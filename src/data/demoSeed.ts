import { DEMO_CARD_PRODUCT_IDS } from '../types';
import type { Account, CategoryId, CreditUsage, PointsBalance, Transaction } from '../types';
import { addMonthsClamped } from '../lib/bonus';
import { periodKeyFor } from '../lib/credits';

// Deterministic 12-month demo dataset for a ~30-year-old professional in SF.
// Seeded PRNG -> identical output on every call (dates derive from `new Date()`,
// so the window slides day to day, but any two calls on the same day match).

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32)

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Small helpers

const pad2 = (n: number): string => String(n).padStart(2, '0');
const iso = (y: number, m0: number, d: number): string => `${y}-${pad2(m0 + 1)}-${pad2(d)}`;
const daysIn = (y: number, m0: number): number => new Date(y, m0 + 1, 0).getDate();
const dow = (y: number, m0: number, d: number): number => new Date(y, m0, d).getDay();
const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Accounts

const CHECKING = 'acct-checking';
const SAVINGS = 'acct-savings';
const CARD_SAPPHIRE = 'acct-sapphire';
const CARD_DOUBLECASH = 'acct-doublecash';
const CARD_GOLD = 'acct-gold';

const [SAPPHIRE_PRODUCT, DOUBLECASH_PRODUCT, GOLD_PRODUCT] = DEMO_CARD_PRODUCT_IDS;

const CREDIT_IDS = new Set<string>([CARD_SAPPHIRE, CARD_DOUBLECASH, CARD_GOLD]);

// When each card was opened. The Sapphire and the Double Cash are seasoned; the
// Gold is deliberately new so its welcome bonus reads as in progress (the real
// offer is 60,000 MR for $6,000 in 6 months, and ~75 days of Gold spend lands
// well short of that).
const SAPPHIRE_OPENED = '2023-03-10';
const SAPPHIRE_BONUS_DEADLINE = '2023-06-10'; // openedAt + 3 months
const DOUBLECASH_OPENED = '2021-08-02';
const GOLD_OPEN_DAYS_AGO = 75;

// ---------------------------------------------------------------------------
// Merchant catalogs (clean name + statement-style raw description + $ range)

interface MerchantSpec {
  merchant: string;
  raw: string;
  min: number;
  max: number;
  w?: number; // weight for weighted pick, default 1
}

const GROCERIES: MerchantSpec[] = [
  { merchant: "Trader Joe's", raw: "TRADER JOE'S #552 SAN FRANCISC", min: 24, max: 82, w: 4.5 },
  { merchant: 'Safeway', raw: 'SAFEWAY #0995 SAN FRANCISCO CA', min: 22, max: 88, w: 2 },
  { merchant: 'Whole Foods Market', raw: 'WHOLEFDS SOM 10250 SAN FRANCIS', min: 32, max: 105, w: 2 },
  { merchant: 'Ferry Plaza Farmers Market', raw: 'SQ *FERRY PLAZA FARMERS MKT', min: 18, max: 46, w: 1.5 },
  { merchant: 'Costco', raw: 'COSTCO WHSE #0144 SAN FRANCISC', min: 88, max: 162, w: 1 },
];

const COFFEE: MerchantSpec[] = [
  { merchant: 'Blue Bottle Coffee', raw: 'BLUE BOTTLE COFFEE #70 SAN FRA', min: 5.25, max: 9, w: 2 },
  { merchant: 'Philz Coffee', raw: 'PHILZ COFFEE - CASTRO SAN FRAN', min: 5.5, max: 8.75, w: 2 },
  { merchant: 'Sightglass Coffee', raw: 'SQ *SIGHTGLASS COFFEE', min: 5, max: 8.5, w: 1.5 },
  { merchant: 'Ritual Coffee Roasters', raw: 'SQ *RITUAL COFFEE ROASTERS', min: 5, max: 8, w: 1.5 },
  { merchant: 'Andytown Coffee', raw: 'SQ *ANDYTOWN COFFEE ROASTERS', min: 5.25, max: 8.25, w: 1 },
];

const LUNCH: MerchantSpec[] = [
  { merchant: 'Souvla', raw: 'TST* SOUVLA - HAYES VALLEY', min: 14, max: 22, w: 2 },
  { merchant: 'Sweetgreen', raw: 'SWEETGREEN SAN FRANCISCO CA', min: 13, max: 19, w: 2 },
  { merchant: "Gott's Roadside", raw: 'GOTTS ROADSIDE - FERRY BLDG', min: 14, max: 22, w: 1.5 },
  { merchant: 'Rooster & Rice', raw: 'ROOSTER & RICE - SOMA SF CA', min: 13, max: 18, w: 1.5 },
  { merchant: 'The Bird', raw: 'TST* THE BIRD SF', min: 12, max: 17, w: 1.5 },
  { merchant: 'El Farolito', raw: 'EL FAROLITO SAN FRANCISCO CA', min: 12, max: 19, w: 1.5 },
];

