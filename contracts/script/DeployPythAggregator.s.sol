// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {PythAggregatorV3} from "../src/vendor/pyth/PythAggregatorV3.sol";

/**
 * Deploy a PythAggregatorV3 wrapper on Arc testnet.
 *
 *   forge script script/DeployPythAggregator.s.sol \
 *     --rpc-url $ARC_TESTNET_RPC_URL --broadcast
 *
 * PythAggregatorV3 is the official Pyth adapter (vendored under src/vendor/pyth). It exposes one
 * Pyth price feed through Chainlink's AggregatorV3Interface, so the existing PolicyVault Oracle
 * condition reads it with no vault change. This is Option 1 of docs/specs/PHASE2_ORACLE_PYTH_ADAPTER.md.
 *
 * Pyth is deployed on Arc testnet at 0x2880aB155794e7179c9eE2e38200202908C17B43 (VERIFICATIONS V21).
 * PYTH_FEED_ID is the Pyth price feed id, for example USDC/USD.
 */
contract DeployPythAggregator is Script {
    function run() external returns (PythAggregatorV3 wrapper) {
        return deploy(
            vm.envAddress("ARC_PYTH_ADDRESS"),
            vm.envBytes32("PYTH_FEED_ID"),
            vm.envUint("DEPLOYER_PRIVATE_KEY")
        );
    }

    /// @dev Split from run() so a test can exercise it without the environment, matching DeployPolicyVault.
    function deploy(address pyth, bytes32 feedId, uint256 deployerKey) public returns (PythAggregatorV3 wrapper) {
        require(pyth != address(0), "ARC_PYTH_ADDRESS unset");
        require(pyth.code.length > 0, "ARC_PYTH_ADDRESS has no code, wrong network?");
        require(feedId != bytes32(0), "PYTH_FEED_ID unset");

        vm.startBroadcast(deployerKey);
        wrapper = new PythAggregatorV3(pyth, feedId);
        vm.stopBroadcast();

        console.log("PythAggregatorV3 deployed:", address(wrapper));
        console.log("  pyth  ", pyth);
        console.log("  feedId:");
        console.logBytes32(feedId);
        console.log("Record the address in .env, then point an oracle policy's feed at it.");
    }
}
