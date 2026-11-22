import { generateApiKey } from "@tiqa/core";
import { createPrisma, type PrismaClient } from "@tiqa/db";
import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeEach } from "vitest";
import { buildApp } from "../src/app";
import type { Deps } from "../src/deps";
import { loadEnv } from "../src/env";
import { base32Decode, hotp, totpStep } from "../src/lib/totp";
import type { Mail } from "../src/lib/mailer";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "./env";

export const PEPPER = "test_pepper_0123456789abcdef0123456789abcdef";

export interface TestCtx {
  app: FastifyInstance;
  prisma: PrismaClient;
  redis: Redis;
  deps: Deps;
  mails: Mail[];
  sms: Array<{ to: string; text: string }>;
}

/** Boots the real app against the test database + a dedicated Redis DB. Tables are truncated before each test. */
export function setupTestApp(envOverrides: Record<string, string> = {}): TestCtx {
  const prisma = createPrisma(TEST_DATABASE_URL);
  const redis = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
  const mails: Mail[] = [];
  const sms: Array<{ to: string; text: string }> = [];
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    REDIS_URL: TEST_REDIS_URL,
    PHONE_HASH_PEPPER: PEPPER,
    SESSION_SECRET: "test_session_secret_0123456789abcdef0123456789",
    RATE_LIMIT_PER_MIN: "1000",
    INTEGRATION_ENC_KEY: "a".repeat(64),
    API_PUBLIC_URL: "https://tiqa.test/api",
    ...envOverrides,
  });
  const deps: Deps = { prisma, redis, env, mailer: { send: async (m) => void mails.push(m) },
    sms: { available: true, send: async (to, text) => void sms.push({ to, text }) },
  };
  const ctx = { prisma, redis, deps, mails, sms } as TestCtx;

  beforeEach(async () => {
    if (!ctx.app) ctx.app = await buildApp(deps, { logger: false });
    await prisma.$executeRawUnsafe(
      `TRUNCATE "DocumentCounter","Invoice","WebhookDelivery","WebhookEndpoint","Integration","CsvMapping","RequestItem","DataSubjectRequest","OtpChallenge","ConsumerSession","AnomalyFlag","Invite","Outcome","Lookup","AuditLog","ApiKey","Session","MagicLink","Membership","User","UsageMonthly","Subscription","CsvImport","Merchant","Plan" RESTART IDENTITY CASCADE`,
    );
    await redis.flushdb();
    mails.length = 0;
    sms.length = 0;
    ctx.app.network.clearTrustCache();
    delete deps.fetch;
  });
  afterAll(async () => {
    await ctx.app?.close();
    await prisma.$disconnect();
    redis.disconnect();
  });
  return ctx;
}

export async function createMerchant(ctx: TestCtx, name = "Store", data: Record<string, unknown> = {}) {
  const merchant = await ctx.prisma.merchant.create({ data: { name, termsAcceptedAt: new Date(), ...data } });
  const k = generateApiKey("test");
  await ctx.prisma.apiKey.create({ data: { merchantId: merchant.id, name: "test", prefix: k.prefix, secretHash: k.secretHash } });
  return { merchant, key: k.key, auth: { authorization: `Bearer ${k.key}` } };
}

/** Sign up through the real endpoint and return the session cookie header. */
export async function signup(ctx: TestCtx, email = "owner@store.test", merchantName = "My Store") {
  const res = await ctx.app.inject({
    method: "POST",
    url: "/app/auth/signup",
    payload: { email, password: "correct horse battery", merchantName, acceptTerms: true },
  });
  if (res.statusCode !== 201) throw new Error(`signup failed: ${res.body}`);
  return { cookie: cookieFrom(res.headers["set-cookie"]) };
}

export function cookieFrom(setCookie: string | string[] | undefined): string {
  const c = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return c.split(";")[0]!;
}

export const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

/** Make a user staff, enrol TOTP 2FA through the real endpoints, and return a fully verified session cookie. */
export async function staffLogin(ctx: TestCtx, email = "staff@tiqa.test") {
  const { cookie } = await signup(ctx, email, "Tiqa Staff Store");
  await ctx.prisma.user.update({ where: { email }, data: { isStaff: true } });
  const setup = await ctx.app.inject({ method: "POST", url: "/admin/mfa/setup", headers: { cookie } });
  const code = hotp(base32Decode(setup.json().secret), totpStep());
  const v = await ctx.app.inject({ method: "POST", url: "/admin/mfa/verify", headers: { cookie }, payload: { code } });
  if (v.statusCode !== 200) throw new Error(`mfa verify failed: ${v.body}`);
  return { cookie };
}

/** Run the consumer OTP flow for a phone and return the consumer cookie. */
export async function consumerLogin(ctx: TestCtx, phone: string) {
  await ctx.app.inject({ method: "POST", url: "/public/otp/request", payload: { phone } });
  const code = /(\d{6})/.exec(ctx.sms.at(-1)!.text)![1]!;
  const res = await ctx.app.inject({ method: "POST", url: "/public/otp/verify", payload: { phone, code } });
  if (res.statusCode !== 200) throw new Error(`otp verify failed: ${res.body}`);
  return { cookie: cookieFrom(res.headers["set-cookie"]) };
}
