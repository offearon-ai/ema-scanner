// Background EMA 9/20 scanner. Runs on a schedule (GitHub Actions), so alerts arrive
// even when the phone app is closed. Uses the same signal rules as index.html:
// closed candles only, and a cross counts once the next candle also closes on the new side.
//
// Env: TWELVEDATA_API_KEY (required), NTFY_TOPIC and/or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID,
//      NTFY_SERVER (default https://ntfy.sh), STATE_FILE (default scanner/state.json),
//      SEND_TEST=1 to send one test notification and exit.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Secrets pasted on a phone often carry a trailing newline or spaces, which breaks the key and topic.
const env = (name) => (process.env[name] || "").trim();
// Accept the ntfy topic as a bare name or as a full link like https://ntfy.sh/my-topic
const ntfyTopic = () => env("NTFY_TOPIC").replace(/^https?:\/\/[^/]+\//i, "").replace(/^\/+|\/+$/g, "");
const CONFIG = JSON.parse(readFileSync(process.env.CONFIG_FILE || join(HERE, "config.json"), "utf8"));
const STATE_FILE = process.env.STATE_FILE || join(HERE, "state.json");
const TF = { "1H": { api: "1h", secs: 3600, label: "1H" }, "4H": { api: "4h", secs: 14400, label: "4H" }, "D": { api: "1day", secs: 86400, label: "Daily" } };
const TFS = ["1H", "4H", "D"];
const CCY = new Set("USD EUR GBP JPY CAD AUD NZD CHF SEK NOK DKK SGD HKD MXN ZAR TRY CNH CNY PLN HUF CZK INR KRW THB ILS XAU XAG XPT XPD".split(" "));
const ALIAS = { GOLD: "XAU/USD", SILVER: "XAG/USD", BTCUSD: "BTC/USD", ETHUSD: "ETH/USD", SOLUSD: "SOL/USD", XRPUSD: "XRP/USD", USOIL: "WTI/USD", WTI: "WTI/USD", UKOIL: "BRENT/USD", BRENT: "BRENT/USD" };
const BARS = 300, SETTLE = 90;
const MAX_ALERT_AGE = 2; // candles: older events are never alerted (e.g. after the state was lost)

const now = () => Date.now() / 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const apiSymbol = (s) => ALIAS[s] || (s.length === 6 && CCY.has(s.slice(0, 3)) && CCY.has(s.slice(3)) ? s.slice(0, 3) + "/" + s.slice(3) : s);
const decimals = (p) => (p >= 100 ? 2 : p >= 20 ? 3 : 5);
const utc = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

// ---------- analysis (same rules as index.html) ----------
function ema(cl, n) { const k = 2 / (n + 1); let e = cl[0]; return cl.map((c) => (e = c * k + e * (1 - k))); }
export function events(bars, tf) {
  const secs = TF[tf].secs, ts = bars.map((b) => b[0]), cl = bars.map((b) => b[1]), n = cl.length;
  const e9 = ema(cl, 9), e20 = ema(cl, 20), e200 = ema(cl, 200);
  const s9 = cl.map((c, i) => c > e9[i]), s20 = cl.map((c, i) => c > e20[i]), rel = e9.map((v, i) => v > e20[i]);
  const out = [];
  for (let i = 27; i < n; i++) {
    const trend = (up) => ((cl[i] > e200[i]) === up ? "with trend" : "against trend");
    if (rel[i] === rel[i - 1] && rel[i - 1] !== rel[i - 2]) out.push({ kind: "cross", up: rel[i], text: (rel[i] ? "above" : "below") + " EMA 20", trend: trend(rel[i]), price: cl[i], t: ts[i] + secs });
    for (const [nm, sr] of [["9", s9], ["20", s20]]) {
      if (sr[i] === sr[i - 1] && sr[i - 1] !== sr[i - 2]) out.push({ kind: "price", up: sr[i], text: "closed " + (sr[i] ? "above" : "below") + " EMA " + nm, trend: trend(sr[i]), price: cl[i], t: ts[i] + secs });
    }
  }
  return { events: out, close: ts[n - 1] + secs, d: decimals(cl[n - 1]) };
}

// ---------- state ----------
function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { lastSeen: {}, lastClose: {} }; }
}
function saveState(st) { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(st, null, 1)); }

// A key needs fetching once its next candle should have closed (works for any candle alignment).
// If the candle wasn't there yet (market closed, weekend), wait a while before asking again.
const RETRY = { "1H": 3600, "4H": 7200, "D": 21600 };
function due(st, k) {
  const tf = k.split("|")[1], last = st.lastClose[k];
  if (st.retryAt && now() < (st.retryAt[k] || 0) - 300) return false;
  return last == null || now() >= last + TF[tf].secs + SETTLE;
}

// ---------- data ----------
async function fetchBatch(syms, tf, key) {
  const api = syms.map(apiSymbol);
  const url = "https://api.twelvedata.com/time_series?symbol=" + encodeURIComponent(api.join(",")) +
    "&interval=" + TF[tf].api + "&outputsize=" + BARS + "&timezone=UTC&order=asc&apikey=" + encodeURIComponent(key);
  const r = await fetch(url);
  const json = await r.json();
  if (json && json.status === "error" && !json.meta) throw Object.assign(new Error(json.message || "request failed"), { code: json.code });
  const per = syms.length === 1 ? { [api[0]]: json } : json;
  const out = {};
  syms.forEach((s, i) => {
    const j = per && per[api[i]];
    if (!j || j.status === "error" || !Array.isArray(j.values)) { out[s] = { error: (j && j.message) || "no data" }; return; }
    const secs = TF[tf].secs, t = now();
    out[s] = { bars: j.values
      .map((v) => [Date.parse(v.datetime.replace(" ", "T") + (v.datetime.length > 10 ? "Z" : "T00:00:00Z")) / 1000, parseFloat(v.close)])
      .filter((b) => isFinite(b[1]) && b[0] + secs <= t)
      .sort((a, b) => a[0] - b[0]) };
  });
  return out;
}

