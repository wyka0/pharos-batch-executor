import { keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hash, type Hex, type Log, type TransactionSerializedLegacy } from 'viem';
import path from 'node:path';
import type { EvmPublicClient } from '../adapters/evm.js';
import { EvmAdapter } from '../adapters/evm.js';
import { loadArtifact, type ContractArtifact } from '../artifacts.js';
import { assertAuthorizedCaller } from '../caller.js';
import { ExecutionGateError } from '../errors.js';
import { ATLANTIC } from '../network.js';
import type { ReceiptLike } from '../receipt.js';
import type { ActionResult, ActualReceipt, ExecutionComparison } from '../types.js';
import { validateActions } from '../validation.js';
import { broadcastPlanHash, canonicalJson, decimal, verifyApproval, type BroadcastPlan, type PlannedTransaction } from './broadcast-plan.js';
import type { ExecutionJournal } from './journal.js';
import { deploymentBinding, type DeploymentStore } from './deployments.js';
import { feeEvidence, type FeeEvidence } from './fees.js';
import type { DeploymentBinding } from './broadcast-plan.js';
import type { TestnetSigner } from './signer.js';
import { planComparison } from './comparison.js';
import { planActions, verifyPlannedEffects, verifyPlannedReceipt } from './verification.js';

export interface RunnerReadClient extends EvmPublicClient {
  getTransactionCount(args: { address: Address; blockTag: 'latest' | 'pending' }): Promise<number>;
  getGasPrice(): Promise<bigint>;
}
export interface RunnerClient extends RunnerReadClient {
  getTransactionReceipt(args: { hash: Hash }): Promise<(ReceiptLike & { logs: readonly Log[] }) | null>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hash>;
}

export interface ExecutionStep {
  id: string; index: number;
  state: 'NOT_SUBMITTED' | 'INTENT' | 'SUBMITTED' | 'CONFIRMED' | 'REVERTED' | 'UNKNOWN' | 'UNVERIFIED' | 'ABORTED_BEFORE_SEND';
  transactionHash?: Hash;
  receipt?: ActualReceipt;
  rawReceipt?: ReceiptLike;
  deployedAddress?: Address;
  actions?: ActionResult[];
  refundCreditWei?: bigint;
  expectedOutcomesMatch?: boolean;
  deploymentRecord?: DeploymentBinding;
  fees?: FeeEvidence;
  error?: string;
}
export interface TestnetExecutionEvidence {
  schemaVersion: 1; classification: 'ATLANTIC TESTNET'; planHash: string; plan: BroadcastPlan;
  startedAt: string; finishedAt?: string;
  state: 'RUNNING' | 'CONFIRMED' | 'HALTED'; steps: ExecutionStep[];
  comparison?: ExecutionComparison;
  disclosures: string[];
}

export interface RunnerDependencies {
  client: RunnerClient;
  journal: ExecutionJournal;
  deployments: DeploymentStore;
  signerLoader(): Promise<TestnetSigner>;
  artifactLoader?: typeof loadArtifact;
  now?: () => number;
  /** Persist complete public evidence after every state transition. */
  onEvidence(evidence: TestnetExecutionEvidence): Promise<void>;
}

