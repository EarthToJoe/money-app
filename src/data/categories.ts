import type { CategoryDef, CategoryId } from '../types';

// Category colors come from the validated chart palette (see src/styles/tokens.css).
// Charts should show at most the top ~6 categories and fold the rest into
// "Other" — never put all 14 on one chart.
export const CATEGORIES: CategoryDef[] = [
  { id: 'groceries', label: 'Groceries', emoji: '🛒', color: '#1baf7a' },
  { id: 'dining', label: 'Dining & drinks', emoji: '🍜', color: '#eb6834' },
  { id: 'transport', label: 'Transport', emoji: '🚕', color: '#2a78d6' },
  { id: 'travel', label: 'Travel', emoji: '✈️', color: '#4a3aa7' },
  { id: 'shopping', label: 'Shopping', emoji: '🛍️', color: '#e87ba4' },
  { id: 'entertainment', label: 'Entertainment', emoji: '🎬', color: '#eda100' },
  { id: 'subscriptions', label: 'Subscriptions', emoji: '🔁', color: '#e34948' },
  { id: 'utilities', label: 'Utilities', emoji: '💡', color: '#008300' },
  { id: 'housing', label: 'Housing', emoji: '🏠', color: '#184f95' },
  { id: 'health', label: 'Health', emoji: '🩺', color: '#199e70' },
  { id: 'fees', label: 'Fees & interest', emoji: '🧾', color: '#898781' },
  { id: 'income', label: 'Income', emoji: '💵', color: '#0ca30c' },
  { id: 'transfer', label: 'Transfers', emoji: '🔄', color: '#c3c2b7' },
  { id: 'other', label: 'Other', emoji: '📦', color: '#b7b5ad' },
];

const byId = new Map(CATEGORIES.map((c) => [c.id, c]));

export function categoryDef(id: CategoryId): CategoryDef {
  return byId.get(id) ?? byId.get('other')!;
}

// Categories that count as spending (excluded: money movement and money in).
export const SPENDING_CATEGORY_IDS: CategoryId[] = CATEGORIES.filter(
  (c) => c.id !== 'income' && c.id !== 'transfer',
).map((c) => c.id);

// Categories a credit card can plausibly earn rewards on (used by the
// rewards engine and the card recommender).
export const REWARDABLE_CATEGORY_IDS: CategoryId[] = SPENDING_CATEGORY_IDS.filter(
  (id) => id !== 'fees' && id !== 'housing',
);
