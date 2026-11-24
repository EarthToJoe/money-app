#!/usr/bin/env bash
# Update the running Finch on this server to the latest main and restart it.
#
# Run on the VPS, from the Finch checkout. GitHub Actions runs this over SSH
# after every merge to main (.github/workflows/deploy.yml); you can also run it
# by hand. See docs/deploy.md for the one-time setup.
#
# Your data (server/.finch-data.json), Plaid tokens (server/.plaid-store.json)
# and .env are gitignored, so updating the code never touches them.
set -euo pipefail

cd "$(dirname "$0")/.."

# How to restart Finch. Override with FINCH_RESTART_CMD in the environment if
# your setup differs (for example a pm2 process or a user-level systemd unit).
RESTART_CMD="${FINCH_RESTART_CMD:-sudo systemctl restart finch}"

echo "== Updating code"
git fetch --quiet origin main
git checkout --quiet main
git merge --ff-only --quiet origin/main
echo "   now at $(git log -1 --format='%h %s')"

echo "== Installing dependencies"
npm ci --include=dev --no-audit --no-fund

echo "== Building"
npm run typecheck
npm run build

echo "== Restarting: $RESTART_CMD"
bash -c "$RESTART_CMD"

# Give it a moment, then make sure it actually came back.
PORT="$(grep -E '^PLAID_PORT=' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' || true)"
PORT="${PORT:-8787}"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    echo "== Finch is up on :${PORT}"
    exit 0
  fi
  sleep 1
done
echo "!! Finch did not answer on :${PORT} after restart. Check: journalctl -u finch -n 50" >&2
exit 1