/** All gate/fee/code/simulation checks run before a signing key is loaded. */
export async function executeApprovedPlan(
  inputPlan: BroadcastPlan, approvalHash: string, confirmed: boolean, deps: RunnerDependencies,
): Promise<TestnetExecutionEvidence> {
  // Neither a caller nor an async signer can mutate the approved plan in flight.
  const plan = freezePlan(structuredClone(inputPlan));
  const now = deps.now ?? Date.now;
  verifyApproval(plan, approvalHash, confirmed, now());
  const hash = broadcastPlanHash(plan);
  deps.journal.assertPlan(plan);
  if (path.relative(deps.journal.directory, deps.deployments.directory) !== '') throw new ExecutionGateError('Journal and deployment records must share one durable state directory.');
  const artifacts = await artifactBindings(plan, deps.artifactLoader ?? loadArtifact);
  try {
    await deps.deployments.verifyPrerequisites(plan, deps.client, deps.artifactLoader);
    if (plan.purpose === 'deploy') await deps.deployments.assertAvailable(plan.sender, plan.deploymentStage!);
    await preflight(plan, deps.client, artifacts);
    await deps.journal.acquire(plan.sender, plan.transactions.map((tx) => tx.nonce));
  } catch (error) {
    if (error instanceof ExecutionGateError) throw error;
    throw new ExecutionGateError('Read-only preflight or durable-state acquisition failed; no signing or submission attempted.');
  }
  const evidence: TestnetExecutionEvidence = {
    schemaVersion: 1, classification: 'ATLANTIC TESTNET', planHash: hash, plan,
    startedAt: new Date(now()).toISOString(), state: 'RUNNING',
    steps: plan.transactions.map((tx, index) => ({ id: tx.id, index, state: 'NOT_SUBMITTED', fees: feeEvidence(plan, tx),
      ...(plan.actions === undefined ? {} : { actions: planActions(plan, index) }) })),
    disclosures: [
      'Hashes in INTENT/UNKNOWN/ABORTED_BEFORE_SEND are computed offline; they are not claims of successful broadcast or deployment.',
      'CONFIRMED means transaction/receipt/canonical block and applicable runtime/action events were verified.',
      'A confirmed batch receipt can contain failed actions. Inspect every action, not only receipt status.',
      'Unknown or unverified submissions are never retried; remaining transactions stay NOT_SUBMITTED.',
      'ABORTED_BEFORE_SEND means the final approval guard refused before the RPC call; durable sender/nonce intents remain and cannot be reused automatically.',
      'Simulation is a prediction, not an execution guarantee. Observed action results may differ and are reported explicitly.',
      'Each deployment stage consumes its own approval and stops after that single transaction. No following stage or batch is authorized.',
      'Receipt-derived gasUsed * effectiveGasPrice is not an independently observed balance debit. Atlantic fee settlement remains unresolved.',
    ],
    ...(planComparison(plan) === undefined ? {} : { comparison: planComparison(plan) }),
  };
  const persist = async () => { await deps.onEvidence(structuredClone(evidence)); };
  let interrupted = false;
  try {
    verifyApproval(plan, approvalHash, confirmed, now());
    await deps.journal.claimApproval(plan, new Date(now()).toISOString());
    if (plan.purpose === 'deploy') await deps.deployments.claim(plan, new Date(now()).toISOString());
    await persist();
    verifyApproval(plan, approvalHash, confirmed, now());
    const signer = await deps.signerLoader();
    for (const [index, tx] of plan.transactions.entries()) {
      const step = evidence.steps[index]!;
      try {
        // Revalidate time, chain, nonce, code and remaining budget immediately
        // before EACH attempt. Deployment plans contain exactly ONE stage.
        verifyApproval(plan, approvalHash, confirmed, now());
        await deps.deployments.verifyPrerequisites(plan, deps.client, deps.artifactLoader);
        await beforeStep(plan, index, deps.client);
        await freshEstimate(plan, tx, deps.client);
        if (plan.purpose === 'batch') await assertSimulation(plan, deps.client, artifacts.BatchExecutor);
        verifyApproval(plan, approvalHash, confirmed, now());
        const raw = await signer.sign({
          chainId: 688689, type: tx.type!, nonce: tx.nonce,
          ...(tx.to === null ? {} : { to: tx.to }), data: tx.data, value: decimal(tx.valueWei),
          gas: decimal(tx.gasLimit), gasPrice: decimal(plan.gasPriceWei),
        });
        // Verify the signed payload OFFLINE before any submission intent.
        // A signer bug cannot silently change recipient, chain or fee limits.
        await verifySignedPayload(raw, tx, plan);
        verifyApproval(plan, approvalHash, confirmed, now());
        await deps.deployments.verifyPrerequisites(plan, deps.client, deps.artifactLoader);
        await beforeStep(plan, index, deps.client);
        const transactionHash = keccak256(raw);
        step.transactionHash = transactionHash;
        step.state = 'INTENT';
        await deps.journal.append({ at: new Date(now()).toISOString(), planHash: hash, index, id: tx.id,
          state: 'INTENT', transactionHash, nonce: tx.nonce });
        await persist();
        // No await between this final guard and the submission invocation.
        // An aborted intent is retained: it never permits a retry/new-plan bypass.
        try { verifyApproval(plan, approvalHash, confirmed, now()); }
        catch {
          step.state = 'ABORTED_BEFORE_SEND';
          step.error = 'Approval expired or failed at the final send boundary. No RPC submission attempted; durable intent retained. Do not retry.';
          await recordState(step, tx, hash, deps, now);
          interrupted = true;
          break;
        }
        // The serialized payload remains in memory only. Exactly ONE call;
        // transport is configured with retryCount: 0 by the CLI.
        let returnedHash: Hash;
        try { returnedHash = await deps.client.sendRawTransaction({ serializedTransaction: raw }); }
        catch {
          step.state = 'UNKNOWN';
          step.error = 'RPC/transport failed after a submission attempt; acceptance is unknown. Do not retry.';
          await recordState(step, tx, hash, deps, now);
          break;
        }
        if (returnedHash.toLowerCase() !== transactionHash.toLowerCase()) {
          step.state = 'UNKNOWN'; step.error = 'RPC returned an unexpected hash; reconcile the offline-computed hash without resubmitting.';
          await recordState(step, tx, hash, deps, now);
          break;
        }
        step.state = 'SUBMITTED';
        await recordState(step, tx, hash, deps, now);
        await persist();
        let receipt: ReceiptLike & { logs: readonly Log[] };
        try {
          receipt = await deps.client.waitForTransactionReceipt({ hash: transactionHash, confirmations: 2, timeout: 180_000, pollingInterval: 3_000 });
        } catch {
          step.state = 'UNKNOWN'; step.error = 'Receipt not obtained within the confirmation window. Reconcile this exact hash; no retry.';
          await recordState(step, tx, hash, deps, now);
          break;
        }
        step.rawReceipt = receipt;
        try {
          step.receipt = await verifyPlannedReceipt(plan, tx, transactionHash, receipt, deps.client);
          step.fees = feeEvidence(plan, tx, step.receipt);
          if (step.receipt.status === 'reverted') {
            step.state = 'REVERTED'; step.error = 'Outer transaction reverted; no action effects committed.';
          } else {
            Object.assign(step, await verifyPlannedEffects(plan, tx, receipt, step.receipt, deps.client));
            if (tx.kind === 'deployment') step.deploymentRecord = deploymentBinding(await deps.deployments.save(plan, transactionHash, step.receipt, step.deployedAddress!, new Date(now()).toISOString()));
            if (tx.kind === 'batch') step.expectedOutcomesMatch = canonicalJson(step.actions!.map((a) => ({
              id: a.id, success: a.success, returnData: a.returnData, returnDataSize: a.returnDataSize!.toString(),
            }))) === canonicalJson(plan.expectedSimulation);
            step.state = 'CONFIRMED';
          }
        } catch {
          step.state = 'UNVERIFIED'; step.error = 'Receipt, transaction, canonical block, runtime, or action evidence did not verify. Do not assume success.';
        }
        await recordState(step, tx, hash, deps, now);
        await persist();
        if (step.state !== 'CONFIRMED') break;
      } catch {
        // If INTENT/SUBMITTED was reached, a potentially sent transaction must
        // remain UNKNOWN, never be reclassified as safe-to-send.
        if (step.state === 'INTENT' || step.state === 'SUBMITTED') step.state = 'UNKNOWN';
        if (step.state === 'NOT_SUBMITTED') {
          step.state = 'ABORTED_BEFORE_SEND';
          try { await deps.journal.abortBeforeIntent(new Date(now()).toISOString()); } catch { /* The immutable approval/reservation still blocks reuse. */ }
        }
        step.error = step.state === 'ABORTED_BEFORE_SEND' ? 'Submission aborted before the RPC call; abort persistence failed. Preserve durable intent; do not retry.' : step.state === 'UNKNOWN' ? 'Execution interrupted after intent; manual reconciliation required.' : step.state === 'CONFIRMED' || step.state === 'REVERTED' || step.state === 'UNVERIFIED'
          ? 'Execution halted after receipt collection because evidence persistence failed. Preserve the existing hash and reconcile.'
          : 'Approval, pre-submission safety, signing, or persistence check failed; no transaction attempted for this step.';
        interrupted = true;
        break;
      }
    }
    evidence.state = !interrupted && evidence.steps.every((step) => step.state === 'CONFIRMED') ? 'CONFIRMED' : 'HALTED';
    for (const step of evidence.steps) {
      if (step.state === 'NOT_SUBMITTED') step.error ??= 'Not submitted; execution halted before this transaction.';
      if (step.state !== 'CONFIRMED' && step.actions !== undefined) {
        step.actions = step.actions.map((a) => ({ ...a, success: null,
          status: step.state === 'NOT_SUBMITTED' || step.state === 'ABORTED_BEFORE_SEND' ? 'not_submitted' : step.state === 'REVERTED' ? 'not_committed' : 'unknown',
          transactionHash: step.transactionHash, error: step.error ?? 'Outcome is unverified.' }));
      }
    }
    evidence.finishedAt = new Date(now()).toISOString();
    if (plan.purpose === 'batch') evidence.comparison = planComparison(plan, evidence.steps[0]);
    await persist();
    return evidence;
  } catch {
    evidence.state = 'HALTED';
    evidence.finishedAt = new Date(now()).toISOString();
    for (const step of evidence.steps) {
      if (step.state === 'NOT_SUBMITTED') {
        step.state = 'ABORTED_BEFORE_SEND';
        step.error = 'Approval, signing configuration or evidence persistence refused before submission. Consumed approvals and reservations are retained.';
        try { await deps.journal.abortBeforeIntent(new Date(now()).toISOString()); } catch { /* Preserve any existing claim; never retry. */ }
      }
      if (step.state === 'INTENT' || step.state === 'SUBMITTED') {
        step.state = 'UNKNOWN'; step.error = 'Interrupted after intent; reconcile the existing hash, never resend.';
      }
    }
    await persist();
    return evidence;
  } finally { await deps.journal.release(); }
}

