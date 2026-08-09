// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title FutureDatedAggregator
/// @notice An AggregatorV3 feed that reports a valid price dated in the future, for proving the
///         fail-closed fix onchain.
///
/// @dev This is a proof instrument, not production code, and it is deployed to Arc on purpose. The
///      defect that forced v4 is an underflow when a feed's `updatedAt` runs ahead of the block
///      timestamp, and Pyth cannot be asked to publish a future timestamp on demand. So the feed is
///      synthetic and the vault under test is the real deployed one. What is being proven is the
///      vault's guard, not the price's meaning, so a synthetic feed is the honest instrument here:
///      no claim is being made about what the number says, only about how the vault handles it.
///
///      Everything else about the answer is deliberately valid, so the future-dated timestamp is the
///      only thing that can cause a difference in behaviour: the price is positive, the round is
///      complete, and the feed does not revert.
contract FutureDatedAggregator {
    /// @notice Seconds ahead of the current block that `updatedAt` is reported.
    uint256 public immutable skewSeconds;

    /// @notice The answer returned, in the feed's own decimals.
    int256 public immutable answer;

    constructor(int256 answer_, uint256 skewSeconds_) {
        answer = answer_;
        skewSeconds = skewSeconds_;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function description() external pure returns (string memory) {
        return "Covenant proof instrument: future-dated answer";
    }

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer_, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint256 future = block.timestamp + skewSeconds;
        return (1, answer, future, future, 1);
    }
}
