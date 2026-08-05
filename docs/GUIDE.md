# Sillara — The Complete Guide

Everything in one place: what it is, how it's built, every feature, every
endpoint, how to run it locally, how to ship it, and what to do when something
breaks.

**Contents**
1. [What Sillara is](#1-what-sillara-is)
2. [Architecture](#2-architecture)
3. [Feature reference](#3-feature-reference)
4. [Data model](#4-data-model)
5. [API reference](#5-api-reference)
6. [Local setup](#6-local-setup)
7. [Production deployment](#7-production-deployment)
8. [Migrations & the P3 backfill](#8-migrations--the-p3-backfill)
9. [Operations runbook](#9-operations-runbook)
10. [Troubleshooting](#10-troubleshooting)
11. [Roadmap](#11-roadmap)

---

## 1. What Sillara is

A worldwide, self-serve, multi-tenant point of sale. A shop owner anywhere on
Earth signs up, pays online, and is ringing up sales minutes later — with no
salesperson, no installer, and no setup fee.

**The wedge.** Every established POS in our launch market sells through agents:
"request a demo", a visit, an installation, days of waiting. Sillara's entire
pipeline is unattended. That is structurally hard for them to copy, because
copying it means dismantling their own business model.

**The magic.** 📸 Shelfie: photograph your shelves, your printed price list, or
your handwritten price book — in any language — and your catalog builds itself.
Nobody else does this. It solves the #1 activation killer in the industry
(typing in hundreds of products) and it demos in fifteen seconds.

**The growth loop.** Every receipt WhatsApp'd to a customer carries a public
link back to us. A busy shop hands out 200 a day.

**The endgame (P4).** Once thousands of shops and their suppliers are both on
the platform, ordering happens inside Sillara. That network is the moat — a
competitor can copy a sell screen; they cannot copy the network.

---

## 2. Architecture

```
sillara.com         Vercel · static marketing + checkout hand-off
app.sillara.com     Vercel · the POS (PWA) + public receipt pages
api.sillara.com     VPS   · Nginx → PM2 → Node 22 → MySQL (127.0.0.1)
```

### The three rules everything follows

**1. Tenancy comes from the token, never the request.** `orgId` is baked into
the JWT at login. No header, query param or body field can select a tenant.
Every business table carries `orgId` and every query is scoped by it — so
cross-tenant reads are structurally impossible, not merely "filtered".

**2. The till never waits on the network.** The catalog lives in IndexedDB;
completing a sale writes locally and returns instantly. Tap-to-receipt is under
100 ms and **identical online and offline**. Sales flush from an outbox in the
background. This is why there is no lag, and it is not a feature that can be
bolted on later — it is the shape of the whole client.

**3. The database is the idempotency layer.** Not application logic, not luck:

| Guarantee | Constraint |
|---|---|
| A sale syncs exactly once, however many retries | `UNIQUE(orgId, clientUuid)` |
| A webhook provisions exactly one shop | `UNIQUE(provider, eventId)` |
| A referral is credited once | `UNIQUE(referredOrgId)` |
| Receipt numbers are gap-free under concurrency | MySQL `LAST_INSERT_ID(expr)` |

### Money and ledgers

All money is `DECIMAL`, never float. Totals are **recomputed server-side** from
the line items on every sync — the device's totals are advisory. Loyalty points
are computed server-side too: points are money, and a device with a six-hour-old
balance must not be able to mint them.

Two append-only ledgers back the cached balances:

- `stock_movements` → `Product.stockQty` and `BranchStock.qty`
- `loyalty_transactions` → `Customer.loyaltyPoints`

Balances are denormalised for read speed; the ledger is the truth. Anything you
can't explain from the ledger is a bug.

---

## 3. Feature reference

### 📸 Shelfie — catalog mode
Photograph shelves, printed price lists, handwritten price books. Claude Opus 5
reads them (vision + JSON-schema structured output) and returns draft products
with name, price, category and a confidence flag. The owner reviews, edits and
bulk-inserts. Photos are downscaled **on device** to ≤1568 px JPEG first (~5 MB
→ ~250 KB), which keeps uploads fast on shop Wi-Fi and cuts vision tokens.

Drafts, never direct inserts — the model proposes, the human disposes.

### 📥 Shelfie v2 — invoice mode
Photograph a supplier invoice, delivery note or GRN. Returns supplier name plus
line items with quantity and **unit cost** (dividing line totals by quantity
when only totals are printed; skipping VAT rows, delivery charges and
subtotals). Each line is then matched **on device** against the existing catalog
so restocks update the product you already have instead of creating a duplicate
— the single most important detail in the flow. Unmatched lines become new
products with a suggested selling price (cost + 25%).

### 🧾 Sell screen
Touch grid with category filters, barcode scan-to-sell (a scanner is a keyboard
that types fast and hits Enter — no "scan mode" needed), cash/card/QR, quick-cash
denominations that adapt to the currency's magnitude, customer attach, and
points redemption. Works fully offline.

### 🔗 Public receipts
Every sale mints an unguessable 12-character ID **on the device**, so an offline
sale can be WhatsApp'd immediately — the link goes live when the outbox syncs.
`app.sillara.com/r/<id>` opens a receipt page with no auth, no app and no
signup, ending in "Run a shop? Start free →".

### 📦 Stock
Immutable `stock_movements` for every sale, void-return, receive, adjustment,
stocktake and transfer. Low-stock alerts with a one-tap filter, ± adjustment
with a mandatory reason, stocktake (set counted → ledger records the delta), and
per-product movement history.

### ⏱️ Shifts
Open with a float, sell, close by counting the drawer. Expected cash is computed
from the sales themselves, never a running counter a device could get wrong
offline. The close screen shows expected beside the count box so variance
appears the instant the cashier finishes typing.

### ⭐ Loyalty
Points earned on spend, redeemed as a discount. Economics live on the org row
(earn rate, point value, minimum before spending) and are owner-tunable. Every
calculation happens server-side inside the sale transaction; the device only
*requests* a redemption. Redemption is capped three ways: by balance, by the
minimum-redeem floor, and by the bill itself — points can never make a sale
negative.

### 🏬 Multi-branch (Pro)
Every org gets a "Main" branch at provisioning, so single-shop tenants never see
the concept. Per-branch stock balances move in lockstep with the org rollup
inside the same transaction as the ledger row. Transfers write two signed rows
(`TRANSFER_OUT`/`TRANSFER_IN`) and leave the org total untouched — nothing left
the business.

### 📋 Purchase orders
Order first, receive against the order. Gives you **expected vs delivered**,
which a photo alone cannot. Receiving updates `qtyReceived` per line and
recomputes status (DRAFT/SENT → PARTIAL → RECEIVED) **from the lines**, never
from a caller-supplied value. Free-text lines create the product on first
receipt.

### 📈 Profit & exports
Margin per item computed from the cost captured at receive time — what was
really paid. Three CSVs (sales, sold items, stock valuation) with a UTF-8 BOM so
Excel opens Sinhala and Tamil names correctly.

### 🎁 Referrals
Codes minted lazily from the shop name in a read-aloud-safe alphabet (no
I/O/0/1). `?ref=` flows marketing → signup → provisioning. Credit is awarded at
**provisioning, not signup**, so abandoned checkouts earn nobody anything.

### 🌐 The supplier network (P4) — the moat
`Supplier` is a shop's *private* address-book entry. `SupplierAccount` is a
supplier as a **platform participant** — one record shared by every shop that
buys from them. That distinction is the whole design.

**Shop side:** browse a country directory, connect in one tap (auto-accepted —
friction kills a young network), browse a connected supplier's published price
list with your own stock levels shown inline, and order. Orders become ordinary
`PurchaseOrder`s, so the existing receive flow and Shelfie v2 work unchanged.
The **Suggested** tab turns your low-stock list into one-tap reorders, cheapest
source first.

**Supplier side:** a magic-link portal — no password, because suppliers are
low-frequency users and a second auth product would kill adoption before the
network could form. They see and confirm orders, publish and reprice their
catalog, and read **aggregated demand**: what is moving across the shops they
serve, and which of their items shops are low on *right now*.

The demand view never names a shop. Suppliers get the signal ("42 units moved
across 7 shops"), shops keep their privacy. Break that boundary and shops
leave — and without shops there is no signal to sell.

**Why it's the moat:** a competitor can copy every screen in this codebase.
They cannot copy the shops and suppliers who have already found each other
here. Every connection makes the next one more valuable.

### 🌍 Worldwide
Per-tenant currency, timezone and language, defaulted from the signup country.
English + සිංහල + தமிழ්; adding a market is one file.

### 💻 All platforms
One PWA. Installs as a real app on Windows, macOS, Linux (Chrome/Edge
one-click), Android and iOS. Play Store via TWA. No Electron, no separate
builds — one fix ships everywhere at once.

---

## 4. Data model

25 models. Full definitions: [`server/prisma/schema.prisma`](../server/prisma/schema.prisma).

| Group | Models |
|---|---|
| Platform | `Plan`, `Organization`, `OrgUser`, `WebhookEvent`, `AuditLog`, `OrgSequence` |
| Locations | `Branch`, `BranchStock`, `Register` |
| Catalog | `Category`, `Product` |
| Selling | `Sale`, `SaleItem`, `Customer`, `Shift` |
| Ledgers | `StockMovement`, `LoyaltyTransaction` |
| Purchasing | `Supplier`, `PurchaseOrder`, `PurchaseOrderItem` |
| Network | `SupplierAccount`, `SupplierProduct`, `SupplierConnection` |
| Growth | `Referral` |

**Conventions**
- Soft delete (`deletedAt`) on people and config; financial records are voided,
  never deleted.
- Money `DECIMAL(12,2)`; quantities `DECIMAL(12,3)`; loyalty rates
  `DECIMAL(8,4)`.
- Snapshot fields (`SaleItem.nameSnapshot`, `PurchaseOrderItem.nameSnapshot`)
  freeze history — a receipt reads the same forever, even after a rename.

---

## 5. API reference

Base: `{API_URL}/api/v1`. Envelope: `{ok: true, data}` or
`{ok: false, error: {code, message, details?}}`. Auth is
`Authorization: Bearer <jwt>` except where marked **public**.

Roles: **C**ashier < **M**anager < **O**wner.

### Public
| Method | Path | Notes |
|---|---|---|
| GET | `/public/plans?country=LK` | Localised pricing table |
| POST | `/public/signup` | Free → provisioned + session; paid → checkout config |
| GET | `/public/provision-status/:orgId` | Checkout-return polling |
| GET | `/public/receipt/:publicId` | The WhatsApp receipt page data |
| GET | `/public/geo` | Country sniff for currency defaults |
| POST | `/public/webhooks/paddle` | HMAC-verified, replay-proof |
| POST | `/public/webhooks/payhere` | md5sig-verified, replay-proof |

### Auth
| Method | Path | Role |
|---|---|---|
| POST | `/auth/activate` · `/auth/login` | public |
| GET | `/auth/me` | C |
| GET/POST | `/auth/staff` | M |
| POST | `/auth/switch` | C (4-digit PIN, same org only) |

### Products & Shelfie
| Method | Path | Role | Notes |
|---|---|---|---|
| GET | `/products/bootstrap` | C | Whole catalog in one call → IndexedDB |
| GET | `/products` | C | `search`, `categoryId`, `lowStock` |
| POST/PATCH/DELETE | `/products[/:id]` | M | |
| POST | `/products/shelfie` | M | `mode: catalog \| invoice`, 1–4 images |
| GET | `/products/shelfie/status` | C | Feature flag for the UI |
| POST | `/products/bulk` | M | Bulk insert, plan cap enforced up front |
| GET | `/products/lookup/:barcode` | C | Open Food Facts auto-fill |
| POST | `/products/categories` | M | |

### Sales
| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/sales/sync` | C | Outbox flush; returns `purgeable[]` |
| GET | `/sales` | C | Paginated |
| GET | `/sales/z-report` | C | Daily totals, tender split, top items |
| POST | `/sales/:id/void` | M | Returns stock + writes ledger rows |

### Stock
| Method | Path | Role |
|---|---|---|
| GET | `/stock/low` · `/stock/movements/:productId` | C |
| POST | `/stock/adjust` · `/stock/count` · `/stock/receive` | M |

### Shifts
| Method | Path | Role |
|---|---|---|
| GET | `/shifts/current` · `/shifts/:id/summary` | C |
| POST | `/shifts/open` · `/shifts/:id/close` | C |
| GET | `/shifts` | M |

### Loyalty
| Method | Path | Role |
|---|---|---|
| GET | `/loyalty/balance/:customerId` · `/loyalty/history/:customerId` · `/loyalty/top` | C |
| POST | `/loyalty/adjust` | M |

### Branches
| Method | Path | Role |
|---|---|---|
| GET | `/branches` · `/branches/stock/:productId` | C |
| POST/PATCH | `/branches[/:id]` | O |
| POST | `/branches/transfer` | M |
| GET | `/branches/performance` | M |

### Purchasing
| Method | Path | Role |
|---|---|---|
| GET/POST | `/purchasing/suppliers` | C / M |
| GET | `/purchasing/orders[/:id]` | C |
| POST | `/purchasing/orders` · `/orders/:id/status` · `/orders/:id/receive` | M |

### Network (shop side)
| Method | Path | Role |
|---|---|---|
| GET | `/network/suppliers` · `/network/connections` | C |
| GET | `/network/catalog/:supplierAccountId` | C |
| GET | `/network/suggested` | C |
| POST | `/network/connect/:supplierAccountId` · `/network/order` | M |

### Supplier portal (magic-link token, not the org JWT)
Auth: `x-supplier-token` header, or `?t=` on the first load.

| Method | Path | Auth |
|---|---|---|
| POST | `/supplier/register` · `/supplier/portal-link` | public |
| GET | `/supplier/me` · `/orders` · `/products` · `/demand` | token |
| POST | `/supplier/orders/:id/confirm` · `/supplier/products` | token |
| PATCH | `/supplier/products/:id` · `/supplier/profile` | token |

### Reports, referrals, org
| Method | Path | Role |
|---|---|---|
| GET | `/reports/profit` | M |
| GET | `/reports/export/sales` · `/items` · `/stock` | M (CSV) |
| GET | `/referrals` | C |
| GET/PATCH | `/org` | C / O |
| GET | `/health` | public |

---

## 6. Local setup

**Prerequisites:** Node 22, MySQL 8.

```bash
# 1 — database
mysql -u root -e "CREATE DATABASE sillara CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

```bash
# 2 — secrets (paste both into server/.env)
node -e "for (const k of ['JWT_SECRET','MAGIC_LINK_SECRET']) console.log(k+'='+require('crypto').randomBytes(32).toString('hex'))"
```

```bash
# 3 — API
cd server
cp .env.example .env      # paste the secrets; add ANTHROPIC_API_KEY for Shelfie
npm install
npx prisma migrate dev --name init
npm run seed
npm run dev               # :4100
```

```bash
# 4 — POS (second terminal)
cd pos
cp .env.example .env && npm install
npm run dev               # :5273
```

Marketing site: open `marketing/index.html`, or serve it on any static port.

### The 10-minute acceptance run

Do this end-to-end before you believe anything works:

1. `localhost:5273/signup` → create a free shop → you land in the wizard
2. Wizard step 2 → **📸 photograph a price list** → review → save
3. Sell an item → **WhatsApp the receipt → open the link on another device**
4. Stock tab → **📥 photograph a supplier invoice** → lines match → stock rises
5. Business → Loyalty → enable → back to Sell → attach a customer → sell → points appear
6. Sell → 🟢 open a shift → sell → close it → variance shown
7. **Airplane mode → sell → reconnect** → outbox counter clears
8. Business → Profit → export a CSV
9. Network → Suppliers → connect to the demo supplier → Browse → order
10. Open `marketing/suppliers.html` → register → the console mailer logs a
    portal link → open it → confirm the order you just placed

No `ANTHROPIC_API_KEY`? Steps 2 and 4 are hidden; everything else works.

---

## 7. Production deployment

Full commands: [DEPLOY.md](DEPLOY.md). Summary:

**API (VPS):** Nginx → PM2 → Node → MySQL on localhost.
Two Nginx settings matter: `client_max_body_size 25m` (Shelfie photo batches)
and `proxy_read_timeout 120s` (vision calls run 10–30 s).

**POS (Vercel, root `pos`):** `pos/vercel.json` already sets the SPA rewrite,
immutable asset caching, **no-cache on `sw.js`** (a stale worker would pin an
old build), and `camera=(self)` for Shelfie. Env: `VITE_API_URL`.

**Marketing (Vercel, root `marketing`):** static, no build step.

**Play Store:** `bubblewrap` with the pre-filled `pos/twa-manifest.json`, then
paste Play's SHA-256 fingerprint into
`pos/public/.well-known/assetlinks.json` and redeploy — without it the app
opens with a browser address bar.

### Environment variables

| Var | Required | Notes |
|---|:--:|---|
| `DATABASE_URL` | ✅ | Add `?connection_limit=15` in production |
| `JWT_SECRET`, `MAGIC_LINK_SECRET` | ✅ | 32 bytes hex each |
| `APP_URL`, `SITE_URL`, `API_URL`, `CORS_ORIGINS` | ✅ | Exact https origins |
| `ANTHROPIC_API_KEY` | — | Shelfie. Absent = feature hidden |
| `SHELFIE_MODEL` | — | Default `claude-opus-5` |
| `RESEND_API_KEY`, `EMAIL_PROVIDER` | prod | Activation emails |
| `PADDLE_*` | prod | Worldwide payments (merchant of record) |
| `PAYHERE_*` | LK | Local cards + LankaQR |

Production refuses to boot with no payment provider configured — a POS platform
that can't take money is a demo.

---

## 8. Migrations & the P3 backfill

### Applying P3

```bash
cd server
npx prisma migrate dev --name p3_shifts_loyalty_branches   # local
# or, on the server:
npx prisma migrate deploy
```

Creates `branches`, `branch_stock`, `shifts`, `loyalty_transactions`,
`suppliers`, `purchase_orders`, `purchase_order_items`, `referrals`, plus new
columns on `organizations`, `sales`, `registers`, `stock_movements` and
`org_users`.

### Then backfill existing shops

New shops get a "Main" branch from the provisioner. Shops created **before P3**
have none — their sales, registers and movements carry a null `branchId` and
their per-branch stock table is empty. Fix that:

```bash
npm run backfill:p3 -- --dry     # report only, changes nothing
```

```bash
npm run backfill:p3              # apply
```

What it does, per org:
1. Creates a `Main` / `BR-01` default branch if none exists
2. Links orphaned registers, sales and stock movements to it
3. Seeds `branch_stock` from `Product.stockQty` (with one branch, the branch
   balance *is* the org balance — copying is correct; recomputing from the
   ledger would be wrong for shops that adjusted stock before the ledger
   existed)

**It is idempotent by construction.** Every step filters on `null` or checks for
an existing row, so a second run is a no-op. Each org runs in its own
transaction — one bad tenant can't roll back another. Run it again without fear
after a partial failure; completed orgs are skipped.

Expected output:

```
🔧 P3 backfill — applying

  🏬 silverline-mart              branch:created registers:  1 sales:  1243 moves:  1243 stock:  87
     cafe-aroma                   branch:ok      registers:  0 sales:     0 moves:     0 stock:   0

─────────────────────────────────────────────
Organizations scanned : 2
Branches created      : 1
...
✅ Backfill complete. Safe to run again — it is idempotent.
```

### Verify

```sql
-- every org has exactly one default branch
SELECT o.slug, COUNT(b.id) AS branches, SUM(b.isDefault) AS defaults
FROM organizations o LEFT JOIN branches b ON b.orgId = o.id AND b.deletedAt IS NULL
WHERE o.deletedAt IS NULL GROUP BY o.slug HAVING defaults <> 1;

-- nothing orphaned
SELECT COUNT(*) FROM sales WHERE branchId IS NULL;
SELECT COUNT(*) FROM stock_movements WHERE branchId IS NULL;

-- branch stock matches the org rollup (single-branch shops)
SELECT p.name, p.stockQty, bs.qty FROM products p
JOIN branch_stock bs ON bs.productId = p.id
WHERE p.trackStock = 1 AND p.stockQty <> bs.qty;
```

The last query returning rows is expected **only** for shops that already had
more than one branch. For everyone else it should be empty.

---

## 9. Operations runbook

### Daily
Nothing. The scheduler handles billing state, digests, mail and cleanup, and
every job is idempotent — a missed night catches up on its own.

### Weekly
- `pm2 logs sillara-api --lines 200` — look for repeated 5xx or webhook errors
- Confirm last night's backup exists in `/root/backups/`
- Two queries, thirty seconds:
  ```sql
  SELECT jobName, runKey, error FROM job_runs
   WHERE status='FAILED' AND startedAt > NOW() - INTERVAL 7 DAY;
  SELECT template, `to`, lastError FROM email_messages WHERE status='FAILED';
  ```
  Both empty is the expected state. A failed `lifecycle` run means somebody is
  not being billed; a permanently failed email means a shop was never told why
  its till stopped.
- Recover from either with `npm run job -- <name> --force`. Re-running is safe
  by construction: state transitions are guarded and every email is keyed.

### Monthly
- **Restore a backup into a scratch database.** A backup you have never
  restored is a hope, not a backup.
- Review Shelfie spend in the Anthropic console (~$0.05–0.15 per scan)
- `SELECT COUNT(*) FROM organizations WHERE status='ACTIVE'` — the number that
  matters

### Deploying an update
```bash
cd /srv/sillara && git pull
cd server && npm ci && npx prisma migrate deploy && npm run build && pm2 restart sillara-api
```
Frontends redeploy themselves on push if Vercel is connected to the repo.

### Backups
```
0 2 * * * mysqldump --single-transaction --routines sillara | gzip > /root/backups/sillara-$(date +\%F).sql.gz
0 4 * * 0 find /root/backups -name '*.sql.gz' -mtime +30 -delete
```

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Sales stuck in the outbox counter | API unreachable or auth expired | Check `/health`; sign out and back in. **Sales are safe** — the outbox is durable and retries forever |
| Shelfie button missing | `ANTHROPIC_API_KEY` unset | Set it and restart; `/products/shelfie/status` reports the flag |
| Shelfie times out | Nginx `proxy_read_timeout` too low | Raise to 120 s — vision calls run 10–30 s |
| Shelfie 413 | Upload larger than Nginx allows | `client_max_body_size 25m` |
| Invoice lines create duplicates | Names differ too much to match | Fix the product name in review; matching is normalised name compare |
| Public receipt 404 | Sale hasn't synced yet, or was voided | Wait for the outbox; voided sales are intentionally hidden |
| Receipt link shows a stale page | Service worker cached it | Already excluded — confirm the deployed `sw.js` skips `/r/` |
| Points not awarded | Loyalty disabled, or no customer attached | Business → Loyalty → enable; attach a customer before charging |
| "Multiple branches are a Pro feature" | Plan lacks `multi_branch` | Upgrade the plan, or add the feature to the `plans` row |
| Stock looks wrong | Cached balance drifted from the ledger | Compare `stock_movements` sums against `products.stockQty`; the ledger is truth |
| Login works, everything 401s | Clock skew or wrong `JWT_SECRET` | Confirm the API and the build point at the same environment |
| CORS errors | `CORS_ORIGINS` mismatch | Must list exact origins including scheme, no trailing slash |
| Install prompt never appears | Not HTTPS, or already installed | PWA install requires TLS; check `display-mode: standalone` |
| Supplier directory empty | No `SupplierAccount` in that country | Suppliers self-list at `/suppliers.html`; `SEED_DEMO=true` adds one |
| "Connect to this supplier first" | No ACTIVE `SupplierConnection` | Connect from Network → Suppliers |
| Order rejected on minimum | Below supplier's `minOrder` or a line below its `moq` | Both are enforced server-side — the client hint can be stale |
| Supplier portal link expired | 30-day TTL | Request a new one at `/suppliers.html`; links rotate on every issue |
| Everything returns 402 `ORG_SUSPENDED` | Billing lapsed past its grace period | `GET /org/billing` says exactly why; a payment webhook reactivates instantly. **Reads still work** — this is by design |
| Everything returns 401 `ACCOUNT_INACTIVE` | The user was deactivated or the org soft-deleted | Re-enable in staff settings; takes effect within 5 s (the guard's cache TTL) |
| A shop was never dunned | The `lifecycle` job has not run | `SELECT * FROM job_runs WHERE jobName='lifecycle'`; run `npm run job -- lifecycle --force` |
| No emails arriving | `EMAIL_PROVIDER=console`, or the outbox is stuck | Console mode logs instead of sending. Otherwise check `email_messages.lastError` |
| The same email arrived twice | Two different `dedupeKey`s were generated | The key must be deterministic — a timestamp in it defeats the whole mechanism |
| `npm run dev` dies on "unable to determine transport target for pino-pretty" | devDependencies not installed | `npm install`. The logger now degrades to JSON instead of failing to boot |

**Golden rule for money bugs:** the ledgers (`stock_movements`,
`loyalty_transactions`) are truth; the balances (`stockQty`, `loyaltyPoints`)
are caches. If they disagree, the cache is wrong — and the ledger tells you
exactly which write did it.

---

## 11. Roadmap

**P4 — shipped.** The supplier network is built (see the feature reference).
What remains is not code: it needs shops and suppliers actually on it. Ten
connected pairs teach you more than the next ten features.

**Queued:**
- Thermal print bridge for Android terminals (needs a small companion app — a
  browser cannot reach a USB printer directly)
- Shelfie v3: shelf-gap detection ("you're out of three fast movers")
- Online payments in-app (PayHere/Stripe checkout link on the receipt)
- Accounting export to QuickBooks / Xero / Zoho Books

**Not on the roadmap, deliberately:** native iOS/Android rewrites. One PWA ships
to every platform at once; splitting that is a permanent tax for no user-visible
gain until card-present payments require it.

