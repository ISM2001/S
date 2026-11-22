import { describe, expect, it } from "vitest";
import { decrypt, encrypt, hmacSha256, signatureMatches } from "../src/lib/crypto";
import { assertSafeOutboundUrl, isPrivateAddress } from "../src/lib/ssrf";
import { extractOrder } from "../src/services/extract";
import { signPayload } from "../src/services/webhooks-out";
import { verifyOAuthHmac } from "../src/routes/shopify";
import { phoneFromOrder } from "../src/routes/youcan";

const KEY = "b".repeat(64);

describe("crypto", () => {
  it("encrypts/decrypts and detects tampering", () => {
    const c = encrypt("shpat_secret", KEY);
    expect(c).not.toContain("shpat");
    expect(decrypt(c, KEY)).toBe("shpat_secret");
    const parts = c.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."), KEY)).toThrow();
    expect(() => decrypt(c, "c".repeat(64))).toThrow();
  });
  it("signatureMatches accepts hex or base64, rejects others", () => {
    const d = hmacSha256("s", "body");
    expect(signatureMatches(d.toString("hex"), d)).toBe(true);
    expect(signatureMatches(d.toString("base64"), d)).toBe(true);
    expect(signatureMatches("nope", d)).toBe(false);
    expect(signatureMatches(undefined, d)).toBe(false);
  });
  it("outbound signature format", () => {
    expect(signPayload("whsec_x", "{}", 1700000000)).toBe(`t=1700000000,v1=${hmacSha256("whsec_x", "1700000000.{}").toString("hex")}`);
  });
});

describe("SSRF guard", () => {
  it.each(["10.0.0.1", "127.0.0.1", "192.168.1.5", "172.20.0.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"])("%s is private", (ip) =>
    expect(isPrivateAddress(ip)).toBe(true));
  it.each(["8.8.8.8", "41.248.1.1", "2a00:1450::1"])("%s is public", (ip) => expect(isPrivateAddress(ip)).toBe(false));
  it("production: https only, no internal addresses", async () => {
    await expect(assertSafeOutboundUrl("http://example.com/x", true)).rejects.toMatchObject({ code: "WEBHOOK_URL_HTTPS_REQUIRED" });
    await expect(assertSafeOutboundUrl("https://127.0.0.1/x", true)).rejects.toMatchObject({ code: "WEBHOOK_URL_NOT_PUBLIC" });
    await expect(assertSafeOutboundUrl("https://[::1]/x", true)).rejects.toMatchObject({ code: "WEBHOOK_URL_NOT_PUBLIC" });
    await expect(assertSafeOutboundUrl("https://user:pw@example.com/", true)).rejects.toMatchObject({ code: "WEBHOOK_URL_INVALID" });
    await expect(assertSafeOutboundUrl("ftp://example.com/", false)).rejects.toMatchObject({ code: "WEBHOOK_URL_INVALID" });
  });
});

describe("extractOrder", () => {
  it("guesses common shapes", () => {
    expect(extractOrder({ phone: "0612345678", order_id: 12 })).toMatchObject({ phone: "0612345678", orderRef: "12" });
    expect(extractOrder({ order: { id: "A-9", customer: { phone: "+212612345678" } } })).toMatchObject({ phone: "+212612345678", orderRef: "A-9" });
    expect(extractOrder({ shipping_address: { phone: "0712" }, name: "#1001", status: "Livré" })).toMatchObject({ orderRef: "#1001", status: "Livré" });
  });
  it("explicit paths win", () => {
    const r = extractOrder({ phone: "x", meta: { tel: "0611111111" }, cmd: { n: 5 } }, { phone_path: "meta.tel", order_ref_path: "cmd.n" });
    expect(r).toMatchObject({ phone: "0611111111", orderRef: "5" });
  });
});

describe("platform helpers", () => {
  it("Shopify OAuth HMAC: sorted query without hmac", () => {
    const q = { shop: "a.myshopify.com", code: "c", timestamp: "1", state: "n" };
    const msg = "code=c&shop=a.myshopify.com&state=n&timestamp=1";
    expect(verifyOAuthHmac({ ...q, hmac: hmacSha256("sec", msg).toString("hex") }, "sec")).toBe(true);
    expect(verifyOAuthHmac({ ...q, hmac: "00" }, "sec")).toBe(false);
    expect(verifyOAuthHmac(q, "sec")).toBe(false);
  });
  it("YouCan phone lookup tries customer, shipping and payment addresses", () => {
    expect(phoneFromOrder({ customer: { phone: "0611" } })).toBe("0611");
    expect(phoneFromOrder({ shipping: { address: [{ phone: "0622" }] } })).toBe("0622");
    expect(phoneFromOrder({ payment: { address: { phone: "0633" } } })).toBe("0633");
    expect(phoneFromOrder({})).toBeNull();
  });
});
