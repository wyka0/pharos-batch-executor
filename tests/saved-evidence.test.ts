import { describe, expect, it } from 'vitest';
import { stringifyPublicJson } from '../src/evidence.js';
import { verifyReceipt } from '../src/receipt.js';
import { savedReceiptLogs, verifySavedReceipt, type SavedRawReceipt, type SavedReceipt } from '../src/saved-evidence.js';
import { actionLog, BLOCK_HASH, HASH, rawReceipt, summaryLog } from './receipt-fixtures.js';
import { threeActions } from './fixtures.js';
import { validateActions } from '../src/validation.js';

function context() {
  const actions = validateActions(threeActions());
  const raw = rawReceipt([...actions.map((a, i) => actionLog(a, i)), summaryLog(3, 3)]);
  const saved = verifyReceipt(raw, HASH, { currentBlockNumber: 10n, canonicalBlockHash: BLOCK_HASH });
  return { raw: JSON.parse(stringifyPublicJson(raw)) as SavedRawReceipt, saved: JSON.parse(stringifyPublicJson(saved)) as SavedReceipt };
}

describe('saved local receipt consistency — no RPC or signing', () => {
  it('matches the normalized receipt against the actual saved raw fields', () => {
    const c = context();
    expect(verifySavedReceipt(c.saved, c.raw).gasUsed).toBe(120_000n);
    expect(savedReceiptLogs(c.raw)[0]?.blockNumber).toBe(9n);
  });

  it.each(['gasUsed', 'effectiveGasPrice', 'blockNumber'] as const)('rejects a raw %s inconsistent with the summary', (field) => {
    const c = context();
    c.raw[field] = '1';
    expect(() => verifySavedReceipt(c.saved, c.raw)).toThrow();
  });

  it('does not accept a different status, hash, block or fabricated fee', () => {
    const c = context();
    expect(() => verifySavedReceipt(c.saved, { ...c.raw, status: 'reverted' })).toThrow(/does not match/);
    expect(() => verifySavedReceipt(c.saved, { ...c.raw, transactionHash: BLOCK_HASH })).toThrow(/hash mismatch/);
    expect(() => verifySavedReceipt({ ...c.saved, blockHash: HASH }, c.raw)).toThrow(/not canonical/);
    expect(() => verifySavedReceipt({ ...c.saved, feeWei: '1' }, c.raw)).toThrow(/does not match/);
  });

  it('rejects models, missing confirmations, and malformed saved quantities', () => {
    const c = context();
    expect(() => verifySavedReceipt({ ...c.saved, evidence: 'simulated' } as unknown as SavedReceipt, c.raw)).toThrow(/actual receipts/);
    expect(() => verifySavedReceipt({ ...c.saved, confirmations: '0' }, c.raw)).toThrow(/insufficient confirmations/);
    expect(() => verifySavedReceipt(c.saved, { ...c.raw, gasUsed: '0x1' })).toThrow(/decimal string/);
  });

  it('binds target logs as well as executor logs and refuses removed or reordered logs', () => {
    const c = context();
    const raw = structuredClone(c.raw);
    raw.logs[0]!.transactionHash = BLOCK_HASH;
    expect(() => verifySavedReceipt(c.saved, raw)).toThrow(/different receipt/);
    expect(() => savedReceiptLogs({ ...c.raw, logs: [c.raw.logs[1]!, c.raw.logs[0]!] })).toThrow(/unordered/);
    raw.logs[0] = { ...c.raw.logs[0]!, removed: true };
    expect(() => savedReceiptLogs(raw)).toThrow(/removed/);
  });
});
