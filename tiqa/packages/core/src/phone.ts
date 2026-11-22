/**
 * Moroccan phone normalization → E.164 (+212XXXXXXXXX).
 *
 * Accepts the formats sellers actually have in spreadsheets / carrier exports:
 *   0612345678 · 06 12 34 56 78 · 06-12-34-56-78 · +212612345678 · +212 6 12 34 56 78
 *   00212612345678 · 212612345678 · +212(0)612345678 · 612345678 · Arabic-Indic digits (٠٦١٢…)
 *
 * Only Moroccan numbers whose national significant number starts with 5 (fixed), 6 or 7 (mobile)
 * are accepted. Anything else returns null, so it can never be hashed into the network.
 */

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EASTERN_ARABIC = "۰۱۲۳۴۵۶۷۸۹";

function westernDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (c) => {
    const i = ARABIC_INDIC.indexOf(c);
    return String(i >= 0 ? i : EASTERN_ARABIC.indexOf(c));
  });
}

export function normalizeMoroccanPhone(input: unknown): string | null {
  if (typeof input !== "string" && typeof input !== "number") return null;
  let s = westernDigits(String(input)).trim();
  if (!s || s.length > 30) return null;

  // "+212 (0)6…" → drop the trunk zero in parentheses
  s = s.replace(/\(0\)/g, "");
  const hasPlus = s.startsWith("+");
  // Anything other than digits and common separators → reject (letters, extensions, etc.)
  if (!/^\+?[\d\s.\-()/]+$/.test(s)) return null;
  let d = s.replace(/\D/g, "");

  if (hasPlus) {
    if (!d.startsWith("212")) return null; // foreign number
    d = d.slice(3);
  } else if (d.startsWith("00212")) {
    d = d.slice(5);
  } else if (d.startsWith("212") && d.length === 12) {
    d = d.slice(3);
  } else if (d.startsWith("0") && d.length === 10) {
    d = d.slice(1);
  }
  // "+212 06…" / "00212 06…": some people keep the trunk 0 after the country code.
  if (d.startsWith("0") && d.length === 10) d = d.slice(1);

  if (!/^[567]\d{8}$/.test(d)) return null;
  return `+212${d}`;
}

/** Last two digits, the only part of a number a merchant's own history ever shows ("06 •• •• •• 12"). */
export function phoneLast2(e164: string): string {
  return e164.slice(-2);
}
