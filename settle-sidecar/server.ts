/**
 * LLMPaymentChannel settle sidecar.
 *
 * A localhost-only Node service the llm-gateway (Go) calls at SETTLE TIME ONLY
 * (close / expiry / threshold) — never per request. It owns the scrypt-ts logic
 * for building + signing the contract's drain()/close()/timeout() spends, which
 * have no battle-tested Go equivalent (the c3 ANYONECANPAY_SINGLE preimage +
 * dual checkSig). The off-chain 402 tier (BRC-77 receipts + CAS) stays entirely
 * in the Go gateway; this is purely the on-chain anchor.
 *
 * NON-CUSTODIAL close()/timeout() — the canonical proven flow
 * (reference-walletsig-close.ts, mainnet close 628ac044, SEEN_ON_NETWORK):
 *
 *   PHASE 1 (prepare):  the GATEWAY builds the FIX-A spend (single contract input
 *     + payout outputs, fee taken FROM channel value, NO funding input, NO change
 *     — a wallet-authored close would append funding+change and break the
 *     SIGHASH_ALL hashOutputs assert). It computes the sighash = hash256 of the
 *     BIP143 preimage (scryptlib getPreimage) and returns it to the client. The
 *     user's private key NEVER touches the sidecar.
 *
 *   --- the CLIENT signs the sighash in its own BRC-100 wallet ---
 *     userSig = wallet.createSignature({ hashToDirectlySign: sighash,
 *               protocolID, keyID, counterparty:'self' }). The privkey stays in
 *     the wallet; only a DER signature comes back.
 *
 *   PHASE 2 (finalize): the gateway VERIFIES the signature locally against the
 *     userPubKey over the sighash (safety net — never risk funds on a bad sig),
 *     injects it as the close()/timeout() userSig via getUnlockingScript, and
 *     returns the fully-signed raw tx (the Go gateway broadcasts via ARC, or set
 *     SETTLE_BROADCAST=1 to have the sidecar POST to ARC directly).
 *
 * drain() stays dual-signed and is exercised by the jest oracle with the DEV
 * privkey path; the production drain() co-signing flow is a follow-up (the
 * gateway holds its own key in Secret Manager and the user co-signs via wallet,
 * same prepare/finalize split — TODO below).
 *
 * DEV/test privkey path: set SETTLE_ALLOW_PRIVKEY=1 to enable the legacy
 * one-shot endpoints that accept userPrivWIF/gatewayPrivWIF and sign in-process.
 * This is what the jest suite + local smoke tests use; it is REFUSED by default
 * so a misconfigured prod sidecar can never custody a user key.
 *
 * Run: BSV_NETWORK=testnet SETTLE_PORT=8094 npx ts-node settle-sidecar/server.ts
 */
import * as http from 'http'
import * as path from 'path'
import * as fs from 'fs'
import {
    bsv,
    TestWallet,
    DefaultProvider,
    PubKey,
    Sig,
    MethodCallOptions,
    ContractTransaction,
    findSig,
    SignatureResponse,
} from 'scrypt-ts'
import { getPreimage } from 'scryptlib'
import { LLMPaymentChannel } from '../src/contracts/LLMPaymentChannel'

const NETWORK =
    process.env.BSV_NETWORK === 'mainnet'
        ? bsv.Networks.mainnet
        : bsv.Networks.testnet // default testnet — NEVER mainnet during Phase 6
const PORT = Number(process.env.SETTLE_PORT || 8094)

// DEV-only: allow the legacy in-process privkey signing path (jest / local smoke).
// REFUSED by default — a prod sidecar must NEVER hold the user's private key.
const ALLOW_PRIVKEY = process.env.SETTLE_ALLOW_PRIVKEY === '1'

// Optional: let the sidecar broadcast finalized txs to ARC directly. By default
// it returns the raw hex and the Go gateway broadcasts via its broadcaster.Arc.
const BROADCAST = process.env.SETTLE_BROADCAST === '1'
const ARC_URL = process.env.SETTLE_ARC_URL || 'https://arc.gorillapool.io/v1/tx'

