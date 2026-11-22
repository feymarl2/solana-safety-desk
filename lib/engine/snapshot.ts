// Safety Desk — MarketSnapshot gatherer.
//
// ONE batched read per stage via getMultipleAccountsInfo; the public
// devnet RPC is rate-limited, so per-check RPC calls are kept minimal and
// the program-level upgrade-authority read is cached for an hour
// (RESEARCH.md §8). No wallet, no signing — reads only.
//
// Degradation contract: any failed batch leaves its fields null and sets
// rpcError with a human-readable note. Checks then return status "info"
// with an honest explanation — never a fake result. A 429 therefore
// degrades the verdict instead of inventing one.
//
// Decoding is manual Borsh (lib/engine/decode.ts) — no @pm-amm/sdk /
// Anchor dependency (ESM gotcha, see DEVELOPER-GUIDE.md).

import { PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { PM_AMM_PROGRAM_ID } from "../constants.js";
import {
  decodeGroup,
  decodeMarket,
  DEFAULT_PUBKEY,
  parseLpPositionShares,
  parseMintSupply,
  parseProgramData,
  parseTokenAccount,
  type DecodedMarket,
} from "./decode.js";
import {
  currentMarketPrice,
  i80f48ToNumber,
  lEffective,
  poolValue,
} from "./math.js";
import type { LegSnapshot, MarketSnapshot } from "./types.js";

const PROGRAM_KEY = new PublicKey(PM_AMM_PROGRAM_ID);

/** Max legs for which per-leg vault/supply reads are fetched (batch size). */
const MAX_LEG_SOLVENCY_LEGS = 8;

/** Upgrade-authority cache TTL: the program upgrades rarely; hourly is plenty. */
const UPGRADE_CACHE_TTL_MS = 60 * 60 * 1000;

interface UpgradeInfo {
  programDataAddress: string | null;
  upgradeAuthority: string | null;
  programImmutable: boolean | null;
  lastUpgradeSlot: number | null;
  lastUpgradeTime: number | null;
  upgradeAuthorityOnCurve: boolean | null;
  upgradeAuthorityOwner: string | null;
  programDataTxCount: number | null;
}

let upgradeCache: { info: UpgradeInfo; fetchedAt: number } | null = null;

function emptySnapshot(marketAddress: string, observedAt: number): MarketSnapshot {
  return {
    marketAddress,
    exists: null,
    ownerProgramId: null,
    accountSize: null,
    kind: "unknown",
    rpcError: null,
    name: null,
    creator: null,
    endTs: null,
    winningSide: null,
    initialPriceBps: null,
    yesReserve: null,
    noReserve: null,
    lastAccrualTs: null,
    isDynamic: null,
    vaultAccount: null,
    vaultBalanceRaw: null,
    outstandingYesRaw: null,
    outstandingNoRaw: null,
    yesMint: null,
    noMint: null,
    groupId: null,
    legMarketAddresses: null,
    legProbabilities: null,
    startTs: null,
    collateralMint: null,
    collateralDecimals: null,
    lZeroBits: null,
    cumYesPerShare: null,
    cumNoPerShare: null,
    totalLpShares: null,
    unclaimedExcessYes: null,
    unclaimedExcessNo: null,
    resolved: null,
    groupAddress: null,
    currentPrice: null,
    lEffNow: null,
    lEffAtStart: null,
    xNow: null,
    yNow: null,
    poolValueRaw: null,
    obligationRaw: null,
    coverage: null,
    authorityOnCurve: null,
    authorityOwner: null,
    authorityExists: null,
    legs: null,
    groupTotalSeededBps: null,
    groupWinningLeg: null,
    groupAttachedLegs: null,
    lpPositionCount: null,
    lpTopShare: null,
    upgradeAuthority: null,
    programImmutable: null,
    lastUpgradeSlot: null,
    lastUpgradeTime: null,
    programDataAddress: null,
    upgradeAuthorityOnCurve: null,
    upgradeAuthorityOwner: null,
    programDataTxCount: null,
    observedAt,
    slot: null,
  };
}

function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|rate limit|too many requests|503|502|504|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(
    msg,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry transient/RPC errors (429s) with backoff; rethrows the last error. */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      await sleep(i === 0 ? 600 : 1500);
    }
  }
  throw last;
}

