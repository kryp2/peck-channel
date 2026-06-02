/**
 * peck-channel — client-side channel operations.
 *
 * The wallet/client half of the proven non-custodial flow: deploy a channel, build
 * the ANYONECANPAY_SINGLE drain spend, get the user's wallet signature, and assemble
 * the drain() unlocking script. The gateway half (co-sign, fee-sign, broadcast) is
 * in ./gateway.ts + the reference Go gateway (peck-host).
 *
 * EVERY operation here is byte-identical to settle-sidecar/e2e-gopath-drain.ts, the
 * driver proven on mainnet (deploy 97fd93be… / drain 569ddd1b…). Do not change the
 * tx construction, sighash derivation, or sig encoding without re-proving on-chain
 * and re-running settle-sidecar/sighash-parity-check.ts.
 */
import { bsv, PubKey, Sig } from 'scrypt-ts'
import { getPreimage } from 'scryptlib'
import { WalletClient, Transaction as SdkTx } from '@bsv/sdk'
import { LLMPaymentChannel } from '../contracts/LLMPaymentChannel'
import * as fs from 'fs'
import * as path from 'path'

/** Default BRC-100 protocol ID for peck.channel keys (letters/numbers/spaces only — no hyphen). */
export const DEFAULT_PROTOCOL: [number, string] = [2, 'peck channel']

/** ANYONECANPAY_SINGLE | FORKID = 0xc3 — the flag drain() is annotated with. Both sigs use it. */
export const ACP_SINGLE_FORKID =
  bsv.crypto.Signature.SIGHASH_ANYONECANPAY |
  bsv.crypto.Signature.SIGHASH_SINGLE |
  bsv.crypto.Signature.SIGHASH_FORKID

/** SIGHASH_ALL | FORKID = 0x41 — the flag close()/timeout() are annotated with. */
export const SIGHASH_ALL_FORKID =
  bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID

/** Load the compiled LLMPaymentChannel artifact (defaults to the repo's artifacts/ path). */
export function loadContractArtifact(artifactPath?: string): void {
  const p =
    artifactPath ||
    path.join(__dirname, '..', '..', 'artifacts', 'contracts', 'LLMPaymentChannel.json')
  LLMPaymentChannel.loadArtifact(JSON.parse(fs.readFileSync(p, 'utf8')))
}

export interface DeployChannelParams {
  wallet: WalletClient
  /** Gateway pubkey the contract binds — MUST equal the key the gateway co-signs with. */
  gatewayPubHex: string
  lockAmount: number
  /** Sats parked in a gateway-owned P2PKH output to pay the drain fee (kept off channel value). */
  feeFund: number
  keyId: string
  protocol?: [number, string]
  network?: any
  expirySecs?: number
  /** Unix seconds for the expiry base; defaults to now. */
  nowUnixSecs?: number
  description?: string
}

export interface DeployedChannel {
  channelTxid: string
  deployTx: any
  feeVout: number
  instance: LLMPaymentChannel
  lockingScript: any
  userPubKey: string
  gatewayPubHex: string
  gatewayP2PKH: any
  lockAmount: number
  feeFund: number
  expiry: bigint
}

/**
 * Deploy a channel: one createAction mints the contract output (lockAmount) AND a
 * gateway-owned fee-fund output (feeFund). The wallet funds + broadcasts it.
 * [Triggers ONE wallet approval — the deposit.]
 */
