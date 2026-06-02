/**
 * E2E — full channel LIFECYCLE through the peck-host Go HTTP path, on-chain (mainnet):
 * deploy → drain → close, with amountSpent > 0 so close() splits to BOTH parties.
 *
 * This exercises the pieces the drain-only and close-only drivers don't:
 *   - peck-host advances the channel UTXO pointer after a drain (the UTXO moves), so
 *     the subsequent close spends the POST-DRAIN output, not the spent deploy.
 *   - the lib carries the advanced contract state from drain → close (nextInstance +
 *     next-state script), and close() pays gateway←amountSpent + user←remainder−fee.
 *
 *   1. [lib] deployChannel — contract + gateway fee-fund                      [PROMPT #1]
 *   2. [gateway] open (with fee UTXO) + accrue-drain (DEV)
 *   3. drain: requestDrain → buildDrainSpend → cosignDrain → wallet drain-sig [PROMPT #2]
 *             → assembleDrainUnlock → submitDrain (gateway advances its UTXO pointer)
 *   4. close: requestClose (amountSpent now > 0) → buildCloseSpend against the
 *             post-drain UTXO → wallet close-sig                              [PROMPT #3]
 *             → assembleCloseUnlock → submitClose
 *
 * ZERO-CONF NOTE: close spends the drain's UNCONFIRMED output. ARC usually accepts
 * spending a mempool parent, but may reject with "parent not found" until the drain
 * confirms. If close fails that way, it is a chaining limit (not a sig bug) — re-run
 * the close after the drain confirms.
 *
 * PRE-REQ: peck-host NON-mock with a funded gateway key + PECKHOST_ALLOW_ACCRUE=1
 * (see RUNBOOK_DRAIN_E2E.md). Run with PECKHOST_PUBKEY set to the SAME key.
 */
import { WalletClient } from '@bsv/sdk'
import {
  PeckChannelGateway,
  loadContractArtifact,
  deployChannel,
  buildDrainSpend,
  buildCloseSpend,
  walletSignSighash,
  assembleDrainUnlock,
  assembleCloseUnlock,
  SIGHASH_ALL_FORKID,
} from '../src/client'

const HOST = process.env.PECK_HOST_URL || 'http://localhost:8080'
const KEYID = 'e2e-gopath-lifecycle-1'
const LOCK = 800
const DRAIN = 200
const FEEFUND = 1400
const DRAIN_FEE = 1300
const CLOSE_FEE = 300

