# Integrations & carriers: research status

**Nothing in this file has been verified yet.** Phase 3 starts with reading each provider's official developer documentation. No endpoint is assumed or invented.

| Integration | Plan | Status |
|---|---|---|
| Generic webhook | Inbound "order created" → score → callback. Outbound HMAC-signed events. | Phase 3 (first) |
| Shopify | App stub: OAuth, `orders/create` webhook, write band as order tag/note | Phase 3 |
| YouCan | Research the official developer docs/app store first, then report what is possible | Phase 3, **not researched** |
| Carrier CSV templates | Column presets per carrier export | Phase 3, needs real sample exports from sellers |

## Moroccan carriers: public API?
To verify in Phase 3 (official docs only): Amana (Barid Al-Maghrib), Cathedis, Sendit, Ozon Express, Speedaf, Digylog, Onessta, Forcelog, CTM Messagerie.
Until then, carrier data comes in through **CSV exports** (dashboard → Importer → "Export de la plateforme transporteur").

## Payments (Phase 4, stubbed)
To evaluate: CMI, Payzone, YouCan Pay, bank transfer, cash networks (Cash Plus, Wafacash). Not verified.
