import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Passwords are stored as scrypt hashes with a salt of their own (docs/adr/0010), in one string
 * that names its parameters, `scrypt$N$r$p$salt$hash` (base64), so a later change of cost still
 * reads the hashes made before it. Node's own crypto: no dependency.
 */

/** The password the `admin` of a fresh install starts with, which must be changed at its first sign-in. */
export const DEFAULT_ADMIN_PASSWORD = 'admin';
export const MIN_PASSWORD_LENGTH = 8;
/** scrypt reads every byte, so a password has a ceiling: no one types more, and a megabyte would cost the server. */
export const MAX_PASSWORD_LENGTH = 200;

/** About 50 ms and 16 MB a hash: slow for a guesser, quick for a sign-in. */
const COST = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

const derive = (password: string, salt: Buffer, length: number, options: ScryptOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, length, { ...options, maxmem: 64 * 1024 * 1024 }, (error, key) => (error ? reject(error) : resolve(key)));
  });

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, KEY_LENGTH, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Whether the password is the one hashed. Compared in constant time; a hash it cannot read never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || salt === undefined || hash === undefined) return false;
  const expected = Buffer.from(hash, 'base64');
  try {
    const key = await derive(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return timingSafeEqual(key, expected);
  } catch {
    // Parameters scrypt refuses: not a hash this code wrote.
    return false;
  }
}

/**
 * A hash of a random password, checked against when a username is unknown or a user disabled, so
 * a refusal takes as long whichever it was and the time says nothing about who exists.
 */
let decoy: Promise<string> | undefined;
export const decoyHash = (): Promise<string> => (decoy ??= hashPassword(randomBytes(16).toString('hex')));

/** Why a new password is refused, or undefined when it will do. */
export function passwordProblem(password: unknown): string | undefined {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) return `A password needs at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `A password can be at most ${MAX_PASSWORD_LENGTH} characters`;
  return undefined;
}
