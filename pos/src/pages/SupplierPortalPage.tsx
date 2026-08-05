import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { money, dateOf } from '@/lib/format';

/**
 * Supplier portal — a separate audience inside the same app.
 *
 * Authenticated by the magic-link token in the URL, not the org JWT, so it
 * shares no session state with the POS. Deliberately raw `fetch` for that
 * reason: reusing the POS api client would carry a shop's Authorization
 * header into a supplier context, which is exactly the kind of quiet
 * cross-audience leak that is hard to notice and hard to undo.
 */

interface Me {
  supplier: { id: string; name: string; currency: string; minOrder: number; leadDays: number; description: string | null };
  stats: { products: number; pendingOrders: number; connectedShops: number };
}

interface Order {
  id: string;
  number: number;
  status: string;
  total: number;
  currency: string;
  createdAt: string;
  expectedAt: string | null;
  confirmedAt: string | null;
  shop: { name: string; phone: string | null; address: string | null };
  items: Array<{ name: string; qty: number; qtyReceived: number; unitCost: number }>;
}

interface Demand {
  days: number;
  connectedShops: number;
  topItems: Array<{ name: string; units: number; shops: number; revenue: number }>;
  needRestocking: Array<{ name: string; shopsLow: number; unitCost: number }>;
}

interface CatalogRow {
  id: string;
  name: string;
  unitCost: string;
  moq: string;
  unit: string;
  inStock: boolean;
  isActive: boolean;
}

type Tab = 'orders' | 'demand' | 'catalog';