export async function deployChannel(params: DeployChannelParams): Promise<DeployedChannel> {
  const net = params.network || bsv.Networks.mainnet
  const protocol = params.protocol || DEFAULT_PROTOCOL
  const nowSecs = params.nowUnixSecs ?? Math.floor(Date.now() / 1000)

  const userPubKey = (
    await params.wallet.getPublicKey({
      protocolID: protocol as any,
      keyID: params.keyId,
      counterparty: 'self',
      forSelf: true,
    })
  ).publicKey

  const expiry = BigInt(nowSecs + (params.expirySecs ?? 3600))
  const instance = new LLMPaymentChannel(
    PubKey(userPubKey),
    PubKey(params.gatewayPubHex),
    BigInt(params.lockAmount),
    expiry
  )
  const lockingScript = instance.lockingScript
  const gatewayP2PKH = bsv.Script.buildPublicKeyHashOut(
    bsv.Address.fromPublicKey(bsv.PublicKey.fromString(params.gatewayPubHex), net)
  )

  // The fee-fund output (gateway-owned) only matters for drain (its fee comes from a
  // separate input). close() takes its fee from channel value, so a close-only channel
  // can skip it: feeFund <= 0 deploys just the contract output.
  const outputs: any[] = [
    { lockingScript: lockingScript.toHex(), satoshis: params.lockAmount, outputDescription: 'channel deposit' },
  ]
  if (params.feeFund > 0) {
    outputs.push({ lockingScript: gatewayP2PKH.toHex(), satoshis: params.feeFund, outputDescription: 'drain fee fund' })
  }
  const dep = await params.wallet.createAction({
    description: params.description || 'Deploy peck-channel',
    outputs,
    options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
  })

  const deployTx = new bsv.Transaction(SdkTx.fromAtomicBEEF(dep.tx as number[]).toHex())
  const feeVout =
    params.feeFund > 0
      ? deployTx.outputs.findIndex((o: any) => o.script.toHex() === gatewayP2PKH.toHex())
      : -1

  return {
    channelTxid: dep.txid as string,
    deployTx,
    feeVout,
    instance,
    lockingScript,
    userPubKey,
    gatewayPubHex: params.gatewayPubHex,
    gatewayP2PKH,
    lockAmount: params.lockAmount,
    feeFund: params.feeFund,
    expiry,
  }
}

export interface DrainSpend {
  drainTx: any
  /** BIP143 ANYONECANPAY_SINGLE sighash both parties sign (input[0]). */
  sighash: Buffer
}

/**
 * Build the drain spend: contract input[0] + next-state output[0] (same value,
 * amountSpent/nonce advanced) + a SEPARATE fee input[1] + fee-change output[1].
 * The fee input is left UNSIGNED — the gateway signs it in submit-drain.
 * Returns the sighash both the user (wallet) and the gateway (cosign) must sign.
 */
export function buildDrainSpend(
  channel: DeployedChannel,
  drainAmount: number,
  nonce: number,
  drainFee: number
): DrainSpend {
  const { instance, deployTx, feeVout, lockingScript, gatewayP2PKH, lockAmount, feeFund } = channel

  instance.from = { tx: deployTx, outputIndex: 0 } as any
  const next = instance.next()
  next.amountSpent = BigInt(drainAmount)
  next.paymentNonce = BigInt(nonce + 1)
  const nextScript = next.lockingScript

  const drainTx = new bsv.Transaction()
    .addInput(instance.buildContractInput())
    .addOutput(new bsv.Transaction.Output({ script: nextScript, satoshis: lockAmount }))
    .addInput(
      new bsv.Transaction.Input({
        prevTxId: deployTx.id,
        outputIndex: feeVout,
        script: bsv.Script.empty(),
        output: deployTx.outputs[feeVout],
      })
    )
    .addOutput(new bsv.Transaction.Output({ script: gatewayP2PKH, satoshis: feeFund - drainFee }))

  const preimageHex = getPreimage(drainTx, lockingScript, lockAmount, 0, ACP_SINGLE_FORKID)
  const sighash = bsv.crypto.Hash.sha256sha256(Buffer.from(preimageHex, 'hex'))

  return { drainTx, sighash }
}

/**
 * Sign the drain sighash in the user's wallet (createSignature{hashToDirectlySign} —
 * the private key never leaves the wallet) and verify it locally before use.
 * Returns the sig in sig||flag hex form. [Triggers ONE wallet approval.]
 */
export async function walletSignSighash(
  wallet: WalletClient,
  sighash: Buffer,
  userPubKey: string,
  opts: { keyId: string; protocol?: [number, string]; sighashFlag?: number }
): Promise<string> {
  const protocol = opts.protocol || DEFAULT_PROTOCOL
  const flag = opts.sighashFlag ?? ACP_SINGLE_FORKID // drain default; pass SIGHASH_ALL_FORKID for close
  const { signature } = await wallet.createSignature({
    hashToDirectlySign: Array.from(sighash),
    protocolID: protocol as any,
    keyID: opts.keyId,
    counterparty: 'self',
  })
  const ok = bsv.crypto.ECDSA.verify(
    sighash,
    bsv.crypto.Signature.fromDER(Buffer.from(signature)),
    bsv.PublicKey.fromString(userPubKey)
  )
  if (!ok) throw new Error('user sig does not verify locally over the sighash')
  return Buffer.from(signature).toString('hex') + flag.toString(16).padStart(2, '0')
}

