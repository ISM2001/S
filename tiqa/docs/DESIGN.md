# Tiqa: design proposal (v0, for approval)

> Status: **APPROVED 2026-11-22** with the decisions below. Phases 0–3 implemented.
> Legal statements in this document are engineering assumptions, not legal advice. Everything marked ⚖️ needs review by a Moroccan lawyer.

## Decisions (approved 2026-11-22)

| # | Question | Decision |
|---|---|---|
| 1 | Repository | Tiqa gets its **own new repo** (staged in `tiqa/` until it exists). |
| 2 | "returned" vs "refused" | **Same weight** (1.0). unreachable = 0.5. |
| 3 | Exact counts | **Grouped counts** in the API: outcomes `0, 1-2, 3-5, 6-10, 11+`, merchants `0, 1, 2-3, 4-5, 6+`. |
| 4 | City in the score | **No.** Stored coarse (city code only) for the merchant's own stats. |
| 5 | Thresholds | As proposed: N = 3, ≥ 2 merchants, evidence ≥ 1.0, half-life 90 days, prior 25% (k = 4), bands 20% / 40%. |
| 6 | Deletion requests | Freeze immediately, admin review, delete if upheld (Phase 2, pending lawyer). |
| 7 | Paid services | **None for now.** Email = Mailpit locally (console fallback). SMS OTP = console stub. Hosting decided later. |
| 8 | Pricing | Placeholder plans: Free (200 lookups/month), Starter 199 MAD (2,000), Pro 599 MAD (10,000). |
| 9 | Darija | A few friendly Darija phrases in Arabic script inside the Arabic UI. |
| 10 | Seed numbers | Documented fake blocks `0600000000–0600099999` (demo) and `07xxxxxxxx` (load test), dev pepper only, seed refuses production. |

### Simplifications vs. the original proposal (keep it simple)
* **No job queue yet.** The worker is a plain daily timer (retention). BullMQ can come later if jobs multiply.
* **CSV import is synchronous** (≤ 50,000 rows / 10 MB per file). 50k rows import in a few seconds.
* **Scoring config lives in code** (`packages/scoring` `DEFAULT_CONFIG`, versioned `v1.0`, recorded on every lookup). A DB-backed config table can come with the admin panel.
* **Trust weights** exist in the schema and are applied by the scorer. The job that *computes* them ships in Phase 2.
* `packages/core` was added (phone normalization, HMAC, CSV status mapping, Zod schemas).

