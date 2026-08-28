import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
// Plain .js, deliberately: the same module is imported by server/index.js, which
// runs on bare Node with no build step. Vite bundles this config with esbuild,
// so importing it here is free.
import { makeGate, readTunnelPassword } from './server/tunnel-auth.js';

// The Plaid backend holds the secret and the access tokens; the browser only
// ever talks to it through this proxy, never to Plaid directly.
const API_PORT = process.env.PLAID_PORT ?? '8787';

// `npm run tunnel` fronts this dev server with a cloudflared quick tunnel so
// Plaid's OAuth banks have an https redirect URI to send the browser back to.
// Set TUNNEL=1 on the dev process when you're working through that tunnel.
const THROUGH_TUNNEL = process.env.TUNNEL === '1';

// Read once, at config load. envDir below points away from the project's .env,
// so readTunnelPassword() parses that file itself rather than going through
// import.meta.env — see server/tunnel-auth.js. Changing FINCH_TUNNEL_PASSWORD
// (in .env or the environment) therefore needs a dev-server restart to take
// effect; `npm run tunnel` sets it before starting anything, so that is the
// normal order anyway. Empty string = no tunnel in use = gate disabled.
const TUNNEL_PASSWORD = readTunnelPassword();

/**
 * Ask anyone who is not this machine for the tunnel password — before Vite gets
 * to answer anything.
 *
 * The dev server is what `npm run tunnel` exposes to the public internet, and
 * the whole app hangs off it: the HTML, the module graph, and the /api proxy to
 * the Plaid backend. So the gate goes in front of all three.
 *
 * Covering the HTML is the load-bearing part. fetch() cannot raise a native
 * credential prompt, so gating only /api would leave the browser silently
 * un-challenged and the app would break instead of asking. Challenge the
 * top-level navigation and the browser prompts once, then attaches the
 * Authorization header to every same-origin request that follows, /api
 * included.
 *
 * With no password set this installs a middleware that calls next() and nothing
 * else, so `http://localhost:5173` development is exactly as it was.
 */
function tunnelAuth(): Plugin {
  const gate = makeGate({ password: TUNNEL_PASSWORD, realm: 'Finch' });

  return {
    name: 'finch:tunnel-auth',
    // Dev/preview only. Nothing about this ships in a build.
    apply: 'serve',
    // Middleware added straight from configureServer runs *before* Vite's own
    // internal middlewares (transform, static files, the /api proxy), which is
    // exactly where a gate has to sit; `enforce: 'pre'` puts it ahead of other
    // plugins' middleware too.
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use(gate);
    },
    configurePreviewServer(server) {
      server.middlewares.use(gate);
    },
  };
}

export default defineConfig({
  plugins: [tunnelAuth(), react()],
  // The browser bundle reads no environment variables — every secret lives in
  // the backend. Pointing envDir at a directory with no .env keeps Vite from
  // watching the project's .env, which the in-app Plaid setup form writes to:
  // a restart there would kill the very request that saved the credentials.
  envDir: 'src',
  server: {
    port: 5173,
    // Requests arriving through the tunnel carry a Host header Vite has never
    // heard of (xyz.trycloudflare.com) and it answers "Blocked request" unless
    // the host is allow-listed. The name changes on every quick tunnel, so
    // there is nothing stable to list — allow any host. Dev server only: this
    // has no effect on `vite build` or on anything you deploy. Safe to keep
    // open now that tunnelAuth() stands in front of it.
    allowedHosts: true,
    // HMR's websocket client derives its port from the page. Through the
    // tunnel the page is https on 443 while Vite still thinks it is serving
    // 5173, so the socket dials the wrong port and hot reload dies. Pointing
    // the client at 443 fixes it — but only under TUNNEL=1, because that same
    // override would break plain http://localhost:5173 development.
    ...(THROUGH_TUNNEL ? { hmr: { clientPort: 443 } } : {}),
    watch: {
      ignored: ['**/.env', '**/.env.*', '**/server/.plaid-store.json'],
    },
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
