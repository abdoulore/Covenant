// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract PolicyVaultTest is Test {
    PolicyVault internal vault;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal executor = makeAddr("executor");
    address internal recipient = makeAddr("recipient");
    address internal stranger = makeAddr("stranger");

    address internal approverA = makeAddr("approverA");
    address internal approverB = makeAddr("approverB");
    address internal approverC = makeAddr("approverC");

    /// @dev Six decimals throughout. 1 USDC == 1e6. See PolicyVault decimals note.
    uint256 internal constant ONE_USDC = 1e6;
    uint32 internal constant ARC_DOMAIN = 26;
    uint32 internal constant BASE_SEPOLIA_DOMAIN = 6;

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PolicyVault(address(usdc), executor, owner);

        usdc.mint(owner, 1_000 * ONE_USDC);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _createTimelock(uint256 amount, uint64 releaseTime) internal returns (uint256 id) {
        vm.prank(owner);
        id = vault.createPolicy(
            recipient,
            amount,
            PolicyVault.PayoutCurrency.USDC,
            BASE_SEPOLIA_DOMAIN,
            PolicyVault.ConditionType.Timelock,
            releaseTime,
            new address[](0),
            0
        );
    }

    function _approvers() internal view returns (address[] memory a) {
        a = new address[](3);
        a[0] = approverA;
        a[1] = approverB;
        a[2] = approverC;
    }

    function _createApproval(uint256 amount, uint8 threshold) internal returns (uint256 id) {
        vm.prank(owner);
        id = vault.createPolicy(
            recipient,
            amount,
            PolicyVault.PayoutCurrency.EURC,
            ARC_DOMAIN,
            PolicyVault.ConditionType.Approval,
            0,
            _approvers(),
            threshold
        );
    }

    function _fund(uint256 id, uint256 amount) internal {
        vm.prank(owner);
        vault.deposit(id, amount);
    }

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    function test_Constructor_SetsState() public view {
        assertEq(address(vault.usdc()), address(usdc));
        assertEq(vault.executor(), executor);
        assertEq(vault.owner(), owner);
        assertEq(vault.nextPolicyId(), 0);
        assertEq(vault.ARC_DOMAIN(), ARC_DOMAIN);
    }

    function test_RevertWhen_ConstructedWithZeroUsdc() public {
        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        new PolicyVault(address(0), executor, owner);
    }

    function test_RevertWhen_ConstructedWithZeroExecutor() public {
        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        new PolicyVault(address(usdc), address(0), owner);
    }

    // ---------------------------------------------------------------------
    // Timelock condition, happy path
    // ---------------------------------------------------------------------

    function test_Timelock_ReleasesAfterDeadline() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 id = _createTimelock(10 * ONE_USDC, deadline);
        _fund(id, 10 * ONE_USDC);

        assertFalse(vault.checkCondition(id));
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Pending));

        vm.warp(deadline);

        assertTrue(vault.checkCondition(id));
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Releasable));

        vm.expectEmit(true, true, false, true, address(vault));
        emit PolicyVault.PolicyReleased(
            id, recipient, 10 * ONE_USDC, PolicyVault.PayoutCurrency.USDC, BASE_SEPOLIA_DOMAIN, executor
        );
        vault.release(id);

        assertEq(usdc.balanceOf(executor), 10 * ONE_USDC);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Executed));
    }

    /// @dev Release is permissionless. The condition is the gate, not the caller.
    function test_Timelock_ReleaseIsPermissionless() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 id = _createTimelock(ONE_USDC, deadline);
        _fund(id, ONE_USDC);
        vm.warp(deadline);

        vm.prank(stranger);
        vault.release(id);

        assertEq(usdc.balanceOf(executor), ONE_USDC);
    }

    // ---------------------------------------------------------------------
    // Approval condition, happy path
    // ---------------------------------------------------------------------

    function test_Approval_ReleasesAtThreshold() public {
        uint256 id = _createApproval(5 * ONE_USDC, 2);
        _fund(id, 5 * ONE_USDC);

        assertFalse(vault.checkCondition(id));

        vm.prank(approverA);
        vault.approve(id);
        assertFalse(vault.checkCondition(id), "one of three must not satisfy a 2-of-3 threshold");

        vm.expectEmit(true, true, false, true, address(vault));
        emit PolicyVault.Approved(id, approverB, 2, 2);
        vm.prank(approverB);
        vault.approve(id);

        assertTrue(vault.checkCondition(id));
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Releasable));

        vault.release(id);
        assertEq(usdc.balanceOf(executor), 5 * ONE_USDC);
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Executed));
    }

    function test_Approval_TracksApproverRegistry() public {
        uint256 id = _createApproval(ONE_USDC, 2);

        assertTrue(vault.isApprover(id, approverA));
        assertFalse(vault.isApprover(id, stranger));
        assertFalse(vault.hasApproved(id, approverA));

        vm.prank(approverA);
        vault.approve(id);

        assertTrue(vault.hasApproved(id, approverA));
    }

    // ---------------------------------------------------------------------
    // Revert paths: release
    // ---------------------------------------------------------------------

    /// @dev This is the failure path demonstrated onchain in the canary.
    function test_RevertWhen_ReleaseBeforeTimelock() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 id = _createTimelock(ONE_USDC, deadline);
        _fund(id, ONE_USDC);

        vm.warp(deadline - 1);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.ConditionNotMet.selector, id));
        vault.release(id);

        assertEq(usdc.balanceOf(address(vault)), ONE_USDC, "funds must stay put on a failed release");
    }

    function test_RevertWhen_ReleaseBelowApprovalThreshold() public {
        uint256 id = _createApproval(ONE_USDC, 2);
        _fund(id, ONE_USDC);

        vm.prank(approverA);
        vault.approve(id);

        vm.expectRevert(abi.encodeWithSelector(PolicyVault.ConditionNotMet.selector, id));
        vault.release(id);
    }

    function test_RevertWhen_DoubleRelease() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 id = _createTimelock(ONE_USDC, deadline);
        _fund(id, ONE_USDC);
        vm.warp(deadline);

        vault.release(id);

        vm.expectRevert(
            abi.encodeWithSelector(PolicyVault.PolicyNotPending.selector, id, PolicyVault.Status.Executed)
        );
        vault.release(id);

        assertEq(usdc.balanceOf(executor), ONE_USDC, "a second release must not double pay");
    }

    function test_RevertWhen_ReleaseUnderfunded() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 id = _createTimelock(10 * ONE_USDC, deadline);
        _fund(id, 4 * ONE_USDC);
        vm.warp(deadline);

        assertTrue(vault.checkCondition(id), "condition is met even though funding is short");
        assertEq(
            uint8(vault.statusOf(id)),
            uint8(PolicyVault.Status.Pending),
            "an underfunded policy must not read as Releasable"
        );

        vm.expectRevert(
            abi.encodeWithSelector(PolicyVault.Underfunded.selector, id, 4 * ONE_USDC, 10 * ONE_USDC)
        );
        vault.release(id);
    }

    function test_RevertWhen_ReleaseUnknownPolicy() public {
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.UnknownPolicy.selector, 99));
        vault.release(99);
    }

    // ---------------------------------------------------------------------
    // Revert paths: approve
    // ---------------------------------------------------------------------

    function test_RevertWhen_UnauthorizedApprove() public {
        uint256 id = _createApproval(ONE_USDC, 2);

        vm.expectRevert(abi.encodeWithSelector(PolicyVault.NotAnApprover.selector, id, stranger));
        vm.prank(stranger);
        vault.approve(id);
    }

    function test_RevertWhen_ApproveTwice() public {
        uint256 id = _createApproval(ONE_USDC, 2);

        vm.prank(approverA);
        vault.approve(id);

        vm.expectRevert(abi.encodeWithSelector(PolicyVault.AlreadyApproved.selector, id, approverA));
        vm.prank(approverA);
        vault.approve(id);

        assertFalse(vault.checkCondition(id), "one approver must not reach threshold by approving twice");
    }

    function test_RevertWhen_ApproveTimelockPolicy() public {
        uint256 id = _createTimelock(ONE_USDC, uint64(block.timestamp + 1 days));

        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyVault.WrongConditionType.selector,
                id,
                PolicyVault.ConditionType.Approval,
                PolicyVault.ConditionType.Timelock
            )
        );
        vm.prank(approverA);
        vault.approve(id);
    }

    function test_RevertWhen_ApproveAfterRelease() public {
        uint256 id = _createApproval(ONE_USDC, 2);
        _fund(id, ONE_USDC);

        vm.prank(approverA);
        vault.approve(id);
        vm.prank(approverB);
        vault.approve(id);
        vault.release(id);

        vm.expectRevert(
            abi.encodeWithSelector(PolicyVault.PolicyNotPending.selector, id, PolicyVault.Status.Executed)
        );
        vm.prank(approverC);
        vault.approve(id);
    }

    // ---------------------------------------------------------------------
    // Revert paths: createPolicy validation
    // ---------------------------------------------------------------------

    function test_RevertWhen_CreateByNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        vault.createPolicy(
            recipient,
            ONE_USDC,
            PolicyVault.PayoutCurrency.USDC,
            BASE_SEPOLIA_DOMAIN,
            PolicyVault.ConditionType.Timelock,
            uint64(block.timestamp + 1 days),
            new address[](0),
            0
        );
    }

    /// @dev EURC cannot leave Arc: CCTP and App Kit Bridge carry USDC only. See DECISIONS.md D1.
    function test_RevertWhen_EurcPayoutToNonArcDomain() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyVault.UnsupportedRoute.selector, PolicyVault.PayoutCurrency.EURC, BASE_SEPOLIA_DOMAIN
            )
        );
        vm.prank(owner);
        vault.createPolicy(
            recipient,
            ONE_USDC,
            PolicyVault.PayoutCurrency.EURC,
            BASE_SEPOLIA_DOMAIN,
            PolicyVault.ConditionType.Approval,
            0,
            _approvers(),
            2
        );
    }

    function test_EurcPayoutOnArcIsAllowed() public {
        uint256 id = _createApproval(ONE_USDC, 2);
        PolicyVault.Policy memory p = vault.getPolicy(id);
        assertEq(uint8(p.payoutCurrency), uint8(PolicyVault.PayoutCurrency.EURC));
        assertEq(p.destinationDomain, ARC_DOMAIN);
    }

    function test_RevertWhen_ZeroRecipient() public {
        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        vm.prank(owner);
        vault.createPolicy(
            address(0),
            ONE_USDC,
            PolicyVault.PayoutCurrency.USDC,
            BASE_SEPOLIA_DOMAIN,
            PolicyVault.ConditionType.Timelock,
            uint64(block.timestamp + 1 days),
            new address[](0),
            0
        );
    }

    function test_RevertWhen_ZeroAmount() public {
        vm.expectRevert(PolicyVault.ZeroAmount.selector);
        vm.prank(owner);
        vault.createPolicy(
            recipient,
            0,
            PolicyVault.PayoutCurrency.USDC,
            BASE_SEPOLIA_DOMAIN,
            PolicyVault.ConditionType.Timelock,
            uint64(block.timestamp + 1 days),
            new address[](0),
            0
        );
    }

    function test_RevertWhen_TimelockInPast() public {
        uint64 past = uint64(block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.ReleaseTimeInPast.selector, past, block.timestamp));
        vm.prank(owner);
        vault.createPolicy(
            recipient,
            ONE_USDC,
            PolicyVault.PayoutCurrency.USDC,
            BASE_SEPOLIA_DOMAIN,
            PolicyVault.ConditionType.Timelock,
            past,
            new address[](0),
            0
        );
    }

    function test_RevertWhen_TimelockCarriesApprovers() public {
        vm.expectRevert(PolicyVault.InvalidTimelockConfig.selector);
        vm.prank(owner);
        vault.createPolicy(
            recipient,
            ONE_USDC,
            PolicyVault.PayoutCurrency.USDC,
            BASE_SEPOLIA_DOMAIN,
            PolicyVault.ConditionType.Timelock,
            uint64(block.timestamp + 1 days),
            _approvers(),
            2
        );
    }

    function test_RevertWhen_ThresholdExceedsApproverCount() public {
        vm.expectRevert(PolicyVault.InvalidApprovalConfig.selector);
        vm.prank(owner);
        vault.createPolicy(
            recipient,
            ONE_USDC,
            PolicyVault.PayoutCurrency.USDC,
            ARC_DOMAIN,
            PolicyVault.ConditionType.Approval,
            0,
            _approvers(),
            4
        );
    }

    function test_RevertWhen_ApprovalCarriesReleaseTime() public {
        vm.expectRevert(PolicyVault.InvalidApprovalConfig.selector);
        vm.prank(owner);
        vault.createPolicy(
            recipient,
            ONE_USDC,
            PolicyVault.PayoutCurrency.USDC,
            ARC_DOMAIN,
            PolicyVault.ConditionType.Approval,
            uint64(block.timestamp + 1 days),
            _approvers(),
            2
        );
    }

    function test_RevertWhen_DuplicateApprover() public {
        address[] memory dupes = new address[](2);
        dupes[0] = approverA;
        dupes[1] = approverA;

        vm.expectRevert(abi.encodeWithSelector(PolicyVault.DuplicateApprover.selector, approverA));
        vm.prank(owner);
        vault.createPolicy(
            recipient,
            ONE_USDC,
            PolicyVault.PayoutCurrency.USDC,
            ARC_DOMAIN,
            PolicyVault.ConditionType.Approval,
            0,
            dupes,
            2
        );
    }

    // ---------------------------------------------------------------------
    // Deposit
    // ---------------------------------------------------------------------

    function test_Deposit_AccumulatesAcrossCalls() public {
        uint256 id = _createTimelock(10 * ONE_USDC, uint64(block.timestamp + 1 days));

        _fund(id, 3 * ONE_USDC);
        _fund(id, 7 * ONE_USDC);

        assertEq(vault.getPolicy(id).funded, 10 * ONE_USDC);
        assertEq(usdc.balanceOf(address(vault)), 10 * ONE_USDC);
    }

    function test_Deposit_FromThirdParty() public {
        uint256 id = _createTimelock(ONE_USDC, uint64(block.timestamp + 1 days));

        usdc.mint(stranger, ONE_USDC);
        vm.startPrank(stranger);
        usdc.approve(address(vault), ONE_USDC);
        vault.deposit(id, ONE_USDC);
        vm.stopPrank();

        assertEq(vault.getPolicy(id).funded, ONE_USDC);
    }

    function test_RevertWhen_DepositExceedsPolicyAmount() public {
        uint256 id = _createTimelock(5 * ONE_USDC, uint64(block.timestamp + 1 days));

        vm.expectRevert(
            abi.encodeWithSelector(PolicyVault.Overfunded.selector, id, 6 * ONE_USDC, 5 * ONE_USDC)
        );
        _fund(id, 6 * ONE_USDC);
    }

    function test_RevertWhen_DepositWithoutAllowance() public {
        uint256 id = _createTimelock(ONE_USDC, uint64(block.timestamp + 1 days));
        usdc.mint(stranger, ONE_USDC);

        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(vault), 0, ONE_USDC)
        );
        vm.prank(stranger);
        vault.deposit(id, ONE_USDC);
    }

    function test_RevertWhen_DepositZero() public {
        uint256 id = _createTimelock(ONE_USDC, uint64(block.timestamp + 1 days));
        vm.expectRevert(PolicyVault.ZeroAmount.selector);
        _fund(id, 0);
    }

    function test_RevertWhen_DepositAfterRelease() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 id = _createTimelock(ONE_USDC, deadline);
        _fund(id, ONE_USDC);
        vm.warp(deadline);
        vault.release(id);

        vm.expectRevert(
            abi.encodeWithSelector(PolicyVault.PolicyNotPending.selector, id, PolicyVault.Status.Executed)
        );
        _fund(id, ONE_USDC);
    }

    // ---------------------------------------------------------------------
    // Cancel
    // ---------------------------------------------------------------------

    function test_Cancel_RefundsOwnerAndBlocksRelease() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 id = _createTimelock(10 * ONE_USDC, deadline);
        _fund(id, 10 * ONE_USDC);

        uint256 balanceBefore = usdc.balanceOf(owner);

        vm.expectEmit(true, true, false, true, address(vault));
        emit PolicyVault.PolicyCancelled(id, owner, 10 * ONE_USDC);
        vm.prank(owner);
        vault.cancel(id);

        assertEq(usdc.balanceOf(owner), balanceBefore + 10 * ONE_USDC);
        assertEq(usdc.balanceOf(address(vault)), 0);
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Cancelled));

        vm.warp(deadline);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyVault.PolicyNotPending.selector, id, PolicyVault.Status.Cancelled)
        );
        vault.release(id);
    }

    function test_Cancel_UnfundedPolicy() public {
        uint256 id = _createTimelock(ONE_USDC, uint64(block.timestamp + 1 days));
        vm.prank(owner);
        vault.cancel(id);
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Cancelled));
    }

    function test_RevertWhen_CancelAfterRelease() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 id = _createTimelock(ONE_USDC, deadline);
        _fund(id, ONE_USDC);
        vm.warp(deadline);
        vault.release(id);

        vm.expectRevert(
            abi.encodeWithSelector(PolicyVault.PolicyNotPending.selector, id, PolicyVault.Status.Executed)
        );
        vm.prank(owner);
        vault.cancel(id);
    }

    function test_RevertWhen_CancelByNonOwner() public {
        uint256 id = _createTimelock(ONE_USDC, uint64(block.timestamp + 1 days));

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        vault.cancel(id);
    }

    function test_RevertWhen_DoubleCancel() public {
        uint256 id = _createTimelock(ONE_USDC, uint64(block.timestamp + 1 days));
        _fund(id, ONE_USDC);

        vm.startPrank(owner);
        vault.cancel(id);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyVault.PolicyNotPending.selector, id, PolicyVault.Status.Cancelled)
        );
        vault.cancel(id);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Executor rotation
    // ---------------------------------------------------------------------

    function test_SetExecutor_RedirectsRelease() public {
        address newExecutor = makeAddr("newExecutor");
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 id = _createTimelock(ONE_USDC, deadline);
        _fund(id, ONE_USDC);

        vm.expectEmit(true, true, false, false, address(vault));
        emit PolicyVault.ExecutorUpdated(executor, newExecutor);
        vm.prank(owner);
        vault.setExecutor(newExecutor);

        vm.warp(deadline);
        vault.release(id);

        assertEq(usdc.balanceOf(newExecutor), ONE_USDC);
        assertEq(usdc.balanceOf(executor), 0);
    }

    function test_RevertWhen_SetExecutorZero() public {
        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        vm.prank(owner);
        vault.setExecutor(address(0));
    }

    function test_RevertWhen_SetExecutorByNonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        vault.setExecutor(stranger);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function test_RevertWhen_ViewingUnknownPolicy() public {
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.UnknownPolicy.selector, 0));
        vault.statusOf(0);

        vm.expectRevert(abi.encodeWithSelector(PolicyVault.UnknownPolicy.selector, 7));
        vault.checkCondition(7);
    }

    function test_PolicyIdsIncrement() public {
        uint256 first = _createTimelock(ONE_USDC, uint64(block.timestamp + 1 days));
        uint256 second = _createTimelock(ONE_USDC, uint64(block.timestamp + 2 days));
        assertEq(first, 0);
        assertEq(second, 1);
        assertEq(vault.nextPolicyId(), 2);
    }

    /// @dev Two policies must not share funding. A release of one must leave the other's balance.
    function test_PoliciesAreFundedIndependently() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        uint256 a = _createTimelock(4 * ONE_USDC, deadline);
        uint256 b = _createTimelock(6 * ONE_USDC, deadline);

        _fund(a, 4 * ONE_USDC);
        _fund(b, 6 * ONE_USDC);

        vm.warp(deadline);
        vault.release(a);

        assertEq(usdc.balanceOf(executor), 4 * ONE_USDC);
        assertEq(usdc.balanceOf(address(vault)), 6 * ONE_USDC, "policy b funding must be untouched");

        vault.release(b);
        assertEq(usdc.balanceOf(executor), 10 * ONE_USDC);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    // ---------------------------------------------------------------------
    // Fuzz
    // ---------------------------------------------------------------------

    function testFuzz_TimelockReleasePaysExactAmount(uint256 amount, uint32 delay) public {
        amount = bound(amount, 1, 1_000_000 * ONE_USDC);
        delay = uint32(bound(delay, 1, type(uint32).max));

        usdc.mint(owner, amount);
        uint64 deadline = uint64(block.timestamp + delay);

        uint256 id = _createTimelock(amount, deadline);
        _fund(id, amount);

        vm.warp(deadline - 1);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.ConditionNotMet.selector, id));
        vault.release(id);

        vm.warp(deadline);
        vault.release(id);

        assertEq(usdc.balanceOf(executor), amount);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function testFuzz_PartialFundingNeverReleases(uint256 amount, uint256 funded) public {
        amount = bound(amount, 2, 1_000_000 * ONE_USDC);
        funded = bound(funded, 1, amount - 1);

        usdc.mint(owner, amount);
        uint64 deadline = uint64(block.timestamp + 1 days);

        uint256 id = _createTimelock(amount, deadline);
        _fund(id, funded);
        vm.warp(deadline);

        vm.expectRevert(abi.encodeWithSelector(PolicyVault.Underfunded.selector, id, funded, amount));
        vault.release(id);
    }

    function testFuzz_ApprovalThresholdIsExact(uint8 threshold) public {
        threshold = uint8(bound(threshold, 1, 3));

        uint256 id = _createApproval(ONE_USDC, threshold);
        _fund(id, ONE_USDC);

        address[] memory all = _approvers();
        for (uint256 i = 0; i < threshold; ++i) {
            if (i > 0) assertFalse(vault.checkCondition(id), "threshold reached early");
            vm.prank(all[i]);
            vault.approve(id);
        }

        assertTrue(vault.checkCondition(id));
        vault.release(id);
        assertEq(usdc.balanceOf(executor), ONE_USDC);
    }
}
