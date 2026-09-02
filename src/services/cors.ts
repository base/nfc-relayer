import Cors from 'cors';
import type { CorsRequest } from 'cors';
import { NextApiRequest, NextApiResponse } from 'next';

/**
 * Origins permitted to call this API from a browser.
 *
 * Supplied as a comma-separated list in `ALLOWED_ORIGINS`, for example
 * `https://pay.example.com,https://checkout.example.com`.
 *
 * The previous configuration was `origin: '*'`. For an API whose endpoints spend
 * a sponsor wallet's gas and mutate payment records, a wildcard means any page on
 * the internet can issue cross-origin requests to it from a visitor's browser.
 * CORS is not the primary control — the verification-code check on each mutating
 * route is — but a wildcard removes a cheap layer of defence for no benefit.
 */
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

/**
 * Resolves the CORS origin decision.
 *
 * When `ALLOWED_ORIGINS` is unset the API is treated as same-origin only: no
 * `Access-Control-Allow-Origin` header is emitted, which browsers reject for
 * cross-origin reads. This fails closed rather than silently reverting to `*`.
 */
const originCheck: Cors.CorsOptions['origin'] = (requestOrigin, callback) => {
  if (!requestOrigin) {
    // Same-origin and non-browser callers (curl, mobile apps, server-to-server)
    // send no Origin header. CORS does not apply to them.
    callback(null, true);
    return;
  }
  callback(null, allowedOrigins.includes(requestOrigin));
};

const cors = Cors({
  methods: ['GET', 'HEAD', 'POST', 'OPTIONS'],
  origin: originCheck,
  optionsSuccessStatus: 200,
  maxAge: 600,
});

/** Signature of the connect-style middleware produced by the `cors` package. */
type CorsMiddleware = (
  req: CorsRequest,
  res: { statusCode?: number; setHeader(key: string, value: string): unknown; end(): unknown },
  next: (err?: unknown) => void,
) => void;

/**
 * Runs a connect-style middleware as a promise.
 *
 * Typed against the `cors` package's own request/response contracts instead of
 * `Function`/`any`, so a signature change is caught at compile time. The
 * middleware is invoked inside the promise executor so a synchronous throw —
 * which the `cors` package can raise while reflecting on the request or response
 * — is turned into a rejection rather than escaping the call site.
 */
function runMiddleware(
  req: NextApiRequest,
  res: NextApiResponse,
  fn: CorsMiddleware,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      fn(req as unknown as CorsRequest, res, (result?: unknown) => {
        if (result instanceof Error) {
          reject(result);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Applies the CORS policy to a request.
 *
 * @returns `true` when the caller should continue handling the request, `false`
 *   when this function has already written a response.
 *
 * The boolean is the contract callers must branch on. An earlier revision asked
 * them to inspect `res.writableEnded` instead, which is fragile: it is not set by
 * every response implementation, and a caller that read it as `undefined` would
 * continue and attempt a second write on an already-finished response,
 * raising `ERR_HTTP_HEADERS_SENT`.
 */
export async function applyCors(req: NextApiRequest, res: NextApiResponse): Promise<boolean> {
  try {
    await runMiddleware(req, res, cors as unknown as CorsMiddleware);
  } catch (error) {
    console.error('Error applying CORS middleware:', error);
    res.status(500).json({ message: 'Internal Server Error' });
    return false;
  }

  // A preflight request is fully answered by the middleware itself.
  return !res.writableEnded;
}
