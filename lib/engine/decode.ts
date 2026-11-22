// Safety Desk — manual Borsh decoding of pm-AMM accounts.
//
// No @pm-amm/sdk / Anchor dependency (ESM gotcha — see DEVELOPER-GUIDE.md).
// Layouts are copied from the program source at repo HEAD d5b407b
// (anchor/programs/pm_amm/src/state.rs: Market::LEN = 443,
// GroupMarket::LEN = 1188) and verified against the IDL discriminators and
// live devnet accounts (15 Nov 2026 probe: decoded price 0.396 == seed
// 3960 bps; ProgramData authority matched DEVNET.md). If the program
// upgrades, re-verify these layouts against the new IDL before trusting
// them — the decoders below reject wrong sizes/discriminators loudly
// (return null) instead of misreading shifted fields.

import { PublicKey } from "@solana/web3.js";

export const MARKET_DISCRIMINATOR = [219, 190, 213, 55, 0, 227, 198, 154];
export const GROUP_DISCRIMINATOR = [64, 120, 105, 242, 92, 182, 3, 113];
export const LP_POSITION_SIZE = 145;
export const GROUP_SIZE = 1188;

export const DEFAULT_PUBKEY = "11111111111111111111111111111111";

/** I80F48 / u128 fields are read as signed 128-bit bit patterns. */
function readI128Bits(data: Buffer, offset: number): bigint {
  const lo = data.readBigUInt64LE(offset);
  const hi = data.readBigUInt64LE(offset + 8);
  let v = (hi << 64n) | lo;
  if (v >= 1n << 127n) v -= 1n << 128n;
  return v;
}

function readPubkey(data: Buffer, offset: number): string {
  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

/** Zero-padded UTF-8 name field → string (stops at first NUL). */
function readName(data: Buffer, offset: number, length: number): string {
  const raw = data.subarray(offset, offset + length);
  const nul = raw.indexOf(0);
  return raw.subarray(0, nul < 0 ? length : nul).toString("utf8");
}

function hasDiscriminator(data: Buffer, disc: number[]): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== disc[i]) return false;
  return true;
}

export interface DecodedMarket {
  authority: string;
  marketId: bigint;
  collateralMint: string;
  yesMint: string;
  noMint: string;
  vault: string;
  startTs: number;
  endTs: number;
  /** L_0, I80F48 bits. 0 = market shell, never funded. */
  lZeroBits: bigint;
  /** Stored reserves (as of lastAccrualTs) — MUST be rescaled before pricing. */
  reserveYesBits: bigint;
  reserveNoBits: bigint;
  lastAccrualTs: number;
  cumYesPerShareBits: bigint;
  cumNoPerShareBits: bigint;
  totalYesDistributed: bigint;
  totalNoDistributed: bigint;
  totalLpSharesBits: bigint;
  resolved: boolean;
  /** 0 unresolved, 1 YES, 2 NO. */
  winningSide: number;
  bump: number;
  name: string;
  /** 0 = legacy 50/50 seed. */
  initialPriceBps: number;
  /** GroupMarket PDA, or the default pubkey for standalone markets. */
  group: string;
  unclaimedExcessYes: bigint;
  unclaimedExcessNo: bigint;
}

/** Decode a 443-byte Market account. Null on size/discriminator mismatch. */
export function decodeMarket(data: Buffer): DecodedMarket | null {
  if (data.length !== 443 || !hasDiscriminator(data, MARKET_DISCRIMINATOR)) {
    return null;
  }
  return {
    authority: readPubkey(data, 8),
    marketId: data.readBigUInt64LE(40),
    collateralMint: readPubkey(data, 48),
    yesMint: readPubkey(data, 80),
    noMint: readPubkey(data, 112),
    vault: readPubkey(data, 144),
    startTs: Number(data.readBigInt64LE(176)),
    endTs: Number(data.readBigInt64LE(184)),
    lZeroBits: readI128Bits(data, 192),
    reserveYesBits: readI128Bits(data, 208),
    reserveNoBits: readI128Bits(data, 224),
    lastAccrualTs: Number(data.readBigInt64LE(240)),
    cumYesPerShareBits: readI128Bits(data, 248),
    cumNoPerShareBits: readI128Bits(data, 264),
    totalYesDistributed: data.readBigUInt64LE(280),
    totalNoDistributed: data.readBigUInt64LE(288),
    totalLpSharesBits: readI128Bits(data, 296),
    resolved: data[312] !== 0,
    winningSide: data[313],
    bump: data[314],
    name: readName(data, 315, 64),
    initialPriceBps: data.readUInt16LE(379),
    group: readPubkey(data, 381),
    unclaimedExcessYes: data.readBigUInt64LE(413),
    unclaimedExcessNo: data.readBigUInt64LE(421),
  };
}

