/** Mock RPC + freshly generated, in-memory signing keys ONLY. No HTTP/send. */
import { rm } from 'node:fs/promises';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionResult, keccak256, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractArtifact } from '../src/artifacts.js';
import { BATCH_EXECUTOR_ABI } from '../src/abi.js';
import { validateActions } from '../src/validation.js';
import { broadcastPlanHash } from '../src/testnet/broadcast-plan.js';
import { ExecutionJournal } from '../src/testnet/journal.js';
import { executeApprovedPlan, type RunnerClient, type RunnerDependencies } from '../src/testnet/runner.js';
import type { UnsignedTestnetTransaction } from '../src/testnet/signer.js';
import { batchPlan, deployPlan } from './broadcast-fixtures.js';
import { actionLog, BLOCK_HASH, rawReceipt, summaryLog } from './receipt-fixtures.js';
import { testTempDirectory } from './temp.js';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function context(changes: Partial<RunnerClient> = {}, purpose: 'deploy' | 'batch' = 'deploy', failedAt = -1) {
  const account = privateKeyToAccount(generatePrivateKey()); // never printed or persisted
  const plan = purpose === 'deploy' ? deployPlan(account.address) : batchPlan(account.address, failedAt);
  const hash = broadcastPlanHash(plan);
  const dir = await testTempDirectory(); directories.push(dir);
  const journal = new ExecutionJournal(dir, hash);
  const signed = new Map<Hex, UnsignedTestnetTransaction>();
  let nonce = 0;
  const client: RunnerClient = {
    getChainId: vi.fn(async () => 688689), getBlockNumber: vi.fn(async () => 10n),
    getBlock: vi.fn(async () => ({ hash: BLOCK_HASH, gasLimit: 30_000_000n })),
    getBalance: vi.fn(async () => 1_000_000_000_000_000_000n), getGasPrice: vi.fn(async () => 10_000_000_000n),
    getTransactionCount: vi.fn(async () => nonce), getCode: vi.fn(async () => '0x00' as const),
    estimateGas: vi.fn(async () => 100_000n), call: vi.fn(async () => ({ data: purpose === 'deploy' ? '0x' as const : encodeFunctionResult({
      abi: BATCH_EXECUTOR_ABI, functionName: 'execute', result: plan.expectedSimulation!.map((a) => ({ success: a.success, data: a.returnData, returnDataSize: BigInt(a.returnDataSize) })),
    }) })),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }) => {
      expect((await journal.read()).at(-1)?.state).toBe('INTENT'); // PROVES write-before-send
      nonce++;
      return keccak256(serializedTransaction);
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash: txHash }) => {
      const tx = signed.get(txHash)!;
      const logs = purpose === 'deploy' ? [] : [
        ...validateActions(plan.actions).map((a, i) => actionLog(a, i, i !== failedAt)), summaryLog(3, failedAt < 0 ? 3 : 2, plan.sender),
      ].map((log) => ({ ...log, transactionHash: txHash }));
      return { ...rawReceipt(logs), transactionHash: txHash, contractAddress: plan.transactions[tx.nonce]!.expectedContractAddress ?? null };
    }),
    getTransaction: vi.fn(async ({ hash: txHash }) => {
      const tx = signed.get(txHash)!;
      return { hash: txHash, from: plan.sender, to: tx.to ?? null, input: tx.data, value: tx.value, chainId: 688689, nonce: tx.nonce };
    }),
    ...changes,
  };
  const signerLoader = vi.fn(async () => ({ async sign(tx: UnsignedTestnetTransaction) {
    const raw = await account.signTransaction(tx); signed.set(keccak256(raw), tx); return raw;
  } }));
  const artifactLoader: RunnerDependencies['artifactLoader'] = async (name) => ({ contractName: name,
    source: 'UNIT FIXTURE', sourceHash: 'UNIT FIXTURE', compiler: 'solc-0.8.24', evmVersion: 'paris', optimizerRuns: 200,
    abi: [], bytecode: '0x6000', runtimeBytecode: '0x00', runtimeCodeHash: keccak256('0x00'), bytecodeHash: keccak256('0x6000') } satisfies ContractArtifact);
  const deps: RunnerDependencies = { client, journal, signerLoader, artifactLoader, onEvidence: vi.fn(async () => {}) };
  return { plan, hash, deps, client, signerLoader, journal };
}

