"use client";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useMe } from "@/components/MeContext";
import { api } from "@/lib/api";
import { mad } from "@/lib/money";
import { useErrorMessage } from "@/lib/use-error";

interface Plan { id: string; code: string; nameFr: string; nameAr: string; monthlyFeeCentimes: number; includedLookups: number; overageCentimesPerLookup: number }
interface Billing {
  plan: Plan | null;
  plans: Plan[];
  usage: { period: string; lookups: number };
  estimate: { totalCentimes: number; vatRateBp: number } | null;
  profile: { legal_name: string | null; ice: string | null; address: string | null; city: string | null; email: string | null };
  payment: { bank: string; rib: string };
  invoices: Array<{ id: string; number: string; period: string; status: "issued" | "paid" | "cancelled"; totalCentimes: number; overdue: boolean }>;
}

export default function BillingPage() {
  const t = useTranslations("billing");
  const tc = useTranslations("common");
  const locale = useLocale();
  const format = useFormatter();
  const errMsg = useErrorMessage();
  const { me } = useMe();
  const [b, setB] = useState<Billing | null>(null);
  const [profile, setProfile] = useState({ legal_name: "", ice: "", address: "", city: "", email: "" });
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = () => api<Billing>("/app/billing").then((x) => {
    setB(x);
    setProfile({ legal_name: x.profile.legal_name ?? "", ice: x.profile.ice ?? "", address: x.profile.address ?? "", city: x.profile.city ?? "", email: x.profile.email ?? "" });
  });
  useEffect(() => void load(), []);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); await load(); } catch (e) { setError(errMsg(e)); }
  };
  if (!b) return null;
  const isOwner = me.merchant.role === "owner";
  const canEdit = me.merchant.role !== "member";
  const included = b.plan?.includedLookups ?? 0;
  const pct = included ? Math.min(100, (b.usage.lookups / included) * 100) : 0;

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-bold">{t("title")}</h1>
      {error && <p className="text-sm text-red-700">{error}</p>}

      <section className="card space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-semibold">{t("usage", { period: b.usage.period })}</h2>
          {b.estimate && <span className="text-sm text-slate-600">{t("estimate")}: <b>{mad(b.estimate.totalCentimes, locale)} MAD</b></span>}
        </div>
        <div className="h-3 rounded bg-slate-100"><div className={`h-3 rounded ${pct >= 100 ? "bg-red-500" : "bg-brand-600"}`} style={{ width: `${pct}%` }} /></div>
        <p className="text-sm text-slate-600">{t("lookupsUsed", { used: b.usage.lookups, included })}</p>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {b.plans.map((p) => {
          const current = b.plan?.id === p.id;
          return (
            <div key={p.id} className={`card space-y-2 ${current ? "ring-2 ring-brand-600" : ""}`}>
              <div className="font-semibold">{locale === "ar" ? p.nameAr : p.nameFr}</div>
              <div className="text-xl font-bold">{p.monthlyFeeCentimes ? t("perMonth", { price: mad(p.monthlyFeeCentimes, locale) }) : t("free")}</div>
              <div className="text-sm text-slate-600">{t("included", { n: format.number(p.includedLookups) })}</div>
              <div className="text-xs text-slate-500">{p.overageCentimesPerLookup ? t("overage", { price: mad(p.overageCentimesPerLookup, locale) }) : t("noOverage")}</div>
              {current ? (
                <div className="text-sm font-medium text-brand-700">{t("current")}</div>
              ) : (
                isOwner && <button className="btn-secondary w-full" onClick={() => act(() => api("/app/billing/plan", { method: "PATCH", body: { code: p.code } }))}>{t("choose")}</button>
              )}
            </div>
          );
        })}
      </section>

      <form className="card space-y-3" onSubmit={(e) => {
        e.preventDefault();
        setSaved(false);
        void act(async () => {
          const body = Object.fromEntries(Object.entries(profile).map(([k, v]) => [k, v.trim() || null]));
          await api("/app/billing/profile", { method: "PATCH", body: { ...body, legal_name: profile.legal_name } });
          setSaved(true);
        });
      }}>
        <h2 className="font-semibold">{t("profile")}</h2>
        <p className="text-sm text-slate-500">{t("profileHelp")}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {([["legal_name", "legalName"], ["ice", "ice"], ["address", "address"], ["city", "city"], ["email", "email"]] as const).map(([k, label]) => (
            <div key={k}>
              <label className="label" htmlFor={k}>{t(label)}</label>
              <input id={k} className="input" disabled={!canEdit} dir={k === "ice" || k === "email" ? "ltr" : undefined} required={k === "legal_name"}
                inputMode={k === "ice" ? "numeric" : undefined} pattern={k === "ice" ? "\\d{15}" : undefined}
                value={profile[k]} onChange={(e) => setProfile({ ...profile, [k]: e.target.value })} />
            </div>
          ))}
        </div>
        {canEdit && <button className="btn-secondary">{tc("save")}</button>}
        {saved && <span className="ms-3 text-sm text-brand-700">✓</span>}
      </form>

      <section className="card space-y-3">
        <h2 className="font-semibold">{t("invoices")}</h2>
        {b.invoices.length === 0 ? <p className="text-sm text-slate-500">{t("noInvoices")}</p> : (
          <table className="w-full text-sm">
            <thead className="text-slate-500"><tr>{["number", "period", "amount", "status"].map((h) => <th key={h} className="py-1 text-start font-medium">{t(h)}</th>)}<th /></tr></thead>
            <tbody>
              {b.invoices.map((i) => (
                <tr key={i.id} className="border-t border-slate-100">
                  <td className="py-2" dir="ltr">{i.number}</td>
                  <td className="py-2" dir="ltr">{i.period}</td>
                  <td className="py-2">{mad(i.totalCentimes, locale)} MAD</td>
                  <td className={`py-2 ${i.overdue ? "font-semibold text-red-700" : ""}`}>{t(`statuses.${i.overdue ? "overdue" : i.status}`)}</td>
                  <td className="py-2 text-end"><Link className="text-brand-700 hover:underline" href={`/invoice/${i.id}`} target="_blank">{t("view")}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="rounded-lg bg-slate-50 p-3 text-sm">
          <div className="font-medium">{t("payment")}</div>
          <div>{t("bank")}: {b.payment.bank}</div>
          <div>{t("rib")}: <span dir="ltr">{b.payment.rib}</span></div>
          <div className="text-xs text-slate-500">{t("paymentHelp")}</div>
        </div>
      </section>
    </div>
  );
}
