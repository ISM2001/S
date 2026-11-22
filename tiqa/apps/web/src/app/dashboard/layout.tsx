"use client";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { MeContext } from "@/components/MeContext";
import { api, ApiError, type Me } from "@/lib/api";

const NAV = [
  ["/dashboard", "overview"],
  ["/dashboard/lookup", "lookup"],
  ["/dashboard/upload", "upload"],
  ["/dashboard/history", "history"],
  ["/dashboard/api-keys", "apiKeys"],
] as const;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations();
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);

  const load = useCallback(() => {
    api<Me>("/app/me")
      .then(setMe)
      .catch((e) => {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.replace("/login");
      });
  }, [router]);
  useEffect(load, [load]);

  async function logout() {
    await api("/app/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    router.replace("/login");
  }

  if (!me) return <div className="p-8 text-sm text-slate-500">{t("common.loading")}</div>;

  return (
    <MeContext.Provider value={{ me, reload: load }}>
      <div className="min-h-screen md:flex">
        <aside className="border-b border-slate-200 bg-white md:min-h-screen md:w-60 md:border-b-0 md:border-e">
          <div className="p-4">
            <div className="text-xl font-bold text-brand-700">{t("common.appName")}</div>
            <div className="truncate text-sm text-slate-500">{me.merchant.name}</div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-col md:pb-0">
            {NAV.map(([href, key]) => (
              <Link
                key={href}
                href={href}
                className={`whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium ${
                  pathname === href ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                {t(`nav.${key}`)}
              </Link>
            ))}
          </nav>
          <div className="hidden space-y-3 p-4 md:block">
            <LanguageSwitcher onChange={(locale) => void api("/app/me", { method: "PATCH", body: { locale } }).catch(() => undefined)} />
            <div dir="ltr" className="truncate text-xs text-slate-500">{me.user.email}</div>
            <button className="text-sm text-slate-600 hover:underline" onClick={logout}>{t("common.logout")}</button>
          </div>
        </aside>
        <main className="flex-1 p-4 md:p-8">
          <div className="mb-4 flex items-center justify-between md:hidden">
            <LanguageSwitcher />
            <button className="text-sm text-slate-600" onClick={logout}>{t("common.logout")}</button>
          </div>
          <ContributionBanner me={me} />
          {children}
        </main>
      </div>
    </MeContext.Provider>
  );
}

function ContributionBanner({ me }: { me: Me }) {
  const t = useTranslations("overview.contribution");
  const c = me.contribution;
  if (c.tier === "full") return null;
  const tone = c.tier === "grace" ? "bg-sky-50 text-sky-900 border-sky-200" : "bg-amber-50 text-amber-900 border-amber-200";
  return (
    <div className={`mb-6 rounded-lg border p-3 text-sm ${tone}`}>
      {t(c.tier, { ratio: Math.round((c.ratio ?? 0) * 100), limit: c.limitPerMin })}
    </div>
  );
}
