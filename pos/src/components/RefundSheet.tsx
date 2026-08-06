import { useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { money, receiptNo } from '@/lib/format';

/**
 * Give some of a sale back.
 *
 * A void says "this never happened" and only works on the whole thing. A
 * refund is a real event: the customer keeps two of the three, hands one back,
 * and gets money for it. The server writes a credit note — its own numbered
 * receipt, with negative lines and negative payments — so takings, tax, margin
 * and the drawer all net it out on their own.
 *
 * The amount shown here is indicative. The server recomputes it from the
 * original line's share of the discount and tax, and the till never tells it
 * how much to hand over.
 */

export interface RefundableSale {
  id: string;
  number: number;
  total: string;
  tender: string;
  soldAt: string;
  items: Array<{
    id: string;
    nameSnapshot: string;
    qty: string;
    refundedQty: string;
    unitPrice: string;
    lineTotal: string;
  }>;
}

type Tender = 'CASH' | 'CARD' | 'QR' | 'OTHER';
const TENDERS: Tender[] = ['CASH', 'CARD', 'QR', 'OTHER'];

export function RefundSheet({
  sale,
  currency,
  onClose,
  onDone,
}: {
  sale: RefundableSale;
  currency: string;
  onClose: () => void;
  onDone: (summary: string) => void;
}) {
  // How many of each line to give back, keyed by sale item.
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState('');
  const [tender, setTender] = useState<Tender>(
    TENDERS.includes(sale.tender as Tender) ? (sale.tender as Tender) : 'CASH',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = useMemo(
    () =>
      sale.items.map((item) => {
        const sold = Number(item.qty);
        const already = Number(item.refundedQty);
        return { ...item, sold, already, remaining: Math.max(0, sold - already) };
      }),
    [sale.items],
  );

  const anythingLeft = lines.some((l) => l.remaining > 0);

  // Indicative only — proportional to the line, same as the server does.
  const estimate = lines.reduce((sum, l) => {
    const giving = qty[l.id] ?? 0;
    if (giving <= 0 || l.sold <= 0) return sum;
    return sum + (Number(l.lineTotal) * giving) / l.sold;
  }, 0);

  const chosen = lines.filter((l) => (qty[l.id] ?? 0) > 0);
  const canSubmit = chosen.length > 0 && reason.trim().length >= 3 && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ number: number }>(`/sales/${sale.id}/refund`, {
        reason: reason.trim(),
        lines: chosen.map((l) => ({ saleItemId: l.id, qty: qty[l.id] })),
        // Server works out the amount; sending our own risks a cent's
        // disagreement rejecting the whole settlement.
        refundTender: tender,
      });
      onDone(`✓ Refunded on credit note ${receiptNo(result.number)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Refund failed — try again');
      setBusy(false);
    }
  };

  const step = (id: string, delta: number, max: number) =>
    setQty((prev) => ({ ...prev, [id]: Math.max(0, Math.min(max, (prev[id] ?? 0) + delta)) }));

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div className="flex max-h-[92vh] w-full max-w-lg flex-col rounded-t-2xl bg-card sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="border-b border-border p-4">
          <h2 className="text-lg font-bold">Refund {receiptNo(sale.number)}</h2>
          <p className="text-xs text-muted-foreground">
            Choose what is coming back. Everything else stays sold.
          </p>
        </div>

        {!anythingLeft ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            Every line on this receipt has already been refunded.
          </p>
        ) : (
          <>
            <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
              {lines.map((l) => (
                <li key={l.id} className={`px-4 py-3 ${l.remaining === 0 ? 'opacity-40' : ''}`}>
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{l.nameSnapshot}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {l.sold} sold at {money(Number(l.unitPrice), currency)}
                        {l.already > 0 ? ` · ${l.already} already refunded` : ''}
                      </p>
                    </div>

                    {l.remaining > 0 ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          onClick={() => step(l.id, -1, l.remaining)}
                          disabled={(qty[l.id] ?? 0) === 0}
                          aria-label={`One fewer ${l.nameSnapshot}`}
                          className="pressable grid size-9 place-items-center rounded-lg bg-secondary text-lg font-bold disabled:opacity-30"
                        >
                          −
                        </button>
                        <span className="tabular w-8 text-center text-sm font-bold">{qty[l.id] ?? 0}</span>
                        <button
                          onClick={() => step(l.id, 1, l.remaining)}
                          disabled={(qty[l.id] ?? 0) >= l.remaining}
                          aria-label={`One more ${l.nameSnapshot}`}
                          className="pressable grid size-9 place-items-center rounded-lg bg-secondary text-lg font-bold disabled:opacity-30"
                        >
                          +
                        </button>
                      </div>
                    ) : (
                      <span className="shrink-0 text-[11px] font-semibold text-muted-foreground">refunded</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <div className="border-t border-border p-4">
              <label className="block">
                <span className="text-[11px] font-bold uppercase tracking-[0.07em] text-muted-foreground">
                  Reason
                </span>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Faulty, wrong size, changed their mind…"
                  className="mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-ring"
                />
              </label>

              <p className="mt-3 text-[11px] font-bold uppercase tracking-[0.07em] text-muted-foreground">
                Refund to
              </p>
              <div className="mt-1.5 grid grid-cols-4 gap-2" role="group" aria-label="Refund method">
                {TENDERS.map((option) => (
                  <button
                    key={option}
                    onClick={() => setTender(option)}
                    aria-pressed={tender === option}
                    className={`h-10 rounded-lg text-[12px] font-bold transition-colors ${
                      tender === option ? 'bg-primary text-primary-foreground' : 'bg-secondary'
                    }`}
                  >
                    {option}
                  </button>
                ))}
              </div>

              {error ? (
                <p role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-[13px] font-medium text-destructive">
                  {error}
                </p>
              ) : null}

              <div className="mt-4 flex items-baseline justify-between">
                <span className="text-sm text-muted-foreground">Approximate refund</span>
                <span className="tabular text-xl font-bold">{money(Math.round(estimate * 100) / 100, currency)}</span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <button onClick={onClose} className="h-12 rounded-xl bg-secondary text-sm font-semibold">
                  Cancel
                </button>
                <button
                  onClick={() => void submit()}
                  disabled={!canSubmit}
                  className="h-12 rounded-xl bg-destructive text-sm font-bold text-destructive-foreground disabled:opacity-50"
                >
                  {busy ? 'Refunding…' : 'Refund'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
