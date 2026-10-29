import { TransactionNotFoundError } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { broadcastPlanHash, type BroadcastPlan } from '../src/testnet/broadcast-plan.js';
import type { JournalEntry } from '../src/testnet/journal.js';
import { reconcilePlan, type ReconcileClient } from '../src/testnet/reconcile.js';
import { validateActions } from '../src/validation.js';
import { batchPlan, deployPlan } from './broadcast-fixtures.js';
import { ACCOUNT } from './fixtures.js';
import { actionLog, BLOCK_HASH, HASH, rawReceipt, summaryLog } from './receipt-fixtures.js';
import { CALLER_GETTER_DATA, callerReply } from './caller-fixtures.js';

function context(plan: BroadcastPlan = deployPlan(), changes: Partial<ReconcileClient> = {}) {
  const entry: JournalEntry = { at: new Date().toISOString(), planHash: broadcastPlanHash(plan), index: 0,
    id: plan.transactions[0]!.id, state: 'INTENT', transactionHash: HASH, nonce: plan.transactions[0]!.nonce };
  const tx = plan.transactions[0]!;
  const client: ReconcileClient = {
    getChainId: vi.fn(async () => 688689), getBlockNumber: vi.fn(async () => 10n),
    getBlock: vi.fn(async () => ({ hash: BLOCK_HASH, gasLimit: 30_000_000n })),
    getBalance: vi.fn(async () => 1n), getGasPrice: vi.fn(async () => 10_000_000_000n),
    getTransactionCount: vi.fn(async () => 1), getCode: vi.fn(async () => '0x00' as const),
    estimateGas: vi.fn(async () => { throw new Error('Reconciliation must not estimate/send'); }),
    call: vi.fn(async (request) => {
      expect(request).toEqual({ account: plan.sender, to: plan.batchExecutor ?? tx.expectedContractAddress, data: CALLER_GETTER_DATA, value: 0n, blockNumber: 9n });
      return callerReply(plan.sender); // only the ownership getter; no execute replay
    }),
    waitForTransactionReceipt: vi.fn(async () => { throw new Error('Reconciliation must not wait or poll'); }),
    getTransaction: vi.fn(async () => ({ hash: HASH, from: ACCOUNT, to: tx.to, input: tx.data, value: BigInt(tx.valueWei), chainId: 688689, nonce: tx.nonce })),
    getTransactionReceipt: vi.fn(async () => ({ ...rawReceipt(), contractAddress: tx.expectedContractAddress ?? null })),
    ...changes,
  };
  return { plan, entry, client };
}

