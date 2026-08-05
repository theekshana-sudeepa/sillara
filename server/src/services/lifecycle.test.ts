import { describe, it, expect } from 'vitest';
import {
  decideLifecycle,
  addMonths,
  mayEmail,
  canWrite,
  GRACE_DAYS,
  type LifecycleOrg,
} from './lifecycle.js';

/**
 * The billing state machine decides whether a shop can trade. Getting it
 * wrong in one direction gives the product away; in the other it kills a
 * paying customer's till during a rush. Both are pinned here.
 */

const NOW = new Date('2026-08-01T12:00:00.000Z');
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

const org = (over: Partial<LifecycleOrg> = {}): LifecycleOrg => ({
  id: 'org1',
  status: 'ACTIVE',
  planCode: 'SHOP',
  trialEndsAt: null,
  currentPeriodEnd: days(20),
  graceUntil: null,
  creditMonths: 0,
  lastBillingEmailAt: null,
  ...over,
});

describe('addMonths', () => {
  it('does not overflow a short month', () => {
    // The classic: 31 Jan + 1 month must be 28 Feb, not 3 March.
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(addMonths(new Date('2024-01-31T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2024-02-29'); // leap
    expect(addMonths(new Date('2026-08-31T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-09-30');
  });

  it('rolls the year over', () => {
    expect(addMonths(new Date('2026-12-15T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2027-01-15');
  });

  it('keeps the time of day', () => {
    expect(addMonths(new Date('2026-03-10T08:45:30Z'), 1).toISOString()).toBe('2026-04-10T08:45:30.000Z');
  });
});

describe('the free tier is not a subscription', () => {
  it('never lapses, whatever the dates say', () => {
    const free = org({ planCode: 'FREE', status: 'ACTIVE', currentPeriodEnd: days(-400), creditMonths: 0 });
    expect(decideLifecycle(free, NOW)).toEqual({ kind: 'none' });
  });

  it('never dunns a free trial either', () => {
    expect(decideLifecycle(org({ planCode: 'FREE', status: 'TRIAL', trialEndsAt: days(-9) }), NOW)).toEqual({ kind: 'none' });
  });
});

describe('trials', () => {
  it('says nothing until the warning window opens', () => {
    expect(decideLifecycle(org({ status: 'TRIAL', trialEndsAt: days(9) }), NOW)).toEqual({ kind: 'none' });
  });

  it('warns inside the last three days', () => {
    expect(decideLifecycle(org({ status: 'TRIAL', trialEndsAt: days(2) }), NOW)).toEqual({ kind: 'warn_trial', daysLeft: 2 });
  });

  it('an expired trial with no credit enters grace, it does not stop the till', () => {
    const action = decideLifecycle(org({ status: 'TRIAL', trialEndsAt: days(-1) }), NOW);
    expect(action.kind).toBe('past_due');
    if (action.kind !== 'past_due') throw new Error('unreachable');
    expect(action.graceUntil).toEqual(days(GRACE_DAYS));
  });

  it('an expired trial with a referral credit becomes a paid month', () => {
    const trialEnd = days(-1);
    const action = decideLifecycle(
      org({ status: 'TRIAL', trialEndsAt: trialEnd, currentPeriodEnd: null, creditMonths: 2 }),
      NOW,
    );
    // Contiguous: the credited month runs from where the trial ended.
    expect(action).toEqual({ kind: 'apply_credit', periodEnd: addMonths(trialEnd, 1), creditsLeft: 1 });
  });
});

describe('active subscriptions', () => {
  it('leaves a paid-up shop alone', () => {
    expect(decideLifecycle(org(), NOW)).toEqual({ kind: 'none' });
  });

  it('treats a paid plan with no period end as due now, not as free forever', () => {
    // The webhook never arrived. Selling free indefinitely is the failure mode
    // this branch exists to prevent.
    expect(decideLifecycle(org({ currentPeriodEnd: null }), NOW).kind).toBe('past_due');
  });

  it('spends a credit rather than dunning', () => {
    const lastPeriodEnd = days(-2);
    const action = decideLifecycle(org({ currentPeriodEnd: lastPeriodEnd, creditMonths: 1 }), NOW);
    // Periods stay contiguous — the new month starts where the old one ended,
    // so a sweep that ran two days late does not gift two days.
    expect(action).toEqual({ kind: 'apply_credit', periodEnd: addMonths(lastPeriodEnd, 1), creditsLeft: 0 });
  });

  it('falls forward to now when the sweep has been down longer than a month', () => {
    // Granting a period that is already over would leave the shop lapsed
    // again the instant the credit was spent.
    const action = decideLifecycle(org({ currentPeriodEnd: days(-45), creditMonths: 1 }), NOW);
    if (action.kind !== 'apply_credit') throw new Error('expected a credit');
    expect(action.periodEnd).toEqual(addMonths(NOW, 1));
    expect(action.periodEnd.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe('grace and suspension', () => {
  it('does nothing while grace is running — the till keeps working', () => {
    expect(decideLifecycle(org({ status: 'PAST_DUE', graceUntil: days(3) }), NOW)).toEqual({ kind: 'none' });
  });

  it('suspends once grace has run out', () => {
    expect(decideLifecycle(org({ status: 'PAST_DUE', graceUntil: days(-1) }), NOW)).toEqual({ kind: 'suspend' });
  });

  it('suspends a PAST_DUE row that somehow has no grace date', () => {
    expect(decideLifecycle(org({ status: 'PAST_DUE', graceUntil: null }), NOW)).toEqual({ kind: 'suspend' });
  });

  it('leaves terminal states alone', () => {
    for (const status of ['SUSPENDED', 'CANCELLED', 'PENDING'] as const) {
      expect(decideLifecycle(org({ status }), NOW)).toEqual({ kind: 'none' });
    }
  });
});

describe('the sweep is safe to run twice', () => {
  it('a shop that just went past due is not suspended by the next run', () => {
    const first = decideLifecycle(org({ status: 'TRIAL', trialEndsAt: days(-1) }), NOW);
    if (first.kind !== 'past_due') throw new Error('expected past_due');

    // Apply it, then run again an hour later.
    const after = org({ status: 'PAST_DUE', graceUntil: first.graceUntil, trialEndsAt: days(-1) });
    expect(decideLifecycle(after, new Date(NOW.getTime() + 3_600_000))).toEqual({ kind: 'none' });
  });
});

describe('email throttling', () => {
  it('allows the first email', () => {
    expect(mayEmail({ lastBillingEmailAt: null }, NOW)).toBe(true);
  });
  it('blocks a second one the same day', () => {
    expect(mayEmail({ lastBillingEmailAt: days(-0.5) }, NOW)).toBe(false);
  });
  it('allows one the next day', () => {
    expect(mayEmail({ lastBillingEmailAt: days(-1) }, NOW)).toBe(true);
  });
});

describe('canWrite', () => {
  it('lets trialing, active and past-due shops sell', () => {
    expect(canWrite('TRIAL')).toBe(true);
    expect(canWrite('ACTIVE')).toBe(true);
    expect(canWrite('PAST_DUE')).toBe(true); // grace: never kill the till mid-trade
  });
  it('stops suspended, cancelled and unprovisioned ones', () => {
    expect(canWrite('SUSPENDED')).toBe(false);
    expect(canWrite('CANCELLED')).toBe(false);
    expect(canWrite('PENDING')).toBe(false);
  });
});
