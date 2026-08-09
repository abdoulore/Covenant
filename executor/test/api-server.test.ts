import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApiServer, type VaultServiceLike } from "../src/api/server.js";
import { loadApiConfig } from "../src/api/apiConfig.js";

// A stub write service that records calls, so the server's routing/auth/validation is tested with
// no chain and no Circle.
class StubService implements VaultServiceLike {
  calls: string[] = [];
  /** Set to make the next lifecycle write hang until `open` is called, for concurrency tests. */
  gate?: { promise: Promise<void>; open: () => void } | undefined;

  private async waitForGate() {
    if (this.gate) await this.gate.promise;
  }

  async createTimelock(input: any) { this.calls.push("createTimelock"); return { policyId: "7", txHash: "0xabc", explorerUrl: "u" }; }
  async createApproval(input: any) { this.calls.push("createApproval"); await this.waitForGate(); return { policyId: "8", txHash: "0xdef", explorerUrl: "u" }; }
  async createAttestation(input: any) { this.calls.push("createAttestation"); return { policyId: "9", txHash: "0x1", explorerUrl: "u" }; }
  async createOracle(input: any) { this.calls.push("createOracle"); return { policyId: "10", txHash: "0x2", explorerUrl: "u" }; }
  async createOraclePull(input: any) { this.calls.push(`createOraclePull:${input.threshold1e18}:${input.maxConfBps}`); return { policyId: "13", txHash: "0x5", explorerUrl: "u" }; }
  async createRecurring(input: any) { this.calls.push("createRecurring"); return { policyId: "11", txHash: "0x3", explorerUrl: "u" }; }
  async createSweep(input: any) { this.calls.push("createSweep"); return { policyId: "12", txHash: "0x4", explorerUrl: "u" }; }
  async fund(vault: string, policyId: string, amount: string) { this.calls.push(`fund:${vault}:${policyId}:${amount}`); await this.waitForGate(); return { txHash: "0xf", explorerUrl: "u" }; }
  async approve(vault: string, policyId: string) { this.calls.push(`approve:${vault}:${policyId}`); return { txHash: "0xa", explorerUrl: "u" }; }
  async release(vault: string, policyId: string) { this.calls.push(`release:${vault}:${policyId}`); return { txHash: "0xr", explorerUrl: "u" }; }
  async releaseWithProof(vault: string, policyId: string) { this.calls.push(`releaseWithProof:${vault}:${policyId}`); return { txHash: "0xp", explorerUrl: "u" }; }
}

function openableGate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

const SECRET = "test-operator-secret";
let server: Server;
let base: string;
let stub: StubService;
/**
 * One session for the whole file.
 *
 * Logging in per test would spend the login rate-limit budget, which is deliberately small: the
 * route is the entire authentication surface. Tests share a cookie the way an operator shares a
 * session, and the limiter gets its own server below.
 */
let cookie: string;

/** Start an API server on an ephemeral port. Each one gets its own in-process rate limiters. */
async function startServer(service: VaultServiceLike): Promise<{ server: Server; base: string }> {
  // devMode true but a secret set, so auth is still enforced (not the open dev path).
  const config = loadApiConfig({ COVENANT_ENV: "dev", OPERATOR_SECRET: SECRET });
  const s = createApiServer({
    config,
    readState: async () => ({ ok: true, policies: [], settlements: [], oracle: null }),
    getService: async () => service,
  });
  await new Promise<void>((r) => s.listen(0, r));
  const { port } = s.address() as AddressInfo;
  return { server: s, base: `http://127.0.0.1:${port}` };
}

