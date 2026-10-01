// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {DeployPolicyVaultV5} from "../script/DeployPolicyVaultV5.s.sol";
import {PolicyVaultV5} from "../src/PolicyVaultV5.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockTokenMessengerV2} from "./mocks/MockTokenMessengerV2.sol";

contract NativeViewUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 18;
    }
}

/// @notice The checks that run before a v5 deploy is broadcast.
contract DeployPolicyVaultV5Test is Test {
    DeployPolicyVaultV5 internal script;
    MockUSDC internal usdc;
    MockTokenMessengerV2 internal messenger;
    address internal guardianWallet = makeAddr("guardian");
    uint256 internal constant KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function setUp() public {
        script = new DeployPolicyVaultV5();
        usdc = new MockUSDC();
        messenger = new MockTokenMessengerV2();
        messenger.setRemote(6, bytes32(uint256(1)));
    }

    function _base() internal pure returns (uint32[] memory d) {
        d = new uint32[](1);
        d[0] = 6;
    }

    function test_deploysWithTheGivenSettings() public {
        PolicyVaultV5 vault = script.deploy(address(usdc), address(messenger), _base(), guardianWallet, 1_000e6, KEY);
        assertEq(address(vault.usdc()), address(usdc));
        assertEq(address(vault.tokenMessenger()), address(messenger));
        assertTrue(vault.isDestination(6));
        assertEq(vault.guardian(), guardianWallet);
        assertEq(vault.fundsCap(), 1_000e6);
    }

    function test_refusesTheNativeViewOfUsdc() public {
        NativeViewUSDC wrong = new NativeViewUSDC();
        vm.expectRevert("USDC decimals is not 6: this is the native view");
        script.validate(address(wrong), address(messenger), _base(), guardianWallet, 1_000e6);
    }

    /// @dev Testnet and mainnet CCTP contracts differ; the wrong one does not know the domain.
    function test_refusesADestinationTheMessengerDoesNotServe() public {
        uint32[] memory d = new uint32[](1);
        d[0] = 3;
        vm.expectRevert("a V5_DESTINATIONS domain is not served by this TokenMessenger");
        script.validate(address(usdc), address(messenger), d, guardianWallet, 1_000e6);
    }

    function test_refusesAZeroCap() public {
        vm.expectRevert("V5_FUNDS_CAP must be above zero, or nothing can ever be funded");
        script.validate(address(usdc), address(messenger), _base(), guardianWallet, 0);
    }

    function test_onMainnetRefusesAPlainWalletAsGuardian() public {
        vm.chainId(5042);
        vm.expectRevert("mainnet guardian must be a multisig contract");
        script.validate(address(usdc), address(messenger), _base(), guardianWallet, 1_000e6);

        // A contract passes, as a multisig would.
        script.validate(address(usdc), address(messenger), _base(), address(messenger), 1_000e6);
    }

    function test_onTestnetAPlainWalletMayStandIn() public {
        vm.chainId(5042002);
        script.validate(address(usdc), address(messenger), _base(), guardianWallet, 1_000e6);
    }

    function test_onMainnetReadsOnlyMainnetSettings() public {
        vm.chainId(5042);
        assertEq(script.setting("DEPLOYER_PRIVATE_KEY"), "MAINNET_DEPLOYER_PRIVATE_KEY");
        assertEq(script.setting("V5_GUARDIAN"), "MAINNET_V5_GUARDIAN");
        vm.chainId(5042002);
        assertEq(script.setting("DEPLOYER_PRIVATE_KEY"), "DEPLOYER_PRIVATE_KEY");
    }
}
