"use client";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthShell } from "@/components/AuthShell";
import { api } from "@/lib/api";
import { useErrorMessage } from "@/lib/use-error";

export default function SignupPage() {
  const t = useTranslations("auth");
  const locale = useLocale();
  const errMsg = useErrorMessage();
  const router = useRouter();
  const [form, setForm] = useState({ merchantName: "", email: "", password: "", acceptTerms: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/app/auth/signup", { body: { ...form, locale } });
      router.push("/dashboard");
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t("signupTitle")}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="merchantName">{t("merchantName")}</label>
          <input id="merchantName" className="input" required minLength={2} value={form.merchantName} onChange={(e) => setForm({ ...form, merchantName: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="email">{t("email")}</label>
          <input id="email" type="email" dir="ltr" className="input" autoComplete="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="password">{t("password")}</label>
          <input id="password" type="password" className="input" autoComplete="new-password" required minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <p className="mt-1 text-xs text-slate-500">{t("passwordHint")}</p>
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-1" checked={form.acceptTerms} onChange={(e) => setForm({ ...form, acceptTerms: e.target.checked })} />
          <span>
            {t("acceptTerms")} <span className="text-slate-400">{t("termsDraft")}</span>
          </span>
        </label>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button className="btn w-full" disabled={busy || !form.acceptTerms}>{t("signup")}</button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        {t("haveAccount")} <Link href="/login" className="font-medium text-brand-700 hover:underline">{t("login")}</Link>
      </p>
    </AuthShell>
  );
}