async function login(at = base): Promise<string> {
  const res = await fetch(`${at}/api/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: SECRET }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/cov_session=([^;]+)/);
  expect(m).not.toBeNull();
  return `cov_session=${m![1]}`;
}

beforeAll(async () => {
  stub = new StubService();
  ({ server, base } = await startServer(stub));
  cookie = await login();
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("read route", () => {
  it("serves state publicly with no auth", async () => {
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);
  });
});

describe("health check", () => {
  /** A platform probe runs forever, so it must not cost a chain read. */
  it("answers without touching the read model or the chain", async () => {
    let readStateCalls = 0;
    const probe = createApiServer({
      config: loadApiConfig({ COVENANT_ENV: "dev", OPERATOR_SECRET: SECRET }),
      readState: async () => { readStateCalls++; return {}; },
      getService: async () => { throw new Error("health must not resolve the write service"); },
    });
    await new Promise<void>((r) => probe.listen(0, r));
    const { port } = probe.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);
    expect(readStateCalls).toBe(0);

    await new Promise<void>((r) => probe.close(() => r()));
  });
});

describe("session", () => {
  it("rejects a wrong operator secret", async () => {
    const res = await fetch(`${base}/api/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "wrong" }),
    });
    expect(res.status).toBe(401);
  });

  it("issues an HttpOnly session cookie for the right secret", async () => {
    const res = await fetch(`${base}/api/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: SECRET }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/);
  });

  /**
   * The cookie is HttpOnly, so the app cannot read it and has no way to know it is still signed in
   * after a reload. GET answers exactly that, and nothing else.
   */
  describe("GET reports whether the cookie is still good", () => {
    const askWith = (headers: Record<string, string> = {}) => fetch(`${base}/api/session`, { headers });

    it("reports signed out when no cookie is sent", async () => {
      const res = await askWith();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ signedIn: false });
    });

    it("reports signed in for a live session cookie", async () => {
      const res = await askWith({ cookie });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ signedIn: true });
    });

    /** The same verification the write routes use, so it cannot report a session they would refuse. */
    it("reports signed out for a forged cookie", async () => {
      const [payload] = cookie.replace("cov_session=", "").split(".");
      const res = await askWith({ cookie: `cov_session=${payload}.deadbeef` });
      expect(await res.json()).toEqual({ signedIn: false });
    });

    /** It answers about a cookie; it must never be a way to obtain one. */
    it("never issues a session of its own", async () => {
      expect((await askWith()).headers.get("set-cookie")).toBeNull();
      expect((await askWith({ cookie })).headers.get("set-cookie")).toBeNull();
    });

    it("costs no chain read", async () => {
      let readStateCalls = 0;
      const probe = createApiServer({
        config: loadApiConfig({ COVENANT_ENV: "dev", OPERATOR_SECRET: SECRET }),
        readState: async () => { readStateCalls++; return {}; },
        getService: async () => { throw new Error("a session check must not resolve the write service"); },
      });
      await new Promise<void>((r) => probe.listen(0, r));
      const { port } = probe.address() as AddressInfo;

      const res = await fetch(`http://127.0.0.1:${port}/api/session`);
      expect(res.status).toBe(200);
      expect(readStateCalls).toBe(0);

      await new Promise<void>((r) => probe.close(() => r()));
    });
  });
});

describe("write gating", () => {
  it("rejects a create with no session", async () => {
    const res = await fetch(`${base}/api/policies`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "timelock" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects release with no session", async () => {
    const res = await fetch(`${base}/api/policies/v3/3/release`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("validates the body before touching the service", async () => {

    const res = await fetch(`${base}/api/policies`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ type: "timelock", recipient: "not-an-address", amount: "100", payoutCurrency: "USDC", destinationDomain: 26, releaseTime: 123 }),
    });
    expect(res.status).toBe(400);
    expect(stub.calls).not.toContain("createTimelock");
  });

  it("creates a timelock with a valid body and a session", async () => {

    const res = await fetch(`${base}/api/policies`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ type: "timelock", recipient: "0x" + "1".repeat(40), amount: "100000", payoutCurrency: "USDC", destinationDomain: 26, releaseTime: 2_000_000_000 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).policyId).toBe("7");
    expect(stub.calls).toContain("createTimelock");
  });

  it("honors an idempotency key: a repeat does not call the service twice", async () => {

    stub.calls = [];
    const body = JSON.stringify({ type: "approval", recipient: "0x" + "2".repeat(40), amount: "100000", payoutCurrency: "USDC", destinationDomain: 26, approvers: ["0x" + "3".repeat(40)], threshold: 1 });
    const headers = { "content-type": "application/json", cookie, "idempotency-key": "key-xyz" };
    const r1 = await fetch(`${base}/api/policies`, { method: "POST", headers, body });
    const r2 = await fetch(`${base}/api/policies`, { method: "POST", headers, body });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(stub.calls.filter((c) => c === "createApproval").length).toBe(1);
  });

  it("routes fund and release to the service with a session", async () => {

    stub.calls = [];
    const f = await fetch(`${base}/api/policies/v4/5/fund`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ amount: "50000" }),
    });
    expect(f.status).toBe(200);
    const rel = await fetch(`${base}/api/policies/v4/5/release`, { method: "POST", headers: { cookie } });
    expect(rel.status).toBe(200);
    expect(stub.calls).toContain("fund:v4:5:50000");
    expect(stub.calls).toContain("release:v4:5");
  });
});

