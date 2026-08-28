#!/usr/bin/env node
// Finch: put a public HTTPS URL — with a password on it — in front of the dev server.
//
// Plaid only allows an http://localhost redirect URI in Sandbox. Every other
// environment demands https, and the big OAuth banks (Chase, Capital One, BofA,
// Schwab, PNC, US Bank) bounce the browser back to that redirect URI after the
// login. So to link a real bank from a laptop you need a public https address
// that terminates on http://localhost:5173 — that's what this does.
//
// A public address in front of a dev server holding real bank data needs a
// lock on it. server/tunnel-auth.js puts HTTP Basic auth on every request that
// doesn't come from this machine — the app's HTML included, so the browser
// prompts once and then sends the header on every /api call by itself. This
// script owns the password's life cycle: read it, or mint one and refuse to
// open the tunnel until the dev server has had a chance to load it.
//
// Run: npm run tunnel   (alongside `npm run dev` in another terminal)
// It shells out to cloudflared and reads its output; the only imports are two
// of the project's own modules — no new dependencies.
import { spawn, spawnSync } from 'node:child_process';
import { ENV_PATH, upsertEnvValues } from '../server/env-file.js';
import { generatePassword, readTunnelPassword } from '../server/tunnel-auth.js';

// Note what is deliberately NOT here: dotenv. readTunnelPassword() parses .env
// itself, so this process never loads PLAID_SECRET into its environment — and
// spawn() below hands its environment to cloudflared, which has no business
// holding a Plaid secret.

const PORT = process.env.WEB_PORT || '5173';
const LOCAL_URL = `http://localhost:${PORT}`;
const DOWNLOADS =
  'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

// cloudflared prints the assigned hostname inside its own banner. Quick-tunnel
// names are lowercase words joined by hyphens, e.g. https://x-y-z.trycloudflare.com
const TUNNEL_URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

/** Draw a box around some lines. Empty strings become blank rows. */
function box(lines) {
  const width = Math.max(...lines.map((l) => [...l].length));
  const bar = '─'.repeat(width + 2);
  const body = lines.map((l) => `│ ${l}${' '.repeat(width - [...l].length)} │`);
  return ['', `┌${bar}┐`, ...body, `└${bar}┘`, ''].join('\n');
}

function missingCloudflared() {
  console.error(
    box([
      'cloudflared is not installed.',
      '',
      'It is the tunnel client this script drives. On macOS:',
      '',
      '    brew install cloudflared',
      '',
      'Other platforms / direct downloads:',
      `    ${DOWNLOADS}`,
      '',
      'Then run `npm run tunnel` again.',
    ]),
  );
  console.error('Not installing it for you — that is your call to make.\n');
  process.exit(1);
}

// ---------------------------------------------------------------- preflight
const probe = spawnSync('cloudflared', ['--version'], { encoding: 'utf8' });
if (probe.error) {
  if (probe.error.code === 'ENOENT') missingCloudflared();
  console.error(`Could not run cloudflared: ${probe.error.message}`);
  process.exit(1);
}
if (probe.status !== 0) {
  console.error(`cloudflared --version exited with ${probe.status}. Is the install healthy?`);
  const detail = `${probe.stderr || ''}${probe.stdout || ''}`.trim();
  if (detail) console.error(detail.split('\n')[0]);
  process.exit(1);
}
console.log(`Using ${(probe.stdout || '').trim().split('\n')[0] || 'cloudflared'}`);

