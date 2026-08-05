import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
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
  stuckWebhooks: number;
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

  // Rate-limit windows are minutes long; a row an hour past its expiry is
  // dead weight the store never reads again.
  await prisma.rateLimitHit.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 3_600_000) } } });

  const prunedEmails = await pruneSentEmails(60);

  // Webhooks that were claimed but never finished.
  //
  // The handler answers the provider 200 immediately, then claims the event id
  // and does the work. A crash in between leaves a row with no `processedAt`
  // and no way back: the provider believes it delivered, and the claim means a
  // retry would be treated as a replay and skipped. Nothing retries it, ever.
  //
  // This does not reprocess — replaying a payment event automatically is how
  // you bill someone twice. It surfaces them, loudly, so a human decides. The
  // nightly lifecycle sweep is what keeps billing correct meanwhile; this is
  // how you find out the sweep had to.
  const stuck = await prisma.webhookEvent.findMany({
    where: { processedAt: null, createdAt: { lt: new Date(now.getTime() - 15 * 60_000) } },
    select: { id: true, provider: true, eventId: true, eventType: true, createdAt: true },
    take: 100,
  });
  for (const event of stuck) {
    logger.error(event, '🚨 webhook claimed but never processed — needs a human');
  }

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
    stuckWebhooks: stuck.length,
  };
}
