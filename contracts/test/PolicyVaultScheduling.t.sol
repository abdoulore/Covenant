// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Scheduling (Phase 2.3): recurring payroll and sweep policies, released per period via
///         releasePeriod, with a maxCatchUp bound that holds a long-overdue period for owner approval.
contract PolicyVaultSchedulingTest is Test {
    PolicyVault internal vault;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal executor = makeAddr("executor");
    address internal recipient = makeAddr("recipient");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant ONE_USDC = 1e6;
    uint32 internal constant ARC_DOMAIN = 26;
    uint32 internal constant BASE_SEPOLIA_DOMAIN = 6;
    uint64 internal constant DAY = 1 days;

    function setUp() public {
        vm.warp(1_000_000); // a sane base timestamp for schedules
        usdc = new MockUSDC();
        vault = new PolicyVault(address(usdc), executor, owner);
        usdc.mint(owner, 1_000 * ONE_USDC);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _recurring(uint256 perPeriod, uint32 periods, uint64 maxCatchUp) internal returns (uint256 id) {
        vm.prank(owner);
        id = vault.createRecurringPolicy(
            recipient, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN,
            perPeriod, DAY, uint64(block.timestamp), periods, maxCatchUp
        );
    }

    function _sweep(uint256 buffer, uint256 minSweep, uint64 maxCatchUp) internal returns (uint256 id) {
        vm.prank(owner);
        id = vault.createSweepPolicy(
            recipient, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN,
            buffer, minSweep, DAY, uint64(block.timestamp), maxCatchUp
        );
    }

    function _fund(uint256 id, uint256 amount) internal {
        vm.prank(owner);
        vault.deposit(id, amount);
    }

    // ---------------------------------------------------------------------
    // Payroll
    // ---------------------------------------------------------------------

    function test_recurring_releasesEachPeriodThenRetires() public {
        uint256 id = _recurring(ONE_USDC, 3, 7 * DAY);
        _fund(id, 3 * ONE_USDC);

        vault.releasePeriod(id); // period 1, due at creation
        assertEq(usdc.balanceOf(executor), ONE_USDC);

        vm.expectPartialRevert(PolicyVault.PeriodNotDue.selector);
        vault.releasePeriod(id); // period 2 not due yet

        vm.warp(block.timestamp + DAY);
        vault.releasePeriod(id); // period 2
        vm.warp(block.timestamp + DAY);
        vault.releasePeriod(id); // period 3, the last
        assertEq(usdc.balanceOf(executor), 3 * ONE_USDC);
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Executed));

        vm.warp(block.timestamp + DAY);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.PolicyNotPending.selector, id, PolicyVault.Status.Executed));
        vault.releasePeriod(id);
    }

    function test_recurring_rejectsSingleShotRelease() public {
        uint256 id = _recurring(ONE_USDC, 3, 7 * DAY);
        _fund(id, ONE_USDC);
        vm.expectPartialRevert(PolicyVault.UseReleasePeriod.selector);
        vault.release(id);
    }

    function test_recurring_acceptsTopUpsBeyondNominal() public {
        uint256 id = _recurring(ONE_USDC, 0, 7 * DAY); // open-ended
        _fund(id, 5 * ONE_USDC); // no Overfunded revert for a recurring policy
        assertEq(vault.getPolicy(id).funded, 5 * ONE_USDC);
    }

    function test_recurring_openEnded_runsUntilFundsRunOutThenResumesOnTopUp() public {
        uint256 id = _recurring(ONE_USDC, 0, 30 * DAY);
        _fund(id, 2 * ONE_USDC);
        vault.releasePeriod(id);
        vm.warp(block.timestamp + DAY);
        vault.releasePeriod(id);

        vm.warp(block.timestamp + DAY);
        vm.expectPartialRevert(PolicyVault.Underfunded.selector);
        vault.releasePeriod(id);
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Pending)); // still active

        _fund(id, ONE_USDC);
        vault.releasePeriod(id);
        assertEq(usdc.balanceOf(executor), 3 * ONE_USDC);
    }

    function test_recurring_catchUpReleasesOnePeriodPerCall() public {
        uint256 id = _recurring(ONE_USDC, 5, 100 * DAY); // generous bound
        _fund(id, 5 * ONE_USDC);
        vm.warp(block.timestamp + 2 * DAY); // periods 1, 2, 3 are now all due

        vault.releasePeriod(id);
        vault.releasePeriod(id);
        vault.releasePeriod(id);
        assertEq(usdc.balanceOf(executor), 3 * ONE_USDC);

        vm.expectPartialRevert(PolicyVault.PeriodNotDue.selector);
        vault.releasePeriod(id); // period 4 is still in the future
    }

    function test_recurring_catchUpBoundHoldsStalePeriodForOwner() public {
        uint256 id = _recurring(ONE_USDC, 5, 2 * DAY); // maxCatchUp 2 days
        _fund(id, 5 * ONE_USDC);
        vault.releasePeriod(id); // period 1

        vm.warp(block.timestamp + 5 * DAY); // period 2 overdue by 4 days, beyond the bound
        vm.expectPartialRevert(PolicyVault.CatchUpStale.selector);
        vault.releasePeriod(id);

        vm.prank(owner);
        vault.approveStalePeriod(id); // owner clears exactly this period
        assertEq(usdc.balanceOf(executor), 2 * ONE_USDC);
    }

    function test_approveStalePeriod_ownerOnly() public {
        uint256 id = _recurring(ONE_USDC, 5, 2 * DAY);
        _fund(id, 5 * ONE_USDC);
        vault.releasePeriod(id);
        vm.warp(block.timestamp + 5 * DAY);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.approveStalePeriod(id);
    }

    function test_recurring_emitsPeriodIndex() public {
        uint256 id = _recurring(ONE_USDC, 3, 7 * DAY);
        _fund(id, 3 * ONE_USDC);

        vm.expectEmit(true, true, false, true, address(vault));
        emit PolicyVault.PolicyReleased(id, recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, executor, 1);
        vault.releasePeriod(id);

        vm.warp(block.timestamp + DAY);
        vm.expectEmit(true, true, false, true, address(vault));
        emit PolicyVault.PolicyReleased(id, recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, executor, 2);
        vault.releasePeriod(id);
    }

    function test_statusOf_recurring_reflectsDueAndFunded() public {
        uint256 id = _recurring(ONE_USDC, 3, 7 * DAY);
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Pending)); // due but unfunded

        _fund(id, 3 * ONE_USDC);
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Releasable));
        assertTrue(vault.isPeriodDue(id));

        vault.releasePeriod(id);
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Pending)); // next period not due
        assertFalse(vault.isPeriodDue(id));
    }

    function test_cancel_recurring_refundsRemaining() public {
        uint256 id = _recurring(ONE_USDC, 5, 7 * DAY);
        _fund(id, 5 * ONE_USDC);
        vault.releasePeriod(id); // 1 out, 4 remain funded

        uint256 ownerBefore = usdc.balanceOf(owner);
        vm.prank(owner);
        vault.cancel(id);
        assertEq(usdc.balanceOf(owner), ownerBefore + 4 * ONE_USDC);
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Cancelled));
    }

    function test_recurring_rejectsEurcCrossChain() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyVault.UnsupportedRoute.selector, PolicyVault.PayoutCurrency.EURC, BASE_SEPOLIA_DOMAIN)
        );
        vault.createRecurringPolicy(
            recipient, PolicyVault.PayoutCurrency.EURC, BASE_SEPOLIA_DOMAIN,
            ONE_USDC, DAY, uint64(block.timestamp), 3, 7 * DAY
        );
    }

    function test_createRecurring_rejectsBadConfig() public {
        uint64 now_ = uint64(block.timestamp);
        vm.startPrank(owner);
        vm.expectRevert(PolicyVault.ZeroAmount.selector);
        vault.createRecurringPolicy(recipient, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, 0, DAY, now_, 3, 7 * DAY);
        vm.expectRevert(PolicyVault.InvalidRecurringConfig.selector);
        vault.createRecurringPolicy(recipient, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, ONE_USDC, 0, now_, 3, 7 * DAY);
        vm.expectRevert(PolicyVault.InvalidRecurringConfig.selector);
        vault.createRecurringPolicy(recipient, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, ONE_USDC, DAY, now_, 3, 0);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Sweep
    // ---------------------------------------------------------------------

    function test_sweep_releasesExcessAndKeepsBuffer() public {
        uint256 id = _sweep(10 * ONE_USDC, ONE_USDC, 7 * DAY);
        _fund(id, 15 * ONE_USDC); // 5 above the buffer
        vault.releasePeriod(id);
        assertEq(usdc.balanceOf(executor), 5 * ONE_USDC);
        assertEq(vault.getPolicy(id).funded, 10 * ONE_USDC); // buffer kept
    }

    function test_sweep_skipsWhenExcessBelowMin() public {
        uint256 id = _sweep(10 * ONE_USDC, ONE_USDC, 7 * DAY);
        _fund(id, 10 * ONE_USDC + ONE_USDC / 2); // excess 0.5 < minSweep 1
        vm.expectPartialRevert(PolicyVault.SweepBelowMin.selector);
        vault.releasePeriod(id);
    }

    function test_sweep_afterTopUp() public {
        uint256 id = _sweep(10 * ONE_USDC, ONE_USDC, 30 * DAY);
        _fund(id, 12 * ONE_USDC);
        vault.releasePeriod(id); // sweeps 2, keeps 10
        assertEq(usdc.balanceOf(executor), 2 * ONE_USDC);

        _fund(id, 3 * ONE_USDC); // 13 funded
        vm.warp(block.timestamp + DAY);
        vault.releasePeriod(id); // sweeps 3
        assertEq(usdc.balanceOf(executor), 5 * ONE_USDC);
        assertEq(vault.getPolicy(id).funded, 10 * ONE_USDC);
    }

    function test_createSweep_rejectsBadConfig() public {
        uint64 now_ = uint64(block.timestamp);
        vm.startPrank(owner);
        vm.expectRevert(PolicyVault.InvalidSweepConfig.selector);
        vault.createSweepPolicy(recipient, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, 10 * ONE_USDC, 0, DAY, now_, 7 * DAY);
        vm.expectRevert(PolicyVault.InvalidSweepConfig.selector);
        vault.createSweepPolicy(recipient, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, 10 * ONE_USDC, ONE_USDC, 0, now_, 7 * DAY);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // How a scheduled policy reports itself
    // ---------------------------------------------------------------------

    event PolicyCreated(
        uint256 indexed policyId,
        address indexed recipient,
        uint256 amount,
        PolicyVault.PayoutCurrency payoutCurrency,
        uint32 destinationDomain,
        PolicyVault.ConditionType conditionType
    );

    /// @dev A scheduled policy must not read as a satisfied Timelock. Both the stored type and the
    ///      creation event say Schedule, so an indexer or keeper is not told the wrong thing.
    function test_schedule_reportsScheduleConditionType() public {
        uint64 now_ = uint64(block.timestamp);

        vm.expectEmit(true, true, false, true);
        emit PolicyCreated(0, recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, PolicyVault.ConditionType.Schedule);
        vm.prank(owner);
        uint256 payroll = vault.createRecurringPolicy(
            recipient, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, ONE_USDC, DAY, now_, 3, 7 * DAY
        );

        vm.expectEmit(true, true, false, true);
        emit PolicyCreated(1, recipient, 0, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, PolicyVault.ConditionType.Schedule);
        vm.prank(owner);
        uint256 sweep = vault.createSweepPolicy(
            recipient, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, 10 * ONE_USDC, ONE_USDC, DAY, now_, 7 * DAY
        );

        assertEq(uint8(vault.getPolicy(payroll).conditionType), uint8(PolicyVault.ConditionType.Schedule));
        assertEq(uint8(vault.getPolicy(sweep).conditionType), uint8(PolicyVault.ConditionType.Schedule));
    }

    /// @dev checkCondition is the single-shot gate and does not apply to a schedule. It must read
    ///      false, not true, so a consumer that does not know to call isPeriodDue is not misled.
    function test_schedule_checkConditionIsFalse() public {
        uint256 id = _recurring(ONE_USDC, 3, 7 * DAY);
        _fund(id, 3 * ONE_USDC);

        assertFalse(vault.checkCondition(id), "a schedule has no single-shot condition");
        assertTrue(vault.isPeriodDue(id), "isPeriodDue is the gate that does apply");
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Releasable));
    }

    function test_RevertWhen_createPolicyAsksForScheduleType() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyVault.UseTypedCreator.selector, PolicyVault.ConditionType.Schedule)
        );
        vault.createPolicy(
            recipient,
            ONE_USDC,
            PolicyVault.PayoutCurrency.USDC,
            ARC_DOMAIN,
            PolicyVault.ConditionType.Schedule,
            0,
            new address[](0),
            0
        );
    }
}
