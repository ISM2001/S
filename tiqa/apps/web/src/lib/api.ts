export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public details?: unknown,
  ) {
    super(code);
  }
}

/** Calls the Fastify API through the same-origin /api proxy (see next.config.ts). */
export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "generic", data?.error?.details);
  return data as T;
}

export type Band = "low" | "medium" | "high" | "insufficient_data";

export interface ScoreResponse {
  lookup_id: string;
  band: Band;
  score: number | null;
  outcomes_count: string;
  merchants_count: string;
  reasons: string[];
  score_version: string;
}

export interface Me {
  user: { email: string; locale: string; is_staff: boolean };
  merchant: { id: string; name: string; role: "owner" | "admin" | "member" };
  contribution: { tier: "grace" | "full" | "reduced" | "throttled"; ratio: number | null; limitPerMin: number };
}
