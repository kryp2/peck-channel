import {
    bsv,
    TestWallet,
    DummyProvider,
    PubKey,
    MethodCallOptions,
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

            const callTx = await deployed.methods.close(
                (sigResps: SignatureResponse[]) =>
                    findSig(sigResps, userPrivKey.publicKey),
                {
                    pubKeyOrAddrToSign: [userPrivKey.publicKey],
                } as MethodCallOptions<LLMPaymentChannel>
            )
            console.log(`  close() TX: ${callTx.tx.id}`)
            expect(callTx.tx.id).toBeTruthy()
        })

        it('should close channel with zero amountSpent (full refund to user)', async () => {
            const lockAmount = 10000n
            const instance = createInstance(
                lockAmount,
                BigInt(Math.floor(Date.now() / 1000) + 86400)
            )

            const deployed = await deployInstance(instance, Number(lockAmount))

            const callTx = await deployed.methods.close(
                (sigResps: SignatureResponse[]) =>
                    findSig(sigResps, userPrivKey.publicKey),
                {
                    pubKeyOrAddrToSign: [userPrivKey.publicKey],
                } as MethodCallOptions<LLMPaymentChannel>
            )
            console.log(`  close() (zero spent) TX: ${callTx.tx.id}`)
            expect(callTx.tx.id).toBeTruthy()
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

            const callTx = await deployed.methods.timeout(
                (sigResps: SignatureResponse[]) =>
                    findSig(sigResps, userPrivKey.publicKey),
                {
                    pubKeyOrAddrToSign: [userPrivKey.publicKey],
                    lockTime: Number(pastExpiry) + 1, // locktime after expiry
                } as MethodCallOptions<LLMPaymentChannel>
            )
            console.log(`  timeout() TX: ${callTx.tx.id}`)
            expect(callTx.tx.id).toBeTruthy()
        })

        it('should reject timeout before expiry', async () => {
            const futureExpiry = BigInt(Math.floor(Date.now() / 1000) + 86400)
            const lockAmount = 10000n
            const instance = createInstance(lockAmount, futureExpiry)

            const deployed = await deployInstance(instance, Number(lockAmount))

            await expect(
                deployed.methods.timeout(
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, userPrivKey.publicKey),
                    {
                        pubKeyOrAddrToSign: [userPrivKey.publicKey],
                        lockTime: Math.floor(Date.now() / 1000), // current time, before expiry
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

            await expect(
                deployed.methods.close(
                    (sigResps: SignatureResponse[]) =>
                        findSig(sigResps, wrongKey.publicKey),
                    {
                        pubKeyOrAddrToSign: [wrongKey.publicKey],
                    } as MethodCallOptions<LLMPaymentChannel>
                )
            ).rejects.toThrow()
        })
    })
})
