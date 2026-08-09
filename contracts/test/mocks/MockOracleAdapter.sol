// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOracleAdapter} from "../../src/IOracleAdapter.sol";

/// @notice Configurable IOracleAdapter stand-in for OraclePull tests.
/// @dev Lets a test set the returned price, confidence, and fee, and force the reverting case that a
///      real adapter produces for an unverifiable, stale, or future-dated proof. It records the value
///      it was paid so a test can assert the vault forwarded exactly the quoted fee and no more.
contract MockOracleAdapter is IOracleAdapter {
    int256 public value1e18 = 1e18;
    uint256 public conf1e18;
    uint256 public publishTime = 1;
    uint256 public fee;

    bool public reverting;
    string public revertReason = "adapter: proof rejected";

    /// @notice Value actually received by the last verifyAndRead call.
    uint256 public lastPaid;
    /// @notice Arguments the vault passed through, so a test can assert they were not mangled.
    bytes32 public lastFeedId;
    uint64 public lastMaxStale;
    bytes public lastProof;

    function setPrice(int256 value_, uint256 conf_) external {
        value1e18 = value_;
        conf1e18 = conf_;
    }

    function setFee(uint256 fee_) external {
        fee = fee_;
    }

    function setReverting(bool r) external {
        reverting = r;
    }

    function quoteFee(bytes calldata) external view returns (uint256) {
        return fee;
    }

    function verifyAndRead(bytes32 feedId, bytes calldata proof, uint64 maxStaleSeconds)
        external
        payable
        returns (int256, uint256, uint256)
    {
        if (reverting) revert(revertReason);
        lastPaid = msg.value;
        lastFeedId = feedId;
        lastMaxStale = maxStaleSeconds;
        lastProof = proof;
        return (value1e18, conf1e18, publishTime);
    }
}
