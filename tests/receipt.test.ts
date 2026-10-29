import { encodeAbiParameters, encodeEventTopics, type Log } from 'viem';
import { describe, expect, it } from 'vitest';
import { BATCH_EXECUTOR_ABI } from '../src/abi.js';
import { decodeRevertData, resultsFromReceipt, verifyActionEvents, verifyReceipt, verifyTransaction } from '../src/receipt.js';
import { validateActions } from '../src/validation.js';
import { ACCOUNT, EXECUTOR, TARGET_A, threeActions } from './fixtures.js';
import { actionLog, BLOCK_HASH, HASH, rawReceipt, summaryLog } from './receipt-fixtures.js';

const CHECKS = { currentBlockNumber: 10n, canonicalBlockHash: BLOCK_HASH, minimumConfirmations: 2n };

describe('receipt verification (synthetic fixtures, offline)', () => {
  it('preserves actual usage, status, block and exact fee', () => {
    const receipt = verifyReceipt(rawReceipt(), HASH, CHECKS);
    expect(receipt.gasUsed).toBe(120_000n);
    expect(receipt.blockNumber).toBe(9n);
    expect(receipt.confirmations).toBe(2n);
    expect(receipt.feeWei).toBe(1_200_000_000_000_000n);
  });

  it('captures canonical parent and transaction-count observations without inventing missing metadata', () => {
    const receipt = verifyReceipt(rawReceipt(), HASH, { ...CHECKS, canonicalBlockParentHash: HASH, canonicalBlockTransactionCount: 3 });
    expect(receipt).toMatchObject({ parentBlockHash: HASH, blockTransactionCount: 3 });
    expect(verifyReceipt(rawReceipt(), HASH, CHECKS)).not.toHaveProperty('blockTransactionCount');
    expect(verifyReceipt(rawReceipt(), HASH, CHECKS)).not.toHaveProperty('parentBlockHash');
  });

  it.each([-1, 0, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid canonical block transaction count: %s', (count) => {
    expect(() => verifyReceipt(rawReceipt(), HASH, { ...CHECKS, canonicalBlockTransactionCount: count })).toThrow(/canonical block transaction count/);
  });

  it('preserves reverted status rather than inventing success', () => {
    expect(verifyReceipt({ ...rawReceipt(), status: 'reverted' }, HASH, CHECKS).status).toBe('reverted');
  });

  it.each([
    ['missing gas', { gasUsed: undefined }, /gasUsed/],
    ['zero gas', { gasUsed: 0n }, /gasUsed/],
    ['missing status', { status: undefined }, /status/],
    ['missing block', { blockNumber: undefined }, /blockNumber/],
    ['zero block', { blockNumber: 0n }, /blockNumber/],
    ['wrong hash', { transactionHash: BLOCK_HASH }, /hash mismatch/],
    ['orphaned block', { blockHash: HASH }, /canonical/],
    ['missing gas price', { effectiveGasPrice: undefined }, /effectiveGasPrice/],
  ])('rejects %s', (_label, changes, pattern) => {
    expect(() => verifyReceipt({ ...rawReceipt(), ...changes }, HASH, CHECKS)).toThrow(pattern);
  });

  it('rejects insufficient confirmations', () => {
    expect(() => verifyReceipt(rawReceipt(), HASH, { ...CHECKS, currentBlockNumber: 9n })).toThrow(/confirmations/);
  });

  it('checks signed transaction chain, sender, recipient, calldata, value and nonce', () => {
    const tx = { hash: HASH, from: ACCOUNT, to: EXECUTOR, input: '0x1234' as const, value: 0n, chainId: 31337, nonce: 7 };
    const expected = { hash: HASH, from: ACCOUNT, to: EXECUTOR, data: '0x1234' as const, value: 0n, chainId: 31337, nonce: 7 };
    verifyTransaction(tx, expected);
    expect(() => verifyTransaction({ ...tx, chainId: 1672 }, expected)).toThrow(/chain ID/);
    expect(() => verifyTransaction({ ...tx, nonce: 8 }, expected)).toThrow(/nonce/);
    expect(() => verifyTransaction({ ...tx, from: TARGET_A }, expected)).toThrow(/sender/);
    expect(() => verifyTransaction({ ...tx, input: '0xffff' }, expected)).toThrow(/calldata/);
  });

  it('decodes a real-format Error(string) and empty/unknown revert data honestly', () => {
    const data = `0x08c379a0${encodeAbiParameters([{ type: 'string' }], ['failed call']).slice(2)}` as const;
    expect(decodeRevertData(data)).toBe('failed call');
    expect(decodeRevertData('0x')).toBeUndefined();
    expect(decodeRevertData('0xffff')).toContain('unrecognized');
  });
});

