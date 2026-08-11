import { applyCors } from '@/lib/http/cors';
import { createPaymentTxOrMsg } from '@/services/paymentTxOrMsgService';
import { Payload } from '@/types/paymentTx';
import { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // [SECURITY PATCH]: Use native Next.js CORS wrapper with proper method filtering
  if (!applyCors(req, res, ['POST', 'OPTIONS'])) return;

  if (req.method === 'POST') {
    try {
      // Basic payload type validation
      const payloadType = req.body?.payloadType;
      if (!payloadType || !['eip681', 'contractCall', 'eip712'].includes(payloadType)) {
        res.status(400).json({ message: 'Invalid or missing payload type' });
        return;
      }

      // Write to database via secured service
      const paymentTxOrMsg = await createPaymentTxOrMsg(req.body as Payload);

      // Return successful creation response with server-generated UUID
      res.status(201).json({
        message: 'Payment relay stored successfully',
        uuid: paymentTxOrMsg.uuid,
      });
    } catch (error: unknown) {
      // Log the actual error internally for debugging/monitoring
      console.error('[paymentTxParams] Error storing payment:', error);

      // [SECURITY PATCH]: Prevent Information Disclosure. 
      // Never interpolate raw Prisma or system error messages (`(error as Error).message`) into the response body.
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        res.status(400).json({ message: 'Database request failed' });
        return;
      }

      res.status(500).json({ message: 'Internal server error' });
    }
  } else {
    // Handled gracefully by applyCors, but kept as a failsafe
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}