// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
contract PolicyVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice CCTP domain identifier for Arc. See docs/VERIFICATIONS.md V3.
    uint32 public constant ARC_DOMAIN = 26;

    enum ConditionType {
        Timelock,
        Approval
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
    event PolicyReleased(
        uint256 indexed policyId,
        address indexed recipient,
        uint256 amount,
        PayoutCurrency payoutCurrency,
        uint32 destinationDomain,
        address executor
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

    constructor(address usdc_, address executor_, address owner_) Ownable(owner_) {
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
        } else {
            if (releaseTime != 0) revert InvalidApprovalConfig();
            if (approvers.length == 0 || threshold == 0 || threshold > approvers.length) {
                revert InvalidApprovalConfig();
            }
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
        if (newFunded > p.amount) revert Overfunded(policyId, newFunded, p.amount);
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

    /// @notice Release a policy's funds to the executor wallet.
    /// @dev Permissionless by design. The condition, not the caller, is the gate. Reverting here
    ///      when the condition is unmet is a demonstrated behaviour, not just a guard.
    function release(uint256 policyId) external nonReentrant {
        Policy storage p = _requirePolicy(policyId);
        if (p.status != Status.Pending) revert PolicyNotPending(policyId, p.status);
        if (!_conditionMet(p)) revert ConditionNotMet(policyId);
        if (p.funded < p.amount) revert Underfunded(policyId, p.funded, p.amount);

        p.status = Status.Executed;
        address executor_ = executor;

        usdc.safeTransfer(executor_, p.amount);

        emit PolicyReleased(policyId, p.recipient, p.amount, p.payoutCurrency, p.destinationDomain, executor_);
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

    /// @notice Effective status, resolving Pending to Releasable when the policy is both
    ///         condition-satisfied and fully funded.
    function statusOf(uint256 policyId) external view returns (Status) {
        Policy storage p = _requirePolicy(policyId);
        if (p.status == Status.Pending && _conditionMet(p) && p.funded >= p.amount) {
            return Status.Releasable;
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
        return p.approvalCount >= p.threshold;
    }

    function _requirePolicy(uint256 policyId) private view returns (Policy storage p) {
        if (policyId >= nextPolicyId) revert UnknownPolicy(policyId);
        p = _policies[policyId];
    }
}
