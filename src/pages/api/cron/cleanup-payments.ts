import { cleanupOldPayments } from '@helpers/cleanup-payments';
import { secureCompare } from '@helpers/secure-compare';
import type { NextApiRequest, NextApiResponse } from 'next';

export default async function handler(request: NextApiRequest, response: NextApiResponse) {
  if (request.method !== 'POST' && request.method !== 'GET') {
    response.setHeader('Allow', ['GET', 'POST']);
    response.status(405).json({ success: false, message: `Method ${request.method} Not Allowed` });
    return;
  }

  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers['authorization'];

  // Fail closed when the secret is not configured, and compare in constant time.
  // The previous `authHeader !== \`Bearer ${secret}\`` comparison short-circuits on
  // the first differing byte, so response timing revealed how much of the secret
  // a guess had right.
  if (!cronSecret || !secureCompare(authHeader, `Bearer ${cronSecret}`)) {
    response.status(401).json({ success: false });
    return;
  }

  try {
    const deletedCount = await cleanupOldPayments();
    console.log(`Cleaned up ${deletedCount} old payment transactions`);

    response
      .status(200)
      .json({ success: true, message: `Cleaned up ${deletedCount} old payment transactions` });
  } catch (error) {
    // The cleanup helper rethrows; without this the rejection escapes the handler
    // and Next.js returns an unstructured 500.
    console.error('Cron cleanup failed:', error);
    response.status(500).json({ success: false, message: 'Cleanup failed' });
  }
}
