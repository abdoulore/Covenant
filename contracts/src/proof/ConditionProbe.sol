// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface ICheckCondition {
    function checkCondition(uint256 policyId) external view returns (bool);
}

/// @title ConditionProbe
/// @notice Calls checkCondition and emits the result, so a view can be proven onchain.
///
/// @dev `checkCondition` is a view, so calling it directly produces no transaction and no hash, and
///      "it returned false instead of reverting" is exactly the kind of claim that needs a hash. This
///      turns the read into a transaction: on a fixed vault the probe SUCCEEDS and emits met=false,
///      and on a vault with the underflow defect the probe itself reverts.
///
///      That difference is the proof. Both vaults produce a failed release either way, so the
///      release hashes alone would look identical; it is the probe that separates "read the feed and
///      declined" from "could not read the feed at all".
contract ConditionProbe {
    event Probed(address indexed vault, uint256 indexed policyId, bool met);

    /// @notice Read a policy's condition and record the answer in a log.
    /// @dev Not a view, deliberately: emitting is the point.
    function probe(address vault, uint256 policyId) external returns (bool met) {
        met = ICheckCondition(vault).checkCondition(policyId);
        emit Probed(vault, policyId, met);
    }
}
