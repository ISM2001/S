import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { badRequest } from "./errors";

/**
 * Outbound webhook URLs are merchant-controlled: block requests to internal networks (SSRF).
 * In production only https to public addresses is allowed. Outside production, http/localhost
 * is allowed so the feature can be tested locally.
 */
export async function assertSafeOutboundUrl(raw: string, production: boolean): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest("WEBHOOK_URL_INVALID");
  }
  if (url.username || url.password) throw badRequest("WEBHOOK_URL_INVALID");
  if (production && url.protocol !== "https:") throw badRequest("WEBHOOK_URL_HTTPS_REQUIRED");
  if (!["https:", "http:"].includes(url.protocol)) throw badRequest("WEBHOOK_URL_INVALID");
  if (!production) return url;

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw badRequest("WEBHOOK_URL_NOT_PUBLIC");
  return url;
}

export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
  }
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 10 || a === 127 || a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}
