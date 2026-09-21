// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ChaconneVerifyPlanGuard} from "../src/ChaconneVerifyPlanGuard.sol";

/// @notice Double-implementation cross-check for v2 (§0 反幻觉): constants below were produced by
///         packages/core/src/verify/eip712.ts (itself cross-checked against viem in
///         packages/core/test/verify.eip712v2.test.ts) via script/goldenV2.ts, for domain (196, 0x1234…7890).
contract PlanGuardEip712CrossCheckTest is Test {
    address constant GUARD_ADDR = 0x1234567890123456789012345678901234567890;
    address constant A = 0x9d275685dC284C8eB1C79f6ABA7a63Dc75ec890a;
    address constant N = 0x0D3Db2D6a4Ca2C2b6A2aE9d4e2C3F7e6A1b2c3d4;

    bytes32 constant TS_TRADE_MANDATE_TYPEHASH = 0xb7cf925026b59f4db9a5150a2c2db209a84d4460fd6efac7c64baef562af7dc2;
    bytes32 constant TS_MANDATE_STEP_TYPEHASH = 0x49e6449bc8af826219d398ed9024b055326a73aadabcc5322510702949ba4e69;
    bytes32 constant TS_STEP_CERT_TYPEHASH = 0x60abe1560bc660de772ff99828bf507a65712cbf680a491ca1dbff9b50e10c22;
    bytes32 constant TS_DOMAIN_SEPARATOR = 0x2b88a28859652ad08f4ef9e130ac565176994b7fdcd6cab4d59bd79e59f71107;
    bytes32 constant TS_OUTPUT_SET_HASH = 0x86d6a48c06cef9c738a5c4f9f66b6b7b64223bfaf4e417a388234018909bedb4;
    bytes32 constant TS_MANDATE_STRUCT_HASH = 0x842c81e0da2f3a8aa1f11583a2779c46a2604d80d354e32d5e15adeed505e684;
    bytes32 constant TS_MANDATE_DIGEST = 0xd4c8f429d89bb17f9cb512202fef2df7bd88c83d80197566acd15f8a1edd0763;
    bytes32 constant TS_STEP_STRUCT_HASH = 0xbe2de8533bdfaf7e39a65fd3e5e89a67273a7ffada04b5aa259b6a25435dcbac;
    bytes32 constant TS_STEP_DIGEST = 0xe4504dfd194dfee8ab6fdaa3c35dfebf89aa320f6c2c52265c9428a067426876;
    bytes32 constant TS_CERT_STRUCT_HASH = 0x6a7c90024c4bae477289f0b38fcee12044b57c365ccebc3a22ef1325aeac0bce;
    bytes32 constant TS_CERT_DIGEST = 0xe2bfd478738868a8031c0f76c6a2c1172573031575c32302f880603a881b48ce;

    ChaconneVerifyPlanGuard guard;

    function setUp() public {
        vm.chainId(196);
        ChaconneVerifyPlanGuard impl = new ChaconneVerifyPlanGuard(address(this), address(0xABCD), 1, 120);
        vm.etch(GUARD_ADDR, address(impl).code); // digests are pure/view; no storage needed
        guard = ChaconneVerifyPlanGuard(GUARD_ADDR);
    }

    function _mandate() internal pure returns (ChaconneVerifyPlanGuard.TradeMandate memory m) {
        m = ChaconneVerifyPlanGuard.TradeMandate({
            owner: 0xbaCB138e0e9E1444Bae9b401C4615378C57c0381,
            recipient: 0xbaCB138e0e9E1444Bae9b401C4615378C57c0381,
            inputToken: 0x4ae46a509F6b1D9056937BA4500cb143933D2dc8,
            outputSetHash: TS_OUTPUT_SET_HASH,
            budgetCap: 10000000,
            perStepCap: 5000000,
            maxSteps: 3,
            policyDefinitionHash: 0x1111111111111111111111111111111111111111111111111111111111111111,
            effectivePolicyHash: 0x2222222222222222222222222222222222222222222222222222222222222222,
            registryHash: 0x3333333333333333333333333333333333333333333333333333333333333333,
            validFrom: 1789900000,
            deadline: 1790000000,
            nonce: 7
        });
    }

    function _step() internal pure returns (ChaconneVerifyPlanGuard.Step memory s) {
        s = ChaconneVerifyPlanGuard.Step({
            mandateDigest: TS_MANDATE_DIGEST,
            stepIndex: 0,
            outputToken: A,
            amountIn: 5000000,
            minAmountOut: 14908660368714889,
            router: 0x7c5bEE2a8091C3ef39072f64F18Fac913060AEaF,
            spender: 0x8b773D83bc66Be128c60e07E17C8901f7a64F000,
            calldataHash: 0x4444444444444444444444444444444444444444444444444444444444444444,
            evidenceHash: 0x5555555555555555555555555555555555555555555555555555555555555555,
            deadline: 1789909931
        });
    }

    function test_typehashes_matchTs() public view {
        assertEq(guard.TRADE_MANDATE_TYPEHASH(), TS_TRADE_MANDATE_TYPEHASH);
        assertEq(guard.MANDATE_STEP_TYPEHASH(), TS_MANDATE_STEP_TYPEHASH);
        assertEq(guard.STEP_CERTIFICATE_TYPEHASH(), TS_STEP_CERT_TYPEHASH);
    }

    function test_domainSeparator_matchesTs() public view {
        assertEq(block.chainid, 196);
        assertEq(guard.domainSeparator(), TS_DOMAIN_SEPARATOR);
    }

    function test_outputSetHash_matchesTs_sortedList() public view {
        address[] memory set = new address[](2);
        set[0] = N; // 0x0d… < 0x9d…
        set[1] = A;
        assertEq(guard.computeOutputSetHash(set), TS_OUTPUT_SET_HASH);
        assertEq(keccak256(abi.encodePacked(N, A)), TS_OUTPUT_SET_HASH, "tight 20-byte packing");
        assertNotEq(
            keccak256(abi.encodePacked(set)), TS_OUTPUT_SET_HASH, "abi.encodePacked(address[]) pads to 32 bytes"
        );
    }

    function test_outputSetHash_rejectsUnsorted() public {
        address[] memory set = new address[](2);
        set[0] = A;
        set[1] = N;
        vm.expectRevert(ChaconneVerifyPlanGuard.OutputSetNotSorted.selector);
        guard.computeOutputSetHash(set);
    }

    function test_mandateHashes_matchTs() public view {
        assertEq(guard.hashMandate(_mandate()), TS_MANDATE_STRUCT_HASH);
        assertEq(guard.mandateDigest(_mandate()), TS_MANDATE_DIGEST);
    }

    function test_stepAndCertificate_matchTs() public view {
        assertEq(guard.hashStep(_step()), TS_STEP_STRUCT_HASH);
        assertEq(guard.stepDigest(_step()), TS_STEP_DIGEST);
        ChaconneVerifyPlanGuard.StepCertificate memory c = ChaconneVerifyPlanGuard.StepCertificate({
            stepDigest: TS_STEP_DIGEST,
            evidenceHash: 0x5555555555555555555555555555555555555555555555555555555555555555,
            policyDefinitionHash: 0x1111111111111111111111111111111111111111111111111111111111111111,
            effectivePolicyHash: 0x2222222222222222222222222222222222222222222222222222222222222222,
            issuedAt: 1789909871,
            validUntil: 1789909931,
            signerEpoch: 1
        });
        assertEq(guard.hashCertificate(c), TS_CERT_STRUCT_HASH);
        assertEq(guard.certificateDigest(c), TS_CERT_DIGEST);
    }
}
