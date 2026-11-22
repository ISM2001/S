"use client";
import { useFormatter, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useMe } from "@/components/MeContext";
import { api } from "@/lib/api";
import { useErrorMessage } from "@/lib/use-error";

interface Conn { id: string; shop: string | null; active: boolean; last_event_at: string | null; settings: Record<string, unknown> }
interface Info {
  generic: { configured: boolean; active?: boolean; settings?: { phone_path?: string; order_ref_path?: string; status_path?: string }; last_event_at?: string | null };
  endpoints: Array<{ id: string; url: string; events: string[]; active: boolean; failure_streak: number }>;
  shopify: { available: boolean; connections: Conn[] };
  youcan: { available: boolean; connections: Conn[] };
}
interface Delivery { id: string; event: string; status: string; attempts: number; responseStatus: number | null; lastError: string | null; createdAt: string }

function Copy({ text }: { text: string }) {
  const t = useTranslations("integrations");
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => navigator.clipboard.writeText(text).then(() => setDone(true))}>
      {done ? t("copied") : t("copy")}
    </button>
  );
}

function IntegrationsInner() {
  const t = useTranslations("integrations");
  const tc = useTranslations("common");
  const format = useFormatter();
  const errMsg = useErrorMessage();
  const { me } = useMe();
  const canManage = me.merchant.role !== "member";
  const connected = useSearchParams().get("connected");
  const [info, setInfo] = useState<Info | null>(null);
  const [hookUrl, setHookUrl] = useState<string | null>(null);
  const [paths, setPaths] = useState({ phone_path: "", order_ref_path: "", status_path: "" });
  const [epUrl, setEpUrl] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [deliveries, setDeliveries] = useState<Record<string, Delivery[]>>({});
  const [shop, setShop] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<Info>("/app/integrations").then((i) => {
    setInfo(i);
    const s = i.generic.settings ?? {};
    setPaths({ phone_path: s.phone_path ?? "", order_ref_path: s.order_ref_path ?? "", status_path: s.status_path ?? "" });
  }), []);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };
  if (!info) return null;
  const example = `curl -X POST "${hookUrl ?? "https://…/v1/hooks/hk_…"}" \\
  -H "Content-Type: application/json" \\
  -d '{"order_id": "CMD-1001", "phone": "0612345678"}'`;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-slate-600">{t("intro")}</p>
      </div>
      {connected && <p className="rounded-lg bg-brand-50 p-3 text-sm text-brand-900">{t("connected")}</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}

      {/* Shopify */}
      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">{t("shopify.title")}</h2>
        <p className="text-sm text-slate-600">{t("shopify.help")}</p>
        {!info.shopify.available ? (
          <p className="text-sm text-slate-500">{t("shopify.notConfigured")}</p>
        ) : (
          <>
            {info.shopify.connections.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-4 rounded-lg border border-slate-200 p-3 text-sm">
                <span className="font-medium" dir="ltr">{c.shop}</span>
                {!c.active && <span className="text-red-700">{t("shopify.inactive")}</span>}
                {(["cod_only", "tag_orders"] as const).map((k) => (
                  <label key={k} className="flex items-center gap-1">
                    <input type="checkbox" disabled={!canManage} checked={c.settings[k] !== false}
                      onChange={(e) => act(() => api(`/app/integrations/shopify/${c.id}`, { method: "PATCH", body: { cod_only: c.settings.cod_only !== false, tag_orders: c.settings.tag_orders !== false, [k]: e.target.checked } }))} />
                    {k === "cod_only" ? t("shopify.codOnly") : t("shopify.tag")}
                  </label>
                ))}
                {canManage && <button className="btn-danger ms-auto" onClick={() => act(() => api(`/app/integrations/${c.id}`, { method: "DELETE" }))}>{t("shopify.disconnect")}</button>}
              </div>
            ))}
            {canManage && (
              <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); window.location.href = `/api/integrations/shopify/install?shop=${encodeURIComponent(shop)}`; }}>
                <div className="flex-1">
                  <label className="label" htmlFor="shop">{t("shopify.shop")}</label>
                  <input id="shop" dir="ltr" className="input" required placeholder="ma-boutique.myshopify.com" value={shop} onChange={(e) => setShop(e.target.value)} />
                </div>
                <button className="btn">{t("shopify.connect")}</button>
              </form>
            )}
          </>
        )}
      </section>

      {/* YouCan */}
      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">{t("youcan.title")}</h2>
        <p className="text-sm text-slate-600">{t("youcan.help")}</p>
        {!info.youcan.available ? (
          <p className="text-sm text-slate-500">{t("youcan.notConfigured")}</p>
        ) : (
          <>
            {info.youcan.connections.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 p-3 text-sm">
                <span className="font-medium">{t("youcan.store")}</span>
                <span className="text-slate-500">{c.last_event_at ? t("generic.lastEvent", { date: format.dateTime(new Date(c.last_event_at), { dateStyle: "short", timeStyle: "short" }) }) : t("generic.never")}</span>
                {typeof c.settings.subscription_error === "string" && <span className="text-red-700">{t("youcan.subscriptionError")}</span>}
                {canManage && <button className="btn-danger ms-auto" onClick={() => act(() => api(`/app/integrations/${c.id}`, { method: "DELETE" }))}>{t("shopify.disconnect")}</button>}
              </div>
            ))}
            {canManage && <a className="btn inline-flex" href="/api/integrations/youcan/install">{t("youcan.connect")}</a>}
          </>
        )}
      </section>

      {/* Generic inbound */}
      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">{t("generic.title")}</h2>
        <p className="text-sm text-slate-600">{t("generic.help")}</p>
        {info.generic.configured && (
          <p className="text-sm text-slate-500">
            {info.generic.last_event_at ? t("generic.lastEvent", { date: format.dateTime(new Date(info.generic.last_event_at), { dateStyle: "short", timeStyle: "short" }) }) : t("generic.never")}
          </p>
        )}
        {hookUrl && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="mb-2 text-sm font-medium text-amber-900">{t("generic.urlOnce")}</p>
            <div className="flex items-center gap-2"><code className="flex-1 break-all text-xs" dir="ltr">{hookUrl}</code><Copy text={hookUrl} /></div>
          </div>
        )}
        {canManage && (
          <button className="btn" onClick={() => {
            if (info.generic.configured && !confirm(t("generic.confirmRotate"))) return;
            void act(async () => setHookUrl((await api<{ url: string }>("/app/integrations/generic", { method: "POST", body: {} })).url));
          }}>
            {info.generic.configured ? t("generic.rotate") : t("generic.create")}
          </button>
        )}
        {info.generic.configured && canManage && (
          <form className="space-y-2" onSubmit={(e) => {
            e.preventDefault();
            const s = Object.fromEntries(Object.entries(paths).map(([k, v]) => [k, v.trim() || null]));
            void act(() => api("/app/integrations/generic", { method: "PATCH", body: { settings: s } }));
          }}>
            <div className="text-sm font-medium text-slate-700">{t("generic.paths")}</div>
            <div className="grid gap-2 sm:grid-cols-3">
              {([["phone_path", "phonePath", "customer.phone"], ["order_ref_path", "refPath", "order.id"], ["status_path", "statusPath", "status"]] as const).map(([k, label, ph]) => (
                <div key={k}>
                  <label className="label" htmlFor={k}>{t(`generic.${label}`)}</label>
                  <input id={k} dir="ltr" className="input" placeholder={ph} value={paths[k]} onChange={(e) => setPaths({ ...paths, [k]: e.target.value })} />
                </div>
              ))}
            </div>
            <button className="btn-secondary">{tc("save")}</button>
          </form>
        )}
        <div>
          <div className="mb-1 text-sm font-medium">{t("generic.example")}</div>
          <pre className="overflow-x-auto rounded bg-slate-900 p-3 text-left text-xs text-slate-100" dir="ltr">{example}</pre>
        </div>
      </section>

      {/* Outbound */}
      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">{t("outbound.title")}</h2>
        <p className="text-sm text-slate-600">{t("outbound.help")}</p>
        {secret && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p className="mb-2 text-sm font-medium text-amber-900">{t("outbound.secretOnce")}</p>
            <div className="flex items-center gap-2"><code className="flex-1 break-all text-xs" dir="ltr">{secret}</code><Copy text={secret} /></div>
          </div>
        )}
        {info.endpoints.map((ep) => (
          <div key={ep.id} className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <code className="flex-1 break-all" dir="ltr">{ep.url}</code>
              {!ep.active && <span className="text-red-700">{t("outbound.disabled")}</span>}
              {canManage && (
                <>
                  <button className="btn-secondary px-2 py-1 text-xs" onClick={() => act(async () => {
                    const r = await api<{ status: string; responseStatus: number | null; lastError: string | null }>(`/app/webhook-endpoints/${ep.id}/test`, { method: "POST", body: {} });
                    setTestResult({ ...testResult, [ep.id]: r.status === "delivered" ? t("outbound.testOk", { status: r.responseStatus ?? 200 }) : t("outbound.testFail", { error: r.lastError ?? "?" }) });
                  })}>{t("outbound.test")}</button>
                  <button className="btn-secondary px-2 py-1 text-xs" onClick={() => api<Delivery[]>(`/app/webhook-endpoints/${ep.id}/deliveries`).then((d) => setDeliveries({ ...deliveries, [ep.id]: d }))}>{t("outbound.deliveries")}</button>
                  <button className="btn-danger" onClick={() => act(() => api(`/app/webhook-endpoints/${ep.id}`, { method: "DELETE" }))}>{t("outbound.delete")}</button>
                </>
              )}
            </div>
            {testResult[ep.id] && <p className="text-xs text-slate-600">{testResult[ep.id]}</p>}
            {deliveries[ep.id] && (
              <ul className="text-xs text-slate-600" dir="ltr">
                {deliveries[ep.id]!.map((d) => (
                  <li key={d.id}>{d.createdAt.slice(0, 19).replace("T", " ")} · {d.event} · {d.status} · {d.responseStatus ?? d.lastError ?? ""} · ×{d.attempts}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {canManage && (
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const r = await api<{ secret: string }>("/app/webhook-endpoints", { body: { url: epUrl, events: ["score.created"] } });
              setSecret(r.secret);
              setEpUrl("");
            });
          }}>
            <div className="flex-1">
              <label className="label" htmlFor="ep">{t("outbound.url")}</label>
              <input id="ep" dir="ltr" type="url" className="input" required placeholder="https://" value={epUrl} onChange={(e) => setEpUrl(e.target.value)} />
            </div>
            <button className="btn">{t("outbound.add")}</button>
          </form>
        )}
      </section>
    </div>
  );
}

export default function IntegrationsPage() {
  return (
    <Suspense>
      <IntegrationsInner />
    </Suspense>
  );
}
