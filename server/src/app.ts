import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { pinoHttp } from 'pino-http';
import { corsOrigins, env, isProd } from './config/env.js';
import { logger } from './lib/logger.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { requireAuth } from './middleware/auth.js';
import { guarded } from './middleware/org.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { asyncHandler, ok } from './lib/http.js';
import { prisma } from './lib/prisma.js';

import { publicRouter } from './modules/public/public.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { productsRouter } from './modules/products/products.routes.js';
import { salesRouter } from './modules/sales/sales.routes.js';
import { customersRouter } from './modules/customers/customers.routes.js';
import { orgRouter } from './modules/org/org.routes.js';
import { stockRouter } from './modules/stock/stock.routes.js';
import { shiftsRouter } from './modules/shifts/shifts.routes.js';
import { loyaltyRouter } from './modules/loyalty/loyalty.routes.js';
import { branchesRouter } from './modules/branches/branches.routes.js';
import { purchasingRouter } from './modules/purchasing/purchasing.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { referralsRouter } from './modules/referrals/referrals.routes.js';
import { networkRouter } from './modules/network/network.routes.js';
import { supplierRouter } from './modules/network/supplier.routes.js';

export function createApp(): Express {
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('x-request-id', (req.headers['x-request-id'] as string) ?? crypto.randomUUID());
    next();
  });

  app.use(
    pinoHttp({
      logger,
      genReqId: (_req: IncomingMessage, res: ServerResponse) => res.getHeader('x-request-id') as string,
      autoLogging: { ignore: (req: IncomingMessage) => req.url === '/health' },
    }),
  );

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' }, hsts: isProd ? undefined : false }));

  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || corsOrigins.includes(origin)) return cb(null, true);
        cb(new Error('Not allowed by CORS'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      maxAge: 86_400,
    }),
  );

  app.use(compression());

  // Paddle needs the raw body for signature verification — its route mounts
  // raw() itself, so JSON parsing must skip it.
  app.use((req, res, next) => {
    if (req.path === '/api/v1/public/webhooks/paddle') return next();
    // 20mb headroom for Shelfie photo uploads (client downscales first, but
    // four JPEGs can still be a few MB base64-encoded).
    express.json({ limit: '20mb' })(req, res, next);
  });
  app.use(express.urlencoded({ extended: true, limit: '1mb' })); // PayHere notify

  app.use(globalLimiter);

  app.get(
    '/health',
    asyncHandler(async (_req, res) => {
      await prisma.$queryRaw`SELECT 1`;
      ok(res, { status: 'healthy', env: env.NODE_ENV, uptimeSec: Math.round(process.uptime()) });
    }),
  );

  const v1 = express.Router();

  // Unauthenticated by design: signup, checkout webhooks, public receipts.
  v1.use('/public', publicRouter);
  // Authenticates rather than requires authentication.
  v1.use('/auth', authRouter);

  // Everything below is a shop acting on its own data. `guarded` proves, on
  // every request, that the user still works there and the shop may still
  // write — neither of which a 12-hour JWT can tell you on its own.
  v1.use('/products', requireAuth, guarded, productsRouter);
  v1.use('/sales', requireAuth, guarded, salesRouter);
  v1.use('/customers', requireAuth, guarded, customersRouter);
  v1.use('/org', requireAuth, guarded, orgRouter);
  v1.use('/stock', requireAuth, guarded, stockRouter);
  v1.use('/shifts', requireAuth, guarded, shiftsRouter);
  v1.use('/loyalty', requireAuth, guarded, loyaltyRouter);
  v1.use('/branches', requireAuth, guarded, branchesRouter);
  v1.use('/purchasing', requireAuth, guarded, purchasingRouter);
  v1.use('/reports', requireAuth, guarded, reportsRouter);
  v1.use('/referrals', requireAuth, guarded, referralsRouter);
  v1.use('/network', requireAuth, guarded, networkRouter);

  // Supplier portal: authenticated by its own magic-link token, not the org JWT.
  v1.use('/supplier', supplierRouter);
  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
