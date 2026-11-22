"use client";
import { useTranslations } from "next-intl";
import { ApiError } from "./api";

/** Turns an API error into a translated, user-friendly message. */
export function useErrorMessage() {
  const t = useTranslations("errors");
  return (e: unknown) => {
    const code = e instanceof ApiError ? e.code : "generic";
    return t.has(code) ? t(code) : t("generic");
  };
}
