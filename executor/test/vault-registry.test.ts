import { describe, expect, it } from "vitest";
import {
  currentVaultAddress,
  isWritable,
  labelsFor,
  PRIMARY_VAULT_LABEL,
  vaultAddress,
  VAULT_ENV_VAR,
  VAULT_LABELS,
  VAULTS,
} from "../src/api/vaults.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The registry is the single answer to "which vault did you mean". These tests hold the invariants
 * that make that true, including the one binding the .mjs mirror to it.
 */
describe("vault registry", () => {
  it("has exactly one writable deployment, and it is the primary", () => {
    const writable = VAULT_LABELS.filter(isWritable);
    expect(writable).toEqual([PRIMARY_VAULT_LABEL]);
  });

  it("lists the primary on every surface", () => {
    expect(labelsFor("app")).toContain(PRIMARY_VAULT_LABEL);
    expect(labelsFor("monitor")).toContain(PRIMARY_VAULT_LABEL);
  });

  it("keeps the monitor as the complete record", () => {
    // The app may narrow; the monitor may not. History lives there.
    expect(labelsFor("monitor")).toEqual([...VAULT_LABELS]);
    expect(labelsFor("app").length).toBeLessThanOrEqual(labelsFor("monitor").length);
  });

  it("gives every deployment a distinct env var and a note", () => {
    const vars = VAULT_LABELS.map((l) => VAULT_ENV_VAR[l]);
    expect(new Set(vars).size).toBe(vars.length);
    for (const label of VAULT_LABELS) expect(VAULTS[label].note.length).toBeGreaterThan(0);
  });

  it("resolves the current vault from the primary's env var", () => {
    const env = { [VAULT_ENV_VAR[PRIMARY_VAULT_LABEL]]: "0xabc" };
    expect(currentVaultAddress(env)).toBe("0xabc");
  });

  it("names the missing variable rather than failing vaguely", () => {
    expect(() => currentVaultAddress({})).toThrow(VAULT_ENV_VAR[PRIMARY_VAULT_LABEL]);
  });

  it("resolves a specific deployment for tooling that targets a superseded vault", () => {
    const env = { [VAULT_ENV_VAR.v2]: "0xold" };
    expect(vaultAddress("v2", env)).toBe("0xold");
    expect(vaultAddress("v3", env)).toBeUndefined();
  });

  /**
   * The .mjs scripts run under plain node and cannot import this registry, so they mirror one fact
   * from it. This is what stops the mirror drifting: change the primary and forget the mirror, and
   * the demo scripts would quietly target the previous deployment.
   */
  it("keeps the .mjs mirror pointed at the same env var", () => {
    // Read as source rather than imported: the mirror is plain .mjs with no types, and asserting on
    // the literal in the file is what actually catches someone editing it to the wrong variable.
    const mirror = readFileSync(join(__dirname, "..", "scripts", "lib", "vault-address.mjs"), "utf8");
    const match = mirror.match(/CURRENT_VAULT_ENV\s*=\s*"([A-Z0-9_]+)"/);

    expect(match, "vault-address.mjs must declare CURRENT_VAULT_ENV").not.toBeNull();
    expect(match![1]).toBe(VAULT_ENV_VAR[PRIMARY_VAULT_LABEL]);
  });
});
