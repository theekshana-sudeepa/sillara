import { prisma } from '../lib/prisma.js';
import { pruneSentEmails } from '../services/email/outbox.js';

/**
 * Housekeeping. None of this is urgent, all of it is the difference between a
 * database that stays fast for years and one that quietly becomes the reason
 * reports time out.
 */

export interface CleanupSummary {
  expiredTokens: number;
  oldWebhookEvents: number;
  oldJobRuns: number;
  prunedEmails: number;
  abandonedSignups: number;
}

export async function runCleanup(now = new Date()): Promise<CleanupSummary> {
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);

  // Magic-link tokens are single-use and short-lived; an expired one is dead
  // weight that only widens the search space for anyone guessing.
  const expiredTokens = await prisma.orgUser.updateMany({
    where: { magicExpiresAt: { lt: now } },
    data: { magicToken: null, magicExpiresAt: null },
  });

  // Webhook events exist to prove idempotency. Once a provider can no longer
  // retry (weeks, not months), the row is only history.
  const oldWebhookEvents = await prisma.webhookEvent.deleteMany({
    where: { createdAt: { lt: days(90) }, processedAt: { not: null } },
  });

  const oldJobRuns = await prisma.jobRun.deleteMany({
    where: { startedAt: { lt: days(30) }, status: 'SUCCEEDED' },
  });

  const prunedEmails = await pruneSentEmails(60);

  // A PENDING org is a signup that never paid. After 30 days it is not a lead,
  // it is a row holding a slug hostage.
  const abandonedSignups = await prisma.organization.deleteMany({
    where: { status: 'PENDING', createdAt: { lt: days(30) }, provisionedAt: null },
  });

  return {
    expiredTokens: expiredTokens.count,
    oldWebhookEvents: oldWebhookEvents.count,
    oldJobRuns: oldJobRuns.count,
    prunedEmails,
    abandonedSignups: abandonedSignups.count,
  };
}
