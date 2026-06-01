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
 * LLMPaymentChannel — Lock-and-Drain Payment Channel for LLM Gateway
 *
 * Lifecycle:
 * 1. OPEN:  User locks N satoshis into this contract (on-chain TX)
 *           Both userPubKey and gatewayPubKey are set at deployment
 *           expiryTime sets the channel timeout
 *
 * 2. DRAIN: Gateway calls drain() after each LLM API call
 *           Requires signatures from BOTH user and gateway
 *           amountSpent is incremented, contract UTXO value stays the same
 *           paymentNonce is incremented for replay protection
 *
 * 3. CLOSE: Three ways to close:
 *           a) close() by user → gateway gets amountSpent, user gets rest
 *           b) timeout() after expiry → user reclaims everything
 *           c) drain() fully drains → close() with zero user remainder
 */
export class LLMPaymentChannel extends SmartContract {
    // The user who funds the channel
    @prop()
    userPubKey: PubKey

    // The LLM gateway operator
    @prop()
    gatewayPubKey: PubKey

    // Total amount locked in the channel (in satoshis)
    @prop()
    lockAmount: bigint

    // Accumulated amount spent/drained (stateful — updated per drain)
    @prop(true)
    amountSpent: bigint

    // Replay protection nonce — incremented on every drain
    @prop(true)
    paymentNonce: bigint

    // Unix timestamp after which user can reclaim via timeout()
    @prop()
    expiryTime: bigint

    constructor(
        userPubKey: PubKey,
        gatewayPubKey: PubKey,
        lockAmount: bigint,
        expiryTime: bigint
    ) {
        super(...arguments)
        this.userPubKey = userPubKey
        this.gatewayPubKey = gatewayPubKey
        this.lockAmount = lockAmount
        this.amountSpent = 0n
        this.paymentNonce = 0n
        this.expiryTime = expiryTime
    }

    /**
     * drain — Gateway withdraws payment for an LLM call
     *
     * @param amount     - satoshis to drain for this call
     * @param nonce      - must match current paymentNonce (replay protection)
     * @param userSig    - user's signature authorizing the drain
     * @param gatewaySig - gateway's signature
     *
     * Both signatures required = mutual agreement on state update.
     * The new amountSpent must not exceed lockAmount.
     * The contract UTXO value stays the same — funds are only distributed on close().
     */
    @method(SigHash.ANYONECANPAY_SINGLE)
    public drain(amount: bigint, nonce: bigint, userSig: Sig, gatewaySig: Sig) {
        // Verify both signatures
        assert(this.checkSig(userSig, this.userPubKey), 'Invalid user signature')
        assert(
            this.checkSig(gatewaySig, this.gatewayPubKey),
            'Invalid gateway signature'
        )

        // Replay protection — nonce must match
        assert(nonce == this.paymentNonce, 'Invalid nonce')

        // Ensure positive drain amount
        assert(amount > 0n, 'Drain amount must be positive')

        // Update spent amount
        const newSpent = this.amountSpent + amount
        assert(newSpent <= this.lockAmount, 'Insufficient channel balance')
        this.amountSpent = newSpent

        // Increment nonce for next drain
        this.paymentNonce++

        // Propagate contract with updated state — UTXO value stays the same
        const outputs = this.buildStateOutput(this.ctx.utxo.value)
        assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
    }

    /**
     * close — User closes the channel, settling the balance
     *
     * Gateway receives amountSpent, user receives the remainder.
     * If amountSpent is 0, only user gets output. If fully drained, only gateway gets output.
     */
    @method()
    public close(userSig: Sig, fee: bigint) {
        assert(this.checkSig(userSig, this.userPubKey), 'Invalid user signature')
        assert(fee >= 0n, 'fee must be non-negative')

        const gatewayAmount = this.amountSpent
        // FIX A: the close fee is taken FROM the channel value (deducted from the
        // user's refund). The spending tx therefore has a SINGLE input (the
        // contract UTXO) and the [gateway, user] outputs only — NO separate fee
        // input and NO change output. The actual on-chain fee == fee ==
        // lockAmount - (gatewayAmount + userAmount). This lets a BRC-100 wallet
        // author the close via createAction without the wallet appending a change
        // output that would break this SIGHASH_ALL hashOutputs commitment.
        const userAmount = this.lockAmount - this.amountSpent - fee
        assert(userAmount >= 0n, 'fee exceeds user balance')

        let outputs: ByteString = toByteString('')

        // Gateway gets amountSpent (if any)
        if (gatewayAmount > 0n) {
            outputs += Utils.buildPublicKeyHashOutput(
                hash160(this.gatewayPubKey),
                gatewayAmount
            )
        }

        // User gets remainder minus the fee (if any)
        if (userAmount > 0n) {
            outputs += Utils.buildPublicKeyHashOutput(
                hash160(this.userPubKey),
                userAmount
            )
        }

        assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
    }

    /**
     * timeout — User reclaims all funds after channel expires
     *
     * Only callable after expiryTime has passed (enforced via nLockTime).
     * All funds go back to the user regardless of amountSpent.
     */
    @method()
    public timeout(userSig: Sig, fee: bigint) {
        assert(this.checkSig(userSig, this.userPubKey), 'Invalid user signature')

        // Enforce expiry via nLockTime
        assert(this.ctx.locktime >= this.expiryTime, 'Channel not yet expired')
        assert(fee >= 0n, 'fee must be non-negative')

        // Full refund to user, minus the close fee taken from channel value
        // (single input, no separate fee input / change — see close()).
        const userAmount = this.ctx.utxo.value - fee
        assert(userAmount > 0n, 'fee exceeds channel value')
        const outputs = Utils.buildPublicKeyHashOutput(
            hash160(this.userPubKey),
            userAmount
        )
        assert(this.ctx.hashOutputs == hash256(outputs), 'hashOutputs mismatch')
    }
}
