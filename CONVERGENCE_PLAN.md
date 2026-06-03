

# Payment-Channel Ecosystem Audit — peck monorepo
*Synthesis of three scout reports + direct source verification, 2026-06-03*

> **Verification note / scout correction:** The CONTRACTS scout reported the FIX A (fee-from-channel) divergence direction **backwards for LLMPaymentChannel**. Direct source check confirms:
> - `peck-channel/src/contracts/LLMPaymentChannel.ts` (CANONICAL) → `close(userSig, fee)` / `timeout(userSig, fee)` — **HAS FIX A** ✓
> - `peck-contracts/src/contracts/LLMPaymentChannel.ts` → `close(userSig)` / `timeout(userSig)` — **STALE, no fee** ✗
> - For FetchPaymentChannel the scout was right: `peck-overlay-schema` has FIX A, `peck-contracts` is stale.
>
> **Net implication:** the canonical primitive repo is the *most current* version. `peck-contracts` is a lagging mirror, not the source of truth for the channel contracts. Cleanup should flow *out of* peck-channel/peck-overlay-schema *into* peck-contracts, not the other way around.

---

## 1. CONTRACT MAP

| Contract | Family | Location(s) | Role | FIX A (fee) | Cleanup needed |
|---|---|---|---|---|---|
| **LLMPaymentChannel** | Channel (dual-sig, nonce, time-expiry) | `peck-channel/src/contracts/` | **CANONICAL PRIMITIVE** | ✓ yes | none — this is the standard |
| LLMPaymentChannel (copy) | Channel | `peck-contracts/src/contracts/` | Stale mirror | ✗ no | **Re-sync from peck-channel or delete** |
| **FetchPaymentChannel** | Channel (block-height expiry, monotonic nonce, read-side) | `peck-overlay-schema/src/paywall/contract/` | Canonical *variant* — mainnet-proven 2026-06-01 | ✓ yes | none — but should be re-homed (see below) |
| FetchPaymentChannel (copy) | Channel | `peck-contracts/src/contracts/` | Stale mirror | ✗ no | **Re-sync or delete** |
| FetchPaymentChannel (artifact) | Channel | `peck-fm/src/contract/FetchPaymentChannel.json` | Compiled JSON copy | (compiled) | Re-point to canonical artifact |
| **PeckCanvas** | Accumulator (UTXO value-up + rolling hash) | `peck-contracts/` + `peck-ink/` (identical) | Distinct primitive — *not a channel* | n/a | none; keep separate |
| **PeckBilling** | Accumulator (charge audit trail) | `peck-contracts/` only | Distinct primitive — *not a channel* | n/a | none; unique |
| Connect4 / Lobby | Game state machine | `peck-contracts/` (new) vs `contracts/`,`datamynt-arena/` (old) | Unrelated to channels | n/a | de-dup is a *separate* arena concern |
| PaymentChannel (generic) | Channel (single-sig, simpler) | `opencode/packages/opencode/...` | **Different primitive** — keep separate | n/a | do not converge |
| AgentEscrow | Escrow covenant | `peck-mcp/.claude/worktrees/` (×3, uncommitted) | Experimental, not a channel | n/a | ignore / let it land or die in worktree |

**The two real channel families:**
1. **LLMPaymentChannel** — dual-sig, nonce replay-guard, *time*-based expiry. Drives metered AI/compute billing. Canonical home: **peck-channel** (lib + spec v1 + golden sighash vectors + sidecar e2e).
2. **FetchPaymentChannel** — a *generalization* of the same shape for pay-per-fetch: *block-height* expiry, monotonic nonce, off-chain drains via `X-Peck-Receipt`. Canonical home: **peck-overlay-schema** (mainnet-proven).

These are sibling variants of one design, not two unrelated things. They should eventually live side-by-side in `peck-channel` as `LLMPaymentChannel` + `FetchPaymentChannel`, with `peck-contracts` either re-exporting from there or being retired as the channel home.

**Genuinely separate (do NOT fold into peck.channel):** PeckCanvas, PeckBilling (accumulators — value goes *up* per action, gateway `drain()` withdraws; no bidirectional channel state, no client/gateway co-signature flow), opencode PaymentChannel (single-sig), Connect4/Lobby (games), AgentEscrow (covenant escrow).

