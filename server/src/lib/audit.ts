import type { Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';

/**
 * Write an audit row.
 *
 * Security events need a record that survives the request: who changed a
 * role, who deactivated whom, who sat there guessing PINs. Answering "how did
 * that account get owner access?" three weeks later is only possible if the
 * answer was written down at the time.
 *
 * Never throws. An audit table that can refuse a login is a denial-of-service
 * with extra steps — a failure here is logged and swallowed, because the
 * alternative is worse than a missing row.
 */
export async function audit(entry: {
  orgId?: string | null;
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  detail?: Prisma.InputJsonValue;
  ip?: string | null;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        orgId: entry.orgId ?? null,
        actorId: entry.actorId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        detail: entry.detail,
        ip: entry.ip?.slice(0, 64) ?? null,
      },
    });
  } catch (err) {
    logger.error({ err, action: entry.action, entity: entry.entity }, 'audit write failed');
  }
}
