# Developer Guide — Perp & Prediction Market Safety Desk

> Status: Phase 1 + Phase 2 COMPLETE (15 Nov 2026). All six checks are
> implemented and verified live against Solana devnet (see `EVIDENCE/`),
> screenshot QA passed at 390px + 1280px, and the app is DEPLOYED LIVE on
> Vercel (see "Repo + live links"). Remaining: public repo, demo-market
> seeding, submission prep — see "Status + remaining work" below. Repo
> creation is still TODO (parent's step — GitHub PAT scope).

## What it is

A web app that answers one question before a trader risks money: **is this
prediction market safe?** The user pastes a pm-AMM market (or group) account
address (Solana devnet); the desk reads the market on-chain and returns a
safety verdict — a 0–100 score, a band (**LOOKS SOUND** / **TRADE WITH
CAUTION** / **AVOID** / **UNRATED**), six per-check cards with explorer
evidence links, and a one-paragraph plain-English explanation.

- **Hackathon:** Solana "Perps and Prediction Markets" (hackathons.solana.com), deadline displayed as 6 Dec 2026 on the entrant's device (WIB); exact deadline time/timezone unverified — submit by 4 Dec.
- **Protocol:** pm-AMM (Predict) — one Anchor program, 34 instructions, USDC collateral. Program ID `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y` (same on devnet and mainnet — this app reads **devnet only**).
- **Stack:** Vercel serverless API (TypeScript) + static one-page frontend (Tailwind v4 Play CDN, Lucide icons). No framework, no build step beyond `tsc --noEmit`. No wallet adapter, no sign-in, no database, no secrets. Only runtime dependency: `@solana/web3.js`.
- **Cost:** $0. Devnet reads only; the public devnet RPC is free and rate-limited.
- **Design decision — no `@pm-amm/sdk`:** the SDK depends on `@anchor-lang/core`
  (CommonJS), which fails on `BN` under raw Node ESM. Instead of a bundler,
  this codebase decodes accounts with manual Borsh layouts
  (`lib/engine/decode.ts`, verified against repo HEAD `d5b407b` + live
  accounts) and reimplements the SDK's pure math (`lib/engine/math.ts`,
  same approximations the SDK uses). If the program upgrades, re-verify
  the layouts against the new IDL — the decoders reject wrong
  sizes/discriminators instead of misreading shifted fields.

## How to run locally

Prerequisites: Node.js ≥ 22.

```bash
cd build
npm install
npm run dev      # serves the UI + the real /api handlers at http://localhost:3000
```

Then open http://localhost:3000, paste a devnet market address, and press **Check market**. Three verified example markets are offered as buttons (see "Verified example markets").

Other commands:

```bash
npm run smoke      # offline smoke test — decoders, math, scorer, heuristic; NO network calls
npm run build      # tsc --noEmit (the Vercel build)
npm run typecheck  # same as build
PORT=4000 npm run dev   # dev server on another port
```

Smoke-test the API directly (with the dev server running):

```bash
curl -s http://localhost:3000/api/health
curl -s -X POST http://localhost:3000/api/check \
  -H 'content-type: application/json' \
  -d '{"market":"fcLNbKJMg8fUPs9W8cVog6yowU4qhgu1cR34n5GFYN6"}'
```

No environment variables are needed. There is no `.env` file and nothing to configure.

## Endpoints

| Endpoint | Method | Request | Response |
|---|---|---|---|
| `/api/health` | GET | — | `{ ok, network: "devnet", programId, engineVersion, checksImplemented: 6, checksTotal: 6 }` |
| `/api/check` | POST | `{ market: string }` (base58 Solana address — a market, group, or any account) | `MarketVerdict` JSON: `market`, `network`, `programId`, `score` (0–100 or `null` when unrated), `band`, `explanation`, `checks[]`, `generatedAt`, `engineVersion` |

`/api/check` rate limit: 60 checks/hour per IP (in-memory, per instance). Invalid addresses return HTTP 400 with a plain-English error. Non-market addresses return HTTP 200 with band `UNRATED` and all-info checks — never a fake score.

## Repo + live links

