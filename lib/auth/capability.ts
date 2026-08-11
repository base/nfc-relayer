import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { requireEnv } from '@/lib/env';

// Ensures the server is using a strong, cryptographically secure key loaded from the environment.
const CAPABILITY_KEY = Buffer.from(requireEnv('RELAY_CAPABILITY_KEY'), 'hex');
if (CAPABILITY_KEY.length < 32) throw new Error('RELAY_CAPABILITY_KEY must be >= 32 bytes of hex');

/** 
 * Issued ONLY in the 201 response of POST /api/paymentTxParams. 
 * Never returned by any read path. 
 */
export function mintCapability(uuid: string): string {
  return createHmac('sha256', CAPABILITY_KEY).update(uuid, 'utf8').digest('base64url');
}

/** 
 * Hash-then-compare: Prevents timing attacks.
 * timingSafeEqual throws ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH on unequal lengths, 
 * so we hash both sides first to guarantee equal length buffers before comparison.
 */
export function verifyCapability(uuid: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const digest = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(digest(presented), digest(mintCapability(uuid)));
}

/**
 * Extracts the Bearer token from the Authorization header.
 */
export function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : undefined;
}