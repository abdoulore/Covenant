/**
 * Covenant monitor: a READ-ONLY view over the treasury engine (Phase 2.4, read-first).
 *
 * This process holds no keys and mounts NO write endpoints. State comes from the shared read model
 * (src/api/readModel.ts), the same one the product API serves, so the monitor and the app never
 * drift. This file is now just the HTTP shell: it serves that state at /api/state and the static
 * frontend. See docs/specs/PHASE2_DASHBOARD.md and FRONTEND_B_APP.md.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReadState, readModelFromOptions } from "../api/readModel.js";
import { sendJson } from "../api/http.js";

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(here, "public");

const env = (n: string, fallback?: string): string => {
  const v = process.env[n] ?? fallback;
  if (!v) throw new Error(`${n} is not set.`);
  return v;
};

const deps = readModelFromOptions({
  rpcUrl: env("ARC_TESTNET_RPC_URL"),
  v3Address: process.env.POLICY_VAULT_V3_ADDRESS,
  v2Address: process.env.POLICY_VAULT_ADDRESS,
  feedId: process.env.PYTH_USDC_USD_FEED_ID ?? "",
  stateDir: join(process.cwd(), ".state"),
});

const CONTENT: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0] ?? "/";
  try {
    if (url === "/api/state") {
      sendJson(res, 200, await buildReadState(deps));
      return;
    }
    // Static frontend. Only GET, only from the public dir. No write routes exist.
    const file = url === "/" ? "index.html" : url.replace(/^\/+/, "");
    const ext = file.slice(file.lastIndexOf("."));
    const content = await readFile(join(PUBLIC_DIR, file));
    res.writeHead(200, { "content-type": CONTENT[ext] ?? "application/octet-stream" }).end(content);
  } catch (err: any) {
    res.writeHead(url.startsWith("/api") ? 500 : 404, { "content-type": "application/json" })
      .end(JSON.stringify({ error: err?.message ?? "not found" }));
  }
});

const PORT = Number(process.env.DASHBOARD_PORT ?? 4319);
server.listen(PORT, () => console.log(`Covenant monitor (read-only) on http://localhost:${PORT}`));
