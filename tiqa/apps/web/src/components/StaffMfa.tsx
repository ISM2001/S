"use client";
import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useErrorMessage } from "@/lib/use-error";

/** Staff two-factor gate: enrolment (QR code rendered locally, never sent to a third party) or code entry. */
export function StaffMfa({ mode, onDone }: { mode: "setup_required" | "required"; onDone: () => void }) {
  const t = useTranslations("admin.mfa");
  const errMsg = useErrorMessage();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "setup_required") return;
    api<{ secret: string; otpauth_uri: string }>("/admin/mfa/setup", { method: "POST", body: {} })
      .then(async (r) => setSetup({ secret: r.secret, qr: await QRCode.toDataURL(r.otpauth_uri, { margin: 1, width: 200 }) }))
      .catch((e) => setError(errMsg(e)));
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mx-auto max-w-sm space-y-4 py-10">
      <h1 className="text-xl font-bold">{t("title")}</h1>
      <p className="text-sm text-slate-600">{mode === "setup_required" ? t("setupHelp") : t("requiredHelp")}</p>
      {setup && (
        <div className="card space-y-2 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qr} alt="QR code" className="mx-auto" width={200} height={200} />
          <div className="text-xs text-slate-500">{t("secret")}</div>
          <code className="block break-all text-xs" dir="ltr">{setup.secret}</code>
        </div>
      )}
      <form className="space-y-3" onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api("/admin/mfa/verify", { body: { code } });
          onDone();
        } catch (err) {
          setError(errMsg(err));
        }
      }}>
        <label className="label" htmlFor="totp">{t("code")}</label>
        <input id="totp" dir="ltr" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="input tracking-widest" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button className="btn w-full" disabled={code.length !== 6}>{t("verify")}</button>
      </form>
    </div>
  );
}
