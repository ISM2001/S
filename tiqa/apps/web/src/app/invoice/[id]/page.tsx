"use client";
import { useLocale, useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { mad } from "@/lib/money";

interface Party { name?: string; ice?: string | null; rc?: string; if?: string; address?: string | null; city?: string | null; email?: string | null; bank?: string; rib?: string }
interface Invoice {
  number: string; period: string; status: string; issuedAt: string; dueAt: string; currency: string;
  lines: Array<{ label: string; quantity: number; unitCentimes: number; totalCentimes: number }>;
  subtotalCentimes: number; vatRateBp: number; vatCentimes: number; totalCentimes: number;
  seller: Party; buyer: Party; creditNoteNumber: string | null;
}

/** Printable invoice (browser "Print → Save as PDF"). Legal content is in French. */
export default function InvoicePage() {
  const t = useTranslations("billing");
  const locale = useLocale();
  const { id } = useParams<{ id: string }>();
  const [inv, setInv] = useState<Invoice | null>(null);
  useEffect(() => void api<Invoice>(`/app/billing/invoices/${id}`).then(setInv), [id]);
  if (!inv) return null;
  const d = (s: string) => new Date(s).toLocaleDateString("fr-MA");
  const amount = (c: number) => `${mad(c, locale)} ${inv.currency}`;
  return (
    <main className="mx-auto max-w-3xl bg-white p-8 text-sm print:p-0">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="text-2xl font-bold text-brand-700">Tiqa</div>
          <div className="text-xl font-semibold">{t("printTitle")} <span dir="ltr">{inv.number}</span></div>
          {inv.creditNoteNumber && <div className="mt-1 font-semibold text-red-700">{t("creditNote", { n: inv.creditNoteNumber })}</div>}
        </div>
        <button className="btn-secondary print:hidden" onClick={() => window.print()}>{t("print")}</button>
      </div>
      <div className="mb-6 grid grid-cols-2 gap-6">
        {(["seller", "buyer"] as const).map((k) => {
          const p = inv[k];
          return (
            <div key={k}>
              <div className="mb-1 text-xs uppercase text-slate-500">{t(k)}</div>
              <div className="font-semibold">{p.name}</div>
              {p.address && <div>{p.address}{p.city ? `, ${p.city}` : ""}</div>}
              {p.ice && <div>ICE : <span dir="ltr">{p.ice}</span></div>}
              {p.rc && <div>RC : {p.rc} · IF : {p.if}</div>}
            </div>
          );
        })}
      </div>
      <div className="mb-4 flex gap-6">
        <div>{t("issued")} : {d(inv.issuedAt)}</div>
        <div>{t("due")} : {d(inv.dueAt)}</div>
        <div>{t("period")} : <span dir="ltr">{inv.period}</span></div>
      </div>
      <table className="mb-4 w-full border-collapse">
        <thead>
          <tr className="border-b-2 border-slate-800">
            {["designation", "qty", "unit", "total"].map((h) => <th key={h} className="py-1 text-start">{t(h)}</th>)}
          </tr>
        </thead>
        <tbody>
          {inv.lines.map((l, i) => (
            <tr key={i} className="border-b border-slate-200">
              <td className="py-1">{l.label}</td>
              <td className="py-1">{l.quantity}</td>
              <td className="py-1">{amount(l.unitCentimes)}</td>
              <td className="py-1">{amount(l.totalCentimes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ms-auto w-64 space-y-1">
        <div className="flex justify-between"><span>{t("subtotal")}</span><span>{amount(inv.subtotalCentimes)}</span></div>
        <div className="flex justify-between"><span>{t("vat", { rate: inv.vatRateBp / 100 })}</span><span>{amount(inv.vatCentimes)}</span></div>
        <div className="flex justify-between border-t border-slate-800 pt-1 font-bold"><span>{t("totalTtc")}</span><span>{amount(inv.totalCentimes)}</span></div>
      </div>
      <div className="mt-8 text-xs text-slate-600">
        <div>{t("payment")} · {t("bank")} : {inv.seller.bank} · {t("rib")} : <span dir="ltr">{inv.seller.rib}</span></div>
        <div>{t("paymentHelp")}</div>
        {inv.seller.name?.startsWith("[") && <div className="mt-2 text-red-700 print:hidden">{t("draftNotice")}</div>}
      </div>
    </main>
  );
}
