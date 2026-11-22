import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * AES-256-GCM for secrets we must be able to read back (platform access tokens, webhook signing secrets).
 * Key: INTEGRATION_ENC_KEY (64 hex chars). Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 */
export function encrypt(plain: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(token: string, keyHex: string): string {
  const [v, iv, tag, ct] = token.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("bad ciphertext");
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

export function hmacSha256(secret: string, data: string | Buffer): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

/** Constant-time comparison of a received signature (hex or base64) with the expected digest. */
export function signatureMatches(received: string | undefined, expected: Buffer): boolean {
  if (!received) return false;
  const r = received.trim();
  for (const candidate of [expected.toString("hex"), expected.toString("base64")]) {
    const a = Buffer.from(r);
    const b = Buffer.from(candidate);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}
