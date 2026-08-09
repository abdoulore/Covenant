// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {PythAdapter} from "../src/PythAdapter.sol";
import {ConditionProbe} from "../src/proof/ConditionProbe.sol";
import {FutureDatedAggregator} from "../src/proof/FutureDatedAggregator.sol";

/**
 * Deploy the v4 companion contracts on Arc testnet.
 *
 *   forge script script/DeployV4.s.sol:DeployPythAdapter --rpc-url $ARC_TESTNET_RPC_URL --broadcast
 *   forge script script/DeployV4.s.sol:DeployProofInstruments --rpc-url $ARC_TESTNET_RPC_URL --broadcast
 *
 * PolicyVault v4 itself deploys with the existing DeployPolicyVault script; the vault constructor
 * is unchanged. These are the pieces v4 adds around it. See docs/specs/V4_VAULT.md.
 */

/// @notice Deploy the Pyth adapter that backs OraclePull policies.
contract DeployPythAdapter is Script {
    function run() external returns (PythAdapter adapter) {
        return deploy(vm.envAddress("ARC_PYTH_ADDRESS"), vm.envUint("DEPLOYER_PRIVATE_KEY"));
    }

    /// @dev Split from run() so a test can exercise it without the environment, matching the
    ///      existing deploy scripts.
    function deploy(address pyth, uint256 deployerKey) public returns (PythAdapter adapter) {
        require(pyth != address(0), "ARC_PYTH_ADDRESS unset");
        require(pyth.code.length > 0, "ARC_PYTH_ADDRESS has no code, wrong network?");

        vm.startBroadcast(deployerKey);
        adapter = new PythAdapter(pyth);
        vm.stopBroadcast();

        console.log("PythAdapter deployed:", address(adapter));
        console.log("  pyth", pyth);
        console.log("Record as ARC_PYTH_ADAPTER_ADDRESS in .env.");
    }
}

/**
 * @notice Deploy the instruments for the fail-closed proof (RESULTS row 8).
 *
 * @dev FutureDatedAggregator reports a valid price dated ahead of the block, which is the input the
 *      defective staleness check underflows on. ConditionProbe makes a view call observable as a
 *      transaction, because "returned false instead of reverting" needs a hash to be a claim rather
 *      than an assertion.
 *
 *      Both are deployed once and used against BOTH v3 and v4, which is what makes the resulting
 *      hashes a comparison rather than two unrelated runs.
 */
contract DeployProofInstruments is Script {
    /// @dev A healthy peg price at 8 decimals, so nothing except the timestamp is unusual.
    int256 internal constant HEALTHY_ANSWER = 1e8;
    /// @dev Small enough to be realistic clock skew, large enough not to be raced by block time.
    uint256 internal constant SKEW_SECONDS = 300;

    function run() external returns (FutureDatedAggregator feed, ConditionProbe probe) {
        return deploy(vm.envUint("DEPLOYER_PRIVATE_KEY"));
    }

    function deploy(uint256 deployerKey) public returns (FutureDatedAggregator feed, ConditionProbe probe) {
        vm.startBroadcast(deployerKey);
        feed = new FutureDatedAggregator(HEALTHY_ANSWER, SKEW_SECONDS);
        probe = new ConditionProbe();
        vm.stopBroadcast();

        console.log("FutureDatedAggregator deployed:", address(feed));
        console.log("  answer 1.00000000, dated", SKEW_SECONDS, "seconds ahead of each block");
        console.log("ConditionProbe deployed:", address(probe));
        console.log("Point an Oracle policy on BOTH v3 and v4 at the aggregator, then probe each.");
    }
}
