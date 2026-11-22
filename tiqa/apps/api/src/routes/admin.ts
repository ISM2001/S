import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import { badRequest, notFound, unauthorized } from "../lib/errors";
import { decrypt, encrypt } from "../lib/crypto";
import { newTotpSecret, otpauthUri, verifyTotp } from "../lib/totp";
import { hit } from "../services/rate-limit";
import { validate } from "../lib/validate";
import { runTrustJob } from "../jobs/trust";
import { audit } from "../services/audit";
import { requireStaff } from "../services/auth";
import type { Network } from "../services/network";
import { resolveRequest } from "../services/requests";

/** Staff-only admin panel API: consumer requests, merchant trust, anomaly flags. */
export async function adminRoutes(app: FastifyInstance, { deps, network }: { deps: Deps; network: Network }) {
  const { prisma } = deps;

  app.get("/admin/me", async (req) => {
    const s = await requireStaff(deps, req, { allowNoMfa: true });
    const mfa = !deps.env.STAFF_MFA_REQUIRED || s.mfaVerified ? "ok" : s.mfaEnabled ? "required" : "setup_required";
    return { email: s.email, mfa };
  });

  /** Start TOTP enrolment (only while not yet enabled). Returns the secret + otpauth:// URI for the QR code. */
  app.post("/admin/mfa/setup", async (req) => {
    const s = await requireStaff(deps, req, { allowNoMfa: true });
    if (s.mfaEnabled) throw badRequest("MFA_ALREADY_ENABLED");
    const secret = newTotpSecret();
    await prisma.user.update({ where: { id: s.userId }, data: { totpSecretEnc: encrypt(secret, deps.env.INTEGRATION_ENC_KEY) } });
    return { secret, otpauth_uri: otpauthUri(secret, s.email) };
  });

  /** Verify a TOTP code: enables 2FA on first success, marks this session as verified. Codes can't be replayed. */
  app.post("/admin/mfa/verify", async (req) => {
    const s = await requireStaff(deps, req, { allowNoMfa: true });
    await hit(deps.redis, `mfa:${s.userId}`, 10, 900);
    const { code } = validate(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    if (!s.totpSecretEnc) throw badRequest("MFA_NOT_SET_UP");
    const step = verifyTotp(decrypt(s.totpSecretEnc, deps.env.INTEGRATION_ENC_KEY), code);
    if (step === null) throw unauthorized("MFA_CODE_INVALID");
    const fresh = await deps.redis.set(`tiqa:mfa-step:${s.userId}:${step}`, "1", "EX", 120, "NX");
    if (fresh !== "OK") throw unauthorized("MFA_CODE_INVALID");
    if (!s.mfaEnabled) await prisma.user.update({ where: { id: s.userId }, data: { totpEnabledAt: new Date() } });
    await prisma.session.update({ where: { idHash: s.sessionIdHash }, data: { mfaAt: new Date() } });
    await audit(deps, { actor: { type: "staff", id: s.userId }, action: s.mfaEnabled ? "mfa_verified" : "mfa_enabled" });
    return { ok: true };
  });

  app.get("/admin/overview", async (req) => {
    await requireStaff(deps, req);
    const [openRequests, openFlags, merchants, lowTrust] = await Promise.all([
      prisma.dataSubjectRequest.count({ where: { status: "open" } }),
      prisma.anomalyFlag.count({ where: { status: "open" } }),
      prisma.merchant.count(),
      prisma.merchant.count({ where: { OR: [{ trustWeight: { lt: 0.7 } }, { trustOverride: { lt: 0.7 } }] } }),
    ]);
    return { open_requests: openRequests, open_flags: openFlags, merchants, low_trust_merchants: lowTrust };
  });

  // ── Consumer requests ─────────────────────────────────────────────────
  app.get("/admin/requests", async (req) => {
    await requireStaff(deps, req);
    const q = validate(z.object({ status: z.enum(["open", "upheld", "rejected"]).default("open") }), req.query);
    const rows = await prisma.dataSubjectRequest.findMany({
      where: { status: q.status },
      orderBy: { createdAt: q.status === "open" ? "asc" : "desc" },
      take: 100,
      include: { items: { orderBy: { occurredAt: "desc" } } },
    });
    const merchantIds = [...new Set(rows.flatMap((r) => r.items.map((i) => i.merchantId)))];
    const names = new Map((await prisma.merchant.findMany({ where: { id: { in: merchantIds } }, select: { id: true, name: true } })).map((m) => [m.id, m.name]));
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      message: r.message,
      created_at: r.createdAt,
      resolved_at: r.resolvedAt,
      resolution_note: r.resolutionNote,
      // Staff see merchant + order ref so they can ask the merchant for proof. Never a phone number.
      items: r.items.map((i) => ({
        merchant_id: i.merchantId,
        merchant_name: names.get(i.merchantId) ?? "(deleted)",
        outcome: i.outcome,
        source: i.source,
        occurred_at: i.occurredAt,
        order_ref: i.merchantOrderRef,
      })),
    }));
  });

  app.post("/admin/requests/:id/resolve", async (req) => {
    const s = await requireStaff(deps, req);
    const { id } = req.params as { id: string };
    const body = validate(z.object({ decision: z.enum(["upheld", "rejected"]), note: z.string().trim().max(1000).optional() }), req.body);
    await resolveRequest(deps, network, { requestId: id, decision: body.decision, note: body.note, staffUserId: s.userId });
    return { ok: true };
  });

  // ── Merchants & trust ─────────────────────────────────────────────────
  app.get("/admin/merchants", async (req) => {
    await requireStaff(deps, req);
    const merchants = await prisma.merchant.findMany({
      orderBy: [{ trustWeight: "asc" }, { createdAt: "asc" }],
      take: 500,
      select: {
        id: true, name: true, status: true, trustWeight: true, trustOverride: true, trustComputedAt: true, trustDetails: true, createdAt: true,
        _count: { select: { outcomes: true, lookups: true, flags: { where: { status: "open" } } } },
      },
    });
    return merchants.map((m) => ({
      id: m.id, name: m.name, status: m.status, created_at: m.createdAt,
      trust_weight: m.trustWeight, trust_override: m.trustOverride,
      effective_trust: m.status === "suspended" ? 0 : (m.trustOverride ?? m.trustWeight),
      trust_computed_at: m.trustComputedAt, trust_details: m.trustDetails,
      outcomes: m._count.outcomes, lookups: m._count.lookups, open_flags: m._count.flags,
    }));
  });

  app.patch("/admin/merchants/:id", async (req) => {
    const s = await requireStaff(deps, req);
    const { id } = req.params as { id: string };
    const body = validate(
      z.object({ trust_override: z.number().min(0).max(1).nullable().optional(), status: z.enum(["active", "suspended"]).optional() }),
      req.body,
    );
    const m = await prisma.merchant.findUnique({ where: { id } });
    if (!m) throw notFound();
    await prisma.merchant.update({
      where: { id },
      data: {
        ...(body.trust_override !== undefined ? { trustOverride: body.trust_override } : {}),
        ...(body.status ? { status: body.status } : {}),
      },
    });
    network.clearTrustCache();
    await audit(deps, {
      actor: { type: "staff", id: s.userId },
      merchantId: id,
      action: "admin_update_merchant",
      result: { before: { trust_override: m.trustOverride, status: m.status }, after: body },
    });
    return { ok: true };
  });

  // ── Anomaly flags ─────────────────────────────────────────────────────
  app.get("/admin/flags", async (req) => {
    await requireStaff(deps, req);
    const q = validate(z.object({ status: z.enum(["open", "dismissed", "actioned"]).default("open") }), req.query);
    const flags = await prisma.anomalyFlag.findMany({
      where: { status: q.status },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { merchant: { select: { name: true, trustWeight: true, trustOverride: true } } },
    });
    return flags.map((f) => ({
      id: f.id, merchant_id: f.merchantId, merchant_name: f.merchant.name, kind: f.kind, severity: f.severity,
      details: f.details, status: f.status, created_at: f.createdAt, reviewed_at: f.reviewedAt,
      merchant_trust: f.merchant.trustOverride ?? f.merchant.trustWeight,
    }));
  });

  app.patch("/admin/flags/:id", async (req) => {
    const s = await requireStaff(deps, req);
    const { id } = req.params as { id: string };
    const { status } = validate(z.object({ status: z.enum(["dismissed", "actioned"]) }), req.body);
    const { count } = await prisma.anomalyFlag.updateMany({ where: { id, status: "open" }, data: { status, reviewedBy: s.userId, reviewedAt: new Date() } });
    if (!count) throw notFound();
    await audit(deps, { actor: { type: "staff", id: s.userId }, action: "admin_review_flag", result: { flag_id: id, status } });
    return { ok: true };
  });

  app.post("/admin/trust/recompute", async (req) => {
    const s = await requireStaff(deps, req);
    const res = await runTrustJob(prisma);
    network.clearTrustCache();
    await audit(deps, { actor: { type: "staff", id: s.userId }, action: "admin_trust_recompute", result: res });
    return res;
  });
}
