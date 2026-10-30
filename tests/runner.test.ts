/** Mock RPC and synthetic signing identifiers ONLY. No HTTP, keys or signatures. */
import { readdir, rm } from 'node:fs/promises';
import { encodeFunctionResult, keccak256, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContractArtifact } from '../src/artifacts.js';
import { BATCH_EXECUTOR_ABI } from '../src/abi.js';
import { ExecutionGateError, type PreConsumptionErrorCode } from '../src/errors.js';
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
  const signerLoader = vi.fn(async () => ({ address: plan.sender, sign }));
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

async function expectGateCode(promise: Promise<unknown>, code: PreConsumptionErrorCode): Promise<ExecutionGateError> {
  try { await promise; }
  catch (error) {
    expect(error).toBeInstanceOf(ExecutionGateError);
    expect((error as ExecutionGateError).code).toBe(code);
    return error as ExecutionGateError;
  }
  throw new Error(`Expected ExecutionGateError ${code}.`);
}

describe('gated testnet runner — offline mock requests only', () => {
  it('requires approval and confirmation BEFORE key loading or submission', async () => {
    const c = await context();
    await expectGateCode(executeApprovedPlan(c.plan, c.hash, false, c.deps), 'PLAN_VALIDATION_FAILED');
    await expectGateCode(executeApprovedPlan(c.plan, 'wrong', true, c.deps), 'PLAN_VALIDATION_FAILED');
    expect(c.signerLoader).not.toHaveBeenCalled();
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('rejects a mismatched validated signer before consuming approval or creating any intent', async () => {
    const c = await context();
    c.deps.signerLoader = vi.fn(async () => ({
      address: '0x1111111111111111111111111111111111111111' as const,
      sign: c.sign,
    }));
    await expectGateCode(executeApprovedPlan(c.plan, c.hash, true, c.deps), 'SIGNER_ADDRESS_MISMATCH');
    expect(await c.journal.readApprovalState()).toBe('UNUSED');
    expect(await c.journal.read()).toEqual([]);
    expect(await readdir(c.dir)).toEqual([]);
    expect(c.sign).not.toHaveBeenCalled();
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong chain', { getChainId: vi.fn(async () => 1672) }, 'RPC_PREFLIGHT_FAILED'],
    ['insufficient funding', { getBalance: vi.fn(async () => 0n) }, 'BALANCE_INSUFFICIENT'],
    ['nonce changed', { getTransactionCount: vi.fn(async () => 3) }, 'NONCE_CONFLICT'],
    ['gas price raised', { getGasPrice: vi.fn(async () => 30_000_000_000n) }, 'GAS_PRICE_EXCEEDED'],
    ['estimation failure', { estimateGas: vi.fn(async () => { throw new Error('fixture estimate failure'); }) }, 'FRESH_ESTIMATE_FAILED'],
  ] as const)('blocks %s before loading keys', async (_label, changes, code) => {
    const c = await context(changes);
    await expectGateCode(executeApprovedPlan(c.plan, c.hash, true, c.deps), code);
    expect(c.signerLoader).not.toHaveBeenCalled();
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('codes source-bound artifact mismatches at their actual guard', async () => {
    const c = await context();
    const load = c.deps.artifactLoader!;
    c.deps.artifactLoader = async (name) => ({ ...(await load(name)), bytecode: name === 'BatchExecutor' ? '0x6001' : '0x6000' });
    await expectGateCode(executeApprovedPlan(c.plan, c.hash, true, c.deps), 'ARTIFACT_BINDING_FAILED');
    expect(c.signerLoader).not.toHaveBeenCalled();
  });

  it('codes prerequisite verification failure before signer loading', async () => {
    const c = await context({}, 'batch');
    vi.mocked(c.deps.deployments.verifyPrerequisites).mockRejectedValue(new Error('untrusted prerequisite details'));
    await expectGateCode(executeApprovedPlan(c.plan, c.hash, true, c.deps), 'PREREQUISITE_VERIFICATION_FAILED');
    expect(c.signerLoader).not.toHaveBeenCalled();
  });

  it('codes an existing deployment-stage claim without loading the signer', async () => {
    const c = await context();
    await c.deps.deployments.claim(c.plan, new Date().toISOString());
    await expectGateCode(executeApprovedPlan(c.plan, c.hash, true, c.deps), 'STAGE_ALREADY_CLAIMED');
    expect(c.signerLoader).not.toHaveBeenCalled();
  });

  it('codes an occupied predicted CREATE address', async () => {
    const c = await context();
    const getCode = c.client.getCode;
    const predicted = c.plan.transactions[0]!.expectedContractAddress!.toLowerCase();
    c.client.getCode = vi.fn(async (request) => request.address.toLowerCase() === predicted ? '0x11' : getCode(request));
    await expectGateCode(executeApprovedPlan(c.plan, c.hash, true, c.deps), 'CREATE_ADDRESS_OCCUPIED');
    expect(c.signerLoader).not.toHaveBeenCalled();
  });

  it('codes signer-source failures without consuming approval or exposing the cause', async () => {
    const c = await context();
    c.deps.signerLoader = async () => { throw new Error(`untrusted ${'PRIVATE_KEY'}=${'ab'.repeat(32)}`); };
    const error = await expectGateCode(executeApprovedPlan(c.plan, c.hash, true, c.deps), 'SIGNER_SOURCE_FAILED');
    expect(error.message).not.toContain('ab'.repeat(32));
    expect(await c.journal.readApprovalState()).toBe('UNUSED');
    expect(await readdir(c.dir)).toEqual([]);
  });

  it('codes an existing execution lock after signer validation but before approval consumption', async () => {
    const c = await context();
    const owner = new ExecutionJournal(c.dir, c.hash);
    await owner.acquire();
    try {
      await expectGateCode(executeApprovedPlan(c.plan, c.hash, true, c.deps), 'EXECUTION_LOCK_EXISTS');
      expect(await c.journal.readApprovalState()).toBe('UNUSED');
      expect(c.sign).not.toHaveBeenCalled();
    } finally { await owner.release(); }
  });

  it('codes an existing nonce approval reservation without consuming this plan', async () => {
    const c = await context();
    const otherPlan = structuredClone(c.plan);
    otherPlan.disclosures = [...otherPlan.disclosures, 'SYNTHETIC competing approval fixture.'];
    const otherHash = broadcastPlanHash(otherPlan);
    const other = new ExecutionJournal(c.dir, otherHash);
    await other.acquire(otherPlan.sender, [otherPlan.transactions[0]!.nonce]);
    try { await other.claimApproval(otherPlan, new Date().toISOString()); }
    finally { await other.release(); }

    await expectGateCode(executeApprovedPlan(c.plan, c.hash, true, c.deps), 'NONCE_RESERVATION_EXISTS');
    expect(await c.journal.readApprovalState()).toBe('UNUSED');
    expect(c.sign).not.toHaveBeenCalled();
  });

  it('maps unknown pre-consumption exceptions to a safe internal code', async () => {
    const c = await context();
    const secret = `untrusted ${'PRIVATE_KEY'}=${'cd'.repeat(32)}`;
    vi.spyOn(c.journal, 'acquire').mockRejectedValue(new Error(secret));
    const error = await expectGateCode(executeApprovedPlan(c.plan, c.hash, true, c.deps), 'INTERNAL_PRECONSUMPTION_FAILURE');
    expect(error.message).not.toContain(secret);
    expect(error.safeCause).toBe('PLAN_OR_SENDER_LOCK');
    expect(await c.journal.readApprovalState()).toBe('UNUSED');
    expect(c.sign).not.toHaveBeenCalled();
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
    c.deps.signerLoader = async () => ({ address: c.plan.sender, sign: async () => '0x01' });
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
      return { ...signer, async sign(tx) { const raw = await signer.sign(tx); clock += 120_000; return raw; } };
    };
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps.every((s) => s.state === 'ABORTED_BEFORE_SEND')).toBe(true);
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(await c.journal.read()).toHaveLength(0);
  });

  it.each([
    ['artifact checks', 'PLAN_VALIDATION_FAILED'],
    ['signer loading', 'APPROVAL_EXPIRED_AFTER_SIGNER_LOAD'],
  ] as const)('rejects without consuming approval when it expires during pre-consumption %s', async (boundary, code) => {
    const c = await context();
    const clock = approvalClock(c);
    if (boundary === 'artifact checks') {
      const load = c.deps.artifactLoader!;
      c.deps.artifactLoader = async (name) => { const artifact = await load(name); clock.expire(); return artifact; };
    }
    if (boundary === 'signer loading') {
      const load = c.deps.signerLoader;
      c.deps.signerLoader = async () => { const signer = await load(); clock.expire(); return signer; };
    }
    await expectGateCode(executeApprovedPlan(c.plan, c.hash, true, c.deps), code);
    expect(c.sign).not.toHaveBeenCalled();
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(await c.journal.read()).toHaveLength(0);
    expect(c.signerLoader).toHaveBeenCalledTimes(boundary === 'signer loading' ? 1 : 0);
    expect(await c.journal.readApprovalState()).toBe('UNUSED');
  });

  it.each(['journal acquisition', 'initial evidence persistence'] as const)('fails closed when approval expires during %s', async (boundary) => {
    const c = await context();
    const clock = approvalClock(c);
    if (boundary === 'journal acquisition') {
      const acquire = c.journal.acquire.bind(c.journal);
      vi.spyOn(c.journal, 'acquire').mockImplementation(async (...args) => { await acquire(...args); clock.expire(); });
    } else c.deps.onEvidence = async () => { await Promise.resolve(); clock.expire(); };
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.state).toBe('HALTED');
    expect(result.steps.every((step) => step.state === 'ABORTED_BEFORE_SEND')).toBe(true);
    expect(c.signerLoader).toHaveBeenCalledTimes(1);
    expect(c.sign).not.toHaveBeenCalled();
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(await c.journal.read()).toHaveLength(0);
    expect(await c.journal.readApprovalState()).toBe(boundary === 'journal acquisition' ? 'UNUSED' : 'ABORTED_BEFORE_SEND');
  });

  it('rejects expiry during initial preflight before loading or consuming signer approval', async () => {
    const c = await context();
    const clock = approvalClock(c);
    const read = c.client.getBlock;
    c.client.getBlock = vi.fn(async (request) => { const block = await read(request); clock.expire(); return block; });
    await expect(executeApprovedPlan(c.plan, c.hash, true, c.deps)).rejects.toThrow(/expired/);
    expect(c.signerLoader).not.toHaveBeenCalled();
    expect(await c.journal.readApprovalState()).toBe('UNUSED');
    expect(await c.journal.read()).toEqual([]);
  });

  it.each([
    ['pre-sign checks', 2], ['post-sign checks', 3],
  ] as const)('catches expiry during %s, including awaits after signed-payload verification', async (_label, expireRead) => {
    const c = await context();
    const clock = approvalClock(c);
    const read = c.client.getBlock;
    let reads = 0;
    c.client.getBlock = vi.fn(async (request) => { const block = await read(request); if (++reads === expireRead) clock.expire(); return block; });
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.state).toBe('HALTED');
    expect(result.steps.map((step) => step.state)).toEqual(['ABORTED_BEFORE_SEND']);
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
      return { ...signer, sign: (tx) => signer.sign({ ...tx, [field]: field === 'data' ? '0x6001' : field === 'nonce' ? 9 : field === 'chainId' ? 1672 : 1n } as UnsignedTestnetTransaction) };
    };
    const result = await executeApprovedPlan(c.plan, c.hash, true, c.deps);
    expect(result.steps[0]?.state).toBe('ABORTED_BEFORE_SEND');
    expect(c.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(await c.journal.read()).toHaveLength(0);
  });
});