async function artifactBindings(plan: BroadcastPlan, loader: typeof loadArtifact) {
  const executor = await loader('BatchExecutor');
  const target = await loader('TestOnlyCounter');
  const artifacts = { BatchExecutor: executor, TestOnlyCounter: target };
  if (plan.purpose === 'deploy') for (const tx of plan.transactions) {
    const artifact = artifacts[tx.artifactName!];
    if (tx.data !== artifact.bytecode || tx.expectedRuntimeCodeHash !== artifact.runtimeCodeHash) throw new ExecutionGateError('Approved deployment differs from the source-bound build artifacts.');
  }
  else if (plan.executorRuntimeCodeHash !== executor.runtimeCodeHash) throw new ExecutionGateError('Approved executor differs from the source-bound artifact.');
  return artifacts;
}

async function preflight(plan: BroadcastPlan, client: RunnerReadClient, artifacts: { BatchExecutor: ContractArtifact }) {
  await beforeStep(plan, 0, client);
  if (plan.purpose !== 'deploy') await assertSimulation(plan, client, artifacts.BatchExecutor);
  for (const tx of plan.transactions) await freshEstimate(plan, tx, client);
}

async function freshEstimate(plan: BroadcastPlan, tx: PlannedTransaction, client: EvmPublicClient) {
  const gas = await client.estimateGas({ account: plan.sender, type: tx.type, nonce: tx.nonce, gasPrice: decimal(plan.gasPriceWei),
    ...(tx.to === null ? {} : { to: tx.to }), data: tx.data, value: decimal(tx.valueWei), gas: decimal(tx.gasLimit) });
  if (gas > decimal(tx.gasLimit)) throw new ExecutionGateError('Fresh gas estimate exceeds approved bound.');
}

