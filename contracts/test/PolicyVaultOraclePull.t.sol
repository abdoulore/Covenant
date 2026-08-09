// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockOracleAdapter} from "./mocks/MockOracleAdapter.sol";

/// @notice OraclePull condition (v4): verify a signed price proof and release atomically, with a
///         confidence guard the wrapper-based Oracle condition structurally cannot provide.
///         See docs/specs/V4_VAULT.md.
contract PolicyVaultOraclePullTest is Test {
    PolicyVault internal vault;
    MockUSDC internal usdc;
    MockOracleAdapter internal adapter;

    address internal owner = makeAddr("owner");
    address internal executor = makeAddr("executor");
    address internal recipient = makeAddr("recipient");
    address internal keeper = makeAddr("keeper");

    uint256 internal constant ONE_USDC = 1e6;
    uint32 internal constant ARC_DOMAIN = 26;
    uint32 internal constant BASE_SEPOLIA_DOMAIN = 6;

    /// @dev 1e18 scale, because the adapter normalizes. 0.995 USDC/USD is 0.995e18.
    int256 internal constant PEG_FLOOR = 995e15;
    bytes32 internal constant FEED_ID = keccak256("USDC/USD");
    uint64 internal constant MAX_STALE = 60;
    bytes internal constant PROOF = hex"c0ffee";

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        vault = new PolicyVault(address(usdc), executor, owner);
        adapter = new MockOracleAdapter();

        usdc.mint(owner, 1_000 * ONE_USDC);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);
        vm.deal(keeper, 10 ether);
    }

    // ---- helpers ----

    function _create(PolicyVault.Comparator cmp, uint16 maxConfBps) internal returns (uint256 id) {
        vm.prank(owner);
        id = vault.createOraclePullPolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, BASE_SEPOLIA_DOMAIN,
            address(adapter), FEED_ID, cmp, PEG_FLOOR, MAX_STALE, maxConfBps
        );
    }

    function _fund(uint256 id) internal {
        vm.prank(owner);
        vault.deposit(id, ONE_USDC);
    }

    // ---- happy path ----

    function test_pull_releasesOnAVerifiedCrossingPrice() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 0);
        _fund(id);
        adapter.setPrice(999e15, 0); // 0.999, above the 0.995 floor

        vm.prank(keeper);
        vault.releaseWithProof(id, PROOF);

        assertEq(usdc.balanceOf(executor), ONE_USDC);
        assertEq(uint8(vault.getPolicy(id).status), uint8(PolicyVault.Status.Executed));
        assertEq(vault.getPolicy(id).funded, 0, "funded must be drawn down");
    }

    function test_pull_passesPolicyConfigThroughToTheAdapter() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 0);
        _fund(id);
        adapter.setPrice(999e15, 0);

        vm.prank(keeper);
        vault.releaseWithProof(id, PROOF);

        assertEq(adapter.lastFeedId(), FEED_ID);
        assertEq(adapter.lastMaxStale(), MAX_STALE);
        assertEq(adapter.lastProof(), PROOF);
    }

    function test_pull_lteDirectionReleasesBelowThreshold() public {
        uint256 id = _create(PolicyVault.Comparator.Lte, 0);
        _fund(id);
        adapter.setPrice(98e16, 0); // 0.98, a real depeg

        vm.prank(keeper);
        vault.releaseWithProof(id, PROOF);
        assertEq(usdc.balanceOf(executor), ONE_USDC);
    }

    // ---- the condition still gates ----

    function test_RevertWhen_priceDoesNotCross() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 0);
        _fund(id);
        adapter.setPrice(99e16, 0); // 0.99, below the 0.995 floor

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.ConditionNotMet.selector, id));
        vault.releaseWithProof(id, PROOF);
        assertEq(usdc.balanceOf(executor), 0);
    }

    /// @dev A real adapter reverts for an unverifiable, stale, or future-dated proof. The vault must
    ///      not paper over that: no release, and the failure propagates rather than reading as unmet.
    function test_RevertWhen_adapterRejectsTheProof() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 0);
        _fund(id);
        adapter.setPrice(999e15, 0);
        adapter.setReverting(true);

        vm.prank(keeper);
        vm.expectRevert(bytes("adapter: proof rejected"));
        vault.releaseWithProof(id, PROOF);
        assertEq(usdc.balanceOf(executor), 0);
    }

    function test_RevertWhen_underfunded() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 0);
        adapter.setPrice(999e15, 0);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.Underfunded.selector, id, 0, ONE_USDC));
        vault.releaseWithProof(id, PROOF);
    }

    function test_RevertWhen_releasedTwice() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 0);
        _fund(id);
        adapter.setPrice(999e15, 0);

        vm.startPrank(keeper);
        vault.releaseWithProof(id, PROOF);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyVault.PolicyNotPending.selector, id, PolicyVault.Status.Executed)
        );
        vault.releaseWithProof(id, PROOF);
        vm.stopPrank();
        assertEq(usdc.balanceOf(executor), ONE_USDC, "a second release must not pay again");
    }

    // ---- the confidence guard, which the wrapper path cannot do at all ----

    function test_confidence_rejectsAWideQuoteThatWouldOtherwiseRelease() public {
        // 50 bps bound; the price crosses the threshold, so only confidence can refuse it.
        uint256 id = _create(PolicyVault.Comparator.Gte, 50);
        _fund(id);
        adapter.setPrice(999e15, 10e15); // conf 0.01 on a 0.999 price is ~100 bps, over the bound

        vm.prank(keeper);
        vm.expectPartialRevert(PolicyVault.ConfidenceTooWide.selector);
        vault.releaseWithProof(id, PROOF);
        assertEq(usdc.balanceOf(executor), 0, "a price the oracle is unsure of must not pay");
    }

    function test_confidence_acceptsATightQuote() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 50);
        _fund(id);
        adapter.setPrice(999e15, 1e15); // ~10 bps, inside the bound

        vm.prank(keeper);
        vault.releaseWithProof(id, PROOF);
        assertEq(usdc.balanceOf(executor), ONE_USDC);
    }

    function test_confidence_boundIsInclusive() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 100);
        _fund(id);
        adapter.setPrice(1e18, 1e16); // exactly 100 bps

        vm.prank(keeper);
        vault.releaseWithProof(id, PROOF);
        assertEq(usdc.balanceOf(executor), ONE_USDC, "exactly at the bound is inside it");
    }

    function test_confidence_zeroDisablesTheCheck() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 0);
        _fund(id);
        adapter.setPrice(999e15, 500e15); // absurdly wide, but the guard is off

        vm.prank(keeper);
        vault.releaseWithProof(id, PROOF);
        assertEq(usdc.balanceOf(executor), ONE_USDC);
    }

    // ---- fee handling, the one place native value touches this contract ----

    function test_fee_forwardsExactlyTheQuoteAndRefundsTheRest() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 0);
        _fund(id);
        adapter.setPrice(999e15, 0);
        adapter.setFee(3 wei);

        uint256 before = keeper.balance;
        vm.prank(keeper);
        vault.releaseWithProof{value: 1 ether}(id, PROOF);

        assertEq(adapter.lastPaid(), 3, "the adapter gets exactly its quote");
        assertEq(keeper.balance, before - 3, "the rest comes back");
        assertEq(address(vault).balance, 0, "no native value settles in the vault");
    }

    function test_RevertWhen_feeUnderpaid() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 0);
        _fund(id);
        adapter.setPrice(999e15, 0);
        adapter.setFee(100);

        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.InsufficientFee.selector, 100, 99));
        vault.releaseWithProof{value: 99}(id, PROOF);
    }

    /// @dev The no-native-value rule survives a refusal too: a reverted release leaves nothing here.
    function test_fee_isReturnedWhenTheConditionRefuses() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 0);
        _fund(id);
        adapter.setPrice(99e16, 0); // does not cross
        adapter.setFee(3 wei);

        uint256 before = keeper.balance;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.ConditionNotMet.selector, id));
        vault.releaseWithProof{value: 1 ether}(id, PROOF);

        assertEq(keeper.balance, before, "a reverted release costs no value");
        assertEq(address(vault).balance, 0);
    }

    // ---- entrypoint separation ----

    function test_RevertWhen_pullPolicyGoesThroughPlainRelease() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 0);
        _fund(id);
        adapter.setPrice(999e15, 0);

        vm.expectRevert(abi.encodeWithSelector(PolicyVault.UseReleaseWithProof.selector, id));
        vault.release(id);
    }

    function test_RevertWhen_otherPolicyGoesThroughReleaseWithProof() public {
        vm.prank(owner);
        uint256 id = vault.createPolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN,
            PolicyVault.ConditionType.Timelock, uint64(block.timestamp + 1 days), new address[](0), 0
        );

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyVault.WrongConditionType.selector,
                id,
                PolicyVault.ConditionType.OraclePull,
                PolicyVault.ConditionType.Timelock
            )
        );
        vault.releaseWithProof(id, PROOF);
    }

    /// @dev checkCondition cannot evaluate a pull policy without a proof, so it must read false
    ///      rather than true. Same discipline as Schedule.
    function test_pull_checkConditionIsFalseAndStatusStaysPending() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 0);
        _fund(id);
        adapter.setPrice(999e15, 0);

        assertFalse(vault.checkCondition(id), "a pull policy has no condition readable from state");
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Pending));
    }

    // ---- creation guards ----

    function test_RevertWhen_createWithBadConfig() public {
        vm.startPrank(owner);
        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        vault.createOraclePullPolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN,
            address(0), FEED_ID, PolicyVault.Comparator.Gte, PEG_FLOOR, MAX_STALE, 0
        );

        vm.expectRevert(PolicyVault.InvalidOraclePullConfig.selector);
        vault.createOraclePullPolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN,
            address(adapter), FEED_ID, PolicyVault.Comparator.Gte, PEG_FLOOR, 0, 0
        );

        vm.expectRevert(PolicyVault.InvalidOraclePullConfig.selector);
        vault.createOraclePullPolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN,
            address(adapter), bytes32(0), PolicyVault.Comparator.Gte, PEG_FLOOR, MAX_STALE, 0
        );

        // A bound above 100% cannot reject anything, so it is a configuration mistake, not a no-op.
        vm.expectRevert(PolicyVault.InvalidOraclePullConfig.selector);
        vault.createOraclePullPolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN,
            address(adapter), FEED_ID, PolicyVault.Comparator.Gte, PEG_FLOOR, MAX_STALE, 10_001
        );
        vm.stopPrank();
    }

    function test_RevertWhen_createByNonOwner() public {
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, keeper));
        vault.createOraclePullPolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN,
            address(adapter), FEED_ID, PolicyVault.Comparator.Gte, PEG_FLOOR, MAX_STALE, 0
        );
    }

    function test_RevertWhen_oldCreatePolicyAsksForPullType() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyVault.UseTypedCreator.selector, PolicyVault.ConditionType.OraclePull)
        );
        vault.createPolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN,
            PolicyVault.ConditionType.OraclePull, 0, new address[](0), 0
        );
    }

    function test_RevertWhen_eurcPullPolicyLeavesArc() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyVault.UnsupportedRoute.selector, PolicyVault.PayoutCurrency.EURC, BASE_SEPOLIA_DOMAIN
            )
        );
        vault.createOraclePullPolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.EURC, BASE_SEPOLIA_DOMAIN,
            address(adapter), FEED_ID, PolicyVault.Comparator.Gte, PEG_FLOOR, MAX_STALE, 0
        );
    }

    function test_cancel_refundsAPullPolicy() public {
        uint256 id = _create(PolicyVault.Comparator.Gte, 0);
        _fund(id);

        uint256 before = usdc.balanceOf(owner);
        vm.prank(owner);
        vault.cancel(id);
        assertEq(usdc.balanceOf(owner), before + ONE_USDC);
        assertEq(uint8(vault.getPolicy(id).status), uint8(PolicyVault.Status.Cancelled));
    }
}
