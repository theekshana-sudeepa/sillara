import type { NextFunction, Request, RequestHandler, Response } from 'express';

export const asyncHandler =
  <T>(fn: (req: Request, res: Response, next: NextFunction) => Promise<T>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export const ok = <T>(res: Response, data: T, status = 200): void => {
  res.status(status).json({ ok: true, data });
};
