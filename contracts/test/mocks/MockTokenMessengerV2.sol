// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITokenMessengerV2} from "../../src/ITokenMessengerV2.sol";

/// @notice Stands in for Circle's TokenMessengerV2: takes the burn from the caller, as the real one
///         does, and records every argument so a test can check exactly what the vault asked for.
contract MockTokenMessengerV2 is ITokenMessengerV2 {
    struct Burn {
        address caller;
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        bytes hookData;
    }

    mapping(uint32 => bytes32) public remoteTokenMessengers;
    Burn[] internal _burns;

    function setRemote(uint32 domain, bytes32 messenger) external {
        remoteTokenMessengers[domain] = messenger;
    }

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        require(remoteTokenMessengers[destinationDomain] != bytes32(0), "unknown domain");
        require(maxFee < amount, "fee >= amount");
        IERC20(burnToken).transferFrom(msg.sender, address(this), amount);
        _burns.push(
            Burn(msg.sender, amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold, hookData)
        );
    }

    function burnCount() external view returns (uint256) {
        return _burns.length;
    }

    function lastBurn() external view returns (Burn memory) {
        return _burns[_burns.length - 1];
    }
}
