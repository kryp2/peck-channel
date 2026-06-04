# peck-channel

[![npm version](https://img.shields.io/npm/v/peck-channel.svg)](https://www.npmjs.com/package/peck-channel)
[![Tests](https://github.com/kryp2/peck-channel/actions/workflows/test.yml/badge.svg)](https://github.com/kryp2/peck-channel/actions/workflows/test.yml)
[![License](https://img.shields.io/badge/license-Open%20BSV-blue.svg)](LICENSE)

_Repo, dir and package are all `peck-channel` (renamed from `llm-payment-channel` 2026-06-03)._

The **canonical BSV payment-channel primitive** for the peck ecosystem: an sCrypt
**lock-and-drain payment channel** contract + a **non-custodial client library** +
the protocol spec. Users lock satoshis on-chain, a gateway drains per API call /
per compute-second, and the channel settles on close or timeout.

**Consumers:** peck.run (peck-host, compute per-second) · llm.peck.to (per-token) ·
peck.fm (HLS paywall) · peck-overlay-schema paywall. The reference gateway is
peck-host; the protocol both TS and Go honour is in **[`PECK_CHANNEL_SPEC.md`](./PECK_CHANNEL_SPEC.md)**.

> **Non-custodial, proven on mainnet** (deploy `97fd93be…` / drain `569ddd1b…`,
> ARC 200): the wallet signs only the user sighash; the gateway co-signs + fee-signs
> and broadcasts server-side. No private key ever crosses the boundary.

## Client library (`src/client`)

The wallet/consumer half of the proven flow, byte-identical to the on-chain proof:

```ts
import { WalletClient } from '@bsv/sdk'
import {
  PeckChannelGateway, loadContractArtifact, deployChannel,
  buildDrainSpend, walletSignSighash, assembleDrainUnlock,
} from 'peck-channel' // or '../src/client' in-repo

loadContractArtifact()
const w = new WalletClient('auto', 'my-app.peck.to')
const gw = new PeckChannelGateway('https://peck.run')

const ch = await deployChannel({ wallet: w, gatewayPubHex, lockAmount: 600, feeFund: 1400, keyId: 'k1' })
gw.setAuthPubKey(ch.userPubKey)
await gw.open({ channel_txid: ch.channelTxid, amount: 600, script_hex: ch.lockingScript.toHex(),
                satoshi_value: 600, vout: 0, user_pubkey: ch.userPubKey,
                fee_txid: ch.channelTxid, fee_vout: ch.feeVout, fee_satoshi_value: 1400 })
// …meter accrues PendingDrain in prod…
const { drain_amount, nonce } = (await gw.requestDrain(ch.channelTxid)).json!
const { drainTx, sighash } = buildDrainSpend(ch, drain_amount, nonce, 1300)
const { gateway_sig } = (await gw.cosignDrain(ch.channelTxid, sighash.toString('hex'))).json!
const userSig = await walletSignSighash(w, sighash, ch.userPubKey, { keyId: 'k1' })
await assembleDrainUnlock(ch.instance, drainTx, drain_amount, nonce, userSig, gateway_sig)
await gw.submitDrain(ch.channelTxid, drainTx.toString()) // gateway fee-signs + broadcasts
```

`settle-sidecar/e2e-gopath-drain.ts` drives exactly this and doubles as the on-chain
conformance test (`npm run drain-e2e`).

---

## Contract (sCrypt)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                       Client                            │
│  (peck-desktop, opencode, peck-web, etc.)               │
└────────────────────────┬────────────────────────────────┘
                         │
              1. Deploy LLMPaymentChannel
              2. Set channel_id (TXID) in X-Channel-ID header
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                  LLM Gateway (Go)                       │
│  internal/middleware/auth.go  → validates X-Channel-ID  │
│  internal/payment/pricer.go   → computes cost/sat       │
│  internal/payment/channel.go  → [MUST IMPLEMENT] drain  │
└────────────────────────┬────────────────────────────────┘
                         │
              3. Call drain() after LLM response
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                BSV blockchain (sCrypt)                  │
│  LLMPaymentChannel.ts — stateful UTXO                   │
└─────────────────────────────────────────────────────────┘
```

## Contract lifecycle

```
[OPEN]     User deploys contract with lockAmount satoshi
              │
              ├─→ drain(amount, nonce, userSig, gatewaySig)
              │      Increases amountSpent, nonce++ (replay protection)
              │      UTXO value stays lockAmount
              │      (Can be called many times)
              │
              ├─→ close(userSig)
              │      Gateway gets: amountSpent
              │      User gets:    lockAmount − amountSpent
              │
              └─→ timeout(userSig)   [only after expiryTime]
                     User gets: the entire lockAmount back
```

## Contract fields

| Field | Type | Stateful | Description |
|------|------|----------|-------------|
| `userPubKey` | PubKey | no | The user who funds the channel |
| `gatewayPubKey` | PubKey | no | The LLM Gateway operator |
| `lockAmount` | bigint | no | Total amount locked (satoshi) |
| `amountSpent` | bigint | **yes** | Accumulated spend (updated per drain) |
| `paymentNonce` | bigint | **yes** | Replay protection (incremented per drain) |
| `expiryTime` | bigint | no | Unix timestamp for channel expiry |

## Project structure

```
peck-channel/
├── src/contracts/
│   └── LLMPaymentChannel.ts    ← Smart contract (done)
├── tests/
│   └── LLMPaymentChannel.test.ts ← Jest test suite (10 tests)
├── artifacts/contracts/
│   └── LLMPaymentChannel.json  ← Compiled artifact (auto-generated)
├── deploy.ts                   ← Deploy script (CLI)
├── jest.config.js
├── package.json
└── tsconfig.json
```

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Compile the contract

```bash
npm run build
# → artifacts/contracts/LLMPaymentChannel.json
```

### 3. Run the tests

```bash
npx jest --forceExit
```

> **Note:** scrypt-ts takes a long time to initialize in some environments. Tests may take 30–60 sec.

### 4. Deploy a payment channel

```bash
ts-node deploy.ts \
  <userPrivKeyWIF> \
  <gatewayPubKeyHex> \
  <lockAmountSats> \
  [expirySeconds]
```

Example:
```bash
ts-node deploy.ts \
  "L1xxxxxx..." \
  "02abcdef..." \
  50000 \
  86400
```

Output (JSON):
```json
{
  "status": "success",
  "channelId": "abc123txid...",
  "lockAmount": 50000,
  "expiryTime": 1741654800,
  "userPubKey": "02...",
  "gatewayPubKey": "02..."
}
```

## Integration with the LLM Gateway

The channel's `channelId` (TXID) is sent as the `X-Channel-ID` header to the gateway:

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Channel-ID: abc123txid..." \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hi!"}]}'
```

### What is already in place in the gateway

| Gateway code | Status | Description |
|---|---|---|
| `middleware/auth.go` | ✅ Skeleton | Reads `X-Channel-ID`, TODO: on-chain validation |
| `payment/pricer.go` | ✅ Done | Computes cost in satoshi from token usage |
| `payment/channel.go` | ❌ Missing | The actual `drain()` call from Go → BSV |

### Next steps for the gateway integration

The gateway needs an `internal/payment/channel.go` that:

1. **Verifies the channel** — checks that the TXID is on-chain and has enough balance
2. **Calls `drain()`** — signs the transaction and broadcasts it
3. **Tracks the nonce** — stores the latest nonce in a local DB to avoid replay
4. **Fallback** — rejects the request if the drain fails

```go
// Pseudo-Go — what the gateway needs
type Channel struct {
    TXID        string
    LockAmount  int64
    AmountSpent int64
    Nonce       int64
}

func (c *ChannelManager) Drain(channelID string, satoshi int64) error {
    // 1. Fetch channel from DB / BSV node
    // 2. Build drain() TX with both signatures
    // 3. Broadcast TX
    // 4. Update local nonce + amountSpent
}
```

## Replay protection

Every `drain()` call requires that `nonce` matches the contract's `paymentNonce`. After a drain the nonce is incremented on-chain. This ensures old drain transactions cannot be reused (replay attacks).

```
Drain #1: nonce=0 → after: paymentNonce=1
Drain #2: nonce=1 → after: paymentNonce=2
Attempt to replay Drain #1: nonce=0 → REJECTED
```

## Security considerations

> [!WARNING]
> **Both parties must sign `drain()`** — the gateway cannot drain the channel without the user's approval. The user signature should happen in the client's wallet (peck-desktop/bsv-desktop) so the gateway never sees private keys.

> [!IMPORTANT]
> **Timeout** is the user's safety valve. If the gateway stops responding, the user can always reclaim the funds after `expiryTime`.

> [!NOTE]
> **Minimum lockAmount** should be large enough to cover several calls. Recommended: at least 10,000 sat (≈ a few cents) to avoid frequent redeployment.

## Dependencies

| Package | Version | Use |
|---|---|---|
| `scrypt-ts` | ^1.4.5 | sCrypt TypeScript framework |
| `@bsv/sdk` | ^2.0.2 | BSV SDK (TX building, signing) |
| `@bsv/wallet-helper` | ^0.0.5 | Wallet helpers |
| `jest` + `ts-jest` | ^29.x | Test runner |

## References

- **Existing contract pattern:** `../contracts/src/contracts/Connect4.ts`
- **Deploy pattern:** `../contracts/deploy_contract.ts`
- **Gateway:** `../llm-gateway/`
- **sCrypt documentation:** https://docs.scrypt.io
