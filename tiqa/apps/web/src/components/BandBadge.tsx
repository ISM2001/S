"use client";
import { useTranslations } from "next-intl";
import type { Band } from "@/lib/api";

const STYLES: Record<Band, string> = {
  low: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  medium: "bg-amber-100 text-amber-800 ring-amber-200",
  high: "bg-red-100 text-red-800 ring-red-200",
  insufficient_data: "bg-slate-100 text-slate-600 ring-slate-200",
};

export function BandBadge({ band, size = "sm" }: { band: Band; size?: "sm" | "lg" }) {
  const t = useTranslations("bands");
  const s = size === "lg" ? "px-3 py-1 text-base" : "px-2 py-0.5 text-xs";
  return <span className={`inline-flex items-center rounded-full font-semibold ring-1 ${s} ${STYLES[band]}`}>{t(band)}</span>;
}
