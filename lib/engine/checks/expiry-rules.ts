// Expiry & market-rules check — IMPLEMENTED + heuristic (RESEARCH §4).
// Timeline, settlement terms, seed-vs-current, and duration sanity are all
// on-chain facts. Question clarity is a HEURISTIC ONLY: the 64-byte `name`
// field is the ONLY market text on-chain — no description, rules,
// resolution source, or link exists anywhere (YES/NO token metadata
// carries an empty URI). The clarity test below is a deterministic
// checklist (length, printability, question/date/threshold/source
// signals), never presented as a verified rules check, and it can only
// warn — never fail a market on its own. The disclosure that no rules
// text exists on-chain appears in every explanation.
// Thresholds: expired-unresolved → base 40; < 1h left → 45; < 24h → 55;
// < 7d → 75; else 85. Duration < 1h or > 1y → −10 each. Clarity flags
// → −8 each (empty/garbled −12), capped at −24. Points ≥ 70 → pass,
// else warn. Resolved markets → pass 80 (outcome known, terms stated).

import { explorerAccountUrl } from "../../constants.js";
import {
  formatDuration,
  formatPct,
  sumProbabilities,
} from "../math.js";
import type { CheckContext, CheckResult } from "../types.js";

export const CHECK_ID = "expiry-rules" as const;
export const CHECK_TITLE = "Expiry & market rules";
export const CHECK_WEIGHT = 10;

const SETTLEMENT_TERMS =
  "Settlement terms (verified in the program code): 1 winning token = 1 " +
  "mUSDC with no fee, and 1 YES + 1 NO can always be redeemed together " +
  "for 1 mUSDC, before or after resolution.";

const NO_RULES_DISCLOSURE =
  "No resolution rules are recorded on-chain — the 64-byte market name " +
  "is the only market text that exists, so the resolution authority's " +
  "interpretation of the question is final.";

interface ClarityFlag {
  label: string;
  deduction: number;
}

/** Deterministic name-string checklist. Heuristic — see header. */
export function clarityFlags(name: string): ClarityFlag[] {
  const flags: ClarityFlag[] = [];
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    flags.push({ label: "the market name is empty", deduction: 12 });
    return flags;
  }
  // Non-printable / garbled bytes.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(name) || trimmed !== name.trim()) {
    flags.push({ label: "the market name contains garbled characters", deduction: 12 });
  }
  if (trimmed.length < 8) {
    flags.push({ label: "the market name is very short", deduction: 8 });
  }
  const lower = trimmed.toLowerCase();
  const hasQuestion = trimmed.includes("?");
  const hasNumber = /\d/.test(trimmed);
  const hasDate = /\d{4}-\d{2}-\d{2}|\d{1,2}\s?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(trimmed);
  const hasThreshold = /[<>$]|above|below|exceed|at least|at most|>=|<=/.test(lower);
  const hasSource =
    /(coingecko|pyth|chainlink|binance|coinbase|official|federal reserve|fomc|ecb|bloomberg|reuters)/.test(lower);
  if (!hasQuestion && !hasNumber && !hasDate && !hasThreshold && !hasSource) {
    flags.push({
      label: "the question has no question mark, number, date, threshold, or named source",
      deduction: 8,
    });
  }
  // Junk shape: one short token, no digits, no spaces (e.g. "kjkj").
  if (!/\s/.test(trimmed) && trimmed.length < 6 && !hasNumber) {
    flags.push({ label: "the market name looks like placeholder text", deduction: 8 });
  }
  return flags;
}

