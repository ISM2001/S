/**
 * Latency benchmark for POST /v1/score over real HTTP (in-process server, rate limit lifted).
 * Prereq: pnpm db:seed && pnpm --filter @tiqa/db seed:load
 *   pnpm --filter @tiqa/api bench [requests=3000] [concurrency=20]
 */
import { prisma } from "@tiqa/db";
import { Redis } from "ioredis";
import { buildApp } from "./app";
import { loadEnv } from "./env";

const TOTAL = Number(process.argv[2] ?? 3000);
const CONCURRENCY = Number(process.argv[3] ?? 20);
const env = loadEnv({ ...process.env, RATE_LIMIT_PER_MIN: "100000000", LOG_LEVEL: "warn" });
const redis = new Redis(env.REDIS_URL);
const app = await buildApp({ prisma, redis, env, mailer: { send: async () => undefined } }, { logger: false });
await app.listen({ port: 0, host: "127.0.0.1" });
const addr = app.server.address() as { port: number };
const KEY = "tq_test_000000000000_demo_secret_do_not_use_in_production";

const loadPhone = (i: number) => `07${String(i).padStart(8, "0")}`;
const lat: number[] = [];
let i = 0;
const bands: Record<string, number> = {};
async function worker() {
  while (i < TOTAL) {
    const n = i++;
    const phone = loadPhone(Math.floor(Math.random() * 200_000));
    const t = performance.now();
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/score`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ phone, order_ref: `bench-${n}` }),
    });
    const body = (await res.json()) as { band?: string };
    lat.push(performance.now() - t);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
    bands[body.band!] = (bands[body.band!] ?? 0) + 1;
  }
}
const t0 = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const secs = (performance.now() - t0) / 1000;
lat.sort((a, b) => a - b);
const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))]!.toFixed(1);
console.log(`outcomes in DB: ${await prisma.outcome.count()}`);
console.log(`${TOTAL} lookups, concurrency ${CONCURRENCY}: ${(TOTAL / secs).toFixed(0)} req/s`);
console.log(`latency ms  p50=${q(0.5)}  p95=${q(0.95)}  p99=${q(0.99)}  max=${lat.at(-1)!.toFixed(1)}`);
console.log("bands:", bands);
// Remove the benchmark's lookup rows so they don't pollute the demo store's history/usage (audit entries are kept: append-only).
const demo = await prisma.lookup.findFirst({ where: { merchantOrderRef: "bench-0" }, select: { merchantId: true } });
await prisma.lookup.deleteMany({ where: { merchantOrderRef: { startsWith: "bench-" } } });
if (demo) await prisma.usageMonthly.updateMany({ where: { merchantId: demo.merchantId }, data: { lookups: { decrement: TOTAL } } });
await app.close();
await prisma.$disconnect();
redis.disconnect();
