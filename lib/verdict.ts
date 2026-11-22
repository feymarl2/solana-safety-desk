// Safety Desk — verdict entry point.
// checkMarket(marketAddress) checks one pm-AMM market (or group) on Solana
// devnet and returns the JSON verdict. Mirrors MintGuard's verdict.ts shape
// (one entry function, read-only, no transactions).
//
// Read-only: batched getMultipleAccountsInfo / getAccountInfo /
// getSignaturesForAddress reads via the snapshot gatherer. Never sends a
// transaction, never connects a wallet. Devnet only.

import { PublicKey } from "@solana/web3.js";
import { PM_AMM_PROGRAM_ID } from "./constants.js";
import { buildDevnetConnection } from "./rpc.js";
import { runChecks } from "./engine/index.js";
import { scoreChecks } from "./engine/scorer.js";
import { gatherMarketSnapshot } from "./engine/snapshot.js";
import type { CheckContext, MarketVerdict } from "./engine/types.js";

export const ENGINE_VERSION = "1.0.0";

/** Parse + validate a pasted market address. Throws on invalid input. */
export function parseMarketAddress(input: unknown): PublicKey {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("`market` must be a Solana address string.");
  }
  const trimmed = input.trim();
  try {
    return new PublicKey(trimmed);
  } catch {
    throw new Error(
      "`market` must be a valid base58 Solana address (a pm-AMM market account on devnet).",
    );
  }
}

export async function checkMarket(
  marketAddress: string,
): Promise<MarketVerdict> {
  const market = parseMarketAddress(marketAddress);
  const connection = buildDevnetConnection();

  // One batched devnet read fills the snapshot; the gatherer degrades
  // gracefully (null fields + rpcError) when the public RPC rate-limits.
  const snapshot = await gatherMarketSnapshot(connection, market);
  const ctx: CheckContext = {
    market,
    marketAddress: market.toBase58(),
    connection,
    snapshot,
  };

  const checks = await runChecks(ctx);
  const { score, band, explanation } = scoreChecks(checks);

  return {
    market: market.toBase58(),
    network: "devnet",
    programId: PM_AMM_PROGRAM_ID,
    score,
    band,
    explanation,
    checks,
    generatedAt: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
  };
}
