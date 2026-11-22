import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

const globalForPrisma = globalThis as unknown as { __tiqaPrisma?: PrismaClient };

export function createPrisma(url?: string): PrismaClient {
  return new PrismaClient(url ? { datasourceUrl: url } : undefined);
}

/** Process-wide singleton (avoids exhausting connections during dev hot reload). */
export const prisma: PrismaClient = globalForPrisma.__tiqaPrisma ?? createPrisma();
if (process.env.NODE_ENV !== "production") globalForPrisma.__tiqaPrisma = prisma;
