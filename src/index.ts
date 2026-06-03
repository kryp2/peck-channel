/**
 * peck-channel — the canonical BSV payment-channel primitive (contract + client lib + spec).
 *
 * Consumers: peck.run (peck-host), llm.peck.to, peck.fm, peck-overlay-schema paywall.
 * The reference gateway is peck-host; the protocol both TS and Go honour is in
 * PECK_CHANNEL_SPEC.md (drain proven non-custodial on mainnet: 97fd93be… / 569ddd1b…).
 */
export { LLMPaymentChannel } from './contracts/LLMPaymentChannel'
// FetchPaymentChannel — the per-fetch sibling variant (block-height expiry,
// strictly-monotonic nonce, off-chain X-Peck-Receipt drains). Re-homed from
// peck-overlay-schema 2026-06-03; mainnet-proven FIX-A.
export { FetchPaymentChannel } from './contracts/FetchPaymentChannel'
export * from './client'