**Cleanup summary:**
- **Single source of truth for channel contracts = peck-channel (+ overlay-schema for the Fetch variant).** Treat `peck-contracts` channel copies as stale; re-sync or delete them.
- The `peck-api` Go repo embeds a **hardcoded hex `ChannelScriptTemplate`** of the *old* (pre-FIX-A) LLMPaymentChannel. This is the most dangerous duplicate — it is invisible to a TS-level grep and will silently diverge from the spec.

---

## 2. CONSUMER CONNECT-STATUS TABLE

| Repo / service | What it does | Channel relationship | Connect status | Active? |
|---|---|---|---|---|
| **peck-channel** | The primitive: contract + TS client (`channel.ts`/`gateway.ts`) + spec v1 + golden vectors + settle-sidecar | — (source) | **CANONICAL** | Active (5 ops proven on mainnet) |
| **peck-host** (peck.run gateway) | Builds drain/close/cosign-drain TXs in Go against the contract; `/channels/*` API | Re-implements the gateway side in Go **against the same contract semantics** — comments reference `LLMPaymentChannel` but it does **not import** peck-channel TS/Go | **WIRED-BY-SPEC** (closest thing to a real consumer; conforms to the contract, not the lib) | **Active, production** |
| **llm-gateway** (llm.peck.to) | 402 tier; own `ChannelState`, receipt, two-phase settle via sidecar, BRC-77 verify | Mirrors the receipt/settle protocol with its **own Go `ChannelState`** | **DUPLICATE (Go)** | Active (`ENFORCE_PAYMENT`/`SETTLE_ENABLED` off by default) |
| **peck-overlay-schema** | Per-fetch paywall: FetchPaymentChannel contract + receipt + Express middleware + settle endpoints | Owns the canonical **FetchPaymentChannel variant** (FIX A, mainnet-proven) | **OWN CANONICAL VARIANT** (to be re-homed into peck-channel) | Dormant/dev (endpoints exist, no live overlay deploy) |
| **peck-fm** (radio paywall) | HLS streaming gate; imports `FetchPaymentChannel.json` artifact; in-memory channel state | Copy of the Fetch artifact + own lifecycle | **DUPLICATE** | Active (audio streaming, in-mem state only) |
| **peck-api** | Experimental channel manager | **Hardcoded hex `ChannelScriptTemplate`** of *stale* LLMPaymentChannel + own `ChannelManager`/`UTXOManager` | **DUPLICATE (worst kind — embedded hex, pre-FIX-A)** | Experimental, no live usage |
| **peck-mcp** (mcp.peck.to) | `paywall-client.ts` — BRC-100 wallet receipt signing, off-chain, non-custodial | Mirrors receipt protocol; keys never leave wallet | **MIRRORS PROTOCOL** (acceptable client) | Active |
| **peck-web** (peck.to UI) | Paywall config/earnings pages; proxies to overlay `/v1/paywall/config` | UI only — no channel state/settle | **UI-ONLY (no wiring needed)** | Active |
| **peck-contracts** | Contract source mirror | Holds *stale* LLM + Fetch copies | **STALE MIRROR** | Reference |
| **settle-sidecar** (in peck-channel) | `/settle/{op}/prepare\|finalize` builder + conformance e2e | Part of the primitive | **PERIPHERAL (canonical)** | Active (used by llm-gateway Phase 6) |
| datamynt-arena | Game state (`state_channel.py`, HMAC, **not BSV**) | — | **UNRELATED** | Dormant |
| kvitteringen-no | Invoices / BRC-104 receipt certs | — | **UNRELATED** | n/a |
| mer-data-no | eSIM 1Sat-ordinal receipts | — | **UNRELATED** | n/a |
| peck-bio / margin-api / peck-website | identity / lending / marketing | — | **UNRELATED** (peck-website has a soft non-channel paywall ref only) | n/a |

**Wiring tally:** 1 canonical (peck-channel) · 1 wired-by-spec (peck-host) · 1 protocol-mirror, acceptable (peck-mcp) · **3 true duplicates to converge (llm-gateway, peck-fm, peck-api)** · 1 own-canonical-variant to re-home (peck-overlay-schema) · 1 stale mirror (peck-contracts) · 1 UI-only · the rest unrelated.

---

## 3. PECK.INK VERDICT