### Phase 2 implementation notes
* **Contradiction signal.** When a carrier-sourced record (carrier export/API) replaces a merchant-entered one for the *same order ref*, the row is marked `carrierChecked`. If the merchant had said refused/returned/unreachable and the carrier says delivered, it is also marked `contradicted`. ⚠️ Today the carrier file is uploaded by the merchant itself, so a dishonest merchant can simply not upload it. This signal becomes strong only with direct carrier data (Phase 3+). Upheld consumer disputes and anomaly flags carry the weight until then.
* **Anomaly flags implemented:** `REFUSAL_SPIKE` (z-test vs. own 8-week baseline), `UNLOOKED_REFUSALS` (≥ 30 refusals for never-scored phones with ≥ 60% refusal share; a normal backfill doesn't trigger it), `CONTRADICTION_HIGH`, `DISPUTES_UPHELD`. **Dropped:** "bulk identical timestamps", which would fire on every honest CSV without a time column.
* **Trust** = contradiction component × 0.85^(upheld disputes, 12 months) × open-flag factors (low 0.95, medium 0.8, high 0.5), clamped to [0.1, 1]. Only *open* flags penalize. Once a human dismisses one, the same kind is not re-raised for 30 days.
* **Deletion upheld:** outcomes deleted. Merchants' lookup rows are kept but unlinked (hash replaced with random bytes). OTPs and sessions are deleted, and the request keeps no phone hash. **Audit logs keep the hash** until their own retention ends (⚖️ to confirm).
* **Phase 3:** see `docs/INTEGRATIONS.md`. Platform tokens and webhook secrets are AES-256-GCM encrypted (`INTEGRATION_ENC_KEY`). Outbound URLs are SSRF-checked (https + public IPs only in production). Outbound payloads never contain phone numbers.
* **Not done yet (before go-live):** TOTP 2FA for staff accounts, real SMS provider, a merchant switcher for users who belong to several stores (today the first membership is used).

---

## (a) Architecture

### Monorepo layout

```
tiqa/
├─ apps/
│  ├─ api/            Fastify: public API (/v1), dashboard API (/app), consumer portal API (/public), admin API (/admin), plus a worker process for scheduled jobs
│  └─ web/            Next.js App Router + Tailwind + next-intl (fr, ar-RTL): merchant dashboard, consumer rights portal, admin panel
├─ packages/
│  ├─ scoring/        PURE function: (outcomes, merchantTrust, config, now) → result. No I/O. 100% unit tested.
│  ├─ db/             Prisma schema, migrations, client, seed (fake numbers only)
│  └─ core/           (proposed addition) phone normalization (E.164), HMAC identity, Zod schemas shared by api and web, error codes, i18n reason keys
├─ legal/             TODO docs, all marked "TO BE REVIEWED BY A MOROCCAN LAWYER"
├─ docker-compose.yml postgres:16, redis:7, mailpit (local email inbox for magic links), api, web
└─ README.md
```

Why add `packages/core`: phone normalization and hashing must be **byte-identical** everywhere (API, CSV import, consumer portal, seed). Having one implementation means one set of tests.

### Request path: `POST /v1/score` (budget: 300 ms p95, target under 50 ms)

```
Merchant ─► Fastify
   1. Auth: API key "tq_live_<prefix>_<secret>" → look up by prefix → constant-time compare of SHA-256(secret)   [key cached in Redis 60 s]
   2. Rate limit: Redis sliding window, limit = plan limit × contribution tier
   3. Zod validate → normalize phone to E.164 (+2126…/+2127…/+2125…) → reject if not a Moroccan number
   4. phoneHash = HMAC-SHA256(pepper[v], e164)              (raw phone dropped from memory here; never logged)
   5. Redis GET agg:{phoneHash} → on miss: SELECT outcomes WHERE phone_hash=$1 AND status='active' AND occurred_at > now()-retention
                                           (index on (phone_hash, occurred_at); usually fewer than 50 rows)
   6. scoring.score(outcomes, trustByMerchant, config, now)   ← pure, about 0.1 ms
   7. INSERT audit_log + INSERT lookup (merchant's private order history) + INCR usage counter
   8. Respond { band, score, outcomes_count, merchants_count, reasons[], score_version }
```

* The cache holds the *outcome rows* (not the score), so a change to trust weights or config applies immediately. The key is deleted whenever a new outcome or dispute touches that hash. TTL is 10 minutes.
* Logger redaction: Fastify/pino redacts `phone`, `body.phone`, `body.rows[*].phone` at the logger level, not by convention.

### Background jobs (worker process, same codebase, BullMQ on Redis, which is free and self-hosted)

| Job | Schedule | What it does |
|---|---|---|
| `retention` | daily | Hard-deletes outcomes older than `RETENTION_MONTHS` (default 12). Also deletes expired OTPs, magic links and sessions. Audit log has its own retention setting (see open questions). |
| `trust-recompute` | hourly | Recomputes each merchant's trust weight and anomaly flags (see the scoring section). |
| `csv-import` | on upload | Parses, validates, normalizes and hashes rows, upserts outcomes, and writes a downloadable error report. |
| `usage-rollup` | daily | Monthly usage per merchant for billing. |

### Auth

* **Dashboard:** email + password (argon2id) **or** magic link (single-use token, only its SHA-256 stored, 15 min expiry). Server-side session in Postgres plus an httpOnly SameSite=Lax cookie. Roles: `owner`, `admin`, `member`.
* **API:** per-merchant API keys, shown once, stored as SHA-256 with a visible prefix so they can be identified. Scopes: `score`, `outcomes:write`. Revocable, `last_used_at` tracked.
* **Admin:** separate `is_staff` flag on users, required TOTP 2FA, every admin action written to the audit log.
* **Consumer portal:** no account. Phone + OTP issues a short-lived (15 min) token scoped to one phoneHash.

### Identity hashing details

* Moroccan mobile numbers have only about 2×10⁸ possible values, so a **plain** SHA-256 can be reversed in minutes. The secret pepper (HMAC key) is the only thing that protects identifiers. It lives in env for dev and in a KMS/secret manager in production, never in the database or the repo.
* `hash_key_version` is stored on each row. Raw numbers are never kept, so rotating the key means accepting the new key for new data and scoring against both versions until old rows expire through retention (at most 12 months). This is documented in the runbook.
* Pseudonymized data is **still personal data** under Law 09-08 ⚖️. Hashing reduces risk but does not take Tiqa out of the law's scope.

---

## Data model (Prisma, abridged)

Money is stored as integer **centimes MAD**. All ids are UUIDv7/cuid. `phone_hash` is `bytea(32)`.

```prisma
// ── Tenancy & auth ────────────────────────────────────────────
model Merchant {
  id               String   @id
  name             String
  status           MerchantStatus   // pending | active | suspended
  trustWeight      Float    @default(1.0)   // computed, 0.1..1.0
  trustOverride    Float?                   // admin override, wins if set
  failedOrderCostCentimes Int @default(4000) // for the "money saved" estimate (default value to be validated)
  termsAcceptedAt  DateTime?                 // merchant DPA + duty to inform customers
  createdAt        DateTime @default(now())
}
model User        { id, email @unique, passwordHash?, locale (fr|ar), emailVerifiedAt?, isStaff, totpSecretEnc? }
model Membership  { userId, merchantId, role (owner|admin|member)  @@id([userId, merchantId]) }
model Invite      { id, merchantId, email, role, tokenHash, expiresAt, acceptedAt? }
model Session     { id, userId, expiresAt, ip?, userAgent? }
model MagicLink   { id, userId, tokenHash @unique, expiresAt, usedAt? }
model ApiKey      { id, merchantId, name, prefix @unique, keyHash, scopes[], lastUsedAt?, revokedAt?, createdBy }

// ── Shared network (the only cross-merchant data) ──────────────
model Outcome {
  id             String
  phoneHash      Bytes
  hashKeyVersion Int
  merchantId     String          // NEVER exposed to other merchants
  outcome        OutcomeType     // delivered | refused | unreachable | returned
  source         OutcomeSource   // carrier_api | carrier_export | merchant_manual (csv/api/dashboard)
  carrier        String?         // normalized enum-like code: amana, cathedis, sendit, ozon, ...
  cityCode       String?         // coarse: city level only, from a fixed reference list
  occurredAt     DateTime
  merchantOrderRef String?       // merchant's own ref, used for dedupe and to link to their lookups
  status         RecordStatus    // active | frozen (disputed) | removed
  createdAt      DateTime
  @@unique([merchantId, merchantOrderRef, outcome])
  @@index([phoneHash, occurredAt])
}

// ── Merchant-private ───────────────────────────────────────────
model Lookup {            // powers "order history with bands"
  id, merchantId, phoneHash, phoneLast2 String  // shown as "06 •• •• •• 12"; no raw number stored anywhere
  merchantOrderRef?, band, score?, outcomesCount, merchantsCount, scoreVersion, createdAt
  decision?               // merchant-private: shipped | cancelled | prepaid_required (feeds the "money saved" estimate; never shared)
}

// ── Compliance ─────────────────────────────────────────────────
model AuditLog   { id, at, actorType (api_key|user|staff|consumer|system), actorId, merchantId?, action, phoneHash?, result Json, ip? }
                 // actions: score_lookup, outcome_submit, csv_import, consumer_view, consumer_dispute, consumer_delete, admin_*
model OtpChallenge { id, phoneHash, codeHash, attempts, expiresAt, ipHash }
model DataSubjectRequest {
  id, phoneHash, type (access|dispute|deletion), status (open|in_review|upheld|rejected|completed),
  consumerMessage String?   // free text, length-limited; no sensitive data requested
  outcomeIds String[]       // records frozen by this request
  resolvedBy?, resolvedAt?, resolutionNote?
}

// ── Trust & anomalies ──────────────────────────────────────────
model AnomalyFlag { id, merchantId, kind, severity, details Json, status (open|dismissed|actioned), createdAt, reviewedBy? }
model ScoringConfig { version Int @id, params Json, activeFrom DateTime, createdBy }  // every result records score_version

// ── Billing (payments stubbed) ─────────────────────────────────
model Plan          { id, code, nameFr, nameAr, monthlyFeeCentimes, includedLookups, overageCentimesPerLookup, rateLimitPerMin }
model Subscription  { merchantId, planId, status, currentPeriodStart, currentPeriodEnd }
model UsageMonthly  { merchantId, period "2026-11", lookups, outcomesSubmitted, matchedOutcomes  @@id([merchantId, period]) }
model Invoice       { id, merchantId, period, amountCentimes, status (draft|issued|paid|void), paymentProvider?, externalRef? }

// ── Integrations (phase 3) ─────────────────────────────────────
model WebhookEndpoint { id, merchantId, url, secretEnc, events[], active }
```

What is deliberately **not** stored: raw phone numbers, names, full addresses, product details, order amounts, IP addresses in plain text (stored as a hash, if at all).

---

## (b) Scoring v1

### Inputs per outcome *i*

| Symbol | Meaning | Default |
|---|---|---|
| y_i | refusal value: refused = 1, returned = 1, unreachable = 0.5, delivered = 0 | configurable |
| d_i | time decay = 0.5^(age_days / H) | H = 90-day half-life |
| s_i | source weight: carrier_api 1.0, carrier_export 0.8, merchant_manual 0.6 | configurable |
| t_m | trust weight of the reporting merchant, 0.1–1.0 | 1.0 for new merchants |

### Formula

1. Weight each outcome: **w_i = d_i × s_i × t_m**
2. **Per-merchant cap (anti-poisoning):** for each merchant *m*, let W_m = Σ w_i over that merchant's outcomes. If W_m > C × t_m (C = 2.0), scale all of that merchant's weights by (C × t_m) / W_m. One store can contribute at most "about 2 fresh carrier-confirmed orders" worth of evidence, and a distrusted store contributes less.
3. Evidence: **n = Σ w_i**, refusal evidence **r = Σ w_i·y_i** (after capping)
4. **Bayesian smoothing** with prior mean μ = 0.25 (network average) and prior strength k = 4:
   **p = (r + μ·k) / (n + k)**
5. **score = round(100·p)**
6. **Band**
   * `insufficient_data` if raw count < N (default 3) **or** distinct merchants < 2 **or** n < 1.0 (all evidence old or low-trust)
   * otherwise `low` if p < 0.20, `medium` if 0.20 ≤ p < 0.40, `high` if p ≥ 0.40

Frozen (disputed) outcomes are excluded before step 1. The function is pure: `score(outcomes, trust, config, now)`. It returns `{ band, score, p, n, outcomesCount, merchantsCount, reasons[], scoreVersion }`. When the band is `insufficient_data`, `score` is `null` so that no number is shown without enough evidence.

**Reasons** are stable codes that the dashboard translates into fr and ar: `REFUSALS_AT_MULTIPLE_STORES`, `RECENT_REFUSALS`, `MOSTLY_DELIVERED`, `CARRIER_CONFIRMED_HISTORY`, `UNREACHABLE_HISTORY`, `HISTORY_MOSTLY_OLD`, `LIMITED_HISTORY`. They never name a store, a date or a single report.

### Worked examples (numbers produced by a reference implementation)

**A. Serial refuser: 6 outcomes, 4 stores, all within 60 days**

| Store | Outcomes (age, source) | weight |
|---|---|---|
| m1 | refused 3d manual, refused 20d manual | 0.586 + 0.515 = 1.101 |
| m2 | refused 10d carrier_export | 0.741 |
| m3 | refused 35d manual | 0.458 |
| m4 | refused 50d carrier_api, unreachable 60d manual | 0.680 + 0.378 = 1.058 |

n = 3.358, r = 3.169 → p = (3.169 + 1) / (3.358 + 4) = **0.567 → score 57, band HIGH**
Reasons: `REFUSALS_AT_MULTIPLE_STORES`, `RECENT_REFUSALS`, `CARRIER_CONFIRMED_HISTORY`.

**B. Good customer: 8 outcomes, 3 stores, 7 delivered, 1 refused 4 months ago**
n = 3.708, r = 0.238 → p = (0.238 + 1) / (3.708 + 4) = **0.161 → score 16, band LOW**

**C. Poisoning attempt: store X reports 20 "refused" in 20 days; stores Y and Z have 3 carrier-backed deliveries**
* X raw weight 11.08 is capped to 2.0 (scale 0.181). Y = 1.720, Z = 0.686.
* n = 4.405, r = 2.000 → p = **0.357 → score 36, MEDIUM** (without the cap: p = 0.691, HIGH)
* Once the trust job drops X to t = 0.3 (carrier data contradicts X's refusals), X's cap becomes 0.6 → n = 3.005, r = 0.600 → p = **0.228 → score 23, MEDIUM, close to LOW**
* If X were the **only** reporter: merchants = 1 → **INSUFFICIENT_DATA**. A single store can never mark anyone on its own.

**D. Old history: 4 refusals from 2 stores, 9–11 months ago**
n = 0.231 (heavy decay) → under the n ≥ 1.0 threshold → **INSUFFICIENT_DATA** with reason `HISTORY_MOSTLY_OLD`. People can change, and this gives them a soft reset well before the 12-month deletion.

### Merchant trust weight (computed by the hourly job)

```
contradiction_rate_m = (c + 1) / (k_m + 10)      // Beta(1,9) prior ≈ 10% baseline
   c   = merchant-entered "refused/unreachable" later contradicted by a carrier-sourced "delivered" for the same order ref or phone hash ±7 days
   k_m = merchant-entered outcomes that have any carrier-sourced counterpart
t_m = clamp(1 − 2 × max(0, contradiction_rate_m − 0.10), 0.1, 1.0)   × anomaly penalty
```

Anomaly flags (each one lowers trust by a configurable multiplier until an admin reviews it):
* `REFUSAL_SPIKE`: the merchant's refusal share this week is more than 3σ above their own 8-week baseline.
* `UNLOOKED_OUTCOMES`: more than 50% of submitted outcomes are for phone hashes the merchant never scored (possible dumping or list uploading).
* `BULK_SAME_TIMESTAMP`: large batches of refusals with identical timestamps.
* `CONTRADICTION_HIGH`: contradiction rate above 30% with k_m ≥ 20.

Admins can set `trustOverride`. Every change is audited.

---

## Contribution rule ("give data to get data")

* `ratio = matched_outcomes_90d / lookups_90d`, counting only outcomes for phone hashes the merchant actually scored, after a 14-day lag (deliveries take time). This stops a merchant from gaming the ratio by uploading junk "delivered" rows.
* Grace period: the first 30 days or 300 lookups count as fully contributing.
* Tiers (configurable): ratio ≥ 0.5 → full plan rate limit; 0.2–0.5 → 50%; below 0.2 → 10 lookups/min, with a dashboard banner in fr and ar explaining how to unlock full access.

## Money saved estimate (dashboard)

`saved ≈ Σ over lookups with decision ∈ {cancelled, prepaid_required} of p × failedOrderCost`
`failedOrderCost` is set per merchant (outbound + return shipping + packaging + confirmation call). The default value of 40 MAD is a placeholder that we must validate with sellers. The dashboard labels the figure "estimate" and shows the formula.

---

## (c) Phased plan

**Phase 0: scaffolding (short)**
pnpm workspaces, TS strict, ESLint/Prettier, Vitest, Docker Compose (Postgres, Redis, Mailpit), GitHub Actions CI (lint + test), `.env.example`.

**Phase 1: API + scoring + CSV + basic dashboard** ← first milestone
1. `packages/scoring`: pure function + full tests (the examples above become test fixtures, plus property tests: monotonicity, the cap holds, single-merchant ⇒ insufficient).
2. `packages/core`: E.164 normalization (all Moroccan formats: `06…`, `+2126…`, `002126…`, `2126…`, spaces/dashes) + HMAC + Zod schemas.
3. `packages/db`: schema above (billing/webhook tables included but unused), migrations, seed with fake numbers only (see open questions).
4. `apps/api`: API key auth, `POST /v1/score`, `POST /v1/outcomes` (single) and `POST /v1/outcomes/batch` (≤ 1000, idempotent on `merchantOrderRef`), audit log, Redis cache, rate limits + contribution tiers, retention job, OpenAPI docs at `/docs`.
5. `apps/web`: signup/login (password + magic link via Mailpit locally), lookup tool, CSV upload (column mapping, preview, per-row error report; templates for "generic" and 1–2 carrier export formats we can obtain samples of), order history with bands, own refusal-rate stats, API key create/revoke. fr + ar RTL from day one.
6. `/legal` placeholder docs. README with local run instructions.
→ **Exit criteria:** p95 under 300 ms locally with 1M seeded outcomes, all tests green, no raw phone in DB or logs (an automated test greps the DB and log output for seeded numbers).

**Phase 2: compliance and trust (must ship before any real data)**
Consumer rights portal (OTP → summary → dispute/delete; dispute freezes records), admin panel (disputes, trust weights, anomaly flags), trust-recompute job, team invites/roles, money-saved widget, Darija-friendly copy pass.

**Phase 3: integrations**
Generic webhook (inbound "order created" → score → callback, outbound HMAC-signed events) → Shopify app stub (OAuth + `orders/create` webhook + order tag/note with band) → YouCan (**researched first; I will report back what their public API supports before writing any code**) → per-carrier CSV templates, plus a report on which Moroccan carriers offer public APIs (verified from their docs, not assumed).

**Phase 4: billing and hardening**
Usage metering → invoices (stub provider) → payment provider research (see below), KMS for the pepper, load test, backups, observability, security review / pen test.

---

## (d) Open questions (decisions I need from you)

1. **Repository.** This repo currently holds an unrelated static site (RAYO, e-scooters, Spain). Should I (a) move it to `/legacy-rayo-site` and build Tiqa at the root, (b) delete it, or (c) should Tiqa go in a new repo? I recommend (c) or (a).
2. **"returned" vs "refused".** In Moroccan COD, "retour" usually *is* the refused parcel coming back. Do you want `returned` to mean "accepted, then returned later" (a weaker signal)? My proposal: refused = 1.0, returned = 1.0, unreachable = 0.5, all configurable.
3. **Own data in the score.** Should a merchant's lookup include their *own* past outcomes? Including them is simpler, but a merchant could subtract their own data from the counts to learn about others. My proposal: include them, but return **bucketed counts** (`1-2`, `3-5`, `6-10`, `10+`) instead of exact `outcomes_count`/`merchants_count`. This conflicts slightly with your API spec, so it's your call.
4. **City.** Should it go into the score at all? Using city risks penalizing whole regions (fairness, plus CNDP proportionality). My proposal: store coarse city for the merchant's own stats only and keep it out of the v1 score.
5. **Thresholds.** Are N = 3, the 90-day half-life, μ = 25% and the band cut-offs 20% / 40% OK as starting values? They are all stored in `ScoringConfig`, so they are easy to change.
6. **Deletion requests.** If anyone can delete their history on request, serial refusers will do exactly that. Options: (a) honor every deletion, (b) treat deletion as an *objection* that a reviewer evaluates (legitimate interest in fraud prevention vs. the person's rights), (c) delete, then return `insufficient_data` for that hash for N months. ⚖️ This needs a lawyer. My engineering proposal: freeze immediately, review within X days, then delete if upheld.
7. **SMS OTP provider** (paid service, so I need your approval). Locally I'll use a console stub. Production candidates: a Moroccan SMS aggregator or an international one such as Twilio or Infobip. WhatsApp OTP is an alternative. Which do you prefer, or should I research costs?
8. **Hosting location** (hard to reverse). Hosting outside Morocco is a cross-border transfer, which likely needs CNDP authorization ⚖️. Options: a Moroccan provider (e.g. local data centers such as N+ONE, Inwi/Maroc Telecom cloud offerings), or EU hosting with a transfer authorization. This affects architecture very little but affects the legal setup a lot.
9. **Email provider** for magic links (Mailpit locally; production options include Resend, Postmark, SES). Paid, so I need your approval.
10. **Seed data.** Moroccan numbers have no officially reserved "fiction" range that I know of. My proposal: generate numbers in a prefix block we document as fake, **plus** a `SEED_ONLY` flag on seeded merchants, and refuse to run the seed when `NODE_ENV=production`. Please confirm, or name a range you know to be unassigned.
11. **Pricing in MAD.** Should I seed placeholder plans (e.g. Free 100 lookups, Starter, Pro) or do you have numbers?
12. **Darija.** Arabic script, Latin script ("3arbizi"), or only a few friendly phrases inside the fr/ar UI?

## Legal and product risks (⚖️ = needs a Moroccan lawyer)

| # | Risk | Mitigation in the design |
|---|---|---|
| 1 ⚖️ | **CNDP prior authorization vs. declaration.** A shared, cross-merchant file used to make decisions about individuals (pooling data from several controllers, i.e. "interconnexion de fichiers") may require **prior authorization** rather than a simple declaration under Law 09-08. The CNDP has historically been strict about shared "listes noires". | No go-live with real data until filing is done. Band output instead of blacklist. Documented purpose limitation. |
| 2 ⚖️ | **Controller roles.** Is Tiqa an independent controller of the network, a joint controller with merchants, or a processor? This drives the DPA, liability, and who answers consumer requests. | Draft both DPA variants in `/legal`. |
| 3 ⚖️ | **Hashed data is still personal data.** | Treated as personal data throughout: retention, audit, access rights. |
| 4 ⚖️ | **Transparency at collection.** Consumers must be informed *before* their data is shared. Merchants are often small and may not comply. | Merchant terms require it. We provide ready-made fr/ar/Darija notice text and checkout snippets, and record `termsAcceptedAt`. Open question: audit merchant compliance? |
| 5 ⚖️ | **Automated decision-making.** A refused order based solely on our score could be challenged. | Position the band as decision *support*. Recommend "ask for prepayment/deposit" or "call to confirm" rather than "refuse". Reasons are explainable. Consumer portal shows a summary. |
| 6 | **Defamation / wrong data.** One disgruntled merchant (or a shared family phone) could harm a consumer. | ≥ 2 merchants required, per-merchant cap, trust weights, disputes freeze records, decay. |
| 7 | **Re-identification by merchants.** Differencing attacks (submit, look up, compare counts). | Bucketed counts (Q3), no per-store details, rate limits, audit logs. Anomaly flag for lookups that are not followed by orders. |
| 8 | **Pepper compromise** would make every hash reversible (small number space). | KMS, no pepper in DB/backups, key versioning, access logging. |
| 9 | **Consumer portal abuse.** OTP SMS cost-pumping, enumeration. | Per-IP and per-number limits, captcha, generic responses. |
| 10 | **Law changes.** Check whether Law 09-08 has been amended or a replacement law adopted, and whether CNDP has sector guidance on credit/fraud-risk scoring. | Lawyer review before Phase 2 ends. |
| 11 | **Fairness.** City or carrier could act as proxies for region or income. | City excluded from the score (Q4). Bands monitored by city in admin analytics. |
| 12 | **Network cold start.** With few merchants, most lookups return `insufficient_data`, so the product has little value. | Business risk, not technical: onboard a cluster of sellers in one niche first. CSV backfill of their historical carrier exports gives instant data (subject to the duty to inform for historical data ⚖️). |

## Integrations and payments: not researched yet

* **YouCan:** I have not verified their public API. I will research their developer docs at the start of Phase 3 and report what is actually available (order webhooks, app store, order notes/tags) before building anything. No endpoints will be assumed.
* **Carriers with public APIs:** candidates to verify include Amana (Barid Al-Maghrib), Cathedis, Sendit, Ozon Express, Speedaf, Digylog, Onessta, Forcelog and others. I'll report which ones publish documented APIs. CSV export import comes first regardless.
* **Payments (Phase 4, stubbed until then):** options to evaluate include CMI (interbank card gateway), Payzone, YouCan Pay, bank transfer with manual reconciliation, and cash networks (Cash Plus, Wafacash). Stripe does not, as far as I know, onboard Morocco-based businesses directly. I will verify all of this before recommending one.
