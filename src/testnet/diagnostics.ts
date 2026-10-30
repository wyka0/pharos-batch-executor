import {
  ExecutionGateError, PRE_CONSUMPTION_ERROR_CODES, SAFE_EXECUTION_GATE_CAUSES,
  type PreConsumptionErrorCode, type SafeExecutionGateCause,
} from '../errors.js';

function isCode(value: unknown): value is PreConsumptionErrorCode {
  return typeof value === 'string' && (PRE_CONSUMPTION_ERROR_CODES as readonly string[]).includes(value);
}

function isCause(value: unknown): value is SafeExecutionGateCause {
  return typeof value === 'string' && (SAFE_EXECUTION_GATE_CAUSES as readonly string[]).includes(value);
}

export function preConsumptionErrorCode(error: unknown): PreConsumptionErrorCode {
  return error instanceof ExecutionGateError && isCode(error.code)
    ? error.code
    : 'INTERNAL_PRECONSUMPTION_FAILURE';
}

export function safeExecutionGateCause(error: unknown): SafeExecutionGateCause {
  return error instanceof ExecutionGateError && isCause(error.safeCause)
    ? error.safeCause
    : 'UNKNOWN_PRECONSUMPTION';
}

export function publicRunnerRefusal(error: unknown): string {
  const code = preConsumptionErrorCode(error);
  const cause = safeExecutionGateCause(error);
  return `Testnet runner stopped/refused [${code}] [${cause}]. Inspect the public plan, journal and execution evidence. Do not resend an intent or unknown transaction.`;
}
