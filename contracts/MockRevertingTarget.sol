// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Call target that always reverts. Used to prove reverted receipts are not retried.
contract MockRevertingTarget {
    error AlwaysReverts(string reason);

    function fail() external pure {
        revert AlwaysReverts("intentional revert");
    }
}
