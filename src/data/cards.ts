import type { CardCredit, CardProduct } from '../types';

// ---------------------------------------------------------------------------
// Card product database — popular US consumer cards, reward structures and
// credits as of 2025 (approximate where programs changed mid-year;
// simplifications carry a `note` on the relevant rule and/or an honest
// highlight or credit `how`).
//
// Modeling conventions:
// - Cash-back cards: pointValueCents = 1, so multiplier == % back and a
//   cash signup bonus of $200 is encoded as points: 20000 (20,000 cents).
// - Points/miles cards: pointValueCents is the SHARED planning value of the
//   card's loyalty program (must match LOYALTY_PROGRAMS in
//   src/data/programs.ts), and programId links the two:
//     chase-ur 1.5 · amex-mr 1.6 · citi-ty 1.4 · capital-one 1.4 · bilt 1.5
//     united 1.3 · delta 1.2 · hyatt 1.7 · marriott 0.8 · hilton 0.5 · ihg 0.5
// - Rotating / choose-your-own 5% cards are modeled as a single representative
//   category (groceries or utilities) with an annual cap and an honest note.
// - Co-branded hotel/airline cards: brand spend ("12x at Hilton") is a SCOPED
//   rule — `programIds: ['hilton']` covers every Hilton flag, `merchantKinds:
//   ['airline']` is "flights booked direct", `merchantIds: ['amex-travel']` is
//   one specific merchant. A scoped rule only pays when the purchase actually
//   matches; everything else in the category falls through to the next rule and
//   finally to baseMultiplier. So these rates are real rates now, not ceilings.
//   Rules with NO scoping fields still apply category-wide, which is correct
//   where the issuer really does pay it everywhere (Sapphire Preferred 2x
//   travel, IHG Premier 5x other travel). See RewardRule in src/types.ts.
// - "First matching rule wins" — order rules from most specific to least. Two
//   rules in the same category are how "6x at Marriott, 3x on flights booked
//   direct, 2x everything else" is expressed.
// - Credits: `period` drives the reset cadence (src/lib/credits.ts);
//   `matchPattern` is a case-insensitive regex source used to auto-detect
//   usage from merchant + raw description. Credits that never post as a
//   statement line (Uber Cash, in-app promos) carry no pattern and say so.
// - Multi-year credits (Global Entry $120 every 4 years / TSA PreCheck $85
//   every 4.5 years) have no matching CreditPeriod, so they are ANNUALIZED —
//   amount 30, period 'annual' — and the `how` states the real cadence.
//   Encoding the full $120 as an annual credit would overstate a year by 4x.
// - Perks that pay out in points rather than dollars (anniversary Free Night
//   Awards, companion certificates) live in `highlights`, not `credits`: a
//   $0 credit would read as "already used" in the tracker.

// Shared regex fragments for credit auto-detection.
const AIRLINES =
  'UNITED|DELTA|AMERICAN AIR|AMERICAN AIRLINES|SOUTHWEST|JETBLUE|ALASKA AIR|SPIRIT AIR|FRONTIER|HAWAIIAN AIR';
const HOTELS =
  'MARRIOTT|HILTON|HYATT|IHG|HOLIDAY INN|WESTIN|SHERATON|HAMPTON|COURTYARD|AIRBNB|VRBO|HOTELS\\.COM|BOOKING\\.COM|EXPEDIA';
const GROUND = 'UBER|LYFT|AMTRAK|PARKING|TRANSIT|MTA|BART|METRO|TOLL|TAXI|CAPITAL BIKESHARE|CITI BIKE';
const AMEX_TRAVEL = 'AMEX TRAVEL|AMERICAN EXPRESS TRAVEL|AMEXTRAVEL';
const HILTON_BRANDS =
  'HILTON|HAMPTON|WALDORF|CONRAD|DOUBLETREE|EMBASSY|HOMEWOOD|TRU BY|CANOPY|CURIO|TAPESTRY|SIGNIA|LXR|MOTTO';

// Global Entry ($120 every 4 years) or TSA PreCheck ($85 every 4.5 years).
// Annualized per the convention above; shared by the Amex cards that carry it.
const globalEntryCredit = (): CardCredit => ({
  id: 'global-entry',
  name: 'Global Entry / TSA PreCheck credit',
  amount: 30,
  period: 'annual',
  category: 'travel',
  matchPattern: 'GLOBAL ENTRY|TSA PRECHECK|TSAPRECHK|US CBP',
  how: 'Up to $120 for Global Entry every 4 years, or $85 for TSA PreCheck every 4.5 years. Shown here as $30/yr — the annualized value — because the real credit only arrives once every four years.',
});

// ----------------------------------------------------------------- Amex Gold
const AMEX_GOLD_CREDITS: CardCredit[] = [
  {
    id: 'uber-cash',
    name: 'Uber Cash',
    amount: 10,
    period: 'monthly',
    category: 'transport',
    how: "Added to your Uber account each month; use on rides or Uber Eats. Doesn't appear as a statement credit, so mark it used here.",
  },
  {
    id: 'dining-credit',
    name: 'Dining credit',
    amount: 10,
    period: 'monthly',
    category: 'dining',
    matchPattern: 'GRUBHUB|CHEESECAKE|GOLDBELLY|WINE\\.COM|FIVE GUYS',
    how: 'Up to $10 back each month at Grubhub, The Cheesecake Factory, Goldbelly, Wine.com and Five Guys. Enroll once in your Amex account.',
    enrollmentRequired: true,
  },
  {
    id: 'dunkin',
    name: "Dunkin' credit",
    amount: 7,
    period: 'monthly',
    category: 'dining',
    matchPattern: 'DUNKIN',
    how: "Up to $7 back each month at Dunkin' (in-store or in the app). Enroll once in your Amex account.",
    enrollmentRequired: true,
  },
  {
    id: 'resy',
    name: 'Resy credit',
    amount: 50,
    period: 'semiannual',
    category: 'dining',
    matchPattern: 'RESY',
    how: 'Up to $50 back Jan–Jun and $50 Jul–Dec at US Resy restaurants; pay with the Gold at any restaurant on Resy. Enrollment required.',
    enrollmentRequired: true,
  },
];

