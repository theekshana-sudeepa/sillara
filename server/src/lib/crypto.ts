import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, 12);
export const verifyPassword = (plain: string, hash: string): Promise<boolean> => bcrypt.compare(plain, hash);

/**
 * A real hash of a value nobody will ever type, so that logging in with an
 * unknown email burns the same CPU as logging in with a known one.
 *
 * This replaces a hand-written constant (`$2a$12$0000…`) that looked like a
 * bcrypt hash but was not well-formed. bcryptjs rejected it immediately
 * instead of doing the work, which defeated the whole point: measured on this
 * codebase, an unknown email answered in ~4ms and a known one in ~257ms. A 62×
 * gap is trivially readable over the internet, and it let anyone enumerate
 * every account on the platform without a single valid credential.
 *
 * Computed once at load. It costs ~250ms at boot and nothing afterwards.
 */
export const DUMMY_PASSWORD_HASH: string = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);
export const hashPin = (pin: string): Promise<string> => bcrypt.hash(pin, 8); // 4-digit, low value, fast switch
export const verifyPin = (pin: string, hash: string): Promise<boolean> => bcrypt.compare(pin, hash);

export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (v: string): string => crypto.createHash('sha256').update(v).digest('hex');
export const hmac256 = (key: string, v: string): string => crypto.createHmac('sha256', key).update(v).digest('hex');
export const md5Upper = (v: string): string => crypto.createHash('md5').update(v).digest('hex').toUpperCase();
