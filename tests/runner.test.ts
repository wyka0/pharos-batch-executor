/** Mock RPC and synthetic signing identifiers ONLY. No HTTP, keys or signatures. */
import { rm } from 'node:fs/promises';
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
import { CALLER_GETTER_DATA, callerReply } from './caller-fixtures.js';
import { DeploymentStore } from '../src/testnet/deployments.js';
import { ACCOUNT } from './fixtures.js';
import { fakeSign } from './mock-signatures.js';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

async function context(changes: Partial<RunnerClient> = {}, purpose: 'deploy' | 'batch' = 'deploy', failedAt = -1) {
  const plan = purpose === 'deploy' ? deployPlan(ACCOUNT) : batchPlan(ACCOUNT, failedAt);
  const hash = broadcastPlanHash(plan);
  const dir = await testTempDirectory(); directories.push(dir);
  const journal = new ExecutionJournal(dir, hash);
  const deployments = new DeploymentStore(dir);
  // These runner-unit tests isolate submission guards. Staged integration tests
  // exercise real prerequisite records and their RPC re-verification end-to-end.
  if (purpose === 'batch') vi.spyOn(deployments, 'verifyPrerequisites').mockResolvedValue();
  const signed = new Map<Hex, UnsignedTestnetTransaction>();
  let nonce = 0;
  const client: RunnerClient = {
    getChainId: vi.fn(async () => 688689), getBlockNumber: vi.fn(async () => 10n),
    getBlock: vi.fn(async () => ({ hash: BLOCK_HASH, gasLimit: 30_000_000n })),
    getBalance: vi.fn(async () => 1_000_000_000_000_000_000n), getGasPrice: vi.fn(async () => 10_000_000_000n),
    getTransactionCount: vi.fn(async ({ address }) => address.toLowerCase() === plan.sender.toLowerCase() ? nonce : 0),
    getCode: vi.fn(async ({ address }) => address.toLowerCase() === plan.sender.toLowerCase() ||
      (purpose === 'deploy' && nonce === 0 && address.toLowerCase() === plan.transactions[0]!.expectedContractAddress!.toLowerCase()) ? '0x' as const : '0x00' as const),
    estimateGas: vi.fn(async () => 100_000n), call: vi.fn(async ({ data }) => data === CALLER_GETTER_DATA ? callerReply(plan.sender) : ({ data: purpose === 'deploy' ? '0x' as const : encodeFunctionResult({
      abi: BATCH_EXECUTOR_ABI, functionName: 'execute', result: plan.expectedSimulation!.map((a) => ({ success: a.success, data: a.returnData, returnDataSize: BigInt(a.returnDataSize) })),
    }) })),
    sendRawTransaction: vi.fn(async ({ serializedTransaction }) => {
      expect((await journal.read()).at(-1)?.state).toBe('INTENT'); // PROVES write-before-send
      nonce++;
      return keccak256(serializedTransaction);
    }),
    waitForTransactionReceipt: vi.fn(async ({ hash: txHash }) => {
      const logs = purpose === 'deploy' ? [] : [
        ...validateActions(plan.actions).map((a, i) => actionLog(a, i, i !== failedAt)), summaryLog(3, failedAt < 0 ? 3 : 2, plan.sender),
      ].map((log) => ({ ...log, transactionHash: txHash }));
      return { ...rawReceipt(logs), transactionHash: txHash, contractAddress: plan.transactions[0]!.expectedContractAddress ?? null };
    }),
    getTransaction: vi.fn(async ({ hash: txHash }) => {
      const tx = signed.get(txHash)!;
      return { hash: txHash, from: plan.sender, to: tx.to ?? null, input: tx.data, value: tx.value, chainId: 688689, nonce: tx.nonce, type: tx.type, gas: tx.gas, gasPrice: tx.gasPrice };
    }),
    getTransactionReceipt: vi.fn(async () => null),
    ...changes,
  };
  const sign = vi.fn(async (tx: UnsignedTestnetTransaction) => {
    const raw = fakeSign(tx, plan.sender); signed.set(keccak256(raw), tx); return raw;
  });
  const signerLoader = vi.fn(async () => ({ sign }));
  const artifactLoader: RunnerDependencies['artifactLoader'] = async (name) => ({ contractName: name,
    source: 'UNIT FIXTURE', sourceHash: 'UNIT FIXTURE', compiler: 'solc-0.8.24', evmVersion: 'paris', optimizerRuns: 200,
    abi: [], bytecode: '0x6000', runtimeBytecode: '0x00', runtimeCodeHash: keccak256('0x00'), bytecodeHash: keccak256('0x6000') } satisfies ContractArtifact);
  const deps: RunnerDependencies = { client, journal, deployments, signerLoader, artifactLoader, onEvidence: vi.fn(async () => {}) };
  return { plan, hash, deps, client, signerLoader, sign, journal, dir };
}

