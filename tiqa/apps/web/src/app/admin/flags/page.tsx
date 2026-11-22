"use client";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type Status = "open" | "dismissed" | "actioned";
interface Flag {
  id: string; merchant_name: string; kind: string; severity: "low" | "medium" | "high";
  details: Record<string, number>; status: Status; created_at: string; merchant_trust: number;
}
const SEV = { low: "bg-slate-100 text-slate-700", medium: "bg-amber-100 text-amber-800", high: "bg-red-100 text-red-800" };

export default function AdminFlags() {
  const t = useTranslations("admin");
  const format = useFormatter();
  const [status, setStatus] = useState<Status>("open");
  const [rows, setRows] = useState<Flag[]>([]);
  const load = useCallback(() => api<Flag[]>(`/admin/flags?status=${status}`).then(setRows), [status]);
  useEffect(() => void load(), [load]);

  const review = async (id: string, s: "dismissed" | "actioned") => {
    await api(`/admin/flags/${id}`, { method: "PATCH", body: { status: s } });
    await load();
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(["open", "dismissed", "actioned"] as const).map((s) => (
          <button key={s} className={status === s ? "btn" : "btn-secondary"} onClick={() => setStatus(s)}>
            {s === "open" ? t("open") : s === "dismissed" ? t("dismissedTab") : t("actionedTab")}
          </button>
        ))}
      </div>
      {rows.length === 0 && <p className="text-sm text-slate-500">{t("noFlags")}</p>}
      {rows.map((f) => (
        <div key={f.id} className="card space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${SEV[f.severity]}`}>{t(`severity.${f.severity}`)}</span>
            <span className="font-semibold">{f.merchant_name}</span>
            <span className="text-sm text-slate-700">{t.has(`kinds.${f.kind}`) ? t(`kinds.${f.kind}`) : f.kind}</span>
            <span className="ms-auto text-sm text-slate-500">{format.dateTime(new Date(f.created_at), { dateStyle: "medium" })}</span>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-slate-600" dir="ltr">
            {Object.entries(f.details).map(([k, v]) => <code key={k} className="rounded bg-slate-100 px-1.5 py-0.5">{k}: {v}</code>)}
            <code className="rounded bg-slate-100 px-1.5 py-0.5">trust: {f.merchant_trust.toFixed(2)}</code>
          </div>
          {f.status === "open" && (
            <div className="flex gap-2 pt-1">
              <button className="btn-secondary" onClick={() => review(f.id, "dismissed")}>{t("dismiss")}</button>
              <button className="btn-secondary" onClick={() => review(f.id, "actioned")}>{t("action")}</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