export async function checkExpiryRules(
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
        "The market snapshot could not be gathered, so expiry and settlement terms could not be read.",
      implemented: false,
    };
  }
  if (snap.exists === false) {
    return {
      ...base,
      status: "info",
      points: null,
      explanation: "No account exists at this address on devnet, so there is no expiry to check.",
    };
  }
  if (snap.exists === null || snap.kind === "unknown") {
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        snap.kind === "unknown"
          ? "This account is not a pm-AMM market or group account, so expiry and settlement terms do not apply."
          : `The market account could not be read from devnet${snap.rpcError ? ` (${snap.rpcError})` : ""}, so expiry is unknown.`,
    };
  }

  const isGroup = snap.kind === "group";
  const name = snap.name ?? "";
  const now = snap.observedAt;

  if (snap.resolved === true) {
    const outcome = isGroup
      ? snap.groupWinningLeg !== null && snap.groupWinningLeg !== 0xff
        ? `leg ${snap.groupWinningLeg} won`
        : "a winning leg was picked"
      : snap.winningSide === 1
        ? "YES won"
        : snap.winningSide === 2
          ? "NO won"
          : "an outcome was picked";
    return {
      ...base,
      status: "pass",
      points: 80,
      explanation:
        `This ${isGroup ? "group" : "market"} is resolved (${outcome}). ${SETTLEMENT_TERMS} ` +
        `Question: "${name}". ${NO_RULES_DISCLOSURE}`,
    };
  }

  if (snap.endTs === null) {
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        `Expiry could not be read for this ${isGroup ? "group" : "market"}. ${SETTLEMENT_TERMS} ${NO_RULES_DISCLOSURE}`,
    };
  }

  const secondsLeft = snap.endTs - now;
  const expired = secondsLeft <= 0;
  let points: number;
  let runwayNote: string;
  if (expired) {
    points = 40;
    runwayNote = `This ${isGroup ? "group" : "market"} expired ${formatDuration(-secondsLeft)} ago and is still unresolved — winnings stay locked until the authority resolves it. `;
  } else if (secondsLeft < 3600) {
    points = 45;
    runwayNote = `Only ${formatDuration(secondsLeft)} left to expiry — volatility and dynamic liquidity decay accelerate sharply near expiry. `;
  } else if (secondsLeft < 86400) {
    points = 55;
    runwayNote = `${formatDuration(secondsLeft)} left to expiry. `;
  } else if (secondsLeft < 7 * 86400) {
    points = 75;
    runwayNote = `${formatDuration(secondsLeft)} left to expiry. `;
  } else {
    points = 85;
    runwayNote = `${formatDuration(secondsLeft)} left to expiry. `;
  }

  // Duration sanity (on-chain bounds are 300s to ~50y).
  let durationNote = "";
  if (snap.startTs !== null) {
    const duration = snap.endTs - snap.startTs;
    if (duration < 3600) {
      points -= 10;
      durationNote = "The market's total duration is under an hour, leaving thin time for price discovery. ";
    } else if (duration > 365 * 86400) {
      points -= 10;
      durationNote = "The market runs for over a year, which stretches authority-disappearance risk. ";
    }
  }

  // Seed vs current.
  let moveNote: string;
  if (isGroup) {
    const prices = (snap.legProbabilities ?? []).filter(
      (p): p is number => p !== null,
    );
    if (prices.length > 0 && snap.groupTotalSeededBps !== null) {
      const sum = sumProbabilities(prices);
      moveNote = `Seeded total ${(snap.groupTotalSeededBps / 100).toFixed(2)}% vs current priced-leg sum ${formatPct(sum)} (see the coherence check). `;
    } else {
      moveNote = "";
    }
  } else if (snap.initialPriceBps !== null && snap.currentPrice !== null) {
    const seed = (snap.initialPriceBps === 0 ? 5000 : snap.initialPriceBps) / 10000;
    const movePp = (snap.currentPrice - seed) * 100;
    moveNote = `Seed YES price ${formatPct(seed)} vs current ${formatPct(snap.currentPrice)} (${movePp >= 0 ? "+" : ""}${movePp.toFixed(1)}pp). `;
  } else if (snap.initialPriceBps !== null) {
    const seed = (snap.initialPriceBps === 0 ? 5000 : snap.initialPriceBps) / 10000;
    moveNote = `Seed YES price ${formatPct(seed)}; no current price (unfunded or unreadable). `;
  } else {
    moveNote = "";
  }

  // Question-clarity heuristic (warn-only, capped deduction).
  const flags = clarityFlags(name);
  const deduction = Math.min(
    24,
    flags.reduce((sum, f) => sum + f.deduction, 0),
  );
  points -= deduction;
  points = Math.max(30, Math.min(100, points));
  const clarityNote =
    flags.length > 0
      ? `Question-clarity heuristic flags (name-string checklist only, not a verified rules check): ${flags.map((f) => f.label).join("; ")}. `
      : "The question passes the name-string clarity checklist (length, question/date/threshold/source signals). ";

  return {
    ...base,
    status: points >= 70 ? "pass" : "warn",
    points,
    explanation:
      runwayNote +
      durationNote +
      moveNote +
      `Question: "${name}". ` +
      clarityNote +
      SETTLEMENT_TERMS +
      " " +
      NO_RULES_DISCLOSURE,
  };
}
