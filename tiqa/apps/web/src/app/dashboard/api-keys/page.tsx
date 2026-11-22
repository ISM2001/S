"use client";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useMe } from "@/components/MeContext";
import { api } from "@/lib/api";
import { useErrorMessage } from "@/lib/use-error";

/** Public URL of the API for integrations (not the /api proxy). Set NEXT_PUBLIC_API_URL in production. */
const PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface Key { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }

export default function ApiKeysPage() {
  const t = useTranslations("apiKeys");
  const format = useFormatter();
  const errMsg = useErrorMessage();
  const { me } = useMe();
  const [keys, setKeys] = useState<Key[]>([]);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canManage = me.merchant.role !== "member";

  const load = () => api<Key[]>("/app/api-keys").then(setKeys);
  useEffect(() => void load(), []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const r = await api<{ key: string }>("/app/api-keys", { body: { name } });
      setCreated(r.key);
      setName("");
      void load();
    } catch (err) {
      setError(errMsg(err));
    }
  }

  async function revoke(id: string) {
    if (!confirm(t("confirmRevoke"))) return;
    await api(`/app/api-keys/${id}`, { method: "DELETE" });
    void load();
  }

  const example = `curl -X POST ${PUBLIC_API_URL}/v1/score \\
  -H "Authorization: Bearer ${created ?? "tq_live_…"}" \\
  -H "Content-Type: application/json" \\
  -d '{"phone": "0612345678", "order_ref": "CMD-1001"}'`;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-slate-600">{t("intro")}</p>
      </div>
      {canManage && (
        <form onSubmit={create} className="card flex flex-wrap items-end gap-3">
          <div className="flex-1">
            <label className="label" htmlFor="name">{t("name")}</label>
            <input id="name" className="input" required maxLength={60} placeholder="YouCan, Shopify, Google Sheets…" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <button className="btn">{t("create")}</button>
        </form>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
      {created && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="mb-2 text-sm font-medium text-amber-900">{t("createdOnce")}</p>
          <code dir="ltr" className="block break-all rounded bg-white p-2 text-sm">{created}</code>
        </div>
      )}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-2 text-start font-medium">{t("name")}</th>
              <th className="px-4 py-2 text-start font-medium">{t("prefix")}</th>
              <th className="px-4 py-2 text-start font-medium">{t("lastUsed")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className={`border-t border-slate-100 ${k.revokedAt ? "text-slate-400" : ""}`}>
                <td className="px-4 py-2">{k.name}</td>
                <td className="px-4 py-2"><code dir="ltr" className="">{k.prefix}</code></td>
                <td className="px-4 py-2">{k.lastUsedAt ? format.relativeTime(new Date(k.lastUsedAt), new Date()) : t("never")}</td>
                <td className="px-4 py-2 text-end">
                  {k.revokedAt ? t("revoked") : canManage && <button className="btn-danger" onClick={() => revoke(k.id)}>{t("revoke")}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <div className="mb-2 text-sm font-medium">{t("example")}</div>
        <pre dir="ltr" className="overflow-x-auto rounded bg-slate-900 p-3 text-xs text-slate-100 text-left">{example}</pre>
      </div>
    </div>
  );
}
