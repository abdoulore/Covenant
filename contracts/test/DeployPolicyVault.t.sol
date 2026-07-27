// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DeployPolicyVault} from "../script/DeployPolicyVault.s.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Stands in for the 18 decimal native view of USDC on Arc, the wrong thing to deploy against.
contract MockNativeUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }
}

/**
 * These tests call deploy() and validate() with explicit arguments rather than driving run()
 * through the environment. vm.setEnv writes to a single process-wide environment while Foundry
 * executes tests in a suite in parallel, so env-driven test setup races and fails by ordering.
 */
contract DeployPolicyVaultTest is Test {
    DeployPolicyVault internal deployScript;
    MockUSDC internal usdcSixDecimals;
    MockNativeUSDC internal usdcNativeView;

    /// @dev Anvil's first default key. Any valid key works; nothing is broadcast in tests.
    uint256 internal constant DEPLOYER_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    address internal owner = makeAddr("owner");
    address internal executor = makeAddr("executor");

    function setUp() public {
        deployScript = new DeployPolicyVault();
        usdcSixDecimals = new MockUSDC();
        usdcNativeView = new MockNativeUSDC();
    }

    function test_DeploysAgainstTheSixDecimalErc20View() public {
        PolicyVault vault = deployScript.deploy(address(usdcSixDecimals), executor, owner, DEPLOYER_KEY);

        assertEq(address(vault.usdc()), address(usdcSixDecimals));
        assertEq(vault.executor(), executor);
        assertEq(vault.owner(), owner);
        assertEq(vault.nextPolicyId(), 0);
    }

    /// @dev The 10^12 mistake. Catching it at deploy costs a re-run; missing it costs a settlement.
    function test_RevertWhen_PointedAtTheNativeEighteenDecimalView() public {
        vm.expectRevert("USDC decimals is not 6, this is the native view, not the ERC-20 view");
        deployScript.validate(address(usdcNativeView), executor, owner);
    }

    function test_RevertWhen_UsdcAddressHasNoCode() public {
        vm.expectRevert("ARC_USDC_ADDRESS has no code, wrong network?");
        deployScript.validate(makeAddr("notAContract"), executor, owner);
    }

    function test_RevertWhen_UsdcUnset() public {
        vm.expectRevert("ARC_USDC_ADDRESS unset");
        deployScript.validate(address(0), executor, owner);
    }

    /// @dev The custody boundary in DECISIONS.md D2 is meaningless if both roles are one address.
    function test_RevertWhen_ExecutorEqualsOwner() public {
        vm.expectRevert("executor and owner must differ, the custody boundary needs two parties");
        deployScript.validate(address(usdcSixDecimals), owner, owner);
    }

    function test_RevertWhen_ExecutorUnset() public {
        vm.expectRevert("EXECUTOR_WALLET_ADDRESS unset");
        deployScript.validate(address(usdcSixDecimals), address(0), owner);
    }

    function test_RevertWhen_OwnerUnset() public {
        vm.expectRevert("TREASURY_WALLET_ADDRESS unset");
        deployScript.validate(address(usdcSixDecimals), executor, address(0));
    }

    function test_ValidConfigurationPasses() public view {
        deployScript.validate(address(usdcSixDecimals), executor, owner);
    }
}