export default function SupplierPortalPage() {
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';

  const [tab, setTab] = useState<Tab>('orders');
  const [me, setMe] = useState<Me | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [demand, setDemand] = useState<Demand | null>(null);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'invalid'>('loading');
  const [toast, setToast] = useState<string | null>(null);

  const call = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const base = import.meta.env.VITE_API_URL ?? '';
      const res = await fetch(`${base}/api/v1/supplier${path}`, {
        ...init,
        headers: { 'x-supplier-token': token, 'Content-Type': 'application/json', ...init?.headers },
      });
      const json = (await res.json()) as { ok: boolean; data: T; error?: { message: string } };
      if (!res.ok || !json.ok) throw new Error(json.error?.message ?? 'Request failed');
      return json.data;
    },
    [token],
  );

  useEffect(() => {
    if (!token) return setState('invalid');
    void call<Me>('/me')
      .then((m) => { setMe(m); setState('ready'); })
      .catch(() => setState('invalid'));
  }, [token, call]);

  const load = useCallback(async () => {
    if (state !== 'ready') return;
    try {
      if (tab === 'orders') setOrders(await call<Order[]>('/orders'));
      if (tab === 'demand') setDemand(await call<Demand>('/demand?days=30'));
      if (tab === 'catalog') setCatalog(await call<CatalogRow[]>('/products'));
    } catch { /* keep whatever is on screen */ }
  }, [tab, state, call]);

  useEffect(() => { void load(); }, [load]);

  const confirm = async (id: string) => {
    try {
      await call(`/orders/${id}/confirm`, { method: 'POST', body: '{}' });
      setToast('✓ Order confirmed');
      setTimeout(() => setToast(null), 3000);
      await load();
    } catch { /* surfaced by the empty state */ }
  };

  if (state === 'loading') {
    return <div className="grid min-h-full place-items-center bg-background">
      <div className="size-8 animate-spin rounded-full border-2 border-border border-t-primary" />
    </div>;
  }

  if (state === 'invalid') {
    return (
      <div className="grid min-h-full place-items-center bg-background p-6 text-center">
        <div className="max-w-sm">
          <p className="text-4xl" aria-hidden>🔐</p>
          <h1 className="mt-3 text-lg font-bold">This portal link has expired</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Portal links last 30 days. Request a fresh one and we'll email it to you.
          </p>
          <a href="https://sillara.com/suppliers" className="mt-6 inline-block rounded-xl bg-primary px-5 py-3 text-sm font-bold text-primary-foreground">
            Get a new link
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-background">
      <header className="border-b border-border bg-card px-4 py-3">
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">S</div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold">{me?.supplier.name}</p>
            <p className="tabular text-xs text-muted-foreground">
              {me?.stats.connectedShops} shops · {me?.stats.products} items · {me?.stats.pendingOrders} new orders
            </p>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-2xl">
        <div className="flex gap-1 p-2">
          {([['orders', '📦 Orders'], ['demand', '📊 Demand'], ['catalog', '🏷 Price list']] as const).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} aria-pressed={tab === id}
              className={`flex-1 rounded-lg py-2 text-xs font-semibold transition-colors ${
                tab === id ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>
              {label}
            </button>
          ))}
        </div>

        {toast ? <p role="status" className="bg-success/10 px-4 py-2 text-center text-sm font-semibold text-success">{toast}</p> : null}

        <div className="p-4 pt-2">
          {/* ---------------------------------------------------- orders */}
          {tab === 'orders' ? (
            orders.length === 0 ? (
              <p className="py-16 text-center text-sm text-muted-foreground">No orders yet.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {orders.map((o) => (
                  <li key={o.id} className="rounded-xl border border-border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-bold">{o.shop.name}</p>
                        <p className="tabular text-xs text-muted-foreground">
                          Order #{o.number} · {dateOf(o.createdAt)}
                          {o.expectedAt ? ` · due ${dateOf(o.expectedAt)}` : ''}
                        </p>
                        {o.shop.address ? <p className="mt-0.5 text-xs text-muted-foreground">{o.shop.address}</p> : null}
                        {o.shop.phone ? <p className="text-xs text-muted-foreground">{o.shop.phone}</p> : null}
                      </div>
                      <span className="tabular shrink-0 text-base font-bold">{money(o.total, o.currency)}</span>
                    </div>

                    <ul className="mt-3 divide-y divide-border border-t border-border pt-2">
                      {o.items.map((i, idx) => (
                        <li key={idx} className="flex justify-between py-1.5 text-sm">
                          <span className="tabular min-w-0 flex-1 truncate">{i.qty} × {i.name}</span>
                          <span className="tabular shrink-0 text-muted-foreground">{money(i.qty * i.unitCost, o.currency)}</span>
                        </li>
                      ))}
                    </ul>

                    {o.status === 'SENT' && !o.confirmedAt ? (
                      <button onClick={() => void confirm(o.id)}
                        className="mt-3 h-11 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground">
                        Confirm order
                      </button>
                    ) : (
                      <p className="mt-3 text-center text-xs font-semibold text-success">
                        {o.status === 'RECEIVED' ? '✓ Delivered and received' : '✓ Confirmed'}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {/* ---------------------------------------------------- demand */}
          {tab === 'demand' && demand ? (
            <>
              <p className="rounded-xl bg-secondary/60 p-3 text-xs text-muted-foreground">
                Aggregated across the <strong className="text-foreground">{demand.connectedShops}</strong> shops connected to you,
                last {demand.days} days. Individual shops are never identified.
              </p>

              {demand.needRestocking.length > 0 ? (
                <>
                  <p className="mt-5 text-xs font-bold uppercase tracking-wide text-warning">Shops are running low right now</p>
                  <ul className="mt-2 divide-y divide-border rounded-xl border border-warning/30 bg-warning/5">
                    {demand.needRestocking.map((r) => (
                      <li key={r.name} className="flex items-center gap-3 px-3 py-2.5">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.name}</span>
                        <span className="tabular shrink-0 text-sm font-bold text-warning">{r.shopsLow} shop{r.shopsLow === 1 ? '' : 's'}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}

              <p className="mt-5 text-xs font-bold uppercase tracking-wide text-muted-foreground">Your top movers</p>
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border bg-card">
                {demand.topItems.map((i) => (
                  <li key={i.name} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{i.name}</span>
                      <span className="tabular block text-xs text-muted-foreground">{i.units} units · {i.shops} shops</span>
                    </span>
                    <span className="tabular shrink-0 text-sm font-bold">{money(i.revenue, me?.supplier.currency ?? 'LKR')}</span>
                  </li>
                ))}
                {demand.topItems.length === 0 ? (
                  <li className="px-3 py-8 text-center text-sm text-muted-foreground">No orders in this period yet.</li>
                ) : null}
              </ul>
            </>
          ) : null}

          {/* --------------------------------------------------- catalog */}
          {tab === 'catalog' ? (
            <ul className="divide-y divide-border rounded-xl border border-border bg-card">
              {catalog.map((p) => (
                <li key={p.id} className={`flex items-center gap-3 px-3 py-2.5 ${p.isActive ? '' : 'opacity-50'}`}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{p.name}</span>
                    <span className="tabular block text-xs text-muted-foreground">
                      min {Number(p.moq)} {p.unit}{p.inStock ? '' : ' · out of stock'}
                    </span>
                  </span>
                  <span className="tabular shrink-0 text-sm font-bold">
                    {money(Number(p.unitCost), me?.supplier.currency ?? 'LKR')}
                  </span>
                </li>
              ))}
              {catalog.length === 0 ? (
                <li className="px-4 py-10 text-center">
                  <p className="text-sm font-semibold">No price list yet</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Shops can only order what you publish. Send us your price list and we'll load it for you — reply to any Sillara email.
                  </p>
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>

        <p className="pb-8 pt-4 text-center text-xs text-muted-foreground">Sillara · the shop network · sillara.com</p>
      </div>
    </div>
  );
}
