# Sillara — Local & Production Setup (zero-lag edition)

## Part 1 — Local (15 minutes)

```bash
# Database (MySQL 8 running)
mysql -u root -e "CREATE DATABASE sillara CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# API
cd server
cp .env.example .env
# set JWT_SECRET + MAGIC_LINK_SECRET:  openssl rand -hex 32  (twice)
# set ANTHROPIC_API_KEY for 📸 Shelfie (console.anthropic.com) — optional, feature hides without it
npm install
npx prisma migrate deploy    # applies the committed initial migration
npm run seed              # plans: FREE / SHOP / PRO
npm run dev               # :4100

# POS (second terminal)
cd ../pos
cp .env.example .env && npm install
npm run dev               # :5273
```

Test the whole funnel with no payment accounts: `localhost:5273/signup` → create a
free shop → wizard → 📸 Shelfie a price list → sell → airplane-mode → sell again →
reconnect → watch the outbox sync.

### Automated tests

```bash
cd server
npm test          # unit only (money rounding, loyalty caps) — no database

# integration: a second database, kept well away from your dev data
mysql -u root -e "CREATE DATABASE sillara_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
DATABASE_URL="mysql://root@127.0.0.1:3306/sillara_test" npx prisma migrate deploy
DATABASE_URL="mysql://root@127.0.0.1:3306/sillara_test" npm run seed
TEST_DATABASE_URL="mysql://root@127.0.0.1:3306/sillara_test" npm test
```

Without `TEST_DATABASE_URL` the integration suite skips itself, so `npm test`
is always safe to run. `tests/setup-env.ts` never falls back to your dev
`DATABASE_URL`, so a test run cannot write into the shop you are demoing.

### Background jobs

The API runs its own cron in-process (`RUN_JOBS=true`, the default). To watch
one work without waiting for the schedule:

```bash
cd server
npm run job -- --list
npm run job -- lifecycle --force   # billing state machine
npm run job -- digest --force      # yesterday's takings email
npm run job -- emails --force      # flush the outbox
```

With `EMAIL_PROVIDER=console` nothing leaves the machine — the outbox row is
written, rendered and marked SENT, and the subject line is logged. To read the
email a shop owner would actually get:

```bash
mysql -u root sillara -e "SELECT subject, text FROM email_messages ORDER BY createdAt DESC LIMIT 1\G"
```

## Part 2 — Production topology

```
sillara.com          → Vercel (static marketing)     — global CDN, zero config
app.sillara.com      → Vercel (POS build)            — global CDN edge caching
api.sillara.com      → VPS: Nginx → PM2 → Node :4100 — one box to start
MySQL                → same VPS (127.0.0.1)          — no network hop
```

Server sequence (Ubuntu 24.04):

```
apt update && apt install -y nginx mysql-server git certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
npm i -g pm2

mysql -e "CREATE DATABASE sillara CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'sillara'@'localhost' IDENTIFIED BY 'STRONG_PASSWORD';
GRANT ALL ON sillara.* TO 'sillara'@'localhost'; FLUSH PRIVILEGES;"

cd /srv && git clone <your-repo> sillara && cd sillara/server
cp .env.example .env && nano .env      # production values below
npm ci && npx prisma generate && npx prisma migrate deploy && npm run seed
npm run build
pm2 start dist/server.js --name sillara-api && pm2 save && pm2 startup
```

Production `.env` deltas:
```
NODE_ENV=production
APP_URL=https://app.sillara.com
SITE_URL=https://sillara.com
API_URL=https://api.sillara.com
CORS_ORIGINS=https://app.sillara.com,https://sillara.com
DATABASE_URL="mysql://sillara:STRONG_PASSWORD@127.0.0.1:3306/sillara?connection_limit=15"
PADDLE_ENV=production      PAYHERE_ENV=production     # once accounts are live
EMAIL_PROVIDER=resend      RESEND_API_KEY=re_...
```

Nginx for the API (`certbot --nginx -d api.sillara.com` after):
```
server {
  server_name api.sillara.com;
  client_max_body_size 25m;                     # Shelfie photo batches
  location / {
    proxy_pass http://127.0.0.1:4100;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 90s;                     # Shelfie vision calls run 10–30s
  }
}
```

Vercel: two projects — `marketing/` (plain static) and `pos/` (`npm run build`,
output `dist`, env `VITE_API_URL=https://api.sillara.com`, SPA rewrite to
`/index.html`).

Backups (`crontab -e`):
```
0 2 * * * mysqldump --single-transaction sillara | gzip > /root/backups/sillara-$(date +\%F).sql.gz
```

## Part 3 — Why it doesn't lag (the architecture is the answer)

| Layer | Mechanism | Result |
|---|---|---|
| **Sell screen** | Catalog lives in IndexedDB; completing a sale writes locally and returns instantly | Tap → receipt in <100ms, **identical online and offline** — the till never waits on any server |
| Sync | Background outbox flush every 30s / on reconnect; server dedupes by UUID | Network latency is invisible to the cashier |
| Catalog reads | One `/products/bootstrap` call caches everything; searches/barcode hits are local index lookups | Zero per-keystroke requests |
| Frontend delivery | Static PWA on Vercel's CDN + service-worker shell cache | Warm loads are near-instant worldwide; cold loads served from the nearest edge |
| Photos (Shelfie) | Downscaled on-device to ≤1568px JPEG before upload (~5MB → ~250KB) | Fast uploads on shop Wi-Fi; fewer vision tokens |
| API | Same-box MySQL, indexed hot paths (`orgId` composites), gzip/br compression, keep-alive | p95 API reads in single-digit ms at this scale |
| Database | Composite indexes on every tenant query; money as DECIMAL; per-org counters via `LAST_INSERT_ID` | No table scans, no lock contention on receipt numbers |

Scale triggers (don't do these early): move MySQL to a managed instance at ~200
active shops; add a read replica + Redis for reports at ~1,000; split the sync
endpoint onto its own process at ~5,000. The client-side architecture never
needs to change — that's the point of offline-first.
