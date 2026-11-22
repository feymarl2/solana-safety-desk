// Resolution-authority check — IMPLEMENTED (PARTIAL verdict, RESEARCH §4).
// Who decides the winning outcome? The pm-AMM's own documented #1 gap.
//
// What is VERIFIED from public data:
//   - The authority address (market.authority / group.authority) and the
//     resolved state. resolve_market enforces exactly authority == signer.
//   - NO oracle / NO timelock / NO dispute process: a CODE FACT, not a
//     guess — the 34-instruction IDL contains no oracle-adapter, dispute,
//     timelock, or challenge instruction, and the program source has no
//     such logic. Stated plainly in every explanation below.
// What is HEURISTIC ONLY (never presented as verified fact):
//   - Single-key vs multisig: the authority is one bare pubkey. The only
//     signals are on-curve shape (plain-keypair shape vs PDA shape) and
//     the authority account's owner. "No on-chain evidence of multisig"
//     is the honest default wording.
// What is NOT possible (disclosed, not scored):
//   - Authority track record (fair resolutions before) needs tx history.
// Scoring: AWOL (expired + unresolved ≥ 7 days) → fail 5. Single-key
// on-curve shape → warn 35. Off-curve PDA shape → warn 55 (suggestive,
// not proof). Unclassifiable → warn 45. Already resolved → warn 60.

import {
  explorerAccountUrl,
  PM_AMM_PROGRAM_ID,
} from "../../constants.js";
import { formatDuration, shortenAddress } from "../math.js";
import type { CheckContext, CheckResult } from "../types.js";

export const CHECK_ID = "resolution-authority" as const;
export const CHECK_TITLE = "Resolution authority";
export const CHECK_WEIGHT = 25;

/** Expired + unresolved for at least this long = authority AWOL (fail). */
const AWOL_SECONDS = 7 * 86400;

const NO_ORACLE_FACT =
  "The pm-AMM program has no oracle, no dispute window, and no timelock — " +
  "verified in the program source (none of its 34 instructions implements " +
  "oracle, dispute, or timelock logic) and disclosed in its own docs. " +
  "The resolution authority's decision is final.";

export async function checkResolutionAuthority(
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
        "The market snapshot could not be gathered, so the resolution authority could not be identified. " +
        NO_ORACLE_FACT,
      implemented: false,
    };
  }
  if (snap.exists === false) {
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        "No account exists at this address on devnet, so there is no resolution authority to check. " +
        "Check the address and try again.",
    };
  }
  if (snap.exists === null || snap.kind === "unknown") {
    return {
      ...base,
      status: "info",
      points: null,
      explanation:
        snap.kind === "unknown"
          ? `This account exists on devnet but is not a pm-AMM market or group account (owner ${shortenAddress(snap.ownerProgramId ?? "unknown")}, ${snap.accountSize ?? "?"} bytes), so it has no resolution authority. Paste a market or group account address.`
          : `The market account could not be read from devnet${snap.rpcError ? ` (${snap.rpcError})` : ""}, so the resolution authority is unknown. ${NO_ORACLE_FACT}`,
    };
  }

  const authority = snap.creator as string;
  const isGroup = snap.kind === "group";
  const resolved = snap.resolved === true;
  const now = snap.observedAt;
  const expiredSeconds =
    snap.endTs !== null && !resolved ? now - snap.endTs : null;
  const evidence = [
    ...base.evidence,
    {
      label: "Resolution authority account on Solscan (devnet)",
      url: explorerAccountUrl(authority),
    },
    {
      label: "pm-AMM docs — limitations (§7)",
      url: "https://predict-pm-amm.dev/",
    },
  ];

  // Authority-AWOL: expired long ago, still unresolved, no deadline exists.
  if (!resolved && expiredSeconds !== null && expiredSeconds >= AWOL_SECONDS) {
    return {
      ...base,
      status: "fail",
      points: 5,
      explanation:
        `This market expired ${formatDuration(expiredSeconds)} ago and is still unresolved. ` +
        `Only ${shortenAddress(authority)} can resolve it, and there is no on-chain deadline forcing resolution — winnings stay locked until that address acts, if it ever does. ` +
        NO_ORACLE_FACT +
        " The only fallback in the system (permissionless voiding after a grace period) exists solely for bet-vault markets, and this market shows no evidence of being one.",
      evidence,
    };
  }

  // Authority shape classification (heuristic — worded as such).
  let shapeNote: string;
  let points: number;
  if (snap.authorityOwner === PM_AMM_PROGRAM_ID) {
    shapeNote =
      "The authority address is owned by the pm-AMM program itself, which suggests this market was launched by a vault program account rather than a personal key. ";
    points = 55;
  } else if (snap.authorityOnCurve === true) {
    shapeNote =
      "The authority is a single on-curve address — the shape of a plain keypair — with no on-chain evidence of multisig or DAO control. ";
    points = 35;
  } else if (snap.authorityOnCurve === false) {
    shapeNote =
      "The authority address is off-curve (program-derived address shape), which suggests program or multisig-vault control, but that is a heuristic only — nothing on-chain proves a multisig governs it. ";
    points = 55;
  } else {
    shapeNote =
      "The authority's key shape could not be classified, so multisig control cannot be confirmed or ruled out. ";
    points = 45;
  }

  const cascadeNote = isGroup
    ? "This is a group: the group authority picks the winning leg, and each leg then resolves by cascade — attached legs cannot resolve directly. "
    : snap.groupAddress
      ? "This market is attached to a group, so it resolves by cascade from the group authority, not directly. "
      : "";

  if (resolved) {
    const outcome =
      isGroup && snap.groupWinningLeg !== null && snap.groupWinningLeg !== 0xff
        ? `leg ${snap.groupWinningLeg}`
        : snap.winningSide === 1
          ? "YES"
          : snap.winningSide === 2
            ? "NO"
            : "an outcome";
    return {
      ...base,
      status: "warn",
      points: 60,
      explanation:
        `This market is already resolved (${outcome} won), decided by ${shortenAddress(authority)}. ` +
        shapeNote +
        cascadeNote +
        NO_ORACLE_FACT +
        " There was no dispute path for traders who disagreed with the outcome.",
      evidence,
    };
  }

  const expiryNote =
    expiredSeconds !== null && expiredSeconds > 0
      ? `It expired ${formatDuration(expiredSeconds)} ago and is awaiting resolution — winnings are locked until the authority acts. `
      : snap.endTs !== null
        ? `Resolution is only possible after expiry, in ${formatDuration(snap.endTs - now)}. `
        : "";

  return {
    ...base,
    status: "warn",
    points,
    explanation:
      `One address controls resolution: ${shortenAddress(authority)}. ` +
      shapeNote +
      cascadeNote +
      expiryNote +
      NO_ORACLE_FACT +
      " This check cannot judge whether the authority resolved fairly in the past — that needs transaction history, which the desk does not read.",
    evidence,
  };
}
