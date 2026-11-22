# RESEARCH — Perp & Prediction Market Safety Desk (pm-AMM spike)

**Date:** 15 Nov 2026, ~17:27–17:40 WIB (10:27–10:40 UTC). Read-only: docs + public repo
(clone of HEAD `d5b407b`) + live devnet RPC reads. No logins, no spending, no wallet.
**Verdict up front:** 3 of 6 checks are fully implementable from public devnet data,
2 are partial (core implementable, one sub-question heuristic/history-bound), 1 is
implementable except for its "question clarity" half, which must be a heuristic.
No check is fully blocked. Details + exact data sources below.

---

## 1. Identity: program, repo, SDK

| Item | Value |
|---|---|
| Program ID (devnet AND mainnet-beta, same) | `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y` |
| Repo | https://github.com/sparkfun-labs/pm-amm (public, MIT, HEAD `d5b407b`, 167 commits) |
| Docs site | https://predict-pm-amm.dev/ |
| Builder kit | https://predict-pm-amm.dev/hackathon.md |
| Agent reference | https://predict-pm-amm.dev/llms.txt |
| API reference | https://github.com/sparkfun-labs/pm-amm/blob/main/doc/api-reference.md |
| SDK quickstart | https://github.com/sparkfun-labs/pm-amm/blob/main/packages/sdk/README.md |
| IDL (repo) | `idl/pm_amm.json` — byte-identical to the SDK-bundled `packages/sdk/src/idl/pm_amm.json` (verified by diff) |
| IDL address field | `GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y` |
| Instructions | **34** (10 binary + 5 group + 5 vault + 6 vault-group + 8 bet-vault; counted from IDL) |
| Accounts | 9: `Market`, `LpPosition`, `GroupMarket`, `CommitmentVault`, `CommitPosition`, `CommitmentVaultGroup`, `CommitPositionGroup`, `BetVault`, `BetPosition` |
| Reference app (devnet) | https://pm-amm-devnet.vercel.app (market page `/market/<numeric marketId>`) |
| Devnet collateral (mock USDC) | `3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ`, 6 decimals, symbol `mUSDC` |
| Mainnet collateral (real USDC) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (never touch from this build — devnet only) |
| Protocol DAO (50% of swap fee) | `4qXyczAr5DuBVaHUwmZT5Xt6hgQ6RwqBYcFGtrv8QEph` (hardcoded in `swap.rs` + SDK `PROTOCOL_DAO`; off-curve = PDA, see §4 check 2 note) |
| Swap fee | 2% (`SWAP_FEE_BPS = 200`), USDC leg only, split 50% DAO / 50% market creator; YES↔NO free |
| Devnet RPC | `https://api.devnet.solana.com` (public, rate-limited — batch reads, poll ≥15s) |
| Tests claimed | 266 (72 Rust unit + 64 TS integration + 130 Python oracle/property) |
| Audit | **None.** Self-described "trust-based proof of concept" (`MAINNET.md`, docs §7). No third-party audit exists — the desk must say so, it cannot "verify" an audit. |

### SDK

- **Package:** `@pm-amm/sdk`, **version `0.2.0`** — npm latest, published 2026-09-24
  (verified against the npm registry; only versions ever published: `0.1.0`, `0.2.0`).
  **Do NOT use 0.1.0** — it carries the stale pre-Sprint-25 DAO address (`MAINNET.md`).
- **Install:** `pnpm add @pm-amm/sdk @solana/web3.js @anchor-lang/core @solana/spl-token`
- **Peer deps:** `@solana/web3.js@^1.98.4`, `@anchor-lang/core@^1.0.1`,
  `@solana/spl-token@^0.4.14`. Single copy of web3.js required; browser needs a
  `Buffer` polyfill loaded before app imports; raw Node ESM breaks on `BN` — use a
  bundler or the CJS build (`require`).
- **Read-only client (what the desk uses — no wallet, no signing):**
  `PmAmmClient.readOnly(connection, programId, collateralMint, opts?)`.
  `fromProvider` is only needed for `send.*`/`flows.*`, which the desk does not need.

### Key read methods (`client.fetch*` — all typed, decoded, `null` if missing)

| Method | Returns | Notes |
|---|---|---|
| `fetchMarket(pda)` | `MarketAccount \| null` | Single market |
| `fetchAllMarkets(443)` | `{publicKey, account}[]` | `443` = current `Market` size; skips stale layouts |
| `fetchGroup(pda)` / `fetchAllGroups()` | `GroupMarketAccount` | Multi-outcome wrapper |
| `fetchLpPosition(market, owner)` | `LpPositionAccount \| null` | Needs an owner address (user input) |
| `fetchVault(pda)` / `fetchAllVaults()` | `CommitmentVaultAccount` | Binary commitment vault |
| `fetchCommitPosition(vault, owner)` | `CommitPositionAccount \| null` | |
| `fetchVaultGroup(pda)` / `fetchAllVaultGroups()` | `CommitmentVaultGroupAccount` | Multi-outcome vault |
| `fetchCommitGroupPosition(vault, owner)` | `CommitPositionGroupAccount \| null` | |
| `fetchBetVault(pda)` / `fetchAllBetVaults()` | `BetVaultAccount` | Bet vault v2 (has its own `resolver` + void fallback) |
| `fetchBetPosition(betVault, owner)` | `BetPositionAccount \| null` | |

