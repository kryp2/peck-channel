import {
    bsv,
    TestWallet,
    DummyProvider,
    PubKey,
    MethodCallOptions,
    ContractTransaction,
    findSig,
    SignatureResponse,
} from 'scrypt-ts'
import { FetchPaymentChannel } from '../src/contracts/FetchPaymentChannel'
import * as path from 'path'
import * as fs from 'fs'

// NOTE: this contract lives in peck-overlay-schema, which has NO jest/ts-jest
// dev-deps and an ESM/NodeNext project tsconfig without the scrypt-ts
// transformer. This test was authored + green-run in an isolated CommonJS
// workspace (scrypt-cli compile + ts-jest, mirroring peck-channel):
//   9 passed (drain x3, close x3, timeout x2, sig-validation x1) on 2026-06-01.
// To re-run here you need scrypt-cli to compile the artifact and a ts-jest
// harness. The committed FetchPaymentChannel.json is the freshly recompiled
// artifact reflecting the FIX A close(sig,fee)/timeout(sig,fee) signatures.

// Helper: generate a random BSV private key.
// MUST be testnet: scrypt-ts DummyProvider reports testnet, and TestWallet
// only "owns" the testnet encoding of its keys. fromRandom() defaults to
// mainnet, so every signTransaction would reject the (mainnet) address with
// "does not belong to this TestWallet". (Harness lesson from LLMPaymentChannel.)
function randomPrivateKey(): bsv.PrivateKey {
    return bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
}

