import { runLifecycle } from './lifecycle.job.js';
import { runDailyDigest } from './digest.job.js';
import { runCleanup } from './cleanup.job.js';
import { runStockReconcile } from './reconcile.job.js';
import { flushEmails } from '../services/email/outbox.js';
import { dayKey, hourKey } from './lock.js';

/**
 * One place that knows every scheduled job: its name, its cron expression,
 * how its run window is keyed, and what it does. The scheduler and the CLI
 * both read from here, so `npm run job -- lifecycle` runs exactly what the
 * cron runs — no drift between "what production does" and "what I can test".
 */

export interface JobDefinition {
  name: string;
  cron: string;
  description: string;
  /** The lock window. Two runs sharing a key run once. */
  runKey: (now: Date) => string;
  run: (now: Date) => Promise<unknown>;
}

export const JOBS: JobDefinition[] = [
  {
    name: 'lifecycle',
    // 02:10 UTC — after midnight in every market we sell into, before anyone
    // opens the shop. Nobody discovers a suspension mid-morning.
    cron: '10 2 * * *',
    description: 'Trials, renewals, referral credits, grace periods, suspensions',
    runKey: dayKey,
    run: (now) => runLifecycle(now),
  },
  {
    name: 'digest',
    // Hourly: each org gets its digest when *its* local day has ended, and
    // the dedupeKey (org + local date) makes the other 23 runs no-ops.
    cron: '20 * * * *',
    description: "Yesterday's takings + low stock, in each org's own timezone",
    runKey: hourKey,
    run: (now) => runDailyDigest(now),
  },
  {
    name: 'emails',
    cron: '*/2 * * * *',
    description: 'Flush the transactional email outbox',
    // Per-row claiming already makes this safe to run concurrently, so the
    // key is fine-grained enough to never block a flush.
    runKey: (now) => now.toISOString().slice(0, 16),
    run: () => flushEmails(100),
  },
  {
    name: 'cleanup',
    cron: '40 3 * * *',
    description: 'Expire tokens, prune webhook events, job runs, sent mail',
    runKey: dayKey,
    run: (now) => runCleanup(now),
  },
  {
    name: 'reconcile',
    // 03:10 — after the day's trading has settled everywhere, before cleanup.
    cron: '10 3 * * *',
    description: 'Check stock caches against the ledger (--apply to correct)',
    runKey: dayKey,
    // Report-only on a schedule. Correcting balances is a decision, not a
    // cron: the flag has to be typed by a person who has read the drift.
    run: (now) => runStockReconcile(now, { apply: process.argv.includes('--apply') }),
  },
];

export const findJob = (name: string): JobDefinition | undefined => JOBS.find((j) => j.name === name);