function noteError(snap: MarketSnapshot, note: string): void {
  snap.rpcError = snap.rpcError ? `${snap.rpcError} ${note}` : note;
}

function onCurveOf(address: string): boolean | null {
  try {
    return PublicKey.isOnCurve(new PublicKey(address));
  } catch {
    return null;
  }
}

/** ProgramData read with hourly cache. Best-effort: failures yield nulls. */
async function readUpgradeInfo(
  connection: Connection,
  programAccountData: Buffer | null,
): Promise<UpgradeInfo> {
  const empty: UpgradeInfo = {
    programDataAddress: null,
    upgradeAuthority: null,
    programImmutable: null,
    lastUpgradeSlot: null,
    lastUpgradeTime: null,
    upgradeAuthorityOnCurve: null,
    upgradeAuthorityOwner: null,
    programDataTxCount: null,
  };
  if (upgradeCache && Date.now() - upgradeCache.fetchedAt < UPGRADE_CACHE_TTL_MS) {
    return upgradeCache.info;
  }
  if (!programAccountData || programAccountData.length < 36) return empty;
  try {
    const programDataAddress = new PublicKey(programAccountData.subarray(4, 36));
    const pdAccount = await withRetry(() =>
      connection.getAccountInfo(programDataAddress),
    );
    if (!pdAccount) return empty;
    const parsed = parseProgramData(
      programAccountData,
      pdAccount.data as Buffer,
    );
    if (!parsed) return empty;
    const info: UpgradeInfo = {
      ...empty,
      programDataAddress: parsed.programDataAddress,
      upgradeAuthority: parsed.upgradeAuthority,
      programImmutable: parsed.immutable,
      lastUpgradeSlot: parsed.slot,
      upgradeAuthorityOnCurve: parsed.upgradeAuthority
        ? onCurveOf(parsed.upgradeAuthority)
        : null,
    };
    // Block time + recent ProgramData activity + authority owner, best-effort.
    try {
      const t = await withRetry(() => connection.getBlockTime(parsed.slot), 2);
      info.lastUpgradeTime = t;
    } catch {
      /* leave null */
    }
    try {
      const sigs = await withRetry(
        () => connection.getSignaturesForAddress(programDataAddress, { limit: 20 }),
        2,
      );
      info.programDataTxCount = sigs.length;
    } catch {
      /* leave null */
    }
    if (parsed.upgradeAuthority) {
      try {
        const authAcc = await withRetry(
          () => connection.getAccountInfo(new PublicKey(parsed.upgradeAuthority as string)),
          2,
        );
        info.upgradeAuthorityOwner = authAcc ? authAcc.owner.toBase58() : null;
      } catch {
        /* leave null */
      }
    }
    upgradeCache = { info, fetchedAt: Date.now() };
    return info;
  } catch {
    return empty;
  }
}

interface PricedMarket {
  price: number | null;
  lEffNow: number | null;
  lEffAtStart: number | null;
  xNow: number;
  yNow: number;
  poolValueRaw: number | null;
}

function priceMarket(m: DecodedMarket, now: number): PricedMarket {
  const lZero = i80f48ToNumber(m.lZeroBits);
  const rx = i80f48ToNumber(m.reserveYesBits);
  const ry = i80f48ToNumber(m.reserveNoBits);
  const lEffAtStart =
    lZero > 0 ? lEffective(lZero, Math.max(m.endTs - m.startTs, 1)) : null;
  const priced = currentMarketPrice({
    lZero,
    reserveYes: rx,
    reserveNo: ry,
    endTs: m.endTs,
    lastAccrualTs: m.lastAccrualTs,
    now,
  });
  if (!priced) {
    // Unfunded (or degenerate): no price; reserves as stored for solvency.
    return { price: null, lEffNow: null, lEffAtStart, xNow: rx, yNow: ry, poolValueRaw: null };
  }
  return {
    price: priced.price,
    lEffNow: priced.lEff,
    lEffAtStart,
    xNow: priced.xNow,
    yNow: priced.yNow,
    poolValueRaw: poolValue(priced.price, priced.lEff),
  };
}

