import { describe, expect, it } from "vitest";
import {
  normalizeMoroccanPhone,
  phoneLast2,
  phoneHash,
  generateApiKey,
  parseApiKey,
  sha256,
  safeEqual,
  mapOutcomeStatus,
  normalizeCity,
  normalizeCarrier,
  ScoreRequest,
  OutcomeRequest,
} from "../src/index";

const PEPPER = "test_pepper_0123456789abcdef0123456789abcdef";

describe("normalizeMoroccanPhone", () => {
  it.each([
    "0612345678",
    "06 12 34 56 78",
    "06-12-34-56-78",
    "06.12.34.56.78",
    "+212612345678",
    "+212 6 12 34 56 78",
    "+212 (0)6 12 34 56 78",
    "+212 0612345678",
    "00212612345678",
    "00212 0612345678",
    "212612345678",
    "612345678",
    "٠٦١٢٣٤٥٦٧٨",
    " 0612345678 ",
  ])("%s → +212612345678", (input) => {
    expect(normalizeMoroccanPhone(input)).toBe("+212612345678");
  });

  it("accepts numbers (spreadsheet cells) and 07 / 05 prefixes", () => {
    expect(normalizeMoroccanPhone(612345678)).toBe("+212612345678");
    expect(normalizeMoroccanPhone("0712345678")).toBe("+212712345678");
    expect(normalizeMoroccanPhone("0522123456")).toBe("+212522123456");
  });

  it.each([
    "",
    "abc",
    "0812345678", // not a valid Moroccan prefix
    "061234567", // too short
    "06123456789", // too long
    "+33612345678", // French number
    "+1 415 555 0100",
    "0612345678 ext 12",
    null,
    undefined,
    {},
  ])("rejects %s", (input) => {
    expect(normalizeMoroccanPhone(input as unknown)).toBeNull();
  });

  it("phoneLast2", () => expect(phoneLast2("+212612345678")).toBe("78"));
});

describe("phoneHash", () => {
  it("is deterministic and 32 bytes", () => {
    const a = phoneHash("+212612345678", PEPPER);
    expect(a).toHaveLength(32);
    expect(a.equals(phoneHash("+212612345678", PEPPER))).toBe(true);
  });
  it("same number in different formats → same hash", () => {
    const a = phoneHash(normalizeMoroccanPhone("06 12 34 56 78")!, PEPPER);
    const b = phoneHash(normalizeMoroccanPhone("00212612345678")!, PEPPER);
    expect(a.equals(b)).toBe(true);
  });
  it("depends on the pepper (not a plain hash)", () => {
    const a = phoneHash("+212612345678", PEPPER);
    const b = phoneHash("+212612345678", PEPPER.replace("0", "1"));
    expect(a.equals(b)).toBe(false);
    expect(a.equals(sha256("+212612345678"))).toBe(false);
  });
  it("refuses weak peppers and non-normalized input", () => {
    expect(() => phoneHash("+212612345678", "short")).toThrow();
    expect(() => phoneHash("0612345678", PEPPER)).toThrow();
  });
});

describe("API keys", () => {
  it("round-trips and only the secret hash identifies the key", () => {
    const k = generateApiKey("test");
    expect(k.key.startsWith(`tq_test_${k.prefix}_`)).toBe(true);
    const parsed = parseApiKey(k.key)!;
    expect(parsed.prefix).toBe(k.prefix);
    expect(safeEqual(sha256(parsed.secret), k.secretHash)).toBe(true);
  });
  it("rejects malformed keys", () => {
    expect(parseApiKey("nope")).toBeNull();
    expect(parseApiKey("tq_live_zzzzzzzzzzzz_abcdefghijklmnopqrstuvwx")).toBeNull();
  });
  it("safeEqual handles different lengths", () => {
    expect(safeEqual(Buffer.from("a"), Buffer.from("ab"))).toBe(false);
  });
});

describe("mapOutcomeStatus", () => {
  it.each([
    ["Livré", "delivered"],
    ["livre", "delivered"],
    ["Delivered", "delivered"],
    ["تم التسليم", "delivered"],
    ["Refusé", "refused"],
    ["refuse par le client", "refused"],
    ["رفض", "refused"],
    ["Retour", "returned"],
    ["Retourné à l'expéditeur", "returned"],
    ["RTO", "returned"],
    ["Injoignable", "unreachable"],
    ["Pas de réponse", "unreachable"],
    ["Numéro erroné", "unreachable"],
    ["Annulé", "skip"],
    ["En cours de livraison", "skip"],
    ["Confirmé", "skip"],
  ])("%s → %s", (raw, expected) => expect(mapOutcomeStatus(raw)).toBe(expected));

  it("unknown / empty → null", () => {
    expect(mapOutcomeStatus("non livré")).toBeNull();
    expect(mapOutcomeStatus("")).toBeNull();
    expect(mapOutcomeStatus(undefined)).toBeNull();
  });
});

describe("normalizeCity / normalizeCarrier", () => {
  it("cities in French, Arabic, with accents", () => {
    expect(normalizeCity("Casablanca")).toBe("casablanca");
    expect(normalizeCity("CASA")).toBe("casablanca");
    expect(normalizeCity("الدار البيضاء")).toBe("casablanca");
    expect(normalizeCity("Fès")).toBe("fes");
    expect(normalizeCity("Salé")).toBe("sale");
    expect(normalizeCity("Some Village")).toBeNull();
  });
  it("carriers", () => {
    expect(normalizeCarrier("AMANA Express")).toBe("amana");
    expect(normalizeCarrier("Ozon Express")).toBe("ozon_express");
    expect(normalizeCarrier("Random Co")).toBe("other");
    expect(normalizeCarrier("")).toBeNull();
  });
});

describe("schemas", () => {
  it("ScoreRequest normalizes phone and city", () => {
    const r = ScoreRequest.parse({ phone: "06 12 34 56 78", city: "Rabat" });
    expect(r.phone).toBe("+212612345678");
    expect(r.city).toBe("rabat");
  });
  it("ScoreRequest rejects bad phones", () => {
    const r = ScoreRequest.safeParse({ phone: "12345" });
    expect(r.success).toBe(false);
  });
  it("OutcomeRequest rejects future dates and unknown outcomes", () => {
    expect(OutcomeRequest.safeParse({ phone: "0612345678", outcome: "refused", occurred_at: "2999-01-01" }).success).toBe(false);
    expect(OutcomeRequest.safeParse({ phone: "0612345678", outcome: "blacklisted" }).success).toBe(false);
    expect(OutcomeRequest.safeParse({ phone: "0612345678", outcome: "returned", carrier: "Amana" }).success).toBe(true);
  });
});
