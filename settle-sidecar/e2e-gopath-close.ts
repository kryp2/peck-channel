/**
 * E2E — CLOSE through the peck-host Go HTTP path, on-chain (mainnet).
 *
 * Proves channel SETTLEMENT (where the money actually moves) through the productized
 * peck.run gateway path, via the peck-channel client lib — the sibling of
 * e2e-gopath-drain.ts. close() needs ONLY the user's signature (no gateway co-sign),
 * so the flow is shorter:
 *
 *   1. [lib] deployChannel — wallet createAction mints the contract output   [PROMPT #1]
 *   2. [gateway] open — register the channel so peck-host tracks its state
 *   3. [gateway] requestClose — fetch the authoritative amountSpent (0 here)
 *   4. [lib] buildCloseSpend — FIX-A close tx (gateway←amountSpent, user←remainder−fee)
 *   5. [lib] walletSignSighash (SIGHASH_ALL) — user signs in-wallet            [PROMPT #2]
 *   6. [lib] assembleCloseUnlock — close() unlock (userSig + fee)
 *   7. [gateway] submitClose — peck-host verifies the split, broadcasts via ARC, ends channel
 *
 * This run closes with amountSpent=0 (full user refund minus fee), proving the close
 * path itself. A drain-then-close lifecycle (gateway output > 0) needs the channel's
 * post-drain outpoint tracked — a follow-up.
 *
 * PRE-REQ: peck-host running locally NON-mock with a funded gateway key (see
 * RUNBOOK_DRAIN_E2E.md). Run with PECKHOST_PUBKEY set to the SAME key.
 */
import { WalletClient } from '@bsv/sdk'
import {
  PeckChannelGateway,
  loadContractArtifact,
  deployChannel,
  buildCloseSpend,
  walletSignSighash,
  assembleCloseUnlock,
  SIGHASH_ALL_FORKID,
} from '../src/client'

const HOST = process.env.PECK_HOST_URL || 'http://localhost:8080'
const KEYID = 'e2e-gopath-close-1'
const LOCK = 2500
const CLOSE_FEE = 700 // taken from channel value; user refund = LOCK - amountSpent - fee

async function main() {
  const gatewayPubHex = process.env.PECKHOST_PUBKEY
  if (!gatewayPubHex)
    throw new Error('set PECKHOST_PUBKEY (same as the running peck-host) so the contract binds the right gateway key')
  console.log('gatewayPubKey (from PECKHOST_PUBKEY):', gatewayPubHex)

  const gw = new PeckChannelGateway(HOST)
  try {
    const h = await gw.health()
    console.log('peck-host /health:', h.status, h.body.slice(0, 120))
  } catch (e: any) {
    throw new Error('peck-host not reachable at ' + HOST + ' — start it first. ' + e.message)
  }

  loadContractArtifact()
  const w = new WalletClient('auto', 'peck-run-close-e2e.peck.to')

  // ── PROMPT #1: deploy the channel (no fee-fund — close takes its fee from value) ──
  console.log('\n>>> PROMPT #1: approve the channel deposit in your wallet...')
  const channel = await deployChannel({
    wallet: w,
    gatewayPubHex,
    lockAmount: LOCK,
    feeFund: 0,
    keyId: KEYID,
    description: 'Deploy LLM channel (close E2E)',
  })
  console.log('userPubKey (BRC-42 child):', channel.userPubKey)
  console.log('deploy txid:', channel.channelTxid)
  gw.setAuthPubKey(channel.userPubKey)

  // ── Step 2: register the channel ──
  const open = await gw.open({
    channel_txid: channel.channelTxid,
    amount: LOCK,
    script_hex: channel.lockingScript.toHex(),
    satoshi_value: LOCK,
    vout: 0,
    user_pubkey: channel.userPubKey,
    expiry_time: Number(channel.expiry),
  })
  console.log('open:', open.status, JSON.stringify(open.json || open.text).slice(0, 200))
  if (!open.ok) throw new Error('open failed')

  // ── Step 3: requestClose — gateway's authoritative amountSpent ──
  const ci = await gw.requestClose(channel.channelTxid)
  console.log('request-close:', ci.status, JSON.stringify(ci.json || ci.text).slice(0, 200))
  if (!ci.ok || !ci.json) throw new Error('request-close failed: ' + (ci.json?.error || ci.text))
  const amountSpent = Number(ci.json.amount_spent)

  // ── Step 4: build the FIX-A close spend (lib) ──
  const { closeTx, sighash } = buildCloseSpend(channel, amountSpent, CLOSE_FEE)
  console.log(`close split: gateway=${amountSpent} user=${LOCK - amountSpent - CLOSE_FEE} fee=${CLOSE_FEE}`)
  console.log('close sighash:', sighash.toString('hex'))

  // ── PROMPT #2: user signs the close sighash (SIGHASH_ALL) ──
  console.log('\n>>> PROMPT #2: approve the close signature in your wallet...')
  const userSigHex = await walletSignSighash(w, sighash, channel.userPubKey, {
    keyId: KEYID,
    sighashFlag: SIGHASH_ALL_FORKID,
  })
  console.log('✅ user sig verifies locally')

  // ── Step 5: assemble the close() unlock; submit for verify + broadcast ──
  await assembleCloseUnlock(channel.instance, closeTx, userSigHex, CLOSE_FEE)
  console.log(`close tx ${closeTx.id} | inputs ${closeTx.inputs.length} outputs ${closeTx.outputs.length}`)
  const submit = await gw.submitClose(channel.channelTxid, closeTx.toString(), CLOSE_FEE)
  console.log('\nsubmit-close:', submit.status, JSON.stringify(submit.json || submit.text).slice(0, 400))
  if (submit.ok && submit.json?.txid) {
    console.log('\n🎉 CLOSE PROVEN THROUGH THE GO HTTP PATH — deploy ' + channel.channelTxid + ' / close ' + submit.json.txid)
  }
}
main().catch((e) => {
  console.error('GOPATH-CLOSE-E2E-ERR:', e?.message || String(e))
  process.exit(1)
})
