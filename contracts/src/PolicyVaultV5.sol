// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IOracleAdapter} from "./IOracleAdapter.sol";
import {ITokenMessengerV2} from "./ITokenMessengerV2.sol";

/// @notice The one call the Oracle condition makes on a Chainlink AggregatorV3 feed.
interface IChainlinkFeed {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title PolicyVaultV5
/// @notice Non-custodial conditional payments. Anyone creates and funds a policy from their own
///         wallet; the vault pays the recipient itself when the condition is met; nobody else ever
///         holds the money. Spec: docs/specs/V5_VAULT.md. Decision: DECISIONS D16.
///
/// @dev WHAT A POLICY PROMISES, AND TO WHOM.
///      Every policy has an owner (its creator), a recipient, a condition, and a deadline.
///        - Before the deadline, anyone may release once the condition is met, and the money goes
///          to the recipient and nowhere else. The owner may cancel only while it is NOT met.
///        - At or after the deadline, release is closed and only the owner may reclaim.
///      So a recipient whose condition is met is paid if anyone releases before the deadline, and
///      an owner is never locked out forever. There is no admin that can move a policy's funds:
///      the only paths out are to the recipient and back to the owner.
///
/// @dev DECIMALS. Arc exposes one USDC balance through an 18 decimal native view (gas, msg.value)
///      and a 6 decimal ERC-20 view at 0x3600...0000. Every amount here is the 6 decimal view,
///      moved only with SafeERC20. msg.value appears only in the two proof functions, where it is
///      forwarded to the oracle adapter as its quoted fee and the excess refunded, never mixed with
///      policy amounts. There is no receive() and no fallback().
///
/// @dev CROSS-CHAIN FEES. The vault burns through CCTP v2 with Circle's forwarding hook, and Circle
///      collects the whole `maxFee` (VERIFICATIONS V24). So each policy fixes a per-transfer fee,
///      funded by the owner on top of the payout, and the recipient receives exactly the payout.
///      The fee is never chosen by the caller of release: a caller free to pass zero could stop the
///      forwarder and leave the recipient needing gas to mint.
///
/// @dev THE GUARDIAN can do exactly three things, none of which moves or freezes a policy's funds:
///      pause releases for at most MAX_PAUSE (owners can still cancel unmet policies, stop, extend,
///      and reclaim), raise or remove the cap on total funds held, and hand itself on or renounce.
///      Time spent paused is added to every deadline, so a pause cannot turn a recipient's payment
///      into an owner's refund.
contract PolicyVaultV5 is ReentrancyGuard, EIP712, Multicall {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice CCTP domain of Arc. A policy paying here is a direct transfer.
    uint32 public constant ARC_DOMAIN = 26;

    /// @notice Largest approver set, bounded by approvalCount's uint8.
    uint256 public constant MAX_APPROVERS = 255;

    /// @notice The least time a deadline must leave: after creation, after a timelock's release
    ///         time, and after a schedule's start (or a fixed payroll's last period).
    uint64 public constant MIN_WINDOW = 7 days;

    /// @notice A pause ends by itself after this long.
    uint64 public constant MAX_PAUSE = 7 days;

    /// @notice How long after a pause ends before another may begin.
    uint64 public constant PAUSE_COOLDOWN = 7 days;

    /// @notice CCTP Standard finality. From Arc it costs nothing extra and is already fast (V10, V25).
    uint32 public constant STANDARD_FINALITY = 2000;

    /// @notice Circle's forwarding hook: "cctp-forward", version 0, payload length 0.
    bytes public constant FORWARD_HOOK = hex"636374702d666f72776172640000000000000000000000000000000000000000";

    bytes32 private constant ATTESTATION_TYPEHASH = keccak256("Attestation(uint256 policyId)");

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @dev Same values and order as v4, so readers keep one mapping across deployments.
    enum ConditionType {
        Timelock,
        Approval,
        Attestation,
        Oracle,
        Schedule,
        OraclePull
    }

    enum Comparator {
        Gte,
        Lte
    }

    /// @dev Releasable is never stored; statusOf() derives it.
    enum Status {
        Pending,
        Releasable,
        Executed,
        Cancelled
    }

    /// @notice What every creator takes.
    /// @param amount The one-off payout. Must be 0 for payroll and sweep, which use their own terms.
    /// @param deadline Last moment a release is possible; after it the owner may reclaim.
    /// @param maxFeePerTransfer 0 for a payout on Arc. For cross-chain, the CCTP maxFee paid on each
    ///        transfer, which Circle collects in full. Size it from the fee API's high tier.
    struct Terms {
        address recipient;
        uint256 amount;
        uint32 destinationDomain;
        uint64 deadline;
        uint256 maxFeePerTransfer;
    }

    struct Policy {
        address owner;
        address recipient;
        uint256 amount;
        // What the vault holds toward payouts. A one-off policy holds exactly `amount` from creation.
        uint256 funded;
        // What the vault holds toward cross-chain fees, separate so it is never paid to a recipient.
        uint256 feeAllowance;
        uint256 maxFeePerTransfer;
        uint32 destinationDomain;
        ConditionType conditionType;
        Status status;
        uint64 deadline;
        // pausedSeconds() when the policy was created; pause time after this extends the deadline.
        uint64 pausedAtCreation;
        // Timelock.
        uint64 releaseTime;
        // Approval.
        uint8 threshold;
        uint8 approvalCount;
        // Attestation.
        address attester;
        bool attested;
        // Oracle (a Chainlink feed, threshold in the feed's decimals) and OraclePull (an adapter,
        // threshold in 1e18). Readers must branch on conditionType to scale oracleThreshold.
        address feed;
        Comparator comparator;
        uint64 maxStaleSeconds;
        int256 oracleThreshold;
        address adapter;
        bytes32 feedId;
        uint16 maxConfBps;
        // Payroll and sweep.
        bool recurring;
        bool isSweep;
        uint256 amountPerPeriod;
        uint256 buffer;
        uint256 minSweep;
        uint64 interval;
        uint64 nextDue;
        // 0 while running. Once stopped, only periods due at or before this may still be released.
        uint64 stoppedAt;
        uint32 periods;
        uint32 periodsReleased;
    }

    // ---------------------------------------------------------------------
    // State
    // ---------------------------------------------------------------------

    IERC20 public immutable usdc;

    /// @notice CCTP v2 TokenMessenger, or zero when this deployment pays on Arc only.
    ITokenMessengerV2 public immutable tokenMessenger;

    uint256 public nextPolicyId;

    mapping(uint256 policyId => Policy) private _policies;
    mapping(uint256 policyId => mapping(address account => bool)) public isApprover;
    mapping(uint256 policyId => mapping(address account => bool)) public hasApproved;

    /// @notice Cross-chain destinations this deployment will pay to, fixed at deployment. EVM chains
    ///         only: a recipient is an EVM address, and CCTP also serves non-EVM chains where that
    ///         encoding would mint to an account nobody controls.
    mapping(uint32 domain => bool) public isDestination;

    address public guardian;
    address public pendingGuardian;

    /// @notice The most the vault may hold across all policies. Only ever raised.
    uint256 public fundsCap;

    /// @notice Everything currently held for policies, payouts and fee allowances together.
    uint256 public totalHeld;

    uint64 private _pauseStart;
    uint64 private _pauseEnd;
    uint64 private _pausedAccrued;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event PolicyCreated(
        uint256 indexed policyId,
        address indexed owner,
        address indexed recipient,
        ConditionType conditionType,
        uint256 amount,
        uint32 destinationDomain,
        uint64 deadline
    );
    event Funded(uint256 indexed policyId, uint256 toPayouts, uint256 toFees);
    event MaxFeeRaised(uint256 indexed policyId, uint256 maxFeePerTransfer);
    event DeadlineExtended(uint256 indexed policyId, uint64 deadline);
    event Approved(uint256 indexed policyId, address indexed approver, uint8 approvalCount, uint8 threshold);
    event Attested(uint256 indexed policyId, address indexed attester);
    /// @dev periodIndex is 0 for a one-off release and 1, 2, 3... per period. `fee` is the CCTP
    ///      maxFee burned alongside a cross-chain payout, 0 on Arc.
    event PolicyReleased(
        uint256 indexed policyId,
        address indexed recipient,
        uint256 amount,
        uint32 destinationDomain,
        uint256 periodIndex,
        uint256 fee
    );
    event PolicyCancelled(uint256 indexed policyId, address indexed refundTo, uint256 refunded);
    event PolicyStopped(uint256 indexed policyId, uint256 keptForRecipient, uint256 refunded);
    event PolicyFinished(uint256 indexed policyId, uint256 refunded);
    event Paused(uint64 until);
    event Unpaused();
    event CapRaised(uint256 fundsCap);
    event GuardianProposed(address indexed guardian);
    event GuardianChanged(address indexed previous, address indexed current);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error UnknownPolicy(uint256 policyId);
    error NotPolicyOwner(uint256 policyId, address caller);
    error NotGuardian(address caller);
    error PolicyNotPending(uint256 policyId, Status status);
    error ConditionNotMet(uint256 policyId);
    error ConditionMet(uint256 policyId);
    error PastDeadline(uint256 policyId, uint256 effectiveDeadline);
    error BeforeDeadline(uint256 policyId, uint256 effectiveDeadline);
    error DeadlineTooSoon(uint64 deadline, uint256 earliest);
    error DeadlineNotLater(uint64 current, uint64 proposed);
    error Underfunded(uint256 policyId, uint256 funded, uint256 required);
    error FeeAllowanceShort(uint256 policyId, uint256 allowance, uint256 required);
    error ReleaseTimeInPast(uint64 releaseTime, uint256 nowTs);
    error InvalidApprovalConfig();
    error DuplicateApprover(address approver);
    error NotAnApprover(uint256 policyId, address caller);
    error AlreadyApproved(uint256 policyId, address approver);
    error WrongConditionType(uint256 policyId, ConditionType expected, ConditionType actual);
    error UnsupportedDestination(uint32 destinationDomain);
    error InvalidFee(uint32 destinationDomain, uint256 maxFeePerTransfer);
    error FeeNotHigher(uint256 current, uint256 proposed);
    error InvalidAttestationSignature(uint256 policyId);
    error AlreadyAttested(uint256 policyId);
    error InvalidOracleConfig();
    error InvalidOraclePullConfig();
    error InvalidRecurringConfig();
    error InvalidSweepConfig();
    error NotRecurring(uint256 policyId);
    error UseReleasePeriod(uint256 policyId);
    error UseReleaseWithProof(uint256 policyId);
    error UseCancelWithProof(uint256 policyId);
    error UseStop(uint256 policyId);
    error PolicyIsStopped(uint256 policyId);
    error PeriodNotDue(uint256 policyId, uint64 nextDue, uint256 nowTs);
    error SweepBelowMin(uint256 policyId, uint256 slice, uint256 minSweep);
    error InsufficientFee(uint256 required, uint256 sent);
    error ConfidenceTooWide(uint256 policyId, uint256 conf, uint256 value, uint16 maxConfBps);
    error RefundFailed(address to, uint256 amount);
    error OverCap(uint256 wouldHold, uint256 fundsCap);
    error CapNotHigher(uint256 current, uint256 proposed);
    error ReleasesPaused(uint64 until);
    error AlreadyPaused(uint64 until);
    error PauseCoolingDown(uint256 availableAt);
    error NotPaused();
    error PermitFailed();

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /// @param destinations Cross-chain CCTP domains to allow, EVM chains only. Empty for Arc only.
    /// @param guardian_ The pause and cap key, a multisig. Zero for none: then nothing can pause and
    ///        the cap can never be raised.
    /// @param fundsCap_ Initial cap on total funds held. type(uint256).max for no cap.
    constructor(
        address usdc_,
        address tokenMessenger_,
        uint32[] memory destinations,
        address guardian_,
        uint256 fundsCap_
    ) EIP712("PolicyVault", "5") {
        if (usdc_ == address(0)) revert ZeroAddress();
        if (fundsCap_ == 0) revert ZeroAmount();
        if (destinations.length > 0 && tokenMessenger_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        tokenMessenger = ITokenMessengerV2(tokenMessenger_);
        for (uint256 i = 0; i < destinations.length; ++i) {
            if (destinations[i] == ARC_DOMAIN) revert UnsupportedDestination(ARC_DOMAIN);
            isDestination[destinations[i]] = true;
        }
        guardian = guardian_;
        fundsCap = fundsCap_;
        emit GuardianChanged(address(0), guardian_);
    }

    // ---------------------------------------------------------------------
    // Creating a policy. Each one-off creator pulls payout plus fee in the same call, so a
    // one-off policy is never partly funded.
    // ---------------------------------------------------------------------

    /// @notice Pays after `releaseTime`.
    function createTimelockPolicy(Terms calldata t, uint64 releaseTime)
        external
        nonReentrant
        returns (uint256 policyId)
    {
        if (releaseTime <= block.timestamp) revert ReleaseTimeInPast(releaseTime, block.timestamp);
        _requireDeadlineAfter(t.deadline, releaseTime);
        Policy storage p;
        (policyId, p) = _open(t, ConditionType.Timelock);
        p.releaseTime = releaseTime;
        _fundOneOff(policyId, p, t.amount);
    }

    /// @notice Pays once `threshold` of `approvers` have approved.
    function createApprovalPolicy(Terms calldata t, address[] calldata approvers, uint8 threshold)
        external
        nonReentrant
        returns (uint256 policyId)
    {
        // Bounded so approvalCount, a uint8, can never wrap back below a met threshold.
        if (approvers.length == 0 || approvers.length > MAX_APPROVERS || threshold == 0 || threshold > approvers.length) {
            revert InvalidApprovalConfig();
        }
        Policy storage p;
        (policyId, p) = _open(t, ConditionType.Approval);
        p.threshold = threshold;
        for (uint256 i = 0; i < approvers.length; ++i) {
            address a = approvers[i];
            if (a == address(0)) revert ZeroAddress();
            if (isApprover[policyId][a]) revert DuplicateApprover(a);
            isApprover[policyId][a] = true;
        }
        _fundOneOff(policyId, p, t.amount);
    }

    /// @notice Pays once `attester` has signed the policy's EIP-712 statement (see attest()).
    function createAttestationPolicy(Terms calldata t, address attester)
        external
        nonReentrant
        returns (uint256 policyId)
    {
        if (attester == address(0)) revert ZeroAddress();
        Policy storage p;
        (policyId, p) = _open(t, ConditionType.Attestation);
        p.attester = attester;
        _fundOneOff(policyId, p, t.amount);
    }

    /// @notice Pays while a Chainlink feed satisfies `comparator threshold`.
    /// @param threshold In the feed's own decimals.
    /// @param maxStaleSeconds Oldest acceptable answer. Must exceed the feed's heartbeat, which is
    ///        24 hours for USDC/USD on Arc (V27), or a healthy feed reads as stale.
    function createOraclePolicy(
        Terms calldata t,
        address feed,
        Comparator comparator,
        int256 threshold,
        uint64 maxStaleSeconds
    ) external nonReentrant returns (uint256 policyId) {
        if (feed == address(0)) revert ZeroAddress();
        if (maxStaleSeconds == 0) revert InvalidOracleConfig();
        Policy storage p;
        (policyId, p) = _open(t, ConditionType.Oracle);
        p.feed = feed;
        p.comparator = comparator;
        p.oracleThreshold = threshold;
        p.maxStaleSeconds = maxStaleSeconds;
        _fundOneOff(policyId, p, t.amount);
    }

    /// @notice Pays when a signed price, verified by `adapter` at release, satisfies the rule.
    /// @param threshold1e18 In 18 decimals, whatever the oracle's own scale: the adapter normalizes.
    /// @param maxConfBps Refuse a price whose confidence interval exceeds this share of it. 0 disables.
    function createOraclePullPolicy(
        Terms calldata t,
        address adapter,
        bytes32 feedId,
        Comparator comparator,
        int256 threshold1e18,
        uint64 maxStaleSeconds,
        uint16 maxConfBps
    ) external nonReentrant returns (uint256 policyId) {
        if (adapter == address(0)) revert ZeroAddress();
        if (maxStaleSeconds == 0 || feedId == bytes32(0) || maxConfBps > 10_000) revert InvalidOraclePullConfig();
        Policy storage p;
        (policyId, p) = _open(t, ConditionType.OraclePull);
        p.adapter = adapter;
        p.feedId = feedId;
        p.comparator = comparator;
        p.oracleThreshold = threshold1e18;
        p.maxStaleSeconds = maxStaleSeconds;
        p.maxConfBps = maxConfBps;
        _fundOneOff(policyId, p, t.amount);
    }

    /// @notice Payroll: `amountPerPeriod` every `interval` from `startTime`, for `periods` periods,
    ///         or open-ended when `periods` is 0. The deadline is also the end of the schedule.
    /// @param initialFunding Pulled into the payroll balance now; top up later with topUp().
    /// @param initialFees Pulled into the fee allowance now. Must be 0 for a payout on Arc.
    function createRecurringPolicy(
        Terms calldata t,
        uint256 amountPerPeriod,
        uint64 interval,
        uint64 startTime,
        uint32 periods,
        uint256 initialFunding,
        uint256 initialFees
    ) external nonReentrant returns (uint256 policyId) {
        if (t.amount != 0 || amountPerPeriod == 0 || interval == 0 || startTime == 0) revert InvalidRecurringConfig();
        _requireDeadlineAfter(t.deadline, startTime);
        if (periods != 0) {
            // A fixed payroll's last period must leave the same window as its first.
            _requireDeadlineAfter(t.deadline, uint256(startTime) + uint256(periods - 1) * uint256(interval));
        }
        Policy storage p;
        (policyId, p) = _open(t, ConditionType.Schedule);
        p.recurring = true;
        p.amountPerPeriod = amountPerPeriod;
        p.interval = interval;
        p.nextDue = startTime;
        p.periods = periods;
        _fundRecurring(policyId, p, initialFunding, initialFees);
    }

    /// @notice Sweep: each `interval`, pay everything held above `buffer`, skipping when the excess
    ///         is below `minSweep`. Runs until stopped or until its deadline.
    function createSweepPolicy(
        Terms calldata t,
        uint256 buffer,
        uint256 minSweep,
        uint64 interval,
        uint64 startTime,
        uint256 initialFunding,
        uint256 initialFees
    ) external nonReentrant returns (uint256 policyId) {
        if (t.amount != 0 || minSweep == 0 || interval == 0 || startTime == 0) revert InvalidSweepConfig();
        _requireDeadlineAfter(t.deadline, startTime);
        Policy storage p;
        (policyId, p) = _open(t, ConditionType.Schedule);
        p.recurring = true;
        p.isSweep = true;
        p.buffer = buffer;
        p.minSweep = minSweep;
        p.interval = interval;
        p.nextDue = startTime;
        _fundRecurring(policyId, p, initialFunding, initialFees);
    }

    /// @notice Spend a USDC permit for this vault, so creating and funding can share one transaction
    ///         through multicall. Tolerates a permit someone else already submitted: what matters is
    ///         the allowance, not who landed the signature.
    function permitUsdc(uint256 value, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC20Permit(address(usdc)).permit(msg.sender, address(this), value, permitDeadline, v, r, s) {}
        catch {
            if (usdc.allowance(msg.sender, address(this)) < value) revert PermitFailed();
        }
    }

    // ---------------------------------------------------------------------
    // Conditions
    // ---------------------------------------------------------------------

    function approve(uint256 policyId) external {
        Policy storage p = _requirePolicy(policyId);
        if (p.status != Status.Pending) revert PolicyNotPending(policyId, p.status);
        if (p.conditionType != ConditionType.Approval) {
            revert WrongConditionType(policyId, ConditionType.Approval, p.conditionType);
        }
        if (!isApprover[policyId][msg.sender]) revert NotAnApprover(policyId, msg.sender);
        if (hasApproved[policyId][msg.sender]) revert AlreadyApproved(policyId, msg.sender);
        hasApproved[policyId][msg.sender] = true;
        unchecked {
            ++p.approvalCount;
        }
        emit Approved(policyId, msg.sender, p.approvalCount, p.threshold);
    }

    /// @notice Submit the attester's signature. Anyone may carry it onchain; only the named
    ///         attester's signature counts, and the latch is one-way.
    function attest(uint256 policyId, bytes calldata signature) external {
        Policy storage p = _requirePolicy(policyId);
        if (p.status != Status.Pending) revert PolicyNotPending(policyId, p.status);
        if (p.conditionType != ConditionType.Attestation) {
            revert WrongConditionType(policyId, ConditionType.Attestation, p.conditionType);
        }
        if (p.attested) revert AlreadyAttested(policyId);
        address signer = ECDSA.recover(attestationDigest(policyId), signature);
        if (signer != p.attester) revert InvalidAttestationSignature(policyId);
        p.attested = true;
        emit Attested(policyId, signer);
    }

    function attestationDigest(uint256 policyId) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ATTESTATION_TYPEHASH, policyId)));
    }

    // ---------------------------------------------------------------------
    // Release. Permissionless: the condition is the gate, and the money can only go to the
    // recipient. Closed while paused and at or after the deadline.
    // ---------------------------------------------------------------------

    function release(uint256 policyId) external nonReentrant {
        _requireNotPaused();
        Policy storage p = _requirePolicy(policyId);
        if (p.recurring) revert UseReleasePeriod(policyId);
        if (p.conditionType == ConditionType.OraclePull) revert UseReleaseWithProof(policyId);
        if (p.status != Status.Pending) revert PolicyNotPending(policyId, p.status);
        _requireBeforeDeadline(policyId, p);
        if (!_conditionMet(p)) revert ConditionNotMet(policyId);
        _releaseOneOff(policyId, p);
    }

    /// @notice Release a pull-oracle policy with a signed price. Send at least the adapter's quoted
    ///         fee in native value; the excess comes back.
    function releaseWithProof(uint256 policyId, bytes calldata proof) external payable nonReentrant {
        _requireNotPaused();
        Policy storage p = _requirePolicy(policyId);
        if (p.conditionType != ConditionType.OraclePull) {
            revert WrongConditionType(policyId, ConditionType.OraclePull, p.conditionType);
        }
        if (p.status != Status.Pending) revert PolicyNotPending(policyId, p.status);
        _requireBeforeDeadline(policyId, p);

        (bool met, bool confident, int256 value, uint256 conf, uint256 fee) = _readProof(p, proof);
        if (!met) revert ConditionNotMet(policyId);
        if (!confident) revert ConfidenceTooWide(policyId, conf, uint256(value), p.maxConfBps);

        _releaseOneOff(policyId, p);
        _refundNative(fee);
    }

    /// @notice Release the next due period of a payroll or sweep. Every overdue period can be
    ///         released, one call each: there is no catch-up gate, because stopping is how an
    ///         owner ends a schedule.
    function releasePeriod(uint256 policyId) external nonReentrant {
        _requireNotPaused();
        Policy storage p = _requirePolicy(policyId);
        if (!p.recurring) revert NotRecurring(policyId);
        if (p.status != Status.Pending) revert PolicyNotPending(policyId, p.status);
        _requireBeforeDeadline(policyId, p);
        if (block.timestamp < p.nextDue) revert PeriodNotDue(policyId, p.nextDue, block.timestamp);
        if (p.stoppedAt != 0 && p.nextDue > p.stoppedAt) revert PolicyIsStopped(policyId);

        uint256 slice = _slice(p);
        if (p.isSweep && slice < p.minSweep) revert SweepBelowMin(policyId, slice, p.minSweep);
        if (slice == 0 || p.funded < slice) revert Underfunded(policyId, p.funded, slice);
        uint256 fee = _feeFor(p);
        if (p.feeAllowance < fee) revert FeeAllowanceShort(policyId, p.feeAllowance, fee);

        p.funded -= slice;
        p.feeAllowance -= fee;
        uint32 index = ++p.periodsReleased;
        p.nextDue += p.interval;

        // Done when a fixed payroll's last period is out, or when a stopped schedule has paid
        // everything it kept. Whatever remains then belongs to the owner, not to the vault.
        bool finished = (!p.isSweep && p.periods != 0 && p.periodsReleased >= p.periods)
            || (p.stoppedAt != 0 && (p.funded == 0 || p.nextDue > p.stoppedAt));
        uint256 leftover;
        if (finished) {
            p.status = Status.Executed;
            leftover = p.funded + p.feeAllowance;
            p.funded = 0;
            p.feeAllowance = 0;
        }
        totalHeld -= slice + fee + leftover;

        _send(p, slice, fee);
        emit PolicyReleased(policyId, p.recipient, slice, p.destinationDomain, index, fee);
        if (finished) {
            if (leftover > 0) usdc.safeTransfer(p.owner, leftover);
            emit PolicyFinished(policyId, leftover);
        }
    }

    // ---------------------------------------------------------------------
    // What only a policy's owner may do. Each can only keep, add, or return the owner's own money;
    // none can redirect a payment.
    // ---------------------------------------------------------------------

    /// @notice Cancel a one-off policy before its deadline, while its condition is not met, and
    ///         take everything back.
    function cancel(uint256 policyId) external nonReentrant {
        Policy storage p = _ownedPending(policyId);
        if (p.recurring) revert UseStop(policyId);
        if (p.conditionType == ConditionType.OraclePull) revert UseCancelWithProof(policyId);
        _requireBeforeDeadline(policyId, p);
        if (_conditionMet(p)) revert ConditionMet(policyId);
        _refundAll(policyId, p);
    }

    /// @notice Cancel a pull-oracle policy before its deadline. The contract cannot judge the
    ///         condition without a price, so the owner supplies one, and the cancel succeeds only if
    ///         that same price could not release the policy.
    function cancelWithProof(uint256 policyId, bytes calldata proof) external payable nonReentrant {
        Policy storage p = _ownedPending(policyId);
        if (p.conditionType != ConditionType.OraclePull) {
            revert WrongConditionType(policyId, ConditionType.OraclePull, p.conditionType);
        }
        _requireBeforeDeadline(policyId, p);
        (bool met, bool confident,,, uint256 fee) = _readProof(p, proof);
        if (met && confident) revert ConditionMet(policyId);
        _refundAll(policyId, p);
        _refundNative(fee);
    }

    /// @notice Stop a payroll or sweep. Periods already due stay payable to the recipient until the
    ///         deadline; everything else returns to the owner now.
    function stop(uint256 policyId) external nonReentrant {
        Policy storage p = _ownedPending(policyId);
        if (!p.recurring) revert NotRecurring(policyId);
        if (p.stoppedAt != 0) revert PolicyIsStopped(policyId);
        _requireBeforeDeadline(policyId, p);

        (uint256 kept, uint256 keptFee) = _dueAtStop(p);
        uint256 refund = (p.funded - kept) + (p.feeAllowance - keptFee);
        totalHeld -= refund;
        if (kept == 0) {
            p.status = Status.Cancelled;
            p.funded = 0;
            p.feeAllowance = 0;
        } else {
            p.stoppedAt = uint64(block.timestamp);
            p.funded = kept;
            p.feeAllowance = keptFee;
            // A stopped sweep pays out exactly what it kept, so nothing is held back as a buffer.
            if (p.isSweep) p.buffer = 0;
        }
        if (refund > 0) usdc.safeTransfer(p.owner, refund);
        emit PolicyStopped(policyId, kept, refund);
    }

    /// @notice At or after the deadline, take back everything still held for the policy.
    function reclaim(uint256 policyId) external nonReentrant {
        Policy storage p = _ownedPending(policyId);
        uint256 deadline = effectiveDeadline(policyId);
        if (block.timestamp < deadline) revert BeforeDeadline(policyId, deadline);
        _refundAll(policyId, p);
    }

    /// @notice Push the deadline later. Never earlier: a later deadline only helps the recipient.
    function extendDeadline(uint256 policyId, uint64 newDeadline) external {
        Policy storage p = _ownedPending(policyId);
        if (newDeadline <= p.deadline) revert DeadlineNotLater(p.deadline, newDeadline);
        p.deadline = newDeadline;
        emit DeadlineExtended(policyId, newDeadline);
    }

    /// @notice Add to a running payroll or sweep's balance.
    function topUp(uint256 policyId, uint256 amount) external nonReentrant {
        Policy storage p = _ownedPending(policyId);
        if (!p.recurring) revert NotRecurring(policyId);
        if (p.stoppedAt != 0) revert PolicyIsStopped(policyId);
        _requireBeforeDeadline(policyId, p);
        if (amount == 0) revert ZeroAmount();
        p.funded += amount;
        _pull(amount);
        emit Funded(policyId, amount, 0);
    }

    /// @notice Add to a cross-chain payroll or sweep's fee allowance. Allowed after a stop too, so
    ///         the periods it kept can still be paid.
    function addFeeAllowance(uint256 policyId, uint256 amount) external nonReentrant {
        Policy storage p = _ownedPending(policyId);
        if (!p.recurring) revert NotRecurring(policyId);
        if (p.destinationDomain == ARC_DOMAIN) revert InvalidFee(p.destinationDomain, amount);
        _requireBeforeDeadline(policyId, p);
        if (amount == 0) revert ZeroAmount();
        p.feeAllowance += amount;
        _pull(amount);
        emit Funded(policyId, 0, amount);
    }

    /// @notice Raise the fee paid on each cross-chain transfer, for when destination gas has risen
    ///         since the policy was funded. Never lower. A one-off policy pulls the difference now,
    ///         so its allowance always covers its one transfer.
    function raiseMaxFee(uint256 policyId, uint256 newMaxFee) external nonReentrant {
        Policy storage p = _ownedPending(policyId);
        if (p.destinationDomain == ARC_DOMAIN) revert InvalidFee(p.destinationDomain, newMaxFee);
        if (newMaxFee <= p.maxFeePerTransfer) revert FeeNotHigher(p.maxFeePerTransfer, newMaxFee);
        _requireBeforeDeadline(policyId, p);
        uint256 extra;
        if (!p.recurring) {
            extra = newMaxFee - p.feeAllowance;
            p.feeAllowance = newMaxFee;
        }
        p.maxFeePerTransfer = newMaxFee;
        if (extra > 0) _pull(extra);
        emit MaxFeeRaised(policyId, newMaxFee);
        if (extra > 0) emit Funded(policyId, 0, extra);
    }

    // ---------------------------------------------------------------------
    // Guardian
    // ---------------------------------------------------------------------

    /// @notice Stop releases for MAX_PAUSE at most. Cancels of unmet policies, stops, extensions and
    ///         reclaims keep working. Every deadline moves out by the time spent paused.
    function pause() external {
        _onlyGuardian();
        if (paused()) revert AlreadyPaused(_pauseEnd);
        if (_pauseEnd != 0) {
            uint256 availableAt = uint256(_pauseEnd) + PAUSE_COOLDOWN;
            if (block.timestamp < availableAt) revert PauseCoolingDown(availableAt);
            // The previous pause is over; fold its full length into the running total.
            _pausedAccrued += _pauseEnd - _pauseStart;
        }
        _pauseStart = uint64(block.timestamp);
        _pauseEnd = uint64(block.timestamp) + MAX_PAUSE;
        emit Paused(_pauseEnd);
    }

    /// @notice End the pause early. The cooldown runs from now.
    function unpause() external {
        _onlyGuardian();
        if (!paused()) revert NotPaused();
        _pauseEnd = uint64(block.timestamp);
        emit Unpaused();
    }

    /// @notice Raise the cap on total funds held. type(uint256).max removes it. Never lower.
    function raiseCap(uint256 newCap) external {
        _onlyGuardian();
        if (newCap <= fundsCap) revert CapNotHigher(fundsCap, newCap);
        fundsCap = newCap;
        emit CapRaised(newCap);
    }

    /// @notice Two-step hand-over, so a mistyped address cannot silently end the guardian.
    function proposeGuardian(address next) external {
        _onlyGuardian();
        if (next == address(0)) revert ZeroAddress();
        pendingGuardian = next;
        emit GuardianProposed(next);
    }

    function acceptGuardian() external {
        if (msg.sender != pendingGuardian || msg.sender == address(0)) revert NotGuardian(msg.sender);
        emit GuardianChanged(guardian, msg.sender);
        guardian = msg.sender;
        pendingGuardian = address(0);
    }

    /// @notice Give up the guardian for good: no more pauses, and the cap stays where it is.
    function renounceGuardian() external {
        _onlyGuardian();
        emit GuardianChanged(guardian, address(0));
        guardian = address(0);
        pendingGuardian = address(0);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function paused() public view returns (bool) {
        return _pauseEnd != 0 && block.timestamp < _pauseEnd;
    }

    /// @notice Total seconds releases have been paused, including a pause in progress.
    function pausedSeconds() public view returns (uint256 total) {
        total = _pausedAccrued;
        if (_pauseEnd != 0) {
            uint256 end = block.timestamp < _pauseEnd ? block.timestamp : _pauseEnd;
            if (end > _pauseStart) total += end - _pauseStart;
        }
    }

    /// @notice The deadline plus any pause time since the policy was created.
    function effectiveDeadline(uint256 policyId) public view returns (uint256) {
        Policy storage p = _requirePolicy(policyId);
        return uint256(p.deadline) + (pausedSeconds() - p.pausedAtCreation);
    }

    /// @notice True when a one-off policy's condition is met now. Ignores funding, deadline and
    ///         pause. False for payroll, sweep and pull-oracle policies, whose gates differ.
    function checkCondition(uint256 policyId) external view returns (bool) {
        return _conditionMet(_requirePolicy(policyId));
    }

    /// @notice True when a payroll or sweep has a period due that could be released now.
    function isPeriodDue(uint256 policyId) public view returns (bool) {
        Policy storage p = _requirePolicy(policyId);
        return p.recurring && p.status == Status.Pending && block.timestamp >= p.nextDue
            && (p.stoppedAt == 0 || p.nextDue <= p.stoppedAt) && block.timestamp < effectiveDeadline(policyId);
    }

    /// @notice Pending resolves to Releasable when a release would succeed now, pull oracles
    ///         excepted since they need a proof.
    function statusOf(uint256 policyId) external view returns (Status) {
        Policy storage p = _requirePolicy(policyId);
        if (p.status != Status.Pending || paused() || block.timestamp >= effectiveDeadline(policyId)) return p.status;
        if (p.recurring) {
            if (!isPeriodDue(policyId)) return p.status;
            uint256 slice = _slice(p);
            bool payable_ = p.isSweep ? slice >= p.minSweep : slice > 0;
            if (payable_ && p.funded >= slice && p.feeAllowance >= _feeFor(p)) return Status.Releasable;
            return p.status;
        }
        return _conditionMet(p) ? Status.Releasable : p.status;
    }

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        return _requirePolicy(policyId);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev Checks shared by every creator, then allocates the policy. Terms that could never pay
    ///      out are refused here, before any money arrives.
    function _open(Terms calldata t, ConditionType conditionType) private returns (uint256 policyId, Policy storage p) {
        if (t.recipient == address(0)) revert ZeroAddress();
        if (t.recipient == address(this)) revert ZeroAddress();
        _requireDeadlineAfter(t.deadline, block.timestamp);
        if (t.destinationDomain == ARC_DOMAIN) {
            if (t.maxFeePerTransfer != 0) revert InvalidFee(t.destinationDomain, t.maxFeePerTransfer);
        } else {
            if (!isDestination[t.destinationDomain]) revert UnsupportedDestination(t.destinationDomain);
            if (tokenMessenger.remoteTokenMessengers(t.destinationDomain) == bytes32(0)) {
                revert UnsupportedDestination(t.destinationDomain);
            }
            if (t.maxFeePerTransfer == 0) revert InvalidFee(t.destinationDomain, 0);
        }

        policyId = nextPolicyId++;
        p = _policies[policyId];
        p.owner = msg.sender;
        p.recipient = t.recipient;
        p.destinationDomain = t.destinationDomain;
        p.conditionType = conditionType;
        p.status = Status.Pending;
        p.deadline = t.deadline;
        p.pausedAtCreation = uint64(pausedSeconds());
        p.maxFeePerTransfer = t.maxFeePerTransfer;
    }

    function _fundOneOff(uint256 policyId, Policy storage p, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        p.amount = amount;
        p.funded = amount;
        p.feeAllowance = p.maxFeePerTransfer;
        _pull(amount + p.maxFeePerTransfer);
        emit PolicyCreated(policyId, p.owner, p.recipient, p.conditionType, amount, p.destinationDomain, p.deadline);
    }

    function _fundRecurring(uint256 policyId, Policy storage p, uint256 initialFunding, uint256 initialFees) private {
        if (p.destinationDomain == ARC_DOMAIN && initialFees != 0) revert InvalidFee(ARC_DOMAIN, initialFees);
        p.funded = initialFunding;
        p.feeAllowance = initialFees;
        _pull(initialFunding + initialFees);
        uint256 shown = p.isSweep ? 0 : p.amountPerPeriod;
        emit PolicyCreated(policyId, p.owner, p.recipient, p.conditionType, shown, p.destinationDomain, p.deadline);
    }

    function _releaseOneOff(uint256 policyId, Policy storage p) private {
        uint256 amount = p.amount;
        uint256 fee = _feeFor(p);
        // A one-off's allowance equals its fee (raiseMaxFee keeps it so), but anything above the fee
        // is the owner's and goes back rather than to the recipient or Circle.
        uint256 surplus = p.feeAllowance - fee;
        p.status = Status.Executed;
        p.funded = 0;
        p.feeAllowance = 0;
        totalHeld -= amount + fee + surplus;

        _send(p, amount, fee);
        emit PolicyReleased(policyId, p.recipient, amount, p.destinationDomain, 0, fee);
        if (surplus > 0) usdc.safeTransfer(p.owner, surplus);
    }

    /// @dev Pay the recipient: a transfer on Arc, or a CCTP burn with Circle's forwarding for every
    ///      other destination, so the recipient needs no gas where they are paid.
    function _send(Policy storage p, uint256 amount, uint256 fee) private {
        if (p.destinationDomain == ARC_DOMAIN) {
            usdc.safeTransfer(p.recipient, amount);
            return;
        }
        uint256 burn = amount + fee;
        usdc.forceApprove(address(tokenMessenger), burn);
        tokenMessenger.depositForBurnWithHook(
            burn,
            p.destinationDomain,
            bytes32(uint256(uint160(p.recipient))),
            address(usdc),
            bytes32(0), // Circle's forwarder does not serve a restricted destination caller.
            fee,
            STANDARD_FINALITY,
            FORWARD_HOOK
        );
    }

    function _refundAll(uint256 policyId, Policy storage p) private {
        uint256 refund = p.funded + p.feeAllowance;
        p.status = Status.Cancelled;
        p.funded = 0;
        p.feeAllowance = 0;
        totalHeld -= refund;
        if (refund > 0) usdc.safeTransfer(p.owner, refund);
        emit PolicyCancelled(policyId, p.owner, refund);
    }

    /// @dev What a stop leaves for the recipient: the periods due by now that the policy can still
    ///      pay, payout and fee both. Never more than it holds.
    function _dueAtStop(Policy storage p) private view returns (uint256 kept, uint256 keptFee) {
        if (block.timestamp < p.nextDue) return (0, 0);
        uint256 fee = _feeFor(p);
        if (p.isSweep) {
            uint256 slice = _slice(p);
            if (slice >= p.minSweep && p.feeAllowance >= fee) return (slice, fee);
            return (0, 0);
        }
        uint256 count = (block.timestamp - p.nextDue) / p.interval + 1;
        if (p.periods != 0) {
            uint256 remaining = p.periods - p.periodsReleased;
            if (count > remaining) count = remaining;
        }
        uint256 affordable = p.funded / p.amountPerPeriod;
        if (count > affordable) count = affordable;
        if (fee > 0) {
            uint256 feesCovered = p.feeAllowance / fee;
            if (count > feesCovered) count = feesCovered;
        }
        return (count * p.amountPerPeriod, count * fee);
    }

    /// @dev Verify a signed price through the policy's adapter and judge it against the rule. The
    ///      adapter reverts on a bad proof or one outside [now - maxStaleSeconds, now]. A non-positive
    ///      value is treated as not met rather than trusted, whatever the adapter promises.
    function _readProof(Policy storage p, bytes calldata proof)
        private
        returns (bool met, bool confident, int256 value, uint256 conf, uint256 fee)
    {
        IOracleAdapter adapter = IOracleAdapter(p.adapter);
        fee = adapter.quoteFee(proof);
        if (msg.value < fee) revert InsufficientFee(fee, msg.value);
        (value, conf,) = adapter.verifyAndRead{value: fee}(p.feedId, proof, p.maxStaleSeconds);
        if (value <= 0) return (false, false, value, conf, fee);
        met = p.comparator == Comparator.Gte ? value >= p.oracleThreshold : value <= p.oracleThreshold;
        confident = p.maxConfBps == 0 || conf * 10_000 <= uint256(value) * p.maxConfBps;
    }

    /// @dev Return any native value above the adapter's fee. Reverts rather than keeping it.
    function _refundNative(uint256 fee) private {
        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool ok,) = payable(msg.sender).call{value: refund}("");
            if (!ok) revert RefundFailed(msg.sender, refund);
        }
    }

    function _pull(uint256 amount) private {
        if (amount == 0) return;
        uint256 wouldHold = totalHeld + amount;
        if (wouldHold > fundsCap) revert OverCap(wouldHold, fundsCap);
        totalHeld = wouldHold;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    function _conditionMet(Policy storage p) private view returns (bool) {
        if (p.conditionType == ConditionType.Timelock) return block.timestamp >= p.releaseTime;
        if (p.conditionType == ConditionType.Approval) return p.approvalCount >= p.threshold;
        if (p.conditionType == ConditionType.Attestation) return p.attested;
        if (p.conditionType == ConditionType.Oracle) return _oracleConditionMet(p);
        // Schedule and OraclePull have no condition readable from state alone.
        return false;
    }

    /// @dev Fail closed, unchanged from v4: a stale, zero, negative, incomplete, future-dated or
    ///      reverting feed reads as not met, for release and for cancel alike.
    function _oracleConditionMet(Policy storage p) private view returns (bool) {
        try IChainlinkFeed(p.feed).latestRoundData() returns (
            uint80 roundId, int256 answer, uint256, uint256 updatedAt, uint80 answeredInRound
        ) {
            if (answer <= 0 || updatedAt == 0 || answeredInRound < roundId) return false;
            if (updatedAt > block.timestamp) return false;
            if (block.timestamp - updatedAt > p.maxStaleSeconds) return false;
            return p.comparator == Comparator.Gte ? answer >= p.oracleThreshold : answer <= p.oracleThreshold;
        } catch {
            return false;
        }
    }

    function _slice(Policy storage p) private view returns (uint256) {
        if (p.isSweep) return p.funded > p.buffer ? p.funded - p.buffer : 0;
        return p.amountPerPeriod;
    }

    function _feeFor(Policy storage p) private view returns (uint256) {
        return p.destinationDomain == ARC_DOMAIN ? 0 : p.maxFeePerTransfer;
    }

    function _ownedPending(uint256 policyId) private view returns (Policy storage p) {
        p = _requirePolicy(policyId);
        if (msg.sender != p.owner) revert NotPolicyOwner(policyId, msg.sender);
        if (p.status != Status.Pending) revert PolicyNotPending(policyId, p.status);
    }

    function _requireBeforeDeadline(uint256 policyId, Policy storage p) private view {
        uint256 deadline = uint256(p.deadline) + (pausedSeconds() - p.pausedAtCreation);
        if (block.timestamp >= deadline) revert PastDeadline(policyId, deadline);
    }

    function _requireDeadlineAfter(uint64 deadline, uint256 from) private pure {
        uint256 earliest = from + MIN_WINDOW;
        if (deadline < earliest) revert DeadlineTooSoon(deadline, earliest);
    }

    function _requireNotPaused() private view {
        if (paused()) revert ReleasesPaused(_pauseEnd);
    }

    function _onlyGuardian() private view {
        if (msg.sender != guardian || msg.sender == address(0)) revert NotGuardian(msg.sender);
    }

    function _requirePolicy(uint256 policyId) private view returns (Policy storage p) {
        if (policyId >= nextPolicyId) revert UnknownPolicy(policyId);
        p = _policies[policyId];
    }
}
