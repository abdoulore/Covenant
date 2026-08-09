/**
 * The API client. The app talks ONLY to the Covenant API, never to the chain or Circle directly, so
 * the client holds no keys and no provider. Writes carry the session cookie (credentials: include)
 * and an Idempotency-Key so a double submit cannot double-execute.
 */

export interface Policy {
  vault: string; address: string; id: string;
  /** False for a superseded deployment: it is shown, but nothing can be done to it. */
  writable?: boolean;
  recipient: string; amount: string; funded: string;
  payoutCurrency: string; destinationDomain: number;
  conditionType: string; status: string; effectiveStatus: string;
  releaseTime?: string; threshold?: number; approvalCount?: number;
  attester?: string; attested?: boolean;
  /** oracleThreshold is in the FEED's decimals for Oracle, and 1e18 for OraclePull. Branch on conditionType. */
  feed?: string; comparator?: string; oracleThreshold?: string; maxStaleSeconds?: string;
  adapter?: string; feedId?: string; maxConfBps?: number;
  recurring?: boolean; isSweep?: boolean;
  amountPerPeriod?: string; buffer?: string; minSweep?: string;
  interval?: string; nextDue?: string; maxCatchUp?: string; periods?: number; periodsReleased?: number;
}

export interface Settlement {
  key: string; source: string; policyId: string; periodIndex?: number;
  status: string; recipient?: string; amount?: string; payoutCurrency?: string; destinationDomain?: number;
  release: { txHash?: string; url?: string; at?: string };
  payout: { txHash?: string; url?: string; at?: string } | null;
  custodyGapMs?: number;
  legs?: { kind: string; status: string; txHash?: string; url?: string }[];
}

export interface Oracle { pair: string; price: number; conf: number; publishTime: number; decimals: number; }

export interface AppState {
  generatedAt: string;
  vaults: { label: string; address: string; writable?: boolean; note?: string }[];
  policies: Policy[];
  settlements: Settlement[];
  oracle: Oracle | null;
}

export interface WriteResult { txHash: string; explorerUrl: string; policyId?: string; }

/** An error carrying the API's structured reason, so the UI can show a contract revert verbatim. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public reason?: string) {
    super(message);
  }
}

/**
 * Where the API lives.
 *
 * Empty by default, which makes every request same-origin (`/api/...`). That is what the Vite dev
 * proxy serves and what a single-origin deployment wants.
 *
 * Set VITE_API_BASE to an absolute origin when the app and the API are deployed separately, for
 * example a static bundle on one host and the write API on a host that can run a persistent
 * process. The API must then pin COVENANT_CORS_ORIGIN to this app's origin, or the browser will
 * refuse the credentialed request.
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`, { credentials: "include", ...init });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(res.status, body.message ?? body.error ?? `HTTP ${res.status}`, body.reason);
  }
  return body as T;
}

const idempotencyKey = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function write<T>(path: string, payload?: unknown): Promise<T> {
  return req<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey() },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
}

export const api = {
  getState: () => req<AppState>("/state"),

  login: (secret: string) => write<{ ok: true }>("/session", { secret }),
  logout: () => req<{ ok: true }>("/session", { method: "DELETE" }),

  createTimelock: (p: {
    recipient: string; amount: string; payoutCurrency: string; destinationDomain: number; releaseTime: number;
  }) => write<WriteResult>("/policies", { type: "timelock", ...p }),

  createApproval: (p: {
    recipient: string; amount: string; payoutCurrency: string; destinationDomain: number; approvers: string[]; threshold: number;
  }) => write<WriteResult>("/policies", { type: "approval", ...p }),

  createAttestation: (p: {
    recipient: string; amount: string; payoutCurrency: string; destinationDomain: number; attester: string;
  }) => write<WriteResult>("/policies", { type: "attestation", ...p }),

  createOracle: (p: {
    recipient: string; amount: string; payoutCurrency: string; destinationDomain: number;
    feedKey: "USDC/USD"; comparator: "Gte" | "Lte"; threshold: string; maxStaleSeconds: number;
  }) => write<WriteResult>("/policies", { type: "oracle", ...p }),

  /**
   * The pull-oracle path, and the default for new oracle policies. Verifies a signed price and
   * releases in one transaction, and can reject a price the oracle itself is unsure about.
   * `threshold1e18` is in 1e18 scale, not the feed's decimals: the adapter normalizes.
   */
  createOraclePull: (p: {
    recipient: string; amount: string; payoutCurrency: string; destinationDomain: number;
    feedKey: "USDC/USD"; comparator: "Gte" | "Lte"; threshold1e18: string; maxStaleSeconds: number; maxConfBps: number;
  }) => write<WriteResult>("/policies", { type: "oraclePull", ...p }),

  createRecurring: (p: {
    recipient: string; payoutCurrency: string; destinationDomain: number;
    amountPerPeriod: string; interval: number; startTime: number; periods: number; maxCatchUp: number;
  }) => write<WriteResult>("/policies", { type: "recurring", ...p }),

  createSweep: (p: {
    recipient: string; payoutCurrency: string; destinationDomain: number;
    buffer: string; minSweep: string; interval: number; startTime: number; maxCatchUp: number;
  }) => write<WriteResult>("/policies", { type: "sweep", ...p }),

  /**
   * Lifecycle actions carry the vault the policy actually lives on.
   *
   * Policy ids restart at zero on each PolicyVault deployment and the app shows policies from all
   * of them, so `id` alone does not identify a policy. Pass `policy.vault` straight through from
   * whatever row or detail view the operator acted on: it is the one value that makes the write
   * land where the screen said it would.
   */
  fund: (vault: string, policyId: string, amount: string) =>
    write<WriteResult>(`/policies/${vault}/${policyId}/fund`, { amount }),
  approve: (vault: string, policyId: string) => write<WriteResult>(`/policies/${vault}/${policyId}/approve`),
  release: (vault: string, policyId: string) => write<WriteResult>(`/policies/${vault}/${policyId}/release`),
  /** OraclePull policies release only through here: the API fetches the signed price and pays the fee. */
  releaseWithProof: (vault: string, policyId: string) =>
    write<WriteResult>(`/policies/${vault}/${policyId}/releaseWithProof`),
};
