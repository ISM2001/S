/**
 * Pull the phone / order reference / status out of an arbitrary order JSON
 * (no-code tools, custom stores, platform webhooks). Explicit dot-paths win over guesses.
 */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) cur = /^\d+$/.test(part) ? cur[Number(part)] : cur[0]?.[part as never];
    else if (typeof cur === "object") cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

const PHONE_PATHS = [
  "phone", "customer_phone", "phone_number", "telephone", "tel", "mobile", "gsm",
  "customer.phone", "customer.phone_number", "client.phone", "client.telephone",
  "shipping_address.phone", "shipping.address.phone", "shipping.phone", "billing_address.phone", "billing.phone",
  "order.phone", "order.customer.phone", "order.shipping_address.phone", "data.phone", "data.customer.phone",
];
const REF_PATHS = ["order_ref", "order_id", "order_number", "reference", "ref", "name", "id", "order.id", "order.ref", "data.id", "data.ref"];
const STATUS_PATHS = ["status", "delivery_status", "shipping_status", "outcome", "order.status", "data.status"];

export interface ExtractConfig {
  phone_path?: string | null;
  order_ref_path?: string | null;
  status_path?: string | null;
}

function first(obj: unknown, explicit: string | null | undefined, guesses: string[]): string | null {
  for (const p of explicit ? [explicit] : guesses) {
    const v = getPath(obj, p);
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

export function extractOrder(payload: unknown, cfg: ExtractConfig = {}) {
  return {
    phone: first(payload, cfg.phone_path, PHONE_PATHS),
    orderRef: first(payload, cfg.order_ref_path, REF_PATHS)?.slice(0, 100) ?? null,
    status: first(payload, cfg.status_path, cfg.status_path ? [] : STATUS_PATHS),
  };
}
