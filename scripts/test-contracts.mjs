import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { toEventSelector, toFunctionSelector } from 'viem';
import { root, runForge, wslPath } from './tooling.mjs';

runForge(['test', '-vv', '--offline']);

// Foundry 1.2's recordLogs AND JSON logs include reverted emissions. Project
// surviving logs from real call frames: a failed ancestor discards every log
// in its subtree, including logs from successful executor/target descendants.
// Re-run only the rollback regression with traces; no RPC or receipt mock.
const testName = 'test_late_outer_revert_rolls_back_effects_value_refunds_and_logs';
const args = ['test', '--offline', '--match-contract', 'BatchExecutorTest', '--match-test', testName, '--json', '-vvvv'];
const windows = process.platform === 'win32';
const command = windows ? 'wsl.exe' : (process.env.FORGE_BIN ?? 'forge');
const toolArgs = windows
  ? ['-d', process.env.WSL_DISTRO ?? 'Ubuntu', '--', ...(process.env.FORGE_BIN
    ? [process.env.FORGE_BIN]
    : ['/bin/bash', wslPath(`${root}/scripts/forge-session.sh`)]), ...args, '--root', wslPath(root)]
  : [...args, '--root', root];
const result = spawnSync(command, toolArgs, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 10_000_000 });
assert.equal(result.status, 0, 'Offline rollback trace test failed.');
const report = JSON.parse(result.stdout);
const test = report['contracts/test/BatchExecutor.t.sol:BatchExecutorTest']?.test_results[`${testName}()`];
assert.equal(test?.status, 'Success', 'The exact rollback regression must pass.');
const executions = test.traces.filter(([kind]) => kind === 'Execution');
assert.equal(executions.length, 1, 'One in-process test execution required.');
const { arena } = executions[0][1];
assert.equal(arena[0].trace.success, true, 'The enclosing test must commit its continuing control.');

function orderedLogs(index, committedOnly) {
  const node = arena[index];
  assert(node, 'Missing EVM call frame.');
  if (committedOnly && !node.trace.success) return [];
  return node.ordering.flatMap((item) => {
    if ('Call' in item) return orderedLogs(node.children[item.Call], committedOnly);
    assert('Log' in item, 'Unexpected Foundry trace ordering format.');
    const log = node.logs[item.Log];
    assert(log, 'Missing EVM log entry.');
    return [{ address: node.trace.address, ...log.raw_log }];
  });
}

const outerSelector = toFunctionSelector('executeThenMaybeRevert((bytes32,address,uint256,uint256,bytes)[],bool)');
const calls = arena.filter(({ trace }) => trace.data.startsWith(outerSelector));
assert.equal(calls.length, 2, 'Exactly one rolled-back call and its identical continuing control required.');
const reverted = calls.find(({ trace }) => !trace.success);
const control = calls.find(({ trace }) => trace.success);
assert(reverted && control, 'Both real EVM outcomes required.');
assert.equal(reverted.trace.status, 'Revert');
assert.equal(reverted.trace.output, toFunctionSelector('LateOuterFailure()'), 'The failure must be the late parent condition.');
assert.equal(reverted.trace.address, control.trace.address, 'Both cases must use the same authorized outer caller.');
const executeSelector = toFunctionSelector('execute((bytes32,address,uint256,uint256,bytes)[])');
for (const call of calls) {
  assert.equal(call.parent, 0, 'The real outer call must be directly enclosed by the test.');
  assert.equal(BigInt(call.trace.value), 4n * 10n ** 18n, 'Both cases must transfer the complete real native budget.');
  const batches = call.children.map((index) => arena[index]).filter(({ trace }) => trace.data.startsWith(executeSelector));
  assert.equal(batches.length, 1, 'One real executor batch per outer call required.');
  assert.equal(batches[0].trace.success, true, 'The batch must finish its effects and refund credit before the parent condition.');
}

const revertedEmissions = orderedLogs(reverted.idx, false);
const controlLogs = orderedLogs(control.idx, true);
assert.equal(revertedEmissions.length, 9, 'Non-vacuous rollback: state, action, refund and batch events must actually be emitted.');
assert.deepEqual(revertedEmissions, controlLogs, 'Identical effects must emit identical logs in the continuing control.');
for (const [signature, count] of [
  ['ValueSet(bytes32,uint256)', 2],
  ['ActionExecuted(uint256,bytes32,address,bool,bytes,uint256)', 5],
  ['RefundCredited(address,uint256)', 1],
  ['BatchExecuted(address,uint256,uint256,uint256)', 1],
]) assert.equal(controlLogs.filter(({ topics }) => topics[0] === toEventSelector(signature)).length, count, signature);
assert.deepEqual(orderedLogs(reverted.idx, true), [], 'No log in the reverted outer subtree can survive.');
assert.deepEqual(orderedLogs(0, true), controlLogs, 'Only continuing-control logs may survive the complete test execution.');
console.log('Rollback log checks passed: nine real emissions discarded by the late outer revert; only the nine continuing-control logs survive.');
