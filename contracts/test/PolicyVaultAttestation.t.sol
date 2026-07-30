// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {PolicyVault} from "../src/PolicyVault.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Attestation condition (Phase 2). See docs/specs/PHASE2_CONDITION_TYPES.md.
contract PolicyVaultAttestationTest is Test {
    PolicyVault internal vault;
    MockUSDC internal usdc;

    address internal owner = makeAddr("owner");
    address internal executor = makeAddr("executor");
    address internal recipient = makeAddr("recipient");
    address internal stranger = makeAddr("stranger");

    address internal attester;
    uint256 internal attesterPk;
    address internal wrongSigner;
    uint256 internal wrongPk;

    uint256 internal constant ONE_USDC = 1e6;
    uint32 internal constant ARC_DOMAIN = 26;
    uint32 internal constant BASE_SEPOLIA_DOMAIN = 6;

    event Attested(uint256 indexed policyId, address indexed attester);

    function setUp() public {
        usdc = new MockUSDC();
        vault = new PolicyVault(address(usdc), executor, owner);

        (attester, attesterPk) = makeAddrAndKey("attester");
        (wrongSigner, wrongPk) = makeAddrAndKey("wrongSigner");

        usdc.mint(owner, 1_000 * ONE_USDC);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ---- helpers ----

    function _create(uint256 amount) internal returns (uint256 id) {
        vm.prank(owner);
        id = vault.createAttestationPolicy(
            recipient, amount, PolicyVault.PayoutCurrency.USDC, BASE_SEPOLIA_DOMAIN, attester
        );
    }

    function _fund(uint256 id, uint256 amount) internal {
        vm.prank(owner);
        vault.deposit(id, amount);
    }

    function _sign(uint256 pk, uint256 id) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.attestationDigest(id));
        return abi.encodePacked(r, s, v);
    }

    // ---- happy path ----

    function test_Attestation_ReleasesAfterValidAttestation() public {
        uint256 id = _create(ONE_USDC);
        _fund(id, ONE_USDC);

        assertFalse(vault.checkCondition(id), "not releasable before attestation");

        vm.expectEmit(true, true, false, true);
        emit Attested(id, attester);
        vault.attest(id, _sign(attesterPk, id));

        assertTrue(vault.checkCondition(id), "releasable after attestation");
        assertEq(uint8(vault.statusOf(id)), uint8(PolicyVault.Status.Releasable));

        vault.release(id);

        assertEq(usdc.balanceOf(executor), ONE_USDC, "funds released to executor");
        assertEq(uint8(vault.getPolicy(id).status), uint8(PolicyVault.Status.Executed));
        assertTrue(vault.getPolicy(id).attested);
    }

    function test_Attestation_SubmissionIsPermissionless() public {
        uint256 id = _create(ONE_USDC);
        _fund(id, ONE_USDC);

        // A stranger carries the attester's signature onchain. Only the signature matters.
        bytes memory sig = _sign(attesterPk, id);
        vm.prank(stranger);
        vault.attest(id, sig);

        assertTrue(vault.checkCondition(id));
    }

    function test_Attestation_EurcOnArcAllowed() public {
        vm.prank(owner);
        uint256 id = vault.createAttestationPolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.EURC, ARC_DOMAIN, attester
        );
        assertEq(uint8(vault.getPolicy(id).conditionType), uint8(PolicyVault.ConditionType.Attestation));
    }

    // ---- release gating ----

    function test_RevertWhen_ReleaseBeforeAttestation() public {
        uint256 id = _create(ONE_USDC);
        _fund(id, ONE_USDC);

        vm.expectRevert(abi.encodeWithSelector(PolicyVault.ConditionNotMet.selector, id));
        vault.release(id);
    }

    // ---- signature validation ----

    function test_RevertWhen_AttestWithWrongSigner() public {
        uint256 id = _create(ONE_USDC);
        // Sign before expectRevert: _sign reads attestationDigest from the vault, and that read
        // must not fall inside the expectRevert window.
        bytes memory sig = _sign(wrongPk, id);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.InvalidAttestationSignature.selector, id));
        vault.attest(id, sig);
    }

    function test_RevertWhen_AttestMalformedSignature() public {
        uint256 id = _create(ONE_USDC);
        // Wrong length: OZ ECDSA rejects before any signer comparison.
        vm.expectRevert();
        vault.attest(id, hex"1234");
    }

    function test_SignatureForOnePolicyDoesNotReleaseAnother() public {
        uint256 id0 = _create(ONE_USDC);
        uint256 id1 = _create(ONE_USDC);

        // A valid attester signature for policy 0, replayed against policy 1, does not verify:
        // the digest binds the policyId.
        bytes memory sigFor0 = _sign(attesterPk, id0);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.InvalidAttestationSignature.selector, id1));
        vault.attest(id1, sigFor0);
    }

    // ---- replay and lifecycle ----

    function test_RevertWhen_AttestReplay() public {
        uint256 id = _create(ONE_USDC);
        vault.attest(id, _sign(attesterPk, id));

        bytes memory sig = _sign(attesterPk, id);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.AlreadyAttested.selector, id));
        vault.attest(id, sig);
    }

    function test_RevertWhen_AttestAfterExecuted() public {
        uint256 id = _create(ONE_USDC);
        _fund(id, ONE_USDC);
        vault.attest(id, _sign(attesterPk, id));
        vault.release(id);

        bytes memory sig = _sign(attesterPk, id);
        vm.expectRevert(
            abi.encodeWithSelector(PolicyVault.PolicyNotPending.selector, id, PolicyVault.Status.Executed)
        );
        vault.attest(id, sig);
    }

    function test_RevertWhen_AttestUnknownPolicy() public {
        bytes memory sig = _sign(attesterPk, 99);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.UnknownPolicy.selector, 99));
        vault.attest(99, sig);
    }

    function test_RevertWhen_AttestWrongConditionType() public {
        // A timelock policy cannot be satisfied by an attestation.
        vm.prank(owner);
        uint256 id = vault.createPolicy(
            recipient,
            ONE_USDC,
            PolicyVault.PayoutCurrency.USDC,
            BASE_SEPOLIA_DOMAIN,
            PolicyVault.ConditionType.Timelock,
            uint64(block.timestamp + 1 days),
            new address[](0),
            0
        );

        bytes memory sig = _sign(attesterPk, id);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyVault.WrongConditionType.selector,
                id,
                PolicyVault.ConditionType.Attestation,
                PolicyVault.ConditionType.Timelock
            )
        );
        vault.attest(id, sig);
    }

    // ---- creation guards ----

    function test_RevertWhen_OldCreatePolicyRejectsAttestationType() public {
        vm.prank(owner);
        vm.expectRevert(PolicyVault.UseCreateAttestationPolicy.selector);
        vault.createPolicy(
            recipient,
            ONE_USDC,
            PolicyVault.PayoutCurrency.USDC,
            BASE_SEPOLIA_DOMAIN,
            PolicyVault.ConditionType.Attestation,
            0,
            new address[](0),
            0
        );
    }

    function test_RevertWhen_CreateAttestationZeroAttester() public {
        vm.prank(owner);
        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        vault.createAttestationPolicy(recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, address(0));
    }

    function test_RevertWhen_CreateAttestationZeroRecipient() public {
        vm.prank(owner);
        vm.expectRevert(PolicyVault.ZeroAddress.selector);
        vault.createAttestationPolicy(address(0), ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, attester);
    }

    function test_RevertWhen_CreateAttestationZeroAmount() public {
        vm.prank(owner);
        vm.expectRevert(PolicyVault.ZeroAmount.selector);
        vault.createAttestationPolicy(recipient, 0, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, attester);
    }

    function test_RevertWhen_CreateAttestationEurcCrossChain() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                PolicyVault.UnsupportedRoute.selector, PolicyVault.PayoutCurrency.EURC, BASE_SEPOLIA_DOMAIN
            )
        );
        vault.createAttestationPolicy(
            recipient, ONE_USDC, PolicyVault.PayoutCurrency.EURC, BASE_SEPOLIA_DOMAIN, attester
        );
    }

    function test_RevertWhen_CreateAttestationNotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vault.createAttestationPolicy(recipient, ONE_USDC, PolicyVault.PayoutCurrency.USDC, ARC_DOMAIN, attester);
    }

    // ---- fuzz ----

    function testFuzz_OnlyTheNamedAttesterCanSatisfy(uint256 pk) public {
        // Any signer other than the named attester must be rejected. Bound to valid secp256k1 keys.
        pk = bound(pk, 1, 115792089237316195423570985008687907852837564279074904382605163141518161494336);
        vm.assume(vm.addr(pk) != attester);

        uint256 id = _create(ONE_USDC);
        bytes memory sig = _sign(pk, id);
        vm.expectRevert(abi.encodeWithSelector(PolicyVault.InvalidAttestationSignature.selector, id));
        vault.attest(id, sig);
    }
}
