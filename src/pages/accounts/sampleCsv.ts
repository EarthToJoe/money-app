// Built-in sample statement so the import wizard is testable without a file.
// Mirrors a typical card export: spending is negative, payments/refunds positive,
// dates in MM/DD/YYYY. Dates are generated relative to today so the rows land
// in the current and previous month.

interface SampleRow {
  daysAgo: number;
  description: string;
  type: 'Sale' | 'Payment' | 'Return';
  amount: number; // statement sign: negative = charge
}

const ROWS: SampleRow[] = [
  { daysAgo: 1, description: "TRADER JOE'S #552 SAN FRANCISC", type: 'Sale', amount: -54.12 },
  { daysAgo: 1, description: 'SQ *SIGHTGLASS COFFEE', type: 'Sale', amount: -6.75 },
  { daysAgo: 2, description: 'UBER *TRIP HELP.UBER.COM', type: 'Sale', amount: -18.4 },
  { daysAgo: 2, description: 'TST* SOUVLA - HAYES VALLEY', type: 'Sale', amount: -19.5 },
  { daysAgo: 3, description: 'AMZN MKTP US*2K4PX91 AMZN.COM/BILL', type: 'Sale', amount: -42.99 },
  { daysAgo: 4, description: 'NETFLIX.COM NETFLIX.COM CA', type: 'Sale', amount: -15.49 },
  { daysAgo: 4, description: 'DD *DOORDASH BURMASUPER', type: 'Sale', amount: -38.2 },
  { daysAgo: 5, description: 'SHELL OIL 57444202800 SAN FRAN', type: 'Sale', amount: -52.3 },
  { daysAgo: 6, description: 'WHOLEFDS SOM 10250 SAN FRANCIS', type: 'Sale', amount: -71.08 },
  { daysAgo: 7, description: 'PAYMENT THANK YOU - WEB', type: 'Payment', amount: 1250.0 },
  { daysAgo: 7, description: 'CVS/PHARMACY #09823 SAN FRANCI', type: 'Sale', amount: -23.47 },
  { daysAgo: 8, description: 'SPOTIFY USA 877-778-1161 NY', type: 'Sale', amount: -11.99 },
  { daysAgo: 9, description: 'CHIPOTLE 1459 SAN FRANCISCO CA', type: 'Sale', amount: -13.85 },
  { daysAgo: 10, description: 'LYFT *RIDE 855-865-9553 CA', type: 'Sale', amount: -14.2 },
  { daysAgo: 11, description: 'TARGET 00027616 SAN FRANCISCO', type: 'Sale', amount: -64.31 },
  { daysAgo: 12, description: 'UNITED 0162489217743 UNITED.CO', type: 'Sale', amount: -312.6 },
  { daysAgo: 12, description: 'AIRBNB * HMA8Q2Z1KF AIRBNB.COM', type: 'Sale', amount: -418.0 },
  { daysAgo: 13, description: 'AMC METREON 16 SAN FRANCISCO', type: 'Sale', amount: -34.0 },
  { daysAgo: 14, description: 'STARBUCKS STORE 05612 SAN FRAN', type: 'Sale', amount: -7.25 },
  { daysAgo: 15, description: 'SAFEWAY #0995 SAN FRANCISCO CA', type: 'Sale', amount: -46.9 },
  { daysAgo: 16, description: 'UBER *EATS HELP.UBER.COM', type: 'Sale', amount: -29.75 },
  { daysAgo: 17, description: 'COMCAST CABLE COMM 800-COMCAST', type: 'Sale', amount: -74.99 },
  { daysAgo: 18, description: 'SFMTA PARKING METER SAN FRANCI', type: 'Sale', amount: -4.5 },
  { daysAgo: 19, description: 'APPLE.COM/BILL 866-712-7753 CA', type: 'Sale', amount: -2.99 },
  { daysAgo: 20, description: 'UNIQLO USA LLC SAN FRANCISCO', type: 'Sale', amount: -89.4 },
  { daysAgo: 21, description: 'UNIQLO USA LLC SAN FRANCISCO', type: 'Return', amount: 29.9 },
  { daysAgo: 22, description: 'TST* NOPA SAN FRANCISCO CA', type: 'Sale', amount: -96.5 },
  { daysAgo: 24, description: 'CLIPPER SYSTEMS AUTOLOAD CA', type: 'Sale', amount: -40.0 },
  { daysAgo: 26, description: 'BLUE BOTTLE COFFEE #70 SAN FRA', type: 'Sale', amount: -8.5 },
  { daysAgo: 28, description: 'COSTCO WHSE #0144 SAN FRANCISC', type: 'Sale', amount: -142.17 },
  { daysAgo: 30, description: 'FITNESS SF - SOMA MEMBERSHIP', type: 'Sale', amount: -85.0 },
  { daysAgo: 33, description: 'STEAMGAMES.COM 4259522985 WA', type: 'Sale', amount: -29.99 },
  { daysAgo: 36, description: 'PGANDE WEB ONLINE CA', type: 'Sale', amount: -112.34 },
  { daysAgo: 38, description: 'PAYMENT THANK YOU - WEB', type: 'Payment', amount: 980.0 },
  { daysAgo: 41, description: 'WALGREENS #1327 SAN FRANCISCO', type: 'Sale', amount: -17.62 },
  { daysAgo: 44, description: 'TICKETMASTER EVENT 800-653-800', type: 'Sale', amount: -128.5 },
];

function mdy(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const SAMPLE_CSV_NAME = 'sample-statement.csv';

export function buildSampleCsv(now = new Date()): string {
  const lines = ['Transaction Date,Post Date,Description,Category,Type,Amount,Memo'];
  for (const r of ROWS) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - r.daysAgo);
    const posted = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    lines.push(
      [mdy(d), mdy(posted), csvCell(r.description), '', r.type, r.amount.toFixed(2), ''].join(','),
    );
  }
  return lines.join('\n') + '\n';
}
