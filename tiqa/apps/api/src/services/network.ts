import { phoneHash, type Bytes } from "@tiqa/core";
import { score, type ScoringOutcome, type ScoreResult } from "@tiqa/scoring";
import type { Deps } from "../deps";
import { monthsAgo } from "../lib/time";

const OUTCOME_CACHE_TTL_S = 600;
const TRUST_TTL_MS = 60_000;

type CachedOutcome = [merchantId: string, outcome: ScoringOutcome["outcome"], source: ScoringOutcome["source"], t: number];

/**
 * Access to the shared network. This is the only place that reads other merchants' outcomes,
 * and it only ever returns them to the pure scoring function, never to a caller.
 */
export class Network {
  private trustCache = new Map<string, { t: number; at: number }>();

  constructor(private deps: Deps) {}

  hash(e164: string): Bytes {
    return phoneHash(e164, this.deps.env.PHONE_HASH_PEPPER);
  }

  private key(hash: Bytes) {
    return `tiqa:out:v1:${hash.toString("hex")}`;
  }

  async outcomesFor(hash: Bytes): Promise<ScoringOutcome[]> {
    const { redis, prisma, env } = this.deps;
    const cached = await redis.get(this.key(hash)).catch(() => null);
    let rows: CachedOutcome[];
    if (cached) {
      rows = JSON.parse(cached) as CachedOutcome[];
    } else {
      const db = await prisma.outcome.findMany({
        where: { phoneHash: hash, status: "active", occurredAt: { gte: monthsAgo(env.RETENTION_MONTHS) } },
        select: { merchantId: true, outcome: true, source: true, occurredAt: true },
        take: 500,
        orderBy: { occurredAt: "desc" },
      });
      rows = db.map((o) => [o.merchantId, o.outcome, o.source, o.occurredAt.getTime()]);
      await redis.set(this.key(hash), JSON.stringify(rows), "EX", OUTCOME_CACHE_TTL_S).catch(() => undefined);
    }
    return rows.map(([merchantId, outcome, source, t]) => ({ merchantId, outcome, source, occurredAt: new Date(t) }));
  }

  async invalidate(hashes: Bytes[]): Promise<void> {
    const keys = [...new Set(hashes.map((h) => this.key(h)))];
    for (let i = 0; i < keys.length; i += 500) {
      await this.deps.redis.del(...keys.slice(i, i + 500)).catch(() => undefined);
    }
  }

  /** Effective trust per merchant: admin override > computed weight; suspended → 0. */
  async trustFor(merchantIds: string[]): Promise<Map<string, number>> {
    const now = Date.now();
    const out = new Map<string, number>();
    const missing: string[] = [];
    for (const id of new Set(merchantIds)) {
      const c = this.trustCache.get(id);
      if (c && now - c.at < TRUST_TTL_MS) out.set(id, c.t);
      else missing.push(id);
    }
    if (missing.length) {
      const ms = await this.deps.prisma.merchant.findMany({
        where: { id: { in: missing } },
        select: { id: true, status: true, trustWeight: true, trustOverride: true },
      });
      for (const m of ms) {
        const t = m.status === "suspended" ? 0 : (m.trustOverride ?? m.trustWeight);
        out.set(m.id, t);
        this.trustCache.set(m.id, { t, at: now });
      }
      for (const id of missing) if (!out.has(id)) out.set(id, 0); // deleted merchant → ignore
    }
    return out;
  }

  async scoreHash(hash: Bytes, now = new Date()): Promise<ScoreResult> {
    const outcomes = await this.outcomesFor(hash);
    const trust = await this.trustFor(outcomes.map((o) => o.merchantId));
    return score(outcomes, trust, now);
  }
}
