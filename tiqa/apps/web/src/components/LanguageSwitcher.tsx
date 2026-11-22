"use client";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { LOCALE_COOKIE } from "@/i18n/config";

export function LanguageSwitcher({ onChange }: { onChange?: (l: "fr" | "ar") => void }) {
  const locale = useLocale();
  const router = useRouter();
  const set = (l: "fr" | "ar") => {
    document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    onChange?.(l);
    router.refresh();
  };
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-slate-300 text-sm">
      {(["fr", "ar"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => set(l)}
          className={`px-3 py-1 ${locale === l ? "bg-brand-600 text-white" : "bg-white text-slate-700 hover:bg-slate-50"}`}
        >
          {l === "fr" ? "Français" : "العربية"}
        </button>
      ))}
    </div>
  );
}
