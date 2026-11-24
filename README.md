# Finch — know your money

A personal-finance web app: see where your money goes, budget against it, and run
a credit-card suite properly — the right card per purchase, welcome bonuses on
track, statement credits used before they expire, and every loyalty balance in
one place.

## Run it

```bash
npm install
npm run dev
```

That starts two processes: the web app on <http://localhost:5173> and a small API
server on `:8787` that exists only to talk to Plaid. Vite proxies `/api` to it.

First launch loads a realistic 12-month demo dataset (5 accounts, ~1,100
transactions, 10 loyalty balances, an in-progress welcome bonus) so every page is
explorable immediately. **Accounts → Import CSV** brings in your real statements,
**Accounts → Connect bank** syncs them live, and **Reset data** wipes back to demo.

Bank sync needs Plaid keys in a `.env` file:

```bash
cp .env.example .env   # then paste your client_id and sandbox secret
```

Without them the API server still starts and simply reports Plaid as
unconfigured — every other page works exactly the same on demo or CSV data.

Real banks need one extra piece: most large US institutions (Chase, Capital One,
BofA, Schwab, PNC, US Bank) log you in via OAuth and return the browser to an
**https** redirect URL, which `localhost` can't provide. `npm run tunnel` puts a
public HTTPS tunnel in front of the dev server and prints the exact redirect URL
to register with Plaid. The full walkthrough — keys, costs, the sandbox login,
the tunnel runbook — is in **[SETUP-PLAID.md](SETUP-PLAID.md)**.

Other scripts: `npm run dev:web` (frontend only), `npm run dev:server` (API only),
`npm run tunnel` (public HTTPS tunnel for Plaid OAuth), `npm run build`,
`npm run typecheck`, `node scripts/smoke.mjs` (typecheck + build gate).

## On your phone, and where it runs

Finch runs at **finch.hughesnode.com** on the VPS, as one `npm start` process
behind the web server. Every merge to `main` deploys there automatically.
Sign in with `FINCH_PASSWORD`, then use Safari's **Add to Home Screen**, and
your data stays in sync between the phone and the Mac. Setup and the manual
fallback are in **[docs/deploy.md](docs/deploy.md)**.

## The pages

| Page | What you get |
|---|---|
| **Dashboard** | Spent / income / rewards / net cash this month, 12-month trend, category breakdown, top merchants, budget snapshot, missed-rewards callout, wallet summary, recent activity |
| **Advisor** | Search any store, site, airline or hotel → which card to use and why; plan a big purchase (cash vs points vs transfer vs bank portal); **Ask Finch**, an optional Claude assistant grounded in your wallet |
| **Wallet** | Welcome-bonus tracker per card, every statement credit with what's left and when it resets, and a centralized "use before they reset" list |
| **Points** | Every bank, airline and hotel balance valued in dollars, with a transfer-partner explorer both directions |
| **Transactions** | Filter by month / account / category / search, recategorize inline |
| **Budgets** | Monthly limits with pace markers, one-click suggestions from your 3-month average |
| **Rewards** | Per-card earnings, "which card for this category", missed rewards, 12-month earnings, and cards worth adding ranked by incremental two-year gain |
| **Accounts** | Balances, card debt, utilization, bank sync, CSV import wizard |

### Advisor, in more detail

Three tools, in order of how often you'll reach for them:

- **Which card for this purchase** — type "Costco", "united.com", "Airbnb",
  "Whole Foods". A directory of 175 merchants resolves the query to the category
  it actually codes as (warehouse clubs are not supermarkets), then every card you
  own is ranked for that specific purchase: category multiplier, networks the
  merchant refuses (no Amex at Costco), a live welcome bonus, and any statement
  credit the purchase would consume. Every option shows the value it earns and
  the reasons behind it.
- **Big-purchase planner** — a flight or hotel stay at a cash price, plus the
  award price if you looked it up. It compares paying cash (with the best card and
  its rewards netted out), booking the award with points you hold or can transfer
  in, and booking through the bank's own travel portal at its fixed rate. Every
  option carries its cents-per-point, the transfer steps, and the caveats that
  bite — award taxes, no elite credit on portal hotel stays.
