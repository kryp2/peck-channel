/**
 * peck-channel client library — the wallet/consumer half of the payment-channel
 * primitive. Pair the gateway HTTP client with the channel ops to drive the proven
 * non-custodial drain flow against any peck.channel gateway (peck-host = reference).
 *
 * See ../../PECK_CHANNEL_SPEC.md for the protocol and the canonical drain flow.
 */
export * from './gateway'
export * from './channel'
