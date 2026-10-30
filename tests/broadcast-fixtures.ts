/** SYNTHETIC unit plans. Never deployment or blockchain evidence. */
import { getContractAddress, keccak256, type Address } from 'viem';
import { ATLANTIC } from '../src/network.js';
import { preparePlan } from '../src/plan.js';
import { DEPLOYMENT_ARTIFACTS, transactionPayloadHash, type BroadcastPlan, type DeploymentBinding, type DeploymentStage } from '../src/testnet/broadcast-plan.js';
import { validateActions } from '../src/validation.js';
import { ACCOUNT, EXECUTOR, threeActions } from './fixtures.js';

export function legacyDeployPlan(sender: Address = ACCOUNT): BroadcastPlan {
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

export function legacyBatchPlan(sender: Address = ACCOUNT, failedAt = -1): BroadcastPlan {
  const plan = legacyDeployPlan(sender);
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

export function sealPayloads(plan: BroadcastPlan): BroadcastPlan {
  for (const tx of plan.transactions) { tx.type = 'legacy'; tx.payloadHash = transactionPayloadHash(plan, tx); }
  plan.maximumCostWei = plan.transactions.reduce((sum, tx) => sum + BigInt(tx.gasLimit) * BigInt(plan.gasPriceWei) + BigInt(tx.valueWei), 0n).toString();
  return plan;
}

export function fixtureBinding(address: Address = EXECUTOR): DeploymentBinding {
  return { recordHash: `sha256:${'aa'.repeat(32)}`, planHash: `sha256:${'bb'.repeat(32)}`, transactionHash: `0x${'ab'.repeat(32)}`,
    address, runtimeCodeHash: keccak256('0x00'), blockNumber: '9', blockHash: `0x${'cd'.repeat(32)}` };
}

export function deployPlan(sender: Address = ACCOUNT, stage: DeploymentStage = 'executor', nonce = 0, prerequisite = fixtureBinding()): BroadcastPlan {
  const plan = legacyDeployPlan(sender);
  plan.schemaVersion = 2;
  plan.deploymentStage = stage;
  plan.transactions = [plan.transactions[stage === 'executor' ? 0 : 1]!];
  const tx = plan.transactions[0]!;
  tx.nonce = nonce;
  tx.artifactName = DEPLOYMENT_ARTIFACTS[stage];
  tx.expectedContractAddress = getContractAddress({ from: sender, nonce: BigInt(nonce) });
  if (stage === 'counter') plan.deploymentPrerequisites = { executor: prerequisite };
  return sealPayloads(plan);
}

export function batchPlan(sender: Address = ACCOUNT, failedAt = -1): BroadcastPlan {
  const plan = legacyBatchPlan(sender, failedAt);
  plan.schemaVersion = 2;
  plan.deploymentPrerequisites = { executor: fixtureBinding(), counter: fixtureBinding('0x6666666666666666666666666666666666666666') };
  return sealPayloads(plan);
}
