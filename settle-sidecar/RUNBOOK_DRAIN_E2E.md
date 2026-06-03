# Runbook — non-custodial drain E2E gjennom peck.run

_Bevise peck.channel drain-sømmen mot peck-host (peck.run) sin Go-HTTP-sti, non-custodial. Krever Thomas' BRC-100-wallet (peck-desktop kjørende). 2026-06-02._

## Hva dette beviser
Drain hvor walleten KUN signerer bruker-sighash. Gatewayen co-signer (`/cosign-drain`) og fee-signer (`/submit-drain`) server-side. Ingen gateway-nøkkel i klienten — `PECKHOST_FEE_WIF` er borte.

## Forutsetninger
- peck-desktop / BRC-100-wallet kjører (driveren bruker `WalletClient('auto', ...)`).
- En finansiert gateway-nøkkel: `PECKHOST_PRIVKEY` (WIF) + matchende `PECKHOST_PUBKEY` (hex). Fee-fund-UTXO betales til denne adressen i deploy-tx.
- Walleten har sats til `LOCK` (600) + `FEEFUND` (1400) + miner-fee for deploy-tx.

## Steg

**1. Start peck-host lokalt i NON-mock (ekte ARC):**
```bash
cd /home/thomas/Documents/peck-to/peck-host
PECKHOST_PRIVKEY=<wif> PECKHOST_PUBKEY=<hex> \
  ARC_URL=https://arc.gorillapool.io/v1/tx \
  PECKHOST_ALLOW_ACCRUE=1 PORT=8080 \
  go run ./cmd/main.go < /dev/null
```
(`PECKHOST_ALLOW_ACCRUE=1` lar driveren sette PendingDrain uten metering-loopen. MOCK_MODE usatt → ekte broadcast.)

**2. Kompiler kontrakten (om ikke gjort):**
```bash
cd /home/thomas/Documents/peck-to/peck-channel
npm run build < /dev/null   # → artifacts/contracts/LLMPaymentChannel.json
```

**3. Kjør driveren (egen terminal, samme PECKHOST_PUBKEY):**
```bash
cd /home/thomas/Documents/peck-to/peck-channel
PECKHOST_PUBKEY=<hex> PECK_HOST_URL=http://localhost:8080 \
  npx ts-node settle-sidecar/e2e-gopath-drain.ts < /dev/null
```
**Merk:** Ikke sett `PECKHOST_FEE_WIF` — den er ikke lenger i bruk. Hvis du setter den, signerer klienten fee-input selv og gateway-fee-signeringen blir no-op (fortsatt gyldig, men ikke den non-custodial stien vi beviser).

## Wallet-prompts (2)
- **PROMPT #1** — godkjenn kanal-deposit (`LOCK` + `FEEFUND`-output i deploy-tx).
- **PROMPT #2** — godkjenn drain-signaturen (`createSignature{hashToDirectlySign}`).

## Forventet utfall
```
🎉 DRAIN PROVEN THROUGH THE GO HTTP PATH — deploy <txid> / drain <txid>
```
Drain-txid `SEEN_ON_NETWORK` på ARC. Kanalverdien (`LOCK`) holdes konstant; fee tas fra fee-fund-input.

## Hvis det feiler
- `cosign-drain failed` → sjekk at `/open` ble kjørt (kanalen må være drain-ready: `script_hex` satt).
- `gateway fee-sign failed: fee input not found` → `fee_vout`/`fee_txid` i `/open` matcher ikke deploy-tx sin fee-output. Driveren setter `fee_txid=dep.txid`, `fee_vout=feeVout` automatisk.
- `drain verify failed` → state-output value/prefix-mismatch (sjekk at `PECKHOST_PUBKEY` i driver == den peck-host startet med, ellers binder kontrakten feil gateway-nøkkel).
- Deploy-tx er alltid reclaimable via `timeout()` etter expiry hvis noe stopper underveis.

## Etter bevist
Oppdater `IN_FLIGHT.md` + minne. Neste lag: seed `peck-channel`-pakken rundt denne stien, mirror til FetchPaymentChannel, så peck.run-meteren driver det automatisk (uten accrue-hooken).
