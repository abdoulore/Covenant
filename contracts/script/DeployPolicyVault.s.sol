// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PolicyVault} from "../src/PolicyVault.sol";

/**
 * Deploy PolicyVault to Arc testnet.
 *
 *   forge script script/DeployPolicyVault.s.sol \
 *     --rpc-url $ARC_TESTNET_RPC_URL --broadcast
 *
 * This is how PolicyVault was deployed to Arc testnet. See docs/DECISIONS.md D3: an earlier plan
 * to deploy through Circle's Smart Contract Platform was dropped, and the direct Foundry broadcast
 * is the actual and documented path.
 */
contract DeployPolicyVault is Script {
    /// @notice Entry point. Reads configuration from the environment, then delegates.
    function run() external returns (PolicyVault vault) {
        return deploy(
            vm.envAddress("ARC_USDC_ADDRESS"),
            vm.envAddress("EXECUTOR_WALLET_ADDRESS"),
            vm.envAddress("TREASURY_WALLET_ADDRESS"),
            vm.envUint("DEPLOYER_PRIVATE_KEY")
        );
    }

    /**
     * @notice Validate and deploy from explicit arguments.
     * @dev Kept separate from run() so tests can exercise it without touching the environment.
     *      vm.setEnv mutates one process-wide environment while Foundry runs tests in a suite in
     *      parallel, so per-test env configuration races and produces order-dependent results.
     *      Parameters are the fix, not more careful env handling.
     */
    function deploy(address usdc, address executor, address owner, uint256 deployerKey)
        public
        returns (PolicyVault vault)
    {
        validate(usdc, executor, owner);

        vm.startBroadcast(deployerKey);
        vault = new PolicyVault(usdc, executor, owner);
        vm.stopBroadcast();

        console.log("PolicyVault deployed:", address(vault));
        console.log("  usdc     ", usdc);
        console.log("  executor ", executor);
        console.log("  owner    ", owner);
        console.log("Record the address in .env as POLICY_VAULT_ADDRESS and in docs/RESULTS.md.");
    }

    /// @notice Every precondition that must hold before a deploy is worth broadcasting.
    function validate(address usdc, address executor, address owner) public view {
        _assertUsdcIsTheSixDecimalView(usdc);

        require(executor != address(0), "EXECUTOR_WALLET_ADDRESS unset");
        require(owner != address(0), "TREASURY_WALLET_ADDRESS unset");
        require(executor != owner, "executor and owner must differ, the custody boundary needs two parties");
    }

    /**
     * Guard against the single most costly mistake available on Arc.
     *
     * Arc exposes USDC as an 18 decimal native view for gas and a 6 decimal ERC-20 view for
     * balances. Deploying against anything reporting other than 6 decimals means every policy
     * amount is wrong by a factor of 10^12. Failing here costs a re-run. Not failing here costs
     * a settlement. See docs/VERIFICATIONS.md V1a.
     */
    function _assertUsdcIsTheSixDecimalView(address usdc) private view {
        require(usdc != address(0), "ARC_USDC_ADDRESS unset");
        require(usdc.code.length > 0, "ARC_USDC_ADDRESS has no code, wrong network?");

        uint8 decimals = IERC20Metadata(usdc).decimals();
        require(decimals == 6, "USDC decimals is not 6, this is the native view, not the ERC-20 view");
    }
}
