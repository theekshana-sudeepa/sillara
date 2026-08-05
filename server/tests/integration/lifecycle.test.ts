import { it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { describeDb, createShop, saleBody, closeDb, type Shop } from './fixtures.js';

/**
 * The billing engine, end to end: does a suspended shop actually stop selling,
 * does a re-run of a job change anything, and can the same email go out twice?
 *
 * The unit tests prove the state machine decides correctly. These prove the
 * decisions reach the database and the HTTP layer.
 */

let prisma: PrismaClient;

beforeAll(async () => {
  ({ prisma } = await import('../../src/lib/prisma.js'));
});

afterAll(closeDb);

// ---------------------------------------------------------------------------

describeDb('enforcement: a suspended shop is read-only, not locked out', () => {
  let shop: Shop;

  beforeAll(async () => {
    shop = await createShop('Suspended Shop');
    // Sell one thing while healthy, so there is history to read back later.
    await shop.api('post', '/sales/sync').send({ sales: [saleBody()] });
  });

  it('sells normally while ACTIVE', async () => {
    const res = await shop.api('post', '/sales/sync').send({ sales: [saleBody()] });
    expect(res.body.data.results[0].status).toBe('created');
  });

  it('keeps selling through PAST_DUE — the grace period is the point', async () => {
    await prisma.organization.update({
      where: { id: shop.orgId },
      data: { status: 'PAST_DUE', graceUntil: new Date(Date.now() + 3 * 86_400_000) },
    });
    await waitForCache();

    const res = await shop.api('post', '/sales/sync').send({ sales: [saleBody()] });
    expect(res.status).toBe(200);
    expect(res.body.data.results[0].status).toBe('created');
  });

  it('refuses to sell once SUSPENDED', async () => {
    await prisma.organization.update({ where: { id: shop.orgId }, data: { status: 'SUSPENDED' } });
    await waitForCache();

    const res = await shop.api('post', '/sales/sync').send({ sales: [saleBody()] });
    expect(res.status).toBe(402);
    expect(res.body.error.code).toBe('ORG_SUSPENDED');
  });

  it('blocks every other write too, not just sales', async () => {
    const product = await shop.api('post', '/products').send({ name: 'Nope', price: 10 });
    expect(product.status).toBe(402);

    const customer = await shop.api('post', '/customers').send({ name: 'Nope' });
    expect(customer.status).toBe(402);
  });

  it('still lets the shop read everything it owns', async () => {
    // This is the part that matters: a lapsed customer is not a hostage.
    const boot = await shop.api('get', '/products/bootstrap');
    expect(boot.status).toBe(200);
    expect(boot.body.data.org.id).toBe(shop.orgId);

    const sales = await shop.api('get', '/sales');
    expect(sales.status).toBe(200);
    expect(sales.body.meta.total).toBeGreaterThan(0);

    const z = await shop.api('get', '/sales/z-report');
    expect(z.status).toBe(200);
  });

  it('explains itself through /org/billing rather than leaving a bare 402', async () => {
    const res = await shop.api('get', '/org/billing');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SUSPENDED');
    expect(res.body.data.canSell).toBe(false);
    expect(res.body.data.message).toContain('paused');
  });

  it('comes straight back when billing is fixed', async () => {
    await prisma.organization.update({
      where: { id: shop.orgId },
      data: { status: 'ACTIVE', graceUntil: null, currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) },
    });
    await waitForCache();

    const res = await shop.api('post', '/sales/sync').send({ sales: [saleBody()] });
    expect(res.body.data.results[0].status).toBe('created');
  });
});

describeDb('enforcement: a deactivated user loses the till', () => {
  let shop: Shop;

  beforeAll(async () => {
    shop = await createShop('Staffing Shop');
  });

  it('rejects a still-valid token once the user is deactivated', async () => {
    // The token is fine — 12 hours of life left. The employment is not.
    const before = await shop.api('get', '/products/bootstrap');
    expect(before.status).toBe(200);

    await prisma.orgUser.updateMany({ where: { orgId: shop.orgId }, data: { isActive: false } });
    await waitForCache();

    const after = await shop.api('get', '/products/bootstrap');
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('ACCOUNT_INACTIVE');
  });
});

// ---------------------------------------------------------------------------

