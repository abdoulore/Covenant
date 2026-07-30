// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Configurable Chainlink AggregatorV3 stand-in for oracle-condition tests.
/// @dev Only latestRoundData is exercised by PolicyVault. Every field is settable so a test can
///      reproduce fresh data, stale data, a zero or negative answer, an incomplete round, or a
///      reverting feed.
contract MockAggregator {
    uint80 public roundId = 1;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public answeredInRound = 1;
    bool public reverting;

    /// @notice Set the answer and mark it fresh as of now.
    function setAnswer(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
    }

    /// @notice Set the answer and an explicit updatedAt, for staleness tests.
    function setAnswerAt(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
    }

    /// @notice Force an incomplete round: answeredInRound < roundId.
    function setIncompleteRound() external {
        roundId = 5;
        answeredInRound = 4;
    }

    function setReverting(bool r) external {
        reverting = r;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        if (reverting) revert("feed down");
        return (roundId, answer, 0, updatedAt, answeredInRound);
    }
}
