// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Local-fork-only test router for apps/verify-service/scripts/e2eV7.ts (fixture evidence mode, no OKX route).
///         Never deployed outside a local anvil fork. It pulls whatever input allowance the caller granted
///         (PlanGuard grants exactly the pulled amount) and pays a fixed output amount from its own pre-funded balance.
contract E2EForkRouter {
    /// @param tokenIn   input token (pulled from msg.sender up to its allowance to this router)
    /// @param tokenOut  output token (paid from this router's balance)
    /// @param amountOut output amount sent back to msg.sender
    function swap(address tokenIn, address tokenOut, uint256 amountOut) external returns (uint256) {
        uint256 take = IERC20(tokenIn).allowance(msg.sender, address(this));
        require(take > 0, "router: no allowance");
        require(IERC20(tokenIn).transferFrom(msg.sender, address(this), take), "router: pull failed");
        require(IERC20(tokenOut).transfer(msg.sender, amountOut), "router: pay failed");
        return amountOut;
    }
}
