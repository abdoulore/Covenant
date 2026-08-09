/**
 * Current-vault resolution for the plain .mjs scripts.
 *
 * The source of truth is executor/src/api/vaults.ts. This mirrors only the one fact those scripts
 * need, because they run under plain node rather than tsx and cannot import the TypeScript registry.
 *
 * The mirror is kept honest by a test (executor/test/vault-registry.test.ts) that fails if this
 * disagrees with vaults.ts, so the duplication cannot drift silently. On the next migration, change
 * vaults.ts and this constant together; the test will tell you if you forget.
 *
 * The test makes the duplication safe, not good. The durable fix is to remove the mirror entirely,
 * either by emitting the registry as a JSON artifact that both TypeScript and plain node read, or by
 * running these two scripts under tsx like every other one. Recorded here so a stopgap does not
 * become the architecture by nobody ever saying otherwise.
 */

/** Env var holding the current (writable) deployment's address. Mirrors PRIMARY_VAULT_LABEL. */
export const CURRENT_VAULT_ENV = "POLICY_VAULT_V4_ADDRESS";

export function currentVaultAddress(env = process.env) {
  const address = env[CURRENT_VAULT_ENV];
  if (!address) {
    throw new Error(
      `${CURRENT_VAULT_ENV} is not set. It holds the current vault, which every demo script targets.`,
    );
  }
  return address;
}