- **Ask Finch** — see below.

### Wallet, in more detail

- **Welcome bonuses.** Set a card's opened date and Finch seeds the bonus from the
  card product, then tracks qualifying spend against it: what's left, days
  remaining, and the daily pace needed. It also computes the bonus's value per
  dollar of remaining spend, which is what makes the Advisor prefer that card
  while the bonus is live. Override the points, minimum spend or deadline on any
  card, or mark a bonus earned or abandoned.
- **Statement credits.** Uber Cash, dining and hotel credits, airline fee credits
  and the rest, each on its own reset schedule — monthly, quarterly, semiannual,
  annual, or cardmember year measured from the card's opened date. Usage is
  auto-detected from matching transactions on that account, capped at the face
  amount, and always overridable by hand. "Use before they reset" collects every
  credit with money left on it, soonest deadline first, filtered to the next 30
  days by default.

### Points, in more detail

32 programs — 5 bank currencies, 20 airlines, 7 hotels — each with a conservative
planning value per point, so balances total to a dollar figure. The transfer
explorer runs both directions across 76 transfer relationships: what a bank
currency can feed, and everything that can feed a given airline or hotel program.
Reachability accounts for the 1,000-point transfer blocks banks enforce, so the
number you see is what you could actually muster, not a rounded fantasy.

Loyalty programs have no consumer APIs, so those balances are typed in — each row
shows when you last updated it.

## The card suite model

Finch treats your cards as a **suite**, not a list:

- **Per purchase** — the Advisor ranks every card you own for a specific merchant,
  accounting for the category multiplier, network acceptance, an in-progress
  welcome bonus, and any statement credit the purchase would use.
- **Welcome bonuses** — while a bonus is live, its effective value per dollar
  usually beats every category multiplier, and the Advisor says so.
- **Statement credits** — tracked per reset period, auto-detected where the
  transaction text gives them away.
- **Points** — bank currencies (Chase UR, Amex MR, Citi ThankYou, Capital One,
  Bilt), 20 airlines and 7 hotel programs, with 76 transfer relationships so you
  can see what you can actually muster in any one program.

## How the math works

Every card is modeled as `points = spend × multiplier`, `value = points × pointValueCents`
(cash back uses 1¢). Elevated rates carry annual caps where the real card has them;
rotating-category cards are modeled at a representative category with a note.
Point values are conservative planning numbers (Chase UR 1.5¢, Amex MR 1.6¢,
Hyatt 1.7¢, Hilton 0.5¢) — all editable in `src/data/programs.ts` and `src/data/cards.ts`.

Card recommendations measure what a card would **add** to your wallet: from your
last 6 full months of spending, annualized, each category counts only the gain
over your current best card, minus the annual fee. The signup bonus counts only
if your spending pace actually clears its minimum inside the bonus window. Cards
are then ranked by estimated two-year value — first year including the bonus, plus
one ongoing year — so a big signup bonus can't carry a card that bleeds value after.

> Finch shows arithmetic on published reward rates. It is not financial advice —
> verify terms with the issuer.

## Ask Finch (optional AI)

