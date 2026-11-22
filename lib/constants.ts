// Safety Desk — devnet constants.
// Single source of truth for every pm-AMM / Solana address this app uses.
// ALL values are DEVNET. The pm-AMM program ID is the same on mainnet, so
// the devnet RPC endpoint + devnet mUSDC mint are what keep every read on
// devnet. There are intentionally NO mainnet addresses or code paths.
//
// Sources (read 15 Nov 2026): https://predict-pm-amm.dev/ (§3) and
// https://predict-pm-amm.dev/hackathon.md (§1, "Devnet constants").

/** pm-AMM Anchor program ID — same program ID on devnet and mainnet. */
export const PM_AMM_PROGRAM_ID =
  "GV1FMGHRYBjQLaghE5fnGuYCuCcpdt3GD5xEX3TwN16y";

/** Devnet mock USDC (mUSDC) mint, 6 decimals. NEVER mainnet USDC. */
export const DEVNET_MUSDC_MINT =
  "3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ";
export const MUSDC_DECIMALS = 6;

/** Public devnet RPC. Rate-limited (429) — batch reads, poll ≥ 15s. */
export const DEVNET_RPC_URL = "https://api.devnet.solana.com";

/** Network label shown in every verdict. This app only ever reads devnet. */
export const NETWORK = "devnet" as const;

/** Current pm-AMM market account size in bytes (hackathon.md §6). */
export const MARKET_ACCOUNT_SIZE = 443;

/** Swap fee on the USDC leg: 2%, split 50% protocol / 50% market creator. */
export const SWAP_FEE_BPS = 200;

/** Settlement: 1 winning token = 1 USDC, no fee. */
export const SETTLEMENT_PER_WINNING_TOKEN_USDC = 1;

/** Solscan account URL, devnet cluster. Evidence links use this. */
export function explorerAccountUrl(address: string): string {
  return `https://solscan.io/account/${address}?cluster=devnet`;
}

/** Solscan program URL, devnet cluster. */
export function explorerProgramUrl(programId: string = PM_AMM_PROGRAM_ID): string {
  return explorerAccountUrl(programId);
}
