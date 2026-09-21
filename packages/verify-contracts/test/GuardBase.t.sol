// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChaconneVerifyGuard} from "../src/ChaconneVerifyGuard.sol";
import {MockERC20, MockRouter} from "./mocks/Mocks.sol";

/// @dev Shared fixture: guard deployed at the frozen test address 0x4444…4444 on chainId 196 so that EIP-712 digests
///      can be cross-checked against the TypeScript implementation (packages/core/test/verify.eip712.test.ts).
abstract contract GuardBase is Test {
    ChaconneVerifyGuard internal guard;
    MockERC20 internal usd; // 6 dec input
    MockERC20 internal stock; // 18 dec output
    MockRouter internal router;

    address internal constant GUARD_ADDR = 0x4444444444444444444444444444444444444444;
    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant SIGNER_PK = 0x5163;
    uint256 internal constant ADMIN_PK = 0xAD;
    address internal user;
    address internal signer;
    address internal admin;
    address internal recipient = address(0xBEEF);

    bytes32 internal constant POLICY_HASH = bytes32(uint256(0x01));
    bytes32 internal constant EFFECTIVE_HASH = bytes32(uint256(0x02));
    bytes32 internal constant REGISTRY_HASH = bytes32(uint256(0x03));
    bytes32 internal constant EVIDENCE_HASH = bytes32(uint256(0x04));
    uint64 internal constant EPOCH = 1;
    uint64 internal constant MAX_TTL = 120;

    function setUp() public virtual {
        vm.chainId(196);
        vm.warp(1_789_000_000);
        user = vm.addr(OWNER_PK);
        signer = vm.addr(SIGNER_PK);
        admin = vm.addr(ADMIN_PK);

        usd = new MockERC20("USD", "USD", 6);
        stock = new MockERC20("FAKEx", "FAKEx", 18);
        router = new MockRouter(stock);

        ChaconneVerifyGuard impl = new ChaconneVerifyGuard(admin, signer, EPOCH, MAX_TTL);
        // place at frozen address (copy code + storage-independent: constructor state must be re-applied)
        vm.etch(GUARD_ADDR, address(impl).code);
        guard = ChaconneVerifyGuard(GUARD_ADDR);
        // re-run constructor effects on the etched instance via admin calls (etch copies code only)
        _bootstrapAt(GUARD_ADDR);

        vm.startPrank(admin);
        guard.setPolicy(POLICY_HASH, true);
        guard.setRegistry(REGISTRY_HASH, true);
        guard.setRoute(address(router), address(router), true);
        guard.setSelector(address(router), MockRouter.swap.selector, true);
        guard.setToken(address(usd), true);
        guard.setToken(address(stock), true);
        vm.stopPrank();

        usd.mint(user, 1_000_000_000); // 1000 USD
        vm.prank(user);
        usd.approve(GUARD_ADDR, type(uint256).max);
        router.setOutput(400e15, true); // 0.4 stock
    }

    /// @dev vm.etch copies only bytecode; constructor-set storage must be written directly.
    ///      Layout (forge inspect, OZ 5.4): slot 2 = [_paused (1 byte, offset 0) | _owner (20 bytes, offset 1)];
    ///      ReentrancyGuard uses transient storage; EIP712 name/version are immutables (in code).
    function _bootstrapAt(address at) internal {
        vm.store(at, bytes32(uint256(2)), bytes32(uint256(uint160(admin)) << 8));
        vm.prank(admin);
        ChaconneVerifyGuard(at).setSignerEpoch(EPOCH, signer, true);
        vm.prank(admin);
        ChaconneVerifyGuard(at).setMaxCertificateTtl(MAX_TTL);
    }

    function _calldata() internal view returns (bytes memory) {
        return abi.encodeCall(MockRouter.swap, (address(usd), 100_000_000));
    }

    function _intent(bytes memory cd) internal view returns (ChaconneVerifyGuard.TradeIntent memory it) {
        it = ChaconneVerifyGuard.TradeIntent({
            owner: user,
            recipient: recipient,
            inputToken: address(usd),
            outputToken: address(stock),
            amountIn: 100_000_000,
            minAmountOut: 398e15,
            router: address(router),
            spender: address(router),
            calldataHash: keccak256(cd),
            policyDefinitionHash: POLICY_HASH,
            effectivePolicyHash: EFFECTIVE_HASH,
            registryHash: REGISTRY_HASH,
            evidenceHash: EVIDENCE_HASH,
            nonce: 7,
            deadline: uint64(block.timestamp + 60)
        });
    }

    function _cert(ChaconneVerifyGuard.TradeIntent memory it)
        internal
        view
        returns (ChaconneVerifyGuard.VerificationCertificate memory c)
    {
        c = ChaconneVerifyGuard.VerificationCertificate({
            intentDigest: _digestIntent(it),
            evidenceHash: it.evidenceHash,
            policyDefinitionHash: it.policyDefinitionHash,
            effectivePolicyHash: it.effectivePolicyHash,
            issuedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 60),
            signerEpoch: EPOCH
        });
    }

    function _digestIntent(ChaconneVerifyGuard.TradeIntent memory it) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                guard.TRADE_INTENT_TYPEHASH(),
                it.owner,
                it.recipient,
                it.inputToken,
                it.outputToken,
                it.amountIn,
                it.minAmountOut,
                it.router,
                it.spender,
                it.calldataHash,
                it.policyDefinitionHash,
                it.effectivePolicyHash,
                it.registryHash,
                it.evidenceHash,
                it.nonce,
                it.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", guard.domainSeparator(), structHash));
    }

    function _digestCert(ChaconneVerifyGuard.VerificationCertificate memory c) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                guard.VERIFICATION_CERTIFICATE_TYPEHASH(),
                c.intentDigest,
                c.evidenceHash,
                c.policyDefinitionHash,
                c.effectivePolicyHash,
                c.issuedAt,
                c.validUntil,
                c.signerEpoch
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", guard.domainSeparator(), structHash));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    struct Bundle {
        ChaconneVerifyGuard.TradeIntent intent;
        bytes intentSig;
        ChaconneVerifyGuard.VerificationCertificate cert;
        bytes certSig;
        bytes cd;
    }

    function _bundle() internal view returns (Bundle memory b) {
        b.cd = _calldata();
        b.intent = _intent(b.cd);
        b.intentSig = _sign(OWNER_PK, _digestIntent(b.intent));
        b.cert = _cert(b.intent);
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
    }

    function _exec(Bundle memory b) internal returns (uint256 spent, uint256 received, uint256 refunded) {
        vm.prank(b.intent.owner);
        return guard.execute(b.intent, b.intentSig, b.cert, b.certSig, b.cd);
    }
}
