// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, stdError} from "forge-std/Test.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import {ConditionProbe} from "../src/proof/ConditionProbe.sol";
import {FutureDatedAggregator} from "../src/proof/FutureDatedAggregator.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Reproduces the staleness check exactly as v2 and v3 deployed it, so the proof instruments
///      can be validated against the defect they exist to demonstrate. This is the ONLY copy of the
///      old arithmetic in the tree; the real contract no longer contains it.
///
///      The bug: `block.timestamp - updatedAt` sits outside the try block, so a future-dated
///      updatedAt underflows and reverts the whole call instead of reading as "not yet".
contract DefectiveOracleVault {
    address public feed;
    uint64 public maxStaleSeconds;

    constructor(address feed_, uint64 maxStaleSeconds_) {
        feed = feed_;
        maxStaleSeconds = maxStaleSeconds_;
    }

    function checkCondition(uint256) external view returns (bool) {
        try FutureDatedAggregator(feed).latestRoundData() returns (
            uint80 roundId, int256 answer, uint256, uint256 updatedAt, uint80 answeredInRound
        ) {
            if (answer <= 0 || updatedAt == 0 || answeredInRound < roundId) return false;
            if (block.timestamp - updatedAt > maxStaleSeconds) return false; // underflows here
            return true;
        } catch {
            return false;
        }
    }
}

/// @notice Validates the row-8 proof instruments before they are deployed to Arc and gas is spent
///         producing hashes with them. See docs/specs/V4_VAULT.md.
contract ProofInstrumentsTest is Test {
    PolicyVault internal vault;
    MockUSDC internal usdc;
    FutureDatedAggregator internal feed;
    ConditionProbe internal probe;

    address internal owner = makeAddr("owner");
    address internal executor = makeAddr("executor");
    address internal recipient = makeAddr("recipient");

    uint256 internal constant ONE_USDC = 1e6;
    uint32 internal constant ARC_DOMAIN = 26;
    uint64 internal constant MAX_STALE = 60;
    uint256 internal constant SKEW = 300;

    event Probed(address indexed vault, uint256 indexed policyId, bool met);

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockUSDC();
        vault = new PolicyVault(address(usdc), executor, owner);
        feed = new FutureDatedAggregator(1e8, SKEW);
        probe = new ConditionProbe();

        usdc.mint(owner, 100 * ONE_USDC);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _oraclePolicy() internal returns (uint256 id) {
        vm.prank(owner);
        id = vault.createOraclePolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN,
            address(feed), PolicyVault.Comparator.Gte, 995e5, MAX_STALE
        );
        vm.prank(owner);
        vault.deposit(id, ONE_USDC);
    }

    /// @dev The instrument must report a future-dated answer and nothing else unusual, or the proof
    ///      would not isolate the timestamp as the cause.
    function test_aggregator_reportsAValidAnswerDatedAhead() public view {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        assertEq(updatedAt, block.timestamp + SKEW, "dated ahead of the block");
        assertGt(answer, 0, "otherwise valid: positive");
        assertEq(answeredInRound, roundId, "otherwise valid: complete round");
    }

    /// @dev v4's behaviour: the read succeeds and answers "not met".
    function test_v4_probeSucceedsAndReportsNotMet() public {
        uint256 id = _oraclePolicy();

        vm.expectEmit(true, true, false, true, address(probe));
        emit Probed(address(vault), id, false);
        bool met = probe.probe(address(vault), id);

        assertFalse(met, "a future-dated answer reads as not yet, not as a release");
    }

    /// @dev v2/v3 behaviour, against the reproduction above: the read itself reverts with an
    ///      arithmetic panic. This is what makes the pair of onchain hashes a comparison.
    function test_v3_probeRevertsWithAnArithmeticPanic() public {
        DefectiveOracleVault defective = new DefectiveOracleVault(address(feed), MAX_STALE);

        vm.expectRevert(stdError.arithmeticError);
        probe.probe(address(defective), 0);
    }

    /// @dev And the release path refuses cleanly on v4 rather than panicking, so the recorded revert
    ///      reason differs from v3's even though both transactions fail with status 0. The reason is
    ///      the evidence; "reverted" alone would prove nothing.
    function test_v4_releaseRefusesWithConditionNotMet() public {
        uint256 id = _oraclePolicy();
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.ConditionNotMet.selector, id));
        vault.release(id);
    }

    /// @dev The fix must not swallow legitimately fresh data: same feed shape, sane timestamp.
    function test_v4_stillReleasesOnAFreshInRangeAnswer() public {
        FutureDatedAggregator fresh = new FutureDatedAggregator(1e8, 0); // no skew
        vm.prank(owner);
        uint256 id = vault.createOraclePolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN,
            address(fresh), PolicyVault.Comparator.Gte, 995e5, MAX_STALE
        );
        vm.prank(owner);
        vault.deposit(id, ONE_USDC);

        assertTrue(probe.probe(address(vault), id), "a current answer still releases");
        vault.release(id);
        assertEq(usdc.balanceOf(executor), ONE_USDC);
    }
}
