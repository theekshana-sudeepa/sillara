import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/state/store';
import { money } from '@/lib/format';

/**
 * 🌐 The supplier network — shop side.
 *
 * Three tabs that map to the three jobs: find suppliers, order from them, and
 * be told what to reorder. The "Suggested" tab is the payoff — it turns the
 * low-stock list into a one-tap order because a connected supplier already
 * sells the thing you're out of.
 */

interface Supplier {
  id: string;
  name: string;
  description: string | null;
  minOrder: number;
  leadDays: number;
  currency: string;
  productCount: number;
  connection: 'REQUESTED' | 'ACTIVE' | 'BLOCKED' | null;
}

interface CatalogItem {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  unitCost: number;
  moq: number;
  unit: string;
  inStock: boolean;
  myProduct: { id: string; stockQty: number; price: number } | null;
}

interface Suggestion {
  product: { id: string; name: string; stockQty: number; lowStockAt: number };
  offers: Array<{ supplierProductId: string; supplierAccountId: string; supplierName: string; unitCost: number; moq: number; unit: string }>;
}

type Tab = 'suggested' | 'suppliers' | 'catalog';

export default function NetworkPage() {
  const { session, online } = useSession();
  const currency = session?.org.currency ?? 'USD';

  const [tab, setTab] = useState<Tab>('suggested');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [openSupplier, setOpenSupplier] = useState<Supplier | null>(null);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(null), 3500); };

  const load = useCallback(async () => {
    if (!online) return;
    setError(null);
    try {
      if (tab === 'suppliers') setSuppliers(await api.get<Supplier[]>('/network/suppliers', search ? { search } : undefined));
      if (tab === 'suggested') setSuggestions(await api.get<Suggestion[]>('/network/suggested'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load');
    }
  }, [tab, search, online]);

  useEffect(() => { void load(); }, [load]);

  const connect = async (s: Supplier) => {
    setBusy(true);
    try {
      await api.post(`/network/connect/${s.id}`, {});
      flash(`✓ Connected to ${s.name}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not connect');
    } finally {
      setBusy(false);
    }
  };

  const browse = async (s: Supplier) => {
    setBusy(true);
    setCart({});
    try {
      setCatalog(await api.get<CatalogItem[]>(`/network/catalog/${s.id}`));
      setOpenSupplier(s);
      setTab('catalog');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open catalog');
    } finally {
      setBusy(false);
    }
  };

  const placeOrder = async () => {
    if (!openSupplier) return;
    const items = Object.entries(cart).filter(([, qty]) => qty > 0).map(([supplierProductId, qty]) => ({ supplierProductId, qty }));
    if (items.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const order = await api.post<{ number: number }>('/network/order', {
        supplierAccountId: openSupplier.id,
        items,
      });
      flash(`✓ Order #${order.number} sent to ${openSupplier.name}`);
      setCart({});
      setOpenSupplier(null);
      setTab('suggested');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Order failed');
    } finally {
      setBusy(false);
    }
  };

  /** One-tap: jump from a low-stock suggestion into that supplier's cart. */
  const orderSuggestion = async (s: Suggestion, offerIndex: number) => {
    const offer = s.offers[offerIndex]!;
    const supplier = await api.get<Supplier[]>('/network/suppliers').then(
      (list) => list.find((x) => x.id === offer.supplierAccountId),
    );
    if (!supplier) return;
    await browse(supplier);
    setCart({ [offer.supplierProductId]: offer.moq });
  };

  const cartTotal = catalog.reduce((sum, item) => sum + (cart[item.id] ?? 0) * item.unitCost, 0);
  const cartCount = Object.values(cart).filter((q) => q > 0).length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 border-b border-border p-2">
        {([['suggested', '💡 Suggested'], ['suppliers', '🏭 Suppliers']] as const).map(([id, label]) => (
          <button key={id} onClick={() => { setTab(id); setOpenSupplier(null); }} aria-pressed={tab === id}
            className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-colors ${
              tab === id ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>
            {label}
          </button>
        ))}
        {openSupplier ? (
          <button onClick={() => setTab('catalog')} aria-pressed={tab === 'catalog'}
            className={`flex-1 truncate rounded-lg py-2 text-xs font-semibold ${
              tab === 'catalog' ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>
            🛒 {openSupplier.name}
          </button>
        ) : null}
      </div>

      {toast ? <p role="status" className="bg-success/10 px-4 py-2 text-center text-sm font-semibold text-success">{toast}</p> : null}
      {error ? <p role="alert" className="mx-4 mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      {!online ? <p className="bg-warning/10 px-4 py-2 text-center text-sm text-warning">Offline — the network needs a connection.</p> : null}

      <div className="flex-1 overflow-y-auto">
        {/* ---------------------------------------------------- suggested */}
        {tab === 'suggested' ? (
          suggestions.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-3xl" aria-hidden>💡</p>
              <p className="mt-3 text-sm font-semibold">Nothing to reorder</p>
              <p className="mt-1 text-sm text-muted-foreground">
                When a tracked product drops to its reorder level and a connected supplier sells it, it appears here with one-tap ordering.
              </p>
              <button onClick={() => setTab('suppliers')} className="mt-5 rounded-xl bg-primary px-5 py-3 text-sm font-bold text-primary-foreground">
                Find suppliers
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {suggestions.map((s) => (
                <li key={s.product.id} className="px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{s.product.name}</span>
                    <span className="tabular shrink-0 text-xs font-bold text-warning">
                      {s.product.stockQty} left
                    </span>
                  </div>
                  <div className="mt-2 flex flex-col gap-1.5">
                    {s.offers.slice(0, 3).map((o, i) => (
                      <button key={o.supplierProductId} onClick={() => void orderSuggestion(s, i)} disabled={busy}
                        className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-xs transition-colors active:bg-secondary">
                        <span className="min-w-0 flex-1 truncate">{o.supplierName}</span>
                        <span className="tabular shrink-0 font-bold">{money(o.unitCost, currency)}/{o.unit}</span>
                        <span className="shrink-0 text-primary">order →</span>
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {/* ---------------------------------------------------- suppliers */}
        {tab === 'suppliers' ? (
          <>
            <div className="p-3">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search suppliers…"
                className="h-11 w-full rounded-xl border border-input bg-secondary/50 px-4 text-sm outline-none focus:border-ring focus:bg-background" />
            </div>
            <ul className="divide-y divide-border">
              {suppliers.map((s) => (
                <li key={s.id} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{s.name}</span>
                      {s.description ? <span className="block truncate text-xs text-muted-foreground">{s.description}</span> : null}
                      <span className="tabular block text-xs text-muted-foreground">
                        {s.productCount} items · {s.leadDays}d lead
                        {s.minOrder > 0 ? ` · min ${money(s.minOrder, s.currency)}` : ''}
                      </span>
                    </span>
                    {s.connection === 'ACTIVE' ? (
                      <button onClick={() => void browse(s)} disabled={busy}
                        className="shrink-0 rounded-lg bg-primary px-3 py-2 text-xs font-bold text-primary-foreground">
                        Browse
                      </button>
                    ) : (
                      <button onClick={() => void connect(s)} disabled={busy}
                        className="shrink-0 rounded-lg bg-secondary px-3 py-2 text-xs font-bold">
                        Connect
                      </button>
                    )}
                  </div>
                </li>
              ))}
              {suppliers.length === 0 ? (
                <li className="px-6 py-16 text-center">
                  <p className="text-3xl" aria-hidden>🏭</p>
                  <p className="mt-3 text-sm font-semibold">No suppliers listed yet in your country</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Know a wholesaler? Send them <strong className="text-foreground">sillara.com/suppliers</strong> — listing is free.
                  </p>
                </li>
              ) : null}
            </ul>
          </>
        ) : null}

        {/* ------------------------------------------------------ catalog */}
        {tab === 'catalog' && openSupplier ? (
          <ul className="divide-y divide-border">
            {catalog.map((item) => {
              const qty = cart[item.id] ?? 0;
              return (
                <li key={item.id} className={`px-4 py-3 ${item.inStock ? '' : 'opacity-50'}`}>
                  <div className="flex items-start gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.name}</span>
                      <span className="tabular block text-xs text-muted-foreground">
                        {money(item.unitCost, openSupplier.currency)}/{item.unit}
                        {item.moq > 1 ? ` · min ${item.moq}` : ''}
                        {!item.inStock ? ' · out of stock' : ''}
                      </span>
                      {item.myProduct ? (
                        <span className="tabular block text-[11px] text-success">
                          you stock this · {item.myProduct.stockQty} on hand
                        </span>
                      ) : (
                        <span className="block text-[11px] text-info">new to your shop</span>
                      )}
                    </span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button onClick={() => setCart({ ...cart, [item.id]: Math.max(0, qty - item.moq) })}
                        disabled={!item.inStock} aria-label={`Less ${item.name}`}
                        className="grid size-9 place-items-center rounded-lg bg-secondary text-lg font-semibold disabled:opacity-40">−</button>
                      <span className="tabular w-9 text-center text-sm font-bold">{qty || ''}</span>
                      <button onClick={() => setCart({ ...cart, [item.id]: qty + (qty === 0 ? item.moq : item.moq) })}
                        disabled={!item.inStock} aria-label={`More ${item.name}`}
                        className="grid size-9 place-items-center rounded-lg bg-secondary text-lg font-semibold disabled:opacity-40">+</button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {tab === 'catalog' && cartCount > 0 && openSupplier ? (
        <div className="border-t border-border p-3">
          <div className="mb-2 flex justify-between text-sm">
            <span className="text-muted-foreground">{cartCount} item{cartCount === 1 ? '' : 's'}</span>
            <span className="tabular font-bold">{money(cartTotal, openSupplier.currency)}</span>
          </div>
          {openSupplier.minOrder > 0 && cartTotal < openSupplier.minOrder ? (
            <p className="mb-2 text-center text-xs text-warning">
              {money(openSupplier.minOrder - cartTotal, openSupplier.currency)} below the minimum order
            </p>
          ) : null}
          <button onClick={() => void placeOrder()} disabled={busy || (openSupplier.minOrder > 0 && cartTotal < openSupplier.minOrder)}
            className="w-full rounded-xl bg-primary text-base font-bold text-primary-foreground disabled:opacity-40" style={{ height: 52 }}>
            {busy ? 'Sending…' : `Send order to ${openSupplier.name}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}
