import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/state/store';
import { getCachedCategories, type CachedCategory } from '@/lib/db';
import { money } from '@/lib/format';
import { t } from '@/lib/i18n';
import { ShelfieImport } from '@/components/ShelfieImport';

interface ProductRow {
  id: string;
  name: string;
  price: string;
  sku: string | null;
  barcode: string | null;
  trackStock: boolean;
  stockQty: string;
  isActive: boolean;
  category: { id: string; name: string; color: string } | null;
}

interface FormState {
  id?: string;
  name: string;
  price: string;
  barcode: string;
  categoryId: string;
  trackStock: boolean;
  stockQty: string;
}

const EMPTY: FormState = { name: '', price: '', barcode: '', categoryId: '', trackStock: false, stockQty: '0' };

export default function ProductsPage() {
  const { session, refreshCatalog } = useSession();
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [categories, setCategories] = useState<CachedCategory[]>([]);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shelfieOpen, setShelfieOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const currency = session?.org.currency ?? 'USD';

  /** Barcode auto-fill: scan an unknown code → name appears from the open
   *  product database. Silent no-op when offline or unknown. */
  const lookupBarcode = async (barcode: string) => {
    if (!form || form.name.trim() || !/^\d{6,14}$/.test(barcode)) return;
    try {
      const hit = await api.get<{ found: boolean; name?: string }>(`/products/lookup/${barcode}`);
      if (hit.found && hit.name) setForm((f) => (f && !f.name.trim() ? { ...f, name: hit.name! } : f));
    } catch { /* nicety only */ }
  };

  const load = useCallback(async () => {
    try {
      setRows(await api.get<ProductRow[]>('/products', search ? { search } : undefined));
    } catch {
      /* offline: page is read-mostly; sell screen still works from cache */
    }
    setCategories(await getCachedCategories());
  }, [search]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    const payload = {
      name: form.name,
      price: Number(form.price) || 0,
      barcode: form.barcode || null,
      categoryId: form.categoryId || null,
      trackStock: form.trackStock,
      stockQty: Number(form.stockQty) || 0,
    };
    try {
      if (form.id) await api.patch(`/products/${form.id}`, payload);
      else await api.post('/products', payload);
      setForm(null);
      await load();
      await refreshCatalog(); // sell screen cache picks the change up now
    } catch (err) {
      // The 402 PLAN_LIMIT error is the upgrade funnel talking.
      setError(err instanceof ApiError && err.status === 402 ? `${err.message}` : err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('search_products')}
          aria-label={t('search_products')}
          className="h-11 flex-1 rounded-xl border border-input bg-secondary/50 px-4 text-sm outline-none focus:border-ring focus:bg-background"
        />
        <button
          onClick={() => setShelfieOpen(true)}
          className="h-11 shrink-0 rounded-xl border border-primary/40 bg-primary/10 px-3 text-sm font-bold text-primary"
          title="Photograph your shelf or price list"
        >
          📸
        </button>
        <button onClick={() => setForm(EMPTY)} className="h-11 shrink-0 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground">
          + {t('add_product')}
        </button>
      </div>

      {toast ? (
        <p role="status" className="border-b border-border bg-success/10 px-4 py-2 text-center text-sm font-semibold text-success">
          {toast}
        </p>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">{t('cart_empty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() =>
                    setForm({
                      id: p.id,
                      name: p.name,
                      price: String(Number(p.price)),
                      barcode: p.barcode ?? '',
                      categoryId: p.category?.id ?? '',
                      trackStock: p.trackStock,
                      stockQty: String(Number(p.stockQty)),
                    })
                  }
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/50"
                >
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: p.category?.color ?? '#94A3B8' }} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{p.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {p.category?.name ?? '—'}{p.barcode ? ` · ${p.barcode}` : ''}
                    </span>
                  </span>
                  {p.trackStock ? (
                    <span className={`tabular text-xs ${Number(p.stockQty) <= 0 ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
                      {t('stock')}: {Number(p.stockQty)}
                    </span>
                  ) : null}
                  <span className="tabular text-sm font-semibold">{money(Number(p.price), currency)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {form ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/40 backdrop-blur-sm sm:items-center" onClick={() => setForm(null)}>
          <form
            onSubmit={(e) => void save(e)}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md rounded-t-2xl bg-card p-5 sm:rounded-2xl"
          >
            <h2 className="text-lg font-bold">{form.id ? form.name : t('add_product')}</h2>
            {error ? <p role="alert" className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

            <label className="mt-4 block text-xs font-semibold text-muted-foreground">{t('name')}</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus
              className="mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-ring" />

            <div className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-muted-foreground">{t('price')} ({currency})</label>
                <input inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value.replace(/[^\d.]/g, '') })} required
                  className="tabular mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-ring" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-muted-foreground">{t('barcode')}</label>
                <input value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })}
                  onBlur={(e) => void lookupBarcode(e.target.value.trim())}
                  placeholder="Scan to auto-fill name"
                  className="tabular mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-ring" />
              </div>
            </div>

            <label className="mt-3 block text-xs font-semibold text-muted-foreground">{t('category')}</label>
            <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
              className="mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-ring">
              <option value="">—</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>

            <label className="mt-3 flex items-center gap-2.5 rounded-xl border border-border p-3 text-sm">
              <input type="checkbox" checked={form.trackStock} onChange={(e) => setForm({ ...form, trackStock: e.target.checked })} className="size-4" />
              {t('stock')}
              {form.trackStock ? (
                <input inputMode="numeric" value={form.stockQty} onChange={(e) => setForm({ ...form, stockQty: e.target.value.replace(/[^\d.]/g, '') })}
                  className="tabular ml-auto h-9 w-24 rounded-lg border border-input bg-background px-2 text-right text-sm" aria-label={t('stock')} />
              ) : null}
            </label>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setForm(null)} className="h-12 rounded-xl bg-secondary text-sm font-semibold">{t('cancel')}</button>
              <button type="submit" disabled={busy} className="h-12 rounded-xl bg-primary text-sm font-bold text-primary-foreground disabled:opacity-50">{t('save')}</button>
            </div>
          </form>
        </div>
      ) : null}

      {shelfieOpen ? (
        <ShelfieImport
          onClose={() => setShelfieOpen(false)}
          onDone={(created) => {
            setShelfieOpen(false);
            setToast(`✓ ${created} product${created === 1 ? '' : 's'} added from photos`);
            setTimeout(() => setToast(null), 4000);
            void load();
            void refreshCatalog();
          }}
        />
      ) : null}
    </div>
  );
}
