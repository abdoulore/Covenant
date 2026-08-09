// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PythAdapter} from "../src/PythAdapter.sol";
import {MockPyth} from "./mocks/MockPyth.sol";

/// @notice PythAdapter: verify a signed update and normalize the price to 1e18.
/// @dev The normalization is the part worth testing hard. Every threshold on an OraclePull policy is
///      compared against whatever this returns, so an exponent handled wrongly is a payment made
///      against a price off by orders of magnitude.
contract PythAdapterTest is Test {
    PythAdapter internal adapter;
    MockPyth internal pyth;

    bytes32 internal constant FEED_ID = keccak256("USDC/USD");
    bytes internal constant PROOF = hex"c0ffee";
    uint64 internal constant MAX_STALE = 60;

    function setUp() public {
        vm.warp(1_700_000_000);
        pyth = new MockPyth();
        adapter = new PythAdapter(address(pyth));
    }

    function test_RevertWhen_constructedWithZeroPyth() public {
        vm.expectRevert(PythAdapter.ZeroAddress.selector);
        new PythAdapter(address(0));
    }

    // ---- normalization ----

    /// @dev The real case: USDC/USD publishes at expo -8, so 0.99985376 arrives as 99985376.
    function test_normalizes_theRealUsdcExponent() public {
        pyth.setPrice(99_985_376, 49_537, -8);
        (int256 value, uint256 conf,) = adapter.verifyAndRead(FEED_ID, PROOF, MAX_STALE);

        assertEq(value, 999_853_760_000_000_000, "0.99985376 scaled to 1e18");
        assertEq(conf, 495_370_000_000_000, "confidence uses the same scale");
    }

    function test_normalizes_exactlyOne() public {
        pyth.setPrice(1e8, 0, -8);
        (int256 value,,) = adapter.verifyAndRead(FEED_ID, PROOF, MAX_STALE);
        assertEq(value, 1e18);
    }

    function test_normalizes_anAlreadyEighteenDecimalFeed() public {
        pyth.setPrice(5e17, 1e15, -18);
        (int256 value, uint256 conf,) = adapter.verifyAndRead(FEED_ID, PROOF, MAX_STALE);
        assertEq(value, 5e17, "expo -18 needs no shift");
        assertEq(conf, 1e15);
    }

    /// @dev A positive exponent means the raw integer is larger than the value, not smaller.
    function test_normalizes_aPositiveExponent() public {
        pyth.setPrice(3, 1, 2); // 3 * 10^2 = 300
        (int256 value, uint256 conf,) = adapter.verifyAndRead(FEED_ID, PROOF, MAX_STALE);
        assertEq(value, 300e18);
        assertEq(conf, 100e18);
    }

    function test_RevertWhen_exponentIsAbsurd() public {
        pyth.setPrice(1, 0, 100);
        vm.expectRevert(abi.encodeWithSelector(PythAdapter.ExponentOutOfRange.selector, int32(100)));
        adapter.verifyAndRead(FEED_ID, PROOF, MAX_STALE);
    }

    // ---- fail closed ----

    function test_RevertWhen_priceIsZeroOrNegative() public {
        pyth.setPrice(0, 0, -8);
        vm.expectRevert(abi.encodeWithSelector(PythAdapter.NonPositivePrice.selector, int64(0)));
        adapter.verifyAndRead(FEED_ID, PROOF, MAX_STALE);

        pyth.setPrice(-1, 0, -8);
        vm.expectRevert(abi.encodeWithSelector(PythAdapter.NonPositivePrice.selector, int64(-1)));
        adapter.verifyAndRead(FEED_ID, PROOF, MAX_STALE);
    }

    /**
     * The whole reason this adapter exists rather than another hand-rolled staleness check.
     *
     * The window handed to Pyth is [now - maxStaleSeconds, now]. The upper bound is `now`, so an
     * update published in the future is outside it and Pyth refuses to return it. The wrapper path
     * had to subtract timestamps itself, and that subtraction underflowing on a future-dated answer
     * is the defect that forced v4. Here the vault never does the arithmetic at all.
     */
    function test_windowAsksPythToRejectBothStaleAndFutureDatedUpdates() public {
        adapter.verifyAndRead(FEED_ID, PROOF, MAX_STALE);

        assertEq(pyth.lastMinPublishTime(), uint64(block.timestamp - MAX_STALE), "oldest accepted");
        assertEq(pyth.lastMaxPublishTime(), uint64(block.timestamp), "nothing newer than now");
    }

    function test_RevertWhen_pythFindsNothingInTheWindow() public {
        pyth.setOutOfWindow(true);
        vm.expectRevert(MockPyth.PriceFeedNotFoundWithinRange.selector);
        adapter.verifyAndRead(FEED_ID, PROOF, MAX_STALE);
    }

    /// @dev A chain whose timestamp is below maxStaleSeconds must clamp, not underflow. Same class of
    ///      bug as the one this adapter replaces, so it is guarded and tested rather than assumed.
    function test_windowClampsRatherThanUnderflowingOnAYoungChain() public {
        vm.warp(10);
        adapter.verifyAndRead(FEED_ID, PROOF, MAX_STALE); // maxStale 60 > timestamp 10
        assertEq(pyth.lastMinPublishTime(), 0, "clamped to zero");
        assertEq(pyth.lastMaxPublishTime(), 10);
    }

    // ---- fees ----

    function test_quoteFee_readsThroughToPyth() public {
        pyth.setUpdateFee(7);
        assertEq(adapter.quoteFee(PROOF), 7);
    }

    function test_forwardsTheValueItIsSentAndKeepsNothing() public {
        pyth.setUpdateFee(3);
        adapter.verifyAndRead{value: 3}(FEED_ID, PROOF, MAX_STALE);

        assertEq(pyth.lastValueReceived(), 3, "the fee reaches Pyth");
        assertEq(address(adapter).balance, 0, "the adapter holds no balance between calls");
    }

    function testFuzz_normalizationIsMonotonic(int64 a, int64 b) public {
        a = int64(bound(a, 1, type(int32).max));
        b = int64(bound(b, 1, type(int32).max));
        vm.assume(a < b);

        pyth.setPrice(a, 0, -8);
        (int256 va,,) = adapter.verifyAndRead(FEED_ID, PROOF, MAX_STALE);
        pyth.setPrice(b, 0, -8);
        (int256 vb,,) = adapter.verifyAndRead(FEED_ID, PROOF, MAX_STALE);

        assertLt(va, vb, "a larger raw price must normalize to a larger value");
    }
}
