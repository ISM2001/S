import type { Bytes } from "@tiqa/core";
import type { ActorType, Prisma } from "@tiqa/db";
import type { Deps } from "../deps";

export interface Actor {
  type: ActorType;
  id: string | null;
}

export async function audit(
  deps: Deps,
  entry: { actor: Actor; merchantId?: string | null; action: string; phoneHash?: Bytes | null; result?: Prisma.InputJsonValue },
): Promise<void> {
  await deps.prisma.auditLog.create({
    data: {
      actorType: entry.actor.type,
      actorId: entry.actor.id,
      merchantId: entry.merchantId ?? null,
      action: entry.action,
      phoneHash: entry.phoneHash ?? null,
      result: entry.result,
    },
  });
}
