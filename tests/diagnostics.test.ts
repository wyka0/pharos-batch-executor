import { describe, expect, it } from 'vitest';
import { ExecutionGateError, type PreConsumptionErrorCode } from '../src/errors.js';
import { preConsumptionErrorCode, publicRunnerRefusal } from '../src/testnet/diagnostics.js';

const CODES: readonly PreConsumptionErrorCode[] = [
  'PLAN_VALIDATION_FAILED',
  'ARTIFACT_BINDING_FAILED',
  'PREREQUISITE_VERIFICATION_FAILED',
  'STAGE_ALREADY_CLAIMED',
  'RPC_PREFLIGHT_FAILED',
  'NONCE_CONFLICT',
  'BALANCE_INSUFFICIENT',
  'GAS_PRICE_EXCEEDED',
  'CREATE_ADDRESS_OCCUPIED',
  'FRESH_ESTIMATE_FAILED',
  'SIGNER_SOURCE_FAILED',
  'SIGNER_ADDRESS_MISMATCH',
  'APPROVAL_EXPIRED_AFTER_SIGNER_LOAD',
  'EXECUTION_LOCK_EXISTS',
  'NONCE_RESERVATION_EXISTS',
  'INTERNAL_PRECONSUMPTION_FAILURE',
];

describe('safe pre-consumption diagnostics', () => {
  it.each(CODES)('prints stable code %s without exception text or safe cause', (code) => {
    const secret = `${'PRIVATE_KEY'}=${'ab'.repeat(32)}`;
    const error = new ExecutionGateError(`untrusted ${secret}`, { code, safeCause: 'UNKNOWN_PRECONSUMPTION' });
    const output = publicRunnerRefusal(error);
    expect(preConsumptionErrorCode(error)).toBe(code);
    expect(output).toContain(`[${code}]`);
    expect(output).not.toContain(secret);
    expect(output).not.toContain('UNKNOWN_PRECONSUMPTION');
  });

  it('maps unknown exceptions to INTERNAL_PRECONSUMPTION_FAILURE without leaking details', () => {
    const secret = `${'PRIVATE_KEY'}=${'cd'.repeat(32)}`;
    const output = publicRunnerRefusal(new Error(secret));
    expect(output).toContain('[INTERNAL_PRECONSUMPTION_FAILURE]');
    expect(output).not.toContain(secret);
  });
});
