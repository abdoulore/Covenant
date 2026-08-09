// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IOracleAdapter
/// @notice The seam between PolicyVault and a pull oracle.
///
/// @dev Adding an oracle should be a deployment, not a vault redeploy. The vault holds an adapter
///      address per policy and knows nothing about Wormhole, Pyth, or any other verification scheme;
///      the adapter verifies a proof and hands back a number. A second oracle is then a new adapter
///      contract, and the immutable vault never moves.
///
///      Values are normalized to 1e18 by the adapter, not by the vault. The alternative, returning a
///      raw value plus an exponent and binding the exponent per policy, pushes scale handling into
///      the vault for every oracle that is ever added. One representation crossing this boundary
///      means the vault compares a single int256 threshold no matter what is behind it.
///      See docs/specs/PHASE2_ORACLE_PYTH_ADAPTER.md.
interface IOracleAdapter {
    /// @notice Verify `proof` for `feedId`, enforce freshness, and return the price.
    /// @dev MUST revert rather than return a doubtful value: the vault treats a successful return as
    ///      a verified, in-window price. Implementations must reject a proof that fails verification,
    ///      is older than `maxStaleSeconds`, or is dated in the future.
    /// @param feedId The oracle's identifier for the feed.
    /// @param proof The signed update blob, opaque to the vault.
    /// @param maxStaleSeconds Oldest acceptable publish time, relative to now.
    /// @return value1e18 The price, normalized to 18 decimals.
    /// @return conf1e18 The confidence interval around the price, in the same scale.
    /// @return publishTime The oracle's publish timestamp for the returned price.
    function verifyAndRead(bytes32 feedId, bytes calldata proof, uint64 maxStaleSeconds)
        external
        payable
        returns (int256 value1e18, uint256 conf1e18, uint256 publishTime);

    /// @notice The fee `verifyAndRead` requires, in the chain's native token.
    /// @dev On Arc the native token is USDC, so this is a gas-like cost priced in dollars. It is not
    ///      a credential, so paying it does not compromise the permissionless property.
    function quoteFee(bytes calldata proof) external view returns (uint256);
}
