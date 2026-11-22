"use client";
import { useTranslations } from "next-intl";
import { LanguageSwitcher } from "./LanguageSwitcher";

export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTranslations("common");
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <div className="text-2xl font-bold text-brand-700">{t("appName")}</div>
          <div className="text-sm text-slate-500">{t("tagline")}</div>
        </div>
        <LanguageSwitcher />
      </div>
      <div className="card">
        <h1 className="mb-4 text-lg font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}
