import { createHash, timingSafeEqual } from 'crypto';

/**
 * Constant-time comparison for short secrets such as verification codes and
 * cron tokens.
 *
 * A naive `a !== b` comparison short-circuits on the first differing byte, so the
 * time it takes to reject a candidate leaks how many leading characters were
 * correct. Given an endpoint an attacker can call repeatedly, that turns an
 * exponential guessing problem into a linear one.
 *
 * Both inputs are hashed with SHA-256 first so that `timingSafeEqual` always
 * receives two 32-byte buffers. This avoids the `RangeError` that
 * `timingSafeEqual` throws on length mismatch — an exception which would itself
 * disclose that the lengths differ — without needing a separate length check.
 *
 * @param a First value. A non-string (for example `undefined` from an unset
 *   environment variable) never matches.
 * @param b Second value.
 * @returns `true` only when both inputs are strings with identical contents.
 */
export function secureCompare(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();

  return timingSafeEqual(digestA, digestB);
}
