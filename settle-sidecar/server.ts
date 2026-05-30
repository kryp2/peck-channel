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
 * Call shapes mirror tests/LLMPaymentChannel.test.ts (the canonical oracle) and
 * the decoded mechanics:
 *   - drain():  SigHash 0xc3 (ANYONECANPAY|SINGLE|FORKID); dual sig over ONE
 *               preimage; nonce arg = CURRENT paymentNonce, next.paymentNonce+1;
 *               funds NOT moved (next output value == channel value), fee from a
 *               SEPARATE input.
 *   - close():  SigHash 0x41 (ALL|FORKID); distributes the FULL lockAmount as
 *               [gateway P2PKH(amountSpent), user P2PKH(remainder)], NO change
 *               output (would break hashOutputs), fee from a SEPARATE input.
 *   - timeout():SigHash 0x41; single user refund; needs nLockTime >= expiry and
 *               a non-final input sequence.
 *
 * STATUS: scaffold. Structurally complete + uses the validated call shapes, but
 * NOT yet testnet-validated (needs faucet UTXOs for the separate fee input and a
 * real chain read to reconstruct the live channel UTXO). Marked TODO(testnet).
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
import { LLMPaymentChannel } from '../src/contracts/LLMPaymentChannel'

const NETWORK =
    process.env.BSV_NETWORK === 'mainnet'
        ? bsv.Networks.mainnet
        : bsv.Networks.testnet // default testnet — NEVER mainnet during Phase 6
const PORT = Number(process.env.SETTLE_PORT || 8094)

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
// on-chain contract UTXO. TODO(testnet): instead of trusting the posted state,
// fetch the live locking script via peck-indexer/overlay (NOT WhatsOnChain) and
// use LLMPaymentChannel.fromLockingScript() so amountSpent/paymentNonce come
// from chain. For the scaffold the gateway supplies them from its CAS state.
interface ChannelReq {
    userPubKey: string
    gatewayPubKey: string
    lockAmount: number // sats
    expiryTime: number // unix seconds
    amountSpent: number // current stateful value
    nonce: number // current paymentNonce
    utxo: { txId: string; outputIndex: number; satoshis: number; script: string }
    // Signing material. TODO(prod): the gateway signs with ITS key from Secret
    // Manager and the USER signature arrives from the client; the sidecar should
    // never hold the user's private key outside testnet testing.
    userPrivWIF: string
    gatewayPrivWIF: string
    // Optional: a separate funding UTXO (user-owned) to pay the tx fee, since
    // drain/close distribute the full channel value. TODO(testnet): the gateway
    // selects this from a faucet/funding wallet.
    feeUtxo?: { txId: string; outputIndex: number; satoshis: number; script: string }
}

function reconstruct(req: ChannelReq): {
    instance: LLMPaymentChannel
    signer: TestWallet
    userPriv: bsv.PrivateKey
    gatewayPriv: bsv.PrivateKey
} {
    const userPriv = bsv.PrivateKey.fromWIF(req.userPrivWIF)
    const gatewayPriv = bsv.PrivateKey.fromWIF(req.gatewayPrivWIF)

    const instance = new LLMPaymentChannel(
        PubKey(req.userPubKey),
        PubKey(req.gatewayPubKey),
        BigInt(req.lockAmount),
        BigInt(req.expiryTime)
    )
    instance.amountSpent = BigInt(req.amountSpent)
    instance.paymentNonce = BigInt(req.nonce)

    // Bind the on-chain contract UTXO so buildContractInput() spends the real one.
    instance.from = {
        tx: new bsv.Transaction().from({
            txId: req.utxo.txId,
            outputIndex: req.utxo.outputIndex,
            satoshis: req.utxo.satoshis,
            script: req.utxo.script,
        }),
        outputIndex: req.utxo.outputIndex,
    } as any

    const provider = new DefaultProvider({ network: NETWORK })
    const signer = new TestWallet([userPriv, gatewayPriv], provider)
    return { instance, signer, userPriv, gatewayPriv }
}

function p2pkh(priv: bsv.PrivateKey): bsv.Script {
    return bsv.Script.buildPublicKeyHashOut(
        bsv.Address.fromPublicKey(priv.publicKey, NETWORK)
    )
}

// ─── Settle operations ──────────────────────────────────────────────────────

