# peck.channel — spec & interface (v1)

_v0 written 2026-06-02, locked to v1 2026-06-03. This is the protocol both languages (TS client + Go gateway) MUST honour. Canonical contract: **`LLMPaymentChannel`** (proven on-chain — NOT FetchPaymentChannel). Source-verified against `src/contracts/LLMPaymentChannel.ts`, `src/client/*`, `settle-sidecar/*`, `peck-host/billing/*` and `peck-host/api/channels.go`._

## 0a. The standard is proven — golden vectors + all ops on-chain

**TS↔Go agreement is proven by contract**, not luck: `vectors/sighash-vectors.json` is the language-neutral ground truth (drain/close/timeout sighashes). `tests/conformance.test.ts` (TS) and `peck-host/billing/conformance_test.go` (Go) assert against the SAME file. Regenerate with `npm run vectors`. `sighashToSign` = the natural BIP143 digest `hash256(preimage)`; TS: `sha256sha256(getPreimage)`, Go: `ReverseBytes(GetInputSignatureHash)`.

**All 4 contract ops proven non-custodial on mainnet (2026-06-02/03):**
| Op | txid |
|---|---|
| drain | `569ddd1b` · `822a773c` |
| close (amountSpent=0) | `4980815075` |
| full lifecycle (drain→close, amountSpent>0) | `43dd688a` |
| meter-driven settlement | `aa3ee1e5` |
| timeout (gateway-independent) | `6d5b83ab` |

## 0. What peck.channel is (and is not)

peck.channel is **the primitive for all BSV payment channels** in the ecosystem — not an app, not a streaming host. It is four things that must agree, not one package everyone imports:

1. **Contract artifact** — the compiled sCrypt contract (`LLMPaymentChannel`). One source, shared by all.
2. **Protocol spec** (this document) — ABI, sighash construction, nonce/receipt semantics, gateway HTTP contract. Language-neutral truth.
3. **TS client lib** — wallet side: build next-state, derive sighash, obtain the user sig from a BRC-100 wallet, assemble the unlock. **Realized in `src/client/`** (`PeckChannelGateway` + `deployChannel`/`buildDrainSpend`/`walletSignSighash`/`assembleDrainUnlock`), byte-identical to the proven path; `settle-sidecar/e2e-gopath-drain.ts` consumes it and is the conformance test.
4. **Go gateway lib** — gateway side: build drain/close, co-sign, sign the fee input, broadcast via ARC. The seed lives in `peck-host/billing/*`. It should dedupe llm-gateway's parallel `internal/payment/*`.

Go cannot import the sCrypt lib — that is why (3) and (4) are separate. The glue that guarantees they agree: **`settle-sidecar/sighash-parity-check.ts`** (go-bt sighash == scryptlib sighash, proven). Any change to sighash construction MUST keep the parity check green.

**Consumers (vertical dependency, clean interfaces — not a lateral tangle):**
`peck.channel → peck.run (peck-host) → peck.website` · `peck.channel → llm.peck.to (402 tier)` · `peck.channel → peck.fm (HLS paywall)` · `peck.channel → peck-overlay-schema (FetchPaymentChannel paywall)`

## 1. Contract ABI (`LLMPaymentChannel`)

| Field | Type | Stateful | Description |
|------|------|----------|-------------|
| `userPubKey` | PubKey | no | User who funds the channel (BRC-42-derived child) |
| `gatewayPubKey` | PubKey | no | Gateway operator. MUST match the gateway's co-sign key |
| `lockAmount` | bigint | no | Total locked (satoshi). The UTXO value is held constant across drains |
| `amountSpent` | bigint | **yes** | Accumulated spend, updated per drain |
| `paymentNonce` | bigint | **yes** | Replay protection, incremented per drain |
| `expiryTime` | bigint | no | Unix time for timeout refund |

**Methods:**
- `drain(amount, nonce, userSig, gatewaySig)` — requires BOTH sigs over the same sighash. `amountSpent ← amount`, `paymentNonce ← nonce+1`, the UTXO value stays `lockAmount`. Can be called many times.
- `close(userSig)` — split: gateway gets `amountSpent`, user gets `lockAmount − amountSpent`. SIGHASH_ALL.
- `timeout(userSig)` — only after `expiryTime`: user gets the entire `lockAmount` back (nLockTime). The user's safety valve.

## 2. Sighash construction (drain) — the canonical recipe

