import { prisma } from "@tiqa/db";
import { loadEnv } from "./env";
import { runRetention } from "./jobs/retention";

/**
 * Background worker. Phase 1 has a single daily job (retention), so a plain timer is enough;
 * no queue system needed yet. Run exactly one worker instance.
 */
const env = loadEnv();
const DAY = 86_400_000;

async function tick() {
  try {
    const res = await runRetention(prisma, { retentionMonths: env.RETENTION_MONTHS, auditRetentionMonths: env.AUDIT_RETENTION_MONTHS });
    await prisma.auditLog.create({ data: { actorType: "system", action: "retention_run", result: JSON.parse(JSON.stringify(res)) } });
    console.log(new Date().toISOString(), "retention", res);
  } catch (e) {
    console.error("retention failed", (e as Error).message);
  }
}

await tick();
setInterval(tick, DAY);
console.log("worker started: retention runs daily");
