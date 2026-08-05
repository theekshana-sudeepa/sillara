import type { OrgStatus, PlanCode } from '@prisma/client';

/**
 * ---------------------------------------------------------------------------
 * THE BILLING LIFECYCLE STATE MACHINE
 * ---------------------------------------------------------------------------
 * Every subscription business eventually gets this wrong in the same way: it
 * bolts "did they pay?" onto whatever webhook happened to arrive. Webhooks get
 * dropped, providers have outages, and a shop that paid gets locked out — or
 * worse, a shop that stopped paying sells free forever.
 *
 * So the truth lives here, in a pure function of (org, now), and a nightly job
 * applies it. Webhooks are an *optimisation* that moves `currentPeriodEnd`
 * forward early; this sweep is what guarantees correctness when they don't.
 *
 * The product rule that shapes all of it: **never kill the till mid-trade.**
 * A shop whose card fails at 2pm on a Saturday keeps selling. They get a grace
 * period, they get told plainly, and nothing is ever deleted. The alternative
 * — a dead POS during a rush — is how you lose a customer permanently, and it
 * earns you nothing, because a shop that cannot sell cannot pay either.
 */

/** Days a shop keeps selling after a failed payment. */
export const GRACE_DAYS = 7;
/** Start warning this many days before a trial ends. */
export const TRIAL_WARNING_DAYS = 3;
/** At most one billing email per org per this many hours. */
export const BILLING_EMAIL_THROTTLE_HOURS = 20;

export interface LifecycleOrg {
  id: string;
  status: OrgStatus;
  planCode: PlanCode;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  graceUntil: Date | null;
  creditMonths: number;
  lastBillingEmailAt: Date | null;
}

export type LifecycleAction =
  /** Nothing due. */
  | { kind: 'none' }
  /** A referral credit covers this period — stay ACTIVE, burn one month. */
  | { kind: 'apply_credit'; periodEnd: Date; creditsLeft: number }
  /** Trial is close to ending; warn but change nothing. */
  | { kind: 'warn_trial'; daysLeft: number }
  /** Period lapsed with no credit — enter the grace window. */
  | { kind: 'past_due'; graceUntil: Date }
  /** Grace has run out — pause selling (reads still work). */
  | { kind: 'suspend' };

export const addMonths = (from: Date, months: number): Date => {
  const d = new Date(from);
  const targetMonth = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(targetMonth);
  // 31 Jan + 1 month is 28/29 Feb, not 3 March.
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
};

const daysBetween = (from: Date, to: Date): number => Math.ceil((to.getTime() - from.getTime()) / 86_400_000);

/**
 * What should happen to this org right now? Pure — no database, no clock of
 * its own, no side effects. That is what makes the rules testable and the
 * job boring.
 */
export function decideLifecycle(org: LifecycleOrg, now: Date): LifecycleAction {
  // The free tier is not a subscription. It never lapses, never dunns, never
  // suspends. Free shops that stay free forever are the top of the funnel.
  if (org.planCode === 'FREE') return { kind: 'none' };

  switch (org.status) {
    case 'TRIAL': {
      if (!org.trialEndsAt) return { kind: 'none' };
      if (org.trialEndsAt > now) {
        const daysLeft = daysBetween(now, org.trialEndsAt);
        return daysLeft <= TRIAL_WARNING_DAYS ? { kind: 'warn_trial', daysLeft } : { kind: 'none' };
      }
      return lapse(org, now);
    }

    case 'ACTIVE': {
      // No period end on a paid plan means a provider we never heard back
      // from. Treat it as due now rather than as licence to sell free.
      const end = org.currentPeriodEnd;
      if (end && end > now) return { kind: 'none' };
      return lapse(org, now);
    }

    case 'PAST_DUE': {
      const grace = org.graceUntil;
      if (!grace || grace <= now) return { kind: 'suspend' };
      return { kind: 'none' }; // still in grace — the dunning email is throttled separately
    }

    // PENDING never provisioned; SUSPENDED and CANCELLED are terminal until a
    // payment webhook or an operator moves them.
    default:
      return { kind: 'none' };
  }
}

/** A period ended. Spend a referral credit if there is one, else start grace. */
function lapse(org: LifecycleOrg, now: Date): LifecycleAction {
  if (org.creditMonths > 0) {
    // Billing periods must be contiguous: the credited month begins where the
    // last one ended, not where the sweep happened to notice. Otherwise every
    // late run silently gifts the shop the delay.
    const anchor = (org.status === 'TRIAL' ? org.trialEndsAt : org.currentPeriodEnd) ?? now;
    const contiguous = addMonths(anchor, 1);
    // Unless the sweep has been down longer than the month it would grant —
    // then a period that is already over helps nobody.
    const periodEnd = contiguous > now ? contiguous : addMonths(now, 1);
    return { kind: 'apply_credit', periodEnd, creditsLeft: org.creditMonths - 1 };
  }
  return { kind: 'past_due', graceUntil: new Date(now.getTime() + GRACE_DAYS * 86_400_000) };
}

/** Has enough time passed to send this org another billing email? */
export function mayEmail(org: Pick<LifecycleOrg, 'lastBillingEmailAt'>, now: Date): boolean {
  if (!org.lastBillingEmailAt) return true;
  return now.getTime() - org.lastBillingEmailAt.getTime() >= BILLING_EMAIL_THROTTLE_HOURS * 3_600_000;
}

/**
 * Can this org still write (sell, receive stock, edit products)?
 * Reads are never blocked — a shop must always be able to get its own data
 * out, paid or not. That is not generosity, it is the reason they trust you
 * with it in the first place.
 */
export function canWrite(status: OrgStatus): boolean {
  return status === 'TRIAL' || status === 'ACTIVE' || status === 'PAST_DUE';
}
