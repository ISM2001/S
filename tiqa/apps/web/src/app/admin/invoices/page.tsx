"use client";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { mad } from "@/lib/money";
import { useErrorMessage } from "@/lib/use-error";

type Status = "issued" | "overdue" | "paid" | "cancelled";
interface Row { id: string; number: string; merchant_name: string; period: string; status: string; total_centimes: number; due_at: string; payment_ref: string | null; credit_note: string | null; overdue: boolean }

export default function AdminInvoices() {
  const t = useTranslations("admin.invoices");
  const tb = useTranslations("billing");
  const locale = useLocale();
  const errMsg = useErrorMessage();
  const [status, setStatus] = useState<Status>("issued");
  const [rows, setRows] = useState<Row[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api<Row[]>(`/admin/invoices?status=${status}`).then(setRows), [status]);
  useEffect(() => void load(), [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await load(); } catch (e) { setError(errMsg(e)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {(["issued", "overdue", "paid", "cancelled"] as const).map((s) => (
          <button key={s} className={status === s ? "btn" : "btn-secondary"} onClick={() => setStatus(s)}>{tb(`statuses.${s}`)}</button>
        ))}
        <button className="btn-secondary ms-auto" onClick={() => act(async () => {
          const r = await api<{ issued: number; skipped: number }>("/admin/billing/run", { method: "POST", body: {} });
          setInfo(t("result", r));
        })}>{t("runBilling")}</button>
      </div>
      {info && <p className="text-sm text-brand-700">{info}</p>}
      {error && <p className="text-sm text-red-700">{error}</p>}
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>{["number", "period", "amount", "status"].map((h) => <th key={h} className="px-3 py-2 text-start font-medium">{tb(h)}</th>)}<th className="px-3 py-2 text-start font-medium">{tb("buyer")}</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="px-3 py-2" dir="ltr">{r.number}</td>
                <td className="px-3 py-2" dir="ltr">{r.period}</td>
                <td className="px-3 py-2">{mad(r.total_centimes, locale)} MAD</td>
                <td className={`px-3 py-2 ${r.overdue ? "font-semibold text-red-700" : ""}`}>{tb(`statuses.${r.overdue ? "overdue" : r.status}`)}{r.credit_note ? ` · ${r.credit_note}` : ""}{r.payment_ref ? ` · ${r.payment_ref}` : ""}</td>
                <td className="px-3 py-2">{r.merchant_name}</td>
                <td className="space-x-2 px-3 py-2 text-end">
                  {r.status === "issued" && (
                    <>
                      <button className="btn-secondary px-2 py-1 text-xs" onClick={() => {
                        const reference = prompt(t("reference"));
                        if (reference) void act(() => api(`/admin/invoices/${r.id}/mark-paid`, { body: { method: "bank_transfer", reference } }));
                      }}>{t("markPaid")}</button>
                      <button className="btn-danger" onClick={() => {
                        const reason = prompt(t("cancelReason"));
                        if (reason) void act(() => api(`/admin/invoices/${r.id}/cancel`, { body: { reason } }));
                      }}>{t("cancel")}</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
