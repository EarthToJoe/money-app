#!/usr/bin/env python3
"""
IAD <-> PUJ fare tracker for one exact United itinerary.

  Outbound: UA 1661  IAD -> PUJ  2026-12-16  08:20
  Return:   UA 1614  PUJ -> IAD  2026-12-20  12:56
  2 adults, STANDARD Economy (not Basic).

Reads the standard-Economy price off the Google Flights booking page, appends it
to a CSV, and notifies when the price crosses a threshold. Designed to be run on
a timer (systemd or cron). See README.md.
"""

from __future__ import annotations

import csv
import json
import os
import re
import smtplib
import statistics
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from pathlib import Path

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

# --- what we track -----------------------------------------------------------

ITINERARY_URL = os.environ.get(
    "ITINERARY_URL",
    "https://www.google.com/travel/flights/booking?tfs="
    "CBwQAhpGEgoyMDI2LTEyLTE2IiAKA0lBRBIKMjAyNi0xMi0xNhoDUFVKKgJVQTIEMTY2MSgAMgJVQWoHCAESA0lBRHIHCAESA1BVSh"
    "pGEgoyMDI2LTEyLTIwIiAKA1BVShIKMjAyNi0xMi0yMBoDSUFEKgJVQTIEMTYxNCgAMgJVQWoHCAESA1BVSnIHCAESA0lBREABQAFI"
    "AWoEEAEYAHABggELCP___________wGYAQE",
)

# Sanity guards: if the page no longer shows these, we are looking at the wrong
# itinerary and must not log a price.
EXPECTED_MARKERS = ("8:20 AM", "12:56 PM")

FARE_LABEL = "Economy"          # exact row label; NOT "Basic Economy"
PASSENGERS = 2

# --- alert thresholds (see ../TRACKER.md) ------------------------------------

TIER1_BUY_TOTAL = float(os.environ.get("TIER1_BUY_TOTAL", 1600))
WATCH_TOTAL = float(os.environ.get("WATCH_TOTAL", 1750))
ADAPTIVE_MIN_OBS = 36
ADAPTIVE_SIGMA = 1.5
DEADLINE_SOFT = date(2026, 10, 15)   # warn: dip odds shrinking
DEADLINE_HARD = date(2026, 11, 3)    # 43 days out: buy at trailing-14d min

CSV_PATH = Path(os.environ.get("CSV_PATH", Path(__file__).resolve().parent.parent / "price-log.csv"))
SCHEMA = "STANDARD_ECONOMY_2PAX"
FIELDS = [
    "timestamp",
    "standard_econ_2pax_total_usd",
    "standard_econ_per_person_usd",
    "basic_econ_per_person_usd",
    "fare_tracked",
    "notes",
]


# --- scraping ----------------------------------------------------------------

def money(s: str) -> float | None:
    m = re.fullmatch(r"\$([\d,]+(?:\.\d{2})?)", s.strip())
    return float(m.group(1).replace(",", "")) if m else None


def fare_from_text(text: str, label: str) -> float | None:
    """Find a fare row by its exact label, then the next price line under it."""
    lines = [ln.strip() for ln in text.splitlines()]
    for i, ln in enumerate(lines):
        if ln == label:
            for nxt in lines[i + 1 : i + 4]:
                price = money(nxt)
                if price is not None:
                    return price
    return None


def scrape() -> dict:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(
            locale="en-US",
            timezone_id="America/New_York",
            viewport={"width": 1280, "height": 900},
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
            ),
        )
        page = ctx.new_page()
        try:
            page.goto(ITINERARY_URL, wait_until="domcontentloaded", timeout=60_000)
            page.wait_for_selector("text=Booking options", timeout=45_000)
            page.wait_for_timeout(2_500)  # let fare rows settle
            text = page.inner_text("body")
        except PWTimeout as e:
            raise RuntimeError(f"Google Flights did not render booking options: {e}") from e
        finally:
            browser.close()

    missing = [m for m in EXPECTED_MARKERS if m not in text]
    if missing:
        raise RuntimeError(
            f"Itinerary markers missing from page ({', '.join(missing)}) — "
            "flights may have sold out or the schedule changed."
        )

    total = fare_from_text(text, FARE_LABEL)
    if total is None:
        raise RuntimeError(f"Could not find a '{FARE_LABEL}' fare row on the page.")

    return {
        "total": total,
        "per_person": round(total / PASSENGERS, 2),
        "basic_per_person": (
            round(b / PASSENGERS, 2)
            if (b := fare_from_text(text, "Basic Economy")) is not None
            else None
        ),
    }


# --- history -----------------------------------------------------------------

def read_history() -> list[dict]:
    if not CSV_PATH.exists():
        return []
    with CSV_PATH.open(newline="") as fh:
        rows = [r for r in csv.DictReader(fh) if r.get("fare_tracked") == SCHEMA]
    out = []
    for r in rows:
        try:
            out.append(
                {
                    "ts": datetime.fromisoformat(r["timestamp"]),
                    "total": float(r["standard_econ_2pax_total_usd"]),
                    "notes": r.get("notes", ""),
                }
            )
        except (ValueError, KeyError):
            continue
    return out


