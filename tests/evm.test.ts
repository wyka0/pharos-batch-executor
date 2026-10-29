import { encodeFunctionResult, keccak256, type Hash } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { BATCH_EXECUTOR_ABI } from '../src/abi.js';
import { EvmAdapter, type ApprovedSubmitter, type EvmPublicClient } from '../src/adapters/evm.js';
import { preparePlan } from '../src/plan.js';
import { validateActions } from '../src/validation.js';
import { ACCOUNT, EXECUTOR, TARGET_B, threeActions } from './fixtures.js';
import { actionLog, BLOCK_HASH, HASH, rawReceipt, summaryLog } from './receipt-fixtures.js';
import { CALLER_GETTER_DATA, callerReply } from './caller-fixtures.js';

const actions = validateActions(threeActions());
function context(options?: { reader?: Partial<EvmPublicClient>; submitter?: ApprovedSubmitter }) {
  const submitted = vi.fn(async () => ({ state: 'submitted' as const, hash: HASH }));
  const client: EvmPublicClient = {
    getChainId: vi.fn(async () => 31337), getBlockNumber: vi.fn(async () => 10n),
    getBlock: vi.fn(async () => ({ hash: BLOCK_HASH, gasLimit: 30_000_000n })),
    getBalance: vi.fn(async () => 1_000_000_000_000_000_000n), getCode: vi.fn(async () => '0x1234' as const),
    estimateGas: vi.fn(async ({ to }) => to === EXECUTOR ? 800_000n : 30_000n),
    call: vi.fn(async ({ data }) => data === CALLER_GETTER_DATA ? callerReply() : ({ data: encodeFunctionResult({ abi: BATCH_EXECUTOR_ABI, functionName: 'execute', result: actions.map(() => ({ success: true, data: '0x' as const, returnDataSize: 0n })) }) })),
    waitForTransactionReceipt: vi.fn(async () => rawReceipt([...actions.map((a, i) => actionLog(a, i)), summaryLog(3, 3)])),
    getTransaction: vi.fn(async () => ({ hash: HASH, from: ACCOUNT, to: EXECUTOR, input: preparePlan(actions).batchCalldata, value: 0n, chainId: 31337, nonce: 0,
      blockNumber: 9n, blockHash: BLOCK_HASH, transactionIndex: 0 })),
    ...options?.reader,
  };
  const adapter = new EvmAdapter({ id: 'local-anvil', rpcUrl: 'http://127.0.0.1:12345', account: ACCOUNT, batchExecutor: EXECUTOR,
    expectedExecutorCodeHash: keccak256('0x1234'), publicClient: client, submitter: options?.submitter ?? { submit: submitted } });
  return { adapter, client, submitted };
}

