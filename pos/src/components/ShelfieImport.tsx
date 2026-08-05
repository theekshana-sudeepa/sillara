import { useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/state/store';
import { money } from '@/lib/format';

/**
 * 📸 Shelfie — photograph shelves / price lists / handwritten price books,
 * review the AI-extracted drafts, insert in bulk.
 *
 * Performance rule: photos are downscaled ON DEVICE to ≤1568px JPEG before
 * upload. A 12MP phone photo goes from ~5MB to ~250KB — uploads stay fast on
 * shop Wi-Fi, and the vision model reads a 1568px shelf photo just as well as
 * the original while costing a fraction of the tokens.
 */

interface Draft {
  name: string;
  price: number | null;
  category: string | null;
  confidence: 'high' | 'medium' | 'low';
  keep: boolean;
}

type Phase = 'pick' | 'reading' | 'review' | 'saving';

async function downscale(file: File): Promise<{ data: string; mediaType: 'image/jpeg' }> {
  const bitmap = await createImageBitmap(file);
  const long = Math.max(bitmap.width, bitmap.height);
  const scale = long > 1568 ? 1568 / long : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { data: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/jpeg' };
}

const CONF_STYLE: Record<Draft['confidence'], string> = {
  high: 'bg-success/15 text-success',
  medium: 'bg-warning/15 text-warning',
  low: 'bg-destructive/15 text-destructive',
};

export function ShelfieImport({ onClose, onDone }: { onClose: () => void; onDone: (created: number) => void }) {
  const { session } = useSession();
  const currency = session?.org.currency ?? 'USD';
  const fileRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>('pick');
  const [previews, setPreviews] = useState<string[]>([]);
  const [payload, setPayload] = useState<Array<{ data: string; mediaType: 'image/jpeg' }>>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    setError(null);
    const room = 4 - payload.length;
    for (const file of Array.from(files).slice(0, room)) {
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
      const result = await api.post<{ products: Omit<Draft, 'keep'>[] }>('/products/shelfie', { images: payload });
      if (result.products.length === 0) {
        setError('No products found in these photos. Try closer shots where names and prices are readable.');
        setPhase('pick');
        return;
      }
      setDrafts(result.products.map((p) => ({ ...p, keep: true })));
      setPhase('review');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reading failed — check your connection and try again');
      setPhase('pick');
    }
  };

  const save = async () => {
    const kept = drafts.filter((d) => d.keep && d.name.trim() && d.price !== null && d.price > 0);
    if (kept.length === 0) {
      setError('Keep at least one product with a price');
      return;
    }
    setPhase('saving');
    setError(null);
    try {
      const result = await api.post<{ created: number }>('/products/bulk', {
        products: kept.map((d) => ({ name: d.name.trim(), price: d.price, categoryName: d.category })),
      });
      onDone(result.created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed — try again');
      setPhase('review');
    }
  };

  const edit = (i: number, patch: Partial<Draft>) =>
    setDrafts(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  const keptCount = drafts.filter((d) => d.keep && d.price !== null && d.price > 0).length;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm sm:items-center">
      <div className="flex max-h-[94vh] w-full max-w-lg flex-col rounded-t-2xl bg-card sm:rounded-2xl">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <h2 className="text-lg font-bold">📸 Shelfie</h2>
            <p className="text-xs text-muted-foreground">Photograph your shelves or price list — we type it in for you.</p>
          </div>
          <button onClick={onClose} className="grid size-9 place-items-center rounded-lg bg-secondary text-sm" aria-label="Close">✕</button>
        </div>

        {error ? <p role="alert" className="mx-4 mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

        {/* ---------------------------------------------------- pick photos */}
        {phase === 'pick' ? (
          <div className="flex flex-col gap-3 overflow-y-auto p-4">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="sr-only"
              onChange={(e) => void addFiles(e.target.files)}
            />

            {previews.length > 0 ? (
              <div className="grid grid-cols-4 gap-2">
                {previews.map((src, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      setPreviews(previews.filter((_, j) => j !== i));
                      setPayload(payload.filter((_, j) => j !== i));
                    }}
                    className="relative aspect-square overflow-hidden rounded-lg border border-border"
                    aria-label={`Remove photo ${i + 1}`}
                  >
                    <img src={src} alt="" className="size-full object-cover" />
                    <span className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-foreground/70 text-[10px] text-background">✕</span>
                  </button>
                ))}
              </div>
            ) : null}

            <button
              onClick={() => fileRef.current?.click()}
              disabled={payload.length >= 4}
              className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-border py-10 text-muted-foreground transition-colors active:bg-secondary disabled:opacity-40"
            >
              <span className="text-4xl" aria-hidden>📷</span>
              <span className="text-sm font-semibold">{previews.length === 0 ? 'Take or choose photos' : `Add another (${payload.length}/4)`}</span>
              <span className="text-xs">Shelves · price lists · handwritten books · invoices — any language</span>
            </button>

            <button
              onClick={() => void read()}
              disabled={payload.length === 0}
              className="rounded-xl bg-primary text-base font-bold text-primary-foreground disabled:opacity-40"
              style={{ height: 52 }}
            >
              Read products →
            </button>
          </div>
        ) : null}

        {/* ------------------------------------------------------- reading */}
        {phase === 'reading' ? (
          <div className="flex flex-col items-center gap-4 p-12">
            <div className="size-10 animate-spin rounded-full border-[3px] border-border border-t-primary" />
            <p className="text-sm font-semibold">Reading your photos…</p>
            <p className="text-center text-xs text-muted-foreground">Names, prices and categories are being extracted. Usually 10–30 seconds.</p>
          </div>
        ) : null}

        {/* -------------------------------------------------------- review */}
        {phase === 'review' || phase === 'saving' ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <p className="px-4 pt-3 text-xs text-muted-foreground">
                Found <strong className="text-foreground">{drafts.length}</strong> — untick anything wrong, fix prices, then add.
              </p>
              <ul className="divide-y divide-border">
                {drafts.map((d, i) => (
                  <li key={i} className={`flex items-center gap-2.5 px-4 py-2.5 ${d.keep ? '' : 'opacity-40'}`}>
                    <input
                      type="checkbox"
                      checked={d.keep}
                      onChange={(e) => edit(i, { keep: e.target.checked })}
                      className="size-5 shrink-0"
                      aria-label={`Keep ${d.name}`}
                    />
                    <div className="min-w-0 flex-1">
                      <input
                        value={d.name}
                        onChange={(e) => edit(i, { name: e.target.value })}
                        className="w-full bg-transparent text-sm font-medium outline-none focus:underline"
                        aria-label="Product name"
                      />
                      <div className="mt-0.5 flex items-center gap-1.5">
                        {d.category ? <span className="text-[10px] text-muted-foreground">{d.category}</span> : null}
                        <span className={`rounded-full px-1.5 py-px text-[9px] font-bold uppercase ${CONF_STYLE[d.confidence]}`}>
                          {d.confidence}
                        </span>
                      </div>
                    </div>
                    <input
                      inputMode="decimal"
                      value={d.price ?? ''}
                      placeholder="price"
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^\d.]/g, '');
                        edit(i, { price: v === '' ? null : Number(v) });
                      }}
                      className={`tabular w-24 rounded-lg border bg-background px-2 py-1.5 text-right text-sm font-semibold outline-none focus:border-ring ${
                        d.keep && (d.price === null || d.price <= 0) ? 'border-destructive' : 'border-input'
                      }`}
                      aria-label={`Price for ${d.name}`}
                    />
                  </li>
                ))}
              </ul>
            </div>

            <div className="border-t border-border p-3">
              <button
                onClick={() => void save()}
                disabled={phase === 'saving' || keptCount === 0}
                className="w-full rounded-xl bg-success text-base font-bold text-success-foreground disabled:opacity-40"
                style={{ height: 52 }}
              >
                {phase === 'saving' ? 'Adding…' : `Add ${keptCount} product${keptCount === 1 ? '' : 's'} · ${money(
                  drafts.filter((d) => d.keep).reduce((s, d) => s + (d.price ?? 0), 0),
                  currency,
                )} total`}
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
