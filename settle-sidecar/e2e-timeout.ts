/**
 * E2E — timeout() reclaim, on-chain (mainnet). The user's GATEWAY-INDEPENDENT
 * safety valve: after expiry the user reclaims the full channel value with NO
 * gateway involvement — proving funds are never trapped if the gateway disappears.
 *
 *   1. [lib] deployChannel with an ALREADY-PAST expiry (so nLockTime is valid now) [PROMPT #1]
 *   2. [lib] buildTimeoutSpend — single input + one user output, nLockTime = expiry
 *   3. [lib] wallet timeout-sig (SIGHASH_ALL)                                       [PROMPT #2]
 *   4. [lib] assembleTimeoutUnlock → broadcast STRAIGHT TO ARC (no peck-host)
 *
 * No peck-host needed — that is the whole point of timeout. The gateway pubkey is a
 * throwaway (timeout() doesn't use it). Requires a funded BRC-100 wallet.
 */
import { bsv } from 'scrypt-ts'
import { WalletClient as WC } from '@bsv/sdk'
import {
  loadContractArtifact,
  deployChannel,
  buildTimeoutSpend,
  walletSignSighash,
  assembleTimeoutUnlock,
  SIGHASH_ALL_FORKID,
} from '../src/client'

const KEYID = 'e2e-timeout-1'
const LOCK = 1000
const TIMEOUT_FEE = 700 // ARC min ~633 for this 1-output reclaim; user gets LOCK - fee

async function arc(rawHex: string) {
  const res = await fetch('https://arc.gorillapool.io/v1/tx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawTx: rawHex }),
  })
  return { ok: res.ok, status: res.status, body: await res.text() }
}

async function main() {
  loadContractArtifact()
  const w = new WC('auto', 'peck-run-timeout-e2e.peck.to')

  // Throwaway gateway key — timeout() never references it, but the contract binds one.
  const gatewayPriv = bsv.PrivateKey.fromRandom(bsv.Networks.mainnet)
  const gatewayPubHex = gatewayPriv.publicKey.toHex()

  // ── PROMPT #1: deploy with an already-past expiry so timeout is valid now ──
  console.log('\n>>> PROMPT #1: approve the channel deposit in your wallet...')
  const channel = await deployChannel({
    wallet: w,
    gatewayPubHex,
    lockAmount: LOCK,
    feeFund: 0,
    keyId: KEYID,
    expirySecs: -120, // expiry 2 minutes in the PAST → nLockTime immediately final
    description: 'Deploy LLM channel (timeout E2E)',
  })
  console.log('deploy txid:', channel.channelTxid, '| expiry (past):', Number(channel.expiry))

  // ── build + sign the timeout reclaim ──
  const { timeoutTx, sighash } = buildTimeoutSpend(channel, TIMEOUT_FEE)
  console.log(`timeout reclaim: user=${LOCK - TIMEOUT_FEE} fee=${TIMEOUT_FEE}`)

  console.log('\n>>> PROMPT #2: approve the timeout reclaim signature in your wallet...')
  const userSig = await walletSignSighash(w, sighash, channel.userPubKey, {
    keyId: KEYID,
    sighashFlag: SIGHASH_ALL_FORKID,
  })
  console.log('✅ user sig verifies locally')

  await assembleTimeoutUnlock(channel.instance, timeoutTx, userSig, TIMEOUT_FEE)
  console.log(`timeout tx ${timeoutTx.id} | inputs ${timeoutTx.inputs.length} outputs ${timeoutTx.outputs.length} | nLockTime ${timeoutTx.nLockTime}`)

  // ── broadcast straight to ARC — no gateway in the loop ──
  const r = await arc(timeoutTx.toString())
  console.log('\nARC ok=' + r.ok + ' status=' + r.status + ':', r.body.slice(0, 400))
  if (r.ok) {
    console.log('\n🎉 TIMEOUT RECLAIM PROVEN — user reclaimed funds with NO gateway. deploy ' + channel.channelTxid + ' / timeout ' + timeoutTx.id)
  }
}
main().catch((e) => {
  console.error('TIMEOUT-E2E-ERR:', e?.message || String(e))
  process.exit(1)
})
