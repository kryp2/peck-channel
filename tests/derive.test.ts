import { PrivateKey } from '@bsv/sdk'
import { GatewayKeys, ChannelInvoice } from '../settle-sidecar/derive'

describe('BRC-42 channel key derivation (gateway side)', () => {
    const gatewayIdentity = PrivateKey.fromRandom()
    const clientIdentityHex = PrivateKey.fromRandom().toPublicKey().toString()
    const gw = new GatewayKeys(gatewayIdentity)
    const inv: ChannelInvoice = { prefix: 'chan-nonce-1', suffix: 'payout' }

    it('derived payout pubkey matches the derived payout privkey (gateway can spend its payout)', () => {
        const pub = gw.payoutPubKey(inv, clientIdentityHex)
        const priv = gw.payoutPrivKey(inv, clientIdentityHex)
        expect(priv.toPublicKey().toString()).toBe(pub)
        // And it is NOT the raw root identity key (the whole point — no legacy reuse).
        expect(pub).not.toBe(gatewayIdentity.toPublicKey().toString())
    })

    it('different invoice (suffix) derives a different key — per-leg uniqueness', () => {
        const payout = gw.payoutPubKey(inv, clientIdentityHex)
        const refundLeg = gw.payoutPubKey({ ...inv, suffix: 'refund' }, clientIdentityHex)
        expect(payout).not.toBe(refundLeg)
    })

    it('different channel nonce (prefix) derives a different key — per-channel uniqueness', () => {
        const a = gw.payoutPubKey(inv, clientIdentityHex)
        const b = gw.payoutPubKey({ ...inv, prefix: 'chan-nonce-2' }, clientIdentityHex)
        expect(a).not.toBe(b)
    })

    it('different counterparty derives a different key (BRC-42 ECDH binds the counterparty)', () => {
        const otherClientHex = PrivateKey.fromRandom().toPublicKey().toString()
        const a = gw.payoutPubKey(inv, clientIdentityHex)
        const b = gw.payoutPubKey(inv, otherClientHex)
        expect(a).not.toBe(b)
    })
})
