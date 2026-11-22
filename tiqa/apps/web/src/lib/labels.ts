const CARRIERS: Record<string, string> = {
  amana: "Amana", cathedis: "Cathedis", sendit: "Sendit", ozon_express: "Ozon Express", speedaf: "Speedaf",
  digylog: "Digylog", onessta: "Onessta", forcelog: "Forcelog", ctm_messagerie: "CTM Messagerie",
};
export const carrierLabel = (c: string | null) => (c ? (CARRIERS[c] ?? c) : "—");
export const cityLabel = (c: string | null) =>
  c ? c.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : "—";
