import { prisma } from "@tiqa/db";
import { loadEnv } from "../env";
import { runRetention } from "./retention";

const env = loadEnv();
const res = await runRetention(prisma, { retentionMonths: env.RETENTION_MONTHS, auditRetentionMonths: env.AUDIT_RETENTION_MONTHS });
await prisma.auditLog.create({ data: { actorType: "system", action: "retention_run", result: JSON.parse(JSON.stringify(res)) } });
console.log("retention done", res);
await prisma.$disconnect();
