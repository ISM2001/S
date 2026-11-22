/**
 * Coarse city reference list. Only the city code is stored (data minimization):
 * no street, no district, no full address. Unknown cities are stored as null.
 * City is NOT used by the v1 score (fairness: avoid penalizing whole regions).
 */
export const CITIES: Record<string, string[]> = {
  casablanca: ["casablanca", "casa", "dar el beida", "الدار البيضاء", "كازا", "الدارالبيضاء"],
  rabat: ["rabat", "الرباط"],
  sale: ["sale", "salé", "سلا"],
  temara: ["temara", "témara", "تمارة"],
  kenitra: ["kenitra", "kénitra", "القنيطرة"],
  fes: ["fes", "fès", "fez", "فاس"],
  meknes: ["meknes", "meknès", "مكناس"],
  marrakech: ["marrakech", "marrakesh", "مراكش"],
  agadir: ["agadir", "أكادير", "اكادير"],
  tanger: ["tanger", "tangier", "tangiers", "طنجة"],
  tetouan: ["tetouan", "tétouan", "تطوان"],
  oujda: ["oujda", "وجدة"],
  nador: ["nador", "الناظور"],
  alhoceima: ["al hoceima", "alhoceima", "الحسيمة"],
  eljadida: ["el jadida", "eljadida", "الجديدة"],
  safi: ["safi", "آسفي", "اسفي"],
  essaouira: ["essaouira", "الصويرة"],
  beni_mellal: ["beni mellal", "béni mellal", "بني ملال"],
  khouribga: ["khouribga", "خريبكة"],
  settat: ["settat", "سطات"],
  berrechid: ["berrechid", "برشيد"],
  mohammedia: ["mohammedia", "المحمدية"],
  khemisset: ["khemisset", "الخميسات"],
  taza: ["taza", "تازة"],
  larache: ["larache", "العرائش"],
  ksar_el_kebir: ["ksar el kebir", "القصر الكبير"],
  ouarzazate: ["ouarzazate", "ورزازات"],
  errachidia: ["errachidia", "الرشيدية"],
  laayoune: ["laayoune", "laâyoune", "العيون"],
  dakhla: ["dakhla", "الداخلة"],
  guelmim: ["guelmim", "كلميم"],
  tiznit: ["tiznit", "تزنيت"],
  taroudant: ["taroudant", "تارودانت"],
  inezgane: ["inezgane", "إنزكان", "انزكان"],
  berkane: ["berkane", "بركان"],
};

const ALIASES = new Map<string, string>();
for (const [code, names] of Object.entries(CITIES)) for (const n of [code, ...names]) ALIASES.set(fold(n), code);

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[-_']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCity(input: unknown): string | null {
  if (typeof input !== "string" || !input.trim()) return null;
  return ALIASES.get(fold(input)) ?? null;
}