/**
 * The vault is part of a policy's identity. Every deployment numbers its policies from zero, so a
 * write that lost the vault would land on the same-numbered policy somewhere else: a different
 * policy, with a different recipient.
 */
describe("vault targeting", () => {
  it("carries the vault through to the service", async () => {
    stub.calls = [];

    await fetch(`${base}/api/policies/v4/4/fund`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ amount: "1" }),
    });
    const rel = await fetch(`${base}/api/policies/v4/4/release`, { method: "POST", headers: { cookie } });

    expect(rel.status).toBe(200);
    expect(stub.calls).toEqual(["fund:v4:4:1", "release:v4:4"]);
  });

  it("rejects an unknown vault label without touching the service", async () => {
    stub.calls = [];
    const res = await fetch(`${base}/api/policies/v9/4/release`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(400);
    expect((await res.json() as any).message).toMatch(/unknown vault/i);
    expect(stub.calls).toEqual([]);
  });

  /**
   * Superseded deployments are read, so their labels are valid, but their policies were cancelled
   * and refunded during the v4 migration and their record is closed. The refusal lives here as well
   * as in the app, so a hand-made request cannot reopen them.
   */
  it("refuses every write to a read-only deployment", async () => {
    for (const vault of ["v3", "v2"]) {
      for (const [action, body] of [["fund", { amount: "1" }], ["approve", {}], ["release", {}]] as const) {
        stub.calls = [];
        const res = await fetch(`${base}/api/policies/${vault}/4/${action}`, {
          method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body),
        });
        expect(res.status, `${vault}/${action}`).toBe(400);
        expect((await res.json() as any).message).toMatch(/read-only/i);
        expect(stub.calls, `${vault}/${action} must not reach the service`).toEqual([]);
      }
    }
  });

  it("no longer serves the vault-less route", async () => {
    stub.calls = [];
    const res = await fetch(`${base}/api/policies/4/release`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(404);
    expect(stub.calls).toEqual([]);
  });
});

describe("pull-oracle routes", () => {
  it("creates a pull-oracle policy in 1e18 scale with a confidence bound", async () => {
    stub.calls = [];
    const res = await fetch(`${base}/api/policies`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        type: "oraclePull", recipient: "0x" + "4".repeat(40), amount: "100000", payoutCurrency: "USDC",
        destinationDomain: 26, feedKey: "USDC/USD", comparator: "Gte",
        threshold1e18: "995000000000000000", maxStaleSeconds: 60, maxConfBps: 50,
      }),
    });
    expect(res.status).toBe(200);
    expect(stub.calls).toContain("createOraclePull:995000000000000000:50");
  });

  it("rejects a confidence bound above 100 percent, which could never refuse anything", async () => {
    stub.calls = [];
    const res = await fetch(`${base}/api/policies`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        type: "oraclePull", recipient: "0x" + "4".repeat(40), amount: "100000", payoutCurrency: "USDC",
        destinationDomain: 26, feedKey: "USDC/USD", comparator: "Gte",
        threshold1e18: "995000000000000000", maxStaleSeconds: 60, maxConfBps: 10_001,
      }),
    });
    expect(res.status).toBe(400);
    expect(stub.calls).toEqual([]);
  });

  it("routes releaseWithProof separately from release", async () => {
    stub.calls = [];
    const res = await fetch(`${base}/api/policies/v4/9/releaseWithProof`, { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(stub.calls).toEqual(["releaseWithProof:v4:9"]);
  });
});

