/**
 * SIGHASH PARITY CHECK — does scryptlib's getPreimage→hash256 produce the SAME
 * ANYONECANPAY_SINGLE|FORKID sighash that peck-host's go-bt
 * tx.GetInputSignatureHash produces for a byte-identical tx?
 *
 * This de-risks the Go drain path WITHOUT a wallet: if the digests match, the
 * gateway sighash is exactly what scryptlib (and the BRC-100 wallet) will sign,
 * so the Go-path drain E2E is cryptographically sound up to the wallet boundary.
 *
 * Fixed params mirror billing/sighash_parity_test.go EXACTLY:
 *   prevTxid  = 1111...1111, vout 0
 *   scriptHex = 76a914...88ac (P2PKH all-zero hash160) — the scriptCode
 *   value     = 2500
 *   output[0] = same scriptHex, value 2500
 *   flag      = ANYONECANPAY|SINGLE|FORKID = 0xc3
 *
 * Go produced (run go test first):
 *   GO_SIGHASH_ASIS     = a10cb568517a585613cbba06e05c2ce425b20890f669e99f9064c686343ff18e
 *   GO_SIGHASH_REVERSED = 8ef13f3486c664909fe969f69008b225e42c5ce006bacb1356587a5168b50ca1
 *   GO_TX_HEX           = 0100000001 1111..1111 00000000 00 ffffffff 01 c409000000000000 1976a914..88ac 00000000
 */
import { bsv } from 'scrypt-ts'
import { getPreimage } from 'scryptlib'

const PREV_TXID = '1111111111111111111111111111111111111111111111111111111111111111'
const VOUT = 0
const SCRIPT_HEX = '76a914000000000000000000000000000000000000000088ac'
const VALUE = 2500
// ANYONECANPAY | SINGLE | FORKID
const FLAG =
  bsv.crypto.Signature.SIGHASH_ANYONECANPAY |
  bsv.crypto.Signature.SIGHASH_SINGLE |
  bsv.crypto.Signature.SIGHASH_FORKID

const GO_ASIS = 'a10cb568517a585613cbba06e05c2ce425b20890f669e99f9064c686343ff18e'
const GO_REVERSED = '8ef13f3486c664909fe969f69008b225e42c5ce006bacb1356587a5168b50ca1'

function main() {
  console.log('flag = 0x' + FLAG.toString(16))

  // Build the byte-identical tx: one input (prevTxid:0), one output (same script, same value).
  const script = bsv.Script.fromHex(SCRIPT_HEX)
  const tx = new bsv.Transaction()
  tx.addInput(
    new bsv.Transaction.Input({
      prevTxId: PREV_TXID,
      outputIndex: VOUT,
      script: bsv.Script.empty(),
      output: new bsv.Transaction.Output({ script, satoshis: VALUE }),
    })
  )
  tx.addOutput(new bsv.Transaction.Output({ script, satoshis: VALUE }))

  console.log('TS_TX_HEX        =', tx.toString())

  // scryptlib getPreimage → the BIP143 preimage; hash256 of it = the sighash.
  const preimageHex = getPreimage(tx, script, VALUE, 0, FLAG)
  const sighash = bsv.crypto.Hash.sha256sha256(Buffer.from(preimageHex, 'hex'))
  const asis = sighash.toString('hex')
  const reversed = Buffer.from(sighash).reverse().toString('hex')
  console.log('TS_SIGHASH_ASIS     =', asis)
  console.log('TS_SIGHASH_REVERSED =', reversed)

  const match =
    asis === GO_ASIS ||
    asis === GO_REVERSED ||
    reversed === GO_ASIS ||
    reversed === GO_REVERSED
  if (match) {
    console.log('\n✅ PARITY: TS scryptlib sighash MATCHES go-bt — Go drain path is cryptographically sound to the wallet boundary.')
  } else {
    console.log('\n❌ MISMATCH: scryptlib and go-bt produce different sighashes for the same tx.')
    console.log('   This must be reconciled before the Go-path E2E (the wallet would sign a digest the contract rejects).')
    process.exit(1)
  }
}
main()
