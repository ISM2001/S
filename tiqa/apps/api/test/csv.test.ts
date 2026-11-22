import { describe, expect, it } from "vitest";
import { mapCsvRows, parseCsv, parseFlexibleDate, suggestMapping } from "../src/services/csv";
import { setupTestApp, signup } from "./helpers";

const ctx = setupTestApp();

const CARRIER_EXPORT = [
  "N° Commande;Téléphone;Ville;Statut;Date de livraison;Transporteur",
  "CMD-001;06 00 00 01 01;Casablanca;Livré;03/11/2026;Amana",
  "CMD-002;+212600000102;Rabat;Refusé;04/11/2026;Amana",
  "CMD-003;0600000103;Fès;Retour;05/11/2026 14:30;Sendit",
  "CMD-004;12345;Tanger;Livré;05/11/2026;Amana",
  "CMD-005;0600000105;Agadir;Annulé;05/11/2026;Amana",
  "CMD-006;0600000106;Agadir;???;05/11/2026;Amana",
  "CMD-007;0600000107;Oujda;Injoignable;31/02/2026;Amana",
].join("\n");

describe("CSV parsing (unit)", () => {
  it("detects ';' delimiter, BOM and suggests a mapping from French headers", () => {
    const { headers, records } = parseCsv("﻿" + CARRIER_EXPORT);
    expect(headers[0]).toBe("N° Commande");
    expect(records).toHaveLength(7);
    expect(suggestMapping(headers)).toEqual({
      phone: "Téléphone",
      status: "Statut",
      date: "Date de livraison",
      city: "Ville",
      carrier: "Transporteur",
      order_ref: "N° Commande",
    });
  });

  it("maps rows and reports errors by row number (never the phone)", () => {
    const { headers, records } = parseCsv(CARRIER_EXPORT);
    const m = mapCsvRows(records, suggestMapping(headers) as never, null, new Date("2026-11-22T00:00:00Z"));
    expect(m.rows).toHaveLength(3);
    expect(m.skipped).toBe(1); // Annulé
    expect(m.errors).toEqual([
      { row: 5, code: "INVALID_PHONE" },
      { row: 7, code: "UNKNOWN_STATUS" },
      { row: 8, code: "INVALID_DATE" },
    ]);
    expect(m.rows[0]).toMatchObject({ e164: "+212600000101", outcome: "delivered", carrier: "amana", cityCode: "casablanca", orderRef: "CMD-001" });
    expect(m.rows[2]!.occurredAt.toISOString()).toBe("2026-11-05T14:30:00.000Z");
  });

  it("parses common date formats", () => {
    const now = new Date("2026-11-22T00:00:00Z");
    expect(parseFlexibleDate("2026-11-03", now)?.toISOString()).toBe("2026-11-03T12:00:00.000Z");
    expect(parseFlexibleDate("2026-11-03 08:15", now)?.toISOString()).toBe("2026-11-03T08:15:00.000Z");
    expect(parseFlexibleDate("3/11/2026", now)?.toISOString()).toBe("2026-11-03T12:00:00.000Z");
    expect(parseFlexibleDate("03-11-26", now)?.toISOString()).toBe("2026-11-03T12:00:00.000Z");
    expect(parseFlexibleDate("46000", now)).not.toBeNull(); // Excel serial
    expect(parseFlexibleDate("2030-01-01", now)).toBeNull(); // future
    expect(parseFlexibleDate("31/02/2026", now)).toBeNull();
    expect(parseFlexibleDate("hello", now)).toBeNull();
  });

  it("handles comma-separated files with quoted fields", () => {
    const { records } = parseCsv('phone,status\n"0600000201","Livré"\n"0600000202","Refusé, client absent"');
    expect(records).toHaveLength(2);
    expect(records[1]!.status).toBe("Refusé, client absent");
  });
});

describe("CSV upload (integration)", () => {
  it("preview returns headers, suggested mapping and sample", async () => {
    const { cookie } = await signup(ctx);
    const r = await ctx.app.inject({ method: "POST", url: "/app/outcomes/csv/preview", headers: { cookie }, payload: { csv: CARRIER_EXPORT } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ total_rows: 7, suggested_mapping: { phone: "Téléphone" } });
    expect(r.json().sample).toHaveLength(5);
  });

  it("imports a carrier export, is idempotent on re-upload, and stores no raw phone", async () => {
    const { cookie } = await signup(ctx);
    const payload = {
      csv: CARRIER_EXPORT,
      mapping: { phone: "Téléphone", status: "Statut", date: "Date de livraison", order_ref: "N° Commande", city: "Ville", carrier: "Transporteur" },
      source_type: "carrier_export",
    };
    const r1 = await ctx.app.inject({ method: "POST", url: "/app/outcomes/csv", headers: { cookie }, payload });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ rows_total: 7, inserted: 3, updated: 0, skipped: 1, failed: 3 });

    const r2 = await ctx.app.inject({ method: "POST", url: "/app/outcomes/csv", headers: { cookie }, payload });
    expect(r2.json()).toMatchObject({ inserted: 0, updated: 3 });
    expect(await ctx.prisma.outcome.count()).toBe(3);
    expect((await ctx.prisma.outcome.findFirstOrThrow({ where: { merchantOrderRef: "CMD-002" } })).source).toBe("carrier_export");

    const imports = (await ctx.app.inject({ method: "GET", url: "/app/imports", headers: { cookie } })).json();
    expect(imports).toHaveLength(2);
  });

  it("rejects a mapping that references a missing column", async () => {
    const { cookie } = await signup(ctx);
    const r = await ctx.app.inject({
      method: "POST", url: "/app/outcomes/csv", headers: { cookie },
      payload: { csv: CARRIER_EXPORT, mapping: { phone: "Phone", status: "Statut" } },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("CSV_MAPPING_UNKNOWN_COLUMN");
  });
});
