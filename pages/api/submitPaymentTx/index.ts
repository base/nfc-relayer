import { ethers } from 'ethers';
import { Prisma } from '@prisma/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import { applyCors } from '@/lib/http/cors';
import { bearerToken, verifyCapability } from '@/lib/auth/capability';
import {
  getChainContext, assertGasBudget, TRANSFER_WITH_AUTHORIZATION_TYPES,
  UnsupportedChainError, GasBudgetExhaustedError,
} from '@/lib/relayer/signer';
import { getPrismaClient } from '@/helpers/database';

// Enforce a strict JSON body limit to prevent memory exhaustion (DoS).
export const config = { api: { bodyParser: { sizeLimit: '16kb' } } };

const NONCE_LOCK_KEY = 0x6e66_6372n; // 'nfcr' — one advisory lock namespace per relayer account
const GAS_LIMIT_NUMERATOR = 115;     // +15% headroom: raw estimateGas reverts on any state drift
const GAS_LIMIT_DENOMINATOR = 100;

interface Authorization {
  readonly from: string; readonly to: string; readonly value: string;
  readonly validAfter: string; readonly validBefore: string; readonly nonce: string;
}
type Response = { readonly txHash: string } | { readonly error: string };

/** Total function over unknown input — no destructuring of `req.body` before it is proven. */
function parseAuthorization(body: unknown): { uuid: string; signature: string; message: Authorization } {
  if (typeof body !== 'object' || body === null) throw new BadRequestError('body must be a JSON object');
  const { uuid, signature, typedData } = body as Record<string, unknown>;

  if (typeof uuid !== 'string' || !/^[0-9a-f-]{36}$/i.test(uuid)) throw new BadRequestError('invalid uuid');
  if (typeof signature !== 'string' || !ethers.utils.isHexString(signature, 65)) {
    throw new BadRequestError('signature must be 65 bytes of hex');
  }
  if (typeof typedData !== 'object' || typedData === null) throw new BadRequestError('missing typedData');

  const raw = (typedData as Record<string, unknown>).message;
  if (typeof raw !== 'object' || raw === null) throw new BadRequestError('missing typedData.message');
  const m = raw as Record<string, unknown>;

  const address = (field: string): string => {
    const v = m[field];
    if (typeof v !== 'string' || !ethers.utils.isAddress(v)) throw new BadRequestError(`invalid ${field}`);
    return ethers.utils.getAddress(v);
  };
  const uint = (field: string): string => {
    try { return ethers.BigNumber.from(m[field] as never).toString(); }
    catch { throw new BadRequestError(`invalid ${field}`); }
  };
  if (typeof m.nonce !== 'string' || !ethers.utils.isHexString(m.nonce, 32)) {
    throw new BadRequestError('nonce must be 32 bytes of hex');
  }

  return {
    uuid, signature,
    message: {
      from: address('from'), to: address('to'), value: uint('value'),
      validAfter: uint('validAfter'), validBefore: uint('validBefore'), nonce: m.nonce,
    },
  };
}

/**
 * `from` is excluded: formatTxMessageResponse rewrites message.from from the ?senderAddress query
 * param on read, so the payer's address legitimately differs from what was stored at create time.
 * Every value-bearing field IS bound, which is what stops an attacker-minted authorization.
 */