/**
 * Solvency obligation. Unresolved markets replicate the on-chain swap
 * guard exactly: max(yesSupply + x_now + excessYes, noSupply + y_now +
 * excessNo). Resolved markets: only the winning side is redeemable, so
 * the obligation is the winning supply + winning excess (reserves no
 * longer back open positions — trading is over). Returns null when any
 * input is missing.
 */
function solvencyObligation(
  m: DecodedMarket,
  xNow: number,
  yNow: number,
  yesSupply: bigint | null,
  noSupply: bigint | null,
): number | null {
  if (yesSupply === null || noSupply === null) return null;
  if (m.resolved && (m.winningSide === 1 || m.winningSide === 2)) {
    const winSupply = m.winningSide === 1 ? yesSupply : noSupply;
    const winExcess =
      m.winningSide === 1 ? m.unclaimedExcessYes : m.unclaimedExcessNo;
    return Number(winSupply) + Number(winExcess);
  }
  return Math.max(
    Number(yesSupply) + xNow + Number(m.unclaimedExcessYes),
    Number(noSupply) + yNow + Number(m.unclaimedExcessNo),
  );
}

function coverageOf(vault: bigint | null, obligation: number | null): number | null {
  if (vault === null || obligation === null || obligation <= 0) return null;
  return Number(vault) / obligation;
}

function fillMarketFields(
  snap: MarketSnapshot,
  m: DecodedMarket,
  priced: PricedMarket,
): void {
  snap.name = m.name;
  snap.creator = m.authority;
  snap.startTs = m.startTs;
  snap.endTs = m.endTs;
  snap.winningSide = m.winningSide;
  snap.initialPriceBps = m.initialPriceBps;
  snap.yesReserve = m.reserveYesBits;
  snap.noReserve = m.reserveNoBits;
  snap.lastAccrualTs = m.lastAccrualTs;
  snap.isDynamic = true;
  snap.vaultAccount = m.vault;
  snap.yesMint = m.yesMint;
  snap.noMint = m.noMint;
  snap.collateralMint = m.collateralMint;
  snap.lZeroBits = m.lZeroBits;
  snap.cumYesPerShare = m.cumYesPerShareBits;
  snap.cumNoPerShare = m.cumNoPerShareBits;
  snap.totalLpShares = m.totalLpSharesBits;
  snap.unclaimedExcessYes = m.unclaimedExcessYes;
  snap.unclaimedExcessNo = m.unclaimedExcessNo;
  snap.resolved = m.resolved;
  snap.groupAddress = m.group === DEFAULT_PUBKEY ? null : m.group;
  snap.groupId = snap.groupAddress;
  snap.currentPrice = priced.price;
  snap.lEffNow = priced.lEffNow;
  snap.lEffAtStart = priced.lEffAtStart;
  snap.xNow = priced.xNow;
  snap.yNow = priced.yNow;
  snap.poolValueRaw = priced.poolValueRaw;
  snap.authorityOnCurve = onCurveOf(m.authority);
}

