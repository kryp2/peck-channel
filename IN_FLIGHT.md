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

## 2026-06-02 (forts.) — close() produktisert (settlement-halvdelen)
- close = der pengene FAKTISK flytter (drain holder verdi låst, advancer kun amountSpent som checkpoint). peck-host hadde ingen close → lagt til.
- peck-host: `billing/close_tx.go` (`VerifyCloseTx` — split `[gateway←amountSpent, user←lock−spent−fee]`, FIX-A, kun struktur) + `RequestClose`/`SubmitClose` handlers + ruter `/api/channels/{close,submit-close}`. Bygger+vet grønt.
- lib: `SIGHASH_ALL_FORKID`, `buildCloseSpend`/`assembleCloseUnlock`, `walletSignSighash` tar nå `sighashFlag`. `deployChannel` hopper fee-fund når `feeFund<=0` (close trenger den ikke). gateway-klient `requestClose`/`submitClose`. Driver `e2e-gopath-close.ts` (`npm run close-e2e`). Typecheck rent.
- close trenger KUN userSig (ingen cosign, ingen placeholder) — enklere enn drain.

## 2026-06-02 (forts.) — close BEVIST ON-CHAIN ✅
- `npm run close-e2e` via lib-en: deploy `25833bc3…d705` / close `4980815075…2f959` (ARC 200, status closed). amountSpent=0 → user 500, fee 700. Settlement gjennom peck.run Go-stien bekreftet.
- LÆRDOM: createAction-500-ene var peck-desktop approval-TIMEOUT (treg godkjenning), IKKE saldo. Godkjenn promptene raskt. (Drains gikk da Thomas var i tide; close feilet 3× da han ikke fulgte med.)

## 2026-06-02 (forts.) — FULL LIFECYCLE BEVIST ON-CHAIN ✅ (deploy→drain→close, amountSpent>0)
- `npm run lifecycle-e2e`: deploy `5ffd977b…e240` / drain `2e863c23…a7db` / close `43dd688aef7ba6…c84c994` (ARC 200). Gateway fikk 200 sat, bruker 100. Begge close-outputs (amountSpent>0-grenen), non-custodial.
- peck-host: SettleDrain advancer kanal-UTXO-pekeren til drain-output[0] etter broadcast (drain.go). Lib: buildDrainSpend returnerer nextInstance+nextScriptHex; buildCloseSpend spender post-drain-UTXO (fromTxId/fromScriptHex + avansert instans + next-state subscript).
- 2 BUGS fanget + fikset: (1) `VerifyDrainTx`/`sharesContractPrefix` krevde eksakt script-lengde — feil fordi sCrypt-ints er VARIABEL-bredde (amountSpent=200=0xC8 trenger 0x00-padding=2 bytes vs 50=1 byte). Fikset til min-lengde-prefix-sammenligning. (2) close fee=300 < ARC-min 633 → bump til 700, LOCK 1000.
- Zero-conf-kjeding BEKREFTET: close spender ubekreftet drain-output, ARC godtok (ingen parent-not-found).

## 2026-06-02 (forts.) — METER-DRIVEN SETTLEMENT BEVIST ON-CHAIN ✅
- `npm run meter-settle-e2e`: ekte per-sekund-meter akkumulerte 40→80→120→140 sat headless (ingen prompts), så settle via drain+close. deploy `e3168912…` / drain `f86cb7df…` (amountSpent=140) / close `aa3ee1e5…` (ARC 200, gateway 140 + user 160 + fee 700).
- peck-host: StartMeter/StopMeter (DEV-gated) kjører den eksisterende Meter på bar kanal. FIX: meteren biller instance-seconds i non-mock (0 for bar kanal → 0 akkumulering); la til Meter.StartWallClock + ServiceMeter.ForceWallClock så DEV-meteren biller wall-clock.
- "Produktet gjør det selv": meter accruer fritt, bruker signerer kun ved settle. Symmetrisk med llm.peck.to receipt→close — de to consumerne nå symmetriske.

## Neste
- (valgfritt) receipt-pre-auth-tak så akkumulering er bundet til user-autorisasjon (llm-gateway har BRC-77-mønsteret).
- timeout()-produktisering (user safety valve, kan ikke bevises uten expiry).
- dedupe llm-gateway internal/payment mot spec; mirror FIX A til FetchPaymentChannel.
- Senere: timeout() produktisering (user safety valve); dedupe llm-gateway internal/payment mot spec; mirror FIX A til FetchPaymentChannel.
- Drain→close lifecycle: peck-host sporer ikke post-drain outpoint (kanal-UTXO flytter per drain) — må fikses for close-etter-drain (gateway-output-grenen).
- La peck.run-meteren drive drain/close automatisk (uten accrue-hook) mot et pre-autorisert receipt-tak.
- Senere: dedupe llm-gateway `internal/payment/*` mot SPEC; mirror FIX A til FetchPaymentChannel (peck-overlay-schema paywall).
- Produksjonalisér sidecar `server.ts`: klient-wallet-sig i stedet for `userPrivWIF`.
- Mirror FIX A + nøkkel-lag + wallet-sig til FetchPaymentChannel (peck-overlay-schema paywall — stubbet /close + /timeout).
- Wire sidecar ↔ gateway for `ENFORCE_PAYMENT`-tier på llm.peck.to.

## Kontekst
- Del av llm-gateway 402-laget OG peck.run drain-stack. Proven flow ligger som referanse i `settle-sidecar/spike-close-broadcast.ts` (lokal, ucommittet).
