/**
 * Every v5 transaction the app asks a wallet to sign, and how it reads the answer.
 *
 * Each one is simulated first, from the user's own account, so a refusal comes back as the vault's
 * own reason ("DeadlineTooSoon", "ConditionNotMet") before the wallet asks for anything, and a
 * transaction the vault would refuse is never offered for signature.
 *
 * Money moves into the vault with an EIP-2612 permit signed in the wallet and spent in the same
 * transaction as the action it pays for, through the vault's multicall: one signature and one
 * transaction, and no standing allowance left behind. A wallet that cannot sign permits falls back
 * to an ordinary approval for the exact amount, then the action.
 */
import {
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError, decodeEventLog, encodeFunctionData,
  parseAbi, parseSignature, type Abi, type Hex,
} from "viem";
import vaultAbiJson from "./vaultAbi.json";
import { ARC, ARC_DOMAIN, IRIS, USDC, txUrl } from "./chain";
import { walletMessage } from "./wallet";
import type { Signer } from "./signer";

export const VAULT_ABI = vaultAbiJson as Abi;

const USDC_ABI = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function nonces(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

/** What every creator takes. `deadline` is the last moment a release is possible. */
export interface Terms {
  recipient: `0x${string}`;
  amount: bigint;
  destinationDomain: number;
  deadline: bigint;
  maxFeePerTransfer: bigint;
}

export interface Sent { hash: Hex; url: string; policyId?: string }

/** A refusal or failure, in words, with the vault's error name when it gave one. */
export class TxError extends Error {
  constructor(message: string, public reason?: string) { super(message); }
}

function explain(e: unknown): TxError {
  if (e instanceof TxError) return e;
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return new TxError("You declined the request in your wallet.");
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (revert?.data?.errorName) {
      const args = revert.data.args?.map((a) => String(a)).join(", ");
      return new TxError("The vault refused this.", `${revert.data.errorName}${args ? `(${args})` : ""}`);
    }
    if (revert?.reason) return new TxError("The vault refused this.", revert.reason);
  }
  return new TxError(walletMessage(e));
}

/**
 * The cross-chain fee to fix on a policy, in USDC base units: Circle's high quote for forwarding to
 * `domain` at standard finality, plus a margin. Circle collects the whole of it on every transfer.
 *
 * Refuses when Circle charges a protocol fee on the route. Arc has none today (V25); sizing one needs
 * the transfer amount, and a guess would fix a fee on the policy that is wrong for its whole life.
 */
export async function quoteMaxFee(domain: number): Promise<bigint> {
  if (domain === ARC_DOMAIN) return 0n;
  const res = await fetch(`${IRIS}/v2/burn/USDC/fees/${ARC_DOMAIN}/${domain}?forward=true`);
  if (!res.ok) throw new TxError(`Circle's fee API returned ${res.status}. Try again shortly.`);
  const quotes = (await res.json()) as { finalityThreshold: number; minimumFee: number; forwardFee?: { high: number } }[];
  const standard = quotes.find((q) => q.finalityThreshold === 2000);
  if (!standard?.forwardFee) throw new TxError("Circle did not quote forwarding to that destination.");
  if (standard.minimumFee !== 0) throw new TxError("Circle now charges a protocol fee on this route, which this app does not size yet.");
  return BigInt(standard.forwardFee.high) + 5_000n;
}

/** The USDC the connected account holds, in base units. */
export async function usdcBalance(s: Signer): Promise<bigint> {
  return (await s.client.readContract({ address: USDC, abi: USDC_ABI, functionName: "balanceOf", args: [s.account] })) as bigint;
}

/**
 * The permit call that lets the vault pull `value`, or null when the allowance already covers it.
 * The user sees and signs the permit in their wallet: spender the vault, exact value, one hour.
 */
