import { getContractAddress, keccak256, type Address } from 'viem';
import { EvmAdapter } from '../adapters/evm.js';
import { loadArtifact } from '../artifacts.js';
import { ExecutionGateError } from '../errors.js';
import { ATLANTIC } from '../network.js';
import { preparePlan } from '../plan.js';
import type { BatchActionInput } from '../types.js';
import { validateActions } from '../validation.js';
import { broadcastPlanHash, PLAN_TTL_MS, verifyApproval, type BroadcastPlan, type PlannedTransaction } from './broadcast-plan.js';
import { atlanticPublicClient, getReadiness } from './readiness.js';

export async function buildBroadcastPlan(options: {
  purpose: BroadcastPlan['purpose']; sender: Address; actions?: unknown; executor?: Address;
}): Promise<BroadcastPlan> {
  const client = atlanticPublicClient();
  const readiness = await getReadiness(options.sender);
  if (!readiness.noPendingTransactions) throw new ExecutionGateError('Wallet has pending transactions; wait before planning.');
  const now = Date.now();
  const transactions: PlannedTransaction[] = [];
  const base: BroadcastPlan = {
    schemaVersion: 1, skill: 'pharos-batch-executor', purpose: options.purpose, network: ATLANTIC,
    sender: options.sender, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PLAN_TTL_MS).toISOString(),
    planningBlockNumber: readiness.blockNumber.toString(), gasPriceWei: readiness.gasPriceWei.toString(),
    maximumCostWei: '0', transactions,
    disclosures: [
      'Atlantic TESTNET ONLY. This is an unsigned plan, not execution evidence.',
      'All gas values here are RPC ESTIMATES or gas-limit ceilings; no actual receipt or transaction hash is claimed.',
      'Setup deployment is 2 separate transactions, not a batch. An execution batch is exactly 1 transaction.',
      'Approval binds sender, nonce, targets, calldata, value, gas price, limits, code and expected outcomes. No automatic send retries.',
      'Do not concurrently use this sender; any nonce/state/code change requires re-planning and fresh approval.',
    ],
  };
  if (options.purpose === 'deploy') {
    for (const [i, name] of (['BatchExecutor', 'TestOnlyCounter'] as const).entries()) {
      const artifact = await loadArtifact(name);
      const estimatedGas = await client.estimateGas({ account: options.sender, data: artifact.bytecode, value: 0n });
      const nonce = readiness.pendingNonce + i;
      transactions.push({
        id: `deploy-${name}`, kind: 'deployment', nonce, to: null, data: artifact.bytecode, valueWei: '0',
        gasLimit: margin(estimatedGas).toString(), estimatedGas: estimatedGas.toString(), artifactName: name,
        expectedRuntimeCodeHash: artifact.runtimeCodeHash,
        expectedContractAddress: getContractAddress({ from: options.sender, nonce: BigInt(nonce) }),
      });
    }
  } else {
    if (options.executor === undefined) throw new ExecutionGateError('--executor is required after verified deployment.');
    const actions = validateActions(options.actions);
    const artifact = await loadArtifact('BatchExecutor');
    const adapter = new EvmAdapter({ id: 'atlantic-testnet', rpcUrl: ATLANTIC.rpcUrl, account: options.sender,
      batchExecutor: options.executor, expectedExecutorCodeHash: artifact.runtimeCodeHash, publicClient: client });
    const simulation = await adapter.simulateBatch(actions);
    const estimates = await adapter.estimateGas(actions);
    if (simulation.state !== 'dry_run' || estimates.batch.gas === null) throw new ExecutionGateError('Batch simulation/estimation failed; no executable plan generated.');
    const targetCodeHashes: Record<string, `0x${string}`> = {};
    for (const action of actions) targetCodeHashes[action.target] = keccak256((await client.getCode({ address: action.target })) ?? '0x');
    const prepared = preparePlan(actions);
    base.actions = actions.map((a): BatchActionInput => ({ id: a.id, target: a.target, calldata: a.calldata,
      independent: true, value: a.value.toString(), gasLimit: a.gasLimit.toString(), ...(a.note === undefined ? {} : { note: a.note }) }));
    base.batchExecutor = options.executor;
    base.executorRuntimeCodeHash = artifact.runtimeCodeHash;
    base.targetCodeHashes = targetCodeHashes;
    base.expectedSimulation = simulation.actions.map((a) => ({ id: a.id, success: a.success === true, returnData: a.returnData!, returnDataSize: a.returnDataSize!.toString() }));
    base.gasEstimates = {
      blockNumber: estimates.blockNumber!.toString(), batch: estimates.batch.gas.toString(),
      individual: estimates.individual.map((estimate, i) => ({ id: actions[i]!.id, gas: estimate.gas?.toString() ?? null,
        ...(estimate.error === undefined ? {} : { error: estimate.error }) })),
    };
    if (options.purpose === 'batch') {
      transactions.push({ id: 'execute-batch', kind: 'batch', nonce: readiness.pendingNonce, to: options.executor,
        data: prepared.batchCalldata, valueWei: prepared.totalValue.toString(),
        estimatedGas: estimates.batch.gas.toString(), gasLimit: margin(estimates.batch.gas).toString() });
    } else {
      if (estimates.individualTotal === null || simulation.actions.some((a) => !a.success)) throw new ExecutionGateError('Refusing individual baseline with failing action estimates or simulation.');
      for (const [i, action] of actions.entries()) transactions.push({ id: action.id, kind: 'individual', nonce: readiness.pendingNonce + i,
        to: action.target, data: action.calldata, valueWei: action.value.toString(),
        estimatedGas: estimates.individual[i]!.gas!.toString(), gasLimit: margin(estimates.individual[i]!.gas!).toString() });
      base.disclosures.push('BASELINE ONLY: these N sequential transactions are NOT a batch. They require a separate approval and change state.');
    }
  }
  base.maximumCostWei = transactions.reduce((sum, tx) => sum + BigInt(tx.gasLimit) * readiness.gasPriceWei + BigInt(tx.valueWei), 0n).toString();
  verifyApproval(base, broadcastPlanHash(base), true, now);
  if (readiness.balanceWei < BigInt(base.maximumCostWei)) throw new ExecutionGateError('Insufficient balance for the full approved gas/value ceiling.');
  return base;
}

function margin(gas: bigint): bigint { return (gas * 12_000n + 9_999n) / 10_000n; }
