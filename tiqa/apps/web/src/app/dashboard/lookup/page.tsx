"use client";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { BandBadge } from "@/components/BandBadge";
import { api, type ScoreResponse } from "@/lib/api";
import { useErrorMessage } from "@/lib/use-error";

export default function LookupPage() {
  const t = useTranslations();
  const errMsg = useErrorMessage();
  const [phone, setPhone] = useState("");
  const [orderRef, setOrderRef] = useState("");
  const [result, setResult] = useState<ScoreResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api<ScoreResponse>("/app/lookup", { body: { phone, order_ref: orderRef || undefined } }));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("lookup.title")}</h1>
        <p className="text-slate-600">{t("lookup.subtitle")}</p>
      </div>
      <form onSubmit={submit} className="card grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div>
          <label className="label" htmlFor="phone">{t("lookup.phone")}</label>
          <input id="phone" inputMode="tel" dir="ltr" className="input text-start" placeholder={t("lookup.phonePlaceholder")} required value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="ref">{t("lookup.orderRef")}</label>
          <input id="ref" className="input" value={orderRef} onChange={(e) => setOrderRef(e.target.value)} />
        </div>
        <button className="btn" disabled={busy || !phone}>{t("lookup.submit")}</button>
      </form>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {result && (
        <div className="card space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <BandBadge band={result.band} size="lg" />
            {result.score !== null && (
              <div className="text-sm text-slate-600">
                {t("lookup.score")}: <span className="text-2xl font-bold text-slate-900">{result.score}</span>/100
              </div>
            )}
          </div>
          <p className="font-medium">{t(`bandAdvice.${result.band}`)}</p>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-slate-500">{t("lookup.outcomes")}</dt>
              <dd className="font-semibold"><span dir="ltr">{result.outcomes_count}</span></dd>
            </div>
            <div>
              <dt className="text-slate-500">{t("lookup.stores")}</dt>
              <dd className="font-semibold"><span dir="ltr">{result.merchants_count}</span></dd>
            </div>
          </dl>
          {result.reasons.length > 0 && (
            <div>
              <div className="mb-1 text-sm text-slate-500">{t("lookup.reasons")}</div>
              <ul className="flex flex-wrap gap-2">
                {result.reasons.map((r) => (
                  <li key={r} className="rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700">{t.has(`reasons.${r}`) ? t(`reasons.${r}`) : r}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="border-t border-slate-100 pt-3 text-xs text-slate-500">{t("lookup.disclaimer")}</p>
        </div>
      )}
    </div>
  );
}
