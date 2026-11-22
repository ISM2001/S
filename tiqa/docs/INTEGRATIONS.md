# Integrations: research & status (Phase 3)

Research date: **2026-11-22**. The developer sites (shopify.dev, developer.youcan.shop) could not be fetched directly from the build environment, so facts below come from **web-search excerpts of the official docs**. Everything marked ⚠️ must be re-checked in the docs or against a real store before launch. No endpoint was invented: anything not found is listed as "not found" and not implemented.

## Status

| Integration | Status | How it works |
|---|---|---|
| **Generic webhook** | ✅ Built & tested | Secret inbound URL `POST /v1/hooks/hk_…` (any tool: Google Sheets Apps Script, n8n, Make, custom store). Orders → scored, result in the response. Payloads with a delivery status (`Livré`, `Refusé`, `delivered`…) → recorded as outcomes. Field paths are auto-detected or configured. **Outbound** signed webhooks (`score.created`) to the merchant's system, with retries. |
| **Shopify** | ✅ App stub built & tested against mocked Shopify | OAuth install from the dashboard → each COD order is scored → tag `tiqa-risque-eleve` / `-moyen` / `-faible` / `tiqa-donnees-insuffisantes` added to the order. Compliance webhooks handled. Needs a Shopify Partner app + review (see blockers). |
| **YouCan** | ✅ Built on documented endpoints, tested against mocks | OAuth install → subscribes to `order.created` → each order is scored. Result visible in Tiqa history + outbound webhook. **No write-back to YouCan** (no documented tag/note endpoint found). |
| **Carrier CSV** | ✅ Improved | Column mappings are **remembered per file layout**: map a carrier export once, and the next import of the same layout is pre-filled. Downloadable template for sellers' own spreadsheets. |
| **Carrier APIs** | ❌ None usable yet | See the carrier table below. |

## Shopify: what the docs say (and what we did)

