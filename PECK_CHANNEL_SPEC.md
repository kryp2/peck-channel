# peck.channel — spec & grensesnitt (v1)

_v0 skrevet 2026-06-02, låst til v1 2026-06-03. Dette er protokollen begge språk (TS-klient + Go-gateway) MÅ ære. Kanon-kontrakt: **`LLMPaymentChannel`** (bevist on-chain — IKKE FetchPaymentChannel). Kilde-verifisert mot `src/contracts/LLMPaymentChannel.ts`, `src/client/*`, `settle-sidecar/*`, `peck-host/billing/*` og `peck-host/api/channels.go`._

## 0a. Standarden er bevist — golden vektorer + alle ops on-chain

**TS↔Go-enighet er bevist ved kontrakt**, ikke flaks: `vectors/sighash-vectors.json` er den språknøytrale fasiten (drain/close/timeout-sighashes). `tests/conformance.test.ts` (TS) og `peck-host/billing/conformance_test.go` (Go) asserter mot SAMME fil. Regenerér med `npm run vectors`. `sighashToSign` = naturlig BIP143-digest `hash256(preimage)`; TS: `sha256sha256(getPreimage)`, Go: `ReverseBytes(GetInputSignatureHash)`.

**Alle 4 kontrakt-ops bevist non-custodial på mainnet (2026-06-02/03):**
| Op | txid |
|---|---|
| drain | `569ddd1b` · `822a773c` |
| close (amountSpent=0) | `4980815075` |
| full lifecycle (drain→close, amountSpent>0) | `43dd688a` |
| meter-driven settlement | `aa3ee1e5` |
| timeout (gateway-uavhengig) | `6d5b83ab` |

## 0. Hva peck.channel er (og ikke er)

peck.channel er **primitivet for alle BSV-betalingskanaler** i økosystemet — ikke en app, ikke en streaming-host. Det er fire ting som må være enige, ikke én pakke alle importerer:

1. **Kontrakt-artefakt** — den kompilerte sCrypt-kontrakten (`LLMPaymentChannel`). Én kilde, deles av alle.
2. **Protokoll-spec** (dette dokumentet) — ABI, sighash-konstruksjon, nonce/receipt-semantikk, gateway-HTTP-kontrakt. Språknøytral sannhet.
3. **TS-klientlib** — wallet-side: bygg next-state, deriver sighash, hent bruker-sig fra BRC-100-wallet, sett sammen unlock. **Realisert i `src/client/`** (`PeckChannelGateway` + `deployChannel`/`buildDrainSpend`/`walletSignSighash`/`assembleDrainUnlock`), byte-identisk med den beviste stien; `settle-sidecar/e2e-gopath-drain.ts` konsumerer den og er conformance-testen.
4. **Go-gateway-lib** — gateway-side: bygg drain/close, co-sign, sign fee-input, broadcast via ARC. Frøet ligger i `peck-host/billing/*`. Skal dedupe llm-gateway sin parallelle `internal/payment/*`.

Go kan ikke importere sCrypt-libben — derfor er (3) og (4) separate. Limet som garanterer at de er enige: **`settle-sidecar/sighash-parity-check.ts`** (go-bt-sighash == scryptlib-sighash, bevist). Enhver endring i sighash-konstruksjon MÅ holde paritetssjekken grønn.

**Consumers (vertikal avhengighet, rene grensesnitt — ikke lateral floke):**
`peck.channel → peck.run (peck-host) → peck.website` · `peck.channel → llm.peck.to (402-tier)` · `peck.channel → peck.fm (HLS-paywall)` · `peck.channel → peck-overlay-schema (FetchPaymentChannel paywall)`

## 1. Kontrakt-ABI (`LLMPaymentChannel`)

| Felt | Type | Stateful | Beskrivelse |
|------|------|----------|-------------|
| `userPubKey` | PubKey | nei | Bruker som funder kanalen (BRC-42-derivert child) |
| `gatewayPubKey` | PubKey | nei | Gateway-operatør. MÅ matche gatewayens co-sign-nøkkel |
| `lockAmount` | bigint | nei | Total låst (satoshi). UTXO-verdien holdes konstant gjennom drains |
| `amountSpent` | bigint | **ja** | Akkumulert spent, oppdateres per drain |
| `paymentNonce` | bigint | **ja** | Replay-vern, inkrementeres per drain |
| `expiryTime` | bigint | nei | Unix-tid for timeout-refusjon |

**Metoder:**
- `drain(amount, nonce, userSig, gatewaySig)` — krever BEGGE sigs over samme sighash. `amountSpent ← amount`, `paymentNonce ← nonce+1`, UTXO-verdi forblir `lockAmount`. Kan kalles mange ganger.
- `close(userSig)` — splitt: gateway får `amountSpent`, bruker får `lockAmount − amountSpent`. SIGHASH_ALL.
- `timeout(userSig)` — kun etter `expiryTime`: bruker får hele `lockAmount` tilbake (nLockTime). Brukerens sikkerhetsventil.

