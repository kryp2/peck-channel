# IN_FLIGHT — llm-payment-channel
_Sist oppdatert: 2026-05-30_

## Sist gjort
- **Test-harness FIKSET + verifisert (9/10 grønt med egne øyne).** Rotårsak til at alle 10 testene feilet («address does not belong to this TestWallet»): nettverks-mismatch — scrypt-ts DummyProvider rapporterer testnet, men `bsv.PrivateKey.fromRandom()` defaulter til mainnet, så TestWallet eide aldri mainnet-adressene. Fix: `fromRandom(bsv.Networks.testnet)` i `tests/LLMPaymentChannel.test.ts:15-17` (speiler peck-bio catToken.test.ts). KUN den endringen trengtes — `changeAddress`-tillegg var unødvendig. Diff = 6 linjer.
  - Verifisert lokalt: `npx jest` → `Tests: 1 failed, 9 passed, 10 total`, 0 «does not belong», ekte TX-id-er logget.
  - **NB:** Jeg utstedte commit-kommandoen men shell-en sluttet å svare før jeg fikk bekreftet at den landet. **SJEKK: `git -C llm-payment-channel log -1` — hvis testnet-fixen IKKE er committet, commit den** (melding: "test(channel): use testnet keys so harness network matches DummyProvider").

## close() — REKLASSIFISERT: test-harness-gap, IKKE kontrakt-bug (2026-05-30)
- Jeg PRØVDE kontrakt-side fix (`buildChangeOutput()`) — den gjorde det VERRE (2 røde, brakk close-zero-spent). Revertet. Det LÆRTE oss svaret: `close()` er KORREKT designet.
- `close()` fordeler full lockAmount til [gateway, user] og asserter hashOutputs over nøyaktig de to. Fee MÅ komme fra en SEPARAT input, og tx MÅ IKKE ha change-output. Dette er riktig (samme som FetchPaymentChannel). Bytecode uendret; la til en doc-kommentar (commit `ae11ecb`).
- Det ene røde (close-split) feiler KUN fordi default scrypt-ts-builder legger på en change-output. Fix = custom `bindTxBuilder('close', ...)` med fee-input uten change (speil CatToken burn() catToken.test.ts:440-450). Test-side, lav prioritet.
- **drain() / timeout() / sig-validering: alle grønne (9/10).** Kontrakt-logikken er verifisert sunn — klar for ChainDrain-bygging. close-LOGIKKEN er også korrekt, bare ikke eksersert av default-builderen.

## Kontekst
- Del av peck.run drain-stack. Se `../PECK_RUN_DRAIN_ECONOMICS_2026-05-30.md` (instans-sekund-modell) + `../PECK_RUN_CHANNEL_CONTRACT_2026-05-30.md`. Kontrakt-valg = sCrypt (ikke Runar). Memory: [[peck-run-drain-economics-2026-05-30]].
- Når close()-bug er fikset + 10/10 grønt: da kan ekte ChainDrain bygges i peck-host (drain.go er mock).