const DINNER: MerchantSpec[] = [
  { merchant: 'Zazie', raw: 'TST* ZAZIE - SAN FRANCISC', min: 44, max: 88, w: 1.5 },
  { merchant: 'Nopa', raw: 'TST* NOPA SAN FRANCISCO CA', min: 68, max: 125, w: 1 },
  { merchant: 'Burma Superstar', raw: 'BURMA SUPERSTAR SAN FRANCISCO', min: 46, max: 92, w: 1.5 },
  { merchant: 'Flour + Water', raw: 'TST* FLOUR + WATER SAN FRANCIS', min: 62, max: 118, w: 1 },
  { merchant: 'Beretta', raw: 'TST* BERETTA VALENCIA SAN FR', min: 45, max: 90, w: 1.5 },
  { merchant: 'Foreign Cinema', raw: 'FOREIGN CINEMA SAN FRANCISCO', min: 72, max: 128, w: 0.8 },
  { merchant: 'Mission Chinese Food', raw: 'MISSION CHINESE FOOD SF CA', min: 42, max: 84, w: 1.2 },
  { merchant: 'Che Fico', raw: 'TST* CHE FICO SAN FRANCISCO', min: 82, max: 138, w: 0.6 },
];

const DELIVERY: MerchantSpec[] = [
  { merchant: 'DoorDash', raw: 'DD *DOORDASH', min: 26, max: 58, w: 2 },
  { merchant: 'Uber Eats', raw: 'UBER *EATS HELP.UBER.COM', min: 24, max: 52, w: 1.5 },
];

const DOORDASH_SUFFIXES = ['BURMALOVE', 'PADTHAI', 'SHAKESHACK', 'CURRYUPNOW', 'ILCASARO'];

const RIDESHARE: MerchantSpec[] = [
  { merchant: 'Uber', raw: 'UBER *TRIP HELP.UBER.COM', min: 9, max: 38, w: 2.5 },
  { merchant: 'Lyft', raw: 'LYFT *RIDE 855-865-9553 CA', min: 9, max: 34, w: 1.5 },
];

const SHOPPING: MerchantSpec[] = [
  { merchant: 'Amazon', raw: 'AMZN MKTP US*', min: 14, max: 120, w: 3 },
  { merchant: 'Target', raw: 'TARGET 00027616 SAN FRANCISCO', min: 18, max: 95, w: 1.5 },
  { merchant: 'Uniqlo', raw: 'UNIQLO USA LLC SAN FRANCISCO', min: 29, max: 118, w: 1 },
  { merchant: 'REI', raw: 'REI #83 SAN FRANCISCO CA', min: 35, max: 185, w: 1 },
  { merchant: 'Apple', raw: 'APPLE STORE R033 SAN FRANCISCO', min: 19, max: 249, w: 0.8 },
  { merchant: 'Sephora', raw: 'SEPHORA #0058 SAN FRANCISCO', min: 24, max: 115, w: 1 },
];

const ENTERTAINMENT: MerchantSpec[] = [
  { merchant: 'AMC Metreon', raw: 'AMC METREON 16 SAN FRANCISCO', min: 17, max: 38, w: 1.5 },
  { merchant: 'Steam', raw: 'STEAMGAMES.COM 4259522985 WA', min: 10, max: 60, w: 1.5 },
  { merchant: 'SFMOMA', raw: 'SFMOMA ADMISSIONS SAN FRANCISC', min: 25, max: 40, w: 0.8 },
  { merchant: 'California Academy of Sciences', raw: 'CALIFORNIA ACADEMY OF SCIENCES', min: 35, max: 48, w: 0.6 },
  { merchant: 'de Young Museum', raw: 'DE YOUNG MUSEUM SAN FRANCISCO', min: 15, max: 30, w: 0.6 },
];

const CONCERTS: MerchantSpec[] = [
  { merchant: 'Ticketmaster', raw: 'TICKETMASTER EVENT 800-653-800', min: 65, max: 185, w: 1.5 },
  { merchant: 'AXS Tickets', raw: 'AXS.COM TICKETS 888-929-7849', min: 55, max: 160, w: 1 },
];

const PHARMACY: MerchantSpec[] = [
  { merchant: 'CVS Pharmacy', raw: 'CVS/PHARMACY #09823 SAN FRANCI', min: 8, max: 46, w: 1.5 },
  { merchant: 'Walgreens', raw: 'WALGREENS #1327 SAN FRANCISCO', min: 7, max: 42, w: 1 },
];

