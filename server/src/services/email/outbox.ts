import { Resend } from 'resend';
import { Prisma } from '@prisma/client';
import { prisma, isUniqueViolation } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import type { RenderedEmail } from './templates.js';

/**
 * The email outbox.
 *
 * Nothing in this codebase sends mail inline. Callers `enqueue()` a row and
 * return; `flushEmails()` does the network I/O on a schedule. That separation
 * buys three things a direct `await resend.send()` never can:
 *
 *   1. A provider outage cannot fail a customer's signup.
 *   2. Retries are automatic and backed off, with the attempt count visible.
 *   3. `dedupeKey` is UNIQUE, so a job that runs twice — a cron misfire, a
 *      redeployed pod, an operator running the CLI by hand — is physically
 *      incapable of mailing the same shop twice.
 *
 * Same philosophy as sale sync: the database is the idempotency layer.
 */

let resend: Resend | null = null;

export interface EnqueueInput extends RenderedEmail {
  to: string;
  template: string;
  /** Stable across retries of the same logical send, e.g. `trial-ending:<orgId>:2026-08-01`. */
  dedupeKey: string;
  orgId?: string | null;
  sendAfter?: Date;
}

/**
 * Queue one email. Returns false when the dedupeKey already exists — that is
 * the success path for a re-run, not an error, so callers can ignore it.
 */
export async function enqueue(input: EnqueueInput): Promise<boolean> {
  try {
    await prisma.emailMessage.create({
      data: {
        orgId: input.orgId ?? null,
        dedupeKey: input.dedupeKey.slice(0, 191),
        template: input.template,
        to: input.to,
        subject: input.subject.slice(0, 255),
        html: input.html,
        text: input.text,
        sendAfter: input.sendAfter ?? new Date(),
      },
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) {
      logger.debug({ dedupeKey: input.dedupeKey }, 'email already queued — skipping');
      return false;
    }
    throw err;
  }
}

/** 1min, 5min, 25min, 2h, 10h — five attempts across half a day, then FAILED. */
const MAX_ATTEMPTS = 5;
const backoffMs = (attempt: number): number => 60_000 * 5 ** (attempt - 1);

async function deliver(msg: { to: string; subject: string; html: string; text: string }): Promise<void> {
  if (env.EMAIL_PROVIDER === 'console' || !env.RESEND_API_KEY) {
    logger.info({ to: msg.to, subject: msg.subject }, '📧 [console mailer] would send');
    return;
  }
  resend ??= new Resend(env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: `${env.MAIL_FROM_NAME} <${env.MAIL_FROM_EMAIL}>`,
    to: [msg.to],
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
  });
  if (error) throw new Error(`${error.name}: ${error.message}`);
}

export interface FlushResult {
  sent: number;
  retried: number;
  failed: number;
}

/**
 * Send everything due. Each message is claimed with a conditional UPDATE
 * before any network call, so two flushes running at once cannot both send
 * the same email — the second one's `updateMany` matches zero rows.
 */
export async function flushEmails(limit = 50): Promise<FlushResult> {
  const due = await prisma.emailMessage.findMany({
    where: { status: 'PENDING', sendAfter: { lte: new Date() } },
    orderBy: { sendAfter: 'asc' },
    take: limit,
  });

  const result: FlushResult = { sent: 0, retried: 0, failed: 0 };

  for (const msg of due) {
    // Claim: only one flush can move this row off its current attempt count.
    const claimed = await prisma.emailMessage.updateMany({
      where: { id: msg.id, status: 'PENDING', attempts: msg.attempts },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue; // another worker got it

    try {
      await deliver(msg);
      await prisma.emailMessage.update({
        where: { id: msg.id },
        data: { status: 'SENT', sentAt: new Date(), lastError: null },
      });
      result.sent += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempt = msg.attempts + 1;
      const exhausted = attempt >= MAX_ATTEMPTS;
      await prisma.emailMessage.update({
        where: { id: msg.id },
        data: {
          status: exhausted ? 'FAILED' : 'PENDING',
          lastError: message.slice(0, 2000),
          sendAfter: exhausted ? msg.sendAfter : new Date(Date.now() + backoffMs(attempt)),
        },
      });
      if (exhausted) {
        result.failed += 1;
        logger.error({ id: msg.id, to: msg.to, template: msg.template, attempt, err: message }, 'email permanently failed');
      } else {
        result.retried += 1;
        logger.warn({ id: msg.id, template: msg.template, attempt, err: message }, 'email send failed — will retry');
      }
    }
  }

  if (result.sent || result.retried || result.failed) {
    logger.info(result, '📧 outbox flushed');
  }
  return result;
}

/**
 * Send one message immediately AND record it, for the paths where a human is
 * staring at the screen waiting (activation). Still writes the outbox row
 * first, so a failure here is retried by the flush job rather than lost.
 */
export async function enqueueAndFlush(input: EnqueueInput): Promise<void> {
  const queued = await enqueue(input);
  if (!queued) return;
  await flushEmails(5);
}

/** Housekeeping: sent mail older than 60 days is noise, not history. */
export async function pruneSentEmails(olderThanDays = 60): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const { count } = await prisma.emailMessage.deleteMany({
    where: { status: 'SENT', sentAt: { lt: cutoff } },
  });
  return count;
}

export type EmailMessageRow = Prisma.EmailMessageGetPayload<object>;
