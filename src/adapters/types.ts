import type { BatchExecutionResult, GasEstimate, IndividualExecutionResult, ValidatedAction } from '../types.js';

export interface BatchGasEstimates {
  individual: GasEstimate[];
  individualTotal: bigint | null;
  batch: GasEstimate;
  blockNumber?: bigint;
}

export interface ChainAdapter {
  readonly id: 'simulated' | 'local-anvil' | 'atlantic-testnet';
  readonly chainId: number;
  readonly environment: 'simulated' | 'local-evm' | 'atlantic-testnet';
  estimateGas(actions: readonly ValidatedAction[]): Promise<BatchGasEstimates>;
  simulateBatch(actions: readonly ValidatedAction[]): Promise<BatchExecutionResult>;
  /** Explicitly invoked execution, never called by a dry-run. */
  executeBatch(actions: readonly ValidatedAction[]): Promise<BatchExecutionResult>;
  executeIndividual(actions: readonly ValidatedAction[]): Promise<IndividualExecutionResult>;
}
