import type { Store, ClientRateLimitInfo, Options } from 'express-rate-limit';
import { prisma } from './prisma.js';
import { logger } from './logger.js';

/**
 * ---------------------------------------------------------------------------
 * A RATE LIMIT THAT SURVIVES A SECOND PROCESS
 * ---------------------------------------------------------------------------
 * `express-rate-limit` defaults to a Map in one process. Production runs PM2
 * cluster, so each worker counts separately: a limit of 20 is really 20 × the
 * number of workers, and every deploy resets all of them to zero — which is
 * the moment a signup surface is least protected and most worth hitting.
 *
 * The counter lives in MySQL for the same reason the job lock and the email
 * outbox do: the database is already the thing every instance agrees on, and
 * adding Redis to a stack whose selling point is "one VPS" is a real cost.
 * Swapping in a Redis store later is a one-line change here.
 *
 * The increment is one statement. `LAST_INSERT_ID` carries the new count back
 * out of the upsert, so two workers racing on the same key get 1 and 2 rather
 * than both reading 1 — the same technique receipt numbering uses.
 * ---------------------------------------------------------------------------
 */
export class MySqlRateLimitStore implements Store {
  private windowMs = 60_000;
  readonly localKeys = false;

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const expires = new Date(Date.now() + this.windowMs);

    try {
      // Both statements must run on the same connection: LAST_INSERT_ID() is
      // per-connection state, and Prisma's pool will happily hand the SELECT
      // to a different one, which reads back somebody else's number. The
      // transaction is what pins them together — the same reason receipt
      // numbering does this inside `prisma.$transaction`.
      return await prisma.$transaction(async (tx) => {
        // An expired window resets to 1 rather than continuing to climb, so a
        // key that went quiet for an hour starts fresh.
        await tx.$executeRaw`
          INSERT INTO rate_limit_hits (\`key\`, count, expiresAt)
          VALUES (${key}, LAST_INSERT_ID(1), ${expires})
          ON DUPLICATE KEY UPDATE
            count     = LAST_INSERT_ID(IF(expiresAt <= UTC_TIMESTAMP(3), 1, count + 1)),
            expiresAt = IF(expiresAt <= UTC_TIMESTAMP(3), VALUES(expiresAt), expiresAt)
        `;

        const rows = await tx.$queryRaw<Array<{ hits: bigint; expiresAt: Date }>>`
          SELECT LAST_INSERT_ID() AS hits, expiresAt FROM rate_limit_hits WHERE \`key\` = ${key}
        `;

        return {
          totalHits: Number(rows[0]?.hits ?? 1),
          resetTime: rows[0]?.expiresAt ?? expires,
        };
      });
    } catch (err) {
      // Fail open. A limiter that 500s the login page during a database blip
      // is a worse outage than the abuse it was guarding against — and any
      // endpoint behind it needs the database anyway, so it will fail loudly
      // on its own if this is really down.
      logger.error({ err, key }, 'rate limit store unavailable — allowing request');
      return { totalHits: 1, resetTime: expires };
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await prisma.$executeRaw`
        UPDATE rate_limit_hits SET count = GREATEST(count - 1, 0) WHERE \`key\` = ${key}
      `;
    } catch (err) {
      logger.error({ err, key }, 'rate limit decrement failed');
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await prisma.rateLimitHit.deleteMany({ where: { key } });
    } catch (err) {
      logger.error({ err, key }, 'rate limit reset failed');
    }
  }
}