PDA helpers (bound, no RPC): `marketPda(id)`, `yesMint(market)`, `noMint(market)`,
`marketVault(market)`, `lpPosition(market, owner)`, `groupPda(id)`, `vaultPda(id)`,
`vaultCollateral(vault)`, `commitPosition(vault, owner)`, vault-group + bet-vault
equivalents, `metadataPda(mint)`. Pure `derive*` versions take `programId` first.

Batched reads: `client.program.account.market.fetchMultiple(pdas)` (one RPC call;
see the helpers file below). Anchor's `fetchAll*` = `getProgramAccounts` + decode.

### Pure math (`@pm-amm/sdk/math` — no chain dependency)

`i80f48ToNumber`, `phi`, `capitalPhi`, `phiInv`, `priceFromReserves(x, y, lEff)`,
`poolValue(price, lEff)`, `estimateSwapOutput` (**buys only, fee-unaware — do not use
for quotes**), `expectedDailyLvr(price, lEff, remainingSecs)`,
`expectedTerminalWealth(deposited)` (= deposited/2), `simulateLpDeposit`,
`lpPositionPnl`, `expectedLegSeedBps`/`expectedLegSeedPrice`,
`sumProbabilities`/`groupDriftPct`, `expectedDriftAfterBet`,
`legBudgetAllocations`, `formatUsdc`/`formatPrice`/`formatTimeRemaining`,
bet-vault odds helpers (`betOddsBps`, `betEffectiveLpBps`, `betKeptCollateral`, `betPayout`).

### Helpers file (REQUIRED — copy it, do not hand-roll quotes)

https://predict-pm-amm.dev/helpers/pm-amm-helpers.ts — exports `marketState(m)`,
`quoteSwap(m, direction, amountInRaw)` (all 6 directions, 2% fee included, matches
`simulateTransaction` to <0.01%), `minOutput(quote)`, `fetchMarkets(client, pdas)`.
**Caveat verified:** this file is **NOT in the repo** at HEAD (no `examples/helpers/`
directory exists; the `hackathon.md` GitHub link to it is stale). The docs-site copy
is canonical; copy from there.

---

## 2. On-chain account layouts (fields the desk reads)

Fixed-point fields (`l_zero`, reserves, accumulators, shares) are **I80F48 stored as
`u128` bits** = signed 128-bit integer / 2^48. SDK: `i80f48ToNumber(BN)`. All money
values are in **raw 6-decimal units** (1 USDC = 1,000,000). My independent Python
decode of live devnet accounts reproduced sane prices/supplies, confirming this.

### `Market` — 443 bytes, PDA seeds `["market", market_id_le_u64]`

| Field | Type | Desk use |
|---|---|---|
| `authority` | Pubkey | Resolution authority + creator-fee recipient. THE trust field |
| `market_id` | u64 | Arbitrary creator-chosen id (timestamps/random observed, NOT sequential) |
| `collateral_mint` | Pubkey | **Any SPL mint is accepted** — must compare to expected mUSDC/USDC |
| `yes_mint` / `no_mint` | Pubkey | PDAs `["yes_mint"/"no_mint", market]`; supplies via `getTokenSupply` |
| `vault` | Pubkey | PDA `["vault", market]`; USDC token account; balance via `getTokenAccountBalance` |
| `start_ts` / `end_ts` | i64 | Expiry = `end_ts` (T). Duration bounds [300s, ~50y] |
| `l_zero` | u128 (I80F48) | L₀. `0` = market shell, never funded — no price exists |
| `reserve_yes` / `reserve_no` | u128 (I80F48) | Virtual reserves x/y **as of `last_accrual_ts`** — must rescale (see §3) |
| `last_accrual_ts` | i64 | Timestamp the stored reserves date from |
| `cum_yes_per_share` / `cum_no_per_share` | u128 | dC_t accumulators (LP residual accounting) |
| `total_yes_distributed` / `total_no_distributed` | u64 | Cumulative LP distributions |
| `total_lp_shares` | u128 | LP share supply |
| `resolved` | bool | |
| `winning_side` | u8 | 0 = unresolved, 1 = YES, 2 = NO |
| `bump` | u8 | |
| `name` | [u8; 64] | **The ONLY market text on-chain.** Zero-padded UTF-8, 1–64 bytes |
| `initial_price_bps` | u16 | Seed YES price; 0 = legacy 50/50; else [100, 9900] |
| `group` | Pubkey | GroupMarket PDA if attached as a leg, else `Pubkey::default()`; write-once |
| `unclaimed_excess_yes` / `unclaimed_excess_no` | u64 | Unminted LP surplus — **counted in the solvency guard** |

IDL discriminator: `[219, 190, 213, 55, 0, 227, 198, 154]`.

### `GroupMarket` — 1188 bytes, PDA seeds `["group", group_id_le_u64]`

