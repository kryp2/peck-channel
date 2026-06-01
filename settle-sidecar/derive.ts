/**
 * BRC-42 per-channel key derivation for BRC-100-native settlement.
 *
 * The channel's contract keys are NOT the parties' root identity keys (that was
 * the legacy P2PKH-to-root bug). Instead each party derives a fresh CHILD key
 * per channel via BRC-42 (KeyDeriver), keyed by a channel-scoped invoice
 * (protocolID + keyID = "<prefix> <suffix>") and the counterparty's identity.
 * close()/timeout() then pay P2PKH(hash160(derivedChild)) — a BRC-29-style
 * payment the recipient's wallet can rederive, discover (internalizeAction), and
 * spend. The SAME invoice derives the pubkey (fed into the contract at open) and
 * the privkey (used to sign/spend the payout), so a party can always spend what
 * it was paid.
 *
 * This module is the GATEWAY side: a local KeyDeriver over the gateway's own
 * identity key — no wallet UI. The client side derives its refund key in its own
 * BRC-100 wallet (getPublicKey/createSignature) symmetrically.
 */
import { KeyDeriver, PrivateKey, type WalletProtocol, type Counterparty } from '@bsv/sdk'

// protocolID for channel settlement keys (securityLevel 2 = per-counterparty).
export const CHANNEL_PROTOCOL: WalletProtocol = [2, 'peck channel']

export interface ChannelInvoice {
    /** Per-channel nonce chosen at open (the BRC-29 derivationPrefix). */
    prefix: string
    /** Leg selector, e.g. 'payout' (gateway) or 'refund' (client). */
    suffix: string
}

function keyID(inv: ChannelInvoice): string {
    return `${inv.prefix} ${inv.suffix}`
}

/** Derives the gateway's per-channel payout keys from its identity key. */
export class GatewayKeys {
    private deriver: KeyDeriver

    constructor(identityKey: PrivateKey | string) {
        const root =
            typeof identityKey === 'string'
                ? PrivateKey.fromHex(identityKey)
                : identityKey
        this.deriver = new KeyDeriver(root)
    }

    /** The derived payout PUBKEY (hex) fed into the contract as gatewayPubKey. */
    payoutPubKey(inv: ChannelInvoice, counterpartyIdentityHex: string): string {
        return this.deriver
            .derivePublicKey(
                CHANNEL_PROTOCOL,
                keyID(inv),
                counterpartyIdentityHex as Counterparty,
                true // forSelf: this is the gateway's own receiving key
            )
            .toString()
    }

    /** The matching derived PRIVKEY, used to sign the close() spend / take the payout. */
    payoutPrivKey(inv: ChannelInvoice, counterpartyIdentityHex: string): PrivateKey {
        return this.deriver.derivePrivateKey(
            CHANNEL_PROTOCOL,
            keyID(inv),
            counterpartyIdentityHex as Counterparty
        )
    }
}
