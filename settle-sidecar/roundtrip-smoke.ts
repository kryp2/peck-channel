/**
 * Local smoke test for the NON-CUSTODIAL prepare/finalize flow in server.ts.
 *
 * Simulates the client wallet locally: instead of WalletClient.createSignature,
 * we sign the prepare-returned sighash with a testnet privkey (the wallet would
 * sign the identical hashToDirectlySign digest). Proves prepare → sign → finalize
 * yields a fully-unlocked tx whose close()/timeout() assert PASSES — i.e. the
 * gateway never needs the user privkey, only a DER sig over the sighash.
 *
 * NOT a network test. No broadcast. Uses testnet keys (scrypt-ts artifacts are
 * network-agnostic for unlocking-script generation). Run:
 *   npx ts-node settle-sidecar/roundtrip-smoke.ts < /dev/null
 */
import { bsv } from 'scrypt-ts'
import {
    prepareClose,
    prepareTimeout,
    finalizeSpend,
    buildInstance,
} from './server'

const NET = bsv.Networks.testnet

function fakeUtxoFor(req: any): { txId: string; outputIndex: number; satoshis: number; script: string } {
    // The locking script for the channel UTXO == the contract's lockingScript.
    const instance = buildInstance({ ...req, utxo: { txId: '00'.repeat(32), outputIndex: 0, satoshis: req.lockAmount, script: '' } })
    return {
        txId: 'a'.repeat(64),
        outputIndex: 0,
        satoshis: req.lockAmount,
        script: instance.lockingScript.toHex(),
    }
}

/** Stand-in for wallet.createSignature({hashToDirectlySign}) — signs the digest directly. */
function walletSign(sighashHex: string, priv: bsv.PrivateKey): number[] {
    const digest = Buffer.from(sighashHex, 'hex')
    const sig = bsv.crypto.ECDSA.sign(digest, priv)
    return Array.from(sig.toDER() as Buffer)
}

async function roundtrip(label: string, kind: 'close' | 'timeout', amountSpent: number) {
    const userPriv = bsv.PrivateKey.fromRandom(NET)
    const gatewayPriv = bsv.PrivateKey.fromRandom(NET)
    const lockAmount = 10000
    const fee = 700
    const expiryTime =
        kind === 'timeout'
            ? Math.floor(Date.now() / 1000) - 3600 // past
            : Math.floor(Date.now() / 1000) + 86400

    const base = {
        userPubKey: userPriv.publicKey.toHex(),
        gatewayPubKey: gatewayPriv.publicKey.toHex(),
        lockAmount,
        expiryTime,
        amountSpent,
        nonce: 0,
        fee,
    }
    const req = { ...base, utxo: fakeUtxoFor(base) }

    // PHASE 1 (gateway): build FIX-A tx + return sighash.
    const prep = kind === 'close' ? prepareClose(req) : prepareTimeout(req)

    // CLIENT: sign the sighash in (simulated) wallet — privkey never left "the wallet".
    const sigBytes = walletSign(prep.sighash, userPriv)

    // PHASE 2 (gateway): verify + inject + (no broadcast here).
    const fin = await finalizeSpend({
        op: kind,
        txHex: prep.txHex,
        lockingScript: prep.lockingScript,
        lockAmount: prep.lockAmount,
        userPubKey: prep.userPubKey,
        fee,
        expiryTime,
        signatureBytes: sigBytes,
    })

    console.log(`✅ ${label}: txid=${fin.txid} outputs=${JSON.stringify(prep.outputs)}`)
    if (!fin.txid || fin.txid.length !== 64) throw new Error(`${label}: bad txid`)
    if (!fin.tx) throw new Error(`${label}: no raw tx`)
}

async function main() {
    await roundtrip('close (partial spend)', 'close', 3000)
    await roundtrip('close (zero spent → full refund)', 'close', 0)
    await roundtrip('timeout (expired → user reclaim)', 'timeout', 0)
    console.log('ALL ROUNDTRIPS OK — finalize injected wallet sig + close/timeout assert passed')
    process.exit(0) // server.ts import starts the HTTP listener; exit explicitly
}
main().catch((e) => {
    console.error('ROUNDTRIP-SMOKE-ERR:', e?.message || String(e))
    process.exit(1)
})
