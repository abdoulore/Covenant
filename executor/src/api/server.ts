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
import { sendJson, readJsonBody, parseCookies, serializeCookie, applyCors, clientIp, RateLimiter, TtlCache } from "./http.js";
import type { CreateResult, WriteResult, PayoutCurrencyName } from "./vaultService.js";
import { isVaultLabel, isWritable, PRIMARY_VAULT_LABEL, VAULT_LABELS, VAULTS, type VaultLabel } from "./vaults.js";

const SESSION_COOKIE = "cov_session";
const CURRENCIES: PayoutCurrencyName[] = ["USDC", "EURC"];

/** The write surface the server needs. VaultService satisfies it; tests pass a stub. */
export interface VaultServiceLike {
  createTimelock(input: any): Promise<CreateResult>;
  createApproval(input: any): Promise<CreateResult>;
  createAttestation(input: any): Promise<CreateResult>;
  createOracle(input: any): Promise<CreateResult>;
  createOraclePull(input: any): Promise<CreateResult>;
  createRecurring(input: any): Promise<CreateResult>;
  createSweep(input: any): Promise<CreateResult>;
  fund(vault: VaultLabel, policyId: string, amount: string): Promise<WriteResult>;
  approve(vault: VaultLabel, policyId: string): Promise<WriteResult>;
  release(vault: VaultLabel, policyId: string): Promise<WriteResult>;
  releaseWithProof(vault: VaultLabel, policyId: string): Promise<WriteResult>;
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
  /**
   * Login is limited far harder than writes, and separately.
   *
   * There is one operator and one shared secret, so the login route is the whole authentication
   * surface. Unlimited attempts against it is an offline-speed guess made online. Ten per minute
   * leaves a fat-fingered operator room and takes brute force off the table.
   */
  const loginLimiter = new RateLimiter(10, 60_000);
  /**
   * Reads are public, so they get a ceiling too. Generous, because the app polls legitimately and
   * the response is cached upstream anyway; this only stops one caller monopolising the process.
   */
  const readLimiter = new RateLimiter(120, 60_000);
  /** Idempotency records, bounded and expiring: the keys arrive in a header. */
  const idempotency = new TtlCache<Promise<{ status: number; body: unknown }>>(10 * 60_000, 1_000);

  const authed = (req: IncomingMessage): boolean => {
    if (config.devMode && !config.operatorSecret) return true; // explicit local-dev open path
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return verifyToken(config.operatorSecret, token);
  };

  const setSessionCookie = (res: ServerResponse) => {
    const token = issueToken(config.operatorSecret);
    res.setHeader("Set-Cookie", serializeCookie(SESSION_COOKIE, token, {
      // SameSite=None on a split deployment, or the browser never sends this back and every write
      // fails as unauthenticated. Secure is mandatory with None; secureCookies is already true
      // whenever crossOrigin is.
      httpOnly: true, sameSite: config.sameSite, secure: config.secureCookies, maxAgeSeconds: 12 * 3600,
    }));
  };

  /**
   * CSRF check for write routes.
   *
   * With SameSite=Strict the browser refuses to attach the session to a cross-site request and
   * nothing more is needed. A split deployment requires SameSite=None, which hands that protection
   * back, so the Origin header has to carry it: a forged request from another site announces its
   * true origin here, and a missing Origin means the request did not come from a browser page at
   * all. Only enforced when the cookie was relaxed, so a same-origin deployment keeps the simpler
   * rule and local dev is unaffected.
   */
  const originAllowed = (req: IncomingMessage): boolean => {
    if (!config.crossOrigin) return true;
    return req.headers.origin === config.corsOrigin;
  };

  /**
   * The contract's own words for a refusal, if it gave any.
   *
   * A custom error decodes to a name and arguments, but only into the cause chain: viem's
   * top-level `shortMessage` flattens to "the contract function reverted" and drops both. Reading
   * shortMessage alone therefore tells an operator that something was refused while withholding
   * what, which for a system whose whole claim is that refusals are legible is the wrong half to
   * keep. When the ABI cannot decode the revert, shortMessage still carries the raw signature and
   * remains the better answer, so this returns nothing and the caller falls back.
   */
  function decodedRevert(err: any): string | undefined {
    for (let e = err, depth = 0; e && depth < 6; e = e.cause, depth++) {
      const name = e?.data?.errorName;
      if (typeof name === "string" && name.length > 0) {
        const args = Array.isArray(e.data.args) ? e.data.args.map((a: unknown) => String(a)).join(", ") : "";
        return `${name}(${args})`;
      }
      if (typeof e?.reason === "string" && e.reason.length > 0) return e.reason;
    }
    return undefined;
  }

