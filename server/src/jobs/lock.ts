import { prisma, isUniqueViolation } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * Distributed job locking, with no lock server.
 *
 * `job_runs` has UNIQUE(jobName, runKey). Two API instances both waking at
 * 02:00 race to INSERT the same row; MySQL picks a winner and the loser gets
 * a duplicate-key error and goes back to sleep. That is the entire mechanism.
 *
 * A crashed run must not wedge the job forever, so a claim can also take over
 * a row that is RUNNING but older than `staleAfterMs`, or one that FAILED.
 */

const STALE_AFTER_MS = 30 * 60_000; // 30 minutes

export interface JobOutcome<T> {
  ran: boolean;
  result?: T;
}

/** Day bucket in UTC — the run key for daily jobs. */
export const dayKey = (d = new Date()): string => d.toISOString().slice(0, 10);
/** Hour bucket — the run key for hourly jobs. */
export const hourKey = (d = new Date()): string => d.toISOString().slice(0, 13);

async function claim(jobName: string, runKey: string): Promise<string | null> {
  try {
    const row = await prisma.jobRun.create({ data: { jobName, runKey } });
    return row.id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }

  // Someone holds it. Take over only if they died or failed.
  const existing = await prisma.jobRun.findUnique({ where: { uniq_job_run: { jobName, runKey } } });
  if (!existing) return null; // vanished between insert and read — let the other run have it

  const stale = existing.status === 'RUNNING' && Date.now() - existing.startedAt.getTime() > STALE_AFTER_MS;
  if (!stale && existing.status !== 'FAILED') return null;

  // Conditional update = a second lock. Only the instance that sees the row
  // in the state it expected wins the takeover.
  const taken = await prisma.jobRun.updateMany({
    where: { id: existing.id, status: existing.status, startedAt: existing.startedAt },
    data: { status: 'RUNNING', startedAt: new Date(), finishedAt: null, error: null },
  });
  if (taken.count === 0) return null;

  logger.warn({ jobName, runKey, previous: existing.status }, 'job lock taken over');
  return existing.id;
}

/**
 * Run `fn` at most once per (jobName, runKey). Returns `{ ran: false }` when
 * another instance already has it — that is a normal outcome, not an error.
 */
export async function withJobLock<T>(
  jobName: string,
  runKey: string,
  fn: () => Promise<T>,
): Promise<JobOutcome<T>> {
  const id = await claim(jobName, runKey);
  if (!id) {
    logger.debug({ jobName, runKey }, 'job already claimed elsewhere — skipping');
    return { ran: false };
  }

  const started = Date.now();
  try {
    const result = await fn();
    await prisma.jobRun.update({
      where: { id },
      data: { status: 'SUCCEEDED', finishedAt: new Date(), detail: (result ?? null) as never },
    });
    logger.info({ jobName, runKey, ms: Date.now() - started, detail: result }, '⏱️  job finished');
    return { ran: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    await prisma.jobRun.update({
      where: { id },
      data: { status: 'FAILED', finishedAt: new Date(), error: message.slice(0, 4000) },
    });
    logger.error({ jobName, runKey, err }, 'job failed');
    throw err;
  }
}