describeDb('the lifecycle job', () => {
  let shop: Shop;
  let runLifecycle: typeof import('../../src/jobs/lifecycle.job.js').runLifecycle;

  beforeAll(async () => {
    shop = await createShop('Lifecycle Shop');
    ({ runLifecycle } = await import('../../src/jobs/lifecycle.job.js'));
  });

  const setOrg = (data: Record<string, unknown>) =>
    prisma.organization.update({ where: { id: shop.orgId }, data: data as never });

  const status = async () =>
    (await prisma.organization.findUniqueOrThrow({ where: { id: shop.orgId }, select: { status: true } })).status;

  it('moves an expired trial into grace and queues one email', async () => {
    await setOrg({
      planCode: 'SHOP',
      status: 'TRIAL',
      trialEndsAt: new Date(Date.now() - 86_400_000),
      creditMonths: 0,
      lastBillingEmailAt: null,
    });

    await runLifecycle();

    expect(await status()).toBe('PAST_DUE');
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: shop.orgId } });
    expect(org.graceUntil).not.toBeNull();
    expect(org.graceUntil!.getTime()).toBeGreaterThan(Date.now());

    const mail = await prisma.emailMessage.findMany({ where: { orgId: shop.orgId, template: 'past-due' } });
    expect(mail).toHaveLength(1);
  });

  it('is idempotent — a second run the same day changes nothing', async () => {
    const before = await prisma.organization.findUniqueOrThrow({ where: { id: shop.orgId } });
    await runLifecycle();
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: shop.orgId } });

    expect(after.status).toBe(before.status);
    expect(after.graceUntil?.toISOString()).toBe(before.graceUntil?.toISOString());

    // And crucially, no second email.
    const mail = await prisma.emailMessage.count({ where: { orgId: shop.orgId, template: 'past-due' } });
    expect(mail).toBe(1);
  });

  it('suspends once grace has run out', async () => {
    await setOrg({ graceUntil: new Date(Date.now() - 60_000) });
    await runLifecycle();

    expect(await status()).toBe('SUSPENDED');
    expect(await prisma.emailMessage.count({ where: { orgId: shop.orgId, template: 'suspended' } })).toBe(1);
  });

  it('spends a referral credit instead of dunning', async () => {
    await setOrg({
      status: 'ACTIVE',
      currentPeriodEnd: new Date(Date.now() - 86_400_000),
      creditMonths: 2,
      graceUntil: null,
    });

    const summary = await runLifecycle();
    expect(summary.creditsApplied).toBe(1);

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: shop.orgId } });
    expect(org.status).toBe('ACTIVE');
    expect(org.creditMonths).toBe(1);
    expect(org.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
  });

  it('never touches a FREE shop', async () => {
    await setOrg({ planCode: 'FREE', status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() - 999 * 86_400_000) });
    await runLifecycle();
    expect(await status()).toBe('ACTIVE');
  });
});

// ---------------------------------------------------------------------------

describeDb('job locking', () => {
  let withJobLock: typeof import('../../src/jobs/lock.js').withJobLock;

  beforeAll(async () => {
    ({ withJobLock } = await import('../../src/jobs/lock.js'));
  });

  it('runs once when ten instances fire the same window', async () => {
    const key = `test-${Date.now()}`;
    let executions = 0;

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        withJobLock('test-job', key, async () => {
          executions += 1;
          return { ok: true };
        }),
      ),
    );

    expect(executions).toBe(1);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
  });

  it('records the outcome so an operator can see what happened', async () => {
    const key = `test-detail-${Date.now()}`;
    await withJobLock('test-job', key, async () => ({ processed: 7 }));

    const run = await prisma.jobRun.findUniqueOrThrow({ where: { uniq_job_run: { jobName: 'test-job', runKey: key } } });
    expect(run.status).toBe('SUCCEEDED');
    expect(run.finishedAt).not.toBeNull();
    expect(run.detail).toEqual({ processed: 7 });
  });

  it('records a failure and lets the next attempt retry it', async () => {
    const key = `test-fail-${Date.now()}`;
    await expect(
      withJobLock('test-job', key, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const failed = await prisma.jobRun.findUniqueOrThrow({ where: { uniq_job_run: { jobName: 'test-job', runKey: key } } });
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toContain('boom');

    // A failed run must not wedge the window forever.
    const retry = await withJobLock('test-job', key, async () => ({ recovered: true }));
    expect(retry.ran).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describeDb('the email outbox', () => {
  let enqueue: typeof import('../../src/services/email/outbox.js').enqueue;
  let flushEmails: typeof import('../../src/services/email/outbox.js').flushEmails;

  beforeAll(async () => {
    ({ enqueue, flushEmails } = await import('../../src/services/email/outbox.js'));
  });

  it('refuses to queue the same dedupeKey twice', async () => {
    const dedupeKey = `test-dedupe-${Date.now()}`;
    const body = { to: 'a@b.test', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi', template: 'test', dedupeKey };

    expect(await enqueue(body)).toBe(true);
    expect(await enqueue(body)).toBe(false); // second one loses, and that is success

    expect(await prisma.emailMessage.count({ where: { dedupeKey } })).toBe(1);
  });

  it('marks a queued message SENT once flushed', async () => {
    const dedupeKey = `test-flush-${Date.now()}`;
    await enqueue({ to: 'a@b.test', subject: 'Flush me', html: '<p>x</p>', text: 'x', template: 'test', dedupeKey });

    await flushEmails(100);

    const msg = await prisma.emailMessage.findUniqueOrThrow({ where: { dedupeKey } });
    expect(msg.status).toBe('SENT');
    expect(msg.sentAt).not.toBeNull();
    expect(msg.attempts).toBe(1);
  });

  it('does not re-send a message that already went out', async () => {
    const dedupeKey = `test-once-${Date.now()}`;
    await enqueue({ to: 'a@b.test', subject: 'Once', html: '<p>x</p>', text: 'x', template: 'test', dedupeKey });
    await flushEmails(100);
    await flushEmails(100);

    const msg = await prisma.emailMessage.findUniqueOrThrow({ where: { dedupeKey } });
    expect(msg.attempts).toBe(1); // not 2
  });
});

/** The org guard memoises for a few seconds; step past it deliberately. */
async function waitForCache(): Promise<void> {
  const { invalidateOrgCache } = await import('../../src/middleware/org.js');
  invalidateOrgCache();
}
