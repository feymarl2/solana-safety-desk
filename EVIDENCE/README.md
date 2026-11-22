# EVIDENCE — live devnet verification (Phase 1)

**Run:** 15 Nov 2026, ~10:37–10:41 UTC (17:37–17:41 WIB). Engine `1.0.0`.
**Method:** local dev server (`npm run dev`, the real `/api/check` handler) +
`curl` POSTs. RPC: `https://api.devnet.solana.com` (public devnet).
Each file holds one market: address, `checkedAtUtc`, RPC endpoint, and the
full verdict JSON returned by the server. Nothing here is hand-edited.

## Results

| File | Market | Score / band | Key evidence |
|---|---|---|---|
| `live-binary.json` | `fcLNbKJMg8fUPs9W8cVog6yowU4qhgu1cR34n5GFYN6` — "BTC<=70000.00 by 2026-11-20 08:00Z" | 19 / AVOID | Solvency 1.16× (vault 150.00 vs guard obligation 129.26); price 39.6% = seed 3960 bps; pool 77.67; expected daily LVR 7.94 (model); resolution authority off-curve heuristic (warn 55) |
| `group-drift.json` | `4s2XecwCSGWePmQR4QesHKMncXZccBo5ZqWx5t1n7N76` — "Best performer in Q4 2026" | 19 / AVOID | Legs 33.3% / 33.3% / 76.5%, Σ = 143.2%, drift 43.2pp → coherence fail; per-leg solvency 1.11× / 1.11× / 1.05× |
| `group-leg.json` | `6Yg878V1u4HDgeWrKmjTiXvDRoB5SGvUbG5iFr3xJzCj` — leg "BTC" of the group above | 19 / AVOID | Sibling legs fetched from the leg address; same 143.2% drift reproduced; cascade-resolution note |
| `expired-unresolved.json` | `2BqF6eu6MmBRm48ttuzst8Q7dnTuNkx2pedrYhTheLi4` — "SOL>68.8@1794722400" | 19 / AVOID | Expired 4h37m, unresolved, funded; solvency 1.42×; resolution warn (winnings locked) |
| `awol-131d.json` | `Ai7PRVYMMU8SGcokmd43nVzZ84vV9eavNxZPjhF9gMpX` — "CASHOUT smoke" | 8 / AVOID | Expired 131d unresolved → resolution fail; collateral-mint check caught a non-mUSDC mint → solvency fail |
| `resolved-yes.json` | `1a5271tnEsfPZpnDzZNH8yo5e6SPc6cwZX46cZ3TU3t` — "Will ETH be above $1,000…" | 19 / AVOID | YES won; program-owned (vault) authority noted; collateral-mint check caught a non-mUSDC mint → solvency fail |
| `nonexistent.json` | Random fresh keypair address (no account) | null / UNRATED | All checks info; no score invented |
| `system-program.json` | `11111111111111111111111111111111` (exists, not pm-AMM) | null / UNRATED | All checks info; upgrade check stays silent for non-markets |

## Cross-cutting confirmations (in every market verdict)

- **Upgrade authority:** `ETGKSFc7KMu32foPegEGiqFiDX3B2bPXhiFhvm8K7R6Y`,
  on-curve single key, last deploy slot 511,269,300 (15 Oct 2026), 11 recent
  ProgramData transactions observed — matches RESEARCH.md exactly.
- **Resolution check** states the no-oracle / no-dispute / no-timelock code
  fact in every market verdict.
- **Why every real market scores ≤ 19 (AVOID):** the single-key upgrade
  authority is a hard fail by the scaffold's scoring rule (caps at 19).
  That is the protocol's current disclosed state, not a desk bug — scores
  still differentiate below the cap (8 vs 19). If the program moves to a
  multisig/immutable authority, scores will rise accordingly.

## Reproduce

```bash
cd build
PORT=3100 npm run dev
curl -s -X POST http://localhost:3100/api/check \
  -H 'content-type: application/json' \
  -d '{"market":"fcLNbKJMg8fUPs9W8cVog6yowU4qhgu1cR34n5GFYN6"}'
```

Devnet state churns: prices, expiry ages, and coverage ratios will differ
on re-runs; the group drift and upgrade-authority readings were stable
across two runs 5 minutes apart (10:37 and 10:41 UTC).
