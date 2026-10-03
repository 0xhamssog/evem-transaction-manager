// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockTarget} from "../contracts/MockTarget.sol";
import {MockRevertingTarget} from "../contracts/MockRevertingTarget.sol";

contract MockTargetTest is Test {
    MockTarget internal target;

    function setUp() public {
        target = new MockTarget();
    }

    function test_pingSucceeds() public {
        uint256 returned = target.ping{value: 1 ether}(7);
        assertEq(returned, 7);
        assertEq(target.callCount(), 1);
        assertEq(target.lastValue(), 7);
    }

    function testFuzz_pingReturnsInput(uint256 input) public {
        assertEq(target.ping(input), input);
        assertEq(target.callCount(), 1);
        assertEq(target.lastValue(), input);
    }
}

contract MockRevertingTargetTest is Test {
    MockRevertingTarget internal target;

    function setUp() public {
        target = new MockRevertingTarget();
    }

    function test_failReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(MockRevertingTarget.AlwaysReverts.selector, "intentional revert")
        );
        target.fail();
    }

    function testFuzz_failAlwaysReverts(uint256) public {
        vm.expectRevert(
            abi.encodeWithSelector(MockRevertingTarget.AlwaysReverts.selector, "intentional revert")
        );
        target.fail();
    }
}

contract MockTargetHandler is Test {
    MockTarget public target;
    uint256 public calls;

    constructor(MockTarget target_) {
        target = target_;
    }

    function ping(uint96 input) external {
        target.ping(input);
        calls += 1;
    }
}

contract MockTargetInvariantTest is Test {
    MockTarget internal target;
    MockTargetHandler internal handler;

    function setUp() public {
        target = new MockTarget();
        handler = new MockTargetHandler(target);
        targetContract(address(handler));
    }

    function invariant_callCountMatchesSuccessfulPings() public view {
        assertEq(target.callCount(), handler.calls());
    }
}