describe('gated testnet runner — offline mock requests only', () => {
  it('requires approval and confirmation BEFORE key loading or submission', async () => {
    const c = await context();
    await expect(executeApprovedPlan(c.plan, c.hash, false, c.deps)).rejects.toThrow(/confirm/);
    await expect(executeApprovedPlan(c.plan, 'wrong', true, c.deps)).rejects.toThrow(/plan-hash/);
    expect(c.signerLoader).not.toHaveBeenCalled();
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong chain', { getChainId: vi.fn(async () => 1672) }, /chain/],
    ['insufficient funding', { getBalance: vi.fn(async () => 0n) }, /balance/],
    ['nonce changed', { getTransactionCount: vi.fn(async () => 3) }, /Nonce/],
    ['gas price raised', { getGasPrice: vi.fn(async () => 30_000_000_000n) }, /Gas price/],
    ['estimation failure', { estimateGas: vi.fn(async () => { throw new Error('fixture estimate failure'); }) }, /estimate failure/],
  ])('blocks %s before loading keys', async (_label, changes, pattern) => {
    const c = await context(changes);
    await expect(executeApprovedPlan(c.plan, c.hash, true, c.deps)).rejects.toThrow(pattern);
    expect(c.signerLoader).not.toHaveBeenCalled();
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('validates the signed payload and writes durable intent BEFORE each single submission', async () => {
    const c = await context();
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.state).toBe('CONFIRMED');
    expect(result.steps.map((s) => s.state)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(result.steps.every((s) => s.receipt?.gasUsed === 120_000n && s.receipt.blockNumber === 9n)).toBe(true);
    expect(c.client.sendRawTransaction).toHaveBeenCalledTimes(2); // TWO SETUP txs, NEVER called a batch
    expect((await c.journal.read()).map((entry) => entry.state)).toEqual(['INTENT', 'SUBMITTED', 'CONFIRMED', 'INTENT', 'SUBMITTED', 'CONFIRMED']);
  });

  it('never retries after a possibly accepted send; preserves hash and remaining NOT_SUBMITTED', async () => {
    const send = vi.fn(async () => { throw new Error('fixture transport error with potentially sensitive payload'); });
    const c = await context({ sendRawTransaction: send });
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.state).toBe('HALTED');
    expect(result.steps.map((s) => s.state)).toEqual(['UNKNOWN', 'NOT_SUBMITTED']);
    expect(result.steps[0]?.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('potentially sensitive payload');
    await expect(executeApprovedPlan(c.plan, c.hash, true, c.deps)).rejects.toThrow(/execution intent/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(c.signerLoader).toHaveBeenCalledTimes(1);
  });

  it('receipt timeout stops remaining transactions and preserves the known hash', async () => {
    const c = await context({ waitForTransactionReceipt: vi.fn(async () => { throw new Error('timeout'); }) });
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps.map((s) => s.state)).toEqual(['UNKNOWN', 'NOT_SUBMITTED']);
    expect(c.client.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('runtime mismatch is unverified despite a successful receipt, and stops the remaining setup', async () => {
    const c = await context({ getCode: vi.fn(async () => '0x11' as const) });
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps.map((s) => s.state)).toEqual(['UNVERIFIED', 'NOT_SUBMITTED']);
    expect(result.steps[0]?.receipt?.status).toBe('success');
    expect(c.client.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('malformed signer output is rejected OFFLINE before any intent or send', async () => {
    const c = await context();
    c.deps.signerLoader = async () => ({ sign: async () => '0x01' });
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps.map((s) => s.state)).toEqual(['NOT_SUBMITTED', 'NOT_SUBMITTED']);
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(await c.journal.read()).toHaveLength(0);
  });

  it('executes three mixed-outcome actions using EXACTLY ONE signed batch transaction', async () => {
    const c = await context({}, 'batch', 1);
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.state).toBe('CONFIRMED');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.actions?.map((a) => a.success)).toEqual([true, false, true]);
    expect(result.steps[0]?.expectedOutcomesMatch).toBe(true);
    expect(c.client.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(result.comparison?.individual.estimatedGas.gas).toBeNull();
    expect(result.comparison?.batch.measuredGas?.gas).toBe(120_000n);
    expect(result.comparison?.measuredSavings).toBeUndefined();
  });

  it('fresh simulation divergence blocks the batch BEFORE key loading', async () => {
    const c = await context({ call: vi.fn(async () => ({ data: encodeFunctionResult({ abi: BATCH_EXECUTOR_ABI, functionName: 'execute',
      result: [{ success: false, data: '0x', returnDataSize: 0n }, { success: true, data: '0x', returnDataSize: 0n }, { success: true, data: '0x', returnDataSize: 0n }],
    }) })) }, 'batch');
    await expect(executeApprovedPlan(c.plan, c.hash, true, c.deps)).rejects.toThrow(/outcomes differ/);
    expect(c.signerLoader).not.toHaveBeenCalled();
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('caller-plan mutation during signing cannot change the captured approval', async () => {
    const c = await context();
    const originalLoader = c.deps.signerLoader;
    c.deps.signerLoader = async () => {
      c.plan.transactions[0]!.data = '0x6001';
      return originalLoader();
    };
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.state).toBe('CONFIRMED');
    expect(result.plan.transactions[0]?.data).toBe('0x6000');
    expect(result.planHash).toBe(c.hash);
  });

  it('evidence callback mutation cannot alter an execution step', async () => {
    const c = await context();
    c.deps.onEvidence = async (snapshot) => { snapshot.steps[0]!.state = 'UNKNOWN'; };
    expect((await executeApprovedPlan(c.plan, c.hash, true, c.deps)).state).toBe('CONFIRMED');
  });

  it('evidence failure after INTENT prevents sending and retains an uncertain hash', async () => {
    const c = await context();
    let saves = 0;
    c.deps.onEvidence = async () => { if (++saves === 2) throw new Error('fixture disk failure'); };
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps.map((s) => s.state)).toEqual(['UNKNOWN', 'NOT_SUBMITTED']);
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect((await c.journal.read())[0]?.state).toBe('INTENT');
  });

  it('rechecks expiry after signing and refuses a delayed expired plan', async () => {
    const c = await context();
    let clock = Date.now();
    const originalLoader = c.deps.signerLoader;
    c.deps.now = () => clock;
    c.deps.signerLoader = async () => {
      const signer = await originalLoader();
      return { async sign(tx) { const raw = await signer.sign(tx); clock += 120_000; return raw; } };
    };
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps.every((s) => s.state === 'NOT_SUBMITTED')).toBe(true);
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it.each(['chainId', 'nonce', 'gas', 'gasPrice', 'value', 'data'] as const)('rejects a valid signature with altered %s before intent', async (field) => {
    const c = await context();
    const originalLoader = c.deps.signerLoader;
    c.deps.signerLoader = async () => {
      const signer = await originalLoader();
      return { sign: (tx) => signer.sign({ ...tx, [field]: field === 'data' ? '0x6001' : field === 'nonce' ? 9 : field === 'chainId' ? 1672 : 1n } as UnsignedTestnetTransaction) };
    };
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps[0]?.state).toBe('NOT_SUBMITTED');
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(await c.journal.read()).toHaveLength(0);
  });
});
