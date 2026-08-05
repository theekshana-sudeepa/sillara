import { createRequire } from 'node:module';
import pino from 'pino';
import { env, isProd } from '../config/env.js';

/**
 * pino-pretty runs in a worker thread — exactly what you want in dev, and
 * exactly what breaks under a test runner that owns the worker pool.
 *
 * It is also a devDependency, so it is absent in production by design. Pino
 * resolves the transport lazily and throws at construction if it cannot find
 * it, which means a single missing package takes the whole API down at boot
 * rather than degrading. Log formatting is never worth an outage: check that
 * it resolves, and fall back to JSON if it doesn't.
 */
function prettyAvailable(): boolean {
  if (isProd || env.NODE_ENV === 'test') return false;
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return true;
  } catch {
    // eslint-disable-next-line no-console
    console.warn('pino-pretty not installed — logging JSON. `npm i -D pino-pretty` for readable dev logs.');
    return false;
  }
}

const pretty = prettyAvailable();

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: pretty ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } : undefined,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.pin', '*.passwordHash'],
    censor: '[redacted]',
  },
  base: { service: 'sillara-api' },
});
