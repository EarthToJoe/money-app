import Anthropic from '@anthropic-ai/sdk';
import type { Account, CardProduct, CreditUsage, PointsBalance, Transaction } from '../types';
import { productById } from '../data/cards';
import { categoryDef } from '../data/categories';
import { programById } from '../data/programs';
import { avgMonthlySpendByCategory } from './analytics';
import { bonusProgressAll } from './bonus';
import { creditsAll } from './credits';
import { balanceRows, totalValueCents } from './loyalty';
import { fmtUsdWhole } from './format';

// ---------------------------------------------------------------------------
// "Ask Finch" — a Claude-powered assistant grounded in the user's wallet.
// The API key lives in the browser (zustand-persisted settings) and requests
// go straight from the browser to Anthropic via the official SDK.

export interface AssistantContextInput {
  accounts: Account[];
  transactions: Transaction[];
  creditUsages: CreditUsage[];
  pointsBalances: PointsBalance[];
}

export const FINCH_SYSTEM_PROMPT = `You are Finch, a credit-card rewards and points advisor embedded in a personal-finance app. The user's wallet snapshot follows in the next system block — treat it as ground truth and answer with specific numbers from it (card names, multipliers, point values, bonus progress, credit amounts, balances, spend averages).

Rules:
- When comparing cash vs points, compute the cents-per-point of the redemption (cash price ÷ points price × 100) and compare it to the planning value per point given in the snapshot. Redeem when the redemption beats the planning value; otherwise pay cash and keep earning.
- If a welcome bonus is in progress, call it out FIRST — bonus-qualifying spend is almost always worth more than any category multiplier.
- Flag unused statement credits that apply to what the user is asking about.
- Prefer concise, structured answers: a short verdict, then the math as bullet points ("- " lines), bold the key numbers with **text**.
- Confident and specific, never apologetic. If the snapshot lacks something, say so plainly and answer with what is there.
- Never ask for card numbers, logins, or any account credentials.
- End every answer with exactly: Not financial advice — verify terms with the issuer.`;

function money(n: number): string {
  return fmtUsdWhole(n);
}

/** '4x dining & drinks (to $50k/yr)' — compact rule summary for one product. */
function rulesSummary(product: CardProduct): string {
  const unit = product.currency === 'cashback' ? '%' : 'x';
  const parts = product.rules.map((r) => {
    const cats =
      r.categories === 'all'
        ? 'everything'
        : r.categories.map((c) => categoryDef(c).label.toLowerCase()).join('/');
    const cap = r.capPerYear !== undefined ? ` (to ${money(r.capPerYear)}/yr)` : '';
    return `${r.multiplier}${unit} ${cats}${cap}`;
  });
  parts.push(`${product.baseMultiplier}${unit} else`);
  return parts.join(', ');
}

