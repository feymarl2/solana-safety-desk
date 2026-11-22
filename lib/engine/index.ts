// Safety Desk — check registry + orchestrator.
// Runs all six checks against one market and returns results in a stable
// order, regardless of completion order. One check throwing must never
// kill the verdict: a thrown error becomes an "info" result explaining
// the failure, mirroring the Telegraph desk's Promise.allSettled pattern.
//
// TODO (follow-up worker): build the MarketSnapshot (lib/engine/types.ts)
// once here — batched devnet reads via @pm-amm/sdk — and pass it in the
// CheckContext. Today the snapshot is null and every check is a stub.

import type { CheckContext, CheckFn, CheckResult } from "./types.js";
import { checkResolutionAuthority } from "./checks/resolution-authority.js";
import { checkUpgradeAuthority } from "./checks/upgrade-authority.js";
import { checkSolvency } from "./checks/solvency.js";
import { checkCoherence } from "./checks/coherence.js";
import { checkLpRisk } from "./checks/lp-risk.js";
import { checkExpiryRules } from "./checks/expiry-rules.js";

export const CHECKS: ReadonlyArray<{
  id: CheckResult["id"];
  title: string;
  weight: number;
  run: CheckFn;
}> = [
  {
    id: "resolution-authority",
    title: "Resolution authority",
    weight: 25,
    run: checkResolutionAuthority,
  },
  {
    id: "upgrade-authority",
    title: "Upgrade authority",
    weight: 20,
    run: checkUpgradeAuthority,
  },
  { id: "solvency", title: "Solvency", weight: 20, run: checkSolvency },
  {
    id: "coherence",
    title: "Multi-outcome coherence",
    weight: 15,
    run: checkCoherence,
  },
  { id: "lp-risk", title: "LP risk", weight: 10, run: checkLpRisk },
  {
    id: "expiry-rules",
    title: "Expiry & market rules",
    weight: 10,
    run: checkExpiryRules,
  },
];

export async function runChecks(
  ctx: CheckContext,
): Promise<CheckResult[]> {
  const settled = await Promise.allSettled(CHECKS.map((c) => c.run(ctx)));
  return settled.map((result, i) => {
    const meta = CHECKS[i] as (typeof CHECKS)[number];
    if (result.status === "fulfilled") return result.value;
    return {
      id: meta.id,
      title: meta.title,
      status: "info" as const,
      points: null,
      weight: meta.weight,
      explanation: `This check failed to run: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}. It did not affect the score.`,
      evidence: [],
      implemented: false,
    };
  });
}
