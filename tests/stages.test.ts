/**
 * Offline staged two-deployment workflow. Real planner/runner/journal/store with
 * mocked RPC and SYNTHETIC signing identifiers only: no network, keys, or signatures.
 */
import { readdir, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import {
  encodeAbiParameters, encodeEventTopics, encodeFunctionResult, getContractAddress, keccak256, toHex,
  type Address, type Hash, type Hex, type Log, TransactionNotFoundError,
} from 'viem';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { loadArtifact, type ContractArtifact } from '../src/artifacts.js';
import { BATCH_EXECUTOR_ABI } from '../src/abi.js';
import { scanTextForSecrets } from '../src/safety.js';
import { validateActions } from '../src/validation.js';
import { buildBroadcastPlan } from '../src/testnet/build-plan.js';
import { broadcastPlanHash, verifyApproval, type BroadcastPlan } from '../src/testnet/broadcast-plan.js';
import { DeploymentStore, deploymentBinding } from '../src/testnet/deployments.js';
import { ExecutionJournal } from '../src/testnet/journal.js';
import { executeApprovedPlan, type RunnerClient, type RunnerDependencies, type TestnetExecutionEvidence } from '../src/testnet/runner.js';
import { reconcilePlan, type ReconciliationEvidence } from '../src/testnet/reconcile.js';
import type { ReceiptLike } from '../src/receipt.js';
import type { ValidatedAction } from '../src/types.js';
import type { UnsignedTestnetTransaction } from '../src/testnet/signer.js';
import { CALLER_GETTER_DATA, callerReply } from './caller-fixtures.js';
import { ACCOUNT } from './fixtures.js';
import { fakeSign } from './mock-signatures.js';
import { testTempDirectory } from './temp.js';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

// Anchored to real time so recover/deploy records (real-clock verifiedAt) never predate later plans.
const CAPTURE_BLOCK = 32_056_634n;
const BASE_TIME = Date.now();
const FAILING_RECORD_HASH = `sha256:${'cc'.repeat(32)}`;

function actionEventLog(action: ValidatedAction, index: number, success: boolean, block: bigint,
  blockHash: Hash, txHash: Hash, executor: Address): Log {
  return {
    address: executor,
    topics: encodeEventTopics({ abi: BATCH_EXECUTOR_ABI, eventName: 'ActionExecuted',
      args: { index: BigInt(index), id: action.idBytes32, target: action.target } }) as Log['topics'],
    data: encodeAbiParameters([{ type: 'bool' }, { type: 'bytes' }, { type: 'uint256' }], [success, '0x', 0n]),
    blockHash, blockNumber: block, logIndex: index, transactionHash: txHash, transactionIndex: 0, removed: false,
  };
}

function summaryEventLog(total: number, failed: number, block: bigint, blockHash: Hash, txHash: Hash,
  executor: Address, sender: Address): Log {
  return {
    address: executor,
    topics: encodeEventTopics({ abi: BATCH_EXECUTOR_ABI, eventName: 'BatchExecuted', args: { sender } }) as Log['topics'],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [BigInt(total), BigInt(total - failed), BigInt(failed)]),
    blockHash, blockNumber: block, logIndex: total, transactionHash: txHash, transactionIndex: 0, removed: false,
  };
}

interface SimulatedChain {
  client: RunnerClient;
  signed: Map<Hex, UnsignedTestnetTransaction>;
  send: Mock;
  state(): { latest: bigint; senderNonce: number; executor?: Address };
  setOutcomePattern(pattern: readonly boolean[]): void;
  setBatch(actions: readonly ValidatedAction[]): void;
  setExecutor(address: Address): void;
  behavior: { sendFails: boolean; receiptWaitFails: boolean };
}