/**
 * Assemble the drain() unlocking script (interleaving userSig + gatewaySig + the
 * scrypt preimage) onto input[0]. After this the only unsigned input is the fee
 * input, which the gateway signs in submit-drain.
 */
export async function assembleDrainUnlock(
  instance: LLMPaymentChannel,
  drainTx: any,
  drainAmount: number,
  nonce: number,
  userSigHex: string,
  gatewaySigHex: string
): Promise<void> {
  const unlock = await instance.getUnlockingScript(async (self: LLMPaymentChannel) => {
    self.to = { tx: drainTx, inputIndex: 0 } as any
    self.drain(BigInt(drainAmount), BigInt(nonce), Sig(userSigHex), Sig(gatewaySigHex))
  })
  drainTx.inputs[0].setScript(unlock)
}

export interface CloseSpend {
  closeTx: any
  /** BIP143 SIGHASH_ALL sighash the user signs (input[0]). */
  sighash: Buffer
}

/**
 * Build the FIX-A close() spend: a SINGLE contract input + the split outputs only
 * (gateway ← amountSpent if >0, then user ← lockAmount − amountSpent − fee if >0),
 * NO change. The fee is taken from channel value. Byte-identical to the proven
 * reference-walletsig-close.ts, extended for amountSpent > 0. close() needs only the
 * user signature — no gateway co-sign — so the returned sighash is final.
 *
 * `amountSpent` should be the gateway's authoritative tally (from requestClose).
 */
export function buildCloseSpend(channel: DeployedChannel, amountSpent: number, fee: number): CloseSpend {
  const { instance, deployTx, lockingScript, gatewayPubHex, userPubKey, lockAmount } = channel
  const net = bsv.Networks.mainnet // P2PKH locking script is network-independent (hash160 only)

  const gatewayAmount = amountSpent
  const userAmount = lockAmount - amountSpent - fee
  if (userAmount < 0)
    throw new Error(`close fee ${fee} exceeds user balance (lock ${lockAmount}, spent ${amountSpent})`)

  instance.from = { tx: deployTx, outputIndex: 0 } as any
  const closeTx = new bsv.Transaction().addInput(instance.buildContractInput())

  // Contract order: gateway first (if >0), then user (if >0) — matches close()'s guards.
  if (gatewayAmount > 0) {
    const gwP2PKH = bsv.Script.buildPublicKeyHashOut(
      bsv.Address.fromPublicKey(bsv.PublicKey.fromString(gatewayPubHex), net)
    )
    closeTx.addOutput(new bsv.Transaction.Output({ script: gwP2PKH, satoshis: gatewayAmount }))
  }
  if (userAmount > 0) {
    const userP2PKH = bsv.Script.buildPublicKeyHashOut(
      bsv.Address.fromPublicKey(bsv.PublicKey.fromString(userPubKey), net)
    )
    closeTx.addOutput(new bsv.Transaction.Output({ script: userP2PKH, satoshis: userAmount }))
  }

  const preimageHex = getPreimage(closeTx, lockingScript, lockAmount, 0, SIGHASH_ALL_FORKID)
  const sighash = bsv.crypto.Hash.sha256sha256(Buffer.from(preimageHex, 'hex'))
  return { closeTx, sighash }
}

/** Assemble the close() unlocking script (userSig + fee) onto input[0]. */
export async function assembleCloseUnlock(
  instance: LLMPaymentChannel,
  closeTx: any,
  userSigHex: string,
  fee: number
): Promise<void> {
  const unlock = await instance.getUnlockingScript(async (self: LLMPaymentChannel) => {
    self.to = { tx: closeTx, inputIndex: 0 } as any
    self.close(Sig(userSigHex), BigInt(fee))
  })
  closeTx.inputs[0].setScript(unlock)
}
