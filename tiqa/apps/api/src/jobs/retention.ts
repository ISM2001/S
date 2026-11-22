import type { PrismaClient } from "@tiqa/db";
import { monthsAgo } from "../lib/time";

/**
 * Data retention (Law 09-08: keep data no longer than necessary).
 * - Shared outcomes older than RETENTION_MONTHS are hard-deleted.
 * - Merchant lookup history follows the same retention.
 * - Audit logs have their own (longer) retention.
 * - Expired sessions and magic links are removed.
 */
export async function runRetention(
  prisma: PrismaClient,
  cfg: { retentionMonths: number; auditRetentionMonths: number },
  now = new Date(),
) {
  const cutoff = monthsAgo(cfg.retentionMonths, now);
  const auditCutoff = monthsAgo(cfg.auditRetentionMonths, now);
  const BATCH = 10_000;

  // Delete in batches so a large backlog doesn't lock the table for long.
  let outcomes = 0;
  for (;;) {
    const n = await prisma.$executeRaw`
      DELETE FROM "Outcome" WHERE "id" IN (SELECT "id" FROM "Outcome" WHERE "occurredAt" < ${cutoff} LIMIT ${BATCH})`;
    outcomes += n;
    if (n < BATCH) break;
  }
  const lookups = await prisma.lookup.deleteMany({ where: { createdAt: { lt: cutoff } } });
  const auditLogs = await prisma.auditLog.deleteMany({ where: { at: { lt: auditCutoff } } });
  const sessions = await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
  const magicLinks = await prisma.magicLink.deleteMany({ where: { expiresAt: { lt: now } } });
  const otps = await prisma.otpChallenge.deleteMany({ where: { expiresAt: { lt: now } } });
  const consumerSessions = await prisma.consumerSession.deleteMany({ where: { expiresAt: { lt: now } } });

  return { cutoff, outcomes, lookups: lookups.count, auditLogs: auditLogs.count, sessions: sessions.count, magicLinks: magicLinks.count, otps: otps.count, consumerSessions: consumerSessions.count };
}
