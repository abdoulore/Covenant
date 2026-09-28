/// <reference types="vite/client" />

/**
 * Build-time configuration the app reads.
 *
 * Declared explicitly rather than left to the loose index signature vite/client provides, so a typo
 * in a variable name is a compile error instead of a silent undefined at runtime.
 */
interface ImportMetaEnv {
  /**
   * Absolute origin of the write API, for a deployment where the app and the API are on different
   * hosts. Unset means same-origin (`/api/...`), which is what the dev proxy serves.
   */
  readonly VITE_API_BASE?: string;
  /**
   * The v5 vault users sign against from their own wallets. Built in, never taken from the API, so a
   * server cannot redirect a user's money. Unset uses the deployment pinned in src/v5/chain.ts.
   */
  readonly VITE_POLICY_VAULT_V5_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