`authority`, `group_id`, `start_ts`, `end_ts`, `leg_count` (u8, 2–32),
`legs[32]` (Pubkey array; `Pubkey::default()` = empty slot), `resolved`,
`winning_leg` (u8, `0xFF` = unresolved), `bump`, `name[64]`,
`total_seeded_bps` (u32, Σ seeded bps; enforced ≤ 10,001 at attach, and within
`[10_000 − N − (10_000 % N), 10_001]` at resolution). Discriminator:
`[64, 120, 105, 242, 92, 182, 3, 113]`.

### `LpPosition` — 145 bytes, PDA seeds `["lp", market, owner]`

`owner`, `market`, `shares` (u128), `collateral_deposited` (u64),
`yes_per_share_checkpoint` / `no_per_share_checkpoint` (u128), `bump`,
`excess_yes` / `excess_no` (u64). Discriminator: `[105, 241, 37, 200, 224, 2, 252, 90]`.
Enumerable per market via `getProgramAccounts` + `memcmp` on the `market` field
(offset 40 = 8 discriminator + 32 owner).

### `CommitmentVault` / `CommitmentVaultGroup` / `BetVault`

- Vault: `authority`, `vault_id`, `collateral_mint`, `name[64]`, `commit_end_ts`,
  `market_end_ts`, `yes_total`, `no_total`, `commit_count`, `min_total`, `launched`,
  `winning_price_bps` (launch price), `market` (launched PDA or default), `lp_position`.
- Vault group: + `leg_count` (2–8), `leg_names[8][32]`, `leg_totals[8]`,
  `group_market_initialized`, `legs_launched`, `group_market`.
- **BetVault** (distinct resolution model): `authority`, **`resolver`** (only key that
  may resolve; defaults to creator), `vault_id`, `collateral_mint`, `name[64]`,
  `commit_end_ts`, `market_end_ts`, `yes_total`, `no_total`, `commit_count`,
  `min_total`, `lp_bps`, `effective_lp_bps`, `allowlist_len` + `allowlist[8]`
  (0 = open), `launched`, `price_bps`, `market`, `winning_side`, `settled`,
  `payout_pool`, `claimed_stake`, `paid_out`, `refunding`, **`void_grace_secs`**
  (default 7 days), **`voided`**. The launched market's `authority` is the vault PDA,
  and only `resolveBetVault` can resolve that market. **Void fallback exists only
  here:** anyone may `void_bet_vault` after `market_end_ts + void_grace_secs` if never
  resolved, refunding all committers pro-rata.

### PDA seeds (all)

Market `["market", id]` · LpPosition `["lp", market, owner]` · GroupMarket
`["group", id]` · YES/NO mints `["yes_mint"/"no_mint", market]` · market vault
`["vault", market]` · CommitmentVault `["vault", id]` (same seed string, different
second seed) · vault collateral `["vault_collateral", vault]` · CommitPosition
`["commit", vault, owner]` · CommitmentVaultGroup `["vault_group", id]` ·
`["vault_group_collateral", vault]` · CommitPositionGroup `["commit_group", vault, owner]` ·
BetVault `["bet_vault", id]` · BetPosition `["bet_position", vault, owner]`.

---

## 3. The one formula the desk must get right: current price

Stored reserves date from `last_accrual_ts`. Every swap accrues first, and liquidity
decays as `L_eff = L_0 · √(T − t)`. Quoting stored reserves against today's `L_eff`
over-promises by +15–80% on idle markets. Correct procedure (from `llms.txt` +
helpers `marketState`, verified against `accrual.rs`/`pm_math.rs::l_effective`):

```
lEff  = L0 * sqrt(max(endTs - now, 1))
lLast = L0 * sqrt(max(endTs - lastAccrualTs, 1))
scale = lEff / lLast
x = reserveYes * scale ; y = reserveNo * scale
price = Φ((y - x) / lEff)          // = priceFromReserves(x, y, lEff)
poolValue = L_eff * φ(Φ⁻¹(price))  // = poolValue(price, lEff)
```

Use `marketState(m)` from the helpers file; never price from raw stored reserves.
Resolved markets: price is 1/0 by `winning_side`. Unfunded markets (`l_zero == 0`):
no price — report "no liquidity", do not show 50%.

---

## 4. Per-check verdicts

### Check 1 — Resolution integrity: **PARTIAL**

**Implementable from public data:**

- **Who resolves:** `market.authority` (binary) / `group.authority` (group) /
  `betVault.resolver` (bet vault). `resolve_market` enforces exactly
  `market.authority == signer` + `now >= end_ts` + not already resolved
  (`resolve_market.rs`, verified in source). Attached legs CANNOT resolve directly
  (`LegMustCascadeResolve`); they cascade from `group.winning_leg` via permissionless
  `resolve_group_leg`. Desk shows: authority address, whether it equals the market
  creator (it always does by construction, except vault-launched markets where
  authority = vault authority, and bet-vault markets where authority = vault PDA),
  resolved state + `winning_side`/`winning_leg`, and time since expiry without
  resolution (authority AWOL risk — no deadline exists for resolving).
