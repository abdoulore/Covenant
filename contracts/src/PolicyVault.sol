// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Minimal Chainlink Data Feed interface. Only the call the Oracle condition needs.
/// @dev Defined inline rather than pulling in the Chainlink package for one method. Arc has
///      Chainlink Data Feeds via Chainlink Scale. See docs/specs/PHASE2_CONDITION_TYPES.md.
interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title PolicyVault
/// @notice Holds treasury USDC and enforces release conditions onchain. The contract decides
///         IF funds move. The offchain executor only decides HOW they route.
///
/// @dev DECIMALS, READ THIS BEFORE CHANGING ANYTHING.
///      Arc exposes one pool of USDC through two views: an 18 decimal native view used for gas
///      and msg.value, and a 6 decimal ERC-20 view at 0x3600000000000000000000000000000000000000.
///      They are the same balance, 10^12 apart. This contract deals exclusively in the 6 decimal
///      ERC-20 view. Every `amount` in this file is 6 decimals. There is deliberately no receive()
///      or fallback() and no payable function, so native value cannot enter and cannot be trapped
///      at the wrong scale. See docs/VERIFICATIONS.md V1a.
contract PolicyVault is Ownable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    /// @notice CCTP domain identifier for Arc. See docs/VERIFICATIONS.md V3.
    uint32 public constant ARC_DOMAIN = 26;

    /// @dev EIP-712 type for an attestation. Binds a signature to a single policyId, and the
    ///      domain separator binds it to this contract and chain, so a signature cannot be
    ///      replayed across policies, deployments, or chains. See docs/specs/PHASE2_CONDITION_TYPES.md.
    bytes32 private constant ATTESTATION_TYPEHASH = keccak256("Attestation(uint256 policyId)");

    enum ConditionType {
        Timelock,
        Approval,
        Attestation,
        Oracle
    }

    /// @notice Direction of an Oracle comparison against the threshold.
    enum Comparator {
        Gte,
        Lte
    }

    enum PayoutCurrency {
        USDC,
        EURC
    }

    /// @dev Releasable is never stored. It is derived by statusOf(). Stored status is only ever
    ///      Pending, Executed or Cancelled.
    enum Status {
        Pending,
        Releasable,
        Executed,
        Cancelled
    }

    struct Policy {
        address recipient;
        uint256 amount;
        uint256 funded;
        PayoutCurrency payoutCurrency;
        uint32 destinationDomain;
        ConditionType conditionType;
        uint64 releaseTime;
        uint8 threshold;
        uint8 approvalCount;
        Status status;
        // Attestation condition. attester is config, attested is the one-way latch, mirroring how
        // threshold is config and approvalCount is state for the Approval condition.
        address attester;
        bool attested;
        // Oracle condition. All config, no per-policy state: the condition is a live read of the
        // feed. oracleThreshold is expressed in the feed's own decimals. Unset fields on non-oracle
        // policies stay zero and cost no gas, since zero storage slots are never written.
        address feed;
        Comparator comparator;
        uint64 maxStaleSeconds;
        int256 oracleThreshold;
        // Recurring policies (scheduling, v3). `recurring` marks a payroll or sweep policy that
        // releases repeatedly through releasePeriod, not once through release. `isSweep` picks the
        // variable sweep slice (funded above `buffer`) over the fixed payroll `amountPerPeriod`.
        // The schedule is enforced onchain. See docs/specs/PHASE2_SCHEDULING.md.
        bool recurring;
        bool isSweep;
        uint256 amountPerPeriod; // payroll slice per period
        uint256 buffer;          // sweep keeps this much, releases the excess
        uint256 minSweep;        // sweep dust floor, below which a period is skipped
        uint64 interval;         // seconds between periods
        uint64 nextDue;          // timestamp the next period is due
        uint64 maxCatchUp;       // a period overdue beyond this is held for owner approval
        uint32 periods;          // payroll total, 0 for open-ended
        uint32 periodsReleased;  // periods released so far, and the index emitted per release
    }

    IERC20 public immutable usdc;

    /// @notice Wallet that receives released funds and performs the routing legs.
    /// @dev The custody boundary. See docs/DECISIONS.md D2.
    address public executor;

    uint256 public nextPolicyId;

    mapping(uint256 policyId => Policy) private _policies;
    mapping(uint256 policyId => mapping(address account => bool)) public isApprover;
    mapping(uint256 policyId => mapping(address account => bool)) public hasApproved;

    event PolicyCreated(
        uint256 indexed policyId,
        address indexed recipient,
        uint256 amount,
        PayoutCurrency payoutCurrency,
        uint32 destinationDomain,
        ConditionType conditionType
    );
    event Deposited(uint256 indexed policyId, address indexed from, uint256 amount, uint256 totalFunded);
    event Approved(uint256 indexed policyId, address indexed approver, uint8 approvalCount, uint8 threshold);
    event Attested(uint256 indexed policyId, address indexed attester);
    /// @dev periodIndex is 0 for a single-shot release, and 1, 2, 3... for each period of a
    ///      recurring policy, so an offchain consumer can settle each period independently.
    event PolicyReleased(
        uint256 indexed policyId,
        address indexed recipient,
        uint256 amount,
        PayoutCurrency payoutCurrency,
        uint32 destinationDomain,
        address executor,
        uint256 periodIndex
    );
    event PolicyCancelled(uint256 indexed policyId, address indexed refundTo, uint256 refunded);
    event ExecutorUpdated(address indexed previousExecutor, address indexed newExecutor);

    error ZeroAddress();
    error ZeroAmount();
    error UnknownPolicy(uint256 policyId);
    error PolicyNotPending(uint256 policyId, Status status);
    error ConditionNotMet(uint256 policyId);
    error Underfunded(uint256 policyId, uint256 funded, uint256 required);
    error ReleaseTimeInPast(uint64 releaseTime, uint256 nowTs);
    error InvalidTimelockConfig();
    error InvalidApprovalConfig();
    error DuplicateApprover(address approver);
    error NotAnApprover(uint256 policyId, address caller);
    error AlreadyApproved(uint256 policyId, address approver);
    error WrongConditionType(uint256 policyId, ConditionType expected, ConditionType actual);
    error UnsupportedRoute(PayoutCurrency payoutCurrency, uint32 destinationDomain);
    error Overfunded(uint256 policyId, uint256 funded, uint256 amount);
    error UseTypedCreator(ConditionType conditionType);
    error InvalidAttestationSignature(uint256 policyId);
    error AlreadyAttested(uint256 policyId);
    error InvalidOracleConfig();
    error UseReleasePeriod(uint256 policyId);
    error NotRecurring(uint256 policyId);
    error PeriodNotDue(uint256 policyId, uint64 nextDue, uint256 nowTs);
    error CatchUpStale(uint256 policyId, uint64 nextDue);
    error SweepBelowMin(uint256 policyId, uint256 slice, uint256 minSweep);
    error InvalidRecurringConfig();
    error InvalidSweepConfig();

    constructor(address usdc_, address executor_, address owner_)
        Ownable(owner_)
        EIP712("PolicyVault", "1")
    {
        if (usdc_ == address(0) || executor_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        executor = executor_;
        emit ExecutorUpdated(address(0), executor_);
    }

    // ---------------------------------------------------------------------
    // Policy lifecycle
    // ---------------------------------------------------------------------

    /// @notice Create a policy. Funds are not moved here, use deposit().
    /// @param amount Payout amount in the 6 decimal USDC ERC-20 view.
    /// @param destinationDomain CCTP domain of the payout chain. ARC_DOMAIN for a local payout.
    /// @param releaseTime Unix timestamp for Timelock policies, must be 0 for Approval policies.
    /// @param approvers Approver set for Approval policies, must be empty for Timelock policies.
    /// @param threshold N in N-of-M, must be 0 for Timelock policies.
    function createPolicy(
        address recipient,
        uint256 amount,
        PayoutCurrency payoutCurrency,
        uint32 destinationDomain,
        ConditionType conditionType,
        uint64 releaseTime,
        address[] calldata approvers,
        uint8 threshold
    ) external onlyOwner returns (uint256 policyId) {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // EURC has no cross-chain route: CCTP and App Kit Bridge carry USDC only, and Arc is the
        // only swap-enabled testnet. Reject the impossible combination here rather than letting it
        // fail deep inside an SDK call at settlement time. See docs/DECISIONS.md D1.
        if (payoutCurrency == PayoutCurrency.EURC && destinationDomain != ARC_DOMAIN) {
            revert UnsupportedRoute(payoutCurrency, destinationDomain);
        }

        if (conditionType == ConditionType.Timelock) {
            if (approvers.length != 0 || threshold != 0) revert InvalidTimelockConfig();
            if (releaseTime <= block.timestamp) revert ReleaseTimeInPast(releaseTime, block.timestamp);
        } else if (conditionType == ConditionType.Approval) {
            if (releaseTime != 0) revert InvalidApprovalConfig();
            if (approvers.length == 0 || threshold == 0 || threshold > approvers.length) {
                revert InvalidApprovalConfig();
            }
        } else {
            // Attestation and Oracle policies carry different parameters and have their own creators.
            revert UseTypedCreator(conditionType);
        }

        policyId = nextPolicyId++;

        Policy storage p = _policies[policyId];
        p.recipient = recipient;
        p.amount = amount;
        p.payoutCurrency = payoutCurrency;
        p.destinationDomain = destinationDomain;
        p.conditionType = conditionType;
        p.releaseTime = releaseTime;
        p.threshold = threshold;
        p.status = Status.Pending;

        for (uint256 i = 0; i < approvers.length; ++i) {
            address a = approvers[i];
            if (a == address(0)) revert ZeroAddress();
            if (isApprover[policyId][a]) revert DuplicateApprover(a);
            isApprover[policyId][a] = true;
        }

        emit PolicyCreated(policyId, recipient, amount, payoutCurrency, destinationDomain, conditionType);
    }

    /// @notice Fund a policy. Anyone may fund; the caller must have approved this contract.
    /// @dev Funding beyond the policy amount is rejected so the vault never holds unattributed
    ///      dust that cancel() would sweep to the owner.
    function deposit(uint256 policyId, uint256 amount) external nonReentrant {
        Policy storage p = _requirePolicy(policyId);
        if (p.status != Status.Pending) revert PolicyNotPending(policyId, p.status);
        if (amount == 0) revert ZeroAmount();

        uint256 newFunded = p.funded + amount;
        // Recurring policies accept ongoing top-ups, so the single-shot overfunding cap does not
        // apply to them: a payroll or sweep balance is meant to be refilled over its lifetime.
        if (!p.recurring && newFunded > p.amount) revert Overfunded(policyId, newFunded, p.amount);
        p.funded = newFunded;

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(policyId, msg.sender, amount, newFunded);
    }

    /// @notice Record an approval toward an Approval policy's N-of-M threshold.
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

    /// @notice Create an attestation policy. It releases once the named attester signs (see attest()).
    /// @param attester The address whose EIP-712 signature satisfies the condition. Single attester.
    /// @dev A separate creator rather than a wider createPolicy, so each condition type keeps only
    ///      the parameters it actually uses. See docs/specs/PHASE2_CONDITION_TYPES.md.
    function createAttestationPolicy(
        address recipient,
        uint256 amount,
        PayoutCurrency payoutCurrency,
        uint32 destinationDomain,
        address attester
    ) external onlyOwner returns (uint256 policyId) {
        if (recipient == address(0) || attester == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        // Same route guard as createPolicy: EURC has no cross-chain path. See docs/DECISIONS.md D1.
        if (payoutCurrency == PayoutCurrency.EURC && destinationDomain != ARC_DOMAIN) {
            revert UnsupportedRoute(payoutCurrency, destinationDomain);
        }

        policyId = nextPolicyId++;

        Policy storage p = _policies[policyId];
        p.recipient = recipient;
        p.amount = amount;
        p.payoutCurrency = payoutCurrency;
        p.destinationDomain = destinationDomain;
        p.conditionType = ConditionType.Attestation;
        p.attester = attester;
        p.status = Status.Pending;

        emit PolicyCreated(policyId, recipient, amount, payoutCurrency, destinationDomain, ConditionType.Attestation);
    }

    /// @notice Create an oracle policy. It releases when a Chainlink Data Feed crosses a threshold.
    /// @param feed Chainlink AggregatorV3 feed address.
    /// @param comparator Gte releases when the feed is at or above the threshold, Lte at or below.
    /// @param threshold Comparison value, in the feed's own decimals. Off-chain callers read
    ///        feed.decimals() to scale it; the contract compares raw answers.
    /// @param maxStaleSeconds Reject a feed answer older than this. Set from the feed's heartbeat.
    /// @dev No keeper exists on Arc (Chainlink Automation is not available), so the executor polls
    ///      checkCondition and calls release when it flips true. See docs/specs/PHASE2_CONDITION_TYPES.md.
    function createOraclePolicy(
        address recipient,
        uint256 amount,
        PayoutCurrency payoutCurrency,
        uint32 destinationDomain,
        address feed,
        Comparator comparator,
        int256 threshold,
        uint64 maxStaleSeconds
    ) external onlyOwner returns (uint256 policyId) {
        if (recipient == address(0) || feed == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (maxStaleSeconds == 0) revert InvalidOracleConfig();

        // Same route guard as createPolicy: EURC has no cross-chain path. See docs/DECISIONS.md D1.
        if (payoutCurrency == PayoutCurrency.EURC && destinationDomain != ARC_DOMAIN) {
            revert UnsupportedRoute(payoutCurrency, destinationDomain);
        }

        policyId = nextPolicyId++;

        Policy storage p = _policies[policyId];
        p.recipient = recipient;
        p.amount = amount;
        p.payoutCurrency = payoutCurrency;
        p.destinationDomain = destinationDomain;
        p.conditionType = ConditionType.Oracle;
        p.feed = feed;
        p.comparator = comparator;
        p.oracleThreshold = threshold;
        p.maxStaleSeconds = maxStaleSeconds;
        p.status = Status.Pending;

        emit PolicyCreated(policyId, recipient, amount, payoutCurrency, destinationDomain, ConditionType.Oracle);
    }

    /// @notice Create a recurring payroll policy: release `amountPerPeriod` every `interval` seconds,
    ///         for `periods` periods, or open-ended when `periods` is 0. Released via releasePeriod().
    /// @dev A period overdue by more than `maxCatchUp` is held for approveStalePeriod(), so a
    ///      forgotten schedule cannot silently drain the treasury. See docs/specs/PHASE2_SCHEDULING.md.
    function createRecurringPolicy(
        address recipient,
        PayoutCurrency payoutCurrency,
        uint32 destinationDomain,
        uint256 amountPerPeriod,
        uint64 interval,
        uint64 startTime,
        uint32 periods,
        uint64 maxCatchUp
    ) external onlyOwner returns (uint256 policyId) {
        if (recipient == address(0)) revert ZeroAddress();
        if (amountPerPeriod == 0) revert ZeroAmount();
        if (interval == 0 || startTime == 0 || maxCatchUp == 0) revert InvalidRecurringConfig();
        if (payoutCurrency == PayoutCurrency.EURC && destinationDomain != ARC_DOMAIN) {
            revert UnsupportedRoute(payoutCurrency, destinationDomain);
        }

        policyId = nextPolicyId++;
        Policy storage p = _policies[policyId];
        p.recipient = recipient;
        p.payoutCurrency = payoutCurrency;
        p.destinationDomain = destinationDomain;
        p.recurring = true;
        p.amountPerPeriod = amountPerPeriod;
        p.interval = interval;
        p.nextDue = startTime;
        p.periods = periods;
        p.maxCatchUp = maxCatchUp;
        p.status = Status.Pending;

        emit PolicyCreated(policyId, recipient, amountPerPeriod, payoutCurrency, destinationDomain, p.conditionType);
    }

    /// @notice Create a sweep policy: on schedule, release everything funded above `buffer` to the
    ///         recipient, keeping `buffer` and skipping when the excess is below `minSweep`.
    function createSweepPolicy(
        address recipient,
        PayoutCurrency payoutCurrency,
        uint32 destinationDomain,
        uint256 buffer,
        uint256 minSweep,
        uint64 interval,
        uint64 startTime,
        uint64 maxCatchUp
    ) external onlyOwner returns (uint256 policyId) {
        if (recipient == address(0)) revert ZeroAddress();
        if (minSweep == 0 || interval == 0 || startTime == 0 || maxCatchUp == 0) revert InvalidSweepConfig();
        if (payoutCurrency == PayoutCurrency.EURC && destinationDomain != ARC_DOMAIN) {
            revert UnsupportedRoute(payoutCurrency, destinationDomain);
        }

        policyId = nextPolicyId++;
        Policy storage p = _policies[policyId];
        p.recipient = recipient;
        p.payoutCurrency = payoutCurrency;
        p.destinationDomain = destinationDomain;
        p.recurring = true;
        p.isSweep = true;
        p.buffer = buffer;
        p.minSweep = minSweep;
        p.interval = interval;
        p.nextDue = startTime;
        p.maxCatchUp = maxCatchUp;
        p.status = Status.Pending;

        emit PolicyCreated(policyId, recipient, 0, payoutCurrency, destinationDomain, p.conditionType);
    }

    /// @notice Release the currently due period of a recurring policy. Permissionless, like release().
    /// @dev Reverts CatchUpStale when the period is overdue beyond maxCatchUp; use approveStalePeriod.
    function releasePeriod(uint256 policyId) external nonReentrant {
        Policy storage p = _requirePolicy(policyId);
        if (!p.recurring) revert NotRecurring(policyId);
        if (p.status != Status.Pending) revert PolicyNotPending(policyId, p.status);
        if (block.timestamp < p.nextDue) revert PeriodNotDue(policyId, p.nextDue, block.timestamp);
        if (block.timestamp - p.nextDue > p.maxCatchUp) revert CatchUpStale(policyId, p.nextDue);
        _releaseOnePeriod(policyId, p);
    }

    /// @notice Owner override to release one due period past its maxCatchUp bound. Releases exactly
    ///         the current period and advances the schedule by one interval; it does not lift the
    ///         bound for future periods.
    function approveStalePeriod(uint256 policyId) external onlyOwner nonReentrant {
        Policy storage p = _requirePolicy(policyId);
        if (!p.recurring) revert NotRecurring(policyId);
        if (p.status != Status.Pending) revert PolicyNotPending(policyId, p.status);
        if (block.timestamp < p.nextDue) revert PeriodNotDue(policyId, p.nextDue, block.timestamp);
        _releaseOnePeriod(policyId, p);
    }

    /// @notice Satisfy an attestation policy by submitting the attester's EIP-712 signature.
    /// @dev Permissionless to submit: only a signature from the policy's named attester counts, so
    ///      anyone (the attester, the executor, a relayer) can carry the signature onchain. The
    ///      latch is one-way, so a replay is rejected rather than paid.
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

    /// @notice The EIP-712 digest an attester signs to satisfy policy `policyId`.
    /// @dev Exposed so an off-chain attester or the executor can produce the exact digest to sign.
    function attestationDigest(uint256 policyId) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(ATTESTATION_TYPEHASH, policyId)));
    }

    /// @notice Release a policy's funds to the executor wallet.
    /// @dev Permissionless by design. The condition, not the caller, is the gate. Reverting here
    ///      when the condition is unmet is a demonstrated behaviour, not just a guard.
    function release(uint256 policyId) external nonReentrant {
        Policy storage p = _requirePolicy(policyId);
        if (p.recurring) revert UseReleasePeriod(policyId);
        if (p.status != Status.Pending) revert PolicyNotPending(policyId, p.status);
        if (!_conditionMet(p)) revert ConditionNotMet(policyId);
        if (p.funded < p.amount) revert Underfunded(policyId, p.funded, p.amount);

        p.status = Status.Executed;
        address executor_ = executor;

        usdc.safeTransfer(executor_, p.amount);

        emit PolicyReleased(policyId, p.recipient, p.amount, p.payoutCurrency, p.destinationDomain, executor_, 0);
    }

    /// @notice Cancel a policy before release and refund whatever was deposited to the owner.
    function cancel(uint256 policyId) external onlyOwner nonReentrant {
        Policy storage p = _requirePolicy(policyId);
        if (p.status != Status.Pending) revert PolicyNotPending(policyId, p.status);

        p.status = Status.Cancelled;
        uint256 refund = p.funded;
        p.funded = 0;

        address to = owner();
        if (refund > 0) usdc.safeTransfer(to, refund);

        emit PolicyCancelled(policyId, to, refund);
    }

    /// @notice Rotate the executor wallet. Does not affect already executed policies.
    function setExecutor(address newExecutor) external onlyOwner {
        if (newExecutor == address(0)) revert ZeroAddress();
        address previous = executor;
        executor = newExecutor;
        emit ExecutorUpdated(previous, newExecutor);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice True when the policy's release condition is satisfied. Ignores funding.
    function checkCondition(uint256 policyId) external view returns (bool) {
        return _conditionMet(_requirePolicy(policyId));
    }

    /// @notice True when a recurring policy has a period due now, within its catch-up bound. The
    ///         scheduler keeper polls this the way the oracle keeper polls checkCondition.
    function isPeriodDue(uint256 policyId) external view returns (bool) {
        return _periodDue(_requirePolicy(policyId));
    }

    /// @notice Effective status, resolving Pending to Releasable when the policy is both
    ///         condition-satisfied and fully funded.
    function statusOf(uint256 policyId) external view returns (Status) {
        Policy storage p = _requirePolicy(policyId);
        if (p.status == Status.Pending) {
            if (p.recurring) {
                uint256 slice = _slice(p);
                bool fundable = p.isSweep ? slice >= p.minSweep : (slice > 0 && p.funded >= slice);
                if (fundable && _periodDue(p)) return Status.Releasable;
            } else if (_conditionMet(p) && p.funded >= p.amount) {
                return Status.Releasable;
            }
        }
        return p.status;
    }

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        return _requirePolicy(policyId);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _conditionMet(Policy storage p) private view returns (bool) {
        if (p.conditionType == ConditionType.Timelock) {
            return block.timestamp >= p.releaseTime;
        }
        if (p.conditionType == ConditionType.Approval) {
            return p.approvalCount >= p.threshold;
        }
        if (p.conditionType == ConditionType.Attestation) {
            return p.attested;
        }
        return _oracleConditionMet(p); // Oracle
    }

    /// @dev Fail closed. Any doubt about the data means the condition is not met, so release does
    ///      not fire and checkCondition returns false rather than reverting. A stale, zero, negative,
    ///      incomplete, or reverting feed all read as "not yet", never as a release.
    function _oracleConditionMet(Policy storage p) private view returns (bool) {
        try IAggregatorV3(p.feed).latestRoundData() returns (
            uint80 roundId, int256 answer, uint256, uint256 updatedAt, uint80 answeredInRound
        ) {
            if (answer <= 0 || updatedAt == 0 || answeredInRound < roundId) return false;
            if (block.timestamp - updatedAt > p.maxStaleSeconds) return false;
            return p.comparator == Comparator.Gte ? answer >= p.oracleThreshold : answer <= p.oracleThreshold;
        } catch {
            return false;
        }
    }

    /// @dev The amount a recurring release moves: the fixed payroll slice, or a sweep's excess above
    ///      the buffer (zero when the balance is at or below the buffer).
    function _slice(Policy storage p) private view returns (uint256) {
        if (p.isSweep) {
            return p.funded > p.buffer ? p.funded - p.buffer : 0;
        }
        return p.amountPerPeriod;
    }

    /// @dev True when a recurring policy has a period due now and within its catch-up bound.
    function _periodDue(Policy storage p) private view returns (bool) {
        return p.recurring && p.status == Status.Pending && block.timestamp >= p.nextDue
            && block.timestamp - p.nextDue <= p.maxCatchUp;
    }

    /// @dev Release one period: transfer the slice, advance the schedule, retire a finished payroll.
    ///      Effects precede the transfer and nextDue advances by exactly one interval, so a repeat or
    ///      reentrant call before the next due time reverts and a period is never paid twice.
    function _releaseOnePeriod(uint256 policyId, Policy storage p) private {
        uint256 slice = _slice(p);
        if (p.isSweep && slice < p.minSweep) revert SweepBelowMin(policyId, slice, p.minSweep);
        if (slice == 0 || p.funded < slice) revert Underfunded(policyId, p.funded, slice);

        p.funded -= slice;
        uint32 index = ++p.periodsReleased;
        p.nextDue += p.interval;

        // Fixed-term payroll retires when its last period is out. Open-ended payroll and sweep stay
        // active for top-ups, stopping only on cancel or when funds cannot cover the next slice.
        if (!p.isSweep && p.periods != 0 && p.periodsReleased >= p.periods) {
            p.status = Status.Executed;
        }

        address executor_ = executor;
        usdc.safeTransfer(executor_, slice);
        emit PolicyReleased(policyId, p.recipient, slice, p.payoutCurrency, p.destinationDomain, executor_, index);
    }

    function _requirePolicy(uint256 policyId) private view returns (Policy storage p) {
        if (policyId >= nextPolicyId) revert UnknownPolicy(policyId);
        p = _policies[policyId];
    }
}
