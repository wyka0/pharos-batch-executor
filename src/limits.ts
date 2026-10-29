export const MIN_ACTIONS = 3;
export const MAX_ACTIONS = 32;
export const MIN_CALL_GAS = 25_000n;
export const MAX_CALL_GAS = 1_000_000n;
export const DEFAULT_CALL_GAS = 100_000n;
export const MAX_CALLDATA_BYTES = 4_096;
export const MAX_RETURN_DATA_BYTES = 2_048;
export const UINT256_MAX = (1n << 256n) - 1n;
export const ACTION_RESERVE_GAS = 60_000n;
export const FINISH_RESERVE_GAS = 60_000n;

/** Contract reservation, not a prediction of measured gas used. */
export function requiredExecutionGas(actions: readonly { gasLimit: bigint }[]): bigint {
  return FINISH_RESERVE_GAS + actions.reduce(
    (sum, action) => sum + action.gasLimit + (action.gasLimit + 62n) / 63n + ACTION_RESERVE_GAS,
    0n,
  );
}
