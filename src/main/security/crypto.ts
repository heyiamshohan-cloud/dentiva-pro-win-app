// Dentiva Pro - password hashing (scrypt, per-user salt, timing-safe compare).
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384, r = 8, p = 1, KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N, r, p });
  return `s2$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [tag, nS, rS, pS, saltB64, hashB64] = stored.split('$');
    if (tag !== 's2') return false;
    const salt = Buffer.from(saltB64!, 'base64');
    const expected = Buffer.from(hashB64!, 'base64');
    const actual = scryptSync(password, salt, expected.length, {
      N: Number(nS), r: Number(rS), p: Number(pS),
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}