```
flag    = SIGHASH_ANYONECANPAY | SIGHASH_SINGLE | SIGHASH_FORKID
preimage = getPreimage(drainTx, lockingScript, lockAmount, inputIndex=0, flag)   // BIP143
sighash  = sha256sha256(preimage)
```

- **ANYONECANPAY_SINGLE** binds only contract input[0] + state output[0]. This lets the fee be paid from a separate input (gateway fee-fund) WITHOUT changing the channel value — the drain keeps `lockAmount` constant.
- User sig: `wallet.createSignature({ hashToDirectlySign: sighash, protocolID:[2,'peck channel'], keyID, counterparty:'self' })`. **The private key never leaves the wallet.**
- Gateway sig: ECDSA over the same `sighash` with the gateway key.
- Both sigs get the `flag` byte appended (DER + flag) before they are placed in the unlock.

**The protocol ID is `[2, 'peck channel']`** (BRC-100 regex: letters/digits/spaces only — no hyphen).

## 2b. FetchPaymentChannel — the sibling variant (per-fetch)

`FetchPaymentChannel` is the same design as `LLMPaymentChannel`, generalized for "pay-per-fetch" (overlay paywall, peck.fm). Re-homed here from peck-overlay-schema 2026-06-03 (mainnet-proven FIX-A). Differences:

| | LLMPaymentChannel | FetchPaymentChannel |
|---|---|---|
| Expiry | `expiryTime` (unix time, `ctx.locktime >= 500_000_000`) | `expiryHeight` (block height, `ctx.locktime < 500_000_000`) |
| Nonce | match + 1 per drain | **strictly increasing** (`newNonce > this.nonce`) |
| Drain | per LLM token / compute-second | per fetch, off-chain via `X-Peck-Receipt`; on-chain drain only for dispute/commit |
| Parties | user / gateway | client / server |

Everything else is the same: dual-sig drain (ANYONECANPAY_SINGLE), FIX-A `close(clientSig, fee)`/`timeout(clientSig, fee)` with the fee taken from value, P2PKH split, **the same sighash recipe (§2)**. Contract+artifact+test now live in `src/contracts/FetchPaymentChannel.ts` (9/9 jest green). Consumers (overlay paywall, peck.fm) should import from here — re-pointing is a follow-up.

## 3. The non-custodial principle (hard rule)

> The wallet produces ONLY the user's signature over a sighash. The gateway builds the transaction, co-signs its half, signs its own fee input, and broadcasts. **No private key crosses the boundary in either direction.**

Empirically grounded: wallet `createAction` ALWAYS adds a funding input + change output → a wallet-AUTHORED close/drain breaks FIX A (the ANYONECANPAY_SINGLE binding). Therefore **the gateway builds the tx, the wallet does not author it.** Proven on-chain: close `628ac044`, drain `a63031b0`, deploy `d36a9071` — all `SEEN_ON_NETWORK`.

## 4. Gateway HTTP contract (what consumers consume)

These routes define the peck.channel gateway. peck-host implements them (`api/channels.go`); llm.peck.to/peck.fm should converge on the same shape.

| Route | Direction | Does |
|------|---------|------|
| `POST /channels/open` | client→gateway | Register a channel: `{channel_txid, amount, script_hex, satoshi_value, vout, user_pubkey, expiry_time}`. The gateway provisions `ChannelOnChainState`. **TODO: verify the UTXO on-chain (`channels.go:94`).** |
| `POST /channels/drain` (RequestDrain) | client→gateway | The gateway builds the drain spend, co-signs the ANYONECANPAY_SINGLE sighash, returns `{gateway_sig, sighash, drain_amount, nonce}`. |
| `POST /channels/cosign-drain` | client→gateway | **(commit `8dba2b7`)** The client posts its rebuilt sighash; the gateway re-co-signs it with the gateway key. Closes the placeholder-sighash gap. |
| `POST /channels/submit-drain` | client→gateway | The client posts the finished drain tx (contract input user-signed). The gateway runs `VerifyDrainTx` + **signs fee input[1]** + `SettleDrain` broadcasts via ARC. |
| `POST /channels/close` | client→gateway | **(impl.)** The gateway returns the authoritative `amountSpent` + params; the client builds the FIX-A close (`buildCloseSpend`), the user signs SIGHASH_ALL in the wallet. No gateway co-sign (close needs only userSig). |
| `POST /channels/submit-close` | client→gateway | **(impl.)** The client posts the finished close tx; the gateway runs `VerifyCloseTx` (split = `[gateway←amountSpent, user←lockAmount−amountSpent−fee]`) + broadcasts via ARC + closes the channel. |
| (no gateway route) | client→ARC | **(impl.)** `timeout()` is GATEWAY-INDEPENDENT: after expiry the client builds the reclaim tx (`buildTimeoutSpend`, nLockTime=expiry), the user signs, and broadcasts DIRECTLY to ARC. No gateway — that is the whole point of the safety valve. Proven: `6d5b83ab…`. |

