import type { z } from "zod";
import { badRequest } from "./errors";

export function validate<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      "VALIDATION_FAILED",
      r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return r.data;
}
