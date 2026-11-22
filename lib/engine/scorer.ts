// Safety Desk — pure scorer: check results → 0–100 score + verdict band +
// one-paragraph explanation. 100% offline and deterministic, following
// MintGuard's scoring.ts pattern (deductions + hard-block cap), adapted:
//
// - Only IMPLEMENTED checks aggregate. A stub (points: null) contributes
//   nothing — it can neither raise nor lower the score.
// - No implemented checks at all → score null, band UNRATED. The desk says
//   plainly that it cannot judge yet instead of inventing a number.
// - Hard fail: a failing check marked hard-fail-capable (resolution and
//   upgrade authority) caps the score at 19 and forces AVOID — the same
//   cap MintGuard uses for BLOCK verdicts.
// - Bands: >= 80 LOOKS SOUND, 50–79 TRADE WITH CAUTION, < 50 AVOID.

import type { CheckId, CheckResult, VerdictBand } from "./types.js";

export const HARD_FAIL_SCORE_CAP = 19;
export const SOUND_THRESHOLD = 80;
export const CAUTION_THRESHOLD = 50;

/** Checks whose failure alone caps the score and forces AVOID. */
const HARD_FAIL_CHECKS: ReadonlySet<CheckId> = new Set([
  "resolution-authority",
  "upgrade-authority",
]);

export interface ScoredOutput {
  score: number | null;
  band: VerdictBand;
  explanation: string;
}

export function scoreChecks(checks: CheckResult[]): ScoredOutput {
  const implemented = checks.filter(
    (c) => c.implemented && c.points !== null,
  );

  if (implemented.length === 0) {
    return {
      score: null,
      band: "UNRATED",
      explanation:
        "This address could not be scored: no check produced a score — " +
        "the address may not be a pm-AMM market, the devnet reads may " +
        "have failed, or every check was informational. Read the " +
        "per-check explanations below, verify the address on the " +
        "explorer, and try again.",
    };
  }

  const totalWeight = implemented.reduce((sum, c) => sum + c.weight, 0);
  let score = Math.round(
    implemented.reduce((sum, c) => sum + (c.points as number) * c.weight, 0) /
      totalWeight,
  );
  score = Math.max(0, Math.min(100, score));

  const hardFail = implemented.some(
    (c) => c.status === "fail" && HARD_FAIL_CHECKS.has(c.id),
  );
  if (hardFail) {
    score = Math.min(score, HARD_FAIL_SCORE_CAP);
  }

  let band: VerdictBand;
  if (hardFail || score < CAUTION_THRESHOLD) {
    band = "AVOID";
  } else if (score >= SOUND_THRESHOLD) {
    band = "LOOKS SOUND";
  } else {
    band = "TRADE WITH CAUTION";
  }

  const fails = implemented.filter((c) => c.status === "fail");
  const warns = implemented.filter((c) => c.status === "warn");
  const pending = checks.filter((c) => !c.implemented);

  let explanation: string;
  if (band === "AVOID") {
    explanation =
      `This market scores ${score}/100 — avoid it. ` +
      fails.map((c) => c.explanation).join(" ");
  } else if (band === "TRADE WITH CAUTION") {
    explanation =
      `This market scores ${score}/100 — trade only with caution. ` +
      [...fails, ...warns].map((c) => c.explanation).join(" ");
  } else {
    explanation =
      `This market scores ${score}/100 and looks sound on the checks run. ` +
      (warns.length > 0
        ? warns.map((c) => c.explanation).join(" ")
        : "No warning signs were found.") +
      " A good score is not a guarantee — markets can still resolve " +
      "against you.";
  }
  if (pending.length > 0) {
    explanation +=
      ` ${pending.length} check${pending.length === 1 ? " is" : "s are"} ` +
      "still being built and did not affect this score.";
  }

  return { score, band, explanation };
}
