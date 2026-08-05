/**
 * Runs before every test file.
 *
 * `src/config/env.ts` calls process.exit(1) on a bad environment — correct for
 * a server, fatal for a test runner. Filling in safe defaults here means a unit
 * test can import a module that happens to touch prisma without the whole run
 * dying.
 *
 * The integration tests point at TEST_DATABASE_URL and are skipped when it is
 * unset, so `npm test` stays green on a laptop with no MySQL running.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= 'test-jwt-secret-at-least-32-characters-long';
process.env.MAGIC_LINK_SECRET ??= 'test-magic-secret-at-least-32-characters-long';
process.env.EMAIL_PROVIDER = 'console';
process.env.LOG_LEVEL ??= 'error';

// Never let a test run touch the development database by accident.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'mysql://unused@127.0.0.1:3306/sillara_no_db';