/** Minimal deterministic chain state machine; every artifact payload comes from the real build. */
function simulateChain(sender: Address, runtimeCode: Map<Hex, ContractArtifact>): SimulatedChain {
  const code = new Map<Address, Hex>([[sender, '0x' as Hex]]);
  const accountNonces = new Map<Address, number>();
  const receipts = new Map<Hash, ReceiptLike & { logs: Log[] }>();
  const mined = new Map<Hash, UnsignedTestnetTransaction & { blockNumber: bigint; blockHash: Hash }>();
  const signed = new Map<Hex, UnsignedTestnetTransaction>();
  const blockTxCounts = new Map<bigint, number>();
  let latest = CAPTURE_BLOCK;
  let senderNonce = 3; // matches the last public pre-implementation capture
  let executor: Address | undefined;
  let pendingBatch: readonly ValidatedAction[] = [];
  let outcomePattern: readonly boolean[] = [true, true, true];
  const behavior = { sendFails: false, receiptWaitFails: false };
  const blockHash = (number: bigint): Hash => keccak256(toHex(number));

  const send = vi.fn(async ({ serializedTransaction }: { serializedTransaction: Hex }): Promise<Hash> => {
    if (behavior.sendFails) throw new Error('simulated transport failure');
    const tx = signed.get(serializedTransaction.toLowerCase() as Hex);
    if (tx === undefined) throw new Error('simulated unknown signed payload');
    const txHash = keccak256(serializedTransaction) as Hash;
    if (tx.nonce !== senderNonce) throw new Error('simulated nonce mismatch');
    const blockNumber = latest + 1n;
    const blockHashValue = blockHash(blockNumber);
    senderNonce += 1;
    const logs: Log[] = [];
    let contractAddress: Address | null = null;
    const artifact = (tx.to === null || tx.to === undefined) ? runtimeCode.get(tx.data) : undefined;
    if (artifact !== undefined) {
      contractAddress = getContractAddress({ from: sender, nonce: BigInt(tx.nonce) });
      if ((code.get(contractAddress) ?? '0x') !== '0x') throw new Error('simulated occupied CREATE destination');
      code.set(contractAddress, artifact.runtimeBytecode);
      accountNonces.set(contractAddress, (accountNonces.get(contractAddress) ?? 0) + 1);
    } else if (executor !== undefined && tx.to != null && tx.to?.toLowerCase() === executor.toLowerCase() && pendingBatch.length > 0) {
      let index = 0;
      for (const [i, action] of pendingBatch.entries()) {
        logs.push(actionEventLog(action, index++, outcomePattern[i]!, blockNumber, blockHashValue, txHash, executor));
      }
      logs.push(summaryEventLog(pendingBatch.length, outcomePattern.filter((success) => !success).length,
        blockNumber, blockHashValue, txHash, executor, sender));
    }
    receipts.set(txHash, { transactionHash: txHash, status: 'success', gasUsed: 120_000n, blockNumber,
      blockHash: blockHashValue, effectiveGasPrice: tx.gasPrice ?? 10_000_000_000n, contractAddress, logs });
    mined.set(txHash, { ...tx, blockNumber, blockHash: blockHashValue });
    blockTxCounts.set(blockNumber, 1);
    // Two or more confirmations before the receipt is reported, matching waitForTransactionReceipt.
    latest = blockNumber + 3n;
    return txHash;
  });

  const client: RunnerClient = {
    getChainId: vi.fn(async () => 688689),
    getBlockNumber: vi.fn(async () => latest),
    getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
      if (blockNumber <= 0n || blockNumber > latest) throw new Error('simulated missing block');
      const txCount = blockTxCounts.get(blockNumber);
      return { hash: blockHash(blockNumber), gasLimit: 30_000_000n, parentHash: blockHash(blockNumber - 1n),
        ...(txCount === undefined ? {} : { transactions: new Array(txCount).fill({}) }) };
    }),
    getBalance: vi.fn(async () => 1_000_000_000_000_000_000n),
    getGasPrice: vi.fn(async () => 10_000_000_000n),
    getTransactionCount: vi.fn(async ({ address }: { address: Address }) =>
      address.toLowerCase() === sender.toLowerCase() ? senderNonce : accountNonces.get(address) ?? 0),
    getCode: vi.fn(async ({ address }: { address: Address }) => code.get(address) ?? '0x'),
    estimateGas: vi.fn(async ({ to, gas }: { to?: Address; gas?: bigint }) => {
      const estimate = to === undefined ? 100_000n : to.toLowerCase() === executor?.toLowerCase() ? 700_000n : 30_000n;
      if (estimate > (gas ?? 5_000_000n)) throw new Error('simulated gas overflow');
      return estimate;
    }),
    call: vi.fn(async ({ to, data, account }: { to: Address; data: Hex; account: Address }) => {
      if (data === CALLER_GETTER_DATA) return callerReply(account);
      if (executor !== undefined && to.toLowerCase() === executor.toLowerCase()) {
        return { data: encodeFunctionResult({ abi: BATCH_EXECUTOR_ABI, functionName: 'execute',
          result: outcomePattern.map((success) => ({ success, data: '0x' as const, returnDataSize: 0n })) }) };
      }
      return { data: '0x' as const };
    }),
    sendRawTransaction: send,
    waitForTransactionReceipt: vi.fn(async ({ hash }: { hash: Hash }) => {
      if (behavior.receiptWaitFails || !receipts.has(hash)) throw new Error('simulated confirmation wait failure');
      return receipts.get(hash)!;
    }),
    getTransaction: vi.fn(async ({ hash }: { hash: Hash }) => {
      const tx = mined.get(hash);
      if (tx === undefined) throw new TransactionNotFoundError({ hash });
      return { hash, from: sender, to: tx.to ?? null, input: tx.data, value: tx.value, chainId: 688689, nonce: tx.nonce,
        type: tx.type, gas: tx.gas, gasPrice: tx.gasPrice, blockNumber: tx.blockNumber, blockHash: tx.blockHash, transactionIndex: 0 };
    }),
    getTransactionReceipt: vi.fn(async ({ hash }: { hash: Hash }) => receipts.get(hash) ?? null),
  };

  return {
    client, signed, send, behavior,
    state: () => ({ latest, senderNonce, executor }),
    setOutcomePattern: (pattern) => { outcomePattern = pattern; },
    setBatch: (actions) => { pendingBatch = actions; },
    setExecutor: (address) => { executor = address; },
  };
}