describe("idempotency under concurrency", () => {
  /**
   * The regression that matters: two requests in flight at once, not one after the other. A cache
   * written only after the op completes leaves both callers seeing an empty cache, and both paying.
   */
  it("collapses simultaneous requests with the same key into one execution", async () => {

    stub.calls = [];
    stub.gate = openableGate();

    const headers = { "content-type": "application/json", cookie, "idempotency-key": "concurrent-1" };
    const body = JSON.stringify({ amount: "9" });
    const a = fetch(`${base}/api/policies/v4/6/fund`, { method: "POST", headers, body });
    const b = fetch(`${base}/api/policies/v4/6/fund`, { method: "POST", headers, body });

    // Both are now waiting on the same in-flight write. Let it finish.
    await new Promise((r) => setTimeout(r, 30));
    stub.gate.open();

    const [ra, rb] = await Promise.all([a, b]);
    stub.gate = undefined;

    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(await ra.json()).toEqual(await rb.json());
    expect(stub.calls.filter((c) => c.startsWith("fund:v4:6")).length).toBe(1);
  });

  it("releases the key after a failure, so a genuine retry still works", async () => {

    stub.calls = [];
    const headers = { "content-type": "application/json", cookie, "idempotency-key": "retry-me" };

    // Invalid amount: rejected before the service is reached.
    const bad = await fetch(`${base}/api/policies/v4/7/fund`, {
      method: "POST", headers, body: JSON.stringify({ amount: "0" }),
    });
    expect(bad.status).toBe(400);

    // Same key, corrected body: must execute rather than replay the failure.
    const good = await fetch(`${base}/api/policies/v4/7/fund`, {
      method: "POST", headers, body: JSON.stringify({ amount: "500" }),
    });
    expect(good.status).toBe(200);
    expect(stub.calls).toContain("fund:v4:7:500");
  });
});

/**
 * The login route is the whole authentication surface: one operator, one shared secret. Unlimited
 * attempts against it turn an offline-speed guess into an online one, so it is limited separately
 * from writes and harder.
 *
 * Its own server, so spending the budget here cannot make the rest of the file flaky.
 */
