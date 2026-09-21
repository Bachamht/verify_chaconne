// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ChaconneVerifyGuard} from "../../src/ChaconneVerifyGuard.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @dev 1% fee burned on every transfer — must be rejected as input by the Guard
contract FeeOnTransferERC20 is MockERC20 {
    constructor() MockERC20("FeeToken", "FEE", 6) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Configurable router: consumes `consumeBps` of the pulled input and mints `outPerIn`-scaled output.
contract MockRouter {
    MockERC20 public outToken;
    uint256 public consumeBps = 10_000; // 100 %
    uint256 public outputAmount; // fixed output to send
    bool public sendOutput = true;
    bool public shouldRevert;
    address public reenterTarget;
    bytes public reenterData;

    constructor(MockERC20 out) {
        outToken = out;
    }

    function setConsumeBps(uint256 bps) external {
        consumeBps = bps;
    }

    function setOutput(uint256 amt, bool send) external {
        outputAmount = amt;
        sendOutput = send;
    }

    function setRevert(bool r) external {
        shouldRevert = r;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    /// @notice selector 0x… `swap(address,uint256)`: pulls `amountIn * consumeBps / 1e4` of `tokenIn` from msg.sender
    function swap(address tokenIn, uint256 amountIn) external returns (uint256) {
        if (shouldRevert) revert("router: revert");
        uint256 take = (amountIn * consumeBps) / 10_000;
        if (take > 0) IERC20(tokenIn).transferFrom(msg.sender, address(this), take);
        if (reenterTarget != address(0)) {
            (bool ok,) = reenterTarget.call(reenterData);
            require(ok, "reenter failed");
        }
        if (sendOutput) outToken.mint(msg.sender, outputAmount);
        return outputAmount;
    }

    /// @notice a second selector that is NOT allowlisted in tests
    function drain(address token, address to) external {
        IERC20(token).transfer(to, IERC20(token).balanceOf(address(this)));
    }
}

/// @dev Output token that skims 1% on transfer out of the Guard → RecipientShortfall
contract FeeOnTransferOut is MockERC20 {
    constructor() MockERC20("FeeOut", "FOUT", 18) {}

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @dev Rebasing-style input token: every transfer delivers `shortfallWei` less than requested (share rounding),
///      like xStocks EVM tokens can (CV-D05 reverse case). Balance semantics otherwise normal.
contract RebasingShortfallERC20 is MockERC20 {
    uint256 public shortfallWei;

    constructor(uint256 sf) MockERC20("REBASEx", "REBASEx", 18) {
        shortfallWei = sf;
    }

    function setShortfall(uint256 sf) external {
        shortfallWei = sf;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && shortfallWei > 0 && value > shortfallWei) {
            super._update(from, address(0), shortfallWei);
            super._update(from, to, value - shortfallWei);
        } else {
            super._update(from, to, value);
        }
    }
}
