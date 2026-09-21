// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {GuardBase} from "./GuardBase.t.sol";
import {ChaconneVerifyGuard} from "../src/ChaconneVerifyGuard.sol";
import {MockERC20, MockRouter} from "./mocks/Mocks.sol";

/// @dev Handler: random users execute random (valid) intents with random router consumption/outputs.
contract GuardHandler is GuardBase {
    uint256 public totalSpent;
    uint256 public totalRefunded;
    uint256 public totalReceived;
    uint256 public executions;
    uint256 public donatedUsd;
    uint256 public donatedStock;
    uint256 internal nextNonce = 100;

    function setUp() public override {
        super.setUp();
    }

    function usdToken() external view returns (MockERC20) { return usd; }
    function stockToken() external view returns (MockERC20) { return stock; }
    function routerAddr() external view returns (address) { return address(router); }
    function userAddr() external view returns (address) { return user; }
    function recipientAddr() external view returns (address) { return recipient; }

    function execute(uint256 amountIn, uint256 consumeBps, uint256 outAmount, uint256 minOutBps) external {
        amountIn = bound(amountIn, 1, 50_000_000);
        consumeBps = bound(consumeBps, 0, 10_000);
        outAmount = bound(outAmount, 1, 1e18);
        minOutBps = bound(minOutBps, 1, 10_000);
        router.setConsumeBps(consumeBps);
        router.setOutput(outAmount, true);

        bytes memory cd = abi.encodeCall(MockRouter.swap, (address(usd), amountIn));
        ChaconneVerifyGuard.TradeIntent memory it = _intent(cd);
        it.amountIn = amountIn;
        it.minAmountOut = (outAmount * minOutBps) / 10_000;
        if (it.minAmountOut == 0) it.minAmountOut = 1;
        it.nonce = nextNonce++;
        it.deadline = uint64(block.timestamp + 60);
        bytes memory intentSig = _sign(OWNER_PK, _digestIntent(it));
        ChaconneVerifyGuard.VerificationCertificate memory c = _cert(it);
        bytes memory certSig = _sign(SIGNER_PK, _digestCert(c));

        uint256 userBefore = usd.balanceOf(user);
        uint256 recBefore = stock.balanceOf(recipient);
        vm.prank(user);
        (uint256 spent, uint256 received, uint256 refunded) = guard.execute(it, intentSig, c, certSig, cd);
        executions++;
        totalSpent += spent;
        totalRefunded += refunded;
        totalReceived += received;
        require(spent + refunded == amountIn, "conservation");
        require(userBefore - usd.balanceOf(user) == spent, "owner pays exactly spent");
        require(stock.balanceOf(recipient) - recBefore == received, "recipient gets received");
        require(received >= it.minAmountOut, "minOut");
    }

    function donate(uint256 a, uint256 b) external {
        a = bound(a, 0, 1_000_000);
        b = bound(b, 0, 1e18);
        usd.mint(GUARD_ADDR, a);
        stock.mint(GUARD_ADDR, b);
        donatedUsd += a;
        donatedStock += b;
    }
}

contract GuardInvariantTest is Test {
    GuardHandler handler;

    function setUp() public {
        handler = new GuardHandler();
        handler.setUp();
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = GuardHandler.execute.selector;
        selectors[1] = GuardHandler.donate.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Guard never accumulates user funds: its balances equal exactly what outsiders donated.
    function invariant_guardHoldsOnlyDonations() public view {
        assertEq(handler.usdToken().balanceOf(0x4444444444444444444444444444444444444444), handler.donatedUsd());
        assertEq(handler.stockToken().balanceOf(0x4444444444444444444444444444444444444444), handler.donatedStock());
    }

    /// @notice Router allowance is always cleared after execution.
    function invariant_noResidualAllowance() public view {
        assertEq(handler.usdToken().allowance(0x4444444444444444444444444444444444444444, handler.routerAddr()), 0);
    }

    /// @notice Conservation across all executions: spent + refunded == sum of amountIn; user paid exactly totalSpent.
    function invariant_conservation() public view {
        assertEq(handler.usdToken().balanceOf(handler.userAddr()), 1_000_000_000 - handler.totalSpent());
        assertEq(handler.stockToken().balanceOf(handler.recipientAddr()), handler.totalReceived());
    }
}