## 2. Sighash-konstruksjon (drain) — den kanoniske oppskriften

```
flag    = SIGHASH_ANYONECANPAY | SIGHASH_SINGLE | SIGHASH_FORKID
preimage = getPreimage(drainTx, lockingScript, lockAmount, inputIndex=0, flag)   // BIP143
sighash  = sha256sha256(preimage)
```

- **ANYONECANPAY_SINGLE** binder kun kontrakt-input[0] + state-output[0]. Det lar fee betales fra en separat input (gateway fee-fund) UTEN å endre kanalverdien — drain holder `lockAmount` konstant.
- Bruker-sig: `wallet.createSignature({ hashToDirectlySign: sighash, protocolID:[2,'peck channel'], keyID, counterparty:'self' })`. **Privatnøkkelen forlater aldri walleten.**
- Gateway-sig: ECDSA over samme `sighash` med gateway-nøkkel.
- Begge sigs får `flag`-byte appendet (DER + flag) før de settes i unlock.

**Protocol-ID er `[2, 'peck channel']`** (BRC-100-regex: kun bokstaver/tall/mellomrom — ingen bindestrek).

## 2b. FetchPaymentChannel — søsken-varianten (per-fetch)

`FetchPaymentChannel` er samme design som `LLMPaymentChannel`, generalisert for "pay-per-fetch" (overlay paywall, peck.fm). Re-homet hit fra peck-overlay-schema 2026-06-03 (mainnet-bevist FIX-A). Forskjeller:

| | LLMPaymentChannel | FetchPaymentChannel |
|---|---|---|
| Expiry | `expiryTime` (unix-tid, `ctx.locktime >= 500_000_000`) | `expiryHeight` (block-høyde, `ctx.locktime < 500_000_000`) |
| Nonce | match + 1 per drain | **strengt økende** (`newNonce > this.nonce`) |
| Drain | per LLM-token / compute-sekund | per fetch, off-chain via `X-Peck-Receipt`; on-chain drain kun for dispute/commit |
| Parter | user / gateway | client / server |

Alt annet likt: dual-sig drain (ANYONECANPAY_SINGLE), FIX-A `close(clientSig, fee)`/`timeout(clientSig, fee)` med fee fra verdi, P2PKH-split, **samme sighash-oppskrift (§2)**. Kontrakt+artifact+test bor nå i `src/contracts/FetchPaymentChannel.ts` (9/9 jest grønt). Consumere (overlay paywall, peck.fm) bør importere herfra — re-point er oppfølger.

## 3. Non-custodial-prinsippet (hard regel)

> Walleten produserer KUN brukerens signatur over en sighash. Gatewayen bygger transaksjonen, co-signer sin halvdel, signerer sin egen fee-input, og broadcaster. **Ingen privatnøkkel krysser grensen i noen retning.**

Empirisk forankret (`IN_FLIGHT.md`): wallet-`createAction` legger ALLTID til funding-input + change-output → en wallet-AUTHORED close/drain bryter FIX A (ANYONECANPAY_SINGLE-bindingen). Derfor **bygger gatewayen tx, walleten authorer den ikke.** Bevist on-chain: close `628ac044`, drain `a63031b0`, deploy `d36a9071` — alle `SEEN_ON_NETWORK`.

## 4. Gateway-HTTP-kontrakt (det consumers konsumerer)

Disse rutene definerer peck.channel-gatewayen. peck-host implementerer dem (`api/channels.go`); llm.peck.to/peck.fm skal konvergere mot samme form.

| Rute | Retning | Gjør |
|------|---------|------|
| `POST /channels/open` | klient→gateway | Registrer kanal: `{channel_txid, amount, script_hex, satoshi_value, vout, user_pubkey, expiry_time}`. Gateway provisjonerer `ChannelOnChainState`. **TODO: verifiser UTXO on-chain (`channels.go:94`).** |
| `POST /channels/drain` (RequestDrain) | klient→gateway | Gateway bygger drain-spend, co-signer ANYONECANPAY_SINGLE-sighash, returnerer `{gateway_sig, sighash, drain_amount, nonce}`. |
| `POST /channels/cosign-drain` | klient→gateway | **(commit `8dba2b7`)** Klient poster sin rebygde sighash; gateway re-co-signer den med gateway-nøkkel. Tetter placeholder-sighash-gapet. |
| `POST /channels/submit-drain` | klient→gateway | Klient poster ferdig drain-tx (kontrakt-input bruker-signert). Gateway `VerifyDrainTx` + **signerer fee-input[1]** + `SettleDrain` broadcaster via ARC. |
| `POST /channels/close` | klient→gateway | **(impl.)** Gateway returnerer autoritativ `amountSpent` + params; klienten bygger FIX-A close (`buildCloseSpend`), bruker signerer SIGHASH_ALL i wallet. Ingen gateway-cosign (close trenger kun userSig). |
| `POST /channels/submit-close` | klient→gateway | **(impl.)** Klient poster ferdig close-tx; gateway `VerifyCloseTx` (split = `[gateway←amountSpent, user←lockAmount−amountSpent−fee]`) + broadcast via ARC + avslutter kanalen. |
| (ingen gateway-rute) | klient→ARC | **(impl.)** `timeout()` er GATEWAY-UAVHENGIG: etter expiry bygger klienten reclaim-tx-en (`buildTimeoutSpend`, nLockTime=expiry), bruker signerer, og broadcaster RETT til ARC. Ingen gateway — det er hele poenget med sikkerhetsventilen. Bevist: `6d5b83ab…`. |

