# Background alerts (phone locked or app closed)

The phone app can only alert you while it's open on screen. This repository also contains a
scanner that runs on GitHub's servers every hour, using the same signal rules, and sends each new
alert to your phone through the free **ntfy** app (or Telegram).

## Setup (about 5 minutes)

1. **Install ntfy** on your phone ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) ·
   [iPhone](https://apps.apple.com/app/ntfy/id1625396347)). No account is needed.
2. **Pick a private topic name** that nobody could guess, for example `ema-alerts-7f3k92qd1x`.
   Anyone who knows the name can read your alerts, so treat it like a password.
   In ntfy, tap **+** and subscribe to that topic.
3. In this repository on GitHub, open **Settings › Secrets and variables › Actions** and add two
   repository secrets:
   - `TWELVEDATA_API_KEY`: your Twelve Data key (the same one as in the app is fine)
   - `NTFY_TOPIC`: the topic name from step 2
4. Make sure `.github/workflows/scan.yml` is on the **default branch** (`main`). GitHub only runs
   scheduled jobs from there.
5. Test it: **Actions › EMA background scan › Run workflow**, tick **Only send a test
   notification**, and run it. A test alert should arrive on your phone within a few seconds.

After that it runs on its own every hour. The first run only records the current state; alerts
start from the next new candle.

## Choosing symbols

The phone app's watchlist is saved only on your phone, so the background scanner has its own list in
[`scanner/config.json`](scanner/config.json). Edit it on GitHub:

- `watchlist`: symbols, written the same way as in the app (`EURUSD`, `XAUUSD`, `BTCUSD`, `AAPL` …)
- `alertTimeframes`: any of `"1H"`, `"4H"`, `"D"`
- `modes`: per symbol, `"cross"` (default, EMA 9/20 cross only), `"all"` (also price closing across
  EMA 9 or 20) or `"off"`

## Good to know

- **Timing:** GitHub starts scheduled jobs a few minutes late, sometimes 15 minutes or more when it's
  busy. As in the app, a cross only counts once the next candle also closes on the new side.
- **Data limit:** the scanner only loads a timeframe once its next candle has closed. With the
  default 7 symbols that's roughly 220 of your 800 free Twelve Data credits a day, leaving room for
  the app. Keep the total of both inside 800 if you add many symbols.
- **Times** in background alerts are shown in UTC.
- **Pausing:** GitHub turns off scheduled jobs in a repository with no activity for 60 days, and
  emails you first. Re-enable it from the Actions tab. To stop alerts yourself, disable the workflow there.
- **Telegram instead of ntfy:** create a bot with @BotFather, send it a message, then add the
  secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. You can use both at once.
- **Your own ntfy server:** add a repository *variable* (not secret) `NTFY_SERVER` with its URL.
