// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GuardBase} from "./GuardBase.t.sol";
import {ChaconneVerifyGuard} from "../src/ChaconneVerifyGuard.sol";

/// @notice Double-implementation cross-check (§0 反幻觉): values below were produced by the TypeScript encoder
///         packages/core/src/verify/eip712.ts (itself cross-checked against viem) for domain (196, 0x4444…4444)
///         with the fixture intent from packages/core/test/verify.eip712.test.ts.
contract Eip712CrossCheckTest is GuardBase {
    bytes32 constant TS_TRADE_INTENT_TYPEHASH = 0x5a0cd095cfb29c2a6d5dedf346f80119fd95d7877f7702efaeb100e338d0e9fb;
    bytes32 constant TS_CERT_TYPEHASH = 0x187869047f9f4524e2b01a088ef09ed23302bbd31a85c3bdd6c4ecc0aeb74ba3;
    bytes32 constant TS_DOMAIN_SEPARATOR = 0xa231c56a6a16aac4e56e2718adee4fc698772a56f653de262be0d4d4c8c332af;
    bytes32 constant TS_INTENT_STRUCT_HASH = 0x040d7d8e7085643cf6a3f27f2b459dae9121430c9dd265e30e97c776b8f81b77;
    bytes32 constant TS_INTENT_DIGEST = 0xfd46a43d81af40af6586e9a8c928b16486fc718678a9da64f6be34de02f4d553;
    bytes32 constant TS_CERT_DIGEST = 0xac07fed64289abefc76661a0cad8f02a3b0c321448232727dfba2c5503ac3b5e;
    bytes32 constant TS_CALLDATA_HASH = 0xd4fd4e189132273036449fc9e11198c739161b4c0116a9a2dccdfa1c492006f1;

    function _tsIntent() internal pure returns (ChaconneVerifyGuard.TradeIntent memory it) {
        it = ChaconneVerifyGuard.TradeIntent({
            owner: 0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa,
            recipient: 0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB,
            inputToken: 0x1111111111111111111111111111111111111111,
            outputToken: 0x2222222222222222222222222222222222222222,
            amountIn: 100000000,
            minAmountOut: 398000000000000000,
            router: 0x5555555555555555555555555555555555555555,
            spender: 0x6666666666666666666666666666666666666666,
            calldataHash: TS_CALLDATA_HASH,
            policyDefinitionHash: 0x0101010101010101010101010101010101010101010101010101010101010101,
            effectivePolicyHash: 0x0202020202020202020202020202020202020202020202020202020202020202,
            registryHash: 0x0303030303030303030303030303030303030303030303030303030303030303,
            evidenceHash: 0x0404040404040404040404040404040404040404040404040404040404040404,
            nonce: 7,
            deadline: 1789000060
        });
    }

    function test_typehashes_matchTs() public view {
        assertEq(guard.TRADE_INTENT_TYPEHASH(), TS_TRADE_INTENT_TYPEHASH);
        assertEq(guard.VERIFICATION_CERTIFICATE_TYPEHASH(), TS_CERT_TYPEHASH);
    }

    function test_domainSeparator_matchesTs() public view {
        assertEq(block.chainid, 196);
        assertEq(address(guard), GUARD_ADDR);
        assertEq(guard.domainSeparator(), TS_DOMAIN_SEPARATOR);
    }

    function test_intentHashes_matchTs() public view {
        ChaconneVerifyGuard.TradeIntent memory it = _tsIntent();
        assertEq(guard.hashIntent(it), TS_INTENT_STRUCT_HASH);
        assertEq(guard.intentDigest(it), TS_INTENT_DIGEST);
        assertEq(keccak256(hex"deadbeef"), TS_CALLDATA_HASH);
    }

    function test_certificateDigest_matchesTs() public view {
        ChaconneVerifyGuard.VerificationCertificate memory c = ChaconneVerifyGuard.VerificationCertificate({
            intentDigest: TS_INTENT_DIGEST,
            evidenceHash: 0x0404040404040404040404040404040404040404040404040404040404040404,
            policyDefinitionHash: 0x0101010101010101010101010101010101010101010101010101010101010101,
            effectivePolicyHash: 0x0202020202020202020202020202020202020202020202020202020202020202,
            issuedAt: 1789000000,
            validUntil: 1789000060,
            signerEpoch: 1
        });
        assertEq(guard.certificateDigest(c), TS_CERT_DIGEST);
    }
}
