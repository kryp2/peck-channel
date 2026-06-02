/**
 * E2E — METER-DRIVEN settlement through peck.run, on-chain (mainnet).
 *
 * The product flow (not the accrue-hook): peck-host's REAL per-second meter accrues
 * PendingDrain over time, then the user settles the accrued amount via the proven
 * drain + close lifecycle. This is the symmetric peck.run analogue of llm.peck.to's
 * receipt→close: the meter runs headless (no wallet prompts during the session); the
 * user signs only at settle.
 *
 *   1. [lib] deployChannel — contract + fee-fund                              [PROMPT #1]
 *   2. [gateway] open (with fee UTXO)
 *   3. [gateway] start-meter @ cost_per_sec — the billingLoop accrues PendingDrain live
 *   4. wait (watch the accrued amount grow via requestDrain) — NO wallet prompts
 *   5. [gateway] stop-meter — final accrual; returns the total accrued PendingDrain
 *   6. settle: drain (amountSpent ← accrued) [PROMPT #2] → close [PROMPT #3]
 *
 * PRE-REQ: peck-host NON-mock, funded gateway key, PECKHOST_ALLOW_ACCRUE=1, and a
 * SHORT DRAIN_INTERVAL_SECS (e.g. 2) so accrual is visible quickly:
 *   PECKHOST_PRIVKEY=… PECKHOST_PUBKEY=… PECKHOST_ALLOW_ACCRUE=1 \
 *     DRAIN_INTERVAL_SECS=2 PORT=8080 go run ./cmd/main.go
 * Run with PECKHOST_PUBKEY set to the SAME key.
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
const KEYID = 'e2e-meter-settle-1'
const LOCK = 1000
const FEEFUND = 1400
const DRAIN_FEE = 1300
const CLOSE_FEE = 700
const COST_PER_SEC = 20
const METER_SECONDS = 8 // how long to let the meter run before settling

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const gatewayPubHex = process.env.PECKHOST_PUBKEY
  if (!gatewayPubHex) throw new Error('set PECKHOST_PUBKEY (same as the running peck-host)')
  console.log('gatewayPubKey:', gatewayPubHex)

  const gw = new PeckChannelGateway(HOST)
  try {
    const h = await gw.health()
    console.log('peck-host /health:', h.status, h.body.slice(0, 120))
  } catch (e: any) {
    throw new Error('peck-host not reachable at ' + HOST + '. ' + e.message)
  }

  loadContractArtifact()
  const w = new WalletClient('auto', 'peck-run-meter-e2e.peck.to')

  // ── PROMPT #1: deploy ──
  console.log('\n>>> PROMPT #1: approve the channel deposit in your wallet...')
  const channel = await deployChannel({
    wallet: w,
    gatewayPubHex,
    lockAmount: LOCK,
    feeFund: FEEFUND,
    keyId: KEYID,
    description: 'Deploy LLM channel (meter-settle E2E)',
  })
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

  // ── start the REAL meter — accrues PendingDrain live, no wallet prompts ──
  const sm = await gw.startMeter(channel.channelTxid, COST_PER_SEC)
  if (!sm.ok) throw new Error('start-meter failed (PECKHOST_ALLOW_ACCRUE=1?): ' + sm.text)
  console.log(`\n⏱  meter running @ ${COST_PER_SEC} sat/sec — accruing for ~${METER_SECONDS}s (no prompts)...`)

  for (let t = 2; t <= METER_SECONDS; t += 2) {
    await sleep(2000)
    const rd = await gw.requestDrain(channel.channelTxid)
    const accrued = rd.json?.drain_amount ?? 0
    console.log(`   t≈${t}s — accrued PendingDrain: ${accrued} sat`)
  }

  // ── stop the meter — final accrual; the accrued amount is what we settle ──
  const stop = await gw.stopMeter(channel.channelTxid)
  const accrued = stop.json?.pending_drain ?? 0
  console.log(`\n⏹  meter stopped — total accrued: ${accrued} sat (uptime ${stop.json?.uptime_seconds ?? '?'}s)`)
  if (accrued <= 0) throw new Error('meter accrued nothing — is DRAIN_INTERVAL_SECS short enough?')

  // ── SETTLE: drain (commit amountSpent = accrued) then close ──
  const reqDrain = await gw.requestDrain(channel.channelTxid)
  const rd = reqDrain.json || ({} as any)
  if (!reqDrain.ok || !rd.drain_amount) throw new Error('request-drain failed: ' + (rd.error || reqDrain.text))
  const drainAmount = Number(rd.drain_amount)
  const drainNonce = Number(rd.nonce)
  const drainSpend = buildDrainSpend(channel, drainAmount, drainNonce, DRAIN_FEE)
  const cosign = await gw.cosignDrain(channel.channelTxid, drainSpend.sighash.toString('hex'))
  if (!cosign.ok || !cosign.json?.gateway_sig) throw new Error('cosign-drain failed: ' + (cosign.json?.error || cosign.text))

  console.log('\n>>> PROMPT #2: approve the drain (settle accrued usage) in your wallet...')
  const drainUserSig = await walletSignSighash(w, drainSpend.sighash, channel.userPubKey, { keyId: KEYID })
  await assembleDrainUnlock(channel.instance, drainSpend.drainTx, drainAmount, drainNonce, drainUserSig, cosign.json.gateway_sig)
  const submitDrain = await gw.submitDrain(channel.channelTxid, drainSpend.drainTx.toString())
  if (!submitDrain.ok || !submitDrain.json?.txid) throw new Error('submit-drain failed: ' + (submitDrain.json?.error || submitDrain.text))
  const drainTxid = submitDrain.json.txid
  console.log('✅ usage settled on-chain (drain):', drainTxid, `amountSpent=${drainAmount}`)

  const ci = await gw.requestClose(channel.channelTxid)
  if (!ci.ok || !ci.json) throw new Error('request-close failed: ' + (ci.json?.error || ci.text))
  const amountSpent = Number(ci.json.amount_spent)
  console.log(`close split: gateway=${amountSpent} user=${LOCK - amountSpent - CLOSE_FEE} fee=${CLOSE_FEE}`)
  const closeSpend = buildCloseSpend(channel, amountSpent, CLOSE_FEE, {
    instance: drainSpend.nextInstance,
    fromTxId: drainTxid,
    fromScriptHex: drainSpend.nextScriptHex,
  })

  console.log('\n>>> PROMPT #3: approve the close in your wallet...')
  const closeUserSig = await walletSignSighash(w, closeSpend.sighash, channel.userPubKey, { keyId: KEYID, sighashFlag: SIGHASH_ALL_FORKID })
  await assembleCloseUnlock(drainSpend.nextInstance, closeSpend.closeTx, closeUserSig, CLOSE_FEE)
  const submitClose = await gw.submitClose(channel.channelTxid, closeSpend.closeTx.toString(), CLOSE_FEE)
  console.log('\nsubmit-close:', submitClose.status, JSON.stringify(submitClose.json || submitClose.text).slice(0, 300))
  if (submitClose.ok && submitClose.json?.txid) {
    console.log('\n🎉 METER-DRIVEN SETTLEMENT PROVEN — the per-second meter accrued ' + amountSpent + ' sat, settled on-chain.')
    console.log('   deploy ' + channel.channelTxid + ' / drain ' + drainTxid + ' / close ' + submitClose.json.txid)
  }
}
main().catch((e) => {
  console.error('METER-SETTLE-E2E-ERR:', e?.message || String(e))
  process.exit(1)
})
