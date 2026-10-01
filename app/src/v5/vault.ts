/**
 * Every v5 transaction the app asks a wallet to sign, and how it reads the answer.
 *
 * Each one is simulated first, from the user's own account, so a refusal comes back as the vault's
 * own reason ("DeadlineTooSoon", "ConditionNotMet") before the wallet asks for anything, and a
 * transaction the vault would refuse is never offered for signature.
 *
 * Money moves into the vault the way Arc provides for it: the exact approval and the action that
 * spends it go in one transaction through Arc's Multicall3From, which runs both as the user. One
 * wallet prompt, and no allowance left behind. Where that path is unavailable, an EIP-2612 permit
 * spent through the vault's own multicall does the same with a signature and a transaction; a smart
 * account, which can use neither, approves and then acts.
 *
 * Arc-specific (docs.arc.io, EVM differences): a transaction offering less than 20 gwei is dropped by
 * the mempool without a receipt, so every send carries at least that, and no wait is open-ended.
 */
import {
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError, WaitForTransactionReceiptTimeoutError,
  decodeErrorResult, decodeEventLog, encodeFunctionData, parseAbi, parseSignature, type Abi, type Hex,
} from "viem";
import vaultAbiJson from "./vaultAbi.json";
import { ARC, ARC_DOMAIN, IRIS, MIN_MAX_FEE_PER_GAS, MULTICALL3_FROM, USDC, txUrl } from "./chain";
import { walletMessage } from "./wallet";
import type { Signer } from "./signer";

export const VAULT_ABI = vaultAbiJson as Abi;

const BATCH_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

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

/** Fees for a send, never under Arc's floor: below it the transaction is dropped without trace. */
async function fees(s: Signer): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const f = await s.client.estimateFeesPerGas();
  const maxFeePerGas = f.maxFeePerGas > MIN_MAX_FEE_PER_GAS ? f.maxFeePerGas : MIN_MAX_FEE_PER_GAS;
  const tip = f.maxPriorityFeePerGas ?? 0n;
  return { maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas };
}

/** Wait for a receipt, but not forever: Arc finalizes on inclusion, so 90 seconds without one means trouble. */
async function confirm(s: Signer, hash: Hex) {
  try {
    return await s.client.waitForTransactionReceipt({ hash, timeout: 90_000 });
  } catch (e) {
    if (e instanceof WaitForTransactionReceiptTimeoutError) {
      throw new TxError(
        "Arc has not included this transaction after 90 seconds. It may have been dropped; check it on the explorer before trying again, so nothing is sent twice.",
        txUrl(hash),
      );
    }
    throw e;
  }
}

/** Send a prepared request, wait for it, and read any policy it created. */
async function send(s: Signer, vault: `0x${string}`, request: unknown): Promise<Sent> {
  const hash = await s.wallet.writeContract({ ...(request as object), ...(await fees(s)) } as never);
  const receipt = await confirm(s, hash);
  if (receipt.status !== "success") throw new TxError("The transaction reverted onchain.", hash);
  const created = receipt.logs
    .filter((l) => l.address.toLowerCase() === vault.toLowerCase())
    .map((l) => { try { return decodeEventLog({ abi: VAULT_ABI, data: l.data, topics: l.topics }); } catch { return null; } })
    .find((d) => d?.eventName === "PolicyCreated");
  const policyId = created ? String((created.args as unknown as { policyId: bigint }).policyId) : undefined;
  return { hash, url: txUrl(hash), ...(policyId ? { policyId } : {}) };
}

/** Simulate, send, and wait for one call to the vault. */
async function call(s: Signer, vault: `0x${string}`, functionName: string, args: readonly unknown[], value?: bigint): Promise<Sent> {
  const { request } = await s.client.simulateContract({
    account: s.account, address: vault, abi: VAULT_ABI, functionName, args, ...(value ? { value } : {}),
  } as never);
  return send(s, vault, request);
}

/**
 * Approve exactly `pull` and run the vault action in one transaction through Arc's Multicall3From,
 * both as the user. Simulated first with failures allowed, so a refusal comes back with the vault's
 * own reason rather than the batcher's generic one; sent with failures not allowed, so it is all or
 * nothing.
 */
async function batchFrom(s: Signer, vault: `0x${string}`, pull: bigint, action: Hex): Promise<Sent> {
  const approve = encodeFunctionData({ abi: USDC_ABI, functionName: "approve", args: [vault, pull] });
  const calls = (allowFailure: boolean) => [
    { target: USDC, allowFailure, callData: approve },
    { target: vault, allowFailure, callData: action },
  ];
  const { result } = await s.client.simulateContract({
    account: s.account, address: MULTICALL3_FROM, abi: BATCH_ABI, functionName: "aggregate3", args: [calls(true)],
  });
  const [approved, acted] = result as readonly { success: boolean; returnData: Hex }[];
  if (!approved?.success) throw new TxError("USDC refused the approval for this.");
  if (!acted?.success) {
    let reason: string = acted?.returnData ?? "no reason given";
    try {
      const err = decodeErrorResult({ abi: VAULT_ABI, data: acted!.returnData });
      reason = `${err.errorName}(${(err.args ?? []).map(String).join(", ")})`;
    } catch { /* not one of the vault's errors: show the raw data */ }
    throw new TxError("The vault refused this.", reason);
  }
  const { request } = await s.client.simulateContract({
    account: s.account, address: MULTICALL3_FROM, abi: BATCH_ABI, functionName: "aggregate3", args: [calls(false)],
  });
  return send(s, vault, request);
}

/**
 * Run an action that pulls `pull` USDC from the user, by the best path the account allows: none
 * needed when an allowance already covers it; Arc's Multicall3From for an ordinary wallet; a permit
 * through the vault's multicall if that fails for a reason other than a refusal; and, for a smart
 * account, an exact approval and then the action.
 */
async function withFunding(s: Signer, vault: `0x${string}`, pull: bigint, functionName: string, args: readonly unknown[]): Promise<Sent> {
  const balance = await usdcBalance(s);
  if (balance < pull) {
    throw new TxError(`This needs ${fmt(pull)} USDC from your wallet, and it holds ${fmt(balance)}.`);
  }
  const allowance = (await s.client.readContract({ address: USDC, abi: USDC_ABI, functionName: "allowance", args: [s.account, vault] })) as bigint;
  if (allowance >= pull) return call(s, vault, functionName, args);

  const action = encodeFunctionData({ abi: VAULT_ABI, functionName, args });
  const isContract = !!(await s.client.getCode({ address: s.account }));
  if (!isContract) {
    try {
      return await batchFrom(s, vault, pull, action);
    } catch (e) {
      // A refusal, or the user's own "no", is the answer. Anything else: try the permit path.
      if (e instanceof TxError) throw e;
      if (e instanceof BaseError && e.walk((x) => x instanceof UserRejectedRequestError)) throw explain(e);
    }
    const permit = await permitCall(s, vault, pull);
    return permit ? call(s, vault, "multicall", [[permit, action]]) : call(s, vault, functionName, args);
  }
  // A smart account signs as neither path needs, so approve exactly, then act.
  const { request } = await s.client.simulateContract({ account: s.account, address: USDC, abi: USDC_ABI, functionName: "approve", args: [vault, pull] });
  const hash = await s.wallet.writeContract({ ...request, ...(await fees(s)) } as never);
  await confirm(s, hash);
  return call(s, vault, functionName, args);
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
