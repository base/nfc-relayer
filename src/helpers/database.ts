import { PrismaClient } from '@prisma/client';

/**
 * Cached client.
 *
 * Held on `globalThis` so that Next.js's development-mode module reloading does
 * not create a new `PrismaClient` — and therefore a new connection pool — on every
 * edit, which exhausts the database's connection limit.
 */
const globalForPrisma = globalThis as typeof globalThis & {
  __nfcRelayerPrisma?: PrismaClient;
};

/**
 * Returns the shared Prisma client.
 *
 * The datasource URL is read from `DATABASE_URL_POOLED`, matching the
 * `datasource db` block in `prisma/schema.prisma`. The previous implementation
 * overrode the URL with `process.env.DATABASE_URL`, so the generated client and
 * the schema disagreed: whichever of the two variables was set in a given
 * environment silently decided which database was used, and connection pooling
 * was bypassed whenever only the unpooled variable was present.
 */
export function getPrismaClient(): PrismaClient {
  if (!globalForPrisma.__nfcRelayerPrisma) {
    const url = process.env.DATABASE_URL_POOLED ?? process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'DATABASE_URL_POOLED is not set; the Prisma client cannot be initialised',
      );
    }

    globalForPrisma.__nfcRelayerPrisma = new PrismaClient({
      datasources: { db: { url } },
    });
  }

  return globalForPrisma.__nfcRelayerPrisma;
}

/**
 * Closes the shared connection pool.
 *
 * Intended for process shutdown and test teardown only. Calling this from a
 * request handler disconnects the pool out from under every other in-flight
 * request served by the same process.
 */
export async function disconnectPrisma(): Promise<void> {
  const client = globalForPrisma.__nfcRelayerPrisma;
  if (!client) {
    return;
  }
  await client.$disconnect();
  globalForPrisma.__nfcRelayerPrisma = undefined;
}