// SIGHASH_ALL | FORKID == 0x41 — the close()/timeout() sighash type (per
// reference-walletsig-close.ts, proven on mainnet).
const SIGHASH_ALL_FORKID =
    bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID

// Load the compiled artifact once at startup.
const artifactPath = path.join(
    __dirname,
    '..',
    'artifacts',
    'contracts',
    'LLMPaymentChannel.json'
)
LLMPaymentChannel.loadArtifact(JSON.parse(fs.readFileSync(artifactPath, 'utf8')))

// ─── Channel reconstruction ───────────────────────────────────────────────────
//
// A settle request carries the channel's immutable params + current state + the
// on-chain contract UTXO. TODO(prod): instead of trusting the posted state,
// fetch the live locking script via peck-indexer/overlay (NOT WhatsOnChain) and
// use LLMPaymentChannel.fromLockingScript() so amountSpent/paymentNonce come
// from chain. For now the gateway supplies them from its CAS state.
interface ChannelReq {
    userPubKey: string
    gatewayPubKey: string
    lockAmount: number // sats
    expiryTime: number // unix seconds
    amountSpent: number // current stateful value
    nonce: number // current paymentNonce
    utxo: { txId: string; outputIndex: number; satoshis: number; script: string }
    // FIX A: close()/timeout() take the fee FROM the channel value (no separate
    // fee input / change), so the gateway just supplies the fee amount. ~100
    // sat/kb on a ~6.3KB close tx ≈ 700 sats (proven on mainnet).
    fee?: number
    // DEV/test ONLY — present only on the legacy privkey path (SETTLE_ALLOW_PRIVKEY=1).
    userPrivWIF?: string
    gatewayPrivWIF?: string
}

/** Rebuild the contract instance + bind its on-chain UTXO. No keys required. */
function buildInstance(req: ChannelReq): LLMPaymentChannel {
    const instance = new LLMPaymentChannel(
        PubKey(req.userPubKey),
        PubKey(req.gatewayPubKey),
        BigInt(req.lockAmount),
        BigInt(req.expiryTime)
    )
    instance.amountSpent = BigInt(req.amountSpent)
    instance.paymentNonce = BigInt(req.nonce)

    // Bind the on-chain contract UTXO so buildContractInput() spends the real one.
    // scrypt-ts reads `from.tx.outputs[from.outputIndex]` (the .balance getter), so
    // the referenced tx must carry the channel OUTPUT at outputIndex — NOT an input.
    // We synthesize a stub prev-tx with the contract output at the right index and
    // set its id to the real funding txid so the spend references the live UTXO.
    const prevTx = new bsv.Transaction()
    for (let i = 0; i < req.utxo.outputIndex; i++) {
        // pad leading outputs so the contract lands at outputIndex
        prevTx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(''), satoshis: 0 }))
    }
    prevTx.addOutput(
        new bsv.Transaction.Output({
            script: bsv.Script.fromHex(req.utxo.script),
            satoshis: req.utxo.satoshis,
        })
    )
    // Pin the prev-tx id to the real funding txid so the input's prevTxId is correct.
    Object.defineProperty(prevTx, 'hash', { value: req.utxo.txId, configurable: true })
    ;(prevTx as any)._getHash = () => Buffer.from(req.utxo.txId, 'hex').reverse()
    instance.from = { tx: prevTx, outputIndex: req.utxo.outputIndex } as any
    return instance
}

function p2pkhFromPubKeyHex(pubKeyHex: string): bsv.Script {
    return bsv.Script.buildPublicKeyHashOut(
        bsv.Address.fromPublicKey(bsv.PublicKey.fromString(pubKeyHex), NETWORK)
    )
}

// ─── FIX-A tx construction (shared by prepare + finalize + DEV path) ──────────
//
// Mirrors reference-walletsig-close.ts and tests/LLMPaymentChannel.test.ts:
//   close():   [gateway P2PKH(amountSpent)?, user P2PKH(lockAmount-amountSpent-fee)?]
//   timeout(): [user P2PKH(lockAmount-fee)], nLockTime>=expiry, non-final input.
// No funding input, no change output — fee is implicit (input - sum(outputs)).

