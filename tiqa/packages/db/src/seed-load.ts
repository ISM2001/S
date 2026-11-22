/**
 * Load-test dataset: N outcomes (default 1,000,000) over N/5 fake phones (07 00 xx xx xx block), 50 merchants.
 *   pnpm --filter @tiqa/db seed:load            # 1M
 *   pnpm --filter @tiqa/db seed:load 200000     # smaller
 * Then: pnpm --filter @tiqa/api bench
 */
import { phoneHash } from "@tiqa/core";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { assertNotProduction, loadPhone, mulberry32 } from "./seed-utils";

const pepper = assertNotProduction();
const prisma = new PrismaClient();
const N = Number(process.argv[2] ?? 1_000_000);
const PHONES = Math.max(1000, Math.floor(N / 5));
const rand = mulberry32(7);
const outcomes = ["delivered", "delivered", "delivered", "delivered", "refused", "returned", "unreachable"];
const sources = ["carrier_api", "carrier_export", "merchant_manual"];

async function main() {
  const old = await prisma.merchant.findMany({ where: { isSeed: true, name: { startsWith: "Load " } }, select: { id: true } });
  if (old.length) await prisma.merchant.deleteMany({ where: { id: { in: old.map((m) => m.id) } } });
  const merchants = await Promise.all(
    Array.from({ length: 50 }, (_, i) => prisma.merchant.create({ data: { name: `Load ${i}`, isSeed: true } })),
  );
  const hashes = Array.from({ length: PHONES }, (_, i) => phoneHash(loadPhone(i), pepper).toString("hex"));
  const t0 = Date.now();
  const BATCH = 20_000;
  for (let off = 0; off < N; off += BATCH) {
    const n = Math.min(BATCH, N - off);
    const ids: string[] = [], hs: string[] = [], ms: string[] = [], os: string[] = [], ss: string[] = [], ds: string[] = [], refs: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(randomUUID());
      hs.push(hashes[Math.floor(rand() * PHONES)]!);
      ms.push(merchants[Math.floor(rand() * merchants.length)]!.id);
      os.push(outcomes[Math.floor(rand() * outcomes.length)]!);
      ss.push(sources[Math.floor(rand() * sources.length)]!);
      ds.push(new Date(Date.now() - rand() * 360 * 86_400_000).toISOString());
      refs.push(`L-${off + i}`);
    }
    await prisma.$executeRaw`
      INSERT INTO "Outcome" ("id","phoneHash","merchantId","outcome","source","occurredAt","merchantOrderRef","updatedAt")
      SELECT u.id, decode(u.h,'hex'), u.m, u.o::"OutcomeType", u.s::"OutcomeSource", u.d::timestamp(3), u.r, now()
      FROM unnest(${ids}::text[], ${hs}::text[], ${ms}::text[], ${os}::text[], ${ss}::text[], ${ds}::text[], ${refs}::text[]) AS u(id,h,m,o,s,d,r)`;
    process.stdout.write(`\r  ${off + n}/${N} outcomes`);
  }
  await prisma.$executeRawUnsafe(`ANALYZE "Outcome"`);
  console.log(`\n✅ Loaded ${N} outcomes over ${PHONES} fake phones in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
main().finally(() => prisma.$disconnect());
