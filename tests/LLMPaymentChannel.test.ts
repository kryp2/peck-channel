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
import { LLMPaymentChannel } from '../src/contracts/LLMPaymentChannel'
import * as path from 'path'
import * as fs from 'fs'

// Helper: generate a random BSV private key.
// MUST be testnet: scrypt-ts DummyProvider reports testnet, and TestWallet
// only "owns" the testnet encoding of its keys. fromRandom() defaults to
// mainnet, so every signTransaction rejected the (mainnet) change address
// with "does not belong to this TestWallet". Mirrors peck-bio catToken.test.
function randomPrivateKey(): bsv.PrivateKey {
    return bsv.PrivateKey.fromRandom(bsv.Networks.testnet)
}

describe('LLMPaymentChannel', () => {
    let userPrivKey: bsv.PrivateKey
    let gatewayPrivKey: bsv.PrivateKey
    let userPubKey: PubKey
    let gatewayPubKey: PubKey

    beforeAll(async () => {
        // Load the compiled artifact
        const artifactPath = path.join(
            __dirname,
            '..',
            'artifacts',
            'contracts',
            'LLMPaymentChannel.json'
        )
        if (!fs.existsSync(artifactPath)) {
            throw new Error(
                `Artifact not found at ${artifactPath}. Run 'npx scrypt-cli compile' first.`
            )
        }
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
        LLMPaymentChannel.loadArtifact(artifact)

        // Generate test keys
        userPrivKey = randomPrivateKey()
        gatewayPrivKey = randomPrivateKey()
        userPubKey = PubKey(userPrivKey.publicKey.toHex())
        gatewayPubKey = PubKey(gatewayPrivKey.publicKey.toHex())
    })

    function createInstance(lockAmount: bigint, expiryTime: bigint): LLMPaymentChannel {
        return new LLMPaymentChannel(userPubKey, gatewayPubKey, lockAmount, expiryTime)
    }

    async function deployInstance(
        instance: LLMPaymentChannel,
        lockAmount: number
    ): Promise<LLMPaymentChannel> {
        // Use DummyProvider for fully local testing (no network)
        const signer = new TestWallet(
            userPrivKey,
            new DummyProvider()
        )
        // Also add the gateway key so it can sign drain() calls
        signer.addPrivateKey(gatewayPrivKey)

        await instance.connect(signer)
        const deployTx = await instance.deploy(lockAmount)
        console.log(`  Deployed: ${deployTx.id}`)
        return instance
    }

    // FIX A: close()/timeout() take the fee FROM the channel value, so the
    // spending tx has a SINGLE input (the contract UTXO) + the payout outputs,
    // with no separate fee input and no change output (fee == input - outputs).
    // DummyProvider.getFeePerKb()==1, and it requires unspent ∈ [estimateFee,
    // 3*estimateFee] where estimateFee=ceil(txBytes/1000). The signed close/timeout
    // tx is ~6KB (the BIP143 preimage embeds the ~5.9KB locking script), so
    // estimateFee≈7 and the mock fee window is ≈[7,21]. (Real broadcast uses
    // 100 sat/kb via ARC — this tiny value is only the local mock's window.)
    const FEE = 14n
    function p2pkhOf(priv: bsv.PrivateKey): bsv.Script {
        return bsv.Script.buildPublicKeyHashOut(
            bsv.Address.fromPublicKey(priv.publicKey, bsv.Networks.testnet)
        )
    }
    function bindClose(deployed: LLMPaymentChannel, fee: bigint): void {
        deployed.bindTxBuilder(
            'close',
            async (current: LLMPaymentChannel): Promise<ContractTransaction> => {
                const gatewayAmount = Number(current.amountSpent)
                const userAmount = Number(current.lockAmount - current.amountSpent - fee)
                const tx = new bsv.Transaction().addInput(current.buildContractInput())
                if (gatewayAmount > 0) {
                    tx.addOutput(new bsv.Transaction.Output({ script: p2pkhOf(gatewayPrivKey), satoshis: gatewayAmount }))
                }
                if (userAmount > 0) {
                    tx.addOutput(new bsv.Transaction.Output({ script: p2pkhOf(userPrivKey), satoshis: userAmount }))
                }
                tx.fee(Number(fee))
                return { tx, atInputIndex: 0, nexts: [] }
            }
        )
    }
    function bindTimeout(deployed: LLMPaymentChannel, fee: bigint, lockTime: number): void {
        deployed.bindTxBuilder(
            'timeout',
            async (current: LLMPaymentChannel): Promise<ContractTransaction> => {
                const userAmount = Number(current.lockAmount - fee)
                const tx = new bsv.Transaction().addInput(current.buildContractInput())
                tx.addOutput(new bsv.Transaction.Output({ script: p2pkhOf(userPrivKey), satoshis: userAmount }))
                tx.fee(Number(fee))
                tx.inputs[0].sequenceNumber = 0xfffffffe
                tx.nLockTime = lockTime
                return { tx, atInputIndex: 0, nexts: [] }
            }
        )
    }

    // ─────────────────────────────────────────────
    // drain() tests
    // ─────────────────────────────────────────────
    describe('drain()', () => {
        it('should drain with valid dual signatures and correct nonce', async () => {
            const lockAmount = 10000n
            const instance = createInstance(
                lockAmount,
                BigInt(Math.floor(Date.now() / 1000) + 86400)
            )
            const deployed = await deployInstance(instance, Number(lockAmount))

            const drainAmount = 100n
            const nextInstance = deployed.next()
            nextInstance.amountSpent = drainAmount
            nextInstance.paymentNonce = 1n

            const callTx = await deployed.methods.drain(
                drainAmount,
                0n, // nonce
                (sigResps: SignatureResponse[]) => findSig(sigResps, userPrivKey.publicKey),
                (sigResps: SignatureResponse[]) =>
                    findSig(sigResps, gatewayPrivKey.publicKey),
                {
                    pubKeyOrAddrToSign: [
                        userPrivKey.publicKey,
                        gatewayPrivKey.publicKey,
                    ],
                    next: {
                        instance: nextInstance,
                        balance: Number(lockAmount),
                    },
                } as MethodCallOptions<LLMPaymentChannel>
            )
            console.log(`  drain() TX: ${callTx.tx.id}`)
            expect(callTx.tx.id).toBeTruthy()
        })

        it('should reject drain with wrong nonce (replay protection)', async () => {
            const lockAmount = 10000n
            const instance = createInstance(
                lockAmount,
                BigInt(Math.floor(Date.now() / 1000) + 86400)
            )
            const deployed = await deployInstance(instance, Number(lockAmount))

            const drainAmount = 100n
            const nextInstance = deployed.next()
            nextInstance.amountSpent = drainAmount
            nextInstance.paymentNonce = 1n

            await expect(
                deployed.methods.drain(
                    drainAmount,
                    999n, // wrong nonce
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, userPrivKey.publicKey),
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, gatewayPrivKey.publicKey),
                    {
                        pubKeyOrAddrToSign: [
                            userPrivKey.publicKey,
                            gatewayPrivKey.publicKey,
                        ],
                        next: {
                            instance: nextInstance,
                            balance: Number(lockAmount),
                        },
                    } as MethodCallOptions<LLMPaymentChannel>
                )
            ).rejects.toThrow()
        })

        it('should reject drain exceeding lockAmount', async () => {
            const lockAmount = 1000n
            const instance = createInstance(
                lockAmount,
                BigInt(Math.floor(Date.now() / 1000) + 86400)
            )
            const deployed = await deployInstance(instance, Number(lockAmount))

            const drainAmount = 1001n // exceeds lockAmount
            const nextInstance = deployed.next()
            nextInstance.amountSpent = drainAmount
            nextInstance.paymentNonce = 1n

            await expect(
                deployed.methods.drain(
                    drainAmount,
                    0n,
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, userPrivKey.publicKey),
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, gatewayPrivKey.publicKey),
                    {
                        pubKeyOrAddrToSign: [
                            userPrivKey.publicKey,
                            gatewayPrivKey.publicKey,
                        ],
                        next: {
                            instance: nextInstance,
                            balance: Number(lockAmount),
                        },
                    } as MethodCallOptions<LLMPaymentChannel>
                )
            ).rejects.toThrow()
        })

        it('should reject drain with zero amount', async () => {
            const lockAmount = 10000n
            const instance = createInstance(
                lockAmount,
                BigInt(Math.floor(Date.now() / 1000) + 86400)
            )
            const deployed = await deployInstance(instance, Number(lockAmount))

            const nextInstance = deployed.next()
            nextInstance.amountSpent = 0n
            nextInstance.paymentNonce = 1n

            await expect(
                deployed.methods.drain(
                    0n, // zero amount
                    0n,
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, userPrivKey.publicKey),
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, gatewayPrivKey.publicKey),
                    {
                        pubKeyOrAddrToSign: [
                            userPrivKey.publicKey,
                            gatewayPrivKey.publicKey,
                        ],
                        next: {
                            instance: nextInstance,
                            balance: Number(lockAmount),
                        },
                    } as MethodCallOptions<LLMPaymentChannel>
                )
            ).rejects.toThrow()
        })
    })

    // ─────────────────────────────────────────────
    // close() tests
    // ─────────────────────────────────────────────
    describe('close()', () => {
        it('should close channel and split funds correctly', async () => {
            const lockAmount = 10000n
            const instance = createInstance(
                lockAmount,
                BigInt(Math.floor(Date.now() / 1000) + 86400)
            )

            // Simulate that some amount has been drained
            instance.amountSpent = 3000n

            const deployed = await deployInstance(instance, Number(lockAmount))
            bindClose(deployed, FEE)

            const callTx = await deployed.methods.close(
                (sigResps: SignatureResponse[]) =>
                    findSig(sigResps, userPrivKey.publicKey),
                FEE,
                {
                    pubKeyOrAddrToSign: [userPrivKey.publicKey],
                    autoPayFee: false,
                } as MethodCallOptions<LLMPaymentChannel>
            )
            console.log(`  close() TX: ${callTx.tx.id}`)
            expect(callTx.tx.id).toBeTruthy()
            // [gateway 3000, user 10000-3000-700=6300]; fee 700 taken from value.
            expect(callTx.tx.outputs.length).toBe(2)
            expect(callTx.tx.outputs[0].satoshis).toBe(3000)
            expect(callTx.tx.outputs[1].satoshis).toBe(10000 - 3000 - Number(FEE))
        })

        it('should close channel with zero amountSpent (full refund to user)', async () => {
            const lockAmount = 10000n
            const instance = createInstance(
                lockAmount,
                BigInt(Math.floor(Date.now() / 1000) + 86400)
            )

            const deployed = await deployInstance(instance, Number(lockAmount))
            bindClose(deployed, FEE)

            const callTx = await deployed.methods.close(
                (sigResps: SignatureResponse[]) =>
                    findSig(sigResps, userPrivKey.publicKey),
                FEE,
                {
                    pubKeyOrAddrToSign: [userPrivKey.publicKey],
                    autoPayFee: false,
                } as MethodCallOptions<LLMPaymentChannel>
            )
            console.log(`  close() (zero spent) TX: ${callTx.tx.id}`)
            expect(callTx.tx.id).toBeTruthy()
            // amountSpent 0 → single user output 10000-700=9300.
            expect(callTx.tx.outputs.length).toBe(1)
            expect(callTx.tx.outputs[0].satoshis).toBe(10000 - Number(FEE))
        })
    })

    // ─────────────────────────────────────────────
    // timeout() tests
    // ─────────────────────────────────────────────
    describe('timeout()', () => {
        it('should allow user to reclaim after expiry', async () => {
            const pastExpiry = BigInt(Math.floor(Date.now() / 1000) - 3600) // 1 hour ago
            const lockAmount = 10000n
            const instance = createInstance(lockAmount, pastExpiry)

            const deployed = await deployInstance(instance, Number(lockAmount))
            bindTimeout(deployed, FEE, Number(pastExpiry) + 1)

            const callTx = await deployed.methods.timeout(
                (sigResps: SignatureResponse[]) =>
                    findSig(sigResps, userPrivKey.publicKey),
                FEE,
                {
                    pubKeyOrAddrToSign: [userPrivKey.publicKey],
                    lockTime: Number(pastExpiry) + 1, // locktime after expiry
                    autoPayFee: false,
                } as MethodCallOptions<LLMPaymentChannel>
            )
            console.log(`  timeout() TX: ${callTx.tx.id}`)
            expect(callTx.tx.id).toBeTruthy()
            // single user refund = 10000-700=9300.
            expect(callTx.tx.outputs.length).toBe(1)
            expect(callTx.tx.outputs[0].satoshis).toBe(10000 - Number(FEE))
        })

        it('should reject timeout before expiry', async () => {
            const futureExpiry = BigInt(Math.floor(Date.now() / 1000) + 86400)
            const lockAmount = 10000n
            const instance = createInstance(lockAmount, futureExpiry)

            const deployed = await deployInstance(instance, Number(lockAmount))
            const nowLock = Math.floor(Date.now() / 1000)
            bindTimeout(deployed, FEE, nowLock)

            await expect(
                deployed.methods.timeout(
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, userPrivKey.publicKey),
                    FEE,
                    {
                        pubKeyOrAddrToSign: [userPrivKey.publicKey],
                        lockTime: nowLock, // current time, before expiry
                        autoPayFee: false,
                    } as MethodCallOptions<LLMPaymentChannel>
                )
            ).rejects.toThrow()
        })
    })

    // ─────────────────────────────────────────────
    // Signature validation tests
    // ─────────────────────────────────────────────
    describe('signature validation', () => {
        it('should reject drain with wrong user signature', async () => {
            const lockAmount = 10000n
            const wrongKey = randomPrivateKey()
            const instance = createInstance(
                lockAmount,
                BigInt(Math.floor(Date.now() / 1000) + 86400)
            )
            const deployed = await deployInstance(instance, Number(lockAmount))

            // Add the wrong key to the signer
            ;(deployed.signer as TestWallet).addPrivateKey(wrongKey)

            const nextInstance = deployed.next()
            nextInstance.amountSpent = 100n
            nextInstance.paymentNonce = 1n

            await expect(
                deployed.methods.drain(
                    100n,
                    0n,
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, wrongKey.publicKey), // wrong user key
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, gatewayPrivKey.publicKey),
                    {
                        pubKeyOrAddrToSign: [
                            wrongKey.publicKey,
                            gatewayPrivKey.publicKey,
                        ],
                        next: {
                            instance: nextInstance,
                            balance: Number(lockAmount),
                        },
                    } as MethodCallOptions<LLMPaymentChannel>
                )
            ).rejects.toThrow()
        })

        it('should reject close with wrong user signature', async () => {
            const lockAmount = 10000n
            const wrongKey = randomPrivateKey()
            const instance = createInstance(
                lockAmount,
                BigInt(Math.floor(Date.now() / 1000) + 86400)
            )
            const deployed = await deployInstance(instance, Number(lockAmount))

            // Add the wrong key to the signer
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
                    } as MethodCallOptions<LLMPaymentChannel>
                )
            ).rejects.toThrow()
        })
    })
})
