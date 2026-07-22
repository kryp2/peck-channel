/*
 * verify-sighash-pinning.cjs
 *
 * Script-level verification of the Chronicle/OTDA sighash-pinning (nVersion +
 * nHashType) added to the OP_PUSH_TX covenants in LLMPaymentChannel and
 * FetchPaymentChannel. Mirrors the sibling test in peck-contracts PR #2
 * (scripts/verify-sighash-pinning.cjs) — runs against the COMPILED artifacts
 * with scryptlib's bsv-interpreter, so no scrypt-ts test rig is needed.
 *
 *   node scripts/verify-sighash-pinning.cjs   (or: bun scripts/verify-sighash-pinning.cjs)
 *
 * Covers close() (SigHash ALL / 0x41) and drain() (SigHash
 * ANYONECANPAY_SINGLE / 0xc3) on BOTH channel contracts:
 *   [+] positive: nVersion=1, correct nHashType  -> ACCEPT (proves 41000000/c3000000 are the RIGHT constants)
 *   [-] negative: nVersion=2                      -> REJECT (the NEW nVersion pin fires: fails at OP_EQUALVERIFY;
 *                                                            the built-in checkPreimage does NOT check version)
 *   [-] negative: nHashType tail swapped to 0xe3  -> REJECT (OTDA attempt; already caught by the built-in
 *                                                            checkPreimage at OP_CHECKSIG — the "belt" half)
 *
 * Honest note: the 0xe3 rejection is stock checkPreimageSigHashType behaviour
 * (the constructed sig hardcodes the sighash byte OP_CHECKSIG validates), NOT
 * the new slice pin — exactly as peck-contracts PR #2 documented. The nVersion=2
 * rejection is the case the new pin uniquely adds.
 */
const path = require('path')
const sl = require('scryptlib')
const {
    buildContractClass,
    bsv,
    getPreimage,
    signTx,
    toHex,
    PubKey,
    Sig,
    SigHashPreimage,
    DEFAULT_FLAGS,
} = sl

const SIGHASH_ALL = 0x41
const SIGHASH_ANYONECANPAY_SINGLE = 0xc3
const INPUT_SATS = 10000
const FEE = 14

function loadContract(name) {
    const artifact = require(path.join(__dirname, '..', 'artifacts', 'contracts', name + '.json'))
    return buildContractClass(artifact)
}

function pkh(pub) {
    return bsv.crypto.Hash.sha256ripemd160(pub.toBuffer()).toString('hex')
}

function newInput(lockingScript) {
    return new bsv.Transaction.Input({
        prevTxId: '00'.repeat(32),
        outputIndex: 0,
        script: new bsv.Script(),
        sequenceNumber: 0xfffffffe,
    })
}

let pass = 0,
    fail = 0
function check(name, cond) {
    if (cond) {
        pass++
        console.log('  PASS  ' + name)
    } else {
        fail++
        console.log('  FAIL  ' + name)
    }
}

// ─── close() — SigHash ALL (0x41) ─────────────────────────────────────────────
// amountSpent==0 → single client/user refund output = INPUT_SATS − FEE.
function makeCloseResult(Contract, ctorArgs, spenderPriv) {
    return function closeResult({ version, tamperTailTo }) {
        const inst = new Contract(...ctorArgs)
        inst.amountSpent = 0n
        inst.paymentNonce = 0n // FetchPaymentChannel calls this `nonce`; scryptlib keys by stateProps order
        inst.nonce = 0n
        const lockingScript = inst.lockingScript

        const tx = new bsv.Transaction()
        tx.addInput(newInput(lockingScript), lockingScript, INPUT_SATS)
        tx.addOutput(
            new bsv.Transaction.Output({
                script: bsv.Script.fromHex('76a914' + pkh(spenderPriv.publicKey) + '88ac'),
                satoshis: INPUT_SATS - FEE,
            }),
        )
        tx.version = version
        tx.nLockTime = 0

        let preimageHex = toHex(getPreimage(tx, lockingScript, INPUT_SATS, 0, SIGHASH_ALL, DEFAULT_FLAGS))
        const sig = signTx(tx, spenderPriv, lockingScript, INPUT_SATS, 0, SIGHASH_ALL, DEFAULT_FLAGS)
        if (tamperTailTo) preimageHex = preimageHex.slice(0, -8) + tamperTailTo
        return inst
            .close(Sig(sig), FEE, SigHashPreimage(preimageHex))
            .verify({ tx, inputIndex: 0, inputSatoshis: INPUT_SATS })
    }
}

