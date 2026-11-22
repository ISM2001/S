import type { OutcomeType } from "@tiqa/scoring";

/**
 * Map the free-text statuses found in Moroccan carrier exports / seller spreadsheets
 * (French, English, Darija, Arabic) to Tiqa outcomes.
 * Returns "skip" for statuses that are not delivery outcomes (cancelled before shipping, in transit…).
 */
const MAP: Array<[RegExp, OutcomeType | "skip"]> = [
  // skip first: "annulé", in-transit, pending
  [/^(annul|cancel|ملغ|en cours|in transit|pending|en attente|exp[ée]di|shipped|ramass|pickup|confirm)/, "skip"],
  [/^(livr[ée]?|delivered|deliver|tsallem|تم التسليم|سلم|مسلم|paid|pay[ée])/, "delivered"],
  [/^(refus|refused|rejected|rejet|rafd|رفض|مرفوض|ma bghach|mabghach)/, "refused"],
  [/^(retour|retourn|returned|return|rto|رجع|مرتجع|إرجاع)/, "returned"],
  [/^(injoignable|unreachable|pas de r[ée]ponse|no answer|ne r[ée]pond|r[ée]pondeur|messagerie|ما كيجاوبش|لا يجيب|t[ée]l[ée]phone [ée]teint|numero erron|num[ée]ro faux|wrong number)/, "unreachable"],
];

export function mapOutcomeStatus(raw: unknown): OutcomeType | "skip" | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f\u064b-\u065f]/g, "") // strip Latin accents and Arabic diacritics
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!s) return null;
  for (const [re, out] of MAP) if (re.test(s)) return out;
  return null;
}
