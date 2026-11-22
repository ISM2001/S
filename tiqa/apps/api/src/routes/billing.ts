import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import { badRequest, notFound } from "../lib/errors";
import { period } from "../lib/time";
import { validate } from "../lib/validate";
import { audit } from "../services/audit";
import { requireRole, requireSession, requireStaff } from "../services/auth";
import { computeInvoice, generateInvoices, nextNumber, previousPeriod } from "../services/billing";

/** Billing (amounts in MAD centimes). Payments are recorded manually by staff until a gateway is chosen. */
export async function billingRoutes(app: FastifyInstance, { deps }: { deps: Deps }) {
  const { prisma, env } = deps;

  app.get("/app/billing", async (req) => {
    const s = await requireSession(deps, req);
    const [sub, plans, usage, merchant, invoices] = await Promise.all([
      prisma.subscription.findUnique({ where: { merchantId: s.merchantId }, include: { plan: true } }),
      prisma.plan.findMany({ orderBy: { monthlyFeeCentimes: "asc" } }),
      prisma.usageMonthly.findUnique({ where: { merchantId_period: { merchantId: s.merchantId, period: period() } } }),
      prisma.merchant.findUniqueOrThrow({ where: { id: s.merchantId } }),
      prisma.invoice.findMany({
        where: { merchantId: s.merchantId }, orderBy: { issuedAt: "desc" }, take: 24,
        select: { id: true, number: true, period: true, status: true, issuedAt: true, dueAt: true, totalCentimes: true, creditNoteNumber: true },
      }),
    ]);
    const lookups = usage?.lookups ?? 0;
    return {
      plan: sub?.plan ?? null,
      plans,
      usage: { period: period(), lookups },
      estimate: sub ? computeInvoice(sub.plan, lookups, env.VAT_RATE_BP) : null,
      profile: { legal_name: merchant.billingLegalName, ice: merchant.billingIce, address: merchant.billingAddress, city: merchant.billingCity, email: merchant.billingEmail },
      payment: { method: "bank_transfer", bank: env.BILLING_BANK, rib: env.BILLING_RIB },
      invoices: invoices.map((i) => ({ ...i, overdue: i.status === "issued" && i.dueAt < new Date() })),
    };
  });

  app.patch("/app/billing/profile", async (req) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const b = validate(
      z.object({
        legal_name: z.string().trim().min(2).max(160),
        ice: z.string().trim().regex(/^\d{15}$/, "ICE_15_DIGITS").nullable().optional(),
        address: z.string().trim().max(300).nullable().optional(),
        city: z.string().trim().max(80).nullable().optional(),
        email: z.string().trim().email().max(200).nullable().optional(),
      }),
      req.body,
    );
    await prisma.merchant.update({
      where: { id: s.merchantId },
      data: { billingLegalName: b.legal_name, billingIce: b.ice ?? null, billingAddress: b.address ?? null, billingCity: b.city ?? null, billingEmail: b.email ?? null },
    });
    return { ok: true };
  });

  app.patch("/app/billing/plan", async (req) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner"]);
    const { code } = validate(z.object({ code: z.string().min(1).max(40) }), req.body);
    const plan = await prisma.plan.findUnique({ where: { code } });
    if (!plan) throw badRequest("PLAN_UNKNOWN");
    if (plan.monthlyFeeCentimes > 0) {
      const m = await prisma.merchant.findUniqueOrThrow({ where: { id: s.merchantId } });
      if (!m.billingLegalName) throw badRequest("BILLING_PROFILE_REQUIRED");
    }
    await prisma.subscription.upsert({
      where: { merchantId: s.merchantId },
      create: { merchantId: s.merchantId, planId: plan.id },
      update: { planId: plan.id, status: "active" },
    });
    await audit(deps, { actor: { type: "user", id: s.userId }, merchantId: s.merchantId, action: "plan_change", result: { plan: code } });
    return { ok: true };
  });

  app.get("/app/billing/invoices/:id", async (req) => {
    const s = await requireSession(deps, req);
    const { id } = req.params as { id: string };
    const inv = await prisma.invoice.findFirst({ where: { id, merchantId: s.merchantId } });
    if (!inv) throw notFound();
    return inv;
  });

  // ── Staff ──────────────────────────────────────────────────────────────
  app.get("/admin/invoices", async (req) => {
    await requireStaff(deps, req);
    const q = validate(z.object({ status: z.enum(["issued", "paid", "cancelled", "overdue"]).default("issued") }), req.query);
    const where = q.status === "overdue" ? { status: "issued" as const, dueAt: { lt: new Date() } } : { status: q.status };
    const rows = await prisma.invoice.findMany({ where, orderBy: { issuedAt: "desc" }, take: 200, include: { merchant: { select: { name: true } } } });
    return rows.map((i) => ({
      id: i.id, number: i.number, merchant_name: i.merchant.name, period: i.period, status: i.status, total_centimes: i.totalCentimes,
      issued_at: i.issuedAt, due_at: i.dueAt, paid_at: i.paidAt, payment_ref: i.paymentRef, credit_note: i.creditNoteNumber,
      overdue: i.status === "issued" && i.dueAt < new Date(),
    }));
  });

  app.post("/admin/invoices/:id/mark-paid", async (req) => {
    const s = await requireStaff(deps, req);
    const { id } = req.params as { id: string };
    const b = validate(z.object({ method: z.enum(["bank_transfer", "card", "cash", "other"]), reference: z.string().trim().min(1).max(120) }), req.body);
    const { count } = await prisma.invoice.updateMany({ where: { id, status: "issued" }, data: { status: "paid", paidAt: new Date(), paymentMethod: b.method, paymentRef: b.reference } });
    if (!count) throw badRequest("INVOICE_NOT_PAYABLE");
    await audit(deps, { actor: { type: "staff", id: s.userId }, action: "invoice_paid", result: { invoice_id: id, ...b } });
    return { ok: true };
  });

  /** Issued invoices are never deleted: cancellation creates a credit note (avoir) in its own gapless series. */
  app.post("/admin/invoices/:id/cancel", async (req) => {
    const s = await requireStaff(deps, req);
    const { id } = req.params as { id: string };
    const { reason } = validate(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
    const number = await prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.findUnique({ where: { id } });
      if (!inv || inv.status === "cancelled") throw badRequest("INVOICE_NOT_CANCELLABLE");
      const av = await nextNumber(tx, "AV", new Date().getUTCFullYear());
      await tx.invoice.update({ where: { id }, data: { status: "cancelled", creditNoteNumber: av, cancelledAt: new Date(), cancelReason: reason } });
      return av;
    });
    await audit(deps, { actor: { type: "staff", id: s.userId }, action: "invoice_cancelled", result: { invoice_id: id, credit_note: number } });
    return { ok: true, credit_note: number };
  });

  app.post("/admin/billing/run", async (req) => {
    const s = await requireStaff(deps, req);
    const { period: p } = validate(z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional() }), req.body ?? {});
    const target = p ?? previousPeriod();
    if (target >= period()) throw badRequest("PERIOD_NOT_CLOSED");
    const res = await generateInvoices(prisma, env, target);
    await audit(deps, { actor: { type: "staff", id: s.userId }, action: "billing_run", result: res });
    return res;
  });

}
