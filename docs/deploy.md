# Deploying Finch (finch.hughesnode.com)

Once this is set up, every change merged to `main` goes live on its own:
GitHub checks that it builds, then logs into the VPS and runs
`scripts/deploy.sh`, which pulls the new code, rebuilds, and restarts Finch.
Your data, Plaid tokens and `.env` stay on the server and are never touched.

This is a one-time setup on the VPS and in GitHub. It assumes Finch's checkout
lives at `/home/finch/money-app`, owned by a user called `finch`; use your own
path and user everywhere below.

## 1. Finch on the VPS

```bash
git clone https://github.com/EarthToJoe/money-app.git /home/finch/money-app
cd /home/finch/money-app
cp .env.example .env    # or keep the .env you already have there
```

In `.env`, add:

```bash
FINCH_PASSWORD=four-random-words-here   # what you type to sign in on your phone
FINCH_HOST=127.0.0.1                     # only reachable through the web server
PLAID_PORT=8787
```

Then build it once by hand:

```bash
npm ci && npm run build
```

## 2. Keep it running (systemd)

```bash
sudo cp deploy/finch.service /etc/systemd/system/finch.service
sudo nano /etc/systemd/system/finch.service   # fix User= and WorkingDirectory=
sudo systemctl daemon-reload
sudo systemctl enable --now finch
curl http://127.0.0.1:8787/api/health         # {"ok":true}
```

Let the deploy restart it without a password prompt:

```bash
echo 'finch ALL=(root) NOPASSWD: /usr/bin/systemctl restart finch' | sudo tee /etc/sudoers.d/finch
```

If Finch is already run some other way (pm2, a screen session, the dev
server), stop that first. Then either switch to the unit above, or set
`FINCH_RESTART_CMD` for the deploy (for example `pm2 restart finch`).

## 3. Point finch.hughesnode.com at it

The web server that already answers for finch.hughesnode.com needs to forward
everything to `127.0.0.1:8787`.

Caddy:

```
finch.hughesnode.com {
    reverse_proxy 127.0.0.1:8787
}
```

nginx (inside the existing `server { ... }` block for finch.hughesnode.com):

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 25m;
}
```

`X-Forwarded-Proto` is what lets Finch mark the sign-in cookie secure. Caddy
sends it by default.

## 4. Let GitHub deploy

On the VPS, as the `finch` user, make a key just for deploys:

```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/finch_deploy -C finch-deploy
cat ~/.ssh/finch_deploy.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/finch_deploy       # copy this whole private key
```

In GitHub, under **money-app → Settings → Secrets and variables → Actions**,
add four repository secrets:

| Secret | Value |
|---|---|
| `VPS_HOST` | the VPS address |
| `VPS_USER` | `finch` |
| `VPS_SSH_KEY` | the private key you just copied |
| `VPS_APP_DIR` | `/home/finch/money-app` |

Then go to **Actions → Deploy → Run workflow** to try it. Until `VPS_HOST`
is set, the workflow only checks the build and skips the deploy.

## 5. Put it on your phone

1. Open https://finch.hughesnode.com in Safari and sign in with `FINCH_PASSWORD`.
2. Tap Share, then **Add to Home Screen**.

The first device that signs in uploads its data. Sign in on your Mac first so
your real data becomes the shared copy. It would win over the phone's demo data
anyway, but this order is the simplest.

## Deploying by hand

```bash
cd /home/finch/money-app && ./scripts/deploy.sh
```