- **Repo:** TODO (new public repo — creation is the parent's step; GitHub PAT is scoped to 5 other repos)
- **Live demo (production):** https://solana-safety-desk.vercel.app (alias: https://solana-safety-desk-feymarls-projects.vercel.app)
- **Vercel project:** `solana-safety-desk` (`prj_rKobLVefxizzbnXlSxSIjqJ47iau`, team `feymarl's projects`, Hobby $0). Live deployment verified 15 Nov 2026: `dpl_Fyqvq3zviTrX5zjeNMo5dvNKMJQP` (READY).
- **Event page:** https://hackathons.solana.com/hackathons/perps-and-prediction-markets
- **pm-AMM docs:** https://predict-pm-amm.dev/ · builder kit: https://predict-pm-amm.dev/hackathon.md · repo: https://github.com/sparkfun-labs/pm-amm

## Deploy

Deploy via the Vercel connector helper (no CLI login needed):

```bash
python3 ~/workspace/custom-connectors/custom.vercel/bin/vercel_api.py deploy \
  ~/workspace/goals/solana-perps-prediction-hackathon/build \
  --name solana-safety-desk --prod --team team_YJ9tCGYZJMbfYUDwCUk5q2OA
# then poll: vercel_api.py status <deployment-id> --team team_YJ9tCGYZJMbfYUDwCUk5q2OA
# until readyState is READY (build takes ~10s; do NOT use --wait from a
# timeboxed shell — poll separately).
```

No environment variables to set on the deployment. `vercel.json` pins function timeouts (`/api/check` 30s, `/api/health` 10s).

Verify after every deploy (from any shell — the first POST after a deploy
is a cold start and can be slow; retry once if it times out):

```bash
curl -s https://solana-safety-desk.vercel.app/api/health
# {"ok":true,"network":"devnet",...,"checksImplemented":6,"checksTotal":6}
curl -s -X POST https://solana-safety-desk.vercel.app/api/check \
  -H 'content-type: application/json' \
  -d '{"market":"fcLNbKJMg8fUPs9W8cVog6yowU4qhgu1cR34n5GFYN6"}'
# score 19, band AVOID, 6 checks — must match EVIDENCE/live-binary.json
```

### Deploy gotchas (learned 15 Nov 2026 — do not regress)

1. **`uuid` override is load-bearing.** `package.json` pins
   `"overrides": {"uuid": "8.3.2"}`. Without it, npm nests ESM-only
   `uuid@14` under `rpc-websockets`, and the Vercel lambda (Node 26,
   fluid runtime) throws `ERR_REQUIRE_ESM` when the CJS
   `rpc-websockets` bundle `require()`s it — every API route 500s with
   `FUNCTION_INVOCATION_FAILED` while the static page still serves.
   Diagnosed via a lazy-import probe that returned the exact error.
   **Never remove the override or let a nested ESM `uuid` back into the
   tree** — check with `npm ls uuid` (must show one `8.3.2`, deduped).
   If the lockfile is regenerated, re-verify the tree before deploying.
2. **Preview deploys via the helper are broken.** The v13 API rejects
   `target: "preview"` for file-upload deploys (400: target must be
   'production', 'staging', or a custom environment id). Always deploy
   with `--prod`.
3. **Node version floats.** `engines: >=22` lets Vercel pick the newest
   major (26.x at deploy time). If a future Node major breaks
   `@solana/web3.js`, pin `engines.node` to a known-good major.

## Architecture

```
public/index.html            One-page UI (English-only, "How to use" dialog, no wallet button,
                             3 verified example markets)
api/check.ts                 POST { market } → verdict JSON (validation + rate limit)
api/health.ts                Liveness + static config
lib/constants.ts             Devnet constants — the ONLY place addresses/RPC URLs live
lib/http.ts                  Minimal handler types (no @vercel/node dependency)
lib/rpc.ts                   Read-only devnet Connection (lazy, offline-safe)
lib/verdict.ts               checkMarket() entry point + address validation (engine 1.0.0)
lib/engine/types.ts          CheckResult / CheckContext / MarketSnapshot / MarketVerdict
lib/engine/scorer.ts         Pure scorer (see Scoring rules)
lib/engine/index.ts          Check registry + orchestrator (allSettled: one failure never kills the verdict)
lib/engine/decode.ts         Manual Borsh decoders: Market (443), GroupMarket (1188),
                             ProgramData, SPL mint/token account, LpPosition shares
lib/engine/math.ts           pm-AMM math: I80F48, normal CDF/PDF/inverse, rescaled pricing,
                             pool value, expected daily LVR, formatting
lib/engine/snapshot.ts       MarketSnapshot gatherer: batched reads, 1h ProgramData cache,
                             retry-on-429, graceful degradation (nulls + rpcError)
lib/engine/checks/*.ts       The six checks — all IMPLEMENTED (see Check notes)
scripts/smoke.ts             Offline smoke test (no network)
scripts/local-server.ts      Local dev server running the real handlers
EVIDENCE/                    Live devnet verification verdicts (8 markets, 15 Nov 2026)
RESEARCH.md                  Research spike: data sources, formulas, per-check verdicts
```

### Data flow

1. The browser POSTs `{ market }` to `/api/check`.
2. The handler validates the address (base58 `PublicKey`) and rate-limits per IP.
3. `checkMarket()` gathers a `MarketSnapshot` in batched `getMultipleAccountsInfo` reads (target + program account; then mints/vault/collateral/authority; then group legs if any; LP concentration best-effort). ProgramData is cached for 1 hour.
4. The orchestrator runs all six checks against the snapshot; the scorer aggregates scored checks into a score + band + explanation.
5. The verdict JSON returns; the UI renders the score, band, explanation, per-check cards, and evidence links. All server strings are HTML-escaped before rendering.

### RPC call budget (per verdict)

- Single market: ~3 batched reads + cached ProgramData + 1 best-effort `getProgramAccounts` (LP concentration) + 1 `getSlot`. Group (≤ 8 legs): +1 batched leg-token read. Retries on 429: up to 3 attempts with 600ms/1500ms backoff. On persistent failure, fields stay null and checks degrade to `info` with an honest explanation.

### Scoring rules

- Only **implemented + scored** checks aggregate (`points !== null`). Info checks (not applicable, unreadable inputs) contribute nothing.
- Weighted mean over scored checks (weights: resolution 25, upgrade 20, solvency 20, coherence 15, LP risk 10, expiry/rules 10 — sum 100).
- No scored checks → `score: null`, band **UNRATED**.
- Hard fail: a `fail` on a hard-fail-capable check (resolution authority, upgrade authority) caps the score at 19 and forces **AVOID** — the same cap MintGuard uses for BLOCK verdicts.
- Bands: ≥ 80 **LOOKS SOUND**, 50–79 **TRADE WITH CAUTION**, < 50 **AVOID**.
- The explanation paragraph is composed from the failing/warning checks' own explanations, plus a note when checks are still unimplemented (none are, as of 1.0.0).
- **Consequence to understand:** the pm-AMM program currently has a single-key
  upgrade authority, so the upgrade check fails on every market and every
  real market currently scores ≤ 19 (AVOID). That is the protocol's
  disclosed state, not a desk bug — scores still differentiate below the
  cap (verified: 8 vs 19). If the program moves to multisig/immutable
  upgrades, scores rise accordingly. The upgrade check deliberately stays
  silent (info) for non-market addresses so junk input is UNRATED, not AVOID.

## Check notes (thresholds, heuristics, honesty boundaries)

Full research basis: `RESEARCH.md` §4. Each check file carries its own header
with the same contract. Summary:

### 1. Resolution authority (weight 25, hard-fail-capable) — PARTIAL

- **Verified:** authority address + resolved state; no oracle / no dispute /
  no timelock as a code fact (34-instruction IDL, no such instruction).
- **Heuristic only:** single-key vs multisig — on-curve shape (plain-keypair
  shape) vs off-curve PDA shape, plus authority-account owner. Default
  wording: "no on-chain evidence of multisig". Never claims "multisig"
  without history evidence (not read in v1).
- **Disclosed, not scored:** authority track record (needs tx history);
  bet-vault void fallback (only fallback in the system; cannot be
  confirmed from a market account alone).
- **Scoring:** expired + unresolved ≥ 7 days (AWOL) → fail 5. On-curve →
  warn 35. Off-curve PDA → warn 55. Unclassifiable → warn 45. Resolved →
  warn 60. Group markets: cascade note (legs resolve from group authority).

### 2. Upgrade authority (weight 20, hard-fail-capable) — state IMPLEMENTABLE, history PARTIAL

- **Verified live:** ProgramData parse → authority
  `ETGKSFc7KMu32foPegEGiqFiDX3B2bPXhiFhvm8K7R6Y` (on-curve single key),
  slot 511,269,300, 15 Oct 2026. Cached 1h.
- **History:** recent ProgramData tx count shown with "bounded history, may
  be incomplete" note. Never presented as a full upgrade history.
- **Scoring:** immutable → pass 95. On-curve single key → fail 10.
  Off-curve → warn 50. Unclassifiable → warn 45. Unreadable → info.
  Deploy < 30 days ago is flagged as fresh unaudited code (note only).

### 3. Solvency (weight 20) — IMPLEMENTABLE (exact guard formula)

- Obligation = `max(yesSupply + x_now + excessYes, noSupply + y_now + excessNo)`
  with **rescaled** reserves. Resolved markets use the post-resolution
  basis (winning supply + winning excess). The naive vault-vs-supply
  formula is never used.
- **Collateral-mint check:** anything other than the devnet mUSDC mint
  `3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ` → fail 0 (CRITICAL).
  Verified live: caught 2 real non-mUSDC test markets (see `EVIDENCE/`).
- **Scoring:** coverage ≥ 1 → pass 90. Coverage < 1 → fail 0 (CRITICAL —
  unreachable through normal swaps, indicates an invariant break).
  Unfunded (no obligation) / unreadable → info. Groups: worst leg drives
  the verdict; per-leg coverage listed.

### 4. Multi-outcome coherence (weight 15) — IMPLEMENTABLE

- Leg prices from rescaled reserves; Σ and drift `|Σ − 1|`. Empty slots
  skipped; unfunded legs excluded with a note; expired groups flagged stale.
- **Thresholds:** drift ≤ 2pp → pass 90; ≤ 10pp → warn 60; > 10pp → fail 25.
- Standalone binary markets → info (never a fake Σ = 1). Group-attached
  legs fetch siblings, so pasting one leg still checks the whole group.
- **Verified live:** group Σ = 1.4317 (+43.2pp) — fail, reproduced from
  both the group address and a leg address.

### 5. LP risk (weight 10) — PARTIAL (model only)

- **Implemented:** √(T − t) decay schedule (L_eff now vs at-seed), pool
  value, **expected** (model) daily LVR `V / (2 · T_days)`, expected
  terminal wealth (deposited / 2), 2% fee split disclosure (LPs receive
  none; 50% DAO / 50% creator), LP concentration (best-effort enumeration).
- **Never invented:** realized LVR / realized returns (no history exists).
  Every LVR figure is labeled "expected (model)". Per-position P&L needs
  a wallet address — the desk never asks for one.
- **Scoring:** live + funded → warn 50 (inherent to the disclosed model,
  never fail). Unfunded / expired / resolved → info. Groups: aggregate
  pool value across priced legs.

### 6. Expiry & market rules (weight 10) — IMPLEMENTABLE + heuristic

- **Facts:** time to expiry / expired age, settlement terms (1 winning
  token = 1 mUSDC, no fee; YES+NO redeemable 1:1 — verified in program
  code), seed vs current price, duration sanity (< 1h / > 1y flagged).
- **Heuristic only:** question clarity — deterministic name-string
  checklist (length, printability, question mark / number / date /
  threshold / named source, junk shape). Warn-only, deduction capped at
  24 points, always disclosed as a heuristic. No rules text exists
  on-chain (64-byte name is the only market text) — disclosed in every
  explanation.
- **Scoring:** expired → base 40; < 1h → 45; < 24h → 55; < 7d → 75; else
  85; duration flags −10 each; ≥ 70 pass else warn. Resolved → pass 80.

## Verified example markets (UI buttons)

Verified from live devnet reads, 15 Nov 2026 (~10:37 UTC). Full verdicts
in `EVIDENCE/`. Devnet state churns — re-verify before demo day, and prefer
seeded demo markets once they exist (see Remaining work).

| Address | Demonstrates |
|---|---|
| `fcLNbKJMg8fUPs9W8cVog6yowU4qhgu1cR34n5GFYN6` | Live binary market ("BTC<=70000.00 by 2026-11-20 08:00Z"), funded vault, solvency 1.16× |
| `4s2XecwCSGWePmQR4QesHKMncXZccBo5ZqWx5t1n7N76` | Multi-outcome group ("Best performer in Q4 2026"), live coherence drift Σ = 1.43 |
| `2BqF6eu6MmBRm48ttuzst8Q7dnTuNkx2pedrYhTheLi4` | Expired, unresolved market ("SOL>68.8@1794722400"), authority-awaiting warning |

## Status + remaining work

### Done (Phase 1, verified 15 Nov 2026)

- [x] App shell: package.json (Node ≥ 22, TypeScript, `@solana/web3.js`, no wallet deps), tsconfig, vercel.json
- [x] API routes `/api/check` + `/api/health` with validation + rate limiting
- [x] Engine: `Check` interface, pure scorer (incl. UNRATED + hard-fail cap), orchestrator, `MarketSnapshot`
- [x] Research spike (`RESEARCH.md`): SDK/docs/repo + live devnet reads; per-check implementability verdicts
- [x] Manual Borsh decoders + pm-AMM math (no `@pm-amm/sdk`, ESM-safe), verified against repo HEAD `d5b407b` + live accounts
- [x] MarketSnapshot gatherer: batched reads, 1h ProgramData cache, retry-on-429, graceful degradation
- [x] **All six checks implemented** per the stub contracts + research verdicts (honest PARTIAL handling; see Check notes)
- [x] UI: 3 verified example markets with labels, neutral UNRATED note, "How to use" button (English-only)
- [x] Live verification: `npm install` + `npx tsc --noEmit` + offline smoke test + local-server `curl` checks (health + 8 `/api/check` verdicts incl. group, group leg, expired, AWOL, resolved, nonexistent, non-market) — all green, recorded in `EVIDENCE/`
- [x] This guide completed (check notes, thresholds, QA evidence, remaining work)

### Done (Phase 2 — screenshot QA + deploy, verified 15 Nov 2026)

- [x] **Screenshot QA** at 390px + 1280px per the web-ui-design skill (headless Chromium + Playwright, local-assets copy, real devnet verdict render). Gate passed: hierarchy + grayscale check, no horizontal overflow at 390px, icons/fonts render, zero console errors, one primary CTA, "How to use" dialog works. Screenshots + rerun script: `../hidden_files/qa/` (`qa-1280-*.png`, `qa-390-*.png`, `*-gray.png`, `qa-shots.mjs`).
- [x] **QA fixes (3, all in `public/index.html`):** (1) header title truncated to "Safet…" at 390px → "Devnet only" pill + subtitle now hidden below `sm`, full "Safety Desk" shows; (2) "How to use" dialog rendered top-left (Tailwind preflight kills the UA `margin:auto` centering) → added `m-auto`, dialog now centered at both widths; (3) missing favicon caused a console 404 → inline SVG data-URI favicon added. UI stays English-only with the "How to use" button.
- [x] **Vercel deploy ($0, Hobby):** project `solana-safety-desk`, production deployment `dpl_Fyqvq3zviTrX5zjeNMo5dvNKMJQP` READY; live at https://solana-safety-desk.vercel.app. Verified live: `GET /api/health` 200 + `POST /api/check` 200 returning score 19 / AVOID / 6 checks for the known devnet market — matching `EVIDENCE/live-binary.json`.
- [x] **Deploy blocker fixed:** first deploy 500'd every API route (`FUNCTION_INVOCATION_FAILED`) — root cause was ESM-only `uuid@14` nested under `rpc-websockets` (`ERR_REQUIRE_ESM` on Vercel's Node 26 fluid runtime). Fixed with `"overrides": {"uuid": "8.3.2"}` in `package.json` + regenerated lockfile; tree verified single deduped CJS uuid. See "Deploy gotchas" — do not regress.
- [x] This guide updated with live links, deploy procedure, gotchas, and QA outcome.

