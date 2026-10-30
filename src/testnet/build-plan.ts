import { getContractAddress, keccak256, type Address } from 'viem';
import { EvmAdapter } from '../adapters/evm.js';
import { loadArtifact } from '../artifacts.js';
import { makeDemoActions } from '../demo-actions.js';
import { ExecutionGateError } from '../errors.js';
import { ATLANTIC } from '../network.js';
import { preparePlan } from '../plan.js';
import type { BatchActionInput } from '../types.js';
import { validateActions } from '../validation.js';
import { broadcastPlanHash, DEPLOYMENT_ARTIFACTS, MAX_TRANSACTION_GAS, PLAN_TTL_MS, transactionPayloadHash, verifyApproval, type BroadcastPlan, type DeploymentStage, type PlannedTransaction } from './broadcast-plan.js';
import type { DeploymentStore } from './deployments.js';
import type { ReconcileClient } from './reconcile.js';

export interface PlanDependencies {
  client: ReconcileClient;
  deployments: DeploymentStore;
  artifactLoader?: typeof loadArtifact;
  now?: () => number;
}

export async function buildBroadcastPlan(options: {
  purpose: BroadcastPlan['purpose']; sender: Address; actions?: unknown; executor?: Address;
  stage?: DeploymentStage; scenario?: 'success' | 'mixed';
}, deps: PlanDependencies): Promise<BroadcastPlan> {
  const { client, deployments } = deps;
  const artifactLoader = deps.artifactLoader ?? loadArtifact;
  if (options.purpose === 'deploy' && (!['executor', 'counter'].includes(options.stage ?? '') || options.actions !== undefined || options.executor !== undefined || options.scenario !== undefined)) throw new ExecutionGateError('Select exactly one deployment stage; a deployment plan cannot also execute actions.');
  if (options.purpose !== 'deploy' && options.stage !== undefined) throw new ExecutionGateError('A batch or baseline cannot include a deployment stage.');
  if (options.scenario !== undefined && (options.purpose !== 'batch' || !['success', 'mixed'].includes(options.scenario) || options.actions !== undefined)) throw new ExecutionGateError('Choose one three-action scenario or explicit actions for this batch.');
  if (await client.getChainId() !== ATLANTIC.chainId) throw new ExecutionGateError('Planning RPC chain ID mismatch.');
  if (options.purpose === 'deploy') await deployments.assertAvailable(options.sender, options.stage!);
  const stages: DeploymentStage[] = options.purpose === 'deploy' ? options.stage === 'counter' ? ['executor'] : [] : ['executor', 'counter'];
  const prerequisites = await deployments.prerequisites(options.sender, stages, client, undefined, artifactLoader);
  const [balanceWei, gasPriceWei, blockNumber, pendingNonce, latestNonce, senderCode] = await Promise.all([
    client.getBalance({ address: options.sender }), client.getGasPrice(), client.getBlockNumber(),
    client.getTransactionCount({ address: options.sender, blockTag: 'pending' }), client.getTransactionCount({ address: options.sender, blockTag: 'latest' }),
    client.getCode({ address: options.sender }),
  ]);
  if (pendingNonce !== latestNonce) throw new ExecutionGateError('Wallet has pending transactions; wait before planning.');
  if (senderCode !== undefined && senderCode !== '0x') throw new ExecutionGateError('Direct deployment/execution requires the reviewed code-empty wallet.');
  if (gasPriceWei <= 0n) throw new ExecutionGateError('RPC returned an invalid gas price.');
  const block = await client.getBlock({ blockNumber });
  if (block.hash === null) throw new ExecutionGateError('Planning block is not canonical.');
  const now = (deps.now ?? Date.now)();
  const transactions: PlannedTransaction[] = [];
  const base: BroadcastPlan = {
    schemaVersion: 2, skill: 'pharos-batch-executor', purpose: options.purpose, network: ATLANTIC,
    sender: options.sender, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PLAN_TTL_MS).toISOString(),
    planningBlockNumber: blockNumber.toString(), gasPriceWei: gasPriceWei.toString(),
    maximumCostWei: '0', transactions,
    ...(options.stage === undefined ? {} : { deploymentStage: options.stage }),
    ...(stages.length === 0 ? {} : { deploymentPrerequisites: prerequisites }),
    disclosures: [
      'Atlantic TESTNET ONLY. This is an unsigned plan, not execution evidence.',
      'All gas values here are RPC ESTIMATES or gas-limit ceilings; no actual receipt or transaction hash is claimed.',
      'Each deployment stage is exactly ONE separately planned and approved transaction. No following stage runs automatically.',
      'Approval binds sender, nonce, targets, calldata, value, gas price, limits, code and expected outcomes. No automatic send retries.',
      'Do not concurrently use this sender; any nonce/state/code change requires re-planning and fresh approval.',
      'Gas-limit budgeting is conservative. Receipt-derived fee arithmetic is not an independently observed balance debit; Atlantic fee policy remains unresolved.',
    ],
  };
  if (options.purpose === 'deploy') {
      const name = DEPLOYMENT_ARTIFACTS[options.stage!];
      const artifact = await artifactLoader(name);
      const nonce = pendingNonce;
      const address = getContractAddress({ from: options.sender, nonce: BigInt(nonce) });
      const [code, addressNonce] = await Promise.all([client.getCode({ address }), client.getTransactionCount({ address, blockTag: 'latest' })]);
      if ((code !== undefined && code !== '0x') || addressNonce !== 0) throw new ExecutionGateError('Predicted CREATE address is occupied.');
      const cap = [MAX_TRANSACTION_GAS, block.gasLimit, balanceWei / gasPriceWei].reduce((a, b) => a < b ? a : b);
      if (cap <= 0n) throw new ExecutionGateError('Insufficient balance for deployment estimation.');
      const estimatedGas = await client.estimateGas({ account: options.sender, nonce, type: 'legacy', gasPrice: gasPriceWei,
        data: artifact.bytecode, value: 0n, gas: cap, blockNumber });
      transactions.push({
        id: `deploy-${name}`, kind: 'deployment', nonce, to: null, data: artifact.bytecode, valueWei: '0',
        gasLimit: margin(estimatedGas).toString(), estimatedGas: estimatedGas.toString(), artifactName: name,
        expectedRuntimeCodeHash: artifact.runtimeCodeHash,
        expectedContractAddress: address,
      });
  } else {
    const executor = prerequisites.executor!.address;
    if (options.executor !== undefined && options.executor.toLowerCase() !== executor.toLowerCase()) throw new ExecutionGateError('Explicit executor differs from the verified deployment record.');
    const actions = validateActions(options.scenario === undefined ? options.actions : makeDemoActions(prerequisites.counter!.address, options.scenario, 3, `${options.scenario}-${pendingNonce}`));
    const artifact = await artifactLoader('BatchExecutor');
    const adapter = new EvmAdapter({ id: 'atlantic-testnet', rpcUrl: ATLANTIC.rpcUrl, account: options.sender,
      batchExecutor: executor, expectedExecutorCodeHash: artifact.runtimeCodeHash, publicClient: client });
    const simulation = await adapter.simulateBatch(actions);
    const estimates = await adapter.estimateGas(actions);
    if (simulation.state !== 'dry_run' || estimates.batch.gas === null) throw new ExecutionGateError('Batch simulation/estimation failed; no executable plan generated.');
    if (options.scenario !== undefined && simulation.actions.some((action, i) => action.success !== (options.scenario === 'success' || i !== 1))) throw new ExecutionGateError('Scenario simulation does not match the requested three-action outcomes.');
    const targetCodeHashes: Record<string, `0x${string}`> = {};
    for (const action of actions) targetCodeHashes[action.target] = keccak256((await client.getCode({ address: action.target })) ?? '0x');
    const prepared = preparePlan(actions);
    base.actions = actions.map((a): BatchActionInput => ({ id: a.id, target: a.target, calldata: a.calldata,
      independent: true, value: a.value.toString(), gasLimit: a.gasLimit.toString(), ...(a.note === undefined ? {} : { note: a.note }) }));
    base.batchExecutor = executor;
    base.executorRuntimeCodeHash = artifact.runtimeCodeHash;
    base.targetCodeHashes = targetCodeHashes;
    base.expectedSimulation = simulation.actions.map((a) => ({ id: a.id, success: a.success === true, returnData: a.returnData!, returnDataSize: a.returnDataSize!.toString() }));
    base.gasEstimates = {
      blockNumber: estimates.blockNumber!.toString(), batch: estimates.batch.gas.toString(),
      individual: estimates.individual.map((estimate, i) => ({ id: actions[i]!.id, gas: estimate.gas?.toString() ?? null,
        ...(estimate.error === undefined ? {} : { error: estimate.error }) })),
    };
    if (options.purpose === 'batch') {
      transactions.push({ id: 'execute-batch', kind: 'batch', nonce: pendingNonce, to: executor,
        data: prepared.batchCalldata, valueWei: prepared.totalValue.toString(),
        estimatedGas: estimates.batch.gas.toString(), gasLimit: margin(estimates.batch.gas).toString() });
    } else {
      if (estimates.individualTotal === null || simulation.actions.some((a) => !a.success)) throw new ExecutionGateError('Refusing individual baseline with failing action estimates or simulation.');
      for (const [i, action] of actions.entries()) transactions.push({ id: action.id, kind: 'individual', nonce: pendingNonce + i,
        to: action.target, data: action.calldata, valueWei: action.value.toString(),
        estimatedGas: estimates.individual[i]!.gas!.toString(), gasLimit: margin(estimates.individual[i]!.gas!).toString() });
      base.disclosures.push('BASELINE ONLY: these N sequential transactions are NOT a batch. They require a separate approval and change state.');
    }
  }
  for (const tx of transactions) {
    tx.type = 'legacy';
    tx.payloadHash = transactionPayloadHash(base, tx);
    if (BigInt(tx.gasLimit) > block.gasLimit) throw new ExecutionGateError('Planned transaction exceeds the observed block gas limit.');
  }
  base.maximumCostWei = transactions.reduce((sum, tx) => sum + BigInt(tx.gasLimit) * gasPriceWei + BigInt(tx.valueWei), 0n).toString();
  verifyApproval(base, broadcastPlanHash(base), true, now);
  if (balanceWei < BigInt(base.maximumCostWei)) throw new ExecutionGateError('Insufficient balance for the full approved gas/value ceiling.');
  for (const stage of stages) {
    const record = await deployments.read(options.sender, stage);
    if (Date.parse(record.verifiedAt) > now || pendingNonce <= record.plan.transactions[0]!.nonce) throw new ExecutionGateError('Fresh planning observations must follow the verified deployment prerequisite.');
  }
  return base;
}

function margin(gas: bigint): bigint { return (gas * 12_000n + 9_999n) / 10_000n; }