describe('read-only reconciliation', () => {
  it('verifies an intent receipt and deployed runtime without signing, waiting or replay', async () => {
    const c = context();
    const result = await reconcilePlan(c.plan, [c.entry], c.client);
    expect(result.steps.map((s) => s.state)).toEqual(['CONFIRMED', 'NOT_SUBMITTED']);
    expect(result.steps[0]?.receipt?.gasUsed).toBe(120_000n);
    expect(c.client.call).toHaveBeenCalledTimes(1); // receipt-block ownership getter only
    expect(c.client.estimateGas).not.toHaveBeenCalled();
    expect(c.client.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('accepts expired historical plans ONLY for read-only inspection', async () => {
    const plan = deployPlan();
    plan.createdAt = new Date(Date.now() - 180_000).toISOString();
    plan.expiresAt = new Date(Date.now() - 120_000).toISOString();
    const c = context(plan);
    expect((await reconcilePlan(plan, [c.entry], c.client)).steps[0]?.state).toBe('CONFIRMED');
  });

  it('a matching transaction without a receipt remains unresolved, not successful', async () => {
    const c = context(undefined, { getTransactionReceipt: vi.fn(async () => null) });
    const result = await reconcilePlan(c.plan, [c.entry], c.client);
    expect(result.steps[0]?.state).toBe('PENDING');
    expect(result.unresolvedHashes).toBe(true);
  });

  it('a consumed nonce with no matching hash is UNKNOWN, never a retry recommendation', async () => {
    const c = context(undefined, { getTransactionReceipt: vi.fn(async () => null), getTransaction: vi.fn(async () => { throw new TransactionNotFoundError({ hash: HASH }); }) });
    const result = await reconcilePlan(c.plan, [c.entry], c.client);
    expect(result.steps[0]?.state).toBe('UNKNOWN');
    expect(result.steps[0]?.error).toContain('nonce is consumed');
  });

  it('RPC errors do not mean the transaction was not sent', async () => {
    const c = context(undefined, { getTransactionReceipt: vi.fn(async () => { throw new Error('untrusted payload'); }) });
    const result = await reconcilePlan(c.plan, [c.entry], c.client);
    expect(result.steps[0]?.state).toBe('UNKNOWN');
    expect(result.steps[0]?.error).not.toContain('untrusted payload');
  });

  it('reports every mixed batch action from receipt events, not from simulation', async () => {
    const plan = batchPlan(ACCOUNT, 1);
    const actions = validateActions(plan.actions);
    const c = context(plan, { getTransactionReceipt: vi.fn(async () => rawReceipt([
      ...actions.map((a, i) => actionLog(a, i, i !== 1)), summaryLog(3, 2),
    ])) });
    const result = await reconcilePlan(plan, [c.entry], c.client);
    expect(result.allTransactionsConfirmed).toBe(true);
    expect(result.steps[0]?.actions?.map((a) => a.success)).toEqual([true, false, true]);
    expect(result.comparison?.measuredSavings).toBeUndefined();
    expect(c.client.call).toHaveBeenCalledTimes(1); // receipt-block ownership getter, never execute
  });

  it('outer revert marks all batch actions not committed', async () => {
    const plan = batchPlan();
    const c = context(plan, { getTransactionReceipt: vi.fn(async () => ({ ...rawReceipt(), status: 'reverted' as const })) });
    const result = await reconcilePlan(plan, [c.entry], c.client);
    expect(result.steps[0]?.state).toBe('REVERTED');
    expect(result.steps[0]?.actions?.map((a) => a.status)).toEqual(['not_committed', 'not_committed', 'not_committed']);
  });

  it('missing events preserve verified gas but leave all action outcomes unknown', async () => {
    const plan = batchPlan();
    const c = context(plan);
    const result = await reconcilePlan(plan, [c.entry], c.client);
    expect(result.steps[0]?.state).toBe('UNVERIFIED');
    expect(result.steps[0]?.receipt?.gasUsed).toBe(120_000n);
    expect(result.steps[0]?.actions?.every((a) => a.success === null)).toBe(true);
  });

  it.each(['deployment', 'batch'] as const)('a %s receipt with a wrong authorized caller remains unverified', async (kind) => {
    const plan = kind === 'batch' ? batchPlan() : deployPlan();
    const c = context(plan, { call: vi.fn(async () => callerReply('0x1111111111111111111111111111111111111111')) });
    const result = await reconcilePlan(plan, [c.entry], c.client);
    expect(result.steps[0]?.state).toBe('UNVERIFIED');
    expect(result.steps[0]?.receipt?.gasUsed).toBe(120_000n);
    expect(result.steps[0]?.actions?.every((a) => a.success === null) ?? true).toBe(true);
  });

  it('preserves a locally aborted hash as not submitted without freeing its intent', async () => {
    const plan = batchPlan();
    const c = context(plan, { getTransactionReceipt: vi.fn(async () => null),
      getTransaction: vi.fn(async () => { throw new TransactionNotFoundError({ hash: HASH }); }), getTransactionCount: vi.fn(async () => 0) });
    const entries: JournalEntry[] = [c.entry, { ...c.entry, state: 'ABORTED_BEFORE_SEND' }];
    const before = structuredClone(entries);
    const result = await reconcilePlan(plan, entries, c.client);
    expect(result.steps[0]?.state).toBe('ABORTED_BEFORE_SEND');
    expect(result.steps[0]?.transactionHash).toBe(HASH);
    expect(result.steps[0]?.actions?.every((a) => a.status === 'not_submitted' && a.success === null)).toBe(true);
    expect(result.steps[0]?.error).toContain('Durable intent retained');
    expect(result.allTransactionsConfirmed).toBe(false);
    expect(result.unresolvedHashes).toBe(false);
    expect(result.comparison?.batch.measuredGas).toBeUndefined();
    expect(entries).toEqual(before);
    expect(c.client.call).not.toHaveBeenCalled();
  });

  it.each(['receipt', 'pending transaction'] as const)('a visible %s conflicts with a pre-send abort and cannot be called confirmed', async (visible) => {
    const c = context(batchPlan(), visible === 'pending transaction' ? { getTransactionReceipt: vi.fn(async () => null) } : {});
    const result = await reconcilePlan(c.plan, [c.entry, { ...c.entry, state: 'ABORTED_BEFORE_SEND' }], c.client);
    expect(result.steps[0]?.state).toBe('UNVERIFIED');
    expect(result.steps[0]?.error).toContain('conflict');
    expect(result.unresolvedHashes).toBe(true);
    expect(result.allTransactionsConfirmed).toBe(false);
    expect(result.comparison?.measuredSavings).toBeUndefined();
  });

  it.each(['latest', 'pending'] as const)('an advanced %s nonce keeps an aborted hash unresolved when it is not found', async (advanced) => {
    const c = context(batchPlan(), { getTransactionReceipt: vi.fn(async () => null),
      getTransaction: vi.fn(async () => { throw new TransactionNotFoundError({ hash: HASH }); }),
      getTransactionCount: vi.fn(async ({ blockTag }) => blockTag === advanced ? 1 : 0) });
    const result = await reconcilePlan(c.plan, [c.entry, { ...c.entry, state: 'ABORTED_BEFORE_SEND' }], c.client);
    expect(result.steps[0]?.state).toBe('UNKNOWN');
    expect(result.unresolvedHashes).toBe(true);
  });

  it('does not trust abort status when receipt RPC lookup fails', async () => {
    const c = context(batchPlan(), { getTransactionReceipt: vi.fn(async () => { throw new Error('fixture untrusted RPC failure'); }) });
    const result = await reconcilePlan(c.plan, [c.entry, { ...c.entry, state: 'ABORTED_BEFORE_SEND' }], c.client);
    expect(result.steps[0]?.state).toBe('UNKNOWN');
    expect(result.steps[0]?.error).not.toContain('untrusted');
  });

  it('rejects abort-after-submission or submission-after-abort journal sequences before RPC lookups', async () => {
    const c = context();
    await expect(reconcilePlan(c.plan, [c.entry, { ...c.entry, state: 'SUBMITTED' }, { ...c.entry, state: 'ABORTED_BEFORE_SEND' }], c.client)).rejects.toThrow(/sequence is inconsistent/);
    await expect(reconcilePlan(c.plan, [c.entry, { ...c.entry, state: 'ABORTED_BEFORE_SEND' }, { ...c.entry, state: 'SUBMITTED' }], c.client)).rejects.toThrow(/sequence is inconsistent/);
    expect(c.client.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('no recorded intent produces no receipt queries or invented hashes', async () => {
    const c = context();
    const result = await reconcilePlan(c.plan, [], c.client);
    expect(result.steps.every((s) => s.state === 'NOT_SUBMITTED' && s.transactionHash === undefined)).toBe(true);
    expect(c.client.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('rejects journal/plan mismatches and wrong chains before interpreting receipts', async () => {
    const c = context();
    await expect(reconcilePlan(c.plan, [{ ...c.entry, nonce: 9 }], c.client)).rejects.toThrow(/does not match/);
    const wrong = context(undefined, { getChainId: vi.fn(async () => 1672) });
    await expect(reconcilePlan(wrong.plan, [wrong.entry], wrong.client)).rejects.toThrow(/chain ID/);
    expect(wrong.client.getTransactionReceipt).not.toHaveBeenCalled();
  });
});
