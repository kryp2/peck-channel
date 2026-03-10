# LLM Payment Channel — Agent Context

## What is this project?

An sCrypt smart contract for BSV that implements a **lock-and-drain payment channel** for the LLM Gateway. Users lock satoshis into the contract, the gateway drains per LLM API call, and the channel settles on-chain when closed or timed out.

## Current Status

**Skeleton/scaffold only.** The contract structure is in place with documented methods and TODOs. The implementing agent needs to:

1. **Complete `drain()`**: Build proper UTXO outputs — propagate contract with reduced balance, or finalize if fully drained
2. **Complete `close()`**: Two-output TX — gateway gets amountSpent, user gets remainder
3. **Complete `timeout()`**: nLockTime verification + full refund to user
4. **Add replay protection**: Nonce or sequence number to prevent double-drain
5. **Write tests**: `tests/LLMPaymentChannel.test.ts`
6. **Write deploy script**: `deploy.ts`

## Key Files

- `src/contracts/LLMPaymentChannel.ts` — The main contract (has TODOs)
- `package.json` — Dependencies matching the existing `contracts/` project
- `tsconfig.json` — TypeScript/sCrypt compiler config

## Reference

- **Existing sCrypt patterns**: See `../contracts/src/contracts/Connect4.ts` for a working sCrypt contract example (game with stateful updates, similar pattern)
- **Deploy pattern**: See `../contracts/deploy_contract.ts` for how to deploy sCrypt contracts with `@bsv/sdk`
- **Full architecture plan**: `~/.gemini/antigravity/brain/8be22141-5e65-4dd2-a10c-7e33cd90a645/implementation_plan.md`

## How this fits together

```
User's BSV Wallet (bsv-desktop, localhost)
    │
    │ 1. Lock sats → deploy LLMPaymentChannel
    │ 2. Get channel_id (TXID)
    ▼
LLM Gateway (Go, ../llm-gateway/)
    │
    │ 3. Verify channel exists, check balance
    │ 4. Forward to LLM provider
    │ 5. Drain channel by cost_in_satoshi
    ▼
LLM Provider (OpenAI, Anthropic, Google...)
```

## Tech Stack

- `scrypt-ts@1.4.5` — sCrypt TypeScript framework
- `@bsv/sdk@2.0.2` — BSV SDK
- `@bsv/wallet-helper@0.0.5` — Wallet helpers
