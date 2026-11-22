"use client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { api, ApiError } from "@/lib/api";

const NAV = [["/admin", "requests"], ["/admin/merchants", "merchants"], ["/admin/flags", "flags"]] as const;

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("admin");
  const tc = useTranslations("common");
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<"loading" | "ok" | "forbidden">("loading");
  const [overview, setOverview] = useState<{ open_requests: number; open_flags: number; merchants: number; low_trust_merchants: number } | null>(null);

  useEffect(() => {
    api("/admin/me")
      .then(() => {
        setState("ok");
        return api<typeof overview>("/admin/overview").then(setOverview);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) router.replace("/login");
        else setState("forbidden");
      });
  }, [router, pathname]);

  if (state === "loading") return <div className="p-8 text-sm text-slate-500">{tc("loading")}</div>;
  if (state === "forbidden") return <div className="p-8 text-sm text-red-700">{t("notStaff")}</div>;

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3">
          <div className="font-bold text-brand-700">{t("title")}</div>
          <nav className="flex gap-1">
            {NAV.map(([href, key]) => (
              <Link key={href} href={href} className={`rounded-lg px-3 py-1.5 text-sm font-medium ${pathname === href ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50"}`}>
                {t(`nav.${key}`)}
              </Link>
            ))}
          </nav>
          <div className="ms-auto flex items-center gap-3">
            <LanguageSwitcher />
            <button className="text-sm text-slate-600 hover:underline" onClick={() => api("/app/auth/logout", { method: "POST", body: {} }).finally(() => router.replace("/login"))}>
              {tc("logout")}
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl p-4 md:p-8">
        {overview && (
          <p className="mb-6 text-sm text-slate-500">
            {t("overview", { requests: overview.open_requests, flags: overview.open_flags, merchants: overview.merchants, low: overview.low_trust_merchants })}
          </p>
        )}
        {children}
      </main>
    </div>
  );
}
