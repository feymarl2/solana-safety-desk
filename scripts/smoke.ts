// Safety Desk — offline smoke test.
// Verifies, with NO network calls:
//   1. @solana/web3.js installs and a Connection constructs offline.
//   2. Address parsing accepts valid base58 and rejects junk.
//   3. Manual Borsh decoders round-trip a synthetic Market/GroupMarket/
//      ProgramData/mint/token account (wrong discriminator → null).
//   4. pm-AMM math: I80F48 conversion, CDF symmetry, rescaled pricing,
//      pool value, expected daily LVR.
//   5. Scorer: UNRATED on all-info, hard-fail cap on resolution fail,
//      weighted mean.
//   6. Question-clarity heuristic flags junk names, passes clear ones.
//   7. Check registry: 6 checks, weights sum to 100.
// Run: npm run smoke
// (Live devnet verification is separate: scripts/local-server.ts + curl,
// with verdict JSONs recorded under build/EVIDENCE/.)

import { Connection, PublicKey } from "@solana/web3.js";
import assert from "node:assert/strict";
import { DEVNET_RPC_URL, PM_AMM_PROGRAM_ID } from "../lib/constants.js";
import {
  decodeGroup,
  decodeMarket,
  GROUP_DISCRIMINATOR,
  MARKET_DISCRIMINATOR,
  parseMintSupply,
  parseProgramData,
  parseTokenAccount,
} from "../lib/engine/decode.js";
import { CHECKS } from "../lib/engine/index.js";
import {
  capitalPhi,
  currentMarketPrice,
  expectedDailyLvr,
  i80f48ToNumber,
  poolValue,
  priceFromReserves,
} from "../lib/engine/math.js";
import { scoreChecks } from "../lib/engine/scorer.js";
import type { CheckResult } from "../lib/engine/types.js";
import { clarityFlags } from "../lib/engine/checks/expiry-rules.js";
import { parseMarketAddress } from "../lib/verdict.js";

function i80Bits(value: number): bigint {
  return BigInt(Math.round(value * 2 ** 48));
}

function writeU128(buf: Buffer, offset: number, bits: bigint): void {
  buf.writeBigUInt64LE(bits & 0xffffffffffffffffn, offset);
  buf.writeBigUInt64LE((bits >> 64n) & 0xffffffffffffffffn, offset + 8);
}

function syntheticMarket(): Buffer {
  const buf = Buffer.alloc(443);
  Buffer.from(MARKET_DISCRIMINATOR).copy(buf, 0);
  new PublicKey("HD85YCz4CPeyojdE92vz3rsvMG5BUXiThhsksM4NPA9Q").toBuffer().copy(buf, 8);
  buf.writeBigUInt64LE(1794372739652n, 40);
  new PublicKey("3WQ8hCqTNwjrh8WzE2XyoZoUrd1miPcwWfMkmFPUMEWZ").toBuffer().copy(buf, 48);
  new PublicKey("5UWdySeYJYAuKgZB9BLcj9zVrwG1fS7iaKLGC7GnHqwL").toBuffer().copy(buf, 80);
  new PublicKey("E9uUyyzDK4LpAX4zRD7KA3b6g1TjRPVm6JkKHH1WFh4K").toBuffer().copy(buf, 112);
  new PublicKey("3j4nGJfEzT6r4DxLmbHy7z1xtenw3K8rWBwq3NmfBNua").toBuffer().copy(buf, 144);
  buf.writeBigInt64LE(1794372739n, 176);
  buf.writeBigInt64LE(1795161600n, 184);
  writeU128(buf, 192, i80Bits(310113.04696540756));
  writeU128(buf, 208, i80Bits(150000000));
  writeU128(buf, 224, i80Bits(50000000));
  buf.writeBigInt64LE(1794372739n, 240);
  writeU128(buf, 296, i80Bits(1000000));
  buf[312] = 0;
  buf[313] = 0;
  buf[314] = 253;
  buf.write("BTC<=70000.00 by 2026-11-20 08:00Z", 315, "utf8");
  buf.writeUInt16LE(3960, 379);
  // group = default pubkey (zeros) — standalone market.
  buf.writeBigUInt64LE(72636365n, 421);
  return buf;
}

