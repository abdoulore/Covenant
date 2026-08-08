/**
 * The API client. The app talks ONLY to the Covenant API, never to the chain or Circle directly, so
 * the client holds no keys and no provider. Writes carry the session cookie (credentials: include)
 * and an Idempotency-Key so a double submit cannot double-execute.
 */

export interface Policy {
  vault: string; address: string; id: string;
  recipient: string; amount: string; funded: string;
  payoutCurrency: string; destinationDomain: number;
  conditionType: string; status: string; effectiveStatus: string;
  releaseTime?: string; threshold?: number; approvalCount?: number;
  attester?: string; attested?: boolean;
  feed?: string; comparator?: string; oracleThreshold?: string; maxStaleSeconds?: string;
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
  vaults: { label: string; address: string }[];
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

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { credentials: "include", ...init });
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

  createRecurring: (p: {
    recipient: string; payoutCurrency: string; destinationDomain: number;
    amountPerPeriod: string; interval: number; startTime: number; periods: number; maxCatchUp: number;
  }) => write<WriteResult>("/policies", { type: "recurring", ...p }),

  createSweep: (p: {
    recipient: string; payoutCurrency: string; destinationDomain: number;
    buffer: string; minSweep: string; interval: number; startTime: number; maxCatchUp: number;
  }) => write<WriteResult>("/policies", { type: "sweep", ...p }),

  fund: (policyId: string, amount: string) => write<WriteResult>(`/policies/${policyId}/fund`, { amount }),
  approve: (policyId: string) => write<WriteResult>(`/policies/${policyId}/approve`),
  release: (policyId: string) => write<WriteResult>(`/policies/${policyId}/release`),
};