function buildCloseTx(req: ChannelReq, instance: LLMPaymentChannel): bsv.Transaction {
    const fee = req.fee ?? 0
    const gatewayAmount = req.amountSpent
    const userAmount = req.lockAmount - req.amountSpent - fee
    if (userAmount < 0) throw new Error('fee exceeds user balance')

    const tx = new bsv.Transaction().addInput(instance.buildContractInput())
    if (gatewayAmount > 0) {
        tx.addOutput(
            new bsv.Transaction.Output({
                script: p2pkhFromPubKeyHex(req.gatewayPubKey),
                satoshis: gatewayAmount,
            })
        )
    }
    if (userAmount > 0) {
        tx.addOutput(
            new bsv.Transaction.Output({
                script: p2pkhFromPubKeyHex(req.userPubKey),
                satoshis: userAmount,
            })
        )
    }
    return tx
}

function buildTimeoutTx(req: ChannelReq, instance: LLMPaymentChannel): bsv.Transaction {
    const fee = req.fee ?? 0
    const userAmount = req.lockAmount - fee
    if (userAmount <= 0) throw new Error('fee exceeds channel value')

    const tx = new bsv.Transaction()
        .addInput(instance.buildContractInput())
        .addOutput(
            new bsv.Transaction.Output({
                script: p2pkhFromPubKeyHex(req.userPubKey),
                satoshis: userAmount,
            })
        )
    // nLockTime must be >= expiryTime; the contract input sequence must be
    // non-final or nLockTime is ignored.
    tx.lockUntilDate(new Date((req.expiryTime + 1) * 1000))
    tx.inputs[0].sequenceNumber = 0xfffffffe
    return tx
}

/** sighash the client must sign in its wallet = hash256(BIP143 preimage). */
function closeSighash(tx: bsv.Transaction, lockingScript: bsv.Script, value: number): Buffer {
    const preimageHex = getPreimage(tx, lockingScript, value, 0, SIGHASH_ALL_FORKID)
    return bsv.crypto.Hash.sha256sha256(Buffer.from(preimageHex, 'hex'))
}

// ─── Phase 1: prepare (build FIX-A tx, return the sighash for the wallet) ─────

interface PrepareResp {
    op: 'close' | 'timeout'
    sighash: string // hex — the digest the client signs via createSignature{hashToDirectlySign}
    sighashBytes: number[] // same digest as a byte array (BRC-100 createSignature wants number[])
    sighashType: number // 0x41 — must be appended to the DER sig on finalize
    userPubKey: string // the client verifies this is the key it derived (BRC-42 child)
    txHex: string // unsigned FIX-A tx; echoed back on finalize to reconstruct deterministically
    lockingScript: string // contract locking script hex
    lockAmount: number // contract value (BIP143 amount)
    outputs: { satoshis: number; to: 'gateway' | 'user' }[]
}

function prepareClose(req: ChannelReq): PrepareResp {
    const instance = buildInstance(req)
    const tx = buildCloseTx(req, instance)
    const lockingScript = instance.lockingScript
    const sighash = closeSighash(tx, lockingScript, req.lockAmount)
    const fee = req.fee ?? 0
    const gatewayAmount = req.amountSpent
    const userAmount = req.lockAmount - req.amountSpent - fee
    const outputs: PrepareResp['outputs'] = []
    if (gatewayAmount > 0) outputs.push({ satoshis: gatewayAmount, to: 'gateway' })
    if (userAmount > 0) outputs.push({ satoshis: userAmount, to: 'user' })
    return {
        op: 'close',
        sighash: sighash.toString('hex'),
        sighashBytes: Array.from(sighash),
        sighashType: SIGHASH_ALL_FORKID,
        userPubKey: req.userPubKey,
        txHex: tx.toString(),
        lockingScript: lockingScript.toHex(),
        lockAmount: req.lockAmount,
        outputs,
    }
}

