import { Prisma } from '@prisma/client';

export const D = (v: Prisma.Decimal.Value): Prisma.Decimal => new Prisma.Decimal(v);
export const money = (v: Prisma.Decimal.Value): Prisma.Decimal =>
  D(v).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
export const toNumber = (v: Prisma.Decimal | null | undefined): number => (v ? Number(v.toString()) : 0);
