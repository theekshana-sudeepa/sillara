import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/state/store';
import { money, dateOf, titleCase } from '@/lib/format';
import { ReceiveGoods } from '@/components/ReceiveGoods';

interface StockProduct {
  id: string;
  name: string;
  price: string;
  cost: string;
  trackStock: boolean;
  stockQty: string;
  lowStockAt: string | null;
  unit: string;
  category: { id: string; name: string; color: string } | null;
}

interface Movement {
  id: string;
  type: 'SALE' | 'VOID_RETURN' | 'RECEIVE' | 'ADJUST' | 'COUNT';
  qty: string;
  unitCost: string | null;
  note: string | null;
  createdAt: string;
}

type Sheet =
  | { kind: 'none' }
  | { kind: 'adjust'; product: StockProduct }
  | { kind: 'count'; product: StockProduct }
  | { kind: 'history'; product: StockProduct };

const MOVE_STYLE: Record<Movement['type'], string> = {
  RECEIVE: 'text-success',
  VOID_RETURN: 'text-info',
  SALE: 'text-muted-foreground',
  ADJUST: 'text-warning',
  COUNT: 'text-warning',
};

export default function StockPage() {
  const { session, refreshCatalog } = useSession();
  const currency = session?.org.currency ?? 'USD';

  const [products, setProducts] = useState<StockProduct[]>([]);
  const [low, setLow] = useState<Array<{ id: string; name: string; stockQty: string; lowStockAt: string | null }>>([]);
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [sheet, setSheet] = useState<Sheet>({ kind: 'none' });
  const [movements, setMovements] = useState<Movement[]>([]);
  const [input, setInput] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, lowList] = await Promise.all([
        api.get<StockProduct[]>('/products', search ? { search } : undefined),
        api.get<typeof low>('/stock/low'),
      ]);
      setProducts(list.filter((p) => p.trackStock));
      setLow(lowList);
    } catch { /* offline: sell screen still works from cache */ }
  }, [search]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3500);
  };

  const openSheet = async (next: Sheet) => {
    setSheet(next);
    setInput('');
    setNote('');
    setError(null);
    if (next.kind === 'history') {
      setMovements([]);
      try {
        setMovements(await api.get<Movement[]>(`/stock/movements/${next.product.id}`, { limit: 50 }));
      } catch { /* leave empty */ }
    }
    if (next.kind === 'count') setInput(String(Number(next.product.stockQty)));
  };

  const submit = async () => {
    if (sheet.kind !== 'adjust' && sheet.kind !== 'count') return;
    const value = Number(input);
    if (!Number.isFinite(value)) return setError('Enter a number');
    setBusy(true);
    setError(null);
    try {
      if (sheet.kind === 'adjust') {
        if (value === 0) throw new Error('Adjustment cannot be zero');
        if (note.trim().length < 2) throw new Error('Add a short reason');
        await api.post('/stock/adjust', { productId: sheet.product.id, qty: value, note: note.trim() });
        flash(`✓ ${sheet.product.name} adjusted by ${value > 0 ? '+' : ''}${value}`);
      } else {
        await api.post('/stock/count', { productId: sheet.product.id, counted: value, note: note.trim() || 'Stocktake' });
        flash(`✓ ${sheet.product.name} counted at ${value}`);
      }
      setSheet({ kind: 'none' });
      await load();
      await refreshCatalog().catch(() => {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const visible = lowOnly ? products.filter((p) => low.some((l) => l.id === p.id)) : products;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search stock…" aria-label="Search stock"
          className="h-11 flex-1 rounded-xl border border-input bg-secondary/50 px-4 text-sm outline-none focus:border-ring focus:bg-background" />
        <button onClick={() => setReceiveOpen(true)}
          className="h-11 shrink-0 rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground">
          📥 Receive
        </button>
      </div>

      {toast ? (
        <p role="status" className="border-b border-border bg-success/10 px-4 py-2 text-center text-sm font-semibold text-success">{toast}</p>
      ) : null}

      {low.length > 0 ? (
        <button onClick={() => setLowOnly((v) => !v)}
          className={`flex items-center gap-2 border-b border-border px-4 py-2.5 text-left text-sm ${lowOnly ? 'bg-warning/15' : 'bg-warning/10'}`}>
          <span aria-hidden>⚠️</span>
          <span className="flex-1 font-semibold text-warning">
            {low.length} item{low.length === 1 ? '' : 's'} at or below reorder level
          </span>
          <span className="text-xs font-medium text-warning">{lowOnly ? 'show all' : 'show only these'}</span>
        </button>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="text-3xl" aria-hidden>📦</p>
            <p className="mt-3 text-sm font-semibold">No tracked stock yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Turn on stock tracking for a product, or photograph a supplier invoice to receive goods.
            </p>
            <button onClick={() => setReceiveOpen(true)} className="mt-5 rounded-xl bg-primary px-5 py-3 text-sm font-bold text-primary-foreground">
              📥 Receive goods
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((p) => {
              const qty = Number(p.stockQty);
              const isLow = low.some((l) => l.id === p.id);
              return (
                <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: p.category?.color ?? '#94A3B8' }} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {money(Number(p.price), currency)}
                      {Number(p.cost) > 0 ? ` · cost ${money(Number(p.cost), currency)}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={`tabular text-base font-bold ${qty <= 0 ? 'text-destructive' : isLow ? 'text-warning' : ''}`}>
                      {qty} <span className="text-xs font-normal text-muted-foreground">{p.unit}</span>
                    </p>
                    {p.lowStockAt ? <p className="text-[10px] text-muted-foreground">reorder at {Number(p.lowStockAt)}</p> : null}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button onClick={() => void openSheet({ kind: 'adjust', product: p })}
                      className="grid size-9 place-items-center rounded-lg bg-secondary text-sm" title="Adjust" aria-label={`Adjust ${p.name}`}>±</button>
                    <button onClick={() => void openSheet({ kind: 'count', product: p })}
                      className="grid size-9 place-items-center rounded-lg bg-secondary text-sm" title="Stocktake" aria-label={`Count ${p.name}`}>#</button>
                    <button onClick={() => void openSheet({ kind: 'history', product: p })}
                      className="grid size-9 place-items-center rounded-lg bg-secondary text-sm" title="History" aria-label={`History for ${p.name}`}>↻</button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* --------------------------------------------------- action sheets */}
      {sheet.kind !== 'none' ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/40 backdrop-blur-sm sm:items-center"
          onClick={() => setSheet({ kind: 'none' })}>
          <div className="w-full max-w-md rounded-t-2xl bg-card p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold">
              {sheet.kind === 'adjust' ? 'Adjust stock' : sheet.kind === 'count' ? 'Stocktake' : 'Movement history'}
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {sheet.product.name} · currently <strong className="tabular text-foreground">{Number(sheet.product.stockQty)}</strong> {sheet.product.unit}
            </p>

            {error ? <p role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

            {sheet.kind === 'history' ? (
              <ul className="mt-4 max-h-80 divide-y divide-border overflow-y-auto">
                {movements.length === 0 ? (
                  <li className="py-6 text-center text-sm text-muted-foreground">No movements recorded yet.</li>
                ) : (
                  movements.map((m) => {
                    const q = Number(m.qty);
                    return (
                      <li key={m.id} className="flex items-center gap-3 py-2.5">
                        <span className={`tabular w-16 text-right text-sm font-bold ${q > 0 ? 'text-success' : 'text-muted-foreground'}`}>
                          {q > 0 ? '+' : ''}{q}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className={`text-sm font-medium ${MOVE_STYLE[m.type]}`}>{titleCase(m.type)}</p>
                          {m.note ? <p className="truncate text-xs text-muted-foreground">{m.note}</p> : null}
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">{dateOf(m.createdAt)}</span>
                      </li>
                    );
                  })
                )}
              </ul>
            ) : (
              <>
                <label className="mt-4 block text-xs font-bold uppercase tracking-wide text-muted-foreground">
                  {sheet.kind === 'adjust' ? 'Change by (use − to reduce)' : 'Counted quantity'}
                </label>
                <input inputMode="decimal" value={input} autoFocus
                  onChange={(e) => setInput(e.target.value.replace(/[^\d.-]/g, ''))}
                  placeholder={sheet.kind === 'adjust' ? 'e.g. -3' : '0'}
                  className="tabular mt-1 h-14 w-full rounded-xl border border-input bg-background px-4 text-center text-2xl font-bold outline-none focus:border-ring" />

                {sheet.kind === 'adjust' ? (
                  <div className="mt-2 grid grid-cols-4 gap-2">
                    {[-10, -1, 1, 10].map((n) => (
                      <button key={n} onClick={() => setInput(String((Number(input) || 0) + n))}
                        className="tabular h-10 rounded-lg bg-secondary text-sm font-semibold">{n > 0 ? `+${n}` : n}</button>
                    ))}
                  </div>
                ) : null}

                <label className="mt-4 block text-xs font-bold uppercase tracking-wide text-muted-foreground">
                  Reason {sheet.kind === 'adjust' ? '' : '(optional)'}
                </label>
                <input value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder={sheet.kind === 'adjust' ? 'Breakage, theft, correction…' : 'Stocktake'}
                  className="mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-ring" />

                <div className="mt-5 grid grid-cols-2 gap-2">
                  <button onClick={() => setSheet({ kind: 'none' })} className="h-12 rounded-xl bg-secondary text-sm font-semibold">Cancel</button>
                  <button onClick={() => void submit()} disabled={busy}
                    className="h-12 rounded-xl bg-primary text-sm font-bold text-primary-foreground disabled:opacity-50">
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {receiveOpen ? (
        <ReceiveGoods
          onClose={() => setReceiveOpen(false)}
          onDone={(summary) => {
            setReceiveOpen(false);
            flash(summary);
            void load();
            void refreshCatalog().catch(() => {});
          }}
        />
      ) : null}
    </div>
  );
}
