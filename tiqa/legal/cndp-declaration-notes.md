# CNDP filing: technical facts for our lawyer

> ⚠️ **DRAFT / BROUILLON. TO BE REVIEWED BY A MOROCCAN LAWYER, À FAIRE RELIRE PAR UN AVOCAT MAROCAIN.**
> This is an engineering placeholder, not legal advice. Do not publish or sign it as is.

## Open legal questions (for the lawyer)
1. **Declaration or prior authorization?** Tiqa pools delivery outcomes from many independent merchants into one shared file used to assess individuals ("interconnexion de fichiers" / possible "liste noire"). Which CNDP regime applies under Law 09-08 (and any amendment or replacement law in force)? Which CNDP form(s)?
2. **Roles:** is Tiqa an independent controller of the shared network, a joint controller with each merchant, or a processor? (This decides the merchant agreement model.)
3. **Legal basis:** legitimate interest (fraud and failed-delivery prevention) vs. consent collected by the merchant at checkout?
4. **Consumer objection and deletion:** must Tiqa honor every deletion request, or can it assess an objection against the legitimate interest? (Product default: freeze immediately, review, delete if upheld.)
5. **Historical backfill:** can merchants upload past delivery outcomes collected before customers were informed?
6. **Hosting:** if servers are outside Morocco, which transfer authorization is required? (Hosting not yet chosen.)
7. **Access right scope:** the portal shows a person their records (month, outcome, city, carrier) but **not which stores** reported them (to protect merchants and prevent retaliation). Is this compatible with the right to know the *source* of the data?
8. **Audit logs after deletion:** when a deletion is upheld, audit log entries keep the pseudonymous hash until audit retention ends (24 months planned). Acceptable as a legal obligation / accountability record?
9. **SMS OTP provider:** a provider will process phone numbers to send codes (sub-processor; location?).
10. **Automated decisions:** is a risk band shown to a merchant an "automated decision" under Moroccan law? We position it as decision support only.

## Processing description (as built)
| Item | Value |
|---|---|
| Purpose | Prevent failed cash-on-delivery deliveries and delivery fraud by sharing delivery outcomes between merchants |
| Data subjects | Consumers who placed COD orders with participating merchants |
| Data collected | Phone number (pseudonymized immediately, see below), outcome (delivered / refused / returned / unreachable), date, carrier, coarse city (optional), merchant identifier, merchant's own order reference |
| NOT collected | Name, address, email, product, amount, ID numbers, payment data |
| Pseudonymization | Phone normalized to E.164 then HMAC-SHA256 with a secret key held server-side. Raw numbers are never stored. A merchant's own history shows only the last 2 digits. |
| Recipients | Merchants receive only an aggregate risk band, a 0–100 score and coarse count ranges. Never the identity of other merchants or individual records. |
| Retention | Outcomes and lookups: 12 months (configurable), then automatic hard deletion. Audit logs: 24 months (to confirm). |
| Security | Per-merchant hashed API keys, argon2 passwords, audit log of every lookup, TLS, secret key in a secret manager (production) |
| Data subject rights | Public portal (built): verify phone by SMS code, see records, dispute (records frozen immediately) or request deletion. Staff review: upheld dispute → records deleted; upheld deletion → all data for the number deleted |
| Hosting | TBD (Morocco vs. abroad, see question 6) |
