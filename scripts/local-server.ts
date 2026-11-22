// Safety Desk — local dev server (no Vercel CLI / login needed).
// Serves public/ statically and runs the real api/ handlers behind a
// minimal req/res shim implementing the lib/http.ts shape, so `curl`
// smoke tests exercise the exact code Vercel will run.
// Run: npm run dev   (then open http://localhost:3000)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import checkHandler from "../api/check.js";
import healthHandler from "../api/health.js";
import type { DeskRequest, DeskResponse } from "../lib/http.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT ?? 3000);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

function shim(req: IncomingMessage, res: ServerResponse, body: unknown): { deskReq: DeskRequest; deskRes: DeskResponse } {
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) headers[key] = value;
  const deskReq: DeskRequest = {
    method: req.method,
    headers,
    socket: { remoteAddress: req.socket.remoteAddress },
    body,
  };
  let statusCode = 200;
  const deskRes: DeskResponse = {
    status(code: number) {
      statusCode = code;
      return deskRes;
    },
    json(payload: unknown) {
      res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(payload));
    },
  };
  return { deskReq, deskRes };
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (url.pathname === "/api/check" || url.pathname === "/api/health") {
      const body = req.method === "POST" ? await readJsonBody(req) : undefined;
      const { deskReq, deskRes } = shim(req, res, body);
      const handler = url.pathname === "/api/check" ? checkHandler : healthHandler;
      await handler(deskReq, deskRes);
      return;
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      res.writeHead(404).end("Not found");
      return;
    }
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Internal error" }));
  }
});

server.listen(PORT, () => {
  console.log(`Safety Desk dev server: http://localhost:${PORT}`);
});
