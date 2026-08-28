import type { CategoryId } from '../types';

// A searchable directory of stores, services, websites, airlines and hotels so
// the advisor can answer "which card for Costco / united.com / Airbnb / Uber?".
//
// Every entry carries the category the purchase codes as for rewards purposes
// (which is what drives card choice — e.g. warehouse clubs and Walmart code as
// general retail, not supermarkets), the loyalty program for airlines/hotels,
// networks the merchant refuses, and the gotchas that actually change the
// card you should pull out.

export type MerchantKind =
  | 'store'
  | 'online'
  | 'restaurant'
  | 'airline'
  | 'hotel'
  | 'rideshare'
  | 'delivery'
  | 'travel-portal'
  | 'warehouse'
  | 'gas'
  | 'transit'
  | 'streaming'
  | 'other';

export interface MerchantEntry {
  id: string; // 'costco'
  name: string; // 'Costco'
  aliases: string[]; // ['costco.com', 'costco wholesale']
  category: CategoryId;
  kind: MerchantKind;
  /** Loyalty program this merchant belongs to (airlines/hotels), e.g. 'united', 'hyatt'. */
  programId?: string;
  /** Gotchas that change the card choice: "Warehouse club — Amex not accepted", "Books as travel on most cards". */
  notes?: string[];
  /** Networks this merchant does NOT accept. */
  rejectsNetworks?: Array<'visa' | 'mastercard' | 'amex' | 'discover'>;
}

type Extra = Pick<MerchantEntry, 'programId' | 'notes' | 'rejectsNetworks'>;

function m(
  id: string,
  name: string,
  aliases: string[],
  category: CategoryId,
  kind: MerchantKind,
  extra: Extra = {},
): MerchantEntry {
  return { id, name, aliases, category, kind, ...extra };
}

// Shared notes -------------------------------------------------------------

const NOT_SUPERMARKET = 'Not coded as a supermarket — Amex grocery bonuses (Gold 4x, Blue Cash 6%) do not apply here.';
const WAREHOUSE_CODE = 'Warehouse clubs code as wholesale, not supermarkets — grocery multipliers do not apply; a flat-rate card usually wins.';
const HOTEL_DIRECT = 'Book direct with the hotel to earn points and elite-night credit — OTA and bank-portal stays usually earn neither.';
const AIRLINE_DIRECT = 'Paid fares booked direct earn airline miles and elite credit, and count as "flights booked direct" for card multipliers.';
const OTA_NO_ELITE = 'Codes as travel, but hotel stays booked here usually forfeit elite perks, points and night credit.';
const DELIVERY_DINING = 'Codes as dining on most cards.';
const APPLE_PAY = 'Paying with Apple Pay does not change the category — the merchant code still controls.';
const TRANSIT_NOTE = 'Transit codes as transportation; Chase Sapphire Preferred counts it as travel (2x).';

// Directory ---------------------------------------------------------------

