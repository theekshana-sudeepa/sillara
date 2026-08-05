import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  APP_URL: z.string().url().default('http://localhost:5273'),
  SITE_URL: z.string().url().default('http://localhost:5274'),
  API_URL: z.string().url().default('http://localhost:4100'),

  DATABASE_URL: z.string().min(1),

  JWT_SECRET: z.string().min(32),
  MAGIC_LINK_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('12h'),

  CORS_ORIGINS: z.string().default('http://localhost:5273,http://localhost:5274'),

  /// Background jobs (billing lifecycle, digests, email outbox, cleanup).
  /// Safe on every instance — each job takes a database lock first.
  /// Not z.coerce.boolean(): that reads the string "false" as true.
  RUN_JOBS: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),

  PADDLE_WEBHOOK_SECRET: z.string().optional(),
  PADDLE_API_KEY: z.string().optional(),
  PADDLE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),

  PAYHERE_MERCHANT_ID: z.string().optional(),
  PAYHERE_MERCHANT_SECRET: z.string().optional(),
  PAYHERE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),

  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().optional(),

  // Shelfie (photo → catalog). Feature returns 503 until the key is set.
  ANTHROPIC_API_KEY: z.string().optional(),
  SHELFIE_MODEL: z.string().default('claude-opus-5'),
  MAIL_FROM_NAME: z.string().default('Sillara'),
  MAIL_FROM_EMAIL: z.string().email().default('hello@sillara.com'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    // eslint-disable-next-line no-console
    console.error(`   • ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const corsOrigins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

// A live payment rail is mandatory in production — a POS platform that cannot
// take money is a demo, and we do not deploy demos.
if (isProd && !env.PADDLE_WEBHOOK_SECRET && !env.PAYHERE_MERCHANT_SECRET) {
  // eslint-disable-next-line no-console
  console.error('❌ Production requires at least one payment provider (Paddle or PayHere)');
  process.exit(1);
}