  /** Turn a thrown error into the response body the operator sees. */
  function errorResponse(err: any): { status: number; body: unknown } {
    if (err instanceof BadRequest) {
      return { status: 400, body: { error: "invalid request", message: err.message } };
    }
    // A contract revert or provider error: surface the reason verbatim plus a sentence. Never a
    // silent retry, and never a raw provider object.
    const verbatim = decodedRevert(err) ?? err?.shortMessage ?? err?.message ?? String(err);
    const status = /is not set|credentials|entity secret|api key/i.test(verbatim) ? 503 : 400;
    return {
      status,
      body: {
        error: status === 503 ? "service unavailable" : "write rejected",
        reason: verbatim,
        message: status === 503
          ? "The write service is not configured (credentials absent)."
          : "The chain rejected the write. The contract reason is in `reason`.",
      },
    };
  }

  /**
   * Run a write op with idempotency, rate limiting, and verbatim revert surfacing.
   *
   * The idempotency record is RESERVED before the op runs, not written after it finishes. Checking
   * a completed-results map and then awaiting leaves a window the width of a chain round trip in
   * which a second request with the same key sees nothing cached and executes the write again. For
   * a fund or a release that is the double execution the header exists to prevent, and a double
   * click is enough to hit it. Storing the in-flight promise makes the second caller wait on the
   * first request's outcome instead of starting a second one.
   *
   * A failed op releases its key, so a retry after a genuine failure is still possible.
   */
  async function runWrite(req: IncomingMessage, res: ServerResponse, op: () => Promise<unknown>) {
    if (!writeLimiter.allow(clientIp(req))) {
      sendJson(res, 429, { error: "rate limited", message: "Too many writes, slow down." });
      return;
    }

    const header = req.headers["idempotency-key"];
    const key = typeof header === "string" && header.length > 0 ? header : undefined;

    if (key) {
      const inflight = idempotency.get(key);
      if (inflight) {
        const settled = await inflight;
        sendJson(res, settled.status, settled.body);
        return;
      }
    }

    const run = (async () => {
      try {
        return { status: 200, body: await op() };
      } catch (err: any) {
        return errorResponse(err);
      }
    })();

    if (key) {
      idempotency.set(key, run);
      // Release the key once the outcome is known to be a failure, so a retry is still possible.
      // Registered after the set, never inside the op, so the two cannot race.
      void run.then((settled) => {
        if (settled.status !== 200) idempotency.delete(key);
      });
    }

    const settled = await run;
    sendJson(res, settled.status, settled.body);
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    const method = req.method ?? "GET";

    if (applyCors(req, res, config.corsOrigin)) return; // preflight handled

    try {
      /**
       * Liveness, for a platform health check.
       *
       * Deliberately touches nothing: no chain read, no Circle call, no settlement store. A health
       * check runs on a schedule forever, and pointing one at /api/state would bill a full pass over
       * every policy on every probe. It answers "is this process up", which is the only question a
       * restart policy can act on.
       */
      if (method === "GET" && url === "/api/health") {
        sendJson(res, 200, { ok: true, service: "covenant-api", uptimeSeconds: Math.round(process.uptime()) });
        return;
      }

      // ---- public read ----
      if (method === "GET" && url === "/api/state") {
        if (!readLimiter.allow(clientIp(req))) {
          sendJson(res, 429, { error: "rate limited", message: "Too many reads, slow down." });
          return;
        }
        sendJson(res, 200, await deps.readState());
        return;
      }

      // ---- session ----
      /**
       * Is the session this browser is holding still good?
       *
       * The cookie is HttpOnly, which is the point of it and also the reason the app cannot answer
       * this for itself. Without somewhere to ask, a reload renders as read-only while every write
       * would in fact have been accepted, and the operator is told they are signed out by a page
       * that simply forgot. This reports on nothing but the cookie the caller already sent, so it
       * discloses nothing they did not arrive with.
       *
       * Rate limited alongside the other public reads. It touches no chain and no store, but it
       * does verify a token, and an unauthenticated route that verifies anything gets a ceiling.
       */
      if (method === "GET" && url === "/api/session") {
        if (!readLimiter.allow(clientIp(req))) {
          sendJson(res, 429, { error: "rate limited", message: "Too many reads, slow down." });
          return;
        }
        sendJson(res, 200, { signedIn: authed(req) });
        return;
      }
      if (method === "POST" && url === "/api/session") {
        // Login mints the session, so it is a write for CSRF purposes and gets the same check.
        if (!originAllowed(req)) {
          sendJson(res, 403, {
            error: "origin not allowed",
            message: "Sign-in must come from the pinned application origin.",
          });
          return;
        }
        // Limited before the body is read, so a flood costs nothing to refuse.
        if (!loginLimiter.allow(clientIp(req))) {
          sendJson(res, 429, { error: "rate limited", message: "Too many sign-in attempts. Wait a minute." });
          return;
        }
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
        if (!originAllowed(req)) {
          sendJson(res, 403, {
            error: "origin not allowed",
            message: "Writes must come from the pinned application origin.",
          });
          return;
        }
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
            if (body.type === "oraclePull") {
              if (!isAddress(body.recipient)) throw new BadRequest("recipient must be a 0x address");
              if (!isBaseUnits(body.amount)) throw new BadRequest("amount must be a positive base-unit string");
              if (body.feedKey !== "USDC/USD") throw new BadRequest('feedKey must be "USDC/USD" (the only supported feed in v1)');
              if (typeof body.comparator !== "string" || !COMPARATORS.includes(body.comparator)) throw new BadRequest("comparator must be Gte or Lte");
              // 1e18, not the feed's 8 decimals: the adapter normalizes before the vault compares.
              if (!isBaseUnits(body.threshold1e18)) throw new BadRequest("threshold1e18 must be a positive integer string in 1e18 scale");
              if (!isPosInt(body.maxStaleSeconds)) throw new BadRequest("maxStaleSeconds must be a positive integer");
              if (!isNonNegInt(body.maxConfBps) || body.maxConfBps > 10_000) {
                throw new BadRequest("maxConfBps must be an integer between 0 and 10000 (0 disables the guard)");
              }
              return svc.createOraclePull({
                recipient: body.recipient, amount: body.amount, payoutCurrency: requireCurrency(body.payoutCurrency),
                destinationDomain: Number(body.destinationDomain), comparator: body.comparator,
                threshold1e18: body.threshold1e18, maxStaleSeconds: body.maxStaleSeconds, maxConfBps: body.maxConfBps,
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
            throw new BadRequest('type must be one of timelock, approval, attestation, oracle, oraclePull, recurring, sweep');
          });
          return;
        }

        /**
         * Lifecycle writes name their vault: /api/policies/:vault/:id/:action.
         *
         * The vault is part of the address of a policy, not decoration. More than one PolicyVault
         * deployment is live (the contract is immutable), each numbers its policies from zero, and
         * the read model serves all of them. A route carrying only the id would send a fund or a
         * release to whichever deployment the service was pointed at, which for any policy the
         * operator was actually looking at on an older vault means paying a different recipient.
         */
        const m = url.match(/^\/api\/policies\/([a-z0-9]+)\/(\d+)\/(fund|approve|release|releaseWithProof)$/);
        if (m) {
          const vault = m[1]!;
          const policyId = m[2]!;
          const action = m[3]!;
          const body = action === "fund" ? await readJsonBody(req) : {};
          await runWrite(req, res, async () => {
            if (!isVaultLabel(vault)) {
              throw new BadRequest(`unknown vault "${vault}". Known vaults: ${VAULT_LABELS.join(", ")}`);
            }
            // Refused here as well as in the service, so the reason reads as a bad request rather
            // than a chain error, and so the app is not the only thing stopping it.
            if (!isWritable(vault)) {
              throw new BadRequest(
                `${vault} is read-only. ${VAULTS[vault].note} Writes go to ${PRIMARY_VAULT_LABEL}.`,
              );
            }
            const svc = await deps.getService();
            if (action === "fund") {
              if (!isBaseUnits(body.amount)) throw new BadRequest("amount must be a positive base-unit string");
              return svc.fund(vault, policyId, body.amount);
            }
            if (action === "approve") return svc.approve(vault, policyId);
            if (action === "releaseWithProof") return svc.releaseWithProof(vault, policyId);
            return svc.release(vault, policyId);
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
