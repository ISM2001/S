# Tiqa

**Shared delivery-risk network for cash-on-delivery e-commerce in Morocco.**
Sellers send an order's phone number and get back a risk band in milliseconds, based on delivery outcomes from every seller in the network ("give data to get data").

> Status: **Phase 4 done** (billing in MAD, staff 2FA, key rotation, deploy images, runbook). Earlier phases: API, scoring, CSV import (remembered mappings), dashboard (FR + AR/RTL), consumer rights portal, admin panel, trust weights & anomaly flags, team invites, integrations (generic webhook in/out, Shopify app stub, YouCan app).
> ⚖️ No real customer data before the CNDP filing, lawyer review of [`/legal`](legal/README.md) and the consumer rights portal (Phase 2).

- Design, data model, scoring formula, decisions: [`docs/DESIGN.md`](docs/DESIGN.md)
- API reference: [`docs/API.md`](docs/API.md)
- Integrations (Shopify, YouCan, carriers): research findings & status: [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md)
- Operations runbook (deploy, secrets, pepper rotation, backups, incidents, go-live checklist): [`docs/OPERATIONS.md`](docs/OPERATIONS.md)
- Payment options in Morocco (research, decision pending): [`docs/PAYMENTS.md`](docs/PAYMENTS.md)

---

## Run it locally

Requirements: **Node 22+**, **pnpm 10** (`corepack enable`), **Docker**.

```bash
cp .env.example .env            # dev defaults; never commit .env
docker compose up -d            # Postgres 16, Redis 7, Mailpit (test inbox)
pnpm install
pnpm db:deploy                  # create tables
pnpm db:seed                    # fake demo data (fake numbers only)
pnpm dev                        # API + worker on :4000, dashboard on :3000
```

Then open **http://localhost:3000** and sign in with **`demo@tiqa.test` / `demo-password-123`**
(or use "Recevoir un lien de connexion": the email arrives in Mailpit at **http://localhost:8025**).

| Who | Where | Login |
|---|---|---|
| Merchant (Demo Store, owner) | http://localhost:3000/dashboard | `demo@tiqa.test` / `demo-password-123` |
| Tiqa staff (admin panel) | http://localhost:3000/admin | `admin@tiqa.test` / `admin-password-123`, then set up **2FA** with any authenticator app (mandatory) |
| Consumer (rights portal) | http://localhost:3000/consumer | any fake number below; the SMS code is **printed in the API console** (`[sms:console]`) |

Try these fake numbers in **Vérifier un numéro**:

| Number | Expected |
|---|---|
| `06 00 00 00 01` | **Risque élevé**: refusals at 3 other stores |
| `06 00 00 00 02` | **Risque faible**: delivered at 4 stores |
| `06 00 00 00 03` | **Données insuffisantes**: never seen |
| `06 00 00 00 04` | **Données insuffisantes**: the person disputed everything, so the records are frozen (see the open request in the admin panel) |

The seed also contains **Promo Flash**, a merchant whose carrier exports contradict its own refusals. The worker gives it trust 0.10 and a "CONTRADICTION_HIGH" alert in **/admin**.

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
| Audit log | Every lookup → `AuditLog` (merchant, hashed id, time, result). Consumer views/requests and admin actions too |
| Data subject rights | `apps/api/src/routes/consumer.ts` + `services/requests.ts`, tested in `test/consumer.test.ts` |
| Anti-poisoning | `packages/scoring/src/trust.ts` (pure) + `apps/api/src/jobs/trust.ts`, tested in `test/admin.test.ts` |
| Logs | pino redaction of phone/password/CSV/auth headers (`apps/api/src/app.ts`) |

## Background worker

`pnpm dev` runs it inside the API process. In production run it separately (exactly one instance):

```bash
pnpm --filter @tiqa/api worker          # retention daily + trust weights/anomaly flags hourly
pnpm --filter @tiqa/api job:retention   # one-off runs
pnpm --filter @tiqa/api job:trust
```

## Consumer rights & admin (Phase 2)

- **/consumer** (public): phone → 6-digit SMS code (10 min, 5 attempts, 3 SMS/hour per number) → summary of stored records (month, outcome, city, carrier; **never store names**) → dispute selected records or request deletion. Records are **frozen immediately** (excluded from scores, can't be overwritten by merchants).
- **/admin** (staff only): review requests (uphold or reject), merchant trust (manual override, suspend), anomaly alerts (dismiss or mark handled), recompute trust.
- **Team**: owners/admins invite colleagues by email (`/dashboard/team`). Roles: owner, admin, member.
- **SMS**: no paid provider yet. Codes are printed to the console with a masked number. In production the portal answers "SMS unavailable" until a provider is configured.

## Integrations (Phase 3)

**Dashboard → Intégrations**:
- **Generic webhook**: a secret URL for any tool. Orders are scored, delivery statuses are recorded.
- **Outbound webhooks**: signed `score.created` events, with retries handled by the worker.
- **Shopify** and **YouCan**: OAuth install, then each new order is scored automatically. Shopify orders also get a risk tag.

To enable Shopify/YouCan locally, set `SHOPIFY_API_KEY/SECRET` or `YOUCAN_CLIENT_ID/SECRET` in `.env` (from the Shopify Partner Dashboard / YouCan Partners), and make `API_PUBLIC_URL` reachable from the internet (e.g. a tunnel) so the platforms can call back.

## Billing (Phase 4)

- Plans in MAD (placeholder prices in the seed): **Gratuit** (200 lookups/month, blocked beyond), **Starter** 199 MAD HT (2,000 + 0.15 MAD/extra), **Pro** 599 MAD HT (10,000 + 0.08 MAD/extra).
- Dashboard → **Facturation**: usage, plan change (owner), billing profile (legal name + ICE), invoices (printable / PDF via the browser).
- The worker issues last month's invoices (gapless `FAC-YYYY-NNNNN`, VAT 20%). Staff mark them paid (bank transfer) or cancel with a credit note.

## Deploy

See `docs/OPERATIONS.md`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `docker-compose.prod.example.yml`.

## Roadmap

- ~~Phase 2~~ done.
- **Before any real data**: see the go-live checklist in docs/OPERATIONS.md.
- ~~Phase 3~~ done (see docs/INTEGRATIONS.md for what still needs Shopify/YouCan accounts and reviews).
- ~~Phase 4~~ done. Open decisions: payment gateway (docs/PAYMENTS.md), SMS provider, hosting.
