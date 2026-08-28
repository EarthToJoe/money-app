# IAD ⇄ PUJ fare tracker — VPS deployment

Watches one exact itinerary and pushes a notification when it gets cheap:

| | |
|---|---|
| Outbound | **UA 1661** IAD → PUJ, Wed Dec 16 2026, 8:20 AM |
| Return | **UA 1614** PUJ → IAD, Sun Dec 20 2026, 12:56 PM |
| Travelers | 2 adults |
| Fare | **standard Economy** (never Basic) |
| Baseline | $1,770 total / $885 per person (Aug 24, 2026) |
| Buy alert | total ≤ **$1,600** |

Each run loads the Google Flights booking page for this exact itinerary, reads
the price on the row labeled exactly `Economy`, appends it to `../price-log.csv`,
and notifies if a threshold trips. Runs in about 15 seconds and uses a few MB of
bandwidth, so a $5 VPS is overkill in the best way.

## Deploy (Debian/Ubuntu)

```bash
sudo useradd -r -m -d /opt/fare-tracker fare
sudo -u fare git -C /opt/fare-tracker clone <your-repo> . || sudo -u fare mkdir -p /opt/fare-tracker/vps
# copy tracker.py, requirements.txt, env.example into /opt/fare-tracker/vps/

sudo -u fare python3 -m venv /opt/fare-tracker/.venv
sudo -u fare /opt/fare-tracker/.venv/bin/pip install -r /opt/fare-tracker/vps/requirements.txt
sudo -u fare /opt/fare-tracker/.venv/bin/playwright install chromium
sudo /opt/fare-tracker/.venv/bin/playwright install-deps chromium
```

Configure alerting:

```bash
sudo -u fare cp /opt/fare-tracker/vps/env.example /opt/fare-tracker/.env
sudo -u fare nano /opt/fare-tracker/.env     # set NTFY_TOPIC or your channel
sudo chmod 600 /opt/fare-tracker/.env        # it may hold an SMTP password
```

Test one run before automating it:

```bash
sudo -u fare env $(grep -v '^#' /opt/fare-tracker/.env | xargs) \
  /opt/fare-tracker/.venv/bin/python /opt/fare-tracker/vps/tracker.py
```

You should see a line like `Economy 2pax $1,770.00 ($885.00 pp) — no alert` and a
new row in `price-log.csv`. To prove the notification path works end to end,
re-run it once with `TIER1_BUY_TOTAL=99999` — that forces an alert.

Install the timer:

```bash
sudo cp /opt/fare-tracker/vps/fare-tracker.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fare-tracker.timer
systemctl list-timers fare-tracker.timer     # confirm next run
journalctl -u fare-tracker.service -n 50     # read past runs
```

### cron instead of systemd

`Persistent=true` on the timer is the reason to prefer systemd: it catches up on
a run the VPS slept through. If you want cron anyway:

```cron
7 */2 * * * cd /opt/fare-tracker && set -a && . ./.env && set +a && .venv/bin/python vps/tracker.py >> /var/log/fare-tracker.log 2>&1
```

## Notification channels

Set any combination in `.env`; all configured channels fire.

- **ntfy.sh** — easiest. Install the ntfy app, subscribe to a topic, set `NTFY_TOPIC`.
  Topics are public to anyone who guesses them, so use a random-looking one.
- **Telegram** — `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`.
- **Email** — `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`/`EMAIL_TO`. Gmail needs an App Password.
- **Webhook** — `WEBHOOK_URL`, posts `{"title","body"}`.

If none are set the script still logs prices; it just can't reach you. It prints
`notified via: NOTHING CONFIGURED` in that case.

## When it breaks

It scrapes a page Google can restyle at any time, so assume it will eventually.
Failure is loud by design: a run that can't find the fare row raises, logs to the
journal, and (unless `NOTIFY_ON_ERROR=0`) pushes an error notification. Silence
means it is working; an alert about a failure means go look.

Two failure modes worth telling apart:

- **"Could not find an 'Economy' fare row"** — Google changed the page. Fix the
  label matching in `fare_from_text`.
- **"Itinerary markers missing"** — the 8:20 AM or 12:56 PM flight is no longer
  bookable. That is real news: the flights may be sold out or rescheduled.

Guard against silent death by having the VPS tell you it is alive — e.g. add a
healthchecks.io ping to the systemd unit, so *no* news also reaches you.

## Turn on Google's own price tracking too

Belt and braces, free, zero infrastructure: open the itinerary URL in
`../TRACKER.md`, flip the **Track prices** toggle, and Google emails you on
changes. It won't respect your $1,600 standard-Economy threshold, but it keeps
working if this scraper quietly dies.

## Files

| File | Purpose |
|---|---|
| `tracker.py` | The whole tracker: scrape, log, evaluate, notify |
| `requirements.txt` | Just Playwright |
| `env.example` | Copy to `.env` and edit |
| `fare-tracker.service` | systemd oneshot unit (sandboxed) |
| `fare-tracker.timer` | Every 2 hours, with catch-up |
| `../price-log.csv` | Price history (shared with the desktop tracker) |
| `../TRACKER.md` | Thresholds and the reasoning behind them |
