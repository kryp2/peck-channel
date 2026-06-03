import {
    SmartContract,
    method,
    prop,
    PubKey,
    Sig,
    assert,
    hash256,
    hash160,
    SigHash,
    ByteString,
    Utils,
    toByteString,
} from 'scrypt-ts'

/**
 * FetchPaymentChannel — Lock-and-Drain payment channel for
 * peck.to overlay read-side fetch-fees.
 *
 * Generalisation of LLMPaymentChannel for the peck-wide
 * "pay-per-fetch" model. See docs.peck.to/payments for the
 * full protocol; this contract is the on-chain half.
 *
 * Lifecycle:
 *
 * 1. OPEN   — Client locks N sats by deploying this contract.
 *             clientPubKey + serverPubKey are fixed at deploy.
 *             expiryHeight sets the block-height at which
 *             timeout() becomes valid (default: current + 144).
 *
 * 2. DRAIN  — (Optional) Server calls drain() with mutually
 *             signed state update. Normally all drains are
 *             off-chain via X-Peck-Receipt messages; drain()
 *             is only invoked to anchor state on-chain for a
 *             dispute or a periodic commit.
 *
 * 3. CLOSE  — Three paths:
 *             a) close() by client → server gets amountSpent,
 *                client gets lockAmount − amountSpent
 *             b) timeout() after expiryHeight → client
 *                reclaims full lockAmount
 *             c) close() with amountSpent == lockAmount →
 *                only server payout, no client remainder
 */
export class FetchPaymentChannel extends SmartContract {
    /** The client who funds the channel. */
    @prop()
    clientPubKey: PubKey

    /** The peck.to service identity. */
    @prop()
    serverPubKey: PubKey

    /** Total amount locked, in sats. Never changes in-channel. */
    @prop()
    lockAmount: bigint

    /** Running total drained. Monotonic increasing. */
    @prop(true)
    amountSpent: bigint

    /** Monotonic nonce. Increments on every on-chain drain. */
    @prop(true)
    nonce: bigint

    /**
     * Block-height at which timeout() becomes valid. Normally
     * set to deployHeight + 144 (~24h). sCrypt interprets
     * ctx.locktime < 500_000_000 as block-height.
     */
    @prop()
    expiryHeight: bigint

    constructor(
        clientPubKey: PubKey,
        serverPubKey: PubKey,
        lockAmount: bigint,
        expiryHeight: bigint,
    ) {
        super(...arguments)
        this.clientPubKey = clientPubKey
        this.serverPubKey = serverPubKey
        this.lockAmount = lockAmount
        this.amountSpent = 0n
        this.nonce = 0n
        this.expiryHeight = expiryHeight
    }

    /**
     * drain — Anchor a (newAmountSpent, newNonce) state update
     * on-chain.
     *
     * In the standard flow, drains are off-chain: client signs a
     * X-Peck-Receipt per fetch, server counter-signs, neither
     * party broadcasts. drain() is only used when one party needs
     * to force-commit state (before close() under dispute, or on
     * a periodic commit cadence).
     *
     * Both signatures required — neither party can unilaterally
     * alter balance.
     */
    @method(SigHash.ANYONECANPAY_SINGLE)
    public drain(
        newAmountSpent: bigint,
        newNonce: bigint,
        clientSig: Sig,
        serverSig: Sig,
    ) {
        assert(
            this.checkSig(clientSig, this.clientPubKey),
            'Invalid client signature',
        )
        assert(
            this.checkSig(serverSig, this.serverPubKey),
            'Invalid server signature',
        )

        // Monotonic nonce (replay protection)
        assert(newNonce > this.nonce, 'Nonce must strictly increase')

        // Monotonic spent (never refund in drain)
        assert(
            newAmountSpent >= this.amountSpent,
            'amountSpent cannot decrease',
        )

        // Cannot exceed lockAmount
        assert(
            newAmountSpent <= this.lockAmount,
            'amountSpent exceeds lockAmount',
        )

        this.amountSpent = newAmountSpent
        this.nonce = newNonce

        // Propagate the contract with updated state — UTXO value
        // unchanged; sats stay locked until close() or timeout().
        const outputs = this.buildStateOutput(this.ctx.utxo.value)
        assert(
            this.ctx.hashOutputs == hash256(outputs),
            'hashOutputs mismatch',
        )
    }

    /**
     * close — Settle the channel. Server receives amountSpent,
     * client receives the remainder. Only client signature
     * required — server is happy to be paid whatever state the
     * client is willing to commit (client cannot cheat server
     * because mutually-signed drains already bound amountSpent).
     *
     * FIX A (mirrors LLMPaymentChannel, proven on mainnet
     * 2026-06-01): the miner fee is taken FROM the channel value,
     * deducted from the client's refund. The spending TX therefore
     * has a SINGLE input (the contract UTXO) and exactly the
     * [server, client] payout outputs — NO separate funding input
     * and NO change output. The on-chain fee == fee ==
     * lockAmount − (serverAmount + clientAmount). This lets a
     * BRC-100 wallet author the close via createAction without the
     * wallet appending a funding input + change output that would
     * break this SIGHASH_ALL hashOutputs commitment.
     */
    @method()
    public close(clientSig: Sig, fee: bigint) {
        assert(
            this.checkSig(clientSig, this.clientPubKey),
            'Invalid client signature',
        )
        assert(fee >= 0n, 'fee must be non-negative')

        const serverAmount = this.amountSpent
        const clientAmount = this.lockAmount - this.amountSpent - fee
        assert(clientAmount >= 0n, 'fee exceeds client balance')

        let outputs: ByteString = toByteString('')

        if (serverAmount > 0n) {
            outputs += Utils.buildPublicKeyHashOutput(
                hash160(this.serverPubKey),
                serverAmount,
            )
        }

        if (clientAmount > 0n) {
            outputs += Utils.buildPublicKeyHashOutput(
                hash160(this.clientPubKey),
                clientAmount,
            )
        }

        assert(
            this.ctx.hashOutputs == hash256(outputs),
            'hashOutputs mismatch',
        )
    }

    /**
     * timeout — Client reclaims full deposit after expiryHeight.
     * Protects against server disappearance. Enforced via
     * nLockTime: the spending TX's locktime must be ≥ expiryHeight,
     * which miners will not include in a block before that
     * height.
     */
    @method()
    public timeout(clientSig: Sig, fee: bigint) {
        assert(
            this.checkSig(clientSig, this.clientPubKey),
            'Invalid client signature',
        )

        assert(
            this.ctx.locktime >= this.expiryHeight,
            'Channel not yet expired',
        )
        assert(fee >= 0n, 'fee must be non-negative')

        // Full refund to client, minus the miner fee taken from the
        // channel value (single input, no separate funding input /
        // change — see close() FIX A).
        const clientAmount = this.ctx.utxo.value - fee
        assert(clientAmount > 0n, 'fee exceeds channel value')
        const outputs = Utils.buildPublicKeyHashOutput(
            hash160(this.clientPubKey),
            clientAmount,
        )
        assert(
            this.ctx.hashOutputs == hash256(outputs),
            'hashOutputs mismatch',
        )
    }
}