// ---------- delivery ----------
async function send(title, body, up) {
  const sent = [];
  if (ntfyTopic()) {
    const server = (env("NTFY_SERVER") || "https://ntfy.sh").replace(/\/$/, "");
    const r = await fetch(server + "/" + encodeURIComponent(ntfyTopic()), {
      method: "POST", body,
      headers: { Title: title, Tags: up == null ? "bell" : up ? "chart_with_upwards_trend" : "chart_with_downwards_trend", Priority: "high" },
    });
    if (!r.ok) throw new Error("ntfy returned " + r.status + ": " + (await r.text()).slice(0, 200));
    sent.push("ntfy");
  }
  if (env("TELEGRAM_BOT_TOKEN") && env("TELEGRAM_CHAT_ID")) {
    const r = await fetch("https://api.telegram.org/bot" + env("TELEGRAM_BOT_TOKEN") + "/sendMessage", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env("TELEGRAM_CHAT_ID"), text: title + "\n" + body }),
    });
    if (!r.ok) throw new Error("Telegram returned " + r.status + ": " + (await r.text()).slice(0, 200));
    sent.push("Telegram");
  }
  if (!sent.length) throw new Error("No delivery set up. Add the NTFY_TOPIC secret (or TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID).");
  return sent;
}

// ---------- main ----------
export async function main() {
  if (process.env.SEND_TEST === "1") {
    const via = await send("Test: EMA scanner", "Background alerts are working. They will look like: USDCAD 1H: EMA 9 crossed above EMA 20");
    console.log("Test notification sent via " + via.join(" and "));
    return;
  }
  const key = env("TWELVEDATA_API_KEY");
  if (!key) throw new Error("Add your Twelve Data key as the TWELVEDATA_API_KEY secret.");
  const st = loadState();
  const perMin = Math.max(1, Math.min(8, Number(CONFIG.perMinute) || 8));
  const alertTfs = CONFIG.alertTimeframes || TFS;
  const modeOf = (s) => (CONFIG.modes && CONFIG.modes[s]) || "cross";
  const wl = (CONFIG.watchlist || []).filter((s) => modeOf(s) !== "off");

  const work = [];
  for (const tf of TFS.filter((t) => alertTfs.includes(t))) for (const s of wl) if (due(st, s + "|" + tf)) work.push([s, tf]);
  console.log(`${work.length} symbol/timeframe pairs due`);

  let spent = [], alerts = 0;
  for (const tf of TFS) {
    let syms = work.filter((w) => w[1] === tf).map((w) => w[0]);
    while (syms.length) {
      const t = now(); spent = spent.filter((x) => t - x < 61);
      const room = perMin - spent.length;
      if (room <= 0) { await sleep((spent[0] + 61 - t) * 1000); continue; }
      const batch = syms.slice(0, Math.min(room, 8)); syms = syms.slice(batch.length);
      batch.forEach(() => spent.push(now()));
      let data;
      try { data = await fetchBatch(batch, tf, key); }
      catch (e) {
        if (e.code === 429) { syms = batch.concat(syms); spent = Array(perMin).fill(now()); continue; }
        if (e.code === 401) throw new Error(`Twelve Data rejected the key (it is ${key.length} characters long; free keys are usually 32). Check the TWELVEDATA_API_KEY secret matches the key on your Twelve Data dashboard. (${e.message.slice(0, 80)})`);
        if (batch.length > 1) { // find the bad symbol by loading one at a time
          for (const s of batch) { try { Object.assign(data ??= {}, await fetchBatch([s], tf, key)); } catch (e2) { (data ??= {})[s] = { error: e2.message }; } spent.push(now()); await sleep(8000); }
        } else data = { [batch[0]]: { error: e.message } };
      }
      for (const s of batch) {
        const k = s + "|" + tf, d = data[s];
        if (!d || d.error || d.bars.length < 60) { console.log(`${k}: ${d && d.error ? d.error : "not enough data"}`); continue; }
        const r = events(d.bars, tf);
        if (st.lastClose[k] === r.close) { (st.retryAt ??= {})[k] = now() + RETRY[tf]; console.log(`${k}: no new candle yet`); continue; }
        if (st.retryAt) delete st.retryAt[k];
        st.lastClose[k] = r.close;
        const seen = st.lastSeen[k], newest = r.events.length ? r.events[r.events.length - 1].t : r.close;
        if (seen == null) { st.lastSeen[k] = newest; console.log(`${k}: first run, baseline saved`); continue; }
        const fresh = r.events.filter((e) => e.t > seen && now() - e.t <= (MAX_ALERT_AGE + 1) * TF[tf].secs);
        st.lastSeen[k] = Math.max(seen, newest);
        const toSend = fresh.filter((e) => e.kind === "cross" || modeOf(s) === "all");
        for (const e of toSend) {
          const title = `${s} ${TF[tf].label}: ${e.kind === "cross" ? "EMA 9 crossed " + e.text : e.text}`;
          const body = `at ${e.price.toFixed(r.d)}, ${e.trend} · candle closed ${utc(e.t)}`;
          await send(title, body, e.up); alerts++;
          console.log("ALERT " + title + " " + body);
        }
        console.log(`${k}: checked, ${fresh.length} new signal(s), ${toSend.length} alerted`);
      }
      saveState(st);
    }
  }
  saveState(st);
  console.log(`Done. ${alerts} alert(s) sent.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error("Error: " + e.message); process.exit(1); });
}