interface Harness {
  dir: string;
  store: DeploymentStore;
  chain: SimulatedChain;
  now(): number;
  plan(options: { purpose: BroadcastPlan['purpose']; stage?: 'executor' | 'counter'; scenario?: 'success' | 'mixed' }): Promise<BroadcastPlan>;
  run(plan: BroadcastPlan, overrides?: (deps: RunnerDependencies) => void): {
    deps: RunnerDependencies; journal: ExecutionJournal; sign: Mock; signerLoader: Mock; hash: string;
    execute(): Promise<TestnetExecutionEvidence>;
  };
}

async function harness(): Promise<Harness> {
  const dir = await testTempDirectory(); directories.push(dir);
  const store = new DeploymentStore(dir);
  const [executor, counter] = await Promise.all([loadArtifact('BatchExecutor'), loadArtifact('TestOnlyCounter')]);
  const runtimeCode = new Map<Hex, ContractArtifact>([[executor.bytecode, executor], [counter.bytecode, counter]]);
  const chain = simulateChain(ACCOUNT, runtimeCode);
  let clock = BASE_TIME;
  const now = () => (clock += 60_000);
  return {
    dir, store, chain,
    now,
    async plan(options) {
      return buildBroadcastPlan({ purpose: options.purpose, sender: ACCOUNT,
        ...(options.stage === undefined ? {} : { stage: options.stage }),
        ...(options.scenario === undefined ? {} : { scenario: options.scenario }) },
        { client: chain.client, deployments: store, now });
    },
    run(plan, overrides) {
      const hash = broadcastPlanHash(plan);
      const journal = new ExecutionJournal(dir, hash);
      const sign = vi.fn(async (tx: UnsignedTestnetTransaction) => {
        const raw = fakeSign(tx, plan.sender) as Hex;
        chain.signed.set(raw.toLowerCase() as Hex, tx);
        return raw;
      });
      const signerLoader = vi.fn(async () => ({ address: plan.sender, sign }));
      const deps: RunnerDependencies = {
        client: chain.client, journal, deployments: store, signerLoader, now,
        onEvidence: vi.fn(async () => {}),
      };
      overrides?.(deps);
      return { deps, journal, sign, signerLoader, hash, execute: () => executeApprovedPlan(plan, hash, true, deps) };
    },
  };
}

