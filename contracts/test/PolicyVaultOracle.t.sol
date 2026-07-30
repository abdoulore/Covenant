// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";

/// @notice Oracle condition (Phase 2). See docs/specs/PHASE2_CONDITION_TYPES.md.
contract PolicyVaultOracleTest is Test {
    PolicyVault internal vault;
    MockUSDC internal usdc;
    MockAggregator internal feed;

    address internal owner = makeAddr("owner");
    address internal executor = makeAddr("executor");
    address internal recipient = makeAddr("recipient");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant ONE_USDC = 1e6;
    uint32 internal constant ARC_DOMAIN = 26;
    uint32 internal constant BASE_SEPOLIA_DOMAIN = 6;

    /// @dev 8 decimal feed scale, like a Chainlink USD price feed.
    int256 internal constant THRESHOLD = 2000e8;
    uint64 internal constant MAX_STALE = 3600;

    function setUp() public {
        // A realistic unix time, so staleness math has room to look backwards without underflow.
        vm.warp(1_700_000_000);

        usdc = new MockUSDC();
        vault = new PolicyVault(address(usdc), executor, owner);
        feed = new MockAggregator();

        usdc.mint(owner, 1_000 * ONE_USDC);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ---- helpers ----

    function _create(PolicyVault.Comparator cmp) internal returns (uint256 id) {
        vm.prank(owner);
        id = vault.createOraclePolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, BASE_SEPOLIA_DOMAIN, address(feed), cmp, THRESHOLD, MAX_STALE
        );
    }

    function _fund(uint256 id) internal {
        vm.prank(owner);
        vault.deposit(id, ONE_USDC);
    }

    // ---- happy path, both directions ----

    function test_Oracle_GteReleasesWhenAboveThreshold() public {
        uint256 id = _create(PolicyVault.Comparator.Gte);
        _fund(id);
        feed.setAnswer(THRESHOLD + 1);

        assertTrue(vault.checkCondition(id));
        vault.release(id);
        assertEq(usdc.balanceOf(executor), ONE_USDC);
        assertEq(uint8(vault.getPolicy(id).status), uint8(PolicyVault.Status.Executed));
    }

    function test_Oracle_GteBoundaryIsInclusive() public {
        uint256 id = _create(PolicyVault.Comparator.Gte);
        feed.setAnswer(THRESHOLD); // exactly at the threshold
        assertTrue(vault.checkCondition(id));
    }

    function test_Oracle_GteNotMetBelowThreshold() public {
        uint256 id = _create(PolicyVault.Comparator.Gte);
        feed.setAnswer(THRESHOLD - 1);
        assertFalse(vault.checkCondition(id));
    }

    function test_Oracle_LteReleasesWhenBelowThreshold() public {
        uint256 id = _create(PolicyVault.Comparator.Lte);
        _fund(id);
        feed.setAnswer(THRESHOLD - 1);

        assertTrue(vault.checkCondition(id));
        vault.release(id);
        assertEq(usdc.balanceOf(executor), ONE_USDC);
    }

    function test_Oracle_LteBoundaryIsInclusive() public {
        uint256 id = _create(PolicyVault.Comparator.Lte);
        feed.setAnswer(THRESHOLD);
        assertTrue(vault.checkCondition(id));
    }

    function test_Oracle_LteNotMetAboveThreshold() public {
        uint256 id = _create(PolicyVault.Comparator.Lte);
        feed.setAnswer(THRESHOLD + 1);
        assertFalse(vault.checkCondition(id));
    }

    function test_RevertWhen_ReleaseBeforeCross() public {
        uint256 id = _create(PolicyVault.Comparator.Gte);
        _fund(id);
        feed.setAnswer(THRESHOLD - 1);

        vm.expectRevert(abi.encodeWithSelector(PolicyVault.ConditionNotMet.selector, id));
        vault.release(id);
    }

    // ---- fail closed on bad data ----

    function test_Oracle_FailsClosedOnStaleData() public {
        uint256 id = _create(PolicyVault.Comparator.Gte);
        feed.setAnswer(THRESHOLD + 1); // fresh, and it does cross
        assertTrue(vault.checkCondition(id), "fresh crossing reads true");

        vm.warp(block.timestamp + MAX_STALE + 1); // now the same answer is stale
        assertFalse(vault.checkCondition(id), "stale data must not release");
    }

    function test_Oracle_FailsClosedOnZeroAnswer() public {
        uint256 id = _create(PolicyVault.Comparator.Lte); // 0 <= threshold would otherwise be true
        feed.setAnswer(0);
        assertFalse(vault.checkCondition(id));
    }

    function test_Oracle_FailsClosedOnNegativeAnswer() public {
        uint256 id = _create(PolicyVault.Comparator.Lte); // negative <= threshold would otherwise be true
        feed.setAnswer(-1);
        assertFalse(vault.checkCondition(id));
    }

    function test_Oracle_FailsClosedOnIncompleteRound() public {
        uint256 id = _create(PolicyVault.Comparator.Gte);
        feed.setAnswer(THRESHOLD + 1);
        feed.setIncompleteRound(); // answeredInRound < roundId
        assertFalse(vault.checkCondition(id));
    }

    function test_Oracle_FailsClosedWhenFeedReverts() public {
        uint256 id = _create(PolicyVault.Comparator.Gte);
        feed.setAnswer(THRESHOLD + 1);
        feed.setReverting(true);

        // The view must not propagate the feed's revert: it returns false.
        assertFalse(vault.checkCondition(id));

        // And release refuses cleanly with ConditionNotMet, not the feed's error.
        _fund(id);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.ConditionNotMet.selector, id));
        vault.release(id);
    }

    // ---- creation guards ----

    function test_RevertWhen_OldCreatePolicyRejectsOracleType() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyVault.UseTypedCreator.selector, PolicyVault.ConditionType.Oracle)
        );
        vault.createPolicy(
            recipient,
            ONE_USDC,
            PolicyVault.PayoutCurrency.USDC,
            BASE_SEPOLIA_DOMAIN,
            PolicyVault.ConditionType.Oracle,
            0,
            new address[](0),
            0
        );
    }

    function test_RevertWhen_CreateOracleZeroFeed() public {
        vm.prank(owner);
        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        vault.createOraclePolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, address(0), PolicyVault.Comparator.Gte, THRESHOLD, MAX_STALE
        );
    }

    function test_RevertWhen_CreateOracleZeroRecipient() public {
        vm.prank(owner);
        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        vault.createOraclePolicy(
            address(0), ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, address(feed), PolicyVault.Comparator.Gte, THRESHOLD, MAX_STALE
        );
    }

    function test_RevertWhen_CreateOracleZeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(PolicyVault.ZeroAmount.selector);
        vault.createOraclePolicy(
            recipient, 0, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, address(feed), PolicyVault.Comparator.Gte, THRESHOLD, MAX_STALE
        );
    }

    function test_RevertWhen_CreateOracleZeroMaxStale() public {
        vm.prank(owner);
        vm.expectRevert(PolicyVault.InvalidOracleConfig.selector);
        vault.createOraclePolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, address(feed), PolicyVault.Comparator.Gte, THRESHOLD, 0
        );
    }

    function test_RevertWhen_CreateOracleEurcCrossChain() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyVault.UnsupportedRoute.selector, PolicyVault.PayoutCurrency.EURC, BASE_SEPOLIA_DOMAIN
            )
        );
        vault.createOraclePolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.EURC, BASE_SEPOLIA_DOMAIN, address(feed), PolicyVault.Comparator.Gte, THRESHOLD, MAX_STALE
        );
    }

    function test_RevertWhen_CreateOracleNotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.createOraclePolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, address(feed), PolicyVault.Comparator.Gte, THRESHOLD, MAX_STALE
        );
    }

    // ---- fuzz ----

    function testFuzz_GteMatchesComparison(int256 answer) public {
        // For any positive, fresh answer, checkCondition must equal (answer >= threshold).
        answer = int256(bound(answer, 1, type(int192).max));
        uint256 id = _create(PolicyVault.Comparator.Gte);
        feed.setAnswer(answer);
        assertEq(vault.checkCondition(id), answer >= THRESHOLD);
    }

    function testFuzz_StalenessBoundary(uint64 age) public {
        age = uint64(bound(age, 0, 10 * MAX_STALE));
        uint256 id = _create(PolicyVault.Comparator.Gte);
        uint256 answerTime = block.timestamp;
        feed.setAnswerAt(THRESHOLD + 1, answerTime); // crosses, but may be stale
        vm.warp(answerTime + age);
        // Fresh enough only while age does not exceed the window.
        assertEq(vault.checkCondition(id), age <= MAX_STALE);
    }
}
