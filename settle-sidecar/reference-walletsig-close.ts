/**
 * REFERENCE — non-custodial wallet-signed channel close, PROVEN ON MAINNET.
 *
 * This is the canonical end-to-end flow for closing an LLMPaymentChannel without
 * the user's private key ever leaving their BRC-100 wallet:
 *
 *   1. userPubKey = a BRC-42-derived child of the user's identity
 *      (getPublicKey {protocolID, keyID, counterparty:'self', forSelf:true}) —
 *      NOT the root identity key, NOT a static P2PKH-to-root (the legacy bug).
 *   2. The user funds the contract directly via wallet createAction (deploy).
 *   3. The GATEWAY builds the FIX-A close tx (single contract input + [user]
 *      output, fee from channel value, NO change — a wallet-authored close would
 *      append a change output that breaks close()'s SIGHASH_ALL hashOutputs).
 *   4. The user signs the close SIGHASH (hash256 of the BIP143 preimage) in their
 *      wallet via createSignature({hashToDirectlySign}). hashToDirectlySign signs
 *      the pre-hashed digest directly, so the signature verifies against the
 *      derived pubkey under checkSig.
 *   5. Verify the signature LOCALLY before broadcasting (safety net), inject it as
 *      the close() userSig via getUnlockingScript, broadcast via ARC.
 *
 * Proven 2026-06-01 on mainnet: deploy cfe76859…, close 628ac044… (SEEN_ON_NETWORK,
 * close() assert passed with the wallet-produced signature). Spike harness — the
 * production sidecar (server.ts) should adopt this in place of the userPrivWIF path.
 */
import { bsv, PubKey, Sig } from 'scrypt-ts'
import { getPreimage } from 'scryptlib'
import { WalletClient, Transaction as SdkTx } from '@bsv/sdk'
import { LLMPaymentChannel } from '../src/contracts/LLMPaymentChannel'
import * as fs from 'fs'
import * as path from 'path'

const NET = bsv.Networks.mainnet
const PROTOCOL: [number, string] = [2, 'peck channel']
const KEYID = 'spike-nonce-1 refund'
const SIGHASH_ALL_FORKID = bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID // 0x41
const LOCK = 2500, FEE = 700

async function arc(rawHex: string) {
  const res = await fetch('https://arc.gorillapool.io/v1/tx', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rawTx: rawHex }),
  })
  return { ok: res.ok, body: await res.text() }
}

async function main() {
  LLMPaymentChannel.loadArtifact(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'LLMPaymentChannel.json'), 'utf8')))
  const w = new WalletClient('auto', 'llm-gateway-spike.peck.to')

  // userPubKey = wallet-derived refund child (wallet owns the priv; signs via createSignature).
  const userPubKey = (await w.getPublicKey({ protocolID: PROTOCOL as any, keyID: KEYID, counterparty: 'self', forSelf: true })).publicKey
  const gatewayPriv = bsv.PrivateKey.fromRandom(NET) // gateway leg (amountSpent=0 → unused here)
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 86400)

  const instance = new LLMPaymentChannel(PubKey(userPubKey), PubKey(gatewayPriv.publicKey.toHex()), BigInt(LOCK), expiry)
  const lockingScript = instance.lockingScript

  // ── Phase 1: deploy via wallet (prompt #1) ──
  console.log('deploying channel (userPubKey = wallet-derived child)...')
  const dep = await w.createAction({
    description: 'Deploy LLM channel (wallet-sig spike)',
    outputs: [{ lockingScript: lockingScript.toHex(), satoshis: LOCK, outputDescription: 'channel deposit' }],
    options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
  })
  console.log('deploy txid:', dep.txid)
  const deployTx = new bsv.Transaction(SdkTx.fromAtomicBEEF(dep.tx as number[]).toHex())

  // ── Phase 2: gateway builds FIX-A close, wallet signs the sighash ──
  instance.from = { tx: deployTx, outputIndex: 0 } as any
  const userAmount = LOCK - FEE // amountSpent=0 → full refund minus fee
  const userP2PKH = bsv.Script.buildPublicKeyHashOut(bsv.Address.fromPublicKey(bsv.PublicKey.fromString(userPubKey), NET))
  const closeTx = new bsv.Transaction()
    .addInput(instance.buildContractInput())
    .addOutput(new bsv.Transaction.Output({ script: userP2PKH, satoshis: userAmount }))

  const preimageHex = getPreimage(closeTx, lockingScript, LOCK, 0, SIGHASH_ALL_FORKID)
  const sighash = bsv.crypto.Hash.sha256sha256(Buffer.from(preimageHex, 'hex'))
  console.log('close sighash:', sighash.toString('hex'))

  console.log('requesting wallet signature over the close sighash (prompt #2)...')
  const { signature } = await w.createSignature({ hashToDirectlySign: Array.from(sighash), protocolID: PROTOCOL as any, keyID: KEYID, counterparty: 'self' })

  // SAFETY NET: verify locally BEFORE broadcasting (don't risk funds on a bad sig).
  const sigObj = bsv.crypto.Signature.fromDER(Buffer.from(signature))
  const ok = bsv.crypto.ECDSA.verify(sighash, sigObj, bsv.PublicKey.fromString(userPubKey))
  if (!ok) throw new Error('wallet sig does NOT verify against userPubKey over the close sighash — aborting (funds reclaimable via timeout)')
  console.log('✅ wallet sig verifies locally against userPubKey — building unlock + broadcasting')

  const sigHex = Buffer.from(signature).toString('hex') + SIGHASH_ALL_FORKID.toString(16).padStart(2, '0')
  const unlock = await instance.getUnlockingScript(async (self: LLMPaymentChannel) => {
    self.to = { tx: closeTx, inputIndex: 0 } as any
    self.close(Sig(sigHex), BigInt(FEE))
  })
  closeTx.inputs[0].setScript(unlock)
  console.log(`close tx ${closeTx.id} | inputs ${closeTx.inputs.length} outputs ${closeTx.outputs.length}`)

  const r = await arc(closeTx.toString())
  console.log('ARC ok=' + r.ok + ':', r.body.slice(0, 400))
}
main().catch((e) => { console.error('WALLETSIG-CLOSE-ERR:', e?.message || String(e)); process.exit(1) })