// ─── drain() — SigHash ANYONECANPAY_SINGLE (0xc3) ─────────────────────────────
// value stays locked; output0 = next-state contract script @ INPUT_SATS.
// The two contracts differ in drain semantics + state-prop names, so the caller
// supplies both the method args and the resulting next-state object:
//   LLMPaymentChannel:   drain(amount=100, nonce=0)   → {amountSpent:100n, paymentNonce:1n}
//   FetchPaymentChannel: drain(newSpent=100, newNonce=1) → {amountSpent:100n, nonce:1n}
function makeDrainResult(Contract, ctorArgs, clientPriv, serverPriv, drainArgs, nextState) {
    return function drainResult({ version, tamperTailTo }) {
        const inst = new Contract(...ctorArgs)
        for (const k of Object.keys(nextState)) inst[k] = 0n // start from zeroed state
        const lockingScript = inst.lockingScript
        const nextScript = inst.getNewStateScript(nextState)

        const tx = new bsv.Transaction()
        tx.addInput(newInput(lockingScript), lockingScript, INPUT_SATS)
        tx.addOutput(new bsv.Transaction.Output({ script: nextScript, satoshis: INPUT_SATS }))
        tx.version = version
        tx.nLockTime = 0

        let preimageHex = toHex(
            getPreimage(tx, lockingScript, INPUT_SATS, 0, SIGHASH_ANYONECANPAY_SINGLE, DEFAULT_FLAGS),
        )
        const clientSig = signTx(tx, clientPriv, lockingScript, INPUT_SATS, 0, SIGHASH_ANYONECANPAY_SINGLE, DEFAULT_FLAGS)
        const serverSig = signTx(tx, serverPriv, lockingScript, INPUT_SATS, 0, SIGHASH_ANYONECANPAY_SINGLE, DEFAULT_FLAGS)
        if (tamperTailTo) preimageHex = preimageHex.slice(0, -8) + tamperTailTo
        return inst
            .drain(drainArgs[0], drainArgs[1], Sig(clientSig), Sig(serverSig), SigHashPreimage(preimageHex))
            .verify({ tx, inputIndex: 0, inputSatoshis: INPUT_SATS })
    }
}

function runFor(label, contractName, drainArgs, nextState) {
    console.log('\n=== ' + label + ' (' + contractName + ') ===')
    const Contract = loadContract(contractName)
    const kA = bsv.PrivateKey.fromRandom()
    const kB = bsv.PrivateKey.fromRandom()
    // Both contracts share the ctor shape: (pubA, pubB, lockAmount, expiry).
    const ctorArgs = [PubKey(toHex(kA.publicKey)), PubKey(toHex(kB.publicKey)), INPUT_SATS, 800000]

    // close() — only the funding party (client/user == kA) signs. SigHash ALL.
    const closeResult = makeCloseResult(Contract, ctorArgs, kA)
    check('close positive (v1, 0x41) ACCEPT', closeResult({ version: 1 }).success === true)
    check('close negative (v2 nVersion-pin) REJECT', closeResult({ version: 2 }).success === false)
    check('close negative (tail 0xe3 / OTDA) REJECT', closeResult({ version: 1, tamperTailTo: 'e3000000' }).success === false)

    // drain() — both parties (kA + kB) sign; ACP_SINGLE (0xc3).
    const drainResult = makeDrainResult(Contract, ctorArgs, kA, kB, drainArgs, nextState)
    check('drain positive (v1, 0xc3) ACCEPT', drainResult({ version: 1 }).success === true)
    check('drain negative (v2 nVersion-pin) REJECT', drainResult({ version: 2 }).success === false)
    check('drain negative (tail 0xe3 / OTDA) REJECT', drainResult({ version: 1, tamperTailTo: 'e3000000' }).success === false)
}

// LLMPaymentChannel.drain(amount, nonce): nonce must == paymentNonce(0), amount is the increment.
runFor('LLMPaymentChannel', 'LLMPaymentChannel', [100, 0], { amountSpent: 100n, paymentNonce: 1n })
// FetchPaymentChannel.drain(newAmountSpent, newNonce): newNonce must be > nonce(0), newAmountSpent is absolute.
runFor('FetchPaymentChannel', 'FetchPaymentChannel', [100, 1], { amountSpent: 100n, nonce: 1n })

console.log('\n' + pass + ' passing, ' + fail + ' failing')
process.exit(fail === 0 ? 0 : 1)
