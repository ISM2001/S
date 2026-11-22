"use client";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface M {
  id: string; name: string; status: "active" | "suspended";
  trust_weight: number; trust_override: number | null; effective_trust: number;
  trust_details: { contradictionRate?: number; carrierChecked?: number } | null;
  outcomes: number; lookups: number; open_flags: number;
}

const trustColor = (t: number) => (t >= 0.8 ? "text-emerald-700" : t >= 0.5 ? "text-amber-700" : "text-red-700");

export default function AdminMerchants() {
  const t = useTranslations("admin");
  const [rows, setRows] = useState<M[]>([]);
  const [busy, setBusy] = useState(false);
  const load = () => api<M[]>("/admin/merchants").then(setRows);
  useEffect(() => void load(), []);

  const patch = async (id: string, body: object) => {
    await api(`/admin/merchants/${id}`, { method: "PATCH", body });
    await load();
  };

  return (
    <div className="space-y-4">
      <button className="btn-secondary" disabled={busy} onClick={async () => {
        setBusy(true);
        await api("/admin/trust/recompute", { method: "POST", body: {} }).finally(() => setBusy(false));
        await load();
      }}>{t("recompute")}</button>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>{["merchant", "status", "trust", "contradiction", "override", "outcomes", "lookups", "flags"].map((h) => <th key={h} className="px-3 py-2 text-start font-medium">{t(h)}</th>)}<th /></tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className={`border-t border-slate-100 ${m.status === "suspended" ? "bg-red-50/50" : ""}`}>
                <td className="px-3 py-2 font-medium">{m.name}</td>
                <td className="px-3 py-2">{m.status === "suspended" ? t("suspend") : "✓"}</td>
                <td className={`px-3 py-2 font-semibold ${trustColor(m.effective_trust)}`}>{m.effective_trust.toFixed(2)}</td>
                <td className="px-3 py-2 text-slate-500">{m.trust_details?.carrierChecked ? `${Math.round((m.trust_details.contradictionRate ?? 0) * 100)}% (n=${m.trust_details.carrierChecked})` : "—"}</td>
                <td className="px-3 py-2">
                  <select className="rounded border border-slate-200 px-1 py-0.5" value={m.trust_override ?? ""}
                    onChange={(e) => patch(m.id, { trust_override: e.target.value === "" ? null : Number(e.target.value) })}>
                    <option value="">—</option>
                    {[1, 0.8, 0.5, 0.3, 0.1, 0].map((v) => <option key={v} value={v}>{v.toFixed(1)}</option>)}
                  </select>
                </td>
                <td className="px-3 py-2">{m.outcomes}</td>
                <td className="px-3 py-2">{m.lookups}</td>
                <td className="px-3 py-2">{m.open_flags > 0 ? <span className="font-semibold text-red-700">{m.open_flags}</span> : 0}</td>
                <td className="px-3 py-2 text-end">
                  <button className="btn-danger" onClick={() => patch(m.id, { status: m.status === "suspended" ? "active" : "suspended" })}>
                    {m.status === "suspended" ? t("reactivate") : t("suspend")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
