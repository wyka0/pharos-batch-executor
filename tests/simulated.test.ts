import { describe, expect, it } from 'vitest';

import { SimulatedAdapter } from '../src/adapters/simulated.js';
import { runBatch } from '../src/executor.js';
import { summarizePartialFailure } from '../src/summary.js';
import { validateActions } from '../src/validation.js';
import { threeActions } from './fixtures.js';

describe('simulated adapter', () => {
  it('executes three actions as one honestly labeled simulated batch', async () => {
    const adapter = new SimulatedAdapter();
    const actions = validateActions(threeActions());
    const evidence = await runBatch(adapter, actions, {
      runId: 'test-success',
      individualResult: await adapter.executeIndividual(actions),
    });
    expect(evidence.batch?.actions.every((action) => action.success)).toBe(true);
    expect(evidence.batch?.receipt).toMatchObject({ evidence: 'simulated', simulationRef: 'sim_batch' });
    expect(evidence.batch?.receipt).not.toHaveProperty('txHash');
    expect(evidence.batch?.receipt).not.toHaveProperty('blockNumber');
    expect(evidence.batch?.receipt).not.toHaveProperty('gasUsed');
    expect(evidence.comparison?.batch.transactionCount).toBe(1);
    expect(evidence.comparison?.individual.transactionCount).toBe(3);
    expect(evidence.comparison?.measuredSavings).toBeUndefined();
    expect(evidence.measurementDisclosures).toMatchObject({
      estimatesAreModelValues: true,
      measuredGasFromRealReceipts: false,
      executionEnvironment: 'simulated',
    });
  });

  it('identifies every action and proves remaining actions continue after failure', async () => {
    const adapter = new SimulatedAdapter({
      failureReasons: new Map([['two', 'forced test failure']]),
    });
    const evidence = await runBatch(adapter, validateActions(threeActions()), {
      runId: 'test-mixed',
    });
    expect(evidence.batch?.actions.map(({ id, success, error }) => ({ id, success, error }))).toEqual([
      { id: 'one', success: true, error: undefined },
      { id: 'two', success: false, error: 'forced test failure' },
      { id: 'three', success: true, error: undefined },
    ]);
    const summary = summarizePartialFailure(evidence.batch!.actions);
    expect(summary.failedActionIds).toEqual(['two']);
    expect(summary.succeededActionIds).toEqual(['one', 'three']);
    expect(summary.remainingActionsBehavior).toContain('1 of 1 remaining actions succeeded');
  });
});