const MISC: MerchantSpec[] = [
  { merchant: 'Mulberrys Garment Care', raw: 'MULBERRYS GARMENT CARE SF', min: 18, max: 46, w: 1 },
  { merchant: 'USPS', raw: 'USPS PO 0562860113 SAN FRANCIS', min: 6, max: 19, w: 1 },
  { merchant: 'Fellow Barber', raw: 'SQ *FELLOW BARBER - SF', min: 38, max: 62, w: 1 },
];

// Recurring Amex Gold charges the card's statement credits key off:
// Grubhub -> $10/mo dining credit, Dunkin' -> $7/mo Dunkin' credit,
// Resy -> the $50 semiannual Resy credit. Grubhub lands late in the month, so
// for most of a month the dining credit is still sitting there unused.
const GRUBHUB: MerchantSpec = { merchant: 'Grubhub', raw: 'GRUBHUB*ORDER', min: 28, max: 45 };
const DUNKIN: MerchantSpec = { merchant: "Dunkin'", raw: 'DUNKIN #3412', min: 4, max: 9 };
const RESY_RESTAURANTS = ['ANGLER', 'LAZY BEAR', 'STATE BIRD', 'MISTER JIU', 'ZUNI CAFE'];

// Travel bursts: month index into the 13-slot window (0 = twelve months ago).
interface TripSpec {
  mi: number;
  card: string; // main card used for the trip (sometimes the "wrong" one)
  hotelCard: string;
  flight: MerchantSpec;
  hotel: MerchantSpec;
  dinners: MerchantSpec[];
  coffee: MerchantSpec;
}

const TRIPS: TripSpec[] = [
  {
    mi: 2,
    card: CARD_SAPPHIRE,
    hotelCard: CARD_SAPPHIRE,
    flight: { merchant: 'United Airlines', raw: 'UNITED 0162489217743 UNITED.CO', min: 200, max: 410 },
    hotel: { merchant: 'Moxy Seattle Downtown', raw: 'MARRIOTT MOXY SEATTLE DOWNTOW', min: 350, max: 560 },
    dinners: [
      { merchant: 'The Walrus and the Carpenter', raw: 'TST* WALRUS AND THE CARPENTER', min: 58, max: 110 },
      { merchant: 'Un Bien', raw: 'UN BIEN SEATTLE WA', min: 28, max: 52 },
    ],
    coffee: { merchant: 'Espresso Vivace', raw: 'ESPRESSO VIVACE SEATTLE WA', min: 5.5, max: 9 },
  },
  {
    mi: 6,
    card: CARD_DOUBLECASH, // travel on the 2% card — missed Sapphire rewards
    hotelCard: CARD_DOUBLECASH,
    flight: { merchant: 'Delta Air Lines', raw: 'DELTA AIR 0062341987265 ATLANT', min: 180, max: 390 },
    hotel: { merchant: 'Airbnb', raw: 'AIRBNB * HMA8Q2Z1KF AIRBNB.COM', min: 300, max: 500 },
    dinners: [
      { merchant: 'Franklin Barbecue', raw: 'FRANKLIN BARBECUE AUSTIN TX', min: 32, max: 68 },
      { merchant: 'Uchi', raw: 'TST* UCHI AUSTIN TX', min: 88, max: 140 },
    ],
    coffee: { merchant: 'Cosmic Coffee', raw: 'SQ *COSMIC COFFEE AUSTIN', min: 5.5, max: 9 },
  },
  {
    mi: 10,
    card: CARD_SAPPHIRE,
    hotelCard: CARD_DOUBLECASH, // hotel booked on the wrong card
    flight: { merchant: 'Delta Air Lines', raw: 'DELTA AIR 0062347719024 ATLANT', min: 190, max: 390 },
    hotel: { merchant: 'The Hoxton Portland', raw: 'THE HOXTON PORTLAND OR', min: 330, max: 560 },
    dinners: [
      { merchant: 'Kachka', raw: 'TST* KACHKA PORTLAND OR', min: 58, max: 108 },
      { merchant: "Nong's Khao Man Gai", raw: 'NONGS KHAO MAN GAI PORTLAND', min: 16, max: 28 },
    ],
    coffee: { merchant: 'Stumptown Coffee', raw: 'STUMPTOWN COFFEE PORTLAND OR', min: 5.5, max: 9 },
  },
];

// ---------------------------------------------------------------------------
// Loyalty balances. Program ids must exist in src/data/programs.ts. `daysAgo`
// stands in for "last time you checked this account" — 2 to 40 days back, fixed
// so the dataset stays deterministic.