Broadcast går ALLTID via ARC (`arc.gorillapool.io`), aldri WoC i loop.

## 5. Drain-flyt (kanonisk, non-custodial)

```
[TS klient]  deploy LLMPaymentChannel via wallet.createAction        (PROMPT: deposit)
      │       + gateway fee-fund UTXO i samme tx
      ▼
POST /channels/open      → gateway provisjonerer state
      │
   (meter akkumulerer PendingDrain per sekund/token)
      ▼
POST /channels/drain     → gateway: {gateway_sig (placeholder), sighash, amount, nonce}
      │
[TS klient]  bygg ekte next-state (amountSpent=amount, nonce+1) → ny sighash
      ▼
POST /channels/cosign-drain {sighash}  → gateway re-co-signer over KLIENTENS sighash   ← GAP 1 (endpoint finnes, klient bruker den ikke ennå)
      │
[wallet]  createSignature{hashToDirectlySign: sighash}  → bruker-sig     (PROMPT: drain)
      │
[TS klient]  unlock = drain(amount, nonce, userSig, gatewaySig); sett på input[0]
      ▼
POST /channels/submit-drain {signed_tx_hex}
      │   gateway: VerifyDrainTx → signer fee-input[1] → broadcast ARC      ← GAP 2 (submit-drain signerer ikke fee-input ennå)
      ▼
   drain-txid SEEN_ON_NETWORK
```

## 6. Seam-først-milepæl (ÉN ekte leveranse)

**Mål:** `e2e-gopath-drain.ts` kjører non-custodial — walleten signerer kun bruker-sighash, ingen `PECKHOST_FEE_WIF` i klienten.

To presise fikser — **BEGGE IMPLEMENTERT + BEVIST ON-CHAIN 2026-06-02:**

- **GAP 1 — klient ✅:** `e2e-gopath-drain.ts` bytter lokal WIF-re-sign med `POST /api/channels/cosign-drain` (rebygd sighash → gateway-sig). Fee-input sendes nå USIGNERT. Ingen `PECKHOST_FEE_WIF` lenger.
- **GAP 2 — gateway (peck-host) ✅:** `/open` fanger fee-fund-UTXO (`fee_txid/fee_vout/fee_satoshi_value` → `ChannelOnChainState`). `SubmitDrain` kaller `billing.GatewaySignFeeInput` (go-bt P2PKH, SIGHASH_ALL|FORKID) som signerer fee-input[1] med `PECKHOST_PRIVKEY` før broadcast.

**BEVIST PÅ MAINNET (Go-HTTP-stien, non-custodial):**
- deploy `97fd93be85fbf4df120e1ceac31e53bdb262541d3299b00fd8681a5e059e7293`
- drain `569ddd1b0cc6d9124c9d751c92769c656cd57382124a99c14965047a9190423f` (ARC 200)
- Walleten signerte KUN bruker-sighash; gateway co-signet (`/cosign-drain`) + fee-signet (`/submit-drain`). Begge kontrakt-checkSig + P2PKH fee-input passerte on-chain.

**LÆRDOM (kritisk):** go-bt `GetInputSignatureHash` returnerer reversert (little-endian) digest; OP_CHECKSIG vil ha naturlig `Sha256d(preimage)`. Må signere `bt.ReverseBytes(sh)` (slik go-bt sin egen `InternalSigner` gjør) — ellers ARC 461 NULLFAIL på fee-input. Kontrakt-input-sigs (TS getPreimage→sha256sha256→bsv/go-bk over naturlig digest) er IKKE rammet; kun den go-bt-bygde P2PKH-fee-signaturen.

**Etter milepælen** (ikke i denne runden): seed `peck-channel`-pakken (contract + spec + TS-klient + Go-lib) rundt nettopp denne beviste stien; dedupe llm-gateway `internal/payment/*` mot Go-libben; mirror FIX A til FetchPaymentChannel (peck-overlay-schema paywall).

## 7. Invariantene som ikke får brytes

- Sighash-paritet (go-bt == scryptlib) — kjør `sighash-parity-check.ts` etter enhver sighash-endring.
- Fee endres aldri (`never_touch_fee_rate`) — mining-fee er gatewayens kostnad, absorbert i margin.
- Begge sigs kreves for drain — gateway kan aldri tømme kanalen alene.
- Timeout er alltid brukerens reclaim-vei — kanalen kan aldri låse penger permanent.