| Topic | Finding | Implementation |
|---|---|---|
| OAuth | Authorization-code grant. Callback verified with HMAC-SHA256 of the sorted query (minus `hmac`), `state` = nonce, shop must match `^[a-zA-Z0-9][a-zA-Z0-9\-]*\.myshopify\.com$` ([auth code grant](https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant)) | `routes/shopify.ts`: all three checks + signed cookie |
| **Expiring tokens** | **New public apps must use expiring offline tokens**: add `expiring=1` to the code exchange. Access token 1 h, refresh token 90 days. Required for new apps from Dec 1, 2026 ([migrate](https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens), [changelog](https://shopify.dev/changelog/posts/expiring-offline-access-tokens-required-for-new-custom-apps-as-of-december-1-2026)) | `expiring: 1` + automatic refresh. Tokens AES-256-GCM encrypted |
| Webhooks | `X-Shopify-Hmac-SHA256`, base64 HMAC of the **raw body** with the app secret ([verify deliveries](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries)). Subscriptions declared in the app TOML | Raw-body verification, dedupe on `X-Shopify-Webhook-Id`. Template: `integrations/shopify/shopify.app.toml.example` |
| Compliance | `customers/data_request`, `customers/redact`, `shop/redact` mandatory for App Store apps ([webhooks](https://shopify.dev/docs/api/webhooks/latest?reference=toml)) | data_request → audited (we hold no Shopify profile). redact → this store's outcomes for that phone deleted. shop/redact → integration deleted |
| **Phone = protected data** | Phone is **Level 2 protected customer data**: public apps need Shopify's review. Unapproved fields are **redacted (null)** in webhooks and API ([protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data)) | Falls back to an Admin API order query. Without Level 2 approval **no phone means no score** (logged as `no_phone`) |
| Tagging | `tagsAdd(id, tags)` appends tags, returns `userErrors`. Endpoint `POST https://{shop}/admin/api/2026-10/graphql.json`, header `X-Shopify-Access-Token` ([tagsAdd](https://shopify.dev/docs/api/admin-graphql/latest/mutations/tagsadd)) | Done |
| COD detection | ⚠️ Not found in docs. We match `payment_gateway_names` against "cash / COD / livraison / الدفع عند" | Setting "COD only" (default on). Verify gateway names on real Moroccan stores |

**Blockers before real Shopify stores:** create the app in the Shopify Partner/Dev Dashboard, **request Level 2 protected customer data (phone)** with a justification (fraud & delivery-risk prevention), pass App Store review, and verify the GraphQL `order { phone shippingAddress { phone } }` fields.

## YouCan: what the docs say (and what we did)

Sources: [OAuth](https://docs.youcan.shop/store-admin/introduction/oauth), [REST hooks](https://developer.youcan.shop/store-admin/resthooks/overview), [subscribe](https://developer.youcan.shop/store-admin/resthooks/subscribe), [Get order](https://docs.youcan.shop/store-admin/orders/get), [update status](https://developer.youcan.shop/store-admin/orders/update_status), [apps](https://developer.youcan.shop/apps/introduction).

| Topic | Finding | Implementation |
|---|---|---|
| OAuth | Authorize `https://seller-area.youcan.shop/admin/oauth/authorize` (the short `/oauth/authorize` path is invalid), scopes as repeated `scope[]`. Token `POST https://api.youcan.shop/oauth/token` (`authorization_code` / `refresh_token`), returns access + refresh token + expiry | Done. ⚠️ Whether `state` is echoed back is not documented: the signed cookie protects the flow either way |
| Scopes | `read-orders` (orders), `edit-rest-hooks` (subscribe). ⚠️ No full scope list found | `YOUCAN_SCOPES=read-orders,edit-rest-hooks` |
| Webhooks ("REST hooks") | `POST https://api.youcan.shop/resthooks/subscribe` `{event, target_url}`. Events include `order.created`, `order.updated`, `order.paid`, `app.uninstalled` (`order.create` is a deprecated alias). Envelope `{event_name, event_happened_at, data}`. `X-YOUCAN-SIGNATURE` = HMAC-SHA256 of the raw body with the **app client secret**. `X-YOUCAN-DELIVERY-ID` stable across retries. Max 7 subscriptions per event per store. Can also be declared in `youcan.app.json` | Subscribed on install, routed per integration (`/integrations/youcan/webhooks/:id`). ⚠️ Signature encoding (hex/base64) not stated: both accepted |
| Orders | `GET https://api.youcan.shop/orders/{id}` with `include=customer,shipping,payment,…`. Status fields `payment_status`, `shipping_status` (unfulfilled, processing, shipped, fulfilled, canceled), `confirmation_status`. Numeric status codes look inconsistent across doc samples | Used only to find the phone when the webhook lacks it |
| Phone | ⚠️ No single documented field. Phone appears on the customer resource and on address objects | We try `customer.phone`, `shipping.address[0].phone`, `payment.address.phone`, `phone`, then GET the order |
| Write-back (tag/note) | ❌ **Not found.** Only status-update endpoints exist | Not implemented. Result visible in Tiqa + outbound webhook |
| Delivery outcomes | `shipping_status` has no "refused/returned" value in the docs found | Not used as an outcome source |

**Next steps for YouCan:** register in the [YouCan Partner Program](https://partners.youcan.shop/), create the app, test on a dev store to confirm the phone field and the signature encoding, and ask YouCan whether an order note or tag API exists.

## Moroccan carriers: public APIs?

No **official, public** developer documentation was found for any of them. Third-party tools (eGrow, Cashod, TajerPro…) integrate several of them, which suggests **private/partner APIs on request**.

| Carrier | Finding | Next step |
|---|---|---|
| Amana (Barid Al-Maghrib) | No official public API found. Tracking is available via third-party aggregators (TrackingMore, Ship24) | Contact Poste Maroc business. A tracking aggregator could give status by tracking number (paid) |
| Cathedis | A comparison article mentions an API + Shopify/WooCommerce/PrestaShop connectors | Ask for API docs (best candidate) |
| Digylog | Third parties create shipments, labels and **status webhooks** via its API | Ask for partner API access (good candidate: webhooks) |
| Ozon Express | eGrow integrates its parcel/tracking API | Ask for API access |
| Sendit | No API mentioned. Native Shopify app | CSV export |
| Speedaf, Onessta, Forcelog, CTM | Nothing found | CSV export |

Sources: [eGrow integrations](https://www.egrow.com/en/integration), [Cashod × Digylog](https://cashod.ma/en/integrations/digylog), [Sendit vs Cathedis](https://www.swiftlog.ma/blog/sendit-ma-vs-cathedis-comparatif-livraison-maroc-2026), [TajerPro](https://tajerpro.co.ma/), [TrackingMore Poste Maroc](https://www.trackingmore.com/poste-maroc-tracking-api-fr.html).

**Why carrier APIs matter for Tiqa:** an outcome coming **directly** from a carrier (`carrier_api`, weight 1.0) can't be faked by a merchant. It is the strongest anti-poisoning signal (see DESIGN.md, Phase 2 notes). Getting one or two carrier partnerships (Cathedis, Digylog) should be a business priority.
