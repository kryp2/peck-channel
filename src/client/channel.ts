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

  const dep = await params.wallet.createAction({
    description: params.description || 'Deploy peck-channel',
    outputs: [
      { lockingScript: lockingScript.toHex(), satoshis: params.lockAmount, outputDescription: 'channel deposit' },
      { lockingScript: gatewayP2PKH.toHex(), satoshis: params.feeFund, outputDescription: 'drain fee fund' },
    ],
    options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
  })

  const deployTx = new bsv.Transaction(SdkTx.fromAtomicBEEF(dep.tx as number[]).toHex())
  const feeVout = deployTx.outputs.findIndex((o: any) => o.script.toHex() === gatewayP2PKH.toHex())

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
  opts: { keyId: string; protocol?: [number, string] }
): Promise<string> {
  const protocol = opts.protocol || DEFAULT_PROTOCOL
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
  if (!ok) throw new Error('user sig does not verify locally over the drain sighash')
  return Buffer.from(signature).toString('hex') + ACP_SINGLE_FORKID.toString(16).padStart(2, '0')
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
