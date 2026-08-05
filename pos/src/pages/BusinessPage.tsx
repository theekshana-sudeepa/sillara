import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, getToken } from '@/lib/api';
import { useSession } from '@/state/store';
import { money, dateOf, percent } from '@/lib/format';

/**
 * "Business" — the owner's back office: profit, loyalty settings, branches,
 * shift history, referrals and exports. Everything here is online-only and
 * manager-gated; the till never depends on it.
 *
 * Kept as one tabbed page rather than five nav items because a shop owner
 * opens it weekly, not hourly — bottom-bar space belongs to the daily work.
 */

type Tab = 'profit' | 'loyalty' | 'branches' | 'shifts' | 'grow';

interface Profit {
  days: number;
  revenue: number;
  cost: number;
  profit: number;
  marginPct: number;
  items: Array<{ name: string; qty: number; revenue: number; profit: number; marginPct: number }>;
}

interface Branch {
  id: string;
  name: string;
  code: string;
  isDefault: boolean;
  isActive: boolean;
  _count?: { registers: number; sales: number };
}

interface ShiftRow {
  id: string;
  status: string;
  openingFloat: string;
  expectedCash: string | null;
  countedCash: string | null;
  variance: string | null;
  openedAt: string;
  closedAt: string | null;
  register?: { name: string } | null;
}

interface Referral {
  code: string | null;
  shareUrl: string;
  creditMonths: number;
  referredCount: number;
}

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: 'profit', label: 'Profit', icon: '📈' },
  { id: 'loyalty', label: 'Loyalty', icon: '⭐' },
  { id: 'branches', label: 'Branches', icon: '🏬' },
  { id: 'shifts', label: 'Shifts', icon: '⏱' },
  { id: 'grow', label: 'Grow', icon: '🎁' },
];

