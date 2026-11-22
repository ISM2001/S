"use client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { AuthShell } from "@/components/AuthShell";
import { api } from "@/lib/api";

function Verify() {
  const t = useTranslations("auth");
  const router = useRouter();
  const token = useSearchParams().get("token");
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // tokens are single-use: never verify twice (React strict mode)
    started.current = true;
    if (!token) return setFailed(true);
    api("/app/auth/magic-link/verify", { body: { token } })
      .then(() => router.replace("/dashboard"))
      .catch(() => setFailed(true));
  }, [token, router]);

  return failed ? (
    <p className="text-sm text-red-700">
      {t("magicInvalid")} <Link className="underline" href="/login">{t("login")}</Link>
    </p>
  ) : (
    <p className="text-sm text-slate-600">{t("magicVerifying")}</p>
  );
}

export default function MagicPage() {
  const t = useTranslations("auth");
  return (
    <AuthShell title={t("loginTitle")}>
      <Suspense>
        <Verify />
      </Suspense>
    </AuthShell>
  );
}
