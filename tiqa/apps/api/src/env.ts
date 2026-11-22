import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  PHONE_HASH_PEPPER: z.string().min(32, "PHONE_HASH_PEPPER must be ≥ 32 chars (openssl rand -hex 32)"),
  PHONE_HASH_KEY_VERSION: z.coerce.number().int().positive().default(1),
  SESSION_SECRET: z.string().min(32),
  RETENTION_MONTHS: z.coerce.number().int().min(1).max(60).default(12),
  AUDIT_RETENTION_MONTHS: z.coerce.number().int().min(1).max(120).default(24),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
  API_PORT: z.coerce.number().int().default(4000),
  WEB_URL: z.string().default("http://localhost:3000"),
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().default(1025),
  MAIL_FROM: z.string().default("Tiqa <no-reply@tiqa.local>"),
  LOG_LEVEL: z.string().default("info"),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment:\n  ${msg}`);
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.PHONE_HASH_PEPPER.startsWith("dev_only")) {
    throw new Error("Refusing to start in production with the development pepper.");
  }
  return parsed.data;
}