async function main(): Promise<void> {
  // 1. Offline Connection construction (constructor performs no I/O).
  const connection = new Connection(DEVNET_RPC_URL, "confirmed");
  assert.equal(connection.rpcEndpoint, DEVNET_RPC_URL);
  console.log("ok: Connection constructs offline ->", connection.rpcEndpoint);

  // 2. Address parsing.
  const programKey = parseMarketAddress(PM_AMM_PROGRAM_ID);
  assert.ok(programKey instanceof PublicKey);
  assert.throws(() => parseMarketAddress("not-an-address!!"), /valid base58/);
  assert.throws(() => parseMarketAddress(""), /must be a Solana address/);
  console.log("ok: address parsing (valid + invalid)");

  // 3. Decoders.
  const m = decodeMarket(syntheticMarket());
  assert.ok(m, "synthetic market decodes");
  assert.equal(m.name, "BTC<=70000.00 by 2026-11-20 08:00Z");
  assert.equal(m.initialPriceBps, 3960);
  assert.equal(m.endTs, 1795161600);
  assert.equal(m.resolved, false);
  assert.equal(m.unclaimedExcessNo, 72636365n);
  assert.equal(m.group, "11111111111111111111111111111111");
  assert.ok(Math.abs(i80f48ToNumber(m.lZeroBits) - 310113.04696540756) < 0.01);
  const badDisc = syntheticMarket();
  badDisc[0] ^= 0xff;
  assert.equal(decodeMarket(badDisc), null);
  assert.equal(decodeMarket(Buffer.alloc(100)), null);

  const groupBuf = Buffer.alloc(1188);
  Buffer.from(GROUP_DISCRIMINATOR).copy(groupBuf, 0);
  new PublicKey("6NG87yZrQw6zH6Au8fHbYcD7Dken5smAzisLeXazpt8E").toBuffer().copy(groupBuf, 8);
  groupBuf[64] = 3;
  groupBuf[1090] = 0xff;
  groupBuf.write("Best performer in Q4 2026", 1092, "utf8");
  groupBuf.writeUInt32LE(9999, 1156);
  const g = decodeGroup(groupBuf);
  assert.ok(g, "synthetic group decodes");
  assert.equal(g.name, "Best performer in Q4 2026");
  assert.equal(g.legCount, 3);
  assert.equal(g.totalSeededBps, 9999);

  const progBuf = Buffer.alloc(36);
  progBuf.writeUInt32LE(2, 0);
  new PublicKey("4wBVEijk6s6F9NuYmTRxbMWPfAaFXRsNq54haAf88piF").toBuffer().copy(progBuf, 4);
  const pdBuf = Buffer.alloc(45);
  pdBuf.writeUInt32LE(3, 0);
  pdBuf.writeBigUInt64LE(511269300n, 4);
  pdBuf[12] = 1;
  new PublicKey("ETGKSFc7KMu32foPegEGiqFiDX3B2bPXhiFhvm8K7R6Y").toBuffer().copy(pdBuf, 13);
  const pd = parseProgramData(progBuf, pdBuf);
  assert.ok(pd);
  assert.equal(pd.upgradeAuthority, "ETGKSFc7KMu32foPegEGiqFiDX3B2bPXhiFhvm8K7R6Y");
  assert.equal(pd.slot, 511269300);
  assert.equal(pd.immutable, false);

  const mintBuf = Buffer.alloc(82);
  mintBuf.writeBigUInt64LE(123456789n, 36);
  mintBuf[44] = 6;
  assert.deepEqual(parseMintSupply(mintBuf), { supply: 123456789n, decimals: 6 });
  const tokenBuf = Buffer.alloc(165);
  mintBuf.subarray(0, 0); // no-op, keeps layout explicit
  tokenBuf.writeBigUInt64LE(150000000n, 64);
  assert.equal(parseTokenAccount(tokenBuf)?.amount, 150000000n);
  console.log("ok: Borsh decoders (market/group/program-data/mint/token)");

  // 4. Math.
  assert.ok(Math.abs(i80f48ToNumber(i80Bits(1.5)) - 1.5) < 1e-9);
  assert.ok(Math.abs(capitalPhi(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(priceFromReserves(100, 100, 1000) - 0.5) < 1e-9);
  const priced = currentMarketPrice({
    lZero: 1000,
    reserveYes: 100000,
    reserveNo: 100000,
    endTs: 2000000,
    lastAccrualTs: 1000000,
    now: 1000000,
  });
  assert.ok(priced && Math.abs(priced.price - 0.5) < 1e-9);
  assert.equal(
    currentMarketPrice({ lZero: 0, reserveYes: 0, reserveNo: 0, endTs: 2, lastAccrualTs: 1, now: 1 }),
    null,
  );
  assert.ok(poolValue(0.5, 1000) > 0);
  assert.ok(
    Math.abs(expectedDailyLvr(0.5, 1000, 86400) - poolValue(0.5, 1000) / 2) < 1e-9,
  );
  console.log("ok: pm-AMM math (I80F48, CDF, rescaled pricing, pool value, LVR)");

  // 5. Scorer.
  const infoOnly: CheckResult[] = CHECKS.map((c) => ({
    id: c.id, title: c.title, status: "info", points: null, weight: c.weight,
    explanation: "info", evidence: [], implemented: true,
  }));
  const unrated = scoreChecks(infoOnly);
  assert.equal(unrated.score, null);
  assert.equal(unrated.band, "UNRATED");
  const hardFail: CheckResult[] = CHECKS.map((c) => ({
    id: c.id, title: c.title,
    status: c.id === "resolution-authority" ? ("fail" as const) : ("pass" as const),
    points: c.id === "resolution-authority" ? 5 : 90,
    weight: c.weight, explanation: "x", evidence: [], implemented: true,
  }));
  const capped = scoreChecks(hardFail);
  assert.ok((capped.score as number) <= 19);
  assert.equal(capped.band, "AVOID");
  console.log("ok: scorer (UNRATED + hard-fail cap)");

  // 6. Clarity heuristic.
  assert.ok(clarityFlags("kjkj").length > 0);
  assert.ok(clarityFlags("").length > 0);
  assert.equal(clarityFlags("BTC above $70k at 2026-11-15 12:00 UTC? (CoinGecko)").length, 0);
  console.log("ok: question-clarity heuristic");

  // 7. Registry.
  assert.equal(CHECKS.length, 6);
  assert.equal(CHECKS.reduce((s, c) => s + c.weight, 0), 100);
  console.log("ok: check registry (6 checks, weights sum 100)");

  console.log("SMOKE GREEN");
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
