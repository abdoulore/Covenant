// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PythStructs} from "../../src/vendor/pyth/PythStructs.sol";

/// @notice Minimal Pyth stand-in for PythAdapter tests.
/// @dev Deliberately does NOT inherit IPyth: only two of that interface's many functions are ever
///      called, and dispatch is by selector, so implementing the rest would be noise. It records the
///      publish-time window it was handed, which is how the tests assert that the adapter asks Pyth
///      to reject a future-dated update rather than checking the timestamp itself.
contract MockPyth {
    int64 public price = 1e8;
    uint64 public conf;
    int32 public expo = -8;
    uint256 public publishTime = 1;
    uint256 public updateFee;

    /// @notice Set to simulate Pyth refusing an update outside the requested window.
    bool public outOfWindow;

    uint64 public lastMinPublishTime;
    uint64 public lastMaxPublishTime;
    uint256 public lastValueReceived;

    error PriceFeedNotFoundWithinRange();

    function setPrice(int64 price_, uint64 conf_, int32 expo_) external {
        price = price_;
        conf = conf_;
        expo = expo_;
    }

    function setPublishTime(uint256 t) external {
        publishTime = t;
    }

    function setUpdateFee(uint256 f) external {
        updateFee = f;
    }

    function setOutOfWindow(bool o) external {
        outOfWindow = o;
    }

    function getUpdateFee(bytes[] calldata) external view returns (uint256) {
        return updateFee;
    }

    function parsePriceFeedUpdates(
        bytes[] calldata,
        bytes32[] calldata priceIds,
        uint64 minPublishTime,
        uint64 maxPublishTime
    ) external payable returns (PythStructs.PriceFeed[] memory feeds) {
        lastMinPublishTime = minPublishTime;
        lastMaxPublishTime = maxPublishTime;
        lastValueReceived = msg.value;

        // What the real contract does when nothing in the blob falls inside the window. This is the
        // path that makes a stale or future-dated proof fail closed without the adapter doing math.
        if (outOfWindow) revert PriceFeedNotFoundWithinRange();

        feeds = new PythStructs.PriceFeed[](1);
        feeds[0] = PythStructs.PriceFeed({
            id: priceIds[0],
            price: PythStructs.Price({price: price, conf: conf, expo: expo, publishTime: publishTime}),
            emaPrice: PythStructs.Price({price: price, conf: conf, expo: expo, publishTime: publishTime})
        });
    }
}