function buildLeg(
  address: string,
  m: DecodedMarket | null,
  now: number,
  tokenReads?: { yesSupply: bigint | null; noSupply: bigint | null; vault: bigint | null },
): LegSnapshot {
  if (!m) {
    return {
      address, name: null, decoded: false, funded: false, price: null,
      endTs: null, resolved: null, winningSide: null, initialPriceBps: null,
      collateralMint: null,
      vaultBalanceRaw: null, obligationRaw: null, coverage: null,
    };
  }
  const priced = priceMarket(m, now);
  const funded = i80f48ToNumber(m.lZeroBits) > 0;
  let obligation: number | null = null;
  let coverage: number | null = null;
  if (tokenReads) {
    obligation = solvencyObligation(m, priced.xNow, priced.yNow, tokenReads.yesSupply, tokenReads.noSupply);
    coverage = coverageOf(tokenReads.vault, obligation);
  }
  return {
    address,
    name: m.name,
    decoded: true,
    funded,
    price: priced.price,
    endTs: m.endTs,
    resolved: m.resolved,
    winningSide: m.winningSide,
    initialPriceBps: m.initialPriceBps,
    collateralMint: m.collateralMint,
    vaultBalanceRaw: tokenReads?.vault ?? null,
    obligationRaw: obligation,
    coverage,
  };
}

/** Best-effort LP concentration for one market. Nulls on any failure. */
async function readLpConcentration(
  connection: Connection,
  marketKey: PublicKey,
  totalSharesBits: bigint,
): Promise<{ count: number; topShare: number } | null> {
  try {
    const positions = await withRetry(
      () =>
        connection.getProgramAccounts(PROGRAM_KEY, {
          filters: [
            { dataSize: 145 },
            { memcmp: { offset: 40, bytes: marketKey.toBase58() } },
          ],
        }),
      2,
    );
    if (positions.length === 0) return { count: 0, topShare: 0 };
    const total = i80f48ToNumber(totalSharesBits);
    if (!(total > 0)) return { count: positions.length, topShare: 0 };
    let top = 0;
    for (const { account } of positions) {
      const shares = parseLpPositionShares(account.data as Buffer);
      if (shares !== null) top = Math.max(top, i80f48ToNumber(shares));
    }
    return { count: positions.length, topShare: top / total };
  } catch {
    return null;
  }
}

