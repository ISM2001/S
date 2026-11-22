/** MAD amounts are stored in centimes. */
export const mad = (centimes: number, locale: string) =>
  new Intl.NumberFormat(locale === "ar" ? "ar-MA" : "fr-MA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(centimes / 100);