Broadcast ALWAYS goes via ARC (`arc.gorillapool.io`), never WoC in a loop.

## 5. Drain flow (canonical, non-custodial)

```
[TS client]  deploy LLMPaymentChannel via wallet.createAction        (PROMPT: deposit)
      │       + gateway fee-fund UTXO in the same tx
      ▼
POST /channels/open      → gateway provisions state
      │
   (meter accrues PendingDrain per second/token)
      ▼
POST /channels/drain     → gateway: {gateway_sig (placeholder), sighash, amount, nonce}
      │
[TS client]  build the real next-state (amountSpent=amount, nonce+1) → new sighash
      ▼
POST /channels/cosign-drain {sighash}  → gateway re-co-signs over the CLIENT'S sighash   ← GAP 1 (endpoint exists, client does not use it yet)
      │
[wallet]  createSignature{hashToDirectlySign: sighash}  → user sig     (PROMPT: drain)
      │
[TS client]  unlock = drain(amount, nonce, userSig, gatewaySig); place on input[0]
      ▼
POST /channels/submit-drain {signed_tx_hex}
      │   gateway: VerifyDrainTx → sign fee input[1] → broadcast ARC      ← GAP 2 (submit-drain does not sign the fee input yet)
      ▼
   drain-txid SEEN_ON_NETWORK
```

## 6. Seam-first milestone (ONE real deliverable)

**Goal:** `e2e-gopath-drain.ts` runs non-custodial — the wallet signs only the user sighash, no `PECKHOST_FEE_WIF` in the client.

Two precise fixes — **BOTH IMPLEMENTED + PROVEN ON-CHAIN 2026-06-02:**

- **GAP 1 — client ✅:** `e2e-gopath-drain.ts` replaces the local WIF re-sign with `POST /api/channels/cosign-drain` (rebuilt sighash → gateway sig). The fee input is now sent UNSIGNED. No more `PECKHOST_FEE_WIF`.
- **GAP 2 — gateway (peck-host) ✅:** `/open` captures the fee-fund UTXO (`fee_txid/fee_vout/fee_satoshi_value` → `ChannelOnChainState`). `SubmitDrain` calls `billing.GatewaySignFeeInput` (go-bt P2PKH, SIGHASH_ALL|FORKID) which signs fee input[1] with `PECKHOST_PRIVKEY` before broadcast.

**PROVEN ON MAINNET (the Go HTTP path, non-custodial):**
- deploy `97fd93be85fbf4df120e1ceac31e53bdb262541d3299b00fd8681a5e059e7293`
- drain `569ddd1b0cc6d9124c9d751c92769c656cd57382124a99c14965047a9190423f` (ARC 200)
- The wallet signed ONLY the user sighash; the gateway co-signed (`/cosign-drain`) + fee-signed (`/submit-drain`). Both the contract checkSig and the P2PKH fee input passed on-chain.

**LESSON (critical):** go-bt `GetInputSignatureHash` returns a reversed (little-endian) digest; OP_CHECKSIG wants the natural `Sha256d(preimage)`. You must sign `bt.ReverseBytes(sh)` (the way go-bt's own `InternalSigner` does) — otherwise ARC 461 NULLFAIL on the fee input. The contract-input sigs (TS getPreimage→sha256sha256→bsv/go-bk over the natural digest) are NOT affected; only the go-bt-built P2PKH fee signature.

**After the milestone** (not in this round): seed the `peck-channel` package (contract + spec + TS client + Go lib) around exactly this proven path; dedupe llm-gateway `internal/payment/*` against the Go lib; mirror FIX A to FetchPaymentChannel (peck-overlay-schema paywall).

## 7. The invariants that must not break

- Sighash parity (go-bt == scryptlib) — run `sighash-parity-check.ts` after any sighash change.
- The fee never changes (`never_touch_fee_rate`) — the mining fee is the gateway's cost, absorbed into margin.
- Both sigs are required for drain — the gateway can never drain the channel alone.
- Timeout is always the user's reclaim path — the channel can never lock funds permanently.