function prepareTimeout(req: ChannelReq): PrepareResp {
    const instance = buildInstance(req)
    const tx = buildTimeoutTx(req, instance)
    const lockingScript = instance.lockingScript
    const sighash = closeSighash(tx, lockingScript, req.lockAmount)
    const fee = req.fee ?? 0
    return {
        op: 'timeout',
        sighash: sighash.toString('hex'),
        sighashBytes: Array.from(sighash),
        sighashType: SIGHASH_ALL_FORKID,
        userPubKey: req.userPubKey,
        txHex: tx.toString(),
        lockingScript: lockingScript.toHex(),
        lockAmount: req.lockAmount,
        outputs: [{ satoshis: req.lockAmount - fee, to: 'user' }],
    }
}

// ─── Phase 2: finalize (verify the wallet sig, inject, optionally broadcast) ──

interface FinalizeReq {
    op: 'close' | 'timeout'
    // Echoed from the prepare response — the gateway resends these so finalize is
    // stateless. The tx is rebuilt from txHex; userPubKey/lockingScript/lockAmount
    // pin the verification + unlocking context.
    txHex: string
    lockingScript: string
    lockAmount: number
    userPubKey: string
    fee: number
    expiryTime?: number // required for timeout (drives nLockTime reconstruction)
    // The client's wallet signature over the prepare sighash. Either:
    //   signatureHex: raw DER hex (no sighash-type byte), OR
    //   signatureBytes: number[] DER (what BRC-100 createSignature returns).
    signatureHex?: string
    signatureBytes?: number[]
}

function reconstructTx(body: FinalizeReq): bsv.Transaction {
    // Rebuild from the raw hex. The contract input's prevout script/satoshis are
    // not carried in raw hex, so re-attach them from the locking script + amount
    // so getUnlockingScript can recompute the same preimage the client signed.
    const tx = new bsv.Transaction(body.txHex)
    const ls = bsv.Script.fromHex(body.lockingScript)
    tx.inputs[0].output = new bsv.Transaction.Output({
        script: ls,
        satoshis: body.lockAmount,
    })
    return tx
}

async function finalizeSpend(body: FinalizeReq): Promise<{ txid: string; tx: string; broadcast?: any }> {
    if (!body.txHex || !body.lockingScript || !body.userPubKey) {
        throw new Error('finalize requires txHex, lockingScript, userPubKey')
    }
    const sigBytes = body.signatureBytes
        ? Buffer.from(body.signatureBytes)
        : body.signatureHex
        ? Buffer.from(body.signatureHex, 'hex')
        : null
    if (!sigBytes) throw new Error('finalize requires signatureHex or signatureBytes')

    const tx = reconstructTx(body)
    const lockingScript = bsv.Script.fromHex(body.lockingScript)
    const userPubKey = bsv.PublicKey.fromString(body.userPubKey)

    // Recompute the sighash from the reconstructed tx and verify the client's
    // signature LOCALLY before broadcasting (safety net — funds reclaimable via
    // timeout if we abort). Mirrors reference-walletsig-close.ts step 5.
    const sighash = closeSighash(tx, lockingScript, body.lockAmount)
    const sigObj = bsv.crypto.Signature.fromDER(sigBytes)
    const ok = bsv.crypto.ECDSA.verify(sighash, sigObj, userPubKey)
    if (!ok) {
        throw new Error(
            'client wallet sig does NOT verify against userPubKey over the ' +
                `${body.op} sighash — aborting (funds reclaimable via timeout)`
        )
    }

    // Inject the verified sig as the contract's userSig via getUnlockingScript.
    const sigHex =
        sigBytes.toString('hex') + SIGHASH_ALL_FORKID.toString(16).padStart(2, '0')
    const instance = LLMPaymentChannel.fromLockingScript(
        body.lockingScript
    ) as LLMPaymentChannel
    const fee = BigInt(body.fee ?? 0)

    const unlock = await instance.getUnlockingScript(async (self: LLMPaymentChannel) => {
        self.to = { tx, inputIndex: 0 } as any
        if (body.op === 'timeout') {
            self.timeout(Sig(sigHex), fee)
        } else {
            self.close(Sig(sigHex), fee)
        }
    })
    tx.inputs[0].setScript(unlock)

    const txid = tx.id
    const rawHex = tx.toString()
    if (BROADCAST) {
        const res = await fetch(ARC_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rawTx: rawHex }),
        })
        const broadcast = { ok: res.ok, status: res.status, body: (await res.text()).slice(0, 600) }
        return { txid, tx: rawHex, broadcast }
    }
    return { txid, tx: rawHex }
}