function assertMatchesStoredIntent(submitted: Authorization, stored: unknown): void {
  const typedData = (stored as { typedData?: { message?: Record<string, unknown> } } | null)?.typedData;
  const intent = typedData?.message;
  if (!intent) throw new ConflictError('record carries no relayable authorization');

  const bound: readonly (keyof Authorization)[] = ['to', 'value', 'validAfter', 'validBefore', 'nonce'];
  for (const field of bound) {
    const expected = intent[field];
    const normalized = field === 'to'
      ? ethers.utils.getAddress(String(expected))
      : field === 'nonce' ? String(expected).toLowerCase()
      : ethers.BigNumber.from(expected as never).toString();
    const actual = field === 'nonce' ? submitted.nonce.toLowerCase() : submitted[field];
    if (normalized !== actual) throw new ConflictError(`authorization field '${field}' does not match record`);
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Response>): Promise<void> {
  // Graceful handling of non-POST requests to prevent dangling connections
  if (!applyCors(req, res, ['POST', 'OPTIONS'])) return; 
  const prisma = getPrismaClient();

  try {
    const { uuid, signature, message } = parseAuthorization(req.body);

    // Capability check before any DB read or chain interaction.
    if (!verifyCapability(uuid, bearerToken(req.headers.authorization))) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const record = await prisma.contactlessPaymentTxOrMsg.findUnique({
      where: { uuid },
      select: { uuid: true, chainId: true, rpcProxySubmissionParams: true, relayClaimedAt: true, txHash: true },
    });
    if (!record) { res.status(404).json({ error: 'not found' }); return; }

    assertMatchesStoredIntent(message, record.rpcProxySubmissionParams);

    const ctx = await getChainContext(Number(record.chainId)); // chain from SERVER state, not the client body
    await assertGasBudget(ctx);

    // Signer recovery against the server-reconstructed domain. The submitted typedData.domain is
    // discarded entirely, which is what binds chainId and verifyingContract securely.
    const recovered = ethers.utils.verifyTypedData(
      ctx.domain, TRANSFER_WITH_AUTHORIZATION_TYPES, message, signature,
    );
    if (recovered !== message.from) { res.status(400).json({ error: 'signature does not match from' }); return; }

    const args = [
      message.from, message.to, message.value, message.validAfter, message.validBefore, message.nonce,
      ...(({ v, r, s }) => [v, r, s])(ethers.utils.splitSignature(signature)),
    ] as const;

    // Atomic single-use claim collapses the old check-then-relay TOCTOU into one DB statement.
    const claim = await prisma.contactlessPaymentTxOrMsg.updateMany({
      where: { uuid, relayClaimedAt: null, txHash: null },
      data: { relayClaimedAt: new Date() },
    });
    if (claim.count !== 1) { res.status(409).json({ error: 'already relayed' }); return; }

    try {
      // Two chain-independent reads in parallel: was 3 sequential awaits (~2 RTT saved).
      const [estimated, feeData] = await Promise.all([
        ctx.token.estimateGas.transferWithAuthorization(...args, { from: ctx.relayer.address }),
        ctx.relayer.provider.getFeeData(),
      ]);
      
      const { maxFeePerGas, maxPriorityFeePerGas } = feeData;
      if (!maxFeePerGas || !maxPriorityFeePerGas) throw new Error('chain did not report EIP-1559 fee data');

      const populated = await ctx.token.populateTransaction.transferWithAuthorization(...args);

      // Serialize nonce acquisition + broadcast using Postgres Advisory Locks.
      // This solves the horizontal scaling issue where multiple Lambdas crash into the same nonce.
      const txHash = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NONCE_LOCK_KEY}::bigint)`;
        const sent = await ctx.relayer.sendTransaction({
          ...populated,
          type: 2, // Explicit EIP-1559 transaction type
          chainId: ctx.config.chainId,
          nonce: await ctx.relayer.getTransactionCount('pending'),
          gasLimit: estimated.mul(GAS_LIMIT_NUMERATOR).div(GAS_LIMIT_DENOMINATOR),
          maxFeePerGas,
          maxPriorityFeePerGas,
        });
        await tx.contactlessPaymentTxOrMsg.update({ where: { uuid }, data: { txHash: sent.hash } });
        return sent.hash;
      }, { timeout: 20_000 });

      res.status(200).json({ txHash });
    } catch (error: unknown) {
      // Release the claim so a transient RPC failure does not permanently brick the payment.
      await prisma.contactlessPaymentTxOrMsg.updateMany({
        where: { uuid, txHash: null }, data: { relayClaimedAt: null },
      });
      throw error;
    }
  } catch (error: unknown) {
    if (error instanceof BadRequestError)      { res.status(400).json({ error: error.message }); return; }
    if (error instanceof ConflictError)        { res.status(409).json({ error: error.message }); return; }
    if (error instanceof UnsupportedChainError){ res.status(400).json({ error: 'unsupported chain' }); return; }
    if (error instanceof GasBudgetExhaustedError) {
      res.status(503).setHeader('Retry-After', '60').json({ error: 'relayer unavailable' });
      return;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      console.error('[submitPaymentTx] prisma', error.code);
      res.status(500).json({ error: 'internal error' });
      return;
    }
    
    // Never reflect exception text directly into the response (closes Information Disclosure vulnerability)
    console.error('[submitPaymentTx] relay failed', error);
    res.status(502).json({ error: 'relay failed' }); 
  }
}

class BadRequestError extends Error {}
class ConflictError extends Error {}