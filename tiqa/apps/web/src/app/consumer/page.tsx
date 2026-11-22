"use client";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { api, ApiError } from "@/lib/api";
import { carrierLabel, cityLabel } from "@/lib/labels";
import { useErrorMessage } from "@/lib/use-error";

interface Summary {
  records: Array<{ id: string; month: string; outcome: "delivered" | "refused" | "returned" | "unreachable"; city: string | null; carrier: string | null; status: "active" | "frozen" }>;
  stores_count: number;
  requests: Array<{ id: string; type: "dispute" | "deletion"; status: "open" | "upheld" | "rejected"; created_at: string; records: number }>;
  retention_months: number;
}

/** Public consumer rights portal (no account): verify the phone by SMS code, then access / dispute / delete. */
export default function ConsumerPortal() {
  const t = useTranslations("consumer");
  const th = useTranslations("history");
  const errMsg = useErrorMessage();
  const [step, setStep] = useState<"phone" | "code" | "summary">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  // Store the message KEY (not the translated text) so it follows a language switch.
  const [info, setInfo] = useState<"codeSent" | "requestSent" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const s = await api<Summary>("/public/me");
    setSummary(s);
    setStep("summary");
  };
  // Resume an existing (15-minute) session after a page reload.
  useEffect(() => void load().catch(() => undefined), []);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && step === "summary") setStep("phone");
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const sendCode = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api("/public/otp/request", { body: { phone } });
      setInfo("codeSent");
      setStep("code");
    });
  };
  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await api("/public/otp/verify", { body: { phone, code } });
      setInfo(null);
      await load();
    });
  };
  const request = (type: "dispute" | "deletion", ids?: string[]) =>
    run(async () => {
      if (type === "deletion" && !confirm(t("deleteConfirm"))) return;
      await api("/public/me/requests", { body: { type, outcome_ids: ids?.length ? ids : undefined, message: message || undefined } });
      setSelected(new Set());
      setMessage("");
      setInfo("requestSent");
      await load();
    });
  const logout = () =>
    run(async () => {
      await api("/public/logout", { method: "POST", body: {} });
      setSummary(null);
      setPhone("");
      setCode("");
      setStep("phone");
    });

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="text-2xl font-bold text-brand-700">Tiqa</div>
        <LanguageSwitcher />
      </div>
      <h1 className="mb-2 text-2xl font-bold">{t("title")}</h1>
      <p className="mb-2 text-slate-600">{t("intro")}</p>
      <p className="mb-6 text-sm text-slate-600">{t("rights")}</p>

      {info && <p className="mb-4 rounded-lg bg-brand-50 p-3 text-sm text-brand-900">{t(info)}</p>}
      {error && <p className="mb-4 text-sm text-red-700">{error}</p>}

      {step === "phone" && (
        <form onSubmit={sendCode} className="card flex flex-wrap items-end gap-3">
          <div className="flex-1">
            <label className="label" htmlFor="phone">{t("phone")}</label>
            <input id="phone" dir="ltr" inputMode="tel" className="input" placeholder="06 12 34 56 78" required value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <button className="btn" disabled={busy || !phone}>{t("sendCode")}</button>
        </form>
      )}

      {step === "code" && (
        <form onSubmit={verify} className="card flex flex-wrap items-end gap-3">
          <div className="flex-1">
            <label className="label" htmlFor="code">{t("code")}</label>
            <input id="code" dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="input tracking-widest" required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </div>
          <button className="btn" disabled={busy || code.length !== 6}>{t("verify")}</button>
          <button type="button" className="btn-secondary" onClick={() => setStep("phone")}>{t("changeNumber")}</button>
        </form>
      )}

      {step === "summary" && summary && (
        <div className="space-y-6">
          <section className="card space-y-3">
            <h2 className="font-semibold">{t("summaryTitle")}</h2>
            {summary.records.length === 0 ? (
              <p className="text-sm text-slate-600">{t("noRecords")}</p>
            ) : (
              <>
                <p className="text-sm text-slate-600">{t("storesCount", { count: summary.stores_count })} {t("storesHidden")}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="w-8" />
                        {["month", "outcome", "city", "carrier", "status"].map((h) => <th key={h} className="px-2 py-1 text-start font-medium">{t(h)}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {summary.records.map((r) => (
                        <tr key={r.id} className="border-t border-slate-100">
                          <td className="px-2 py-1">
                            <input type="checkbox" aria-label={r.month} disabled={r.status === "frozen"} checked={selected.has(r.id)}
                              onChange={(e) => {
                                const s = new Set(selected);
                                if (e.target.checked) s.add(r.id); else s.delete(r.id);
                                setSelected(s);
                              }} />
                          </td>
                          <td className="px-2 py-1" dir="ltr">{r.month}</td>
                          <td className="px-2 py-1">{th(`outcomes.${r.outcome}`)}</td>
                          <td className="px-2 py-1">{cityLabel(r.city)}</td>
                          <td className="px-2 py-1">{carrierLabel(r.carrier)}</td>
                          <td className="px-2 py-1">
                            {r.status === "frozen"
                              ? <span className="rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-800">{t("statusFrozen")}</span>
                              : <span className="text-xs text-slate-500">{t("statusActive")}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            <p className="text-xs text-slate-500">{t("retention", { months: summary.retention_months })}</p>
          </section>

          {summary.records.some((r) => r.status === "active") && (
            <section className="card space-y-3">
              <h2 className="font-semibold">{t("disputeTitle")}</h2>
              <p className="text-sm text-slate-600">{t("disputeHelp")}</p>
              <div>
                <label className="label" htmlFor="msg">{t("message")}</label>
                <textarea id="msg" className="input" rows={2} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn" disabled={busy || selected.size === 0} onClick={() => request("dispute", [...selected])}>{t("disputeSelected")}</button>
                <button className="btn-secondary" disabled={busy} onClick={() => request("dispute")}>{t("disputeAll")}</button>
              </div>
            </section>
          )}

          <section className="card space-y-3">
            <h2 className="font-semibold">{t("deleteTitle")}</h2>
            <p className="text-sm text-slate-600">{t("deleteHelp")}</p>
            <button className="btn-secondary border-red-300 text-red-700" disabled={busy} onClick={() => request("deletion")}>{t("deleteButton")}</button>
          </section>

          {summary.requests.length > 0 && (
            <section className="card">
              <h2 className="mb-2 font-semibold">{t("requestsTitle")}</h2>
              <ul className="space-y-1 text-sm">
                {summary.requests.map((r) => (
                  <li key={r.id} className="flex flex-wrap justify-between gap-2 border-t border-slate-100 py-2">
                    <span>{t(`requestType.${r.type}`)} · <span dir="ltr">{r.created_at.slice(0, 10)}</span></span>
                    <span className="font-medium">{t(`requestStatus.${r.status}`)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <button className="btn-secondary" onClick={logout}>{t("logout")}</button>
        </div>
      )}
      <p className="mt-10 text-xs text-slate-400">{t("legalDraft")}</p>
    </main>
  );
}
