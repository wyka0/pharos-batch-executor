import { ExecutionGateError, type PreConsumptionErrorCode } from '../errors.js';

export function preConsumptionErrorCode(error: unknown): PreConsumptionErrorCode {
  return error instanceof ExecutionGateError && error.code !== undefined
    ? error.code
    : 'INTERNAL_PRECONSUMPTION_FAILURE';
}

export function publicRunnerRefusal(error: unknown): string {
  const code = preConsumptionErrorCode(error);
  return `Testnet runner stopped/refused [${code}]. Inspect the public plan, journal and execution evidence. Do not resend an intent or unknown transaction.`;
}
