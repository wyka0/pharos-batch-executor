/** SYNTHETIC comparison fixtures. No RPC, signing, saved-proof edits or receipts from a live chain. */
import { keccak256, type Hash } from 'viem';
import { describe, expect, it } from 'vitest';
import type { BatchGasEstimates } from '../src/adapters/types.js';
import { buildComparison, createComparisonBinding } from '../src/comparison.js';
import { preparePlan } from '../src/plan.js';
import { resultsFromReceipt, verifyReceipt, type ReceiptLike, type TransactionLike } from '../src/receipt.js';
import type { ActualReceipt, BatchExecutionResult, ComparisonBinding, IndividualExecutionResult } from '../src/types.js';
import { validateActions } from '../src/validation.js';
import { ACCOUNT, EXECUTOR, TARGET_B, threeActions } from './fixtures.js';
import { actionLog, BLOCK_HASH, HASH, rawReceipt, summaryLog } from './receipt-fixtures.js';

const START_HASH = `0x${'12'.repeat(32)}` as Hash;
const STATE_ROOT = `0x${'ef'.repeat(32)}` as Hash;
const individualHashes = [1, 2, 3].map((i) => `0x${String(i).padStart(64, '0')}` as Hash);
const individualBlocks = [51, 52, 53].map((i) => `0x${String(i).repeat(32)}` as Hash);

function fixture(failedAt = -1) {
  const actions = validateActions(threeActions().map((a, i) => ({ ...a, value: i === failedAt ? '0' : String(i + 1) })));
  const prepared = preparePlan(actions);
  const binding = createComparisonBinding(actions, { environment: 'local-evm', chainId: 31337, sender: ACCOUNT, executor: EXECUTOR,
    executorRuntimeCodeHash: keccak256('0x1234'), startingBlock: { number: 8n, hash: START_HASH, stateRoot: STATE_ROOT } });
  const rawBatch = { ...rawReceipt([...actions.map((a, i) => actionLog(a, i, i !== failedAt)), summaryLog(3, failedAt < 0 ? 3 : 2)]), gasUsed: 70_000n };
  const batchReceipt = verifyReceipt(rawBatch, HASH, { canonicalBlockHash: BLOCK_HASH, canonicalBlockParentHash: START_HASH,
    canonicalBlockTransactionCount: 1, currentBlockNumber: 10n });
  const batch: BatchExecutionResult = { kind: 'batch', state: 'confirmed', transactionHash: HASH, receipt: batchReceipt, rawReceipt: rawBatch,
    ...resultsFromReceipt(actions, rawBatch.logs, EXECUTOR, ACCOUNT, { transactionHash: HASH, blockHash: BLOCK_HASH, blockNumber: 9n }),
    comparisonBinding: binding, transaction: { hash: HASH, from: ACCOUNT, to: EXECUTOR, input: prepared.batchCalldata, value: prepared.totalValue,
      chainId: 31337, nonce: 41, blockNumber: 9n, blockHash: BLOCK_HASH, transactionIndex: 0 } };
  const raws = actions.map((_, i) => ({ ...rawReceipt(), transactionHash: individualHashes[i]!, blockNumber: BigInt(9 + i),
    blockHash: individualBlocks[i]!, gasUsed: 30_000n, status: i === failedAt ? 'reverted' as const : 'success' as const }));
  const receipts = raws.map((raw, i) => verifyReceipt(raw, individualHashes[i]!, { canonicalBlockHash: raw.blockHash,
    canonicalBlockParentHash: i === 0 ? START_HASH : individualBlocks[i - 1]!, canonicalBlockTransactionCount: 1, currentBlockNumber: 12n }));
  const individual: IndividualExecutionResult = { kind: 'individual', receipts, rawReceipts: raws, comparisonBinding: structuredClone(binding),
    transactions: actions.map((a, i) => ({ hash: individualHashes[i]!, from: ACCOUNT, to: a.target, input: a.calldata, value: a.value,
      chainId: 31337, nonce: 41 + i, blockNumber: BigInt(9 + i), blockHash: individualBlocks[i]!, transactionIndex: 0 })),
    actions: actions.map((a, i) => ({ index: i, id: a.id, target: a.target, success: i !== failedAt,
      status: i === failedAt ? 'failed' : 'succeeded', transactionHash: individualHashes[i]!, returnDataSource: 'unavailable' })) };
  const estimates: BatchGasEstimates = { individual: actions.map(() => ({ gas: 30_000n, estimate: true, source: 'rpc' })), individualTotal: 90_000n,
    batch: { gas: 800_000n, estimate: true, source: 'rpc' }, blockNumber: 8n };
  return { actions, batch, individual, estimates };
}

