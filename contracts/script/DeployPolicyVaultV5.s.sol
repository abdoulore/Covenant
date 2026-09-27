// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PolicyVaultV5} from "../src/PolicyVaultV5.sol";
import {ITokenMessengerV2} from "../src/ITokenMessengerV2.sol";

/**
 * Deploy PolicyVaultV5.
 *
 *   forge script script/DeployPolicyVaultV5.s.sol --rpc-url $ARC_TESTNET_RPC_URL --broadcast
 *
 * Reads ARC_USDC_ADDRESS, ARC_CCTP_TOKEN_MESSENGER, V5_DESTINATIONS (comma separated CCTP domains,
 * EVM chains only), V5_GUARDIAN, V5_FUNDS_CAP (6 decimal base units), and DEPLOYER_PRIVATE_KEY.
 *
 * Every check below runs before anything is broadcast. The vault is immutable, so a wrong setting
 * is a redeploy on testnet and, on mainnet, a vault holding other people's money that cannot be
 * fixed.
 */
contract DeployPolicyVaultV5 is Script {
    /// @notice Arc mainnet's chain id (VERIFICATIONS V26).
    uint256 internal constant ARC_MAINNET = 5042;

    function run() external returns (PolicyVaultV5 vault) {
        uint256[] memory raw = vm.envUint("V5_DESTINATIONS", ",");
        uint32[] memory destinations = new uint32[](raw.length);
        for (uint256 i = 0; i < raw.length; ++i) {
            require(raw[i] <= type(uint32).max, "V5_DESTINATIONS holds a value that is not a CCTP domain");
            destinations[i] = uint32(raw[i]);
        }
        return deploy(
            vm.envAddress("ARC_USDC_ADDRESS"),
            vm.envAddress("ARC_CCTP_TOKEN_MESSENGER"),
            destinations,
            vm.envAddress("V5_GUARDIAN"),
            vm.envUint("V5_FUNDS_CAP"),
            vm.envUint("DEPLOYER_PRIVATE_KEY")
        );
    }

    /// @dev Explicit arguments, so tests can drive it without the process-wide environment.
    function deploy(
        address usdc,
        address messenger,
        uint32[] memory destinations,
        address guardian,
        uint256 fundsCap,
        uint256 deployerKey
    ) public returns (PolicyVaultV5 vault) {
        validate(usdc, messenger, destinations, guardian, fundsCap);

        vm.startBroadcast(deployerKey);
        vault = new PolicyVaultV5(usdc, messenger, destinations, guardian, fundsCap);
        vm.stopBroadcast();

        console.log("PolicyVaultV5 deployed:", address(vault));
        console.log("  chain id   ", block.chainid);
        console.log("  usdc       ", usdc);
        console.log("  messenger  ", messenger);
        console.log("  guardian   ", guardian);
        console.log("  funds cap  ", fundsCap);
        for (uint256 i = 0; i < destinations.length; ++i) console.log("  destination", destinations[i]);
        console.log("Record it in .env as POLICY_VAULT_V5_ADDRESS, with the deploy block.");
    }

    function validate(
        address usdc,
        address messenger,
        uint32[] memory destinations,
        address guardian,
        uint256 fundsCap
    ) public view {
        // The 18 decimal native view would make every amount wrong by 10^12 (V1a).
        require(usdc != address(0) && usdc.code.length > 0, "ARC_USDC_ADDRESS has no code, wrong network?");
        require(IERC20Metadata(usdc).decimals() == 6, "USDC decimals is not 6: this is the native view");

        require(fundsCap > 0, "V5_FUNDS_CAP must be above zero, or nothing can ever be funded");

        if (destinations.length > 0) {
            // Testnet and mainnet CCTP contracts differ (V26). A registry lookup against the wrong one
            // fails here, before the vault is created, not at a user's first release.
            require(messenger.code.length > 0, "ARC_CCTP_TOKEN_MESSENGER has no code, wrong network?");
            for (uint256 i = 0; i < destinations.length; ++i) {
                require(
                    ITokenMessengerV2(messenger).remoteTokenMessengers(destinations[i]) != bytes32(0),
                    "a V5_DESTINATIONS domain is not served by this TokenMessenger"
                );
            }
        }

        // On mainnet the guardian must be a contract, a multisig, never a single key. On testnet a
        // plain wallet stands in, disclosed as such. This is what stops the stand-in being carried
        // over to real money by accident.
        if (block.chainid == ARC_MAINNET) {
            require(guardian == address(0) || guardian.code.length > 0, "mainnet guardian must be a multisig contract");
        }
    }
}