/** Plain-text snapshot of the user's wallet, bonus progress, credits, balances and spend profile. */
export function buildWalletContext(input: AssistantContextInput): string {
  const { accounts, transactions, creditUsages, pointsBalances } = input;
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const lines: string[] = [`Wallet snapshot as of ${today}.`];

  // --- Credit cards ---------------------------------------------------------
  const bonusByAccount = new Map(
    bonusProgressAll(accounts, transactions, today).map((b) => [b.account.id, b]),
  );
  const creditStatuses = creditsAll(accounts, creditUsages, transactions, today);

  const cards = accounts.filter((a) => a.type === 'credit');
  lines.push('', `CREDIT CARDS (${cards.length}):`);
  for (const account of cards) {
    const product = account.productId ? productById(account.productId) : undefined;
    if (!product) {
      lines.push(`- ${account.name} (…${account.mask}): unlinked card, owes ${money(account.balance)}`);
      continue;
    }
    const program = product.programId ? programById(product.programId) : undefined;
    const currency = program
      ? `${program.name} @${product.pointValueCents}c/pt`
      : product.currency === 'cashback'
        ? 'cash back'
        : `${product.currency} @${product.pointValueCents}c/pt`;
    lines.push(
      `- ${account.name} (${product.network}, ${product.annualFee > 0 ? `${money(product.annualFee)}/yr fee` : 'no fee'}, earns ${currency}): ${rulesSummary(product)}`,
    );

    const bonus = bonusByAccount.get(account.id);
    if (bonus) {
      if (bonus.status === 'in-progress') {
        lines.push(
          `  Welcome bonus IN PROGRESS: ${bonus.tracking.points.toLocaleString('en-US')} pts (~${money(bonus.valueCents / 100)}) for ${money(bonus.tracking.minSpend)} spend — ${money(bonus.remaining)} to go by ${bonus.tracking.deadline} (${bonus.daysLeft} days).`,
        );
      } else {
        lines.push(`  Welcome bonus: ${bonus.status}.`);
      }
    }

    const credits = creditStatuses.filter((c) => c.account.id === account.id);
    for (const c of credits.slice(0, 5)) {
      lines.push(
        `  Credit: ${c.credit.name} ${money(c.credit.amount)}/${c.credit.period} — ${money(c.remaining)} left in ${c.periodLabel}, resets after ${c.periodEnds}.`,
      );
    }
  }

  // --- Points balances ------------------------------------------------------
  const rows = balanceRows(pointsBalances);
  if (rows.length > 0) {
    lines.push('', 'POINTS & MILES:');
    for (const r of rows) {
      lines.push(
        `- ${r.program.name}: ${r.balance.toLocaleString('en-US')} ${r.program.unit} (~${money(r.valueCents / 100)} at ${r.program.valueCents}c planning value)`,
      );
    }
    lines.push(`- Total planning value: ~${money(totalValueCents(pointsBalances) / 100)}`);
  } else if (pointsBalances.length > 0) {
    lines.push('', 'POINTS & MILES:');
    for (const b of pointsBalances) {
      lines.push(`- ${b.programId}: ${b.balance.toLocaleString('en-US')}`);
    }
  }

  // --- Spend profile --------------------------------------------------------
  const avg = avgMonthlySpendByCategory(transactions, 3);
  const spendRows = [...avg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (spendRows.length > 0) {
    lines.push(
      '',
      'AVG MONTHLY SPEND (last 3 full months): ' +
        spendRows.map(([cat, amt]) => `${categoryDef(cat).label.toLowerCase()} ${money(amt)}`).join(', '),
    );
  }

  // --- Cash -----------------------------------------------------------------
  const cash = accounts.filter((a) => a.type === 'checking' || a.type === 'savings');
  const cashTotal = cash.reduce((s, a) => s + a.balance, 0);
  const owed = cards.reduce((s, a) => s + a.balance, 0);
  if (accounts.length > 0) {
    lines.push(
      '',
      `CASH: ${money(cashTotal)} across ${cash.length} account(s). Credit-card balances owed: ${money(owed)}.`,
    );
  }

  let out = lines.join('\n');
  if (out.length > 2500) out = out.slice(0, 2497) + '…';
  return out;
}

export interface AskOptions {
  apiKey: string;
  question: string;
  context: string;
  /** called with the accumulated text as it streams */
  onText?: (text: string) => void;
  signal?: AbortSignal;
}

/** Ask Claude a question grounded in the wallet context. Resolves with the final answer text. */
export async function askFinch(opts: AskOptions): Promise<string> {
  const { apiKey, question, context, onText, signal } = opts;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  let snapshot = '';
  try {
    const stream = client.beta.messages.stream(
      {
        model: 'claude-opus-5',
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
        // Server-side refusal fallback: if the model declines for policy
        // reasons, the API re-runs the request on a default fallback chain.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [
          { type: 'text', text: FINCH_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: context },
        ],
        messages: [{ role: 'user', content: question }],
      },
      { signal },
    );

    stream.on('text', (_delta, textSnapshot) => {
      snapshot = textSnapshot;
      onText?.(textSnapshot);
    });

    const final = await stream.finalMessage();

    if (final.stop_reason === 'refusal') {
      return 'Finch declined to answer that one. Try rephrasing, or keep the question about your cards, points, and purchases.';
    }

    const text = final.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text || snapshot;
  } catch (err) {
    if (err instanceof Anthropic.APIUserAbortError || signal?.aborted) {
      // Stopped by the user — hand back whatever streamed so far.
      return snapshot;
    }
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error('Anthropic rejected that API key. Double-check it (keys start with "sk-ant-") and save it again.');
    }
    if (err instanceof Anthropic.PermissionDeniedError) {
      throw new Error('This API key is not allowed to use the model. Check your key permissions in the Anthropic console.');
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error('Anthropic rate limit reached. Wait a moment, then ask again.');
    }
    if (err instanceof Anthropic.APIConnectionError) {
      throw new Error('Could not reach Anthropic. Check your internet connection and try again.');
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`Anthropic error${err.status ? ` (${err.status})` : ''}: ${err.message}`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}
