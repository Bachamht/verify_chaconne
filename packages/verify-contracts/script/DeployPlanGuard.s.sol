// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ChaconneVerifyPlanGuard} from "../src/ChaconneVerifyPlanGuard.sol";

/// @notice Deploy PlanGuard v2. Env: DEPLOYER_PRIVATE_KEY, ATTESTATION_SIGNER, GUARD_OWNER (defaults to deployer),
///         SIGNER_EPOCH (default 1), MAX_CERT_TTL_SECONDS (default 120).
///         Allowlists are configured separately by ConfigurePlanGuard.s.sol after operator approval (硬约束①).
contract DeployPlanGuard is Script {
    function run() external returns (ChaconneVerifyPlanGuard guard) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address signer = vm.envAddress("ATTESTATION_SIGNER");
        address owner = vm.envOr("GUARD_OWNER", deployer);
        uint64 epoch = uint64(vm.envOr("SIGNER_EPOCH", uint256(1)));
        uint64 ttl = uint64(vm.envOr("MAX_CERT_TTL_SECONDS", uint256(120)));

        vm.startBroadcast(pk);
        guard = new ChaconneVerifyPlanGuard(owner, signer, epoch, ttl);
        vm.stopBroadcast();

        console2.log("ChaconneVerifyPlanGuard deployed at", address(guard));
        console2.log("chainId", block.chainid);
        console2.log("owner", owner);
        console2.log("attestation signer", signer);
        console2.log("epoch", epoch);
        console2.log("maxCertificateTtl", ttl);
    }
}
