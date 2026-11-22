# Merchant terms & data agreement (outline)

> ⚠️ **DRAFT / BROUILLON. TO BE REVIEWED BY A MOROCCAN LAWYER, À FAIRE RELIRE PAR UN AVOCAT MAROCAIN.**
> This is an engineering placeholder, not legal advice. Do not publish or sign it as is.

Version recorded at signup: `2026-11-draft` (stored in `Merchant.termsVersion` together with `termsAcceptedAt`).

## Key obligations to include (engineering requirements, lawyer to draft the wording)
1. **Duty to inform customers.** Before or at order confirmation, the merchant tells customers that order data is shared with Tiqa for fraud and delivery-risk prevention, using the notice in [consumer-notice.md](consumer-notice.md) (checkout page, confirmation call/WhatsApp script, order SMS).
2. **Accurate reporting.** Only report real delivery outcomes for real orders. Never report on people who did not order. Fabricated or malicious reports → trust weight reduced, suspension, termination.
3. **Decision support only.** The merchant must not present the band to customers as a "blacklist" and should prefer proportionate measures (confirmation call, deposit) over outright refusal.
4. **No re-identification.** No attempt to infer which merchants reported a customer, or to reverse identifiers.
5. **Give data to get data.** Lookups are rate-limited when the merchant reports few outcomes.
6. **Data subject requests.** The merchant forwards consumer requests to Tiqa within [X] days. Tiqa may freeze disputed records.
7. **Security.** API keys are kept secret, rotated when staff leave, revoked if leaked.
8. **Roles & DPA.** [Independent controller / joint controller / processor: see CNDP question 2]. Sub-processors list, hosting location, breach notification delay, audit rights, end-of-contract deletion.
9. **Liability.** Scores are statistical estimates. No guarantee of delivery outcome.
