import { parse } from "csv-parse/sync";
import { mapOutcomeStatus, normalizeCarrier, normalizeCity, normalizeMoroccanPhone, type CsvImportRequest } from "@tiqa/core";
import { sha256 } from "@tiqa/core";
import { badRequest } from "../lib/errors";
import type { OutcomeRow } from "./outcomes";

export const MAX_CSV_ROWS = 50_000;

export type CsvRowError = { row: number; code: "INVALID_PHONE" | "UNKNOWN_STATUS" | "INVALID_DATE" | "MISSING_VALUE" };

function detectDelimiter(csv: string): string {
  const nl = csv.indexOf("\n");
  const firstLine = nl === -1 ? csv : csv.slice(0, nl);
  const counts = [";", ",", "\t"].map((d) => [d, firstLine.split(d).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0]![1] > 0 ? counts[0]![0] : ",";
}

export function parseCsv(csv: string): { headers: string[]; records: Record<string, string>[] } {
  let records: Record<string, string>[];
  try {
    records = parse(csv, {
      columns: (h: string[]) => h.map((x) => x.trim()),
      bom: true,
      delimiter: detectDelimiter(csv),
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as Record<string, string>[];
  } catch {
    throw badRequest("CSV_UNREADABLE");
  }
  if (records.length > MAX_CSV_ROWS) throw badRequest("CSV_TOO_MANY_ROWS", { max: MAX_CSV_ROWS });
  const headers = records.length ? Object.keys(records[0]!) : [];
  return { headers, records };
}

const GUESS: Record<keyof CsvImportRequest["mapping"], RegExp> = {
  phone: /t[ée]l|phone|mobile|gsm|هاتف|رقم|num[ée]ro|^num$/i,
  status: /statut|status|[ée]tat|الحالة|r[ée]sultat/i,
  date: /date|تاريخ|livr[ée] le/i,
  order_ref: /commande|order|r[ée]f|tracking|suivi|n°|code/i,
  city: /ville|city|مدينة|destination/i,
  carrier: /transporteur|carrier|soci[ée]t[ée]|شركة|livreur/i,
};

export function suggestMapping(headers: string[]): Partial<CsvImportRequest["mapping"]> {
  const out: Partial<CsvImportRequest["mapping"]> = {};
  const used = new Set<string>();
  for (const field of ["phone", "status", "date", "city", "carrier", "order_ref"] as const) {
    const h = headers.find((x) => !used.has(x) && GUESS[field].test(x));
    if (h) {
      out[field] = h;
      used.add(h);
    }
  }
  return out;
}

/**
 * Dates as found in Moroccan spreadsheets/exports:
 * 2026-11-03 · 2026-11-03 14:22[:05] · 03/11/2026 (dd/mm/yyyy) · 03-11-2026 · 03/11/26 · Excel serial (45964)
 */
export function parseFlexibleDate(raw: string | undefined, now = new Date()): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  let d: Date | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s))) {
    d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 12), +(m[5] ?? 0), +(m[6] ?? 0)));
    if (d.getUTCMonth() !== +m[2]! - 1) return null;
  } else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s))) {
    const year = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    d = new Date(Date.UTC(year, +m[2]! - 1, +m[1]!, +(m[4] ?? 12), +(m[5] ?? 0), +(m[6] ?? 0)));
    if (d.getUTCMonth() !== +m[2]! - 1) return null;
  } else if (/^\d{5}(\.\d+)?$/.test(s)) {
    d = new Date(Date.UTC(1899, 11, 30) + parseFloat(s) * 86_400_000);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  if (d.getTime() > now.getTime() + 2 * 86_400_000) return null;
  if (d.getUTCFullYear() < 2015) return null;
  return d;
}

export interface MappedCsv {
  rows: OutcomeRow[];
  skipped: number;
  errors: CsvRowError[];
}

export function mapCsvRows(
  records: Record<string, string>[],
  mapping: CsvImportRequest["mapping"],
  defaultCarrier: string | null | undefined,
  now = new Date(),
): MappedCsv {
  const rows: OutcomeRow[] = [];
  const errors: CsvRowError[] = [];
  let skipped = 0;
  const fallbackCarrier = defaultCarrier ? normalizeCarrier(defaultCarrier) : null;

  records.forEach((rec, i) => {
    const rowNum = i + 2; // +1 header, +1 for 1-based numbering as in Excel
    const rawPhone = rec[mapping.phone];
    const rawStatus = rec[mapping.status];
    if (!rawPhone || !rawStatus) return void errors.push({ row: rowNum, code: "MISSING_VALUE" });

    const status = mapOutcomeStatus(rawStatus);
    if (status === "skip") return void skipped++;
    if (!status) return void errors.push({ row: rowNum, code: "UNKNOWN_STATUS" });

    const e164 = normalizeMoroccanPhone(rawPhone);
    if (!e164) return void errors.push({ row: rowNum, code: "INVALID_PHONE" });

    let occurredAt = now;
    if (mapping.date) {
      const d = parseFlexibleDate(rec[mapping.date], now);
      if (!d) return void errors.push({ row: rowNum, code: "INVALID_DATE" });
      occurredAt = d;
    }

    rows.push({
      e164,
      outcome: status,
      occurredAt,
      carrier: (mapping.carrier ? normalizeCarrier(rec[mapping.carrier]) : null) ?? fallbackCarrier,
      cityCode: mapping.city ? normalizeCity(rec[mapping.city]) : null,
      orderRef: mapping.order_ref ? rec[mapping.order_ref]?.trim().slice(0, 100) || null : null,
    });
  });
  return { rows, skipped, errors };
}

/** Identifies a file layout (same columns, any order) so a mapping can be remembered. */
export function headerSignature(headers: string[]): string {
  return sha256([...headers].map((h) => h.trim().toLowerCase()).sort().join("\n")).toString("hex");
}
