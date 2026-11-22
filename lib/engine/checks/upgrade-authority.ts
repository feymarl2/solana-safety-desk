// Upgrade-authority check — IMPLEMENTED for current state (PARTIAL for
// history, RESEARCH §4). Can one key rewrite the program's logic?
//
// Current state is EXACT: the BPF upgradeable loader stores the authority
// in the ProgramData account (u32 enum 3 + u64 slot + Option + pubkey).
// Live-verified 15 Nov 2026: authority ETGKSFc7…R6Y, on-curve single
// keypair, last deploy slot 511269300 (15 Oct 2026).
// History is PARTIAL: recent ProgramData transactions are counted with an
// explicit "history may be incomplete" note — a signature touching
// ProgramData is not proof of an upgrade, and RPC history is bounded.
// Scoring: immutable → pass 95. Single-key on-curve → fail 10
// (hard-fail-capable: caps the score at 19, forces AVOID — the scaffold's
// rule for this check). Off-curve PDA shape → warn 50. Unclassifiable →
// warn 45. Unreadable → info, no points.

import {
  explorerAccountUrl,
  explorerProgramUrl,
  PM_AMM_PROGRAM_ID,
} from "../../constants.js";
import { formatDuration, shortenAddress } from "../math.js";
import type { CheckContext, CheckResult } from "../types.js";

export const CHECK_ID = "upgrade-authority" as const;
export const CHECK_TITLE = "Upgrade authority";
export const CHECK_WEIGHT = 20;

/** A deploy within this window is flagged as fresh, unaudited code. */
const RECENT_UPGRADE_SECONDS = 30 * 86400;

const NO_AUDIT_NOTE =
  "The program has no third-party audit — its own docs describe it as a " +
  "trust-based proof of concept.";

export async function checkUpgradeAuthority(
  ctx: CheckContext,
): Promise<CheckResult> {
  const base = {
    id: CHECK_ID,
    title: CHECK_TITLE,
    weight: CHECK_WEIGHT,
    evidence: [
      {
        label: "pm-AMM program on Solscan (devnet)",
        url: explorerProgramUrl(PM_AMM_PROGRAM_ID),
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
        "The market snapshot could not be gathered, so the program upgrade authority could not be read.",
      implemented: false,
    };
  }

  // Program-level fact, but a verdict about a non-market must not be
  // scored: when the pasted address is not a pm-AMM market/group (or
  // could not be read at all), stay informational so the verdict is
  // UNRATED instead of a misleading AVOID for an address never judged.
  if (snap.kind === "unknown" || snap.exists === false) {
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        "The upgrade-authority verdict applies to the pm-AMM program, not to this address — and this address is not a pm-AMM market or group account, so no market verdict is scored.",
    };
  }

  const evidence = [...base.evidence];
  if (snap.programDataAddress) {
    evidence.push({
      label: "ProgramData account on Solscan (devnet)",
      url: explorerAccountUrl(snap.programDataAddress),
    });
  }
  if (snap.upgradeAuthority) {
    evidence.push({
      label: "Upgrade authority account on Solscan (devnet)",
      url: explorerAccountUrl(snap.upgradeAuthority),
    });
  }

  if (snap.programImmutable === true) {
    return {
      ...base,
      status: "pass",
      points: 95,
      explanation:
        "The pm-AMM program is immutable: its ProgramData account has no upgrade authority, so no one can rewrite the program logic. " +
        NO_AUDIT_NOTE,
      evidence,
    };
  }

  if (!snap.upgradeAuthority) {
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        `The program's upgrade authority could not be read from devnet${snap.rpcError ? ` (${snap.rpcError})` : ""}, so it is unknown whether one key can rewrite the program. ${NO_AUDIT_NOTE}`,
      evidence,
    };
  }

  const deployNote =
    snap.lastUpgradeSlot !== null
      ? ` Last deployed at slot ${snap.lastUpgradeSlot.toLocaleString("en-US")}` +
        (snap.lastUpgradeTime !== null
          ? ` (${new Date(snap.lastUpgradeTime * 1000).toISOString().slice(0, 10)})`
          : "") +
        "."
      : "";
  const recentNote =
    snap.lastUpgradeTime !== null &&
    snap.observedAt - snap.lastUpgradeTime < RECENT_UPGRADE_SECONDS
      ? ` That deploy was ${formatDuration(snap.observedAt - snap.lastUpgradeTime)} ago — fresh, unaudited code.`
      : "";
  const historyNote =
    snap.programDataTxCount !== null
      ? ` ${snap.programDataTxCount} recent ProgramData transactions were observed (bounded RPC history — this may be incomplete and is not a full upgrade history; confirming an upgrade needs transaction parsing).`
      : "";

  if (snap.upgradeAuthorityOnCurve === true) {
    return {
      ...base,
      status: "fail",
      points: 10,
      explanation:
        `One key can upgrade the program: ${shortenAddress(snap.upgradeAuthority)}. ` +
        "The upgrade authority read from the ProgramData account is a single on-curve address — the shape of a plain keypair — with no on-chain evidence of multisig control. " +
        "That key could replace the program logic, including resolution and vault rules, at any time." +
        deployNote +
        recentNote +
        historyNote +
        " " +
        NO_AUDIT_NOTE,
      evidence,
    };
  }
  if (snap.upgradeAuthorityOnCurve === false) {
    return {
      ...base,
      status: "warn",
      points: 50,
      explanation:
        `The program upgrade authority is ${shortenAddress(snap.upgradeAuthority)}, an off-curve (program-derived) address, which suggests program or multisig-vault control — but that is a heuristic only, and nothing on-chain proves a multisig governs upgrades.` +
        deployNote +
        recentNote +
        historyNote +
        " " +
        NO_AUDIT_NOTE,
      evidence,
    };
  }
  return {
    ...base,
    status: "warn",
    points: 45,
    explanation:
      `The program can be upgraded by ${shortenAddress(snap.upgradeAuthority)}, and the authority's key shape could not be classified, so multisig control cannot be confirmed.` +
      deployNote +
      recentNote +
      historyNote +
      " " +
      NO_AUDIT_NOTE,
    evidence,
  };
}
