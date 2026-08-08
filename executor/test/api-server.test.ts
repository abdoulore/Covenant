import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createApiServer, type VaultServiceLike } from "../src/api/server.js";
import { loadApiConfig } from "../src/api/apiConfig.js";

// A stub write service that records calls, so the server's routing/auth/validation is tested with
// no chain and no Circle.
class StubService implements VaultServiceLike {
  calls: string[] = [];
  async createTimelock(input: any) { this.calls.push("createTimelock"); return { policyId: "7", txHash: "0xabc", explorerUrl: "u" }; }
  async createApproval(input: any) { this.calls.push("createApproval"); return { policyId: "8", txHash: "0xdef", explorerUrl: "u" }; }
  async fund(policyId: string, amount: string) { this.calls.push(`fund:${policyId}:${amount}`); return { txHash: "0xf", explorerUrl: "u" }; }
  async approve(policyId: string) { this.calls.push(`approve:${policyId}`); return { txHash: "0xa", explorerUrl: "u" }; }
  async release(policyId: string) { this.calls.push(`release:${policyId}`); return { txHash: "0xr", explorerUrl: "u" }; }
}

const SECRET = "test-operator-secret";
let server: Server;
let base: string;
let stub: StubService;

beforeAll(async () => {
  stub = new StubService();
  // devMode true but a secret set, so auth is still enforced (not the open dev path).
  const config = loadApiConfig({ COVENANT_ENV: "dev", OPERATOR_SECRET: SECRET });
  server = createApiServer({
    config,
    readState: async () => ({ ok: true, policies: [], settlements: [], oracle: null }),
    getService: async () => stub,
  });
  await new Promise<void>((r) => server.listen(0, r));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function login(): Promise<string> {
  const res = await fetch(`${base}/api/session`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: SECRET }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/cov_session=([^;]+)/);
  expect(m).not.toBeNull();
  return `cov_session=${m![1]}`;
}

describe("read route", () => {
  it("serves state publicly with no auth", async () => {
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).ok).toBe(true);
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
});

describe("write gating", () => {
  it("rejects a create with no session", async () => {
    const res = await fetch(`${base}/api/policies`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "timelock" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects release with no session", async () => {
    const res = await fetch(`${base}/api/policies/3/release`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("validates the body before touching the service", async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/policies`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ type: "timelock", recipient: "not-an-address", amount: "100", payoutCurrency: "USDC", destinationDomain: 26, releaseTime: 123 }),
    });
    expect(res.status).toBe(400);
    expect(stub.calls).not.toContain("createTimelock");
  });

  it("creates a timelock with a valid body and a session", async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/policies`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ type: "timelock", recipient: "0x" + "1".repeat(40), amount: "100000", payoutCurrency: "USDC", destinationDomain: 26, releaseTime: 2_000_000_000 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).policyId).toBe("7");
    expect(stub.calls).toContain("createTimelock");
  });

  it("honors an idempotency key: a repeat does not call the service twice", async () => {
    const cookie = await login();
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
    const cookie = await login();
    stub.calls = [];
    const f = await fetch(`${base}/api/policies/5/fund`, {
      method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ amount: "50000" }),
    });
    expect(f.status).toBe(200);
    const rel = await fetch(`${base}/api/policies/5/release`, { method: "POST", headers: { cookie } });
    expect(rel.status).toBe(200);
    expect(stub.calls).toContain("fund:5:50000");
    expect(stub.calls).toContain("release:5");
  });
});

describe("cors preflight", () => {
  it("answers OPTIONS with 204", async () => {
    const res = await fetch(`${base}/api/policies`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
  });
});
