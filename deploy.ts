import { LLMPaymentChannel } from './src/contracts/LLMPaymentChannel'
import { bsv, PubKey, TestWallet, DefaultProvider } from 'scrypt-ts'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Deploy an LLM Payment Channel
 *
 * Usage:
 *   ts-node deploy.ts <userPrivKeyWIF> <gatewayPubKeyHex> <lockAmountSats> [expirySeconds]
 *
 * Arguments:
 *   userPrivKeyWIF   - WIF-encoded private key of the user funding the channel
 *   gatewayPubKeyHex - Hex-encoded public key of the LLM gateway operator
 *   lockAmountSats   - Amount of satoshis to lock in the channel
 *   expirySeconds    - (Optional) Channel lifetime in seconds (default: 86400 = 24h)
 */
async function deploy() {
    try {
        // Parse arguments
        const userPrivKeyWIF = process.argv[2]
        const gatewayPubKeyHex = process.argv[3]
        const lockAmountSats = parseInt(process.argv[4])
        const expirySeconds = parseInt(process.argv[5]) || 86400 // default: 24 hours

        if (!userPrivKeyWIF || !gatewayPubKeyHex || !lockAmountSats) {
            console.error(
                'Usage: ts-node deploy.ts <userPrivKeyWIF> <gatewayPubKeyHex> <lockAmountSats> [expirySeconds]'
            )
            process.exit(1)
        }

        // Load compiled contract artifact
        const artifactPath = path.join(__dirname, 'artifacts', 'contracts', 'LLMPaymentChannel.json')
        if (!fs.existsSync(artifactPath)) {
            throw new Error(
                `Artifact not found at ${artifactPath}. Run 'npx scrypt-cli compile' first.`
            )
        }
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
        LLMPaymentChannel.loadArtifact(artifact)

        // Set up wallet from user's private key
        const userPrivKey = bsv.PrivateKey.fromWIF(userPrivKeyWIF)
        const userPubKey = PubKey(userPrivKey.publicKey.toHex())
        const gatewayPubKey = PubKey(gatewayPubKeyHex)

        // Calculate expiry time
        const expiryTime = BigInt(Math.floor(Date.now() / 1000) + expirySeconds)

        // Create the contract instance
        const instance = new LLMPaymentChannel(
            userPubKey,
            gatewayPubKey,
            BigInt(lockAmountSats),
            expiryTime
        )

        // Connect signer and deploy
        const signer = new TestWallet(userPrivKey, new DefaultProvider())
        await instance.connect(signer)
        const deployTx = await instance.deploy(lockAmountSats)

        // Output deployment info as JSON (for LLM Gateway to consume)
        console.log(
            JSON.stringify({
                status: 'success',
                channelId: deployTx.id,
                lockAmount: lockAmountSats,
                expiryTime: Number(expiryTime),
                userPubKey: userPubKey,
                gatewayPubKey: gatewayPubKey,
            })
        )
    } catch (e: any) {
        console.log(
            JSON.stringify({ status: 'error', message: e.message || String(e) })
        )
        process.exit(1)
    }
}

deploy()
