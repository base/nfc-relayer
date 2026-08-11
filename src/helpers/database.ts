import { PrismaClient } from '@prisma/client';
import { requireEnv } from '@/lib/env';

declare global {
  // eslint-disable-next-line no-var
  var __prismaClient: PrismaClient | undefined;
}

export function getPrismaClient(): PrismaClient {
  // [SECURITY PATCH]: Replaced `process.env.DATABASE_URL` with `requireEnv('DATABASE_URL_POOLED')`.
  // A constructor datasource overrides schema.prisma's env("DATABASE_URL_POOLED").
  // Because DATABASE_URL was used (which is documented as the NON-pooled migration connection), 
  // every runtime query previously bypassed the pooler and exhausted direct Postgres connections.
  
  // We also pin the client to `globalThis` so that Next.js Hot Module Replacement (HMR) 
  // does not leak connections by creating a new instance on every file save.
  globalThis.__prismaClient ??= new PrismaClient({
    datasources: { db: { url: requireEnv('DATABASE_URL_POOLED') } },
    log: ['warn', 'error'],
  });
  
  return globalThis.__prismaClient;
}

// [SECURITY PATCH]: `disconnectPrisma` has been intentionally deleted.
// Calling `$disconnect()` in a `finally` block (as the cron handler previously did) destroys 
// the connection for the entire warm Lambda environment. By keeping the connection open, 
// subsequent requests to the same warm Lambda avoid costly database reconnection latency.