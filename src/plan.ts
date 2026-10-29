import { createHash } from 'node:crypto';
import { encodeFunctionData } from 'viem';

import { BATCH_EXECUTOR_ABI } from './abi.js';
import type { ValidatedAction } from './types.js';
import { validateActions } from './validation.js';

export interface PreparedPlan {
  planHash: string;
  actions: ValidatedAction[];
  batchCalldata: `0x${string}`;
  totalValue: bigint;
}

/** Prepare the exact calldata and stable approval hash for a batch. */
export function preparePlan(actions: readonly ValidatedAction[]): PreparedPlan {
  // Revalidate at the library boundary, not only in the CLI.
  const copied = validateActions(actions.map((action) => ({
    id: action.id, target: action.target, calldata: action.calldata,
    value: action.value.toString(), gasLimit: action.gasLimit.toString(), independent: action.independent,
    ...(action.note === undefined ? {} : { note: action.note }),
  })));
  const batchCalldata = encodeFunctionData({
    abi: BATCH_EXECUTOR_ABI,
    functionName: 'execute',
    args: [
      copied.map((action) => ({
        id: action.idBytes32,
        target: action.target,
        value: action.value,
        gasLimit: action.gasLimit,
        data: action.calldata,
      })),
    ],
  });
  const canonical = JSON.stringify({
    schemaVersion: 1,
    actions: copied.map((action, index) => ({
      index,
      id: action.id,
      idBytes32: action.idBytes32,
      target: action.target,
      valueWei: action.value.toString(),
      gasLimit: action.gasLimit.toString(),
      independent: true,
      calldata: action.calldata,
    })),
    batchCalldata,
  });
  return {
    planHash: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
    actions: copied,
    batchCalldata,
    totalValue: copied.reduce((sum, action) => sum + action.value, 0n),
  };
}
