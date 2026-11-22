// LP-risk check — IMPLEMENTED, model/ex-ante only (PARTIAL, RESEARCH §4).
// What does providing liquidity actually cost here? Implementable from
// public state: the √(T − t) decay schedule, pool value, EXPECTED (model)
// daily LVR, the paper's expected terminal wealth (deposited / 2), the
// fee split, and LP concentration. NOT possible: realized LVR / realized
// LP returns — no price/volume history exists in the SDK and devnet has
// no pm-AMM indexer. This check NEVER invents an LVR number: every LVR
// figure is labeled "expected (model)". LPs do NOT receive the 2% fee
// split (50% protocol DAO / 50% market creator) — stated in every live
// explanation. Per-position P&L needs a wallet address, which the desk
// never asks for.
// Scoring: live + funded → warn 50 (the bleed is inherent to the disclosed
// model, not a defect — so warn, never fail). Unfunded / expired /
// resolved → info, no points (no live LP exposure to judge).

import { explorerAccountUrl, SWAP_FEE_BPS } from "../../constants.js";
import {
  expectedDailyLvr,
  expectedTerminalWealth,
  formatDuration,
  formatPct,
  formatUsdc,
  shortenAddress,
} from "../math.js";
import type { CheckContext, CheckResult } from "../types.js";

export const CHECK_ID = "lp-risk" as const;
export const CHECK_TITLE = "LP risk";
export const CHECK_WEIGHT = 10;

const FEE_NOTE =
  "The 2% swap fee (USDC leg only) is split 50/50 between the protocol " +
  "DAO and the market creator — liquidity providers receive none of it, " +
  "so LP economics are curve spread plus released residuals only.";

export async function checkLpRisk(ctx: CheckContext): Promise<CheckResult> {
  const base = {
    id: CHECK_ID,
    title: CHECK_TITLE,
    weight: CHECK_WEIGHT,
    evidence: [
      {
        label: "Market account on Solscan (devnet)",
        url: explorerAccountUrl(ctx.marketAddress),
      },
      {
        label: "pm-AMM paper (Paradigm, 2024)",
        url: "https://www.paradigm.xyz/writing/pm-amm",
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
        "The market snapshot could not be gathered, so LP risk could not be estimated.",
      implemented: false,
    };
  }
  if (snap.exists === false) {
    return {
      ...base,
      status: "info",
      points: null,
      explanation: "No account exists at this address on devnet, so there is no liquidity pool to judge.",
    };
  }
  if (snap.exists === null || snap.kind === "unknown") {
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        snap.kind === "unknown"
          ? "This account is not a pm-AMM market or group account, so it has no LP pool."
          : `The market account could not be read from devnet${snap.rpcError ? ` (${snap.rpcError})` : ""}, so LP risk is unknown.`,
    };
  }

  const resolved = snap.resolved === true;
  const expired = snap.endTs !== null && snap.observedAt >= snap.endTs;
  if (resolved || expired) {
    return {
      ...base,
      status: "info",
      points: null,
      explanation: resolved
        ? "This market is resolved, so the LP window is over — no live liquidity-provider exposure remains to judge. LPs claim or withdraw under the post-resolution rules."
        : "This market has expired, so the LP window is over — no live liquidity-provider exposure remains to judge. LPs claim or withdraw once the authority resolves it.",
    };
  }

  // --- Group input: aggregate across priced legs ---------------------------
  if (snap.kind === "group") {
    const legs = snap.legs ?? [];
    const priced = legs.filter((l) => l.price !== null);
    if (snap.poolValueRaw === null || priced.length === 0) {
      return {
        ...base,
        status: "info",
        points: null,
        explanation:
          "No leg of this group has measurable pool value (unfunded or unreadable legs), so LP risk cannot be estimated. " + FEE_NOTE,
      };
    }
    const remaining = snap.endTs !== null ? snap.endTs - snap.observedAt : 0;
    return {
      ...base,
      status: "warn",
      points: 50,
      explanation:
        `Across the ${priced.length} priced leg(s), aggregate pool value is ${formatUsdc(snap.poolValueRaw)} mUSDC with ${formatDuration(remaining)} to expiry. ` +
        "Each leg's liquidity decays as √(T − t) toward expiry, and under the paper's model LPs end with half their deposited wealth in expectation (expected terminal wealth = deposited / 2) before any fee income — and there is no fee income for LPs. " +
        FEE_NOTE +
        " Realized arbitrage losses cannot be computed: no trade history exists for this market. Figures here are model expectations, not predictions. Paste a single leg address for per-leg decay detail.",
    };
  }

  // --- Single market --------------------------------------------------------
  const funded = snap.lZeroBits !== null && snap.lZeroBits !== 0n;
  if (!funded || snap.currentPrice === null || snap.poolValueRaw === null || snap.lEffNow === null) {
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        "This market has no funded liquidity pool (L₀ = 0 or no measurable price), so there is no LP position to judge yet. The first LP deposit seeds the pool. " + FEE_NOTE,
    };
  }
  const remaining = (snap.endTs as number) - snap.observedAt;
  const decayPct =
    snap.lEffAtStart !== null && snap.lEffAtStart > 0
      ? (snap.lEffNow / snap.lEffAtStart) * 100
      : null;
  const dailyLvr = expectedDailyLvr(snap.currentPrice, snap.lEffNow, remaining);
  const concentrationNote =
    snap.lpPositionCount !== null
      ? snap.lpPositionCount === 0
        ? " No LP positions were found for this market."
        : ` ${snap.lpPositionCount} LP position(s) found${snap.lpTopShare !== null ? `; the largest LP holds ${formatPct(snap.lpTopShare)} of all shares` : ""}.`
      : " LP concentration could not be measured (position enumeration failed).";
  const creatorNote = snap.creator
    ? ` The 50% creator fee share goes to ${shortenAddress(snap.creator)}.`
    : "";

  return {
    ...base,
    status: "warn",
    points: 50,
    explanation:
      `Pool value is ${formatUsdc(snap.poolValueRaw)} mUSDC at a YES price of ${formatPct(snap.currentPrice)}, with ${formatDuration(remaining)} to expiry. ` +
      `Liquidity decays as √(T − t): effective liquidity is now ${decayPct !== null ? `${decayPct.toFixed(0)}% of its at-seed level` : "below its at-seed level"} and falls to zero at expiry. ` +
      `Expected (model) arbitrage loss is ${formatUsdc(dailyLvr)} mUSDC per day at the current price and pool size — a property of the curve under the paper's Gaussian-score model, NOT a realized or predicted loss for this market; realized LVR cannot be computed without trade history. ` +
      `Under the same model, expected terminal wealth is half the deposit (${formatUsdc(expectedTerminalWealth(1000000))} expected back per ${formatUsdc(1000000)} deposited, before residuals). ` +
      FEE_NOTE +
      creatorNote +
      concentrationNote +
      ` Swap fee is ${SWAP_FEE_BPS / 100}% on the USDC leg only; YES↔NO swaps are free.`,
  };
}
