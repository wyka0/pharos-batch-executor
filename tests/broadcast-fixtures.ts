/** SYNTHETIC unit plans. Never deployment or blockchain evidence. */
import { getContractAddress, keccak256, type Address } from 'viem';
import { ATLANTIC } from '../src/network.js';
import { preparePlan } from '../src/plan.js';
import type { BroadcastPlan } from '../src/testnet/broadcast-plan.js';
import { validateActions } from '../src/validation.js';
import { ACCOUNT, EXECUTOR, threeActions } from './fixtures.js';

export function deployPlan(sender: Address = ACCOUNT): BroadcastPlan {
  const now = Date.now();
  return {
    schemaVersion: 1, skill: 'pharos-batch-executor', purpose: 'deploy', network: ATLANTIC, sender,
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    planningBlockNumber: '10', gasPriceWei: '10000000000', maximumCostWei: '2400000000000000',
    transactions: (['BatchExecutor', 'TestOnlyCounter'] as const).map((name, i) => ({
      id: `deploy-${name}`, kind: 'deployment', nonce: i, to: null, data: '0x6000', valueWei: '0',
      gasLimit: '120000', estimatedGas: '100000', artifactName: name,
      expectedRuntimeCodeHash: keccak256('0x00'), expectedContractAddress: getContractAddress({ from: sender, nonce: BigInt(i) }),
    })),
    disclosures: ['SYNTHETIC UNIT PLAN, NOT A REAL DEPLOYMENT.'],
  };
}

export function batchPlan(sender: Address = ACCOUNT, failedAt = -1): BroadcastPlan {
  const plan = deployPlan(sender);
  const actions = validateActions(threeActions());
  const prepared = preparePlan(actions);
  plan.purpose = 'batch';
  plan.actions = threeActions();
  plan.batchExecutor = EXECUTOR;
  plan.executorRuntimeCodeHash = keccak256('0x00');
  plan.targetCodeHashes = Object.fromEntries(actions.map((a) => [a.target, keccak256('0x00')]));
  plan.expectedSimulation = actions.map((a, i) => ({ id: a.id, success: i !== failedAt, returnData: '0x', returnDataSize: '0' }));
  plan.gasEstimates = { blockNumber: '10', batch: '800000', individual: actions.map((a, i) => ({ id: a.id, gas: i === failedAt ? null : '30000',
    ...(i === failedAt ? { error: 'SYNTHETIC failed estimate' } : {}) })) };
  plan.transactions = [{ id: 'execute-batch', kind: 'batch', nonce: 0, to: EXECUTOR,
    data: prepared.batchCalldata, valueWei: '0', estimatedGas: '800000', gasLimit: '960000' }];
  plan.maximumCostWei = '9600000000000000';
  return plan;
}
