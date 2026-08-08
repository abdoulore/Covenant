/**
 * The Covenant write API (Frontend Part B). See docs/DECISIONS.md D12 and FRONTEND_B_APP.md.
 *
 * Reads are public (GET /api/state), exactly as the monitor is. Every write is gated by the operator
 * session and validated before it reaches the chain. A contract revert is surfaced verbatim plus a
 * human sentence, never swallowed. Mutations are idempotent by an Idempotency-Key header.
 *
 * This module has NO import side effects: it exports a factory that takes injected dependencies, so
 * the routing, auth gating, and validation are unit-tested with stubs, no chain and no Circle. The
 * real wiring and listen() live in start.ts.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { ApiConfig } from "./apiConfig.js";
import { issueToken, verifyToken, checkOperatorSecret } from "./session.js";
import { sendJson, readJsonBody, parseCookies, serializeCookie, applyCors, clientIp, RateLimiter } from "./http.js";
import type { CreateResult, WriteResult, PayoutCurrencyName } from "./vaultService.js";

const SESSION_COOKIE = "cov_session";
const CURRENCIES: PayoutCurrencyName[] = ["USDC", "EURC"];

/** The write surface the server needs. VaultService satisfies it; tests pass a stub. */
export interface VaultServiceLike {
  createTimelock(input: any): Promise<CreateResult>;
  createApproval(input: any): Promise<CreateResult>;
  createAttestation(input: any): Promise<CreateResult>;
  createOracle(input: any): Promise<CreateResult>;
  createRecurring(input: any): Promise<CreateResult>;
  createSweep(input: any): Promise<CreateResult>;
  fund(policyId: string, amount: string): Promise<WriteResult>;
  approve(policyId: string): Promise<WriteResult>;
  release(policyId: string): Promise<WriteResult>;
}

export interface ApiDeps {
  config: ApiConfig;
  /** Build the read-only state (the shared read model). */
  readState: () => Promise<unknown>;
  /** Lazily resolve the write service. May reject if credentials are absent; that surfaces as 503. */
  getService: () => Promise<VaultServiceLike>;
}

// ---- validation helpers -------------------------------------------------

const isAddress = (v: unknown): v is `0x${string}` => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isBaseUnits = (v: unknown): v is string => typeof v === "string" && /^[0-9]+$/.test(v) && v !== "0";
const isNonNegBaseUnits = (v: unknown): v is string => typeof v === "string" && /^[0-9]+$/.test(v);
const isUnixTime = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const COMPARATORS = ["Gte", "Lte"];

class BadRequest extends Error {}

function requireCurrency(v: unknown): PayoutCurrencyName {
  if (typeof v === "string" && (CURRENCIES as string[]).includes(v)) return v as PayoutCurrencyName;
  throw new BadRequest(`payoutCurrency must be one of ${CURRENCIES.join(", ")}`);
}

// ---- the handler --------------------------------------------------------

