/** Pure unsigned-plan bounds. SYNTHETIC estimates, no RPC or signer. */
import { keccak256 } from 'viem';
import { describe, expect, it } from 'vitest';
import { minimumBatchTransactionGas, requiredExecutionGas } from '../src/limits.js';
import { preparePlan } from '../src/plan.js';
import { broadcastPlanHash, MAX_TRANSACTION_GAS, verifyApproval } from '../src/testnet/broadcast-plan.js';
import { validateActions } from '../src/validation.js';
import { batchPlan } from './broadcast-fixtures.js';
import { threeActions } from './fixtures.js';

function planWith(count: number, gasLimit: bigint) {
  const plan = batchPlan();
  const inputs = Array.from({ length: count }, (_, i) => ({ ...threeActions()[0]!, id: `bound-${i}`, gasLimit: gasLimit.toString() }));
  const actions = validateActions(inputs);
  const prepared = preparePlan(actions);
  plan.actions = inputs;
  plan.targetCodeHashes = Object.fromEntries(actions.map((a) => [a.target, keccak256('0x00')]));
  plan.expectedSimulation = actions.map((a) => ({ id: a.id, success: true, returnData: '0x', returnDataSize: '0' }));
  plan.gasEstimates = { blockNumber: '10', batch: '1000000', individual: actions.map((a) => ({ id: a.id, gas: '30000' })) };
  Object.assign(plan.transactions[0]!, { data: prepared.batchCalldata, estimatedGas: '1000000', gasLimit: MAX_TRANSACTION_GAS.toString() });
  plan.maximumCostWei = (MAX_TRANSACTION_GAS * BigInt(plan.gasPriceWei)).toString();
  return { plan, prepared };
}

describe('coupled action count and runner gas bounds', () => {
  it('accepts 32 action syntax without pretending the default gas reserve fits the runner ceiling', () => {
    const { plan, prepared } = planWith(32, 100_000n);
    expect(prepared.actions).toHaveLength(32);
    expect(requiredExecutionGas(prepared.actions)).toBe(5_230_816n);
    expect(minimumBatchTransactionGas(prepared.actions, prepared.batchCalldata)).toBeGreaterThan(MAX_TRANSACTION_GAS);
    expect(() => verifyApproval(plan, broadcastPlanHash(plan), true)).toThrow(/execution reservation/);
  });

  it.each([31, 32])('rejects %i default-gas actions under the unchanged 5,000,000 transaction ceiling', (count) => {
    const { plan } = planWith(count, 100_000n);
    expect(() => verifyApproval(plan, broadcastPlanHash(plan), true)).toThrow(/accepted action counts do not guarantee/);
  });

  it.each([5, 32])('rejects %i individually valid maximum-gas calls when their combined reserve is oversized', (count) => {
    const { plan, prepared } = planWith(count, 1_000_000n);
    expect(requiredExecutionGas(prepared.actions)).toBeGreaterThan(MAX_TRANSACTION_GAS);
    expect(() => verifyApproval(plan, broadcastPlanHash(plan), true)).toThrow(/execution reservation/);
  });

  it.each([[32, 25_000n], [3, 1_000_000n]] as const)('allows count %i / call cap %s when the necessary reservation fits, without guaranteeing actual execution', (count, gasLimit) => {
    const { plan, prepared } = planWith(count, gasLimit);
    expect(minimumBatchTransactionGas(prepared.actions, prepared.batchCalldata)).toBeLessThan(MAX_TRANSACTION_GAS);
    expect(() => verifyApproval(plan, broadcastPlanHash(plan), true)).not.toThrow();
  });

  it('rejects even a small plan whose approved gas omits intrinsic/calldata costs', () => {
    const { plan, prepared } = planWith(3, 100_000n);
    const minimum = minimumBatchTransactionGas(prepared.actions, prepared.batchCalldata);
    Object.assign(plan.transactions[0]!, { gasLimit: (minimum - 1n).toString(), estimatedGas: (minimum - 2n).toString() });
    plan.maximumCostWei = ((minimum - 1n) * BigInt(plan.gasPriceWei)).toString();
    expect(() => verifyApproval(plan, broadcastPlanHash(plan), true)).toThrow(/intrinsic\/calldata gas/);
  });
});
