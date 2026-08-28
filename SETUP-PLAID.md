# Connecting your banks to Finch

This is the whole setup, start to finish, assuming you have never touched Plaid
before. The sandbox path takes about five minutes and costs nothing.

- [What Plaid is](#what-plaid-is)
- [Why Finch has a backend now](#why-finch-has-a-backend-now)
- [What it costs](#what-it-costs)
- [Setup (sandbox)](#setup-sandbox)
- [Connecting real banks (production)](#connecting-real-banks-production)
- [Troubleshooting](#troubleshooting)
- [Where your data lives](#where-your-data-lives)

## What Plaid is

Banks don't publish APIs you can call. Plaid is the aggregator that sits in
between: you log into your bank inside **Plaid Link**, Plaid's own hosted widget,
and Plaid hands the app an **access token** that can read balances and
transactions for that login. Your bank username and password go to Plaid and your
bank — never to Finch, and never into this codebase.

Vocabulary you'll see in the dashboard and in error messages:

| Term | Means |
|---|---|
| **Item** | One bank login. A login that exposes a checking and a savings account is still one Item — and Plaid's free tiers are counted in Items. |
| **Link** | The connect-your-bank UI Plaid hosts. Finch opens it in a modal. |
| **`public_token`** | Short-lived handle Link returns to the browser. Worth nothing on its own. |
| **`access_token`** | The long-lived key to an Item's data. Backend only, forever. |
| **Sandbox / Production** | Fake banks with fake data / your actual accounts. Different secrets, different data, separate Items. |

## Why Finch has a backend now

Two values must never reach the browser: your **Plaid secret** and each Item's
**access token**. Anything a browser can read, anyone with devtools can read —
and an access token is a standing read permission on a real bank account.

So Finch runs a small Express server alongside the web app:

```
browser (React)  ──/api/plaid/*──▶  server/index.js  ──▶  Plaid API
  never sees                        holds PLAID_SECRET
  the secret                        holds access tokens
  or the tokens                     (server/.plaid-store.json)
```

`npm run dev` starts both. Vite proxies `/api` to `http://localhost:8787`, so the
browser only ever talks to your own machine. The one Plaid value that does reach
the browser is the **link token**, which is short-lived, single-purpose, and
useless outside the Link session it was minted for.

## What it costs

| What you're using | Data | Price |
|---|---|---|
| **Sandbox** | Fake banks, fabricated transactions | Free forever. "Usage of Sandbox is always free." |
| **Production, Trial plan** | Your real accounts | Free for up to **10 Production Items** (10 bank logins). Available to teams created on or after **April 15, 2026** (US/Canada). |
| **Production, past 10 Items** | Your real accounts | Pay-as-you-go, no minimum commitment. |

Plaid does not publish a price list in its docs — per-Item pricing for
pay-as-you-go is shown on the final screen of the Production access request, so
you see the number before you commit to anything. Don't take a figure from
anywhere else as gospel.

Teams created **before** April 15, 2026 don't get the Trial plan. They get
**Limited Production** instead: real data, free, but with a cap on API calls and
Items, and with the big OAuth banks (Chase, Bank of America, Wells Fargo) blocked
until the team is approved for full Production.

Source of truth, and worth a skim before you enter a card:
[plaid.com/docs/account/billing](https://plaid.com/docs/account/billing/).

For a personal wallet — a few checking accounts and a handful of cards — 10 Items
is plenty. Most people never leave the free tier.

## Setup (sandbox)

Start here even if you want real data. Sandbox proves the wiring works before
real credentials are involved.

### 1. Create a Plaid account

Sign up at [dashboard.plaid.com/signup](https://dashboard.plaid.com/signup). No
card required. Sandbox access is live the moment the account exists.

### 2. Copy your keys

In the dashboard: **Developers → Keys**
([direct link](https://dashboard.plaid.com/developers/keys)). Copy two values:

- `client_id` — one per team, same across every environment.
- **Sandbox secret** — the row labelled Sandbox. There is a separate secret per
  environment, and mixing them up is the single most common setup error.

### 3. Put them in `.env`

```bash
cp .env.example .env
```

Open `.env` and paste:

```
PLAID_CLIENT_ID=your_client_id_here
PLAID_SECRET=your_sandbox_secret_here
PLAID_ENV=sandbox
PLAID_PORT=8787
```

`.env` is gitignored. Nothing in it is ever bundled into the frontend.

### 4. Start the app

```bash
npm install   # first time only
npm run dev
```

That runs two processes: the Plaid backend on `:8787` and the web app on
`:5173`. Open <http://localhost:5173>.

### 5. Link a sandbox bank

**Accounts → Connect bank**. The modal shows a **Sandbox** badge and a **Connect a
bank** button; press it and Plaid Link opens. (If the keys didn't take, the modal
shows the setup steps above instead, with a Copy button for the `.env` lines — fix
`.env`, restart, and reopen it.)

Pick any institution — in sandbox they're all fake, so "First Platypus Bank"
behaves like Chase — and log in with the universal sandbox credentials:

| Field | Value |
|---|---|
| Username | `user_good` |
| Password | `pass_good` |
| 2FA code, if asked | `1234` (any four digits works) |

Select the accounts you want and finish.

### 6. Watch it import

On success Finch pulls the Item's accounts and their transaction history, maps
each transaction to a Finch category, and drops everything into your local store.
It asks Plaid for the maximum window — **730 days**, two years — and takes
whatever the institution actually has. Sandbox banks return their fabricated set
immediately; a real bank may need a minute on the first pull while Plaid does the
initial fetch.

Once a bank is linked, a **Sync** button appears in the Accounts header and pulls
everything current. The Connect bank modal also has a per-bank **Sync** if you
only want one of them.

Re-syncing is safe. Accounts and transactions carry stable Plaid-derived ids, so a
second sync updates rows rather than duplicating them, and any category you fixed
by hand survives.

### 7. Link each card to a product

Synced credit cards arrive as generic accounts — Plaid knows the balance and the
last four digits, not that it's an Amex Gold with a $120 dining credit. On the
**Accounts** page each credit-card row has a card-product dropdown, defaulting to
"— not linked —". Pick the matching card from the 24 products Finch models.

That one step turns on the rest of the app: reward multipliers per category, the
Advisor's per-merchant recommendation, welcome-bonus tracking, and statement
credits. Set the card's **opened date** on the Wallet page too if a welcome bonus
is still in play.

## Connecting real banks (production)

Sandbox proved the wiring. Real banks add exactly two things: production
credentials, and — for most of the big US banks — an **OAuth round trip** that
sends the browser off to the bank's own site and back again. That round trip
needs a public **https** address pointing at your laptop, which is what
`npm run tunnel` sets up.

If your bank is not an OAuth bank, skip straight to steps 1–2 and ignore
everything about tunnels: you'll type your credentials inside Plaid Link exactly
as you did in sandbox, on plain `http://localhost:5173`.

### 1. Get production access and the Production secret

Request Production in the dashboard
([Overview → Request products](https://dashboard.plaid.com/overview/request-products)).
You describe the use case; personal finance is the most ordinary request there
is, and pricing appears on the final screen before you submit.

On the **Trial plan** — teams created on or after **April 15, 2026** (US/Canada) —
production is real data on your real accounts, up to **10 Items** (10 bank
logins), at no cost. Past 10 Items it's pay-as-you-go with no minimum. Teams
created before that date get **Limited Production** instead, where the OAuth
majors stay blocked until full Production approval.

Then copy the **Production** secret from **Developers → Keys**. It is a
different string from the sandbox secret; mixing them up produces
`INVALID_API_KEYS` and nothing else.

### 2. Unlink your sandbox banks first

While `PLAID_ENV` is still `sandbox`: **Connect bank → Unlink** on each. Sandbox
access tokens only work in sandbox, so those Items are dead weight the moment you
switch, and unlinking now keeps the list clean.

### 3. Work out whether your bank needs OAuth

These require OAuth today, and there are more:

> Chase · Capital One · Bank of America · Charles Schwab · PNC · US Bank

The authoritative list is the API's, per environment. With your `.env` filled in:

```bash
set -a; . ./.env; set +a
curl -s https://production.plaid.com/institutions/get \
  -H 'Content-Type: application/json' \
  -d "{\"client_id\":\"$PLAID_CLIENT_ID\",\"secret\":\"$PLAID_SECRET\",
       \"count\":500,\"offset\":0,\"country_codes\":[\"US\"],
       \"options\":{\"oauth\":true}}" \
  | python3 -c 'import json,sys; [print(i["name"]) for i in json.load(sys.stdin)["institutions"]]'
```

`options.oauth: true` filters the response to OAuth institutions. Sourcing
`.env` keeps the secret out of your shell history — don't paste it on the
command line.

An OAuth bank behaves differently inside Link: instead of a username and
password box you get a **Continue to Login** button, and pressing it navigates
the entire page to the bank.

### 4. Why that needs a tunnel

Plaid requires the redirect URI — the address the bank returns the browser to —
to be **https**, and to be registered in your dashboard ahead of time.
`http://localhost` is accepted **in Sandbox only**. A laptop has no public https
address, so you borrow one:

```
you ─▶ https://xyz.trycloudflare.com ─cloudflared─▶ http://localhost:5173 (Vite)
                                                      └─ /api ─▶ :8787 ─▶ Plaid
```

`npm run tunnel` wraps Cloudflare's `cloudflared` in **quick tunnel** mode: free,
no Cloudflare account, no DNS. Install it first with `brew install cloudflared`
(the script tells you so and stops if it's missing —
[other platforms](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)).

That address is public, so `npm run tunnel` also puts a lock on it. The first
run generates a password, saves it to `.env` as `FINCH_TUNNEL_PASSWORD`, and
stops *without* opening the tunnel so the dev server can be restarted and pick
it up. From then on, every request that doesn't come from your own machine — the
app's HTML, its `/api` calls, anything a stranger aims at the URL — has to pass
HTTP Basic auth. Your browser asks once and remembers. Details in
[What the tunnel exposes](#what-the-tunnel-exposes).

The catch: a quick tunnel gets a **new hostname every run**, and the hostname is
baked into the redirect URI you registered. Restart the tunnel, re-register.
(The password does not change with it — it lives in `.env` until you change it.)

> **Rehearse in sandbox, free.** Sandbox accepts `http://localhost:5173/oauth`
> as a redirect URI, and Link's sandbox institution list includes an OAuth test
> bank (search "OAuth"). Registering that one URL lets you exercise the whole
> hand-off — navigate away, come back to `/oauth`, resume Link — without a tunnel
> and without production credentials.

### 5. The runbook

**1. Terminal one — the app.**

```bash
TUNNEL=1 npm run dev
```

`TUNNEL=1` only adjusts Vite's hot-reload socket so it survives the tunnel;
everything else is the normal dev server.

**2. Terminal two — the tunnel.**

```bash
npm run tunnel
```

**The very first time you run this**, there is no tunnel password yet. The
script makes one, writes it into `.env`, and stops without opening anything:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Made a tunnel password and saved it to .env.                        │
│                                                                     │
│ Not opening the tunnel this time — on purpose. The dev server read  │
│ its password at startup, which was before this one existed, so its  │
│ lock is currently inert: anyone who learned the tunnel URL could    │
│ read your accounts and transactions. …                              │
│                                                                     │
│ Two steps and you are through:                                      │
│   1. Restart the app: Ctrl-C `npm run dev`, then start it again     │
│   2. Run `npm run tunnel` again — it will print the URL and the     │
│      password together                                              │
└─────────────────────────────────────────────────────────────────────┘
```

That is not a failure. The dev server in terminal one read its password when it
started — when there wasn't one — so its lock is inert, and a tunnel opened now
would be an unlocked door onto your accounts. Restart terminal one, run
`npm run tunnel` again, and you never see this message again.

Every run after that prints the box you actually want:

```
Tunnel is live:  https://xyz.trycloudflare.com
Password:        amber-otter-lamp-quiet      (any username works)
Your OAuth redirect URL:  https://xyz.trycloudflare.com/oauth
```

Leave that terminal open. Closing it closes the tunnel.

**3. Register the redirect URL with Plaid.** Dashboard → **Developers → API →
Allowed redirect URIs → Configure** → add `https://xyz.trycloudflare.com/oauth`
→ save. It must match what Finch sends **character for character**: same scheme,
same host, `/oauth`, no trailing slash. A mismatch fails at link-token creation
with `INVALID_FIELD`, before you ever see a bank.

**4. Open the app through the tunnel** — `https://xyz.trycloudflare.com`, *not*
`localhost`. The browser asks for a username and password: type anything at all
for the username, and the password from the box. It asks once per session, then
attaches the credentials to everything the page loads, `/api` calls included.

Use the tunnel URL rather than localhost because the bank returns the browser to
the tunnel host, and Link can only be resumed on the origin that started it.
Starting on localhost is the single most common way to lose the flow halfway.

**5. Point Finch at production.** Do this part in a second tab on
<http://localhost:5173>. Changing keys is a local-machine job — the routes
behind it write `.env` — and the setting is server-side anyway, so it applies to
the tunnel tab the moment you reload it.

**Accounts → Connect bank → Change keys**: switch the environment to
**Production**, paste the production secret, paste the redirect URL, save.
(Equivalent to setting `PLAID_SECRET`, `PLAID_ENV=production` and
`PLAID_REDIRECT_URI` in `.env` and restarting — the form just writes the same
file without the restart.) The modal's badge flips to **Production**; that's your
confirmation the switch took. Reload the tunnel tab so it sees the new state.

**6. Connect the bank.** Press **Connect a bank**, pick your institution, press
**Continue to Login**. The page leaves for the bank, you log in and choose which
accounts to share, and the bank sends you back to `/oauth`, where Finch resumes
the same Link session, receives the token, and imports accounts and up to 730
days of transactions.

Under the hood: the link token is created carrying the redirect URI, stashed in
browser storage before Link opens (the page is about to navigate away, taking all
in-memory state with it), and read back on `/oauth` to resume the session. So:
same browser, same tab, same origin.

**7. Shut the tunnel down.** Ctrl-C in terminal two; it confirms the tunnel is
closed and Finch is local-only again. Linking is the only step that needs a
public address — from here on, syncing runs off the stored access tokens over
plain <http://localhost:5173>, with no tunnel and no password prompt. Read
[What the tunnel exposes](#what-the-tunnel-exposes) once before you leave one
running.

### 6. When the OAuth flow goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| The browser keeps asking for the password | Wrong password — it is the `FINCH_TUNNEL_PASSWORD` line in `.env`, and the username is ignored, so only the second box matters. Or the dev server was started *before* that line existed, loaded an empty password, and now nothing you type can match | Restart `npm run dev`, then reload the tunnel URL. The password is read once at startup, so any hand-edit to `.env` needs a restart before it counts. |
| 401 on every request: the tunnel URL shows an "Unauthorized" page, or the app loads and then every panel says it can't reach the backend | The prompt was dismissed or answered wrong. Callers that aren't a browser — curl, another device, a webhook — get the same 401 and never see a prompt at all | Reload the tunnel URL and enter the password. For curl, pass it: `curl -u finch:'your-password' https://xyz.trycloudflare.com/api/plaid/status` — any username works. There is no gate on `http://localhost:5173`, so if localhost is prompting you, you aren't actually on localhost. |
| `INVALID_FIELD` mentioning `redirect_uri`, or "redirect URI is not registered" | The string Finch sent isn't registered, or differs from the registered one | Copy the exact URL from the tunnel box into **Developers → API → Allowed redirect URIs**. Check scheme (`https`), host spelling, `/oauth`, and no trailing slash. Then close and reopen the Connect bank modal so a fresh link token is minted. |
| **Continue to Login** does nothing, or the bank never loads | The link token was created without a redirect URI (you saved the redirect URL after opening the modal), or you're on `http://localhost` — Link won't hand off from a non-https origin | Load the app from the tunnel URL, re-save the redirect URL under **Change keys**, then reopen the modal. Tokens are minted when the modal opens, not when you press the button. |
| You come back from the bank to a blank page, or "couldn't resume" | `/oauth` couldn't find the stored link token: different origin (localhost vs tunnel), different browser or profile, or the tab was closed mid-flow | Start over from the tunnel URL and stay in the same tab. A stale token is harmless — nothing was linked. |
| It worked yesterday, now every attempt fails | The quick tunnel handed out a **new hostname** on restart, so the registered redirect URI points at a dead host | Register the new `/oauth` URL, update it under **Change keys**, reopen the modal. To stop re-registering, run a *named* Cloudflare tunnel on a domain you own — stable hostname, register once. |
| `ITEM_LOGIN_REQUIRED`, or a **Reconnect needed** badge | The bank wants a fresh login or the OAuth consent expired (banks re-prompt periodically — Chase does it on a schedule) | **Connect bank → Reconnect** on that bank. It repeats the same OAuth round trip, so the tunnel must be up and the redirect URL still registered. History, categories and card links survive. |
| Vite answers "Blocked request. This host is not allowed" | Running an older `vite.config.ts` without `allowedHosts` | Pull the current config and restart `npm run dev`. |
| The page reloads constantly, or hot reload never connects | Dev server started without `TUNNEL=1`, so HMR's socket dials the wrong port | Restart terminal 1 as `TUNNEL=1 npm run dev`. |
| Your bank shows a username and password box, no redirect | It isn't an OAuth institution | Nothing to do — that's the simple path. No tunnel, no redirect URL; `http://localhost:5173` is fine. |

The general (non-OAuth) failures — bad keys, missing transactions, wrong
categories — are in [Troubleshooting](#troubleshooting) below.

### What the tunnel exposes

Worth reading once, before you leave a tunnel running.

**While `npm run tunnel` is up, the dev server on your laptop is on the public
internet.** Not "sort of": Cloudflare accepts requests for that hostname from
anywhere in the world and forwards them into `http://localhost:5173`, which
proxies `/api` to the Plaid backend holding your access tokens. That is the
point — the bank's redirect has to be able to reach you — but it means the same
thing a stranger's browser could reach.

**The password is the control that keeps your data private.** Every request that
doesn't originate on this machine has to carry HTTP Basic credentials matching
`FINCH_TUNNEL_PASSWORD` or it gets a 401 — the HTML, the JavaScript, and every
`/api/plaid/*` call alike. Without it, `GET /api/plaid/status` would list your
linked banks to anyone who asked and `POST /api/plaid/sync` would hand over your
transactions. The HTML is behind the same gate on purpose: `fetch()` never
raises a password prompt of its own, so challenging the page load is what makes
the browser ask once and then attach the header to everything else by itself.

**Your Plaid keys are behind a second door.** The two routes that write `.env` —
`/api/plaid/credentials` and `/api/plaid/redirect-uri` — refuse any request that
doesn't reach them from this machine, with a 403 that no password unlocks. Point
another device on your network at the backend port and it bounces, credentials
or not.

Know the edge of that guard, though: it reads the address the request arrives
*from*, and everything coming down the tunnel arrives through the dev server's
own `/api` proxy, which connects from `127.0.0.1`. So a visitor who has the URL
*and* the password is on the inside of it. The password is the thing standing
between a stranger and your keys — which is the same reason **Change keys**
belongs on `localhost`, in step 5 of the runbook, and not in the tunnel tab.

**The random hostname is not a security control.** Quick tunnel URLs are long
and unguessable, which is genuinely useful, but the string is not a secret: it
goes through DNS, sits in your browser history and shell scrollback, and you are
about to paste it into a Plaid dashboard. Treat the URL as public. The password
is the part that has to stay private, and it is the reason the tunnel is safe to
use at all.

**Shut it down when the linking is done.** Ctrl-C in the tunnel terminal — it
confirms the tunnel is closed. Linking a bank is the only step that needs a
public address; routine syncing afterwards uses the access tokens already stored
on your machine and runs perfectly well on plain `http://localhost:5173` with no
tunnel and no password. (The one thing that brings the tunnel back is an OAuth
bank asking you to reconnect, and that wants a freshly registered redirect URL
anyway.) A tunnel left up for days is an open door with nothing on the other
side of it for you.

### What this means for your data

Worth being plain about, because production means real accounts:

- **Your bank credentials never touch Finch.** You type them on the bank's own
  site (OAuth) or inside Plaid's hosted widget. Neither this codebase nor the
  tunnel ever sees them.
- **Access tokens sit in `server/.plaid-store.json`, in plain text**, on this
  machine. Anyone who can read that file can read your balances and transactions
  through Plaid until you unlink. It is gitignored; it is not encrypted.
- **Transactions live in your browser's localStorage**, unencrypted, like the
  demo data.
- **The tunnel is a public URL with a password on it.** While it runs, anyone who
  knows the hostname can reach your dev server — and gets a 401 unless they also
  have `FINCH_TUNNEL_PASSWORD`. The random hostname is not authentication; the
  password is. Start the tunnel when you're linking a bank, Ctrl-C it when you're
  done, and read [What the tunnel exposes](#what-the-tunnel-exposes).
- **This is a personal, local setup.** It is not hardened for deployment: the
  tunnel password is one shared password for one person, not user accounts, and
  there's no encryption at rest and no multi-user story. Don't put it on a server
  and leave it there.

Keep the sandbox secret around. Flipping back to `sandbox` under **Change keys**
is the fastest way to test a change without touching live accounts.

## Troubleshooting

Anything involving the tunnel — a password prompt that won't take, a 401, a
redirect that doesn't come back — is in
[When the OAuth flow goes wrong](#6-when-the-oauth-flow-goes-wrong) above. This
table is the rest.

| Symptom | Cause | Fix |
|---|---|---|
| "The Plaid backend isn't running." | You launched `npm run dev:web` instead of `npm run dev`, the server crashed, or `:8787` is taken | Run `npm run dev`, then hit **Retry** in the modal. If the port is in use, change `PLAID_PORT` in `.env` — Vite's proxy reads the same variable — and restart both. |
| The modal shows the four setup steps instead of a bank list | The backend is up but `.env` has no keys, or it was written after the server started | Fill in `PLAID_CLIENT_ID` and `PLAID_SECRET`, restart `npm run dev`, reopen the modal. |
| `INVALID_API_KEYS` | The secret doesn't match `PLAID_ENV`. Classic case: a sandbox secret with `PLAID_ENV=production` | Copy the secret from the row matching your environment in Developers → Keys, then restart the server. Check for a trailing space on the pasted value. |
| `ITEM_LOGIN_REQUIRED`, or a **Reconnect needed** badge on a bank | The bank wants a fresh login — password change, expired consent, or MFA. Sandbox Items do this on their own 30 days after creation | Open **Connect bank** and hit **Reconnect** on that bank. It repairs the existing connection; your history and categories stay put. |
| Linked fine, but no transactions | Plaid is still doing the first pull for that Item | Wait a minute and hit **Sync**. Sandbox is instant; real banks are not. |
| Nothing appeared in the app after linking | The import raced the link handoff, or you linked in another tab | Hit **Sync**. It's idempotent — worst case nothing new comes back. |
| Balances right, categories wrong | Plaid's category didn't map cleanly, so Finch fell back to its own keyword engine | Recategorize on the **Transactions** page. Manual overrides are marked and never overwritten by a later sync. |
| An account you deleted came back | Deleting an account row only clears it locally; the bank is still linked | Use **Connect bank → Unlink** to disconnect the bank itself. |
| A leftover sandbox bank errors on Sync after you moved to production | Its access token belongs to the other environment | **Unlink** it. The stored token is dropped locally even when Plaid no longer recognizes it. |
| Amounts look sign-flipped | Nothing to fix. Plaid and Finch agree: positive is money out, negative is money in | — |
| A bank is missing from Link's search | Not supported in that environment. On Limited Production the OAuth majors (Chase, BofA, Wells Fargo) are blocked until full Production approval | Use **Import CSV** for that institution in the meantime. |

## Where your data lives

- **Access tokens** live in `server/.plaid-store.json` on this machine, written by
  your own server process — alongside each bank's sync cursor and a cached list of
  its accounts, so the modal can show what's linked without calling Plaid.
  Gitignored. Delete the file to forget every connection (then remove the orphaned
  accounts in the app).
- **Your secret** lives in `.env` on this machine. Gitignored. It is never sent to
  the browser and never appears in the bundle.
- **Accounts and transactions** live in your browser's localStorage, same as CSV
  imports and demo data. No Finch server, no cloud, no account.
- **Nothing is sent anywhere except Plaid**, and only from your machine. The
  optional "Ask Finch" assistant on the Advisor page is the one other outbound
  call, and it only fires when you paste your own Anthropic key and ask a
  question — it goes browser → Anthropic and never touches the Plaid backend.

To disconnect a bank: **Accounts → Connect bank → Unlink**. That removes the Item
at Plaid — so it stops counting toward your 10 — deletes the stored access token,
and clears that bank's accounts and transactions from Finch. Budgets are kept, and
you can link the bank again whenever you want.

Deleting an account row on the Accounts page is not the same thing: the bank stays
linked and the account reappears on the next sync.
