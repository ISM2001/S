import { prisma } from "@tiqa/db";
import { loadEnv } from "./env";
import { runRetention } from "./jobs/retention";
import { runTrustJob } from "./jobs/trust";

/**
 * Background worker: plain timers, no queue system needed yet. Run exactly ONE instance.
 *  - retention: daily
 *  - trust weights + anomaly flags: hourly
 */
const env = loadEnv();
const HOUR = 3_600_000;

async function job(name: string, fn: () => Promise<unknown>) {
  try {
    const res = await fn();
    await prisma.auditLog.create({ data: { actorType: "system", action: `${name}_run`, result: JSON.parse(JSON.stringify(res)) } });
    console.log(new Date().toISOString(), name, res);
  } catch (e) {
    console.error(new Date().toISOString(), `${name} failed`, (e as Error).message);
  }
}

const retention = () => job("retention", () => runRetention(prisma, { retentionMonths: env.RETENTION_MONTHS, auditRetentionMonths: env.AUDIT_RETENTION_MONTHS }));
const trust = () => job("trust", () => runTrustJob(prisma));

await retention();
await trust();
setInterval(retention, 24 * HOUR);
setInterval(trust, HOUR);
console.log("worker started: retention daily, trust hourly");
