import { encodeFunctionData, keccak256, toBytes, type Address } from 'viem';
import { TEST_ONLY_COUNTER_ABI } from './abi.js';
import type { BatchActionInput } from './types.js';
import { validateActions } from './validation.js';

export type DemoScenario = 'success' | 'mixed' | 'all-fail' | 'gas-isolation' | 'return-cap' | 'refund-credit';
export const DEMO_SCENARIOS: readonly DemoScenario[] = ['success', 'mixed', 'all-fail', 'gas-isolation', 'return-cap', 'refund-credit'];

/** TestOnlyCounter inputs only; no RPC, signing, state or hidden dependencies. */
export function makeDemoActions(target: Address, scenario: DemoScenario, count: number, prefix: string): BatchActionInput[] {
  if (!DEMO_SCENARIOS.includes(scenario)) throw new Error('Unknown test-only demo scenario.');
  if (!Number.isSafeInteger(count) || count < 3 || count > 32) throw new Error('Demo count must be 3..32.');
  const actions: BatchActionInput[] = Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`, target, independent: true, value: '0', gasLimit: '100000',
    calldata: encodeFunctionData({ abi: TEST_ONLY_COUNTER_ABI, functionName: 'setValue',
      args: [keccak256(toBytes(`${prefix}-${i}`)), BigInt(i + 10)] }),
    note: 'TEST-ONLY sender-independent write to a distinct key; target must be a verified TestOnlyCounter.',
  }));
  const middle = Math.floor(count / 2);
  const fail = encodeFunctionData({ abi: TEST_ONLY_COUNTER_ABI, functionName: 'fail' });
  if (scenario === 'all-fail') for (const action of actions) action.calldata = fail;
  else if (scenario === 'mixed') actions[middle]!.calldata = fail;
  else if (scenario === 'gas-isolation') {
    actions[middle]!.calldata = encodeFunctionData({ abi: TEST_ONLY_COUNTER_ABI, functionName: 'burnGas' });
    actions[middle]!.gasLimit = '25000';
  } else if (scenario === 'return-cap') {
    actions[middle]!.calldata = encodeFunctionData({ abi: TEST_ONLY_COUNTER_ABI, functionName: 'largeReturn', args: [16_384n] });
  } else if (scenario === 'refund-credit') {
    actions[middle]!.calldata = fail;
    actions[middle]!.value = '1000';
    actions[middle]!.note = 'TEST-ONLY failed value call; separate owner withdrawal is required for its credit.';
  }
  validateActions(actions);
  return actions;
}
