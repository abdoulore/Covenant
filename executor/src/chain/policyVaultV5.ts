/**
 * PolicyVaultV5's interface, as the offchain code uses it.
 *
 * Hand-written rather than imported from the Foundry artifact, so the executor builds without the
 * contracts, which is how the other vaults' tuples work too. The risk of hand-writing is drift: a
 * field added or reordered in the struct would make every policy read as garbage without an error.
 * test/policyVaultV5Abi.test.ts compares this against the compiled artifact to close that gap.
 */

/** The Policy struct, in declaration order. */
export const V5_POLICY_COMPONENTS = [
  { name: "owner", type: "address" },
  { name: "recipient", type: "address" },
  { name: "amount", type: "uint256" },
  { name: "funded", type: "uint256" },
  { name: "feeAllowance", type: "uint256" },
  { name: "maxFeePerTransfer", type: "uint256" },
  { name: "destinationDomain", type: "uint32" },
  { name: "conditionType", type: "uint8" },
  { name: "status", type: "uint8" },
  { name: "deadline", type: "uint64" },
  { name: "pausedAtCreation", type: "uint64" },
  { name: "releaseTime", type: "uint64" },
  { name: "threshold", type: "uint8" },
  { name: "approvalCount", type: "uint8" },
  { name: "attester", type: "address" },
  { name: "attested", type: "bool" },
  { name: "feed", type: "address" },
  { name: "comparator", type: "uint8" },
  { name: "maxStaleSeconds", type: "uint64" },
  { name: "oracleThreshold", type: "int256" },
  { name: "adapter", type: "address" },
  { name: "feedId", type: "bytes32" },
  { name: "maxConfBps", type: "uint16" },
  { name: "recurring", type: "bool" },
  { name: "isSweep", type: "bool" },
  { name: "amountPerPeriod", type: "uint256" },
  { name: "buffer", type: "uint256" },
  { name: "minSweep", type: "uint256" },
  { name: "interval", type: "uint64" },
  { name: "nextDue", type: "uint64" },
  { name: "stoppedAt", type: "uint64" },
  { name: "periods", type: "uint32" },
  { name: "periodsReleased", type: "uint32" },
] as const;

const id = [{ name: "policyId", type: "uint256" }] as const;
const view = (name: string, inputs: readonly unknown[], outputs: readonly unknown[]) =>
  ({ type: "function", name, stateMutability: "view", inputs, outputs }) as const;

