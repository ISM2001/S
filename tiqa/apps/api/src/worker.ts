import { prisma } from "@tiqa/db";
import { loadEnv } from "./env";
import { runRetention } from "./jobs/retention";
import { runTrustJob } from "./jobs/trust";
import { retryDueDeliveries } from "./services/webhooks-out";
import { Redis } from "ioredis";

/**
 * Background worker: plain timers, no queue system needed yet. Run exactly ONE instance.
 *  - retention: daily
 *  - trust weights + anomaly flags: hourly
 *  - outbound webhook retries: every minute
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
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
const noMail = { send: async () => undefined };
const webhooks = async () => {
  try {
    const r = await retryDueDeliveries({ prisma, redis, env, mailer: noMail, sms: { available: false, send: async () => undefined } });
    if (r.retried) console.log(new Date().toISOString(), "webhook retries", r);
  } catch (e) {
    console.error("webhook retry failed", (e as Error).message);
  }
};

await retention();
await trust();
setInterval(retention, 24 * HOUR);
setInterval(trust, HOUR);
setInterval(webhooks, 60_000);
console.log("worker started: retention daily, trust hourly, webhook retries every minute");
