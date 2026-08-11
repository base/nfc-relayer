import type { NextApiRequest, NextApiResponse } from 'next';

// Build the origin allowlist from the environment variable at boot time.
// This prevents wildcard origins ('*') which expose the API to CSRF and abuse from unauthorized domains.
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(
  (process.env.CORS_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean),
);

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'OPTIONS';

/**
 * Applies strict CORS headers to the response.
 * 
 * @returns {boolean} Returns `true` if the request should proceed. Returns `false` if the response 
 * is already terminal (e.g., OPTIONS preflight or 405 Method Not Allowed), so callers CANNOT continue 
 * and double-write headers (fixing the previous ERR_HTTP_HEADERS_SENT bug).
 */
export function applyCors(
  req: NextApiRequest,
  res: NextApiResponse,
  allowedMethods: readonly HttpMethod[],
): boolean {
  const origin = req.headers.origin;
  
  if (typeof origin === 'string' && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  
  res.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '600'); // Cache preflight requests for 10 minutes

  if (req.method === 'OPTIONS') {
    // Gracefully terminate preflight requests
    res.status(204).end();
    return false;
  }
  
  if (!allowedMethods.includes(req.method as HttpMethod)) {
    // Reject unsupported methods immediately with 405 Method Not Allowed
    res.setHeader('Allow', allowedMethods.join(', '));
    res.status(405).end();
    return false;
  }
  
  return true;
}