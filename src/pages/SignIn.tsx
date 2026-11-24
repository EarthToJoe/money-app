import { useState } from 'react';
import { signIn } from '../lib/cloudSync';

/**
 * Shown instead of the app when Finch runs on a server that needs a password
 * (FINCH_PASSWORD) and this device hasn't signed in yet. Signing in lasts a
 * year on this device.
 */
export default function SignIn() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const problem = await signIn(password);
    setBusy(false);
    if (problem) setError(problem);
  }

  return (
    <div className="signin">
      <form className="card signin-card" onSubmit={submit}>
        <div className="brand signin-brand">
          <div className="brand-logo">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M2 9.5C2 5.9 4.9 3 8.5 3H14v2.2H8.5c-2.4 0-4.3 1.9-4.3 4.3V13H2V9.5z" />
              <circle cx="11.2" cy="9.8" r="2.6" />
            </svg>
          </div>
          Finch
        </div>
        <label className="signin-label" htmlFor="finch-password">
          Password
        </label>
        <input
          id="finch-password"
          className="signin-input"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="signin-error">{error}</div>}
        <button className="btn btn-primary signin-submit" type="submit" disabled={busy || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="signin-note">This device stays signed in for a year.</p>
      </form>
    </div>
  );
}
