# IN_FLIGHT — llm-payment-channel
_Sist oppdatert: 2026-06-01_

## Sist gjort
- **FIX A BEVIST ON-CHAIN (mainnet).** Hele løkka: (1) deploy via BRC-100-wallet `createAction` → tx `d36a9071`; (2) close bygget av gateway (kontrakt-input + `[user]`, fee fra verdi, ingen change) + broadcast via GorillaPool ARC → tx `dfc39a8a`, `SEEN_ON_NETWORK`. close() sin SIGHASH_ALL-assert passerte live.
- **Empirisk arkitektur-svar:** wallet-`createAction` legger ALLTID til funding-input + change-output (verifisert: close-inspect ga 2 inputs/3 outputs) → en wallet-AUTHORED close bryter FIX A. Derfor: **gateway bygger close, walleten authorer den ikke** — walleten gir kun brukerens signatur. Non-custodial + BRC-100-native intakt.
- `settle-sidecar/server.ts` `buildClose`/`buildTimeout` oppdatert til FIX-A-ABI (fee-param, fee-fra-verdi, ingen feeUtxo/change). `derive.ts` = BRC-42 nøkkel-lag. **14/14 jest grønt** (10 kontrakt + 4 derive).

## Prod-gap LUKKET (2026-06-01) — non-custodial wallet-signed close bevist on-chain
- userPubKey = BRC-42-derivert child (`getPublicKey{counterparty:'self',forSelf:true}`). Bruker funder via createAction → deploy `cfe76859`. Gateway bygger FIX-A close. **Bruker signerer sighash i egen wallet via `createSignature{hashToDirectlySign}`** (privatnøkkel forlater aldri walleten) → lokal ECDSA-verify → close `628ac044` `SEEN_ON_NETWORK`, close()-assert passerte med wallet-sig. Kanonisk referanse: `settle-sidecar/reference-walletsig-close.ts`.
- Teknisk nøkkel: `hashToDirectlySign` = sighash (hash256 av BIP143-preimage via scryptlib `getPreimage`) → verifiserer rett mot `checkSig`. Sig injiseres via `getUnlockingScript`.

## 2026-06-02 — peck.channel seam-først: non-custodial drain E2E BEVIST ON-CHAIN ✅
- `PECK_CHANNEL_SPEC.md` skrevet (primitiv-spec: ABI, ACP_SINGLE-sighash, non-custodial-regel, gateway-HTTP-kontrakt).
- GAP 1 ✅ `e2e-gopath-drain.ts`: lokal `PECKHOST_FEE_WIF`-re-sign → `POST /api/channels/cosign-drain`; fee-input sendes USIGNERT.
- GAP 2 ✅ peck-host: `/open` fanger fee-UTXO; `billing.GatewaySignFeeInput` (go-bt P2PKH) signerer fee-input[1] i `SubmitDrain` før broadcast.
- **BEVIST MAINNET:** deploy `97fd93be…7293` / drain `569ddd1b…423f` (ARC 200). Wallet signerte kun bruker-sighash; gateway co-signet+fee-signet server-side. Non-custodial drain gjennom peck.run Go-HTTP-stien.
- LÆRDOM: go-bt `GetInputSignatureHash` er reversert; må signere `bt.ReverseBytes(sh)` for fee-input (ellers ARC 461 NULLFAIL). Fanget på 2. on-chain-forsøk.

## 2026-06-02 (forts.) — peck-channel-pakke seedet (seam-først)
- Repurposet til `peck-channel` (package.json name). Klientlib i `src/client/`: `PeckChannelGateway` (HTTP) + `deployChannel`/`buildDrainSpend`/`walletSignSighash`/`assembleDrainUnlock` (byte-identisk m/ bevist sti). `src/index.ts` barrel. Typecheck rent.
- `e2e-gopath-drain.ts` rewiret til å konsumere lib-en → conformance-test (`npm run drain-e2e`). README + spec oppdatert.
- IKKE rørt: llm-gateway (eget provider-arbeid), peck-contracts, FetchPaymentChannel. Go-gateway-lib = peck-host/billing forblir referansen (Go-consumers avhenger av SPEC, ikke npm-pakka).

## 2026-06-02 (forts.) — peck-channel lib VALIDERT ON-CHAIN ✅
- `npm run drain-e2e` via lib-en: deploy `b6e09b97…b38e` / drain `822a773c…c9bb` (ARC 200). Behavior-preserving refaktor bekreftet — lib-en (ikke bare inline-scriptet) flytter sats non-custodial.

## Neste
- La peck.run-meteren drive drainen automatisk (uten accrue-hook) — fra "test-driver" til "produktet gjør det selv".
- Senere: dedupe llm-gateway `internal/payment/*` mot SPEC; mirror FIX A til FetchPaymentChannel (peck-overlay-schema paywall).
- Produksjonalisér sidecar `server.ts`: klient-wallet-sig i stedet for `userPrivWIF`.
- Mirror FIX A + nøkkel-lag + wallet-sig til FetchPaymentChannel (peck-overlay-schema paywall — stubbet /close + /timeout).
- Wire sidecar ↔ gateway for `ENFORCE_PAYMENT`-tier på llm.peck.to.

## Kontekst
- Del av llm-gateway 402-laget OG peck.run drain-stack. Proven flow ligger som referanse i `settle-sidecar/spike-close-broadcast.ts` (lokal, ucommittet).
