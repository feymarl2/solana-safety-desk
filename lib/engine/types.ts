// Safety Desk — verdict engine types.
// Pattern reused from MintGuard's vetting core (score → verdict → reasons
// → evidence), re-expressed for Solana pm-AMM markets. The engine is
// network-agnostic: checks receive a CheckContext and return CheckResults;
// the scorer is pure and offline. No EVM concepts live here.

import type { Connection, PublicKey } from "@solana/web3.js";

export type CheckStatus = "pass" | "warn" | "fail" | "info";

export type CheckId =
  | "resolution-authority"
  | "upgrade-authority"
  | "solvency"
  | "coherence"
  | "lp-risk"
  | "expiry-rules";

/** Verdict bands shown to the user. UNRATED = nothing could be scored. */
export type VerdictBand =
  | "LOOKS SOUND"
  | "TRADE WITH CAUTION"
  | "AVOID"
  | "UNRATED";

export interface CheckEvidence {
  /** Human label, e.g. "Market account on Solscan (devnet)". */
  label: string;
  /** Absolute URL. Devnet explorer links only. */
  url: string;
}

export interface CheckResult {
  id: CheckId;
  title: string;
  status: CheckStatus;
  /**
   * 0–100 contribution to the aggregate score. NULL when the check is
   * informational (not applicable, or its inputs were unreadable) — an
   * info check must never contribute a fake number.
   */
  points: number | null;
  /** Weight in the aggregate score. Weights sum to 100 across all checks. */
  weight: number;
  /** Plain-English explanation of what was found (or why nothing was). */
  explanation: string;
  evidence: CheckEvidence[];
  /** False for stubs. The scorer only aggregates implemented checks. */
  implemented: boolean;
}

/** One leg of a multi-outcome group, decoded + priced. */
export interface LegSnapshot {
  address: string;
  name: string | null;
  /** True when the leg account exists and decoded as a Market. */
  decoded: boolean;
  /** False when l_zero == 0: no price exists for this leg. */
  funded: boolean;
  /** Current implied YES probability (rescaled reserves), null if unpriced. */
  price: number | null;
  endTs: number | null;
  resolved: boolean | null;
  winningSide: number | null;
  initialPriceBps: number | null;
  /** Collateral mint of this leg (ANY SPL mint is accepted on-chain). */
  collateralMint: string | null;
  /** Vault balance in raw units (leg solvency), null when unread. */
  vaultBalanceRaw: bigint | null;
  /** Guard-formula obligation in raw units, null when uncomputable. */
  obligationRaw: number | null;
  /** Vault / obligation, null when uncomputable. */
  coverage: number | null;
}

/** What kind of account the pasted address turned out to be. */
export type SnapshotKind = "market" | "group" | "unknown";

/**
 * Everything a check needs, gathered once per market by
 * lib/engine/snapshot.ts in batched devnet reads (public devnet RPC is
 * rate-limited — see hackathon.md §6 gotchas).
 *
 * Every field is nullable: a check that cannot read its input must return
 * status "info" explaining what is missing, never a guessed pass/fail.
 * Fields added for the Phase 1 implementation are marked [P1]; the
 * scaffold's original fields are all still filled.
 */
export interface MarketSnapshot {
  /** The address as pasted by the user. */
  marketAddress: string;
  /** Does the account exist on devnet? Null when unread. */
  exists: boolean | null;
  /** Account owner program ID. Expected: the pm-AMM program ID. */
  ownerProgramId: string | null;
  /** Raw account size in bytes. Current market layout: 443; group: 1188. */
  accountSize: number | null;
  /** [P1] Decoded account kind. "unknown" = not a Market/GroupMarket. */
  kind: SnapshotKind;
  /** [P1] Human-readable RPC failure note when reads degraded, else null. */
  rpcError: string | null;

  // --- Decoded market account (manual Borsh decode, lib/engine/decode.ts) -
  /** Market question / name, 1–64 bytes. For groups: the group name. */
  name: string | null;
  /** Market creator = resolution authority (hackathon.md §6: "whoever
   *  creates a market is its authority"). For groups: group authority. */
  creator: string | null;
  /** Expiry unix timestamp (endTs). */
  endTs: number | null;
  /** Resolved yet? winningSide: 0 unresolved, 1 YES, 2 NO. */
  winningSide: number | null;
  /** Seed price in bps (initialPriceBps, 100..9900). */
  initialPriceBps: number | null;
  /** YES / NO reserves as last stored (stale since lastAccrualTs), I80F48 bits. */
  yesReserve: bigint | null;
  noReserve: bigint | null;
  /** Unix timestamp of the last liquidity accrual. */
  lastAccrualTs: number | null;
  /** Static vs dynamic pm-AMM. The pm-AMM is always dynamic: liquidity
   *  decays as √(T − t) toward expiry. True once a market is decoded. */
  isDynamic: boolean | null;
  /** Vault mUSDC token account address. */
  vaultAccount: string | null;
  /** Vault mUSDC balance, raw 6-dp units. */
  vaultBalanceRaw: bigint | null;
  /** Outstanding YES / NO token supplies (raw units). */
  outstandingYesRaw: bigint | null;
  outstandingNoRaw: bigint | null;
  /** YES / NO outcome token mint addresses. */
  yesMint: string | null;
  noMint: string | null;
  /** Multi-outcome group id, or null for standalone binary markets. */
  groupId: string | null;
  /** Sibling leg market PDAs for multi-outcome groups (2–32 legs). */
  legMarketAddresses: string[] | null;
  /** Current implied YES probability per leg (0–1), same order as legs;
   *  null per leg when that leg is unpriced (unfunded/missing). */
  legProbabilities: (number | null)[] | null;