async function permitCall(s: Signer, vault: `0x${string}`, value: bigint): Promise<Hex | null> {
  const read = <T>(functionName: "name" | "version" | "nonces" | "allowance", args?: readonly unknown[]) =>
    s.client.readContract({ address: USDC, abi: USDC_ABI, functionName, args } as never) as Promise<T>;
  if ((await read<bigint>("allowance", [s.account, vault])) >= value) return null;
  const [name, version, nonce] = await Promise.all([read<string>("name"), read<string>("version"), read<bigint>("nonces", [s.account])]);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const signature = await s.wallet.signTypedData({
    account: s.account,
    domain: { name, version, chainId: ARC.id, verifyingContract: USDC },
    types: {
      Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner: s.account, spender: vault, value, nonce, deadline },
  });
  const sig = parseSignature(signature);
  const v = Number(sig.v ?? 27n + BigInt(sig.yParity));
  return encodeFunctionData({ abi: VAULT_ABI, functionName: "permitUsdc", args: [value, deadline, v, sig.r, sig.s] });
}

/** Simulate, send, and wait for one call to the vault. */
async function call(s: Signer, vault: `0x${string}`, functionName: string, args: readonly unknown[], value?: bigint): Promise<Sent> {
  const { request } = await s.client.simulateContract({
    account: s.account, address: vault, abi: VAULT_ABI, functionName, args, ...(value ? { value } : {}),
  } as never);
  const hash = await s.wallet.writeContract(request as never);
  const receipt = await s.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new TxError("The transaction reverted onchain.", hash);
  const created = receipt.logs
    .filter((l) => l.address.toLowerCase() === vault.toLowerCase())
    .map((l) => { try { return decodeEventLog({ abi: VAULT_ABI, data: l.data, topics: l.topics }); } catch { return null; } })
    .find((d) => d?.eventName === "PolicyCreated");
  const policyId = created ? String((created.args as unknown as { policyId: bigint }).policyId) : undefined;
  return { hash, url: txUrl(hash), ...(policyId ? { policyId } : {}) };
}

/**
 * Run an action that pulls `pull` USDC from the user: permit and action in one transaction, or, for
 * a wallet that will not sign a permit, an exact approval and then the action.
 */
async function withFunding(s: Signer, vault: `0x${string}`, pull: bigint, functionName: string, args: readonly unknown[]): Promise<Sent> {
  const balance = await usdcBalance(s);
  if (balance < pull) {
    throw new TxError(`This needs ${fmt(pull)} USDC from your wallet, and it holds ${fmt(balance)}.`);
  }
  const action = encodeFunctionData({ abi: VAULT_ABI, functionName, args });
  let permit: Hex | null;
  try {
    permit = await permitCall(s, vault, pull);
  } catch (e) {
    const err = explain(e);
    if (e instanceof BaseError && e.walk((x) => x instanceof UserRejectedRequestError)) throw err;
    // The wallet cannot sign typed data (some smart-contract wallets): approve instead.
    const hash = await s.wallet.writeContract({ account: s.account, chain: ARC, address: USDC, abi: USDC_ABI, functionName: "approve", args: [vault, pull] });
    await s.client.waitForTransactionReceipt({ hash });
    permit = null;
  }
  return permit ? call(s, vault, "multicall", [[permit, action]]) : call(s, vault, functionName, args);
}

const fmt = (base: bigint) => (Number(base) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });

/** Run a vault action, turning every failure into a TxError the UI can show as it is. */
export async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw explain(e);
  }
}

// ---- creating ------------------------------------------------------------

export type CreateSpec =
  | { kind: "timelock"; terms: Terms; releaseTime: bigint }
  | { kind: "approval"; terms: Terms; approvers: `0x${string}`[]; threshold: number }
  | { kind: "attestation"; terms: Terms; attester: `0x${string}` }
  | { kind: "recurring"; terms: Terms; amountPerPeriod: bigint; interval: bigint; startTime: bigint; periods: number; initialFunding: bigint; initialFees: bigint }
  | { kind: "sweep"; terms: Terms; buffer: bigint; minSweep: bigint; interval: bigint; startTime: bigint; initialFunding: bigint; initialFees: bigint };

/** What creating `spec` pulls from the user's wallet: payout and fee for a one-off, the first funding for a schedule. */
export function pullFor(spec: CreateSpec): bigint {
  return spec.kind === "recurring" || spec.kind === "sweep"
    ? spec.initialFunding + spec.initialFees
    : spec.terms.amount + spec.terms.maxFeePerTransfer;
}

