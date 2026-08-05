import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { money } from '@/lib/format';

/**
 * Billing state, in the shop owner's words.
 *
 * Without this, a shop whose card failed discovers it as a 402 on the Charge
 * button during a queue — no explanation, no way to fix it, one furious phone
 * call. The rule is that the app tells them *before* the till does.
 */

interface Billing {
  status: 'PENDING' | 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CANCELLED';
  canSell: boolean;
  plan: { code: string; name: string; priceUsd: string | number; priceLkr: string | number };
  currency: string;
  renewsAt: string | null;
  daysLeft: number | null;
  graceUntil: string | null;
  graceDaysLeft: number | null;
  creditMonths: number;
  message: string | null;
}

const TONE: Record<Billing['status'], { chip: string; label: string }> = {
  PENDING: { chip: 'bg-secondary text-muted-foreground', label: 'Setting up' },
  TRIAL: { chip: 'bg-primary/15 text-primary', label: 'Trial' },
  ACTIVE: { chip: 'bg-success/15 text-success', label: 'Active' },
  PAST_DUE: { chip: 'bg-warning/15 text-warning', label: 'Payment due' },
  SUSPENDED: { chip: 'bg-destructive/15 text-destructive', label: 'Paused' },
  CANCELLED: { chip: 'bg-destructive/15 text-destructive', label: 'Closed' },
};

export function BillingCard() {
  const [billing, setBilling] = useState<Billing | null>(null);

  useEffect(() => {
    // Read-only, and reads are never blocked — this loads even when selling
    // is paused, which is exactly when it matters most.
    void api.get<Billing>('/org/billing').then(setBilling).catch(() => setBilling(null));
  }, []);

  if (!billing) return null;
  const tone = TONE[billing.status];
  const price = billing.currency === 'LKR' ? billing.plan.priceLkr : billing.plan.priceUsd;

  return (
    <div className="mt-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">{billing.plan.name} plan</p>
        <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${tone.chip}`}>{tone.label}</span>
      </div>

      {billing.plan.code !== 'FREE' ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {money(Number(price), billing.currency)} / month
          {billing.renewsAt ? ` · renews ${new Date(billing.renewsAt).toLocaleDateString()}` : ''}
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">Free forever · upgrade any time</p>
      )}

      {billing.message ? (
        <p className={`mt-3 text-xs leading-5 ${billing.canSell ? 'text-muted-foreground' : 'text-destructive'}`}>
          {billing.message}
        </p>
      ) : null}

      {billing.graceDaysLeft !== null && billing.graceDaysLeft > 0 ? (
        <p className="mt-2 text-xs font-semibold text-warning">
          {billing.graceDaysLeft} {billing.graceDaysLeft === 1 ? 'day' : 'days'} of grace left — the till keeps working.
        </p>
      ) : null}

      {billing.creditMonths > 0 ? (
        <p className="mt-2 text-xs font-semibold text-success">
          🎁 {billing.creditMonths} free {billing.creditMonths === 1 ? 'month' : 'months'} from referrals
        </p>
      ) : null}
    </div>
  );
}
