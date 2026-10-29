import { encodeFunctionResult, keccak256 } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { BATCH_EXECUTOR_ABI } from '../src/abi.js';
import { EvmAdapter, type ApprovedSubmitter, type EvmPublicClient } from '../src/adapters/evm.js';
import { preparePlan } from '../src/plan.js';
import { validateActions } from '../src/validation.js';
import { ACCOUNT, EXECUTOR, TARGET_B, threeActions } from './fixtures.js';
import { actionLog, BLOCK_HASH, HASH, rawReceipt, summaryLog } from './receipt-fixtures.js';

const actions = validateActions(threeActions());
function context(options?: { reader?: Partial<EvmPublicClient>; submitter?: ApprovedSubmitter }) {
  const submitted = vi.fn(async () => ({ state: 'submitted' as const, hash: HASH }));
  const client: EvmPublicClient = {
    getChainId: vi.fn(async () => 31337), getBlockNumber: vi.fn(async () => 10n),
    getBlock: vi.fn(async () => ({ hash: BLOCK_HASH, gasLimit: 30_000_000n })),
    getBalance: vi.fn(async () => 1_000_000_000_000_000_000n), getCode: vi.fn(async () => '0x1234' as const),
    estimateGas: vi.fn(async ({ to }) => to === EXECUTOR ? 800_000n : 30_000n),
    call: vi.fn(async () => ({ data: encodeFunctionResult({ abi: BATCH_EXECUTOR_ABI, functionName: 'execute', result: actions.map(() => ({ success: true, data: '0x' as const, returnDataSize: 0n })) }) })),
    waitForTransactionReceipt: vi.fn(async () => rawReceipt([...actions.map((a, i) => actionLog(a, i)), summaryLog(3, 3)])),
    getTransaction: vi.fn(async () => ({ hash: HASH, from: ACCOUNT, to: EXECUTOR, input: preparePlan(actions).batchCalldata, value: 0n, chainId: 31337, nonce: 0 })),
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
    expect(client.call).toHaveBeenCalledTimes(1); // PRE-send simulation only
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
