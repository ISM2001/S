# Operations runbook

> Hosting is **not chosen yet** (it affects the CNDP cross-border question, see `legal/`). This runbook is host-agnostic.

## Go-live checklist (blocking items marked 🔴)

- 🔴 Lawyer review of `/legal`, CNDP filing accepted, consumer notice live on merchants' stores
- 🔴 Hosting chosen (Morocco vs. abroad + CNDP transfer authorization)
- 🔴 SMS provider configured (consumer portal OTP), email provider configured (magic links, invites)
- 🔴 Real secrets generated and stored in a secret manager: `PHONE_HASH_PEPPER`, `SESSION_SECRET`, `INTEGRATION_ENC_KEY` (the API refuses to start in production with the example values)
- 🔴 Company identity on invoices: `BILLING_SELLER_*`, accountant confirms VAT and invoice mentions
- 🔴 Every staff account has 2FA (enforced by the app: `STAFF_MFA_REQUIRED=true`)
- TLS everywhere (reverse proxy), `NODE_ENV=production`, `WEB_URL` / `API_PUBLIC_URL` set to the public HTTPS URLs
- Backups configured **and a restore tested**
- `pnpm audit --prod` clean (CI runs it)

## Deploy

`docker-compose.prod.example.yml` shows the topology: `postgres`, `redis`, a one-off `migrate` job, `api` (scalable), **one** `worker`, `web`. Images: `apps/api/Dockerfile` (API + worker + migrations), `apps/web/Dockerfile` (`API_URL` build arg = internal API URL).

Order on each release: build images → run `migrate` (`prisma migrate deploy`, non-destructive) → restart `api`, `worker`, `web`.
**Never** run `prisma migrate reset` or `migrate dev` against production.

## Secrets & keys

| Secret | Purpose | If leaked | Rotation |
|---|---|---|---|
| `PHONE_HASH_PEPPER` | HMAC key that pseudonymizes phone numbers | Hashes become reversible (only ~2×10⁸ Moroccan numbers). **Treat as a data breach** | See "Pepper rotation" |
| `INTEGRATION_ENC_KEY` | AES-256-GCM for Shopify/YouCan tokens, webhook secrets, staff TOTP secrets | Platform tokens exposed | No automatic re-encryption yet: revoke platform tokens (merchants reconnect), regenerate webhook secrets, staff re-enrol 2FA |
| `SESSION_SECRET` | Signs the OAuth state cookie | OAuth CSRF possible | Change it. In-flight installs must restart |
| DB password | | | Standard |
| `SHOPIFY_API_SECRET`, `YOUCAN_CLIENT_SECRET` | Verify platform webhooks/OAuth | Forged webhooks | Rotate in the partner dashboards |

Keep secrets in the host's secret manager / KMS, never in images, git or backups.

### Pepper rotation (no downtime, no raw numbers needed)
1. Generate a new pepper: `openssl rand -hex 32`.
2. Set `PHONE_HASH_PEPPERS_OLD="1:<old pepper>"`, `PHONE_HASH_PEPPER=<new>`, `PHONE_HASH_KEY_VERSION=2`, then restart api and worker.
3. Every time a phone number is seen again (lookup, outcome, consumer portal), its records are re-keyed to version 2.
4. After `RETENTION_MONTHS` (12), every version-1 record has been re-keyed or deleted. Check with
   `SELECT count(*) FROM "Outcome" WHERE "hashKeyVersion" < 2;` → 0, then remove `PHONE_HASH_PEPPERS_OLD`.

## Backups

- **Postgres** holds everything that matters. Redis is a cache plus rate-limit counters and needs no backup.
- Daily logical backup, encrypted, stored off-host, kept 30 days:
  ```bash
  pg_dump --format=custom "$DATABASE_URL" | gpg --encrypt --recipient <YOUR_OPS_GPG_KEY_ID> > tiqa-$(date +%F).dump.gpg
  ```
- Point-in-time recovery (WAL archiving) if the host offers managed Postgres.
- **Restore drill every quarter** into a scratch database: `pg_restore --clean --dbname "$SCRATCH_URL" tiqa-YYYY-MM-DD.dump`.
- Backups contain pseudonymized personal data, so they are subject to the same retention rules. ⚖️ A restore must not resurrect records deleted on a consumer's request: after any restore, replay deletions from the audit log (`admin_resolve_request` entries with decision `upheld`).
- **Invoices** must be kept for 10 years (Moroccan accounting rules, to confirm with the accountant). The `Invoice` table blocks merchant deletion (`onDelete: Restrict`).

## Monitoring

- `GET /health` (DB + Redis). Alert if it fails for more than 2 minutes.
- Logs are JSON (pino) with phone numbers, passwords, CSV content, cookies and auth headers redacted. Ship them to the host's log service. Alert on 5xx rate > 1%.
- Worker logs one line per job (`retention`, `trust`, `billing`, `webhook retries`), and each run is also written to `AuditLog` (`*_run`). Alert if `retention_run` hasn't happened in 26 h.
- Performance: `pnpm --filter @tiqa/api bench` (p95 43 ms at 1M outcomes on the dev container).

## Incident response (personal data)

1. Contain: rotate the affected secret (table above), revoke sessions (`DELETE FROM "Session"`), suspend merchant API keys if relevant.
2. Assess from `AuditLog`: what was accessed (lookups are logged with the hashed id, actor and time).
3. ⚖️ Notify: the CNDP and affected merchants. Law 09-08 notification duties and deadlines must be confirmed by the lawyer. Prepare the notice in French and Arabic.
4. Post-mortem within 5 days.

## Billing operations

- The worker issues last month's invoices daily (idempotent, so it actually happens on the 1st). Staff can trigger it manually: Admin → Factures → "Générer les factures du mois précédent".
- Payment by bank transfer: when the money arrives, Admin → Factures → "Marquer payée" with the transfer reference.
- Mistake on an issued invoice: **never edit or delete it**. "Annuler (avoir)" creates a credit note in the `AV-YYYY-NNNNN` series. Then fix the plan or usage and re-issue manually if needed.
- Free plan: lookups stop at the monthly quota (HTTP 402 `QUOTA_EXCEEDED`). Paid plans continue and are billed as overage.
