"use client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthShell } from "@/components/AuthShell";
import { api } from "@/lib/api";
import { useErrorMessage } from "@/lib/use-error";

export default function LoginPage() {
  const t = useTranslations("auth");
  const errMsg = useErrorMessage();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/app/auth/login", { body: { email, password } });
      router.push("/dashboard");
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function magic() {
    if (!email) return setError(errMsg({ code: "VALIDATION_FAILED" }));
    setBusy(true);
    setError(null);
    try {
      await api("/app/auth/magic-link", { body: { email } });
      setInfo(t("magicSent"));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title={t("loginTitle")}>
      <form onSubmit={login} className="space-y-4">
        <div>
          <label className="label" htmlFor="email">{t("email")}</label>
          <input id="email" type="email" dir="ltr" className="input" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="password">{t("password")}</label>
          <input id="password" type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && <p className="text-sm text-red-700">{error}</p>}
        {info && <p className="rounded-lg bg-brand-50 p-3 text-sm text-brand-900">{info}</p>}
        <button className="btn w-full" disabled={busy || !password}>{t("login")}</button>
        <div className="text-center text-xs text-slate-400">{t("or")}</div>
        <button type="button" className="btn-secondary w-full" disabled={busy} onClick={magic}>{t("sendMagicLink")}</button>
      </form>
      <p className="mt-6 text-center text-sm text-slate-600">
        {t("noAccount")} <Link href="/signup" className="font-medium text-brand-700 hover:underline">{t("signup")}</Link>
      </p>
    </AuthShell>
  );
}