describe("login rate limiting", () => {
  let limitServer: Server;
  let limitBase: string;

  beforeAll(async () => {
    ({ server: limitServer, base: limitBase } = await startServer(new StubService()));
  });
  afterAll(() => new Promise<void>((r) => limitServer.close(() => r())));

  it("stops brute force against the operator secret", async () => {
    const attempt = (secret: string) => fetch(`${limitBase}/api/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }),
    });

    let rejectedBeforeLimit = 0;
    let limitedAt = -1;
    for (let i = 0; i < 30; i++) {
      const res = await attempt("wrong");
      if (res.status === 429) { limitedAt = i; break; }
      expect(res.status).toBe(401);
      rejectedBeforeLimit++;
    }

    expect(limitedAt).toBeGreaterThan(0);
    expect(rejectedBeforeLimit).toBeLessThanOrEqual(10);

    // And the limit is on attempts, not on failures: the correct secret is refused too while the
    // window is hot, so the limiter cannot be stepped around by interleaving a good guess.
    expect((await attempt(SECRET)).status).toBe(429);
  });
});

/**
 * On a split deployment the cookie is SameSite=None, so the browser no longer refuses to attach the
 * session to a forged cross-site request. The Origin header carries that protection instead, and
 * these are the tests that it actually does.
 */
describe("csrf protection on a split deployment", () => {
  const ORIGIN = "https://app.example";
  let csrfServer: Server;
  let csrfBase: string;
  let csrfStub: StubService;

  beforeAll(async () => {
    csrfStub = new StubService();
    const config = loadApiConfig({ OPERATOR_SECRET: SECRET, COVENANT_CORS_ORIGIN: ORIGIN });
    expect(config.crossOrigin).toBe(true);
    csrfServer = createApiServer({
      config,
      readState: async () => ({ ok: true, policies: [], settlements: [], oracle: null }),
      getService: async () => csrfStub,
    });
    await new Promise<void>((r) => csrfServer.listen(0, r));
    const { port } = csrfServer.address() as AddressInfo;
    csrfBase = `http://127.0.0.1:${port}`;
  });
  afterAll(() => new Promise<void>((r) => csrfServer.close(() => r())));

  it("refuses sign-in from another origin", async () => {
    const res = await fetch(`${csrfBase}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ secret: SECRET }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses a write from another origin before checking the session", async () => {
    csrfStub.calls = [];
    const res = await fetch(`${csrfBase}/api/policies/v4/1/release`, {
      method: "POST", headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(csrfStub.calls).toEqual([]);
  });

  it("refuses a write with no Origin header at all", async () => {
    // A browser always sends Origin on a cross-site POST. Its absence means this did not come from
    // a page, so it does not get to use a cookie the browser would have withheld.
    const res = await fetch(`${csrfBase}/api/policies/v4/1/release`, { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("allows the pinned origin through, and reads stay public", async () => {
    const login = await fetch(`${csrfBase}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ secret: SECRET }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toMatch(/SameSite=None/);

    const m = (login.headers.get("set-cookie") ?? "").match(/cov_session=([^;]+)/);
    csrfStub.calls = [];
    const write = await fetch(`${csrfBase}/api/policies/v4/1/release`, {
      method: "POST", headers: { origin: ORIGIN, cookie: `cov_session=${m![1]}` },
    });
    expect(write.status).toBe(200);
    expect(csrfStub.calls).toEqual(["release:v4:1"]);

    // Reads are public and unaffected by the origin rule.
    expect((await fetch(`${csrfBase}/api/state`, { headers: { origin: "https://evil.example" } })).status).toBe(200);
  });
});

describe("cors preflight", () => {
  it("answers OPTIONS with 204", async () => {
    const res = await fetch(`${base}/api/policies`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });
});

/**
 * A refusal has to say what it refused.
 *
 * viem decodes a custom error into the cause chain and leaves the top-level shortMessage as a bare
 * "the contract function reverted", so reading shortMessage alone tells the operator that something
 * was refused while withholding what. Filmed against the live vault this surfaced as the raw
 * selector 0x1f0c1db7 where ConditionNotMet(17) belonged.
 */
describe("revert reasons reach the operator decoded", () => {
  /** Shaped like viem: the decoded name and args live on a nested cause, not on the top error. */
  function viemLikeRevert(errorName: string, args: unknown[]) {
    const top: any = new Error("execution reverted");
    top.shortMessage = 'The contract function "releaseWithProof" reverted.';
    top.cause = { data: { errorName, args } };
    return top;
  }

  async function reasonFor(err: unknown): Promise<{ status: number; reason?: string }> {
    const failing = new StubService();
    failing.release = async () => { throw err; };
    const { server: s, base: b } = await startServer(failing);
    const cookie = await login(b);
    const res = await fetch(`${b}/api/policies/v4/3/release`, { method: "POST", headers: { cookie } });
    const body = (await res.json()) as any;
    await new Promise<void>((r) => s.close(() => r()));
    return { status: res.status, reason: body.reason };
  }

  it("names the custom error and its arguments", async () => {
    const { status, reason } = await reasonFor(viemLikeRevert("ConditionNotMet", [17n]));
    expect(status).toBe(400);
    expect(reason).toBe("ConditionNotMet(17)");
  });

  it("carries every argument, so a confidence rejection shows its numbers", async () => {
    const { reason } = await reasonFor(
      viemLikeRevert("ConfidenceTooWide", [7n, 801260000000000n, 999849740000000000n, 4]),
    );
    expect(reason).toBe("ConfidenceTooWide(7, 801260000000000, 999849740000000000, 4)");
  });

  /** An Error(string) revert has no name, and its reason is already the message. */
  it("falls back to a plain string reason", async () => {
    const err: any = new Error("reverted");
    err.shortMessage = "The contract function reverted.";
    err.cause = { reason: "ERC20: insufficient allowance" };
    const { reason } = await reasonFor(err);
    expect(reason).toBe("ERC20: insufficient allowance");
  });

  /**
   * When the ABI cannot decode the revert, shortMessage still carries the raw signature and is the
   * more useful answer, so it must survive rather than be replaced by nothing.
   */
  it("keeps the undecodable signature rather than losing it", async () => {
    const err: any = new Error("reverted");
    err.shortMessage = 'The contract function "release" reverted with the following signature:\n0xdeadbeef';
    const { reason } = await reasonFor(err);
    expect(reason).toContain("0xdeadbeef");
  });
});
