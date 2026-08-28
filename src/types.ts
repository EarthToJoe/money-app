// Core data model for Finch. Every feature module builds against these types.

// Type-only import: erased at compile time, so there is no runtime cycle with
// src/data/merchants.ts (which imports CategoryId from this file the same way).
import type { MerchantKind } from './data/merchants';

export type AccountType = 'checking' | 'savings' | 'credit';

export interface Account {
  id: string;
  name: string; // "Chase Sapphire Preferred"
  institution: string; // "Chase"
  type: AccountType;
  mask: string; // last 4 digits, e.g. "4821"
  balance: number; // dollars; for credit cards this is the current amount owed
  creditLimit?: number; // credit cards only
  productId?: string; // links a credit card account to a CardProduct in src/data/cards.ts
  createdAt: string; // ISO date
  /** Date the card was opened ('YYYY-MM-DD'). Drives welcome-bonus tracking and anniversary credits. */
  openedAt?: string;
  /** Welcome-bonus tracking for this specific card (defaults come from the product's signupBonus). */
  bonus?: BonusTracking;
  /**
   * What this cardholder actually pays per year, when it differs from the
   * product's published fee — e.g. an SCRA military waiver ($0), a retention
   * offer, or a first-year-free promo. Overrides Settings.waiveAnnualFees.
   */
  annualFeeOverride?: number;
}

export interface BonusTracking {
  points: number; // bonus points/miles (or cents for cashback cards)
  minSpend: number; // dollars required
  startDate: string; // 'YYYY-MM-DD' — usually openedAt
  deadline: string; // 'YYYY-MM-DD' — startDate + bonus window
  /** User override: mark the bonus as already earned/posted, or explicitly not pursuing. */
  status?: 'earned' | 'abandoned';
}

export type CategoryId =
  | 'groceries'
  | 'dining'
  | 'transport'
  | 'travel'
  | 'shopping'
  | 'entertainment'
  | 'subscriptions'
  | 'utilities'
  | 'housing'
  | 'health'
  | 'fees'
  | 'income'
  | 'transfer'
  | 'other';

export interface CategoryDef {
  id: CategoryId;
  label: string;
  emoji: string;
  color: string; // hex, from the validated chart palette
}

export interface Transaction {
  id: string;
  accountId: string;
  date: string; // 'YYYY-MM-DD'
  merchant: string; // normalized display name, e.g. "Trader Joe's"
  rawDescription: string; // original statement text, e.g. "TRADER JOE'S #552 SAN FR"
  amount: number; // dollars; positive = money out (spending), negative = money in
  category: CategoryId;
  pending?: boolean;
  source: 'demo' | 'csv' | 'manual' | 'plaid'; // 'plaid' = pulled from a linked bank
}

export interface Budget {
  categoryId: CategoryId;
  monthlyLimit: number; // dollars
}

// ---------------------------------------------------------------------------
// Credit card rewards model.
//
// Unified earning math across cash back / points / miles:
//   points earned = spend dollars x multiplier
//   value in cents = points x pointValueCents
// Cash-back cards use pointValueCents = 1, so a 2% card is multiplier 2.

export type RewardCurrency = 'cashback' | 'points' | 'miles';

/**
 * One elevated earning rate on a card.
 *
 * MERCHANT SCOPING — how a rule is matched (src/lib/rewards.ts owns the code):
 *   1. The category must match: `categories === 'all'` or it includes the
 *      purchase's CategoryId. First matching rule in `rules` wins.
 *   2. A rule that declares NONE of merchantIds / programIds / merchantKinds /
 *      merchantPattern applies to that WHOLE category — the original behaviour,
 *      and still correct for rates that really are category-wide (Amex Gold 4x
 *      dining, Sapphire Preferred 2x travel).
 *   3. A rule that declares any of them is SCOPED, and applies only when the
 *      purchase satisfies AT LEAST ONE of the declared fields (they are OR'd):
 *      "6x at Marriott OR 3x on flights booked direct" is two rules, but
 *      "3x on Delta purchases or hotels booked direct" is one rule with both
 *      programIds and merchantKinds set.
 *   4. With no merchant context at all (annualised category spend, a bare
 *      category picker), a scoped rule CANNOT match — the engine falls through
 *      to the next rule and ultimately to baseMultiplier. Guessing the brand
 *      rate is what made Finch tell a Hyatt guest their Hilton card earns 14x,
 *      so the conservative rate is the correct default.
 */
export interface RewardRule {
  categories: CategoryId[] | 'all';
  multiplier: number; // points per dollar (or % for cashback)
  capPerYear?: number; // annual spend cap in dollars for this elevated rate, if any
  note?: string; // e.g. "on up to $6,000/yr, then 1x"