  // --- [P1] Decoded market extras ----------------------------------------
  /** Market start timestamp. */
  startTs: number | null;
  /** Collateral mint of the market (ANY SPL mint is accepted on-chain). */
  collateralMint: string | null;
  /** Decimals of the collateral mint, null when unread. */
  collateralDecimals: number | null;
  /** L_0, I80F48 bits. 0 = unfunded shell, no price exists. */
  lZeroBits: bigint | null;
  /** Per-share dC_t accumulators, I80F48 bits. */
  cumYesPerShare: bigint | null;
  cumNoPerShare: bigint | null;
  /** LP share supply, I80F48 bits. */
  totalLpShares: bigint | null;
  /** Unminted LP surplus counted in the solvency guard. */
  unclaimedExcessYes: bigint | null;
  unclaimedExcessNo: bigint | null;
  /** Resolved flag (distinct from winningSide for groups). */
  resolved: boolean | null;
  /** GroupMarket PDA this market is attached to, or null if standalone. */
  groupAddress: string | null;

  // --- [P1] Priced state (rescaled reserves — see lib/engine/math.ts) ----
  /** Current YES price (rescaled), null when unpriced. */
  currentPrice: number | null;
  /** Effective liquidity now, raw units. */
  lEffNow: number | null;
  /** Effective liquidity at market start, raw units. */
  lEffAtStart: number | null;
  /** Rescaled reserves now, raw units. */
  xNow: number | null;
  yNow: number | null;
  /** Pool value V(P) now, raw units. */
  poolValueRaw: number | null;
  /** Guard-formula solvency obligation, raw units. */
  obligationRaw: number | null;
  /** Vault / obligation coverage ratio. */
  coverage: number | null;

  // --- [P1] Resolution-authority signals (heuristic — see check 1) -------
  /** True when the authority pubkey is on the ed25519 curve (plain key
   *  shape); false = off-curve PDA shape. Null when undecidable. */
  authorityOnCurve: boolean | null;
  /** Owner program of the authority account, null when account missing. */
  authorityOwner: string | null;
  /** True when the authority account exists on-chain. */
  authorityExists: boolean | null;

  // --- [P1] Group detail --------------------------------------------------
  /** Per-leg snapshots for groups (and for group-attached markets). */
  legs: LegSnapshot[] | null;
  /** Σ seeded bps recorded on the group at attach time. */
  groupTotalSeededBps: number | null;
  /** Winning leg index (0xFF = unresolved). */
  groupWinningLeg: number | null;
  /** Number of attached (non-empty) leg slots. */
  groupAttachedLegs: number | null;

  // --- [P1] LP concentration (best-effort, null when unreadable) ---------
  /** Number of LpPosition accounts found for the primary market. */
  lpPositionCount: number | null;
  /** Largest single LP's share of total shares (0–1). */
  lpTopShare: number | null;

  // --- Program-level reads (upgrade authority) ---------------------------
  /** Upgrade authority of the pm-AMM program (from its program data
   *  account), or null when immutable / unread. */
  upgradeAuthority: string | null;
  /** True when the program is immutable (no upgrade authority). */
  programImmutable: boolean | null;
  /** Slot of the most recent program upgrade, null when unknown. */
  lastUpgradeSlot: number | null;
  /** [P1] Unix timestamp of the last deploy, null when unknown. */
  lastUpgradeTime: number | null;
  /** [P1] ProgramData account address. */
  programDataAddress: string | null;
  /** [P1] True when the upgrade authority is on-curve (plain key shape). */
  upgradeAuthorityOnCurve: boolean | null;
  /** [P1] Owner program of the upgrade-authority account. */
  upgradeAuthorityOwner: string | null;
  /** [P1] Recent ProgramData transactions observed (bounded history —
   *  may be incomplete; never presented as a full upgrade history). */
  programDataTxCount: number | null;

  // --- Observation context ------------------------------------------------
  /** Unix timestamp (seconds) when the snapshot was taken. */
  observedAt: number;
  /** Current devnet slot at observation time, null when unread. */
  slot: number | null;
}

export interface CheckContext {
  market: PublicKey;
  marketAddress: string;
  connection: Connection;
  /**
   * Decoded market data. NULL only when the snapshot gatherer could not
   * run at all — checks then return "info" and document the snapshot
   * fields they need.
   */
  snapshot: MarketSnapshot | null;
}

export type CheckFn = (ctx: CheckContext) => Promise<CheckResult>;

export interface MarketVerdict {
  market: string;
  network: "devnet";
  programId: string;
  /** 0–100 aggregate. NULL when no check could be scored (UNRATED). */
  score: number | null;
  band: VerdictBand;
  /** One-paragraph plain-English explanation of the verdict. */
  explanation: string;
  checks: CheckResult[];
  generatedAt: string;
  engineVersion: string;
}
