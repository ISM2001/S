import { randomToken, sha256 } from "@tiqa/core";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../deps";
import { ApiError, badRequest, notFound, unauthorized } from "../lib/errors";
import { validate } from "../lib/validate";
import { audit } from "../services/audit";
import { createSession, hashPassword, requireRole, requireSession } from "../services/auth";
import { hit } from "../services/rate-limit";

const INVITE_DAYS = 7;

export async function teamRoutes(app: FastifyInstance, { deps }: { deps: Deps }) {
  const { prisma } = deps;

  app.get("/app/team", async (req) => {
    const s = await requireSession(deps, req);
    const [members, invites] = await Promise.all([
      prisma.membership.findMany({
        where: { merchantId: s.merchantId },
        orderBy: { createdAt: "asc" },
        include: { user: { select: { email: true } } },
      }),
      prisma.invite.findMany({
        where: { merchantId: s.merchantId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      }),
    ]);
    return {
      members: members.map((m) => ({ user_id: m.userId, email: m.user.email, role: m.role, is_you: m.userId === s.userId })),
      invites,
    };
  });

  app.post("/app/team/invites", async (req, reply) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    await hit(deps.redis, `invite:${s.merchantId}`, 20, 3600);
    const body = validate(z.object({ email: z.string().trim().toLowerCase().email().max(200), role: z.enum(["admin", "member"]) }), req.body);
    const already = await prisma.membership.findFirst({ where: { merchantId: s.merchantId, user: { email: body.email } } });
    if (already) throw new ApiError(409, "ALREADY_MEMBER");

    const token = randomToken(32);
    const invite = await prisma.invite.create({
      data: {
        merchantId: s.merchantId, email: body.email, role: body.role, tokenHash: sha256(token), invitedBy: s.userId,
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
      },
    });
    const url = `${deps.env.WEB_URL}/invite?token=${encodeURIComponent(token)}`;
    await deps.mailer.send({
      to: body.email,
      subject: `Invitation Tiqa · ${s.merchantName} | دعوة للانضمام`,
      text:
        `Bonjour,\n\n${s.email} vous invite à rejoindre l'équipe « ${s.merchantName} » sur Tiqa.\n` +
        `Acceptez l'invitation (valable ${INVITE_DAYS} jours) :\n${url}\n\n` +
        `—\n\nمرحبا، ${s.email} كيعرض عليك تنضم لفريق « ${s.merchantName} » فـ Tiqa. قبل الدعوة من هنا (صالحة ${INVITE_DAYS} أيام):\n${url}`,
    });
    await audit(deps, { actor: { type: "user", id: s.userId }, merchantId: s.merchantId, action: "team_invite", result: { invite_id: invite.id, role: body.role } });
    reply.code(201);
    return { id: invite.id };
  });

  app.delete("/app/team/invites/:id", async (req) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const { id } = req.params as { id: string };
    const { count } = await prisma.invite.updateMany({ where: { id, merchantId: s.merchantId, acceptedAt: null }, data: { revokedAt: new Date() } });
    if (!count) throw notFound();
    return { ok: true };
  });

  app.patch("/app/team/members/:userId", async (req) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner"]);
    const { userId } = req.params as { userId: string };
    const { role } = validate(z.object({ role: z.enum(["owner", "admin", "member"]) }), req.body);
    if (userId === s.userId) throw badRequest("CANNOT_CHANGE_OWN_ROLE");
    const { count } = await prisma.membership.updateMany({ where: { userId, merchantId: s.merchantId }, data: { role } });
    if (!count) throw notFound();
    await audit(deps, { actor: { type: "user", id: s.userId }, merchantId: s.merchantId, action: "team_role_change", result: { user_id: userId, role } });
    return { ok: true };
  });

  app.delete("/app/team/members/:userId", async (req) => {
    const s = await requireSession(deps, req);
    requireRole(s, ["owner", "admin"]);
    const { userId } = req.params as { userId: string };
    if (userId === s.userId) throw badRequest("CANNOT_REMOVE_YOURSELF");
    const target = await prisma.membership.findUnique({ where: { userId_merchantId: { userId, merchantId: s.merchantId } } });
    if (!target) throw notFound();
    if (target.role === "owner" && s.role !== "owner") throw badRequest("ONLY_OWNER_CAN_REMOVE_OWNER");
    await prisma.membership.delete({ where: { userId_merchantId: { userId, merchantId: s.merchantId } } });
    await prisma.session.deleteMany({ where: { userId } }); // log them out everywhere
    await audit(deps, { actor: { type: "user", id: s.userId }, merchantId: s.merchantId, action: "team_remove", result: { user_id: userId } });
    return { ok: true };
  });

  // ── Accepting an invite (public; the token proves access to the invited mailbox) ──
  app.get("/app/invites/:token", async (req) => {
    const { token } = req.params as { token: string };
    const inv = await prisma.invite.findUnique({ where: { tokenHash: sha256(token) }, include: { merchant: { select: { name: true } } } });
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw notFound("INVITE_INVALID");
    const existing = await prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } });
    return { email: inv.email, merchant_name: inv.merchant.name, role: inv.role, has_account: !!existing };
  });

  app.post("/app/invites/accept", async (req, reply) => {
    await hit(deps.redis, `invite-accept:${req.ip}`, 20, 3600);
    const body = validate(z.object({ token: z.string().min(20).max(200), password: z.string().min(10).max(200).optional() }), req.body);
    const inv = await prisma.invite.findUnique({ where: { tokenHash: sha256(body.token) } });
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw unauthorized("INVITE_INVALID");

    let user = await prisma.user.findUnique({ where: { email: inv.email } });
    if (!user) {
      if (!body.password) throw badRequest("PASSWORD_REQUIRED");
      user = await prisma.user.create({ data: { email: inv.email, passwordHash: await hashPassword(body.password), emailVerifiedAt: new Date() } });
    }
    const { count } = await prisma.invite.updateMany({ where: { id: inv.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
    if (count !== 1) throw unauthorized("INVITE_INVALID");
    await prisma.membership.upsert({
      where: { userId_merchantId: { userId: user.id, merchantId: inv.merchantId } },
      create: { userId: user.id, merchantId: inv.merchantId, role: inv.role },
      update: {},
    });
    await createSession(deps, reply, user.id);
    await audit(deps, { actor: { type: "user", id: user.id }, merchantId: inv.merchantId, action: "team_join", result: { invite_id: inv.id } });
    return { ok: true };
  });
}