async function buildDrain(req: ChannelReq, drainAmount: number): Promise<string> {
    const { instance, signer, userPriv, gatewayPriv } = reconstruct(req)
    await instance.connect(signer)

    // State advance: amountSpent += drainAmount, paymentNonce += 1. The nonce ARG
    // is the CURRENT nonce; next carries current+1. Funds are NOT moved — next
    // output keeps the same channel value.
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
            // TODO(testnet): add the feeUtxo as a separate input; SIGHASH_SINGLE
            // only commits the same-index output so the fee input is safe.
        } as MethodCallOptions<LLMPaymentChannel>
    )
    return tx.toString()
}

async function buildClose(req: ChannelReq): Promise<string> {
    const { instance, signer, userPriv, gatewayPriv } = reconstruct(req)
    await instance.connect(signer)

    const gatewayAmount = req.amountSpent
    const userAmount = req.lockAmount - req.amountSpent

    // SIGHASH_ALL → the spending tx must commit EXACTLY [gateway?, user?] with no
    // change output. Bind a builder producing that set; the fee comes from a
    // SEPARATE funding input. (Validated against the contract's hashOutputs.)
    instance.bindTxBuilder(
        'close',
        async (current: LLMPaymentChannel): Promise<ContractTransaction> => {
            const tx = new bsv.Transaction().addInput(current.buildContractInput())
            if (gatewayAmount > 0) {
                tx.addOutput(
                    new bsv.Transaction.Output({
                        script: p2pkh(gatewayPriv),
                        satoshis: gatewayAmount,
                    })
                )
            }
            if (userAmount > 0) {
                tx.addOutput(
                    new bsv.Transaction.Output({
                        script: p2pkh(userPriv),
                        satoshis: userAmount,
                    })
                )
            }
            // TODO(testnet): add req.feeUtxo as a separate input + declare the fee
            // so the full lockAmount distributes with no change output.
            return { tx, atInputIndex: 0, nexts: [] }
        }
    )

    const { tx } = await instance.methods.close(
        (sigResps: SignatureResponse[]) => findSig(sigResps, userPriv.publicKey),
        {
            pubKeyOrAddrToSign: [userPriv.publicKey],
            autoPayFee: false,
        } as MethodCallOptions<LLMPaymentChannel>
    )
    return tx.toString()
}

async function buildTimeout(req: ChannelReq): Promise<string> {
    const { instance, signer, userPriv } = reconstruct(req)
    await instance.connect(signer)

    instance.bindTxBuilder(
        'timeout',
        async (current: LLMPaymentChannel): Promise<ContractTransaction> => {
            const tx = new bsv.Transaction()
                .addInput(current.buildContractInput())
                .addOutput(
                    new bsv.Transaction.Output({
                        script: p2pkh(userPriv),
                        satoshis: req.lockAmount,
                    })
                )
            // nLockTime must be >= expiryTime; the contract input sequence must be
            // non-final or nLockTime is ignored.
            tx.lockUntilDate(new Date((req.expiryTime + 1) * 1000))
            tx.inputs[0].sequenceNumber = 0xfffffffe
            return { tx, atInputIndex: 0, nexts: [] }
        }
    )

    const { tx } = await instance.methods.timeout(
        (sigResps: SignatureResponse[]) => findSig(sigResps, userPriv.publicKey),
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
            return json(200, { status: 'ok', network: NETWORK.name })
        }
        if (req.method !== 'POST') return json(405, { error: 'method not allowed' })

        const body = await readBody(req)
        let txHex: string
        switch (req.url) {
            case '/settle/drain':
                txHex = await buildDrain(body, Number(body.drainAmount))
                break
            case '/settle/close':
                txHex = await buildClose(body)
                break
            case '/settle/timeout':
                txHex = await buildTimeout(body)
                break
            default:
                return json(404, { error: 'not found' })
        }
        // Return the signed raw tx; the gateway broadcasts via go-sdk broadcaster.Arc
        // against a testnet ARC and checks (success, failure).
        return json(200, { tx: txHex })
    } catch (e: any) {
        return json(500, { error: String(e?.message || e) })
    }
})

// Bind to loopback ONLY — the gateway calls this over localhost; it must never be
// network-reachable (it builds signed spends).
server.listen(PORT, '127.0.0.1', () => {
    console.log(`settle-sidecar on 127.0.0.1:${PORT} (network=${NETWORK.name})`)
})
