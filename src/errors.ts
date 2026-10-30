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
export type PreConsumptionErrorCode =
  | 'PLAN_VALIDATION_FAILED'
  | 'ARTIFACT_BINDING_FAILED'
  | 'PREREQUISITE_VERIFICATION_FAILED'
  | 'STAGE_ALREADY_CLAIMED'
  | 'RPC_PREFLIGHT_FAILED'
  | 'NONCE_CONFLICT'
  | 'BALANCE_INSUFFICIENT'
  | 'GAS_PRICE_EXCEEDED'
  | 'CREATE_ADDRESS_OCCUPIED'
  | 'FRESH_ESTIMATE_FAILED'
  | 'SIGNER_SOURCE_FAILED'
  | 'SIGNER_ADDRESS_MISMATCH'
  | 'APPROVAL_EXPIRED_AFTER_SIGNER_LOAD'
  | 'EXECUTION_LOCK_EXISTS'
  | 'NONCE_RESERVATION_EXISTS'
  | 'INTERNAL_PRECONSUMPTION_FAILURE';

/** Static labels only. Never place exception text, paths, RPC URLs or signer data here. */
export type SafeExecutionGateCause =
  | 'INITIAL_APPROVAL'
  | 'JOURNAL_PLAN_BINDING'
  | 'STATE_DIRECTORY_BINDING'
  | 'SOURCE_ARTIFACT_BINDING'
  | 'DEPLOYMENT_PREREQUISITE'
  | 'DEPLOYMENT_STAGE_AVAILABILITY'
  | 'RPC_STATE_READ'
  | 'RPC_CHAIN_ID'
  | 'RPC_NONCE'
  | 'RPC_BALANCE'
  | 'RPC_GAS_PRICE'
  | 'RPC_BLOCK_LIMIT'
  | 'RPC_SENDER_CODE'
  | 'RPC_CREATE_OCCUPANCY'
  | 'RPC_TARGET_BINDING'
  | 'RPC_SIMULATION'
  | 'RPC_FRESH_ESTIMATE'
  | 'SIGNER_FILE_OR_FORMAT'
  | 'SIGNER_PUBLIC_ADDRESS'
  | 'POST_SIGNER_APPROVAL'
  | 'PLAN_OR_SENDER_LOCK'
  | 'NONCE_MARKER_OR_RESERVATION'
  | 'UNKNOWN_PRECONSUMPTION';

export class ExecutionGateError extends Error {
  override readonly name = 'ExecutionGateError';
  readonly code?: PreConsumptionErrorCode;
  readonly safeCause?: SafeExecutionGateCause;

  constructor(message: string, options?: { code?: PreConsumptionErrorCode; safeCause?: SafeExecutionGateCause }) {
    super(message);
    this.code = options?.code;
    this.safeCause = options?.safeCause;
  }
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