export function createPolicy(s: Signer, vault: `0x${string}`, spec: CreateSpec): Promise<Sent> {
  const t = spec.terms;
  const [fn, args]: [string, readonly unknown[]] =
    spec.kind === "timelock" ? ["createTimelockPolicy", [t, spec.releaseTime]]
    : spec.kind === "approval" ? ["createApprovalPolicy", [t, spec.approvers, spec.threshold]]
    : spec.kind === "attestation" ? ["createAttestationPolicy", [t, spec.attester]]
    : spec.kind === "recurring" ? ["createRecurringPolicy", [t, spec.amountPerPeriod, spec.interval, spec.startTime, spec.periods, spec.initialFunding, spec.initialFees]]
    : ["createSweepPolicy", [t, spec.buffer, spec.minSweep, spec.interval, spec.startTime, spec.initialFunding, spec.initialFees]];
  return run(() => withFunding(s, vault, pullFor(spec), fn, args));
}

// ---- acting on a policy ---------------------------------------------------

const id = (policyId: string) => BigInt(policyId);

export const actions = {
  release: (s: Signer, vault: `0x${string}`, policyId: string) => run(() => call(s, vault, "release", [id(policyId)])),
  releasePeriod: (s: Signer, vault: `0x${string}`, policyId: string) => run(() => call(s, vault, "releasePeriod", [id(policyId)])),
  approve: (s: Signer, vault: `0x${string}`, policyId: string) => run(() => call(s, vault, "approve", [id(policyId)])),
  cancel: (s: Signer, vault: `0x${string}`, policyId: string) => run(() => call(s, vault, "cancel", [id(policyId)])),
  stop: (s: Signer, vault: `0x${string}`, policyId: string) => run(() => call(s, vault, "stop", [id(policyId)])),
  reclaim: (s: Signer, vault: `0x${string}`, policyId: string) => run(() => call(s, vault, "reclaim", [id(policyId)])),
  extendDeadline: (s: Signer, vault: `0x${string}`, policyId: string, newDeadline: bigint) =>
    run(() => call(s, vault, "extendDeadline", [id(policyId), newDeadline])),
  topUp: (s: Signer, vault: `0x${string}`, policyId: string, amount: bigint) =>
    run(() => withFunding(s, vault, amount, "topUp", [id(policyId), amount])),
  addFeeAllowance: (s: Signer, vault: `0x${string}`, policyId: string, amount: bigint) =>
    run(() => withFunding(s, vault, amount, "addFeeAllowance", [id(policyId), amount])),
  /** A one-off pulls the difference now; a schedule only raises what later transfers pay. */
  raiseMaxFee: (s: Signer, vault: `0x${string}`, policyId: string, newMaxFee: bigint, pull: bigint) =>
    run(() => (pull > 0n
      ? withFunding(s, vault, pull, "raiseMaxFee", [id(policyId), newMaxFee])
      : call(s, vault, "raiseMaxFee", [id(policyId), newMaxFee]))),

  /**
   * The attester signs the policy's EIP-712 statement in their wallet, then carries it onchain. The
   * vault accepts it from anyone; only the named attester's signature counts.
   */
  attest: (s: Signer, vault: `0x${string}`, policyId: string) => run(async () => {
    const signature = await s.wallet.signTypedData({
      account: s.account,
      domain: { name: "PolicyVault", version: "5", chainId: ARC.id, verifyingContract: vault },
      types: { Attestation: [{ name: "policyId", type: "uint256" }] },
      primaryType: "Attestation",
      message: { policyId: id(policyId) },
    });
    return call(s, vault, "attest", [id(policyId), signature]);
  }),
};

/** Who the connected account is to a policy, read from the vault rather than inferred. */
export async function rolesFor(s: Signer, vault: `0x${string}`, policyId: string, conditionType: string) {
  if (conditionType !== "Approval") return { approver: false, approved: false };
  const read = (functionName: "isApprover" | "hasApproved") =>
    s.client.readContract({ address: vault, abi: VAULT_ABI, functionName, args: [id(policyId), s.account] }) as Promise<boolean>;
  const [approver, approved] = await Promise.all([read("isApprover"), read("hasApproved")]);
  return { approver, approved };
}

/** Whether the vault's guardian has paused releases. */
export async function pausedState(s: Signer, vault: `0x${string}`): Promise<boolean> {
  return (await s.client.readContract({ address: vault, abi: VAULT_ABI, functionName: "paused" })) as boolean;
}
