// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GuardBase} from "./GuardBase.t.sol";
import {ChaconneVerifyGuard} from "../src/ChaconneVerifyGuard.sol";
import {MockERC20, MockRouter, FeeOnTransferERC20, FeeOnTransferOut} from "./mocks/Mocks.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Behaviour matrix for 验收 G-01（FORK 前的本地行为）～G-12。
contract GuardTest is GuardBase {
    /* ---------------------------- G-01 happy path ---------------------------- */

    function test_execute_happyPath_fullConsumption() public {
        Bundle memory b = _bundle();
        uint256 userUsdBefore = usd.balanceOf(user);

        vm.expectEmit(true, true, true, true, GUARD_ADDR);
        emit ChaconneVerifyGuard.GuardedExecution(
            user, recipient, 7, b.cert.intentDigest, EVIDENCE_HASH, POLICY_HASH, EFFECTIVE_HASH, address(router), 100_000_000, 100_000_000, 400e15, 0
        );
        (uint256 spent, uint256 received, uint256 refunded) = _exec(b);

        assertEq(spent, 100_000_000);
        assertEq(received, 400e15);
        assertEq(refunded, 0);
        assertEq(usd.balanceOf(user), userUsdBefore - 100_000_000);
        assertEq(stock.balanceOf(recipient), 400e15);
        assertEq(stock.balanceOf(GUARD_ADDR), 0, "guard keeps no output");
        assertEq(usd.balanceOf(GUARD_ADDR), 0, "guard keeps no input");
        assertEq(usd.allowance(GUARD_ADDR, address(router)), 0, "allowance cleared");
        assertTrue(guard.nonceUsed(user, 7));
    }

    /* ---------------------------- G-09 partial consumption ---------------------------- */

    function test_execute_partialConsumption_refundsOwner() public {
        router.setConsumeBps(6_000); // router pulls 60 %
        Bundle memory b = _bundle();
        uint256 userUsdBefore = usd.balanceOf(user);
        (uint256 spent, uint256 received, uint256 refunded) = _exec(b);
        assertEq(spent, 60_000_000);
        assertEq(refunded, 40_000_000);
        assertEq(received, 400e15);
        assertEq(usd.balanceOf(user), userUsdBefore - 60_000_000, "only consumed input leaves owner");
        assertEq(usd.balanceOf(GUARD_ADDR), 0);
    }

    function test_execute_donatedBalancesNotAttributed() public {
        // someone donates tokens to the guard beforehand: must not count as output/refund and must not be swept to user
        usd.mint(GUARD_ADDR, 5_000_000);
        stock.mint(GUARD_ADDR, 1e18);
        router.setConsumeBps(6_000);
        Bundle memory b = _bundle();
        (uint256 spent, uint256 received, uint256 refunded) = _exec(b);
        assertEq(spent, 60_000_000);
        assertEq(refunded, 40_000_000);
        assertEq(received, 400e15);
        assertEq(usd.balanceOf(GUARD_ADDR), 5_000_000, "donated input untouched");
        assertEq(stock.balanceOf(GUARD_ADDR), 1e18, "donated output untouched");
        assertEq(stock.balanceOf(recipient), 400e15);
        // only the admin can sweep donations, never mid-execution
        vm.prank(admin);
        guard.rescue(address(stock), admin, 1e18);
        assertEq(stock.balanceOf(admin), 1e18);
    }

    /* ---------------------------- G-06 boundaries ---------------------------- */

    function test_execute_revert_insufficientOutput_belowMinOut() public {
        router.setOutput(398e15 - 1, true);
        Bundle memory b = _bundle();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ChaconneVerifyGuard.InsufficientOutput.selector, 398e15 - 1, 398e15));
        guard.execute(b.intent, b.intentSig, b.cert, b.certSig, b.cd);
        assertFalse(guard.nonceUsed(user, 7), "revert does not consume nonce");
        assertEq(usd.balanceOf(user), 1_000_000_000, "full rollback");
    }

    function test_execute_exactMinOut_passes() public {
        router.setOutput(398e15, true);
        Bundle memory b = _bundle();
        (, uint256 received,) = _exec(b);
        assertEq(received, 398e15);
    }

    function test_execute_zeroOutput_reverts() public {
        router.setOutput(0, false);
        Bundle memory b = _bundle();
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(ChaconneVerifyGuard.InsufficientOutput.selector, 0, 398e15));
        guard.execute(b.intent, b.intentSig, b.cert, b.certSig, b.cd);
    }

    function test_execute_deadlineBoundary() public {
        Bundle memory b = _bundle();
        vm.warp(b.intent.deadline); // == deadline passes
        _exec(b);
        Bundle memory b2 = _bundle();
        b2.intent.nonce = 8;
        b2.intentSig = _sign(OWNER_PK, _digestIntent(b2.intent));
        b2.cert = _cert(b2.intent);
        b2.certSig = _sign(SIGNER_PK, _digestCert(b2.cert));
        vm.warp(b2.intent.deadline + 1);
        vm.prank(user);
        vm.expectRevert(ChaconneVerifyGuard.IntentExpired.selector);
        guard.execute(b2.intent, b2.intentSig, b2.cert, b2.certSig, b2.cd);
    }

    /* ---------------------------- G-02 certificate ---------------------------- */

    function test_revert_wrongCertificateSigner() public {
        Bundle memory b = _bundle();
        b.certSig = _sign(0xBAD, _digestCert(b.cert));
        _expectRevert(b, ChaconneVerifyGuard.InvalidCertificateSignature.selector);
    }

    function test_revert_certificateSignedByUserNotService() public {
        Bundle memory b = _bundle();
        b.certSig = _sign(OWNER_PK, _digestCert(b.cert));
        _expectRevert(b, ChaconneVerifyGuard.InvalidCertificateSignature.selector);
    }

    function test_revert_missingCertificateSignature() public {
        Bundle memory b = _bundle();
        b.certSig = "";
        _expectRevert(b, ChaconneVerifyGuard.InvalidCertificateSignature.selector);
    }

    function test_revert_certificateExpired() public {
        Bundle memory b = _bundle();
        b.intent.deadline = uint64(block.timestamp + 100); // intent outlives the certificate
        b.intentSig = _sign(OWNER_PK, _digestIntent(b.intent));
        b.cert = _cert(b.intent); // validUntil = now + 60
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        vm.warp(b.cert.validUntil + 1);
        _expectRevert(b, ChaconneVerifyGuard.CertificateExpired.selector);
    }

    function test_revert_certificateNotYetValid() public {
        Bundle memory b = _bundle();
        b.cert.issuedAt = uint64(block.timestamp + 10);
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        _expectRevert(b, ChaconneVerifyGuard.CertificateNotYetValid.selector);
    }

    function test_revert_certificateOutlivesIntent() public {
        Bundle memory b = _bundle();
        b.cert.validUntil = b.intent.deadline + 1;
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        _expectRevert(b, ChaconneVerifyGuard.CertificateOutlivesIntent.selector);
    }

    function test_revert_certificateTtlTooLong() public {
        Bundle memory b = _bundle();
        b.intent.deadline = uint64(block.timestamp + 1000);
        b.intentSig = _sign(OWNER_PK, _digestIntent(b.intent));
        b.cert = _cert(b.intent);
        b.cert.validUntil = uint64(block.timestamp + MAX_TTL + 1);
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        _expectRevert(b, ChaconneVerifyGuard.CertificateTtlTooLong.selector);
    }

    function test_revert_certificateBoundToOtherIntent() public {
        Bundle memory b = _bundle();
        b.cert.intentDigest = bytes32(uint256(0xdead));
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        _expectRevert(b, ChaconneVerifyGuard.CertificateIntentMismatch.selector);
    }

    function test_revert_certificateEvidenceMismatch() public {
        Bundle memory b = _bundle();
        b.cert.evidenceHash = bytes32(uint256(0x99));
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        _expectRevert(b, ChaconneVerifyGuard.CertificateBindingMismatch.selector);
    }

    /* ---------------------------- G-11 epochs / pause / admin ---------------------------- */

    function test_epochRotation_oldEpochRejectedAfterDisable() public {
        // rotate: enable epoch 2 with a new signer, disable epoch 1
        uint256 newPk = 0x5164;
        vm.startPrank(admin);
        guard.setSignerEpoch(2, vm.addr(newPk), true);
        guard.setSignerEpoch(1, signer, false);
        vm.stopPrank();
        Bundle memory b = _bundle(); // epoch 1
        _expectRevert(b, ChaconneVerifyGuard.EpochDisabled.selector);
        b.cert.signerEpoch = 2;
        b.certSig = _sign(newPk, _digestCert(b.cert));
        _exec(b);
        assertTrue(guard.nonceUsed(user, 7));
    }

    function test_overlapEpochs_bothAccepted() public {
        uint256 newPk = 0x5164;
        vm.prank(admin);
        guard.setSignerEpoch(2, vm.addr(newPk), true);
        Bundle memory b = _bundle();
        _exec(b); // epoch 1 still valid
    }

    function test_pause_blocksExecute_unpauseRestores() public {
        vm.prank(admin);
        guard.pause();
        Bundle memory b = _bundle();
        vm.prank(user);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        guard.execute(b.intent, b.intentSig, b.cert, b.certSig, b.cd);
        vm.prank(admin);
        guard.unpause();
        _exec(b);
    }

    function test_nonAdmin_cannotManage() public {
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        guard.setSignerEpoch(9, user, true);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        guard.pause();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        guard.rescue(address(usd), user, 1);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        guard.setRoute(address(0x1), address(0x1), true);
        vm.stopPrank();
    }

    function test_admin_cannotTakeUserFunds_viaRescueDuringUse() public {
        // rescue can only move what the guard holds; after execute it holds nothing of the user
        Bundle memory b = _bundle();
        _exec(b);
        vm.prank(admin);
        vm.expectRevert(); // ERC20 insufficient balance
        guard.rescue(address(stock), admin, 1);
    }

    /* ---------------------------- G-04 nonce ---------------------------- */

    function test_revert_nonceReplay() public {
        Bundle memory b = _bundle();
        _exec(b);
        _expectRevert(b, ChaconneVerifyGuard.NonceAlreadyUsed.selector);
    }

    function test_twoRefreshVersionsShareNonce_onlyOneExecutes() public {
        Bundle memory v1 = _bundle();
        Bundle memory v2 = _bundle();
        v2.intent.minAmountOut = 397e15; // a second refresh with slightly different bounds, same nonce
        v2.intentSig = _sign(OWNER_PK, _digestIntent(v2.intent));
        v2.cert = _cert(v2.intent);
        v2.certSig = _sign(SIGNER_PK, _digestCert(v2.cert));
        _exec(v2);
        _expectRevert(v1, ChaconneVerifyGuard.NonceAlreadyUsed.selector);
    }

    function test_cancelNonce_blocksSignedIntent() public {
        Bundle memory b = _bundle();
        vm.prank(user);
        guard.cancelNonce(7);
        _expectRevert(b, ChaconneVerifyGuard.NonceAlreadyUsed.selector);
        vm.prank(user);
        vm.expectRevert(ChaconneVerifyGuard.NonceAlreadyUsed.selector);
        guard.cancelNonce(7);
    }

    function test_failedRouter_doesNotConsumeNonce() public {
        router.setRevert(true);
        Bundle memory b = _bundle();
        vm.prank(user);
        vm.expectRevert(); // RouterCallFailed(bytes)
        guard.execute(b.intent, b.intentSig, b.cert, b.certSig, b.cd);
        assertFalse(guard.nonceUsed(user, 7));
        router.setRevert(false);
        _exec(b); // retry with the same signed bundle succeeds
    }

    /* ---------------------------- G-03 cross-chain / cross-guard ---------------------------- */

    function test_revert_crossChainReplay() public {
        Bundle memory b = _bundle(); // signed under chainId 196
        vm.chainId(1952);
        // EIP712 recomputes the domain with the new chainId → user signature no longer recovers to owner
        _expectRevert(b, ChaconneVerifyGuard.CertificateIntentMismatch.selector);
    }

    function test_revert_crossGuardReplay() public {
        Bundle memory b = _bundle();
        ChaconneVerifyGuard other = new ChaconneVerifyGuard(admin, signer, EPOCH, MAX_TTL);
        vm.startPrank(admin);
        other.setPolicy(POLICY_HASH, true);
        other.setRegistry(REGISTRY_HASH, true);
        other.setRoute(address(router), address(router), true);
        other.setSelector(address(router), MockRouter.swap.selector, true);
        other.setToken(address(usd), true);
        other.setToken(address(stock), true);
        vm.stopPrank();
        vm.prank(user);
        usd.approve(address(other), type(uint256).max);
        vm.prank(user);
        vm.expectRevert(ChaconneVerifyGuard.CertificateIntentMismatch.selector);
        other.execute(b.intent, b.intentSig, b.cert, b.certSig, b.cd);
    }

    function test_revert_senderIsNotIntentOwner() public {
        Bundle memory b = _bundle();
        vm.prank(address(0xC0FFEE));
        vm.expectRevert(ChaconneVerifyGuard.NotOwnerOfIntent.selector);
        guard.execute(b.intent, b.intentSig, b.cert, b.certSig, b.cd);
    }

    /* ---------------------------- G-05 tamper matrix ---------------------------- */

    function test_tamper_recipient() public {
        Bundle memory b = _bundle();
        b.intent.recipient = address(0xE711);
        _expectRevert(b, ChaconneVerifyGuard.CertificateIntentMismatch.selector);
    }

    function test_tamper_amountIn() public {
        Bundle memory b = _bundle();
        b.intent.amountIn = 200_000_000;
        _expectRevert(b, ChaconneVerifyGuard.CertificateIntentMismatch.selector);
    }

    function test_tamper_minOut() public {
        Bundle memory b = _bundle();
        b.intent.minAmountOut = 1;
        _expectRevert(b, ChaconneVerifyGuard.CertificateIntentMismatch.selector);
    }

    function test_tamper_outputToken() public {
        MockERC20 other = new MockERC20("X", "X", 18);
        vm.prank(admin);
        guard.setToken(address(other), true);
        Bundle memory b = _bundle();
        b.intent.outputToken = address(other);
        _expectRevert(b, ChaconneVerifyGuard.CertificateIntentMismatch.selector);
    }

    function test_tamper_calldata_sameHashClaim() public {
        Bundle memory b = _bundle();
        b.cd = abi.encodeCall(MockRouter.swap, (address(usd), 1)); // different calldata, hash in intent unchanged
        _expectRevert(b, ChaconneVerifyGuard.CalldataMismatch.selector);
    }

    function test_tamper_policyHash_toEnabledOne() public {
        bytes32 otherPolicy = bytes32(uint256(0x77));
        vm.prank(admin);
        guard.setPolicy(otherPolicy, true);
        Bundle memory b = _bundle();
        b.intent.policyDefinitionHash = otherPolicy;
        _expectRevert(b, ChaconneVerifyGuard.CertificateIntentMismatch.selector);
    }

    function test_tamper_userResignsButCertificateStale() public {
        // user re-signs a modified intent; certificate still binds the original digest
        Bundle memory b = _bundle();
        b.intent.minAmountOut = 1;
        b.intentSig = _sign(OWNER_PK, _digestIntent(b.intent));
        _expectRevert(b, ChaconneVerifyGuard.CertificateIntentMismatch.selector);
    }

    function test_tamper_intentSignatureFromOtherKey() public {
        Bundle memory b = _bundle();
        b.intentSig = _sign(0xBAD, _digestIntent(b.intent));
        _expectRevert(b, ChaconneVerifyGuard.InvalidIntentSignature.selector);
    }

    /* ---------------------------- G-07 allowlists ---------------------------- */

    function test_revert_policyDisabled() public {
        vm.prank(admin);
        guard.setPolicy(POLICY_HASH, false);
        _expectRevert(_bundle(), ChaconneVerifyGuard.PolicyDisabled.selector);
    }

    function test_revert_registryDisabled() public {
        vm.prank(admin);
        guard.setRegistry(REGISTRY_HASH, false);
        _expectRevert(_bundle(), ChaconneVerifyGuard.RegistryDisabled.selector);
    }

    function test_revert_routeNotAllowed() public {
        vm.prank(admin);
        guard.setRoute(address(router), address(router), false);
        _expectRevert(_bundle(), ChaconneVerifyGuard.RouteNotAllowed.selector);
    }

    function test_revert_selectorNotAllowed_drain() public {
        // attacker gets the service to sign an intent whose calldata targets a non-allowlisted selector
        Bundle memory b = _bundle();
        b.cd = abi.encodeCall(MockRouter.drain, (address(usd), address(0xE711)));
        b.intent.calldataHash = keccak256(b.cd);
        b.intentSig = _sign(OWNER_PK, _digestIntent(b.intent));
        b.cert = _cert(b.intent);
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        _expectRevert(b, ChaconneVerifyGuard.SelectorNotAllowed.selector);
    }

    function test_revert_tokenNotAllowed() public {
        vm.prank(admin);
        guard.setToken(address(stock), false);
        _expectRevert(_bundle(), ChaconneVerifyGuard.TokenNotAllowed.selector);
    }

    function test_revert_nativeValueRejected() public {
        Bundle memory b = _bundle();
        vm.deal(user, 1 ether);
        vm.prank(user);
        (bool ok,) = GUARD_ADDR.call{value: 1}(
            abi.encodeCall(ChaconneVerifyGuard.execute, (b.intent, b.intentSig, b.cert, b.certSig, b.cd))
        );
        assertFalse(ok, "non-payable execute rejects value");
    }

    /* ---------------------------- G-08 / G-10 token behaviour & reentrancy ---------------------------- */

    function test_revert_feeOnTransferInput() public {
        FeeOnTransferERC20 fee = new FeeOnTransferERC20();
        fee.mint(user, 1_000_000_000);
        vm.prank(user);
        fee.approve(GUARD_ADDR, type(uint256).max);
        vm.prank(admin);
        guard.setToken(address(fee), true);
        Bundle memory b = _bundle();
        b.cd = abi.encodeCall(MockRouter.swap, (address(fee), 100_000_000));
        b.intent.inputToken = address(fee);
        b.intent.calldataHash = keccak256(b.cd);
        b.intentSig = _sign(OWNER_PK, _digestIntent(b.intent));
        b.cert = _cert(b.intent);
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        _expectRevert(b, ChaconneVerifyGuard.InputTransferShortfall.selector);
    }

    function test_revert_feeOnTransferOutput_recipientShortfall() public {
        FeeOnTransferOut fout = new FeeOnTransferOut();
        MockRouter r2 = new MockRouter(fout);
        r2.setOutput(400e15, true);
        vm.startPrank(admin);
        guard.setToken(address(fout), true);
        guard.setRoute(address(r2), address(r2), true);
        guard.setSelector(address(r2), MockRouter.swap.selector, true);
        vm.stopPrank();
        Bundle memory b = _bundle();
        b.intent.outputToken = address(fout);
        b.intent.router = address(r2);
        b.intent.spender = address(r2);
        b.intentSig = _sign(OWNER_PK, _digestIntent(b.intent));
        b.cert = _cert(b.intent);
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
        // guard receives 396e15 (1 % skimmed on mint→guard? mint is exempt; skim happens guard→recipient) → recipient gets 396e15 < 398e15
        _expectRevert(b, ChaconneVerifyGuard.RecipientShortfall.selector);
    }

    function test_revert_reentrancy_viaRouter() public {
        Bundle memory b = _bundle();
        bytes memory reenter = abi.encodeCall(ChaconneVerifyGuard.execute, (b.intent, b.intentSig, b.cert, b.certSig, b.cd));
        router.setReenter(GUARD_ADDR, reenter);
        vm.prank(user);
        vm.expectRevert(); // RouterCallFailed wrapping ReentrancyGuardReentrantCall / NotOwnerOfIntent
        guard.execute(b.intent, b.intentSig, b.cert, b.certSig, b.cd);
        assertFalse(guard.nonceUsed(user, 7));
        assertEq(usd.balanceOf(user), 1_000_000_000);
    }

    function test_revert_routerRevertBubblesReason() public {
        router.setRevert(true);
        Bundle memory b = _bundle();
        vm.prank(user);
        vm.expectRevert(
            abi.encodeWithSelector(ChaconneVerifyGuard.RouterCallFailed.selector, abi.encodeWithSignature("Error(string)", "router: revert"))
        );
        guard.execute(b.intent, b.intentSig, b.cert, b.certSig, b.cd);
    }

    /* ---------------------------- helpers ---------------------------- */

    function _expectRevert(Bundle memory b, bytes4 selector) internal {
        vm.prank(b.intent.owner);
        vm.expectRevert(selector);
        guard.execute(b.intent, b.intentSig, b.cert, b.certSig, b.cd);
    }
}
