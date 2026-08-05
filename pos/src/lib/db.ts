import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/**
 * ---------------------------------------------------------------------------
 * OFFLINE STORE — the reason Sillara keeps selling during a power cut.
 * ---------------------------------------------------------------------------
 * Three stores:
 *   catalog  — server-wins snapshot (products, categories, org, staff).
 *              Refreshed on every successful bootstrap; read-only offline.
 *   outbox   — client-wins, append-only queue of completed sales. Each sale
 *              carries a client-minted UUID; the server dedupes on it, so the
 *              outbox can be flushed as many times as connectivity allows.
 *   kv       — session odds and ends (last sync time, receipt counter hint).
 *
 * Conflict strategy in one sentence: catalog flows DOWN (server wins),
 * sales flow UP (device wins, server assigns the receipt number) — the two
 * never fight because they never write the same rows.
 */

export interface CachedProduct {
  id: string;
  categoryId: string | null;
  name: string;
  price: number;
  barcode: string | null;
  sku: string | null;
  unit: string;
  trackStock: boolean;
  stockQty: number;
  isActive: boolean;
}

export interface CachedCategory {
  id: string;
  name: string;
  color: string;
  sortOrder: number;
}

export interface CachedOrg {
  id: string;
  slug: string;
  name: string;
  currency: string;
  language: string;
  taxRate: number;
  taxInclusive: boolean;
  receiptHeader: string | null;
  receiptFooter: string | null;
  address: string | null;
  phone: string | null;
  taxId: string | null;
  /**
   * Cached so the till knows it is paused even with no network. A device that
   * only learns this from a live call would happily queue sales that can never
   * sync — the cashier finds out at the end of the day, which is far worse
   * than finding out before the first one.
   */
  status?: string;
}

export interface OutboxSale {
  clientUuid: string;
  /** Device-minted short id for the public receipt page (/r/:publicId).
   *  Minted locally so an offline sale can still be WhatsApp'd immediately —
   *  the link goes live the moment the outbox syncs. */
  publicId: string;
  registerId: string | null;
  branchId: string | null;
  shiftId: string | null;
  customerId: string | null;
  /// Points the cashier asked to spend. The SERVER decides what's actually
  /// allowed — this is a request, never an instruction.
  redeemPoints: number;
  items: Array<{
    productId: string | null;
    name: string;
    unitPrice: number;
    qty: number;
    /// Null means "inherit" — the server resolves product rate, then org rate.
    /// A number is an explicit override, and 0 genuinely means zero-rated.
    taxRate: number | null;
    lineDiscount: number;
  }>;
  discount: number;
  tender: 'CASH' | 'CARD' | 'QR' | 'CREDIT' | 'OTHER';
  tendered: number;
  note?: string;
  soldAt: string; // ISO — device clock
  // local bookkeeping
  localNumber: number; // provisional receipt no. shown offline (SYNC-xxx)
  total: number;
  attempts: number;
}