export async function gatherMarketSnapshot(
  connection: Connection,
  market: PublicKey,
): Promise<MarketSnapshot> {
  const now = Math.floor(Date.now() / 1000);
  const snap = emptySnapshot(market.toBase58(), now);

  // --- Batch 1: target account + program account (for ProgramData) -------
  let batch1: (AccountInfo<Buffer> | null)[] | null = null;
  try {
    batch1 = await withRetry(() =>
      connection.getMultipleAccountsInfo([market, PROGRAM_KEY]),
    );
  } catch (err) {
    noteError(
      snap,
      `Devnet RPC read failed (${err instanceof Error ? err.message : String(err)}). The public devnet endpoint may be rate-limited — try again in a moment.`,
    );
    return snap;
  }
  const [target, programAccount] = batch1 as [
    AccountInfo<Buffer> | null,
    AccountInfo<Buffer> | null,
  ];

  // Slot, best-effort (never blocks the verdict).
  try {
    snap.slot = await connection.getSlot();
  } catch {
    /* leave null */
  }

  // Upgrade info (cached hourly) — independent of the target account.
  const upgrade = await readUpgradeInfo(
    connection,
    programAccount ? (programAccount.data as Buffer) : null,
  );
  snap.programDataAddress = upgrade.programDataAddress;
  snap.upgradeAuthority = upgrade.upgradeAuthority;
  snap.programImmutable = upgrade.programImmutable;
  snap.lastUpgradeSlot = upgrade.lastUpgradeSlot;
  snap.lastUpgradeTime = upgrade.lastUpgradeTime;
  snap.upgradeAuthorityOnCurve = upgrade.upgradeAuthorityOnCurve;
  snap.upgradeAuthorityOwner = upgrade.upgradeAuthorityOwner;
  snap.programDataTxCount = upgrade.programDataTxCount;

  if (!target) {
    snap.exists = false;
    return snap;
  }
  snap.exists = true;
  snap.ownerProgramId = target.owner.toBase58();
  const data = target.data as Buffer;
  snap.accountSize = data.length;

  const asMarket = decodeMarket(data);
  const asGroup = asMarket ? null : decodeGroup(data);
  if (!asMarket && !asGroup) {
    // Exists, but is not a Market or GroupMarket (wrong owner, vault,
    // LpPosition, token account, ...). Checks explain this from kind.
    snap.kind = "unknown";
    return snap;
  }

  if (asMarket) {
    snap.kind = "market";
    const priced = priceMarket(asMarket, now);
    fillMarketFields(snap, asMarket, priced);

    // --- Batch 2: mints + vault + collateral mint + authority (+ group) --
    const keys: PublicKey[] = [
      new PublicKey(asMarket.yesMint),
      new PublicKey(asMarket.noMint),
      new PublicKey(asMarket.vault),
      new PublicKey(asMarket.collateralMint),
      new PublicKey(asMarket.authority),
    ];
    const wantGroup = asMarket.group !== DEFAULT_PUBKEY;
    if (wantGroup) keys.push(new PublicKey(asMarket.group));
    try {
      const accs = await withRetry(() => connection.getMultipleAccountsInfo(keys));
      const [yesMintAcc, noMintAcc, vaultAcc, collateralAcc, authorityAcc, groupAcc] =
        accs as (AccountInfo<Buffer> | null)[];
      const yesParsed = yesMintAcc ? parseMintSupply(yesMintAcc.data as Buffer) : null;
      const noParsed = noMintAcc ? parseMintSupply(noMintAcc.data as Buffer) : null;
      const vaultParsed = vaultAcc ? parseTokenAccount(vaultAcc.data as Buffer) : null;
      const collateralParsed = collateralAcc
        ? parseMintSupply(collateralAcc.data as Buffer)
        : null;
      snap.outstandingYesRaw = yesParsed?.supply ?? null;
      snap.outstandingNoRaw = noParsed?.supply ?? null;
      snap.vaultBalanceRaw = vaultParsed?.amount ?? null;
      snap.collateralDecimals = collateralParsed?.decimals ?? null;
      snap.authorityExists = authorityAcc !== null;
      snap.authorityOwner = authorityAcc ? authorityAcc.owner.toBase58() : null;
      snap.obligationRaw = solvencyObligation(
        asMarket, priced.xNow, priced.yNow,
        snap.outstandingYesRaw, snap.outstandingNoRaw,
      );
      snap.coverage = coverageOf(snap.vaultBalanceRaw, snap.obligationRaw);

      // Attached group → fetch siblings for coherence (batch 3).
      if (wantGroup && groupAcc) {
        const group = decodeGroup(groupAcc.data as Buffer);
        if (group) {
          snap.groupTotalSeededBps = group.totalSeededBps;
          snap.groupWinningLeg = group.winningLeg;
          const attached = group.legs
            .slice(0, Math.min(group.legCount, 32))
            .filter((a) => a !== DEFAULT_PUBKEY);
          snap.groupAttachedLegs = attached.length;
          snap.legMarketAddresses = attached;
          try {
            const legAccs = await withRetry(() =>
              connection.getMultipleAccountsInfo(
                attached.map((a) => new PublicKey(a)),
              ),
            );
            const legs = legAccs.map((acc, i) =>
              buildLeg(
                attached[i] as string,
                acc ? decodeMarket(acc.data as Buffer) : null,
                now,
              ),
            );
            snap.legs = legs;
            snap.legProbabilities = legs.map((l) => l.price);
          } catch {
            noteError(snap, "Sibling leg markets could not be read; coherence is unavailable for this leg.");
          }
        }
      }
    } catch (err) {
      noteError(
        snap,
        `Token/vault reads failed (${err instanceof Error ? err.message : String(err)}). Solvency and pricing inputs may be missing.`,
      );
    }

    // LP concentration, best-effort.
    const conc = await readLpConcentration(connection, market, asMarket.totalLpSharesBits);
    if (conc) {
      snap.lpPositionCount = conc.count;
      snap.lpTopShare = conc.topShare;
    }
    return snap;
  }

  // --- Group input ---------------------------------------------------------
  snap.kind = "group";
  const group = asGroup as NonNullable<typeof asGroup>;
  snap.name = group.name;
  snap.creator = group.authority;
  snap.startTs = group.startTs;
  snap.endTs = group.endTs;
  snap.resolved = group.resolved;
  snap.winningSide = null;
  snap.groupId = market.toBase58();
  snap.groupTotalSeededBps = group.totalSeededBps;
  snap.groupWinningLeg = group.winningLeg;
  snap.authorityOnCurve = onCurveOf(group.authority);
  const attached = group.legs
    .slice(0, Math.min(group.legCount, 32))
    .filter((a) => a !== DEFAULT_PUBKEY);
  snap.groupAttachedLegs = attached.length;
  snap.legMarketAddresses = attached;

  // Batch 2: authority + leg markets.
  try {
    const accs = await withRetry(() =>
      connection.getMultipleAccountsInfo([
        new PublicKey(group.authority),
        ...attached.map((a) => new PublicKey(a)),
      ]),
    );
    const [authorityAcc, ...legAccs] = accs as (AccountInfo<Buffer> | null)[];
    snap.authorityExists = authorityAcc !== null;
    snap.authorityOwner = authorityAcc ? authorityAcc.owner.toBase58() : null;
    const decodedLegs = legAccs.map((acc) =>
      acc ? decodeMarket(acc.data as Buffer) : null,
    );

    // Batch 3: per-leg token reads for leg solvency (capped at 8 legs).
    let legs: LegSnapshot[];
    if (attached.length <= MAX_LEG_SOLVENCY_LEGS) {
      const tokenKeys: PublicKey[] = [];
      const legIndex: number[] = [];
      decodedLegs.forEach((m, i) => {
        if (m) {
          tokenKeys.push(
            new PublicKey(m.yesMint),
            new PublicKey(m.noMint),
            new PublicKey(m.vault),
          );
          legIndex.push(i);
        }
      });
      try {
        const tokenAccs = await withRetry(() =>
          connection.getMultipleAccountsInfo(tokenKeys),
        );
        const reads = new Map<number, { yesSupply: bigint | null; noSupply: bigint | null; vault: bigint | null }>();
        legIndex.forEach((legIdx, j) => {
          const y = tokenAccs[j * 3] ? parseMintSupply(tokenAccs[j * 3]?.data as Buffer) : null;
          const n = tokenAccs[j * 3 + 1] ? parseMintSupply(tokenAccs[j * 3 + 1]?.data as Buffer) : null;
          const v = tokenAccs[j * 3 + 2] ? parseTokenAccount(tokenAccs[j * 3 + 2]?.data as Buffer) : null;
          reads.set(legIdx, {
            yesSupply: y?.supply ?? null,
            noSupply: n?.supply ?? null,
            vault: v?.amount ?? null,
          });
        });
        legs = decodedLegs.map((m, i) =>
          buildLeg(attached[i] as string, m, now, reads.get(i)),
        );
      } catch {
        noteError(snap, "Per-leg vault reads failed; leg solvency is unavailable.");
        legs = decodedLegs.map((m, i) => buildLeg(attached[i] as string, m, now));
      }
    } else {
      legs = decodedLegs.map((m, i) => buildLeg(attached[i] as string, m, now));
    }
    snap.legs = legs;
    snap.legProbabilities = legs.map((l) => l.price);
    // Aggregate pool value across priced legs (LP check input).
    let poolSum = 0;
    let anyPool = false;
    decodedLegs.forEach((m) => {
      if (!m) return;
      const p = priceMarket(m, now);
      if (p.poolValueRaw !== null && Number.isFinite(p.poolValueRaw)) {
        poolSum += p.poolValueRaw;
        anyPool = true;
      }
    });
    snap.poolValueRaw = anyPool ? poolSum : null;
  } catch (err) {
    noteError(
      snap,
      `Group leg reads failed (${err instanceof Error ? err.message : String(err)}). Coherence is unavailable.`,
    );
  }
  return snap;
}
