import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { toEventSelector, toFunctionSelector, toFunctionSignature } from "viem";
import { V5_ABI, V5_ERRORS, V5_POLICY_COMPONENTS } from "../src/chain/policyVaultV5.js";

/**
 * The executor's hand-written v5 interface must match the compiled contract exactly. A field added
 * or reordered in the Policy struct would otherwise make every policy read as garbage, silently.
 *
 * CI builds the contracts before running this suite, so the artifact is present there; in CI a
 * missing artifact is a failure, not a skip.
 */
const artifact = join(dirname(fileURLToPath(import.meta.url)), "../../contracts/out/PolicyVaultV5.sol/PolicyVaultV5.json");
const present = existsSync(artifact);

describe("v5 interface is present to check", () => {
  it.runIf(process.env.CI)("has the compiled artifact in CI", () => {
    expect(present, "contracts must be built before the executor suite runs").toBe(true);
  });
});

describe.skipIf(!present)("v5 interface matches the compiled contract", () => {
  const compiled: any[] = present ? JSON.parse(readFileSync(artifact, "utf8")).abi : [];

  it("has the Policy struct with the same fields, types, and order", () => {
    const getPolicy = compiled.find((e) => e.type === "function" && e.name === "getPolicy");
    const fields = getPolicy.outputs[0].components.map((c: any) => `${c.name}:${c.type}`);
    expect(V5_POLICY_COMPONENTS.map((c) => `${c.name}:${c.type}`)).toEqual(fields);
  });

  it("uses the same function signatures", () => {
    for (const entry of V5_ABI.filter((e) => e.type === "function")) {
      const match = compiled.find((e) => e.type === "function" && e.name === entry.name);
      expect(match, entry.name).toBeTruthy();
      expect(toFunctionSelector(entry as any), entry.name).toBe(toFunctionSelector(match));
    }
  });

  it("knows exactly the errors the contract can raise", () => {
    const sig = (e: any) => toFunctionSignature({ ...e, type: "function", outputs: [], stateMutability: "view" } as any);
    const theirs = compiled.filter((e) => e.type === "error").map(sig).sort();
    expect(V5_ERRORS.map(sig).sort()).toEqual(theirs);
  });

  it("uses the same PolicyReleased event", () => {
    const ours = V5_ABI.find((e) => e.type === "event" && e.name === "PolicyReleased");
    const theirs = compiled.find((e) => e.type === "event" && e.name === "PolicyReleased");
    expect(toEventSelector(ours as any)).toBe(toEventSelector(theirs));
  });

  // The app signs v5 transactions from the user's wallet with its own copy of the ABI.
  it("matches the app's copy of the ABI (resync: node app/scripts/sync-v5-abi.mjs)", () => {
    const appCopy = join(dirname(fileURLToPath(import.meta.url)), "../../app/src/v5/vaultAbi.json");
    expect(JSON.parse(readFileSync(appCopy, "utf8"))).toEqual(compiled);
  });
});

/** The app pins the vault its users sign against; it must be the one the deploy actually created. */
describe("the app's pinned v5 vault", () => {
  it("is the address in the testnet broadcast record", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const run = JSON.parse(readFileSync(join(root, "contracts/broadcast/DeployPolicyVaultV5.s.sol/5042002/run-latest.json"), "utf8"));
    const deployed = run.transactions.find((t: any) => t.contractName === "PolicyVaultV5").contractAddress;
    const pinned = readFileSync(join(root, "app/src/v5/chain.ts"), "utf8").match(/V5_TESTNET_VAULT = "(0x[0-9a-fA-F]{40})"/)?.[1];
    expect(pinned?.toLowerCase()).toBe(deployed.toLowerCase());
  });
});
