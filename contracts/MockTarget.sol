// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Deterministic successful call target for transaction-manager tests.
contract MockTarget {
    uint256 public callCount;
    uint256 public lastValue;

    event Executed(address indexed caller, uint256 value, uint256 input);

    function ping(uint256 input) external payable returns (uint256) {
        callCount += 1;
        lastValue = input;
        emit Executed(msg.sender, msg.value, input);
        return input;
    }
}
