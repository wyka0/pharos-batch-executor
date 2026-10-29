export type Hex = `0x${string}`;

/** User input: independence must be declared, never inferred from calldata. */
export interface BatchActionInput {
  id: string;
  target: string;
  calldata: string;
  independent: true;
  value?: string | number;
  gasLimit?: string | number;
  note?: string;
}

export interface ValidatedAction {
  id: string;
  idBytes32: Hex;
  target: Hex;
  calldata: Hex;
  value: bigint;
  gasLimit: bigint;
  independent: true;
  note?: string;
}

/** null means estimation FAILED, not a made-up fallback. */
export interface GasEstimate {
  gas: bigint | null;
  estimate: true;
  source: 'rpc' | 'model';
  error?: string;
}

export interface ActualReceipt {
  evidence: 'actual';
  txHash: Hex;
  status: 'success' | 'reverted';
  gasUsed: bigint;
  blockNumber: bigint;
  blockHash: Hex;
  effectiveGasPrice: bigint;
  feeWei: bigint;
  confirmations: bigint;
  explorerUrl?: string;
}

/** Deliberately has NO txHash, blockNumber, or measured gasUsed. */
export interface SimulatedReceipt {
  evidence: 'simulated';
  simulationRef: string;
  status: 'success' | 'reverted';
  modelGas: bigint;
}

export type ReceiptInfo = ActualReceipt | SimulatedReceipt;

export interface ActionResult {
  index: number;
  id: string;
  target: Hex;
  status: 'succeeded' | 'failed' | 'not_committed' | 'not_submitted' | 'unknown';
  /** null when the action's individual outcome is not provable. */
  success: boolean | null;
  transactionHash?: Hex;
  /** Missing for individual receipts: receipts do not contain return data. */
  returnData?: Hex;
  returnDataSource: 'event' | 'simulation' | 'model' | 'unavailable';
  returnDataSize?: bigint;
  returnDataTruncated?: boolean;
  error?: string;
}

export interface BatchExecutionResult {
  kind: 'batch';
  state: 'dry_run' | 'simulated' | 'confirmed' | 'reverted' | 'unknown' | 'unverified' | 'not_submitted';
  transactionHash?: Hex;
  receipt?: ReceiptInfo;
  actions: ActionResult[];
  error?: string;
  /** Failed value is a credit, not an automatic refund transaction. */
  refundCreditWei: bigint;
  rawReceipt?: unknown;
}

export interface IndividualExecutionResult {
  kind: 'individual';
  receipts: ReceiptInfo[];
  actions: ActionResult[];
  rawReceipts?: unknown[];
  error?: string;
}

export interface ExecutionSide {
  transactionCount: number;
  estimatedGas: GasEstimate;
  measuredGas?: { gas: bigint; measured: true; receipts: number };
}

export interface ExecutionComparison {
  individual: ExecutionSide;
  batch: ExecutionSide;
  measuredSavings?: { gas: bigint; fraction: number };
  estimatedSavings?: { gas: bigint; fraction: number };
  transactionReduction: { count: number; fraction: number };
  baselineMethod: string;
  limitations: string[];
}

export interface BatchRunEvidence {
  schemaVersion: 1;
  skill: 'pharos-batch-executor';
  runId: string;
  metadata: {
    adapter: string;
    chainId: number;
    rpcUrl?: string;
    startedAt: string;
    finishedAt: string;
    estimateBlockNumber?: bigint;
  };
  plan: {
    planHash: string;
    actions: Array<{
      index: number;
      id: string;
      idBytes32: Hex;
      target: Hex;
      calldata: Hex;
      valueWei: string;
      gasLimit: string;
      independent: true;
      note?: string;
    }>;
    batchCalldata: Hex;
    batchExecutorAddress?: Hex;
  };
  estimates: { individual: GasEstimate[]; individualTotal: bigint | null; batch: GasEstimate };
  batch: BatchExecutionResult;
  individual?: IndividualExecutionResult;
  comparison: ExecutionComparison;
  measurementDisclosures: {
    estimatesAreModelValues: boolean;
    measuredGasFromRealReceipts: boolean;
    executionEnvironment: 'simulated' | 'local-evm' | 'atlantic-testnet';
    callSuccessDoesNotGuaranteeBusinessSuccess: true;
    callerIsExecutorNotWallet: true;
  };
}

export interface PartialFailureSummary {
  failedActionIds: string[];
  succeededActionIds: string[];
  unknownActionIds: string[];
  remainingActionsBehavior: string;
}
