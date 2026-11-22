import { randomBytes } from "node:crypto";
import type { Deps } from "../deps";
import { notFound, badRequest } from "../lib/errors";
import { audit } from "./audit";
import type { Network } from "./network";

/**
 * Resolve a consumer request (staff only).
 *  dispute  upheld   → the disputed records were wrong: delete them (counts against the reporting merchant's trust)
 *  dispute  rejected → records were right: unfreeze them
 *  deletion upheld   → delete everything about the number (outcomes, links in merchants' histories, OTPs, sessions)
 *  deletion rejected → unfreeze (objection not upheld, e.g. overriding legitimate interest — lawyer to define)
 * Records also covered by ANOTHER open request stay frozen.
 */
export async function resolveRequest(
  deps: Deps,
  network: Network,
  args: { requestId: string; decision: "upheld" | "rejected"; note?: string; staffUserId: string },
) {
  const { prisma } = deps;
  const r = await prisma.dataSubjectRequest.findUnique({ where: { id: args.requestId }, include: { items: true } });
  if (!r) throw notFound();
  if (r.status !== "open") throw badRequest("REQUEST_ALREADY_RESOLVED");
  const hash = r.phoneHash ? Buffer.from(r.phoneHash) : null;
  const outcomeIds = r.items.map((i) => i.outcomeId).filter((x): x is string => !!x);

  await prisma.$transaction(async (tx) => {
    await tx.dataSubjectRequest.update({
      where: { id: r.id },
      data: { status: args.decision, resolvedAt: new Date(), resolvedBy: args.staffUserId, resolutionNote: args.note ?? null },
    });

    if (args.decision === "rejected") {
      const stillDisputed = await tx.requestItem.findMany({
        where: { outcomeId: { in: outcomeIds }, request: { status: "open" } },
        select: { outcomeId: true },
      });
      const keep = new Set(stillDisputed.map((i) => i.outcomeId));
      await tx.outcome.updateMany({ where: { id: { in: outcomeIds.filter((id) => !keep.has(id)) } }, data: { status: "active" } });
      return;
    }

    if (r.type === "dispute") {
      await tx.outcome.deleteMany({ where: { id: { in: outcomeIds } } });
      return;
    }

    // Deletion upheld.
    if (hash) {
      await tx.outcome.deleteMany({ where: { phoneHash: hash } });
      // Merchants keep their own order history rows, but the link to this person is destroyed.
      const lookups = await tx.lookup.findMany({ where: { phoneHash: hash }, select: { id: true } });
      for (const l of lookups) await tx.lookup.update({ where: { id: l.id }, data: { phoneHash: randomBytes(32) } });
      await tx.otpChallenge.deleteMany({ where: { phoneHash: hash } });
      await tx.consumerSession.deleteMany({ where: { phoneHash: hash } });
      await tx.dataSubjectRequest.updateMany({ where: { phoneHash: hash }, data: { phoneHash: null } });
    }
    await tx.requestItem.deleteMany({ where: { requestId: r.id } });
  });

  if (hash) await network.invalidate([hash]);
  await audit(deps, {
    actor: { type: "staff", id: args.staffUserId },
    action: "admin_resolve_request",
    result: { request_id: r.id, type: r.type, decision: args.decision, records: outcomeIds.length },
  });
}