// ------------------------------------------------------------- Amex Platinum
// 2025 refresh (Sept 2025, fee $895): hotel credit doubled to $600/yr, Resy
// $400/yr, Lululemon $300/yr and Oura $200/yr added, digital entertainment
// raised to $25/mo, CLEAR tracks the $209 CLEAR Plus price. Saks and Walmart+
// are not modeled — they were dropped in the refresh.
const AMEX_PLATINUM_CREDITS: CardCredit[] = [
  {
    id: 'airline-fee',
    name: 'Airline fee credit',
    amount: 200,
    period: 'annual',
    category: 'travel',
    matchPattern: AIRLINES,
    how: 'Up to $200 per calendar year in incidental fees (bags, seats, lounge day passes) on one airline you select each January. Tickets do not qualify, so a matched ticket purchase here is a false positive — record the real amount.',
    enrollmentRequired: true,
  },
  {
    id: 'hotel-credit',
    name: 'Hotel credit (FHR / THC)',
    amount: 300,
    period: 'semiannual',
    category: 'travel',
    matchPattern: 'AMEX TRAVEL|AMERICAN EXPRESS TRAVEL|AMEXTRAVEL',
    how: 'Up to $300 Jan–Jun and $300 Jul–Dec on prepaid Fine Hotels + Resorts or The Hotel Collection stays (2-night minimum for THC) booked through Amex Travel. 2025 refresh.',
  },
  {
    id: 'uber-cash',
    name: 'Uber Cash',
    amount: 15,
    period: 'monthly',
    category: 'transport',
    how: '$15 in Uber Cash each month ($35 in December) for US rides or Uber Eats. Lives in the Uber app, not on your statement, so mark it used here.',
    enrollmentRequired: true,
  },
  {
    id: 'digital-entertainment',
    name: 'Digital entertainment credit',
    amount: 25,
    period: 'monthly',
    category: 'subscriptions',
    matchPattern: 'DISNEY|HULU|ESPN|PEACOCK|NYTIMES|NY TIMES|WALL STREET JOURNAL|WSJ|PARAMOUNT',
    how: 'Up to $25 back each month on Disney+, Hulu, ESPN+, Peacock, Paramount+, The New York Times or The Wall Street Journal. 2025 refresh (was $20). Enrollment required.',
    enrollmentRequired: true,
  },
  {
    id: 'resy',
    name: 'Resy credit',
    amount: 100,
    period: 'quarterly',
    category: 'dining',
    matchPattern: 'RESY',
    how: 'Up to $100 back each calendar quarter at US Resy restaurants; pay with the Platinum at any restaurant on Resy. 2025 refresh. Enrollment required.',
    enrollmentRequired: true,
  },
  {
    id: 'lululemon',
    name: 'Lululemon credit',
    amount: 75,
    period: 'quarterly',
    category: 'shopping',
    matchPattern: 'LULULEMON',
    how: 'Up to $75 back each calendar quarter at Lululemon in the US (stores or online). 2025 refresh. Enrollment required.',
    enrollmentRequired: true,
  },
  {
    id: 'oura',
    name: 'Oura Ring credit',
    amount: 200,
    period: 'annual',
    category: 'health',
    matchPattern: 'OURA',
    how: 'Up to $200 back per calendar year on Oura Ring hardware bought direct from Oura. 2025 refresh. Enrollment required.',
    enrollmentRequired: true,
  },
  {
    id: 'equinox',
    name: 'Equinox credit',
    amount: 300,
    period: 'annual',
    category: 'health',
    matchPattern: 'EQUINOX',
    how: 'Up to $300 back per calendar year on Equinox club memberships or Equinox+ paid with the Platinum. Enrollment required.',
    enrollmentRequired: true,
  },
  {
    id: 'clear',
    name: 'CLEAR Plus credit',
    amount: 209,
    period: 'annual',
    category: 'travel',
    matchPattern: 'CLEAR',
    how: 'Up to $209 back per calendar year on a CLEAR Plus membership — covers the full price. Enrollment required.',
    enrollmentRequired: true,
  },
  globalEntryCredit(),
];

// --------------------------------------------------- Chase Sapphire Reserve
// 2025 refresh (June 2025, fee $795). Several credits are time-limited
// partner offers (StubHub, Peloton, Lyft, DoorDash, Apple) — honest end dates
// in `how`.
const CSR_CREDITS: CardCredit[] = [
  {
    id: 'travel-credit',
    name: 'Annual travel credit',
    amount: 300,
    period: 'anniversary',
    category: 'travel',
    matchPattern: `${AIRLINES}|${HOTELS}|${GROUND}|CHASE TRAVEL`,
    how: 'Automatically applied to the first $300 of travel purchases each cardmember year — flights, hotels, rideshare, transit, parking, tolls. Resets on your account anniversary.',
  },
  {
    id: 'the-edit',
    name: 'The Edit hotel credit',
    amount: 250,
    period: 'semiannual',
    category: 'travel',
    matchPattern: 'CHASE TRAVEL|THE EDIT',
    how: 'Up to $250 Jan–Jun and $250 Jul–Dec on prepaid stays of 2+ nights booked through The Edit by Chase Travel. 2025 refresh.',
  },
  {
    id: 'exclusive-tables',
    name: 'Exclusive Tables dining credit',
    amount: 150,
    period: 'semiannual',
    category: 'dining',
    how: 'Up to $150 Jan–Jun and $150 Jul–Dec at restaurants booked through Sapphire Reserve Exclusive Tables on OpenTable. Charges post as the restaurant, so mark it used here. 2025 refresh.',
  },
  {
    id: 'stubhub',
    name: 'StubHub credit',
    amount: 150,
    period: 'semiannual',
    category: 'entertainment',
    matchPattern: 'STUBHUB|VIAGOGO',
    how: 'Up to $150 Jan–Jun and $150 Jul–Dec on StubHub and viagogo tickets, through Dec 31, 2027. Activate once in your Chase account.',
    enrollmentRequired: true,
  },
  {
    id: 'doordash',
    name: 'DoorDash promos',
    amount: 25,
    period: 'monthly',
    category: 'dining',
    matchPattern: 'DOORDASH',
    how: '$5 restaurant promo plus two $10 non-restaurant promos each month with complimentary DashPass (through 2027). Promos apply in the DoorDash app, so a matched charge only confirms you ordered — record what you actually redeemed.',
    enrollmentRequired: true,
  },
  {
    id: 'lyft',
    name: 'Lyft credit',
    amount: 10,
    period: 'monthly',
    category: 'transport',
    matchPattern: 'LYFT',
    how: '$10 in Lyft credit each month plus 5x total points on Lyft rides, through Sept 30, 2027. Applied in the Lyft app.',
  },
  {
    id: 'peloton',
    name: 'Peloton credit',
    amount: 10,
    period: 'monthly',
    category: 'health',
    matchPattern: 'PELOTON',
    how: 'Up to $10 back each month on Peloton memberships, through Dec 31, 2027.',
  },
  {
    id: 'apple-tv-music',
    name: 'Apple TV+ & Apple Music',
    amount: 250,
    period: 'annual',
    category: 'subscriptions',
    how: 'Complimentary Apple TV+ and Apple Music (about $250/yr) through June 2027. Activate once in your Chase account — no charge posts, so mark it used here.',
    enrollmentRequired: true,
  },
];

// ------------------------------------------------- Chase Sapphire Preferred
const CSP_CREDITS: CardCredit[] = [
  {
    id: 'hotel-credit',
    name: 'Hotel credit',
    amount: 50,
    period: 'anniversary',
    category: 'travel',
    matchPattern: 'CHASE TRAVEL',
    how: 'Up to $50 back on hotel stays booked through Chase Travel each cardmember year. Applied automatically.',
  },
  {
    id: 'doordash',
    name: 'DoorDash promo',
    amount: 10,
    period: 'monthly',
    category: 'dining',
    matchPattern: 'DOORDASH',
    how: '$10 in monthly non-restaurant DoorDash promos with complimentary DashPass (through 2027). Applies in the DoorDash app, so a matched charge only confirms you ordered.',
    enrollmentRequired: true,
  },
];

// ------------------------------------------------ Marriott Bonvoy Brilliant
// The anniversary Free Night Award (up to 85,000 points) and the $100
// Ritz-Carlton / St. Regis on-property credit pay out in points or at the
// front desk, not as statement credits, so both live in `highlights`.
const BONVOY_BRILLIANT_CREDITS: CardCredit[] = [
  {
    id: 'dining-credit',
    name: 'Dining credit',
    amount: 25,
    period: 'monthly',
    category: 'dining',
    // No matchPattern on purpose: this covers restaurants worldwide, which
    // post under thousands of merchant names — any regex would be noise.
    how: 'Up to $25 back each month ($300/yr) on eligible restaurant purchases worldwide. Too broad to auto-detect reliably, so mark it used here once it posts.',
  },
  globalEntryCredit(),
];

