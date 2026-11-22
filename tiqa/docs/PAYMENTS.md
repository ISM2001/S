# Payment options for Tiqa subscriptions (research, 2026-11-22)

Payments are **stubbed**: invoices are paid by **bank transfer** and marked paid by staff. Choosing a gateway is a business decision that is hard to reverse (contracts, KYC, fees), so it is listed here for you to decide. Sources are mostly vendor and agency blogs with contradictory figures: **confirm fees and recurring-billing support directly with each provider.**

| Option | What it is | Recurring / subscriptions | Notes |
|---|---|---|---|
| **Bank transfer (virement)** | Today's stub | Manual | Zero fees, fine for B2B sellers at the start. Reconciliation by invoice number |
| **CMI** (Centre Monétique Interbancaire) | Morocco's interbank card gateway, via your bank | Tokenization and recurring through partner gateways, no direct subscription API (per ChariBaaS guide) | Requires a merchant contract with a Moroccan bank. Integration via redirect/hash |
| **Payzone** | Moroccan payment service provider (CMI-connected) | Marketed with recurring payments + API. Dunning reportedly basic | Fees not published. Ask for a quote |
| **YouCan Pay** | Gateway from the YouCan ecosystem | ⚠️ Recurring support not confirmed | Published fees contradict each other (2.5% + 3 MAD vs 3.9% + 2 MAD). Natural fit if many merchants already use YouCan |
| **Chari Pay / BaaS players** | Newer providers | Marketed as having the most complete subscription API | Verify maturity and licensing |
| **Stripe** | — | — | **Not available to Morocco-based companies** (multiple sources). Only via a foreign entity, which has tax and FX implications. Not recommended for Moroccan B2B customers |
| **Cash networks** (Cash Plus, Wafacash) | Pay at an agency with a reference | Manual | Useful for very small sellers without cards |

**Recommendation for the MVP:** keep bank transfer (already built), then add **CMI or Payzone** card payments for monthly invoices once volume justifies it. The code has one place to plug a provider in: invoices already store `paymentMethod` / `paymentRef`, and a gateway webhook would call the same "mark paid" logic.

Sources: [Paiement récurrent au Maroc (baas.ma)](https://www.baas.ma/fr/blog/paiement-recurrent-abonnement-maroc) · [Comparatif passerelles (ChariBaaS)](https://www.charibaas.com/en/blog/comparatif-passerelle-paiement-maroc) · [CMI vs Payzone vs Stripe (Sentinel Studio)](https://www.sentinelstudio.ma/journal/cmi-vs-payzone-vs-stripe-maroc) · [Paiement en ligne Maroc 2026 (Digitoyou)](https://digitoyou.com/blog/paiement-en-ligne-maroc-cmi-stripe-2026/) · [CMI, Stripe, YouCan Pay (Cadence)](https://cadencemaroc.com/blog/paiement-en-ligne-maroc-cmi-stripe-youcanpay) · [Stripe au Maroc (deadline.ma)](https://deadline.ma/conseils/developpement-web/integration-cmi-stripe-paiement-maroc) · [Merchant of Record Morocco (Dodo)](https://dodopayments.com/blogs/merchant-of-record-morocco)

## Invoice compliance (to confirm with an accountant)
Built in: seller and buyer identification with **ICE (15 digits)**, **gapless sequential numbering** per year (`FAC-2026-00001`), a separate credit-note series (`AV-…`), VAT broken out (**20%** standard rate, configurable via `VAT_RATE_BP`), HT/TTC totals, issue and due dates. To confirm: VAT treatment for customers outside Morocco, the full list of mandatory mentions (CGI art. 145), and invoice retention period. Sources: [modèle facture Maroc](https://clicpaie.ma/blogs/modele-facture-maroc/), [taux TVA Maroc](https://clicpaie.ma/blogs/tva-maroc-taux/), [TVA export de services](https://upsilon-consulting.com/tva-export-services-maroc/).
