/**
 * Deterministic gas model for the simulated adapter.
 *
 * These numbers are a MODEL, not a chain measurement. Every value derived
 * from this module is labeled `estimate: true` and
 * `measurementDisclosures.estimatesAreModelValues = true` in evidence.
 *
 * The model mirrors EVM cost structure so comparisons stay meaningful:
 *  - 21000 intrinsic cost per transaction;
 *  - calldata cost: 16 gas per non-zero byte, 4 per zero byte;
 *  - 2600 base cost per external CALL;
 *  - 20000 for a cold storage write (counter-style effects);
 *  - batch mode adds a small per-action loop/evidence overhead (3200) plus a
 *    fixed executor dispatch cost (5200), but pays intrinsic cost only once.
 */

export const INTRINSIC_TX_GAS = 21000n;
export const CALL_BASE_GAS = 2600n;
export const STORAGE_WRITE_GAS = 20000n;
export const BATCH_LOOP_OVERHEAD_PER_ACTION = 3200n;
export const BATCH_DISPATCH_GAS = 5200n;

/** Gas cost of a calldata byte string under the model. */
export function calldataGas(data: Uint8Array): bigint {
  let gas = 0n;
  for (const byte of data) {
    gas += byte === 0 ? 4n : 16n;
  }
  return gas;
}

/** Model estimate for executing one action as its own transaction. */
export function estimateIndividualAction(calldata: Uint8Array, writesStorage: boolean): bigint {
  return (
    INTRINSIC_TX_GAS +
    calldataGas(calldata) +
    CALL_BASE_GAS +
    (writesStorage ? STORAGE_WRITE_GAS : 0n)
  );
}

/** Model estimate for executing N actions inside one batch transaction. */
export function estimateBatch(
  actions: ReadonlyArray<{ calldata: Uint8Array; writesStorage: boolean }>,
): bigint {
  let inner = BATCH_DISPATCH_GAS;
  for (const action of actions) {
    inner +=
      calldataGas(action.calldata) +
      CALL_BASE_GAS +
      BATCH_LOOP_OVERHEAD_PER_ACTION +
      (action.writesStorage ? STORAGE_WRITE_GAS : 0n);
  }
  return INTRINSIC_TX_GAS + inner;
}
