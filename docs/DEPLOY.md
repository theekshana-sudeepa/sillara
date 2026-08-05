# Sillara — Deploy Guide (P2 build)

Three deployables. Do them in this order — the API must exist before the
frontends can talk to it.

```
api.sillara.com   → VPS (Nginx → PM2 → Node 22 → MySQL on 127.0.0.1)
app.sillara.com   → Vercel  (pos/)        — the POS + public receipt pages
sillara.com       → Vercel  (marketing/)  — the storefront
```

---

## 1. API on a VPS

```
apt update && apt install -y nginx mysql-server git certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
npm i -g pm2

mysql -e "CREATE DATABASE sillara CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'sillara'@'localhost' IDENTIFIED BY 'STRONG_PASSWORD';
GRANT ALL ON sillara.* TO 'sillara'@'localhost'; FLUSH PRIVILEGES;"

cd /srv && git clone <your-repo> sillara && cd sillara/server
cp .env.example .env && nano .env          # values below
npm ci && npx prisma generate && npx prisma migrate deploy && npm run seed
npm run build
mkdir -p logs && pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

Production `.env`:

```
NODE_ENV=production
APP_URL=https://app.sillara.com
SITE_URL=https://sillara.com
API_URL=https://api.sillara.com
CORS_ORIGINS=https://app.sillara.com,https://sillara.com
DATABASE_URL="mysql://sillara:STRONG_PASSWORD@127.0.0.1:3306/sillara?connection_limit=15"
JWT_SECRET=<openssl rand -hex 32>
MAGIC_LINK_SECRET=<openssl rand -hex 32>
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_...
ANTHROPIC_API_KEY=sk-ant-...        # 📸 Shelfie (catalog + invoice modes)
SHELFIE_MODEL=claude-opus-5
PADDLE_ENV=production
PAYHERE_ENV=production
RUN_JOBS=true                       # billing lifecycle, digests, outbox, cleanup
```

### Background jobs in production

Leave `RUN_JOBS=true` on every instance. Each job claims a row in `job_runs`
(`UNIQUE(jobName, runKey)`) before doing anything, so N instances firing the
same cron produce exactly one execution. There is deliberately no separate
worker deployable — a second service would double the ops surface of a
one-box business for four small jobs, and moving them out later is a config
change, not a rewrite.

What to watch:

```sql
-- Anything failing?
SELECT jobName, runKey, status, error FROM job_runs
 WHERE status = 'FAILED' AND startedAt > NOW() - INTERVAL 3 DAY;

-- Mail that gave up after five attempts (bad address, provider rejection)
SELECT template, `to`, lastError FROM email_messages WHERE status = 'FAILED';

-- Shops the lifecycle sweep is about to act on
SELECT name, status, currentPeriodEnd, graceUntil, creditMonths
  FROM organizations WHERE planCode <> 'FREE' AND status IN ('TRIAL','PAST_DUE');
```

If the sweep has been down for days, just run it — it is idempotent and
catches up from wherever it left off:

```bash
cd /srv/sillara/server && npm run job -- lifecycle --force
```

Nginx (`/etc/nginx/sites-available/sillara-api`, then `certbot --nginx -d api.sillara.com`):

```nginx
server {
  server_name api.sillara.com;
  client_max_body_size 25m;        # Shelfie photo batches (4 × ~1568px JPEG)

  location / {
    proxy_pass http://127.0.0.1:4100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;       # Shelfie vision calls run 10–30s
    proxy_buffering off;
  }
}
```

Backups — the sales ledger is the business:

```
mkdir -p /root/backups
crontab -e
0 2 * * * mysqldump --single-transaction --routines sillara | gzip > /root/backups/sillara-$(date +\%F).sql.gz
0 4 * * 0 find /root/backups -name '*.sql.gz' -mtime +30 -delete
```

---

## 2. POS on Vercel (`app.sillara.com`)

Project settings: **Root Directory** `pos`. `pos/vercel.json` already sets the
build, the SPA rewrite, immutable asset caching, a no-cache rule for `sw.js`
(otherwise a stale worker pins an old build), and `camera=(self)` in
Permissions-Policy — required for Shelfie's `capture="environment"` input.

Environment variable:

```
VITE_API_URL = https://api.sillara.com
```

Public receipt links (`app.sillara.com/r/<id>`) work automatically — the route
is outside the auth gate, and the service worker deliberately skips `/r/`
so a customer never gets another shop's cached shell.

## 3. Marketing on Vercel (`sillara.com`)

**Root Directory** `marketing`, no build step. `marketing/vercel.json` sets
CDN caching (`s-maxage=3600`, stale-while-revalidate) and security headers.
The page auto-detects `localhost` vs production for API/APP URLs — no env vars.

---

## 4. Play Store (TWA) — after the PWA is live

```
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://app.sillara.com/manifest.webmanifest
# pos/twa-manifest.json is pre-filled (package com.sillara.pos, /sell start URL,
# Sell + Receive shortcuts) — copy it into the bubblewrap project
bubblewrap build          # → app-release-bundle.aab
```

Then: upload the `.aab` to Play Console → enable **Play App Signing** → copy the
**SHA-256 certificate fingerprint** Play gives you → paste it into
`pos/public/.well-known/assetlinks.json`, replacing the placeholder → redeploy
the POS. Without that fingerprint the app opens with a browser address bar
instead of full-screen.

You'll also need 512×512 `icon-512.png` and `icon-512-maskable.png` in
`pos/public/` before building.

---

## Verify after deploy

- [ ] `curl https://api.sillara.com/health` → `{"ok":true,...}`
- [ ] Sign up a test shop at `app.sillara.com/signup` → lands in the wizard
- [ ] 📸 Shelfie a price list → products appear in review → saved
- [ ] Sell something → WhatsApp the receipt → **open the link on another phone**
- [ ] 📥 Receive goods: photograph an invoice → lines match existing products → stock rises
- [ ] Airplane mode → sell → reconnect → outbox counter clears
- [ ] Install prompt appears in Chrome on Windows/Mac
- [ ] `pm2 logs sillara-api` clean; backup cron in `crontab -l`
