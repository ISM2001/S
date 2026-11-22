"use client";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useErrorMessage } from "@/lib/use-error";

type Status = "open" | "upheld" | "rejected";
interface Req {
  id: string;
  type: "dispute" | "deletion";
  status: Status;
  message: string | null;
  created_at: string;
  resolution_note: string | null;
  items: Array<{ merchant_name: string; outcome: string; source: string; occurred_at: string; order_ref: string | null }>;
}

export default function AdminRequests() {
  const t = useTranslations("admin");
  const tc = useTranslations("consumer");
  const th = useTranslations("history");
  const format = useFormatter();
  const errMsg = useErrorMessage();
  const [status, setStatus] = useState<Status>("open");
  const [rows, setRows] = useState<Req[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => api<Req[]>(`/admin/requests?status=${status}`).then(setRows), [status]);
  useEffect(() => void load(), [load]);

  async function resolve(id: string, decision: "upheld" | "rejected") {
    setError(null);
    try {
      await api(`/admin/requests/${id}/resolve`, { body: { decision, note: notes[id] || undefined } });
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(["open", "upheld", "rejected"] as const).map((s) => (
          <button key={s} className={status === s ? "btn" : "btn-secondary"} onClick={() => setStatus(s)}>{t(s)}</button>
        ))}
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {rows.length === 0 && <p className="text-sm text-slate-500">{t("noRequests")}</p>}
      {rows.map((r) => (
        <div key={r.id} className="card space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${r.type === "deletion" ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-800"}`}>
              {tc(`requestType.${r.type}`)}
            </span>
            <span className="text-sm text-slate-500">{format.dateTime(new Date(r.created_at), { dateStyle: "medium", timeStyle: "short" })}</span>
            <span className="text-sm text-slate-500">{t("records", { count: r.items.length })}</span>
          </div>
          {r.message && <blockquote className="border-s-4 border-slate-200 ps-3 text-sm italic text-slate-700">{r.message}</blockquote>}
          {r.items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-500">
                  <tr>{["store", "orderRef", "outcome", "source", "date"].map((h) => <th key={h} className="px-2 py-1 text-start font-medium">{t(h)}</th>)}</tr>
                </thead>
                <tbody>
                  {r.items.map((i, k) => (
                    <tr key={k} className="border-t border-slate-100">
                      <td className="px-2 py-1">{i.merchant_name}</td>
                      <td className="px-2 py-1" dir="ltr">{i.order_ref ?? "—"}</td>
                      <td className="px-2 py-1">{th(`outcomes.${i.outcome}`)}</td>
                      <td className="px-2 py-1 text-slate-500">{t(`sources.${i.source}`)}</td>
                      <td className="px-2 py-1 text-slate-500">{format.dateTime(new Date(i.occurred_at), { dateStyle: "short" })}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {r.status === "open" ? (
            <div className="space-y-2 border-t border-slate-100 pt-3">
              <input className="input" placeholder={t("note")} value={notes[r.id] ?? ""} onChange={(e) => setNotes({ ...notes, [r.id]: e.target.value })} />
              <div className="flex flex-wrap gap-2">
                <button className="btn" onClick={() => resolve(r.id, "upheld")}>{t("uphold")}</button>
                <button className="btn-secondary" onClick={() => resolve(r.id, "rejected")}>{t("reject")}</button>
              </div>
              <p className="text-xs text-slate-500">{r.type === "dispute" ? t("upholdHelpDispute") : t("upholdHelpDeletion")} {t("rejectHelp")}</p>
            </div>
          ) : (
            r.resolution_note && <p className="text-sm text-slate-600">{r.resolution_note}</p>
          )}
        </div>
      ))}
    </div>
  );
}
