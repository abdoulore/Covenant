import { describe, expect, it } from "vitest";
import {
  checkOperatorSecret,
  issueToken,
  verifyToken,
  safeEqual,
} from "../src/api/session.js";
import { parseCookies, serializeCookie, RateLimiter } from "../src/api/http.js";
import { loadApiConfig, ApiConfigError } from "../src/api/apiConfig.js";

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