describe('EVM adapter (mock RPC only)', () => {
  it('dry-run never invokes submission or receipt polling', async () => {
    const { adapter, submitted, client } = context();
    expect((await adapter.simulateBatch(actions)).state).toBe('dry_run');
    expect(submitted).not.toHaveBeenCalled();
    expect(client.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('records failed individual gas estimate without inventing a total or blocking batch simulation', async () => {
    const { adapter } = context({ reader: { estimateGas: vi.fn(async ({ to }) => {
      if (to === TARGET_B) throw new Error('fixture revert');
      return 800_000n;
    }) } });
    const estimates = await adapter.estimateGas(actions);
    expect(estimates.individual[1]?.gas).toBeNull();
    expect(estimates.individual[1]?.error).toContain('two');
    expect(estimates.individualTotal).toBeNull();
    expect(estimates.batch.gas).toBe(800_000n);
    expect((await adapter.simulateBatch(actions)).state).toBe('dry_run');
  });

  it('blocks a batch estimation failure instead of broadcasting a guessed gas limit', async () => {
    const { adapter, submitted } = context({ reader: { estimateGas: vi.fn(async () => { throw new Error('fixture RPC failure'); }) } });
    expect((await adapter.executeBatch(actions)).state).toBe('not_submitted');
    expect(submitted).not.toHaveBeenCalled();
  });

  it('rejects wrong chain and changed runtime before signing', async () => {
    const wrongChain = context({ reader: { getChainId: vi.fn(async () => 1672) } });
    await expect(wrongChain.adapter.executeBatch(actions)).rejects.toThrow(/chain ID/);
    expect(wrongChain.submitted).not.toHaveBeenCalled();
    await expect(context({ reader: { getCode: vi.fn(async () => '0xabcd' as const) } }).adapter.estimateGas(actions)).rejects.toThrow(/bytecode/);
  });

  it.each(['estimateGas', 'simulateBatch', 'executeBatch', 'executeIndividual'] as const)('blocks an unauthorized submitting wallet in %s', async (method) => {
    const { adapter, submitted, client } = context({ reader: { call: vi.fn(async () => callerReply(TARGET_B)) } });
    await expect(adapter[method](actions)).rejects.toThrow(/authorized caller/);
    expect(submitted).not.toHaveBeenCalled();
    expect(client.waitForTransactionReceipt).not.toHaveBeenCalled();
    expect(vi.mocked(client.call).mock.calls.every(([request]) => request.data === CALLER_GETTER_DATA)).toBe(true);
  });

  it('requires a broadcast capability independently of dry-run success', async () => {
    const { client } = context();
    const adapter = new EvmAdapter({ id: 'local-anvil', rpcUrl: 'http://127.0.0.1:1', account: ACCOUNT,
      batchExecutor: EXECUTOR, expectedExecutorCodeHash: keccak256('0x1234'), publicClient: client });
    await expect(adapter.executeBatch(actions)).rejects.toThrow(/no broadcast capability/);
  });

  it('verifies one receipt and every action, with no post-receipt eth_call replay', async () => {
    const { adapter, submitted, client } = context();
    const result = await adapter.executeBatch(actions);
    expect(result.state).toBe('confirmed');
    expect(result.actions.map((a) => a.success)).toEqual([true, true, true]);
    expect(result.receipt).toMatchObject({ txHash: HASH, gasUsed: 120_000n, blockNumber: 9n });
    expect(submitted).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(client.call).mock.calls.map(([request]) => request);
    expect(calls.filter((request) => request.data !== CALLER_GETTER_DATA)).toHaveLength(1); // PRE-send execute simulation only
    expect(calls.at(-1)).toMatchObject({ data: CALLER_GETTER_DATA, blockNumber: 9n }); // getter, not outcome replay
    expect(client.getTransaction).toHaveBeenCalledTimes(1); // capture the same transaction that was verified
  });

  it('a receipt-block caller mismatch preserves receipt gas but refuses batch outcomes', async () => {
    const c = context();
    const call = c.client.call;
    c.client.call = vi.fn(async (request) => request.data === CALLER_GETTER_DATA && request.blockNumber === 9n ? callerReply(TARGET_B) : call(request));
    const result = await c.adapter.executeBatch(actions);
    expect(result.state).toBe('unverified');
    expect(result.receipt).toMatchObject({ evidence: 'actual', gasUsed: 120_000n });
    expect(result.actions.every((a) => a.success === null)).toBe(true);
    expect(c.submitted).toHaveBeenCalledTimes(1);
  });

  it('captures the starting header and the receipt-bound mined transaction, without a second transaction read', async () => {
    const startingHash = `0x${'12'.repeat(32)}` as Hash;
    const stateRoot = `0x${'34'.repeat(32)}` as Hash;
    let sent = false;
    const c = context({ reader: {
      getBlockNumber: vi.fn(async () => sent ? 10n : 8n),
      getBlock: vi.fn(async ({ blockNumber }) => ({ hash: blockNumber === 8n ? startingHash : BLOCK_HASH, stateRoot,
        parentHash: startingHash, gasLimit: 30_000_000n, transactions: [HASH] })),
    }, submitter: { submit: vi.fn(async () => { sent = true; return { state: 'submitted' as const, hash: HASH, nonce: 0 }; }) } });
    const result = await c.adapter.executeBatch(actions);
    expect(result.state).toBe('confirmed');
    expect(result.comparisonBinding).toEqual({ actionPlanHash: preparePlan(actions).planHash, environment: 'local-evm', chainId: 31337,
      sender: ACCOUNT, executor: EXECUTOR, executorRuntimeCodeHash: keccak256('0x1234'), startingBlock: { number: 8n, hash: startingHash, stateRoot } });
    expect(result.receipt).toMatchObject({ parentBlockHash: startingHash, blockTransactionCount: 1 });
    expect(result.transaction).toMatchObject({ hash: HASH, blockNumber: 9n, blockHash: BLOCK_HASH, transactionIndex: 0 });
    expect(c.client.getTransaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(c.client.call).mock.calls.some(([request]) => request.data === CALLER_GETTER_DATA && request.blockNumber === 8n)).toBe(true);
  });

  it('does not invent a starting-state binding when the RPC omits the state root', async () => {
    const c = context();
    const result = await c.adapter.executeBatch(actions);
    expect(result.state).toBe('confirmed');
    expect(result.comparisonBinding).toBeUndefined();
    expect(result.receipt).toMatchObject({ gasUsed: 120_000n });
  });

  it('captures all individual mined transactions and one starting-state binding', async () => {
    const startingHash = `0x${'12'.repeat(32)}` as Hash;
    const stateRoot = `0x${'34'.repeat(32)}` as Hash;
    const hashes = actions.map((_, i) => `0x${String(i + 1).padStart(64, '0')}` as Hash);
    let next = 0;
    const c = context({ reader: {
      getBlockNumber: vi.fn(async () => BigInt(8 + next)),
      getBlock: vi.fn(async ({ blockNumber }) => ({ hash: blockNumber === 8n ? startingHash : BLOCK_HASH, stateRoot,
        parentHash: startingHash, gasLimit: 30_000_000n })),
      waitForTransactionReceipt: vi.fn(async ({ hash }) => ({ ...rawReceipt(), transactionHash: hash, blockNumber: BigInt(9 + hashes.indexOf(hash)) })),
      getTransaction: vi.fn(async ({ hash }) => {
        const i = hashes.indexOf(hash);
        return { hash, from: ACCOUNT, to: actions[i]!.target, input: actions[i]!.calldata, value: actions[i]!.value, chainId: 31337, nonce: i,
          blockNumber: BigInt(9 + i), blockHash: BLOCK_HASH, transactionIndex: 0 };
      }),
    }, submitter: { submit: vi.fn(async () => ({ state: 'submitted' as const, hash: hashes[next]!, nonce: next++ })) } });
    const result = await c.adapter.executeIndividual(actions);
    expect(result.error).toBeUndefined();
    expect(result.transactions?.map((tx) => tx.hash)).toEqual(hashes);
    expect(result.comparisonBinding?.startingBlock).toEqual({ number: 8n, hash: startingHash, stateRoot });
    expect(c.client.getTransaction).toHaveBeenCalledTimes(3);
    expect(vi.mocked(c.client.call).mock.calls.every(([request]) => request.data === CALLER_GETTER_DATA)).toBe(true);
  });

  it('preserves a known hash on receipt timeout and never sends again', async () => {
    const { adapter, submitted } = context({ reader: { waitForTransactionReceipt: vi.fn(async () => { throw new Error('timeout'); }) } });
    const result = await adapter.executeBatch(actions);
    expect(result.state).toBe('unknown');
    expect(result.transactionHash).toBe(HASH);
    expect(result.actions.every((a) => a.success === null && a.status === 'unknown')).toBe(true);
    expect(submitted).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unknown submission', async () => {
    const submit = vi.fn(async () => ({ state: 'unknown' as const, hash: HASH, error: 'fixture uncertain send' }));
    const { adapter, client } = context({ submitter: { submit } });
    const result = await adapter.executeBatch(actions);
    expect(result.state).toBe('unknown');
    expect(result.transactionHash).toBe(HASH);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(client.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('outer revert preserves gas evidence and marks ALL actions not committed', async () => {
    const { adapter } = context({ reader: { waitForTransactionReceipt: vi.fn(async () => ({ ...rawReceipt(), status: 'reverted' as const })) } });
    const result = await adapter.executeBatch(actions);
    expect(result.state).toBe('reverted');
    expect(result.receipt).toMatchObject({ status: 'reverted', gasUsed: 120_000n });
    expect(result.actions.map((a) => a.status)).toEqual(['not_committed', 'not_committed', 'not_committed']);
  });

  it('a successful receipt with missing action logs is UNVERIFIED, not action success', async () => {
    const { adapter } = context({ reader: { waitForTransactionReceipt: vi.fn(async () => rawReceipt()) } });
    const result = await adapter.executeBatch(actions);
    expect(result.state).toBe('unverified');
    expect(result.receipt).toMatchObject({ gasUsed: 120_000n });
    expect(result.actions.every((a) => a.success === null)).toBe(true);
  });

  it('refuses a transaction larger than the block gas limit', async () => {
    const { adapter, submitted } = context({ reader: { getBlock: vi.fn(async () => ({ hash: BLOCK_HASH, gasLimit: 100n })) } });
    await expect(adapter.executeBatch(actions)).rejects.toThrow(/block gas limit/);
    expect(submitted).not.toHaveBeenCalled();
  });

  it('refuses 32 default-gas calls under a 5,000,000 approved bound even if a mock RPC underestimates them', async () => {
    const oversized = validateActions(Array.from({ length: 32 }, (_, i) => ({ ...threeActions()[0]!, id: `oversized-${i}` })));
    const c = context({ reader: { call: vi.fn(async ({ data }) => data === CALLER_GETTER_DATA ? callerReply() : ({ data: encodeFunctionResult({
      abi: BATCH_EXECUTOR_ABI, functionName: 'execute', result: oversized.map(() => ({ success: true, data: '0x' as const, returnDataSize: 0n })),
    }) })) } });
    const adapter = new EvmAdapter({ id: 'local-anvil', rpcUrl: 'http://127.0.0.1:12345', account: ACCOUNT, batchExecutor: EXECUTOR,
      expectedExecutorCodeHash: keccak256('0x1234'), publicClient: c.client, submitter: { submit: c.submitted }, approvedGasLimit: 5_000_000n });
    await expect(adapter.executeBatch(oversized)).rejects.toThrow(/execution reservation/);
    expect(c.submitted).not.toHaveBeenCalled();
  });

  it('an unexpected submitter exception is UNKNOWN, not safe-to-retry', async () => {
    const submit = vi.fn(async () => { throw new Error('untrusted sensitive exception'); });
    const { adapter } = context({ submitter: { submit } });
    const result = await adapter.executeBatch(actions);
    expect(result.state).toBe('unknown');
    expect(result.actions.every((a) => a.success === null)).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result.error).not.toContain('untrusted sensitive');
  });

  it('individual baseline uncertainty stops later sends and reports every action', async () => {
    const submit = vi.fn(async () => ({ state: 'unknown' as const, hash: HASH }));
    const { adapter } = context({ submitter: { submit } });
    const result = await adapter.executeIndividual(actions);
    expect(result.actions.map((a) => a.status)).toEqual(['unknown', 'not_submitted', 'not_submitted']);
    expect(result.actions[0]?.transactionHash).toBe(HASH);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
