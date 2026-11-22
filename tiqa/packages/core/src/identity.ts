import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** A Buffer backed by a plain ArrayBuffer (what Prisma `Bytes` columns expect). */
export type Bytes = Buffer<ArrayBuffer>;

/**
 * Pseudonymous identifier for a phone number in the shared network.
 * HMAC-SHA256(pepper, E.164). The pepper is a server-side secret (env / KMS).
 * A plain hash would be reversible: Morocco has only ~2×10^8 mobile numbers.
 */
export function phoneHash(e164: string, pepper: string): Bytes {
  if (!pepper || pepper.length < 32) throw new Error("PHONE_HASH_PEPPER must be at least 32 characters");
  if (!/^\+212[567]\d{8}$/.test(e164)) throw new Error("phoneHash expects a normalized Moroccan E.164 number");
  return createHmac("sha256", pepper).update(e164, "utf8").digest();
}

export function sha256(input: string): Bytes {
  return createHash("sha256").update(input, "utf8").digest();
}

export function safeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// ── API keys ──────────────────────────────────────────────────────────────
// Format: tq_<env>_<prefix>_<secret>; prefix is public (to look the key up), only sha256(secret) is stored.

export interface GeneratedApiKey {
  key: string;
  prefix: string;
  secretHash: Bytes;
}

export function generateApiKey(env: "live" | "test" = "live"): GeneratedApiKey {
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  return { key: `tq_${env}_${prefix}_${secret}`, prefix, secretHash: sha256(secret) };
}

export function parseApiKey(key: string): { prefix: string; secret: string } | null {
  const m = /^tq_(live|test)_([0-9a-f]{12})_([A-Za-z0-9_-]{20,})$/.exec(key.trim());
  return m ? { prefix: m[2]!, secret: m[3]! } : null;
}