  // --- optional merchant scoping (all additive; omit for a category-wide rate)
  /** Exact MerchantEntry ids from src/data/merchants.ts, e.g. ['amex-travel', 'chase-travel']. */
  merchantIds?: string[];
  /** Case-insensitive regex SOURCE matched against the merchant's name + aliases and the transaction's merchant + rawDescription. */
  merchantPattern?: string;
  /** MerchantEntry.kind values — ['airline'] is "flights booked direct", ['hotel'] is "hotels booked direct". */
  merchantKinds?: MerchantKind[];
  /** MerchantEntry.programId values — ['hilton'] covers every Hilton flag (Conrad, Hampton, DoubleTree...). */
  programIds?: string[];
}

export interface SignupBonus {
  points: number;
  minSpend: number; // dollars
  months: number;
}

export interface CardProduct {
  id: string; // kebab-case, e.g. 'chase-sapphire-preferred'
  name: string;
  issuer: string;
  network: 'visa' | 'mastercard' | 'amex' | 'discover';
  annualFee: number;
  currency: RewardCurrency;
  pointValueCents: number; // value of one point/mile in cents (cashback = 1)
  baseMultiplier: number; // earn rate on unlisted categories, usually 1
  rules: RewardRule[]; // elevated-rate rules; first matching rule wins
  signupBonus?: SignupBonus;
  gradient: [string, string]; // card-art gradient colors
  highlights: string[]; // 2-4 short selling points for the UI
  /** Loyalty program the card's points land in (src/data/programs.ts), e.g. 'chase-ur'. Cashback cards omit this. */
  programId?: string;
  /** Statement credits / perks the card carries (Uber Cash, hotel credit, airline fee credit...). */
  credits?: CardCredit[];
}

// ---------------------------------------------------------------------------
// Card credits (statement credits & perks that reset on a schedule).

export type CreditPeriod =
  | 'monthly' // calendar month
  | 'quarterly' // calendar quarter
  | 'semiannual' // Jan–Jun / Jul–Dec
  | 'annual' // calendar year
  | 'anniversary'; // cardmember year, from Account.openedAt (falls back to calendar year)

export interface CardCredit {
  id: string; // unique within the product, e.g. 'uber-cash'
  name: string; // 'Uber Cash'
  amount: number; // dollars per period
  period: CreditPeriod;
  /** What kind of spend it offsets — used to surface "most useful" credits. */
  category?: CategoryId;
  /** Regex source (case-insensitive) matched against merchant + rawDescription to auto-detect usage from transactions. */
  matchPattern?: string;
  /** One line on how to actually use it. */
  how: string;
  enrollmentRequired?: boolean;
}

/** Tracked usage of a credit within one period (manual entry or confirmed auto-detection). */
export interface CreditUsage {
  accountId: string;
  creditId: string;
  periodKey: string; // e.g. '2026-08', '2026-Q3', '2026-H2', '2026', 'A2026-03-10'
  used: number; // dollars used in the period
}

// ---------------------------------------------------------------------------
// Loyalty programs & points balances.

export type ProgramKind = 'bank' | 'airline' | 'hotel';

export interface LoyaltyProgram {
  id: string; // 'chase-ur', 'amex-mr', 'united', 'hyatt'
  name: string; // 'Chase Ultimate Rewards'
  short: string; // 'UR', 'MileagePlus'
  kind: ProgramKind;
  unit: 'points' | 'miles';
  valueCents: number; // planning value per point/mile
  alliance?: 'star' | 'oneworld' | 'skyteam';
  color: string; // brand-ish hex for dots/avatars
  note?: string;
}

export interface TransferPartner {
  from: string; // bank program id
  to: string; // airline/hotel program id
  ratio: number; // points received per point sent (1 = 1:1, 2 = 1:2, 0.8 = 1:0.8)
  note?: string;
}

export interface PointsBalance {
  programId: string;
  balance: number;
  updatedAt: string; // 'YYYY-MM-DD'
  note?: string;
}

// ---------------------------------------------------------------------------
// Settings

export interface Settings {
  /** Anthropic API key for the optional "Ask Finch" assistant. Stored locally only. */
  anthropicApiKey?: string;
  /**
   * Treat every card's annual fee as $0 — true for active-duty military under
   * the SCRA, where Amex and Chase waive fees outright. Changes what a premium
   * card is worth holding and what a new one is worth opening, so it feeds both
   * the per-card value view and the card recommendations.
   */
  waiveAnnualFees?: boolean;
}

// The three demo credit-card accounts link to these product ids; they MUST
// exist in src/data/cards.ts.
export const DEMO_CARD_PRODUCT_IDS = [
  'chase-sapphire-preferred',
  'citi-double-cash',
  'amex-gold',
] as const;