interface SillaraDB extends DBSchema {
  catalog: { key: string; value: unknown };
  products: { key: string; value: CachedProduct; indexes: { byBarcode: string } };
  outbox: { key: string; value: OutboxSale };
  kv: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<SillaraDB>> | null = null;

export function db(): Promise<IDBPDatabase<SillaraDB>> {
  dbPromise ??= openDB<SillaraDB>('sillara-pos', 1, {
    upgrade(database) {
      database.createObjectStore('catalog');
      const products = database.createObjectStore('products', { keyPath: 'id' });
      products.createIndex('byBarcode', 'barcode');
      database.createObjectStore('outbox', { keyPath: 'clientUuid' });
      database.createObjectStore('kv');
    },
  });
  return dbPromise;
}

// --- catalog ----------------------------------------------------------------

/**
 * Catalog change notification.
 *
 * Boot is deliberately racy: the till opens from cache *immediately* and the
 * network refresh lands whenever it lands. Without a signal, any screen that
 * read the cache before that refresh arrived would sit there stale — and on a
 * brand-new shop that means an empty product grid seconds after signup, which
 * is the worst possible first impression a POS can make.
 */
const CATALOG_EVENT = 'sillara:catalog';

export function onCatalogChange(fn: () => void): () => void {
  window.addEventListener(CATALOG_EVENT, fn);
  return () => window.removeEventListener(CATALOG_EVENT, fn);
}

export async function cacheBootstrap(payload: {
  org: CachedOrg;
  categories: CachedCategory[];
  products: Array<Record<string, unknown>>;
  staff: unknown[];
  registers: unknown[];
  customers: unknown[];
}): Promise<void> {
  const database = await db();
  const tx = database.transaction(['catalog', 'products'], 'readwrite');
  await tx.objectStore('catalog').put(payload.org, 'org');
  await tx.objectStore('catalog').put(payload.categories, 'categories');
  await tx.objectStore('catalog').put(payload.staff, 'staff');
  await tx.objectStore('catalog').put(payload.registers, 'registers');
  await tx.objectStore('catalog').put(payload.customers, 'customers');
  await tx.objectStore('catalog').put(new Date().toISOString(), 'syncedAt');

  const store = tx.objectStore('products');
  await store.clear();
  for (const p of payload.products) {
    await store.put({
      id: String(p.id),
      categoryId: (p.categoryId as string | null) ?? null,
      name: String(p.name),
      price: Number(p.price),
      barcode: (p.barcode as string | null) ?? null,
      sku: (p.sku as string | null) ?? null,
      unit: String(p.unit ?? 'pc'),
      trackStock: Boolean(p.trackStock),
      stockQty: Number(p.stockQty ?? 0),
      isActive: Boolean(p.isActive),
    });
  }
  await tx.done;
  window.dispatchEvent(new Event(CATALOG_EVENT));
}

export async function getCachedOrg(): Promise<CachedOrg | undefined> {
  return (await db()).get('catalog', 'org') as Promise<CachedOrg | undefined>;
}

export async function getCachedCategories(): Promise<CachedCategory[]> {
  return ((await (await db()).get('catalog', 'categories')) as CachedCategory[] | undefined) ?? [];
}

export async function getCachedProducts(): Promise<CachedProduct[]> {
  return (await db()).getAll('products');
}

export async function findByBarcode(barcode: string): Promise<CachedProduct | undefined> {
  return (await db()).getFromIndex('products', 'byBarcode', barcode);
}

// --- outbox -----------------------------------------------------------------

export async function queueSale(sale: OutboxSale): Promise<void> {
  await (await db()).put('outbox', sale);
}

export async function pendingSales(): Promise<OutboxSale[]> {
  return (await db()).getAll('outbox');
}

export async function purgeSales(clientUuids: string[]): Promise<void> {
  const database = await db();
  const tx = database.transaction('outbox', 'readwrite');
  for (const id of clientUuids) await tx.store.delete(id);
  await tx.done;
}

export async function bumpAttempts(clientUuids: string[]): Promise<void> {
  const database = await db();
  const tx = database.transaction('outbox', 'readwrite');
  for (const id of clientUuids) {
    const sale = await tx.store.get(id);
    if (sale) await tx.store.put({ ...sale, attempts: sale.attempts + 1 });
  }
  await tx.done;
}

// --- kv ---------------------------------------------------------------------

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await db()).get('kv', key) as Promise<T | undefined>;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', value, key);
}

/** Provisional receipt number for offline sales: monotonic per device. */
export async function nextLocalNumber(): Promise<number> {
  const current = ((await kvGet<number>('localNumber')) ?? 0) + 1;
  await kvSet('localNumber', current);
  return current;
}

/**
 * Unguessable public receipt id, minted on the device.
 * 12 chars of base36 from crypto randomness — collision odds are negligible
 * and the server's UNIQUE index catches the impossible case.
 */
export function mintPublicId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 12);
}
