import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/state/store';
import { money } from '@/lib/format';

export interface PickedCustomer {
  id: string;
  name: string;
  phone: string | null;
  points: number;
  canRedeem: boolean;
  minRedeem: number;
  redeemValue: number;
}

interface Balance {
  customer: { id: string; name: string; phone: string | null; loyaltyPoints: string };
  points: number;
  value: number;
  canRedeem: boolean;
  minRedeem: number;
  enabled: boolean;
}

/**
 * Attach a customer to the sale so loyalty applies.
 *
 * Online-only by design: points are money, and a device that has been offline
 * for six hours cannot know a customer's real balance. The till keeps selling
 * without it — loyalty is an enhancement to a sale, never a precondition.
 */
export function CustomerPicker({
  onPick,
  onClose,
}: {
  onPick: (customer: PickedCustomer | null) => void;
  onClose: () => void;
}) {
  const { session, online } = useSession();
  const currency = session?.org.currency ?? 'USD';

  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Array<{ id: string; name: string; phone: string | null; loyaltyPoints: string }>>([]);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!online) return;
    const timer = setTimeout(async () => {
      try {
        setResults(await api.get<typeof results>('/customers', search ? { search } : undefined));
      } catch { /* leave the list as-is */ }
    }, 250);
    return () => clearTimeout(timer);
  }, [search, online]);

  const pick = async (customerId: string) => {
    setBusy(true);
    try {
      const balance = await api.get<Balance>(`/loyalty/balance/${customerId}`);
      onPick({
        id: balance.customer.id,
        name: balance.customer.name,
        phone: balance.customer.phone,
        points: balance.points,
        canRedeem: balance.canRedeem,
        minRedeem: balance.minRedeem,
        redeemValue: balance.points > 0 ? balance.value / balance.points : 0,
      });
    } catch {
      onPick(null);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (newName.trim().length < 1) return;
    setBusy(true);
    try {
      const created = await api.post<{ id: string }>('/customers', {
        name: newName.trim(),
        phone: newPhone.trim() || null,
      });
      await pick(created.id);
    } catch {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/50 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-t-2xl bg-card sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border p-4">
          <h2 className="text-lg font-bold">Customer</h2>
          <button onClick={onClose} className="grid size-9 place-items-center rounded-lg bg-secondary text-sm" aria-label="Close">✕</button>
        </div>

        {!online ? (
          <p className="m-4 rounded-lg bg-warning/15 px-3 py-2.5 text-sm text-warning">
            Offline — loyalty needs a connection. The sale works fine without a customer attached.
          </p>
        ) : creating ? (
          <div className="flex flex-col gap-3 p-4">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Customer name" autoFocus
              className="h-12 rounded-xl border border-input bg-background px-4 text-sm outline-none focus:border-ring" />
            <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="Phone (for WhatsApp receipts)" type="tel"
              className="h-12 rounded-xl border border-input bg-background px-4 text-sm outline-none focus:border-ring" />
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setCreating(false)} className="h-12 rounded-xl bg-secondary text-sm font-semibold">Back</button>
              <button onClick={() => void create()} disabled={busy || !newName.trim()}
                className="h-12 rounded-xl bg-primary text-sm font-bold text-primary-foreground disabled:opacity-50">
                {busy ? 'Adding…' : 'Add & attach'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="p-4 pb-2">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or phone…" autoFocus
                className="h-12 w-full rounded-xl border border-input bg-secondary/50 px-4 text-sm outline-none focus:border-ring focus:bg-background" />
            </div>

            <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
              {results.map((c) => (
                <li key={c.id}>
                  <button onClick={() => void pick(c.id)} disabled={busy}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/50">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{c.name}</span>
                      {c.phone ? <span className="block text-xs text-muted-foreground">{c.phone}</span> : null}
                    </span>
                    {Number(c.loyaltyPoints) > 0 ? (
                      <span className="tabular shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-bold text-primary">
                        {Number(c.loyaltyPoints)} pts
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
              {results.length === 0 ? (
                <li className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {search ? 'No match' : 'No customers yet'}
                </li>
              ) : null}
            </ul>

            <div className="grid grid-cols-2 gap-2 border-t border-border p-3">
              <button onClick={() => onPick(null)} className="h-12 rounded-xl bg-secondary text-sm font-semibold">No customer</button>
              <button onClick={() => { setNewName(search); setCreating(true); }}
                className="h-12 rounded-xl bg-primary text-sm font-bold text-primary-foreground">+ New customer</button>
            </div>
          </>
        )}
        <p className="pb-3 text-center text-[11px] text-muted-foreground">
          Points are calculated on the server when the sale syncs — {money(0, currency).replace(/[\d.,]+/, '')}values shown are indicative.
        </p>
      </div>
    </div>
  );
}
