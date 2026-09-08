import { describe, expect, it } from "vitest";
import { hermesAuthMessage, hermesConfig } from "../src/oracle/HermesPythClient.js";

describe("hermes config", () => {
  it("sends no authorization header when no key is set", () => {
    const cfg = hermesConfig({} as NodeJS.ProcessEnv);
    expect(cfg.headers).toEqual({});
    expect(cfg.authenticated).toBe(false);
  });

  it("carries the key as a bearer token", () => {
    const cfg = hermesConfig({ PYTH_API_KEY: "abc123" } as NodeJS.ProcessEnv);
    expect(cfg.headers).toEqual({ authorization: "Bearer abc123" });
    expect(cfg.authenticated).toBe(true);
  });

  /** A key pasted from a dashboard usually arrives with a newline attached. */
  it("trims a key copied with surrounding whitespace", () => {
    const cfg = hermesConfig({ PYTH_API_KEY: "  abc123\n" } as NodeJS.ProcessEnv);
    expect(cfg.headers.authorization).toBe("Bearer abc123");
  });

  it("defaults to hermes.pyth.network and allows a different instance", () => {
    expect(hermesConfig({} as NodeJS.ProcessEnv).baseUrl).toBe("https://hermes.pyth.network");
    const moved = hermesConfig({ PYTH_HERMES_BASE_URL: "https://pyth.dourolabs.app/hermes/" } as NodeJS.ProcessEnv);
    expect(moved.baseUrl).toBe("https://pyth.dourolabs.app/hermes");
  });

  it("ignores an empty override rather than building a url from nothing", () => {
    expect(hermesConfig({ PYTH_HERMES_BASE_URL: "   " } as NodeJS.ProcessEnv).baseUrl)
      .toBe("https://hermes.pyth.network");
  });
});

/**
 * The message is the fix. A bare "Hermes returned 401" sent someone hunting for a network fault
 * when the answer was that the endpoint stopped being keyless.
 */
describe("hermes auth message", () => {
  it("names the missing variable when no key is configured", () => {
    const msg = hermesAuthMessage(401, hermesConfig({} as NodeJS.ProcessEnv));
    expect(msg).toContain("PYTH_API_KEY");
    expect(msg).toMatch(/requires an API key/i);
  });

  it("blames the key, not its absence, when one is set", () => {
    const msg = hermesAuthMessage(403, hermesConfig({ PYTH_API_KEY: "k" } as NodeJS.ProcessEnv));
    expect(msg).toMatch(/rejected the configured PYTH_API_KEY/);
    expect(msg).toContain("https://hermes.pyth.network");
  });

  it("passes other statuses through without an auth story", () => {
    const msg = hermesAuthMessage(503, hermesConfig({} as NodeJS.ProcessEnv));
    expect(msg).toBe("Hermes returned 503");
    expect(msg).not.toContain("PYTH_API_KEY");
  });
});