describe('FetchPaymentChannel', () => {
    let clientPrivKey: bsv.PrivateKey
    let serverPrivKey: bsv.PrivateKey
    let clientPubKey: PubKey
    let serverPubKey: PubKey

    beforeAll(async () => {
        // Co-located committed artifact (recompiled with FIX A signatures).
        // In the isolated CommonJS build workspace this was
        // ../artifacts/contracts/FetchPaymentChannel.json; in-tree the
        // artifact sits next to the contract.
        const artifactPath = path.join(__dirname, '..', 'artifacts', 'contracts', 'FetchPaymentChannel.json')
        if (!fs.existsSync(artifactPath)) {
            throw new Error(
                `Artifact not found at ${artifactPath}. Run 'npx scrypt-cli compile' first.`
            )
        }
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
        FetchPaymentChannel.loadArtifact(artifact)

        clientPrivKey = randomPrivateKey()
        serverPrivKey = randomPrivateKey()
        clientPubKey = PubKey(clientPrivKey.publicKey.toHex())
        serverPubKey = PubKey(serverPrivKey.publicKey.toHex())
    })

    function createInstance(
        lockAmount: bigint,
        expiryHeight: bigint
    ): FetchPaymentChannel {
        return new FetchPaymentChannel(
            clientPubKey,
            serverPubKey,
            lockAmount,
            expiryHeight
        )
    }

    async function deployInstance(
        instance: FetchPaymentChannel,
        lockAmount: number
    ): Promise<FetchPaymentChannel> {
        const signer = new TestWallet(clientPrivKey, new DummyProvider())
        signer.addPrivateKey(serverPrivKey)
        await instance.connect(signer)
        const deployTx = await instance.deploy(lockAmount)
        console.log(`  Deployed: ${deployTx.id}`)
        return instance
    }

    // FIX A: close()/timeout() take the fee FROM the channel value, so the
    // spending tx has a SINGLE input (the contract UTXO) + the payout outputs,
    // with no separate fee input and no change output (fee == input - outputs).
    // DummyProvider.getFeePerKb()==1, with a [estimateFee, 3*estimateFee] unspent
    // window; the signed tx is ~6KB (BIP143 preimage embeds the ~5.9KB locking
    // script), so estimateFee≈7 and the window is ≈[7,21]. (Real broadcast uses
    // 100 sat/kb via ARC — this tiny value is only the local mock's window.)
    const FEE = 14n
    function p2pkhOf(priv: bsv.PrivateKey): bsv.Script {
        return bsv.Script.buildPublicKeyHashOut(
            bsv.Address.fromPublicKey(priv.publicKey, bsv.Networks.testnet)
        )
    }
    function bindClose(deployed: FetchPaymentChannel, fee: bigint): void {
        deployed.bindTxBuilder(
            'close',
            async (
                current: FetchPaymentChannel
            ): Promise<ContractTransaction> => {
                const serverAmount = Number(current.amountSpent)
                const clientAmount = Number(
                    current.lockAmount - current.amountSpent - fee
                )
                const tx = new bsv.Transaction().addInput(
                    current.buildContractInput()
                )
                if (serverAmount > 0) {
                    tx.addOutput(
                        new bsv.Transaction.Output({
                            script: p2pkhOf(serverPrivKey),
                            satoshis: serverAmount,
                        })
                    )
                }
                if (clientAmount > 0) {
                    tx.addOutput(
                        new bsv.Transaction.Output({
                            script: p2pkhOf(clientPrivKey),
                            satoshis: clientAmount,
                        })
                    )
                }
                tx.fee(Number(fee))
                return { tx, atInputIndex: 0, nexts: [] }
            }
        )
    }
    function bindTimeout(
        deployed: FetchPaymentChannel,
        fee: bigint,
        lockTime: number
    ): void {
        deployed.bindTxBuilder(
            'timeout',
            async (
                current: FetchPaymentChannel
            ): Promise<ContractTransaction> => {
                const clientAmount = Number(current.lockAmount - fee)
                const tx = new bsv.Transaction().addInput(
                    current.buildContractInput()
                )
                tx.addOutput(
                    new bsv.Transaction.Output({
                        script: p2pkhOf(clientPrivKey),
                        satoshis: clientAmount,
                    })
                )
                tx.fee(Number(fee))
                tx.inputs[0].sequenceNumber = 0xfffffffe
                tx.nLockTime = lockTime
                return { tx, atInputIndex: 0, nexts: [] }
            }
        )
    }

    // ─────────────────────────────────────────────
    // drain() — anchor a mutually-signed state update on-chain.
    // FetchPaymentChannel semantics differ from LLMPaymentChannel:
    //  - newAmountSpent is ABSOLUTE (must be >= current, <= lockAmount)
    //  - newNonce must STRICTLY INCREASE (not match-then-increment)
    //  - UTXO value is unchanged (funds stay locked until close/timeout)
    // ─────────────────────────────────────────────
    describe('drain()', () => {
        it('should drain with valid dual signatures and increasing nonce', async () => {
            const lockAmount = 10000n
            const instance = createInstance(lockAmount, 800000n)
            const deployed = await deployInstance(instance, Number(lockAmount))

            const newSpent = 100n
            const nextInstance = deployed.next()
            nextInstance.amountSpent = newSpent
            nextInstance.nonce = 1n

            const callTx = await deployed.methods.drain(
                newSpent,
                1n, // newNonce (> 0)
                (sigResps: SignatureResponse[]) =>
                    findSig(sigResps, clientPrivKey.publicKey),
                (sigResps: SignatureResponse[]) =>
                    findSig(sigResps, serverPrivKey.publicKey),
                {
                    pubKeyOrAddrToSign: [
                        clientPrivKey.publicKey,
                        serverPrivKey.publicKey,
                    ],
                    next: {
                        instance: nextInstance,
                        balance: Number(lockAmount),
                    },
                } as MethodCallOptions<FetchPaymentChannel>
            )
            console.log(`  drain() TX: ${callTx.tx.id}`)
            expect(callTx.tx.id).toBeTruthy()
        })

        it('should reject drain with non-increasing nonce (replay protection)', async () => {
            const lockAmount = 10000n
            const instance = createInstance(lockAmount, 800000n)
            const deployed = await deployInstance(instance, Number(lockAmount))

            const nextInstance = deployed.next()
            nextInstance.amountSpent = 100n
            nextInstance.nonce = 0n

            await expect(
                deployed.methods.drain(
                    100n,
                    0n, // not strictly > current nonce (0)
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, clientPrivKey.publicKey),
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, serverPrivKey.publicKey),
                    {
                        pubKeyOrAddrToSign: [
                            clientPrivKey.publicKey,
                            serverPrivKey.publicKey,
                        ],
                        next: {
                            instance: nextInstance,
                            balance: Number(lockAmount),
                        },
                    } as MethodCallOptions<FetchPaymentChannel>
                )
            ).rejects.toThrow()
        })

        it('should reject drain exceeding lockAmount', async () => {
            const lockAmount = 1000n
            const instance = createInstance(lockAmount, 800000n)
            const deployed = await deployInstance(instance, Number(lockAmount))

            const nextInstance = deployed.next()
            nextInstance.amountSpent = 1001n
            nextInstance.nonce = 1n

            await expect(
                deployed.methods.drain(
                    1001n, // exceeds lockAmount
                    1n,
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, clientPrivKey.publicKey),
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, serverPrivKey.publicKey),
                    {
                        pubKeyOrAddrToSign: [
                            clientPrivKey.publicKey,
                            serverPrivKey.publicKey,
                        ],
                        next: {
                            instance: nextInstance,
                            balance: Number(lockAmount),
                        },
                    } as MethodCallOptions<FetchPaymentChannel>
                )
            ).rejects.toThrow()
        })
    })

    // ─────────────────────────────────────────────
    // close() — split server/client, fee taken FROM value (FIX A)
    // ─────────────────────────────────────────────
    describe('close()', () => {
        it('should close channel and split funds correctly (fee from value)', async () => {
            const lockAmount = 10000n
            const instance = createInstance(lockAmount, 800000n)
            instance.amountSpent = 3000n // simulate prior drains

            const deployed = await deployInstance(instance, Number(lockAmount))
            bindClose(deployed, FEE)

            const callTx = await deployed.methods.close(
                (sigResps: SignatureResponse[]) =>
                    findSig(sigResps, clientPrivKey.publicKey),
                FEE,
                {
                    pubKeyOrAddrToSign: [clientPrivKey.publicKey],
                    autoPayFee: false,
                } as MethodCallOptions<FetchPaymentChannel>
            )
            console.log(`  close() TX: ${callTx.tx.id}`)
            expect(callTx.tx.id).toBeTruthy()
            // [server 3000, client 10000-3000-14=6986]; fee 14 from value.
            expect(callTx.tx.outputs.length).toBe(2)
            expect(callTx.tx.outputs[0].satoshis).toBe(3000)
            expect(callTx.tx.outputs[1].satoshis).toBe(
                10000 - 3000 - Number(FEE)
            )
        })

        it('should close with zero amountSpent (full refund to client, minus fee)', async () => {
            const lockAmount = 10000n
            const instance = createInstance(lockAmount, 800000n)

            const deployed = await deployInstance(instance, Number(lockAmount))
            bindClose(deployed, FEE)

            const callTx = await deployed.methods.close(
                (sigResps: SignatureResponse[]) =>
                    findSig(sigResps, clientPrivKey.publicKey),
                FEE,
                {
                    pubKeyOrAddrToSign: [clientPrivKey.publicKey],
                    autoPayFee: false,
                } as MethodCallOptions<FetchPaymentChannel>
            )
            console.log(`  close() (zero spent) TX: ${callTx.tx.id}`)
            expect(callTx.tx.id).toBeTruthy()
            // single client output 10000-14=9986.
            expect(callTx.tx.outputs.length).toBe(1)
            expect(callTx.tx.outputs[0].satoshis).toBe(10000 - Number(FEE))
        })

        it('should close fully drained (only server output)', async () => {
            const lockAmount = 10000n
            const instance = createInstance(lockAmount, 800000n)
            // amountSpent == lockAmount - fee → client remainder is 0
            instance.amountSpent = lockAmount - FEE

            const deployed = await deployInstance(instance, Number(lockAmount))
            bindClose(deployed, FEE)

            const callTx = await deployed.methods.close(
                (sigResps: SignatureResponse[]) =>
                    findSig(sigResps, clientPrivKey.publicKey),
                FEE,
                {
                    pubKeyOrAddrToSign: [clientPrivKey.publicKey],
                    autoPayFee: false,
                } as MethodCallOptions<FetchPaymentChannel>
            )
            console.log(`  close() (fully drained) TX: ${callTx.tx.id}`)
            expect(callTx.tx.id).toBeTruthy()
            // only server output: lockAmount - fee = 9986; client amount 0.
            expect(callTx.tx.outputs.length).toBe(1)
            expect(callTx.tx.outputs[0].satoshis).toBe(
                Number(lockAmount - FEE)
            )
        })
    })

    // ─────────────────────────────────────────────
    // timeout() — client reclaims after expiryHeight (fee from value)
    // ─────────────────────────────────────────────
    describe('timeout()', () => {
        it('should allow client to reclaim after expiry', async () => {
            const expiryHeight = 700000n
            const lockAmount = 10000n
            const instance = createInstance(lockAmount, expiryHeight)

            const deployed = await deployInstance(instance, Number(lockAmount))
            const lockTime = Number(expiryHeight) + 1
            bindTimeout(deployed, FEE, lockTime)

            const callTx = await deployed.methods.timeout(
                (sigResps: SignatureResponse[]) =>
                    findSig(sigResps, clientPrivKey.publicKey),
                FEE,
                {
                    pubKeyOrAddrToSign: [clientPrivKey.publicKey],
                    lockTime,
                    autoPayFee: false,
                } as MethodCallOptions<FetchPaymentChannel>
            )
            console.log(`  timeout() TX: ${callTx.tx.id}`)
            expect(callTx.tx.id).toBeTruthy()
            // single client refund = 10000-14=9986.
            expect(callTx.tx.outputs.length).toBe(1)
            expect(callTx.tx.outputs[0].satoshis).toBe(10000 - Number(FEE))
        })

        it('should reject timeout before expiry', async () => {
            const expiryHeight = 800000n
            const lockAmount = 10000n
            const instance = createInstance(lockAmount, expiryHeight)

            const deployed = await deployInstance(instance, Number(lockAmount))
            const lockTime = Number(expiryHeight) - 100 // before expiry
            bindTimeout(deployed, FEE, lockTime)

            await expect(
                deployed.methods.timeout(
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, clientPrivKey.publicKey),
                    FEE,
                    {
                        pubKeyOrAddrToSign: [clientPrivKey.publicKey],
                        lockTime,
                        autoPayFee: false,
                    } as MethodCallOptions<FetchPaymentChannel>
                )
            ).rejects.toThrow()
        })
    })

    // ─────────────────────────────────────────────
    // signature validation
    // ─────────────────────────────────────────────
    describe('signature validation', () => {
        it('should reject close with wrong client signature', async () => {
            const lockAmount = 10000n
            const wrongKey = randomPrivateKey()
            const instance = createInstance(lockAmount, 800000n)
            const deployed = await deployInstance(instance, Number(lockAmount))

            ;(deployed.signer as TestWallet).addPrivateKey(wrongKey)
            bindClose(deployed, FEE)

            await expect(
                deployed.methods.close(
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, wrongKey.publicKey),
                    FEE,
                    {
                        pubKeyOrAddrToSign: [wrongKey.publicKey],
                        autoPayFee: false,
                    } as MethodCallOptions<FetchPaymentChannel>
                )
            ).rejects.toThrow()
        })
    })
})