export const MERCHANTS: MerchantEntry[] = [
  // --- Warehouse clubs ----------------------------------------------------
  m('costco', 'Costco', ['costco wholesale', 'costco whse', 'costco warehouse'], 'shopping', 'warehouse', {
    rejectsNetworks: ['mastercard', 'amex', 'discover'],
    notes: [
      'Costco warehouses take Visa only (plus debit). Costco.com accepts Visa, Mastercard and Discover — still no Amex.',
      WAREHOUSE_CODE,
      'The Costco Anywhere Visa earns 2% at Costco; otherwise a 2% flat-rate Visa is the play.',
    ],
  }),
  m('costco-com', 'Costco.com', ['costco.com', 'costco online', 'costco com'], 'shopping', 'online', {
    rejectsNetworks: ['amex'],
    notes: ['Costco.com accepts Visa, Mastercard and Discover — no Amex. In-warehouse it is Visa only.', WAREHOUSE_CODE],
  }),
  m('costco-gas', 'Costco Gas', ['costco fuel', 'costco gasoline', 'costco gas station'], 'transport', 'gas', {
    rejectsNetworks: ['mastercard', 'amex', 'discover'],
    notes: ['Costco pumps take Visa only — same acceptance as the warehouse.', 'Codes as a gas station on most cards.'],
  }),
  m('sams-club', "Sam's Club", ['sams club', 'samsclub.com', 'sam s club', 'sams'], 'shopping', 'warehouse', {
    notes: [WAREHOUSE_CODE, 'Accepts all four networks.'],
  }),
  m('bjs', "BJ's Wholesale", ['bjs', 'bjs wholesale', 'bjs.com', 'bj s wholesale club'], 'shopping', 'warehouse', {
    notes: [WAREHOUSE_CODE],
  }),

  // --- Groceries ----------------------------------------------------------
  m('whole-foods', 'Whole Foods', ['whole foods market', 'wholefds', 'wfm', 'wholefoods.com'], 'groceries', 'store', {
    notes: ['Codes as a US supermarket, so grocery multipliers apply. The Amazon Prime Visa earns 5% here.'],
  }),
  m('trader-joes', "Trader Joe's", ['trader joes', 'trader joe', 'traderjoes.com'], 'groceries', 'store'),
  m('safeway', 'Safeway', ['safeway.com'], 'groceries', 'store'),
  m('kroger', 'Kroger', ['kroger.com', 'king soopers', 'fred meyer', 'ralphs', 'frys food', 'qfc', 'smiths food'], 'groceries', 'store', {
    notes: ['Kroger banners (Ralphs, King Soopers, Fred Meyer, QFC) all code as supermarkets.'],
  }),
  m('publix', 'Publix', ['publix.com', 'publix super markets'], 'groceries', 'store'),
  m('heb', 'H-E-B', ['heb', 'h e b', 'heb.com', 'heb grocery', 'central market'], 'groceries', 'store'),
  m('wegmans', 'Wegmans', ['wegmans.com', 'wegmans food markets'], 'groceries', 'store'),
  m('aldi', 'Aldi', ['aldi.us', 'aldi inc'], 'groceries', 'store', {
    notes: ['Aldi accepts all major networks; it codes as a supermarket.'],
  }),
  m('sprouts', 'Sprouts Farmers Market', ['sprouts', 'sprouts.com', 'sprouts farmers mkt'], 'groceries', 'store'),
  m('albertsons', 'Albertsons', ['albertsons.com', 'vons', 'pavilions', 'jewel osco', 'acme markets', 'shaws'], 'groceries', 'store'),
  m('stop-and-shop', 'Stop & Shop', ['stop and shop', 'stopandshop.com', 'giant food', 'giant eagle'], 'groceries', 'store'),
  m('meijer', 'Meijer', ['meijer.com'], 'groceries', 'store', {
    notes: ['Meijer is a supercenter but codes as a supermarket on most cards.'],
  }),
  m('harris-teeter', 'Harris Teeter', ['harristeeter.com', 'harris teeter supermarkets'], 'groceries', 'store'),
  m('food-lion', 'Food Lion', ['foodlion.com'], 'groceries', 'store'),
  m('instacart', 'Instacart', ['instacart.com', 'instacart delivery'], 'groceries', 'delivery', {
    notes: [
      'Codes as groceries on most cards (the supermarket you shop at is not what posts — Instacart is).',
      'Chase Sapphire cards include complimentary Instacart+ and a monthly Instacart credit while enrolled.',
    ],
  }),
  m('amazon-fresh', 'Amazon Fresh', ['amzn fresh', 'amazonfresh'], 'groceries', 'delivery', {
    notes: ['Often posts as Amazon, not a supermarket — grocery multipliers are unreliable here; the Prime Visa earns 5%.'],
  }),

  // --- Big box / online ---------------------------------------------------
  m('amazon', 'Amazon', ['amazon.com', 'amzn', 'amzn mktp', 'amazon marketplace', 'amazon.com bill'], 'shopping', 'online', {
    notes: [
      'Amazon is not a bonus category on most cards — pull your best flat-rate card (2%+). The Amazon Prime Visa earns 5% if you have it.',
      'Amazon Fresh, Whole Foods and Prime Video post separately and can code differently.',
    ],
  }),
  m('walmart', 'Walmart', ['walmart.com', 'wal-mart', 'wm supercenter', 'walmart supercenter', 'walmart neighborhood market'], 'shopping', 'store', {
    notes: [NOT_SUPERMARKET, 'Flat-rate cards win here; Walmart+ is a separate subscription charge.'],
  }),
  m('target', 'Target', ['target.com', 'target stores'], 'shopping', 'store', {
    notes: [NOT_SUPERMARKET, 'The Target Circle card (RedCard) takes 5% off at checkout, which beats any rewards card here.'],
  }),
  m('best-buy', 'Best Buy', ['bestbuy.com', 'best buy', 'bestbuy'], 'shopping', 'store', {
    notes: ['General retail — flat-rate card. Check for purchase protection / extended warranty on the card you use for electronics.'],
  }),
  m('home-depot', 'The Home Depot', ['home depot', 'homedepot.com', 'homedepot'], 'shopping', 'store', {
    notes: ['Codes as home improvement, not a bonus category on most cards. U.S. Bank Cash+ can select it as a 5% category.'],
  }),
  m('lowes', "Lowe's", ['lowes', 'lowes.com', 'lowes home improvement'], 'shopping', 'store', {
    notes: ['Codes as home improvement — flat-rate card unless you hold a card with that bonus category.'],
  }),
  m('ikea', 'IKEA', ['ikea.com', 'ikea us'], 'shopping', 'store'),
  m('apple', 'Apple', ['apple store', 'apple.com', 'apple online', 'apple retail'], 'shopping', 'store', {
    notes: [
      'Hardware codes as electronics / general retail — flat-rate card, and pick one with purchase protection.',
      APPLE_PAY,
    ],
  }),
  m('ebay', 'eBay', ['ebay.com', 'ebay inc'], 'shopping', 'online', {
    notes: ['Online marketplace — not a bonus category; use a flat-rate card.'],
  }),
  m('etsy', 'Etsy', ['etsy.com'], 'shopping', 'online'),
  m('wayfair', 'Wayfair', ['wayfair.com'], 'shopping', 'online'),
  m('nordstrom', 'Nordstrom', ['nordstrom.com', 'nordstrom rack'], 'shopping', 'store'),
  m('macys', "Macy's", ['macys', 'macys.com', 'macy s'], 'shopping', 'store'),
  m('sephora', 'Sephora', ['sephora.com', 'sephora usa'], 'shopping', 'store'),
  m('ulta', 'Ulta Beauty', ['ulta', 'ulta.com'], 'shopping', 'store'),
  m('uniqlo', 'Uniqlo', ['uniqlo.com', 'uniqlo usa'], 'shopping', 'store'),
  m('nike', 'Nike', ['nike.com', 'nike store'], 'shopping', 'store'),
  m('rei', 'REI', ['rei.com', 'rei co-op', 'recreational equipment'], 'shopping', 'store'),
  m('lululemon', 'Lululemon', ['lululemon.com', 'lululemon athletica'], 'shopping', 'store'),
  m('saks', 'Saks Fifth Avenue', ['saks', 'saks.com', 'saksfifthavenue.com', 'saks fifth ave'], 'shopping', 'store', {
    notes: ['The Amex Platinum carries a Saks credit (enrollment required) — use it before the period resets.'],
  }),
  m('zara', 'Zara', ['zara.com', 'zara usa'], 'shopping', 'store'),
  m('hm', 'H&M', ['h&m', 'h and m', 'hm.com', 'h m hennes'], 'shopping', 'store'),
  m('tjmaxx', 'T.J. Maxx', ['tj maxx', 'tjmaxx', 'tjmaxx.com', 'marshalls', 'homegoods'], 'shopping', 'store'),
  m('west-elm', 'West Elm', ['westelm.com', 'pottery barn', 'williams sonoma'], 'shopping', 'store'),
  m('chewy', 'Chewy', ['chewy.com', 'petsmart', 'petco'], 'shopping', 'online'),
  m('staples', 'Staples', ['staples.com', 'office depot', 'officemax'], 'shopping', 'store', {
    notes: ['Office supply stores are a 5% bonus category on Chase Ink Cash.'],
  }),

  // --- Dining & delivery --------------------------------------------------
  m('doordash', 'DoorDash', ['doordash.com', 'dd doordash', 'door dash'], 'dining', 'delivery', {
    notes: [
      DELIVERY_DINING,
      'Chase Sapphire cards bundle DashPass and a monthly DoorDash promo credit while enrolled.',
    ],
  }),
  m('uber-eats', 'Uber Eats', ['ubereats', 'uber eats', 'ubereats.com', 'uber * eats'], 'dining', 'delivery', {
    notes: [DELIVERY_DINING, 'Amex Gold / Platinum Uber Cash applies to Uber Eats orders in the US.'],
  }),
  m('grubhub', 'Grubhub', ['grubhub.com', 'seamless', 'seamless.com'], 'dining', 'delivery', {
    notes: [DELIVERY_DINING, 'Grubhub is one of the merchants covered by the Amex Gold monthly dining credit (enrollment required).'],
  }),
  m('starbucks', 'Starbucks', ['starbucks.com', 'sbux', 'starbucks coffee'], 'dining', 'restaurant', {
    notes: ['Codes as dining. Reloading the Starbucks app is also dining on most cards.'],
  }),
  m('chipotle', 'Chipotle', ['chipotle.com', 'chipotle mexican grill'], 'dining', 'restaurant'),
  m('sweetgreen', 'Sweetgreen', ['sweetgreen.com', 'tst sweetgreen'], 'dining', 'restaurant'),
  m('mcdonalds', "McDonald's", ['mcdonalds', 'mcdonalds.com', 'mcd', 'mcdonald s'], 'dining', 'restaurant'),
  m('dunkin', "Dunkin'", ['dunkin', 'dunkin donuts', 'dunkindonuts.com'], 'dining', 'restaurant'),
  m('resy', 'Resy', ['resy.com', 'resy reservations'], 'dining', 'restaurant', {
    notes: [
      'You pay the restaurant, not Resy — the charge codes as dining at the restaurant.',
      'Amex Gold carries a Resy credit; Amex Platinum gets Resy Global Dining Access.',
    ],
  }),
  m('opentable', 'OpenTable', ['opentable.com', 'open table'], 'dining', 'restaurant', {
    notes: ['Reservations only — the actual charge posts from the restaurant as dining.'],
  }),
  m('panera', 'Panera Bread', ['panera', 'panera.com', 'panera bread'], 'dining', 'restaurant'),
  m('shake-shack', 'Shake Shack', ['shakeshack.com', 'shake shack'], 'dining', 'restaurant'),
  m('chick-fil-a', 'Chick-fil-A', ['chick fil a', 'chickfila', 'chick-fil-a.com'], 'dining', 'restaurant'),
  m('five-guys', 'Five Guys', ['fiveguys.com', 'five guys burgers'], 'dining', 'restaurant', {
    notes: ['Covered by the Amex Gold monthly dining credit (enrollment required).'],
  }),
  m('cheesecake-factory', 'The Cheesecake Factory', ['cheesecake factory', 'thecheesecakefactory.com'], 'dining', 'restaurant', {
    notes: ['Covered by the Amex Gold monthly dining credit (enrollment required).'],
  }),
  m('blue-bottle', 'Blue Bottle Coffee', ['bluebottlecoffee.com', 'blue bottle'], 'dining', 'restaurant'),

  // --- Rideshare / transit / gas / EV -------------------------------------
  m('uber', 'Uber', ['uber.com', 'uber trip', 'uber rides', 'uber * trip', 'uber bv'], 'transport', 'rideshare', {
    notes: [
      'Amex Gold / Platinum Uber Cash covers US rides and Uber Eats — it is use-it-or-lose-it each month.',
      'Chase Sapphire Preferred counts rideshare as travel (2x); most other cards treat it as transportation.',
    ],
  }),
  m('lyft', 'Lyft', ['lyft.com', 'lyft ride', 'lyft inc'], 'transport', 'rideshare', {
    notes: ['Chase Sapphire Preferred and Reserve earn 5x on Lyft through 2027 (modeled at the card’s base travel rate here).'],
  }),
  m('waymo', 'Waymo', ['waymo.com', 'waymo one'], 'transport', 'rideshare', {
    notes: ['Codes as a taxi / rideshare — transportation on most cards, travel on Chase Sapphire Preferred.'],
  }),
  m('bart', 'BART', ['bart.gov', 'bay area rapid transit'], 'transport', 'transit', { notes: [TRANSIT_NOTE, APPLE_PAY] }),
  m('mta', 'MTA', ['mta.info', 'omny', 'metrocard', 'nyct', 'lirr', 'metro-north'], 'transport', 'transit', {
    notes: [TRANSIT_NOTE, 'OMNY tap-to-pay posts per ride; Apple Pay does not change the category.'],
  }),
  m('clipper', 'Clipper', ['clipper card', 'clippercard.com', 'sfmta', 'muni', 'caltrain'], 'transport', 'transit', {
    notes: [TRANSIT_NOTE, APPLE_PAY],
  }),
  m('amtrak', 'Amtrak', ['amtrak.com', 'amtrak rail'], 'travel', 'transit', {
    notes: ['Codes as travel — Sapphire Preferred 2x, Venture X 2x. Amex Platinum’s 5x is flights only.'],
  }),
  m('shell', 'Shell', ['shell oil', 'shell service station', 'shell.com', 'shell gas'], 'transport', 'gas'),
  m('chevron', 'Chevron', ['chevron.com', 'chevron gas', 'texaco'], 'transport', 'gas'),
  m('exxon', 'Exxon', ['exxon mobil', 'exxonmobil', 'mobil', 'exxon.com'], 'transport', 'gas'),
  m('arco', 'ARCO', ['arco gas', 'ampm', 'arco ampm'], 'transport', 'gas', {
    notes: ['Many ARCO stations charge a per-transaction card fee — cash or debit may be cheaper than any reward.'],
  }),
  m('ev-charging', 'EV charging', ['chargepoint', 'electrify america', 'evgo', 'tesla supercharger', 'blink charging', 'ev charger'], 'transport', 'gas', {
    notes: ['Most EV charging networks code as gas stations / automotive — gas bonus categories often apply, but not always.'],
  }),
  m('hertz', 'Hertz', ['hertz.com', 'hertz rent a car', 'hertz rental'], 'travel', 'other', {
    notes: ['Car rentals code as travel. Chase Sapphire cards include primary rental coverage — decline the counter CDW.'],
  }),
  m('enterprise', 'Enterprise Rent-A-Car', ['enterprise', 'enterprise.com', 'enterprise rent a car', 'national car rental', 'alamo'], 'travel', 'other', {
    notes: ['Car rentals code as travel; check your card’s rental coverage before declining the counter insurance.'],
  }),
  m('avis', 'Avis', ['avis.com', 'avis rent a car', 'budget rent a car', 'budget.com'], 'travel', 'other', {
    notes: ['Car rentals code as travel; Amex Platinum gets Avis Preferred status.'],
  }),

  // --- Airlines -----------------------------------------------------------
  m('united', 'United Airlines', ['united.com', 'united air', 'united airlines', 'ual', 'mileageplus'], 'travel', 'airline', {
    programId: 'united',
    notes: [AIRLINE_DIRECT, 'United fares can also be booked with Aeroplan or other Star Alliance miles, often for fewer points.'],
  }),
  m('delta', 'Delta Air Lines', ['delta.com', 'delta air', 'delta airlines', 'skymiles'], 'travel', 'airline', {
    programId: 'delta',
    notes: [AIRLINE_DIRECT, 'SkyMiles awards are priced dynamically — compare to the cash fare every time.'],
  }),
  m('american', 'American Airlines', ['aa.com', 'american air', 'american airlines', 'aadvantage'], 'travel', 'airline', {
    programId: 'american',
    notes: [AIRLINE_DIRECT, 'AAdvantage has no Chase/Amex/Capital One transfer partner — earn miles by flying or via Citi/Bilt.'],
  }),
  m('southwest', 'Southwest Airlines', ['southwest.com', 'southwest', 'southwes', 'rapid rewards', 'swa'], 'travel', 'airline', {
    programId: 'southwest',
    notes: [AIRLINE_DIRECT, 'Rapid Rewards awards are tied to the cash fare (~1.3–1.5¢/pt) — rarely a bad deal, rarely a great one.'],
  }),
  m('alaska', 'Alaska Airlines', ['alaskaair.com', 'alaska air', 'alaska airlines', 'mileage plan', 'atmos rewards'], 'travel', 'airline', {
    programId: 'alaska',
    notes: [AIRLINE_DIRECT, 'Atmos Rewards (ex-Mileage Plan) miles are among the most valuable for oneworld partner awards.'],
  }),
  m('jetblue', 'JetBlue', ['jetblue.com', 'jet blue', 'trueblue'], 'travel', 'airline', {
    programId: 'jetblue',
    notes: [AIRLINE_DIRECT, 'TrueBlue awards track the cash fare, so paying cash with a strong travel card is often equivalent.'],
  }),
  m('spirit', 'Spirit Airlines', ['spirit.com', 'spirit air', 'spirit airlines'], 'travel', 'airline', {
    notes: [AIRLINE_DIRECT, 'Spirit points are not a transfer partner of any major bank program.'],
  }),
  m('frontier', 'Frontier Airlines', ['flyfrontier.com', 'frontier air', 'frontier airlines'], 'travel', 'airline', {
    notes: [AIRLINE_DIRECT],
  }),
  m('hawaiian', 'Hawaiian Airlines', ['hawaiianairlines.com', 'hawaiian air', 'hawaiian airlines', 'hawaiianmiles'], 'travel', 'airline', {
    programId: 'alaska',
    notes: [AIRLINE_DIRECT, 'Hawaiian merged into Alaska; HawaiianMiles roll into Atmos Rewards.'],
  }),
  m('air-canada', 'Air Canada', ['aircanada.com', 'air canada', 'aeroplan'], 'travel', 'airline', {
    programId: 'aeroplan',
    notes: [AIRLINE_DIRECT, 'Aeroplan is a transfer partner of Chase, Amex, Capital One and Bilt — one of the most reachable currencies.'],
  }),
  m('british-airways', 'British Airways', ['britishairways.com', 'british air', 'ba.com', 'avios', 'executive club'], 'travel', 'airline', {
    programId: 'british-airways',
    notes: [AIRLINE_DIRECT, 'Avios transfer from Chase, Amex, Capital One and Bilt; watch the surcharges on long-haul BA awards.'],
  }),
  m('air-france-klm', 'Air France / KLM', ['air france', 'airfrance.com', 'klm', 'klm.com', 'flying blue'], 'travel', 'airline', {
    programId: 'flying-blue',
    notes: [AIRLINE_DIRECT, 'Flying Blue transfers from every major bank program; monthly Promo Rewards can cut award prices 25%+.'],
  }),
  m('virgin-atlantic', 'Virgin Atlantic', ['virginatlantic.com', 'virgin atl', 'flying club'], 'travel', 'airline', {
    programId: 'virgin-atlantic',
    notes: [AIRLINE_DIRECT, 'Flying Club points transfer from Chase, Amex, Capital One, Citi and Bilt.'],
  }),
  m('singapore', 'Singapore Airlines', ['singaporeair.com', 'singapore air', 'krisflyer'], 'travel', 'airline', {
    programId: 'singapore',
    notes: [AIRLINE_DIRECT, 'KrisFlyer transfers from Chase, Amex, Capital One and Citi; transfers take 1–2 days.'],
  }),
  m('ana', 'ANA', ['ana.co.jp', 'all nippon', 'all nippon airways', 'ana mileage club'], 'travel', 'airline', {
    programId: 'ana',
    notes: [AIRLINE_DIRECT, 'ANA Mileage Club transfers from Amex only (1:1); miles expire 36 months after earning.'],
  }),
  m('cathay', 'Cathay Pacific', ['cathaypacific.com', 'cathay pacific', 'asia miles', 'cathay'], 'travel', 'airline', {
    programId: 'cathay',
    notes: [AIRLINE_DIRECT, 'Asia Miles transfer from Amex, Capital One, Citi and Bilt.'],
  }),
  m('emirates', 'Emirates', ['emirates.com', 'emirates airline', 'skywards'], 'travel', 'airline', {
    programId: 'emirates',
    notes: [AIRLINE_DIRECT, 'Skywards transfers from Chase, Amex, Capital One and Citi; premium-cabin awards carry heavy surcharges.'],
  }),
  m('turkish', 'Turkish Airlines', ['turkishairlines.com', 'turkish air', 'miles&smiles', 'miles and smiles'], 'travel', 'airline', {
    programId: 'turkish',
    notes: [AIRLINE_DIRECT, 'Miles&Smiles transfers from Capital One, Citi and Bilt; famous for cheap United domestic awards.'],
  }),
  m('lufthansa', 'Lufthansa', ['lufthansa.com', 'lufthansa group', 'miles & more', 'swiss air', 'austrian airlines'], 'travel', 'airline', {
    notes: [AIRLINE_DIRECT, 'Miles & More is hard to earn from US banks — book Lufthansa awards with Aeroplan or United miles instead.'],
  }),
  m('jal', 'Japan Airlines', ['jal.com', 'jal', 'japan airlines', 'jal mileage bank'], 'travel', 'airline', {
    notes: [AIRLINE_DIRECT, 'JAL awards are best booked with Alaska Atmos or Cathay Asia Miles rather than JAL Mileage Bank.'],
  }),
  m('qantas', 'Qantas', ['qantas.com', 'qantas airways', 'qantas frequent flyer'], 'travel', 'airline', {
    notes: [AIRLINE_DIRECT, 'Qantas Points transfer from Amex, Capital One and Citi; Alaska Atmos also books Qantas awards.'],
  }),

  // --- Hotels -------------------------------------------------------------
  m('hyatt', 'Hyatt', ['hyatt.com', 'world of hyatt', 'hyatt hotels', 'hyatt regency', 'grand hyatt', 'hyatt house'], 'travel', 'hotel', {
    programId: 'hyatt',
    notes: [HOTEL_DIRECT, 'World of Hyatt is Chase’s best transfer partner — award nights routinely return 1.7–2.5¢ per point.'],
  }),
  m('park-hyatt', 'Park Hyatt', ['park hyatt hotels'], 'travel', 'hotel', { programId: 'hyatt', notes: [HOTEL_DIRECT] }),
  m('andaz', 'Andaz', ['andaz hotels'], 'travel', 'hotel', { programId: 'hyatt', notes: [HOTEL_DIRECT] }),
  m('thompson', 'Thompson Hotels', ['thompson hotel', 'thompson'], 'travel', 'hotel', { programId: 'hyatt', notes: [HOTEL_DIRECT] }),
  m('hyatt-place', 'Hyatt Place', ['hyatt place hotels'], 'travel', 'hotel', { programId: 'hyatt', notes: [HOTEL_DIRECT] }),
  m('marriott', 'Marriott', ['marriott.com', 'marriott bonvoy', 'bonvoy', 'marriott hotels', 'jw marriott'], 'travel', 'hotel', {
    programId: 'marriott',
    notes: [HOTEL_DIRECT, 'Bonvoy points are worth ~0.7¢ — transferring bank points here is rarely a good deal.'],
  }),
  m('westin', 'Westin', ['westin hotels', 'the westin'], 'travel', 'hotel', { programId: 'marriott', notes: [HOTEL_DIRECT] }),
  m('sheraton', 'Sheraton', ['sheraton hotels'], 'travel', 'hotel', { programId: 'marriott', notes: [HOTEL_DIRECT] }),
  m('ritz-carlton', 'The Ritz-Carlton', ['ritz carlton', 'ritz-carlton', 'ritzcarlton.com'], 'travel', 'hotel', { programId: 'marriott', notes: [HOTEL_DIRECT] }),
  m('st-regis', 'St. Regis', ['st regis', 'st. regis hotels', 'stregis'], 'travel', 'hotel', { programId: 'marriott', notes: [HOTEL_DIRECT] }),
  m('courtyard', 'Courtyard by Marriott', ['courtyard', 'courtyard marriott'], 'travel', 'hotel', { programId: 'marriott', notes: [HOTEL_DIRECT] }),
  m('residence-inn', 'Residence Inn', ['residence inn by marriott'], 'travel', 'hotel', { programId: 'marriott', notes: [HOTEL_DIRECT] }),
  m('w-hotels', 'W Hotels', ['w hotel', 'w hotels worldwide'], 'travel', 'hotel', { programId: 'marriott', notes: [HOTEL_DIRECT] }),
  m('hilton', 'Hilton', ['hilton.com', 'hilton honors', 'hilton hotels', 'hilton garden inn', 'homewood suites'], 'travel', 'hotel', {
    programId: 'hilton',
    notes: [HOTEL_DIRECT, 'Honors points are worth ~0.5¢; Amex MR transfers 1:2, which is the only bank route worth considering.'],
  }),
  m('waldorf-astoria', 'Waldorf Astoria', ['waldorf', 'waldorf astoria hotels'], 'travel', 'hotel', { programId: 'hilton', notes: [HOTEL_DIRECT] }),
  m('conrad', 'Conrad Hotels', ['conrad', 'conrad hotel'], 'travel', 'hotel', { programId: 'hilton', notes: [HOTEL_DIRECT] }),
  m('hampton', 'Hampton by Hilton', ['hampton inn', 'hampton inn & suites'], 'travel', 'hotel', { programId: 'hilton', notes: [HOTEL_DIRECT] }),
  m('doubletree', 'DoubleTree', ['doubletree by hilton', 'double tree'], 'travel', 'hotel', { programId: 'hilton', notes: [HOTEL_DIRECT] }),
  m('embassy-suites', 'Embassy Suites', ['embassy suites by hilton'], 'travel', 'hotel', { programId: 'hilton', notes: [HOTEL_DIRECT] }),
  m('ihg', 'IHG Hotels', ['ihg', 'ihg.com', 'ihg one rewards', 'ihg rewards'], 'travel', 'hotel', {
    programId: 'ihg',
    notes: [HOTEL_DIRECT, 'IHG points are worth ~0.6¢; the 4th-night-free perk on IHG cards changes the math on long stays.'],
  }),
  m('intercontinental', 'InterContinental', ['intercontinental hotels', 'inter continental'], 'travel', 'hotel', { programId: 'ihg', notes: [HOTEL_DIRECT] }),
  m('kimpton', 'Kimpton', ['kimpton hotels'], 'travel', 'hotel', { programId: 'ihg', notes: [HOTEL_DIRECT] }),
  m('holiday-inn', 'Holiday Inn', ['holiday inn express', 'holidayinn.com'], 'travel', 'hotel', { programId: 'ihg', notes: [HOTEL_DIRECT] }),
  m('crowne-plaza', 'Crowne Plaza', ['crowne plaza hotels'], 'travel', 'hotel', { programId: 'ihg', notes: [HOTEL_DIRECT] }),
  m('wyndham', 'Wyndham', ['wyndham.com', 'wyndham rewards', 'wyndham hotels', 'days inn', 'super 8', 'ramada'], 'travel', 'hotel', {
    programId: 'wyndham',
    notes: [HOTEL_DIRECT, 'Wyndham Rewards has flat award pricing (7.5k/15k/30k) — Vacasa rentals can be a sweet spot.'],
  }),
  m('la-quinta', 'La Quinta', ['la quinta inn', 'laquinta.com', 'la quinta by wyndham'], 'travel', 'hotel', { programId: 'wyndham', notes: [HOTEL_DIRECT] }),
  m('choice', 'Choice Hotels', ['choice', 'choicehotels.com', 'choice privileges'], 'travel', 'hotel', {
    programId: 'choice',
    notes: [HOTEL_DIRECT, 'Choice Privileges points are worth ~0.6¢; Citi ThankYou transfers 1:2.'],
  }),
  m('comfort-inn', 'Comfort Inn', ['comfort inn & suites', 'comfort suites', 'quality inn', 'cambria hotels'], 'travel', 'hotel', { programId: 'choice', notes: [HOTEL_DIRECT] }),
  m('accor', 'Accor', ['accor.com', 'all.accor.com', 'accor live limitless', 'all accor', 'novotel', 'ibis'], 'travel', 'hotel', {
    programId: 'accor',
    notes: [HOTEL_DIRECT, 'ALL points are a fixed ~2¢ discount off the cash rate — bank transfers are usually 2:1, which nets ~1¢.'],
  }),
  m('sofitel', 'Sofitel', ['sofitel hotels'], 'travel', 'hotel', { programId: 'accor', notes: [HOTEL_DIRECT] }),
  m('fairmont', 'Fairmont', ['fairmont hotels', 'fairmont.com'], 'travel', 'hotel', { programId: 'accor', notes: [HOTEL_DIRECT] }),
  m('four-seasons', 'Four Seasons', ['fourseasons.com', 'four seasons hotels'], 'travel', 'hotel', {
    notes: ['No points program — book via Amex Fine Hotels + Resorts or Chase The Edit for on-property credits, or direct.'],
  }),

  // --- OTAs & portals -----------------------------------------------------
  m('expedia', 'Expedia', ['expedia.com', 'expedia inc', 'orbitz', 'travelocity'], 'travel', 'travel-portal', {
    notes: [OTA_NO_ELITE, 'Prepaid OTA hotels do not earn hotel points; flights booked here still earn airline miles.'],
  }),
  m('booking-com', 'Booking.com', ['booking.com', 'booking com', 'booking.com bv', 'bookingcom'], 'travel', 'travel-portal', {
    notes: [OTA_NO_ELITE, '"Pay at property" bookings post from the hotel and may still earn elite credit — prepaid ones will not.'],
  }),
  m('hotels-com', 'Hotels.com', ['hotels.com', 'hotels com', 'hotelscom'], 'travel', 'travel-portal', {
    notes: [OTA_NO_ELITE],
  }),
  m('kayak', 'Kayak', ['kayak.com'], 'travel', 'travel-portal', {
    notes: ['Kayak is metasearch — the booking (and the charge) happens with the airline, hotel or OTA it sends you to.'],
  }),
  m('priceline', 'Priceline', ['priceline.com', 'priceline com'], 'travel', 'travel-portal', {
    notes: [OTA_NO_ELITE],
  }),
  m('airbnb', 'Airbnb', ['airbnb.com', 'airbnb inc', 'air bnb'], 'travel', 'online', {
    notes: ['Codes as travel on most cards (Sapphire Preferred 2x, Venture X 2x, Amex Gold 3x as modeled). No elite credit either way.'],
  }),
  m('vrbo', 'Vrbo', ['vrbo.com', 'homeaway'], 'travel', 'online', {
    notes: ['Codes as travel on most cards — same treatment as Airbnb.'],
  }),
  m('chase-travel', 'Chase Travel', ['chase travel portal', 'ultimate rewards travel', 'chase ultimate rewards travel', 'chase.com/travel'], 'travel', 'travel-portal', {
    notes: [
      'Earns 5x on Sapphire Preferred and 8x on Sapphire Reserve — but hotel stays booked here forfeit elite perks, points and night credit.',
      'Flights booked through Chase Travel still earn airline miles; Sapphire Reserve’s $300 travel credit applies to any travel.',
    ],
  }),
  m('amex-travel', 'Amex Travel', ['amextravel.com', 'american express travel', 'amex travel portal', 'fine hotels + resorts', 'fhr'], 'travel', 'travel-portal', {
    notes: [
      'Amex Platinum earns 5x on flights and prepaid hotels booked here; Fine Hotels + Resorts stays keep elite credit and add on-property perks.',
      'Standard prepaid hotels via Amex Travel usually do not earn hotel points or elite nights.',
    ],
  }),
  m('capital-one-travel', 'Capital One Travel', ['capitalonetravel.com', 'capital one travel portal', 'cap one travel'], 'travel', 'travel-portal', {
    notes: [
      'Venture X earns 10x hotels / 5x flights here, but hotel stays booked through the portal usually forfeit elite credit.',
      'Venture X’s $300 annual travel credit only works on portal bookings.',
    ],
  }),
  m('google-flights', 'Google Flights', ['flights.google.com', 'google flights', 'google travel'], 'travel', 'travel-portal', {
    notes: ['Google Flights is search only — the booking (and the charge) goes to the airline, so it counts as booked direct.'],
  }),
  m('hopper', 'Hopper', ['hopper.com', 'hopper travel'], 'travel', 'travel-portal', { notes: [OTA_NO_ELITE] }),

  // --- Streaming & subscriptions ------------------------------------------
  m('netflix', 'Netflix', ['netflix.com'], 'subscriptions', 'streaming', {
    notes: ['Streaming is a 3x category on Sapphire Preferred and 6% on Amex Blue Cash Preferred.'],
  }),
  m('spotify', 'Spotify', ['spotify.com', 'spotify usa'], 'subscriptions', 'streaming', {
    notes: ['Counts as select streaming on Sapphire Preferred (3x) and Blue Cash Preferred (6%).'],
  }),
  m('hulu', 'Hulu', ['hulu.com'], 'subscriptions', 'streaming'),
  m('disney-plus', 'Disney+', ['disney plus', 'disneyplus.com', 'disney+'], 'subscriptions', 'streaming', {
    notes: ['The Disney Bundle (Disney+, Hulu, ESPN+) is one of the Amex Platinum entertainment-credit merchants.'],
  }),
  m('max', 'Max', ['hbo max', 'max.com', 'hbomax', 'hbo'], 'subscriptions', 'streaming'),
  m('youtube-premium', 'YouTube Premium', ['youtube premium', 'youtube tv', 'google youtube', 'youtubepremium'], 'subscriptions', 'streaming', {
    notes: ['YouTube Premium and YouTube TV both count toward the Amex Platinum digital entertainment credit.'],
  }),
  m('apple-services', 'Apple Services', ['apple.com/bill', 'apple.com bill', 'icloud', 'apple music', 'apple tv+', 'apple one', 'apple arcade'], 'subscriptions', 'streaming', {
    notes: ['Apple.com/bill charges code as digital goods, which most "select streaming" bonuses do not include.'],
  }),
  m('peloton', 'Peloton', ['onepeloton.com', 'peloton interactive', 'peloton app'], 'subscriptions', 'streaming', {
    notes: ['The Peloton app membership is an Amex Platinum entertainment-credit merchant; hardware codes as retail.'],
  }),
  m('paramount-plus', 'Paramount+', ['paramount plus', 'paramountplus.com', 'peacock', 'peacocktv.com'], 'subscriptions', 'streaming'),
  m('audible', 'Audible', ['audible.com', 'kindle unlimited'], 'subscriptions', 'streaming'),
  m('nytimes', 'The New York Times', ['nytimes', 'nytimes.com', 'ny times', 'new york times'], 'subscriptions', 'other', {
    notes: ['One of the Amex Platinum digital entertainment-credit merchants (enrollment required).'],
  }),

  // --- Utilities & phone --------------------------------------------------
  m('pge', 'PG&E', ['pg&e', 'pge', 'pacific gas and electric', 'pge.com'], 'utilities', 'other', {
    notes: ['Most utilities add a ~2–3% card fee — a 2% card barely breaks even. U.S. Bank Cash+ can select utilities as a 5% category.'],
  }),
  m('xfinity', 'Xfinity', ['comcast', 'xfinity.com', 'comcast xfinity'], 'utilities', 'other', {
    notes: ['Internet / cable — U.S. Bank Cash+ and some Citi Custom Cash setups treat this as a bonus category; most cards pay base rate.'],
  }),
  m('verizon', 'Verizon', ['verizon wireless', 'vzw', 'vzwrlss', 'verizon.com'], 'utilities', 'other', {
    notes: ['Pay your cell bill with a card that carries cell-phone protection (Sapphire Reserve, Freedom Flex, Venture X, Platinum) to activate the coverage.'],
  }),
  m('att', 'AT&T', ['at&t', 'att', 'att.com', 'att bill', 'at t'], 'utilities', 'other', {
    notes: ['Pay your cell bill with a card that carries cell-phone protection to activate the coverage.'],
  }),
  m('t-mobile', 'T-Mobile', ['tmobile', 't mobile', 't-mobile.com'], 'utilities', 'other', {
    notes: ['Pay your cell bill with a card that carries cell-phone protection to activate the coverage.'],
  }),
  m('spectrum', 'Spectrum', ['spectrum.com', 'charter communications', 'charter spectrum'], 'utilities', 'other'),

  // --- Pharmacies & health ------------------------------------------------
  m('cvs', 'CVS Pharmacy', ['cvs', 'cvs.com', 'cvs pharmacy', 'cvs/pharmacy'], 'health', 'store', {
    notes: ['Drugstores are a 3% category on Chase Freedom Flex and Freedom Unlimited; most other cards pay base rate.'],
  }),
  m('walgreens', 'Walgreens', ['walgreens.com', 'duane reade'], 'health', 'store', {
    notes: ['Drugstores are a 3% category on Chase Freedom Flex and Freedom Unlimited.'],
  }),
  m('rite-aid', 'Rite Aid', ['riteaid.com', 'rite-aid'], 'health', 'store'),
  m('one-medical', 'One Medical', ['onemedical.com', 'one medical group'], 'health', 'other', {
    notes: ['Medical charges are not a bonus category anywhere — flat-rate card, or an HSA/FSA card if eligible.'],
  }),
  m('equinox', 'Equinox', ['equinox.com', 'equinox fitness'], 'health', 'other', {
    notes: ['Gym memberships code as health/fitness — base rate on nearly every card. Amex Platinum carries an Equinox credit (enrollment required).'],
  }),
  m('classpass', 'ClassPass', ['classpass.com'], 'health', 'other', {
    notes: ['Codes as a fitness subscription — base rate on most cards.'],
  }),
  m('planet-fitness', 'Planet Fitness', ['planetfitness.com', '24 hour fitness', 'la fitness', 'orangetheory'], 'health', 'other'),

  // --- Entertainment ------------------------------------------------------
  m('amc', 'AMC Theatres', ['amc', 'amctheatres.com', 'amc theaters', 'amc stubs'], 'entertainment', 'other', {
    notes: ['Movie theaters are a 3% entertainment category on Capital One Savor.'],
  }),
  m('ticketmaster', 'Ticketmaster', ['ticketmaster.com', 'live nation', 'livenation.com'], 'entertainment', 'other', {
    notes: ['Ticket sellers code as entertainment — Capital One Savor 3%; Citi Strata Premier does not bonus this.'],
  }),
  m('stubhub', 'StubHub', ['stubhub.com', 'stub hub', 'seatgeek', 'vivid seats'], 'entertainment', 'other', {
    notes: ['Resale tickets code as entertainment — Capital One Savor 3%.'],
  }),
  m('steam', 'Steam', ['steampowered.com', 'steam games', 'valve'], 'entertainment', 'online', {
    notes: ['Digital games code as entertainment or digital goods depending on the card — base rate on most.'],
  }),
  m('playstation', 'PlayStation', ['playstation.com', 'sony interactive', 'playstation network', 'psn'], 'entertainment', 'online'),
  m('xbox', 'Xbox', ['xbox.com', 'microsoft xbox', 'xbox game pass'], 'entertainment', 'online'),
  m('fandango', 'Fandango', ['fandango.com', 'regal cinemas', 'cinemark'], 'entertainment', 'other'),
  m('sfmoma', 'SFMOMA', ['sfmoma.org', 'san francisco museum of modern art'], 'entertainment', 'other'),
];

