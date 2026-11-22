import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALES, type Locale } from "./config";

/** Locale comes from a cookie (no locale prefix in URLs, which keeps routing simple). */
export default getRequestConfig(async () => {
  const c = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale: Locale = (LOCALES as readonly string[]).includes(c ?? "") ? (c as Locale) : DEFAULT_LOCALE;
  return {
    locale,
    timeZone: "Africa/Casablanca",
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