type Fixture = ReturnType<typeof fixture>;
type Change = (c: Fixture) => void;

function compare(c: Fixture) { return buildComparison(c.actions, c.estimates, c.batch, c.individual, 'SYNTHETIC identical-starting-state fixture, NOT network evidence.'); }

function remine(c: Fixture, i: number, number: bigint, hash: Hash, parent: Hash, index: number, count = index + 1) {
  const raw = c.individual.rawReceipts![i] as ReceiptLike;
  raw.blockNumber = number; raw.blockHash = hash;
  c.individual.receipts[i] = verifyReceipt(raw, individualHashes[i]!, { canonicalBlockHash: hash, canonicalBlockParentHash: parent,
    canonicalBlockTransactionCount: count, currentBlockNumber: 20n });
  Object.assign(c.individual.transactions![i]!, { blockNumber: number, blockHash: hash, transactionIndex: index });
}

function reuseHash(c: Fixture, i: number, hash: Hash) {
  (c.individual.receipts[i] as ActualReceipt).txHash = hash;
  (c.individual.rawReceipts![i] as ReceiptLike).transactionHash = hash;
  c.individual.transactions![i]!.hash = hash;
  c.individual.actions[i]!.transactionHash = hash;
}

const rejected: Array<[string, Change]> = [
  ['missing batch binding', (c) => { delete c.batch.comparisonBinding; }],
  ['missing individual binding', (c) => { delete c.individual.comparisonBinding; }],
  ['wrong action-plan identity', (c) => { c.individual.comparisonBinding!.actionPlanHash = `sha256:${'00'.repeat(32)}`; }],
  ['different target in the requested plan', (c) => { c.actions[0]!.target = TARGET_B; }],
  ['different calldata in the requested plan', (c) => { c.actions[0]!.calldata = '0x87654321'; }],
  ['different value in the requested plan', (c) => { c.actions[0]!.value++; }],
  ['different call gas in the requested plan', (c) => { c.actions[0]!.gasLimit++; }],
  ['different action order', (c) => { [c.actions[0], c.actions[1]] = [c.actions[1]!, c.actions[0]!]; }],
  ['different environment', (c) => { c.individual.comparisonBinding!.environment = 'atlantic-testnet'; c.individual.comparisonBinding!.chainId = 688689; }],
  ['wrong chain for declared environment', (c) => { c.individual.comparisonBinding!.chainId = 688689; }],
  ['different sender', (c) => { c.individual.comparisonBinding!.sender = TARGET_B; }],
  ['different executor', (c) => { c.individual.comparisonBinding!.executor = TARGET_B; }],
  ['different executor runtime', (c) => { c.individual.comparisonBinding!.executorRuntimeCodeHash = HASH; }],
  ['different starting block number', (c) => { c.individual.comparisonBinding!.startingBlock.number++; }],
  ['different starting block hash', (c) => { c.individual.comparisonBinding!.startingBlock.hash = HASH; }],
  ['different starting state root', (c) => { c.individual.comparisonBinding!.startingBlock.stateRoot = HASH; }],
  ['missing starting state root', (c) => { delete (c.individual.comparisonBinding!.startingBlock as Partial<ComparisonBinding['startingBlock']>).stateRoot; }],
  ['zero sentinel state root', (c) => { c.individual.comparisonBinding!.startingBlock.stateRoot = `0x${'00'.repeat(32)}`; }],
  ['malformed starting hash', (c) => { c.individual.comparisonBinding!.startingBlock.hash = '0x01'; }],
  ['missing batch transaction', (c) => { delete c.batch.transaction; }],
  ['missing individual transactions', (c) => { delete c.individual.transactions; }],
  ['missing raw batch receipt', (c) => { delete c.batch.rawReceipt; }],
  ['missing raw individual receipts', (c) => { delete c.individual.rawReceipts; }],
  ['incomplete normalized receipts', (c) => { c.individual.receipts.pop(); }],
  ['incomplete mined transactions', (c) => { c.individual.transactions!.pop(); }],
  ['incomplete raw receipts', (c) => { c.individual.rawReceipts!.pop(); }],
  ['incomplete individual outcomes', (c) => { c.individual.actions.pop(); }],
  ['incomplete batch outcomes', (c) => { c.batch.actions.pop(); }],
  ['duplicate individual receipt hash', (c) => { reuseHash(c, 1, individualHashes[0]!); }],
  ['batch hash reused by an individual receipt', (c) => { reuseHash(c, 0, HASH); }],
  ['missing individual receipt gas', (c) => { delete (c.individual.receipts[0] as Partial<ActualReceipt>).gasUsed; }],
  ['inconsistent individual fee', (c) => { (c.individual.receipts[0] as ActualReceipt).feeWei++; }],
  ['unconfirmed individual receipt', (c) => { (c.individual.receipts[0] as ActualReceipt).confirmations = 0n; }],
  ['raw individual gas disagrees with normalized receipt', (c) => { (c.individual.rawReceipts![0] as ReceiptLike).gasUsed = 1n; }],
  ['raw individual status disagrees with normalized receipt', (c) => { (c.individual.rawReceipts![0] as ReceiptLike).status = 'reverted'; }],
  ['batch hash does not match its receipt', (c) => { c.batch.transactionHash = individualHashes[0]!; }],
  ['different batch calldata', (c) => { c.batch.transaction!.input = '0x12345678'; }],
  ['different batch value', (c) => { c.batch.transaction!.value++; }],
  ['different individual transaction target', (c) => { c.individual.transactions![0]!.to = TARGET_B; }],
  ['different individual transaction calldata', (c) => { c.individual.transactions![0]!.input = '0x87654321'; }],
  ['different individual transaction value', (c) => { c.individual.transactions![0]!.value++; }],
  ['different individual transaction sender', (c) => { c.individual.transactions![0]!.from = TARGET_B; }],
  ['different individual transaction chain', (c) => { c.individual.transactions![0]!.chainId = 688689; }],
  ['missing mined block number', (c) => { delete c.individual.transactions![0]!.blockNumber; }],
  ['missing mined block hash', (c) => { delete c.individual.transactions![0]!.blockHash; }],
  ['missing transaction index', (c) => { delete c.individual.transactions![0]!.transactionIndex; }],
  ['missing nonce', (c) => { delete (c.individual.transactions![0] as Partial<TransactionLike>).nonce; }],
  ['nonce gap', (c) => { c.individual.transactions![1]!.nonce++; }],
  ['different first nonce', (c) => { c.individual.transactions!.forEach((tx) => tx.nonce++); }],
  ['batch not first in its block', (c) => { c.batch.transaction!.transactionIndex = 1; }],
  ['individual not first in its starting child block', (c) => { c.individual.transactions![0]!.transactionIndex = 1; }],
  ['missing batch parent hash', (c) => { delete (c.batch.receipt as ActualReceipt).parentBlockHash; }],
  ['missing batch block transaction count', (c) => { delete (c.batch.receipt as ActualReceipt).blockTransactionCount; }],
  ['missing baseline block transaction count', (c) => { delete (c.individual.receipts[0] as ActualReceipt).blockTransactionCount; }],
  ['invalid baseline block transaction count', (c) => { (c.individual.receipts[0] as ActualReceipt).blockTransactionCount = 0; }],
  ['mined index outside the canonical block count', (c) => { c.individual.transactions![2]!.transactionIndex = 1; }],
  ['intervening trailing transaction between baseline blocks', (c) => { (c.individual.receipts[0] as ActualReceipt).blockTransactionCount = 2; }],
  ['inconsistent transaction counts within one baseline block', (c) => { remine(c, 1, 9n, individualBlocks[0]!, START_HASH, 1, 2); }],
  ['wrong batch parent hash', (c) => { (c.batch.receipt as ActualReceipt).parentBlockHash = HASH; }],
  ['wrong individual starting parent', (c) => { (c.individual.receipts[0] as ActualReceipt).parentBlockHash = HASH; }],
  ['later receipt has wrong parent', (c) => { (c.individual.receipts[1] as ActualReceipt).parentBlockHash = HASH; }],
  ['intervening block before first baseline receipt', (c) => { remine(c, 0, 10n, individualBlocks[0]!, START_HASH, 0); }],
  ['intervening block between baseline actions', (c) => { remine(c, 1, 11n, individualBlocks[1]!, individualBlocks[0]!, 0); }],
  ['reordered baseline mining', (c) => { remine(c, 1, 8n, individualBlocks[1]!, START_HASH, 0); }],
  ['intervening transaction in a shared baseline block', (c) => { remine(c, 1, 9n, individualBlocks[0]!, START_HASH, 2); }],
  ['duplicate baseline transaction index', (c) => { remine(c, 1, 9n, individualBlocks[0]!, START_HASH, 0); }],
  ['unknown individual outcome', (c) => { c.individual.actions[0]!.success = null; }],
  ['different action result identifier', (c) => { c.individual.actions[0]!.id = 'other'; }],
  ['different action result target', (c) => { c.individual.actions[0]!.target = TARGET_B; }],
  ['outcome and individual receipt disagree', (c) => { c.individual.actions[0]!.success = false; c.individual.actions[0]!.status = 'failed'; }],
  ['missing individual outcome hash', (c) => { delete c.individual.actions[0]!.transactionHash; }],
  ['modeled individual outcome attached to actual receipt', (c) => { c.individual.actions[0]!.returnDataSource = 'model'; }],
  ['simulated batch outcome attached to actual receipt', (c) => { c.batch.actions[0]!.returnDataSource = 'simulation'; }],
  ['batch return data disagrees with receipt event', (c) => { c.batch.actions[0]!.returnData = '0x01'; }],
  ['batch claimed outcome disagrees with receipt event', (c) => { c.batch.actions[0]!.success = false; c.batch.actions[0]!.status = 'failed'; }],
  ['missing executor receipt events', (c) => { (c.batch.rawReceipt as ReceiptLike).logs = []; }],
  ['unknown batch state', (c) => { c.batch.state = 'unknown'; }],
  ['unverified batch state', (c) => { c.batch.state = 'unverified'; }],
  ['reverted outer batch', (c) => { c.batch.state = 'reverted'; (c.batch.receipt as ActualReceipt).status = 'reverted'; }],
  ['errored individual baseline', (c) => { c.individual.error = 'fixture incomplete execution'; }],
  ['outstanding failed-value credit', (c) => { c.batch.refundCreditWei = 1n; }],
];

