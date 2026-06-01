/**
 * REFERENCE — non-custodial wallet-signed channel DRAIN, PROVEN ON MAINNET.
 *
 * Proven 2026-06-01: deploy 71fea273…, drain a63031b0… (SEEN_ON_NETWORK, ARC 200).
 * State continuation amountSpent 0->50, nonce 0->1, channel value constant; both
 * userSig + gatewaySig verified under drain()'s dual checkSig. Fee from a SEPARATE
 * funding input (drain forces the state output to equal full channel value).
 *
 * Sibling of reference-walletsig-close.ts, but for drain() — which is harder:
 *   - sighash type = ANYONECANPAY_SINGLE | FORKID (0xc3), NOT SIGHASH_ALL.
 *   - drain() requires BOTH userSig AND gatewaySig over that sighash.
 *   - the committed output is a STATE CONTINUATION (next contract instance with
 *     amountSpent += amount, paymentNonce + 1, SAME utxo value) via
 *     buildStateOutput(this.ctx.utxo.value) — not a payout P2PKH.
 *
 * Flow:
 *   1. userPubKey = BRC-42 child (wallet getPublicKey{counterparty:self,forSelf}).
 *   2. User funds the channel via wallet createAction (deploy)        [PROMPT #1]
 *   3. Gateway builds the drain tx: contract input + next-state output (same value).
 *   4. Compute the ANYONECANPAY_SINGLE sighash over that tx.
 *   5. User signs the sighash in-wallet (createSignature{hashToDirectlySign}) [PROMPT #2]
 *   6. Gateway signs the SAME sighash with its ephemeral key.
 *   7. Verify BOTH sigs locally; inject via getUnlockingScript; broadcast via ARC.
 *
 * SAFETY: a malformed drain is rejected by ARC (no funds move); the deploy is
 * reclaimable via timeout() after expiry. We also verify both sigs + build the
 * unlocking script locally BEFORE broadcasting, so we never attempt a bad spend.
 */
import { bsv, PubKey, Sig } from 'scrypt-ts'
import { getPreimage } from 'scryptlib'
import { WalletClient, Transaction as SdkTx } from '@bsv/sdk'
import { LLMPaymentChannel } from '../src/contracts/LLMPaymentChannel'
import * as fs from 'fs'
import * as path from 'path'

const NET = bsv.Networks.mainnet
const PROTOCOL: [number, string] = [2, 'peck channel']
const KEYID = 'spike-drain-1'
// ANYONECANPAY_SINGLE | FORKID = 0x80 | 0x03 | 0x40 = 0xc3 (the drain() @method sighash)
const ACP_SINGLE_FORKID =
  bsv.crypto.Signature.SIGHASH_ANYONECANPAY |
  bsv.crypto.Signature.SIGHASH_SINGLE |
  bsv.crypto.Signature.SIGHASH_FORKID
const LOCK = 600 // sats locked in the channel (small — just a proof; reclaimable via timeout)
const DRAIN = 50 // sats to drain in this proof
// drain() forces the state-continuation output to equal the FULL input value
// (buildStateOutput(ctx.utxo.value)), so the fee CANNOT come from channel value.
// ANYONECANPAY_SINGLE only signs (contract input, state output) — so we add a
// SEPARATE fee-funding input + change output that the contract sigs don't cover.
// The deploy mints this fee UTXO to the gateway key (auto-signable, no extra prompt).
const FEEFUND = 1400 // sats parked for the drain fee (change returns to gateway)
const DRAIN_FEE = 1300 // > ARC minimum (1231 last time); change = FEEFUND - DRAIN_FEE

async function arc(rawHex: string) {
  const res = await fetch('https://arc.gorillapool.io/v1/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawTx: rawHex }),
  })
  return { ok: res.ok, status: res.status, body: await res.text() }
}

