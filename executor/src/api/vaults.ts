/**
 * The vault registry: which PolicyVault deployments this project talks to, by what name, and what
 * each one is still for.
 *
 * There is more than one, because the vault is immutable: every change of shape is a new address,
 * and the older deployments keep holding real policies. The read model shows several of them, which
 * means a policy id is NOT unique on its own. Policy 4 exists on v3 and on v4 and they are
 * different policies, with different recipients.
 *
 * That is why this file exists rather than a set of string literals scattered around. Reads label a
 * policy with its vault and writes must carry that label back, or a fund/approve/release aimed at
 * one deployment lands on the same-numbered policy in another. The label is the identity; the id
 * alone is not.
 *
 * Two axes beyond the label, because "shown somewhere" and "can be written to" stopped being the
 * same set at v4:
 *
 *   writable  Whether any write may target it. Only the current deployment is writable. The older
 *             ones hold history, and history is not edited.
 *   surfaces  Where it is listed. The operator app shows only what an operator can act on, which is
 *             the current deployment alone; the monitor is where the whole record lives.
 *
 * On the next migration this file is the only thing that changes: the new deployment becomes the
 * primary and gains both surfaces, and its predecessor drops to the monitor.
 *
 * See docs/specs/V4_VAULT.md.
 */

export interface VaultDeployment {
  label: VaultLabel;
  /** Env var holding this deployment's address. */
  env: string;
  /** Whether writes may target it. Exactly one deployment is writable at a time. */
  writable: boolean;
  /** Surfaces that list it. */
  surfaces: readonly VaultSurface[];
  /** One line on what this deployment is, shown in the UI when actions are unavailable. */
  note: string;
}

export type VaultSurface = "app" | "monitor";

/** Deployment labels, newest first. The read model tags every policy with one of these. */
export const VAULT_LABELS = ["v4", "v3", "v2"] as const;

export type VaultLabel = (typeof VAULT_LABELS)[number];

/**
 * Where new policies are created, and the only deployment any write may target.
 *
 * v4 carries the correctness fixes and the pull-oracle adapter. v3 and v2 are historical: their
 * proofs are recorded and their addresses are no longer written to.
 */
export const PRIMARY_VAULT_LABEL: VaultLabel = "v4";

export const VAULTS: Record<VaultLabel, VaultDeployment> = {
  v4: {
    label: "v4",
    env: "POLICY_VAULT_V4_ADDRESS",
    writable: true,
    surfaces: ["app", "monitor"],
    note: "Current deployment.",
  },
  v3: {
    label: "v3",
    env: "POLICY_VAULT_V3_ADDRESS",
    writable: false,
    // Archived. It was listed in the app while it drained; its remaining policies are the proofs
    // RESULTS cites, which will never be released, so there is nothing left to drain and nothing an
    // operator can do with it. Showing it would be eight rows that exist only to be refused.
    surfaces: ["monitor"],
    note: "Historical deployment, kept for its onchain proofs. Read-only.",
  },
  v2: {
    label: "v2",
    env: "POLICY_VAULT_ADDRESS",
    writable: false,
    // Monitor only. The operator app is an operational surface, and a third label there is clutter
    // plus one more chance for the same-id-different-vault mistake. v2's value is its proof history,
    // which lives in the monitor and in RESULTS.md.
    surfaces: ["monitor"],
    note: "Historical deployment, kept for its onchain proofs. Read-only.",
  },
};

/** The env var holding each deployment's address. */
export const VAULT_ENV_VAR: Record<VaultLabel, string> = {
  v4: VAULTS.v4.env,
  v3: VAULTS.v3.env,
  v2: VAULTS.v2.env,
};

export function isVaultLabel(value: unknown): value is VaultLabel {
  return typeof value === "string" && (VAULT_LABELS as readonly string[]).includes(value);
}

/** True when a write may target this deployment. */
export function isWritable(label: VaultLabel): boolean {
  return VAULTS[label].writable;
}

/** Labels listed on a given surface, newest first. */
export function labelsFor(surface: VaultSurface): VaultLabel[] {
  return VAULT_LABELS.filter((label) => VAULTS[label].surfaces.includes(surface));
}

/**
 * The address of the deployment scripts and demos should target.
 *
 * Every demo and keeper script used to name its own env var, so `POLICY_VAULT_ADDRESS` was scattered
 * across nine files and a migration meant a grep hunt with a chance of missing one. That is the
 * vault-collision mistake at the tooling layer: the same "which vault did you mean" question, in a
 * place where getting it wrong points a demo at a superseded contract.
 *
 * Scripts resolve through here instead, so the next migration is one line in this file.
 */
export function currentVaultAddress(env: Record<string, string | undefined> = process.env): `0x${string}` {
  const varName = VAULT_ENV_VAR[PRIMARY_VAULT_LABEL];
  const address = env[varName];
  if (!address) {
    throw new Error(
      `${varName} is not set. It holds the current vault (${PRIMARY_VAULT_LABEL}), which every ` +
        `demo and keeper script targets.`,
    );
  }
  return address as `0x${string}`;
}

/** A specific deployment's address, for tooling that legitimately targets a superseded vault. */
export function vaultAddress(
  label: VaultLabel,
  env: Record<string, string | undefined> = process.env,
): `0x${string}` | undefined {
  return env[VAULT_ENV_VAR[label]] as `0x${string}` | undefined;
}
