import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '../lib/logger.js';
import { withJobLock } from './lock.js';
import { JOBS } from './registry.js';

/**
 * In-process cron.
 *
 * Deliberately not a separate worker service: a POS platform's background work
 * is four small jobs, and a second deployable would double the ops surface for
 * a business that has one VPS. When that stops being true, every job already
 * takes its own lock — moving them to their own process is a config change,
 * not a rewrite.
 *
 * Safe to run on every instance you deploy. `withJobLock` means N instances
 * firing the same cron produce exactly one execution.
 */

let tasks: ScheduledTask[] = [];

export function startScheduler(): void {
  if (tasks.length) return;

  for (const job of JOBS) {
    if (!cron.validate(job.cron)) {
      logger.error({ job: job.name, cron: job.cron }, 'invalid cron expression — job not scheduled');
      continue;
    }
    const task = cron.schedule(
      job.cron,
      () => {
        const now = new Date();
        void withJobLock(job.name, job.runKey(now), () => job.run(now)).catch(() => {
          /* withJobLock already logged and recorded the failure */
        });
      },
      { timezone: 'UTC' },
    );
    tasks.push(task);
  }

  logger.info({ jobs: JOBS.map((j) => `${j.name} (${j.cron})`) }, '⏰ scheduler started');
}

export function stopScheduler(): void {
  for (const t of tasks) t.stop();
  tasks = [];
}