**peck-ink is NOT a payment-channel consumer — it is a separate primitive and should stay separate.** Its on-chain mechanism is the `PeckCanvas` stateful sCrypt contract: each pixel placement *increases* the contract UTXO value by `pixelPrice` (1 sat) and folds the pixel bytes into a rolling `sha256(oldHash + pixelData)` audit trail; the gateway periodically calls `drain()` to withdraw the accumulated sats. There is no bidirectional channel, no client/gateway co-signed running balance, no nonce-monotonic off-chain receipt, no time/height-based dispute close — i.e. none of the LLMPaymentChannel/FetchPaymentChannel machinery. peck-ink contains zero references to `FetchPaymentChannel`, `LLMPaymentChannel`, `peck-channel`, or the receipt/settle protocol; its `drain()` is a plain operator withdrawal, not a channel close. It is a standalone Bitcoin-Schema (MAP+B+AIP) + accumulator app (first on-chain pixel 2026-03-25). **Verdict: UNRELATED. Do not wire it to peck.channel.** (If anything, `PeckCanvas` + `PeckBilling` form their own small "accumulator" family that could later be consolidated together — but that is a *different* convergence track from the channel primitive and should not be conflated with it.)

---

## 4. PRIORITIZED CONNECT PLAN

Ordered by value/effort. "Connect" = converge a duplicate onto the canonical primitive; some items are de-dup-of-source rather than runtime wiring.

### Quick wins (low effort, removes silent-divergence risk)

**Step 1 — Re-sync / delete stale channel contracts in `peck-contracts`.** *(Effort: low · Risk: low)*
`peck-contracts` holds pre-FIX-A copies of both LLMPaymentChannel and FetchPaymentChannel. Either re-export from peck-channel / peck-overlay-schema or delete them, and make peck-channel the documented single source. Prevents anyone re-deriving an old script. **Quick win.**

**Step 2 — Re-point `peck-fm` at the canonical Fetch artifact.** *(Effort: low · Risk: low)*
peck-fm imports its own `FetchPaymentChannel.json`. Replace with the canonical compiled artifact (from peck-overlay-schema / future peck-channel) via a build step or a shared `@peck/channel-artifacts` reference. peck-fm keeps its own in-mem ChannelState for now (that's a runtime concern, Step 6). **Quick win — artifact-only, no protocol change.**

**Step 3 — Kill the embedded hex in `peck-api`.** *(Effort: low–medium · Risk: low; repo is experimental)*
`peck-api/internal/payment/channel.go` hardcodes a stale `ChannelScriptTemplate` hex string of the pre-FIX-A contract. Since peck-api has no live usage and peck-host is the production gateway, the cleanest action is to **delete peck-api's channel manager** (or gut it to import peck-host's logic). At minimum, replace the hex with a generated artifact + a conformance test against peck-channel's golden sighash vectors. **Highest divergence-risk-per-line in the tree.**

### Medium (real convergence of live Go services)

**Step 4 — Extract a shared Go channel package from `peck-host`; have `llm-gateway` consume it.** *(Effort: medium · Risk: medium — touches live billing on two services)*
peck-host and llm-gateway each maintain separate Go `ChannelState` + drain/receipt/settle logic. peck-host's is production-grade and spec-conformant. Promote it to a shared module (`peck-host/billing` → importable, or a new `peck-channel-go` package) carrying the golden sighash vectors as conformance tests. Migrate llm-gateway's `internal/payment/*` to it. **Do this behind the existing `ENFORCE_PAYMENT`/`SETTLE_ENABLED` flags (both off) so it can land dark.** This is the single highest-value convergence: it eliminates the two independent ChannelState implementations that most threaten settlement correctness.

**Step 5 — Re-home `FetchPaymentChannel` into `peck-channel` as a first-class sibling.** *(Effort: medium · Risk: low–medium)*
The Fetch variant is genuinely canonical (mainnet-proven) but lives in peck-overlay-schema. Move the contract source into peck-channel alongside LLMPaymentChannel, add it to spec v1 (block-height expiry + monotonic-nonce section) with its own golden vectors, and have peck-overlay-schema import it. This makes peck-channel the *one* place both channel variants live. **Risk is mostly import-graph churn, not on-chain behavior.**

### Heavier convergence (defer unless a consumer goes live)

**Step 6 — Replace ad-hoc in-mem `ChannelState` in peck-fm with the shared library.** *(Effort: medium–high · Risk: medium)*
Only worth it once peck-fm's paywall is actually being driven in production. Until then, Step 2 (canonical artifact) is enough. Flag as **deferred**.

