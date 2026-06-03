/**
 * Golden sighash-vector generator for the peck.channel contract methods.
 *
 * Emits vectors/sighash-vectors.json — the language-neutral standard that BOTH the
 * TS client lib and the Go gateway must reproduce. Each case fixes a synthetic tx
 * (a P2PKH stands in for the contract scriptCode — BIP143 hashes the whole
 * scriptCode regardless of size, so this isolates the sighash ALGORITHM) and
 * records `sighashToSign`: the NATURAL BIP143 digest hash256(preimage) that both
 * the user wallet and the gateway sign.
 *
 *   TS produces it as:  sha256sha256(scryptlib.getPreimage(tx, sub, value, i, flag))
 *   Go produces it as:  ReverseBytes(go-bt tx.GetInputSignatureHash(i, flag))
 *     (go-bt returns the reversed/display-endian digest; reversing yields the natural one)
 *
 * Run:  npx ts-node vectors/generate-vectors.ts
 */
import { bsv } from 'scrypt-ts'
import { getPreimage } from 'scryptlib'
import * as fs from 'fs'
import * as path from 'path'

const ACP_SINGLE_FORKID =
  bsv.crypto.Signature.SIGHASH_ANYONECANPAY |
  bsv.crypto.Signature.SIGHASH_SINGLE |
  bsv.crypto.Signature.SIGHASH_FORKID // 0xc3
const ALL_FORKID = bsv.crypto.Signature.SIGHASH_ALL | bsv.crypto.Signature.SIGHASH_FORKID // 0x41

// Fixed synthetic prevout shared by every case (continuity with sighash_parity_test.go).
const PREV_TXID = '1111111111111111111111111111111111111111111111111111111111111111'
const SUBSCRIPT = '76a914000000000000000000000000000000000000000088ac' // P2PKH(all-zero hash160)
const VALUE = 2500
const P2PKH_A = '76a914aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa88ac' // stand-in payout script

interface OutSpec {
  scriptHex: string
  value: number
}
interface CaseInput {
  name: string
  method: 'drain' | 'close' | 'timeout'
  flag: number
  outputs: OutSpec[]
  nLockTime?: number
  sequence?: number
}

const CASES: CaseInput[] = [
  {
    name: 'drain-acp-single',
    method: 'drain',
    flag: ACP_SINGLE_FORKID,
    // drain re-locks the SAME value under output[0] (state continuation).
    outputs: [{ scriptHex: SUBSCRIPT, value: VALUE }],
  },
  {
    name: 'close-all-split',
    method: 'close',
    flag: ALL_FORKID,
    // close splits: gateway (amountSpent) + user (remainder - fee).
    outputs: [
      { scriptHex: P2PKH_A, value: 200 },
      { scriptHex: P2PKH_A, value: 1800 },
    ],
  },
  {
    name: 'timeout-all-locktime',
    method: 'timeout',
    flag: ALL_FORKID,
    // timeout: single user output, nLockTime = expiry, non-final input sequence.
    outputs: [{ scriptHex: P2PKH_A, value: 1800 }],
    nLockTime: 1700000000,
    sequence: 0xfffffffe,
  },
]

function buildSighash(c: CaseInput): string {
  const sub = bsv.Script.fromHex(SUBSCRIPT)
  const tx = new bsv.Transaction()
  tx.addInput(
    new bsv.Transaction.Input({
      prevTxId: PREV_TXID,
      outputIndex: 0,
      script: bsv.Script.empty(),
      output: new bsv.Transaction.Output({ script: sub, satoshis: VALUE }),
    })
  )
  for (const o of c.outputs) {
    tx.addOutput(new bsv.Transaction.Output({ script: bsv.Script.fromHex(o.scriptHex), satoshis: o.value }))
  }
  if (c.nLockTime !== undefined) tx.nLockTime = c.nLockTime
  if (c.sequence !== undefined) tx.inputs[0].sequenceNumber = c.sequence

  const preimageHex = getPreimage(tx, sub, VALUE, 0, c.flag)
  const sighash = bsv.crypto.Hash.sha256sha256(Buffer.from(preimageHex, 'hex'))
  return sighash.toString('hex')
}

function main() {
  const cases = CASES.map((c) => ({
    name: c.name,
    method: c.method,
    prevTxid: PREV_TXID,
    vout: 0,
    subscriptHex: SUBSCRIPT,
    inputValue: VALUE,
    inputIndex: 0,
    sequence: c.sequence ?? 0xffffffff,
    nLockTime: c.nLockTime ?? 0,
    flag: c.flag,
    outputs: c.outputs,
    sighashToSign: buildSighash(c),
  }))

  const doc = {
    version: 1,
    description:
      'peck.channel golden sighash vectors. sighashToSign = NATURAL BIP143 digest hash256(preimage) the user + gateway sign. TS: sha256sha256(getPreimage). Go: ReverseBytes(GetInputSignatureHash). A P2PKH stands in for the contract scriptCode (isolates the sighash algorithm).',
    cases,
  }
  const out = path.join(__dirname, 'sighash-vectors.json')
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n')
  console.log('wrote', out)
  for (const c of cases) console.log(`  ${c.name} (flag 0x${c.flag.toString(16)}) → ${c.sighashToSign}`)
}
main()
