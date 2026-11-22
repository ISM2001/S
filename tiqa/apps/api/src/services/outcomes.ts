import { randomUUID } from "node:crypto";
import { sha256 } from "@tiqa/core";
import type { OutcomeSource, OutcomeType } from "@tiqa/scoring";
import type { Deps } from "../deps";
import { period } from "../lib/time";
import type { Network } from "./network";

export interface OutcomeRow {
  e164: string;
  outcome: OutcomeType;
  occurredAt: Date;
  carrier: string | null;
  cityCode: string | null;
  orderRef: string | null;
}

export interface IngestResult {
  inserted: number;
  updated: number;
  /** Rows that matched a disputed (frozen) record and were left untouched. */
  unchanged: number;
}

const CHUNK = 1000;

/**
 * Upsert outcomes for one merchant into the shared network.
 * Idempotent: keyed on (merchant, order_ref). Without an order_ref, a deterministic key is derived
 * from (phone hash, outcome, day) so re-uploading the same spreadsheet doesn't double-count.
 * Disputed (frozen) records are never overwritten.
 */
export async function ingestOutcomes(
  deps: Deps,
  network: Network,
  merchantId: string,
  rows: OutcomeRow[],
  source: OutcomeSource,
): Promise<IngestResult> {
  const result: IngestResult = { inserted: 0, updated: 0, unchanged: 0 };
  if (!rows.length) return result;

  await network.migrateToCurrentKey(rows.map((r) => r.e164));
  // Last write wins within a batch for the same order ref.
  const byRef = new Map<string, { hashHex: string; row: OutcomeRow }>();
  for (const row of rows) {
    const hashHex = network.hash(row.e164).toString("hex");
    const ref = row.orderRef ?? `auto:${sha256(`${hashHex}|${row.outcome}|${row.occurredAt.toISOString().slice(0, 10)}`).toString("hex").slice(0, 32)}`;
    byRef.set(ref, { hashHex, row });
  }
  const entries = [...byRef.entries()];

  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const ids = chunk.map(() => randomUUID());
    const hashes = chunk.map(([, v]) => v.hashHex);
    const outcomes = chunk.map(([, v]) => v.row.outcome);
    const dates = chunk.map(([, v]) => v.row.occurredAt.toISOString());
    const carriers = chunk.map(([, v]) => v.row.carrier);
    const cities = chunk.map(([, v]) => v.row.cityCode);
    const refs = chunk.map(([ref]) => ref);

    const res = await deps.prisma.$queryRaw<Array<{ inserted: boolean }>>`
      INSERT INTO "Outcome" ("id","phoneHash","hashKeyVersion","merchantId","outcome","source","carrier","cityCode","occurredAt","merchantOrderRef","status","createdAt","updatedAt")
      SELECT u.id, decode(u.h, 'hex'), ${deps.env.PHONE_HASH_KEY_VERSION}, ${merchantId}, u.o::"OutcomeType", ${source}::"OutcomeSource",
             u.c, u.city, u.d::timestamp(3), u.ref, 'active', now(), now()
      FROM unnest(${ids}::text[], ${hashes}::text[], ${outcomes}::text[], ${dates}::text[], ${carriers}::text[], ${cities}::text[], ${refs}::text[])
        AS u(id, h, o, d, c, city, ref)
      ON CONFLICT ("merchantId","merchantOrderRef") DO UPDATE SET
        "phoneHash" = EXCLUDED."phoneHash",
        "hashKeyVersion" = EXCLUDED."hashKeyVersion",
        "outcome" = EXCLUDED."outcome",
        "source" = EXCLUDED."source",
        "carrier" = COALESCE(EXCLUDED."carrier", "Outcome"."carrier"),
        "cityCode" = COALESCE(EXCLUDED."cityCode", "Outcome"."cityCode"),
        "occurredAt" = EXCLUDED."occurredAt",
        -- Trust signals: a carrier-sourced record replacing a merchant-entered one for the same order.
        "carrierChecked" = "Outcome"."carrierChecked"
          OR ("Outcome"."source" = 'merchant_manual' AND EXCLUDED."source" <> 'merchant_manual'),
        "contradicted" = "Outcome"."contradicted"
          OR ("Outcome"."source" = 'merchant_manual' AND EXCLUDED."source" <> 'merchant_manual'
              AND "Outcome"."outcome" IN ('refused','returned','unreachable') AND EXCLUDED."outcome" = 'delivered'),
        "updatedAt" = now()
      WHERE "Outcome"."status" = 'active'
      RETURNING (xmax = 0) AS inserted`;

    const ins = res.filter((r) => r.inserted).length;
    result.inserted += ins;
    result.updated += res.length - ins;
    result.unchanged += chunk.length - res.length;
  }

  await network.invalidate(entries.map(([, v]) => Buffer.from(v.hashHex, "hex")));
  await deps.prisma.usageMonthly.upsert({
    where: { merchantId_period: { merchantId, period: period() } },
    create: { merchantId, period: period(), outcomesSubmitted: rows.length },
    update: { outcomesSubmitted: { increment: rows.length } },
  });
  return result;
}
