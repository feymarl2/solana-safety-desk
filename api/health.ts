// Safety Desk — GET /api/health
// Liveness + static config. Never exposes secrets (there are none).

import { NETWORK, PM_AMM_PROGRAM_ID } from "../lib/constants.js";
import type { DeskRequest, DeskResponse } from "../lib/http.js";
import { ENGINE_VERSION } from "../lib/verdict.js";

export const config = { maxDuration: 10 };

export default function handler(
  _req: DeskRequest,
  res: DeskResponse,
): void {
  res.status(200).json({
    ok: true,
    network: NETWORK,
    programId: PM_AMM_PROGRAM_ID,
    engineVersion: ENGINE_VERSION,
    checksImplemented: 6,
    checksTotal: 6,
  });
}
