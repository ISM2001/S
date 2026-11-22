# Tiqa

**Shared delivery-risk network for cash-on-delivery e-commerce in Morocco.**
Sellers send an order's phone number and get back a risk band in milliseconds, based on delivery outcomes from every seller in the network ("give data to get data").

> Status: **Phase 1 (MVP core)**: API, scoring, CSV import, basic dashboard (FR + AR/RTL).
> ⚖️ No real customer data before the CNDP filing, lawyer review of [`/legal`](legal/README.md) and the consumer rights portal (Phase 2).

- Design, data model, scoring formula, decisions: [`docs/DESIGN.md`](docs/DESIGN.md)
- API reference: [`docs/API.md`](docs/API.md)
- Integrations research status: [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md)

---

## Run it locally

Requirements: **Node 22+**, **pnpm 10** (`corepack enable`), **Docker**.

```bash
cp .env.example .env            # dev defaults; never commit .env
docker compose up -d            # Postgres 16, Redis 7, Mailpit (test inbox)
pnpm install
pnpm db:deploy                  # create tables
pnpm db:seed                    # fake demo data (fake numbers only)
pnpm dev                        # API on :4000, dashboard on :3000
```

Then open **http://localhost:3000** and sign in with **`demo@tiqa.test` / `demo-password-123`**
(or use "Recevoir un lien de connexion": the email arrives in Mailpit at **http://localhost:8025**).

Try these fake numbers in **Vérifier un numéro**:

| Number | Expected |
|---|---|
| `06 00 00 00 01` | **Risque élevé**: refusals at 3 other stores |
| `06 00 00 00 02` | **Risque faible**: delivered at 4 stores |
| `06 00 00 00 03` | **Données insuffisantes**: never seen |

For CSV import, any spreadsheet with a phone column and a status column works (`Livré`, `Refusé`, `Retour`, `Injoignable`… in French, Arabic or Darija; `;` or `,` separators; Excel's Windows-1252 encoding is handled).

### Call the API

```bash
KEY=tq_test_000000000000_demo_secret_do_not_use_in_production   # dev-only key created by the seed

curl -s localhost:4000/v1/score -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"phone":"0600000001","order_ref":"CMD-1"}'

curl -s localhost:4000/v1/outcomes -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"phone":"0600000001","outcome":"refused","order_ref":"CMD-1","carrier":"Amana"}'
```

## Tests

```bash
pnpm test        # scoring + core unit tests, API integration tests (needs `docker compose up -d`)
pnpm typecheck
```

API tests run against a separate `tiqa_test` database (created automatically by `docker/postgres-init.sql`) and Redis DB 15.
They include an end-to-end privacy test that sends a phone number through every entry point, then dumps the whole database and checks the number appears nowhere.

> If your Postgres volume existed before `docker/postgres-init.sql` was added, create the test DB once:
> `docker compose exec postgres createdb -U tiqa tiqa_test`

### Performance check

```bash
pnpm --filter @tiqa/db seed:load      # 1,000,000 fake outcomes (≈ 40 s)
pnpm --filter @tiqa/api bench         # 3,000 lookups over HTTP, 20 concurrent
```
Measured on the dev container: **p50 29 ms, p95 43 ms, p99 59 ms** with 1M outcomes, mostly cold cache (target: < 300 ms).

## Project layout

```
apps/api         Fastify: /v1 (API keys), /app (dashboard, session cookie), worker (retention)
apps/web         Next.js App Router + Tailwind + next-intl (fr, ar RTL). Talks to the API via the /api proxy
packages/scoring Pure scoring function v1 (Bayesian smoothing, decay, anti-poisoning). No I/O, fully tested
packages/core    Phone normalization (E.164), HMAC pseudonymization, API keys, CSV status mapping, Zod schemas
packages/db      Prisma schema + migrations, seed scripts
legal/           Placeholder legal docs: TO BE REVIEWED BY A MOROCCAN LAWYER
```

## Privacy by design: where it lives in the code

| Requirement | Implementation |
|---|---|
| No raw phone numbers | `packages/core/src/identity.ts`: HMAC-SHA256(pepper, E.164). The merchant's own history keeps the last 2 digits only. Verified by `apps/api/test/privacy.test.ts` |
| Pepper kept secret | `PHONE_HASH_PEPPER` env var (secret manager in production). The API refuses to start in production with the dev pepper |
| Minimal data | `packages/db/prisma/schema.prisma`: no names, addresses, products or amounts |
| Retention (12 months) | `apps/api/src/jobs/retention.ts` (daily worker). The scorer also ignores anything older |
| Bands, not a blacklist | API returns band + score + **ranges** of counts. No store identities |
| Single store can't flag anyone | ≥ 2 distinct merchants required. Per-merchant cap (`packages/scoring`) |
| Disputes freeze records | `Outcome.status = frozen` → excluded from scoring and never overwritten |
| Audit log | Every lookup → `AuditLog` (merchant, hashed id, time, result) |
| Logs | pino redaction of phone/password/CSV/auth headers (`apps/api/src/app.ts`) |

## Background worker

```bash
pnpm --filter @tiqa/api worker          # long-running: retention once a day
pnpm --filter @tiqa/api job:retention   # one-off run
```

## Roadmap

- **Phase 2**: consumer rights portal (OTP → summary → dispute/delete), admin panel (disputes, trust weights, anomaly flags), trust-weight job, team invites.
- **Phase 3**: generic webhook, Shopify app stub, YouCan (after API research), carrier CSV templates.
- **Phase 4**: billing (usage in MAD), payments (CMI etc., to evaluate), hardening (KMS, load tests, backups).
