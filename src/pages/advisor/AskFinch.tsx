import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp } from '../../store';
import { askFinch, buildWalletContext } from '../../lib/assistant';
import { ChipButton, Disclaimer } from './bits';

const EXAMPLE_PROMPTS = [
  "I'm booking 4 nights at a Hyatt in Tokyo for $1,600 — points or cash?",
  'What should I put on my Amex Gold this month?',
  'Is it worth opening a Venture X before my Europe trip?',
];

// ---------------------------------------------------------------------------
// Lightweight renderer for the streamed answer: paragraphs, "- " bullets,
// **bold** spans. Anything fancier stays plain text.

function renderInline(text: string): ReactNode {
  const parts = text.split(/\*\*(.+?)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : p));
}

function AnswerText({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let bullets: string[] = [];
  let key = 0;

  const flush = () => {
    if (bullets.length === 0) return;
    out.push(
      <ul key={`ul-${key++}`} style={{ margin: '6px 0', paddingLeft: 20 }}>
        {bullets.map((b, i) => (
          <li key={i} style={{ marginTop: 2 }}>
            {renderInline(b)}
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('- ') || line.startsWith('* ')) {
      bullets.push(line.slice(2));
      continue;
    }
    flush();
    if (!line) continue;
    if (/^#{1,4}\s/.test(line)) {
      out.push(
        <p key={`h-${key++}`} style={{ margin: '10px 0 4px', fontWeight: 700 }}>
          {renderInline(line.replace(/^#{1,4}\s+/, ''))}
        </p>,
      );
    } else {
      out.push(
        <p key={`p-${key++}`} style={{ margin: '6px 0' }}>
          {renderInline(line)}
        </p>,
      );
    }
  }
  flush();

  return <div style={{ fontSize: 'var(--fs-sm)', lineHeight: 1.6 }}>{out}</div>;
}

// ---------------------------------------------------------------------------

export function AskFinch() {
  const accounts = useApp((s) => s.accounts);
  const transactions = useApp((s) => s.transactions);
  const creditUsages = useApp((s) => s.creditUsages);
  const pointsBalances = useApp((s) => s.pointsBalances);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);

  const [keyDraft, setKeyDraft] = useState('');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const context = useMemo(
    () => buildWalletContext({ accounts, transactions, creditUsages, pointsBalances }),
    [accounts, transactions, creditUsages, pointsBalances],
  );

  const apiKey = settings.anthropicApiKey;

  const ask = async () => {
    const q = question.trim();
    if (!q || !apiKey || streaming) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStreaming(true);
    setAnswer('');
    setError(null);
    try {
      const finalText = await askFinch({
        apiKey,
        question: q,
        context,
        onText: setAnswer,
        signal: ctrl.signal,
      });
      setAnswer(finalText);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  if (!apiKey) {
    return (
      <div className="card">
        <div className="card-title">Ask Finch</div>
        <p className="small" style={{ color: 'var(--ink-2)', maxWidth: 640 }}>
          Paste an Anthropic API key to ask free-form questions grounded in your wallet: bonus
          progress, credits, balances, spend profile. The key stays in this browser; requests go
          straight from your browser to Anthropic.
        </p>
        <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <input
            type="password"
            className="input"
            style={{ flex: '1 1 260px', maxWidth: 380 }}
            placeholder="sk-ant-…"
            value={keyDraft}
            autoComplete="off"
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && keyDraft.trim()) {
                updateSettings({ anthropicApiKey: keyDraft.trim() });
                setKeyDraft('');
              }
            }}
          />
          <button
            className="btn btn-primary"
            disabled={!keyDraft.trim()}
            onClick={() => {
              updateSettings({ anthropicApiKey: keyDraft.trim() });
              setKeyDraft('');
            }}
          >
            Save
          </button>
        </div>
        <Disclaimer />
      </div>
    );
  }

  return (
    <div className="card">
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <div className="card-title" style={{ marginBottom: 0 }}>
          Ask Finch
        </div>
        <button
          className="btn btn-ghost small"
          onClick={() => {
            updateSettings({ anthropicApiKey: undefined });
            setAnswer('');
            setError(null);
          }}
        >
          Change key
        </button>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', marginTop: 10 }}>
        {EXAMPLE_PROMPTS.map((p) => (
          <ChipButton key={p} onClick={() => setQuestion(p)} title={p}>
            {p.length > 52 ? `${p.slice(0, 50)}…` : p}
          </ChipButton>
        ))}
      </div>

      <textarea
        className="input"
        rows={3}
        style={{ width: '100%', marginTop: 10, resize: 'vertical' }}
        placeholder="Ask anything about your cards, points, and purchases…"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void ask();
          }
        }}
      />

      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn btn-primary" disabled={streaming || !question.trim()} onClick={() => void ask()}>
          {streaming ? 'Thinking…' : 'Ask'}
        </button>
        {streaming && (
          <button className="btn" onClick={stop}>
            Stop
          </button>
        )}
      </div>

      {error && (
        <p className="small" style={{ color: 'var(--critical)', marginTop: 10 }}>
          {error}
        </p>
      )}

      {answer && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--grid)', paddingTop: 10 }}>
          <AnswerText text={answer} />
        </div>
      )}

      <details style={{ marginTop: 14 }}>
        <summary className="small muted" style={{ cursor: 'pointer' }}>
          What Finch knows
        </summary>
        <pre
          className="small"
          style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'var(--surface-2)',
            borderRadius: 10,
            padding: '10px 12px',
            marginTop: 8,
            fontFamily: 'inherit',
          }}
        >
          {context}
        </pre>
      </details>

      <Disclaimer />
    </div>
  );
}
