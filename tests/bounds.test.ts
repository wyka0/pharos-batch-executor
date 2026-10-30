/** Pure unsigned-plan bounds. SYNTHETIC estimates, no RPC or signer. */
import { encodeAbiParameters, keccak256, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { makeDemoActions } from '../src/demo-actions.js';
import { minimumBatchTransactionGas, requiredExecutionGas, UINT256_MAX } from '../src/limits.js';
import { preparePlan } from '../src/plan.js';
import { plannedBatchGasLimit } from '../src/testnet/build-plan.js';
import { broadcastPlanHash, MAX_TRANSACTION_GAS, transactionPayloadHash, verifyApproval, type BroadcastPlan } from '../src/testnet/broadcast-plan.js';
import { validateActions } from '../src/validation.js';
import { batchPlan, sealPayloads } from './broadcast-fixtures.js';
import { threeActions } from './fixtures.js';

const ATLANTIC_COUNTER = '0xD54115B2c5698AAf468aa3d6623A3Dc3A650b47E' as Address;

/** Re-stamp the complete payload hash after synthetic mutation of the plan. */
function reseal(plan: BroadcastPlan): void {
  const tx = plan.transactions[0]!;
  tx.type = 'legacy';
  tx.payloadHash = transactionPayloadHash(plan, tx);
}

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
  reseal(plan);
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
    reseal(plan);
    expect(() => verifyApproval(plan, broadcastPlanHash(plan), true)).toThrow(/intrinsic\/calldata gas/);
  });
});

describe('conservative batch planner gas selection', () => {
  it('raises the observed three-action success estimate above the authoritative minimum and passes verifyApproval', () => {
    const inputs = makeDemoActions(ATLANTIC_COUNTER, 'success', 3, 'success-5');
    const actions = validateActions(inputs);
    const prepared = preparePlan(actions);
    const minimum = minimumBatchTransactionGas(actions, prepared.batchCalldata);
    const selected = plannedBatchGasLimit(171_832n, actions, prepared.batchCalldata);
    expect(requiredExecutionGas(actions)).toBe(544_764n);
    expect(minimum).toBe(573_392n);
    expect(selected).toBe(688_071n);
    expect(selected).toBeGreaterThanOrEqual(minimum);
    expect(selected).toBeGreaterThan((171_832n * 12_000n + 9_999n) / 10_000n);

    const plan = batchPlan();
    plan.actions = inputs;
    plan.targetCodeHashes = { [ATLANTIC_COUNTER]: keccak256('0x00') };
    plan.expectedSimulation = actions.map((action, i) => ({ id: action.id, success: true,
      returnData: encodeAbiParameters([{ type: 'uint256' }], [BigInt(i + 10)]), returnDataSize: '32' }));
    plan.gasEstimates = { blockNumber: '10', batch: '171832', individual: actions.map((action) => ({ id: action.id, gas: '58447' })) };
    Object.assign(plan.transactions[0]!, { data: prepared.batchCalldata, estimatedGas: '171832', gasLimit: selected.toString() });
    sealPayloads(plan);
    expect(() => verifyApproval(plan, broadcastPlanHash(plan), true)).not.toThrow();
    expect(transactionPayloadHash(plan, plan.transactions[0]!)).toBe(plan.transactions[0]!.payloadHash);
    expect(broadcastPlanHash(structuredClone(plan))).toBe(broadcastPlanHash(plan));
  });

  it('raises the observed mixed success/failure/success estimate above its calldata-specific minimum', () => {
    const actions = validateActions(makeDemoActions(ATLANTIC_COUNTER, 'mixed', 3, 'mixed-5'));
    const prepared = preparePlan(actions);
    const selected = plannedBatchGasLimit(143_258n, actions, prepared.batchCalldata);
    expect(minimumBatchTransactionGas(actions, prepared.batchCalldata)).toBe(572_740n);
    expect(selected).toBe(687_288n);
    expect(selected).toBeGreaterThanOrEqual(572_740n);
    expect(selected).toBeGreaterThan((143_258n * 12_000n + 9_999n) / 10_000n);
  });

  it('never drops below the configured RPC margin when the estimate dominates', () => {
    const actions = validateActions(makeDemoActions(ATLANTIC_COUNTER, 'success', 3, 'margin'));
    const calldata = preparePlan(actions).batchCalldata;
    expect(plannedBatchGasLimit(1_000_000n, actions, calldata)).toBe(1_200_000n);
  });

  it('increases for larger per-action caps and larger calldata', () => {
    const inputs = makeDemoActions(ATLANTIC_COUNTER, 'success', 3, 'growth');
    const normal = validateActions(inputs);
    const normalData = preparePlan(normal).batchCalldata;
    const largerCaps = validateActions(inputs.map((action) => ({ ...action, gasLimit: '200000' })));
    const largerCapData = preparePlan(largerCaps).batchCalldata;
    const largerCalldata = validateActions(inputs.map((action) => ({ ...action, calldata: `0x${'ff'.repeat(1_000)}` })));
    const largerData = preparePlan(largerCalldata).batchCalldata;
    expect(minimumBatchTransactionGas(largerCaps, largerCapData)).toBeGreaterThan(minimumBatchTransactionGas(normal, normalData));
    expect(minimumBatchTransactionGas(largerCalldata, largerData)).toBeGreaterThan(minimumBatchTransactionGas(normal, normalData));
  });

  it('retains the runner ceiling and handles bigint boundaries without arithmetic overflow', () => {
    const actions = validateActions(makeDemoActions(ATLANTIC_COUNTER, 'success', 32, 'ceiling'));
    const calldata = preparePlan(actions).batchCalldata;
    expect(plannedBatchGasLimit(1_000_000n, actions, calldata)).toBeGreaterThan(MAX_TRANSACTION_GAS);
    expect(plannedBatchGasLimit(UINT256_MAX, actions.slice(0, 3), preparePlan(actions.slice(0, 3)).batchCalldata)).toBeGreaterThan(UINT256_MAX);
  });

  it('continues to reject empty and oversized action lists before gas planning', () => {
    expect(() => validateActions([])).toThrow(/at least/);
    expect(() => validateActions(Array.from({ length: 33 }, (_, i) => ({ ...threeActions()[0]!, id: `invalid-${i}` })))).toThrow(/on-chain limit|at most/);
  });
});
