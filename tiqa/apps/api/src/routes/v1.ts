import { MAX_BATCH, OutcomeBatchRequest, OutcomeRequest, ScoreRequest } from "@tiqa/core";
import type { FastifyInstance } from "fastify";
import type { Deps } from "../deps";
import { validate } from "../lib/validate";
import { audit } from "../services/audit";
import { requireApiKey } from "../services/auth";
import { performLookup } from "../services/lookup";
import type { Network } from "../services/network";
import { ingestOutcomes, type OutcomeRow } from "../services/outcomes";
import { hit } from "../services/rate-limit";

/** Public merchant API, authenticated with per-merchant API keys. */
export async function v1Routes(app: FastifyInstance, { deps, network }: { deps: Deps; network: Network }) {
  app.post("/v1/score", async (req, reply) => {
    const key = await requireApiKey(deps, req, "score");
    const body = validate(ScoreRequest, req.body);
    const { response, rateRemaining } = await performLookup(deps, network, {
      merchantId: key.merchantId,
      actor: { type: "api_key", id: key.apiKeyId },
      e164: body.phone,
      orderRef: body.order_ref,
      channel: "api",
    });
    reply.header("x-ratelimit-remaining", rateRemaining);
    return response;
  });

  app.post("/v1/outcomes", async (req) => {
    const key = await requireApiKey(deps, req, "outcomes:write");
    await hit(deps.redis, `outcomes:${key.merchantId}`, 600);
    const o = validate(OutcomeRequest, req.body);
    const row: OutcomeRow = {
      e164: o.phone,
      outcome: o.outcome,
      occurredAt: o.occurred_at ?? new Date(),
      carrier: o.carrier,
      cityCode: o.city,
      orderRef: o.order_ref ?? null,
    };
    const res = await ingestOutcomes(deps, network, key.merchantId, [row], "merchant_manual");
    await audit(deps, {
      actor: { type: "api_key", id: key.apiKeyId },
      merchantId: key.merchantId,
      action: "outcome_submit",
      phoneHash: network.hash(o.phone),
      result: { outcome: o.outcome, ...res },
    });
    return { accepted: 1, ...res };
  });

  app.post("/v1/outcomes/batch", { bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const key = await requireApiKey(deps, req, "outcomes:write");
    await hit(deps.redis, `outcomes:${key.merchantId}`, 600);
    const { outcomes } = validate(OutcomeBatchRequest, req.body);

    const rows: OutcomeRow[] = [];
    const errors: Array<{ index: number; errors: Array<{ path: string; message: string }> }> = [];
    outcomes.forEach((item, index) => {
      const r = OutcomeRequest.safeParse(item);
      if (!r.success) {
        errors.push({ index, errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
        return;
      }
      rows.push({
        e164: r.data.phone,
        outcome: r.data.outcome,
        occurredAt: r.data.occurred_at ?? new Date(),
        carrier: r.data.carrier,
        cityCode: r.data.city,
        orderRef: r.data.order_ref ?? null,
      });
    });
    const res = await ingestOutcomes(deps, network, key.merchantId, rows, "merchant_manual");
    await audit(deps, {
      actor: { type: "api_key", id: key.apiKeyId },
      merchantId: key.merchantId,
      action: "outcome_batch_submit",
      result: { received: outcomes.length, accepted: rows.length, rejected: errors.length, ...res },
    });
    return { received: outcomes.length, accepted: rows.length, rejected: errors.length, max_batch: MAX_BATCH, ...res, errors };
  });
}
