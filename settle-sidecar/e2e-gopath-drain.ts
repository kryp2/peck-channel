/**
 * E2E — DRAIN through the peck-host Go HTTP path, on-chain (mainnet).
 *
 * This is BOTH the on-chain proof AND the conformance test for the peck-channel
 * client lib (src/client): it drives the whole non-custodial flow through the
 * library, so a green run validates the lib end-to-end.
 *
 *   1. [lib] deployChannel — wallet createAction mints contract + fee-fund   [PROMPT #1]
 *   2. [gateway] open — register channel + fee UTXO so peck-host can provision state
 *   3. [gateway] (DEV) accrue-drain — set PendingDrain (the meter does this in prod)
 *   4. [gateway] requestDrain — get pending amount/nonce
 *   5. [lib] buildDrainSpend — rebuild the REAL next-state tx + sighash
 *   6. [gateway] cosignDrain — gateway re-signs the client's real digest server-side
 *   7. [lib] walletSignSighash — user signs in-wallet                        [PROMPT #2]
 *   8. [lib] assembleDrainUnlock — drain() unlock (user+gateway sigs); fee input UNSIGNED
 *   9. [gateway] submitDrain — peck-host fee-signs input[1], verifies, broadcasts via ARC
 *
 * NON-CUSTODIAL: the client never holds a gateway key. The gateway co-signs
 * (cosign-drain) and fee-signs (submit-drain) server-side.
 *
 * PRE-REQ: peck-host running locally in NON-mock with a funded gateway key:
 *   cd peck-host && PECKHOST_PRIVKEY=<wif> PECKHOST_PUBKEY=<hex> \
 *     ARC_URL=https://arc.gorillapool.io/v1/tx PECKHOST_ALLOW_ACCRUE=1 \
 *     PORT=8080 go run ./cmd/main.go
 * (MOCK_MODE unset → real ARC broadcast.) Set PECK_HOST_URL if not :8080.
 * Run the driver with PECKHOST_PUBKEY set to the SAME key. See RUNBOOK_DRAIN_E2E.md.
 */
import { WalletClient } from '@bsv/sdk'
import {
  PeckChannelGateway,
  loadContractArtifact,
  deployChannel,
  buildDrainSpend,
  walletSignSighash,
  assembleDrainUnlock,
} from '../src/client'

const HOST = process.env.PECK_HOST_URL || 'http://localhost:8080'
const KEYID = 'e2e-gopath-1'
const LOCK = 600
const DRAIN = 50
const FEEFUND = 1400
const DRAIN_FEE = 1300

async function main() {
  const gatewayPubHex = process.env.PECKHOST_PUBKEY
  if (!gatewayPubHex)
    throw new Error('set PECKHOST_PUBKEY (same as the running peck-host) so the contract binds the right gateway key')
  console.log('gatewayPubKey (from PECKHOST_PUBKEY):', gatewayPubHex)

  const gw = new PeckChannelGateway(HOST)
  // peck-host reachable?
  try {
    const h = await gw.health()
    console.log('peck-host /health:', h.status, h.body.slice(0, 120))
  } catch (e: any) {
    throw new Error('peck-host not reachable at ' + HOST + ' — start it first (see header). ' + e.message)
  }

  loadContractArtifact()
  const w = new WalletClient('auto', 'peck-run-e2e.peck.to')

  // ── PROMPT #1: deploy channel + gateway fee-fund UTXO ──
  console.log('\n>>> PROMPT #1: approve the channel deposit in your wallet...')
  const channel = await deployChannel({
    wallet: w,
    gatewayPubHex,
    lockAmount: LOCK,
    feeFund: FEEFUND,
    keyId: KEYID,
    description: 'Deploy LLM channel (Go-path E2E)',
  })
  console.log('userPubKey (BRC-42 child):', channel.userPubKey)
  console.log('deploy txid:', channel.channelTxid)
  gw.setAuthPubKey(channel.userPubKey)

  // ── Step 2: register the channel + fee UTXO with peck-host ──
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
  console.log('open:', open.status, JSON.stringify(open.json || open.text).slice(0, 200))
  if (!open.ok) throw new Error('open failed')

  // ── Step 2b: accrue PendingDrain via the DEV hook (meter not running in a proof) ──
  const accrue = await gw.accrueDrain(channel.channelTxid, DRAIN)
  console.log('accrue-drain:', accrue.status, JSON.stringify(accrue.json || accrue.text).slice(0, 160))
  if (!accrue.ok)
    throw new Error(
      'accrue-drain failed (start peck-host with PECKHOST_ALLOW_ACCRUE=1): ' +
        (accrue.json?.error || accrue.text)
    )

  // ── Step 3: requestDrain — gateway returns pending amount/nonce ──
  const reqDrain = await gw.requestDrain(channel.channelTxid)
  console.log('request-drain:', reqDrain.status, JSON.stringify(reqDrain.json || reqDrain.text).slice(0, 300))
  const rd = reqDrain.json || ({} as any)
  if (!reqDrain.ok) throw new Error('request-drain failed: ' + (rd.error || reqDrain.text))
  if (!rd.drain_amount || rd.drain_amount === 0) {
    console.log('\n⚠️ RequestDrain returned drain_amount=0 — no PendingDrain accrued.')
    console.log('   Deploy ' + channel.channelTxid + ' is reclaimable via timeout. Stopping before any bad spend.')
    return
  }

  const amount = Number(rd.drain_amount)
  const nonce = Number(rd.nonce)
  console.log(`gateway requestDrain returned amount=${amount} nonce=${nonce}`)

  // ── Step 4: rebuild the REAL next-state spend + sighash (lib) ──
  const { drainTx, sighash } = buildDrainSpend(channel, amount, nonce, DRAIN_FEE)
  console.log('client-rebuilt sighash:', sighash.toString('hex'))

  // ── Step 5: gateway co-signs the client's real digest (production path) ──
  const cosign = await gw.cosignDrain(channel.channelTxid, sighash.toString('hex'))
  if (!cosign.ok || !cosign.json?.gateway_sig) {
    throw new Error('cosign-drain failed: ' + (cosign.json?.error || cosign.text))
  }
  const gwSigHex = cosign.json.gateway_sig
  console.log('✅ gateway co-signed client sighash via /api/channels/cosign-drain')

  // ── PROMPT #2: user signs the sighash in-wallet (lib verifies locally) ──
  console.log('\n>>> PROMPT #2: approve the drain signature in your wallet...')
  const userSigHex = await walletSignSighash(w, sighash, channel.userPubKey, { keyId: KEYID })
  console.log('✅ user sig verifies locally')

  // ── Step 6: assemble the drain() unlock; fee input[1] left UNSIGNED for the gateway ──
  await assembleDrainUnlock(channel.instance, drainTx, amount, nonce, userSigHex, gwSigHex)

  // ── Step 7: submit — peck-host fee-signs input[1], verifies, broadcasts via ARC ──
  console.log(`drain tx ${drainTx.id} | inputs ${drainTx.inputs.length} outputs ${drainTx.outputs.length}`)
  const submit = await gw.submitDrain(channel.channelTxid, drainTx.toString())
  console.log('\nsubmit-drain:', submit.status, JSON.stringify(submit.json || submit.text).slice(0, 400))
  if (submit.ok && submit.json?.txid) {
    console.log('\n🎉 DRAIN PROVEN THROUGH THE GO HTTP PATH — deploy ' + channel.channelTxid + ' / drain ' + submit.json.txid)
  }
}
main().catch((e) => {
  console.error('GOPATH-E2E-ERR:', e?.message || String(e))
  process.exit(1)
})
