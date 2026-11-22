import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { isRtl } from "@/i18n/config";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tiqa",
  description: "Réseau de prévention des retours COD au Maroc",
  robots: { index: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={isRtl(locale) ? "rtl" : "ltr"}>
      <body className="min-h-screen font-sans">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
