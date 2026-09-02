import { getPrismaClient } from './database';

/** Payment records older than this are considered abandoned and are removed. */
const PAYMENT_RETENTION_MS = 5 * 60 * 1000;

/**
 * Deletes payment records older than {@link PAYMENT_RETENTION_MS}.
 *
 * @returns The number of records removed.
 */
export async function cleanupOldPayments(): Promise<number> {
  const prisma = getPrismaClient();
  const cutoff = new Date(Date.now() - PAYMENT_RETENTION_MS);

  try {
    const result = await prisma.contactlessPaymentTxOrMsg.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    console.log(`Deleted ${result.count} old payment transactions`);
    return result.count;
  } catch (error) {
    console.error('Error cleaning up old payments:', error);
    throw error;
  }
  // The previous implementation called `prisma.$disconnect()` in a `finally`
  // block. The client is a process-wide singleton, so disconnecting here tore
  // down the connection pool shared with every concurrent request handler.
}
