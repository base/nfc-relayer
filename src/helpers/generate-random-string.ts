import { randomInt } from 'crypto';

/**
 * Alphabet used for generated codes.
 *
 * 62 symbols, so each character carries log2(62) ≈ 5.95 bits of entropy.
 */
const CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Default length. At 62 symbols per position this yields roughly 119 bits of
 * entropy, which is ample for an unguessable single-use verification code.
 *
 * The previous default of 8 characters (≈47 bits) was already marginal for a
 * value that gates a payment, and it was generated from `Math.random()`.
 */
export const DEFAULT_LENGTH = 20;

/**
 * Generates a cryptographically secure random string.
 *
 * `Math.random()` must not be used here. It is seeded from a non-cryptographic
 * PRNG (xorshift128+ in V8) whose internal state can be recovered from a handful
 * of observed outputs, after which all past and future values are predictable.
 * This function's output is used as the `verificationCode` that authorizes
 * payment submission, so predictability is directly exploitable.
 *
 * `crypto.randomInt` is used rather than `randomBytes` with a modulo reduction
 * because it performs rejection sampling internally and therefore produces a
 * uniform distribution over the alphabet, with no modulo bias.
 *
 * @param length Number of characters to generate. Defaults to {@link DEFAULT_LENGTH}.
 * @returns A random string drawn uniformly from {@link CHARACTERS}.
 */
export function generateRandomString(length = DEFAULT_LENGTH): string {
  if (!Number.isInteger(length) || length <= 0) {
    throw new Error('generateRandomString: length must be a positive integer');
  }

  let result = '';
  for (let i = 0; i < length; i++) {
    result += CHARACTERS.charAt(randomInt(CHARACTERS.length));
  }
  return result;
}
