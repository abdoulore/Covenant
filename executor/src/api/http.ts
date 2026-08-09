/**
 * Small HTTP helpers for the Covenant API (Frontend Part B). No web framework, matching the
 * monitor's node:http precedent, so the API adds no runtime dependency.
 *
 * These are pure and side-effect free where they can be (cookie parsing, CORS decision, the rate
 * limiter's accounting), so they are unit-tested without a live server.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

/** Serialize a value to a JSON HTTP response. bigint is stringified, never thrown on. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, { "content-type": "application/json" }).end(json);
}

/** Read and parse a JSON request body, bounded so a large body cannot exhaust memory. */
export async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Parse a Cookie header into a map. Tolerant of missing/malformed input. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export interface CookieOptions {
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  secure?: boolean;
  path?: string;
  maxAgeSeconds?: number;
}

/** Serialize a Set-Cookie value. Defaults are the safe ones: HttpOnly, SameSite=Strict, Path=/. */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const p: string[] = [`${name}=${encodeURIComponent(value)}`];
  p.push(`Path=${opts.path ?? "/"}`);
  p.push(`SameSite=${opts.sameSite ?? "Strict"}`);
  if (opts.httpOnly ?? true) p.push("HttpOnly");
  if (opts.secure) p.push("Secure");
  if (opts.maxAgeSeconds != null) p.push(`Max-Age=${opts.maxAgeSeconds}`);
  return p.join("; ");
}

/**
 * Apply CORS for a single pinned origin, and answer preflight. Returns true when the request was a
 * preflight and has been fully handled (the caller should stop). Credentials are allowed because
 * the session cookie must travel, which is exactly why the origin is a single pinned value and
 * never a wildcard: a wildcard with credentials is both invalid and unsafe.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse, allowedOrigin: string): boolean {
  const origin = req.headers.origin;
  if (origin && origin === allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type, idempotency-key");
    res.setHeader("Access-Control-Max-Age", "600");
    res.writeHead(204).end();
    return true;
  }
  return false;
}

/** The client IP, honoring a single trusted proxy hop if present. */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0];
    if (first) return first.trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * A fixed-window rate limiter. Deliberately simple and in-process: v1 is a single-operator API, so
 * this is abuse protection, not a distributed quota. Returns false when the caller is over budget.
 *
 * Keys are caller-supplied (an IP), so the map is swept as it goes. An unbounded map keyed by
 * anything an unauthenticated caller controls is a slow memory leak with a name: the process that
 * has been up longest is the one that falls over.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; windowStart: number }>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    this.sweep(now);
    const rec = this.hits.get(key);
    if (!rec || now - rec.windowStart >= this.windowMs) {
      this.hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    rec.count += 1;
    return rec.count <= this.limit;
  }

  /** Visible for tests: how many keys are currently held. */
  get size(): number {
    return this.hits.size;
  }

  /** Drop windows that have expired. Amortised: at most once per window. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, rec] of this.hits) {
      if (now - rec.windowStart >= this.windowMs) this.hits.delete(key);
    }
  }
}

/**
 * A bounded, expiring map.
 *
 * Used for idempotency records, whose keys come straight off a request header. Without a TTL and a
 * ceiling, any caller can grow the process's memory one header at a time, and nothing ever frees
 * it: the entries are only useful for as long as a client might retry.
 *
 * Eviction is oldest-first by insertion, which Map iteration gives for free.
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get(key: string, now = Date.now()): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    this.sweep(now);
    this.entries.delete(key); // re-insert so eviction order tracks last write
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