- **No oracle / no timelock / no dispute — PROVABLE, not just documented.**
  Grep of the full program source: zero oracle/dispute/timelock logic (all 29
  "oracle" hits refer to the off-chain Python scipy test-reference in `oracle/`).
  The 34-instruction IDL contains no oracle-adapter, dispute, timelock, or
  challenge instruction. The desk can truthfully state "no oracle, no dispute
  window, no timelock in the deployed program" as a **code fact**, citing the
  program's own docs §7 + `MAINNET.md` accepted-risk list. Any future oracle adapter
  would be a separate program/instruction — re-check the IDL on each build.
- **Bet-vault exception:** `void_grace_secs` + `voided` give a real permissionless
  refund fallback — the desk should surface it as the ONLY fallback in the system.
- **Single-key vs multisig/DAO — HEURISTIC ONLY (downgrade).** The authority is one
  bare `Pubkey`; nothing on-chain records whether it is a lone keypair, a Squads
  vault PDA, or a DAO. Available signals, in order of strength:
  1. `PublicKey.isOnCurve(authority)`: off-curve ⇒ PDA (program-controlled, e.g. a
     Squads vault or another program) — suggestive, not proof of multisig.
     On-curve ⇒ almost certainly a plain keypair. (Method validated: base point,
     5 fresh ed25519 keys, Token/System/program IDs all classify correctly.)
  2. `getAccountInfo(authority)`: owner + data length. A Squads V4 multisig *config*
     account is owned by `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`, but the
     *vault PDA that signs* is an empty system-owned account — owner check alone
     cannot confirm a vault.
  3. Tx history: if past `resolve_market` calls for this authority were invoked via
     a Squads CPI, `getSignaturesForAddress` + `getTransaction` would show it.
     Needs history parsing; not a current-state read.
  - Default desk wording: "Single address controls resolution (no on-chain evidence
    of multisig)" unless signal 1/3 says otherwise. Never claim "multisig" without
    history evidence.
- **Authority track record (has this key resolved fairly before?): NOT POSSIBLE**
  from current-state reads. Requires an indexer or `getSignaturesForAddress` scans
  over every market the authority created + resolution-tx parsing. Out of scope for
  v1; list as a disclosed limitation, not a score input.

**Exact calls:** `fetchMarket` / `fetchGroup` / `fetchBetVault` →
`authority`, `resolver`, `resolved`, `winning_side`/`winning_leg`, `end_ts`,
`group` (attached-leg detection); `getAccountInfo(authority)`; `isOnCurve` (local).

### Check 2 — Upgrade authority: **IMPLEMENTABLE** (current state) / **PARTIAL** (history)

**Implementable — verified live on devnet 15 Nov 2026, 10:27 UTC:**

Solana's upgradeable loader stores the authority in the `ProgramData` account.
Procedure (no SDK support needed; 2 RPC calls + local parse):

1. `getAccountInfo(programId)` → data bytes `[4..36]` = ProgramData address.
   Program account enum = 2 (`Program`).
2. `getAccountInfo(programData)` → header: u32 enum `3` (`ProgramData`) +
   u64 `slot` (last deploy/upgrade slot) + u8 `Option` flag + 32-byte authority
   pubkey (absent if flag = 0 ⇒ **immutable**).
3. `getBlockTime(slot)` → last-upgrade timestamp.
4. `PublicKey.isOnCurve(authority)` → on-curve = plain single keypair; off-curve =
   PDA (possibly a multisig vault). `getAccountInfo(authority)` owner check as a
   secondary signal.

**Live results (devnet):**

| Field | Value |
|---|---|
| ProgramData address | `4wBVEijk6s6F9NuYmTRxbMWPfAaFXRsNq54haAf88piF` (same derivation on mainnet; contents differ per cluster) |
| Upgrade authority | `ETGKSFc7KMu32foPegEGiqFiDX3B2bPXhiFhvm8K7R6Y` — **exactly matches `DEVNET.md`** |
| Authority account | owner = System Program, 0 data bytes, not executable, 1.3425 SOL |
| On-curve? | **Yes → plain single keypair. Single-key upgrade authority CONFIRMED on-chain.** |
| Last deploy slot | 511269300 → **15 Oct 2026, 07:11 UTC** (matches the `MAINNET.md` upgrade log: vault-launch authority fix) |
| ProgramData size | 1,532,629 bytes (~1.53 MB `.so`) |
| Immutable? | No — authority present. |

Mainnet authority (from `MAINNET.md`, NOT re-verified live in this spike — devnet
only per task scope): `2TBg1fasPKnBczbtJpvD6LmEUxNnCoigTDQHB3VnUpv7`, also on-curve
(verified locally from the published string) ⇒ single keypair there too. The desk
runs on devnet; if it ever displays mainnet data it must re-read mainnet ProgramData
rather than trust the doc string.

**Partial — "recent upgrades":** `getSignaturesForAddress(programData, {limit})`
returned 11 signatures (3 recent: 23 Sep, 28 Sep, 15 Oct 2026 + older June 2026
entries). But a signature touching ProgramData is not proof of an upgrade —
confirming requires `getTransaction` + parsing for the loader `Upgrade` instruction,
and RPC history is bounded (old signatures age out). Desk v1 should show: current
authority + last-deploy slot/time + "N recent ProgramData transactions" with an
explicit "history may be incomplete" note. Full upgrade history needs an indexer
(Helius/Solscan API) — **downgrade to disclosure**, do not present a partial list as
complete.

