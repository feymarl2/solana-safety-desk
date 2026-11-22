// Solvency check — IMPLEMENTED (exact, RESEARCH §4).
// Does the vault cover every outstanding winning token? The desk
// re-computes the program's own on-chain solvency guard:
//
//   obligation = max(yesSupply + x_now + excessYes,
//                    noSupply  + y_now + excessNo)
//   coverage   = vaultBalance / obligation
//
// where x_now/y_now are the RESCALED reserves. The naive "vault vs
// winning-token supply" formula is WRONG (it omits reserves and unclaimed
// surplus and overstates coverage) and is never used. Resolved markets
// use the post-resolution basis: winning supply + winning excess only.
// Coverage < 1 is unreachable through normal swaps, so < 1 means an
// invariant break: fail, CRITICAL, never smoothed over. Coverage near
// 1.0 on a heavily-traded market is normal, not a warning by itself.
//
// Bonus check (cheap, in v1): collateral-mint verification.
// initialize_market accepts ANY SPL mint, so a market collateralized by
// a worthless token would pass the formula in its own units. Anything
// other than the devnet mUSDC mint is a CRITICAL fail.
// Scoring: wrong mint → fail 0. Coverage < 1 → fail 0. Coverage ≥ 1 →
// pass 90. Unfunded (no obligation) or unreadable inputs → info, no points.

import {
  DEVNET_MUSDC_MINT,
  explorerAccountUrl,
} from "../../constants.js";
import { formatUsdc, shortenAddress } from "../math.js";
import type { CheckContext, CheckResult } from "../types.js";

export const CHECK_ID = "solvency" as const;
export const CHECK_TITLE = "Solvency";
export const CHECK_WEIGHT = 20;

