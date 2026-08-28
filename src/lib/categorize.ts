import type { CategoryId } from '../types';

// Merchant normalization + keyword categorization for raw statement text.
//
// Given a raw statement description like "TST* SWEETGREEN #402 NYC" returns a
// cleaned display merchant ("Sweetgreen") and a best-guess category, using an
// ordered keyword rule table covering common US merchants and statement
// patterns. First matching rule wins; rules without an explicit `merchant`
// fall back to the cleaned-up description. Unmatched text is 'other'.
//
// Two steps run before the table:
//   1. ACH/bank descriptors ("ORIG CO NAME:AMERICAN EXPRESS CO ENTRY DESCR:PMT
//      SEC:WEB IND ID:1234") are split on their field labels, and only the
//      originating company survives — so the table matches "AMERICAN EXPRESS"
//      and the display name carries none of the ID trailer. An issuer name plus
//      a payment descriptor is a card payment ('transfer'), not spending.
//   2. Acquirer prefixes (TST*, SQ *, RESY*) are stripped for display.
//
// explainCategory() returns the same answer plus the id of the rule that fired,
// so the UI can show why a transaction was filed where it was.

interface Rule {
  /** Short stable label for this rule, surfaced by explainCategory(). */
  id: string;
  re: RegExp;
  category: CategoryId;
  /** Canonical display name. When omitted, the cleaned description is used. */
  merchant?: string;
}

// ---------------------------------------------------------------------------
// ACH / bank-descriptor normalisation. Runs BEFORE the keyword table.
//
// Bank feeds hand us machine descriptors rather than merchant names:
//   ORIG CO NAME:AMERICAN EXPRESS CO ENTRY DESCR:PMT SEC:WEB IND ID:1234
//   AMERICAN EXPRESS DES:ACH PMT ID:1234 INDN:JOE H CO ID:1234567890 WEB
// Matching keywords against that raw text is unreliable (the trailing
// SEC/IND/PPD noise is not merchant text, and "PMT" would file a utility
// autopay as a transfer). So we first split the descriptor on its known field
// labels, pull out the originating company, and let the rest of the pipeline
// see ONLY that company name.

/** Field labels seen in NACHA-derived statement text. Longest-first at match time. */
const ACH_LABELS = [
  'ORIG CO NAME', 'CO NAME', 'COMPANY NAME', 'ORIG NAME', 'MERCHANT NAME',
  'CO ENTRY DESCR', 'ENTRY DESCR', 'ENTRY DESC', 'DESCR', 'DESC', 'DES',
  'ORIG ID', 'CO ID', 'COMPANY ID', 'IND ID', 'INDN ID', 'INDN NAME', 'INDN',
  'PPD ID', 'CCD ID', 'WEB ID', 'TEL ID', 'ARC ID', 'SEC', 'ID',
  'TRN', 'TRACE', 'EED', 'REF', 'MEMO', 'TYPE',
];
/** Labels whose value is the originating company. */
const ACH_COMPANY_LABELS = new Set(['ORIG CO NAME', 'CO NAME', 'COMPANY NAME', 'ORIG NAME', 'MERCHANT NAME']);
/** Labels whose value describes the entry ("PMT", "EPAY", "ACH PMT", "BILL PAY"). */
const ACH_DESCR_LABELS = new Set(['CO ENTRY DESCR', 'ENTRY DESCR', 'ENTRY DESC', 'DESCR', 'DESC', 'DES', 'TYPE']);

const ACH_LABEL_RE = new RegExp(
  `\\b(${[...ACH_LABELS]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})\\s*:\\s*`,
  'g',
);

interface AchDescriptor {
  /** Originating company, e.g. "AMERICAN EXPRESS" or "CHASE CREDIT CRD". */
  company: string;
  /** Entry description, e.g. "PMT", "EPAY", "ACH PMT". */
  descr: string;
}