async function main() {
  console.log('sighash type (ACP_SINGLE_FORKID): 0x' + ACP_SINGLE_FORKID.toString(16))
  LLMPaymentChannel.loadArtifact(
    JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', 'artifacts', 'contracts', 'LLMPaymentChannel.json'),
        'utf8'
      )
    )
  )
  const w = new WalletClient('auto', 'llm-gateway-spike.peck.to')

  // userPubKey = wallet-derived child; wallet holds the priv, signs via createSignature.
  const userPubKey = (
    await w.getPublicKey({
      protocolID: PROTOCOL as any,
      keyID: KEYID,
      counterparty: 'self',
      forSelf: true,
    })
  ).publicKey
  console.log('userPubKey (BRC-42 child):', userPubKey)

  // gateway leg — ephemeral here (in prod this is the gateway's Secret-Manager key).
  const gatewayPriv = bsv.PrivateKey.fromRandom(NET)
  const gatewayPubHex = gatewayPriv.publicKey.toHex()
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600) // 1h — timeout-reclaimable

  const instance = new LLMPaymentChannel(
    PubKey(userPubKey),
    PubKey(gatewayPubHex),
    BigInt(LOCK),
    expiry
  )
  const lockingScript = instance.lockingScript

  // gateway P2PKH — receives the fee-funding UTXO at deploy, spends it for the
  // drain fee, gets the change back. Auto-signed by the gateway key (no prompt).
  const gatewayP2PKH = bsv.Script.buildPublicKeyHashOut(
    bsv.Address.fromPublicKey(gatewayPriv.publicKey, NET)
  )

  // ── PROMPT #1: deploy the channel + a gateway fee-funding UTXO via wallet ──
  console.log('\n>>> PROMPT #1: approve the channel deposit in your wallet...')
  const dep = await w.createAction({
    description: 'Deploy LLM payment channel (drain spike)',
    outputs: [
      { lockingScript: lockingScript.toHex(), satoshis: LOCK, outputDescription: 'channel deposit' },
      { lockingScript: gatewayP2PKH.toHex(), satoshis: FEEFUND, outputDescription: 'drain fee fund' },
    ],
    options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
  })
  console.log('deploy txid:', dep.txid)
  const deployTx = new bsv.Transaction(SdkTx.fromAtomicBEEF(dep.tx as number[]).toHex())
  // locate the fee-funding output (the gateway-P2PKH one) by script match
  const feeVout = deployTx.outputs.findIndex(
    (o: any) => o.script.toHex() === gatewayP2PKH.toHex()
  )
  console.log('channel vout: 0 | fee-fund vout:', feeVout)

  // ── Gateway builds the drain tx: contract input + next-state output ──
  instance.from = { tx: deployTx, outputIndex: 0 } as any

  const next = instance.next()
  next.amountSpent = BigInt(DRAIN) // amountSpent: 0 -> DRAIN
  next.paymentNonce = 1n // nonce: 0 -> 1
  const nextScript = next.lockingScript // byte-exact next-state locking script

  // drain() (ANYONECANPAY_SINGLE) only signs input[0] + output[0]. We add a
  // SEPARATE fee input (the gateway fee-fund UTXO) + change output that the
  // contract sigs don't cover, so the tx carries a real fee without touching
  // the channel value (which drain() forces to stay constant).
  const drainTx = new bsv.Transaction()
    .addInput(instance.buildContractInput()) // input[0] — the channel contract
    .addOutput(new bsv.Transaction.Output({ script: nextScript, satoshis: LOCK })) // output[0] — next state (value unchanged)
    .addInput(
      new bsv.Transaction.Input({
        prevTxId: deployTx.id,
        outputIndex: feeVout,
        script: bsv.Script.empty(),
        output: deployTx.outputs[feeVout],
      })
    )
    .addOutput(
      new bsv.Transaction.Output({ script: gatewayP2PKH, satoshis: FEEFUND - DRAIN_FEE })
    ) // output[1] — change back to gateway (fee = FEEFUND - this)

  // ── Compute the ANYONECANPAY_SINGLE sighash both parties sign (input[0]) ──
  const preimageHex = getPreimage(drainTx, lockingScript, LOCK, 0, ACP_SINGLE_FORKID)
  const sighash = bsv.crypto.Hash.sha256sha256(Buffer.from(preimageHex, 'hex'))
  console.log('drain sighash:', sighash.toString('hex'))

  // ── PROMPT #2: user signs the drain sighash in-wallet ──
  console.log('\n>>> PROMPT #2: approve the drain signature in your wallet...')
  const { signature: userSigBytes } = await w.createSignature({
    hashToDirectlySign: Array.from(sighash),
    protocolID: PROTOCOL as any,
    keyID: KEYID,
    counterparty: 'self',
  })

  // ── Gateway signs the SAME sighash ──
  const gatewaySigObj = bsv.crypto.ECDSA.sign(sighash, gatewayPriv)

  // ── SAFETY NET: verify BOTH sigs locally before broadcasting ──
  const userSigObj = bsv.crypto.Signature.fromDER(Buffer.from(userSigBytes))
  const userOk = bsv.crypto.ECDSA.verify(
    sighash,
    userSigObj,
    bsv.PublicKey.fromString(userPubKey)
  )
  const gwOk = bsv.crypto.ECDSA.verify(sighash, gatewaySigObj, gatewayPriv.publicKey)
  console.log('user sig verifies:', userOk, '| gateway sig verifies:', gwOk)
  if (!userOk || !gwOk) {
    throw new Error('signature(s) do NOT verify over the drain sighash — aborting (deploy reclaimable via timeout)')
  }
  console.log('✅ both sigs verify locally — building unlock + broadcasting')

  const userSigHex =
    Buffer.from(userSigBytes).toString('hex') + ACP_SINGLE_FORKID.toString(16).padStart(2, '0')
  const gwSigHex =
    gatewaySigObj.toDER().toString('hex') + ACP_SINGLE_FORKID.toString(16).padStart(2, '0')

  const unlock = await instance.getUnlockingScript(async (self: LLMPaymentChannel) => {
    self.to = { tx: drainTx, inputIndex: 0 } as any
    self.drain(BigInt(DRAIN), 0n, Sig(userSigHex), Sig(gwSigHex))
  })
  drainTx.inputs[0].setScript(unlock)

  // Sign the SEPARATE fee-funding input[1] (plain P2PKH, gateway key). This is a
  // standard SIGHASH_ALL|FORKID input unrelated to the contract — the channel
  // sigs above are ANYONECANPAY_SINGLE so they don't cover it.
  const feeSig = bsv.Transaction.Sighash.sign(
    drainTx,
    gatewayPriv,
    bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID,
    1,
    deployTx.outputs[feeVout].script,
    new bsv.crypto.BN(FEEFUND)
  )
  const feeUnlock = bsv.Script.empty()
    .add(
      Buffer.concat([
        feeSig.toDER(),
        Buffer.from([bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID]),
      ])
    )
    .add(gatewayPriv.publicKey.toBuffer())
  drainTx.inputs[1].setScript(feeUnlock)

  console.log(
    `drain tx ${drainTx.id} | inputs ${drainTx.inputs.length} outputs ${drainTx.outputs.length} | fee ${DRAIN_FEE}`
  )

  const r = await arc(drainTx.toString())
  console.log('\nARC ok=' + r.ok + ' status=' + r.status + ':', r.body.slice(0, 500))
  if (r.ok) {
    console.log('\n🎉 DRAIN PROVEN ON-CHAIN — deploy ' + dep.txid + ' / drain ' + drainTx.id)
  }
}
main().catch((e) => {
  console.error('WALLETSIG-DRAIN-ERR:', e?.message || String(e))
  process.exit(1)
})
