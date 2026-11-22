import type { PrismaClient } from "@tiqa/db";
import type { Redis } from "ioredis";
import type { Env } from "./env";
import type { Mailer } from "./lib/mailer";
import type { SmsSender } from "./lib/sms";

export interface Deps {
  prisma: PrismaClient;
  redis: Redis;
  env: Env;
  mailer: Mailer;
  sms: SmsSender;
  /** Outbound HTTP (injectable for tests). */
  fetch?: typeof fetch;
}
