// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {BatchExecutor} from "../BatchExecutor.sol";
import {TestOnlyCounter} from "../test-only/TestOnlyCounter.sol";

// Minimal Foundry cheatcode interface: no vendored Solidity dependencies.
interface Vm {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function deal(address account, uint256 balance) external;
    function prank(address sender) external;
    function expectRevert(bytes calldata reason) external;
    function expectRevert(bytes4 selector) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract BatchExecutorTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    BatchExecutor private executor;
    TestOnlyCounter private target;
    bytes32 private constant A = keccak256("a");
    bytes32 private constant B = keccak256("b");
    bytes32 private constant C = keccak256("c");

    function setUp() public {
        executor = new BatchExecutor();
        target = new TestOnlyCounter();
        vm.deal(address(this), 10 ether);
    }

    function _actions() private view returns (BatchExecutor.Action[] memory actions) {
        actions = new BatchExecutor.Action[](3);
        actions[0] = BatchExecutor.Action(A, address(target), 0, 100_000, abi.encodeCall(target.setValue, (A, 11)));
        actions[1] = BatchExecutor.Action(B, address(target), 0, 100_000, abi.encodeCall(target.setValue, (B, 22)));
        actions[2] = BatchExecutor.Action(C, address(target), 0, 100_000, abi.encodeCall(target.setValue, (C, 33)));
    }

    function test_three_independent_actions_in_one_call() public {
        BatchExecutor.Result[] memory results = executor.execute(_actions());
        require(results.length == 3 && results[0].success && results[1].success && results[2].success, "all succeed");
        require(target.slots(A) == 11 && target.slots(B) == 22 && target.slots(C) == 33, "independent effects");
    }

