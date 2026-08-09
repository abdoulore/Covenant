import { describe, expect, it } from "vitest";
import {
  checkOperatorSecret,
  issueToken,
  verifyToken,
  safeEqual,
} from "../src/api/session.js";
import { parseCookies, serializeCookie, RateLimiter, TtlCache } from "../src/api/http.js";
import { loadApiConfig, ApiConfigError } from "../src/api/apiConfig.js";
import { isVaultLabel, VAULT_LABELS, PRIMARY_VAULT_LABEL } from "../src/api/vaults.js";

describe("operator secret check", () => {
  it("matches the correct secret and rejects a wrong one", () => {
    expect(checkOperatorSecret("hunter2", "hunter2")).toBe(true);
    expect(checkOperatorSecret("hunter3", "hunter2")).toBe(false);
  });

  it("rejects a length mismatch without throwing", () => {
    expect(safeEqual("short", "a-much-longer-value")).toBe(false);
  });
});

describe("session token", () => {
  const secret = "operator-secret-abc";

  it("issues a token that verifies under the same secret", () => {
    const t = issueToken(secret, 1_000, 10_000);
    expect(verifyToken(secret, t, 2_000)).toBe(true);
  });

  it("rejects a token under a different secret", () => {
    const t = issueToken(secret, 1_000, 10_000);
    expect(verifyToken("a-different-secret", t, 2_000)).toBe(false);
  });

  it("rejects an expired token", () => {
    const t = issueToken(secret, 1_000, 10_000);
    expect(verifyToken(secret, t, 20_000)).toBe(false);
  });

  it("rejects a tampered payload", () => {
    const t = issueToken(secret, 1_000, 10_000);
    const [payload, sig] = t.split(".");
    const forged = `${payload}x.${sig}`;
    expect(verifyToken(secret, forged, 2_000)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const t = issueToken(secret, 1_000, 10_000);
    const [payload] = t.split(".");
    expect(verifyToken(secret, `${payload}.deadbeef`, 2_000)).toBe(false);
  });

  it("rejects undefined and malformed tokens", () => {
    expect(verifyToken(secret, undefined, 2_000)).toBe(false);
    expect(verifyToken(secret, "no-dot", 2_000)).toBe(false);
    expect(verifyToken(secret, ".", 2_000)).toBe(false);
  });
});

describe("cookies", () => {
  it("parses a cookie header into a map, tolerating junk", () => {
    const c = parseCookies("a=1; session=abc.def; malformed; b=%20x");
    expect(c.a).toBe("1");
    expect(c.session).toBe("abc.def");
    expect(c.b).toBe(" x");
  });

  it("returns an empty map for a missing header", () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it("serializes safe defaults and honors options", () => {
    const def = serializeCookie("session", "tok");
    expect(def).toContain("HttpOnly");
    expect(def).toContain("SameSite=Strict");
    expect(def).toContain("Path=/");
    expect(def).not.toContain("Secure");

    const secure = serializeCookie("session", "tok", { secure: true, maxAgeSeconds: 60 });
    expect(secure).toContain("Secure");
    expect(secure).toContain("Max-Age=60");
  });
});

describe("rate limiter", () => {
  it("allows up to the limit, then blocks, then resets after the window", () => {
    const rl = new RateLimiter(2, 1_000);
    expect(rl.allow("ip", 0)).toBe(true);
    expect(rl.allow("ip", 100)).toBe(true);
    expect(rl.allow("ip", 200)).toBe(false); // third in-window is over budget
    expect(rl.allow("ip", 1_200)).toBe(true); // new window
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter(1, 1_000);
    expect(rl.allow("a", 0)).toBe(true);
    expect(rl.allow("b", 0)).toBe(true);
    expect(rl.allow("a", 0)).toBe(false);
  });

  /** Keys are caller-supplied IPs. Without a sweep the map only ever grows. */
  it("drops expired windows instead of holding every key it has ever seen", () => {
    const rl = new RateLimiter(5, 1_000);
    for (let i = 0; i < 50; i++) rl.allow(`ip-${i}`, 0);
    expect(rl.size).toBe(50);

    rl.allow("ip-fresh", 5_000); // a later call sweeps the expired windows
    expect(rl.size).toBe(1);
  });
});

describe("ttl cache", () => {
  it("returns a value inside its ttl and forgets it after", () => {
    const c = new TtlCache<string>(1_000, 10);
    c.set("k", "v", 0);
    expect(c.get("k", 500)).toBe("v");
    expect(c.get("k", 1_500)).toBeUndefined();
  });

  /** The idempotency keys arrive in a request header, so the ceiling is the real protection. */
  it("evicts oldest first once past its ceiling", () => {
    const c = new TtlCache<number>(60_000, 3);
    c.set("a", 1, 0);
    c.set("b", 2, 1);
    c.set("c", 3, 2);
    c.set("d", 4, 3);

    expect(c.size).toBe(3);
    expect(c.get("a", 4)).toBeUndefined(); // the oldest went
    expect(c.get("d", 4)).toBe(4);
  });

  it("drops a key on demand, so a failed write stays retryable", () => {
    const c = new TtlCache<string>(60_000, 10);
    c.set("k", "v", 0);
    c.delete("k");
    expect(c.get("k", 1)).toBeUndefined();
  });
});

/**
 * A policy id is only unique per deployment: the vault is half of a policy's identity, which is why
 * writes carry it.
 */
describe("vault registry", () => {
  it("recognises exactly the configured labels", () => {
    for (const label of VAULT_LABELS) expect(isVaultLabel(label)).toBe(true);
    expect(isVaultLabel("v9")).toBe(false);
    expect(isVaultLabel("")).toBe(false);
    expect(isVaultLabel(undefined)).toBe(false);
    expect(isVaultLabel(3)).toBe(false);
  });

  it("names a primary that is one of the known labels", () => {
    expect(VAULT_LABELS).toContain(PRIMARY_VAULT_LABEL);
  });
});

describe("api boot-safety", () => {
  it("refuses to start in deployed mode without an operator secret", () => {
    expect(() => loadApiConfig({ COVENANT_CORS_ORIGIN: "https://app.example" })).toThrow(ApiConfigError);
  });

  it("refuses to start in deployed mode without a pinned CORS origin", () => {
    expect(() => loadApiConfig({ OPERATOR_SECRET: "s" })).toThrow(ApiConfigError);
  });

  it("starts in deployed mode when both are set, with secure cookies", () => {
    const cfg = loadApiConfig({ OPERATOR_SECRET: "s", COVENANT_CORS_ORIGIN: "https://app.example", API_PORT: "9000" });
    expect(cfg.secureCookies).toBe(true);
    expect(cfg.corsOrigin).toBe("https://app.example");
    expect(cfg.port).toBe(9000);
    expect(cfg.devMode).toBe(false);
  });

  it("allows a local dev run to fall back, with non-secure cookies", () => {
    const cfg = loadApiConfig({ COVENANT_ENV: "dev" });
    expect(cfg.devMode).toBe(true);
    expect(cfg.secureCookies).toBe(false);
    expect(cfg.corsOrigin).toBe("http://localhost:5173");
  });
});

/**
 * Split deployment: a static app bundle on one host, the write API on a host that can run a
 * persistent process. Two settings have to move together or sign-in silently breaks.
 */
describe("split deployment cookie policy", () => {
  const deployed = { OPERATOR_SECRET: "s", COVENANT_CORS_ORIGIN: "https://app.example" };

  it("relaxes SameSite so the session survives a cross-origin request", () => {
    const cfg = loadApiConfig(deployed);
    // SameSite=Strict is never sent cross-site, so every write would 401 with no clue why.
    expect(cfg.crossOrigin).toBe(true);
    expect(cfg.sameSite).toBe("None");
    expect(cfg.secureCookies).toBe(true); // mandatory alongside None
  });

  it("keeps the strict cookie when the app and API share an origin", () => {
    const cfg = loadApiConfig({ ...deployed, COVENANT_SAME_ORIGIN: "true" });
    expect(cfg.crossOrigin).toBe(false);
    expect(cfg.sameSite).toBe("Strict");
  });

  it("keeps the strict cookie in local dev", () => {
    const cfg = loadApiConfig({ COVENANT_ENV: "dev" });
    expect(cfg.crossOrigin).toBe(false);
    expect(cfg.sameSite).toBe("Strict");
  });

  it("never emits SameSite=None without Secure, which browsers reject", () => {
    for (const env of [deployed, { ...deployed, COVENANT_SAME_ORIGIN: "true" }, { COVENANT_ENV: "dev" }]) {
      const cfg = loadApiConfig(env);
      if (cfg.sameSite === "None") expect(cfg.secureCookies).toBe(true);
    }
  });

  it("serializes the relaxed cookie correctly", () => {
    const cfg = loadApiConfig(deployed);
    const cookie = serializeCookie("cov_session", "tok", {
      httpOnly: true, sameSite: cfg.sameSite, secure: cfg.secureCookies, maxAgeSeconds: 60,
    });
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
  });
});
