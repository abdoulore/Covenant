// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOracleAdapter} from "./IOracleAdapter.sol";
import {IPyth} from "./vendor/pyth/IPyth.sol";
import {PythStructs} from "./vendor/pyth/PythStructs.sol";

/// @title PythAdapter
/// @notice IOracleAdapter over Pyth, verifying a signed update and returning the price atomically.
///
/// @dev Why parsePriceFeedUpdates rather than updatePriceFeeds followed by a read: it verifies the
///      update, enforces the publish-time window, and returns the price in one call, without storing
///      anything. That collapses the two-transaction wrapper flow (refresh, then release) into one,
///      and closes the window between them.
///
///      It is also where this adapter's fail-closed property comes from, structurally rather than by
///      our own arithmetic. The window is [now - maxStaleSeconds, now]: a proof that is too old is
///      rejected, and so is one dated in the future. The wrapper path had to check staleness itself,
///      and the future-dated case is precisely what it got wrong (see docs/specs/V4_VAULT.md).
contract PythAdapter is IOracleAdapter {
    /// @notice The Pyth contract this adapter verifies against.
    IPyth public immutable pyth;

    error ZeroAddress();
    error NonPositivePrice(int64 price);
    error ExponentOutOfRange(int32 expo);
    error NoFeedReturned();

    constructor(address pyth_) {
        if (pyth_ == address(0)) revert ZeroAddress();
        pyth = IPyth(pyth_);
    }

    /// @inheritdoc IOracleAdapter
    function quoteFee(bytes calldata proof) external view returns (uint256) {
        bytes[] memory updateData = new bytes[](1);
        updateData[0] = proof;
        return pyth.getUpdateFee(updateData);
    }

    /// @inheritdoc IOracleAdapter
    /// @dev Forwards exactly the value it is sent. The vault quotes the fee first and sends that, so
    ///      nothing accumulates here; this contract holds no balance between calls and has no way to
    ///      receive value outside this function.
    function verifyAndRead(bytes32 feedId, bytes calldata proof, uint64 maxStaleSeconds)
        external
        payable
        returns (int256 value1e18, uint256 conf1e18, uint256 publishTime)
    {
        bytes[] memory updateData = new bytes[](1);
        updateData[0] = proof;
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = feedId;

        // Clamped at zero rather than subtracted blindly: on a chain whose timestamp is below
        // maxStaleSeconds the subtraction would underflow and revert, which is the same class of bug
        // this adapter exists to fix.
        uint64 minPublishTime =
            block.timestamp > maxStaleSeconds ? uint64(block.timestamp - maxStaleSeconds) : 0;

        PythStructs.PriceFeed[] memory feeds =
            pyth.parsePriceFeedUpdates{value: msg.value}(updateData, ids, minPublishTime, uint64(block.timestamp));

        if (feeds.length == 0) revert NoFeedReturned();
        PythStructs.Price memory p = feeds[0].price;

        // A non-positive price is not a cheap price, it is a broken feed. Reject rather than compare.
        if (p.price <= 0) revert NonPositivePrice(p.price);

        (value1e18, conf1e18) = _normalize(p.price, p.conf, p.expo);
        publishTime = p.publishTime;
    }

    /// @dev Scale a Pyth `price * 10^expo` pair to 18 decimals. Pyth's USDC/USD expo is -8, so the
    ///      usual path multiplies by 1e10. Positive exponents are handled for completeness; a value
    ///      too extreme to represent reverts rather than silently saturating.
    function _normalize(int64 value, uint64 conf, int32 expo)
        internal
        pure
        returns (int256 value1e18, uint256 conf1e18)
    {
        int256 shift = int256(18) + int256(expo);

        if (shift >= 0) {
            if (shift > 60) revert ExponentOutOfRange(expo);
            uint256 factor = 10 ** uint256(shift);
            value1e18 = int256(value) * int256(factor);
            conf1e18 = uint256(conf) * factor;
        } else {
            uint256 downShift = uint256(-shift);
            if (downShift > 60) revert ExponentOutOfRange(expo);
            uint256 factor = 10 ** downShift;
            value1e18 = int256(value) / int256(factor);
            conf1e18 = uint256(conf) / factor;
        }
    }
}
