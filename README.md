# llm-payment-channel

sCrypt smart contract for BSV that implements a **lock-and-drain payment channel** for the LLM Gateway. Users lock satoshis on-chain, the gateway drains per API call, and the channel settles when closed or timed out.

## Arkitektur

```
┌─────────────────────────────────────────────────────────┐
│                       Klient                            │
│  (peck-desktop, opencode, peck-web, etc.)               │
└────────────────────────┬────────────────────────────────┘
                         │
              1. Deploy LLMPaymentChannel
              2. Sett channel_id (TXID) i X-Channel-ID header
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                  LLM Gateway (Go)                       │
│  internal/middleware/auth.go  → validerer X-Channel-ID  │
│  internal/payment/pricer.go   → kalkoulerer kost/sat    │
│  internal/payment/channel.go  → [MÅ IMPLEMENTERES] drain│
└────────────────────────┬────────────────────────────────┘
                         │
              3. Kall drain() etter LLM-respons
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                BSV-blockkjeden (sCrypt)                 │
│  LLMPaymentChannel.ts — stateful UTXO                   │
└─────────────────────────────────────────────────────────┘
```

## Kontraktens livssyklus

```
[ÅPEN]     User deployer kontrakt med lockAmount satoshi
              │
              ├─→ drain(amount, nonce, userSig, gatewaySig)
              │      Trekker amountSpent, nonce++ (replay-beskyttelse)
              │      UTXO-verdien forblir lockAmount
              │      (Kan kalles mange ganger)
              │
              ├─→ close(userSig)
              │      Gateway får: amountSpent
              │      User får:    lockAmount − amountSpent
              │
              └─→ timeout(userSig)   [kun etter expiryTime]
                     User får: hele lockAmount tilbake
```

## Kontrakt-feltene

| Felt | Type | Stateful | Beskrivelse |
|------|------|----------|-------------|
| `userPubKey` | PubKey | nei | Brukeren som finansierer kanalen |
| `gatewayPubKey` | PubKey | nei | LLM Gateway-operatøren |
| `lockAmount` | bigint | nei | Total beløp låst (satoshi) |
| `amountSpent` | bigint | **ja** | Akkumulert spent (oppdateres per drain) |
| `paymentNonce` | bigint | **ja** | Replay-beskyttelse (inkrementeres per drain) |
| `expiryTime` | bigint | nei | Unix-tidsstempel for kanalutløp |

## Prosjektstruktur

```
llm-payment-channel/
├── src/contracts/
│   └── LLMPaymentChannel.ts    ← Smart contract (FERDIG)
├── tests/
│   └── LLMPaymentChannel.test.ts ← Jest testsuite (10 tester)
├── artifacts/contracts/
│   └── LLMPaymentChannel.json  ← Kompilert artifact (auto-generert)
├── deploy.ts                   ← Deploy-script (CLI)
├── jest.config.js
├── package.json
└── tsconfig.json
```

## Kom i gang

### 1. Installer avhengigheter

```bash
npm install
```

### 2. Kompiler kontrakten

```bash
npm run build
# → artifacts/contracts/LLMPaymentChannel.json
```

### 3. Kjør tester

```bash
npx jest --forceExit
```

> **Merk:** scrypt-ts tar lang tid å initialisere i noen miljøer. Tester kan ta 30–60 sek.

### 4. Deploy en betalingskanal

```bash
ts-node deploy.ts \
  <userPrivKeyWIF> \
  <gatewayPubKeyHex> \
  <lockAmountSats> \
  [expirySeconds]
```

Eksempel:
```bash
ts-node deploy.ts \
  "L1xxxxxx..." \
  "02abcdef..." \
  50000 \
  86400
```

Output (JSON):
```json
{
  "status": "success",
  "channelId": "abc123txid...",
  "lockAmount": 50000,
  "expiryTime": 1741654800,
  "userPubKey": "02...",
  "gatewayPubKey": "02..."
}
```

## Integrasjon med LLM Gateway

Kanalens `channelId` (TXID) sendes som `X-Channel-ID`-header til gatewayen:

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Channel-ID: abc123txid..." \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hei!"}]}'
```

### Hva som allerede er klart i gatewayen

| Gateway-kode | Status | Beskrivelse |
|---|---|---|
| `middleware/auth.go` | ✅ Skjelett | Leser `X-Channel-ID`, TODO: validering on-chain |
| `payment/pricer.go` | ✅ Ferdig | Kalkulerer kost i satoshi fra token-bruk |
| `payment/channel.go` | ❌ Mangler | Selve `drain()`-kallet fra Go → BSV |

### Neste steg for gateway-integrasjonen

Gateway-en trenger en `internal/payment/channel.go` som:

1. **Verifiserer kanalen** — sjekk at TXID er on-chain og har nok saldo
2. **Kaller `drain()`** — signerer transaksjonen og sender den
3. **Sporer nonce** — lagrer siste nonce i lokal DB for å unngå replay
4. **Fallback** — avvis forespørsel dersom drain feiler

```go
// Pseudo-Go — hva som trengs i gateway
type Channel struct {
    TXID        string
    LockAmount  int64
    AmountSpent int64
    Nonce       int64
}

func (c *ChannelManager) Drain(channelID string, satoshi int64) error {
    // 1. Hent kanal fra DB / BSV node
    // 2. Bygg drain() TX med begge signaturer
    // 3. Broadcast TX
    // 4. Oppdater lokal nonce + amountSpent
}
```

## Replay-beskyttelse

Hvert `drain()`-kall krever at `nonce` matcher kontraktens `paymentNonce`. Etter drain inkrementeres nonce på-kjede. Dette sikrer at gamle drain-transaksjoner ikke kan gjenbrukes (replay attacks).

```
Drain #1: nonce=0 → etter: paymentNonce=1
Drain #2: nonce=1 → etter: paymentNonce=2
Forsøk på replay av Drain #1: nonce=0 → AVVIST
```

## Sikkerhetshensyn

> [!WARNING]
> **Begge parter må signere `drain()`** — gatewayen kan ikke tømme kanalen uten brukerens godkjenning. Brukersignaturen bør skje i klientens wallet (peck-desktop/bsv-desktop) for å unngå at gatewayen noen gang ser private keys.

> [!IMPORTANT]
> **Timeout** er brukerens sikkerhetsventil. Dersom gatewayen slutter å svare, kan brukeren alltid hente tilbake pengene etter `expiryTime`.

> [!NOTE]
> **Minste lockAmount** bør være stor nok til å dekke flere kall. Anbefalt: minst 10 000 sat (≈ noen cents) for å unngå hyppig redeployment.

## Avhengigheter

| Pakke | Versjon | Bruk |
|---|---|---|
| `scrypt-ts` | ^1.4.5 | sCrypt TypeScript-rammeverk |
| `@bsv/sdk` | ^2.0.2 | BSV SDK (TX-bygging, signing) |
| `@bsv/wallet-helper` | ^0.0.5 | Wallet-hjelpere |
| `jest` + `ts-jest` | ^29.x | Testkjøring |

## Referanser

- **Eksisterende kontrakt-mønster:** `../contracts/src/contracts/Connect4.ts`
- **Deploy-mønster:** `../contracts/deploy_contract.ts`
- **Gateway:** `../llm-gateway/`
- **sCrypt-dokumentasjon:** https://docs.scrypt.io
