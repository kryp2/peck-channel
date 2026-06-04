# Changelog

All notable changes to `peck-channel` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-06-03

First published release of the canonical BSV payment-channel primitive for the
peck ecosystem — an sCrypt lock-and-drain payment channel contract, a
non-custodial client library, and the protocol spec both the TypeScript and Go
implementations honour.

### Added

- **sCrypt contract** (`LLMPaymentChannel`): stateful UTXO with `drain()`,
  `close()` and `timeout()`. `amountSpent` and `paymentNonce` are on-chain
  state; nonce increments per drain for replay protection.
- **Non-custodial client library** (`src/client`): `deployChannel`,
  `PeckChannelGateway`, `buildDrainSpend`, `walletSignSighash`,
  `assembleDrainUnlock`, `loadContractArtifact`. The wallet signs only the user
  sighash; the gateway co-signs, fee-signs and broadcasts server-side — no
  private key ever crosses the boundary.
- **Protocol spec** (`PECK_CHANNEL_SPEC.md`) with golden sighash vectors and a
  TS/Go conformance harness, locking the standard at spec v1.
- **FIX A**: `close()` / `timeout()` take the miner fee from the channel value,
  so the gateway builds the close transaction and the wallet only authors its
  signature.
- **BRC-42 per-channel key derivation** on the gateway side.
- Meter-driven settlement driver plus gateway `start-meter` / `stop-meter`.
- `timeout()` reclaim — the gateway-independent safety valve returning the full
  lock amount to the user after `expiryTime`.
- Settle sidecar (`settle-sidecar/`): localhost scrypt-ts settle service,
  non-custodial prepare/finalize close endpoints, cosign-drain, and the
  `e2e-gopath-drain.ts` driver doubling as the on-chain conformance test
  (`npm run drain-e2e`).
- Project README, `PECK_CHANNEL_SPEC.md`, `CONVERGENCE_PLAN.md` and `IN_FLIGHT.md`.
- OSS packaging: published as the public npm package `peck-channel`, Open BSV
  License, GitHub Actions CI (`test.yml`), README badges and repo metadata.

### Changed

- Renamed `llm-payment-channel` → `peck-channel` across repo, directory and
  package; re-homed `FetchPaymentChannel` into `peck-channel` as the sibling
  variant.

### Proven on mainnet

The full channel lifecycle (deploy → drain → close → timeout) was validated
on-chain via the library, non-custodially:

- Non-custodial wallet-signed close — proven on mainnet.
- Non-custodial DRAIN (TS path and Go-HTTP path) — proven on mainnet.
- `close()` after drain with state continuation, and `timeout()` reclaim — all
  four channel operations complete on-chain.
- Reference drain proof: deploy `97fd93be…` / drain `569ddd1b…` (ARC 200).

[Unreleased]: https://github.com/kryp2/peck-channel/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/kryp2/peck-channel/releases/tag/v0.1.1
