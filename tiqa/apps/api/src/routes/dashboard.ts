import { CsvImportRequest, generateApiKey, ScoreRequest } from "@tiqa/core";
import type { Prisma } from "@tiqa/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import { badRequest, notFound } from "../lib/errors";
import { validate } from "../lib/validate";
import { audit } from "../services/audit";
import { requireRole, requireSession } from "../services/auth";
import { getContribution } from "../services/contribution";
import { mapCsvRows, parseCsv, suggestMapping } from "../services/csv";
import { performLookup } from "../services/lookup";
import type { Network } from "../services/network";
import { ingestOutcomes } from "../services/outcomes";
import { hit } from "../services/rate-limit";
import { merchantStats } from "../services/stats";

/** Dashboard API (session cookie). Everything here is scoped to the signed-in user's merchant. */
export async function dashboardRoutes(app: FastifyInstance, { deps, network }: { deps: Deps; network: Network }) {
  const { prisma } = deps;

  app.get("/app/me", async (req) => {
    const s = await requireSession(deps, req);
    const contribution = await getContribution(deps, s.merchantId);
    return {
      user: { email: s.email, locale: s.locale, is_staff: s.isStaff },
      merchant: { id: s.merchantId, name: s.merchantName, role: s.role },
      contribution,
    };
  });

  app.patch("/app/me", async (req) => {
    const s = await requireSession(deps, req);
    const { locale } = validate(z.object({ locale: z.enum(["fr", "ar"]) }), req.body);
    await prisma.user.update({ where: { id: s.userId }, data: { locale } });
    return { ok: true };
  });

  app.patch("/app/merchant", async (req) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const body = validate(z.object({ failed_order_cost_mad: z.number().min(0).max(10_000) }), req.body);
    await prisma.merchant.update({
      where: { id: s.merchantId },
      data: { failedOrderCostCentimes: Math.round(body.failed_order_cost_mad * 100) },
    });
    return { ok: true };
  });

  // ── Lookup tool ─────────────────────────────────────────────────────────
  app.post("/app/lookup", async (req) => {
    const s = await requireSession(deps, req);
    const body = validate(ScoreRequest, req.body);
    const { response } = await performLookup(deps, network, {
      merchantId: s.merchantId,
      actor: { type: "user", id: s.userId },
      e164: body.phone,
      orderRef: body.order_ref,
      channel: "dashboard",
    });
    return response;
  });

  // ── Order history ───────────────────────────────────────────────────────
  app.get("/app/lookups", async (req) => {
    const s = await requireSession(deps, req);
    const q = validate(
      z.object({
        cursor: z.string().optional(),
        band: z.enum(["low", "medium", "high", "insufficient_data"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    const where: Prisma.LookupWhereInput = { merchantId: s.merchantId, ...(q.band ? { band: q.band } : {}) };
    const items = await prisma.lookup.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
      select: {
        id: true, createdAt: true, phoneLast2: true, merchantOrderRef: true, band: true, score: true,
        outcomesBucket: true, merchantsBucket: true, decision: true, channel: true,
      },
    });
    const page = items.slice(0, q.limit);
    // The merchant's OWN reported outcome for each order (by order ref).
    const refs = page.map((l) => l.merchantOrderRef).filter((r): r is string => !!r);
    const own = refs.length
      ? await prisma.outcome.findMany({
          where: { merchantId: s.merchantId, merchantOrderRef: { in: refs } },
          select: { merchantOrderRef: true, outcome: true },
        })
      : [];
    const ownByRef = new Map(own.map((o) => [o.merchantOrderRef, o.outcome]));
    return {
      items: page.map((l) => ({ ...l, own_outcome: l.merchantOrderRef ? (ownByRef.get(l.merchantOrderRef) ?? null) : null })),
      next_cursor: items.length > q.limit ? page[page.length - 1]!.id : null,
    };
  });

  app.patch("/app/lookups/:id", async (req) => {
    const s = await requireSession(deps, req);
    const { id } = req.params as { id: string };
    const { decision } = validate(z.object({ decision: z.enum(["shipped", "cancelled", "prepaid_required"]).nullable() }), req.body);
    const { count } = await prisma.lookup.updateMany({ where: { id, merchantId: s.merchantId }, data: { decision } });
    if (!count) throw notFound();
    return { ok: true };
  });

  // ── Stats ───────────────────────────────────────────────────────────────
  app.get("/app/stats", async (req) => {
    const s = await requireSession(deps, req);
    return merchantStats(deps, s.merchantId);
  });

  // ── CSV upload ──────────────────────────────────────────────────────────
  app.post("/app/outcomes/csv/preview", { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    await requireSession(deps, req);
    const { csv } = validate(z.object({ csv: z.string().min(1).max(10 * 1024 * 1024) }), req.body);
    const { headers, records } = parseCsv(csv);
    if (!headers.length) throw badRequest("CSV_EMPTY");
    return { headers, suggested_mapping: suggestMapping(headers), sample: records.slice(0, 5), total_rows: records.length };
  });

  app.post("/app/outcomes/csv", { bodyLimit: 12 * 1024 * 1024 }, async (req) => {
    const s = await requireSession(deps, req);
    await hit(deps.redis, `csv:${s.merchantId}`, 10);
    const body = validate(CsvImportRequest, req.body);
    const { headers, records } = parseCsv(body.csv);
    for (const col of Object.values(body.mapping)) {
      if (col && !headers.includes(col)) throw badRequest("CSV_MAPPING_UNKNOWN_COLUMN", { column: col });
    }
    const mapped = mapCsvRows(records, body.mapping, body.default_carrier);
    const res = await ingestOutcomes(deps, network, s.merchantId, mapped.rows, body.source_type);
    const report = {
      rows_total: records.length,
      inserted: res.inserted,
      updated: res.updated,
      unchanged: res.unchanged,
      skipped: mapped.skipped,
      failed: mapped.errors.length,
      errors: mapped.errors.slice(0, 1000),
    };
    const imp = await prisma.csvImport.create({
      data: {
        merchantId: s.merchantId,
        userId: s.userId,
        sourceType: body.source_type,
        rowsTotal: report.rows_total,
        inserted: report.inserted,
        updated: report.updated,
        skipped: report.skipped + report.unchanged,
        failed: report.failed,
        errors: report.errors,
      },
    });
    await audit(deps, {
      actor: { type: "user", id: s.userId },
      merchantId: s.merchantId,
      action: "csv_import",
      result: { import_id: imp.id, ...report, errors: undefined },
    });
    await getContribution(deps, s.merchantId, { fresh: true });
    return { import_id: imp.id, ...report };
  });

  app.get("/app/imports", async (req) => {
    const s = await requireSession(deps, req);
    return prisma.csvImport.findMany({
      where: { merchantId: s.merchantId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, createdAt: true, sourceType: true, rowsTotal: true, inserted: true, updated: true, skipped: true, failed: true },
    });
  });

  // ── API keys ────────────────────────────────────────────────────────────
  app.get("/app/api-keys", async (req) => {
    const s = await requireSession(deps, req);
    return prisma.apiKey.findMany({
      where: { merchantId: s.merchantId },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, prefix: true, scopes: true, lastUsedAt: true, revokedAt: true, createdAt: true },
    });
  });

  app.post("/app/api-keys", async (req, reply) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const { name } = validate(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
    const active = await prisma.apiKey.count({ where: { merchantId: s.merchantId, revokedAt: null } });
    if (active >= 10) throw badRequest("TOO_MANY_API_KEYS");
    const k = generateApiKey(deps.env.NODE_ENV === "production" ? "live" : "test");
    const created = await prisma.apiKey.create({
      data: { merchantId: s.merchantId, name, prefix: k.prefix, secretHash: k.secretHash, createdBy: s.userId },
    });
    await audit(deps, { actor: { type: "user", id: s.userId }, merchantId: s.merchantId, action: "api_key_create", result: { id: created.id } });
    reply.code(201);
    // The full key is returned exactly once.
    return { id: created.id, name, prefix: k.prefix, key: k.key };
  });

  app.delete("/app/api-keys/:id", async (req) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const { id } = req.params as { id: string };
    const { count } = await prisma.apiKey.updateMany({
      where: { id, merchantId: s.merchantId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!count) throw notFound();
    await audit(deps, { actor: { type: "user", id: s.userId }, merchantId: s.merchantId, action: "api_key_revoke", result: { id } });
    return { ok: true };
  });
}
