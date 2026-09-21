// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PlanGuardBase} from "./PlanGuardBase.t.sol";
import {ChaconneVerifyPlanGuard} from "../src/ChaconneVerifyPlanGuard.sol";
import {GuardCore} from "../src/GuardCore.sol";
import {MockERC20, MockRouter, RebasingShortfallERC20, FeeOnTransferERC20} from "./mocks/Mocks.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Behaviour matrix for 验收 v2 M-01, M-03..M-11 (+ pause / epoch / allowlists / reentrancy / refunds).
contract PlanGuardTest is PlanGuardBase {
    /* ------------------------------- M-01 ------------------------------- */

    function test_twoSteps_happyPath_progressAccounted() public {
        Bundle memory b0 = _bundle(0);
        bytes32 md = _digestMandate(b0.mandate);
        uint256 userBefore = usd.balanceOf(user);

        vm.expectEmit(true, true, true, true, address(guard));
        emit ChaconneVerifyPlanGuard.MandateStep(
            user, md, 0, address(stockA), STEP_AMOUNT, STEP_AMOUNT, STEP_OUT, 0, EVIDENCE_HASH, executor
        );
        (uint256 spent, uint256 received, uint256 refunded) = _exec(b0);
        assertEq(spent, STEP_AMOUNT);
        assertEq(received, STEP_OUT);
        assertEq(refunded, 0);
        (uint256 sp, uint32 st, bool rv) = guard.mandateState(md);
        assertEq(sp, STEP_AMOUNT);
        assertEq(st, 1);
        assertFalse(rv);
        assertTrue(guard.mandateNonceUsed(user, 11));
        assertEq(guard.mandateOfNonce(user, 11), md);

        Bundle memory b1 = _bundle(1);
        _exec(b1);
        (sp, st,) = guard.mandateState(md);
        assertEq(sp, 2 * STEP_AMOUNT);
        assertEq(st, 2);
        assertEq(usd.balanceOf(user), userBefore - 2 * STEP_AMOUNT);
        assertEq(stockA.balanceOf(recipient), 2 * STEP_OUT);
        assertEq(usd.balanceOf(address(guard)), 0, "guard keeps no input");
        assertEq(stockA.balanceOf(address(guard)), 0, "guard keeps no output");
        assertEq(usd.allowance(address(guard), address(router)), 0, "allowance cleared");
        assertEq(usd.balanceOf(executor), 0, "executor gets nothing");
        assertEq(stockA.balanceOf(executor), 0, "executor gets nothing");
    }

    function test_secondOutputTokenInSet_accepted() public {
        MockRouter r2 = new MockRouter(stockB);
        vm.startPrank(admin);
        guard.setRoute(address(r2), address(r2), true);
        guard.setSelector(address(r2), MockRouter.swap.selector, true);
        vm.stopPrank();
        r2.setOutput(STEP_OUT, true);
        Bundle memory b = _bundle(0);
        b.step.outputToken = address(stockB);
        b.step.router = address(r2);
        b.step.spender = address(r2);
        _resignStep(b);
        (, uint256 received,) = _exec(b);
        assertEq(received, STEP_OUT);
        assertEq(stockB.balanceOf(recipient), STEP_OUT);
    }

    /* ------------------------------- M-11 ------------------------------- */

    function test_thirdPartyExecutor_assetFlowsToOwnerAndRecipient() public {
        router.setConsumeBps(6_000);
        Bundle memory b = _bundle(0);
        uint256 userBefore = usd.balanceOf(user);
        address stranger = address(0x5717A);
        (uint256 spent, uint256 received, uint256 refunded) = _execAs(b, stranger);
        assertEq(spent, 60_000_000);
        assertEq(refunded, 40_000_000);
        assertEq(received, STEP_OUT);
        assertEq(usd.balanceOf(user), userBefore - 60_000_000, "refund went to owner");
        assertEq(stockA.balanceOf(recipient), STEP_OUT, "output went to recipient");
        assertEq(usd.balanceOf(stranger), 0);
        assertEq(stockA.balanceOf(stranger), 0);
    }

    function test_ownerCanExecuteOwnStep() public {
        Bundle memory b = _bundle(0);
        _execAs(b, user);
    }

    /* ------------------------------- M-04 ------------------------------- */

    function test_replaySameStep_reverts() public {
        Bundle memory b = _bundle(0);
        _exec(b);
        vm.expectRevert(abi.encodeWithSelector(ChaconneVerifyPlanGuard.StepOutOfOrder.selector, 1, 0));
        _exec(b);
    }

    function test_stepOutOfOrder_reverts() public {
        Bundle memory b1 = _bundle(1);
        vm.expectRevert(abi.encodeWithSelector(ChaconneVerifyPlanGuard.StepOutOfOrder.selector, 0, 1));
        _exec(b1);
    }

    function test_skipStep_reverts() public {
        _exec(_bundle(0));
        Bundle memory b2 = _bundle(2);
        vm.expectRevert(abi.encodeWithSelector(ChaconneVerifyPlanGuard.StepOutOfOrder.selector, 1, 2));
        _exec(b2);
    }

    /* ------------------------------- M-05 ------------------------------- */

    function test_budgetExceededByOneWei_reverts() public {
        // steps of 100, 100 → 200 spent; third step 50_000_001 would exceed 250_000_000
        _exec(_bundle(0));
        _exec(_bundle(1));
        Bundle memory b = _bundle(2);
        b.cd = _calldata(50_000_001);
        b.step.amountIn = 50_000_001;
        b.step.calldataHash = keccak256(b.cd);
        _resignStep(b);
        vm.expectRevert(ChaconneVerifyPlanGuard.BudgetExceeded.selector);
        _exec(b);
        // exactly at budget passes
        b.cd = _calldata(50_000_000);
        b.step.amountIn = 50_000_000;
        b.step.calldataHash = keccak256(b.cd);
        _resignStep(b);
        _exec(b);
        (uint256 sp,,) = guard.mandateState(_digestMandate(b.mandate));
        assertEq(sp, BUDGET);
    }

    function test_perStepCapExceededByOneWei_reverts() public {
        Bundle memory b = _bundle(0);
        b.cd = _calldata(PER_STEP + 1);
        b.step.amountIn = PER_STEP + 1;
        b.step.calldataHash = keccak256(b.cd);
        _resignStep(b);
        vm.expectRevert(ChaconneVerifyPlanGuard.PerStepCapExceeded.selector);
        _exec(b);
    }

    function test_stepsExhausted_reverts() public {
        // budget 250 with 3 steps of 80 → fits budget, exhausts steps
        Bundle memory b;
        for (uint32 i = 0; i < 3; i++) {
            b = _bundle(i);
            b.cd = _calldata(80_000_000);
            b.step.amountIn = 80_000_000;
            b.step.calldataHash = keccak256(b.cd);
            _resignStep(b);
            _exec(b);
        }
        b = _bundle(3);
        b.cd = _calldata(1_000_000);
        b.step.amountIn = 1_000_000;
        b.step.calldataHash = keccak256(b.cd);
        _resignStep(b);
        vm.expectRevert(ChaconneVerifyPlanGuard.StepsExhausted.selector);
        _exec(b);
    }

    function test_budgetUsesActualSpent_partialConsumptionFreesBudget() public {
        router.setConsumeBps(5_000);
        _exec(_bundle(0)); // spent 50, refunded 50
        (uint256 sp,,) = guard.mandateState(_digestMandate(_mandate()));
        assertEq(sp, 50_000_000);
    }

    /* ------------------------------- M-06 ------------------------------- */

    function test_validFrom_boundary() public {
        Bundle memory b = _bundle(0);
        b.mandate.validFrom = uint64(block.timestamp + 1);
        _resignAll(b);
        vm.expectRevert(ChaconneVerifyPlanGuard.MandateNotYetValid.selector);
        _exec(b);
        b.mandate.validFrom = uint64(block.timestamp);
        _resignAll(b);
        _exec(b);
    }

    function test_mandateDeadline_boundary() public {
        Bundle memory b = _bundle(0);
        b.mandate.deadline = uint64(block.timestamp + 60);
        _resignAll(b);
        vm.warp(block.timestamp + 61);
        vm.expectRevert(ChaconneVerifyPlanGuard.MandateExpired.selector);
        _exec(b);
        vm.warp(block.timestamp - 1);
        _exec(b);
    }

    function test_stepDeadline_boundary() public {
        Bundle memory b = _bundle(0);
        vm.warp(block.timestamp + 61);
        vm.expectRevert(ChaconneVerifyPlanGuard.StepExpired.selector); // step deadline checked before cert window
        _exec(b);
        b = _bundle(0);
        b.step.deadline = uint64(block.timestamp + 10);
        b.cert = _cert(b.step, POLICY_HASH, EFFECTIVE_HASH);
        b.cert.validUntil = uint64(block.timestamp + 10);
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        vm.warp(block.timestamp + 11);
        vm.expectRevert(ChaconneVerifyPlanGuard.StepExpired.selector);
        _exec(b);
        vm.warp(block.timestamp - 1);
        _exec(b);
    }

    function test_certificate_window_boundaries() public {
        Bundle memory b = _bundle(0);
        b.cert.issuedAt = uint64(block.timestamp + 1);
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        vm.expectRevert(GuardCore.CertificateNotYetValid.selector);
        _exec(b);

        b = _bundle(0);
        b.cert.validUntil = uint64(block.timestamp + MAX_TTL + 1);
        b.step.deadline = b.cert.validUntil;
        b.cert.stepDigest = _digestStep(b.step);
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        vm.expectRevert(GuardCore.CertificateTtlTooLong.selector);
        _exec(b);

        b = _bundle(0);
        b.cert.validUntil = uint64(b.step.deadline + 1);
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        vm.expectRevert(ChaconneVerifyPlanGuard.CertificateOutlivesStep.selector);
        _exec(b);
    }

    /* ------------------------------- M-07 ------------------------------- */

    function test_revokedMandate_rejectsFurtherSteps() public {
        Bundle memory b = _bundle(0);
        _exec(b);
        vm.prank(user);
        guard.revokeMandate(b.mandate);
        (,, bool rv) = guard.mandateState(_digestMandate(b.mandate));
        assertTrue(rv);
        Bundle memory b1 = _bundle(1);
        vm.expectRevert(ChaconneVerifyPlanGuard.MandateRevokedError.selector);
        _exec(b1);
    }

    function test_revoke_onlyOwner() public {
        Bundle memory b = _bundle(0);
        vm.prank(executor);
        vm.expectRevert(ChaconneVerifyPlanGuard.NotMandateOwner.selector);
        guard.revokeMandate(b.mandate);
    }

    function test_cancelNonce_blocksUnstartedMandate_butNotStartedOne() public {
        Bundle memory b = _bundle(0);
        vm.prank(user);
        guard.cancelMandateNonce(11);
        vm.expectRevert(ChaconneVerifyPlanGuard.MandateNonceAlreadyUsed.selector);
        _exec(b);
        // a started mandate keeps going even if someone tries to cancel later (nonce already used → revert)
        Bundle memory b2 = _bundle(0);
        b2.mandate.nonce = 12;
        _resignAll(b2);
        _exec(b2);
        vm.prank(user);
        vm.expectRevert(ChaconneVerifyPlanGuard.MandateNonceAlreadyUsed.selector);
        guard.cancelMandateNonce(12);
        Bundle memory b3 = _bundle(1);
        b3.mandate.nonce = 12;
        _resignAll(b3);
        _exec(b3);
    }

    function test_nonceReuseByDifferentMandate_reverts() public {
        _exec(_bundle(0));
        Bundle memory other = _bundle(0);
        other.mandate.budgetCap = BUDGET + 1; // different mandate, same owner nonce 11
        _resignAll(other);
        vm.expectRevert(ChaconneVerifyPlanGuard.MandateNonceAlreadyUsed.selector);
        _exec(other);
    }

    /* ------------------------------- M-08 ------------------------------- */

    function test_outputTokenNotInSet_reverts() public {
        MockERC20 rogue = new MockERC20("ROGUEx", "ROGUEx", 18);
        vm.prank(admin);
        guard.setToken(address(rogue), true);
        Bundle memory b = _bundle(0);
        b.step.outputToken = address(rogue);
        _resignStep(b);
        vm.expectRevert(ChaconneVerifyPlanGuard.OutputNotInSet.selector);
        _exec(b);
    }

    function test_outputSetUnsorted_reverts() public {
        Bundle memory b = _bundle(0);
        address[] memory bad = new address[](2);
        bad[0] = outputSet[1];
        bad[1] = outputSet[0];
        b.set = bad;
        vm.expectRevert(ChaconneVerifyPlanGuard.OutputSetNotSorted.selector);
        _exec(b);
    }

    function test_outputSetDuplicate_reverts() public {
        Bundle memory b = _bundle(0);
        address[] memory bad = new address[](2);
        bad[0] = outputSet[0];
        bad[1] = outputSet[0];
        b.set = bad;
        vm.expectRevert(ChaconneVerifyPlanGuard.OutputSetNotSorted.selector);
        _exec(b);
    }

    function test_outputSetMismatch_reverts() public {
        Bundle memory b = _bundle(0);
        address[] memory other = new address[](1);
        other[0] = outputSet[0];
        b.set = other; // valid sorted list but not the committed one
        vm.expectRevert(ChaconneVerifyPlanGuard.OutputSetMismatch.selector);
        _exec(b);
    }

    function test_computeOutputSetHash_matchesCommitment() public view {
        assertEq(guard.computeOutputSetHash(outputSet), _mandate().outputSetHash);
    }

    /* ------------------------------- M-03 tamper ------------------------------- */

    function test_tamper_mandateFields_invalidateSignature() public {
        Bundle memory b = _bundle(0);
        b.mandate.budgetCap += 1;
        b.step.mandateDigest = _digestMandate(b.mandate); // attacker keeps everything consistent except owner sig
        _resignStep(b);
        vm.expectRevert(ChaconneVerifyPlanGuard.InvalidMandateSignature.selector);
        _exec(b);

        b = _bundle(0);
        b.mandate.recipient = executor;
        b.step.mandateDigest = _digestMandate(b.mandate);
        _resignStep(b);
        vm.expectRevert(ChaconneVerifyPlanGuard.InvalidMandateSignature.selector);
        _exec(b);

        b = _bundle(0);
        b.mandate.perStepCap *= 2;
        b.step.mandateDigest = _digestMandate(b.mandate);
        _resignStep(b);
        vm.expectRevert(ChaconneVerifyPlanGuard.InvalidMandateSignature.selector);
        _exec(b);

        b = _bundle(0);
        b.mandate.deadline += 1;
        b.step.mandateDigest = _digestMandate(b.mandate);
        _resignStep(b);
        vm.expectRevert(ChaconneVerifyPlanGuard.InvalidMandateSignature.selector);
        _exec(b);
    }

    function test_tamper_mandateSignedByOtherKey_reverts() public {
        Bundle memory b = _bundle(0);
        b.mandateSig = _sign(0xBAD, _digestMandate(b.mandate));
        vm.expectRevert(ChaconneVerifyPlanGuard.InvalidMandateSignature.selector);
        _exec(b);
    }

    function test_tamper_stepMandateDigest_reverts() public {
        Bundle memory b = _bundle(0);
        b.step.mandateDigest = bytes32(uint256(0xdead));
        _resignStep(b);
        vm.expectRevert(ChaconneVerifyPlanGuard.StepMandateMismatch.selector);
        _exec(b);
    }

    function test_tamper_stepFields_afterCertificate_reverts() public {
        // certificate is signed for the honest step; attacker mutates the step → stepDigest mismatch
        Bundle memory b = _bundle(0);
        b.step.minAmountOut -= 1;
        vm.expectRevert(ChaconneVerifyPlanGuard.CertificateStepMismatch.selector);
        _exec(b);

        b = _bundle(0);
        b.step.amountIn -= 1;
        vm.expectRevert(ChaconneVerifyPlanGuard.CertificateStepMismatch.selector);
        _exec(b);

        b = _bundle(0);
        b.step.evidenceHash = bytes32(uint256(0x99));
        vm.expectRevert(ChaconneVerifyPlanGuard.CertificateStepMismatch.selector);
        _exec(b);

        b = _bundle(0);
        b.step.deadline += 1;
        vm.expectRevert(ChaconneVerifyPlanGuard.CertificateStepMismatch.selector);
        _exec(b);
    }

    function test_tamper_calldata_reverts() public {
        Bundle memory b = _bundle(0);
        b.cd = _calldata(STEP_AMOUNT - 1); // hash no longer matches
        vm.expectRevert(GuardCore.CalldataMismatch.selector);
        _exec(b);
    }

    function test_tamper_certificateFields_reverts() public {
        Bundle memory b = _bundle(0);
        b.cert.evidenceHash = bytes32(uint256(0x99));
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        vm.expectRevert(ChaconneVerifyPlanGuard.CertificateBindingMismatch.selector);
        _exec(b);

        b = _bundle(0);
        b.cert.policyDefinitionHash = bytes32(uint256(0x77));
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        vm.expectRevert(ChaconneVerifyPlanGuard.CertificateBindingMismatch.selector);
        _exec(b);

        b = _bundle(0);
        b.cert.validUntil += 1; // outlives the step → rejected before signature check
        vm.expectRevert(ChaconneVerifyPlanGuard.CertificateOutlivesStep.selector);
        _exec(b);

        b = _bundle(0);
        b.cert.issuedAt -= 1; // in-window mutation without re-signing → signature mismatch
        vm.expectRevert(GuardCore.InvalidCertificateSignature.selector);
        _exec(b);

        b = _bundle(0);
        b.certSig = _sign(0xBAD, _digestCert(b.cert));
        vm.expectRevert(GuardCore.InvalidCertificateSignature.selector);
        _exec(b);

        b = _bundle(0);
        b.cert.signerEpoch = 2;
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        vm.expectRevert(GuardCore.EpochDisabled.selector);
        _exec(b);
    }

    function test_tamper_certificateForOtherStep_reverts() public {
        Bundle memory b = _bundle(0);
        Bundle memory other = _bundle(1);
        b.cert = other.cert;
        b.certSig = other.certSig;
        vm.expectRevert(ChaconneVerifyPlanGuard.CertificateStepMismatch.selector);
        _exec(b);
    }

    /* ------------------------------- M-09 rebasing input ------------------------------- */

    function _rebasingSetup(uint256 shortfall, uint256 tolerance)
        internal
        returns (RebasingShortfallERC20 rb, MockRouter r2, Bundle memory b)
    {
        rb = new RebasingShortfallERC20(shortfall);
        r2 = new MockRouter(usd); // sell: output is the stablecoin
        vm.startPrank(admin);
        guard.setToken(address(rb), true);
        guard.setRoute(address(r2), address(r2), true);
        guard.setSelector(address(r2), MockRouter.swap.selector, true);
        guard.setInputShortfallTolerance(address(rb), tolerance);
        vm.stopPrank();
        rb.mint(user, 10e18);
        vm.prank(user);
        rb.approve(address(guard), type(uint256).max);
        r2.setOutput(330_000_000, true); // 330 USD for 1 share

        b = _bundle(0);
        b.mandate.inputToken = address(rb);
        address[] memory set = new address[](1);
        set[0] = address(usd);
        b.set = set;
        b.mandate.outputSetHash = _setHash(set);
        b.mandate.budgetCap = 3e18;
        b.mandate.perStepCap = 1e18;
        // router pulls (amountIn - tolerance) so a short delivery still suffices
        b.cd = abi.encodeCall(MockRouter.swap, (address(rb), 1e18 - tolerance));
        b.step.outputToken = address(usd);
        b.step.router = address(r2);
        b.step.spender = address(r2);
        b.step.amountIn = 1e18;
        b.step.minAmountOut = 329_000_000;
        b.step.calldataHash = keccak256(b.cd);
        _resignAll(b);
    }

    function test_sell_rebasingShortfallWithinTolerance_passes() public {
        (RebasingShortfallERC20 rb,, Bundle memory b) = _rebasingSetup(1, 1e6);
        uint256 userStockBefore = rb.balanceOf(user);
        (uint256 spent, uint256 received, uint256 refunded) = _exec(b);
        assertEq(received, 330_000_000);
        assertEq(usd.balanceOf(recipient), 330_000_000);
        // pulled 1e18-1; router consumed 1e18-1e6; leftover refunded (minus 1 wei shortfall on refund transfer)
        assertEq(spent, 1e18 - 1e6);
        assertEq(refunded, 1e6 - 1);
        assertEq(
            userStockBefore - rb.balanceOf(user),
            1e18 - (1e6 - 1) + 1,
            "owner paid pulled minus refund (1 wei rounding on refund)"
        );
        assertLe(rb.balanceOf(address(guard)), 1e6, "dust bounded by tolerance");
        (uint256 sp,,) = guard.mandateState(_digestMandate(b.mandate));
        assertEq(sp, 1e18 - 1e6, "budget accounts actual spent");
    }

    function test_sell_rebasingShortfallBeyondTolerance_reverts() public {
        (,, Bundle memory b) = _rebasingSetup(5, 4);
        vm.expectRevert(GuardCore.InputTransferShortfall.selector);
        _exec(b);
    }

    function test_sell_noTolerance_shortfallReverts() public {
        (,, Bundle memory b) = _rebasingSetup(1, 0);
        vm.expectRevert(GuardCore.InputTransferShortfall.selector);
        _exec(b);
    }

    /* ------------------------------- M-10 sell direction ------------------------------- */

    function test_sell_minOutNotMet_reverts() public {
        (, MockRouter r2, Bundle memory b) = _rebasingSetup(0, 0);
        r2.setOutput(328_000_000, true);
        vm.expectRevert(abi.encodeWithSelector(GuardCore.InsufficientOutput.selector, 328_000_000, 329_000_000));
        _exec(b);
    }

    function test_sell_exactTransfer_noTolerance_passes() public {
        (,, Bundle memory b) = _rebasingSetup(0, 0);
        (uint256 spent, uint256 received,) = _exec(b);
        assertEq(spent, 1e18);
        assertEq(received, 330_000_000);
    }

    function test_feeOnTransferInput_stillRejected_evenWithSmallTolerance() public {
        FeeOnTransferERC20 fee = new FeeOnTransferERC20();
        vm.startPrank(admin);
        guard.setToken(address(fee), true);
        guard.setInputShortfallTolerance(address(fee), 1e3);
        vm.stopPrank();
        fee.mint(user, 1_000_000_000);
        vm.prank(user);
        fee.approve(address(guard), type(uint256).max);
        Bundle memory b = _bundle(0);
        b.mandate.inputToken = address(fee);
        b.cd = abi.encodeCall(MockRouter.swap, (address(fee), STEP_AMOUNT));
        b.step.calldataHash = keccak256(b.cd);
        _resignAll(b);
        vm.expectRevert(GuardCore.InputTransferShortfall.selector); // 1% fee ≫ 1e3 wei tolerance
        _exec(b);
    }

    /* ------------------------------- allowlists / admin ------------------------------- */

    function test_nonZeroValue_reverts() public {
        Bundle memory b = _bundle(0);
        vm.deal(executor, 1 ether);
        vm.prank(executor);
        vm.expectRevert(GuardCore.NonZeroValue.selector);
        guard.executeStep{value: 1}(b.mandate, b.mandateSig, b.set, b.step, b.cert, b.certSig, b.cd);
    }

    function test_selectorNotAllowed_reverts() public {
        Bundle memory b = _bundle(0);
        b.cd = abi.encodeCall(MockRouter.drain, (address(usd), executor));
        b.step.calldataHash = keccak256(b.cd);
        _resignStep(b);
        vm.expectRevert(GuardCore.SelectorNotAllowed.selector);
        _exec(b);
    }

    function test_routeNotAllowed_reverts() public {
        Bundle memory b = _bundle(0);
        b.step.spender = address(0x1234);
        _resignStep(b);
        vm.expectRevert(GuardCore.RouteNotAllowed.selector);
        _exec(b);
    }

    function test_tokenNotAllowed_reverts() public {
        vm.prank(admin);
        guard.setToken(address(stockA), false);
        Bundle memory b = _bundle(0);
        vm.expectRevert(GuardCore.TokenNotAllowed.selector);
        _exec(b);
    }

    function test_policyOrRegistryDisabled_reverts() public {
        Bundle memory b = _bundle(0);
        b.mandate.policyDefinitionHash = bytes32(uint256(0x55));
        _resignAll(b);
        b.cert.policyDefinitionHash = bytes32(uint256(0x55));
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        vm.expectRevert(GuardCore.PolicyDisabled.selector);
        _exec(b);

        b = _bundle(0);
        b.mandate.registryHash = bytes32(uint256(0x66));
        _resignAll(b);
        vm.expectRevert(GuardCore.RegistryDisabled.selector);
        _exec(b);
    }

    function test_paused_rejects_thenResumes() public {
        vm.prank(admin);
        guard.pause();
        Bundle memory b = _bundle(0);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        _exec(b);
        vm.prank(admin);
        guard.unpause();
        _exec(_bundle(0));
    }

    function test_epochRotation_oldEpochRejected_newAccepted() public {
        uint256 newPk = 0x7777;
        address newSigner = vm.addr(newPk);
        vm.startPrank(admin);
        guard.setSignerEpoch(2, newSigner, true);
        guard.setSignerEpoch(1, signer, false);
        vm.stopPrank();
        Bundle memory b = _bundle(0);
        vm.expectRevert(GuardCore.EpochDisabled.selector);
        _exec(b);
        b.cert.signerEpoch = 2;
        b.certSig = _sign(newPk, _digestCert(b.cert));
        _exec(b);
    }

    function test_nonAdmin_cannotConfigure() public {
        vm.startPrank(executor);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, executor));
        guard.setPolicy(bytes32(uint256(9)), true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, executor));
        guard.setInputShortfallTolerance(address(usd), 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, executor));
        guard.pause();
        vm.stopPrank();
    }

    /* ------------------------------- router misbehaviour ------------------------------- */

    function test_routerReentrancy_reverts() public {
        Bundle memory b = _bundle(0);
        bytes memory inner = abi.encodeCall(
            ChaconneVerifyPlanGuard.executeStep, (b.mandate, b.mandateSig, b.set, b.step, b.cert, b.certSig, b.cd)
        );
        router.setReenter(address(guard), inner);
        vm.expectRevert(); // RouterCallFailed(ReentrancyGuardReentrantCall)
        _exec(b);
        (, uint32 st,) = guard.mandateState(_digestMandate(b.mandate));
        assertEq(st, 0, "nothing consumed");
        assertFalse(guard.mandateNonceUsed(user, 11), "nonce not consumed on revert");
    }

    function test_routerRevert_bubbles_noStateChange() public {
        router.setRevert(true);
        Bundle memory b = _bundle(0);
        vm.expectRevert();
        _exec(b);
        (, uint32 st,) = guard.mandateState(_digestMandate(b.mandate));
        assertEq(st, 0);
    }

    function test_zeroOutput_reverts() public {
        router.setOutput(0, false);
        Bundle memory b = _bundle(0);
        vm.expectRevert(abi.encodeWithSelector(GuardCore.InsufficientOutput.selector, 0, STEP_OUT - 2e15));
        _exec(b);
    }

    function test_donatedBalances_notAttributed() public {
        usd.mint(address(guard), 7_000_000);
        stockA.mint(address(guard), 3e18);
        router.setConsumeBps(6_000);
        (uint256 spent, uint256 received, uint256 refunded) = _exec(_bundle(0));
        assertEq(spent, 60_000_000);
        assertEq(refunded, 40_000_000);
        assertEq(received, STEP_OUT);
        assertEq(usd.balanceOf(address(guard)), 7_000_000);
        assertEq(stockA.balanceOf(address(guard)), 3e18);
    }

    function test_rescue_onlyOwner_sweepsDonations() public {
        usd.mint(address(guard), 5);
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, executor));
        guard.rescue(address(usd), executor, 5);
        vm.prank(admin);
        guard.rescue(address(usd), admin, 5);
        assertEq(usd.balanceOf(admin), 5);
    }

    function test_failedStep_canBeRetriedWithSameBundle() public {
        router.setRevert(true);
        Bundle memory b = _bundle(0);
        vm.expectRevert();
        _exec(b);
        router.setRevert(false);
        _exec(b);
    }
}
