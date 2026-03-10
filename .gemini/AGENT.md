# LLM Payment Channel — Agent Context

## What is this project?

An sCrypt smart contract for BSV that implements a **lock-and-drain payment channel** for the LLM Gateway. Users lock satoshis into the contract, the gateway drains per LLM API call, and the channel settles on-chain when closed or timed out.

## Current Status

**COMPLETE.** The contract is implemented, compiled, and tested. See `README.md` for the full overview.

| File | Status |
|------|--------|
| `src/contracts/LLMPaymentChannel.ts` | ✅ Done |
| `artifacts/contracts/LLMPaymentChannel.json` | ✅ Compiled artifact |
| `tests/LLMPaymentChannel.test.ts` | ✅ 10 test cases |
| `deploy.ts` | ✅ CLI deploy script |

## What the gateway still needs

Before end-to-end testing, `../llm-gateway/internal/payment/channel.go` must be created. It needs to:

1. Verify channel TXID is on-chain and has sufficient balance
2. Call `drain()` with co-signatures from both user and gateway
3. Track nonce in a local DB to prevent replay
4. Reject requests if drain fails

The gateway's `auth.go` already reads `X-Channel-ID` from the request header (TODO: validate on-chain is marked in the code). The `pricer.go` already calculates satoshi costs per call.

## Key Design Decisions

- `drain()` only updates `amountSpent` state — UTXO value stays constant at `lockAmount`
- `close()` performs the actual 2-output split (gateway + user)
- `paymentNonce` increments on every `drain()` for replay protection
- Both `userSig` + `gatewaySig` required for drain (mutual authorization)

## Tech Stack

- `scrypt-ts@1.4.5` — sCrypt TypeScript framework
- `@bsv/sdk@2.0.2` — BSV SDK
- `jest` + `ts-jest` — Testing

## Build & Run

```bash
npm install
npx scrypt-cli compile   # → artifacts/contracts/LLMPaymentChannel.json
npx jest --forceExit     # run tests (slow module init, ~30-60s)
```
