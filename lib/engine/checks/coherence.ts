// Coherence check — IMPLEMENTED (RESEARCH §4).
// Multi-outcome markets: do the implied probabilities sum to 1 right now?
// The program enforces Σ ≈ 1 only at seeding (attach caps total_seeded_bps)
// and at resolution; between trades, drift is real and unbounded — the
// live Σ is the whole point of this check. Each leg price uses RESCALED
// reserves (lib/engine/math.ts), never raw stored reserves.
// Edge cases: empty leg slots are skipped; unfunded legs (L₀ = 0) have no
// price and are excluded from Σ with a note; standalone binary markets
// return info (coherence does not apply — never a fake Σ = 1).
// Thresholds (documented): |Σ − 1| ≤ 2pp → pass 90; ≤ 10pp → warn 60;
// > 10pp → fail 25. A live devnet group was verified drifting at Σ = 1.43.

import { explorerAccountUrl } from "../../constants.js";
import { formatPct, groupDriftPct, sumProbabilities } from "../math.js";
import type { CheckContext, CheckResult } from "../types.js";

export const CHECK_ID = "coherence" as const;
export const CHECK_TITLE = "Multi-outcome coherence";
export const CHECK_WEIGHT = 15;

const PASS_DRIFT_PP = 2;
const WARN_DRIFT_PP = 10;

export async function checkCoherence(
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
        "The market snapshot could not be gathered, so group coherence could not be computed.",
      implemented: false,
    };
  }
  if (snap.exists === false) {
    return {
      ...base,
      status: "info",
      points: null,
      explanation: "No account exists at this address on devnet, so there is no group to check.",
    };
  }
  if (snap.exists === null || snap.kind === "unknown") {
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        snap.kind === "unknown"
          ? "This account is not a pm-AMM market or group account, so coherence does not apply."
          : `The market account could not be read from devnet${snap.rpcError ? ` (${snap.rpcError})` : ""}, so coherence is unknown.`,
    };
  }

  const legs = snap.legs ?? [];
  const isGroupContext = snap.kind === "group" || snap.groupAddress !== null;
  if (!isGroupContext || legs.length === 0) {
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        "This is a standalone binary market: it has one YES price and no sibling legs, so probability coherence (do the legs sum to 100%?) does not apply. No fake sum is shown.",
    };
  }

  const evidence = [
    ...base.evidence,
    ...legs.map((l, i) => ({
      label: `Leg ${i + 1} (${l.name ?? "unnamed"}) on Solscan (devnet)`,
      url: explorerAccountUrl(l.address),
    })),
  ];
  const priced = legs.filter((l) => l.price !== null);
  const unpriced = legs.filter((l) => l.price === null);
  if (priced.length === 0) {
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        `This group has ${legs.length} attached leg(s), but none has a price (unfunded legs have L₀ = 0, so no price exists), so the probability sum cannot be computed. Seeded total at attach time: ${snap.groupTotalSeededBps !== null ? `${(snap.groupTotalSeededBps / 100).toFixed(2)}%` : "unknown"}.`,
      evidence,
    };
  }

  const prices = priced.map((l) => l.price as number);
  const sum = sumProbabilities(prices);
  const drift = groupDriftPct(prices);
  const legLine = priced
    .map((l) => `"${l.name ?? "?"}" ${formatPct(l.price as number)}`)
    .join(", ");
  const staleNote =
    snap.endTs !== null && snap.observedAt > snap.endTs
      ? " The group has expired, so these prices are stale (last accrual state) — drift after expiry does not reflect live trading."
      : "";
  const excludedNote =
    unpriced.length > 0
      ? ` ${unpriced.length} leg(s) had no price (unfunded or unreadable) and were excluded from the sum, so the true sum across all legs may differ.`
      : "";
  const seededNote =
    snap.groupTotalSeededBps !== null
      ? ` The group was seeded at ${(snap.groupTotalSeededBps / 100).toFixed(2)}% total.`
      : "";

  if (drift <= PASS_DRIFT_PP) {
    return {
      ...base,
      status: "pass",
      points: 90,
      explanation:
        `The ${priced.length} priced leg(s) sum to ${formatPct(sum)} (drift ${drift.toFixed(1)}pp from 100%): ${legLine}.${seededNote}${excludedNote}${staleNote} The group's implied probabilities are coherent right now.`,
      evidence,
    };
  }
  if (drift <= WARN_DRIFT_PP) {
    return {
      ...base,
      status: "warn",
      points: 60,
      explanation:
        `The ${priced.length} priced leg(s) sum to ${formatPct(sum)} — ${drift.toFixed(1)}pp away from 100%: ${legLine}.${seededNote} The program only enforces the sum at seeding and resolution, so this drift persists until arbitrage corrects it; at least one leg is mispriced relative to the others.${excludedNote}${staleNote}`,
      evidence,
    };
  }
  return {
    ...base,
    status: "fail",
    points: 25,
    explanation:
      `The ${priced.length} priced leg(s) sum to ${formatPct(sum)} — ${drift.toFixed(1)}pp away from 100%: ${legLine}.${seededNote} This is large drift: the legs' implied probabilities are mutually inconsistent, so at least one leg is badly mispriced and the group's prices cannot all be trusted.${excludedNote}${staleNote}`,
    evidence,
  };
}