// ------------------------------------------------------ Hilton Honors Aspire
// 2024 refresh (fee $450 → $550) split the two big credits into shorter
// periods: the $400 resort credit became $200 semi-annually and the $200
// flight credit became $50 quarterly. Unused periods do not roll over, which
// is exactly what the credits tracker is for.
const HILTON_ASPIRE_CREDITS: CardCredit[] = [
  {
    id: 'resort-credit',
    name: 'Hilton Resort credit',
    amount: 200,
    period: 'semiannual',
    category: 'travel',
    matchPattern: HILTON_BRANDS,
    how: 'Up to $200 Jan–Jun and $200 Jul–Dec ($400/yr) at participating Hilton Resorts — room rate, dining, spa. Only resort properties qualify, so a matched city-hotel charge is a false positive.',
  },
  {
    id: 'flight-credit',
    name: 'Hilton flight credit',
    amount: 50,
    period: 'quarterly',
    category: 'travel',
    matchPattern: `${AIRLINES}|${AMEX_TRAVEL}`,
    how: 'Up to $50 back each calendar quarter ($200/yr) on flights booked directly with an airline or through Amex Travel. Unused quarters do not roll over.',
  },
  {
    id: 'clear',
    name: 'CLEAR Plus credit',
    amount: 209,
    period: 'annual',
    category: 'travel',
    matchPattern: 'CLEAR',
    how: 'Covers a CLEAR Plus membership in full each calendar year. The list price has moved $189 → $199 → $209; we track the current $209. Enrollment required.',
    enrollmentRequired: true,
  },
];

// ---------------------------------------------------- Delta SkyMiles Reserve
// 2024 refresh (fee $550 → $650) added the Resy, rideshare and Delta Stays
// credits. The companion certificate and Sky Club access are worth more than
// all of them combined but are not dollar credits — see `highlights`.
const DELTA_RESERVE_CREDITS: CardCredit[] = [
  {
    id: 'resy',
    name: 'Resy credit',
    amount: 20,
    period: 'monthly',
    category: 'dining',
    matchPattern: 'RESY',
    how: 'Up to $20 back each month ($240/yr) at US Resy restaurants; pay with the Reserve at any restaurant booked through Resy. Enrollment required.',
    enrollmentRequired: true,
  },
  {
    id: 'rideshare',
    name: 'Rideshare credit',
    amount: 10,
    period: 'monthly',
    category: 'transport',
    matchPattern: 'UBER|LYFT',
    how: 'Up to $10 back each month ($120/yr) on eligible US rideshare — Uber, Lyft, Curb, Revel, Alto. Uber Eats orders match this pattern but do not qualify, so check an auto-detected amount before trusting it. Enrollment required.',
    enrollmentRequired: true,
  },
  {
    id: 'delta-stays',
    name: 'Delta Stays credit',
    amount: 200,
    period: 'annual',
    category: 'travel',
    matchPattern: 'DELTA STAYS',
    how: 'Up to $200 back per calendar year on prepaid hotels and vacation rentals booked through Delta Stays on delta.com.',
  },
  globalEntryCredit(),
];

