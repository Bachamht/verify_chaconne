// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChaconneVerifyPlanGuard} from "../src/ChaconneVerifyPlanGuard.sol";
import {MockERC20, MockRouter} from "./mocks/Mocks.sol";

/// @dev Shared fixture for PlanGuard v2 tests: one stablecoin input, two stock outputs, a configurable mock router.
abstract contract PlanGuardBase is Test {
    ChaconneVerifyPlanGuard internal guard;
    MockERC20 internal usd; // 6 dec input
    MockERC20 internal stockA; // 18 dec output (router mints this)
    MockERC20 internal stockB; // second member of the output set
    MockRouter internal router;

    uint256 internal constant OWNER_PK = 0xA11CE;
    uint256 internal constant SIGNER_PK = 0x5163;
    uint256 internal constant ADMIN_PK = 0xAD;
    address internal user;
    address internal signer;
    address internal admin;
    address internal recipient = address(0xBEEF);
    address internal executor = address(0xE0E0);

    bytes32 internal constant POLICY_HASH = bytes32(uint256(0x01));
    bytes32 internal constant EFFECTIVE_HASH = bytes32(uint256(0x02));
    bytes32 internal constant REGISTRY_HASH = bytes32(uint256(0x03));
    bytes32 internal constant EVIDENCE_HASH = bytes32(uint256(0x04));
    uint64 internal constant EPOCH = 1;
    uint64 internal constant MAX_TTL = 120;
    uint256 internal constant BUDGET = 250_000_000; // 250 USD
    uint256 internal constant PER_STEP = 100_000_000; // 100 USD
    uint32 internal constant MAX_STEPS = 3;
    uint256 internal constant STEP_AMOUNT = 100_000_000;
    uint256 internal constant STEP_OUT = 400e15;

    address[] internal outputSet;

    function setUp() public virtual {
        vm.chainId(196);
        vm.warp(1_789_000_000);
        user = vm.addr(OWNER_PK);
        signer = vm.addr(SIGNER_PK);
        admin = vm.addr(ADMIN_PK);

        usd = new MockERC20("USD", "USD", 6);
        // deploy both stocks, then order the set by address
        MockERC20 s1 = new MockERC20("AAAx", "AAAx", 18);
        MockERC20 s2 = new MockERC20("BBBx", "BBBx", 18);
        (stockA, stockB) = address(s1) < address(s2) ? (s1, s2) : (s2, s1);
        outputSet.push(address(stockA));
        outputSet.push(address(stockB));
        router = new MockRouter(stockA);

        guard = new ChaconneVerifyPlanGuard(admin, signer, EPOCH, MAX_TTL);

        vm.startPrank(admin);
        guard.setPolicy(POLICY_HASH, true);
        guard.setRegistry(REGISTRY_HASH, true);
        guard.setRoute(address(router), address(router), true);
        guard.setSelector(address(router), MockRouter.swap.selector, true);
        guard.setToken(address(usd), true);
        guard.setToken(address(stockA), true);
        guard.setToken(address(stockB), true);
        vm.stopPrank();

        usd.mint(user, 1_000_000_000); // 1000 USD
        vm.prank(user);
        usd.approve(address(guard), type(uint256).max);
        router.setOutput(STEP_OUT, true);
    }

    /* ------------------------------ builders ------------------------------ */

    /// @dev same rule as the contract / core eip712.ts: tight 20-byte concat of sorted addresses
    function _setHash(address[] memory set) internal pure returns (bytes32) {
        bytes memory buf;
        for (uint256 i = 0; i < set.length; i++) {
            buf = abi.encodePacked(buf, set[i]);
        }
        return keccak256(buf);
    }

    function _mandate() internal view returns (ChaconneVerifyPlanGuard.TradeMandate memory m) {
        m = ChaconneVerifyPlanGuard.TradeMandate({
            owner: user,
            recipient: recipient,
            inputToken: address(usd),
            outputSetHash: _setHash(outputSet),
            budgetCap: BUDGET,
            perStepCap: PER_STEP,
            maxSteps: MAX_STEPS,
            policyDefinitionHash: POLICY_HASH,
            effectivePolicyHash: EFFECTIVE_HASH,
            registryHash: REGISTRY_HASH,
            validFrom: uint64(block.timestamp),
            deadline: uint64(block.timestamp + 3600),
            nonce: 11
        });
    }

    function _calldata(uint256 amountIn) internal view returns (bytes memory) {
        return abi.encodeCall(MockRouter.swap, (address(usd), amountIn));
    }

    function _step(bytes32 mDigest, uint32 index, uint256 amountIn, bytes memory cd)
        internal
        view
        returns (ChaconneVerifyPlanGuard.Step memory s)
    {
        s = ChaconneVerifyPlanGuard.Step({
            mandateDigest: mDigest,
            stepIndex: index,
            outputToken: address(stockA),
            amountIn: amountIn,
            minAmountOut: STEP_OUT - 2e15,
            router: address(router),
            spender: address(router),
            calldataHash: keccak256(cd),
            evidenceHash: EVIDENCE_HASH,
            deadline: uint64(block.timestamp + 60)
        });
    }

    function _cert(ChaconneVerifyPlanGuard.Step memory s, bytes32 policyHash, bytes32 effHash)
        internal
        view
        returns (ChaconneVerifyPlanGuard.StepCertificate memory c)
    {
        c = ChaconneVerifyPlanGuard.StepCertificate({
            stepDigest: _digestStep(s),
            evidenceHash: s.evidenceHash,
            policyDefinitionHash: policyHash,
            effectivePolicyHash: effHash,
            issuedAt: uint64(block.timestamp),
            validUntil: uint64(block.timestamp + 60),
            signerEpoch: EPOCH
        });
    }

    /* ------------------------------ digests ------------------------------ */

    function _digestMandate(ChaconneVerifyPlanGuard.TradeMandate memory m) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                guard.TRADE_MANDATE_TYPEHASH(),
                m.owner,
                m.recipient,
                m.inputToken,
                m.outputSetHash,
                m.budgetCap,
                m.perStepCap,
                m.maxSteps,
                m.policyDefinitionHash,
                m.effectivePolicyHash,
                m.registryHash,
                m.validFrom,
                m.deadline,
                m.nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", guard.domainSeparator(), structHash));
    }

    function _digestStep(ChaconneVerifyPlanGuard.Step memory s) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                guard.MANDATE_STEP_TYPEHASH(),
                s.mandateDigest,
                s.stepIndex,
                s.outputToken,
                s.amountIn,
                s.minAmountOut,
                s.router,
                s.spender,
                s.calldataHash,
                s.evidenceHash,
                s.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", guard.domainSeparator(), structHash));
    }

    function _digestCert(ChaconneVerifyPlanGuard.StepCertificate memory c) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                guard.STEP_CERTIFICATE_TYPEHASH(),
                c.stepDigest,
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

    /* ------------------------------ bundles ------------------------------ */

    struct Bundle {
        ChaconneVerifyPlanGuard.TradeMandate mandate;
        bytes mandateSig;
        address[] set;
        ChaconneVerifyPlanGuard.Step step;
        ChaconneVerifyPlanGuard.StepCertificate cert;
        bytes certSig;
        bytes cd;
    }

    /// @dev fully valid bundle for step `index` under the default mandate
    function _bundle(uint32 index) internal view returns (Bundle memory b) {
        b.mandate = _mandate();
        b.mandateSig = _sign(OWNER_PK, _digestMandate(b.mandate));
        b.set = outputSet;
        b.cd = _calldata(STEP_AMOUNT);
        b.step = _step(_digestMandate(b.mandate), index, STEP_AMOUNT, b.cd);
        b.cert = _cert(b.step, POLICY_HASH, EFFECTIVE_HASH);
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
    }

    /// @dev re-sign step certificate after the caller mutated `b.step` (keeps mandate signature)
    function _resignStep(Bundle memory b) internal view {
        b.cert = _cert(b.step, b.mandate.policyDefinitionHash, b.mandate.effectivePolicyHash);
        b.certSig = _sign(SIGNER_PK, _digestCert(b.cert));
    }

    /// @dev re-sign both mandate (by owner) and step/cert after mutating `b.mandate`
    function _resignAll(Bundle memory b) internal view {
        b.mandateSig = _sign(OWNER_PK, _digestMandate(b.mandate));
        b.step.mandateDigest = _digestMandate(b.mandate);
        _resignStep(b);
    }

    function _exec(Bundle memory b) internal returns (uint256 spent, uint256 received, uint256 refunded) {
        return _execAs(b, executor);
    }

    function _execAs(Bundle memory b, address who)
        internal
        returns (uint256 spent, uint256 received, uint256 refunded)
    {
        vm.prank(who);
        return guard.executeStep(b.mandate, b.mandateSig, b.set, b.step, b.cert, b.certSig, b.cd);
    }
}