### Remaining (Integration + packaging phases)

- [ ] **Public repo + README disclosure** (MintGuard-derived patterns — already drafted in README.md). BLOCKED on GitHub PAT scope — parent's step.
- [ ] **Demo markets:** seed 2–3 demo markets on devnet (test mUSDC only, via the pm-AMM quickstart/faucet) so the demo is self-contained and doesn't depend on strangers' expiring markets; point the UI examples at the seeded markets (only addresses verified from a live devnet read).
- [ ] **Submission prep:** project title + description + PREDICT sponsor-track pick (pm-AMM is core), pitch video ≤ 3 min (optional but valuable). Submit by 4 Dec (buffer — deadline time-of-day unknown). Submission is his tap.
- [ ] **Stretch only if the core is done early:** perps module (Drift/Jupiter position-risk view) — do not split focus before the pm-AMM core is live.
- [ ] **Ongoing:** re-run the IDL diff + `fetchAllMarkets(443)` size check weekly; if the program upgrades, re-verify decoders + DAO address + fee constants before trusting the desk again.

## Safety rules (non-negotiable)

- **Devnet only.** No mainnet addresses, RPCs, or code paths. The program ID is shared with mainnet — the devnet RPC + devnet mUSDC mint are the guardrails.
- **Read-only.** No wallet connects, no signatures, no transactions, no credentials in code/env/files.
- **Honest checks.** A check that cannot read its input returns `info` and explains what is missing — never a guessed pass/fail, never a fake score. Heuristics are labeled as heuristics; PARTIAL verdicts stay partial.
- **No unverified claims.** Sample addresses in the UI must come from a live devnet read or the pm-AMM docs/repo — never invented.
