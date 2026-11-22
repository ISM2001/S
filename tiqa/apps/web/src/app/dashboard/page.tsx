"use client";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useMe } from "@/components/MeContext";
import { api } from "@/lib/api";

interface Stats {
  outcomes: { delivered: number; refused: number; returned: number; unreachable: number; total: number; refusal_rate: number | null };
  monthly: Array<{ month: string; total: number; refused: number }>;
  by_carrier: Array<{ carrier: string; total: number; refused: number }>;
  lookups_30d: Partial<Record<"low" | "medium" | "high" | "insufficient_data", number>>;
  money_saved: { orders_avoided: number; expected_refusals_avoided: number; failed_order_cost_mad: number; estimate_mad: number };
  usage: { lookups: number; plan: { code: string; included_lookups: number } | null };
}

const CARRIER_LABELS: Record<string, string> = {
  amana: "Amana", cathedis: "Cathedis", sendit: "Sendit", ozon_express: "Ozon Express", speedaf: "Speedaf",
  digylog: "Digylog", onessta: "Onessta", forcelog: "Forcelog", ctm_messagerie: "CTM Messagerie", unknown: "—",
};
const carrierLabel = (c: string) => CARRIER_LABELS[c] ?? c;

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

export default function Overview() {
  const t = useTranslations();
  const format = useFormatter();
  const { me } = useMe();
  const [stats, setStats] = useState<Stats | null>(null);
  const [cost, setCost] = useState<string>("");

  const load = () => api<Stats>("/app/stats").then((s) => {
    setStats(s);
    setCost(String(s.money_saved.failed_order_cost_mad));
  });
  useEffect(() => void load(), []);

  if (!stats) return <p className="text-sm text-slate-500">{t("common.loading")}</p>;
  const canEdit = me.merchant.role !== "member";
  const maxMonthly = Math.max(1, ...stats.monthly.map((m) => m.total));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">{t("overview.title")}</h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label={t("overview.refusalRate")} value={pct(stats.outcomes.refusal_rate)} help={t("overview.refusalRateHelp")} />
        <Kpi label={t("overview.outcomes")} value={format.number(stats.outcomes.total)} />
        <Kpi
          label={t("overview.moneySaved")}
          value={t("common.mad", { amount: format.number(stats.money_saved.estimate_mad, { maximumFractionDigits: 0 }) })}
          help={t("overview.moneySavedHelp", { orders: stats.money_saved.orders_avoided, cost: stats.money_saved.failed_order_cost_mad })}
        />
        <Kpi
          label={t("overview.lookups30d")}
          value={format.number(Object.values(stats.lookups_30d).reduce((a, b) => a + (b ?? 0), 0))}
          help={
            stats.usage.plan
              ? t("overview.usage", { lookups: stats.usage.lookups, included: stats.usage.plan.included_lookups })
              : undefined
          }
        />
      </div>

      {stats.outcomes.total === 0 && <div className="card text-sm text-slate-600">{t("overview.noData")}</div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-4 font-semibold">{t("overview.monthly")}</h2>
          <div className="space-y-2">
            {stats.monthly.map((m) => (
              <div key={m.month} className="flex items-center gap-3 text-sm">
                <span dir="ltr" className="w-16 shrink-0 text-slate-500">{m.month}</span>
                <div className="h-4 flex-1 rounded bg-slate-100">
                  <div className="flex h-4 overflow-hidden rounded" style={{ width: `${(m.total / maxMonthly) * 100}%` }}>
                    <div className="bg-emerald-400" style={{ width: `${((m.total - m.refused) / m.total) * 100}%` }} />
                    <div className="bg-red-400" style={{ width: `${(m.refused / m.total) * 100}%` }} />
                  </div>
                </div>
                <span className="w-12 shrink-0 text-end font-medium">{pct(m.refused / m.total)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <h2 className="mb-4 font-semibold">{t("overview.byCarrier")}</h2>
          <table className="w-full text-sm">
            <tbody>
              {stats.by_carrier.map((c) => (
                <tr key={c.carrier} className="border-t border-slate-100">
                  <td className="py-2">{c.carrier === "other" ? t("overview.carrierOther") : c.carrier === "own_fleet" ? t("overview.carrierOwnFleet") : carrierLabel(c.carrier)}</td>
                  <td className="py-2 text-end text-slate-500">{format.number(c.total)}</td>
                  <td className="py-2 text-end font-medium">{pct(c.refused / c.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>

      {canEdit && (
        <form
          className="card flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            await api("/app/merchant", { method: "PATCH", body: { failed_order_cost_mad: Number(cost) } });
            await load();
          }}
        >
          <div>
            <label className="label" htmlFor="cost">{t("overview.costPerFailed")}</label>
            <input id="cost" type="number" min={0} step="1" className="input w-32" value={cost} onChange={(e) => setCost(e.target.value)} />
          </div>
          <button className="btn-secondary">{t("common.save")}</button>
        </form>
      )}
    </div>
  );
}

function Kpi({ label, value, help }: { label: string; value: string; help?: string }) {
  return (
    <div className="card">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
      {help && <div className="mt-1 text-xs text-slate-400">{help}</div>}
    </div>
  );
}
