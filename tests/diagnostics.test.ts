import { describe, expect, it } from 'vitest';
import { ExecutionGateError, PRE_CONSUMPTION_ERROR_CODES, SAFE_EXECUTION_GATE_CAUSES } from '../src/errors.js';
import { preConsumptionErrorCode, publicRunnerRefusal, safeExecutionGateCause } from '../src/testnet/diagnostics.js';

describe('safe pre-consumption diagnostics', () => {
  it.each(PRE_CONSUMPTION_ERROR_CODES)('prints stable code %s without exception text', (code) => {
    const secret = `${'PRIVATE_KEY'}=${'ab'.repeat(32)}`;
    const error = new ExecutionGateError(`untrusted ${secret}`, { code, safeCause: 'UNKNOWN_PRECONSUMPTION' });
    const output = publicRunnerRefusal(error);
    expect(preConsumptionErrorCode(error)).toBe(code);
    expect(output).toContain(`[${code}]`);
    expect(output).toContain('[UNKNOWN_PRECONSUMPTION]');
    expect(output).not.toContain(secret);
  });

  it.each(SAFE_EXECUTION_GATE_CAUSES)('prints allowlisted safe cause %s', (safeCause) => {
    const error = new ExecutionGateError('redacted', { code: 'RPC_PREFLIGHT_FAILED', safeCause });
    expect(safeExecutionGateCause(error)).toBe(safeCause);
    expect(publicRunnerRefusal(error)).toContain(`[${safeCause}]`);
  });

  it('maps unknown exceptions to INTERNAL_PRECONSUMPTION_FAILURE without leaking details', () => {
    const secret = `${'PRIVATE_KEY'}=${'cd'.repeat(32)}`;
    const output = publicRunnerRefusal(new Error(secret));
    expect(output).toContain('[INTERNAL_PRECONSUMPTION_FAILURE]');
    expect(output).toContain('[UNKNOWN_PRECONSUMPTION]');
    expect(output).not.toContain(secret);
  });

  it('rejects runtime-injected non-allowlisted code and cause labels', () => {
    const secret = `${'PRIVATE_KEY'}=${'ef'.repeat(32)}`;
    const error = new ExecutionGateError(secret);
    Object.assign(error, { code: secret, safeCause: secret });
    const output = publicRunnerRefusal(error);
    expect(output).toContain('[INTERNAL_PRECONSUMPTION_FAILURE] [UNKNOWN_PRECONSUMPTION]');
    expect(output).not.toContain(secret);
  });
});
