/** Validation failure with precise, machine-readable context. */
export class ActionValidationError extends Error {
  override readonly name = 'ActionValidationError';
  /** Which action index failed (undefined for batch-level errors). */
  readonly index?: number;
  /** Which field failed. */
  readonly field?: string;

  constructor(message: string, options?: {index?: number; field?: string}) {
    super(message);
    this.index = options?.index;
    this.field = options?.field;
  }
}

/** Planning/execution failure that is not an input-validation problem. */
export class BatchPlanError extends Error {
  override readonly name = 'BatchPlanError';
}

/** Raised when a safety gate refuses to proceed. */
export class ExecutionGateError extends Error {
  override readonly name = 'ExecutionGateError';
}

/** Raised when receipt verification fails (missing/failed receipt data). */
export class ReceiptVerificationError extends Error {
  override readonly name = 'ReceiptVerificationError';
  readonly txHash?: string;

  constructor(message: string, txHash?: string) {
    super(message);
    this.txHash = txHash;
  }
}
