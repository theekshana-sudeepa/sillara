import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';
import { decideLifecycle, mayEmail, type LifecycleOrg } from '../services/lifecycle.js';
import { enqueue } from '../services/email/outbox.js';
import { trialEndingEmail, pastDueEmail, suspendedEmail, creditAppliedEmail } from '../services/email/templates.js';
import { dayKey } from './lock.js';

/**
 * The nightly sweep that makes billing true.
 *
 * It reads every org whose state could have changed, asks the pure state
 * machine what should happen, and applies it. Running it twice in a day
 * changes nothing the second time: the state transitions are idempotent by
 * construction (TRIAL→PAST_DUE only fires while status is still TRIAL) and
 * every email is guarded by a dedupeKey that includes today's date.
 */

export interface LifecycleSummary {
  scanned: number;
  creditsApplied: number;
  warned: number;
  pastDue: number;
  suspended: number;
}

const billingUrl = (orgId: string) => `${env.APP_URL}/settings/billing?org=${orgId}`;

export async function runLifecycle(now = new Date()): Promise<LifecycleSummary> {
  const summary: LifecycleSummary = { scanned: 0, creditsApplied: 0, warned: 0, pastDue: 0, suspended: 0 };
  const today = dayKey(now);

  // Only paid plans in a state that can transition. FREE shops and terminal
  // states are not even read — the sweep stays proportional to what is due,
  // not to how many shops exist.
  const orgs = await prisma.organization.findMany({
    where: {
      deletedAt: null,
      planCode: { not: 'FREE' },
      status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] },
    },
    select: {
      id: true,
      name: true,
      status: true,
      planCode: true,
      trialEndsAt: true,
      currentPeriodEnd: true,
      graceUntil: true,
      creditMonths: true,
      lastBillingEmailAt: true,
      users: {
        where: { role: 'OWNER', deletedAt: null, isActive: true },
        select: { name: true, email: true },
        take: 1,
      },
    },
  });

  for (const org of orgs) {
    summary.scanned += 1;
    const owner = org.users[0];
    const action = decideLifecycle(org as LifecycleOrg, now);

    switch (action.kind) {
      case 'none':
        break;

      case 'warn_trial': {
        if (!owner || !mayEmail(org, now)) break;
        const queued = await enqueue({
          orgId: org.id,
          template: 'trial-ending',
          to: owner.email,
          dedupeKey: `trial-ending:${org.id}:${today}`,
          ...trialEndingEmail(owner.name, org.name, action.daysLeft, billingUrl(org.id)),
        });
        if (queued) {
          await prisma.organization.update({ where: { id: org.id }, data: { lastBillingEmailAt: now } });
          summary.warned += 1;
        }
        break;
      }

      case 'apply_credit': {
        // Guarded update: only spend a credit if the row still has one and is
        // still in the status we decided from. Two sweeps racing cannot
        // double-spend a month.
        const applied = await prisma.organization.updateMany({
          where: { id: org.id, status: org.status, creditMonths: org.creditMonths },
          data: {
            status: 'ACTIVE',
            currentPeriodEnd: action.periodEnd,
            creditMonths: action.creditsLeft,
            graceUntil: null,
            trialEndsAt: null,
          },
        });
        if (applied.count === 0) break;
        summary.creditsApplied += 1;
        logger.info({ orgId: org.id, creditsLeft: action.creditsLeft }, '🎁 referral credit applied');
        if (owner) {
          await enqueue({
            orgId: org.id,
            template: 'credit-applied',
            to: owner.email,
            dedupeKey: `credit-applied:${org.id}:${today}`,
            ...creditAppliedEmail(owner.name, org.name, action.creditsLeft),
          });
        }
        break;
      }

      case 'past_due': {
        const moved = await prisma.organization.updateMany({
          where: { id: org.id, status: org.status },
          data: { status: 'PAST_DUE', graceUntil: action.graceUntil },
        });
        if (moved.count === 0) break;
        summary.pastDue += 1;
        logger.warn({ orgId: org.id, graceUntil: action.graceUntil }, '💳 org past due — grace started');
        if (owner) {
          await enqueue({
            orgId: org.id,
            template: 'past-due',
            to: owner.email,
            dedupeKey: `past-due:${org.id}:${today}`,
            ...pastDueEmail(owner.name, org.name, action.graceUntil, billingUrl(org.id)),
          });
          await prisma.organization.update({ where: { id: org.id }, data: { lastBillingEmailAt: now } });
        }
        break;
      }

      case 'suspend': {
        const moved = await prisma.organization.updateMany({
          where: { id: org.id, status: 'PAST_DUE' },
          data: { status: 'SUSPENDED', suspendedAt: now },
        });
        if (moved.count === 0) break;
        summary.suspended += 1;
        logger.warn({ orgId: org.id }, '⏸️  org suspended after grace');
        if (owner) {
          await enqueue({
            orgId: org.id,
            template: 'suspended',
            to: owner.email,
            dedupeKey: `suspended:${org.id}`,
            ...suspendedEmail(owner.name, org.name, billingUrl(org.id)),
          });
        }
        await prisma.auditLog.create({
          data: { orgId: org.id, action: 'org.suspended', entity: 'Organization', entityId: org.id, detail: { reason: 'grace expired' } },
        });
        break;
      }
    }
  }

  return summary;
}