**Step 7 — Bring peck-overlay-schema's paywall endpoints onto the shared client.** *(Effort: high · Risk: low while dormant)*
Endpoints exist but there is no live overlay deployment. Reconcile its receipt/middleware/settle code with peck-channel's client + the shared Go gateway once the overlay is scheduled to deploy. **Deferred until overlay cutover** (which IN_FLIGHT memory says is explicitly *not* started yet).

### Explicitly DO NOT converge (different primitives — keep separate)
- **peck-ink / PeckCanvas** and **PeckBilling** — accumulators, not channels. (Their own optional "accumulator family" consolidation is a separate track.)
- **opencode PaymentChannel** — single-sig generic channel in a different product; do not force onto the dual-sig spec.
- **Connect4 / Lobby** — game state machines; their peck-contracts↔datamynt-arena divergence is an arena concern, unrelated to billing.
- **AgentEscrow** — uncommitted experimental covenant in peck-mcp worktrees; ignore until it lands.
- **datamynt-arena state_channel.py, kvitteringen-no, mer-data-no, peck-bio, margin-api** — unrelated; no wiring.

### Recommended order of execution
1 → 2 → 3 (quick wins, mostly mechanical, kill stale/hidden copies) → **4** (the real prize: one Go channel core for peck-host + llm-gateway, landed dark behind existing flags) → 5 (unify the two contract variants under peck-channel) → defer 6 and 7 until their consumers are actually deploying.

**Honest bottom line:** there is really only *one* canonical primitive with *one* genuine sibling variant (Fetch). The "duplication" problem is concentrated in **three Go re-implementations of channel state** (peck-host = good, llm-gateway = duplicate, peck-api = stale-embedded-hex) plus **stale contract mirrors** in peck-contracts. Converging Steps 1–5 collapses the channel surface to: one contract repo (peck-channel, both variants), one Go core (from peck-host), and thin protocol-mirroring clients (peck-mcp). Everything else in the tree that looks channel-adjacent is a different primitive and should be left alone.

Relevant canonical paths:
- `/home/thomas/Documents/peck-to/peck-channel/src/contracts/LLMPaymentChannel.ts` (canonical, FIX A)
- `/home/thomas/Documents/peck-to/peck-channel/PECK_CHANNEL_SPEC.md` (spec v1 + golden vectors)
- `/home/thomas/Documents/peck-to/peck-overlay-schema/src/paywall/contract/FetchPaymentChannel.ts` (canonical Fetch variant, FIX A)
- `/home/thomas/Documents/peck-to/peck-host/billing/drain.go` (production gateway, spec-conformant)
- `/home/thomas/Documents/peck-to/peck-api/internal/payment/channel.go:22` (stale embedded hex — highest-risk duplicate)
- `/home/thomas/Documents/peck-to/peck-contracts/src/contracts/` (stale LLM + Fetch mirrors)

---

## UTFØRELSES-STATUS (2026-06-03)

- **Steg 1 ✅** peck-contracts: stale pre-FIX-A LLMPaymentChannel + FetchPaymentChannel fjernet (kilde+exports+dist). Ingen importerte dem (overlay bruker pakka kun for BIO). Pushet.
- **Steg 2 ✅** peck-fm: byttet til kanon FIX-A FetchPaymentChannel-artifact (fra overlay). peck-fm bygger script fra artifact via scryptlib + in-mem kanaler → trygt. (peck-fm ikke eget git-repo; endret på disk.)
- **Steg 3 ✅** peck-api: hardkodet pre-FIX-A hex markert DEPRECATED → peker på peck-channel + peck-host/billing. peck-api er ubrukt stub (peck-web bruker kun social/feed). Pushet.
- **Steg 4 ⏸ STØRRE ENN ANTATT** — peck-host bruker `libsv/go-bt`, llm-gateway bruker offisiell `bsv-blockchain/go-sdk`. To ulike BSV-libs → å forene til én delt Go-pakke er en ekte refactor (velg én lib, skriv om den andre), IKKE et quick import. Fortjener fokusert økt. Down-payment-mulighet: golden-vektor conformance-test i llm-gateway (go-sdk) som beviser at den tredje sighash-stien matcher standarden — bounded + trygt.
- **Steg 5 ⏸** re-home FetchPaymentChannel→peck-channel: gjenstår (peck-overlay-schema kanon i dag).

**Konvergens-gevinst så langt:** silent-divergence-risikoen er borte (stale kopier fjernet/deprecated, aktive consumere på kanon-artifact). Gjenstående er den arkitektoniske Go-lib-unifiseringen (steg 4) + Fetch-re-home (steg 5).
