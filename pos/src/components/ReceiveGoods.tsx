import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/state/store';
import { getCachedProducts, type CachedProduct } from '@/lib/db';
import { money } from '@/lib/format';

/**
 * 📥 Receive goods — Shelfie v2.
 *
 * Photograph the supplier invoice; the model reads supplier, line items,
 * quantities and unit costs. Each line is then MATCHED against the existing
 * catalog on-device (normalised name compare) so restocks update the product
 * you already have instead of creating a duplicate — the single most
 * important detail in the whole flow. Unmatched lines become new products
 * with a suggested selling price.
 *
 * Receiving stock is the most repeated back-office task in retail. Turning it
 * into "take a photo" is what makes Shelfie a daily habit rather than a
 * one-time onboarding trick.
 */

interface InvoiceLine {
  name: string;
  quantity: number;
  unitCost: number | null;
  confidence: 'high' | 'medium' | 'low';
  // resolved on-device
  productId: string | null;
  matchedName: string | null;
  price: number | null; // selling price, only for new products
  keep: boolean;
}

type Phase = 'pick' | 'reading' | 'review' | 'saving';

/** Normalise for fuzzy-ish matching: lowercase, strip punctuation and spaces. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9඀-෿஀-௿]/g, '');

async function downscale(file: File): Promise<{ data: string; mediaType: 'image/jpeg' }> {
  const bitmap = await createImageBitmap(file);
  const long = Math.max(bitmap.width, bitmap.height);
  // Invoices are text-dense — keep the full 1568px budget for legibility.
  const scale = long > 1568 ? 1568 / long : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/jpeg' };
}

export function ReceiveGoods({ onClose, onDone }: { onClose: () => void; onDone: (summary: string) => void }) {
  const { session } = useSession();
  const currency = session?.org.currency ?? 'USD';
  const fileRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>('pick');
  const [catalog, setCatalog] = useState<CachedProduct[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [payload, setPayload] = useState<Array<{ data: string; mediaType: 'image/jpeg' }>>([]);
  const [supplier, setSupplier] = useState('');
  const [lines, setLines] = useState<InvoiceLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getCachedProducts().then(setCatalog);
  }, []);

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    setError(null);
    for (const file of Array.from(files).slice(0, 4 - payload.length)) {
      try {
        const scaled = await downscale(file);
        setPayload((p) => [...p, scaled]);
        setPreviews((p) => [...p, `data:image/jpeg;base64,${scaled.data}`]);
      } catch {
        setError('Could not read that image — try another photo');
      }
    }
  };

  const read = async () => {
    setPhase('reading');
    setError(null);
    try {
      const result = await api.post<{
        extraction: { supplier: string | null; items: Array<Omit<InvoiceLine, 'productId' | 'matchedName' | 'price' | 'keep'>> };
      }>('/products/shelfie', { mode: 'invoice', images: payload });

      const items = result.extraction.items;
      if (items.length === 0) {
        setError('No line items found. Try a flatter, closer shot of the itemised section.');
        setPhase('pick');
        return;
      }

      // Match each invoice line to an existing product.
      const byName = new Map(catalog.map((p) => [norm(p.name), p]));
      setLines(
        items.map((it) => {
          const key = norm(it.name);
          const exact = byName.get(key);
          const partial =
            exact ?? catalog.find((p) => key.length > 5 && (norm(p.name).includes(key) || key.includes(norm(p.name))));
          return {
            ...it,
            productId: partial?.id ?? null,
            matchedName: partial?.name ?? null,
            // Suggest a selling price for new items: cost + 25%, rounded.
            price: partial ? null : it.unitCost != null ? Math.round(it.unitCost * 1.25 * 100) / 100 : null,
            keep: true,
          };
        }),
      );
      if (result.extraction.supplier) setSupplier(result.extraction.supplier);
      setPhase('review');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reading failed — check your connection and try again');
      setPhase('pick');
    }
  };

  const save = async () => {
    const kept = lines.filter((l) => l.keep && l.quantity > 0 && (l.productId || (l.name.trim() && l.price && l.price > 0)));
    if (kept.length === 0) {
      setError('Keep at least one line. New products need a selling price.');
      return;
    }
    setPhase('saving');
    setError(null);
    try {
      const result = await api.post<{ newProducts: number; restocked: number }>('/stock/receive', {
        supplier: supplier.trim() || null,
        rows: kept.map((l) =>
          l.productId
            ? { productId: l.productId, qty: l.quantity, unitCost: l.unitCost }
            : { name: l.name.trim(), price: l.price, qty: l.quantity, unitCost: l.unitCost },
        ),
      });
      onDone(
        `✓ Received ${kept.length} line${kept.length === 1 ? '' : 's'} · ${result.restocked} restocked, ${result.newProducts} new`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed — try again');
      setPhase('review');
    }
  };

  const edit = (i: number, patch: Partial<InvoiceLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const keptLines = lines.filter((l) => l.keep);
  const totalCost = keptLines.reduce((s, l) => s + (l.unitCost ?? 0) * l.quantity, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm sm:items-center">
      <div className="flex max-h-[94vh] w-full max-w-lg flex-col rounded-t-2xl bg-card sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h2 className="text-lg font-bold">📥 Receive goods</h2>
            <p className="text-xs text-muted-foreground">Photograph the supplier invoice — stock updates itself.</p>
          </div>
          <button onClick={onClose} className="grid size-9 place-items-center rounded-lg bg-secondary text-sm" aria-label="Close">✕</button>
        </div>

        {error ? <p role="alert" className="mx-4 mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

        {phase === 'pick' ? (
          <div className="flex flex-col gap-3 overflow-y-auto p-4">
            <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple className="sr-only"
              onChange={(e) => void addFiles(e.target.files)} />

            {previews.length > 0 ? (
              <div className="grid grid-cols-4 gap-2">
                {previews.map((src, i) => (
                  <button key={i}
                    onClick={() => { setPreviews(previews.filter((_, j) => j !== i)); setPayload(payload.filter((_, j) => j !== i)); }}
                    className="relative aspect-square overflow-hidden rounded-lg border border-border" aria-label={`Remove photo ${i + 1}`}>
                    <img src={src} alt="" className="size-full object-cover" />
                    <span className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-foreground/70 text-[10px] text-background">✕</span>
                  </button>
                ))}
              </div>
            ) : null}

            <button onClick={() => fileRef.current?.click()} disabled={payload.length >= 4}
              className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-border py-10 text-muted-foreground transition-colors active:bg-secondary disabled:opacity-40">
              <span className="text-4xl" aria-hidden>🧾</span>
              <span className="text-sm font-semibold">{previews.length === 0 ? 'Photograph the invoice' : `Add another (${payload.length}/4)`}</span>
              <span className="px-6 text-center text-xs">Invoice · delivery note · GRN — printed or handwritten, any language</span>
            </button>

            <button onClick={() => void read()} disabled={payload.length === 0}
              className="rounded-xl bg-primary text-base font-bold text-primary-foreground disabled:opacity-40" style={{ height: 52 }}>
              Read invoice →
            </button>
          </div>
        ) : null}

        {phase === 'reading' ? (
          <div className="flex flex-col items-center gap-4 p-12">
            <div className="size-10 animate-spin rounded-full border-[3px] border-border border-t-primary" />
            <p className="text-sm font-semibold">Reading the invoice…</p>
            <p className="text-center text-xs text-muted-foreground">Matching lines against your catalog. Usually 10–30 seconds.</p>
          </div>
        ) : null}

        {phase === 'review' || phase === 'saving' ? (
          <>
            <div className="border-b border-border p-3">
              <label htmlFor="supplier" className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Supplier</label>
              <input id="supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="e.g. Ceylon Distributors"
                className="mt-1 h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring" />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <ul className="divide-y divide-border">
                {lines.map((l, i) => (
                  <li key={i} className={`px-4 py-3 ${l.keep ? '' : 'opacity-40'}`}>
                    <div className="flex items-start gap-2.5">
                      <input type="checkbox" checked={l.keep} onChange={(e) => edit(i, { keep: e.target.checked })}
                        className="mt-1 size-5 shrink-0" aria-label={`Keep ${l.name}`} />
                      <div className="min-w-0 flex-1">
                        <input value={l.name} onChange={(e) => edit(i, { name: e.target.value })}
                          className="w-full bg-transparent text-sm font-medium outline-none focus:underline" aria-label="Line item name" />
                        <p className="mt-0.5 text-[11px]">
                          {l.productId ? (
                            <span className="font-semibold text-success">↑ restocking “{l.matchedName}”</span>
                          ) : (
                            <span className="font-semibold text-info">+ new product</span>
                          )}
                          <span className={`ml-2 rounded-full px-1.5 py-px text-[9px] font-bold uppercase ${
                            l.confidence === 'high' ? 'bg-success/15 text-success'
                            : l.confidence === 'low' ? 'bg-destructive/15 text-destructive'
                            : 'bg-warning/15 text-warning'}`}>
                            {l.confidence}
                          </span>
                        </p>
                      </div>
                    </div>

                    <div className="mt-2 grid grid-cols-3 gap-2 pl-8">
                      <label className="block">
                        <span className="block text-[10px] font-semibold uppercase text-muted-foreground">Qty</span>
                        <input inputMode="decimal" value={l.quantity}
                          onChange={(e) => edit(i, { quantity: Number(e.target.value.replace(/[^\d.]/g, '')) || 0 })}
                          className="tabular mt-0.5 h-9 w-full rounded-lg border border-input bg-background px-2 text-right text-sm outline-none focus:border-ring" />
                      </label>
                      <label className="block">
                        <span className="block text-[10px] font-semibold uppercase text-muted-foreground">Unit cost</span>
                        <input inputMode="decimal" value={l.unitCost ?? ''} placeholder="—"
                          onChange={(e) => { const v = e.target.value.replace(/[^\d.]/g, ''); edit(i, { unitCost: v === '' ? null : Number(v) }); }}
                          className="tabular mt-0.5 h-9 w-full rounded-lg border border-input bg-background px-2 text-right text-sm outline-none focus:border-ring" />
                      </label>
                      <label className="block">
                        <span className="block text-[10px] font-semibold uppercase text-muted-foreground">
                          {l.productId ? 'Sell price' : 'Sell price *'}
                        </span>
                        <input inputMode="decimal" value={l.productId ? '' : l.price ?? ''} disabled={Boolean(l.productId)}
                          placeholder={l.productId ? 'unchanged' : 'required'}
                          onChange={(e) => { const v = e.target.value.replace(/[^\d.]/g, ''); edit(i, { price: v === '' ? null : Number(v) }); }}
                          className={`tabular mt-0.5 h-9 w-full rounded-lg border bg-background px-2 text-right text-sm outline-none focus:border-ring disabled:opacity-40 ${
                            !l.productId && l.keep && (!l.price || l.price <= 0) ? 'border-destructive' : 'border-input'}`} />
                      </label>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <div className="border-t border-border p-3">
              <div className="mb-2 flex justify-between text-sm">
                <span className="text-muted-foreground">{keptLines.length} line{keptLines.length === 1 ? '' : 's'} · invoice total</span>
                <span className="tabular font-bold">{money(totalCost, currency)}</span>
              </div>
              <button onClick={() => void save()} disabled={phase === 'saving' || keptLines.length === 0}
                className="w-full rounded-xl bg-success text-base font-bold text-success-foreground disabled:opacity-40" style={{ height: 52 }}>
                {phase === 'saving' ? 'Receiving…' : 'Add to stock'}
              </button>
              <button onClick={() => setPhase('pick')} className="mt-2 w-full text-xs font-medium text-muted-foreground" style={{ height: 32 }}>
                ← Back to photos
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
