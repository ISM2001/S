"use client";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { BandBadge } from "@/components/BandBadge";
import { api, type Band } from "@/lib/api";

interface Item {
  id: string;
  createdAt: string;
  phoneLast2: string;
  merchantOrderRef: string | null;
  band: Band;
  score: number | null;
  decision: "shipped" | "cancelled" | "prepaid_required" | null;
  own_outcome: "delivered" | "refused" | "returned" | "unreachable" | null;
}

const BANDS: Array<Band | ""> = ["", "high", "medium", "low", "insufficient_data"];

export default function HistoryPage() {
  const t = useTranslations();
  const format = useFormatter();
  const [band, setBand] = useState<Band | "">("");
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(
    async (reset: boolean, from?: string | null) => {
      const qs = new URLSearchParams({ limit: "50" });
      if (band) qs.set("band", band);
      if (!reset && from) qs.set("cursor", from);
      const res = await api<{ items: Item[]; next_cursor: string | null }>(`/app/lookups?${qs}`);
      setItems((prev) => (reset ? res.items : [...prev, ...res.items]));
      setCursor(res.next_cursor);
      setLoaded(true);
    },
    [band],
  );
  useEffect(() => void load(true), [load]);

  async function setDecision(id: string, decision: string) {
    await api(`/app/lookups/${id}`, { method: "PATCH", body: { decision: decision || null } });
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, decision: (decision || null) as Item["decision"] } : x)));
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t("history.title")}</h1>
      <div className="flex flex-wrap gap-2">
        {BANDS.map((b) => (
          <button key={b || "all"} onClick={() => setBand(b)} className={band === b ? "btn" : "btn-secondary"}>
            {b ? t(`bands.${b}`) : t("history.all")}
          </button>
        ))}
      </div>
      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              {["date", "phone", "order", "band", "score", "decision", "ownOutcome"].map((h) => (
                <th key={h} className="px-4 py-2 text-start font-medium">{t(`history.${h}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((x) => (
              <tr key={x.id} className="border-t border-slate-100">
                <td className="whitespace-nowrap px-4 py-2 text-slate-500">{format.dateTime(new Date(x.createdAt), { dateStyle: "short", timeStyle: "short" })}</td>
                <td className="whitespace-nowrap px-4 py-2"><span dir="ltr">•• •• •• {x.phoneLast2}</span></td>
                <td className="px-4 py-2">{x.merchantOrderRef ?? "—"}</td>
                <td className="px-4 py-2"><BandBadge band={x.band} /></td>
                <td className="px-4 py-2 font-medium">{x.score ?? "—"}</td>
                <td className="px-4 py-2">
                  <select className="rounded border border-slate-200 bg-white px-1 py-0.5 text-xs" value={x.decision ?? ""} onChange={(e) => setDecision(x.id, e.target.value)}>
                    <option value="">{t("history.decisions.none")}</option>
                    {(["shipped", "cancelled", "prepaid_required"] as const).map((d) => (
                      <option key={d} value={d}>{t(`history.decisions.${d}`)}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2">{x.own_outcome ? t(`history.outcomes.${x.own_outcome}`) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loaded && items.length === 0 && <p className="p-6 text-center text-sm text-slate-500">{t("history.empty")}</p>}
      </div>
      {cursor && <button className="btn-secondary" onClick={() => load(false, cursor)}>{t("history.loadMore")}</button>}
    </div>
  );
}