export interface DecodedGroup {
  authority: string;
  groupId: bigint;
  startTs: number;
  endTs: number;
  legCount: number;
  /** All 32 slots; default pubkey = empty slot. */
  legs: string[];
  resolved: boolean;
  /** 0xFF = unresolved. */
  winningLeg: number;
  bump: number;
  name: string;
  totalSeededBps: number;
}

/** Decode an 1188-byte GroupMarket account. Null on mismatch. */
export function decodeGroup(data: Buffer): DecodedGroup | null {
  if (data.length !== GROUP_SIZE || !hasDiscriminator(data, GROUP_DISCRIMINATOR)) {
    return null;
  }
  const legs: string[] = [];
  for (let i = 0; i < 32; i++) legs.push(readPubkey(data, 65 + i * 32));
  return {
    authority: readPubkey(data, 8),
    groupId: data.readBigUInt64LE(40),
    startTs: Number(data.readBigInt64LE(48)),
    endTs: Number(data.readBigInt64LE(56)),
    legCount: data[64],
    legs,
    resolved: data[1089] !== 0,
    winningLeg: data[1090],
    bump: data[1091],
    name: readName(data, 1092, 64),
    totalSeededBps: data.readUInt32LE(1156),
  };
}

export interface ParsedProgramData {
  /** ProgramData account address (derived from the program account). */
  programDataAddress: string;
  /** Slot of the last deploy/upgrade. */
  slot: number;
  /** Upgrade authority, or null when immutable (Option flag = 0). */
  upgradeAuthority: string | null;
  immutable: boolean;
}

/**
 * Parse the BPF upgradeable-loader layout: program account data bytes
 * [4..36] hold the ProgramData address; ProgramData header is u32 enum (3)
 * + u64 slot + u8 Option flag + 32-byte authority. Returns null on any
 * layout mismatch — callers degrade to info, never guess.
 */
export function parseProgramData(
  programAccountData: Buffer,
  programDataAccountData: Buffer,
): ParsedProgramData | null {
  if (programAccountData.length < 36) return null;
  const programDataAddress = new PublicKey(
    programAccountData.subarray(4, 36),
  ).toBase58();
  if (programDataAccountData.length < 45) return null;
  if (programDataAccountData.readUInt32LE(0) !== 3) return null;
  const slot = Number(programDataAccountData.readBigUInt64LE(4));
  const hasAuthority = programDataAccountData[12] !== 0;
  return {
    programDataAddress,
    slot,
    upgradeAuthority: hasAuthority
      ? new PublicKey(programDataAccountData.subarray(13, 45)).toBase58()
      : null,
    immutable: !hasAuthority,
  };
}

/** SPL Token mint: supply u64 at offset 36, decimals u8 at 44. */
export function parseMintSupply(data: Buffer): { supply: bigint; decimals: number } | null {
  if (data.length < 46) return null;
  return { supply: data.readBigUInt64LE(36), decimals: data[44] };
}

/** SPL Token account: amount u64 at offset 64; mint at [0..32]. */
export function parseTokenAccount(data: Buffer): { mint: string; amount: bigint } | null {
  if (data.length < 72) return null;
  return { mint: readPubkey(data, 0), amount: data.readBigUInt64LE(64) };
}

/** LpPosition: shares u128 at offset 72 (8 disc + 32 owner + 32 market). */
export function parseLpPositionShares(data: Buffer): bigint | null {
  if (data.length !== LP_POSITION_SIZE) return null;
  return readI128Bits(data, 72);
}
