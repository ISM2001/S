import type { PrismaClient } from "@tiqa/db";
import type { Redis } from "ioredis";
import type { Env } from "./env";
import type { Mailer } from "./lib/mailer";

export interface Deps {
  prisma: PrismaClient;
  redis: Redis;
  env: Env;
  mailer: Mailer;
}