async function assertSimulation(plan: BroadcastPlan, client: EvmPublicClient, artifact: ContractArtifact) {
  const adapter = new EvmAdapter({ id: 'atlantic-testnet', rpcUrl: ATLANTIC.rpcUrl, account: plan.sender,
    batchExecutor: plan.batchExecutor!, expectedExecutorCodeHash: artifact.runtimeCodeHash, publicClient: client });
  const simulation = await adapter.simulateBatch(validateActions(plan.actions));
  if (simulation.state !== 'dry_run') throw new ExecutionGateError('Fresh simulation failed before signing.');
  const outcomes = simulation.actions.map((a) => ({ id: a.id, success: a.success, returnData: a.returnData, returnDataSize: a.returnDataSize?.toString() }));
  if (canonicalJson(outcomes) !== canonicalJson(plan.expectedSimulation)) throw new ExecutionGateError('Fresh action outcomes differ from the approved simulation.');
}

async function beforeStep(plan: BroadcastPlan, index: number, client: RunnerReadClient) {
  if (await client.getChainId() !== ATLANTIC.chainId) throw new ExecutionGateError('RPC chain changed; refused.');
  const [pending, latest, balance, gasPrice, blockNumber] = await Promise.all([
    client.getTransactionCount({ address: plan.sender, blockTag: 'pending' }),
    client.getTransactionCount({ address: plan.sender, blockTag: 'latest' }),
    client.getBalance({ address: plan.sender }), client.getGasPrice(), client.getBlockNumber(),
  ]);
  if (pending !== plan.transactions[index]!.nonce || pending !== latest) throw new ExecutionGateError('Nonce changed or wallet has an unresolved pending transaction.');
  const senderCode = await client.getCode({ address: plan.sender });
  if (senderCode !== undefined && senderCode !== '0x') throw new ExecutionGateError('Reviewed direct-wallet sender is no longer code-empty.');
  if (gasPrice > decimal(plan.gasPriceWei)) throw new ExecutionGateError('Gas price is above the explicitly approved price.');
  const remaining = plan.transactions.slice(index).reduce((sum, tx) => sum + decimal(tx.gasLimit) * decimal(plan.gasPriceWei) + decimal(tx.valueWei), 0n);
  if (balance < remaining) throw new ExecutionGateError('Insufficient balance for remaining approved gas/value ceiling.');
  const block = await client.getBlock({ blockNumber });
  if (plan.transactions.slice(index).some((tx) => decimal(tx.gasLimit) > block.gasLimit)) throw new ExecutionGateError('Approved transaction exceeds current block gas limit.');
  if (plan.purpose === 'deploy') {
    const address = plan.transactions[index]!.expectedContractAddress!;
    const [code, nonce] = await Promise.all([client.getCode({ address }), client.getTransactionCount({ address, blockTag: 'latest' })]);
    if ((code !== undefined && code !== '0x') || nonce !== 0) throw new ExecutionGateError('Predicted CREATE destination is occupied; no duplicate deployment.');
  }
  if (plan.targetCodeHashes) for (const [address, hash] of Object.entries(plan.targetCodeHashes)) {
    if (keccak256((await client.getCode({ address: address as Address })) ?? '0x') !== hash) throw new ExecutionGateError('Target code changed since approval.');
  }
  if (plan.batchExecutor !== undefined && keccak256((await client.getCode({ address: plan.batchExecutor })) ?? '0x') !== plan.executorRuntimeCodeHash) {
    throw new ExecutionGateError('Executor code changed since approval.');
  }
  if (plan.batchExecutor !== undefined) await assertAuthorizedCaller(client, plan.batchExecutor, plan.sender);
}

