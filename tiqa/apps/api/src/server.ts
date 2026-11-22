import { prisma } from "@tiqa/db";
import { Redis } from "ioredis";
import { buildApp } from "./app";
import { loadEnv } from "./env";
import { createMailer } from "./lib/mailer";

const env = loadEnv();
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
const consoleLog = { info: (o: object, m: string) => console.log(m, o) };
const app = await buildApp({ prisma, redis, env, mailer: createMailer(env, consoleLog) });

await app.listen({ port: env.API_PORT, host: "0.0.0.0" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await app.close();
    await prisma.$disconnect();
    redis.disconnect();
    process.exit(0);
  });
}
