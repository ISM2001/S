"use client";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useErrorMessage } from "@/lib/use-error";

const FIELDS = ["phone", "status", "date", "order_ref", "city", "carrier"] as const;
type Field = (typeof FIELDS)[number];
type Mapping = Partial<Record<Field, string>>;

interface Preview {
  headers: string[];
  suggested_mapping: Mapping;
  sample: Record<string, string>[];
  total_rows: number;
}
interface Report {
  rows_total: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  errors: Array<{ row: number; code: string }>;
}
interface ImportRow { id: string; createdAt: string; sourceType: string; rowsTotal: number; inserted: number; updated: number; failed: number }

/** Excel exports in Morocco are often Windows-1252 / Latin-1, not UTF-8. */
async function readText(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("windows-1252").decode(buf);
  }
}

export default function UploadPage() {
  const t = useTranslations("upload");
  const format = useFormatter();
  const errMsg = useErrorMessage();
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [sourceType, setSourceType] = useState<"merchant_manual" | "carrier_export">("merchant_manual");
  const [defaultCarrier, setDefaultCarrier] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [imports, setImports] = useState<ImportRow[]>([]);

  const loadImports = () => api<ImportRow[]>("/app/imports").then(setImports).catch(() => undefined);
  useEffect(() => void loadImports(), []);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setReport(null);
    setPreview(null);
    try {
      const text = await readText(file);
      setCsv(text);
      const p = await api<Preview>("/app/outcomes/csv/preview", { body: { csv: text } });
      setPreview(p);
      setMapping(p.suggested_mapping);
    } catch (e) {
      setError(errMsg(e));
    }
  }

  async function doImport() {
    if (!csv || !mapping.phone || !mapping.status) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Report>("/app/outcomes/csv", {
        body: { csv, mapping, source_type: sourceType, default_carrier: defaultCarrier || null },
      });
      setReport(r);
      void loadImports();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        <p className="text-slate-600">{t("intro")}</p>
      </div>

      <div className="card space-y-4">
        <div>
          <label className="label" htmlFor="file">{t("chooseFile")}</label>
          <input id="file" type="file" accept=".csv,text/csv" className="text-sm" onChange={(e) => onFile(e.target.files?.[0])} />
          <p className="mt-1 text-xs text-slate-500">{t("excelHint")} {t("statusHelp")}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <span className="label">{t("sourceType")}</span>
            <select className="input" value={sourceType} onChange={(e) => setSourceType(e.target.value as typeof sourceType)}>
              <option value="merchant_manual">{t("manual")}</option>
              <option value="carrier_export">{t("carrierExport")}</option>
            </select>
          </div>
          <div>
            <label className="label" htmlFor="carrier">{t("defaultCarrier")}</label>
            <input id="carrier" className="input" placeholder="Amana, Cathedis, Sendit…" value={defaultCarrier} onChange={(e) => setDefaultCarrier(e.target.value)} />
          </div>
        </div>
      </div>

      {preview && (
        <div className="card space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">{t("mapping")}</h2>
            <span className="text-sm text-slate-500">{t("rows", { count: preview.total_rows })}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {FIELDS.map((f) => (
              <div key={f}>
                <span className="label">{t(`field_${f}`)}</span>
                <select className="input" value={mapping[f] ?? ""} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || undefined })}>
                  <option value="">{t("none")}</option>
                  {preview.headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto">
            <div className="mb-1 text-sm text-slate-500">{t("preview")}</div>
            <table className="w-full text-xs">
              <thead>
                <tr>{preview.headers.map((h) => <th key={h} className="border-b px-2 py-1 text-start">{h}</th>)}</tr>
              </thead>
              <tbody>
                {preview.sample.map((r, i) => (
                  <tr key={i}>{preview.headers.map((h) => <td key={h} className="border-b border-slate-100 px-2 py-1">{r[h]}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <button className="btn" disabled={busy || !mapping.phone || !mapping.status} onClick={doImport}>
            {busy ? t("importing") : t("import")}
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}

      {report && (
        <div className="card space-y-3">
          <h2 className="font-semibold">{t("result")}</h2>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            {(["inserted", "updated", "skipped", "unchanged", "failed"] as const).map((k) => (
              <div key={k} className="rounded-lg bg-slate-50 p-3">
                <div className="text-slate-500">{t(k)}</div>
                <div className="text-xl font-bold">{format.number(report[k])}</div>
              </div>
            ))}
          </div>
          {report.errors.length > 0 && (
            <ul className="max-h-48 overflow-y-auto text-xs text-red-700">
              {report.errors.map((e) => (
                <li key={e.row}>{t("errorRow", { row: e.row, error: t.has(`errors.${e.code}`) ? t(`errors.${e.code}`) : e.code })}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {imports.length > 0 && (
        <div className="card">
          <h2 className="mb-2 font-semibold">{t("recent")}</h2>
          <table className="w-full text-sm">
            <tbody>
              {imports.map((i) => (
                <tr key={i.id} className="border-t border-slate-100">
                  <td className="py-2 text-slate-500">{format.dateTime(new Date(i.createdAt), { dateStyle: "short", timeStyle: "short" })}</td>
                  <td className="py-2">{i.sourceType === "carrier_export" ? t("carrierExport") : t("manual")}</td>
                  <td className="py-2 text-end">{t("rows", { count: i.rowsTotal })}</td>
                  <td className="py-2 text-end text-emerald-700">+{i.inserted}</td>
                  <td className="py-2 text-end text-red-700">{i.failed ? `${i.failed} ✕` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