async function recordState(step: ExecutionStep, tx: PlannedTransaction, hash: string, deps: RunnerDependencies, now: () => number) {
  if (step.state === 'NOT_SUBMITTED' || step.transactionHash === undefined) return;
  await deps.journal.append({ at: new Date(now()).toISOString(), planHash: hash, index: step.index, id: step.id,
    state: step.state, transactionHash: step.transactionHash, nonce: tx.nonce,
    ...(step.receipt === undefined ? {} : { receipt: step.receipt }), ...(step.error === undefined ? {} : { error: step.error }) });
}

function freezePlan<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freezePlan(item);
    Object.freeze(value);
  }
  return value;
}

async function verifySignedPayload(raw: Hex, tx: PlannedTransaction, plan: BroadcastPlan): Promise<void> {
  const parsed = parseTransaction(raw);
  if (parsed.type !== 'legacy' || parsed.chainId !== 688689 || parsed.nonce !== tx.nonce ||
    (parsed.to?.toLowerCase() ?? null) !== (tx.to?.toLowerCase() ?? null) ||
    parsed.data !== tx.data || (parsed.value ?? 0n) !== decimal(tx.valueWei) ||
    parsed.gas !== decimal(tx.gasLimit) || parsed.gasPrice !== decimal(plan.gasPriceWei) ||
    // parseTransaction has already verified and classified the legacy encoding.
    (await recoverTransactionAddress({ serializedTransaction: raw as TransactionSerializedLegacy })).toLowerCase() !== plan.sender.toLowerCase()) {
    throw new ExecutionGateError('Offline signed payload does not match approved sender, chain, calldata, nonce or gas/value bounds.');
  }
}
