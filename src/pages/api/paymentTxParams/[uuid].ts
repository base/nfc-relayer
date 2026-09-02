import { NextApiRequest, NextApiResponse } from 'next';
import { ethers } from 'ethers';
import { getPaymentTxOrMsg } from '@/services/paymentTxOrMsgService';
import { applyCors } from '@/services/cors';

/**
 * Matches the canonical RFC 4122 UUID form produced by `uuidv4()`.
 *
 * Constraining the shape keeps malformed identifiers out of the database query
 * and makes enumeration attempts obvious rather than indistinguishable from
 * ordinary traffic.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // `applyCors` writes its own response when the origin is rejected or the
  // middleware fails, and reports `false` so no second write is attempted.
  if (!(await applyCors(req, res))) {
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
    return;
  }

  try {
    const { uuid, senderAddress } = req.query;

    if (typeof uuid !== 'string' || !UUID_PATTERN.test(uuid)) {
      res.status(400).json({ message: 'Invalid UUID' });
      return;
    }

    if (
      senderAddress !== undefined &&
      (typeof senderAddress !== 'string' || !ethers.utils.isAddress(senderAddress))
    ) {
      res.status(400).json({ message: 'Invalid sender address' });
      return;
    }

    // The response never contains the payment's verificationCode; see
    // `toPublicPayment` in paymentTxOrMsgService.
    const paymentTxOrMsg = await getPaymentTxOrMsg(uuid, senderAddress);
    res.status(200).json(paymentTxOrMsg);
  } catch (error) {
    // Log the detail server-side and return a generic message. The previous
    // implementation interpolated `(error as Error).message` into the response,
    // which disclosed Prisma internals and distinguished "not found" from other
    // failures to an unauthenticated caller.
    console.error('Error retrieving payment transaction:', error);
    res.status(500).json({ message: 'Error retrieving payment transaction' });
  }
}
