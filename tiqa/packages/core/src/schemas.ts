import { z } from "zod";
import { normalizeMoroccanPhone } from "./phone";
import { normalizeCity } from "./cities";
import { normalizeCarrier } from "./carriers";

/** Phone: any common Moroccan format, normalized to E.164. Invalid → validation error. */
export const zPhone = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const e164 = normalizeMoroccanPhone(v);
    if (!e164) {
      ctx.addIssue({ code: "custom", message: "INVALID_MOROCCAN_PHONE" });
      return z.NEVER;
    }
    return e164;
  });

export const zCity = z
  .string()
  .max(80)
  .optional()
  .nullable()
  .transform((v) => (v ? normalizeCity(v) : null));

export const zCarrier = z
  .string()
  .max(80)
  .optional()
  .nullable()
  .transform((v) => (v ? normalizeCarrier(v) : null));

export const zOrderRef = z.string().trim().min(1).max(100).optional().nullable();

export const zOutcomeType = z.enum(["delivered", "refused", "returned", "unreachable"]);

const MAX_FUTURE_MS = 2 * 86_400_000; // tolerate clock skew / timezone confusion, no more

export const zOccurredAt = z.coerce
  .date()
  .optional()
  .refine((d) => !d || (!Number.isNaN(d.getTime()) && d.getTime() <= Date.now() + MAX_FUTURE_MS), {
    message: "OCCURRED_AT_INVALID_OR_IN_FUTURE",
  });

export const ScoreRequest = z.object({
  phone: zPhone,
  city: zCity,
  order_ref: zOrderRef,
});
export type ScoreRequest = z.infer<typeof ScoreRequest>;

export const OutcomeRequest = z.object({
  phone: zPhone,
  outcome: zOutcomeType,
  occurred_at: zOccurredAt,
  carrier: zCarrier,
  city: zCity,
  order_ref: zOrderRef,
});
export type OutcomeRequest = z.infer<typeof OutcomeRequest>;

export const MAX_BATCH = 1000;

/** Batch: rows are validated one by one so a bad row doesn't reject the whole batch. */
export const OutcomeBatchRequest = z.object({
  outcomes: z.array(z.unknown()).min(1).max(MAX_BATCH),
});

export const CsvImportRequest = z.object({
  csv: z.string().min(1).max(10 * 1024 * 1024),
  mapping: z.object({
    phone: z.string().min(1),
    status: z.string().min(1),
    date: z.string().optional().nullable(),
    order_ref: z.string().optional().nullable(),
    city: z.string().optional().nullable(),
    carrier: z.string().optional().nullable(),
  }),
  /** "carrier_export" = the file was exported from a carrier's platform (weighted higher than manual entry). */
  source_type: z.enum(["merchant_manual", "carrier_export"]).default("merchant_manual"),
  default_carrier: z.string().max(80).optional().nullable(),
});
export type CsvImportRequest = z.infer<typeof CsvImportRequest>;
