// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice The two calls PolicyVaultV5 makes on Circle's CCTP v2 TokenMessenger.
/// @dev Addresses differ between Arc testnet and mainnet; see VERIFICATIONS V26.
interface ITokenMessengerV2 {
    /// @notice Burn `amount` of `burnToken` from the caller for minting on `destinationDomain`.
    ///         With Circle's forwarding hook, Circle submits the destination mint and collects
    ///         the whole `maxFee` from the burned amount (VERIFICATIONS V24).
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

    /// @notice The TokenMessenger registered for a remote domain, or zero if CCTP does not serve it.
    function remoteTokenMessengers(uint32 domain) external view returns (bytes32);
}
