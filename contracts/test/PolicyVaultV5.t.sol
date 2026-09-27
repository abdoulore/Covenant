// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PolicyVaultV5} from "../src/PolicyVaultV5.sol";
import {MockUSDCPermit} from "./mocks/MockUSDCPermit.sol";
import {MockTokenMessengerV2} from "./mocks/MockTokenMessengerV2.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockOracleAdapter} from "./mocks/MockOracleAdapter.sol";

/// @notice PolicyVaultV5: every promise the spec makes, and every negative in its proof plan.
///         Every test that moves money ends by checking the vault holds exactly what it thinks.
contract PolicyVaultV5Test is Test {
    PolicyVaultV5 internal vault;
    MockUSDCPermit internal usdc;
    MockTokenMessengerV2 internal messenger;

    address internal owner = makeAddr("owner");
    address internal recipient = makeAddr("recipient");
    address internal stranger = makeAddr("stranger");
    address internal guardian = makeAddr("guardian");

    uint32 internal constant ARC = 26;
    uint32 internal constant BASE = 6;
    uint32 internal constant SOLANA = 5;
    uint256 internal constant CAP = 1_000_000e6;
    uint256 internal constant FEE = 60_000; // 0.06 USDC, about the Base forwarding fee (V25)

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDCPermit();
        messenger = new MockTokenMessengerV2();
        messenger.setRemote(BASE, bytes32(uint256(0xba5e)));
        // Registered with CCTP but not an EVM chain, so deliberately not listed.
        messenger.setRemote(SOLANA, bytes32(uint256(0x5017)));
        vault = _deploy(CAP);
        usdc.mint(owner, 1_000e6);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _deploy(uint256 cap) internal returns (PolicyVaultV5) {
        uint32[] memory dests = new uint32[](1);
        dests[0] = BASE;
        return new PolicyVaultV5(address(usdc), address(messenger), dests, guardian, cap);
    }

    function _terms(uint256 amount) internal view returns (PolicyVaultV5.Terms memory) {
        return PolicyVaultV5.Terms(recipient, amount, ARC, uint64(block.timestamp + 30 days), 0);
    }

    function _xterms(uint256 amount, uint256 fee) internal view returns (PolicyVaultV5.Terms memory) {
        return PolicyVaultV5.Terms(recipient, amount, BASE, uint64(block.timestamp + 30 days), fee);
    }

    function _timelock(PolicyVaultV5.Terms memory t) internal returns (uint256 id, uint64 releaseTime) {
        releaseTime = uint64(block.timestamp + 1 days);
        vm.prank(owner);
        id = vault.createTimelockPolicy(t, releaseTime);
    }

    function _held() internal view {
        assertEq(usdc.balanceOf(address(vault)), vault.totalHeld(), "vault holds exactly what it accounts for");
    }

    function _status(uint256 id) internal view returns (PolicyVaultV5.Status) {
        return vault.getPolicy(id).status;
    }

    // ---------------------------------------------------------------------
    // Creation: anyone, their own money, all at once
    // ---------------------------------------------------------------------

    function test_anyoneCreatesAPolicyAndOwnsIt() public {
        usdc.mint(stranger, 50e6);
        vm.startPrank(stranger);
        usdc.approve(address(vault), 50e6);
        uint256 id = vault.createTimelockPolicy(_terms(50e6), uint64(block.timestamp + 1 days));
        vm.stopPrank();

        assertEq(vault.getPolicy(id).owner, stranger);
        assertEq(usdc.balanceOf(stranger), 0, "funded from the creator's own wallet");
        _held();
    }

    function test_aOneOffPolicyIsFundedInFullAtCreation() public {
        (uint256 id,) = _timelock(_terms(100e6));
        PolicyVaultV5.Policy memory p = vault.getPolicy(id);
        assertEq(p.funded, 100e6);
        assertEq(p.amount, 100e6);
        assertEq(usdc.balanceOf(owner), 900e6);
        _held();
    }

    function test_creatingWithoutTheMoneyCreatesNothing() public {
        vm.prank(stranger); // no balance, no approval
        vm.expectRevert();
        vault.createTimelockPolicy(_terms(100e6), uint64(block.timestamp + 1 days));
        assertEq(vault.nextPolicyId(), 0);
    }

    function test_crossChainPullsThePayoutPlusTheFee() public {
        (uint256 id,) = _timelock(_xterms(100e6, FEE));
        PolicyVaultV5.Policy memory p = vault.getPolicy(id);
        assertEq(p.funded, 100e6);
        assertEq(p.feeAllowance, FEE);
        assertEq(usdc.balanceOf(owner), 1_000e6 - 100e6 - FEE);
        _held();
    }

    function test_rejectsAFeeOnArcAndRequiresOneCrossChain() public {
        PolicyVaultV5.Terms memory t = _terms(10e6);
        t.maxFeePerTransfer = 1;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.InvalidFee.selector, ARC, 1));
        vault.createTimelockPolicy(t, uint64(block.timestamp + 1 days));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.InvalidFee.selector, BASE, 0));
        vault.createTimelockPolicy(_xterms(10e6, 0), uint64(block.timestamp + 1 days));
    }

    /// @dev Solana is served by CCTP, but a recipient here is an EVM address: minting there would
    ///      reach an account nobody controls. Only listed destinations are accepted.
    function test_rejectsADestinationThatIsNotListed() public {
        PolicyVaultV5.Terms memory t = _xterms(10e6, FEE);
        t.destinationDomain = SOLANA;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.UnsupportedDestination.selector, SOLANA));
        vault.createTimelockPolicy(t, uint64(block.timestamp + 1 days));
    }

    function test_rejectsAListedDestinationCctpDoesNotServe() public {
        uint32[] memory dests = new uint32[](1);
        dests[0] = 3; // listed, but not registered on the messenger
        PolicyVaultV5 v = new PolicyVaultV5(address(usdc), address(messenger), dests, guardian, CAP);
        PolicyVaultV5.Terms memory t = _xterms(10e6, FEE);
        t.destinationDomain = 3;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.UnsupportedDestination.selector, uint32(3)));
        v.createTimelockPolicy(t, uint64(block.timestamp + 1 days));
    }

    function test_anArcOnlyDeploymentRefusesCrossChain() public {
        PolicyVaultV5 v = new PolicyVaultV5(address(usdc), address(0), new uint32[](0), guardian, CAP);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.UnsupportedDestination.selector, BASE));
        v.createTimelockPolicy(_xterms(10e6, FEE), uint64(block.timestamp + 1 days));
    }

    function test_constructorRefusesDestinationsWithoutAMessengerOrArcAsADestination() public {
        uint32[] memory dests = new uint32[](1);
        dests[0] = BASE;
        vm.expectRevert(PolicyVaultV5.ZeroAddress.selector);
        new PolicyVaultV5(address(usdc), address(0), dests, guardian, CAP);
        dests[0] = ARC;
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.UnsupportedDestination.selector, ARC));
        new PolicyVaultV5(address(usdc), address(messenger), dests, guardian, CAP);
    }

    function test_deadlineMustLeaveTheMinimumWindow() public {
        PolicyVaultV5.Terms memory t = _terms(10e6);
        t.deadline = uint64(block.timestamp + 7 days - 1);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.DeadlineTooSoon.selector, t.deadline, block.timestamp + 7 days));
        vault.createAttestationPolicy(t, makeAddr("attester"));

        // A timelock's window runs from its release time, not from now.
        t.deadline = uint64(block.timestamp + 8 days);
        uint64 releaseTime = uint64(block.timestamp + 2 days);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.DeadlineTooSoon.selector, t.deadline, uint256(releaseTime) + 7 days));
        vault.createTimelockPolicy(t, releaseTime);
    }

    function test_rejectsTheVaultOrNobodyAsRecipient() public {
        PolicyVaultV5.Terms memory t = _terms(10e6);
        t.recipient = address(vault);
        vm.prank(owner);
        vm.expectRevert(PolicyVaultV5.ZeroAddress.selector);
        vault.createTimelockPolicy(t, uint64(block.timestamp + 1 days));
        t.recipient = address(0);
        vm.prank(owner);
        vm.expectRevert(PolicyVaultV5.ZeroAddress.selector);
        vault.createTimelockPolicy(t, uint64(block.timestamp + 1 days));
    }

    // ---------------------------------------------------------------------
    // Release: the vault pays the recipient itself
    // ---------------------------------------------------------------------

    function test_timelockPaysTheRecipientDirectlyWhoeverReleases() public {
        (uint256 id, uint64 releaseTime) = _timelock(_terms(100e6));
        vm.warp(releaseTime);

        vm.expectEmit(address(vault));
        emit PolicyVaultV5.PolicyReleased(id, recipient, 100e6, ARC, 0, 0);
        vm.prank(stranger);
        vault.release(id);

        assertEq(usdc.balanceOf(recipient), 100e6);
        assertEq(uint256(_status(id)), uint256(PolicyVaultV5.Status.Executed));
        assertEq(usdc.balanceOf(address(vault)), 0);
        _held();
    }

    function test_releaseBeforeTheConditionReverts() public {
        (uint256 id,) = _timelock(_terms(100e6));
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.ConditionNotMet.selector, id));
        vault.release(id);
    }

    function test_approvalPaysOnceTheThresholdIsReached() public {
        address[] memory approvers = new address[](2);
        approvers[0] = makeAddr("a1");
        approvers[1] = makeAddr("a2");
        vm.prank(owner);
        uint256 id = vault.createApprovalPolicy(_terms(40e6), approvers, 2);

        vm.prank(approvers[0]);
        vault.approve(id);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.ConditionNotMet.selector, id));
        vault.release(id);

        vm.prank(approvers[1]);
        vault.approve(id);
        vault.release(id);
        assertEq(usdc.balanceOf(recipient), 40e6);
        _held();
    }

    function test_attestationPaysOnTheAttestersSignature() public {
        (address attester, uint256 pk) = makeAddrAndKey("attester");
        vm.prank(owner);
        uint256 id = vault.createAttestationPolicy(_terms(25e6), attester);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.attestationDigest(id));
        vm.prank(stranger); // anyone may carry the signature
        vault.attest(id, abi.encodePacked(r, s, v));
        vault.release(id);
        assertEq(usdc.balanceOf(recipient), 25e6);
        _held();
    }

    function test_chainlinkOraclePaysWhileTheFeedMeetsTheRule() public {
        MockAggregator feed = new MockAggregator();
        feed.setAnswer(0.97e8);
        vm.prank(owner);
        uint256 id = vault.createOraclePolicy(_terms(30e6), address(feed), PolicyVaultV5.Comparator.Lte, 0.98e8, 25 hours);
        vault.release(id);
        assertEq(usdc.balanceOf(recipient), 30e6);
        _held();
    }

    function test_pullOraclePaysOnAVerifiedPrice() public {
        MockOracleAdapter adapter = new MockOracleAdapter();
        adapter.setPrice(1e18, 0);
        vm.prank(owner);
        uint256 id = vault.createOraclePullPolicy(
            _terms(30e6), address(adapter), bytes32("USDC/USD"), PolicyVaultV5.Comparator.Gte, 0.995e18, 60, 50
        );
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.UseReleaseWithProof.selector, id));
        vault.release(id);
        vault.releaseWithProof(id, hex"01");
        assertEq(usdc.balanceOf(recipient), 30e6);
        _held();
    }

    function test_pullOracleRefusesAnUncertainPrice() public {
        MockOracleAdapter adapter = new MockOracleAdapter();
        adapter.setPrice(1e18, 0.01e18); // 100 bps of uncertainty against a 50 bps bound
        vm.prank(owner);
        uint256 id = vault.createOraclePullPolicy(
            _terms(30e6), address(adapter), bytes32("USDC/USD"), PolicyVaultV5.Comparator.Gte, 0.995e18, 60, 50
        );
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.ConfidenceTooWide.selector, id, 0.01e18, 1e18, uint16(50)));
        vault.releaseWithProof(id, hex"01");
    }

    function test_crossChainReleaseBurnsThroughCctpWithForwarding() public {
        (uint256 id, uint64 releaseTime) = _timelock(_xterms(100e6, FEE));
        vm.warp(releaseTime);
        vault.release(id);

        MockTokenMessengerV2.Burn memory b = messenger.lastBurn();
        assertEq(b.caller, address(vault), "the vault burns, no wallet in between");
        assertEq(b.amount, 100e6 + FEE, "payout plus fee, so the recipient receives the payout");
        assertEq(b.maxFee, FEE, "the fee the policy fixed, never the caller's");
        assertEq(b.destinationDomain, BASE);
        assertEq(b.mintRecipient, bytes32(uint256(uint160(recipient))));
        assertEq(b.burnToken, address(usdc));
        assertEq(b.destinationCaller, bytes32(0));
        assertEq(b.minFinalityThreshold, 2000);
        assertEq(b.hookData, vault.FORWARD_HOOK());
        assertEq(usdc.balanceOf(address(vault)), 0);
        _held();
    }

    // ---------------------------------------------------------------------
    // The owner's powers, and their limits
    // ---------------------------------------------------------------------

    function test_aStrangerCannotTouchSomeoneElsesPolicy() public {
        (uint256 id,) = _timelock(_xterms(10e6, FEE));
        vm.startPrank(stranger);
        bytes memory notOwner = abi.encodeWithSelector(PolicyVaultV5.NotPolicyOwner.selector, id, stranger);
        vm.expectRevert(notOwner);
        vault.cancel(id);
        vm.expectRevert(notOwner);
        vault.extendDeadline(id, uint64(block.timestamp + 90 days));
        vm.expectRevert(notOwner);
        vault.raiseMaxFee(id, FEE + 1);
        vm.expectRevert(notOwner);
        vault.reclaim(id);
        vm.stopPrank();
    }

    function test_theOwnerCancelsAnUnmetPolicyAndGetsEverythingBack() public {
        (uint256 id,) = _timelock(_xterms(100e6, FEE));
        vm.prank(owner);
        vault.cancel(id);
        assertEq(usdc.balanceOf(owner), 1_000e6, "payout and fee both returned");
        assertEq(uint256(_status(id)), uint256(PolicyVaultV5.Status.Cancelled));
        _held();
    }

    /// @dev The reason v5 exists as more than an ownership change: under v4 an owner could cancel
    ///      after the condition was met, as long as nobody had released yet.
    function test_theOwnerCannotCancelOnceATimelockHasPassed() public {
        (uint256 id, uint64 releaseTime) = _timelock(_terms(100e6));
        vm.warp(releaseTime);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.ConditionMet.selector, id));
        vault.cancel(id);
    }

    function test_theOwnerCannotCancelOnceApprovalsAreIn() public {
        address[] memory approvers = new address[](1);
        approvers[0] = makeAddr("a1");
        vm.prank(owner);
        uint256 id = vault.createApprovalPolicy(_terms(10e6), approvers, 1);
        vm.prank(approvers[0]);
        vault.approve(id);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.ConditionMet.selector, id));
        vault.cancel(id);
    }

    function test_theOwnerCannotCancelOnceAttested() public {
        (address attester, uint256 pk) = makeAddrAndKey("attester");
        vm.prank(owner);
        uint256 id = vault.createAttestationPolicy(_terms(10e6), attester);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, vault.attestationDigest(id));
        vault.attest(id, abi.encodePacked(r, s, v));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.ConditionMet.selector, id));
        vault.cancel(id);
    }

    function test_chainlinkCancelFollowsTheFeedIncludingAStaleOne() public {
        MockAggregator feed = new MockAggregator();
        feed.setAnswer(0.97e8);
        vm.prank(owner);
        uint256 id = vault.createOraclePolicy(_terms(10e6), address(feed), PolicyVaultV5.Comparator.Lte, 0.98e8, 25 hours);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.ConditionMet.selector, id));
        vault.cancel(id);

        // A stale feed fails closed for cancel exactly as it does for release.
        vm.warp(block.timestamp + 26 hours);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.ConditionNotMet.selector, id));
        vault.release(id);
        vm.prank(owner);
        vault.cancel(id);
        _held();
    }

    function test_pullOracleCancelNeedsAPriceThatCouldNotRelease() public {
        MockOracleAdapter adapter = new MockOracleAdapter();
        adapter.setPrice(1e18, 0);
        vm.prank(owner);
        uint256 id = vault.createOraclePullPolicy(
            _terms(10e6), address(adapter), bytes32("USDC/USD"), PolicyVaultV5.Comparator.Gte, 0.995e18, 60, 50
        );

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.UseCancelWithProof.selector, id));
        vault.cancel(id);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.ConditionMet.selector, id));
        vault.cancelWithProof(id, hex"01");

        adapter.setPrice(0.99e18, 0);
        vm.prank(owner);
        vault.cancelWithProof(id, hex"01");
        assertEq(uint256(_status(id)), uint256(PolicyVaultV5.Status.Cancelled));
        _held();
    }

    function test_releaseClosesAtTheDeadlineAndTheOwnerReclaims() public {
        (uint256 id,) = _timelock(_terms(100e6));
        uint64 deadline = vault.getPolicy(id).deadline;

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.BeforeDeadline.selector, id, uint256(deadline)));
        vault.reclaim(id);

        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.PastDeadline.selector, id, uint256(deadline)));
        vault.release(id);

        vm.prank(owner);
        vault.reclaim(id);
        assertEq(usdc.balanceOf(owner), 1_000e6);
        assertEq(usdc.balanceOf(recipient), 0);
        _held();
    }

    function test_theDeadlineOnlyMovesLater() public {
        (uint256 id,) = _timelock(_terms(10e6));
        uint64 deadline = vault.getPolicy(id).deadline;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.DeadlineNotLater.selector, deadline, deadline - 1));
        vault.extendDeadline(id, deadline - 1);

        vm.prank(owner);
        vault.extendDeadline(id, deadline + 10 days);
        vm.warp(deadline + 1 days);
        vault.release(id); // reopened by the extension
        assertEq(usdc.balanceOf(recipient), 10e6);
    }

    function test_raisingTheFeePullsTheDifferenceAndTheBurnUsesIt() public {
        (uint256 id, uint64 releaseTime) = _timelock(_xterms(100e6, FEE));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.FeeNotHigher.selector, FEE, FEE));
        vault.raiseMaxFee(id, FEE);

        vm.prank(owner);
        vault.raiseMaxFee(id, FEE + 20_000);
        assertEq(vault.getPolicy(id).feeAllowance, FEE + 20_000);
        _held();

        vm.warp(releaseTime);
        vault.release(id);
        assertEq(messenger.lastBurn().maxFee, FEE + 20_000);
        assertEq(messenger.lastBurn().amount, 100e6 + FEE + 20_000);
        _held();
    }

    function test_raisingTheFeeOnArcIsRefused() public {
        (uint256 id,) = _timelock(_terms(10e6));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.InvalidFee.selector, ARC, uint256(1)));
        vault.raiseMaxFee(id, 1);
    }

    // ---------------------------------------------------------------------
    // Pause: releases only, bounded, and never at a recipient's expense
    // ---------------------------------------------------------------------

    function test_onlyTheGuardianPauses() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.NotGuardian.selector, stranger));
        vault.pause();
    }

    function test_aPauseBlocksReleaseButNotCancellingAnUnmetPolicy() public {
        (uint256 metId, uint64 releaseTime) = _timelock(_terms(10e6));
        vm.warp(releaseTime);
        (uint256 unmetId,) = _timelock(_terms(10e6));

        vm.prank(guardian);
        vault.pause();
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.ReleasesPaused.selector, uint64(block.timestamp + 7 days)));
        vault.release(metId);

        vm.prank(owner);
        vault.cancel(unmetId);
        assertEq(uint256(_status(unmetId)), uint256(PolicyVaultV5.Status.Cancelled));
        _held();
    }

    /// @dev A pause must never turn a recipient's payment into an owner's refund.
    function test_timeSpentPausedExtendsEveryDeadline() public {
        (uint256 id, uint64 releaseTime) = _timelock(_terms(100e6));
        uint64 deadline = vault.getPolicy(id).deadline;
        vm.warp(releaseTime);

        vm.warp(deadline - 1 hours);
        vm.prank(guardian);
        vault.pause();
        vm.warp(uint256(deadline) + 2 days);
        assertEq(vault.effectiveDeadline(id), uint256(deadline) + 2 days + 1 hours);

        vm.prank(owner);
        vm.expectRevert();
        vault.reclaim(id); // not past the moved deadline

        vm.prank(guardian);
        vault.unpause();
        vault.release(id); // the recipient still has the hour the pause interrupted
        assertEq(usdc.balanceOf(recipient), 100e6);
        _held();
    }

    function test_pauseTimeBeforeAPolicyExistedDoesNotExtendIt() public {
        vm.prank(guardian);
        vault.pause();
        vm.warp(block.timestamp + 3 days);
        vm.prank(guardian);
        vault.unpause();
        (uint256 id,) = _timelock(_terms(10e6));
        assertEq(vault.effectiveDeadline(id), vault.getPolicy(id).deadline);
    }

    function test_aPauseEndsByItselfAndCannotBeRenewedAtOnce() public {
        (uint256 id, uint64 releaseTime) = _timelock(_terms(10e6));
        vm.warp(releaseTime);
        vm.prank(guardian);
        vault.pause();
        vm.warp(block.timestamp + 7 days);
        assertFalse(vault.paused());

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.PauseCoolingDown.selector, block.timestamp + 7 days));
        vault.pause();

        vault.release(id);
        vm.warp(block.timestamp + 7 days);
        vm.prank(guardian);
        vault.pause();
        assertTrue(vault.paused());
    }

    function test_guardianHandsOverInTwoStepsAndCanRenounce() public {
        address next = makeAddr("next");
        vm.prank(guardian);
        vault.proposeGuardian(next);
        assertEq(vault.guardian(), guardian);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.NotGuardian.selector, stranger));
        vault.acceptGuardian();
        vm.prank(next);
        vault.acceptGuardian();
        assertEq(vault.guardian(), next);

        vm.prank(next);
        vault.renounceGuardian();
        vm.prank(next);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.NotGuardian.selector, next));
        vault.pause();
    }

    // ---------------------------------------------------------------------
    // Cap: bounds new money, never touches existing money
    // ---------------------------------------------------------------------

    function test_theCapRefusesNewFundingOnly() public {
        vault = _deploy(100e6);
        vm.prank(owner);
        usdc.approve(address(vault), type(uint256).max);

        (uint256 id, uint64 releaseTime) = _timelock(_terms(80e6));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.OverCap.selector, 110e6, 100e6));
        vault.createTimelockPolicy(_terms(30e6), uint64(block.timestamp + 1 days));

        vm.warp(releaseTime);
        vault.release(id); // paying out is never capped
        (uint256 id2,) = _timelock(_terms(30e6));
        vm.prank(owner);
        vault.cancel(id2); // nor is refunding
        _held();
    }

    function test_theCapOnlyGoesUpAndOnlyTheGuardianMovesIt() public {
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.CapNotHigher.selector, CAP, CAP - 1));
        vault.raiseCap(CAP - 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.NotGuardian.selector, stranger));
        vault.raiseCap(CAP + 1);
        vm.prank(guardian);
        vault.raiseCap(type(uint256).max);
        assertEq(vault.fundsCap(), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Payroll and sweep
    // ---------------------------------------------------------------------

    function _payroll(uint32 periods, uint256 funding, PolicyVaultV5.Terms memory t, uint256 fees)
        internal
        returns (uint256 id, uint64 start)
    {
        start = uint64(block.timestamp + 1 days);
        t.deadline = uint64(block.timestamp + 60 days);
        vm.prank(owner);
        id = vault.createRecurringPolicy(t, 10e6, 1 days, start, periods, funding, fees);
    }

    function test_payrollPaysEveryOverduePeriodThereIsNoCatchUpGate() public {
        (uint256 id, uint64 start) = _payroll(0, 100e6, _terms(0), 0);
        vm.warp(uint256(start) + 2 days); // three periods due
        vault.releasePeriod(id);
        vault.releasePeriod(id);
        vault.releasePeriod(id);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.PeriodNotDue.selector, id, uint64(start + 3 days), block.timestamp));
        vault.releasePeriod(id);
        assertEq(usdc.balanceOf(recipient), 30e6);
        _held();
    }

    function test_aFixedPayrollFinishesAndReturnsWhatIsLeft() public {
        (uint256 id, uint64 start) = _payroll(3, 50e6, _terms(0), 0);
        vm.warp(uint256(start) + 2 days);
        vault.releasePeriod(id);
        vault.releasePeriod(id);
        vault.releasePeriod(id);
        assertEq(uint256(_status(id)), uint256(PolicyVaultV5.Status.Executed));
        assertEq(usdc.balanceOf(recipient), 30e6);
        assertEq(usdc.balanceOf(owner), 1_000e6 - 30e6, "the 20 not needed came back");
        _held();
    }

    function test_stoppingKeepsWhatIsAlreadyDueAndReturnsTheRest() public {
        (uint256 id, uint64 start) = _payroll(0, 100e6, _terms(0), 0);
        vm.warp(uint256(start) + 1 days); // two periods due, neither released
        vm.prank(owner);
        vault.stop(id);
        assertEq(usdc.balanceOf(owner), 1_000e6 - 20e6, "everything not yet due returned");

        vm.warp(block.timestamp + 5 days);
        vault.releasePeriod(id);
        vault.releasePeriod(id);
        assertEq(usdc.balanceOf(recipient), 20e6, "the recipient still gets what was due");
        assertEq(uint256(_status(id)), uint256(PolicyVaultV5.Status.Executed));
        _held();
    }

    function test_stoppingWithNothingDueCancels() public {
        (uint256 id,) = _payroll(0, 100e6, _terms(0), 0);
        vm.prank(owner);
        vault.stop(id);
        assertEq(uint256(_status(id)), uint256(PolicyVaultV5.Status.Cancelled));
        assertEq(usdc.balanceOf(owner), 1_000e6);
        _held();
    }

    function test_sweepPaysTheExcessAboveItsBuffer() public {
        uint64 start = uint64(block.timestamp + 1 days);
        PolicyVaultV5.Terms memory t = _terms(0);
        vm.prank(owner);
        uint256 id = vault.createSweepPolicy(t, 5e6, 1e6, 1 days, start, 20e6, 0);
        vm.warp(start);
        vault.releasePeriod(id);
        assertEq(usdc.balanceOf(recipient), 15e6);

        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.SweepBelowMin.selector, id, 0, 1e6));
        vault.releasePeriod(id);

        vm.prank(owner);
        vault.topUp(id, 3e6);
        vault.releasePeriod(id);
        assertEq(usdc.balanceOf(recipient), 18e6);
        _held();
    }

    function test_stoppingADueSweepKeepsTheSweepAndReturnsTheBuffer() public {
        uint64 start = uint64(block.timestamp + 1 days);
        vm.prank(owner);
        uint256 id = vault.createSweepPolicy(_terms(0), 5e6, 1e6, 1 days, start, 20e6, 0);
        vm.warp(start);
        vm.prank(owner);
        vault.stop(id);
        assertEq(usdc.balanceOf(owner), 1_000e6 - 15e6);
        vault.releasePeriod(id);
        assertEq(usdc.balanceOf(recipient), 15e6);
        assertEq(uint256(_status(id)), uint256(PolicyVaultV5.Status.Executed));
        _held();
    }

    function test_crossChainPayrollSpendsItsFeeAllowancePerTransfer() public {
        (uint256 id, uint64 start) = _payroll(0, 100e6, _xterms(0, FEE), 2 * FEE);
        vm.warp(uint256(start) + 2 days);
        vault.releasePeriod(id);
        vault.releasePeriod(id);
        assertEq(messenger.burnCount(), 2);
        assertEq(messenger.lastBurn().amount, 10e6 + FEE);

        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.FeeAllowanceShort.selector, id, 0, FEE));
        vault.releasePeriod(id);
        vm.prank(owner);
        vault.addFeeAllowance(id, FEE);
        vault.releasePeriod(id);
        assertEq(messenger.burnCount(), 3);
        _held();
    }

    function test_topUpIsForSchedulesOnly() public {
        (uint256 id,) = _timelock(_terms(10e6));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.NotRecurring.selector, id));
        vault.topUp(id, 1e6);
    }

    function test_aScheduleClosesAtItsDeadlineAndTheOwnerReclaims() public {
        (uint256 id,) = _payroll(0, 100e6, _terms(0), 0);
        uint64 deadline = vault.getPolicy(id).deadline;
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.PastDeadline.selector, id, uint256(deadline)));
        vault.releasePeriod(id);
        vm.prank(owner);
        vault.reclaim(id);
        assertEq(usdc.balanceOf(owner), 1_000e6);
        _held();
    }

    function test_aPauseBlocksPayroll() public {
        (uint256 id, uint64 start) = _payroll(0, 100e6, _terms(0), 0);
        vm.warp(start);
        vm.prank(guardian);
        vault.pause();
        vm.expectRevert(abi.encodeWithSelector(PolicyVaultV5.ReleasesPaused.selector, uint64(block.timestamp + 7 days)));
        vault.releasePeriod(id);
    }

    // ---------------------------------------------------------------------
    // One signature, one transaction
    // ---------------------------------------------------------------------

    function _permitSig(uint256 pk, address holder, uint256 value, uint256 dl) internal view returns (uint8, bytes32, bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                holder, address(vault), value, usdc.nonces(holder), dl
            )
        );
        return vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    function test_aPermitAndAPolicyInOneTransaction() public {
        (address holder, uint256 pk) = makeAddrAndKey("holder");
        usdc.mint(holder, 50e6);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, holder, 50e6, dl);

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(PolicyVaultV5.permitUsdc, (50e6, dl, v, r, s));
        calls[1] = abi.encodeCall(PolicyVaultV5.createTimelockPolicy, (_terms(50e6), uint64(block.timestamp + 1 days)));
        vm.prank(holder);
        vault.multicall(calls);

        assertEq(vault.getPolicy(0).owner, holder);
        assertEq(usdc.balanceOf(holder), 0);
        _held();
    }

    /// @dev Someone may land the permit first. What matters is the allowance, not who submitted it.
    function test_aFrontRunPermitDoesNotBlockTheCreate() public {
        (address holder, uint256 pk) = makeAddrAndKey("holder");
        usdc.mint(holder, 50e6);
        uint256 dl = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permitSig(pk, holder, 50e6, dl);
        usdc.permit(holder, address(vault), 50e6, dl, v, r, s); // front-run

        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(PolicyVaultV5.permitUsdc, (50e6, dl, v, r, s));
        calls[1] = abi.encodeCall(PolicyVaultV5.createTimelockPolicy, (_terms(50e6), uint64(block.timestamp + 1 days)));
        vm.prank(holder);
        vault.multicall(calls);
        assertEq(vault.getPolicy(0).owner, holder);
    }

    function test_aPermitThatFailsWithNoAllowanceReverts() public {
        vm.prank(stranger);
        vm.expectRevert(PolicyVaultV5.PermitFailed.selector);
        vault.permitUsdc(1e6, block.timestamp + 1 hours, 27, bytes32(0), bytes32(0));
    }

    // ---------------------------------------------------------------------
    // The accounting, under random amounts
    // ---------------------------------------------------------------------

    /// @dev Whatever the amounts, every path out leaves the vault holding exactly what it accounts
    ///      for, and money only ever reaches the recipient or returns to the owner.
    function testFuzz_moneyOnlyReachesTheRecipientOrTheOwner(uint96 a, uint96 b, uint32 fee, bool cancelSecond) public {
        uint256 amountA = bound(uint256(a), 1, 400e6);
        uint256 amountB = bound(uint256(b), 1, 400e6);
        uint256 f = bound(uint256(fee), 1, 1e6);
        uint256 start = usdc.balanceOf(owner);

        (uint256 idA, uint64 releaseTime) = _timelock(_terms(amountA));
        (uint256 idB,) = _timelock(_xterms(amountB, f));
        _held();

        vm.warp(releaseTime);
        vault.release(idA);
        if (cancelSecond) {
            vm.warp(vault.getPolicy(idB).deadline);
            vm.prank(owner);
            vault.reclaim(idB);
        } else {
            vault.release(idB);
        }
        _held();
        assertEq(vault.totalHeld(), 0);

        uint256 toRecipient = usdc.balanceOf(recipient);
        uint256 toBridge = usdc.balanceOf(address(messenger));
        uint256 backToOwner = usdc.balanceOf(owner) - (start - amountA - amountB - f);
        assertEq(toRecipient + toBridge + backToOwner, amountA + amountB + f, "nothing lost, nothing created");
    }
}
