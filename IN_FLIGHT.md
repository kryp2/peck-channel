# IN_FLIGHT — llm-payment-channel
_Sist oppdatert: 2026-06-01_

## Sist gjort
- **FIX A BEVIST ON-CHAIN (mainnet).** Hele løkka: (1) deploy via BRC-100-wallet `createAction` → tx `d36a9071`; (2) close bygget av gateway (kontrakt-input + `[user]`, fee fra verdi, ingen change) + broadcast via GorillaPool ARC → tx `dfc39a8a`, `SEEN_ON_NETWORK`. close() sin SIGHASH_ALL-assert passerte live.
- **Empirisk arkitektur-svar:** wallet-`createAction` legger ALLTID til funding-input + change-output (verifisert: close-inspect ga 2 inputs/3 outputs) → en wallet-AUTHORED close bryter FIX A. Derfor: **gateway bygger close, walleten authorer den ikke** — walleten gir kun brukerens signatur. Non-custodial + BRC-100-native intakt.
- `settle-sidecar/server.ts` `buildClose`/`buildTimeout` oppdatert til FIX-A-ABI (fee-param, fee-fra-verdi, ingen feeUtxo/change). `derive.ts` = BRC-42 nøkkel-lag. **14/14 jest grønt** (10 kontrakt + 4 derive).

## Neste
- **Prod-gap:** brukerens close-sig fra BRC-100-walleten (`createSignature` over close-preimage med BRC-42 refund-child) i stedet for lokal WIF i sidecar. Spiken brukte lokal user-key.
- Mirror FIX A + nøkkel-lag til FetchPaymentChannel (peck-overlay-schema paywall — stubbet /close + /timeout).
- Wire sidecar ↔ gateway (Go broadcaster.Arc) for `ENFORCE_PAYMENT`-tier.

## Kontekst
- Del av llm-gateway 402-laget OG peck.run drain-stack. Proven flow ligger som referanse i `settle-sidecar/spike-close-broadcast.ts` (lokal, ucommittet).