async function main() {
  const gatewayPubHex = process.env.PECKHOST_PUBKEY
  if (!gatewayPubHex) throw new Error('set PECKHOST_PUBKEY (same as the running peck-host)')
  console.log('gatewayPubKey:', gatewayPubHex)

  const gw = new PeckChannelGateway(HOST)
  try {
    const h = await gw.health()
    console.log('peck-host /health:', h.status, h.body.slice(0, 120))
  } catch (e: any) {
    throw new Error('peck-host not reachable at ' + HOST + ' — start it first. ' + e.message)
  }

  loadContractArtifact()
  const w = new WalletClient('auto', 'peck-run-lifecycle-e2e.peck.to')

  // ── PROMPT #1: deploy channel + fee-fund ──
  console.log('\n>>> PROMPT #1: approve the channel deposit in your wallet...')
  const channel = await deployChannel({
    wallet: w,
    gatewayPubHex,
    lockAmount: LOCK,
    feeFund: FEEFUND,
    keyId: KEYID,
    description: 'Deploy LLM channel (lifecycle E2E)',
  })
  console.log('userPubKey:', channel.userPubKey)
  console.log('deploy txid:', channel.channelTxid)
  gw.setAuthPubKey(channel.userPubKey)

  const open = await gw.open({
    channel_txid: channel.channelTxid,
    amount: LOCK,
    script_hex: channel.lockingScript.toHex(),
    satoshi_value: LOCK,
    vout: 0,
    user_pubkey: channel.userPubKey,
    expiry_time: Number(channel.expiry),
    fee_txid: channel.channelTxid,
    fee_vout: channel.feeVout,
    fee_satoshi_value: FEEFUND,
  })
  if (!open.ok) throw new Error('open failed: ' + open.text)
  const accrue = await gw.accrueDrain(channel.channelTxid, DRAIN)
  if (!accrue.ok) throw new Error('accrue failed (PECKHOST_ALLOW_ACCRUE=1?): ' + accrue.text)

  // ── DRAIN ──
  const reqDrain = await gw.requestDrain(channel.channelTxid)
  const rd = reqDrain.json || ({} as any)
  if (!reqDrain.ok || !rd.drain_amount) throw new Error('request-drain failed: ' + (rd.error || reqDrain.text))
  const drainAmount = Number(rd.drain_amount)
  const drainNonce = Number(rd.nonce)
  const drainSpend = buildDrainSpend(channel, drainAmount, drainNonce, DRAIN_FEE)
  const cosign = await gw.cosignDrain(channel.channelTxid, drainSpend.sighash.toString('hex'))
  if (!cosign.ok || !cosign.json?.gateway_sig) throw new Error('cosign-drain failed: ' + (cosign.json?.error || cosign.text))

  console.log('\n>>> PROMPT #2: approve the drain signature in your wallet...')
  const drainUserSig = await walletSignSighash(w, drainSpend.sighash, channel.userPubKey, { keyId: KEYID })
  await assembleDrainUnlock(channel.instance, drainSpend.drainTx, drainAmount, drainNonce, drainUserSig, cosign.json.gateway_sig)
  const submitDrain = await gw.submitDrain(channel.channelTxid, drainSpend.drainTx.toString())
  if (!submitDrain.ok || !submitDrain.json?.txid) throw new Error('submit-drain failed: ' + (submitDrain.json?.error || submitDrain.text))
  const drainTxid = submitDrain.json.txid
  console.log('✅ drain on-chain:', drainTxid, `(amountSpent now ${drainAmount}, channel UTXO → ${drainTxid}:0)`)

  // ── CLOSE (against the post-drain UTXO) ──
  const ci = await gw.requestClose(channel.channelTxid)
  if (!ci.ok || !ci.json) throw new Error('request-close failed: ' + (ci.json?.error || ci.text))
  const amountSpent = Number(ci.json.amount_spent)
  console.log(`request-close: amountSpent=${amountSpent} → close split gateway=${amountSpent} user=${LOCK - amountSpent - CLOSE_FEE} fee=${CLOSE_FEE}`)

  const closeSpend = buildCloseSpend(channel, amountSpent, CLOSE_FEE, {
    instance: drainSpend.nextInstance,
    fromTxId: drainTxid,
    fromScriptHex: drainSpend.nextScriptHex,
  })

  console.log('\n>>> PROMPT #3: approve the close signature in your wallet...')
  const closeUserSig = await walletSignSighash(w, closeSpend.sighash, channel.userPubKey, {
    keyId: KEYID,
    sighashFlag: SIGHASH_ALL_FORKID,
  })
  await assembleCloseUnlock(drainSpend.nextInstance, closeSpend.closeTx, closeUserSig, CLOSE_FEE)
  console.log(`close tx ${closeSpend.closeTx.id} | inputs ${closeSpend.closeTx.inputs.length} outputs ${closeSpend.closeTx.outputs.length}`)
  const submitClose = await gw.submitClose(channel.channelTxid, closeSpend.closeTx.toString(), CLOSE_FEE)
  console.log('\nsubmit-close:', submitClose.status, JSON.stringify(submitClose.json || submitClose.text).slice(0, 400))
  if (submitClose.ok && submitClose.json?.txid) {
    console.log('\n🎉 FULL LIFECYCLE PROVEN — deploy ' + channel.channelTxid + ' / drain ' + drainTxid + ' / close ' + submitClose.json.txid)
    console.log(`   gateway received ${amountSpent} sat, user reclaimed ${LOCK - amountSpent - CLOSE_FEE} sat.`)
  }
}
main().catch((e) => {
  console.error('GOPATH-LIFECYCLE-E2E-ERR:', e?.message || String(e))
  process.exit(1)
})
