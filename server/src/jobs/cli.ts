import { prisma, disconnectPrisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { withJobLock } from './lock.js';
import { JOBS, findJob } from './registry.js';

/**
 * Run one job by hand:
 *
 *   npm run job -- lifecycle          # takes the lock, records the run
 *   npm run job -- lifecycle --force  # ignores today's lock (re-run after a fix)
 *   npm run job -- --list
 *
 * Every incident with a scheduled job ends with someone needing to run it once,
 * now, and see what it did. This is that.
 */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const name = args.find((a) => !a.startsWith('-'));
  const force = args.includes('--force');

  if (!name || args.includes('--list') || args.includes('-l')) {
    // eslint-disable-next-line no-console
    console.log('\nSillara jobs\n');
    for (const j of JOBS) {
      // eslint-disable-next-line no-console
      console.log(`  ${j.name.padEnd(12)} ${j.cron.padEnd(14)} ${j.description}`);
    }
    // eslint-disable-next-line no-console
    console.log('\n  npm run job -- <name> [--force]\n');
    return;
  }

  const job = findJob(name);
  if (!job) {
    // eslint-disable-next-line no-console
    console.error(`Unknown job "${name}". Try: ${JOBS.map((j) => j.name).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const now = new Date();
  if (force) {
    // A forced run still records itself, under a key nobody else will claim.
    const result = await withJobLock(job.name, `${job.runKey(now)}:force:${Date.now()}`, () => job.run(now));
    logger.info({ job: job.name, result: result.result }, 'forced run complete');
    return;
  }

  const outcome = await withJobLock(job.name, job.runKey(now), () => job.run(now));
  if (!outcome.ran) {
    logger.warn({ job: job.name }, 'already ran for this window — use --force to run anyway');
  }
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'job run failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$queryRaw`SELECT 1`.catch(() => undefined);
    await disconnectPrisma();
  });