The Advisor page has a free-form assistant powered by Claude. Paste an Anthropic
API key ([console.anthropic.com](https://console.anthropic.com)) on that page and
ask things like "I'm booking 4 nights at a Hyatt in Tokyo for $1,600 — points or
cash?" It answers from a snapshot of your actual wallet: cards and rates, bonus
progress, unused credits, points balances, and your spending profile.

The key is stored in your browser's localStorage and requests go directly from
your browser to Anthropic. It never touches the Plaid backend, which knows
nothing about it.

## Getting your data in

Three ways, and they mix freely.

**Demo data** — loaded on first run. Five accounts, twelve months of activity, ten
loyalty balances and a bonus in progress. **Reset data** on the Accounts page
brings it back at any time.

**CSV import** — export a statement from your bank or card site (Chase, Amex,
Citi, Capital One all offer this) and use **Accounts → Import CSV**. The wizard
guesses the date, description and amount columns and the sign convention, shows a
live preview, auto-categorizes merchants, and skips duplicates — so re-importing
overlapping date ranges is safe.

**Bank sync (Plaid)** — **Accounts → Connect bank** opens Plaid Link, and Finch
pulls accounts and up to 730 days of transactions, then keeps them current on
demand. Plaid's sandbox is free forever and takes about five minutes to wire up;
real accounts are free for up to 10 bank logins on Plaid's Trial plan. Banks that
use OAuth also need the HTTPS redirect that `npm run tunnel` provides.
**[SETUP-PLAID.md](SETUP-PLAID.md)** walks through keys, costs, the sandbox login,
going live over the tunnel, and what to do when something errors.

How the sync behaves:

- The Plaid secret and per-bank access tokens never leave the backend — they live
  in `.env` and `server/.plaid-store.json`, both gitignored. The browser sees a
  short-lived link token and the resulting data, nothing else.
- Once a bank is linked, **Sync** in the Accounts header refreshes everything;
  the Connect bank modal syncs, reconnects, or **Unlink**s one bank at a time.
- Accounts and transactions carry stable Plaid-derived ids (`plaid:<id>`), so
  re-syncing updates rows instead of duplicating them. Categories you fixed by
  hand, the opened date you set, and the card product you linked all survive a
  sync.
- Plaid's own category and merchant name are used when they map cleanly;
  otherwise `categorize()` — the same keyword engine CSV import uses — takes over.
- Synced credit cards arrive without a card product attached — Plaid reports a
  balance and a mask, not that it's an Amex Gold. Pick the product from the
  dropdown on the card's row to turn on rewards math, bonus tracking and credits.
- Synced rows are tagged `source: 'manual'`; the union in `src/types.ts` predates
  Plaid and widening it to `'plaid'` is a two-line change if you want the
  distinction.

Loyalty programs (airlines, hotels, Chase, Amex) have no consumer APIs, so those
balances are entered by hand on the Points page.

## Project layout

```
server/                 Plaid backend, plain ESM, no build step
  index.js            Express app: status, link token, public-token exchange,
                      transactions sync, unlink
  plaid.js            Plaid client, DTO mapping, error unwrapping
  store.js            atomic JSON token store
  .plaid-store.json   access tokens + sync cursors (gitignored, created at runtime)
src/
  types.ts            data model
  store.ts            zustand store, persisted to localStorage ("finch-v1")
  data/
    categories.ts     14 categories + colors
    cards.ts          24 US credit cards: rates, fees, bonuses, credits
    programs.ts       32 loyalty programs + 76 transfer partners
    merchants.ts      175 stores/sites/airlines/hotels with card gotchas
    demoSeed.ts       deterministic 12-month demo dataset
  lib/
    analytics.ts      month keys, spending aggregation, budgets
    rewards.ts        earnings, missed rewards, best card, recommendations
    bonus.ts          welcome-bonus progress
    credits.ts        statement credits, reset periods, usage detection
    loyalty.ts        balance values, transfer reachability, cover planner
    advisor.ts        per-merchant card ranking, big-purchase planner
    assistant.ts      wallet context + Claude streaming call
    plaid.ts          /api/plaid client + Plaid → Finch mapping
    csv.ts            CSV parsing + column-mapping heuristics
    categorize.ts     statement line → merchant + category
    format.ts         currency/date formatting
  pages/
    Dashboard.tsx  Advisor.tsx  Wallet.tsx  Points.tsx
    Transactions.tsx  Budgets.tsx  Rewards.tsx  Accounts.tsx
    advisor/        purchase lookup, big-purchase planner, Ask Finch
    wallet/         card tiles, bonus hero, credits due
    points/         balance tables, transfer explorer
    accounts/       CSV import wizard, connect-bank modal, Plaid Link button,
                    shared sync helper
    budgets/  rewards/
  styles/             design tokens, base, component kit, app shell
.env                  Plaid keys (gitignored; see .env.example)
```

Stack: Vite · React 18 · TypeScript · zustand · recharts · papaparse ·
@anthropic-ai/sdk · Express + plaid + react-plaid-link. Your financial data lives
in your browser's localStorage; the backend is a Plaid proxy that keeps only
access tokens, sync cursors and a cached account list.