describe('strict gas comparison bindings', () => {
  it('accepts an exact plan and identical starting state with distinct, transaction-bound receipts', () => {
    const c = fixture();
    const before = structuredClone(c);
    const result = compare(c);
    expect(result.baselineValidation).toEqual({ status: 'accepted' });
    expect(result.individual.measuredGas).toEqual({ gas: 90_000n, measured: true, receipts: 3 });
    expect(result.batch.measuredGas).toEqual({ gas: 70_000n, measured: true, receipts: 1 });
    expect(result.measuredSavings).toEqual({ gas: 20_000n, fraction: 0.222222 });
    expect(result.transactionReduction).toEqual({ count: 2, fraction: 2 / 3 });
    expect(c).toEqual(before); // validation never alters captures or evidence
  });

  it('accepts consecutive transactions in the same baseline block', () => {
    const c = fixture();
    remine(c, 0, 9n, individualBlocks[0]!, START_HASH, 0, 3);
    remine(c, 1, 9n, individualBlocks[0]!, START_HASH, 1, 3);
    remine(c, 2, 9n, individualBlocks[0]!, START_HASH, 2, 3);
    expect(compare(c).baselineValidation?.status).toBe('accepted');
  });

  it('accepts a baseline crossing from the last transaction of one block to the first of its child', () => {
    const c = fixture();
    remine(c, 0, 9n, individualBlocks[0]!, START_HASH, 0, 2);
    remine(c, 1, 9n, individualBlocks[0]!, START_HASH, 1, 2);
    remine(c, 2, 10n, individualBlocks[2]!, individualBlocks[0]!, 0, 1);
    expect(compare(c).baselineValidation?.status).toBe('accepted');
  });

  it('accepts equivalent receipt/event-verified failed zero-value calls without inventing business success', () => {
    const c = fixture(1);
    expect(compare(c).baselineValidation?.status).toBe('accepted');
    expect(c.batch.actions[1]?.success).toBe(false);
    expect(compare(c).limitations.join(' ')).toContain('CALL success does not prove application postconditions');
  });

  it('keeps negative measured differences explicit, not advertised as a discount', () => {
    const c = fixture();
    const raw = c.batch.rawReceipt as ReceiptLike;
    raw.gasUsed = 100_000n;
    c.batch.receipt = verifyReceipt(raw, HASH, { canonicalBlockHash: BLOCK_HASH, canonicalBlockParentHash: START_HASH,
      canonicalBlockTransactionCount: 1, currentBlockNumber: 10n });
    expect(compare(c).measuredSavings).toEqual({ gas: -10_000n, fraction: -0.111111 });
  });

  it('retains standalone batch gas with no baseline, but emits no measured saving', () => {
    const c = fixture();
    const result = buildComparison(c.actions, c.estimates, c.batch);
    expect(result.batch.measuredGas?.gas).toBe(70_000n);
    expect(result.individual.measuredGas).toBeUndefined();
    expect(result.measuredSavings).toBeUndefined();
    expect(result.baselineValidation).toBeUndefined();
  });

  it('supports a correctly bound Atlantic-shaped fixture without calling it network proof', () => {
    const c = fixture();
    for (const binding of [c.batch.comparisonBinding!, c.individual.comparisonBinding!]) {
      binding.environment = 'atlantic-testnet'; binding.chainId = 688689;
    }
    c.batch.transaction!.chainId = 688689;
    c.individual.transactions!.forEach((tx) => { tx.chainId = 688689; });
    expect(compare(c).baselineValidation?.status).toBe('accepted'); // SYNTHETIC unit observations only
  });

  it.each(['batch', 'individual'] as const)('rejects an Atlantic-shaped %s fixture below the two-confirmation policy', (side) => {
    const c = fixture();
    for (const binding of [c.batch.comparisonBinding!, c.individual.comparisonBinding!]) {
      binding.environment = 'atlantic-testnet'; binding.chainId = 688689;
    }
    c.batch.transaction!.chainId = 688689;
    c.individual.transactions!.forEach((tx) => { tx.chainId = 688689; });
    (side === 'batch' ? c.batch.receipt as ActualReceipt : c.individual.receipts[0] as ActualReceipt).confirmations = 1n;
    expect(compare(c).baselineValidation?.status).toBe('rejected');
    expect(compare(c).measuredSavings).toBeUndefined();
  });

  it.each(rejected)('rejects %s and withholds measured baseline/savings', (_label, change) => {
    const c = fixture();
    change(c);
    const before = structuredClone(c);
    const result = compare(c);
    expect(result.baselineValidation?.status).toBe('rejected');
    expect(result.individual.measuredGas).toBeUndefined();
    expect(result.measuredSavings).toBeUndefined();
    expect(result.batch.measuredGas?.gas).toBe(70_000n);
    expect(c).toEqual(before);
  });

  it.each(['target', 'calldata', 'value'] as const)('rejects re-declared matching plan hashes when the mined %s differs', (field) => {
    const c = fixture();
    if (field === 'target') c.actions[0]!.target = TARGET_B;
    if (field === 'calldata') c.actions[0]!.calldata = '0x87654321';
    if (field === 'value') c.actions[0]!.value++;
    const changed = preparePlan(c.actions);
    c.batch.comparisonBinding!.actionPlanHash = changed.planHash;
    c.individual.comparisonBinding!.actionPlanHash = changed.planHash;
    expect(compare(c).baselineValidation?.status).toBe('rejected');
  });

  it('revalidates oversized typed action plans instead of comparing by an arbitrary count', () => {
    const c = fixture();
    const oversized = Array.from({ length: 33 }, (_, i) => ({ ...c.actions[0]!, id: `oversized-${i}` }));
    expect(() => buildComparison(oversized, c.estimates, c.batch, c.individual)).toThrow(/limit of 32/);
  });
});