export default function BusinessPage() {
  const { session, online } = useSession();
  const currency = session?.org.currency ?? 'USD';

  const [tab, setTab] = useState<Tab>('profit');
  const [profit, setProfit] = useState<Profit | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [shifts, setShifts] = useState<ShiftRow[]>([]);
  const [referral, setReferral] = useState<Referral | null>(null);
  const [loyalty, setLoyalty] = useState({ enabled: false, earnRate: '1', redeemValue: '0.01', minRedeem: '100' });
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const load = useCallback(async () => {
    if (!online) return;
    setError(null);
    try {
      if (tab === 'profit') setProfit(await api.get<Profit>('/reports/profit', { days: 30 }));
      if (tab === 'branches') setBranches(await api.get<Branch[]>('/branches'));
      if (tab === 'shifts') setShifts(await api.get<ShiftRow[]>('/shifts', { limit: 30 }));
      if (tab === 'grow') setReferral(await api.get<Referral>('/referrals'));
      if (tab === 'loyalty') {
        const org = await api.get<{
          loyaltyEnabled: boolean; loyaltyEarnRate: string; loyaltyRedeemValue: string; loyaltyMinRedeem: number;
        }>('/org');
        setLoyalty({
          enabled: org.loyaltyEnabled,
          earnRate: String(Number(org.loyaltyEarnRate)),
          redeemValue: String(Number(org.loyaltyRedeemValue)),
          minRedeem: String(org.loyaltyMinRedeem),
        });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load');
    }
  }, [tab, online]);

  useEffect(() => { void load(); }, [load]);

  const saveLoyalty = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.patch('/org', {
        loyaltyEnabled: loyalty.enabled,
        loyaltyEarnRate: Number(loyalty.earnRate) || 0,
        loyaltyRedeemValue: Number(loyalty.redeemValue) || 0,
        loyaltyMinRedeem: Number(loyalty.minRedeem) || 0,
      });
      flash('✓ Loyalty settings saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  const addBranch = async () => {
    const name = prompt('Branch name');
    if (!name?.trim()) return;
    try {
      await api.post('/branches', { name: name.trim() });
      flash('✓ Branch opened');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not open branch');
    }
  };

  /** Exports are authed downloads — fetch with the token, then save the blob. */
  const download = async (path: string, filename: string) => {
    try {
      const base = import.meta.env.VITE_API_URL ?? '';
      const res = await fetch(`${base}/api/v1${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error('Export failed');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
      flash('✓ Downloaded');
    } catch {
      setError('Export failed — check your connection');
    }
  };

  const input = 'h-11 w-full rounded-xl border border-input bg-background px-3 text-sm outline-none focus:border-ring';

  return (
    <div className="flex h-full flex-col">
      <div className="flex gap-1 overflow-x-auto border-b border-border p-2">
        {TABS.map((tb) => (
          <button key={tb.id} onClick={() => setTab(tb.id)} aria-pressed={tab === tb.id}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
              tab === tb.id ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>
            <span aria-hidden>{tb.icon}</span>{tb.label}
          </button>
        ))}
      </div>

      {toast ? <p role="status" className="bg-success/10 px-4 py-2 text-center text-sm font-semibold text-success">{toast}</p> : null}
      {error ? <p role="alert" className="mx-4 mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      {!online ? <p className="bg-warning/10 px-4 py-2 text-center text-sm text-warning">Offline — the back office needs a connection.</p> : null}

      <div className="flex-1 overflow-y-auto p-4">
        {/* ------------------------------------------------------- profit */}
        {tab === 'profit' ? (
          profit ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border border-border bg-card p-3">
                  <p className="text-xs text-muted-foreground">Revenue · {profit.days}d</p>
                  <p className="tabular mt-0.5 text-xl font-bold">{money(profit.revenue, currency)}</p>
                </div>
                <div className="rounded-xl border border-border bg-card p-3">
                  <p className="text-xs text-muted-foreground">Profit</p>
                  <p className="tabular mt-0.5 text-xl font-bold text-success">{money(profit.profit, currency)}</p>
                  <p className="text-[11px] text-muted-foreground">{percent(profit.marginPct)} margin</p>
                </div>
              </div>

              <p className="mt-5 text-xs font-bold uppercase tracking-wide text-muted-foreground">Most profitable items</p>
              <ul className="mt-2 divide-y divide-border rounded-xl border border-border bg-card">
                {profit.items.slice(0, 15).map((i) => (
                  <li key={i.name} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{i.name}</span>
                      <span className="tabular block text-xs text-muted-foreground">{i.qty} sold · {percent(i.marginPct)} margin</span>
                    </span>
                    <span className="tabular shrink-0 text-sm font-bold text-success">{money(i.profit, currency)}</span>
                  </li>
                ))}
                {profit.items.length === 0 ? <li className="px-3 py-6 text-center text-sm text-muted-foreground">No sales yet</li> : null}
              </ul>

              <p className="mt-6 text-xs font-bold uppercase tracking-wide text-muted-foreground">Exports</p>
              <div className="mt-2 grid gap-2">
                <button onClick={() => void download('/reports/export/sales', 'sillara-sales.csv')} className="h-11 rounded-xl bg-secondary text-sm font-semibold">⬇ Sales (CSV)</button>
                <button onClick={() => void download('/reports/export/items', 'sillara-items.csv')} className="h-11 rounded-xl bg-secondary text-sm font-semibold">⬇ Sold items (CSV)</button>
                <button onClick={() => void download('/reports/export/stock', 'sillara-stock.csv')} className="h-11 rounded-xl bg-secondary text-sm font-semibold">⬇ Stock valuation (CSV)</button>
              </div>
            </>
          ) : <p className="py-10 text-center text-sm text-muted-foreground">…</p>
        ) : null}

        {/* ------------------------------------------------------ loyalty */}
        {tab === 'loyalty' ? (
          <>
            <label className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
              <input type="checkbox" checked={loyalty.enabled} onChange={(e) => setLoyalty({ ...loyalty, enabled: e.target.checked })} className="size-5" />
              <span className="flex-1">
                <span className="block text-sm font-semibold">Loyalty points</span>
                <span className="block text-xs text-muted-foreground">Customers earn on every purchase and spend at the till.</span>
              </span>
            </label>

            <div className="mt-4 grid gap-3">
              <label className="block">
                <span className="block text-xs font-bold uppercase tracking-wide text-muted-foreground">Points earned per 1 {currency}</span>
                <input inputMode="decimal" value={loyalty.earnRate} onChange={(e) => setLoyalty({ ...loyalty, earnRate: e.target.value.replace(/[^\d.]/g, '') })} className={`tabular mt-1 ${input}`} />
              </label>
              <label className="block">
                <span className="block text-xs font-bold uppercase tracking-wide text-muted-foreground">Value of 1 point ({currency})</span>
                <input inputMode="decimal" value={loyalty.redeemValue} onChange={(e) => setLoyalty({ ...loyalty, redeemValue: e.target.value.replace(/[^\d.]/g, '') })} className={`tabular mt-1 ${input}`} />
              </label>
              <label className="block">
                <span className="block text-xs font-bold uppercase tracking-wide text-muted-foreground">Minimum points before spending</span>
                <input inputMode="numeric" value={loyalty.minRedeem} onChange={(e) => setLoyalty({ ...loyalty, minRedeem: e.target.value.replace(/[^\d]/g, '') })} className={`tabular mt-1 ${input}`} />
              </label>
            </div>

            <p className="mt-3 rounded-xl bg-secondary/60 p-3 text-xs text-muted-foreground">
              With these settings, spending {money(1000, currency)} earns{' '}
              <strong className="text-foreground">{Math.floor(1000 * (Number(loyalty.earnRate) || 0))} points</strong>, worth{' '}
              <strong className="text-foreground">{money(1000 * (Number(loyalty.earnRate) || 0) * (Number(loyalty.redeemValue) || 0), currency)}</strong> off a future purchase.
            </p>

            <button onClick={() => void saveLoyalty()} disabled={busy} className="mt-4 h-12 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground disabled:opacity-50">
              {busy ? 'Saving…' : 'Save loyalty settings'}
            </button>
          </>
        ) : null}

        {/* ----------------------------------------------------- branches */}
        {tab === 'branches' ? (
          <>
            <ul className="divide-y divide-border rounded-xl border border-border bg-card">
              {branches.map((b) => (
                <li key={b.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {b.name} {b.isDefault ? <span className="ml-1 rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-bold text-primary">MAIN</span> : null}
                    </span>
                    <span className="tabular block text-xs text-muted-foreground">
                      {b.code} · {b._count?.registers ?? 0} till{(b._count?.registers ?? 0) === 1 ? '' : 's'} · {b._count?.sales ?? 0} sales
                    </span>
                  </span>
                  {!b.isActive ? <span className="text-xs text-muted-foreground">inactive</span> : null}
                </li>
              ))}
            </ul>
            <button onClick={() => void addBranch()} className="mt-4 h-12 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground">
              + Open another branch
            </button>
            <p className="mt-2 text-center text-xs text-muted-foreground">Multiple branches are a Pro feature.</p>
          </>
        ) : null}

        {/* ------------------------------------------------------- shifts */}
        {tab === 'shifts' ? (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {shifts.map((s) => {
              const variance = s.variance === null ? null : Number(s.variance);
              return (
                <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {dateOf(s.openedAt)}{s.register ? ` · ${s.register.name}` : ''}
                    </span>
                    <span className="tabular block text-xs text-muted-foreground">
                      Float {money(Number(s.openingFloat), currency)}
                      {s.countedCash !== null ? ` · counted ${money(Number(s.countedCash), currency)}` : ''}
                    </span>
                  </span>
                  {s.status === 'OPEN' ? (
                    <span className="shrink-0 rounded-full bg-success/15 px-2 py-0.5 text-[10px] font-bold text-success">OPEN</span>
                  ) : variance !== null ? (
                    <span className={`tabular shrink-0 text-sm font-bold ${
                      variance === 0 ? 'text-success' : variance > 0 ? 'text-info' : 'text-destructive'}`}>
                      {variance === 0 ? '✓' : `${variance > 0 ? '+' : ''}${money(variance, currency)}`}
                    </span>
                  ) : null}
                </li>
              );
            })}
            {shifts.length === 0 ? <li className="px-4 py-8 text-center text-sm text-muted-foreground">No shifts recorded yet</li> : null}
          </ul>
        ) : null}

        {/* --------------------------------------------------------- grow */}
        {tab === 'grow' && referral ? (
          <>
            <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 text-center">
              <p className="text-sm text-muted-foreground">Your referral code</p>
              <p className="tabular mt-1 text-3xl font-bold tracking-widest text-primary">{referral.code}</p>
              <p className="mt-3 text-sm text-muted-foreground">
                Every shop that signs up with your code gets a free month — and so do you.
              </p>
              <button
                onClick={() => { void navigator.clipboard.writeText(referral.shareUrl); flash('✓ Link copied'); }}
                className="mt-4 h-11 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground"
              >
                Copy invite link
              </button>
              <a
                href={`https://wa.me/?text=${encodeURIComponent(`I run my shop on Sillara — it works offline and sets itself up in minutes. Use my link and we both get a free month: ${referral.shareUrl}`)}`}
                target="_blank" rel="noreferrer noopener"
                className="mt-2 grid h-11 place-items-center rounded-xl bg-[#25D366] text-sm font-bold text-white"
              >
                Share on WhatsApp
              </a>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-border bg-card p-3 text-center">
                <p className="tabular text-2xl font-bold">{referral.referredCount}</p>
                <p className="text-xs text-muted-foreground">shops referred</p>
              </div>
              <div className="rounded-xl border border-border bg-card p-3 text-center">
                <p className="tabular text-2xl font-bold text-success">{referral.creditMonths}</p>
                <p className="text-xs text-muted-foreground">free months earned</p>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