// ─── DEV/test privkey path (jest oracle + local smoke) ────────────────────────
//
// Signs in-process with userPrivWIF/gatewayPrivWIF. REFUSED unless
// SETTLE_ALLOW_PRIVKEY=1. Kept so the existing test flow + a single-host smoke
// test work without driving a real BRC-100 wallet.

function reconstructWithKeys(req: ChannelReq): {
    instance: LLMPaymentChannel
    signer: TestWallet
    userPriv: bsv.PrivateKey
    gatewayPriv: bsv.PrivateKey
} {
    if (!ALLOW_PRIVKEY) {
        throw new Error(
            'privkey signing path disabled — set SETTLE_ALLOW_PRIVKEY=1 for DEV/test only. ' +
                'Production close/timeout is non-custodial: use /settle/close/prepare + /settle/close/finalize.'
        )
    }
    if (!req.userPrivWIF || !req.gatewayPrivWIF) {
        throw new Error('DEV privkey path requires userPrivWIF + gatewayPrivWIF')
    }
    const userPriv = bsv.PrivateKey.fromWIF(req.userPrivWIF)
    const gatewayPriv = bsv.PrivateKey.fromWIF(req.gatewayPrivWIF)
    const instance = buildInstance(req)
    const provider = new DefaultProvider({ network: NETWORK })
    const signer = new TestWallet([userPriv, gatewayPriv], provider)
    return { instance, signer, userPriv, gatewayPriv }
}

function p2pkhOf(priv: bsv.PrivateKey): bsv.Script {
    return bsv.Script.buildPublicKeyHashOut(
        bsv.Address.fromPublicKey(priv.publicKey, NETWORK)
    )
}

async function buildDrainDev(req: ChannelReq, drainAmount: number): Promise<string> {
    const { instance, signer, userPriv, gatewayPriv } = reconstructWithKeys(req)
    await instance.connect(signer)

    const next = instance.next()
    next.amountSpent = BigInt(req.amountSpent + drainAmount)
    next.paymentNonce = BigInt(req.nonce + 1)

    const { tx } = await instance.methods.drain(
        BigInt(drainAmount),
        BigInt(req.nonce),
        (sigResps: SignatureResponse[]) => findSig(sigResps, userPriv.publicKey),
        (sigResps: SignatureResponse[]) => findSig(sigResps, gatewayPriv.publicKey),
        {
            pubKeyOrAddrToSign: [userPriv.publicKey, gatewayPriv.publicKey],
            next: { instance: next, balance: req.lockAmount },
        } as MethodCallOptions<LLMPaymentChannel>
    )
    return tx.toString()
}

async function buildCloseDev(req: ChannelReq): Promise<string> {
    const { instance, signer, userPriv, gatewayPriv } = reconstructWithKeys(req)
    await instance.connect(signer)

    const fee = req.fee ?? 0
    const gatewayAmount = req.amountSpent
    const userAmount = req.lockAmount - req.amountSpent - fee

    instance.bindTxBuilder(
        'close',
        async (current: LLMPaymentChannel): Promise<ContractTransaction> => {
            const tx = new bsv.Transaction().addInput(current.buildContractInput())
            if (gatewayAmount > 0) {
                tx.addOutput(
                    new bsv.Transaction.Output({
                        script: p2pkhOf(gatewayPriv),
                        satoshis: gatewayAmount,
                    })
                )
            }
            if (userAmount > 0) {
                tx.addOutput(
                    new bsv.Transaction.Output({
                        script: p2pkhOf(userPriv),
                        satoshis: userAmount,
                    })
                )
            }
            return { tx, atInputIndex: 0, nexts: [] }
        }
    )

    const { tx } = await instance.methods.close(
        (sigResps: SignatureResponse[]) => findSig(sigResps, userPriv.publicKey),
        BigInt(fee),
        {
            pubKeyOrAddrToSign: [userPriv.publicKey],
            autoPayFee: false,
        } as MethodCallOptions<LLMPaymentChannel>
    )
    return tx.toString()
}

