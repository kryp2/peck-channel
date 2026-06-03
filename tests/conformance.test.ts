/**
 * Golden sighash conformance (TS side).
 *
 * Asserts the TS lib's sighash construction (scryptlib getPreimage → hash256)
 * reproduces vectors/sighash-vectors.json EXACTLY. The Go gateway runs the sibling
 * test (peck-host billing/conformance_test.go) against the SAME file — so a passing
 * pair proves TS↔Go agree on the standard by contract, not by luck.
 */
import { bsv } from 'scrypt-ts'
import { getPreimage } from 'scryptlib'
import * as fs from 'fs'
import * as path from 'path'

const doc = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'vectors', 'sighash-vectors.json'), 'utf8')
)

describe('peck.channel golden sighash conformance (TS)', () => {
  test('vectors file is versioned and non-empty', () => {
    expect(doc.version).toBe(1)
    expect(doc.cases.length).toBeGreaterThan(0)
  })

  for (const c of doc.cases) {
    test(`${c.name} (flag 0x${c.flag.toString(16)})`, () => {
      const sub = bsv.Script.fromHex(c.subscriptHex)
      const tx = new bsv.Transaction()
      tx.addInput(
        new bsv.Transaction.Input({
          prevTxId: c.prevTxid,
          outputIndex: c.vout,
          script: bsv.Script.empty(),
          output: new bsv.Transaction.Output({ script: sub, satoshis: c.inputValue }),
        })
      )
      for (const o of c.outputs) {
        tx.addOutput(
          new bsv.Transaction.Output({ script: bsv.Script.fromHex(o.scriptHex), satoshis: o.value })
        )
      }
      tx.nLockTime = c.nLockTime
      tx.inputs[0].sequenceNumber = c.sequence

      const preimage = getPreimage(tx, sub, c.inputValue, c.inputIndex, c.flag)
      const sighash = bsv.crypto.Hash.sha256sha256(Buffer.from(preimage, 'hex')).toString('hex')
      expect(sighash).toBe(c.sighashToSign)
    })
  }
})
