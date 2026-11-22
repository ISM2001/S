import type { Plan, Prisma, PrismaClient } from "@tiqa/db";
import type { Env } from "../env";

export interface InvoiceLine { label: string; quantity: number; unitCentimes: number; totalCentimes: number }

/** PURE: invoice amounts for one month of usage. VAT is rounded once on the subtotal. */
export function computeInvoice(plan: Pick<Plan, "nameFr" | "monthlyFeeCentimes" | "includedLookups" | "overageCentimesPerLookup">, lookups: number, vatRateBp: number) {
  const lines: InvoiceLine[] = [];
  if (plan.monthlyFeeCentimes > 0) {
    lines.push({ label: `Abonnement ${plan.nameFr} (${plan.includedLookups} vérifications incluses)`, quantity: 1, unitCentimes: plan.monthlyFeeCentimes, totalCentimes: plan.monthlyFeeCentimes });
  }
  const overage = Math.max(0, lookups - plan.includedLookups);
  if (overage > 0 && plan.overageCentimesPerLookup > 0) {
    lines.push({ label: "Vérifications supplémentaires", quantity: overage, unitCentimes: plan.overageCentimesPerLookup, totalCentimes: overage * plan.overageCentimesPerLookup });
  }
  const subtotalCentimes = lines.reduce((s, l) => s + l.totalCentimes, 0);
  const vatCentimes = Math.round((subtotalCentimes * vatRateBp) / 10_000);
  return { lines, overage, subtotalCentimes, vatRateBp, vatCentimes, totalCentimes: subtotalCentimes + vatCentimes };
}

/** Next number in a gapless series. MUST be called inside the transaction that creates the document. */
export async function nextNumber(tx: Prisma.TransactionClient, prefix: "FAC" | "AV", year: number): Promise<string> {
  const series = `${prefix}-${year}`;
  await tx.$executeRaw`INSERT INTO "DocumentCounter" ("series", "last") VALUES (${series}, 0) ON CONFLICT ("series") DO NOTHING`;
  const [row] = await tx.$queryRaw<Array<{ last: number }>>`UPDATE "DocumentCounter" SET "last" = "last" + 1 WHERE "series" = ${series} RETURNING "last"`;
  return `${series}-${String(row!.last).padStart(5, "0")}`;
}

export const previousPeriod = (now = new Date()) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
};

export function sellerSnapshot(env: Env) {
  return {
    name: env.BILLING_SELLER_NAME, ice: env.BILLING_SELLER_ICE, rc: env.BILLING_SELLER_RC, if: env.BILLING_SELLER_IF,
    address: env.BILLING_SELLER_ADDRESS, bank: env.BILLING_BANK, rib: env.BILLING_RIB,
  };
}

/**
 * Issue invoices for a closed period (idempotent: one invoice per merchant and period).
 * Free usage (total 0) produces no invoice. The plan used is the merchant's plan at generation time.
 */
export async function generateInvoices(prisma: PrismaClient, env: Env, period: string, now = new Date()) {
  const subs = await prisma.subscription.findMany({ where: { status: "active" }, include: { plan: true, merchant: true } });
  let issued = 0, skipped = 0;
  for (const sub of subs) {
    if (await prisma.invoice.findUnique({ where: { merchantId_period: { merchantId: sub.merchantId, period } } })) { skipped++; continue; }
    const usage = await prisma.usageMonthly.findUnique({ where: { merchantId_period: { merchantId: sub.merchantId, period } } });
    const c = computeInvoice(sub.plan, usage?.lookups ?? 0, env.VAT_RATE_BP);
    if (c.totalCentimes === 0) { skipped++; continue; }
    const m = sub.merchant;
    try {
    await prisma.$transaction(async (tx) => {
      await tx.invoice.create({
        data: {
          number: await nextNumber(tx, "FAC", now.getUTCFullYear()),
          merchantId: m.id,
          period,
          issuedAt: now,
          dueAt: new Date(now.getTime() + env.INVOICE_DUE_DAYS * 86_400_000),
          lines: c.lines as unknown as Prisma.InputJsonArray,
          subtotalCentimes: c.subtotalCentimes,
          vatRateBp: c.vatRateBp,
          vatCentimes: c.vatCentimes,
          totalCentimes: c.totalCentimes,
          seller: sellerSnapshot(env),
          buyer: { name: m.billingLegalName ?? m.name, ice: m.billingIce, address: m.billingAddress, city: m.billingCity, email: m.billingEmail },
        },
      });
    });
    } catch (e) {
      // A concurrent run already issued it: the transaction (and its number) was rolled back, so no gap.
      if ((e as { code?: string }).code === "P2002") { skipped++; continue; }
      throw e;
    }
    issued++;
  }
  return { period, issued, skipped };
}

/** Free plan (no overage price): lookups stop at the included quota. Paid plans continue and are billed as overage. */
export async function checkQuota(prisma: PrismaClient, merchantId: string, period: string): Promise<{ blocked: boolean; included?: number }> {
  const sub = await prisma.subscription.findUnique({ where: { merchantId }, include: { plan: true } });
  if (!sub || sub.plan.overageCentimesPerLookup > 0) return { blocked: false };
  const usage = await prisma.usageMonthly.findUnique({ where: { merchantId_period: { merchantId, period } }, select: { lookups: true } });
  return { blocked: (usage?.lookups ?? 0) >= sub.plan.includedLookups, included: sub.plan.includedLookups };
}