async function buildTimeoutDev(req: ChannelReq): Promise<string> {
    const { instance, signer, userPriv } = reconstructWithKeys(req)
    await instance.connect(signer)

    const fee = req.fee ?? 0
    instance.bindTxBuilder(
        'timeout',
        async (current: LLMPaymentChannel): Promise<ContractTransaction> => {
            const tx = new bsv.Transaction()
                .addInput(current.buildContractInput())
                .addOutput(
                    new bsv.Transaction.Output({
                        script: p2pkhOf(userPriv),
                        satoshis: req.lockAmount - fee,
                    })
                )
            tx.lockUntilDate(new Date((req.expiryTime + 1) * 1000))
            tx.inputs[0].sequenceNumber = 0xfffffffe
            return { tx, atInputIndex: 0, nexts: [] }
        }
    )

    const { tx } = await instance.methods.timeout(
        (sigResps: SignatureResponse[]) => findSig(sigResps, userPriv.publicKey),
        BigInt(fee),
        {
            pubKeyOrAddrToSign: [userPriv.publicKey],
            autoPayFee: false,
            lockTime: req.expiryTime + 1,
        } as MethodCallOptions<LLMPaymentChannel>
    )
    return tx.toString()
}

// ─── HTTP (localhost only) ────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let data = ''
        req.on('data', (c) => {
            data += c
            if (data.length > 1 << 20) reject(new Error('body too large'))
        })
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {})
            } catch (e) {
                reject(e)
            }
        })
    })
}

const server = http.createServer(async (req, res) => {
    const json = (code: number, obj: any) => {
        res.writeHead(code, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
    }
    try {
        if (req.method === 'GET' && req.url === '/health') {
            return json(200, {
                status: 'ok',
                network: NETWORK.name,
                privkeyPathEnabled: ALLOW_PRIVKEY,
                broadcast: BROADCAST,
            })
        }
        if (req.method !== 'POST') return json(405, { error: 'method not allowed' })

        const body = await readBody(req)
        switch (req.url) {
            // ── Non-custodial two-phase close/timeout (PRODUCTION) ──
            case '/settle/close/prepare':
                return json(200, prepareClose(body))
            case '/settle/close/finalize':
                return json(200, await finalizeSpend({ ...body, op: 'close' }))
            case '/settle/timeout/prepare':
                return json(200, prepareTimeout(body))
            case '/settle/timeout/finalize':
                return json(200, await finalizeSpend({ ...body, op: 'timeout' }))

            // ── DEV/test in-process privkey signing (SETTLE_ALLOW_PRIVKEY=1) ──
            case '/settle/drain':
                return json(200, { tx: await buildDrainDev(body, Number(body.drainAmount)) })
            case '/settle/close':
                return json(200, { tx: await buildCloseDev(body) })
            case '/settle/timeout':
                return json(200, { tx: await buildTimeoutDev(body) })

            default:
                return json(404, { error: 'not found' })
        }
    } catch (e: any) {
        return json(500, { error: String(e?.message || e) })
    }
})

// Bind to loopback ONLY — the gateway calls this over localhost; it must never be
// network-reachable (it builds spends + verifies signatures over channel funds).
server.listen(PORT, '127.0.0.1', () => {
    console.log(
        `settle-sidecar on 127.0.0.1:${PORT} (network=${NETWORK.name}, ` +
            `privkeyPath=${ALLOW_PRIVKEY ? 'ON' : 'off'}, broadcast=${BROADCAST ? 'ON' : 'off'})`
    )
})

// Exported for unit testing the pure builders without HTTP.
export {
    prepareClose,
    prepareTimeout,
    finalizeSpend,
    buildCloseTx,
    buildTimeoutTx,
    closeSighash,
    buildInstance,
}