**Exact calls:** `getAccountInfo` (program + programdata), `getBlockTime`,
`getSignaturesForAddress` (bounded), local header parse + `isOnCurve`.

### Check 3 — Solvency: **IMPLEMENTABLE** (exact — replicates the on-chain guard)

The program enforces solvency on every swap (`swap.rs`, "SOLVENCY GUARD (fix #1)").
The desk re-computes the same obligation from public reads:

```
obligation = max(yesSupply + x_now + unclaimedExcessYes,
                 noSupply  + y_now + unclaimedExcessNo)
coverage   = vaultBalance / obligation
```

where `x_now`/`y_now` are the **rescaled** reserves (§3), supplies are SPL mint
supplies, and the excess terms are `market.unclaimed_excess_*`. The naive formula
"vault vs winning-token supply" is WRONG — it omits reserves and unclaimed surplus
and would overstate coverage. The guard formula above is the correct one; it is also
what `claim_winnings` re-checks at payout (`vault >= winning_balance`, hard revert,
pays exactly 1:1, no fee — the old silent `min()` haircut was removed).

**Verified live (devnet, 15 Nov 2026):**

| Market | Vault | Obligation | Coverage |
|---|---|---|---|
| `3GAjk9Cp…` "SOL > $71.85 by 10:47?" | 50.00 mUSDC | 28.88 | **1.73×** |
| `4QW2qaFB…` "BTC above $70k … (CoinGecko)" | 50.00 mUSDC | 9.27 | **5.40×** |

(Both fresh markets: zero circulating supply, obligation = reserves only. Coverage
> 1 is expected BY CONSTRUCTION — the guard makes < 1 unreachable through normal
swaps. A reading < 1.0 would mean an invariant break/bug: flag CRITICAL, do not
smooth it over. Coverage near 1.0 on a heavily-traded market is normal, not a warning
by itself — pair with the reserve/supply split in the UI.)

**Exact calls:** `fetchMarket` → `reserve_yes/no`, `last_accrual_ts`, `l_zero`,
`end_ts`, `unclaimed_excess_*`, `yes_mint`, `no_mint`, `vault`;
`getTokenSupply(yesMint)`, `getTokenSupply(noMint)`,
`getTokenAccountBalance(vault)` (or one `getMultipleAccounts` batch for the vault
+ mint accounts and parse amounts locally). All in raw units; divide by 10^6 for
display (decimals come from the collateral mint — read them, don't assume 6 for
arbitrary mints).

