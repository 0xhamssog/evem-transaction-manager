// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {MockTarget} from "../contracts/MockTarget.sol";
import {MockRevertingTarget} from "../contracts/MockRevertingTarget.sol";

/// @notice Deploys the local mock targets. Not a trading contract.
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        new MockTarget();
        new MockRevertingTarget();
        vm.stopBroadcast();
    }
}