export async function checkSolvency(
  ctx: CheckContext,
): Promise<CheckResult> {
  const base = {
    id: CHECK_ID,
    title: CHECK_TITLE,
    weight: CHECK_WEIGHT,
    evidence: [
      {
        label: "Market account on Solscan (devnet)",
        url: explorerAccountUrl(ctx.marketAddress),
      },
    ],
    implemented: true,
  };
  const snap = ctx.snapshot;
  if (!snap) {
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        "The market snapshot could not be gathered, so vault coverage could not be computed.",
      implemented: false,
    };
  }
  if (snap.exists === false) {
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        "No account exists at this address on devnet, so there is no vault to check.",
    };
  }
  if (snap.exists === null || snap.kind === "unknown") {
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        snap.kind === "unknown"
          ? "This account is not a pm-AMM market or group account, so it has no solvency vault to check."
          : `The market account could not be read from devnet${snap.rpcError ? ` (${snap.rpcError})` : ""}, so vault coverage is unknown.`,
    };
  }

  // --- Group input: worst leg drives the verdict --------------------------
  if (snap.kind === "group") {
    const legs = snap.legs ?? [];
    const evidence = [
      ...base.evidence,
      ...legs.map((l, i) => ({
        label: `Leg ${i + 1} (${l.name ?? "unnamed"}) on Solscan (devnet)`,
        url: explorerAccountUrl(l.address),
      })),
    ];
    const badMintLeg = legs.find(
      (l) => l.decoded && l.collateralMint !== null && l.collateralMint !== DEVNET_MUSDC_MINT,
    );
    if (badMintLeg) {
      return {
        ...base,
        status: "fail",
        points: 0,
        explanation:
          `CRITICAL: leg "${badMintLeg.name ?? badMintLeg.address}" is collateralized by ${shortenAddress(badMintLeg.collateralMint as string)}, not the devnet mUSDC mint. ` +
          "The program accepts any SPL mint as collateral, so this leg's vault may hold a worthless token even if its coverage ratio looks fine. Do not trade this group.",
        evidence,
      };
    }
    const covered = legs.filter((l) => l.coverage !== null);
    if (covered.length === 0) {
      return {
        ...base,
        status: "info",
        points: null,
        explanation:
          "No leg's vault coverage could be computed (vault or supply reads failed, or no leg has any obligation yet), so group solvency is unknown. All decoded legs use the devnet mUSDC mint.",
        evidence,
      };
    }
    const worst = covered.reduce((a, b) =>
      (a.coverage as number) < (b.coverage as number) ? a : b,
    );
    const summary = covered
      .map((l) => `"${l.name ?? shortenAddress(l.address)}" ${(l.coverage as number).toFixed(2)}×`)
      .join(", ");
    if ((worst.coverage as number) < 1) {
      return {
        ...base,
        status: "fail",
        points: 0,
        explanation:
          `CRITICAL: leg "${worst.name ?? worst.address}" is insolvent — its vault covers only ${((worst.coverage as number) * 100).toFixed(1)}% of its guard-formula obligation (${formatUsdc(Number(worst.vaultBalanceRaw ?? 0n))} mUSDC in the vault). ` +
          "Coverage below 1× is unreachable through normal swaps, so this indicates an invariant break. Per-leg coverage: " +
          summary +
          ".",
        evidence,
      };
    }
    return {
      ...base,
      status: "pass",
      points: 90,
      explanation:
        `Every priced leg's vault covers its guard-formula obligation (vault vs outstanding tokens + rescaled reserves + unclaimed surplus). Weakest leg: "${worst.name ?? worst.address}" at ${(worst.coverage as number).toFixed(2)}×. Per-leg coverage: ${summary}. All decoded legs are collateralized by the devnet mUSDC mint.` +
        (covered.length < legs.length
          ? ` ${legs.length - covered.length} leg(s) could not be priced and were excluded.`
          : ""),
      evidence,
    };
  }

  // --- Single market --------------------------------------------------------
  const evidence = [...base.evidence];
  if (snap.vaultAccount) {
    evidence.push({
      label: "Vault token account on Solscan (devnet)",
      url: explorerAccountUrl(snap.vaultAccount),
    });
  }
  if (snap.yesMint) {
    evidence.push({
      label: "YES token mint on Solscan (devnet)",
      url: explorerAccountUrl(snap.yesMint),
    });
  }
  if (snap.noMint) {
    evidence.push({
      label: "NO token mint on Solscan (devnet)",
      url: explorerAccountUrl(snap.noMint),
    });
  }

  if (snap.collateralMint !== null && snap.collateralMint !== DEVNET_MUSDC_MINT) {
    return {
      ...base,
      status: "fail",
      points: 0,
      explanation:
        `CRITICAL: this market is collateralized by ${shortenAddress(snap.collateralMint)}, not the devnet mUSDC mint (${shortenAddress(DEVNET_MUSDC_MINT)}). ` +
        "The program accepts any SPL mint as collateral, so the vault may hold a worthless or self-minted token even if the coverage ratio looks fine. Do not trade this market.",
      evidence,
    };
  }

  if (snap.coverage === null) {
    const funded = snap.lZeroBits !== null && snap.lZeroBits !== 0n;
    if (!funded && snap.obligationRaw !== null && snap.obligationRaw <= 0) {
      return {
        ...base,
        status: "info",
        points: null,
        explanation:
          `This market has never been funded (L₀ = 0): the vault holds ${formatUsdc(Number(snap.vaultBalanceRaw ?? 0n))} mUSDC and there is no outstanding obligation, so a coverage ratio is meaningless. Nothing is at stake yet — and there is no liquidity to trade against. Collateral mint is the devnet mUSDC mint.`,
        evidence,
      };
    }
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        `Vault coverage could not be computed — a vault, supply, or reserve read failed${snap.rpcError ? ` (${snap.rpcError})` : ""}. The desk will not guess at solvency; try again in a moment.`,
      evidence,
    };
  }

  const decimals = snap.collateralDecimals ?? 6;
  const vault = formatUsdc(Number(snap.vaultBalanceRaw ?? 0n), decimals);
  const obligation = formatUsdc(snap.obligationRaw as number, decimals);
  const basis = snap.resolved
    ? "post-resolution basis (winning supply + winning excess only — trading is over)"
    : "the program's guard formula (outstanding tokens + rescaled reserves + unclaimed LP surplus)";
  const split =
    snap.resolved || snap.outstandingYesRaw === null || snap.outstandingNoRaw === null
      ? ""
      : ` Outstanding supply: ${formatUsdc(Number(snap.outstandingYesRaw), decimals)} YES / ${formatUsdc(Number(snap.outstandingNoRaw), decimals)} NO; rescaled reserves: ${formatUsdc(snap.xNow ?? 0, decimals)} / ${formatUsdc(snap.yNow ?? 0, decimals)}.`;

  if (snap.coverage < 1) {
    return {
      ...base,
      status: "fail",
      points: 0,
      explanation:
        `CRITICAL: this market is insolvent — the vault holds ${vault} mUSDC against an obligation of ${obligation} mUSDC (${basis}), a coverage ratio of ${snap.coverage.toFixed(2)}×. ` +
        "Coverage below 1× is unreachable through normal swaps, so this indicates an invariant break: winning tokens may not be fully redeemable." +
        split,
      evidence,
    };
  }
  return {
    ...base,
    status: "pass",
    points: 90,
    explanation:
      `The vault holds ${vault} mUSDC against an obligation of ${obligation} mUSDC (${basis}), a coverage ratio of ${snap.coverage.toFixed(2)}×. ` +
      "Winning tokens are fully backed at 1 winning token = 1 mUSDC, and the collateral mint is the devnet mUSDC mint." +
      split,
    evidence,
  };
}