**Bonus check discovered (implement in v1, cheap): collateral-mint verification.**
`initialize_market` accepts **ANY SPL mint** as collateral ("The collateral mint —
ANY SPL mint"). A market collateralized by a worthless/self-minted token would still
pass the solvency formula in its own units. Desk must assert
`market.collateral_mint == 3WQ8hCq…` (devnet) and flag anything else CRITICAL.

### Check 4 — Coherence (multi-outcome): **IMPLEMENTABLE**

For a `GroupMarket`: fetch each leg in `legs[0..leg_count]`, compute each leg's
current YES price via §3 rescaling, sum, report drift `Σ − 1`.

- SDK provides `sumProbabilities(prices)` / `groupDriftPct(prices)` and
  `expectedLegSeedBps(legCount)` (= `10_000/N`).
- On-chain enforcement exists ONLY at seed (`attach_leg_to_group` caps
  `total_seeded_bps ≤ 10_001`) and at resolution (`resolve_group` requires
  `total_seeded_bps` within `[10_000 − N − (10_000 % N), 10_001]`). Between trades,
  drift is real and unbounded — the desk's live Σ is the whole point.
- **Verified live:** group `4s2XecwCSGWePmQR4QesHKMncXZccBo5ZqWx5t1n7N76`
  ("Best performer in Q4 2026", 3 legs, seeded 9999 bps) showed leg prices
  `[0.333, 0.333, 0.765]`, **Σ = 1.4317, drift +43.2%** — a genuine, large, live
  drift the desk would flag. (This is a seeded demo group from
  `scripts/seed-devnet.cjs`, so drift here reflects test trading, not a live exploit.)
- **Edge cases the desk must handle:** empty leg slots (`Pubkey::default()` — skip,
  report "N of M legs attached"); junk groups with `total_seeded_bps = 0` exist on
  devnet (observed 2); legs with `l_zero == 0` have no price (exclude from Σ, flag
  "leg unfunded"); expired-but-unresolved groups (report drift as stale).
- Standalone binary markets: coherence is N/A (single price, no Σ constraint) —
  show "single market" rather than a fake Σ=1.

**Exact calls:** `fetchGroup` → `legs`, `leg_count`, `total_seeded_bps`, `resolved`,
`winning_leg`; `fetchMultiple(legPdas)` → per-leg `fetchMarket` fields; §3 pricing;
`groupDriftPct`.

### Check 5 — LP risk: **PARTIAL** (model/ex-ante implementable; realized/history not possible)

**Implementable:**

- **Liquidity decay schedule:** `L_eff(t) = L_0 · √(T − t)` from `l_zero` + `end_ts`.
  Desk can show: current `L_eff`, `L_eff` at expiry approach, % liquidity already
  released via dC_t (`cum_*_per_share × shares` vs initial), and pool value
  `V(P) = L_eff · φ(Φ⁻¹(P))` via `poolValue`. All from `fetchMarket` + SDK math.
- **Expected LVR (model, ex-ante):** `expectedDailyLvr(price, lEff, remainingSecs)`
  = `V / (2 · remaining)`; `expectedTerminalWealth(deposited)` = deposited/2 (paper
  result: LPs end with half their wealth in expectation under Gaussian score
  dynamics; README reports measured 0.518 over 500 Monte-Carlo runs). Show as
  "expected" with the model assumption stated — it is a property of the curve, not
  a prediction for this market.
- **Fee split:** constant, from code: 2% on the USDC leg, 50/50 DAO/creator, none to
  LPs. Display as a fixed disclosure + the creator address (`market.authority`).
  Note the consequence: LP economics are curve spread + dC_t only; fees do NOT
  compensate LPs (README "Known Limitations" + `swap.rs`).
- **Per-LP position (needs a wallet address):** `fetchLpPosition(market, owner)` →
  `shares`, `collateral_deposited`, checkpoints, `excess_*`; pending residuals =
  `(cum − checkpoint) × shares`; `lpPositionPnl(...)` for mark-to-market P&L.
  Implementable for any pasted owner address.
- **LP concentration:** enumerable — `getProgramAccounts(programId, {filters:
  [dataSize 145, memcmp offset 40 = market pubkey]})` returns all `LpPosition`s for
  a market; sum shares, show top-LP share / Herfindahl. Implementable, no indexer.

**NOT possible from public state reads (downgrade to disclosure):**

- **Realized LVR / realized LP returns:** needs price/volume history over the
  market's life. No history endpoint exists in the SDK; devnet has no maintained
  pm-AMM indexer. Do NOT fabricate a "historical LVR" number. Desk shows expected
  (model) LVR only, labeled as such.
- **Impermanent-loss-style realized P&L for arbitrary LPs over time:** same history
  gap. Point-in-time `lpPositionPnl` (mark-to-market now) is fine; time series is not.

**Exact calls:** `fetchMarket` → `l_zero`, `end_ts`, `reserve_*`, `last_accrual_ts`,
`cum_*_per_share`, `total_lp_shares`; SDK math above; `fetchLpPosition` /
`getProgramAccounts` (LpPosition enumeration) for concentration.

### Check 6 — Expiry & market rules: **IMPLEMENTABLE**, except question clarity (**HEURISTIC**)

**Implementable:**

- Time to expiry: `end_ts − now` (SDK `formatTimeRemaining`); expired-but-unresolved
  age: `now − end_ts` with `resolved == false` (authority AWOL flag — no on-chain
  resolution deadline exists for binary/group markets).
- Settlement terms: fixed by code, verified in `claim_winnings.rs` (1 winning token
  = 1 collateral unit, no fee, hard vault check) and `redeem_pair.rs` (1 YES + 1 NO
  = 1 USDC, always, pre/post resolution). Display as verified code facts with
  source links, not as per-market reads.
- Seed vs current: `initial_price_bps` (0 ⇒ 50%) vs §3 current price; show move in
  percentage points. Live example: `fcLNbKJMg8fUPs9W8cVog6yowU4qhgu1cR34n5GFYN6`
  seeded 3960 bps, current 39.6% at read time (untraded).
- Duration sanity: `end_ts − start_ts` vs the [300s, ~50y] on-chain bounds; very
  short markets (<1h) and absurdly long ones (>1y) deserve flags (thin time for
  price discovery / authority-disappearance risk).
- Vault/bet-vault timelines: `commit_end_ts`, `market_end_ts`, `launched`,
  `min_total` vs totals, `void_grace_secs` — all on-chain; the desk should render
  vault state machines (commit → launch → trade → resolve/settle/refund/void).

**HEURISTIC ONLY — question clarity (downgrade):** the market question is ONLY the
64-byte `name` field. There is no description, rules, resolution-source, or link
field anywhere on-chain: Metaplex YES/NO metadata carries name/symbol only with an
**empty URI** (`initialize_market.rs`: `String::new()` URI, "no URI" comment). No
off-chain registry exists in the repo. So "question clarity" can only be a
name-string heuristic — e.g. length, ends with "?", contains a date/threshold/number,
mentions a source ("CoinGecko", "Pyth"), vs junk names observed live (`"kjkj"`,
`"sdasd"`, `"0 (0 bps)"`). Score it as a low-weight heuristic with the disclosure
"no resolution criteria are recorded on-chain — the authority's interpretation is
final", and NEVER present the heuristic as a verified rules check. Do not use an LLM
to "judge clarity" as if it were evidence; a deterministic checklist is more honest
and reproducible.

**Exact calls:** `fetchMarket`/`fetchGroup`/`fetchVault*`/`fetchBetVault` →
`start_ts`, `end_ts`, `resolved`, `winning_side`/`winning_leg`, `name`,
`initial_price_bps`, vault timeline fields; §3 pricing for current price.

---

## 5. Verdict summary

| # | Check | Verdict | Key limitation |
|---|---|---|---|
| 1 | Resolution integrity | **PARTIAL** | Authority + no-oracle/no-timelock/no-dispute provable; multisig-vs-single-key is heuristic (on-curve + history); authority track record needs an indexer |
| 2 | Upgrade authority | **IMPLEMENTABLE** (state) / **PARTIAL** (history) | Current authority + last-deploy slot/time exact; full upgrade history needs tx parsing, RPC history bounded |
| 3 | Solvency | **IMPLEMENTABLE** | Must replicate the guard formula (reserves + excess), not naive supply comparison; add collateral-mint check |
| 4 | Coherence | **IMPLEMENTABLE** | Groups only; handle empty/unfunded legs |
| 5 | LP risk | **PARTIAL** | Decay + expected LVR + fees + concentration implementable; realized LVR/history not possible — model-only disclosure |
| 6 | Expiry & rules | **IMPLEMENTABLE** + heuristic | All timeline/settlement/seed facts on-chain; question clarity is a name-string heuristic only — no rules text exists on-chain |

**Downgraded to heuristic/disclosure (do not score as verified facts):**
multisig status of the resolution authority; upgrade-history completeness; realized
LVR; question clarity; authority reputation (not scored at all in v1).

---

## 6. Sample devnet addresses (verified live 15 Nov 2026, 10:27 UTC)

Devnet state churns fast (markets expire; the ~20-minute market below was already
near expiry at read time). Re-run `fetchAllMarkets(443)` at build time and prefer
long-lived markets. Counts at read: **759** `Market` accounts, **84 live**
(unresolved + unexpired), **24** `GroupMarket` accounts.

**Live binary markets:**

| PDA | Name | Seed | Price @ read | Expiry |
|---|---|---|---|---|
| `fcLNbKJMg8fUPs9W8cVog6yowU4qhgu1cR34n5GFYN6` | BTC<=70000.00 by 2026-11-20 08:00Z | 3960 bps | 0.396 | 20 Nov 2026 08:00 UTC |
| `5VfqRxfnd8a8W45TEA2K76uXYWs7wt6RKVdRxSjNLnRb` | SOL>=91.50 by 2026-11-20 08:00Z | 1125 bps | 0.113 | 20 Nov 2026 08:00 UTC |
| `69r1s1cAfgtxs43GMHdMjNUbHkHmkk9cqJ67X9W4ikcK` | BTC<=66400.00 by 2026-11-20 08:00Z | 868 bps | 0.087 | 20 Nov 2026 08:00 UTC |
| `7VD8gtRb2UwmeXUGjfY3svT3jTaziPAgpnwfipXkP3GD` | SOL<=79.00 by 2026-11-20 08:00Z | 4143 bps | 0.413 | 20 Nov 2026 08:00 UTC |
| `4QW2qaFBfGpH345gjeQTzmRzojgCXTr4MagjV8ScShLW` | BTC above $70k at 2026-11-15 12:00 UTC? (CoinGecko) | 5000 bps | 0.500 | 15 Nov 2026 12:00 UTC (short-lived) |
| `3GAjk9CpNLoTsAZuMKMfqvKqh1qFumYu5fYPmU9V2ksv` | SOL > $71.85 by 10:47? | 5000 bps | 0.500 | 15 Nov 2026 ~10:47 UTC (expired by now) |

**Live group (coherence demo):**

| PDA | Name | Legs | Σ @ read |
|---|---|---|---|
| `4s2XecwCSGWePmQR4QesHKMncXZccBo5ZqWx5t1n7N76` | Best performer in Q4 2026 | 3 (seeded 9999 bps) | **1.4317 (+43.2% drift)** |

Explorer pattern: `https://solscan.io/account/<address>?cluster=devnet`
(SDK: `solscanAccountUrl(addr, "devnet")`).

**Demo-market recommendation for the build:** seed 2–3 fresh markets with long
durations (7–30 days) from the builder wallet via the faucet + `send.createMarket`,
so the demo is self-contained and doesn't depend on strangers' expiring markets.
Note the seeded demo group above came from the repo's own `scripts/seed-devnet.cjs`.

---

## 7. Faucet details (devnet test funds — the desk itself needs none, the demo does)

- **Endpoint:** `POST https://pm-amm-devnet.vercel.app/api/faucet`
  `{"wallet": "<devnet pubkey>"}` → `200 {"ok":true,"signature","amount":1000,"sol":n}`
  (CORS allowed; also usable from the browser).
- **Amount:** **1,000 mUSDC** per claim; creates the recipient's ATA if missing.
  Mint authority is a dedicated key `EftrgEw3B744jSihxjrWcX7pW7Y6WTxBJw7RhrGbU2vi`,
  separate from the upgrade authority (verified in `DEVNET.md` + faucet route source).
- **Limits (from route source):** 1 claim / wallet / hour; 5 / IP / day (default,
  raisable for events); 500 / global / day. `429` + `Retry-After` when hit;
  `400` bad wallet; `503` if mainnet/unconfigured.
- **SOL drip (hackathon/event mode, env-dependent):** tops up low-balance wallets —
  builder role 0.2 SOL, `role: "player"` (burner wallets) 0.02 SOL; stops if the
  mint authority would fall below a 2 SOL reserve; per-IP daily drip caps
  (builder 40, player 150). `sol: 0` in the response means no drip. Otherwise:
  `solana airdrop 1 <pubkey> --url devnet` or https://faucet.solana.com (rate-limited,
  often dry — don't loop).
- **Costs:** ~0.05 SOL per market created (rent + fees); burner/player wallets trade
  with the 0.02 SOL drip. The Safety Desk's reads cost nothing and need no wallet.
- **Mainnet:** faucet hard-disabled (UI hidden + API 503). Never point the desk at
  mainnet with real funds.

---

## 8. RPC call inventory (what the desk issues per verdict)

Single-market verdict (binary): `fetchMarket` (1) + `getTokenSupply` ×2 +
`getTokenAccountBalance` (1) + ProgramData check (cached globally, 2 calls, refresh
hourly) = ~4 calls + cache. Group verdict: + `fetchGroup` + `fetchMultiple(legs)`.
Batch with `getMultipleAccounts` / `fetchMultiple` where possible; public devnet RPC
429s under polling — poll ≥15s, pause when tab hidden, and consider the OrbitFlare
free RPC bounty only if limits bite (his tap, per RECON §7C).

No indexer, no API key, no backend is required for v1. Everything above is public
JSON-RPC + local math. History features (authority reputation, realized LVR, full
upgrade history) are the only items that would need an indexer — all deferred.

---

## 9. Open questions

1. **Program upgrades during the build window?** Last deploy 15 Oct 2026; if the
   program upgrades again before 5 Dec, account layouts/IDL could shift. Mitigation:
   re-run the IDL diff + `fetchAllMarkets(443)` size check weekly; pin SDK `0.2.0`
   and re-verify the DAO address + fee constants after any upgrade.
2. **Does the jury run on devnet only?** The PREDICT bounty requires "real
   users/trades/volume/fees on the pm-AMM" for traction weight — a read-only safety
   desk generates no trades. Traction story (if pursued): burner-wallet "check then
   trade" flow, or the desk's own demo markets. Product decision, not a data question.
3. **Perps module (stretch)?** Out of scope for this spike. Drift/Jupiter perps
   position-risk reads are a separate research task; do not start until the pm-AMM
   core is done (RECON §6 scope discipline).
4. **Squads vault detection for authorities:** if v2 wants stronger multisig
   evidence, the path is tx-history parsing (Squads CPI in past resolve/upgrade
   transactions), not current-state reads. Squads V4 program ID (mainnet + devnet):
   `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf`.
5. **Mainnet ProgramData re-verification:** mainnet authority quoted from
   `MAINNET.md` only. If the desk ever shows mainnet data, re-read mainnet
   ProgramData live first. (Build stays devnet-only regardless.)
6. **Stale `hackathon.md` GitHub link:** `examples/helpers/pm-amm-helpers.ts` does
   not exist in the repo — use the docs-site copy. Worth an upstream issue (optional,
   not blocking).

---

## 10. Sources (all read 15 Nov 2026)

1. https://predict-pm-amm.dev/ (docs §§1–9)
2. https://predict-pm-amm.dev/hackathon.md (builder kit, faucet, gotchas)
3. https://predict-pm-amm.dev/llms.txt (full SDK surface, pricing procedure)
4. https://predict-pm-amm.dev/helpers/pm-amm-helpers.ts (`marketState`, `quoteSwap`)
5. https://github.com/sparkfun-labs/pm-amm (clone, HEAD `d5b407b`):
   `anchor/programs/pm_amm/src/{state,lib,accrual,pm_math}.rs`,
   `instructions/{swap,resolve_market,claim_winnings,initialize_market}.rs`,
   `instructions/group/resolve_group.rs`, `packages/sdk/src/{client,constants,math}.ts`,
   `packages/sdk/src/types/accounts.ts`, `idl/pm_amm.json`, `DEVNET.md`, `MAINNET.md`,
   `SECURITY.md`, `app/src/app/api/faucet/route.ts`, `scripts/seed-devnet.cjs`
6. https://github.com/sparkfun-labs/pm-amm/blob/main/doc/api-reference.md
7. npm registry: `@pm-amm/sdk` versions/dist-tags (latest `0.2.0`, 2026-09-24)
8. Live devnet RPC (`https://api.devnet.solana.com`, 10:27 UTC): ProgramData parse,
   `getProgramAccounts` (759 markets / 24 groups), solvency spot-checks (2 markets),
   live group coherence (Σ = 1.4317). Decode script: `/tmp/rpc_check.py` (ephemeral;
   re-run on demand — logic reproduced in §§3–4).
9. Squads V4 program ID: web search (caper.network wiki + Squads docs corroboration).
