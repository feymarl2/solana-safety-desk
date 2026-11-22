# Perp & Prediction Market Safety Desk

**Solana "Perps and Prediction Markets" hackathon entry — deadline displayed as 6 Dec 2026 (WIB); exact time unverified, submit by 4 Dec.**

Paste a pm-AMM prediction market address → instant safety verdict before you trade or provide liquidity: a 0–100 score, a verdict band (**LOOKS SOUND** / **TRADE WITH CAUTION** / **AVOID**), six per-check cards with evidence links, and a one-paragraph plain-English explanation.

- **Live:** https://solana-safety-desk.vercel.app (deployed 15 Nov 2026, $0 Hobby — see DEVELOPER-GUIDE.md)
- **Repo:** TODO (new public repo)
- **Network:** Solana devnet only. Read-only. No wallet connection, no sign-in, no transactions, $0 spend.

## The six checks

| # | Check | What it answers |
|---|---|---|
| 1 | Resolution authority | Who picks the winning outcome — single key, multisig, or oracle? Any dispute window? |
| 2 | Upgrade authority | Can one key rewrite the program? Is it immutable or multisig-governed? Any recent upgrades? |
| 3 | Solvency | Does the vault cover every outstanding winning token? Coverage ratio in plain language. |
| 4 | Multi-outcome coherence | Do the legs' implied probabilities sum to 1 right now, or has the group drifted? |
| 5 | LP risk | Dynamic liquidity decay to expiry, expected arbitrage losses, and who receives the 2% fee. |
| 6 | Expiry & market rules | Time to expiry, settlement terms (1 winning token = 1 USDC), question clarity, seed vs current price. |

**Status: Phase 1 complete (15 Nov 2026).** All six checks are implemented and verified live against Solana devnet — see `EVIDENCE/` for 8 recorded verdicts (live binary, drift group, group leg, expired, AWOL, resolved, nonexistent, non-market). Remaining: screenshot QA, Vercel deploy, public repo, demo-market seeding. See DEVELOPER-GUIDE.md.

> Note: every real pm-AMM market currently scores ≤ 19 (AVOID) because the program has a single-key upgrade authority — a hard fail by the scoring rules, and the protocol's own disclosed state. Scores still differentiate below the cap.

## Run it locally

```bash
cd build
npm install
npm run dev        # http://localhost:3000 — serves the UI + the real /api handlers
npm run smoke      # offline smoke test: no network calls
npm run build      # tsc --noEmit
```

No environment variables. No secrets. No wallet.

## Architecture

```
public/index.html            One-page UI (Tailwind + Lucide, English-only, "How to use" dialog)
api/check.ts                 POST { market } → verdict JSON (rate limit 60/hr/IP)
api/health.ts                Liveness + static config (never secret values)
lib/constants.ts             Devnet constants: program ID, mUSDC mint, RPC, explorer URLs
lib/rpc.ts                   Read-only devnet Connection (offline-safe construction)
lib/verdict.ts               checkMarket() entry point (mirrors MintGuard's verdict.ts)
lib/engine/types.ts          CheckResult / MarketSnapshot / MarketVerdict types
lib/engine/decode.ts         Manual Borsh decoders (Market/Group/ProgramData/SPL accounts)
lib/engine/math.ts           pm-AMM math: I80F48, rescaled pricing, pool value, expected LVR
lib/engine/snapshot.ts       Batched devnet snapshot gatherer (cached ProgramData, retry-on-429)
lib/engine/scorer.ts         Pure scorer: checks → 0–100 + band + explanation
lib/engine/index.ts          Check registry + orchestrator (one failure never kills the verdict)
lib/engine/checks/*.ts       The six checks — all IMPLEMENTED (see DEVELOPER-GUIDE.md)
scripts/smoke.ts             Offline smoke test (decoders, math, scorer, heuristic)
scripts/local-server.ts      Local dev server (no Vercel login needed)
```

## Reused prior work (disclosure)

The verdict-engine *pattern* (checks → score → verdict → reasons → evidence, hard-block score cap) is adapted from the author's own prior work, **MintGuard** (NEAR Hackathon 2026, MIT-licensed). No EVM code was copied: every check, type, and read in this repo is new Solana-specific work. The app grammar (Vercel serverless API + static one-page UI) mirrors the author's MintGuard Listings Desk (Telegraph Hackathon Season II).

## Sources

- pm-AMM docs: https://predict-pm-amm.dev/
- pm-AMM builder kit: https://predict-pm-amm.dev/hackathon.md
- pm-AMM repo: https://github.com/sparkfun-labs/pm-amm
- The paper: C. Moallemi, D. Robinson, *pm-AMM: A Uniform AMM for Prediction Markets*, Paradigm, Nov 2024 — https://www.paradigm.xyz/writing/pm-amm
