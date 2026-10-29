import { randomUUID } from 'node:crypto';

import type { ChainAdapter } from './adapters/types.js';
import { buildComparison } from './comparison.js';
import { preparePlan } from './plan.js';
import type { BatchRunEvidence, ValidatedAction } from './types.js';

export interface RunOptions {
  runId?: string;
  /** Defaults to dry-run. Real execution requires an independently gated adapter. */
  mode?: 'dry-run' | 'execute';
  individualResult?: BatchRunEvidence['individual'];
  baselineMethod?: string;
  rpcUrl?: string;
  batchExecutorAddress?: `0x${string}`;
}

export async function runBatch(
  adapter: ChainAdapter,
  inputActions: readonly ValidatedAction[],
  options: RunOptions = {},
): Promise<BatchRunEvidence> {
  const startedAt = new Date().toISOString();
  const plan = preparePlan(inputActions);
  const actions = plan.actions;
  const estimates = await adapter.estimateGas(actions);
  const batch = options.mode === 'execute'
    ? await adapter.executeBatch(actions)
    : await adapter.simulateBatch(actions);
  return {
    schemaVersion: 1, skill: 'pharos-batch-executor', runId: options.runId ?? `batch_${randomUUID()}`,
    metadata: {
      adapter: adapter.id, chainId: adapter.chainId, startedAt, finishedAt: new Date().toISOString(),
      ...(options.rpcUrl === undefined ? {} : { rpcUrl: options.rpcUrl }),
      ...(estimates.blockNumber === undefined ? {} : { estimateBlockNumber: estimates.blockNumber }),
    },
    plan: {
      planHash: plan.planHash,
      actions: actions.map((a, index) => ({
        index, id: a.id, idBytes32: a.idBytes32, target: a.target, calldata: a.calldata,
        valueWei: a.value.toString(), gasLimit: a.gasLimit.toString(), independent: true,
        ...(a.note === undefined ? {} : { note: a.note }),
      })),
      batchCalldata: plan.batchCalldata,
      ...(options.batchExecutorAddress === undefined ? {} : { batchExecutorAddress: options.batchExecutorAddress }),
    },
    estimates,
    batch,
    ...(options.individualResult === undefined ? {} : { individual: options.individualResult }),
    comparison: buildComparison(actions, estimates, batch, options.individualResult, options.baselineMethod),
    measurementDisclosures: {
      estimatesAreModelValues: adapter.environment === 'simulated',
      measuredGasFromRealReceipts: batch.receipt?.evidence === 'actual',
      executionEnvironment: adapter.environment,
      callSuccessDoesNotGuaranteeBusinessSuccess: true, callerIsExecutorNotWallet: true,
    },
  };
}
