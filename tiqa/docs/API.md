# Tiqa API v1

Base URL (local): `http://localhost:4000`. Auth: `Authorization: Bearer tq_live_…` (or `X-API-Key: …`).
Keys are created in the dashboard (**Clés API**). The full key is shown once. Only its hash is stored.

Phone numbers are accepted in any common Moroccan format (`0612345678`, `06 12 34 56 78`, `+212612345678`, `00212…`, Arabic-Indic digits) and are **never stored in clear**.

Errors: `{"error": {"code": "…", "details": …}, "request_id": "…"}`. Codes: `INVALID_API_KEY` (401), `MISSING_SCOPE` / `MERCHANT_SUSPENDED` (403), `VALIDATION_FAILED` (400), `RATE_LIMITED` (429).

---

## POST /v1/score

Request:
```json
{ "phone": "0612345678", "order_ref": "CMD-1001", "city": "Casablanca" }
```
`order_ref` (optional) links the lookup to your order in your dashboard history. `city` is accepted but **not used** by the v1 score.

Response `200`:
```json
{
  "lookup_id": "cm…",
  "band": "high",
  "score": 56,
  "outcomes_count": "3-5",
  "merchants_count": "2-3",
  "reasons": ["REFUSALS_AT_MULTIPLE_STORES", "RECENT_REFUSALS", "CARRIER_CONFIRMED_HISTORY"],
  "score_version": "v1.0"
}
```
* `band`: `low` | `medium` | `high` | `insufficient_data`. When `insufficient_data`, `score` is `null`.
* `score`: 0–100 = smoothed probability of refusal, in %.
* Counts are **ranges**, never exact (so no merchant can work out what other stores reported).
  outcomes: `0`, `1-2`, `3-5`, `6-10`, `11+`. merchants: `0`, `1`, `2-3`, `4-5`, `6+`.
* `reasons`: `LIMITED_HISTORY`, `HISTORY_MOSTLY_OLD`, `REFUSALS_AT_MULTIPLE_STORES`, `RECENT_REFUSALS`, `UNREACHABLE_HISTORY`, `MOSTLY_DELIVERED`, `CARRIER_CONFIRMED_HISTORY`.
* Header `x-ratelimit-remaining`: lookups left this minute.

Suggested use: `low` → ship. `medium` → confirm by call/WhatsApp. `high` → ask for a deposit or prepayment. `insufficient_data` → business as usual. **Never present the band to a customer as a blacklist.**

Every lookup is written to the audit log (merchant, hashed phone, time, result) and counts toward monthly usage.

## POST /v1/outcomes

Report what happened to a delivery. Idempotent per `order_ref`: sending a new status for the same `order_ref` updates it (e.g. `unreachable` → `delivered`). Without `order_ref`, the same phone + outcome + day is de-duplicated.

```json
{ "phone": "0612345678", "outcome": "refused", "occurred_at": "2026-11-20T15:00:00Z", "carrier": "Amana", "city": "Rabat", "order_ref": "CMD-1001" }
```
`outcome`: `delivered` | `refused` | `returned` | `unreachable` (required). Everything else is optional (`occurred_at` defaults to now, can't be in the future).

Response: `{ "accepted": 1, "inserted": 1, "updated": 0, "unchanged": 0 }`. `unchanged` = the record is under consumer dispute (frozen) and was not modified.

## POST /v1/outcomes/batch

`{ "outcomes": [ …up to 1000 objects like above… ] }`. Valid rows are saved, invalid ones are reported:
```json
{ "received": 3, "accepted": 2, "rejected": 1, "inserted": 2, "updated": 0, "unchanged": 0,
  "errors": [{ "index": 1, "errors": [{ "path": "phone", "message": "INVALID_MOROCCAN_PHONE" }] }] }
```

## Rate limits ("give data to get data")

Lookups/minute depend on your **contribution ratio**: of the distinct phones you scored 14–90 days ago, how many did you later report an outcome for?

| Tier | Condition | Limit |
|---|---|---|
| grace | first 30 days, or < 300 lookups total | full (default 120/min) |
| full | ratio ≥ 50% | full |
| reduced | 20–50% | half |
| throttled | < 20% | 10/min |

Outcome submissions: 600 requests/min.
