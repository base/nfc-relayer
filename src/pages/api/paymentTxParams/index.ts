import { applyCors } from '@/services/cors';
import { createPaymentTxOrMsg } from '@/services/paymentTxOrMsgService';
import { Payload, PayloadType } from '@/types/paymentTx';
import { NextApiRequest, NextApiResponse } from 'next';

/** Payload types this endpoint accepts. */
const SUPPORTED_PAYLOAD_TYPES: readonly PayloadType[] = ['eip681', 'contractCall', 'eip712'];

/** Widest decimal chain id accepted, matching the `chainId String` column. */
const CHAIN_ID_PATTERN = /^\d{1,20}$/;

/**
 * Normalises a caller-supplied chain id to the decimal string the schema stores.
 *
 * `chainId` reaches the sponsorship path through the stored record, so it is
 * validated rather than accepted as an arbitrary value. Numbers are accepted as
 * well as strings — JSON clients naturally send `8453`, and the database column is
 * `String`, so a coercion has to happen somewhere. It happens here, once, after
 * the value has been proven to be a non-negative integer.
 *
 * @returns The canonical decimal string, or `null` when the input is not a
 *   well-formed chain id.
 */
function normalizeChainId(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      return null;
    }
    return String(value);
  }
  if (typeof value === 'string' && CHAIN_ID_PATTERN.test(value)) {
    return value;
  }
  return null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // `applyCors` writes its own response when the origin is rejected or the
  // middleware fails, and reports `false` so no second write is attempted.
  if (!(await applyCors(req, res))) {
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
    return;
  }

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;

    const payloadType = body.payloadType;
    if (
      typeof payloadType !== 'string' ||
      !SUPPORTED_PAYLOAD_TYPES.includes(payloadType as PayloadType)
    ) {
      res.status(400).json({ message: 'Invalid or missing payload type' });
      return;
    }

    const chainId = normalizeChainId(body.chainId);
    if (chainId === null) {
      res.status(400).json({ message: 'chainId must be a non-negative integer' });
      return;
    }

    // `dappUrl` is rendered by clients as the origin of the payment request, so a
    // non-http scheme here would be a phishing primitive.
    const dappUrl = body.dappUrl;
    if (dappUrl !== undefined) {
      if (typeof dappUrl !== 'string') {
        res.status(400).json({ message: 'dappUrl must be a string' });
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(dappUrl);
      } catch {
        res.status(400).json({ message: 'dappUrl must be a valid absolute URL' });
        return;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        res.status(400).json({ message: 'dappUrl must use http or https' });
        return;
      }
    }

    // The normalised `chainId` replaces whatever the client sent, so the value
    // that reaches the database is always the canonical decimal string.
    const paymentTxOrMsg = await createPaymentTxOrMsg({
      ...body,
      chainId,
    } as unknown as Payload);

    // The verification code is returned exactly once, to the creator of the
    // payment request. The creator embeds it in the NFC/QR payload handed to the
    // payer, and the payer presents it back when submitting. It is never included
    // in the public GET response for a uuid.
    res.status(201).json({
      message: 'Payment relay stored successfully',
      uuid: paymentTxOrMsg.uuid,
      verificationCode: paymentTxOrMsg.verificationCode,
    });
  } catch (error) {
    // Log server-side, return an opaque message. Echoing `(error as Error).message`
    // exposed Prisma and database diagnostics to unauthenticated callers.
    console.error('Error storing payment:', error);
    res.status(500).json({ message: 'Error storing payment transaction params' });
  }
}
