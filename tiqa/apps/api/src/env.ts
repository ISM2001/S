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
  /** 64 hex chars (openssl rand -hex 32). Encrypts platform tokens and webhook secrets at rest. */
  INTEGRATION_ENC_KEY: z.string().regex(/^[0-9a-f]{64}$/i, "INTEGRATION_ENC_KEY must be 64 hex chars (openssl rand -hex 32)"),
  /** Public URL of this API as seen by browsers/platforms (OAuth callbacks, webhook URLs). Default: WEB_URL + "/api". */
  API_PUBLIC_URL: z.string().optional(),
  SHOPIFY_API_KEY: z.string().optional().default(""),
  SHOPIFY_API_SECRET: z.string().optional().default(""),
  SHOPIFY_SCOPES: z.string().default("read_orders,write_orders"),
  SHOPIFY_API_VERSION: z.string().default("2026-10"),
  YOUCAN_CLIENT_ID: z.string().optional().default(""),
  YOUCAN_CLIENT_SECRET: z.string().optional().default(""),
  YOUCAN_SCOPES: z.string().default("read-orders,edit-rest-hooks"),
  // ── Billing (seller identity printed on invoices; placeholders until the company exists) ──
  VAT_RATE_BP: z.coerce.number().int().min(0).max(10_000).default(2000),
  INVOICE_DUE_DAYS: z.coerce.number().int().min(0).max(90).default(15),
  BILLING_SELLER_NAME: z.string().default("[Raison sociale Tiqa SARL, à compléter]"),
  BILLING_SELLER_ICE: z.string().default("[ICE à compléter]"),
  BILLING_SELLER_RC: z.string().default("[RC à compléter]"),
  BILLING_SELLER_IF: z.string().default("[IF à compléter]"),
  BILLING_SELLER_ADDRESS: z.string().default("[Adresse à compléter]"),
  BILLING_BANK: z.string().default("[Banque à compléter]"),
  BILLING_RIB: z.string().default("[RIB à compléter]"),
  /** Staff accounts must use TOTP two-factor authentication. */
  STAFF_MFA_REQUIRED: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  /** Previous phone-hash peppers kept during a rotation: "1:oldpepper,2:otherpepper". */
  PHONE_HASH_PEPPERS_OLD: z.string().optional().default(""),
});

export type Env = z.infer<typeof Env> & { API_PUBLIC_URL: string };

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = Env.safeParse(source);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment:\n  ${msg}`);
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.PHONE_HASH_PEPPER.startsWith("dev_only")) {
    throw new Error("Refusing to start in production with the development pepper.");
  }
  if (parsed.data.NODE_ENV === "production" && /^0+$/.test(parsed.data.INTEGRATION_ENC_KEY)) {
    throw new Error("Refusing to start in production with the example INTEGRATION_ENC_KEY.");
  }
  const env = parsed.data;
  if (!env.API_PUBLIC_URL) env.API_PUBLIC_URL = `${env.WEB_URL.replace(/\/$/, "")}/api`;
  return env as Env;
}
