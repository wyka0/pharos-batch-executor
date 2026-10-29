import { estimateBatch, estimateIndividualAction } from '../gas-model.js';
import { preparePlan } from '../plan.js';
import type { ActionResult, BatchExecutionResult, IndividualExecutionResult, ValidatedAction } from '../types.js';
import type { BatchGasEstimates, ChainAdapter } from './types.js';

/** Zero-network MODEL. References are sim_*, never invented transaction hashes. */
export class SimulatedAdapter implements ChainAdapter {
  readonly id = 'simulated' as const;
  readonly chainId = 0;
  readonly environment = 'simulated' as const;
  private readonly failureReasons: ReadonlyMap<string, string>;

  constructor(options?: { failureReasons?: ReadonlyMap<string, string> }) {
    this.failureReasons = options?.failureReasons ?? new Map();
  }

  async estimateGas(actions: readonly ValidatedAction[]): Promise<BatchGasEstimates> {
    preparePlan(actions);
    const individual = actions.map((action) => ({
      gas: estimateIndividualAction(hexToBytes(action.calldata), true),
      estimate: true as const, source: 'model' as const,
    }));
    return {
      individual, individualTotal: individual.reduce((sum, item) => sum + item.gas, 0n),
      batch: {
        gas: estimateBatch(actions.map((action) => ({ calldata: hexToBytes(action.calldata), writesStorage: true }))),
        estimate: true, source: 'model',
      },
    };
  }

  async simulateBatch(actions: readonly ValidatedAction[]): Promise<BatchExecutionResult> {
    return this.executeBatch(actions);
  }

  async executeBatch(actions: readonly ValidatedAction[]): Promise<BatchExecutionResult> {
    const estimates = await this.estimateGas(actions);
    const results = this.results(actions);
    return {
      kind: 'batch', state: 'simulated',
      receipt: {
        evidence: 'simulated', simulationRef: 'sim_batch', status: 'success',
        modelGas: estimates.batch.gas!,
      },
      actions: results,
      refundCreditWei: actions.reduce((sum, action, i) => sum + (results[i]?.success === false ? action.value : 0n), 0n),
    };
  }

  async executeIndividual(actions: readonly ValidatedAction[]): Promise<IndividualExecutionResult> {
    const estimates = await this.estimateGas(actions);
    const results = this.results(actions);
    return {
      kind: 'individual', actions: results,
      receipts: results.map((result, i) => ({
        evidence: 'simulated', simulationRef: `sim_individual_${i}`,
        status: result.success ? 'success' : 'reverted', modelGas: estimates.individual[i]!.gas!,
      })),
    };
  }

  private results(actions: readonly ValidatedAction[]): ActionResult[] {
    return actions.map((action, index) => {
      const error = this.failureReasons.get(action.id);
      return {
        index, id: action.id, target: action.target, status: error === undefined ? 'succeeded' : 'failed',
        success: error === undefined, returnDataSource: 'model',
        ...(error === undefined ? {} : { error }),
      };
    });
  }
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex.slice(2), 'hex'));
}
