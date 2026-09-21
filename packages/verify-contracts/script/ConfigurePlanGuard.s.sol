// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ChaconneVerifyPlanGuard} from "../src/ChaconneVerifyPlanGuard.sol";

/// @notice Apply operator-approved allowlists to PlanGuard from config/<CONFIG_NAME>.json
///         (default config/xlayer.planguard.json). JSON shape (all lists may be empty):
///         {
///           "planGuard": "0x…",
///           "policies": ["0x…"],  "registries": ["0x…"],  "tokens": ["0x…"],
///           "routeCount": 1, "routes": [{"router":"0x…","spender":"0x…","selectors":["0x12345678"]}],
///           "toleranceCount": 2, "tolerances": [{"token":"0x…","wei":"1000000"}]
///         }
///         Every address must be double-source verified and operator-approved (docs/devday-2026/the address-approval log (internal)).
contract ConfigurePlanGuard is Script {
    using stdJson for string;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        string memory name = vm.envOr("CONFIG_NAME", string("xlayer.planguard"));
        string memory json = vm.readFile(string.concat("config/", name, ".json"));

        ChaconneVerifyPlanGuard guard = ChaconneVerifyPlanGuard(json.readAddress(".planGuard"));
        bytes32[] memory policies = json.readBytes32Array(".policies");
        bytes32[] memory registries = json.readBytes32Array(".registries");
        address[] memory tokens = json.readAddressArray(".tokens");
        uint256 routeCount = json.readUint(".routeCount");
        uint256 toleranceCount = json.readUint(".toleranceCount");

        vm.startBroadcast(pk);
        for (uint256 i = 0; i < policies.length; i++) {
            guard.setPolicy(policies[i], true);
        }
        for (uint256 i = 0; i < registries.length; i++) {
            guard.setRegistry(registries[i], true);
        }
        for (uint256 i = 0; i < tokens.length; i++) {
            guard.setToken(tokens[i], true);
        }
        for (uint256 i = 0; i < routeCount; i++) {
            string memory base = string.concat(".routes[", vm.toString(i), "]");
            address router = json.readAddress(string.concat(base, ".router"));
            address spender = json.readAddress(string.concat(base, ".spender"));
            bytes[] memory selectors = json.readBytesArray(string.concat(base, ".selectors"));
            guard.setRoute(router, spender, true);
            for (uint256 j = 0; j < selectors.length; j++) {
                guard.setSelector(router, bytes4(selectors[j]), true);
            }
        }
        for (uint256 i = 0; i < toleranceCount; i++) {
            string memory base = string.concat(".tolerances[", vm.toString(i), "]");
            address token = json.readAddress(string.concat(base, ".token"));
            uint256 tol = json.readUint(string.concat(base, ".wei"));
            guard.setInputShortfallTolerance(token, tol);
        }
        vm.stopBroadcast();
        console2.log("configured planGuard", address(guard));
    }
}