    function test_failure_preserves_before_and_runs_after() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].data = abi.encodeCall(target.fail, ());
        BatchExecutor.Result[] memory results = executor.execute(actions);
        require(results[0].success && !results[1].success && results[2].success, "true false true");
        require(target.slots(A) == 11 && target.slots(B) == 0 && target.slots(C) == 33, "remaining ran");
        require(keccak256(results[1].data) == keccak256(abi.encodeWithSignature("Error(string)", "TestOnly: forced failure")), "exact revert data");
    }

    function test_first_failure_does_not_skip_remaining() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[0].data = abi.encodeCall(target.fail, ());
        BatchExecutor.Result[] memory results = executor.execute(actions);
        require(!results[0].success && results[1].success && results[2].success, "remaining succeed");
        require(target.slots(B) == 22 && target.slots(C) == 33, "remaining effects");
    }

    function test_all_failed_calls_still_have_results() public {
        BatchExecutor.Action[] memory actions = _actions();
        for (uint256 i; i < 3; ++i) actions[i].data = abi.encodeCall(target.fail, ());
        BatchExecutor.Result[] memory results = executor.execute(actions);
        require(!results[0].success && !results[1].success && !results[2].success, "all failures recorded");
    }

    function test_gas_exhaustion_is_isolated_and_last_action_runs() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].data = abi.encodeCall(target.burnGas, ());
        actions[1].gasLimit = 25_000;
        BatchExecutor.Result[] memory results = executor.execute(actions);
        require(results[0].success && !results[1].success && results[2].success, "OOG isolated");
        require(target.slots(C) == 33, "last effect survives OOG");
    }

    function test_return_bomb_is_capped_and_last_action_runs() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].data = abi.encodeCall(target.largeReturn, (16_384));
        BatchExecutor.Result[] memory results = executor.execute(actions);
        require(results[1].success, "large return call succeeds");
        require(results[1].data.length == 2_048 && results[1].returnDataSize > 2_048, "bounded copy + full size");
        require(results[2].success && target.slots(C) == 33, "last action survives large return");
    }

    function test_false_return_is_call_success_not_business_success() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].data = abi.encodeCall(target.returnFalse, ());
        BatchExecutor.Result[] memory results = executor.execute(actions);
        require(results[1].success && !abi.decode(results[1].data, (bool)), "honest CALL semantics");
    }

    function test_one_ordered_evidence_event_per_action() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].data = abi.encodeCall(target.fail, ());
        vm.recordLogs();
        executor.execute(actions);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 count;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(executor) && logs[i].topics[0] == BatchExecutor.ActionExecuted.selector) {
                require(uint256(logs[i].topics[1]) == count, "ordered index");
                require(logs[i].topics[2] == actions[count].id, "id evidence");
                (bool success, bytes memory data, uint256 size) = abi.decode(logs[i].data, (bool, bytes, uint256));
                require(success == (count != 1), "success evidence");
                require(data.length == size, "non-truncated size");
                ++count;
            }
        }
        require(count == 3, "exactly three events");
    }

    function test_zero_actions_rejected() public {
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.InvalidCount.selector, 0));
        executor.execute(new BatchExecutor.Action[](0));
    }

    function test_fewer_than_three_rejected() public {
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.InvalidCount.selector, 2));
        executor.execute(new BatchExecutor.Action[](2));
    }

    function test_too_many_actions_rejected() public {
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.InvalidCount.selector, 33));
        executor.execute(new BatchExecutor.Action[](33));
    }

    function test_zero_target_rejected_before_side_effects() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[2].target = address(0);
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.InvalidTarget.selector, 2));
        executor.execute(actions);
        require(target.slots(A) == 0, "fail fast");
    }

    function test_self_target_rejected() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].target = address(executor);
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.InvalidTarget.selector, 1));
        executor.execute(actions);
    }

    function test_calldata_to_eoa_rejected() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].target = address(0xbeef);
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.InvalidTarget.selector, 1));
        executor.execute(actions);
    }

    function test_short_calldata_rejected() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].data = hex"1234";
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.InvalidCalldata.selector, 1));
        executor.execute(actions);
    }

    function test_large_calldata_rejected() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].data = new bytes(4_097);
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.InvalidCalldata.selector, 1));
        executor.execute(actions);
    }

    function test_duplicate_id_rejected_before_side_effects() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[2].id = A;
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.DuplicateId.selector, 2));
        executor.execute(actions);
        require(target.slots(A) == 0, "fail fast duplicate");
    }

    function test_zero_id_rejected() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].id = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.InvalidId.selector, 1));
        executor.execute(actions);
    }

    function test_gas_limit_bounds_enforced() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].gasLimit = 24_999;
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.InvalidGasLimit.selector, 1));
        executor.execute(actions);
        actions[1].gasLimit = 1_000_001;
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.InvalidGasLimit.selector, 1));
        executor.execute(actions);
    }

    function test_insufficient_outer_gas_rejected_before_side_effects() public {
        BatchExecutor.Action[] memory actions = _actions();
        (bool success,) = address(executor).call{gas: 200_000}(abi.encodeCall(executor.execute, (actions)));
        require(!success && target.slots(A) == 0, "insufficient reservation cannot partly commit");
    }

    function test_value_mismatch_rejected_before_side_effects() public {
        BatchExecutor.Action[] memory actions = _actions();
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.ValueMismatch.selector, 1, 0));
        executor.execute{value: 1}(actions);
        require(target.slots(A) == 0, "fail fast value");
    }

    function test_failed_value_credited_and_only_owner_can_withdraw() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].data = abi.encodeCall(target.fail, ());
        actions[1].value = 1 ether;
        BatchExecutor.Result[] memory results = executor.execute{value: 1 ether}(actions);
        require(!results[1].success && results[2].success, "failed value does not abort rest");
        require(executor.refundCredits(address(this)) == 1 ether, "owner credit");
        vm.prank(address(0xbeef));
        vm.expectRevert(BatchExecutor.NoRefund.selector);
        executor.withdrawRefund(payable(address(0xbeef)));
        uint256 beforeBalance = address(0xcafe).balance;
        executor.withdrawRefund(payable(address(0xcafe)));
        require(address(0xcafe).balance == beforeBalance + 1 ether, "credit delivered");
        require(executor.refundCredits(address(this)) == 0 && address(executor).balance == 0, "credit cleared");
    }

    function test_rejecting_receiver_preserves_refund() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].data = abi.encodeCall(target.fail, ());
        actions[1].value = 1;
        executor.execute{value: 1}(actions);
        RejectValue rejector = new RejectValue();
        vm.expectRevert(BatchExecutor.RefundTransferFailed.selector);
        executor.withdrawRefund(payable(address(rejector)));
        require(executor.refundCredits(address(this)) == 1, "credit preserved on failure");
    }

    function test_exact_successful_value_forwarded() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].data = abi.encodeCall(target.deposit, ());
        actions[1].value = 123;
        executor.execute{value: 123}(actions);
        require(address(target).balance == 123 && address(executor).balance == 0, "value forwarded only");
    }

    function test_reentrancy_is_blocked_without_aborting_outer_actions() public {
        ReentrantProbe probe = new ReentrantProbe(executor);
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].target = address(probe);
        actions[1].data = abi.encodeCall(probe.attack, ());
        BatchExecutor.Result[] memory results = executor.execute(actions);
        require(probe.blocked() && results[1].success && results[2].success, "guard observed and rest runs");
    }

    function test_plain_value_transfer_to_executor_rejected() public {
        (bool success,) = address(executor).call{value: 1}("");
        require(!success && address(executor).balance == 0, "no receive function");
    }

    function test_maximum_32_actions_all_execute() public {
        BatchExecutor.Action[] memory actions = new BatchExecutor.Action[](32);
        for (uint256 i; i < 32; ++i) {
            bytes32 id = bytes32(i + 1);
            actions[i] = BatchExecutor.Action(id, address(target), 0, 100_000, abi.encodeCall(target.setValue, (id, i + 11)));
        }
        BatchExecutor.Result[] memory results = executor.execute(actions);
        require(results.length == 32, "maximum count");
        for (uint256 i; i < 32; ++i) require(results[i].success && target.slots(bytes32(i + 1)) == i + 11, "all independent effects");
    }

    function test_31_gas_exhaustions_do_not_abort_last_action() public {
        BatchExecutor.Action[] memory actions = new BatchExecutor.Action[](32);
        for (uint256 i; i < 31; ++i) actions[i] = BatchExecutor.Action(bytes32(i + 1), address(target), 0, 25_000, abi.encodeCall(target.burnGas, ()));
        actions[31] = BatchExecutor.Action(bytes32(uint256(32)), address(target), 0, 100_000, abi.encodeCall(target.setValue, (C, 303)));
        BatchExecutor.Result[] memory results = executor.execute(actions);
        for (uint256 i; i < 31; ++i) require(!results[i].success, "gas failure isolated");
        require(results[31].success && target.slots(C) == 303, "last action executed after 31 OOG calls");
    }

    function test_three_native_transfers_to_distinct_new_accounts() public {
        BatchExecutor.Action[] memory actions = new BatchExecutor.Action[](3);
        for (uint256 i; i < 3; ++i) actions[i] = BatchExecutor.Action(bytes32(i + 1), address(uint160(0xb001 + i)), 123, 25_000, "");
        BatchExecutor.Result[] memory results = executor.execute{value: 369}(actions);
        for (uint256 i; i < 3; ++i) require(results[i].success && address(uint160(0xb001 + i)).balance == 123, "native value forwarded");
        require(address(executor).balance == 0, "no stranded value");
    }

    function test_value_sum_overflow_rejected_before_effects() public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[0].value = type(uint256).max;
        actions[1].value = 1;
        vm.expectRevert(abi.encodeWithSignature("Panic(uint256)", 0x11));
        executor.execute(actions);
        require(target.slots(A) == 0, "overflow fail fast");
    }

    function test_forced_balance_is_not_available_to_batch_callers() public {
        vm.deal(address(executor), 1 ether);
        BatchExecutor.Action[] memory actions = _actions();
        actions[0].value = 1;
        vm.expectRevert(abi.encodeWithSelector(BatchExecutor.ValueMismatch.selector, 0, 1));
        executor.execute(actions);
        vm.expectRevert(BatchExecutor.NoRefund.selector);
        executor.withdrawRefund(payable(address(0xcafe)));
        require(address(executor).balance == 1 ether, "forced balance cannot be claimed");
    }

    function test_invalid_refund_recipients_rejected() public {
        vm.expectRevert(BatchExecutor.InvalidRecipient.selector);
        executor.withdrawRefund(payable(address(0)));
        vm.expectRevert(BatchExecutor.InvalidRecipient.selector);
        executor.withdrawRefund(payable(address(executor)));
    }

    function test_revert_bomb_is_capped_and_last_action_runs() public {
        RevertBomb bomb = new RevertBomb();
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].target = address(bomb);
        actions[1].data = abi.encodeCall(bomb.failLarge, (16_384));
        BatchExecutor.Result[] memory results = executor.execute(actions);
        require(!results[1].success && results[1].data.length == 2_048 && results[1].returnDataSize == 16_384, "bounded revert bytes");
        require(results[2].success && target.slots(C) == 33, "last action survives revert bomb");
    }

    function testFuzz_partial_failure_keeps_independent_effects(uint8 failAt, uint96 first, uint96 second, uint96 third) public {
        BatchExecutor.Action[] memory actions = _actions();
        actions[0].data = abi.encodeCall(target.setValue, (A, first));
        actions[1].data = abi.encodeCall(target.setValue, (B, second));
        actions[2].data = abi.encodeCall(target.setValue, (C, third));
        uint256 index = uint256(failAt) % 3;
        actions[index].data = abi.encodeCall(target.fail, ());
        BatchExecutor.Result[] memory results = executor.execute(actions);
        for (uint256 i; i < 3; ++i) require(results[i].success == (i != index), "per-action outcomes");
        require(target.slots(A) == (index == 0 ? 0 : first), "first effect");
        require(target.slots(B) == (index == 1 ? 0 : second), "second effect");
        require(target.slots(C) == (index == 2 ? 0 : third), "third effect after failure");
    }
}

contract RejectValue { receive() external payable { revert("reject"); } }

contract RevertBomb {
    function failLarge(uint256 size) external pure {
        bytes memory reason = new bytes(size);
        assembly ("memory-safe") { revert(add(reason, 32), mload(reason)) }
    }
}

contract ReentrantProbe {
    BatchExecutor private immutable executor;
    bool public blocked;
    constructor(BatchExecutor executor_) { executor = executor_; }
    function attack() external {
        try executor.execute(new BatchExecutor.Action[](0)) {} catch (bytes memory reason) {
            blocked = reason.length >= 4 && bytes4(reason) == BatchExecutor.ReentrantCall.selector;
        }
    }
}