export function createRequestHandler(deps: ApiDeps) {
  const { config } = deps;
  const writeLimiter = new RateLimiter(30, 60_000); // 30 writes per IP per minute
  const idempotency = new Map<string, { status: number; body: unknown }>();

  const authed = (req: IncomingMessage): boolean => {
    if (config.devMode && !config.operatorSecret) return true; // explicit local-dev open path
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return verifyToken(config.operatorSecret, token);
  };

  const setSessionCookie = (res: ServerResponse) => {
    const token = issueToken(config.operatorSecret);
    res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, token, {
      httpOnly: true, sameSite: "Strict", secure: config.secureCookies, maxAgeSeconds: 12 * 3600,
    }));
  };

  /** Run a write op with idempotency, rate limiting, and verbatim revert surfacing. */
  async function runWrite(req: IncomingMessage, res: ServerResponse, op: () => Promise<unknown>) {
    if (!writeLimiter.allow(clientIp(req))) {
      sendJson(res, 429, { error: "rate limited", message: "Too many writes, slow down." });
      return;
    }
    const key = req.headers["idempotency-key"];
    if (typeof key === "string" && idempotency.has(key)) {
      const cached = idempotency.get(key)!;
      sendJson(res, cached.status, cached.body);
      return;
    }
    try {
      const result = await op();
      if (typeof key === "string") idempotency.set(key, { status: 200, body: result });
      sendJson(res, 200, result);
    } catch (err: any) {
      if (err instanceof BadRequest) {
        sendJson(res, 400, { error: "invalid request", message: err.message });
        return;
      }
      // A contract revert or provider error: surface the reason verbatim plus a sentence. Never a
      // silent retry, and never a raw provider object.
      const verbatim = err?.shortMessage ?? err?.message ?? String(err);
      const status = /is not set|credentials|entity secret|api key/i.test(verbatim) ? 503 : 400;
      sendJson(res, status, {
        error: status === 503 ? "service unavailable" : "write rejected",
        reason: verbatim,
        message: status === 503
          ? "The write service is not configured (credentials absent)."
          : "The chain rejected the write. The contract reason is in `reason`.",
      });
    }
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    const method = req.method ?? "GET";

    if (applyCors(req, res, config.corsOrigin)) return; // preflight handled

    try {
      // ---- public read ----
      if (method === "GET" && url === "/api/state") {
        sendJson(res, 200, await deps.readState());
        return;
      }

      // ---- session ----
      if (method === "POST" && url === "/api/session") {
        const body = await readJsonBody(req);
        if (!config.operatorSecret) { sendJson(res, 503, { error: "auth not configured" }); return; }
        if (typeof body.secret !== "string" || !checkOperatorSecret(body.secret, config.operatorSecret)) {
          sendJson(res, 401, { error: "invalid operator secret" });
          return;
        }
        setSessionCookie(res);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (method === "DELETE" && url === "/api/session") {
        res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, "", { maxAgeSeconds: 0, secure: config.secureCookies }));
        sendJson(res, 200, { ok: true });
        return;
      }

      // ---- writes (all gated) ----
      if (url.startsWith("/api/policies") && method === "POST") {
        if (!authed(req)) { sendJson(res, 401, { error: "operator session required" }); return; }

        if (url === "/api/policies") {
          const body = await readJsonBody(req);
          await runWrite(req, res, async () => {
            const svc = await deps.getService();
            if (body.type === "timelock") {
              if (!isAddress(body.recipient)) throw new BadRequest("recipient must be a 0x address");
              if (!isBaseUnits(body.amount)) throw new BadRequest("amount must be a positive base-unit string");
              if (!isUnixTime(body.releaseTime)) throw new BadRequest("releaseTime must be a positive unix timestamp");
              return svc.createTimelock({
                recipient: body.recipient, amount: body.amount, payoutCurrency: requireCurrency(body.payoutCurrency),
                destinationDomain: Number(body.destinationDomain), releaseTime: body.releaseTime,
              });
            }
            if (body.type === "approval") {
              if (!isAddress(body.recipient)) throw new BadRequest("recipient must be a 0x address");
              if (!isBaseUnits(body.amount)) throw new BadRequest("amount must be a positive base-unit string");
              if (!Array.isArray(body.approvers) || body.approvers.length === 0 || !body.approvers.every(isAddress)) {
                throw new BadRequest("approvers must be a non-empty array of 0x addresses");
              }
              const threshold = Number(body.threshold);
              if (!Number.isInteger(threshold) || threshold < 1 || threshold > body.approvers.length) {
                throw new BadRequest("threshold must be an integer between 1 and the number of approvers");
              }
              return svc.createApproval({
                recipient: body.recipient, amount: body.amount, payoutCurrency: requireCurrency(body.payoutCurrency),
                destinationDomain: Number(body.destinationDomain), approvers: body.approvers, threshold,
              });
            }
            if (body.type === "attestation") {
              if (!isAddress(body.recipient)) throw new BadRequest("recipient must be a 0x address");
              if (!isBaseUnits(body.amount)) throw new BadRequest("amount must be a positive base-unit string");
              if (!isAddress(body.attester)) throw new BadRequest("attester must be a 0x address");
              return svc.createAttestation({
                recipient: body.recipient, amount: body.amount, payoutCurrency: requireCurrency(body.payoutCurrency),
                destinationDomain: Number(body.destinationDomain), attester: body.attester,
              });
            }
            if (body.type === "oracle") {
              if (!isAddress(body.recipient)) throw new BadRequest("recipient must be a 0x address");
              if (!isBaseUnits(body.amount)) throw new BadRequest("amount must be a positive base-unit string");
              if (body.feedKey !== "USDC/USD") throw new BadRequest('feedKey must be "USDC/USD" (the only supported feed in v1)');
              if (typeof body.comparator !== "string" || !COMPARATORS.includes(body.comparator)) throw new BadRequest("comparator must be Gte or Lte");
              if (!isBaseUnits(body.threshold)) throw new BadRequest("threshold must be a positive integer string in the feed's 8 decimals");
              if (!isPosInt(body.maxStaleSeconds)) throw new BadRequest("maxStaleSeconds must be a positive integer");
              return svc.createOracle({
                recipient: body.recipient, amount: body.amount, payoutCurrency: requireCurrency(body.payoutCurrency),
                destinationDomain: Number(body.destinationDomain), comparator: body.comparator, threshold: body.threshold, maxStaleSeconds: body.maxStaleSeconds,
              });
            }
            if (body.type === "recurring") {
              if (!isAddress(body.recipient)) throw new BadRequest("recipient must be a 0x address");
              if (!isBaseUnits(body.amountPerPeriod)) throw new BadRequest("amountPerPeriod must be a positive base-unit string");
              if (!isPosInt(body.interval)) throw new BadRequest("interval must be a positive integer (seconds)");
              if (!isUnixTime(body.startTime)) throw new BadRequest("startTime must be a positive unix timestamp");
              if (!isNonNegInt(body.periods)) throw new BadRequest("periods must be a non-negative integer (0 = open-ended)");
              if (!isPosInt(body.maxCatchUp)) throw new BadRequest("maxCatchUp must be a positive integer (seconds)");
              return svc.createRecurring({
                recipient: body.recipient, payoutCurrency: requireCurrency(body.payoutCurrency), destinationDomain: Number(body.destinationDomain),
                amountPerPeriod: body.amountPerPeriod, interval: body.interval, startTime: body.startTime, periods: body.periods, maxCatchUp: body.maxCatchUp,
              });
            }
            if (body.type === "sweep") {
              if (!isAddress(body.recipient)) throw new BadRequest("recipient must be a 0x address");
              if (!isNonNegBaseUnits(body.buffer)) throw new BadRequest("buffer must be a base-unit string (0 or more)");
              if (!isBaseUnits(body.minSweep)) throw new BadRequest("minSweep must be a positive base-unit string");
              if (!isPosInt(body.interval)) throw new BadRequest("interval must be a positive integer (seconds)");
              if (!isUnixTime(body.startTime)) throw new BadRequest("startTime must be a positive unix timestamp");
              if (!isPosInt(body.maxCatchUp)) throw new BadRequest("maxCatchUp must be a positive integer (seconds)");
              return svc.createSweep({
                recipient: body.recipient, payoutCurrency: requireCurrency(body.payoutCurrency), destinationDomain: Number(body.destinationDomain),
                buffer: body.buffer, minSweep: body.minSweep, interval: body.interval, startTime: body.startTime, maxCatchUp: body.maxCatchUp,
              });
            }
            throw new BadRequest('type must be one of timelock, approval, attestation, oracle, recurring, sweep');
          });
          return;
        }

        const m = url.match(/^\/api\/policies\/(\d+)\/(fund|approve|release)$/);
        if (m) {
          const policyId = m[1]!;
          const action = m[2]!;
          const body = action === "fund" ? await readJsonBody(req) : {};
          await runWrite(req, res, async () => {
            const svc = await deps.getService();
            if (action === "fund") {
              if (!isBaseUnits(body.amount)) throw new BadRequest("amount must be a positive base-unit string");
              return svc.fund(policyId, body.amount);
            }
            if (action === "approve") return svc.approve(policyId);
            return svc.release(policyId);
          });
          return;
        }
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err: any) {
      sendJson(res, 400, { error: "bad request", message: err?.message ?? String(err) });
    }
  };
}

export function createApiServer(deps: ApiDeps): Server {
  return createServer(createRequestHandler(deps));
}