// Search -----------------------------------------------------------------

const PUNCT_RE = /[^a-z0-9&+.\s]/g;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(PUNCT_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensOf(s: string): string[] {
  return normalize(s)
    .split(/[\s.&+]+/)
    .filter((t) => t.length > 0);
}

interface Indexed {
  entry: MerchantEntry;
  keys: string[]; // normalized name + aliases
  tokens: Set<string>;
}

let INDEX: Indexed[] | null = null;

function index(): Indexed[] {
  if (!INDEX) {
    INDEX = MERCHANTS.map((entry) => {
      const keys = [entry.name, ...entry.aliases].map(normalize);
      const tokens = new Set<string>();
      for (const k of keys) for (const t of tokensOf(k)) tokens.add(t);
      return { entry, keys, tokens };
    });
  }
  return INDEX;
}

/** Query variants: the normalized text, plus the bare domain label for 'www.united.com'-style input. */
function queryVariants(query: string): string[] {
  const out = new Set<string>();
  const q = normalize(query).replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '');
  if (q) out.add(q);
  const domain = q.match(/^([a-z0-9-]+)\.(com|net|org|co|io|us|app|tv|me|ai|gov|info)$/);
  if (domain) out.add(domain[1]);
  return [...out];
}

function scoreEntry(ix: Indexed, variants: string[]): number {
  let best = 0;
  for (const q of variants) {
    const qTokens = tokensOf(q);
    for (const key of ix.keys) {
      if (key === q) return 100; // exact name/alias — cannot do better
      if (key.startsWith(q)) best = Math.max(best, 80 - Math.min(15, key.length - q.length));
      else if (q.length >= 3 && key.includes(q)) best = Math.max(best, 60);
      else if (qTokens.length > 1 && q.startsWith(key) && key.length >= 3) best = Math.max(best, 55); // 'costco gas station' → 'costco'
    }
    if (qTokens.length > 0) {
      const matched = qTokens.filter((t) => t.length >= 2 && ix.tokens.has(t)).length;
      if (matched > 0) best = Math.max(best, 20 + Math.round(30 * (matched / qTokens.length)));
    }
  }
  return best;
}

/** Ranked fuzzy search over names + aliases. Empty query → []. */
export function searchMerchants(query: string, limit = 8): MerchantEntry[] {
  const variants = queryVariants(query);
  if (variants.length === 0 || limit <= 0) return [];
  const scored: Array<{ entry: MerchantEntry; score: number; order: number }> = [];
  index().forEach((ix, order) => {
    const score = scoreEntry(ix, variants);
    if (score > 0) scored.push({ entry: ix.entry, score, order });
  });
  scored.sort(
    (a, b) =>
      b.score - a.score || a.entry.name.length - b.entry.name.length || a.order - b.order,
  );
  return scored.slice(0, limit).map((s) => s.entry);
}

/** Lookup by id. */
export function merchantById(id: string): MerchantEntry | undefined {
  return MERCHANTS.find((e) => e.id === id);
}

/** Merchants that belong to a loyalty program (airline/hotel brands), brand-level entry first. */
export function merchantsForProgram(programId: string): MerchantEntry[] {
  return MERCHANTS.filter((e) => e.programId === programId);
}
