import { randomInt } from "node:crypto";
import { randomToken, safeEqual, sha256, zPhone, type Bytes } from "@tiqa/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import { ApiError, badRequest, unauthorized } from "../lib/errors";
import { validate } from "../lib/validate";
import { audit } from "../services/audit";
import type { Network } from "../services/network";
import { hit } from "../services/rate-limit";

/**
 * Consumer rights portal (Law 09-08): a person proves they control a phone number with an SMS code,
 * then can see what the network holds about that number, dispute records or request deletion.
 * Disputed/deletion-requested records are FROZEN immediately (excluded from scoring) until reviewed.
 */
export const CONSUMER_COOKIE = "tiqa_consumer";
const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_TTL_MS = 15 * 60_000;
const HOUR = 3600;

const codeHash = (hash: Bytes, code: string) => sha256(`${hash.toString("hex")}:${code}`);

export async function consumerRoutes(app: FastifyInstance, { deps, network }: { deps: Deps; network: Network }) {
  const { prisma } = deps;

  async function requireConsumer(req: FastifyRequest): Promise<Bytes> {
    const token = req.cookies[CONSUMER_COOKIE];
    if (!token) throw unauthorized("CONSUMER_SESSION_REQUIRED");
    const s = await prisma.consumerSession.findUnique({ where: { tokenHash: sha256(token) } });
    if (!s || s.expiresAt < new Date()) throw unauthorized("CONSUMER_SESSION_EXPIRED");
    return Buffer.from(s.phoneHash);
  }

  app.post("/public/otp/request", async (req) => {
    const { phone } = validate(z.object({ phone: zPhone }), req.body);
    if (!deps.sms.available) throw new ApiError(503, "SMS_UNAVAILABLE");
    await hit(deps.redis, `otp-req-ip:${req.ip}`, 10, HOUR);
    const hash = network.hash(phone);
    await hit(deps.redis, `otp-req-phone:${hash.toString("hex")}`, 3, HOUR); // SMS cost pumping / harassment guard

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await prisma.otpChallenge.create({ data: { phoneHash: hash, codeHash: codeHash(hash, code), expiresAt: new Date(Date.now() + OTP_TTL_MS) } });
    await deps.sms.send(phone, `Tiqa: ${code} (10 min). رمز Tiqa ديالك: ${code}`);
    // Same answer whether or not the number is known to the network.
    return { ok: true, expires_in: OTP_TTL_MS / 1000 };
  });

  app.post("/public/otp/verify", async (req, reply) => {
    const { phone, code } = validate(z.object({ phone: zPhone, code: z.string().regex(/^\d{6}$/) }), req.body);
    await hit(deps.redis, `otp-verify-ip:${req.ip}`, 30, HOUR);
    const hash = network.hash(phone);
    const ch = await prisma.otpChallenge.findFirst({
      where: { phoneHash: hash, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (!ch || ch.attempts >= OTP_MAX_ATTEMPTS) throw unauthorized("OTP_INVALID");
    await prisma.otpChallenge.update({ where: { id: ch.id }, data: { attempts: { increment: 1 } } });
    if (!safeEqual(codeHash(hash, code), Buffer.from(ch.codeHash))) throw unauthorized("OTP_INVALID");

    const { count } = await prisma.otpChallenge.updateMany({ where: { id: ch.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (count !== 1) throw unauthorized("OTP_INVALID");
    await startConsumerSession(deps, reply, hash);
    await audit(deps, { actor: { type: "consumer", id: null }, action: "consumer_verify", phoneHash: hash });
    return { ok: true };
  });

  app.post("/public/logout", async (req, reply) => {
    const token = req.cookies[CONSUMER_COOKIE];
    if (token) await prisma.consumerSession.deleteMany({ where: { tokenHash: sha256(token) } });
    reply.clearCookie(CONSUMER_COOKIE, { path: "/" });
    return { ok: true };
  });

  /** Access right: everything stored about this number, without revealing which store reported what. */
  app.get("/public/me", async (req) => {
    const hash = await requireConsumer(req);
    const [outcomes, requests] = await Promise.all([
      prisma.outcome.findMany({
        where: { phoneHash: hash },
        orderBy: { occurredAt: "desc" },
        select: { id: true, outcome: true, occurredAt: true, cityCode: true, carrier: true, status: true, merchantId: true },
      }),
      prisma.dataSubjectRequest.findMany({
        where: { phoneHash: hash },
        orderBy: { createdAt: "desc" },
        select: { id: true, type: true, status: true, createdAt: true, resolvedAt: true, _count: { select: { items: true } } },
      }),
    ]);
    await audit(deps, { actor: { type: "consumer", id: null }, action: "consumer_view", phoneHash: hash, result: { records: outcomes.length } });
    return {
      records: outcomes.map((o) => ({
        id: o.id,
        month: o.occurredAt.toISOString().slice(0, 7),
        outcome: o.outcome,
        city: o.cityCode,
        carrier: o.carrier,
        status: o.status,
      })),
      stores_count: new Set(outcomes.map((o) => o.merchantId)).size,
      requests: requests.map((r) => ({ id: r.id, type: r.type, status: r.status, created_at: r.createdAt, resolved_at: r.resolvedAt, records: r._count.items })),
      retention_months: deps.env.RETENTION_MONTHS,
    };
  });

  app.post("/public/me/requests", async (req) => {
    const hash = await requireConsumer(req);
    const body = validate(
      z.object({
        type: z.enum(["dispute", "deletion"]),
        /** Dispute: the records concerned (default: all). Deletion always covers everything. */
        outcome_ids: z.array(z.string().max(64)).max(500).optional(),
        message: z.string().trim().max(1000).optional(),
      }),
      req.body,
    );
    await hit(deps.redis, `dsr:${hash.toString("hex")}`, 5, 24 * HOUR);

    const outcomes = await prisma.outcome.findMany({
      where: {
        phoneHash: hash,
        ...(body.type === "dispute" && body.outcome_ids?.length ? { id: { in: body.outcome_ids } } : {}),
      },
    });
    if (!outcomes.length && body.type === "dispute") throw badRequest("NOTHING_TO_DISPUTE");

    const request = await prisma.$transaction(async (tx) => {
      const r = await tx.dataSubjectRequest.create({
        data: {
          phoneHash: hash,
          type: body.type,
          message: body.message || null,
          items: {
            create: outcomes.map((o) => ({
              outcomeId: o.id, merchantId: o.merchantId, outcome: o.outcome, source: o.source, occurredAt: o.occurredAt, merchantOrderRef: o.merchantOrderRef,
            })),
          },
        },
      });
      await tx.outcome.updateMany({ where: { id: { in: outcomes.map((o) => o.id) } }, data: { status: "frozen" } });
      return r;
    });
    await network.invalidate([hash]);
    await audit(deps, {
      actor: { type: "consumer", id: null },
      action: body.type === "dispute" ? "consumer_dispute" : "consumer_deletion_request",
      phoneHash: hash,
      result: { request_id: request.id, records: outcomes.length },
    });
    return { id: request.id, type: request.type, status: request.status, frozen_records: outcomes.length };
  });
}

export async function startConsumerSession(deps: Deps, reply: FastifyReply, hash: Bytes) {
  const token = randomToken(32);
  await deps.prisma.consumerSession.create({ data: { tokenHash: sha256(token), phoneHash: hash, expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
  reply.setCookie(CONSUMER_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: deps.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  });
}