describe('per-action receipt evidence', () => {
  const actions = validateActions(threeActions());
  const events = actions.map((a, index) => ({ index, idBytes32: a.idBytes32, target: a.target, success: true, result: '0x' as const, returnDataSize: 0n }));

  it('requires every action exactly once', () => {
    expect(verifyActionEvents(actions, events)).toHaveLength(3);
    expect(() => verifyActionEvents(actions, events.slice(0, 2))).toThrow(/missing/);
    expect(() => verifyActionEvents(actions, [...events, events[0]!])).toThrow(/duplicate/);
    expect(() => verifyActionEvents(actions, [...events, { ...events[0]!, index: 3 }])).toThrow(/unexpected/);
  });

  it('rejects wrong ids, targets and return size', () => {
    expect(() => verifyActionEvents(actions, [{ ...events[0]!, idBytes32: HASH }, ...events.slice(1)])).toThrow(/id mismatch/);
    expect(() => verifyActionEvents(actions, [{ ...events[0]!, target: EXECUTOR }, ...events.slice(1)])).toThrow(/target mismatch/);
    expect(() => verifyActionEvents(actions, [{ ...events[0]!, returnDataSize: 1n }, ...events.slice(1)])).toThrow(/return-data/);
  });

  it('ignores forged executor-like events emitted by a target', () => {
    const actualLogs = [...actions.map((a, i) => actionLog(a, i)), summaryLog(3, 3)];
    const forged = { ...actionLog(actions[0]!, 0), address: TARGET_A };
    expect(resultsFromReceipt(actions, [forged, ...actualLogs], EXECUTOR, ACCOUNT).actions).toHaveLength(3);
    expect(() => resultsFromReceipt(actions, [forged, summaryLog(3, 3)], EXECUTOR, ACCOUNT)).toThrow(/missing/);
  });

  it('rejects missing/inconsistent batch summary and removed logs', () => {
    const logs = actions.map((a, i) => actionLog(a, i));
    expect(() => resultsFromReceipt(actions, logs, EXECUTOR, ACCOUNT)).toThrow(/summary/);
    expect(() => resultsFromReceipt(actions, [...logs, summaryLog(3, 2)], EXECUTOR, ACCOUNT)).toThrow(/summary/);
    expect(() => resultsFromReceipt(actions, [{ ...logs[0]!, removed: true }, ...logs.slice(1), summaryLog(3, 3)], EXECUTOR, ACCOUNT)).toThrow(/removed/);
  });

  it('binds every executor log to the receipt transaction and block', () => {
    const logs = [...actions.map((a, i) => actionLog(a, i)), summaryLog(3, 3)];
    const location = { transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: 9n };
    expect(resultsFromReceipt(actions, logs, EXECUTOR, ACCOUNT, location).actions).toHaveLength(3);
    expect(() => resultsFromReceipt(actions, [{ ...logs[0]!, transactionHash: BLOCK_HASH }, ...logs.slice(1)], EXECUTOR, ACCOUNT, location)).toThrow(/another transaction/);
    expect(() => resultsFromReceipt(actions, [{ ...logs[0]!, blockNumber: 8n }, ...logs.slice(1)], EXECUTOR, ACCOUNT, location)).toThrow(/another transaction or block/);
  });

  it('does not accept a separate withdrawal event as batch execution evidence', () => {
    const withdrawal: Log = { ...summaryLog(3, 3),
      topics: encodeEventTopics({ abi: BATCH_EXECUTOR_ABI, eventName: 'RefundWithdrawn', args: { sender: ACCOUNT, recipient: ACCOUNT } }) as Log['topics'],
      data: encodeAbiParameters([{ type: 'uint256' }], [1000n]),
    };
    expect(() => resultsFromReceipt(actions, [...actions.map((a, i) => actionLog(a, i)), withdrawal,
      { ...summaryLog(3, 3), logIndex: 4 }], EXECUTOR, ACCOUNT)).toThrow(/unexpected executor event/);
  });
});