// Not fatal — cloudflared happily starts before the dev server does — but the
// first page load through the tunnel will 502 if nothing is listening yet. It
// also tells the password step below whether to say "restart" or "start".
const reachable = await (async () => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1500);
  try {
    await fetch(LOCAL_URL, { signal: ac.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
})();

// ------------------------------------------------------------------ password
//
// Can this script check whether the *running* dev server is enforcing the gate?
// Only by guessing at how the gate makes up its mind, which is not the same
// thing. Every request this process can make arrives from 127.0.0.1, and a 200
// on http://localhost:5173 is exactly what a correctly gated server gives a
// local caller. Faking the markers a tunnel adds — x-forwarded-for and friends
// — would test today's internals of isLocalRequest() rather than any contract,
// and a wrong answer there refuses a tunnel that was perfectly safe.
// server/tunnel-auth.js exports no status probe, and inventing an endpoint that
// claims "the gate is up" only adds something else that can be wrong.
//
// So the decision rests on the one fact known for certain here: if this run had
// to create the password, the dev server started before that password existed,
// read an empty value at boot, and its gate is inert. That case is worth
// refusing on, and it is precisely the case this script can detect.
//
// The other stale case — password changed by hand since the server booted —
// surfaces as a prompt the browser won't accept. SETUP-PLAID.md's
// troubleshooting table answers that one: restart `npm run dev`.

/** The password every request from off this machine has to present. */
const PASSWORD = await (async () => {
  // readTunnelPassword() and generatePassword() are synchronous today; awaiting
  // a plain string is a no-op, so this keeps working if they ever aren't.
  const existing = String((await readTunnelPassword()) ?? '').trim();
  if (existing) return existing;

  try {
    // Never echoed here. The box on the next run is where you read it, and one
    // copy in the scrollback is enough.
    const created = String(await generatePassword());
    await upsertEnvValues(ENV_PATH, { FINCH_TUNNEL_PASSWORD: created });
  } catch (err) {
    console.error(`\nCould not save a tunnel password to ${ENV_PATH}:`);
    console.error(`  ${err.message}`);
    console.error('Fix that, or set FINCH_TUNNEL_PASSWORD yourself, then run `npm run tunnel` again.\n');
    process.exit(1);
  }

  console.error(
    box([
      'Made a tunnel password and saved it to .env.',
      '',
      'Not opening the tunnel this time — on purpose. The dev server read',
      'its password at startup, which was before this one existed, so its',
      'lock is currently inert: anyone who learned the tunnel URL could',
      'read your accounts and transactions. Finch will not put your bank',
      'data on the public internet behind a gate it knows is switched off.',
      '',
      'Two steps and you are through:',
      reachable
        ? '  1. Restart the app: Ctrl-C `npm run dev`, then start it again'
        : '  1. Start the app: `npm run dev` (it is not running right now)',
      '  2. Run `npm run tunnel` again — it will print the URL and the',
      '     password together',
      '',
      'The password is in .env as FINCH_TUNNEL_PASSWORD. At the browser',
      'prompt any username works; only the password is checked.',
    ]),
  );
  process.exit(1);
})();

if (!reachable) {
  console.log(`Heads up: nothing is answering on ${LOCAL_URL} yet. Start it with \`npm run dev\`.`);
}
console.log(`Opening a quick tunnel to ${LOCAL_URL} …\n`);

// ------------------------------------------------------------------- tunnel
const child = spawn('cloudflared', ['tunnel', '--url', LOCAL_URL], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.on('error', (err) => {
  if (err.code === 'ENOENT') missingCloudflared();
  console.error(`cloudflared failed to start: ${err.message}`);
  process.exit(1);
});

let announced = false;
/** Scan streamed output for the assigned hostname, keeping partial lines. */
function makeScanner() {
  let carry = '';
  return (chunk) => {
    if (announced) return;
    const text = carry + chunk;
    const match = text.match(TUNNEL_URL_RE);
    if (match) {
      announced = true;
      announce(match[0]);
      carry = '';
      return;
    }
    // Keep the tail in case a URL straddles two chunks.
    carry = text.slice(-256);
  };
}

function announce(url) {
  const redirect = `${url}/oauth`;
  process.stdout.write(
    box([
      `Tunnel is live:  ${url}`,
      `Password:        ${PASSWORD}      (any username works)`,
      `Your OAuth redirect URL:  ${redirect}`,
      '',
      'Next:',
      '  1. Register that redirect URL in Plaid:',
      '     Developers → API → Allowed redirect URIs → Configure',
      `  2. Open ${url} and sign in with the password above`,
      '  3. Accounts → Connect bank → Change keys → paste the redirect URL',
      '',
      'Anyone with this URL AND the password can read your account data.',
      'Ctrl-C shuts the tunnel down — do that as soon as your banks are linked.',
    ]),
  );
  console.log('Tip: for hot reload through the tunnel, run the app as `TUNNEL=1 npm run dev`.');
  console.log(
    'Quick tunnels hand out a NEW URL every run, so restarting this means re-registering the redirect URL.',
  );
  console.log('Full walkthrough: SETUP-PLAID.md → "Connecting real banks (production)".\n');
}

// cloudflared logs to stderr; scan both streams and pass everything through.
const scanOut = makeScanner();
const scanErr = makeScanner();
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  scanOut(chunk);
});
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
  scanErr(chunk);
});

// ------------------------------------------------------------------ signals
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nShutting the tunnel down (${signal}) …`);
    child.kill(signal);
    // If cloudflared ignores the polite ask, insist.
    setTimeout(() => child.kill('SIGKILL'), 5000).unref();
  });
}

child.on('exit', (code, signal) => {
  if (shuttingDown) {
    console.log(`Tunnel closed. Finch is local-only again — ${LOCAL_URL}, no password asked for.`);
  } else if (announced) {
    console.error(
      `\ncloudflared exited on its own. The tunnel is closed and Finch is local-only again — ${LOCAL_URL}.`,
    );
  } else {
    console.error('\ncloudflared exited before a tunnel URL appeared. See its output above.');
  }
  // Set the code rather than calling process.exit(): nothing is holding the
  // loop open, and exiting outright can truncate the lines above when stdout
  // is a pipe rather than a terminal.
  process.exitCode = signal ? 0 : (code ?? 0);
});
