// Safety Desk — minimal HTTP handler types.
//
// Vercel Node functions receive (req, res) objects; these structural
// interfaces cover exactly the surface our handlers use, so the app needs
// no @vercel/node dependency. The local dev server (scripts/local-server.ts)
// implements the same shape, so handlers run identically locally and on
// Vercel.

export interface DeskRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  /** Parsed JSON body (Vercel parses it; the local server parses it too). */
  body?: unknown;
}

export interface DeskResponse {
  status(code: number): DeskResponse;
  json(body: unknown): void;
}

export type DeskHandler = (
  req: DeskRequest,
  res: DeskResponse,
) => Promise<void> | void;
