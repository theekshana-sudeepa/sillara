import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/state/store';
import { pendingSales } from '@/lib/db';
import { money, timeOf } from '@/lib/format';

/**
 * Cash-drawer session UI.
 *
 * The close screen deliberately shows *expected* beside the count box: the
 * cashier types what's physically in the drawer and sees the variance the
 * instant they finish. Hiding the expected figure until after submission
 * would be more "secure" on paper and worse in practice — it turns an honest
 * miscount into a dispute rather than a correction.
 */

export interface Shift {
  id: string;
  status: 'OPEN' | 'CLOSED';
  openingFloat: string;
  openedAt: string;
  register?: { name: string } | null;
  branch?: { name: string } | null;
}

interface Summary {
  salesCount: number;
  gross: number;
  discounts: number;
  loyaltyDiscounts: number;
  openingFloat: number;
  cashSales: number;
  expectedCash: number;
  byTender: Array<{ tender: string; total: number; count: number }>;
}

export function ShiftPanel({ onClose, onChanged }: { onClose: () => void; onChanged: (shift: Shift | null) => void }) {
  const { session } = useSession();
  const currency = session?.org.currency ?? 'USD';

  const [shift, setShift] = useState<Shift | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [floatInput, setFloatInput] = useState('');
  const [countInput, setCountInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingBlock, setPendingBlock] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const current = await api.get<Shift | null>('/shifts/current');
      setShift(current);
      if (current) setSummary(await api.get<Summary>(`/shifts/${current.id}/summary`));
    } catch { /* offline — the panel is online-only, the till is not */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.post<Shift>('/shifts/open', { openingFloat: Number(floatInput) || 0 });
      setShift(created);
      onChanged(created);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open the shift');
    } finally {
      setBusy(false);
    }
  };

  const close = async (force = false) => {
    if (!shift) return;
    setBusy(true);
    setError(null);
    try {
      // The server computes expected cash from sales it has received. Anything
      // still in this device's outbox is money in the drawer that it cannot
      // see, so it has to be told — otherwise the cashier is shown a shortage
      // they did not cause.
      const stillQueued = (await pendingSales()).length;

      await api.post(`/shifts/${shift.id}/close`, {
        countedCash: Number(countInput) || 0,
        pendingCount: stillQueued,
        force,
      });
      onChanged(null);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT' && !force) {
        setPendingBlock(err.message);
        setBusy(false);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not close the shift');
      setBusy(false);
    }
  };

  const counted = Number(countInput) || 0;
  const variance = summary ? Math.round((counted - summary.expectedCash) * 100) / 100 : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-t-2xl bg-card p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        {loading ? (
          <div className="grid place-items-center py-10">
            <div className="size-8 animate-spin rounded-full border-2 border-border border-t-primary" />
          </div>
        ) : !shift ? (
          <>
            <h2 className="text-lg font-bold">Open shift</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Count the cash you're starting with. Everything sold until you close is tied to this shift.
            </p>

            {error ? <p role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

            <label htmlFor="float" className="mt-4 block text-xs font-bold uppercase tracking-wide text-muted-foreground">
              Opening float
            </label>
            <input id="float" inputMode="decimal" value={floatInput} autoFocus
              onChange={(e) => setFloatInput(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0"
              className="tabular mt-1 h-14 w-full rounded-xl border border-input bg-background px-4 text-center text-2xl font-bold outline-none focus:border-ring" />

            <button onClick={() => void open()} disabled={busy}
              className="mt-5 h-13 w-full rounded-xl bg-primary text-base font-bold text-primary-foreground disabled:opacity-50" style={{ height: 52 }}>
              {busy ? 'Opening…' : 'Start shift'}
            </button>
          </>
        ) : (
          <>
            <h2 className="text-lg font-bold">Close shift</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Opened {timeOf(shift.openedAt)}{shift.register ? ` · ${shift.register.name}` : ''}
              {summary ? ` · ${summary.salesCount} sale${summary.salesCount === 1 ? '' : 's'}` : ''}
            </p>

            {error ? <p role="alert" className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}

            {summary ? (
              <>
                <dl className="mt-4 space-y-1.5 rounded-xl bg-secondary/60 p-3 text-sm">
                  <div className="flex justify-between"><dt className="text-muted-foreground">Opening float</dt><dd className="tabular">{money(summary.openingFloat, currency)}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">Cash sales</dt><dd className="tabular">{money(summary.cashSales, currency)}</dd></div>
                  {summary.byTender.filter((t) => t.tender !== 'CASH').map((t) => (
                    <div key={t.tender} className="flex justify-between text-muted-foreground">
                      <dt>{t.tender} ({t.count})</dt><dd className="tabular">{money(t.total, currency)}</dd>
                    </div>
                  ))}
                  <div className="flex justify-between border-t border-border pt-1.5 font-bold">
                    <dt>Expected in drawer</dt><dd className="tabular">{money(summary.expectedCash, currency)}</dd>
                  </div>
                </dl>

                <label htmlFor="counted" className="mt-4 block text-xs font-bold uppercase tracking-wide text-muted-foreground">
                  Counted cash
                </label>
                <input id="counted" inputMode="decimal" value={countInput} autoFocus
                  onChange={(e) => setCountInput(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0"
                  className="tabular mt-1 h-14 w-full rounded-xl border border-input bg-background px-4 text-center text-2xl font-bold outline-none focus:border-ring" />

                {countInput ? (
                  <p className={`mt-2 text-center text-sm font-bold ${
                    variance === 0 ? 'text-success' : variance > 0 ? 'text-info' : 'text-destructive'}`}>
                    {variance === 0 ? '✓ Balanced' : variance > 0 ? `Over by ${money(variance, currency)}` : `Short by ${money(Math.abs(variance), currency)}`}
                  </p>
                ) : null}
              </>
            ) : null}

            {pendingBlock ? (
              <div className="mt-4 rounded-xl border border-warning/30 bg-warning/10 p-3.5">
                <p className="text-[13px] font-medium text-foreground">{pendingBlock}</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setPendingBlock(null)}
                    className="h-11 rounded-lg bg-secondary text-[13px] font-semibold"
                  >
                    Wait and retry
                  </button>
                  <button
                    onClick={() => void close(true)}
                    disabled={busy}
                    className="h-11 rounded-lg bg-destructive text-[13px] font-bold text-destructive-foreground disabled:opacity-50"
                  >
                    Close anyway
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-5 grid grid-cols-2 gap-2">
                <button onClick={onClose} className="h-12 rounded-xl bg-secondary text-sm font-semibold">Keep selling</button>
                <button onClick={() => void close()} disabled={busy || !countInput}
                  className="h-12 rounded-xl bg-primary text-sm font-bold text-primary-foreground disabled:opacity-50">
                  {busy ? 'Closing…' : 'Close shift'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
