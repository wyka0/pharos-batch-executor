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

    function test_caller_is_deployer_bound_with_uniform_runtime_and_no_setter() public {
        address otherCaller = address(0xbeef);
        vm.prank(otherCaller);
        BatchExecutor other = new BatchExecutor();
        require(executor.authorizedCaller() == address(this) && other.authorizedCaller() == otherCaller, "deployer bound");
        require(address(executor).codehash == address(other).codehash, "caller is storage, not runtime substitution");
        (bool changed,) = address(executor).call(abi.encodeWithSignature("setAuthorizedCaller(address)", otherCaller));
        require(!changed && executor.authorizedCaller() == address(this), "no caller rotation path");
    }

    function test_untrusted_caller_cannot_transfer_executor_held_tokens() public {
        TestOnlyToken token = new TestOnlyToken();
        address attacker = address(0xbeef);
        token.mint(address(executor), 100);
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].target = address(token);
        actions[1].data = abi.encodeCall(token.transfer, (attacker, 100));
        vm.expectRevert(BatchExecutor.UnauthorizedCaller.selector);
        vm.prank(attacker);
        executor.execute(actions);
        require(token.balanceOf(address(executor)) == 100 && token.balanceOf(attacker) == 0, "held tokens protected");
        require(target.slots(A) == 0 && target.slots(C) == 0, "authorization precedes every target call");
    }

    function test_untrusted_caller_cannot_consume_third_party_transferFrom_allowance() public {
        TestOnlyToken token = new TestOnlyToken();
        address victim = address(0xcafe);
        address attacker = address(0xbeef);
        token.mint(victim, 100);
        vm.prank(victim);
        token.approve(address(executor), 100);
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].target = address(token);
        actions[1].data = abi.encodeCall(token.transferFrom, (victim, attacker, 100));
        vm.expectRevert(BatchExecutor.UnauthorizedCaller.selector);
        vm.prank(attacker);
        executor.execute(actions);
        require(token.balanceOf(victim) == 100 && token.balanceOf(attacker) == 0, "victim balance protected");
        require(token.allowance(victim, address(executor)) == 100 && target.slots(A) == 0, "allowance not consumed");
    }

    function test_untrusted_caller_cannot_create_executor_approval() public {
        TestOnlyToken token = new TestOnlyToken();
        address attacker = address(0xbeef);
        token.mint(address(executor), 100);
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].target = address(token);
        actions[1].data = abi.encodeCall(token.approve, (attacker, type(uint256).max));
        vm.expectRevert(BatchExecutor.UnauthorizedCaller.selector);
        vm.prank(attacker);
        executor.execute(actions);
        require(token.allowance(address(executor), attacker) == 0 && target.slots(A) == 0, "approval proxy blocked");
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "allowance"));
        vm.prank(attacker);
        token.transferFrom(address(executor), attacker, 100);
        require(token.balanceOf(address(executor)) == 100, "no later allowance drain");
    }

    function test_authorized_caller_can_issue_reviewed_independent_token_calls() public {
        // Separate tokens make these independent; this is not approve-then-spend.
        TestOnlyToken held = new TestOnlyToken();
        TestOnlyToken allowed = new TestOnlyToken();
        TestOnlyToken approved = new TestOnlyToken();
        address victim = address(0xcafe);
        address recipient = address(0xb001);
        held.mint(address(executor), 100);
        allowed.mint(victim, 100);
        vm.prank(victim);
        allowed.approve(address(executor), 50);
        BatchExecutor.Action[] memory actions = new BatchExecutor.Action[](3);
        actions[0] = BatchExecutor.Action(A, address(held), 0, 100_000, abi.encodeCall(held.transfer, (recipient, 25)));
        actions[1] = BatchExecutor.Action(B, address(allowed), 0, 100_000, abi.encodeCall(allowed.transferFrom, (victim, recipient, 25)));
        actions[2] = BatchExecutor.Action(C, address(approved), 0, 100_000, abi.encodeCall(approved.approve, (recipient, 25)));
        BatchExecutor.Result[] memory results = executor.execute(actions);
        require(results[0].success && results[1].success && results[2].success, "trusted caller retains arbitrary reviewed CALLs");
        require(held.balanceOf(recipient) == 25 && allowed.balanceOf(recipient) == 25, "authorized transfers");
        require(allowed.allowance(victim, address(executor)) == 25 && approved.allowance(address(executor), recipient) == 25, "authorized allowance changes");
        require(executor.authorizedCaller() == address(this), "calls cannot change caller");
    }

    function test_forwarding_does_not_bypass_msg_sender_authorization() public {
        TestOnlyToken token = new TestOnlyToken();
        ExecutorForwarder forwarder = new ExecutorForwarder();
        token.mint(address(executor), 100);
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].target = address(token);
        actions[1].data = abi.encodeCall(token.transfer, (address(0xbeef), 100));
        // Even the authorized wallet cannot use an untrusted forwarding caller.
        (bool success, bytes memory reason) = forwarder.forward(executor, actions);
        require(!success && reason.length == 4 && bytes4(reason) == BatchExecutor.UnauthorizedCaller.selector, "no forwarding/tx.origin bypass");
        require(token.balanceOf(address(executor)) == 100 && target.slots(A) == 0, "forwarded calls have no effects");
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

    function test_late_outer_revert_rolls_back_effects_value_refunds_and_logs() public {
        OuterRollbackCaller caller = new OuterRollbackCaller();
        BatchExecutor rollbackExecutor = caller.executor();
        RejectValue rejector = new RejectValue();
        address recipient = address(0xb002);
        uint256 callerBefore = address(this).balance;
        uint256 recipientBefore = recipient.balance;
        BatchExecutor.Action[] memory actions = new BatchExecutor.Action[](5);
        actions[0] = BatchExecutor.Action(A, address(target), 0, 100_000, abi.encodeCall(target.setValue, (A, 11)));
        actions[1] = BatchExecutor.Action(B, address(target), 2 ether, 100_000, abi.encodeCall(target.deposit, ()));
        actions[2] = BatchExecutor.Action(keccak256("native"), recipient, 1 ether, 25_000, "");
        actions[3] = BatchExecutor.Action(keccak256("reject"), address(rejector), 1 ether, 25_000, "");
        actions[4] = BatchExecutor.Action(C, address(target), 0, 100_000, abi.encodeCall(target.setValue, (C, 33)));

        vm.recordLogs();
        (bool success, bytes memory reason) = address(caller).call{value: 4 ether}(
            abi.encodeCall(caller.executeThenMaybeRevert, (actions, true))
        );
        require(!success && reason.length == 4 && bytes4(reason) == OuterRollbackCaller.LateOuterFailure.selector, "real late outer revert, not validation/subcall failure");
        // The helper checks successful state writes, both native transfers and
        // the actual refund credit BEFORE issuing this exact late revert.
        require(target.slots(A) == 0 && target.slots(B) == 0 && target.slots(C) == 0, "all target writes rolled back");
        require(address(target).balance == 0 && recipient.balance == recipientBefore && address(rejector).balance == 0, "all target native transfers rolled back");
        require(address(this).balance == callerBefore && address(caller).balance == 0 && address(rollbackExecutor).balance == 0, "outer native debits and executor balance rolled back");
        require(rollbackExecutor.refundCredits(address(caller)) == 0, "created refund credit rolled back");
        Vm.Log[] memory revertedTrace = vm.getRecordedLogs();
        require(revertedTrace.length == 9, "state/action/refund/batch events genuinely emitted before rollback");

        // Same real batch, without the parent's late revert: the rejecting
        // subcall is isolated, and the final write, transfers and credit commit.
        vm.recordLogs();
        BatchExecutor.Result[] memory results = caller.executeThenMaybeRevert{value: 4 ether}(actions, false);
        require(results.length == 5 && results[0].success && results[1].success && results[2].success && !results[3].success && results[4].success, "subcall failure permits continuation");
        require(keccak256(results[3].data) == keccak256(abi.encodeWithSignature("Error(string)", "reject")), "real rejecting subcall reason");
        require(target.slots(A) == 11 && target.slots(B) == 0 && target.slots(C) == 33, "before and after effects commit in control");
        require(address(target).balance == 2 ether && recipient.balance == recipientBefore + 1 ether && address(rejector).balance == 0, "only successful native transfers commit");
        require(address(this).balance == callerBefore - 4 ether && address(caller).balance == 0, "control native debit accounted");
        require(rollbackExecutor.refundCredits(address(caller)) == 1 ether && address(rollbackExecutor).balance == 1 ether, "control credit is backed by retained native value");
        Vm.Log[] memory controlLogs = vm.getRecordedLogs();
        require(keccak256(abi.encode(revertedTrace)) == keccak256(abi.encode(controlLogs)), "identical events emitted in rollback and continuing control");
        // Foundry 1.2 records reverted trace logs too. scripts/test-contracts.mjs
        // asserts ZERO surviving logs from the reverted call using real EVM
        // call-frame revert ancestry, with these nine control logs as a check.
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

    function test_refund_callback_blocks_nested_withdraw_and_execute_without_double_payment() public {
        RefundReentrantRecipient probe = new RefundReentrantRecipient();
        BatchExecutor refundExecutor = probe.executor();
        require(refundExecutor.authorizedCaller() == address(probe), "callback is both credit owner and authorized caller, not an authorization-only rejection");
        // Spare forced balance makes an illicit duplicate payment observable.
        vm.deal(address(refundExecutor), 2 ether);
        uint256 callerBefore = address(this).balance;
        BatchExecutor.Action[] memory actions = _actions();
        actions[1].data = abi.encodeCall(target.fail, ());
        actions[1].value = 1 ether;
        BatchExecutor.Result[] memory results = probe.execute{value: 1 ether}(actions);
        require(results[0].success && !results[1].success && results[2].success, "real failed-value credit with continuing effects");
        require(refundExecutor.refundCredits(address(probe)) == 1 ether && address(refundExecutor).balance == 3 ether, "credit fully backed plus unclaimable reserve");
        require(address(probe).balance == 0 && address(this).balance == callerBefore - 1 ether, "initial native debit accounted");

        BatchExecutor.Action[] memory nested = _actions();
        nested[0].data = abi.encodeCall(target.setValue, (A, 101));
        nested[1].data = abi.encodeCall(target.setValue, (B, 202));
        nested[2].data = abi.encodeCall(target.setValue, (C, 303));
        vm.recordLogs();
        probe.withdrawWithAttack(nested);
        require(probe.withdrawBlocked() && probe.executeBlocked(), "both real nested calls return exact ReentrantCall");
        require(probe.callbacks() == 1 && probe.received() == 1 ether && address(probe).balance == 1 ether, "one callback and one actual payment only");
        require(probe.creditDuringCallback() == 0 && probe.balanceDuringCallback() == 2 ether, "credit cleared and balance debited before callback");
        require(refundExecutor.refundCredits(address(probe)) == 0 && address(refundExecutor).balance == 2 ether, "no duplicate refund or reserve drain");
        require(target.slots(A) == 11 && target.slots(B) == 0 && target.slots(C) == 33, "nested execute caused no effects");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        require(logs.length == 1 && logs[0].emitter == address(refundExecutor) && logs[0].topics.length == 3 && logs[0].topics[0] == BatchExecutor.RefundWithdrawn.selector, "exactly one withdrawal event and no nested batch events");
        require(logs[0].topics[1] == bytes32(uint256(uint160(address(probe)))) && logs[0].topics[2] == logs[0].topics[1] && abi.decode(logs[0].data, (uint256)) == 1 ether, "single owner/recipient/amount evidence");

        // The very same valid nested batch now succeeds outside the callback.
        results = probe.execute(nested);
        require(results[0].success && results[1].success && results[2].success && target.slots(A) == 101 && target.slots(B) == 202 && target.slots(C) == 303, "guard unlocked and execute remains usable");
        actions[1].value = 2 ether;
        results = probe.execute{value: 2 ether}(actions);
        require(!results[1].success && results[2].success && refundExecutor.refundCredits(address(probe)) == 2 ether && address(refundExecutor).balance == 4 ether, "fresh refund lifecycle remains usable");
        address payable recipient = payable(address(0xcafe));
        uint256 recipientBefore = recipient.balance;
        probe.withdrawTo(recipient);
        require(recipient.balance == recipientBefore + 2 ether && refundExecutor.refundCredits(address(probe)) == 0 && address(refundExecutor).balance == 2 ether, "subsequent withdrawal pays exactly fresh credit");
        require(probe.callbacks() == 1 && address(probe).balance == 1 ether && address(this).balance == callerBefore - 3 ether, "complete native accounting and no later duplicate callback");
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

    function test_valid_32_default_gas_actions_exceed_runner_ceiling_before_effects() public {
        BatchExecutor.Action[] memory actions = _manyActions(32, 100_000);
        (bool success, bytes memory reason) = address(executor).call{gas: 5_000_000}(abi.encodeCall(executor.execute, (actions)));
        require(!success && reason.length >= 4 && bytes4(reason) == BatchExecutor.InsufficientBatchGas.selector, "count bounds do not imply gas feasibility");
        for (uint256 i; i < 32; ++i) require(target.slots(bytes32(i + 1)) == 0, "no oversized-plan effects");
    }

    function test_valid_five_max_gas_actions_exceed_runner_ceiling_before_effects() public {
        BatchExecutor.Action[] memory actions = _manyActions(5, 1_000_000);
        (bool success, bytes memory reason) = address(executor).call{gas: 5_000_000}(abi.encodeCall(executor.execute, (actions)));
        require(!success && reason.length >= 4 && bytes4(reason) == BatchExecutor.InsufficientBatchGas.selector, "coupled gas bounds");
        for (uint256 i; i < 5; ++i) require(target.slots(bytes32(i + 1)) == 0, "no partial effects");
    }

    function _manyActions(uint256 count, uint256 gasLimit) private view returns (BatchExecutor.Action[] memory actions) {
        actions = new BatchExecutor.Action[](count);
        for (uint256 i; i < count; ++i) {
            bytes32 id = bytes32(i + 1);
            actions[i] = BatchExecutor.Action(id, address(target), 0, gasLimit, abi.encodeCall(target.setValue, (id, i + 11)));
        }
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

// In-process test fixtures only: not deployment artifacts or production tokens.
contract TestOnlyToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address recipient, uint256 amount) external { balanceOf[recipient] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address recipient, uint256 amount) external returns (bool) {
        _transfer(msg.sender, recipient, amount);
        return true;
    }
    function transferFrom(address owner, address recipient, uint256 amount) external returns (bool) {
        require(allowance[owner][msg.sender] >= amount, "allowance");
        allowance[owner][msg.sender] -= amount;
        _transfer(owner, recipient, amount);
        return true;
    }
    function _transfer(address owner, address recipient, uint256 amount) private {
        require(balanceOf[owner] >= amount, "balance");
        balanceOf[owner] -= amount;
        balanceOf[recipient] += amount;
    }
}

contract ExecutorForwarder {
    function forward(BatchExecutor executor, BatchExecutor.Action[] calldata actions) external returns (bool, bytes memory) {
        return address(executor).call(abi.encodeCall(executor.execute, (actions)));
    }
}

// A malicious refund recipient that owns its credit AND deployed its executor.
// This isolates the shared guard from both NoRefund and caller authorization.
contract RefundReentrantRecipient {
    BatchExecutor public immutable executor;
    bytes private nestedExecution;
    uint256 public callbacks;
    uint256 public received;
    uint256 public creditDuringCallback;
    uint256 public balanceDuringCallback;
    bool public withdrawBlocked;
    bool public executeBlocked;

    constructor() { executor = new BatchExecutor(); }

    function execute(BatchExecutor.Action[] calldata actions) external payable returns (BatchExecutor.Result[] memory) {
        return executor.execute{value: msg.value}(actions);
    }
    function withdrawWithAttack(BatchExecutor.Action[] calldata actions) external {
        nestedExecution = abi.encodeCall(executor.execute, (actions));
        executor.withdrawRefund(payable(address(this)));
    }
    function withdrawTo(address payable recipient) external { executor.withdrawRefund(recipient); }

    receive() external payable {
        require(msg.sender == address(executor), "refund fixture sender");
        ++callbacks;
        received += msg.value;
        creditDuringCallback = executor.refundCredits(address(this));
        balanceDuringCallback = address(executor).balance;
        (bool withdrew, bytes memory withdrawReason) = address(executor).call(
            abi.encodeCall(executor.withdrawRefund, (payable(address(this))))
        );
        withdrawBlocked = !withdrew && withdrawReason.length == 4 && bytes4(withdrawReason) == BatchExecutor.ReentrantCall.selector;
        (bool executed, bytes memory executeReason) = address(executor).call(nestedExecution);
        executeBlocked = !executed && executeReason.length == 4 && bytes4(executeReason) == BatchExecutor.ReentrantCall.selector;
    }
}

// Deterministic, test-only late parent revert: no production revert hook, gas
// assumptions, storage corruption, RPC transaction or mocked receipt involved.
contract OuterRollbackCaller {
    BatchExecutor public immutable executor;
    error LateOuterFailure();

    constructor() { executor = new BatchExecutor(); }

    function executeThenMaybeRevert(BatchExecutor.Action[] calldata actions, bool revertAfter)
        external payable returns (BatchExecutor.Result[] memory results)
    {
        uint256 targetBefore = actions[1].target.balance;
        uint256 recipientBefore = actions[2].target.balance;
        uint256 creditBefore = executor.refundCredits(address(this));
        uint256 executorBefore = address(executor).balance;
        results = executor.execute{value: msg.value}(actions);
        require(results.length == 5 && results[0].success && results[1].success && results[2].success && !results[3].success && results[4].success, "batch completed through real subcall failure");
        TestOnlyCounter counter = TestOnlyCounter(actions[0].target);
        require(counter.slots(actions[0].id) == 11 && counter.slots(actions[4].id) == 33, "real before/after state writes precede late condition");
        require(actions[1].target.balance == targetBefore + actions[1].value && actions[2].target.balance == recipientBefore + actions[2].value, "both real native transfers precede late condition");
        require(executor.refundCredits(address(this)) == creditBefore + actions[3].value && address(executor).balance == executorBefore + actions[3].value, "real backed refund credit precedes late condition");
        if (revertAfter) revert LateOuterFailure();
    }
}
