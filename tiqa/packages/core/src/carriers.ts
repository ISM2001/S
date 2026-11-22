/**
 * Carrier codes. Free text from a CSV is mapped to one of these; anything else becomes "other".
 * Whether each carrier offers a public API is still TO BE VERIFIED (Phase 3); see docs/integrations.md.
 */
export const CARRIERS = ["amana", "cathedis", "sendit", "ozon_express", "speedaf", "digylog", "onessta", "forcelog", "ctm_messagerie", "own_fleet", "other"] as const;
export type Carrier = (typeof CARRIERS)[number];

export function normalizeCarrier(input: unknown): Carrier | null {
  if (typeof input !== "string" || !input.trim()) return null;
  const s = input.toLowerCase().replace(/[^a-z]/g, "");
  if (!s) return "other";
  if (s.includes("amana") || s.includes("barid") || s.includes("poste")) return "amana";
  if (s.includes("cathedis")) return "cathedis";
  if (s.includes("sendit")) return "sendit";
  if (s.includes("ozon")) return "ozon_express";
  if (s.includes("speedaf")) return "speedaf";
  if (s.includes("digylog")) return "digylog";
  if (s.includes("onessta")) return "onessta";
  if (s.includes("forcelog")) return "forcelog";
  if (s.includes("ctm")) return "ctm_messagerie";
  if (s.includes("ownfleet") || s.includes("livreur") || s.includes("interne")) return "own_fleet";
  return "other";
}
