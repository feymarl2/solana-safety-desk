// Safety Desk — POST /api/check
// Body: { market: string } — a pm-AMM market account address on devnet.
// Returns the JSON verdict: score, band, per-check results, evidence.
//
// Guards: per-IP rate limit (60 checks/hour; read-only and free, so the
// cap only bounds abuse). No auth, no wallet, no secrets, no spend.
// Devnet only — there is no mainnet code path.

import type { DeskRequest, DeskResponse } from "../lib/http.js";
import { checkMarket, parseMarketAddress } from "../lib/verdict.js";

export const config = { maxDuration: 30 };

// --- Rate limiting (in-memory, per instance; demo-grade) ------------------
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 60;
const hits = new Map<string, { count: number; windowStart: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_MAX;
}

function clientIp(req: DeskRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  if (Array.isArray(forwarded) && forwarded[0]) return forwarded[0].split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

export default async function handler(
  req: DeskRequest,
  res: DeskResponse,
): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed. POST { market }." });
    return;
  }
  const ip = clientIp(req);
  if (rateLimited(ip)) {
    res
      .status(429)
      .json({ error: "Rate limited: 60 market checks per hour per client. Try again later." });
    return;
  }

  const { market } = (req.body ?? {}) as { market?: unknown };
  try {
    parseMarketAddress(market);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  try {
    const verdict = await checkMarket(market as string);
    res.status(200).json(verdict);
  } catch (err) {
    res.status(502).json({
      error: `Market check failed: ${(err as Error).message}`,
    });
  }
}