function approvalClock(c: Awaited<ReturnType<typeof context>>) {
  let time = Date.parse(c.plan.createdAt) + 1_000;
  const expires = Date.parse(c.plan.expiresAt);
  c.deps.now = () => time;
  return { expires, expire() { time = expires; }, beforeExpiry() { time = expires - 1; } };
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
    ['estimation failure', { estimateGas: vi.fn(async () => { throw new Error('fixture estimate failure'); }) }, /preflight/],
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
    expect(result.steps.map((s) => s.state)).toEqual(['CONFIRMED']);
    expect(result.steps.every((s) => s.receipt?.gasUsed === 120_000n && s.receipt.blockNumber === 9n)).toBe(true);
    expect(c.client.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect((await c.journal.read()).map((entry) => entry.state)).toEqual(['INTENT', 'SUBMITTED', 'CONFIRMED']);
    expect(result.steps[0]?.deploymentRecord).toBeDefined();
  });

  it('never retries after a possibly accepted send; preserves hash and remaining NOT_SUBMITTED', async () => {
    const send = vi.fn(async () => { throw new Error('fixture transport error with potentially sensitive payload'); });
    const c = await context({ sendRawTransaction: send });
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.state).toBe('HALTED');
    expect(result.steps.map((s) => s.state)).toEqual(['UNKNOWN']);
    expect(result.steps[0]?.transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('potentially sensitive payload');
    await expect(executeApprovedPlan(c.plan, c.hash, true, c.deps)).rejects.toThrow(/stage already/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(c.signerLoader).toHaveBeenCalledTimes(1);
  });

  it('receipt timeout stops remaining transactions and preserves the known hash', async () => {
    const c = await context({ waitForTransactionReceipt: vi.fn(async () => { throw new Error('timeout'); }) });
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps.map((s) => s.state)).toEqual(['UNKNOWN']);
    expect(c.client.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('runtime mismatch is unverified despite a successful receipt, and stops the remaining setup', async () => {
    const c = await context();
    const getCode = c.client.getCode;
    c.client.getCode = vi.fn(async (request) => request.blockNumber === 9n ? '0x11' : getCode(request));
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps.map((s) => s.state)).toEqual(['UNVERIFIED']);
    expect(result.steps[0]?.receipt?.status).toBe('success');
    expect(c.client.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('rejects a batch owned by a different wallet before loading signing configuration', async () => {
    const c = await context({ call: vi.fn(async () => callerReply('0x1111111111111111111111111111111111111111')) }, 'batch');
    await expect(executeApprovedPlan(c.plan, c.hash, true, c.deps)).rejects.toThrow(/authorized caller/);
    expect(c.signerLoader).not.toHaveBeenCalled();
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(await c.journal.read()).toHaveLength(0);
  });

  it('a deployment receipt with a different authorized caller remains UNVERIFIED', async () => {
    const c = await context({ call: vi.fn(async () => callerReply('0x1111111111111111111111111111111111111111')) });
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps.map((step) => step.state)).toEqual(['UNVERIFIED']);
    expect(result.steps[0]?.receipt?.gasUsed).toBe(120_000n);
    expect(c.client.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(c.client.call).mock.calls[0]?.[0]).toMatchObject({ data: CALLER_GETTER_DATA, blockNumber: 9n, to: c.plan.transactions[0]!.expectedContractAddress });
  });

  it('rechecks the authorized caller after signing and refuses a changed RPC ownership response', async () => {
    const c = await context({}, 'batch');
    const call = c.client.call;
    c.client.call = vi.fn(async (request) => c.sign.mock.calls.length > 0 && request.data === CALLER_GETTER_DATA
      ? callerReply('0x1111111111111111111111111111111111111111') : call(request));
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps[0]?.state).toBe('ABORTED_BEFORE_SEND');
    expect(c.sign).toHaveBeenCalledTimes(1);
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(await c.journal.read()).toHaveLength(0);
  });

  it('a batch receipt-block ownership mismatch cannot be reported as committed action success', async () => {
    const c = await context({}, 'batch');
    const call = c.client.call;
    c.client.call = vi.fn(async (request) => request.data === CALLER_GETTER_DATA && request.blockNumber === 9n
      ? callerReply('0x1111111111111111111111111111111111111111') : call(request));
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps[0]?.state).toBe('UNVERIFIED');
    expect(result.steps[0]?.receipt?.gasUsed).toBe(120_000n);
    expect(result.steps[0]?.actions?.every((a) => a.success === null)).toBe(true);
    expect(c.client.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('malformed signer output is rejected OFFLINE before any intent or send', async () => {
    const c = await context();
    c.deps.signerLoader = async () => ({ sign: async () => '0x01' });
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps.map((s) => s.state)).toEqual(['ABORTED_BEFORE_SEND']);
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
    const c = await context({ call: vi.fn(async ({ data, account }) => data === CALLER_GETTER_DATA ? callerReply(account) : ({ data: encodeFunctionResult({ abi: BATCH_EXECUTOR_ABI, functionName: 'execute',
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
    expect(result.steps.map((s) => s.state)).toEqual(['UNKNOWN']);
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
    expect(result.steps.every((s) => s.state === 'ABORTED_BEFORE_SEND')).toBe(true);
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(await c.journal.read()).toHaveLength(0);
  });

  it.each(['artifact checks', 'journal acquisition', 'initial evidence persistence', 'signer loading'] as const)('fails closed when approval expires during %s', async (boundary) => {
    const c = await context();
    const clock = approvalClock(c);
    if (boundary === 'artifact checks') {
      const load = c.deps.artifactLoader!;
      c.deps.artifactLoader = async (name) => { const artifact = await load(name); clock.expire(); return artifact; };
    }
    if (boundary === 'journal acquisition') {
      const acquire = c.journal.acquire.bind(c.journal);
      vi.spyOn(c.journal, 'acquire').mockImplementation(async (...args) => { await acquire(...args); clock.expire(); });
    }
    if (boundary === 'initial evidence persistence') c.deps.onEvidence = async () => { await Promise.resolve(); clock.expire(); };
    if (boundary === 'signer loading') {
      const load = c.deps.signerLoader;
      c.deps.signerLoader = async () => { const signer = await load(); clock.expire(); return signer; };
    }
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.state).toBe('HALTED');
    expect(result.steps.every((step) => step.state === 'ABORTED_BEFORE_SEND')).toBe(true);
    expect(c.sign).not.toHaveBeenCalled();
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(await c.journal.read()).toHaveLength(0);
    expect(c.signerLoader).toHaveBeenCalledTimes(boundary === 'signer loading' ? 1 : 0);
  });

  it.each([
    ['initial preflight', 1, 'ABORTED_BEFORE_SEND'], ['pre-sign checks', 2, 'ABORTED_BEFORE_SEND'], ['post-sign checks', 3, 'ABORTED_BEFORE_SEND'],
  ] as const)('catches expiry during %s, including awaits after signed-payload verification', async (_label, expireRead, expected) => {
    const c = await context();
    const clock = approvalClock(c);
    const read = c.client.getBlock;
    let reads = 0;
    c.client.getBlock = vi.fn(async (request) => { const block = await read(request); if (++reads === expireRead) clock.expire(); return block; });
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.state).toBe('HALTED');
    expect(result.steps.map((step) => step.state)).toEqual([expected]);
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect((await c.journal.read()).map((entry) => entry.state)).toEqual(expireRead === 3 ? ['INTENT', 'ABORTED_BEFORE_SEND'] : []);
  });

  it('rechecks expiry after a fresh per-step gas-estimate await, before signing', async () => {
    const c = await context();
    const clock = approvalClock(c);
    const estimate = c.client.estimateGas;
    let estimates = 0;
    c.client.estimateGas = vi.fn(async (request) => { const gas = await estimate(request); if (++estimates === 2) clock.expire(); return gas; });
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps.every((step) => step.state === 'ABORTED_BEFORE_SEND')).toBe(true);
    expect(c.sign).not.toHaveBeenCalled();
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('rechecks expiry after a fresh per-step batch-simulation await, before signing', async () => {
    const c = await context({}, 'batch');
    const clock = approvalClock(c);
    const call = c.client.call;
    let simulations = 0;
    c.client.call = vi.fn(async (request) => { const reply = await call(request); if (request.data !== CALLER_GETTER_DATA && ++simulations === 2) clock.expire(); return reply; });
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps[0]?.state).toBe('ABORTED_BEFORE_SEND');
    expect(c.sign).not.toHaveBeenCalled();
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('catches expiry during the final post-sign ownership getter and marks every batch action not submitted', async () => {
    const c = await context({}, 'batch');
    const clock = approvalClock(c);
    const call = c.client.call;
    c.client.call = vi.fn(async (request) => { const reply = await call(request); if (request.data === CALLER_GETTER_DATA && c.sign.mock.calls.length > 0) clock.expire(); return reply; });
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps[0]?.state).toBe('ABORTED_BEFORE_SEND');
    expect(result.steps[0]?.actions?.every((a) => a.status === 'not_submitted' && a.success === null)).toBe(true);
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(result.comparison?.batch.measuredGas).toBeUndefined();
    expect((await c.journal.read()).map((entry) => entry.state)).toEqual(['INTENT', 'ABORTED_BEFORE_SEND']);
  });

  it.each(['intent journal fsync', 'intent evidence persistence'] as const)('final expiry guard prevents ALL send calls after delayed %s and retains retry-blocking intents', async (boundary) => {
    const c = await context();
    const clock = approvalClock(c);
    if (boundary === 'intent journal fsync') {
      const append = c.journal.append.bind(c.journal);
      vi.spyOn(c.journal, 'append').mockImplementation(async (entry) => { await append(entry); if (entry.state === 'INTENT') clock.expire(); });
    } else c.deps.onEvidence = async (snapshot) => { await Promise.resolve(); if (snapshot.steps[0]?.state === 'INTENT') clock.expire(); };
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.state).toBe('HALTED');
    expect(result.steps.map((step) => step.state)).toEqual(['ABORTED_BEFORE_SEND']);
    expect(result.steps[0]?.error).toContain('No RPC submission attempted');
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    const entries = await c.journal.read();
    expect(entries.map((entry) => entry.state)).toEqual(['INTENT', 'ABORTED_BEFORE_SEND']);
    expect(entries[0]?.transactionHash).toBe(entries[1]?.transactionHash);
    const same = new ExecutionJournal(c.dir, c.hash);
    await expect(same.acquire(c.plan.sender, [0])).rejects.toThrow(/execution intent/);
    const freshPlan = structuredClone(c.plan);
    freshPlan.createdAt = new Date(clock.expires + 1_000).toISOString();
    freshPlan.expiresAt = new Date(clock.expires + 61_000).toISOString();
    const freshHash = broadcastPlanHash(freshPlan);
    const freshDeps = { ...c.deps, journal: new ExecutionJournal(c.dir, freshHash), now: () => clock.expires + 2_000 };
    await expect(executeApprovedPlan(freshPlan, freshHash, true, freshDeps)).rejects.toThrow(/stage already/);
    expect(c.signerLoader).toHaveBeenCalledTimes(1);
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('an abort-journal persistence failure still cannot send and never removes the original INTENT', async () => {
    const c = await context();
    const clock = approvalClock(c);
    c.deps.onEvidence = async (snapshot) => { if (snapshot.steps[0]?.state === 'INTENT') clock.expire(); };
    const append = c.journal.append.bind(c.journal);
    vi.spyOn(c.journal, 'append').mockImplementation(async (entry) => {
      if (entry.state === 'ABORTED_BEFORE_SEND') throw new Error('untrusted disk error contents');
      await append(entry);
    });
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps[0]?.state).toBe('ABORTED_BEFORE_SEND');
    expect(result.steps[0]?.error).toContain('abort persistence failed');
    expect(result.steps[0]?.error).not.toContain('untrusted');
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect((await c.journal.read()).map((entry) => entry.state)).toEqual(['INTENT']);
  });

  it('expiry is a submission deadline, not a requirement that confirmation finish before expiry', async () => {
    const c = await context({}, 'batch');
    const clock = approvalClock(c);
    c.deps.onEvidence = async (snapshot) => { if (snapshot.steps[0]?.state === 'INTENT') clock.beforeExpiry(); };
    const send = c.client.sendRawTransaction;
    c.client.sendRawTransaction = vi.fn(async (request) => {
      expect(c.deps.now!()).toBe(clock.expires - 1);
      clock.expire();
      return send(request);
    });
    expect((await executeApprovedPlan(c.plan, c.hash, true, c.deps)).state).toBe('CONFIRMED');
    expect(c.client.sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('confirmation completes one stage without preparing or sending another stage', async () => {
    const c = await context();
    const clock = approvalClock(c);
    c.deps.onEvidence = async (snapshot) => { if (snapshot.steps[0]?.state === 'CONFIRMED') clock.expire(); };
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps.map((step) => step.state)).toEqual(['CONFIRMED']);
    expect(c.client.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect((await c.journal.read()).map((entry) => entry.state)).toEqual(['INTENT', 'SUBMITTED', 'CONFIRMED']);
  });

  it.each(['chainId', 'nonce', 'gas', 'gasPrice', 'value', 'data'] as const)('rejects a valid signature with altered %s before intent', async (field) => {
    const c = await context();
    const originalLoader = c.deps.signerLoader;
    c.deps.signerLoader = async () => {
      const signer = await originalLoader();
      return { sign: (tx) => signer.sign({ ...tx, [field]: field === 'data' ? '0x6001' : field === 'nonce' ? 9 : field === 'chainId' ? 1672 : 1n } as UnsignedTestnetTransaction) };
    };
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps[0]?.state).toBe('ABORTED_BEFORE_SEND');
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(await c.journal.read()).toHaveLength(0);
  });
});