def append_row(now: datetime, obs: dict, notes: str) -> None:
    new_file = not CSV_PATH.exists()
    with CSV_PATH.open("a", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        if new_file:
            w.writeheader()
        w.writerow(
            {
                "timestamp": now.isoformat(timespec="seconds"),
                "standard_econ_2pax_total_usd": f"{obs['total']:.2f}",
                "standard_econ_per_person_usd": f"{obs['per_person']:.2f}",
                "basic_econ_per_person_usd": (
                    f"{obs['basic_per_person']:.2f}" if obs["basic_per_person"] else ""
                ),
                "fare_tracked": SCHEMA,
                "notes": notes,
            }
        )


# --- alert logic -------------------------------------------------------------

def evaluate(total: float, history: list[dict], today: date) -> tuple[str | None, list[str]]:
    """Return (tier, summary_lines). tier is 'TIER1', 'TIER2', 'TIER3' or None."""
    prior = [h["total"] for h in history]
    all_time_low = min(prior) if prior else None
    prev = prior[-1] if prior else None
    lines: list[str] = []

    if prev is not None:
        delta = total - prev
        lines.append(
            f"${total:,.2f} for {PASSENGERS} "
            f"({'+' if delta >= 0 else '−'}${abs(delta):,.2f} vs last check)"
        )
    else:
        lines.append(f"${total:,.2f} for {PASSENGERS} (first observation)")

    is_new_low = all_time_low is None or total < all_time_low
    lines.append(
        f"all-time low ${min(total, all_time_low):,.2f}" if all_time_low else "no prior history"
    )

    tier = None
    if total <= TIER1_BUY_TOTAL:
        tier = "TIER1"
    elif len(prior) >= ADAPTIVE_MIN_OBS and is_new_low:
        window = [h["total"] for h in history if h["ts"] >= history[-1]["ts"] - timedelta(days=7)]
        if len(window) >= 2:
            mean, sd = statistics.fmean(window), statistics.pstdev(window)
            if sd > 0 and total <= mean - ADAPTIVE_SIGMA * sd:
                tier = "TIER2"
                lines.append(f"7-day mean ${mean:,.2f}, σ ${sd:,.2f} — {ADAPTIVE_SIGMA}σ dip")
    elif is_new_low and total < WATCH_TOTAL:
        tier = "TIER3"

    fired_before = any("TIER1" in h["notes"] or "TIER2" in h["notes"] for h in history)
    if today >= DEADLINE_HARD:
        recent = [h["total"] for h in history if h["ts"].date() >= today - timedelta(days=14)]
        if recent and total <= min(recent):
            lines.append("Past 43-day mark and at the trailing-14-day minimum — buy now.")
    elif today >= DEADLINE_SOFT and not fired_before:
        lines.append(
            "Dip odds shrinking — this route historically climbs after early November; "
            "consider buying at the next local low."
        )

    return tier, lines


# --- notification ------------------------------------------------------------

def post(url: str, data: bytes, headers: dict) -> None:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    urllib.request.urlopen(req, timeout=20).read()


def notify(title: str, body: str) -> None:
    """Fan out to whichever channels are configured via env vars."""
    sent = []

    if topic := os.environ.get("NTFY_TOPIC"):
        server = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
        post(
            f"{server}/{topic}",
            body.encode(),
            {"Title": title, "Priority": "high", "Tags": "airplane"},
        )
        sent.append("ntfy")

    if (tok := os.environ.get("TELEGRAM_BOT_TOKEN")) and (chat := os.environ.get("TELEGRAM_CHAT_ID")):
        post(
            f"https://api.telegram.org/bot{tok}/sendMessage",
            json.dumps({"chat_id": chat, "text": f"{title}\n\n{body}"}).encode(),
            {"Content-Type": "application/json"},
        )
        sent.append("telegram")

    if hook := os.environ.get("WEBHOOK_URL"):
        post(hook, json.dumps({"title": title, "body": body}).encode(),
             {"Content-Type": "application/json"})
        sent.append("webhook")

    if (host := os.environ.get("SMTP_HOST")) and (to := os.environ.get("EMAIL_TO")):
        msg = EmailMessage()
        msg["Subject"] = title
        msg["From"] = os.environ.get("EMAIL_FROM", os.environ.get("SMTP_USER", to))
        msg["To"] = to
        msg.set_content(body)
        port = int(os.environ.get("SMTP_PORT", 587))
        with smtplib.SMTP(host, port, timeout=30) as s:
            s.starttls()
            if user := os.environ.get("SMTP_USER"):
                s.login(user, os.environ["SMTP_PASS"])
            s.send_message(msg)
        sent.append("email")

    print(f"  notified via: {', '.join(sent) or 'NOTHING CONFIGURED'}", file=sys.stderr)


# --- main --------------------------------------------------------------------

def main() -> int:
    now = datetime.now(timezone.utc).astimezone()
    try:
        obs = scrape()
    except Exception as e:
        print(f"[{now:%Y-%m-%d %H:%M}] ERROR: {e}", file=sys.stderr)
        if os.environ.get("NOTIFY_ON_ERROR", "1") == "1":
            notify("⚠️ Fare tracker failed", f"{e}\n\n{ITINERARY_URL}")
        return 1

    history = read_history()
    tier, lines = evaluate(obs["total"], history, now.date())
    summary = " | ".join(lines)
    append_row(now, obs, f"{tier or 'no alert'}; {summary}")

    print(f"[{now:%Y-%m-%d %H:%M}] Economy 2pax ${obs['total']:,.2f} "
          f"(${obs['per_person']:,.2f} pp) — {tier or 'no alert'}")

    if tier in ("TIER1", "TIER2"):
        notify(
            f"✈️ Flight deal: IAD⇄PUJ ${obs['total']:,.0f} for {PASSENGERS}",
            "\n".join(
                [
                    "UA 1661  IAD→PUJ  Wed Dec 16, 8:20 AM",
                    "UA 1614  PUJ→IAD  Sun Dec 20, 12:56 PM",
                    f"Standard Economy — ${obs['total']:,.2f} total "
                    f"(${obs['per_person']:,.2f} per person)",
                    "",
                    *lines,
                    "",
                    "Book: " + ITINERARY_URL,
                ]
            ),
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
