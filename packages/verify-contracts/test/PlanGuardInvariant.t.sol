// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PlanGuardBase} from "./PlanGuardBase.t.sol";
import {ChaconneVerifyPlanGuard} from "../src/ChaconneVerifyPlanGuard.sol";
import {MockERC20, MockRouter} from "./mocks/Mocks.sol";

/// @dev Handler: random executors submit random valid steps of one mandate (random router consumption / output),
///      random donations, random revokes/re-mandates.
contract PlanGuardHandler is PlanGuardBase {
    uint256 public totalSpent;
    uint256 public totalRefunded;
    uint256 public totalReceived;
    uint256 public donatedUsd;
    uint256 public donatedStock;
    uint256 public mandateNonce = 100;
    uint32 public stepsDone;
    uint256 public spentInMandate;

    function setUp() public override {
        super.setUp();
    }

    function usdToken() external view returns (MockERC20) {
        return usd;
    }

    function stockToken() external view returns (MockERC20) {
        return stockA;
    }

    function guardAddr() external view returns (address) {
        return address(guard);
    }

    function routerAddr() external view returns (address) {
        return address(router);
    }

    function userAddr() external view returns (address) {
        return user;
    }

    function recipientAddr() external view returns (address) {
        return recipient;
    }

    function budgetCap() external pure returns (uint256) {
        return BUDGET;
    }

    function currentMandate() internal view returns (ChaconneVerifyPlanGuard.TradeMandate memory m) {
        m = _mandate();
        m.nonce = mandateNonce;
    }

    function step(uint256 amountIn, uint256 consumeBps, uint256 outAmount, uint256 minOutBps, uint256 who) external {
        amountIn = bound(amountIn, 1, PER_STEP);
        consumeBps = bound(consumeBps, 0, 10_000);
        outAmount = bound(outAmount, 1, 1e18);
        minOutBps = bound(minOutBps, 1, 10_000);
        router.setConsumeBps(consumeBps);
        router.setOutput(outAmount, true);
        if (stepsDone >= MAX_STEPS || spentInMandate + amountIn > BUDGET) {
            // rotate to a fresh mandate
            mandateNonce += 1;
            stepsDone = 0;
            spentInMandate = 0;
        }
        ChaconneVerifyPlanGuard.TradeMandate memory m = currentMandate();
        bytes32 md = _digestMandate(m);
        bytes memory cd = _calldata(amountIn);
        ChaconneVerifyPlanGuard.Step memory s = _step(md, stepsDone, amountIn, cd);
        s.minAmountOut = (outAmount * minOutBps) / 10_000;
        if (s.minAmountOut == 0) s.minAmountOut = 1;
        ChaconneVerifyPlanGuard.StepCertificate memory c = _cert(s, POLICY_HASH, EFFECTIVE_HASH);
        bytes memory certSig = _sign(SIGNER_PK, _digestCert(c));
        bytes memory mSig = _sign(OWNER_PK, md);
        address exec = who % 2 == 0 ? executor : user;

        uint256 userBefore = usd.balanceOf(user);
        uint256 recBefore = stockA.balanceOf(recipient);
        vm.prank(exec);
        (uint256 spent, uint256 received, uint256 refunded) = guard.executeStep(m, mSig, outputSet, s, c, certSig, cd);
        stepsDone += 1;
        spentInMandate += spent;
        totalSpent += spent;
        totalRefunded += refunded;
        totalReceived += received;
        require(spent + refunded == amountIn, "conservation");
        require(userBefore - usd.balanceOf(user) == spent, "owner pays exactly spent");
        require(stockA.balanceOf(recipient) - recBefore == received, "recipient gets received");
        (uint256 sp, uint32 st,) = guard.mandateState(md);
        require(sp == spentInMandate && st == stepsDone, "state tracks");
        require(sp <= BUDGET, "budget");
    }

    function donate(uint256 a, uint256 b) external {
        a = bound(a, 0, 1_000_000);
        b = bound(b, 0, 1e18);
        usd.mint(address(guard), a);
        stockA.mint(address(guard), b);
        donatedUsd += a;
        donatedStock += b;
    }

    function revoke() external {
        ChaconneVerifyPlanGuard.TradeMandate memory m = currentMandate();
        vm.prank(user);
        guard.revokeMandate(m);
        mandateNonce += 1;
        stepsDone = 0;
        spentInMandate = 0;
    }
}

contract PlanGuardInvariantTest is Test {
    PlanGuardHandler handler;

    function setUp() public {
        handler = new PlanGuardHandler();
        handler.setUp();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = PlanGuardHandler.step.selector;
        selectors[1] = PlanGuardHandler.donate.selector;
        selectors[2] = PlanGuardHandler.revoke.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Σspent of the live mandate never exceeds its budgetCap (checked per step in the handler; here globally).
    function invariant_spentWithinBudget() public view {
        assertLe(handler.spentInMandate(), handler.budgetCap());
    }

    /// @notice Guard never accumulates user funds: balances equal exactly what outsiders donated.
    function invariant_guardHoldsOnlyDonations() public view {
        assertEq(handler.usdToken().balanceOf(handler.guardAddr()), handler.donatedUsd());
        assertEq(handler.stockToken().balanceOf(handler.guardAddr()), handler.donatedStock());
    }

    /// @notice Router allowance is always cleared after execution.
    function invariant_noResidualAllowance() public view {
        assertEq(handler.usdToken().allowance(handler.guardAddr(), handler.routerAddr()), 0);
    }

    /// @notice Conservation across all executions.
    function invariant_conservation() public view {
        assertEq(handler.usdToken().balanceOf(handler.userAddr()), 1_000_000_000 - handler.totalSpent());
        assertEq(handler.stockToken().balanceOf(handler.recipientAddr()), handler.totalReceived());
    }
}
