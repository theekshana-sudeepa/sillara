import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { isProd } from '../config/env.js';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong';
  let details: unknown;

  if (err instanceof AppError) {
    ({ status, code, message, details } = err);
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') { status = 409; code = 'DUPLICATE'; message = 'A record with this value already exists'; }
    else if (err.code === 'P2025') { status = 404; code = 'NOT_FOUND'; message = 'Record not found'; }
    else { status = 400; code = `PRISMA_${err.code}`; message = 'Database request failed'; }
  }

  const log = { err, status, code, path: req.path, orgId: req.auth?.orgId };
  if (status >= 500) logger.error(log, message);
  else logger.warn(log, message);

  res.status(status).json({
    ok: false,
    error: { code, message: status >= 500 && isProd ? 'Something went wrong' : message, ...(details ? { details } : {}) },
  });
}
