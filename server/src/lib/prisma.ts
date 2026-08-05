import { PrismaClient } from '@prisma/client';
import { isProd } from '../config/env.js';
import { logger } from './logger.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProd ? [{ emit: 'event', level: 'error' }] : [{ emit: 'event', level: 'warn' }],
  });

prisma.$on('error' as never, (e: unknown) => logger.error({ e }, 'prisma error'));
if (!isProd) globalForPrisma.prisma = prisma;

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