export const V5_ABI = [
  view("nextPolicyId", [], [{ type: "uint256" }]),
  view("getPolicy", id, [{ type: "tuple", components: V5_POLICY_COMPONENTS }]),
  view("statusOf", id, [{ type: "uint8" }]),
  view("effectiveDeadline", id, [{ type: "uint256" }]),
  view("checkCondition", id, [{ type: "bool" }]),
  view("isPeriodDue", id, [{ type: "bool" }]),
  view("paused", [], [{ type: "bool" }]),
  { type: "function", name: "release", stateMutability: "nonpayable", inputs: id, outputs: [] },
  { type: "function", name: "releasePeriod", stateMutability: "nonpayable", inputs: id, outputs: [] },
  {
    type: "function", name: "releaseWithProof", stateMutability: "payable",
    inputs: [...id, { name: "proof", type: "bytes" }], outputs: [],
  },
  {
    type: "event", name: "PolicyReleased", anonymous: false,
    inputs: [
      { name: "policyId", type: "uint256", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "destinationDomain", type: "uint32", indexed: false },
      { name: "periodIndex", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
    ],
  },
] as const;

export const V5_CONDITION = ["Timelock", "Approval", "Attestation", "Oracle", "Schedule", "OraclePull"] as const;
export const V5_STATUS = ["Pending", "Releasable", "Executed", "Cancelled"] as const;
export const V5_COMPARATOR = ["Gte", "Lte"] as const;

/** Status values, by name, for comparisons that would otherwise be magic numbers. */
export const V5_STATUS_CODE = { Pending: 0, Releasable: 1, Executed: 2, Cancelled: 3 } as const;
/** The OraclePull condition's code. */
export const V5_ORACLE_PULL = 5;

/** Every custom error the vault can raise, so refusals decode to a name. Checked against the build. */
export const V5_ERRORS = [
  {"type":"error","name":"AddressEmptyCode","inputs":[{"name":"target","type":"address"}]},
  {"type":"error","name":"AlreadyApproved","inputs":[{"name":"policyId","type":"uint256"},{"name":"approver","type":"address"}]},
  {"type":"error","name":"AlreadyAttested","inputs":[{"name":"policyId","type":"uint256"}]},
  {"type":"error","name":"AlreadyPaused","inputs":[{"name":"until","type":"uint64"}]},
  {"type":"error","name":"BeforeDeadline","inputs":[{"name":"policyId","type":"uint256"},{"name":"effectiveDeadline","type":"uint256"}]},
  {"type":"error","name":"CapNotHigher","inputs":[{"name":"current","type":"uint256"},{"name":"proposed","type":"uint256"}]},
  {"type":"error","name":"ConditionMet","inputs":[{"name":"policyId","type":"uint256"}]},
  {"type":"error","name":"ConditionNotMet","inputs":[{"name":"policyId","type":"uint256"}]},
  {"type":"error","name":"ConfidenceTooWide","inputs":[{"name":"policyId","type":"uint256"},{"name":"conf","type":"uint256"},{"name":"value","type":"uint256"},{"name":"maxConfBps","type":"uint16"}]},
  {"type":"error","name":"DeadlineNotLater","inputs":[{"name":"current","type":"uint64"},{"name":"proposed","type":"uint64"}]},
  {"type":"error","name":"DeadlineTooSoon","inputs":[{"name":"deadline","type":"uint64"},{"name":"earliest","type":"uint256"}]},
  {"type":"error","name":"DuplicateApprover","inputs":[{"name":"approver","type":"address"}]},
  {"type":"error","name":"ECDSAInvalidSignature","inputs":[]},
  {"type":"error","name":"ECDSAInvalidSignatureLength","inputs":[{"name":"length","type":"uint256"}]},
  {"type":"error","name":"ECDSAInvalidSignatureS","inputs":[{"name":"s","type":"bytes32"}]},
  {"type":"error","name":"FailedCall","inputs":[]},
  {"type":"error","name":"FeeAllowanceShort","inputs":[{"name":"policyId","type":"uint256"},{"name":"allowance","type":"uint256"},{"name":"required","type":"uint256"}]},
  {"type":"error","name":"FeeNotHigher","inputs":[{"name":"current","type":"uint256"},{"name":"proposed","type":"uint256"}]},
  {"type":"error","name":"InsufficientFee","inputs":[{"name":"required","type":"uint256"},{"name":"sent","type":"uint256"}]},
  {"type":"error","name":"InvalidApprovalConfig","inputs":[]},
  {"type":"error","name":"InvalidAttestationSignature","inputs":[{"name":"policyId","type":"uint256"}]},
  {"type":"error","name":"InvalidFee","inputs":[{"name":"destinationDomain","type":"uint32"},{"name":"maxFeePerTransfer","type":"uint256"}]},
  {"type":"error","name":"InvalidOracleConfig","inputs":[]},
  {"type":"error","name":"InvalidOraclePullConfig","inputs":[]},
  {"type":"error","name":"InvalidRecurringConfig","inputs":[]},
  {"type":"error","name":"InvalidShortString","inputs":[]},
  {"type":"error","name":"InvalidSweepConfig","inputs":[]},
  {"type":"error","name":"NotAnApprover","inputs":[{"name":"policyId","type":"uint256"},{"name":"caller","type":"address"}]},
  {"type":"error","name":"NotGuardian","inputs":[{"name":"caller","type":"address"}]},
  {"type":"error","name":"NotPaused","inputs":[]},
  {"type":"error","name":"NotPolicyOwner","inputs":[{"name":"policyId","type":"uint256"},{"name":"caller","type":"address"}]},
  {"type":"error","name":"NotRecurring","inputs":[{"name":"policyId","type":"uint256"}]},
  {"type":"error","name":"OverCap","inputs":[{"name":"wouldHold","type":"uint256"},{"name":"fundsCap","type":"uint256"}]},
  {"type":"error","name":"PastDeadline","inputs":[{"name":"policyId","type":"uint256"},{"name":"effectiveDeadline","type":"uint256"}]},
  {"type":"error","name":"PauseCoolingDown","inputs":[{"name":"availableAt","type":"uint256"}]},
  {"type":"error","name":"PeriodNotDue","inputs":[{"name":"policyId","type":"uint256"},{"name":"nextDue","type":"uint64"},{"name":"nowTs","type":"uint256"}]},
  {"type":"error","name":"PermitFailed","inputs":[]},
  {"type":"error","name":"PolicyIsStopped","inputs":[{"name":"policyId","type":"uint256"}]},
  {"type":"error","name":"PolicyNotPending","inputs":[{"name":"policyId","type":"uint256"},{"name":"status","type":"uint8"}]},
  {"type":"error","name":"ReentrancyGuardReentrantCall","inputs":[]},
  {"type":"error","name":"RefundFailed","inputs":[{"name":"to","type":"address"},{"name":"amount","type":"uint256"}]},
  {"type":"error","name":"ReleaseTimeInPast","inputs":[{"name":"releaseTime","type":"uint64"},{"name":"nowTs","type":"uint256"}]},
  {"type":"error","name":"ReleasesPaused","inputs":[{"name":"until","type":"uint64"}]},
  {"type":"error","name":"SafeERC20FailedOperation","inputs":[{"name":"token","type":"address"}]},
  {"type":"error","name":"StringTooLong","inputs":[{"name":"str","type":"string"}]},
  {"type":"error","name":"SweepBelowMin","inputs":[{"name":"policyId","type":"uint256"},{"name":"slice","type":"uint256"},{"name":"minSweep","type":"uint256"}]},
  {"type":"error","name":"Underfunded","inputs":[{"name":"policyId","type":"uint256"},{"name":"funded","type":"uint256"},{"name":"required","type":"uint256"}]},
  {"type":"error","name":"UnknownPolicy","inputs":[{"name":"policyId","type":"uint256"}]},
  {"type":"error","name":"UnsupportedDestination","inputs":[{"name":"destinationDomain","type":"uint32"}]},
  {"type":"error","name":"UseCancelWithProof","inputs":[{"name":"policyId","type":"uint256"}]},
  {"type":"error","name":"UseReleasePeriod","inputs":[{"name":"policyId","type":"uint256"}]},
  {"type":"error","name":"UseReleaseWithProof","inputs":[{"name":"policyId","type":"uint256"}]},
  {"type":"error","name":"UseStop","inputs":[{"name":"policyId","type":"uint256"}]},
  {"type":"error","name":"WrongConditionType","inputs":[{"name":"policyId","type":"uint256"},{"name":"expected","type":"uint8"},{"name":"actual","type":"uint8"}]},
  {"type":"error","name":"ZeroAddress","inputs":[]},
  {"type":"error","name":"ZeroAmount","inputs":[]},
] as const;
