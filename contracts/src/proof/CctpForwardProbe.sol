// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice CCTP v2 TokenMessenger, the one function v5 needs.
interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}

/// @title CctpForwardProbe
/// @notice A verification instrument for v5, not part of any vault. See docs/specs/V5_VAULT.md,
///         verifications 1 and 2.
/// @dev v5 has the vault pay cross-chain recipients itself: a contract, not a wallet, burns USDC
///      through CCTP and asks Circle's Forwarding Service to submit the mint, so the recipient needs
///      no gas on the destination chain. Circle documents the forwarding hook but says nothing on
///      whether the burner may be a contract. This does exactly what the vault will, so a real
///      transfer answers it: pull `payout + feeAllowance`, burn it all with `maxFee = feeAllowance`,
///      and check the recipient receives at least `payout`, the upfront-fee model the spec settled.
contract CctpForwardProbe {
    using SafeERC20 for IERC20;

    /// @dev Circle's reserved hook: the bytes "cctp-forward", hook version 0, payload length 0.
    bytes internal constant FORWARD_HOOK = hex"636374702d666f72776172640000000000000000000000000000000000000000";

    /// @dev Standard transfer. From Arc, Circle charges no protocol fee at either speed, and
    ///      Standard attestation is already fast because Arc finalizes deterministically.
    uint32 internal constant STANDARD = 2000;

    event Burned(address indexed recipient, uint32 destinationDomain, uint256 burned, uint256 maxFee);

    function burnForward(
        IERC20 usdc,
        ITokenMessengerV2 messenger,
        uint32 destinationDomain,
        address recipient,
        uint256 payout,
        uint256 feeAllowance
    ) external {
        uint256 burnAmount = payout + feeAllowance;
        usdc.safeTransferFrom(msg.sender, address(this), burnAmount);
        usdc.forceApprove(address(messenger), burnAmount);
        // destinationCaller must be zero: Circle's forwarder does not serve a restricted caller.
        messenger.depositForBurnWithHook(
            burnAmount,
            destinationDomain,
            bytes32(uint256(uint160(recipient))),
            address(usdc),
            bytes32(0),
            feeAllowance,
            STANDARD,
            FORWARD_HOOK
        );
        emit Burned(recipient, destinationDomain, burnAmount, feeAllowance);
    }
}
