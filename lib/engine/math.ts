// Safety Desk — pm-AMM math, reimplemented from the paper + SDK formulas.
//
// The SDK's pure math (@pm-amm/sdk/math) is the reference, but this codebase
// deliberately does NOT depend on @pm-amm/sdk: @anchor-lang/core is CommonJS
// and breaks on BN under raw Node ESM (see DEVELOPER-GUIDE.md). Everything
// here is dependency-free float64 math for display / estimation only — the
// same approximations the SDK itself uses (Abramowitz & Stegun CDF,
// Beasley-Springer-Moro inverse CDF). Never used for on-chain quoting.
//
// References: C. Moallemi & D. Robinson, "pm-AMM", Paradigm, Nov 2024;
// sparkfun-labs/pm-amm packages/sdk/src/math.ts (MIT).

/** I80F48 fixed point: signed 128-bit integer / 2^48. */
const I80F48_SCALE = 1n << 48n;

/**
 * Convert raw I80F48 bits (signed bigint) to a JS number.
 * Splits integer/fractional parts in BigInt first — `Number(bits) / 2**48`
 * loses precision above 2^53, and real L_0 values are ~1e23 in bits.
 * Mirrors the SDK's i80f48ToNumber exactly.
 */
export function i80f48ToNumber(bits: bigint): number {
  const intPart = bits / I80F48_SCALE;
  const fracPart = bits % I80F48_SCALE;
  return Number(intPart) + Number(fracPart) / 2 ** 48;
}

/** Standard normal PDF. */
export function phi(z: number): number {
  return Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
export function capitalPhi(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const erf =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

/** Approximate inverse normal CDF (Beasley-Springer-Moro, as in the SDK). */
export function phiInv(p: number): number {
  if (p <= 0.0001) return -3.7;
  if (p >= 0.9999) return 3.7;
  if (p === 0.5) return 0;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number;
  let r: number;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  q = p - 0.5;
  r = q * q;
  return (
    (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/** Price from reserves: P = Φ((y − x) / L_eff). Paper eq. (5)–(6). */
export function priceFromReserves(x: number, y: number, lEff: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !(lEff > 0)) return NaN;
  return capitalPhi((y - x) / lEff);
}

/** Pool value: V(P) = L_eff · φ(Φ⁻¹(P)). Paper section 8. */
export function poolValue(price: number, lEff: number): number {
  if (!(lEff > 0) || !Number.isFinite(price)) return NaN;
  return lEff * phi(phiInv(price));
}

/** Effective liquidity: L_eff = L_0 · √(T − t). Paper section 8. */
export function lEffective(lZero: number, secondsRemaining: number): number {
  if (!(lZero > 0) || !(secondsRemaining > 0)) return 0;
  return lZero * Math.sqrt(secondsRemaining);
}

/**
 * Current YES price of a market, rescaling the stored reserves first.
 *
 * Stored reserves date from lastAccrualTs; quoting them against today's
 * L_eff over-promises by +15–80% on idle markets (RESEARCH.md §3). Correct
 * procedure: scale = L_eff(now) / L_eff(lastAccrualTs); x,y scaled; then
 * priceFromReserves. Returns null for unfunded markets (L_0 == 0): no
 * price exists, do not show 50%.
 */
export function currentMarketPrice(args: {
  lZero: number;
  reserveYes: number;
  reserveNo: number;
  endTs: number;
  lastAccrualTs: number;
  now: number;
}): { price: number; lEff: number; xNow: number; yNow: number } | null {
  const { lZero, reserveYes, reserveNo, endTs, lastAccrualTs, now } = args;
  if (!(lZero > 0)) return null;
  const lEff = lEffective(lZero, Math.max(endTs - now, 1));
  const lLast = lEffective(lZero, Math.max(endTs - lastAccrualTs, 1));
  if (!(lEff > 0) || !(lLast > 0)) return null;
  const scale = lEff / lLast;
  const xNow = reserveYes * scale;
  const yNow = reserveNo * scale;
  return { price: priceFromReserves(xNow, yNow, lEff), lEff, xNow, yNow };
}

/**
 * Expected daily LVR (model, ex-ante): V(P) / (2 · T_remaining_days).
 * Paper section 8. A property of the curve, NOT a prediction for this
 * market and NOT a realized number — callers must label it "expected".
 */
export function expectedDailyLvr(
  price: number,
  lEff: number,
  remainingSecs: number,
): number {
  if (remainingSecs <= 0) return 0;
  const v = poolValue(price, lEff);
  return v / ((2 * remainingSecs) / 86400);
}

/** Terminal wealth expectation: E[W_T] = W_0 / 2. Paper section 8. */
export function expectedTerminalWealth(deposited: number): number {
  return deposited / 2;
}

/** Σ p_i across group legs. */
export function sumProbabilities(prices: number[]): number {
  return prices.reduce((acc, p) => acc + p, 0);
}

/** |Σ − 1| in percentage points. */
export function groupDriftPct(prices: number[]): number {
  if (prices.length === 0) return 0;
  return Math.abs(sumProbabilities(prices) - 1) * 100;
}

// --- Display formatting (pure, deterministic) -------------------------------

/** Raw 6-decimal units → human USDC with 2 decimals. */
export function formatUsdc(raw: number, decimals = 6): string {
  return (raw / 10 ** decimals).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Probability 0–1 → "39.6%". */
export function formatPct(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}

/** Seconds → "4d 3h", "36m", "2h 5m". Negative values get a "-" prefix. */
export function formatDuration(totalSeconds: number): string {
  const neg = totalSeconds < 0;
  let s = Math.round(Math.abs(totalSeconds));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 && d === 0) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return (neg ? "-" : "") + parts.join(" ");
}

/** Shorten an address for prose: first 4 + "…" + last 4. Full address stays in evidence links. */
export function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