/** Parse a bank/ACH descriptor. Returns null for ordinary card-swipe text. */
function parseAchDescriptor(upper: string): AchDescriptor | null {
  ACH_LABEL_RE.lastIndex = 0;
  const hits: { label: string; start: number; valueStart: number }[] = [];
  for (const m of upper.matchAll(ACH_LABEL_RE)) {
    if (m.index === undefined) continue;
    hits.push({ label: m[1], start: m.index, valueStart: m.index + m[0].length });
  }
  if (!hits.length) return null;

  const valueOf = (i: number) =>
    upper.slice(hits[i].valueStart, i + 1 < hits.length ? hits[i + 1].start : upper.length).trim();

  let company = '';
  let descr = '';
  let sawCompanyLabel = false;
  let sawDescrLabel = false;
  for (let i = 0; i < hits.length; i++) {
    if (ACH_COMPANY_LABELS.has(hits[i].label)) {
      sawCompanyLabel = true;
      if (!company) company = valueOf(i);
    } else if (ACH_DESCR_LABELS.has(hits[i].label)) {
      sawDescrLabel = true;
      if (!descr) descr = valueOf(i);
    }
  }
  // A lone "ID:" is not enough to call something an ACH descriptor.
  if (!sawCompanyLabel && !(sawDescrLabel && hits.length >= 2)) return null;

  // "AMERICAN EXPRESS DES:ACH PMT ID:..." puts the company before the first label.
  const lead = upper.slice(0, hits[0].start).trim();
  if (!company) company = lead;
  if (!company) company = descr;

  company = company
    .replace(/\b\d{5,}\b.*$/, '') // trailing originator/trace ids
    .replace(/\s+(CO|CO\.|INC|INC\.|LLC|CORP)$/, '')
    .replace(/[\s\-–—.,:;*]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { company, descr };
}

/** Card issuers whose ACH pulls are card payments, not spending. */
const CARD_ISSUERS: { re: RegExp; name: string }[] = [
  { re: /AMERICAN EXPRESS|\bAMEX\b/, name: 'American Express' },
  { re: /\bCHASE\b|JPMORGAN|JP MORGAN/, name: 'Chase' },
  { re: /\bCITI\b|CITIBANK|CITICARD|CITI CARD/, name: 'Citi' },
  { re: /CAPITAL ?ONE/, name: 'Capital One' },
  { re: /DISCOVER/, name: 'Discover' },
  { re: /BARCLAY/, name: 'Barclays' },
  { re: /WELLS ?FARGO/, name: 'Wells Fargo' },
  { re: /BANK ?OF ?AMERICA|BANKAMERICA|\bBOFA\b/, name: 'Bank of America' },
  { re: /\bU\.?S\.? ?BANK\b|USBANK/, name: 'US Bank' },
  { re: /SYNCHRONY/, name: 'Synchrony' },
];

/**
 * Entry descriptions that mean "this pulled money to pay a card":
 * PMT, PAYMENT, EPAY, AUTOPAY. Suffix-matched on PMT because issuers run it
 * together with the card word — Capital One sends "CRCARDPMT", Citi "CITICARDPMT".
 */
const ACH_PAYMENT_RE = /PMTS?\b|PAYMENT|EPAY|AUTO ?PAY/;

// ---------------------------------------------------------------------------
// Rule table. Order matters: disambiguators → money movement → brand rules by
// category → generic keyword rules → default 'other'.

const RULES: Rule[] = [
  // --- Disambiguators (more specific variants of brands matched later) -----
  { id: 'brand:uber-eats', re: /UBER\s*\*?\s*EATS|UBEREATS/, category: 'dining', merchant: 'Uber Eats' },
  { id: 'brand:dashpass', re: /DASHPASS/, category: 'subscriptions', merchant: 'DashPass' },
  { id: 'brand:amazon-prime', re: /AMZN PRIME|AMAZON PRIME|PRIME VIDEO|PRIME MEMBERSHIP/, category: 'subscriptions', merchant: 'Amazon Prime' },
  { id: 'brand:amazon-fresh', re: /AMAZON FRESH|AMZN FRESH/, category: 'groceries', merchant: 'Amazon Fresh' },
  { id: 'brand:audible', re: /KINDLE UNLTD|KINDLE UNLIMITED|AUDIBLE/, category: 'subscriptions', merchant: 'Audible' },
  { id: 'brand:costco-gas', re: /COSTCO GAS|COSTCO FUEL/, category: 'transport', merchant: 'Costco Gas' },
  { id: 'brand:xbox-game-pass', re: /XBOX GAME PASS|GAME PASS/, category: 'subscriptions', merchant: 'Xbox Game Pass' },
  { id: 'brand:playstation-plus', re: /PLAYSTATION PLUS|PS PLUS/, category: 'subscriptions', merchant: 'PlayStation Plus' },
  { id: 'brand:nintendo-online', re: /NINTENDO (SWITCH )?ONLINE/, category: 'subscriptions', merchant: 'Nintendo Online' },
  { id: 'brand:walmart-plus', re: /WALMART\+|WALMART PLUS/, category: 'subscriptions', merchant: 'Walmart+' },
  { id: 'brand:instacart-plus', re: /INSTACART\+|INSTACART PLUS/, category: 'subscriptions', merchant: 'Instacart+' },

  // --- Classes, lessons & studios -----------------------------------------
  // Recurring activity spend (dance, martial arts, music) reads as 'other'
  // without these. High in the table because none of the words below appear in
  // any rule further down, so nothing can shadow them and they shadow nothing.
  { id: 'brand:fred-astaire', re: /FRED ASTAIRE/, category: 'entertainment', merchant: 'Fred Astaire Dance Studios' },
  { id: 'brand:arthur-murray', re: /ARTHUR MURRAY/, category: 'entertainment', merchant: 'Arthur Murray Dance Studios' },
  { id: 'kw:dance-studio', re: /DANCE (STUDIO|CENTER|CENTRE|ACADEMY|SCHOOL|COMPANY|CLASS)|SCHOOL OF DANCE|\bBALLET\b|BALLROOM|DANCESPORT/, category: 'entertainment' },
  { id: 'kw:martial-arts', re: /MARTIAL ARTS|\bKARATE\b|TAE ?KWON ?DO|JIU[- ]?JITSU|\bJUDO\b|\bDOJO\b|KICKBOXING|KRAV MAGA/, category: 'entertainment' },
  { id: 'kw:music-lessons', re: /MUSIC (LESSONS?|SCHOOL|ACADEMY|STUDIO|INSTRUCTION|TOGETHER)|(PIANO|GUITAR|VIOLIN|VOICE|DRUM) LESSONS?|SCHOOL OF ROCK|GYMNASTICS|\bTUTORING\b|KUMON|MATHNASIUM/, category: 'entertainment' },

  // --- Childcare -----------------------------------------------------------
  // Filed under 'other': there is no childcare/family CategoryId, and every
  // near-fit would be a lie — it is not medical ('health'), not a night out
  // ('entertainment'), and not a recurring media plan ('subscriptions').
  { id: 'kw:childcare', re: /DAY ?CARE|CHILD ?CARE|PRE-?SCHOOL|NURSERY SCHOOL|MONTESSORI|KINDERCARE|BRIGHT HORIZONS|GODDARD SCHOOL|PRIMROSE SCHOOL|LA PETITE ACADEMY|BABYSIT|\bNANNY\b|CARE\.COM/, category: 'other' },

  // --- Income --------------------------------------------------------------
  { id: 'kw:income-1', re: /PAYROLL|DIRECT ?DEP|DIR DEP|\bSALARY\b|PAYCHECK|\bADP\b|\bGUSTO\b|RIPPLING|JUSTWORKS|PAYCHEX/, category: 'income' },
  { id: 'brand:interest-payment', re: /INTEREST (PAYMENT|PAID|EARNED|CREDIT)/, category: 'income', merchant: 'Interest Payment' },
  { id: 'kw:income-2', re: /\bDIVIDEND/, category: 'income' },
  { id: 'brand:tax-refund', re: /IRS TREAS|TAX REF|US TREASURY|STATE OF .* TAX/, category: 'income', merchant: 'Tax Refund' },
  { id: 'kw:income-3', re: /\bDEPOSIT\b/, category: 'income' },

  // --- Utilities (brands) --------------------------------------------------
  { id: 'brand:pg-and-e', re: /PG&E|PGANDE|PACIFIC GAS/, category: 'utilities', merchant: 'PG&E' },
  { id: 'brand:xfinity', re: /COMCAST|XFINITY/, category: 'utilities', merchant: 'Xfinity' },
  { id: 'brand:verizon', re: /VERIZON|VZWRLSS|\bVZW\b/, category: 'utilities', merchant: 'Verizon' },
  { id: 'brand:t-mobile', re: /T-MOBILE|TMOBILE/, category: 'utilities', merchant: 'T-Mobile' },
  { id: 'brand:at-and-t', re: /AT&T|\bATT\*|\bATT BILL|ATT\s+PAYMENT/, category: 'utilities', merchant: 'AT&T' },
  { id: 'brand:spectrum', re: /SPECTRUM|CHARTER COMM/, category: 'utilities', merchant: 'Spectrum' },
  { id: 'brand:con-edison', re: /CON ?ED\b|CONSOLIDATED EDISON/, category: 'utilities', merchant: 'Con Edison' },
  { id: 'kw:utilities-1', re: /DUKE ENERGY|NATIONAL GRID|SOCAL ?GAS|SO CAL EDISON|\bSCE\b|LADWP|SDG&E|SDGE|EVERSOURCE|\bPSE&?G\b|XCEL ENERGY|DOMINION ENERGY|GEORGIA POWER|FPL\b|AUSTIN ENERGY|SEATTLE CITY LIGHT|PUGET SOUND/, category: 'utilities' },
  { id: 'kw:utilities-2', re: /GOOGLE FI|MINT MOBILE|CRICKET WIRELESS|BOOST MOBILE|VISIBLE\b|US CELLULAR/, category: 'utilities' },
  { id: 'kw:utilities-3', re: /SONIC\.NET|COX COMM|CENTURYLINK|FRONTIER COMM|ASTOUND|RCN\b|OPTIMUM|STARLINK/, category: 'utilities' },
  { id: 'kw:utilities-4', re: /RECOLOGY|WASTE MGMT|WASTE MANAGEMENT|REPUBLIC SERVICES/, category: 'utilities' },
  { id: 'kw:utilities-5', re: /(NATURAL|PIEDMONT|NICOR|PEOPLES|WASHINGTON|COLUMBIA|ATMOS) GAS|GAS (CO\b|COMPANY|SERVICE|& ELEC|AND ELEC)|GAS & ELECTRIC/, category: 'utilities' },

  // --- Transfers / card payments ------------------------------------------
  {
    id: 'brand:card-payment',
    re: /PAYMENT[ -]*THANK YOU|THANK YOU[ -]*PAYMENT|PMT THANK|AUTOPAY|AUTO ?PAY\b|AUTOMATIC PAYMENT|ONLINE PAYMENT|MOBILE PAYMENT|\bEPAY|E-PAYMENT|CARD ?MEMBER SERV|CHASE CREDIT CRD|CITI CARD PAYMENT|AMEX EPAYMENT|CAPITAL ONE.*PMT|DISCOVER.*PAYMENT|CREDIT CARD PAYMENT|PAYMENT RECEIVED/,
    category: 'transfer',
    merchant: 'Card Payment',
  },
  { id: 'brand:zelle', re: /ZELLE/, category: 'transfer', merchant: 'Zelle' },
  { id: 'brand:venmo', re: /VENMO/, category: 'transfer', merchant: 'Venmo' },
  { id: 'brand:cash-app', re: /CASH ?APP/, category: 'transfer', merchant: 'Cash App' },
  { id: 'brand:apple-cash', re: /APPLE CASH/, category: 'transfer', merchant: 'Apple Cash' },
  { id: 'brand:paypal-transfer', re: /PAYPAL (TRANSFER|INST XFER|INSTANT TRANSFER)/, category: 'transfer', merchant: 'PayPal Transfer' },
  { id: 'kw:transfer-1', re: /WIRE (IN|OUT|TRANSFER)|\bTRANSFER\b|\bXFER\b|\bTFR\b/, category: 'transfer' },

  // --- Fees & interest -----------------------------------------------------
  {
    id: 'kw:fees-1',
    re: /\bFEES?\b|INTEREST CHARGE|FINANCE CHARGE|LATE CHARGE|OVERDRAFT|\bNSF\b|SERVICE CHARGE|\bATM\b|FOREIGN TRANS|FX CHARGE|CASH ADVANCE/,
    category: 'fees',
  },
  // Tax prep & paid financial/accounting services: money paid to move money or
  // file paperwork, so 'fees' rather than a spending category. Deliberately
  // narrow — a brokerage or bank name on its own stays a transfer.
  {
    id: 'kw:tax-prep-financial',
    re: /TURBO ?TAX|\bINTUIT\b|H&R ?BLOCK|HR ?BLOCK|JACKSON HEWITT|TAX ?ACT\b|FREETAXUSA|TAXSLAYER|LIBERTY TAX|TAX PREP|TAX SERVICE|\bCPA\b|ACCOUNTING SERV|BOOKKEEPING|FINANCIAL ADVIS|WEALTH MANAGE|ADVISORY (FEE|SERVICE)|NOTARY/,
    category: 'fees',
  },

  // --- Subscriptions (brands) ---------------------------------------------
  { id: 'brand:apple-services', re: /APPLE\.COM\/BILL|APPLE\.COM BILL/, category: 'subscriptions', merchant: 'Apple Services' },
  { id: 'brand:icloud', re: /ICLOUD/, category: 'subscriptions', merchant: 'iCloud' },
  { id: 'brand:apple-services-2', re: /APPLE (MUSIC|TV|ONE|ARCADE)/, category: 'subscriptions', merchant: 'Apple Services' },
  { id: 'brand:netflix', re: /NETFLIX/, category: 'subscriptions', merchant: 'Netflix' },
  { id: 'brand:spotify', re: /SPOTIFY/, category: 'subscriptions', merchant: 'Spotify' },
  { id: 'brand:hulu', re: /\bHULU/, category: 'subscriptions', merchant: 'Hulu' },
  { id: 'brand:disney', re: /DISNEY ?PLUS|DISNEY\+/, category: 'subscriptions', merchant: 'Disney+' },
  { id: 'brand:max', re: /HBO ?MAX|\bHBO\b/, category: 'subscriptions', merchant: 'Max' },
  { id: 'brand:youtube-premium', re: /YOUTUBE ?PREMIUM|YOUTUBE ?TV|GOOGLE \*?YOUTUBE/, category: 'subscriptions', merchant: 'YouTube Premium' },
  { id: 'kw:subscriptions-1', re: /PARAMOUNT\+|PARAMOUNT PLUS|PEACOCK|CRUNCHYROLL|SLING TV|FUBO/, category: 'subscriptions' },
  { id: 'kw:subscriptions-2', re: /SIRIUS ?XM|PANDORA|TIDAL/, category: 'subscriptions' },
  { id: 'brand:the-new-york-times', re: /NYTIMES|NY TIMES|NEW YORK TIMES/, category: 'subscriptions', merchant: 'The New York Times' },
  { id: 'brand:the-wall-street-journal', re: /\bWSJ\b|WALL STREET JOURNAL/, category: 'subscriptions', merchant: 'The Wall Street Journal' },
  { id: 'kw:subscriptions-3', re: /WASHINGTON POST|WASHPOST|THE ATLANTIC|ECONOMIST|NEW YORKER|SUBSTACK|PATREON|MEDIUM\.COM/, category: 'subscriptions' },
  { id: 'brand:classpass', re: /CLASSPASS/, category: 'subscriptions', merchant: 'ClassPass' },
  { id: 'kw:subscriptions-4', re: /PELOTON|STRAVA|HEADSPACE|CALM\.COM|CALM APP|DUOLINGO|NOOM|WHOOP/, category: 'subscriptions' },
  { id: 'kw:subscriptions-5', re: /ADOBE|DROPBOX|GOOGLE (ONE|STORAGE|WORKSPACE)|GSUITE|MICROSOFT|MSFT|OPENAI|CHATGPT|ANTHROPIC|CLAUDE\.AI|NOTION|1PASSWORD|LASTPASS|NORDVPN|EXPRESSVPN|GITHUB|FIGMA|CANVA|ZOOM\.US|SLACK/, category: 'subscriptions' },
  { id: 'kw:subscriptions-6', re: /LINKEDIN|TINDER|HINGE|BUMBLE/, category: 'subscriptions' },

  // --- Housing -------------------------------------------------------------
  // Dry cleaning / laundry first, so the "CLEANING" alternative in the home
  // services rule below cannot swallow a personal service. See the personal
  // services note further down for why these land in 'other'.
  { id: 'kw:dry-cleaning', re: /DRY ?CLEAN(ER|ERS|ING)?\b|LAUNDROMAT|LAUNDRY SERVICE|WASH ?& ?FOLD/, category: 'other' },
  // Home services: work done on the home, so 'housing' alongside rent/mortgage.
  {
    id: 'kw:home-services',
    re: /PLUMB(ER|ING)|ELECTRICIAN|\bHVAC\b|HEATING (& |AND )?(AIR|COOLING)|AIR CONDITION|\bFURNACE\b|LANDSCAP(E|ING|ER)|LAWN (CARE|SERVICE|MOWING)|TRUGREEN|PEST CONTROL|EXTERMINAT|TERMINIX|\bORKIN\b|ROTO[- ]?ROOTER|HANDYMAN|ROOFING|\bROOFER\b|HOUSE ?CLEANING|HOME CLEANING|CLEANING SERVICE|MAID SERVICE|MERRY MAIDS|MOLLY MAID|CHIMNEY|GUTTER|SEPTIC|JUNK REMOVAL|GOT[- ]?JUNK|HOME WARRANTY|\bANGI\b|ANGIE'?S LIST|THUMBTACK|PAINTING SERVICE|PEST\b.*\bSERVICE/,
    category: 'housing',
  },
  // Storage units are shelter you rent by the square foot. Placed after the
  // subscriptions block so "GOOGLE ONE/STORAGE" and iCloud stay subscriptions.
  {
    id: 'kw:storage-unit',
    re: /PUBLIC STORAGE|EXTRA SPACE|CUBESMART|LIFE STORAGE|STORAGE UNIT|SELF[- ]?STORAGE|U-?HAUL STORAGE|\bSTORAGE (CENTER|FACILITY|RENTAL)/,
    category: 'housing',
  },
  { id: 'kw:housing-1', re: /\bRENT\b(?![ -]?A[ -]?CAR)|RENT PAYMENT|APARTMENT|\bAPTS?\b|MORTGAGE|\bHOA\b|PROPERTY M(GM|ANAGE)|LEASING|REALTY|LANDLORD|HOMEOWNERS/, category: 'housing' },

  // --- Health (brands) -----------------------------------------------------
  { id: 'brand:cvs-pharmacy', re: /\bCVS\b/, category: 'health', merchant: 'CVS Pharmacy' },
  { id: 'brand:walgreens', re: /WALGREENS/, category: 'health', merchant: 'Walgreens' },
  { id: 'kw:health-1', re: /RITE AID|DUANE READE/, category: 'health' },
  { id: 'brand:one-medical', re: /ONE MEDICAL/, category: 'health', merchant: 'One Medical' },
  { id: 'kw:health-2', re: /KAISER|SUTTER|QUEST DIAG|LABCORP|UCSF|MAYO CLINIC|CEDARS|MOUNT SINAI|NYU LANGONE|MASS GENERAL/, category: 'health' },
  // Labs & telehealth — the bill is medical care even though no clinic was visited.
  {
    id: 'kw:labs-telehealth',
    re: /BIOREFERENCE|SONORA QUEST|CLINICAL LAB|PATHOLOGY|\bTELADOC\b|MDLIVE|\bAMWELL\b|DOXY\.ME|PLUSHCARE|SESAME CARE|LEMONAID|\bZOCDOC\b|CARBON HEALTH|\bCITYMD\b|MINUTECLINIC|GOODRX|CAPSULE PHARM|ALTO PHARM|\bHIMS\b|\bHERS\b|\bRO\.CO\b|TELEHEALTH|TELEMEDICINE|\bLIFELABS\b|BLOODWORK/,
    category: 'health',
  },
  // Pets: vets are medical care, and pet food/supplies come from the same
  // budget line for most households, so both file under 'health'. This sits
  // above the shopping brand list on purpose — Chewy/Petco/PetSmart would
  // otherwise be caught there as general retail.
  {
    id: 'kw:pets-vet',
    re: /\bCHEWY\b|PETSMART|\bPETCO\b|PET ?SUPPLIES PLUS|\bPETLAND\b|\bVCA\b|BANFIELD|VETERINAR|\bVET (CLINIC|HOSPITAL|CARE)|ANIMAL (HOSPITAL|CLINIC|CARE)|PET (STORE|CLINIC|HOSPITAL|GROOM|BOARDING|SUPPLY|SUPPLIES)|DOG ?(GROOM|WALK|BOARDING)|ROVER\.COM|\bWAG!/,
    category: 'health',
  },
  { id: 'kw:health-3', re: /EQUINOX|24 HOUR FITNESS|PLANET FITNESS|LA FITNESS|ORANGETHEORY|CROSSFIT|BARRY'?S|SOULCYCLE|CORE ?POWER|\bYMCA\b|ANYTIME FITNESS|GOLD'?S GYM/, category: 'health' },
  { id: 'kw:health-4', re: /WARBY PARKER|LENSCRAFTERS|SPECSAVERS/, category: 'health' },

  // --- Travel (brands) -----------------------------------------------------
  { id: 'brand:united-airlines', re: /\bUNITED( AIR|\.CO|\s+\d)/, category: 'travel', merchant: 'United Airlines' },
  { id: 'brand:delta-air-lines', re: /DELTA AIR|\bDELTA\s+\d/, category: 'travel', merchant: 'Delta Air Lines' },
  { id: 'brand:american-airlines', re: /AMERICAN AIR|\bAA\.COM|AMERICAN\s+\d{8,}/, category: 'travel', merchant: 'American Airlines' },
  { id: 'brand:southwest-airlines', re: /SOUTHWEST|SOUTHWES\b/, category: 'travel', merchant: 'Southwest Airlines' },
  { id: 'brand:jetblue', re: /JETBLUE/, category: 'travel', merchant: 'JetBlue' },
  { id: 'brand:alaska-airlines', re: /ALASKA AIR/, category: 'travel', merchant: 'Alaska Airlines' },
  { id: 'kw:travel-1', re: /SPIRIT AIR|FRONTIER AIR|HAWAIIAN AIR|BRITISH AIR|LUFTHANSA|AIR CANADA|AIR FRANCE|\bKLM\b|EMIRATES|QATAR AIR|VIRGIN ATL|AER LINGUS|RYANAIR|EASYJET|\bANA\b|CATHAY|SINGAPORE AIR|ALLEGIANT|SUN COUNTRY|BREEZE AIR/, category: 'travel' },
  { id: 'kw:travel-2', re: /MARRIOTT|\bMOXY\b|WESTIN|SHERATON|COURTYARD|RESIDENCE INN|FAIRFIELD INN|W HOTEL|RITZ[- ]CARLTON|ST\.? REGIS/, category: 'travel' },
  { id: 'kw:travel-3', re: /HILTON|HAMPTON INN|DOUBLETREE|EMBASSY SUITES|WALDORF|CONRAD HOTEL/, category: 'travel' },
  { id: 'kw:travel-4', re: /HYATT|ANDAZ|THOMPSON HOTEL/, category: 'travel' },
  { id: 'kw:travel-5', re: /\bIHG\b|HOLIDAY INN|KIMPTON|INTERCONTINENTAL|CROWNE PLAZA|BEST WESTERN|HOXTON|ACE HOTEL|FOUR SEASONS|MOTEL 6|LA QUINTA|WYNDHAM|RADISSON|OMNI HOTEL|LOEWS/, category: 'travel' },
  { id: 'brand:airbnb', re: /AIRBNB/, category: 'travel', merchant: 'Airbnb' },
  { id: 'brand:vrbo', re: /\bVRBO\b/, category: 'travel', merchant: 'Vrbo' },
  { id: 'kw:travel-6', re: /EXPEDIA|BOOKING\.COM|HOTELS\.COM|KAYAK|PRICELINE|ORBITZ|TRAVELOCITY|TRIPADVISOR|HOPPER|AGODA/, category: 'travel' },
  { id: 'brand:amtrak', re: /AMTRAK/, category: 'travel', merchant: 'Amtrak' },
  { id: 'kw:travel-7', re: /HERTZ|\bAVIS\b|ENTERPRISE RENT|ENTERPRISE RAC|NATIONAL CAR|BUDGET (RENT|CAR|RAC)|\bALAMO\b|\bSIXT\b|\bTURO\b|ZIPCAR|U-HAUL|UHAUL/, category: 'travel' },
  { id: 'kw:travel-8', re: /\bTSA\b|GLOBAL ENTRY|CLEAR PLUS|CLEARME/, category: 'travel' },

  // --- Transport (brands) --------------------------------------------------
  { id: 'brand:uber', re: /\bUBER\b/, category: 'transport', merchant: 'Uber' },
  { id: 'brand:lyft', re: /\bLYFT\b/, category: 'transport', merchant: 'Lyft' },
  { id: 'brand:waymo', re: /WAYMO/, category: 'transport', merchant: 'Waymo' },
  { id: 'brand:chevron', re: /CHEVRON/, category: 'transport', merchant: 'Chevron' },
  { id: 'brand:shell', re: /\bSHELL\b/, category: 'transport', merchant: 'Shell' },
  { id: 'brand:exxon', re: /EXXON|\bESSO\b/, category: 'transport', merchant: 'Exxon' },
  { id: 'brand:mobil', re: /\bMOBIL\b/, category: 'transport', merchant: 'Mobil' },
  { id: 'brand:arco', re: /\bARCO\b|AMPM/, category: 'transport', merchant: 'ARCO' },
  { id: 'kw:transport-1', re: /VALERO|SUNOCO|CITGO|MARATHON (PETRO|OIL|#)|SPEEDWAY|\bWAWA\b|SHEETZ|CIRCLE K|QUIKTRIP|RACETRAC|CASEY'?S|\bBP\b|\bBP#|CONOCO|PHILLIPS 66|TEXACO|GULF OIL|KWIK TRIP|LOVE'?S TRAVEL|PILOT (TRAVEL|FLYING)|FLYING J/, category: 'transport' },
  { id: 'brand:clipper', re: /CLIPPER/, category: 'transport', merchant: 'Clipper' },
  { id: 'brand:sfmta', re: /SFMTA|\bMUNI\b/, category: 'transport', merchant: 'SFMTA' },
  { id: 'brand:bart', re: /\bBART\b/, category: 'transport', merchant: 'BART' },
  { id: 'brand:caltrain', re: /CALTRAIN/, category: 'transport', merchant: 'Caltrain' },
  { id: 'brand:mta', re: /\bMTA\b|METROCARD|\bOMNY\b|\bLIRR\b|METRO-NORTH/, category: 'transport', merchant: 'MTA' },
  { id: 'kw:transport-2', re: /\bMBTA\b|\bWMATA\b|SMARTRIP|\bCTA\b|VENTRA|NJ TRANSIT|\bNJT\b|SEPTA|TRIMET|SOUND TRANSIT|\bORCA\b|\bPATH\b|\bDART\b|\bMARTA\b|\bRTD\b|\bVTA\b|\bAC TRANSIT/, category: 'transport' },
  { id: 'kw:transport-3', re: /PARKING|PARKMOBILE|SPOTHERO|LAZ PARK|IMPARK|\bGARAGE\b|PAYBYPHONE|PARKWHIZ|METER\b/, category: 'transport' },
  { id: 'kw:parking-apps', re: /PREMIER PARKING|ABM PARKING|SP\+? PARKING|PASSPORT PARKING|\bPARKO?PEDIA\b|METROPOLIS/, category: 'transport' },
  { id: 'kw:transport-4', re: /FASTRAK|E-?Z ?PASS|\bTOLLS?\b|SUNPASS|TXTAG|GOOD TO GO/, category: 'transport' },
  { id: 'kw:tolls-extra', re: /PLATEPASS|PEACH PASS|\bI-?PASS\b|PIKEPASS|QUICK ?PASS|TOLL ?TAG|RIVERLINK|EXPRESS ?LANES|TURNPIKE|TOLL ROADS?|\bNEXUS PASS\b|K-?TAG/, category: 'transport' },
  { id: 'kw:transport-5', re: /CAR WASH|CARWASH|JIFFY LUBE|VALVOLINE|AUTOZONE|O'?REILLY AUTO|PEP BOYS|FIRESTONE|DISCOUNT TIRE|\bMIDAS\b|AUTO REPAIR|AUTOMOTIVE|\bDMV\b|SMOG|TIRE\b/, category: 'transport' },
  // Cost of keeping a car on the road: auto insurance, registration, roadside.
  // GEICO is ~all personal auto, so it moves here; multi-line carriers
  // (Progressive, Allstate, State Farm, Lemonade) stay in the generic
  // 'other' insurance rule below because the policy could be home or renters.
  {
    id: 'kw:auto-insurance-registration',
    re: /\bGEICO\b|(AUTO|CAR|VEHICLE|MOTORCYCLE) INSURANCE|AUTO POLICY|VEH(ICLE)? REG(ISTRATION)?\b|MOTOR VEHICLE|TAG (& |AND )?TITLE|TITLE (& |AND )?REG|DRIVER'?S? LICENSE|EMISSIONS TEST|ROADSIDE ASSIST|\bAAA\b|AUTO CLUB/,
    category: 'transport',
  },
  { id: 'kw:transport-6', re: /CHARGEPOINT|ELECTRIFY AMERICA|\bEVGO\b|SUPERCHARGER|BLINK CHARGING/, category: 'transport' },
  { id: 'kw:transport-7', re: /\bLIME\b|BIRD RIDES|CITI ?BIKE|BAY WHEELS|LIME\*RIDE|\bSCOOT\b|DIVVY|REVEL/, category: 'transport' },

  // --- Groceries (brands) --------------------------------------------------
  { id: 'brand:trader-joe-s', re: /TRADER JOE/, category: 'groceries', merchant: "Trader Joe's" },
  { id: 'brand:whole-foods-market', re: /WHOLE ?F(OO)?DS|WHOLEFDS|\bWFM\b/, category: 'groceries', merchant: 'Whole Foods Market' },
  { id: 'brand:safeway', re: /SAFEWAY/, category: 'groceries', merchant: 'Safeway' },
  { id: 'brand:kroger', re: /KROGER/, category: 'groceries', merchant: 'Kroger' },
  { id: 'brand:costco', re: /COSTCO/, category: 'groceries', merchant: 'Costco' },
  { id: 'brand:aldi', re: /\bALDI\b/, category: 'groceries', merchant: 'Aldi' },
  { id: 'brand:publix', re: /PUBLIX/, category: 'groceries', merchant: 'Publix' },
  { id: 'brand:wegmans', re: /WEGMANS/, category: 'groceries', merchant: 'Wegmans' },
  { id: 'brand:h-e-b', re: /H-E-B|\bHEB\b/, category: 'groceries', merchant: 'H-E-B' },
  { id: 'kw:groceries-1', re: /ALBERTSONS|RALPHS|\bVONS\b|FOOD LION|GIANT (FOOD|EAGLE)|STOP ?& ?SHOP|SPROUTS|FRED MEYER|WINCO|MEIJER|HARRIS TEETER|SHOPRITE|HANNAFORD|PIGGLY|SMART ?& ?FINAL|99 RANCH|H ?MART|MOLLIE STONE|BI-RITE|GROCERY OUTLET|LUCKY (SUPERMARKET|#)|PAVILIONS|JEWEL[- ]OSCO|KING SOOPERS|FRY'?S FOOD|QFC\b|ACME MARKETS|PIGGLY|FOOD 4 LESS|FOODMAXX|WINN[- ]DIXIE|FRESH MARKET|GELSON|ERE?WHON|ZABAR|FAIRWAY|KEY FOOD|7-ELEVEN|7 ELEVEN/, category: 'groceries' },
  { id: 'brand:instacart', re: /INSTACART/, category: 'groceries', merchant: 'Instacart' },
  { id: 'kw:groceries-2', re: /FARMERS'? ?M(AR)?KE?T/, category: 'groceries' },

  // --- Dining (brands) -----------------------------------------------------
  { id: 'brand:doordash', re: /DOORDASH|DD \*DOORDASH/, category: 'dining', merchant: 'DoorDash' },
  { id: 'brand:grubhub', re: /GRUBHUB|SEAMLESS/, category: 'dining', merchant: 'Grubhub' },
  { id: 'brand:postmates', re: /POSTMATES/, category: 'dining', merchant: 'Postmates' },
  { id: 'brand:caviar', re: /CAVIAR/, category: 'dining', merchant: 'Caviar' },
  { id: 'brand:starbucks', re: /STARBUCKS/, category: 'dining', merchant: 'Starbucks' },
  { id: 'brand:chipotle', re: /CHIPOTLE/, category: 'dining', merchant: 'Chipotle' },
  { id: 'brand:mcdonald-s', re: /MCDONALD/, category: 'dining', merchant: "McDonald's" },
  { id: 'brand:burger-king', re: /BURGER KING/, category: 'dining', merchant: 'Burger King' },
  { id: 'brand:wendy-s', re: /WENDY'?S/, category: 'dining', merchant: "Wendy's" },
  { id: 'brand:taco-bell', re: /TACO BELL/, category: 'dining', merchant: 'Taco Bell' },
  { id: 'brand:chick-fil-a', re: /CHICK-?FIL-?A/, category: 'dining', merchant: 'Chick-fil-A' },
  { id: 'kw:dining-1', re: /POPEYES|\bKFC\b|SUBWAY|PANERA|SHAKE SHACK|IN-?N-?OUT|FIVE GUYS|DOMINO|PAPA JOHN|PIZZA HUT|LITTLE CAESARS|PANDA EXPRESS|\bCAVA\b|DUNKIN|PEET'?S|PHILZ|BLUE BOTTLE|DUTCH BROS|TIM HORTONS|JAMBA|WINGSTOP|RAISING CANE|SONIC DRIVE|DAIRY QUEEN|ARBY'?S|JACK IN THE BOX|CARL'?S JR|WHATABURGER|NOODLES & CO|QDOBA|EL POLLO LOCO|OLIVE GARDEN|CHEESECAKE FACTORY|APPLEBEE|CHILI'?S|OUTBACK|RED LOBSTER|IHOP|DENNY'?S|WAFFLE HOUSE|CRACKER BARREL|BUFFALO WILD|PF CHANG|SWEETGREEN|DIG INN|JUST SALAD|PRET A MANGER|BLUESTONE LANE|JOE & THE JUICE|TARTINE|LA COLOMBE|INTELLIGENTSIA|STUMPTOWN|SIGHTGLASS|RITUAL COFFEE|VERVE COFFEE/, category: 'dining' },

  // --- Entertainment (brands) ---------------------------------------------
  { id: 'brand:amc-theatres', re: /\bAMC\b/, category: 'entertainment', merchant: 'AMC Theatres' },
  { id: 'kw:entertainment-1', re: /CINEMARK|REGAL CINEMA|\bREGAL\b|ALAMO DRAFTHOUSE|FANDANGO|LANDMARK THEAT/, category: 'entertainment' },
  { id: 'brand:ticketmaster', re: /TICKETMASTER/, category: 'entertainment', merchant: 'Ticketmaster' },
  { id: 'brand:axs-tickets', re: /\bAXS\b|AXS\.COM/, category: 'entertainment', merchant: 'AXS Tickets' },
  { id: 'kw:entertainment-2', re: /STUBHUB|EVENTBRITE|LIVE ?NATION|SEATGEEK|VIVID SEATS|DICE\.FM|RESIDENT ADVISOR/, category: 'entertainment' },
  { id: 'brand:steam', re: /STEAM ?(GAMES|POWERED)|STEAMGAMES/, category: 'entertainment', merchant: 'Steam' },
  { id: 'brand:playstation', re: /PLAYSTATION|SONY INTERACTIVE/, category: 'entertainment', merchant: 'PlayStation' },
  { id: 'brand:xbox', re: /\bXBOX\b/, category: 'entertainment', merchant: 'Xbox' },
  { id: 'brand:nintendo', re: /NINTENDO/, category: 'entertainment', merchant: 'Nintendo' },
  { id: 'kw:entertainment-3', re: /EPIC GAMES|BLIZZARD|RIOT GAMES|\bTWITCH\b|ROBLOX|GAMESTOP/, category: 'entertainment' },
  { id: 'brand:sfmoma', re: /SFMOMA/, category: 'entertainment', merchant: 'SFMOMA' },
  { id: 'kw:entertainment-4', re: /ACADEMY OF SCIENCES|DE YOUNG|EXPLORATORIUM|\bMOMA\b|GUGGENHEIM|SMITHSONIAN|GETTY CENTER|MUSEUM/, category: 'entertainment' },
  { id: 'kw:entertainment-5', re: /\bZOO\b|AQUARIUM|TOPGOLF|DAVE & BUSTER|BOWL(ING|ERO)|BOWLMOR|ARCADE|SIX FLAGS|DISNEYLAND|DISNEY WORLD|UNIVERSAL STUDIOS|CEDAR POINT/, category: 'entertainment' },

  // --- Shopping (brands) ---------------------------------------------------
  { id: 'brand:amazon', re: /AMAZON|AMZN/, category: 'shopping', merchant: 'Amazon' },
  { id: 'brand:target', re: /\bTARGET\b/, category: 'shopping', merchant: 'Target' },
  { id: 'brand:walmart', re: /WAL-?MART|WM SUPERCENTER/, category: 'shopping', merchant: 'Walmart' },
  { id: 'brand:best-buy', re: /BEST ?BUY/, category: 'shopping', merchant: 'Best Buy' },
  { id: 'brand:apple', re: /APPLE STORE|APPLE\.COM|APPLE ONLINE/, category: 'shopping', merchant: 'Apple' },
  { id: 'brand:ebay', re: /\bEBAY\b/, category: 'shopping', merchant: 'eBay' },
  { id: 'brand:etsy', re: /\bETSY\b/, category: 'shopping', merchant: 'Etsy' },
  { id: 'brand:ikea', re: /\bIKEA\b/, category: 'shopping', merchant: 'IKEA' },
  { id: 'brand:the-home-depot', re: /HOME ?DEPOT/, category: 'shopping', merchant: 'The Home Depot' },
  { id: 'brand:lowe-s', re: /LOWE'?S\b/, category: 'shopping', merchant: "Lowe's" },
  { id: 'brand:nordstrom', re: /NORDSTROM/, category: 'shopping', merchant: 'Nordstrom' },
  { id: 'brand:macy-s', re: /MACY'?S/, category: 'shopping', merchant: "Macy's" },
  { id: 'brand:uniqlo', re: /UNIQLO/, category: 'shopping', merchant: 'Uniqlo' },
  { id: 'brand:rei', re: /\bREI\b/, category: 'shopping', merchant: 'REI' },
  // Sporting goods & outdoor retailers — retail, not the activity itself, so
  // 'shopping'. Above the generic entertainment rule, which would otherwise
  // claim anything containing GOLF or SKI.
  {
    id: 'kw:sporting-outdoor',
    re: /BASS PRO|CABELA|ACADEMY SPORTS|BIG 5 SPORT|\bSCHEELS\b|SPORTSMAN'?S WAREHOUSE|HIBBETT|MODELL'?S|DUNHAM'?S SPORT|PLAY IT AGAIN SPORTS|MOOSEJAW|BACKCOUNTRY\.COM|EASTERN MOUNTAIN|L\.?L\.? ?BEAN|ARC'?TERYX|\bMARMOT\b|DECATHLON|FLEET FEET|ROAD RUNNER SPORTS|\bGARMIN\b|\bHOKA\b|BROOKS RUNNING|ON RUNNING|SALOMON|\bYETI\b|GOLF GALAXY|PGA TOUR SUPERSTORE|SKI SHOP|GOLF SHOP/,
    category: 'shopping',
  },
  { id: 'brand:sephora', re: /SEPHORA/, category: 'shopping', merchant: 'Sephora' },
  { id: 'kw:shopping-1', re: /ACE HARDWARE|BLOOMINGDALE|\bZARA\b|\bH&M\b|\bGAP\b|OLD NAVY|BANANA REPUBLIC|J\.? ?CREW|\bNIKE\b|ADIDAS|LULULEMON|PATAGONIA|NORTH FACE|\bULTA\b|WAYFAIR|WEST ELM|CRATE ?& ?BARREL|\bCB2\b|POTTERY BARN|WILLIAMS[- ]SONOMA|RESTORATION HARDWARE|T\.? ?J\.? ?MAXX|MARSHALLS|ROSS (DRESS|STORES)|KOHL'?S|JC ?PENNEY|DICK'?S SPORTING|BARNES ?& ?NOBLE|STAPLES|OFFICE ?DEPOT|OFFICEMAX|MICHAELS|HOBBY LOBBY|JO-?ANN|DOLLAR TREE|DOLLAR GENERAL|FAMILY DOLLAR|FIVE BELOW|\bSHEIN\b|\bTEMU\b|ALIEXPRESS|WISH\.COM|CONTAINER STORE|BED BATH|COSTCO\.COM|SAMS CLUB|SAM'S CLUB|BJ'?S WHOLESALE|EVERLANE|MADEWELL|ANTHROPOLOGIE|URBAN OUTFITTERS|FREE PEOPLE|ABERCROMBIE|HOLLISTER|AMERICAN EAGLE|FOOT LOCKER|ALLBIRDS|WARBY|GLOSSIER|NEWEGG|B&H PHOTO|MICRO CENTER|SHOPIFY|SQUARESPACE/, category: 'shopping' },

  // --- Other (named brands that still shouldn't count as a spend category) -
  { id: 'brand:usps', re: /\bUSPS\b|POSTAL SERVICE|POST OFFICE/, category: 'other', merchant: 'USPS' },
  { id: 'brand:ups', re: /\bUPS\b|UPS STORE/, category: 'other', merchant: 'UPS' },
  { id: 'brand:fedex', re: /FEDEX/, category: 'other', merchant: 'FedEx' },
  // Personal grooming: not medical, not retail, so 'other'. This sits below the
  // hotel and shopping brands (so "MARRIOTT SPA" stays travel and Ulta/Sephora
  // stay shopping) but above the generic health rule, which claims \bSPA\b and
  // MASSAGE. Net effect: a day spa or Massage Envy now reads 'other', not 'health'.
  {
    id: 'kw:personal-care',
    re: /\bBARBER|BARBERSHOP|HAIR ?(CUT|SALON|STUDIO|CO\b)|\bSALON\b|SUPERCUTS|GREAT CLIPS|SPORT ?CLIPS|\bDRYBAR\b|BLOW ?DRY BAR|NAIL ?(SALON|BAR|SPA)|\bNAILS\b|MANICURE|PEDICURE|EUROPEAN WAX|WAXING|\bTHREADING\b|LASH (BAR|STUDIO|EXTENSION)|MASSAGE ENVY|DAY SPA|\bSPA\b|TANNING|MED ?SPA/,
    category: 'other',
  },
  // Charitable giving and religious contributions — no 'giving' category
  // exists, and none of the spend categories fit, so 'other'. Above the generic
  // health rule so "ST JUDE CHILDREN'S RESEARCH HOSPITAL" is not read as a
  // hospital bill.
  {
    id: 'kw:charity',
    re: /DONATION|\bDONATE\b|\bCHARITY\b|CHARITABLE|\bTITHE\b|RED CROSS|UNITED WAY|GOFUNDME|\bST\.? JUDE\b|SALVATION ARMY|HABITAT FOR HUMANITY|DOCTORS WITHOUT BORDERS|WORLD WILDLIFE|\bWWF\b|WIKIMEDIA|\bNPR\b|PUBLIC RADIO|\bCHURCH\b|SYNAGOGUE|\bMOSQUE\b|\bPARISH\b|MISSION FUND|FOUNDATION (GIFT|DONAT)/,
    category: 'other',
  },

  // --- Generic keyword rules (less reliable, so they come after brands) ----
  // Reservation/ordering platforms bill as "RESY*STATE BIRD", "TOAST*JOE'S".
  // The '*' is required: these are ordinary words, and a bakery named Toast is
  // not a Toast POS charge. Brand rules above still win, so TOAST*STARBUCKS
  // stays Starbucks.
  { id: 'kw:restaurant-platform', re: /^(?:RESY|TOAST|OPENTABLE|EZCATER|EZC|SEATED)\s*\*/, category: 'dining' },
  { id: 'kw:dining-2', re: /^TST\s?\*/, category: 'dining' }, // Toast POS prefix = restaurant
  { id: 'kw:dining-3', re: /RESTAURANT|RESTAURANTE|CAF[EÉ]\b|COFFEE|ESPRESSO|PIZZ(A|ERIA)|BURGER|TACO|TAQUERIA|SUSHI|RAMEN|NOODLE|\bPHO\b|BOBA|BAKERY|BAGEL|DONUT|DOUGHNUT|\bDELI\b|DINER|BISTRO|GRILL|KITCHEN|EATERY|\bEATS\b|\bBBQ\b|BARBECUE|\bBAR\b|\bPUB\b|TAVERN|TAPROOM|BREW(ING|ERY)|\bBREW\b|CANTINA|STEAKHOUSE|CHOPHOUSE|TRATTORIA|OSTERIA|RISTORANTE|BRASSERIE|CREAMERY|ICE CREAM|GELATO|JUICE|SMOOTHIE|WINE BAR|SALOON|LOUNGE|CHINESE|\bTHAI\b|MEXICAN|ITALIAN|INDIAN|JAPANESE|KOREAN|VIETNAMESE|MEDITERRANEAN|SEAFOOD|OYSTER|CHICKEN|\bWINGS\b|CATERING|FOOD TRUCK|\bTEA\b|BOULANGERIE|PATISSERIE|CREPE|DUMPLING|CURRY|KEBAB|FALAFEL|SHAWARMA|POKE\b|TAPAS|BISTRO|\bCAFE\b/, category: 'dining' },
  { id: 'kw:groceries-3', re: /GROCER|SUPERMARKET|\bFOODS\b|FOOD MART|FOOD MARKET|\bMARKET\b|\bMKT\b|PRODUCE|BUTCHER|FISH MARKET|CO-?OP\b/, category: 'groceries' },
  { id: 'kw:health-5', re: /PHARMACY|DRUG ?STORE|DENTAL|DENTIST|ORTHODON|MEDICAL|DOCTOR|CLINIC|HOSPITAL|URGENT CARE|OPTOMETR|VISION\b|\bGYM\b|FITNESS|\bYOGA\b|PILATES|THERAP|CHIROPRAC|DERMATOL|PEDIATR|HEALTH|WELLNESS|VETERINAR|ANIMAL HOSPITAL|PHYSICIAN|RADIOLOGY|LAB(ORATOR)?Y\b|OPTICAL|ACUPUNCTURE|MASSAGE|\bSPA\b/, category: 'health' },
  { id: 'kw:travel-9', re: /AIRLINE|AIRWAYS|AIR LINES|\bHOTEL|MOTEL|RESORT|\bINN\b|\bLODGE\b|HOSTEL|CRUISE|RENT-?A-?CAR|CAR RENTAL|AIRPORT|TRAVEL\b/, category: 'travel' },
  { id: 'kw:entertainment-6', re: /CINEMA|THEAT(RE|ER)|CONCERT|TICKETS?\b|\bGAMES?\b|ESCAPE ROOM|COMEDY|KARAOKE|MINI GOLF|\bGOLF\b|\bSKI\b|FESTIVAL|STADIUM|\bARENA\b|AMUSEMENT|CLIMBING|TRAMPOLINE|RECREATION/, category: 'entertainment' },
  { id: 'kw:transport-8', re: /\bGAS\b|\bFUEL\b|PETROL|\bOIL\b|\bTAXI\b|\bCAB\b|RIDESHARE|SHUTTLE|\bMETRO\b|\bTRANSIT\b|\bBUS\b|\bRAIL\b|\bTRAIN\b|BIKE SHARE|SCOOTER|\bAUTO\b|\bMOTORS?\b|\bTIRES\b|CHARGING/, category: 'transport' },
  { id: 'kw:utilities-6', re: /\bWATER\b|\bELECTRIC|UTILIT|\bENERGY\b|\bPOWER (CO|COMPANY|& LIGHT)|WIRELESS|INTERNET|TELECOM|BROADBAND|\bSEWER\b|SANITATION|\bCABLE\b|\bMOBILE\b|\bCELLULAR\b|TRASH|WASTE\b/, category: 'utilities' },
  { id: 'kw:shopping-2', re: /\bSTORE\b|\bSHOP\b|BOUTIQUE|OUTLET|\bMALL\b|APPAREL|CLOTHING|HARDWARE|FURNITURE|ELECTRONICS|BOOKS?\b|BOOKSTORE|FLORIST|FLOWERS|JEWEL|COSMETIC|BEAUTY|MERCH|\bGIFTS?\b|SUPPLY|SUPPLIES|WHOLESALE|RETAIL|DEPARTMENT|OUTFITTERS|SPORTING GOODS/, category: 'shopping' },
  { id: 'kw:subscriptions-7', re: /SUBSCRIPTION|MEMBERSHIP|RENEWAL|\bMONTHLY\b|\bANNUAL\b|\bPLAN\b|STREAMING|\bAPP\b/, category: 'subscriptions' },
  // GEICO moved to the auto-insurance rule above; the carriers left here write
  // home/renters/life too, so 'other' is the honest bucket for them.
  { id: 'kw:other-1', re: /\bINSURANCE\b|\bINS PREM|PROGRESSIVE|ALLSTATE|STATE FARM|LEMONADE/, category: 'other' },
];

// ---------------------------------------------------------------------------
// Description cleanup

// The delimiter is REQUIRED — an asterisk or whitespace. Making it optional
// meant short tokens matched inside real names: "SPOTHERO" lost its "SP" and
// became "Othero", and any merchant starting PP/DD/PY/IC was at the same risk.
const POS_PREFIX_RE = /^(?:TST|SQ|SQU|PAYPAL|PP|DD|PY|SP|IC|CKE|WL|EB|ZSK|LEVELUP|PTI|CLV|SNAP|APL|WWW|GOOGLE|CHECKCARD|DEBIT CARD PURCHASE|POS PURCHASE|PURCHASE AUTHORIZED ON \d{2}\/\d{2})(?:\s*\*+\s*|\s+)/i;
// Same idea for reservation/ordering platforms, except these are ordinary
// words, so only the '*' form counts as a prefix.
const PLATFORM_PREFIX_RE = /^(?:RESY|TOAST|OPENTABLE|EZCATER|EZC|SEATED)\s*\*+\s*/i;
const URL_RE = /\b(?:[A-Z0-9-]+\.)+(?:COM|NET|ORG|CO|IO|US|APP|TV|ME|AI)\b(?:\/[A-Z0-9/_.-]*)?/gi;
const PHONE_RES = [
  /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{3,4}\b/g,
  /\b8\d{2}-[A-Z0-9]{3,}(?:-[A-Z0-9]+)?\b/gi, // 800-COMCAST
];
const MASKED_RE = /\b[X*]{2,}\d+\b/gi;
const NOISE_RE = /\b(?:WEB PMTS?|WEB PAYMENTS?|ONLINE PMTS?|ACH|PPD|CCD|DES:|INDN:|CO ID:|POS PURCHASE|PURCHASE AUTHORIZED|CHECKCARD)\b/gi;
const STORE_NUM_RE = /#\s*[A-Z0-9-]+/gi;
const LONG_DIGITS_RE = /\b\d{4,}\b/g;
const ALNUM_CODE_RE = /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,}\b/g;

const STATE_RE =
  /(?:^|\s+)(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/;

const CITIES = [
  'SAN FRANCISCO', 'SAN JOSE', 'SAN DIEGO', 'SAN MATEO', 'SANTA CLARA', 'SANTA MONICA', 'SACRAMENTO',
  'LOS ANGELES', 'NEW YORK', 'BROOKLYN', 'MANHATTAN', 'QUEENS', 'JERSEY CITY', 'HOBOKEN',
  'SEATTLE', 'PORTLAND', 'AUSTIN', 'CHICAGO', 'ATLANTA', 'BOSTON', 'CAMBRIDGE', 'DENVER', 'DALLAS',
  'HOUSTON', 'PHOENIX', 'MIAMI', 'OAKLAND', 'BERKELEY', 'WASHINGTON', 'PHILADELPHIA', 'MINNEAPOLIS',
  'NASHVILLE', 'LAS VEGAS', 'PALO ALTO', 'MOUNTAIN VIEW', 'MENLO PARK', 'REDWOOD CITY', 'SUNNYVALE',
  'EMERYVILLE', 'DALY CITY', 'SAUSALITO', 'PASADENA', 'LONG BEACH', 'IRVINE', 'SAN ANTONIO',
  'CHARLOTTE', 'RALEIGH', 'DETROIT', 'COLUMBUS', 'INDIANAPOLIS', 'PITTSBURGH', 'BALTIMORE',
  'SALT LAKE CITY', 'KANSAS CITY', 'ST LOUIS', 'NEW ORLEANS', 'ORLANDO', 'TAMPA', 'HONOLULU',
];
// Statements truncate city names ("SAN FRANCISC", "ATLANT"), so accept any
// prefix of at least 5 characters, plus the common short forms.
const CITY_ALTS = new Set<string>(['SF', 'NYC', 'LA', 'DC']);
for (const c of CITIES) {
  for (let n = 5; n <= c.length; n++) CITY_ALTS.add(c.slice(0, n).trimEnd());
}
const CITY_RE = new RegExp(
  `(?:^|\\s+)(?:${[...CITY_ALTS]
    .sort((a, b) => b.length - a.length)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})$`,
);

const ACRONYMS = new Set([
  'REI', 'CVS', 'AMC', 'USPS', 'UPS', 'DMV', 'BART', 'MTA', 'SFMTA', 'ATM', 'HOA', 'IKEA', 'H&M',
  'NYT', 'KFC', 'BBQ', 'DC', 'NYC', 'SF', 'LA', 'TSA', 'IHOP', 'AXS', 'SFMOMA', 'MOMA', 'PG&E',
  'AT&T', 'ARCO', 'BP', 'CB2', 'LLC', 'INC', 'NYU', 'UCSF', 'YMCA', 'DD', 'ACE', 'WFM', 'HEB',
  'BJ', 'QFC', 'IRS', 'ADP', 'NJ', 'PGE', 'EV', 'HBO', 'WSJ', 'NBA', 'NFL', 'MLB', 'NHL', 'UFC',
  'VCA', 'HVAC', 'AAA', 'SFO', 'LAX', 'JFK', 'ORD', 'SEA', 'EWR', 'BOS', 'DFW', 'ATL', 'DEN', 'OAK', 'SJC', 'PDX',
]);
const LOWER_WORDS = new Set(['and', 'of', 'the', 'at', 'to', 'for', 'on', 'in', 'by', 'a', 'an', 'from', 'de', 'del', 'da']);

function titleCase(s: string): string {
  const words = s.toLowerCase().split(' ');
  return words
    .map((w, i) => {
      if (!w) return w;
      const upper = w.toUpperCase();
      if (ACRONYMS.has(upper)) return upper;
      if (i > 0 && LOWER_WORDS.has(w)) return w;
      // Capitalize after word start, hyphen, slash, ampersand, and "Mc"
      return w
        .replace(/(^|[-/&])([a-z])/g, (_m, p, ch: string) => p + ch.toUpperCase())
        .replace(/^Mc([a-z])/, (_m, ch: string) => 'Mc' + ch.toUpperCase());
    })
    .join(' ');
}

/** Strip POS prefixes, store numbers, phone numbers, URLs and location suffixes; title-case the rest. */
export function cleanDescription(raw: string): string {
  const original = raw.trim();
  let s = original.toUpperCase();

  s = s.replace(PLATFORM_PREFIX_RE, '');
  s = s.replace(POS_PREFIX_RE, '');

  // Remember the domain label ("NETFLIX" from "NETFLIX.COM") as a fallback.
  let domainLabel = '';
  s = s.replace(URL_RE, (m) => {
    const host = m.split('/')[0];
    const parts = host.split('.');
    if (parts.length >= 2 && !domainLabel) domainLabel = parts[parts.length - 2];
    return ' ';
  });

  for (const re of PHONE_RES) s = s.replace(re, ' ');
  s = s.replace(MASKED_RE, ' ');
  s = s.replace(NOISE_RE, ' ');
  s = s.replace(STORE_NUM_RE, ' ');
  s = s.replace(LONG_DIGITS_RE, ' ');
  s = s.replace(ALNUM_CODE_RE, ' ');
  s = s.replace(/\*/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  // Peel trailing state / city tokens (statements often end "SAN FRANCISCO CA").
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(STATE_RE, '');
    s = s.replace(CITY_RE, '');
    s = s.replace(/[\s\-–—.,:;]+$/g, '');
    if (s === before) break;
  }

  s = s.replace(/^[\s\-–—.,:;]+/, '').replace(/\s+/g, ' ').trim();

  // Collapse repeated adjacent words ("NYTIMES NYTIMES" → "NYTIMES").
  s = s
    .split(' ')
    .filter((w, i, arr) => i === 0 || w !== arr[i - 1])
    .join(' ');

  if (!s) s = domainLabel || original;
  return titleCase(s.trim());
}

// ---------------------------------------------------------------------------

export interface CategoryExplanation {
  merchant: string;
  category: CategoryId;
  /** Which step decided this: a rule id, 'ach-issuer-payment', 'ach-company', or 'default'. */
  matchedRule: string;
}

function classify(rawDescription: string): CategoryExplanation {
  const raw = rawDescription.trim();
  if (!raw) return { merchant: '', category: 'other', matchedRule: 'empty' };

  // Step 1 — ACH/bank descriptors: keep only the originating company, so the
  // keyword table sees "AMERICAN EXPRESS", not the SEC/IND/PPD trailer.
  let text = raw;
  let prefix = '';
  const ach = parseAchDescriptor(raw.toUpperCase());
  if (ach && ach.company) {
    const issuer = CARD_ISSUERS.find((i) => i.re.test(ach.company));
    if (issuer && ACH_PAYMENT_RE.test(ach.descr || raw.toUpperCase())) {
      // Money pulled by a card issuer to pay a card bill: movement, not spend.
      return { merchant: `${issuer.name} Payment`, category: 'transfer', matchedRule: 'ach-issuer-payment' };
    }
    text = ach.company;
    prefix = 'ach:'; // marks that the text below was ACH-normalised first
  }

  // Step 2 — ordered keyword table, first match wins.
  const upper = text.toUpperCase();
  for (const rule of RULES) {
    if (rule.re.test(upper)) {
      return {
        merchant: rule.merchant ?? cleanDescription(text),
        category: rule.category,
        matchedRule: prefix + rule.id,
      };
    }
  }
  return { merchant: cleanDescription(text), category: 'other', matchedRule: prefix ? 'ach-company' : 'default' };
}

export function categorize(rawDescription: string): { merchant: string; category: CategoryId } {
  const { merchant, category } = classify(rawDescription);
  return { merchant, category };
}

/**
 * Same result as categorize(), plus the id of the rule that fired — for a
 * "why was this categorised this way?" affordance in the UI. Ids are stable
 * short labels ('brand:fred-astaire', 'kw:pets-vet', 'ach-issuer-payment',
 * 'default'); an 'ach:' prefix means the ACH normaliser rewrote the text first.
 */
export function explainCategory(raw: string): { merchant: string; category: CategoryId; matchedRule: string } {
  return classify(raw);
}

/** Exposed for the CSV sign heuristic: does this description look like a purchase? */
export function looksLikeSpending(rawDescription: string): boolean {
  const { category } = categorize(rawDescription);
  return category !== 'income' && category !== 'transfer' && category !== 'other';
}
