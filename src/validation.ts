import { getAddress, isAddress, keccak256, toBytes } from 'viem';

import { ActionValidationError } from './errors.js';
import {
  DEFAULT_CALL_GAS, MAX_ACTIONS, MAX_CALLDATA_BYTES, MAX_CALL_GAS,
  MIN_ACTIONS, MIN_CALL_GAS, UINT256_MAX,
} from './limits.js';
import type { ValidatedAction } from './types.js';

const ALLOWED_FIELDS = new Set(['id', 'target', 'calldata', 'value', 'gasLimit', 'independent', 'note']);

export function validateAddress(value: unknown, label = 'address'): `0x${string}` {
  if (typeof value !== 'string' || !isAddress(value.trim(), { strict: true })) {
    throw new ActionValidationError(`${label} must be a valid EVM address (valid checksum if mixed-case)`);
  }
  const address = getAddress(value.trim());
  if (address === '0x0000000000000000000000000000000000000000') {
    throw new ActionValidationError(`${label} must not be the zero address`);
  }
  return address;
}

/** Strict runtime validation, including untrusted JSON and wrong JS types. */
export function validateActions(inputs: unknown): ValidatedAction[] {
  if (!Array.isArray(inputs)) throw new ActionValidationError('actions must be an array');
  if (inputs.length < MIN_ACTIONS) {
    throw new ActionValidationError(`batch must contain at least ${MIN_ACTIONS} independent actions; received ${inputs.length}`);
  }
  if (inputs.length > MAX_ACTIONS) {
    throw new ActionValidationError(`batch exceeds the on-chain limit of ${MAX_ACTIONS} actions; received ${inputs.length}`);
  }
  const ids = new Map<string, number>();
  let totalValue = 0n;
  return inputs.map((input: unknown, index) => {
    const fail = (message: string, field?: string): never => {
      throw new ActionValidationError(`action ${index}: ${message}`, { index, field });
    };
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return fail('must be an object');
    }
    const action = input as Record<string, unknown>;
    for (const field of Object.keys(action)) {
      if (!ALLOWED_FIELDS.has(field)) fail(`unknown/unsupported field "${field}"; dependent workflows are not supported`, field);
    }
    if (action.independent !== true) fail('independent must be explicitly true; dependent actions are not a batch', 'independent');
    if (typeof action.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(action.id.trim())) {
      fail('id must be 1..64 letters, digits, dots, underscores or hyphens', 'id');
    }
    const id = (action.id as string).trim();
    const firstAt = ids.get(id);
    if (firstAt !== undefined) fail(`duplicate action id "${id}": already used by action ${firstAt}`, 'id');
    ids.set(id, index);
    let target: `0x${string}`;
    try { target = validateAddress(action.target, 'target'); }
    catch (error) { return fail(error instanceof Error ? error.message : 'invalid target', 'target'); }

    if (typeof action.calldata !== 'string') fail('calldata must be a 0x-prefixed hex string', 'calldata');
    const raw = (action.calldata as string).trim();
    const calldata = raw === '' ? '0x' : raw.toLowerCase();
    if (!calldata.startsWith('0x')) fail('calldata must start with 0x', 'calldata');
    const hex = calldata.slice(2);
    if (hex.length % 2 !== 0) fail('calldata has odd hex length', 'calldata');
    if (!/^[0-9a-f]*$/.test(hex)) fail('calldata contains non-hex characters', 'calldata');
    if (hex.length !== 0 && hex.length < 8) fail('calldata shorter than a 4-byte function selector', 'calldata');
    if (hex.length / 2 > MAX_CALLDATA_BYTES) fail(`calldata exceeds ${MAX_CALLDATA_BYTES} bytes`, 'calldata');

    const value = parseInteger(action.value === undefined ? 0 : action.value, index, 'value');
    totalValue += value;
    if (totalValue > UINT256_MAX) fail('sum of action values exceeds uint256', 'value');
    const gasLimit = parseInteger(action.gasLimit === undefined ? DEFAULT_CALL_GAS.toString() : action.gasLimit, index, 'gasLimit');
    if (gasLimit < MIN_CALL_GAS || gasLimit > MAX_CALL_GAS) {
      fail(`gasLimit must be ${MIN_CALL_GAS}..${MAX_CALL_GAS}`, 'gasLimit');
    }
    if (action.note !== undefined && (typeof action.note !== 'string' || action.note.length > 512)) {
      fail('note must be a string of at most 512 characters', 'note');
    }
    return {
      id, idBytes32: keccak256(toBytes(id)), target, calldata: calldata as `0x${string}`,
      value, gasLimit, independent: true,
      ...(action.note === undefined ? {} : { note: action.note as string }),
    };
  });
}

function parseInteger(value: unknown, index: number, field: string): bigint {
  let parsed: bigint;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) parsed = BigInt(value);
  else if (typeof value === 'string' && /^\d+$/.test(value.trim())) parsed = BigInt(value.trim());
  else throw new ActionValidationError(`action ${index}: ${field} must be a non-negative safe integer or decimal string`, { index, field });
  if (parsed > UINT256_MAX) throw new ActionValidationError(`action ${index}: ${field} exceeds uint256`, { index, field });
  return parsed;
}