interface PointsSeed {
  programId: string;
  balance: number;
  daysAgo: number;
  note?: string;
}

const POINTS_SEED: PointsSeed[] = [
  { programId: 'chase-ur', balance: 84320, daysAgo: 3 },
  {
    programId: 'amex-mr',
    balance: 61850,
    daysAgo: 2,
    note: 'Excludes the Gold welcome bonus — not earned yet',
  },
  { programId: 'hyatt', balance: 23400, daysAgo: 9 },
  { programId: 'marriott', balance: 61200, daysAgo: 14 },
  { programId: 'hilton', balance: 40500, daysAgo: 21 },
  { programId: 'united', balance: 18750, daysAgo: 6 },
  { programId: 'delta', balance: 31100, daysAgo: 17 },
  { programId: 'american', balance: 12400, daysAgo: 26 },
  { programId: 'southwest', balance: 9800, daysAgo: 33 },
  { programId: 'alaska', balance: 5200, daysAgo: 40 },
];

// ---------------------------------------------------------------------------
// Generator

export interface DemoData {
  accounts: Account[];
  transactions: Transaction[];
  pointsBalances: PointsBalance[];
  creditUsages: CreditUsage[];
}

export function generateDemoData(): DemoData {
  const rnd = mulberry32(0x5eedc0de);

  const range = (min: number, max: number): number => min + rnd() * (max - min);
  const amt = (min: number, max: number): number => round2(range(min, max));
  const int = (min: number, max: number): number => min + Math.floor(rnd() * (max - min + 1));
  const chance = (p: number): boolean => rnd() < p;

  // Separate deterministic stream for the Amex Gold credit anchors, so adding
  // them doesn't reshuffle every draw that follows in the main stream.
  const rnd2 = mulberry32(0x9e3779b9);
  const amt2 = (min: number, max: number): number => round2(min + rnd2() * (max - min));
  const int2 = (min: number, max: number): number => min + Math.floor(rnd2() * (max - min + 1));

  function wpick(items: MerchantSpec[]): MerchantSpec {
    const total = items.reduce((s, it) => s + (it.w ?? 1), 0);
    let r = rnd() * total;
    for (const it of items) {
      r -= it.w ?? 1;
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  }

  function orderCode(len: number): string {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ0123456789';
    let out = '';
    for (let i = 0; i < len; i++) out += chars[Math.floor(rnd() * chars.length)];
    return out;
  }

  // Fri/Sat/Sun count as "weekend-ish" for dinners, groceries, entertainment.
  function pickDay(y: number, m0: number, bias: 'any' | 'weekend' | 'weekday'): number {
    const dmax = daysIn(y, m0);
    for (let i = 0; i < 10; i++) {
      const d = 1 + Math.floor(rnd() * dmax);
      const w = dow(y, m0, d);
      const weekendish = w === 0 || w === 5 || w === 6;
      if (bias === 'any') return d;
      if (bias === 'weekend' && (weekendish || rnd() < 0.25)) return d;
      if (bias === 'weekday' && (!weekendish || rnd() < 0.3)) return d;
    }
    return 1 + Math.floor(rnd() * dmax);
  }

  // Cross-card habits. The "right" card for dining/groceries is the Amex Gold,
  // but roughly half of that spend lands on Double Cash / Sapphire instead so
  // the rewards module has material missed rewards to find.
  const diningCard = (): string => {
    const r = rnd();
    return r < 0.5 ? CARD_GOLD : r < 0.82 ? CARD_DOUBLECASH : CARD_SAPPHIRE;
  };
  const groceryCard = (): string => {
    const r = rnd();
    return r < 0.48 ? CARD_GOLD : r < 0.8 ? CARD_DOUBLECASH : CARD_SAPPHIRE;
  };
  const transportCard = (): string => {
    const r = rnd();
    return r < 0.38 ? CARD_SAPPHIRE : r < 0.72 ? CARD_DOUBLECASH : CARD_GOLD;
  };
  const shoppingCard = (): string => {
    const r = rnd();
    return r < 0.5 ? CARD_DOUBLECASH : r < 0.78 ? CARD_SAPPHIRE : CARD_GOLD;
  };
  const funCard = (): string => {
    const r = rnd();
    return r < 0.45 ? CARD_DOUBLECASH : r < 0.75 ? CARD_SAPPHIRE : CARD_GOLD;
  };

  const now = new Date();
  const ty = now.getFullYear();
  const tm = now.getMonth();
  const td = now.getDate();
  const todayIso = iso(ty, tm, td);
  const pendFrom = new Date(ty, tm, td - 2);
  const pendIso = iso(pendFrom.getFullYear(), pendFrom.getMonth(), pendFrom.getDate());

  const start = new Date(ty, tm - 12, 1);
  const createdAt = iso(start.getFullYear(), start.getMonth(), 1);

  const daysAgoIso = (n: number): string => {
    const d = new Date(ty, tm, td - n);
    return iso(d.getFullYear(), d.getMonth(), d.getDate());
  };
  const goldOpened = daysAgoIso(GOLD_OPEN_DAYS_AGO);

  const accounts: Account[] = [
    {
      id: CHECKING,
      name: 'Everyday Checking',
      institution: 'Chase',
      type: 'checking',
      mask: '0925',
      balance: 8407.19,
      createdAt,
    },
    {
      id: SAVINGS,
      name: 'High-Yield Savings',
      institution: 'Marcus',
      type: 'savings',
      mask: '4410',
      balance: 24512.83,
      createdAt,
    },
    {
      id: CARD_SAPPHIRE,
      name: 'Chase Sapphire Preferred',
      institution: 'Chase',
      type: 'credit',
      mask: '4821',
      balance: 1268.44,
      creditLimit: 12000,
      productId: SAPPHIRE_PRODUCT,
      createdAt,
      openedAt: SAPPHIRE_OPENED,
      // Long since posted — kept so the wallet has an earned bonus on record.
      bonus: {
        points: 60000,
        minSpend: 4000,
        startDate: SAPPHIRE_OPENED,
        deadline: SAPPHIRE_BONUS_DEADLINE,
        status: 'earned',
      },
    },
    {
      id: CARD_DOUBLECASH,
      name: 'Citi Double Cash',
      institution: 'Citi',
      type: 'credit',
      mask: '7733',
      balance: 734.61,
      creditLimit: 9500,
      productId: DOUBLECASH_PRODUCT,
      createdAt,
      openedAt: DOUBLECASH_OPENED,
      // No welcome bonus tracked: the Double Cash's offer is long expired.
    },
    {
      id: CARD_GOLD,
      name: 'Amex Gold',
      institution: 'American Express',
      type: 'credit',
      mask: '1002',
      balance: 2114.98,
      creditLimit: 15000,
      productId: GOLD_PRODUCT,
      createdAt,
      openedAt: goldOpened,
      // Real offer: 60,000 Membership Rewards for $6,000 of spend in 6 months.
      // No status — the engine works it out from spend since goldOpened.
      bonus: {
        points: 60000,
        minSpend: 6000,
        startDate: goldOpened,
        deadline: addMonthsClamped(goldOpened, 6),
      },
    },
  ];

  const cardNames = new Map<string, string>(accounts.map((a) => [a.id, a.name]));

  // 13 month slots: 12 full months back plus the current partial month.
  const months: { y: number; m0: number; key: string }[] = [];
  for (let off = -12; off <= 0; off++) {
    const dt = new Date(ty, tm + off, 1);
    months.push({ y: dt.getFullYear(), m0: dt.getMonth(), key: iso(dt.getFullYear(), dt.getMonth(), 1).slice(0, 7) });
  }

  const txs: Transaction[] = [];
  const seen = new Set<string>();
  let seq = 0;
  // spend per card per month key, used to size next month's card payment
  const cardSpend = new Map<string, number>();

  function add(
    accountId: string,
    y: number,
    m0: number,
    d: number,
    merchant: string,
    raw: string,
    amount: number,
    category: CategoryId,
  ): void {
    const day = Math.min(Math.max(1, d), daysIn(y, m0));
    const date = iso(y, m0, day);
    if (date > todayIso) return; // current month is partial

    let a = round2(amount);
    let key = `${date}|${a}|${merchant}`;
    while (seen.has(key)) {
      a = round2(a + (a >= 0 ? 0.01 : -0.01));
      key = `${date}|${a}|${merchant}`;
    }
    seen.add(key);

    seq += 1;
    const tx: Transaction = {
      id: `demo-${String(seq).padStart(5, '0')}`,
      accountId,
      date,
      merchant,
      rawDescription: raw,
      amount: a,
      category,
      source: 'demo',
    };
    if (CREDIT_IDS.has(accountId) && date >= pendIso) tx.pending = true;
    txs.push(tx);

    if (CREDIT_IDS.has(accountId) && a > 0 && category !== 'transfer') {
      const mk = date.slice(0, 7);
      const sk = `${accountId}|${mk}`;
      cardSpend.set(sk, round2((cardSpend.get(sk) ?? 0) + a));
    }
  }

  function spend(spec: MerchantSpec, accountId: string, y: number, m0: number, d: number, category: CategoryId): void {
    let raw = spec.raw;
    if (spec.merchant === 'Amazon') raw = `AMZN MKTP US*${orderCode(7)}`;
    else if (spec.merchant === 'DoorDash') raw = `DD *DOORDASH ${DOORDASH_SUFFIXES[Math.floor(rnd() * DOORDASH_SUFFIXES.length)]}`;
    add(accountId, y, m0, d, spec.merchant, raw, amt(spec.min, spec.max), category);
  }

  // --- Biweekly salary: every other Friday from the first Friday of the window.
  const payAnchor = new Date(start);
  while (payAnchor.getDay() !== 5) payAnchor.setDate(payAnchor.getDate() + 1);
  for (let d = new Date(payAnchor); d <= now; d.setDate(d.getDate() + 14)) {
    add(
      CHECKING,
      d.getFullYear(),
      d.getMonth(),
      d.getDate(),
      'Acme Corp Payroll',
      'ACME CORP PAYROLL PPD ID: 4415470',
      -3452.16,
      'income',
    );
  }

  // --- Month-by-month rhythm.
  months.forEach((mo, mi) => {
    const { y, m0 } = mo;
    const trip = TRIPS.find((t) => t.mi === mi);

    // Rent on the 1st.
    add(CHECKING, y, m0, 1, 'Parkside Apartments', 'PARKSIDE APARTMENTS WEB PMTS', 2150.0, 'housing');

    // Automatic $500 savings transfer on the 2nd (both legs).
    add(CHECKING, y, m0, 2, 'Transfer to Savings', 'ONLINE TRANSFER TO SAV XXXX4410', 500.0, 'transfer');
    add(SAVINGS, y, m0, 2, 'Transfer from Checking', 'TRANSFER FROM CHASE CHK XXXX0925', -500.0, 'transfer');

    // Savings interest posts on the last day of the month.
    add(SAVINGS, y, m0, daysIn(y, m0), 'Interest Payment', 'INTEREST PAYMENT', -amt(82.4, 87.6), 'income');

    // Utilities: PG&E + Xfinity via checking, Verizon on the Double Cash.
    add(CHECKING, y, m0, int(8, 12), 'PG&E', 'PGANDE WEB ONLINE CA', amt(80, 140), 'utilities');
    add(CHECKING, y, m0, int(14, 16), 'Xfinity', 'COMCAST CABLE COMM 800-COMCAST', 74.99, 'utilities');
    add(CARD_DOUBLECASH, y, m0, int(19, 22), 'Verizon', 'VZWRLSS*APOCC VISB 800-922-020', amt(67.6, 69.4), 'utilities');

    // Subscriptions on their usual cards.
    add(CARD_GOLD, y, m0, 3, 'iCloud', 'APPLE.COM/BILL 866-712-7753 CA', 2.99, 'subscriptions');
    add(CARD_GOLD, y, m0, 5, 'ClassPass', 'CLASSPASS* MONTHLY 646-459-411', 49.0, 'subscriptions');
    add(CARD_SAPPHIRE, y, m0, 6, 'Netflix', 'NETFLIX.COM NETFLIX.COM CA', 15.49, 'subscriptions');
    add(CARD_DOUBLECASH, y, m0, 9, 'Spotify', 'SPOTIFY USA 877-778-1161 NY', 11.99, 'subscriptions');
    add(CARD_DOUBLECASH, y, m0, 12, 'The New York Times', 'NYTIMES*NYTIMES 800-698-4637', 17.0, 'subscriptions');
    if (m0 === 10) {
      // Amazon Prime renews annually in November.
      add(CARD_SAPPHIRE, y, m0, 17, 'Amazon Prime', 'AMZN PRIME*2A8XY 888-802-3080', 139.0, 'subscriptions');
    }

    // Gym membership (health).
    add(CARD_DOUBLECASH, y, m0, 4, 'Fitness SF', 'FITNESS SF - SOMA MEMBERSHIP', 85.0, 'health');

    // Groceries: 7-10 runs, weekend-leaning, roughly half on the wrong card.
    const groceryRuns = int(7, 10);
    for (let i = 0; i < groceryRuns; i++) {
      spend(wpick(GROCERIES), groceryCard(), y, m0, pickDay(y, m0, 'weekend'), 'groceries');
    }

    // Dining: coffees (weekday), lunches (weekday), dinners (weekend), delivery.
    const coffees = int(8, 11);
    for (let i = 0; i < coffees; i++) {
      spend(wpick(COFFEE), diningCard(), y, m0, pickDay(y, m0, 'weekday'), 'dining');
    }
    const lunches = int(7, 10);
    for (let i = 0; i < lunches; i++) {
      spend(wpick(LUNCH), diningCard(), y, m0, pickDay(y, m0, 'weekday'), 'dining');
    }
    const dinners = Math.max(2, int(4, 6) - (trip ? 2 : 0)); // fewer SF dinners in travel months
    for (let i = 0; i < dinners; i++) {
      spend(wpick(DINNER), diningCard(), y, m0, pickDay(y, m0, 'weekend'), 'dining');
    }
    const deliveries = Math.max(1, int(2, 4) - (trip ? 1 : 0));
    for (let i = 0; i < deliveries; i++) {
      spend(wpick(DELIVERY), diningCard(), y, m0, pickDay(y, m0, 'any'), 'dining');
    }

    // Amex Gold credit anchors — always on the Gold, since that's the card
    // whose credits they trigger.
    const grubhubOrders = int2(1, 2);
    for (let i = 0; i < grubhubOrders; i++) {
      add(CARD_GOLD, y, m0, int2(19, 27), GRUBHUB.merchant, GRUBHUB.raw, amt2(GRUBHUB.min, GRUBHUB.max), 'dining');
    }
    const dunkinRuns = int2(2, 4);
    for (let i = 0; i < dunkinRuns; i++) {
      add(CARD_GOLD, y, m0, int2(3, 26), DUNKIN.merchant, DUNKIN.raw, amt2(DUNKIN.min, DUNKIN.max), 'dining');
    }
    // A Resy dinner every other calendar month; Jan and Jul are both included,
    // so every semiannual Resy period opens with one.
    if (m0 % 2 === 0) {
      const spot = RESY_RESTAURANTS[int2(0, RESY_RESTAURANTS.length - 1)];
      add(CARD_GOLD, y, m0, int2(6, 24), 'Resy', `RESY*${spot} SAN FRANCISCO`, amt2(46, 98), 'dining');
    }

    // Transport: rideshares, a Clipper top-up, occasional gas and parking.
    const rides = int(8, 12);
    for (let i = 0; i < rides; i++) {
      spend(wpick(RIDESHARE), transportCard(), y, m0, pickDay(y, m0, 'any'), 'transport');
    }
    add(
      transportCard(),
      y,
      m0,
      pickDay(y, m0, 'any'),
      'Clipper',
      'CLIPPER SYSTEMS AUTOLOAD CA',
      [20, 30, 40][int(0, 2)],
      'transport',
    );
    if (chance(0.5)) {
      add(transportCard(), y, m0, pickDay(y, m0, 'any'), 'Shell', 'SHELL OIL 57444202800 SAN FRAN', amt(42, 68), 'transport');
    }
    const parkings = int(1, 2);
    for (let i = 0; i < parkings; i++) {
      add(
        transportCard(),
        y,
        m0,
        pickDay(y, m0, 'any'),
        'SFMTA Parking',
        'SFMTA PARKING METER SAN FRANCI',
        amt(8, 20),
        'transport',
      );
    }

    // Shopping: 3-5 purchases, occasionally a heavier month.
    let shops = int(3, 5);
    if (chance(0.3)) shops += int(2, 4);
    for (let i = 0; i < shops; i++) {
      spend(wpick(SHOPPING), shoppingCard(), y, m0, pickDay(y, m0, 'any'), 'shopping');
    }

    // Entertainment: movies/games/museums, occasional concert.
    const outings = int(2, 4);
    for (let i = 0; i < outings; i++) {
      spend(wpick(ENTERTAINMENT), funCard(), y, m0, pickDay(y, m0, 'weekend'), 'entertainment');
    }
    if (chance(0.3)) {
      spend(wpick(CONCERTS), funCard(), y, m0, pickDay(y, m0, 'any'), 'entertainment');
    }

    // Health: pharmacy runs, occasional One Medical copay.
    const pharmacyRuns = int(1, 3);
    for (let i = 0; i < pharmacyRuns; i++) {
      spend(wpick(PHARMACY), chance(0.5) ? CARD_GOLD : CARD_DOUBLECASH, y, m0, pickDay(y, m0, 'any'), 'health');
    }
    if (chance(0.35)) {
      add(CARD_GOLD, y, m0, pickDay(y, m0, 'weekday'), 'One Medical', 'ONE MEDICAL GROUP SAN FRANCISC', 25.0, 'health');
    }

    // Odds and ends.
    const misc = int(1, 3);
    for (let i = 0; i < misc; i++) {
      spend(wpick(MISC), CARD_DOUBLECASH, y, m0, pickDay(y, m0, 'any'), 'other');
    }

    // Rare fees: an out-of-network ATM or a small interest charge.
    if (chance(0.35)) {
      if (chance(0.5)) {
        add(CHECKING, y, m0, pickDay(y, m0, 'any'), 'Non-Chase ATM Fee', 'NON-CHASE ATM FEE-WITH', amt(4, 8), 'fees');
      } else {
        const card = [CARD_SAPPHIRE, CARD_DOUBLECASH, CARD_GOLD][int(0, 2)];
        add(card, y, m0, pickDay(y, m0, 'any'), 'Interest Charge', 'PURCHASE INTEREST CHARGE', amt(11, 35), 'fees');
      }
    }

    // Travel burst: flight booked early in the month, trip ~2 weeks later.
    if (trip) {
      const flightDay = int(2, 7);
      spend(trip.flight, trip.card, y, m0, flightDay, 'travel');
      const startDay = flightDay + int(9, 13);
      spend(trip.hotel, trip.hotelCard, y, m0, startDay + 3, 'travel');
      for (let i = 0; i < 3; i++) {
        const dinner = trip.dinners[i % trip.dinners.length];
        spend(dinner, chance(0.6) ? trip.card : CARD_GOLD, y, m0, startDay + i, 'dining');
      }
      spend(trip.coffee, trip.card, y, m0, startDay + 1, 'dining');
      for (let i = 0; i < 3; i++) {
        add(
          trip.card,
          y,
          m0,
          startDay + int(0, 3),
          'Uber',
          'UBER *TRIP HELP.UBER.COM',
          amt(16, 46),
          'transport',
        );
      }
    }
  });

  // Safety net: if the current semiannual window opened after this month's Resy
  // dinner would have landed, drop one in a few days back so the Gold's Resy
  // credit always has something to auto-detect.
  const currentHalf = periodKeyFor('semiannual', todayIso);
  const hasResyThisHalf = txs.some(
    (t) =>
      t.accountId === CARD_GOLD &&
      t.merchant === 'Resy' &&
      periodKeyFor('semiannual', t.date) === currentHalf,
  );
  if (!hasResyThisHalf) {
    const halfStart = iso(ty, tm <= 5 ? 0 : 6, 1);
    const back = new Date(ty, tm, td - 5);
    const backIso = iso(back.getFullYear(), back.getMonth(), back.getDate());
    const [wy, wm, wd] = (backIso < halfStart ? halfStart : backIso).split('-').map(Number);
    add(CARD_GOLD, wy, wm - 1, wd, 'Resy', `RESY*${RESY_RESTAURANTS[0]} SAN FRANCISCO`, amt2(46, 98), 'dining');
  }

  // --- Monthly card payments: pay off the prior month's spend on each card.
  const firstMonthPayment = new Map<string, number>([
    [CARD_SAPPHIRE, 986.24],
    [CARD_DOUBLECASH, 615.4],
    [CARD_GOLD, 1122.73],
  ]);
  months.forEach((mo, mi) => {
    const payDay = int(15, 19);
    for (const cardId of [CARD_SAPPHIRE, CARD_DOUBLECASH, CARD_GOLD]) {
      const amount =
        mi === 0
          ? firstMonthPayment.get(cardId) ?? 0
          : cardSpend.get(`${cardId}|${months[mi - 1].key}`) ?? 0;
      if (amount < 1) continue;
      const name = cardNames.get(cardId) ?? 'Credit Card';
      const rawOut =
        cardId === CARD_SAPPHIRE
          ? 'CHASE CREDIT CRD AUTOPAY PPD'
          : cardId === CARD_DOUBLECASH
            ? 'CITI AUTOPAY PAYMENT WEB'
            : 'AMEX EPAYMENT ACH PMT';
      add(CHECKING, mo.y, mo.m0, payDay, `Payment to ${name}`, rawOut, round2(amount), 'transfer');
      add(cardId, mo.y, mo.m0, payDay, 'Payment Thank You', 'PAYMENT RECEIVED - THANK YOU', -round2(amount), 'transfer');
    }
  });

  // Newest first; stable tie-break so ordering is deterministic.
  txs.sort((a, b) => (a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date)));

  const pointsBalances: PointsBalance[] = POINTS_SEED.map((p) => ({
    programId: p.programId,
    balance: p.balance,
    updatedAt: daysAgoIso(p.daysAgo),
    ...(p.note ? { note: p.note } : {}),
  }));

  // Credit ids and period keys must match src/data/cards.ts and
  // periodKeyFor() exactly, or the wallet won't see the recorded usage.
  const creditUsages: CreditUsage[] = [
    {
      accountId: CARD_GOLD,
      creditId: 'uber-cash',
      periodKey: periodKeyFor('monthly', todayIso),
      used: 10,
    },
    {
      accountId: CARD_SAPPHIRE,
      creditId: 'hotel-credit',
      periodKey: periodKeyFor('anniversary', todayIso, SAPPHIRE_OPENED),
      used: 50,
    },
  ];

  return { accounts, transactions: txs, pointsBalances, creditUsages };
}
