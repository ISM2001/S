"use client";
import { useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AuthShell } from "@/components/AuthShell";
import { api } from "@/lib/api";
import { useErrorMessage } from "@/lib/use-error";

interface InviteInfo { email: string; merchant_name: string; role: "owner" | "admin" | "member"; has_account: boolean }

function Accept() {
  const t = useTranslations("invite");
  const tt = useTranslations("team");
  const ta = useTranslations("auth");
  const errMsg = useErrorMessage();
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [info, setInfo] = useState<InviteInfo | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return setInvalid(true);
    api<InviteInfo>(`/app/invites/${encodeURIComponent(token)}`).then(setInfo, () => setInvalid(true));
  }, [token]);

  if (invalid) return <p className="text-sm text-red-700">{t("invalid")}</p>;
  if (!info) return null;
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api("/app/invites/accept", { body: { token, password: info.has_account ? undefined : password } });
          router.replace("/dashboard");
        } catch (err) {
          setError(errMsg(err));
        }
      }}
    >
      <p className="text-sm">{t("body", { merchant: info.merchant_name, role: tt(`roles.${info.role}`) })}</p>
      <p className="text-sm text-slate-500" dir="ltr">{info.email}</p>
      {!info.has_account && (
        <div>
          <label className="label" htmlFor="pw">{t("setPassword")}</label>
          <input id="pw" type="password" className="input" minLength={10} required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <p className="mt-1 text-xs text-slate-500">{ta("passwordHint")}</p>
        </div>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button className="btn w-full">{t("accept")}</button>
    </form>
  );
}

export default function InvitePage() {
  const t = useTranslations("invite");
  return (
    <AuthShell title={t("title")}>
      <Suspense>
        <Accept />
      </Suspense>
    </AuthShell>
  );
}