async function deployStage(h: Harness, stage: 'executor' | 'counter', existing?: BroadcastPlan) {
  const plan = existing ?? await h.plan({ purpose: 'deploy', stage });
  const run = h.run(plan);
  const evidence = await run.execute();
  const record = await h.store.read(plan.sender, plan.deploymentStage!);
  if (stage === 'executor') h.chain.setExecutor(record.address);
  const entries = (await run.journal.read()).map((entry) => entry.state);
  return { plan, record, entries, run, evidence };
}

describe('staged, separately approved deployments (offline simulation only)', () => {
  it('stage 1 plans exactly one fresh-observation deployment, executes it and records it durably', async () => {
    const h = await harness();
    const plan = await h.plan({ purpose: 'deploy', stage: 'executor' });
    verifyApproval(plan, broadcastPlanHash(plan), true, h.now());
    expect(plan.schemaVersion).toBe(2);
    expect(plan.deploymentStage).toBe('executor');
    expect(plan.deploymentPrerequisites).toBeUndefined();
    expect(plan.transactions).toHaveLength(1); // exactly ONE separately approved stage; no stage 2 piggyback
    expect(plan.transactions[0]!.nonce).toBe(3); // actual fresh pending nonce, not a hardcoded historical value
    expect(plan.transactions[0]!.expectedContractAddress).toBe(getContractAddress({ from: ACCOUNT, nonce: 3n }));
    expect(plan.transactions[0]!.type).toBe('legacy');

    const { record, entries, evidence } = await deployStage(h, 'executor', plan);
    expect(evidence.state).toBe('CONFIRMED');
    expect(entries).toEqual(['INTENT', 'SUBMITTED', 'CONFIRMED']);
    expect(record.planHash).toBe(broadcastPlanHash(plan));
    expect(record.authorizedCaller?.toLowerCase()).toBe(ACCOUNT.toLowerCase());
    expect(record.fees.balanceDebitStatus).toBe('not-observed');
    expect(record.fees.feePolicy).toBe('unresolved');
    expect(record.fees.independentlyObservedBalanceDebitWei).toBeNull();
    expect(record.fees.receiptDerivedFeeWei).toBe((120_000n * 10_000_000_000n).toString());
    expect(h.chain.state().senderNonce).toBe(4);
    // the record re-verifies against chain evidence, not merely its saved flags
    await h.store.verify(ACCOUNT, 'executor', h.chain.client, deploymentBinding(record));
    const journal = new ExecutionJournal(h.dir, broadcastPlanHash(plan));
    expect(await journal.readApprovalState()).toBe('CLAIMED');
    await expect(journal.acquire(ACCOUNT, [3])).rejects.toThrow(/already has an execution intent|already consumed/);
  });

  it('a consumed approval cannot be reused and stage 1 cannot be planned again', async () => {
    const h = await harness();
    const plan = await h.plan({ purpose: 'deploy', stage: 'executor' });
    const run = h.run(plan);
    expect((await run.execute()).state).toBe('CONFIRMED');
    expect((h.chain.client.sendRawTransaction as Mock).mock.calls).toHaveLength(1);
    await expect(run.execute()).rejects.toThrow(/already has a record or intent/);
    await expect(h.plan({ purpose: 'deploy', stage: 'executor' })).rejects.toThrow(/already has a record or intent/);
    expect((h.chain.client.sendRawTransaction as Mock).mock.calls).toHaveLength(1);
  });

  it('stage 2 is refused before stage 1 verification, then needs refreshed observations and a DISTINCT approval', async () => {
    const h = await harness();
    await expect(h.plan({ purpose: 'deploy', stage: 'counter' })).rejects.toThrow(/is missing/);
    const { plan: stageOne, record } = await deployStage(h, 'executor');
    const sendsAfterStageOne = (h.chain.client.sendRawTransaction as Mock).mock.calls.length;

    const counter = await h.plan({ purpose: 'deploy', stage: 'counter' });
    expect(counter.transactions[0]!.nonce).toBe(4); // derived from the ACTUAL current nonce, not historical predictions
    expect(counter.transactions[0]!.expectedContractAddress).toBe(getContractAddress({ from: ACCOUNT, nonce: 4n }));
    expect(counter.deploymentPrerequisites?.executor?.recordHash).toBe(deploymentBinding(record).recordHash);

    // Stage 1 approval never authorizes stage 2
    const refusalRun = h.run(counter);
    await expect(executeApprovedPlan(counter, broadcastPlanHash(stageOne), true, refusalRun.deps))
      .rejects.toThrow(/plan-hash/);
    expect(refusalRun.signerLoader).not.toHaveBeenCalled();
    expect((h.chain.client.sendRawTransaction as Mock).mock.calls).toHaveLength(sendsAfterStageOne);

    const run = h.run(counter);
    expect(run.hash).not.toBe(broadcastPlanHash(stageOne));
    expect((await run.execute()).state).toBe('CONFIRMED');
    const counterRecord = await h.store.read(ACCOUNT, 'counter');
    expect(counterRecord.authorizedCaller).toBeUndefined();
    expect(counterRecord.plan.deploymentPrerequisites!.executor!.recordHash).toBe(deploymentBinding(record).recordHash);
    expect(h.chain.state().senderNonce).toBe(5);
    await expect(run.execute()).rejects.toThrow(/already has a record or intent/);
  });

  it('a stale or mutated prerequisite binding invalidates the approval before any signature', async () => {
    const h = await harness();
    await deployStage(h, 'executor');
    const sends = (h.chain.client.sendRawTransaction as Mock).mock.calls.length;
    const counter = await h.plan({ purpose: 'deploy', stage: 'counter' });
    const tampered = structuredClone(counter);
    tampered.deploymentPrerequisites!.executor!.recordHash = FAILING_RECORD_HASH;
    const tamperedHash = broadcastPlanHash(tampered);
    const run = h.run(tampered);
    await expect(executeApprovedPlan(tampered, tamperedHash, true, run.deps))
      .rejects.toThrow(/missing, changed or not canonically verified/);
    expect(run.signerLoader).not.toHaveBeenCalled();
    expect((h.chain.client.sendRawTransaction as Mock).mock.calls).toHaveLength(sends);
  });

  it('three-action success and mixed batches each use their own plan, approval intent and receipt evidence', async () => {
    const h = await harness();
    await deployStage(h, 'executor');
    await deployStage(h, 'counter');
    const counterAddress = (await h.store.read(ACCOUNT, 'counter')).address;
    const sendsBeforeBatches = (h.chain.client.sendRawTransaction as Mock).mock.calls.length;

    const success = await h.plan({ purpose: 'batch', scenario: 'success' });
    expect(success.actions).toHaveLength(3);
    expect(success.transactions).toHaveLength(1);
    expect(success.transactions[0]!.nonce).toBe(5);
    expect(success.actions!.every((action) => action.target.toLowerCase() === counterAddress.toLowerCase())).toBe(true);
    verifyApproval(success, broadcastPlanHash(success), true, h.now());
    h.chain.setBatch(validateActions(success.actions));
    h.chain.setOutcomePattern([true, true, true]);
    const successRun = h.run(success);
    const successEvidence = await successRun.execute();
    expect(successEvidence.state).toBe('CONFIRMED');
    expect(successEvidence.steps[0]!.actions?.map((action) => action.success)).toEqual([true, true, true]);
    expect(successEvidence.steps[0]!.expectedOutcomesMatch).toBe(true);
    expect((await successRun.journal.read()).map((entry) => entry.state)).toEqual(['INTENT', 'SUBMITTED', 'CONFIRMED']);

    // The planner derives expectedSimulation from a FRESH dry run, so the mixed
    // outcome pattern must be configured before planning the mixed batch.
    h.chain.setOutcomePattern([true, false, true]);
    const mixed = await h.plan({ purpose: 'batch', scenario: 'mixed' });
    expect(mixed.transactions[0]!.nonce).toBe(6); // the successful batch advanced the observed nonce
    verifyApproval(mixed, broadcastPlanHash(mixed), true, h.now());
    h.chain.setBatch(validateActions(mixed.actions));
    h.chain.setOutcomePattern([true, false, true]);
    const mixedRun = h.run(mixed);
    expect(mixedRun.hash).not.toBe(successRun.hash);
    const mixedEvidence = await mixedRun.execute();
    expect(mixedEvidence.state).toBe('CONFIRMED');
    expect(mixedEvidence.steps[0]!.actions?.map((action) => action.success)).toEqual([true, false, true]);
    expect(mixedEvidence.steps[0]!.refundCreditWei).toBe(0n);
    expect((h.chain.client.sendRawTransaction as Mock).mock.calls).toHaveLength(sendsBeforeBatches + 2);
    // a batch cannot be replayed under another plan's approval
    const replay = h.run(mixed);
    await expect(executeApprovedPlan(mixed, successRun.hash, true, replay.deps)).rejects.toThrow(/plan-hash/);
  });

  it('an uncertain submission reconciles to a recovered durable record without resending', async () => {
    const h = await harness();
    const plan = await h.plan({ purpose: 'deploy', stage: 'executor' });
    h.chain.behavior.receiptWaitFails = true;
    const run = h.run(plan);
    const evidence = await run.execute();
    expect(evidence.state).toBe('HALTED');
    expect(evidence.steps[0]!.state).toBe('UNKNOWN');
    h.chain.behavior.receiptWaitFails = false;

    const result = await reconcilePlan(plan, await run.journal.readForReconciliation(plan), h.chain.client);
    expect(result.allTransactionsConfirmed).toBe(true);
    expect(result.steps[0]!.state).toBe('CONFIRMED');
    expect((h.chain.client.sendRawTransaction as Mock).mock.calls).toHaveLength(1); // never resent
    const record = await h.store.recordReconciliation(result);
    expect(record).toBeDefined();
    expect(record!.transactionHash).toBe(result.steps[0]!.transactionHash);
    expect((await h.store.read(ACCOUNT, 'executor')).transactionHash).toBe(record!.transactionHash);
    await h.store.verify(ACCOUNT, 'executor', h.chain.client, deploymentBinding(record!));
    // recovered record unblocks the next stage without any duplicate deployment
    const counter = await h.plan({ purpose: 'deploy', stage: 'counter' });
    expect(counter.deploymentPrerequisites!.executor!.transactionHash).toBe(record!.transactionHash);
    expect(counter.transactions[0]!.nonce).toBe(4);
  });

  it('signer validation failure leaves approval unconsumed and creates no execution or stage intent', async () => {
    const h = await harness();
    const plan = await h.plan({ purpose: 'deploy', stage: 'executor' });
    const run = h.run(plan, (deps) => {
      deps.signerLoader = async () => { throw new Error('simulated missing signing configuration'); };
    });
    await expect(run.execute()).rejects.toThrow(/signer validation/);
    expect(h.chain.client.sendRawTransaction).not.toHaveBeenCalled();
    expect(await run.journal.readApprovalState()).toBe('UNUSED');
    expect(await run.journal.read()).toEqual([]);
    expect(await readdir(h.dir)).toEqual([]);
    await expect(h.plan({ purpose: 'deploy', stage: 'executor' })).resolves.toMatchObject({ deploymentStage: 'executor' });
  });

  it('signer validation failures never expose secrets or create durable files', async () => {
    const h = await harness();
    const plan = await h.plan({ purpose: 'deploy', stage: 'executor' });
    const secret = ['PRIVATE', 'KEY'].join('_') + '=' + ['0x', 'ab'.repeat(32)].join('');
    const run = h.run(plan, (deps) => {
      deps.signerLoader = async () => { throw new Error(`signing configuration contained ${secret}`); };
    });
    let message = '';
    try { await run.execute(); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toMatch(/signer validation/);
    expect(message).not.toContain(secret);
    expect(scanTextForSecrets(message)).toEqual([]);
    expect(await readdir(h.dir)).toEqual([]);
    expect(await run.journal.readApprovalState()).toBe('UNUSED');
    await expect(h.store.read(ACCOUNT, 'executor')).rejects.toThrow();
  });

  describe('explicit lock recovery', () => {
    async function completedHarness() {
      const h = await harness();
      const plan = await h.plan({ purpose: 'deploy', stage: 'executor' });
      const run = h.run(plan);
      expect((await run.execute()).state).toBe('CONFIRMED');
      const result = await reconcilePlan(plan, await run.journal.readForReconciliation(plan), h.chain.client);
      return { h, plan, result };
    }

    const lockPath = (dir: string, plan: BroadcastPlan) => path.join(dir, `${broadcastPlanHash(plan).slice(7)}.ndjson.lock`);
    // The store's real acquire uses 'wx'; the test fixture simply overwrites the simulated owner between cases.
    const writeLock = (file: string, owner: Record<string, unknown>) => writeFile(file, JSON.stringify(owner));

    it('refuses incomplete, legacy, foreign-host or live owners; releases only verified dead owners', async () => {
      const { h, plan, result } = await completedHarness();
      const journal = new ExecutionJournal(h.dir, broadcastPlanHash(plan));
      const incomplete = { ...result, allTransactionsConfirmed: false } as ReconciliationEvidence;
      await expect(journal.releaseCompletedLocks(plan, incomplete)).rejects.toThrow(/Explicit lock recovery requires/);

      await writeLock(lockPath(h.dir, plan), { schemaVersion: 2, pid: process.pid, host: 'other-host', planHash: broadcastPlanHash(plan), token: 'x' });
      await expect(journal.releaseCompletedLocks(plan, result)).rejects.toThrow(/alive, foreign, legacy or unverifiable/);

      await writeLock(lockPath(h.dir, plan), { schemaVersion: 1, pid: process.pid, host: hostname(), planHash: broadcastPlanHash(plan), token: 'x' });
      await expect(journal.releaseCompletedLocks(plan, result)).rejects.toThrow(/alive, foreign, legacy or unverifiable/);

      await writeLock(lockPath(h.dir, plan), { schemaVersion: 2, pid: process.pid, host: hostname(), planHash: broadcastPlanHash(plan), token: 'live' });
      await expect(journal.releaseCompletedLocks(plan, result)).rejects.toThrow(/alive, foreign, legacy or unverifiable/);

      await writeLock(lockPath(h.dir, plan), { schemaVersion: 2, pid: 4_000_000, host: hostname(), planHash: broadcastPlanHash(plan), token: 'dead' });
      const kill = vi.spyOn(process, 'kill').mockImplementation((() => {
        const error = new Error('no such process') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }) as unknown as typeof process.kill);
      await journal.releaseCompletedLocks(plan, result);
      expect(kill).toHaveBeenCalled();
      kill.mockRestore();
    });
  });
});
