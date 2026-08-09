import { describe, expect, it } from "vitest";
import { join, sep } from "node:path";
import { resolvePublicFile } from "../src/dashboard/staticFiles.js";

/**
 * The monitor serves a static frontend from one directory and holds no keys, but it runs in the
 * same working directory as the repo `.env`. A request path that escapes the public directory is
 * therefore a credential read, not a cosmetic bug.
 */
const ROOT = join(sep, "srv", "covenant", "public");

describe("static file resolution", () => {
  it("serves index.html at the root", () => {
    expect(resolvePublicFile(ROOT, "/")).toBe(join(ROOT, "index.html"));
  });

  it("serves an ordinary file", () => {
    expect(resolvePublicFile(ROOT, "/app.css")).toBe(join(ROOT, "app.css"));
  });

  it("serves a nested file", () => {
    expect(resolvePublicFile(ROOT, "/assets/logo.svg")).toBe(join(ROOT, "assets", "logo.svg"));
  });

  /** node:http does not normalise req.url, so a non-browser client can send this verbatim. */
  it("refuses a traversal out of the public directory", () => {
    expect(resolvePublicFile(ROOT, "/../../.env")).toBeUndefined();
    expect(resolvePublicFile(ROOT, "/../.env")).toBeUndefined();
    expect(resolvePublicFile(ROOT, "/assets/../../../.env")).toBeUndefined();
  });

  it("refuses a percent-encoded traversal", () => {
    expect(resolvePublicFile(ROOT, "/%2e%2e/%2e%2e/.env")).toBeUndefined();
    expect(resolvePublicFile(ROOT, "/..%2f..%2f.env")).toBeUndefined();
  });

  it("refuses malformed percent-encoding rather than guessing", () => {
    expect(resolvePublicFile(ROOT, "/%")).toBeUndefined();
    expect(resolvePublicFile(ROOT, "/%zz")).toBeUndefined();
  });

  it("refuses an embedded NUL", () => {
    expect(resolvePublicFile(ROOT, "/index.html%00.png")).toBeUndefined();
  });

  /** A sibling directory sharing the prefix must not pass as the public directory. */
  it("refuses a sibling directory with the same prefix", () => {
    expect(resolvePublicFile(ROOT, "/../public-backup/secrets.txt")).toBeUndefined();
  });

  it("keeps a traversal that stays inside the directory", () => {
    expect(resolvePublicFile(ROOT, "/assets/../app.css")).toBe(join(ROOT, "app.css"));
  });
});