export const CARD_PRODUCTS: CardProduct[] = [
  // -------------------------------------------------------------- Chase ----
  {
    id: 'chase-sapphire-preferred',
    name: 'Chase Sapphire Preferred',
    issuer: 'Chase',
    network: 'visa',
    annualFee: 95,
    currency: 'points',
    programId: 'chase-ur',
    // Ultimate Rewards planning value (shared with programs.ts): 1.25c floor
    // through Chase Travel, 1.5c+ via Hyatt & airline transfers.
    pointValueCents: 1.5,
    baseMultiplier: 1,
    rules: [
      { categories: ['dining'], multiplier: 3 },
      { categories: ['subscriptions'], multiplier: 3, note: 'Select streaming services' },
      {
        categories: ['travel'],
        multiplier: 5,
        merchantIds: ['chase-travel'],
        note: '5x on travel booked through Chase Travel — hotel stays booked there forfeit elite credit',
      },
      {
        categories: ['travel'],
        multiplier: 2,
        note: '2x on all other travel — this one really is category-wide: airfare, hotels, Airbnb, rail, transit, tolls and parking',
      },
    ],
    signupBonus: { points: 60000, minSpend: 4000, months: 3 },
    gradient: ['#1a3a5c', '#2d5f8a'],
    highlights: [
      '3x dining & select streaming, 2x travel',
      'Points worth 1.25¢ via Chase Travel, ~1.5¢ via transfer partners',
      '$50 annual hotel credit, $10/mo DoorDash promos, 10% anniversary points bonus',
      'No foreign transaction fees',
    ],
    credits: CSP_CREDITS,
  },
  {
    id: 'chase-sapphire-reserve',
    name: 'Chase Sapphire Reserve',
    issuer: 'Chase',
    network: 'visa',
    annualFee: 795, // raised from $550 in the mid-2025 refresh
    currency: 'points',
    programId: 'chase-ur',
    pointValueCents: 1.5, // Ultimate Rewards planning value (shared with programs.ts)
    baseMultiplier: 1,
    rules: [
      {
        categories: ['travel'],
        multiplier: 8,
        merchantIds: ['chase-travel'],
        note: '8x on travel booked through Chase Travel — hotel stays booked there forfeit elite perks, points and night credit',
      },
      {
        categories: ['travel'],
        multiplier: 4,
        merchantKinds: ['airline', 'hotel'],
        note: '4x on flights and hotels booked DIRECT with the airline or hotel; OTAs, Airbnb and Amtrak earn 1x',
      },
      { categories: ['dining'], multiplier: 3 },
    ],
    signupBonus: { points: 60000, minSpend: 5000, months: 3 },
    gradient: ['#0d1b2a', '#2c3e50'],
    highlights: [
      '$300 annual travel credit + $500 The Edit hotel credits',
      '4x flights & hotels, 3x dining',
      'Sapphire Lounges + Priority Pass',
      'Over $2,500/yr in credits can offset the $795 fee for frequent travelers',
    ],
    credits: CSR_CREDITS,
  },
  {
    id: 'chase-freedom-unlimited',
    name: 'Chase Freedom Unlimited',
    issuer: 'Chase',
    network: 'visa',
    annualFee: 0,
    currency: 'cashback',
    pointValueCents: 1,
    baseMultiplier: 1.5,
    rules: [
      { categories: ['dining'], multiplier: 3 },
      { categories: ['health'], multiplier: 3, note: '3% at drugstores' },
    ],
    signupBonus: { points: 20000, minSpend: 500, months: 3 }, // $200 cash
    gradient: ['#0f4c81', '#3b82c4'],
    highlights: [
      '1.5% on everything, no annual fee',
      '3% on dining & drugstores',
      '5% on travel booked through Chase (not modeled)',
    ],
  },
  {
    id: 'chase-freedom-flex',
    name: 'Chase Freedom Flex',
    issuer: 'Chase',
    network: 'mastercard',
    annualFee: 0,
    currency: 'cashback',
    pointValueCents: 1,
    baseMultiplier: 1,
    rules: [
      { categories: ['groceries'], multiplier: 5, capPerYear: 6000, note: '5% rotating quarterly categories on up to $1,500/quarter (activation required) — modeled as groceries' },
      { categories: ['dining'], multiplier: 3 },
      { categories: ['health'], multiplier: 3, note: '3% at drugstores' },
    ],
    signupBonus: { points: 20000, minSpend: 500, months: 3 }, // $200 cash
    gradient: ['#12355b', '#2563a8'],
    highlights: [
      '5% rotating quarterly categories (up to $1,500/quarter)',
      '3% on dining & drugstores',
      'No annual fee',
    ],
  },

  // ------------------------------------------------ Chase co-branded -------
  {
    id: 'united-explorer',
    name: 'United Explorer',
    issuer: 'Chase',
    network: 'visa',
    annualFee: 95, // $0 the first year, then $95
    currency: 'miles',
    programId: 'united',
    pointValueCents: 1.3, // MileagePlus planning value (shared with programs.ts)
    baseMultiplier: 1,
    rules: [
      {
        categories: ['travel'],
        multiplier: 2,
        programIds: ['united'],
        merchantKinds: ['hotel'],
        note: '2x on United purchases and on hotel stays booked direct; all other travel earns 1x',
      },
      { categories: ['dining'], multiplier: 2, note: 'Restaurants incl. eligible delivery' },
    ],
    // Public offers in 2025 ranged 50k–80k; 60k after $3k is the steady state.
    signupBonus: { points: 60000, minSpend: 3000, months: 3 },
    gradient: ['#0b2a55', '#1f5fa8'],
    highlights: [
      'Free first checked bag for you and a companion on United',
      '2 United Club one-time passes every year',
      '$0 intro annual fee the first year, then $95',
      '25% back on United inflight purchases; Global Entry / TSA PreCheck credit',
    ],
  },
  {
    id: 'marriott-bonvoy-boundless',
    name: 'Marriott Bonvoy Boundless',
    issuer: 'Chase',
    network: 'visa',
    annualFee: 95,
    currency: 'points',
    programId: 'marriott',
    pointValueCents: 0.8, // Bonvoy planning value (shared with programs.ts)
    baseMultiplier: 2,
    rules: [
      {
        categories: ['travel'],
        multiplier: 6,
        programIds: ['marriott'],
        note: '6x at Marriott Bonvoy hotels; all other travel earns the 2x base rate',
      },
      { categories: ['groceries'], multiplier: 3, capPerYear: 6000, note: 'Grocery, gas & dining share one $6,000/yr cap, then 2x' },
      { categories: ['transport'], multiplier: 3, capPerYear: 6000, note: 'Gas stations; shares the $6,000/yr cap with groceries & dining' },
      { categories: ['dining'], multiplier: 3, capPerYear: 6000, note: 'Shares the $6,000/yr cap with groceries & gas' },
    ],
    // Offers alternate between 3 Free Night Awards (up to 50k each) and a
    // points bonus; 125k points is a fair points-equivalent of the usual offer.
    signupBonus: { points: 125000, minSpend: 3000, months: 3 },
    gradient: ['#5a1d3c', '#9c2f5f'],
    highlights: [
      'Free Night Award (up to 35,000 points) every anniversary',
      'Automatic Silver Elite + 15 elite night credits a year',
      '6x at Marriott hotels, 3x groceries/gas/dining (up to $6k/yr)',
      'Bonus modeled as 125,000 points — offers alternate with 3 free nights',
    ],
  },
  {
    id: 'world-of-hyatt',
    name: 'World of Hyatt Credit Card',
    issuer: 'Chase',
    network: 'visa',
    annualFee: 95,
    currency: 'points',
    programId: 'hyatt',
    pointValueCents: 1.7, // World of Hyatt planning value (shared with programs.ts)
    baseMultiplier: 1,
    rules: [
      {
        categories: ['travel'],
        multiplier: 4,
        programIds: ['hyatt'],
        note: '4x card points at Hyatt hotels, on top of the base points the stay earns as a World of Hyatt member',
      },
      {
        categories: ['travel'],
        multiplier: 2,
        merchantKinds: ['airline'],
        note: '2x on airline tickets bought direct from the airline; other travel earns 1x',
      },
      { categories: ['dining'], multiplier: 2 },
      { categories: ['transport'], multiplier: 2, note: 'Local transit & commuting' },
      { categories: ['health'], multiplier: 2, note: 'Fitness club & gym memberships' },
    ],
    // 30k after $3k in 3 months, plus up to 30k more via 2x on the first $15k
    // in 6 months (second tranche not modeled).
    signupBonus: { points: 30000, minSpend: 3000, months: 3 },
    gradient: ['#2b1d4a', '#5b3f8a'],
    highlights: [
      'Free night (Category 1–4) every anniversary, another after $15k spend',
      'Automatic Discoverist status + 5 elite nights a year',
      'Hyatt points are the strongest hotel currency (~1.7¢)',
      '2x dining, flights, transit & gym memberships',
    ],
  },
  {
    id: 'ihg-one-rewards-premier',
    name: 'IHG One Rewards Premier',
    issuer: 'Chase',
    network: 'mastercard',
    annualFee: 99,
    currency: 'points',
    programId: 'ihg',
    pointValueCents: 0.5, // IHG One Rewards planning value (shared with programs.ts)
    baseMultiplier: 3,
    rules: [
      {
        categories: ['travel'],
        multiplier: 10,
        programIds: ['ihg'],
        note: '10x card points at IHG hotels (up to 26x with base points and the Platinum Elite bonus)',
      },
      { categories: ['travel'], multiplier: 5, note: '5x on all other travel — this rate is category-wide' },
      { categories: ['dining'], multiplier: 5 },
      { categories: ['transport'], multiplier: 5, note: 'Gas stations' },
    ],
    // Offers in 2025 ranged 140k–175k after $3k–$4k.
    signupBonus: { points: 140000, minSpend: 3000, months: 3 },
    gradient: ['#1f1f23', '#8a6d2f'],
    highlights: [
      'Anniversary Free Night (up to 40,000 points)',
      'Automatic Platinum Elite status; 4th night free on award stays',
      '10x at IHG hotels, 5x travel, dining & gas, 3x everything else',
      '$50/yr United TravelBank cash + Global Entry credit (not modeled)',
    ],
  },
  {
    id: 'amazon-prime-visa',
    name: 'Prime Visa',
    issuer: 'Chase',
    network: 'visa',
    annualFee: 0, // $0 card fee, but the 5% rate requires a paid Prime membership
    currency: 'cashback',
    // Rewards are Chase points redeemable at 1¢ against Amazon orders, cash
    // back or Chase Travel. They do NOT transfer to airline partners, so this
    // is a cash-back card with no programId.
    pointValueCents: 1,
    baseMultiplier: 1,
    rules: [
      {
        categories: ['shopping'],
        multiplier: 5,
        merchantIds: ['amazon'],
        merchantPattern: 'AMAZON|AMZN',
        note: '5% at Amazon.com and Amazon-owned sites with an eligible Prime membership; all other shopping earns 1%',
      },
      {
        categories: ['groceries'],
        multiplier: 5,
        merchantIds: ['whole-foods', 'amazon-fresh'],
        merchantPattern: 'WHOLE FOODS|WHOLEFDS|AMAZON FRESH|AMZN FRESH',
        note: '5% at Whole Foods Market and Amazon Fresh; every other grocery store earns 1%',
      },
      {
        categories: ['travel'],
        multiplier: 5,
        merchantIds: ['chase-travel'],
        note: '5% on travel booked through Chase Travel; travel booked direct earns 1%',
      },
      { categories: ['dining'], multiplier: 2, note: 'Restaurants, including takeout and delivery' },
      { categories: ['transport'], multiplier: 2, note: 'Gas stations and local transit & commuting' },
    ],
    // The welcome offer is an Amazon gift card granted at approval (usually
    // $100–$200), not a spend-based bonus, so there is no signupBonus to track.
    gradient: ['#1b2a3a', '#2f6f9f'],
    highlights: [
      '5% back at Amazon and Whole Foods with an eligible Prime membership (3% without)',
      '5% on travel booked through Chase Travel; 2% on dining, gas and transit',
      'No annual fee on the card itself — the 5% rate rides on your Prime membership',
      'Welcome offer is an Amazon gift card at approval, not a spend bonus, so it is not tracked here',
    ],
  },

  // --------------------------------------------------- American Express ----
  {
    id: 'amex-gold',
    name: 'American Express Gold',
    issuer: 'American Express',
    network: 'amex',
    annualFee: 325,
    currency: 'points',
    programId: 'amex-mr',
    // Membership Rewards planning value (shared with programs.ts): transfer
    // partners commonly yield 1.5–1.7c per point; 1.6 is the midpoint.
    pointValueCents: 1.6,
    baseMultiplier: 1,
    rules: [
      { categories: ['dining'], multiplier: 4, capPerYear: 50000, note: 'On up to $50,000/yr, then 1x' },
      { categories: ['groceries'], multiplier: 4, capPerYear: 25000, note: 'US supermarkets, on up to $25,000/yr, then 1x' },
      {
        categories: ['travel'],
        multiplier: 3,
        merchantKinds: ['airline'],
        note: '3x on flights booked direct with the airline; hotels, Airbnb and everything else in travel earn 1x',
      },
      {
        categories: ['travel'],
        multiplier: 2,
        merchantIds: ['amex-travel'],
        merchantPattern: AMEX_TRAVEL,
        note: 'Amex Travel pays 3x on flights and 2x on prepaid hotels — a portal charge does not say which, so it is modeled at the lower 2x',
      },
    ],
    signupBonus: { points: 60000, minSpend: 6000, months: 6 },
    gradient: ['#c9a44a', '#e6c878'],
    highlights: [
      '4x at restaurants & US supermarkets',
      "$120 dining + $120 Uber Cash + $100 Resy + $84 Dunkin' credits per year",
      'Transfer to 20+ airline & hotel partners',
    ],
    credits: AMEX_GOLD_CREDITS,
  },
  {
    id: 'amex-platinum',
    name: 'The Platinum Card',
    issuer: 'American Express',
    network: 'amex',
    annualFee: 895, // raised from $695 in the late-2025 refresh
    currency: 'points',
    programId: 'amex-mr',
    pointValueCents: 1.6, // Membership Rewards planning value (shared with programs.ts)
    baseMultiplier: 1,
    rules: [
      {
        categories: ['travel'],
        multiplier: 5,
        capPerYear: 500000,
        merchantKinds: ['airline'],
        merchantIds: ['amex-travel'],
        merchantPattern: AMEX_TRAVEL,
        note: '5x on flights booked direct with the airline or through Amex Travel (up to $500,000/yr), and on prepaid hotels booked through Amex Travel. Hotels booked direct, Airbnb and OTAs earn 1x',
      },
    ],
    signupBonus: { points: 80000, minSpend: 8000, months: 6 },
    gradient: ['#a8a9ad', '#d6d7db'],
    highlights: [
      '5x on flights & prepaid hotels',
      'Centurion & Priority Pass lounge access',
      'Over $2,700/yr in credits (hotel, Resy, Lululemon, Uber, entertainment) can offset the $895 fee',
      'Global Entry ($120) or TSA PreCheck ($85) fee credit — shown annualized at $30/yr',
    ],
    credits: AMEX_PLATINUM_CREDITS,
  },
  {
    id: 'amex-blue-cash-preferred',
    name: 'Blue Cash Preferred',
    issuer: 'American Express',
    network: 'amex',
    annualFee: 95,
    currency: 'cashback',
    pointValueCents: 1,
    baseMultiplier: 1,
    rules: [
      { categories: ['groceries'], multiplier: 6, capPerYear: 6000, note: 'US supermarkets, on up to $6,000/yr, then 1%' },
      { categories: ['subscriptions'], multiplier: 6, note: 'Select US streaming subscriptions' },
      { categories: ['transport'], multiplier: 3, note: 'US gas stations & transit' },
    ],
    signupBonus: { points: 25000, minSpend: 3000, months: 6 }, // $250 cash
    gradient: ['#2456a4', '#5b8fd9'],
    highlights: [
      '6% at US supermarkets (up to $6,000/yr)',
      '6% on streaming, 3% on gas & transit',
      '$0 intro annual fee for the first year; $84/yr Disney Bundle credit',
    ],
    credits: [
      {
        id: 'disney-bundle',
        name: 'Disney Bundle credit',
        amount: 7,
        period: 'monthly',
        category: 'subscriptions',
        matchPattern: 'DISNEY PLUS|DISNEYPLUS|DISNEY\\+|HULU|ESPN',
        how: 'Up to $7 back each month on a Disney+, Hulu or ESPN+ subscription of $9.99 or more. Enrollment required.',
        enrollmentRequired: true,
      },
    ],
  },
  {
    id: 'amex-blue-cash-everyday',
    name: 'Blue Cash Everyday',
    issuer: 'American Express',
    network: 'amex',
    annualFee: 0,
    currency: 'cashback',
    pointValueCents: 1,
    baseMultiplier: 1,
    rules: [
      { categories: ['groceries'], multiplier: 3, capPerYear: 6000, note: 'US supermarkets, on up to $6,000/yr, then 1%' },
      { categories: ['shopping'], multiplier: 3, capPerYear: 6000, note: 'US online retail purchases, on up to $6,000/yr' },
      { categories: ['transport'], multiplier: 3, capPerYear: 6000, note: 'US gas stations, on up to $6,000/yr' },
    ],
    signupBonus: { points: 20000, minSpend: 2000, months: 6 }, // $200 cash
    gradient: ['#5b8fd9', '#8fb8ea'],
    highlights: [
      '3% on groceries, online retail & gas (capped)',
      'No annual fee',
      'Intro APR offers on purchases',
    ],
  },

  // ------------------------------------------------- Amex co-branded -------
  {
    id: 'delta-skymiles-gold-amex',
    name: 'Delta SkyMiles Gold',
    issuer: 'American Express',
    network: 'amex',
    annualFee: 150,
    currency: 'miles',
    programId: 'delta',
    pointValueCents: 1.2, // SkyMiles planning value (shared with programs.ts)
    baseMultiplier: 1,
    rules: [
      {
        categories: ['travel'],
        multiplier: 2,
        programIds: ['delta'],
        note: '2x on Delta purchases; all other travel earns 1x',
      },
      { categories: ['dining'], multiplier: 2, note: 'Restaurants worldwide incl. takeout & delivery in the US' },
      { categories: ['groceries'], multiplier: 2, note: 'US supermarkets' },
    ],
    // Offers in 2025 ranged 40k–80k; 50k after $2k in 6 months is typical.
    signupBonus: { points: 50000, minSpend: 2000, months: 6 },
    gradient: ['#7a1430', '#c8102e'],
    highlights: [
      'First checked bag free and priority boarding on Delta',
      '$200 Delta flight credit after $10,000 in purchases a year (not modeled)',
      '15% off Delta award flights (TakeOff 15)',
      '$100 Delta Stays credit per year; $0 intro fee the first year',
    ],
    credits: [
      {
        id: 'delta-stays',
        name: 'Delta Stays credit',
        amount: 100,
        period: 'annual',
        category: 'travel',
        matchPattern: 'DELTA STAYS',
        how: 'Up to $100 back per calendar year on prepaid hotels or vacation rentals booked through Delta Stays on delta.com.',
      },
    ],
  },
  {
    id: 'delta-skymiles-platinum',
    name: 'Delta SkyMiles Platinum',
    issuer: 'American Express',
    network: 'amex',
    annualFee: 350, // raised from $250 in the 2024 refresh
    currency: 'miles',
    programId: 'delta',
    pointValueCents: 1.2, // SkyMiles planning value (shared with programs.ts)
    baseMultiplier: 1,
    rules: [
      {
        categories: ['travel'],
        multiplier: 3,
        programIds: ['delta'],
        merchantKinds: ['hotel'],
        note: '3x on Delta purchases and on hotels booked direct with the hotel; all other travel earns 1x',
      },
      { categories: ['dining'], multiplier: 2, note: 'Restaurants worldwide incl. takeout & delivery in the US' },
      { categories: ['groceries'], multiplier: 2, note: 'US supermarkets' },
    ],
    // Public offers swing 50k–90k; 50k after $3k in 6 months is the steady state.
    signupBonus: { points: 50000, minSpend: 3000, months: 6 },
    gradient: ['#2c3e5c', '#6b7f9e'],
    highlights: [
      'Annual Companion Certificate (Main Cabin round-trip) — usually worth more than the fee on its own',
      'First checked bag free, Main Cabin 1 priority boarding, 15% off Delta award flights',
      '$150 Delta Stays + $120 Resy + $120 rideshare credits a year',
      'Companion certificate pays out in flights, not dollars, so it is not counted as a credit',
    ],
    credits: [
      {
        id: 'delta-stays',
        name: 'Delta Stays credit',
        amount: 150,
        period: 'annual',
        category: 'travel',
        matchPattern: 'DELTA STAYS',
        how: 'Up to $150 back per calendar year on prepaid hotels and vacation rentals booked through Delta Stays on delta.com.',
      },
      {
        id: 'resy',
        name: 'Resy credit',
        amount: 10,
        period: 'monthly',
        category: 'dining',
        matchPattern: 'RESY',
        how: 'Up to $10 back each month ($120/yr) at US Resy restaurants; pay with the card at any restaurant booked through Resy. Enrollment required.',
        enrollmentRequired: true,
      },
      {
        id: 'rideshare',
        name: 'Rideshare credit',
        amount: 10,
        period: 'monthly',
        category: 'transport',
        matchPattern: 'UBER|LYFT',
        how: 'Up to $10 back each month ($120/yr) on eligible US rideshare — Uber, Lyft, Curb, Revel, Alto. Uber Eats orders match this pattern but do not qualify. Enrollment required.',
        enrollmentRequired: true,
      },
    ],
  },
  {
    id: 'delta-skymiles-reserve',
    name: 'Delta SkyMiles Reserve',
    issuer: 'American Express',
    network: 'amex',
    annualFee: 650, // raised from $550 in the 2024 refresh
    currency: 'miles',
    programId: 'delta',
    pointValueCents: 1.2, // SkyMiles planning value (shared with programs.ts)
    baseMultiplier: 1,
    rules: [
      {
        categories: ['travel'],
        multiplier: 3,
        programIds: ['delta'],
        note: '3x on Delta purchases; all other travel — other airlines, hotels, Airbnb, rail — earns 1x',
      },
    ],
    // Public offers swing 60k–100k; 60k after $6k in 6 months is the steady state.
    signupBonus: { points: 60000, minSpend: 6000, months: 6 },
    gradient: ['#0b2545', '#8c1d40'],
    highlights: [
      'Delta Sky Club access when flying Delta (15 visits a year; unlimited above $75k of spend)',
      'Annual Companion Certificate — First Class, Comfort+ or Main Cabin',
      'First checked bag free, Sky Priority boarding, 15% off Delta award flights',
      '$240 Resy + $120 rideshare + $200 Delta Stays credits a year',
    ],
    credits: DELTA_RESERVE_CREDITS,
  },
  {
    id: 'hilton-honors-amex',
    name: 'Hilton Honors American Express',
    issuer: 'American Express',
    network: 'amex',
    annualFee: 0,
    currency: 'points',
    programId: 'hilton',
    pointValueCents: 0.5, // Hilton Honors planning value (shared with programs.ts)
    baseMultiplier: 3,
    rules: [
      {
        categories: ['travel'],
        multiplier: 7,
        programIds: ['hilton'],
        merchantPattern: HILTON_BRANDS,
        note: '7x at Hilton portfolio hotels & resorts; all other travel earns the 3x base rate',
      },
      { categories: ['dining'], multiplier: 5, note: 'US restaurants' },
      { categories: ['groceries'], multiplier: 5, note: 'US supermarkets' },
      { categories: ['transport'], multiplier: 5, note: 'US gas stations' },
    ],
    // Offers commonly run 70k–100k after $2k in 6 months.
    signupBonus: { points: 80000, minSpend: 2000, months: 6 },
    gradient: ['#1e4a9c', '#4d7fd0'],
    highlights: [
      '7x at Hilton, 5x US restaurants, supermarkets & gas, 3x everything else',
      'No annual fee; complimentary Hilton Honors Silver status',
      'Gold status after $20,000 of purchases in a calendar year',
      'No statement credits — the entry point to the Hilton Amex family',
    ],
  },
  {
    id: 'hilton-honors-surpass',
    name: 'Hilton Honors Surpass',
    issuer: 'American Express',
    network: 'amex',
    annualFee: 150,
    currency: 'points',
    programId: 'hilton',
    pointValueCents: 0.5, // Hilton Honors planning value (shared with programs.ts)
    baseMultiplier: 3,
    rules: [
      {
        categories: ['travel'],
        multiplier: 12,
        programIds: ['hilton'],
        merchantPattern: HILTON_BRANDS,
        note: '12x at Hilton portfolio hotels & resorts; all other travel earns the 3x base rate',
      },
      { categories: ['dining'], multiplier: 6, note: 'US restaurants incl. takeout & delivery' },
      { categories: ['groceries'], multiplier: 6, note: 'US supermarkets' },
      { categories: ['transport'], multiplier: 6, note: 'US gas stations' },
      { categories: ['shopping'], multiplier: 4, note: 'US online retail purchases' },
    ],
    // Offers in 2025 ranged 130k–165k after $3k in 6 months.
    signupBonus: { points: 130000, minSpend: 3000, months: 6 },
    gradient: ['#1b2a4a', '#3f6fb5'],
    highlights: [
      'Complimentary Hilton Honors Gold status (Diamond after $40k spend)',
      '12x at Hilton, 6x dining, groceries & gas, 3x everything else',
      'Up to $200/yr in Hilton credits ($50 per quarter)',
      'Free Night Reward after $15,000 in purchases a year',
    ],
    credits: [
      {
        id: 'hilton-credit',
        name: 'Hilton credit',
        amount: 50,
        period: 'quarterly',
        category: 'travel',
        matchPattern: HILTON_BRANDS,
        how: 'Up to $50 back each calendar quarter on purchases made directly with Hilton portfolio hotels & resorts — room rates, dining, spa. Unused quarters do not roll over.',
      },
    ],
  },
  {
    id: 'hilton-honors-aspire',
    name: 'Hilton Honors Aspire',
    issuer: 'American Express',
    network: 'amex',
    annualFee: 550, // raised from $450 in the 2024 refresh
    currency: 'points',
    programId: 'hilton',
    pointValueCents: 0.5, // Hilton Honors planning value (shared with programs.ts)
    baseMultiplier: 3,
    rules: [
      {
        categories: ['travel'],
        multiplier: 14,
        programIds: ['hilton'],
        merchantPattern: HILTON_BRANDS,
        note: '14x at Hilton portfolio hotels & resorts — Hilton stays only. A Hyatt, Marriott or independent hotel earns the 3x base rate',
      },
      {
        categories: ['travel'],
        multiplier: 7,
        merchantKinds: ['airline'],
        merchantIds: ['amex-travel'],
        merchantPattern: AMEX_TRAVEL,
        note: '7x on flights booked direct with the airline or through Amex Travel (car rentals booked direct also earn 7x — not modeled, no car-rental merchants in the directory)',
      },
      { categories: ['dining'], multiplier: 7, note: 'US restaurants' },
    ],
    // Offers in 2025–2026 ran 150k–200k after $6k in 6 months.
    signupBonus: { points: 175000, minSpend: 6000, months: 6 },
    gradient: ['#0b3d6b', '#1a6bb5'],
    highlights: [
      '14x at Hilton, 7x US restaurants, flights & car rentals, 3x everything else',
      'Automatic Hilton Honors Diamond status — the top published tier',
      '$400 resort credit ($200 semi-annually) + $200 flight credit ($50 quarterly) + CLEAR Plus',
      'Free Night Reward every year, plus one more at $30k and another at $60k of spend',
    ],
    credits: HILTON_ASPIRE_CREDITS,
  },
  {
    id: 'amex-marriott-bonvoy-bevy',
    name: 'Marriott Bonvoy Bevy',
    issuer: 'American Express',
    network: 'amex',
    annualFee: 250,
    currency: 'points',
    programId: 'marriott',
    pointValueCents: 0.8, // Bonvoy planning value (shared with programs.ts)
    baseMultiplier: 2,
    rules: [
      {
        categories: ['travel'],
        multiplier: 6,
        programIds: ['marriott'],
        note: '6x at Marriott Bonvoy hotels; all other travel earns the 2x base rate',
      },
      { categories: ['dining'], multiplier: 4, capPerYear: 15000, note: 'Restaurants worldwide; shares one $15,000/yr cap with US supermarkets, then 2x' },
      { categories: ['groceries'], multiplier: 4, capPerYear: 15000, note: 'US supermarkets; shares the $15,000/yr cap with dining, then 2x' },
    ],
    // Offers alternate between roughly 85k and 155k points after $5k–$6k.
    signupBonus: { points: 85000, minSpend: 5000, months: 6 },
    gradient: ['#16233d', '#33507f'],
    highlights: [
      '6x at Marriott Bonvoy hotels, 4x dining & US supermarkets (up to $15k/yr), 2x everything else',
      'Automatic Gold Elite status + 15 elite night credits a year',
      'The middle Amex Bonvoy card — between the no-fee Bonvoy Amex and the $650 Brilliant',
      'No statement credits are modeled: the value here is the earn rates and elite status',
    ],
  },
  {
    id: 'marriott-bonvoy-brilliant',
    name: 'Marriott Bonvoy Brilliant',
    issuer: 'American Express',
    network: 'amex',
    annualFee: 650,
    currency: 'points',
    programId: 'marriott',
    pointValueCents: 0.8, // Bonvoy planning value (shared with programs.ts)
    baseMultiplier: 2,
    rules: [
      {
        categories: ['travel'],
        multiplier: 6,
        programIds: ['marriott'],
        note: '6x at Marriott Bonvoy hotels — Marriott stays only. A Hyatt or Hilton stay earns the 2x base rate',
      },
      {
        categories: ['travel'],
        multiplier: 3,
        merchantKinds: ['airline'],
        note: '3x on flights booked direct with the airline; other travel earns 2x',
      },
      { categories: ['dining'], multiplier: 3, note: 'Restaurants worldwide' },
    ],
    signupBonus: { points: 95000, minSpend: 6000, months: 6 },
    gradient: ['#1c1c1c', '#8a6d3b'],
    highlights: [
      '6x at Marriott hotels, 3x dining & direct-booked flights, 2x everything else',
      'Free Night Award up to 85,000 points every anniversary (~$680 at our 0.8¢ Bonvoy value)',
      'Automatic Platinum Elite status + 25 elite night credits a year',
      '$100 Ritz-Carlton / St. Regis on-property credit on 2-night stays (paid at the hotel, not modeled)',
    ],
    credits: BONVOY_BRILLIANT_CREDITS,
  },

  // --------------------------------------------------------- Capital One ---
  {
    id: 'capital-one-savor',
    name: 'Capital One Savor',
    issuer: 'Capital One',
    network: 'mastercard',
    annualFee: 0, // post-2024 lineup: the no-fee Savor (formerly SavorOne)
    currency: 'cashback',
    pointValueCents: 1,
    baseMultiplier: 1,
    rules: [
      { categories: ['dining'], multiplier: 3 },
      { categories: ['groceries'], multiplier: 3, note: 'Excludes superstores like Walmart & Target' },
      { categories: ['entertainment'], multiplier: 3 },
      { categories: ['subscriptions'], multiplier: 3, note: 'Popular streaming services' },
    ],
    signupBonus: { points: 20000, minSpend: 500, months: 3 }, // $200 cash
    gradient: ['#8c4a2f', '#c07a4a'],
    highlights: [
      '3% on dining, groceries, entertainment & streaming',
      'No annual fee',
      'No foreign transaction fees',
    ],
  },
  {
    id: 'capital-one-venture',
    name: 'Capital One Venture',
    issuer: 'Capital One',
    network: 'visa',
    annualFee: 95,
    currency: 'miles',
    programId: 'capital-one',
    // Capital One miles planning value (shared with programs.ts): 1c erased
    // against travel, ~1.4c via 1:1 airline transfers.
    pointValueCents: 1.4,
    baseMultiplier: 2,
    rules: [],
    signupBonus: { points: 75000, minSpend: 4000, months: 3 },
    gradient: ['#3d4a5c', '#66788c'],
    highlights: [
      '2x miles on every purchase',
      'Transfer to 15+ airline & hotel partners',
      'Global Entry / TSA PreCheck credit',
    ],
  },
  {
    id: 'capital-one-venture-x',
    name: 'Capital One Venture X',
    issuer: 'Capital One',
    network: 'visa',
    annualFee: 395,
    currency: 'miles',
    programId: 'capital-one',
    pointValueCents: 1.4, // Capital One miles planning value (shared with programs.ts)
    baseMultiplier: 2,
    rules: [
      {
        categories: ['travel'],
        multiplier: 5,
        merchantIds: ['capital-one-travel'],
        note: '5x flights and 10x hotels & rental cars booked through Capital One Travel — modeled at the lower 5x, since a portal charge does not say which. Booked anywhere else, travel earns the 2x base rate',
      },
    ],
    signupBonus: { points: 75000, minSpend: 4000, months: 3 },
    gradient: ['#23272e', '#4b5563'],
    highlights: [
      '$300 annual travel credit + 10,000 anniversary miles',
      '2x miles minimum on everything',
      'Capital One & Priority Pass lounge access',
    ],
    credits: [
      {
        id: 'travel-credit',
        name: 'Capital One Travel credit',
        amount: 300,
        period: 'anniversary',
        category: 'travel',
        matchPattern: 'CAPITAL ONE TRAVEL',
        how: 'Up to $300 back on flights, hotels and rental cars booked through Capital One Travel each cardmember year. Applied automatically as a statement credit.',
      },
    ],
  },

  // ---------------------------------------------------------------- Citi ---
  {
    id: 'citi-double-cash',
    name: 'Citi Double Cash',
    issuer: 'Citi',
    network: 'mastercard',
    annualFee: 0,
    currency: 'cashback',
    pointValueCents: 1,
    // Flat 2% on everything (1% when you buy + 1% when you pay), so it lives
    // in baseMultiplier rather than a category rule.
    baseMultiplier: 2,
    rules: [],
    signupBonus: { points: 20000, minSpend: 1500, months: 6 }, // $200 cash
    gradient: ['#4a4a52', '#6b6b75'],
    highlights: [
      'Flat 2% on everything — 1% when you buy, 1% when you pay',
      'No annual fee',
      'No categories to track',
    ],
  },
  {
    id: 'citi-custom-cash',
    name: 'Citi Custom Cash',
    issuer: 'Citi',
    network: 'mastercard',
    annualFee: 0,
    currency: 'cashback',
    pointValueCents: 1,
    baseMultiplier: 1,
    rules: [
      { categories: ['groceries'], multiplier: 5, capPerYear: 6000, note: '5% on your top eligible category each billing cycle, up to $500/mo — modeled as groceries' },
    ],
    signupBonus: { points: 20000, minSpend: 1500, months: 6 }, // $200 cash
    gradient: ['#23689b', '#4a94c8'],
    highlights: [
      '5% on your top spend category each month (up to $500)',
      'Adapts automatically — no activation',
      'No annual fee',
    ],
  },
  {
    id: 'citi-strata-premier',
    name: 'Citi Strata Premier',
    issuer: 'Citi',
    network: 'mastercard',
    annualFee: 95,
    currency: 'points',
    programId: 'citi-ty',
    // ThankYou Points planning value (shared with programs.ts): 1c via
    // portal/gift cards, ~1.4c via airline transfers.
    pointValueCents: 1.4,
    baseMultiplier: 1,
    rules: [
      { categories: ['dining'], multiplier: 3 },
      { categories: ['groceries'], multiplier: 3, note: 'Supermarkets' },
      { categories: ['transport'], multiplier: 3, note: 'Gas & EV charging' },
      {
        categories: ['travel'],
        multiplier: 3,
        merchantKinds: ['airline', 'hotel'],
        note: '3x on air travel and hotels; other travel (OTAs, rail, rideshare) earns 1x. The 10x on hotels & cars via Citi Travel is not modeled',
      },
    ],
    signupBonus: { points: 60000, minSpend: 4000, months: 3 },
    gradient: ['#27364b', '#46597a'],
    highlights: [
      '3x on dining, groceries, gas & travel',
      '$100 hotel benefit on $500+ stays',
      'Transfer to ThankYou airline partners',
    ],
    credits: [
      {
        id: 'hotel-benefit',
        name: 'Hotel benefit',
        amount: 100,
        period: 'annual',
        category: 'travel',
        how: '$100 off a single hotel stay of $500 or more (before taxes and fees) booked through Citi Travel, once per calendar year. Applied at booking, so mark it used here.',
      },
    ],
  },

  // --------------------------------------------------------------- Other ---
  {
    id: 'discover-it-cash-back',
    name: 'Discover it Cash Back',
    issuer: 'Discover',
    network: 'discover',
    annualFee: 0,
    currency: 'cashback',
    pointValueCents: 1,
    baseMultiplier: 1,
    rules: [
      { categories: ['groceries'], multiplier: 5, capPerYear: 6000, note: '5% rotating quarterly categories on up to $1,500/quarter (activation required) — modeled as groceries' },
    ],
    // No traditional signup bonus — Cashback Match doubles year-one earnings
    // instead; we leave signupBonus off rather than fake one.
    gradient: ['#e55c20', '#f39c5a'],
    highlights: [
      '5% rotating quarterly categories (up to $1,500/quarter)',
      'Cashback Match doubles everything you earn in year one',
      'No annual fee',
    ],
  },
  {
    id: 'wells-fargo-active-cash',
    name: 'Wells Fargo Active Cash',
    issuer: 'Wells Fargo',
    network: 'visa',
    annualFee: 0,
    currency: 'cashback',
    pointValueCents: 1,
    baseMultiplier: 2, // flat 2% on everything
    rules: [],
    signupBonus: { points: 20000, minSpend: 500, months: 3 }, // $200 cash
    gradient: ['#7a1f1f', '#b03a2e'],
    highlights: [
      'Flat 2% cash rewards on purchases',
      'No annual fee',
      'Cell phone protection when you pay your bill with the card',
    ],
  },
  {
    id: 'us-bank-cash-plus',
    name: 'U.S. Bank Cash+',
    issuer: 'U.S. Bank',
    network: 'visa',
    annualFee: 0,
    currency: 'cashback',
    pointValueCents: 1,
    baseMultiplier: 1,
    rules: [
      { categories: ['utilities'], multiplier: 5, capPerYear: 8000, note: '5% on two categories you choose (e.g. utilities, internet/streaming), up to $2,000/quarter combined — modeled as utilities' },
      { categories: ['groceries'], multiplier: 2, note: '2% on one everyday category — groceries, gas, or restaurants' },
    ],
    signupBonus: { points: 20000, minSpend: 1000, months: 4 }, // $200 cash
    gradient: ['#1b458f', '#3968b5'],
    highlights: [
      '5% on two categories you pick (up to $2,000/quarter)',
      '2% on one everyday category',
      'No annual fee',
    ],
  },
  {
    id: 'bilt-mastercard',
    name: 'Bilt Mastercard',
    issuer: 'Bilt / Wells Fargo',
    network: 'mastercard',
    annualFee: 0,
    currency: 'points',
    programId: 'bilt',
    // Bilt Rewards planning value (shared with programs.ts): 1:1 transfers to
    // Hyatt and strong airline partners make 1.5c conservative.
    pointValueCents: 1.5,
    baseMultiplier: 1,
    rules: [
      { categories: ['dining'], multiplier: 3 },
      {
        categories: ['travel'],
        multiplier: 2,
        merchantKinds: ['airline', 'hotel'],
        note: '2x on travel booked direct with an airline or hotel (car-rental and cruise bookings also qualify — not modeled, no such merchants in the directory); OTAs and rail earn 1x',
      },
    ],
    // No standard public signup bonus.
    gradient: ['#1a1a1a', '#3d3d3d'],
    highlights: [
      '1x points on rent with no transaction fee (up to 100k pts/yr)',
      '3x dining, 2x travel',
      'Transfer 1:1 to Hyatt & major airline partners',
      'Requires 5 transactions per statement period to earn',
    ],
  },
];

export function productById(id: string): CardProduct | undefined {
  return CARD_PRODUCTS.find((p) => p.id === id);
}
