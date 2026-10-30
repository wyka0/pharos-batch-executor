import { decodeFunctionResult, keccak256, type Address, type Hash, type Hex, type Log } from 'viem';

import { BATCH_EXECUTOR_ABI } from '../abi.js';
import { assertAuthorizedCaller } from '../caller.js';
import { createComparisonBinding } from '../comparison.js';
import { BatchPlanError, ExecutionGateError } from '../errors.js';
import { minimumBatchTransactionGas } from '../limits.js';
import { ATLANTIC, assertEndpoint } from '../network.js';
import { preparePlan } from '../plan.js';
import { resultsFromReceipt, verifyActionEvents, verifyReceipt, verifyTransaction, type ReceiptLike, type TransactionLike } from '../receipt.js';
import type { ActionResult, BatchExecutionResult, ComparisonBinding, IndividualExecutionResult, ValidatedAction } from '../types.js';
import type { BatchGasEstimates, ChainAdapter } from './types.js';

export interface CallRequest { account: Address; to: Address; data: Hex; value: bigint; gas?: bigint; gasPrice?: bigint; nonce?: number; type?: 'legacy'; blockNumber?: bigint }
export interface EvmPublicClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ hash: Hash | null; gasLimit: bigint; stateRoot?: Hash; parentHash?: Hash; transactions?: readonly unknown[] }>;
  getBalance(args: { address: Address; blockNumber?: bigint }): Promise<bigint>;
  getCode(args: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined>;
  estimateGas(args: Omit<CallRequest, 'to'> & { to?: Address }): Promise<bigint>;
  call(args: CallRequest): Promise<{ data?: Hex }>;
  waitForTransactionReceipt(args: { hash: Hash; confirmations?: number; timeout?: number; pollingInterval?: number }): Promise<ReceiptLike & { logs: readonly Log[] }>;
  getTransaction(args: { hash: Hash }): Promise<TransactionLike>;
}

export interface SubmitRequest { to: Address; data: Hex; value: bigint; gas: bigint }
export interface Submission {
  state: 'submitted' | 'unknown' | 'not_submitted'; hash?: Hash; error?: string; nonce?: number;
}
export interface ApprovedSubmitter { submit(request: SubmitRequest): Promise<Submission> }

export interface EvmAdapterOptions {
  id: 'local-anvil' | 'atlantic-testnet';
  rpcUrl: string;
  account: Address;
  batchExecutor: Address;
  expectedExecutorCodeHash: Hash;
  publicClient: EvmPublicClient;
  /** Absent by default: there is no execution capability in a dry-run. */
  submitter?: ApprovedSubmitter;
  approvedGasLimit?: bigint;
}

/** Read-only by default; all real submissions must pass an external gate. */
export class EvmAdapter implements ChainAdapter {
  readonly id: 'local-anvil' | 'atlantic-testnet';
  readonly chainId: number;
  readonly environment: 'local-evm' | 'atlantic-testnet';
  private readonly options: EvmAdapterOptions;

  constructor(options: EvmAdapterOptions) {
    assertEndpoint(options.id, options.rpcUrl);
    this.id = options.id;
    this.chainId = options.id === 'local-anvil' ? 31337 : ATLANTIC.chainId;
    this.environment = options.id === 'local-anvil' ? 'local-evm' : 'atlantic-testnet';
    this.options = options;
  }

  async assertNetwork(): Promise<void> {
    if (await this.options.publicClient.getChainId() !== this.chainId) throw new ExecutionGateError('RPC chain ID mismatch; execution blocked.');
    const code = await this.options.publicClient.getCode({ address: this.options.batchExecutor });
    if (code === undefined || code === '0x' || keccak256(code) !== this.options.expectedExecutorCodeHash) {
      throw new ExecutionGateError('Executor runtime bytecode mismatch or missing deployment.');
    }
    await assertAuthorizedCaller(this.options.publicClient, this.options.batchExecutor, this.options.account);
  }

  async estimateGas(actions: readonly ValidatedAction[]): Promise<BatchGasEstimates> {
    await this.assertNetwork();
    const plan = preparePlan(actions);
    const blockNumber = await this.options.publicClient.getBlockNumber();
    const individual = [];
    for (const action of plan.actions) {
      try {
        const gas = await this.options.publicClient.estimateGas({
          account: this.options.account, to: action.target, data: action.calldata,
          value: action.value, blockNumber,
        });
        individual.push({ gas, estimate: true as const, source: 'rpc' as const });
      } catch {
        // A reverting individual call has no usable gas estimate. Never replace
        // it with 21,000, a guessed limit, or a fabricated total.
        individual.push({ gas: null, estimate: true as const, source: 'rpc' as const, error: `Gas estimation failed for "${action.id}" (revert, RPC, or gas exhaustion).` });
      }
    }
    let batch;
    try {
      batch = {
        gas: await this.options.publicClient.estimateGas(this.batchCall(plan, blockNumber)),
        estimate: true as const, source: 'rpc' as const,
      };
    } catch {
      batch = { gas: null, estimate: true as const, source: 'rpc' as const, error: 'Batch gas estimation failed; broadcasting is blocked.' };
    }
    return {
      individual, batch, blockNumber,
      individualTotal: individual.every((item) => item.gas !== null)
        ? individual.reduce((sum, item) => sum + (item.gas ?? 0n), 0n) : null,
    };
  }

  async simulateBatch(actions: readonly ValidatedAction[]): Promise<BatchExecutionResult> {
    await this.assertNetwork();
    const plan = preparePlan(actions);
    try {
      const blockNumber = await this.options.publicClient.getBlockNumber();
      const reply = await this.options.publicClient.call(this.batchCall(plan, blockNumber));
      if (reply.data === undefined) throw new BatchPlanError('Missing eth_call return data.');
      const decoded = decodeFunctionResult({ abi: BATCH_EXECUTOR_ABI, functionName: 'execute', data: reply.data });
      if (decoded.length !== actions.length) throw new BatchPlanError('Simulation result count mismatch.');
      const verified = verifyActionEvents(actions, decoded.map((r, index) => ({
        index, idBytes32: actions[index]!.idBytes32, target: actions[index]!.target,
        success: r.success, result: r.data, returnDataSize: r.returnDataSize,
      }))).map((action) => ({ ...action, returnDataSource: 'simulation' as const }));
      return {
        kind: 'batch', state: 'dry_run', actions: verified,
        refundCreditWei: actions.reduce((sum, a, i) => sum + (verified[i]?.success === false ? a.value : 0n), 0n),
      };
    } catch {
      const error = 'Batch simulation failed. No transaction submitted and no action outcome assumed.';
      return { kind: 'batch', state: 'not_submitted', actions: unavailable(actions, 'not_submitted', error), error, refundCreditWei: 0n };
    }
  }

  async executeBatch(actions: readonly ValidatedAction[]): Promise<BatchExecutionResult> {
    if (this.options.submitter === undefined) throw new ExecutionGateError('Dry-run adapter has no broadcast capability.');
    await this.assertNetwork();
    const plan = preparePlan(actions);
    const simulation = await this.simulateBatch(actions);
    if (simulation.state !== 'dry_run') return simulation;
    let estimate: bigint;
    try { estimate = await this.options.publicClient.estimateGas(this.batchCall(plan)); }
    catch {
      const error = 'Batch gas estimation failed immediately before submission; no transaction sent.';
      return { kind: 'batch', state: 'not_submitted', actions: unavailable(actions, 'not_submitted', error), error, refundCreditWei: 0n };
    }
    const gas = this.options.approvedGasLimit ?? (estimate * 12_000n + 9_999n) / 10_000n;
    if (gas < estimate) throw new ExecutionGateError('Current gas estimate exceeds approved transaction gas limit.');
    if (gas < minimumBatchTransactionGas(plan.actions, plan.batchCalldata)) throw new ExecutionGateError('Transaction gas bound is below batch execution reservation plus intrinsic/calldata gas.');
    await this.checkFundsAndBlockGas(gas, plan.totalValue);
    const comparisonBinding = await this.captureComparisonBinding(plan.actions);
    const request = { to: this.options.batchExecutor, data: plan.batchCalldata, value: plan.totalValue, gas };
    const submission = await submitSafely(this.options.submitter, request);
    if (submission.state !== 'submitted' || submission.hash === undefined) {
      return {
        kind: 'batch', state: submission.state === 'not_submitted' ? 'not_submitted' : 'unknown',
        ...(submission.hash === undefined ? {} : { transactionHash: submission.hash }),
        actions: unavailable(actions, submission.state === 'not_submitted' ? 'not_submitted' : 'unknown', submission.error ?? 'Submission outcome unknown; do not retry.'),
        error: submission.error, refundCreditWei: 0n,
      };
    }
    let rawReceipt: (ReceiptLike & { logs: readonly Log[] }) | undefined;
    let receipt: BatchExecutionResult['receipt'];
    let transaction: TransactionLike | undefined;
    try {
      rawReceipt = await this.options.publicClient.waitForTransactionReceipt({
        hash: submission.hash, confirmations: this.chainId === 31337 ? 1 : 2, timeout: 180_000, pollingInterval: 3_000,
      });
      ({ receipt, transaction } = await this.checkedReceipt(submission.hash, rawReceipt, request, submission.nonce));
      if (receipt.status === 'reverted') return {
        kind: 'batch', state: 'reverted', transactionHash: submission.hash, receipt, rawReceipt, transaction, comparisonBinding,
        actions: unavailable(actions, 'not_committed', 'Outer transaction reverted: no action effects committed; intermediate execution order is not provable from this receipt.'),
        refundCreditWei: 0n,
      };
      const code = await this.options.publicClient.getCode({ address: this.options.batchExecutor, blockNumber: receipt.blockNumber });
      if (code === undefined || keccak256(code) !== this.options.expectedExecutorCodeHash) throw new ExecutionGateError('Executor runtime at the receipt block does not verify.');
      await assertAuthorizedCaller(this.options.publicClient, this.options.batchExecutor, this.options.account, receipt.blockNumber);
      const result = resultsFromReceipt(actions, rawReceipt.logs, this.options.batchExecutor, this.options.account, {
        transactionHash: receipt.txHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber,
      });
      return { kind: 'batch', state: 'confirmed', transactionHash: submission.hash, receipt, rawReceipt, transaction, comparisonBinding, ...result };
    } catch {
      const state = rawReceipt === undefined ? 'unknown' : 'unverified';
      const error = 'Receipt missing or verification failed. Preserve this hash and reconcile; never resubmit blindly.';
      return {
        kind: 'batch', state, transactionHash: submission.hash, rawReceipt, receipt, transaction, comparisonBinding,
        actions: unavailable(actions, 'unknown', error), error, refundCreditWei: 0n,
      };
    }
  }

  /** Individual transactions are a BASELINE only, never called a batch. */
  async executeIndividual(actions: readonly ValidatedAction[]): Promise<IndividualExecutionResult> {
    if (this.options.submitter === undefined) throw new ExecutionGateError('Individual execution requires an explicit broadcast capability.');
    await this.assertNetwork();
    preparePlan(actions);
    const result: IndividualExecutionResult = { kind: 'individual', receipts: [], actions: [], rawReceipts: [], transactions: [],
      comparisonBinding: await this.captureComparisonBinding(actions) };
    for (const [index, action] of actions.entries()) {
      let gas: bigint;
      try {
        gas = await this.options.publicClient.estimateGas({ account: this.options.account, to: action.target, data: action.calldata, value: action.value });
      } catch {
        result.error = `Gas estimation failed at action ${index}; it and all remaining individual baseline actions were not submitted.`;
        result.actions.push(...unavailable(actions.slice(index), 'not_submitted', result.error, index));
        return result;
      }
      const request = { to: action.target, data: action.calldata, value: action.value, gas: (gas * 12_000n + 9_999n) / 10_000n };
      const submission = await submitSafely(this.options.submitter, request);
      if (submission.state !== 'submitted' || submission.hash === undefined) {
        result.error = submission.error ?? 'Individual submission outcome unknown; stopped without retry.';
        result.actions.push(...unavailable([action], submission.state === 'not_submitted' ? 'not_submitted' : 'unknown', result.error, index).map((a) => ({ ...a, transactionHash: submission.hash })));
        result.actions.push(...unavailable(actions.slice(index + 1), 'not_submitted', 'Stopped after uncertain submission; remaining baseline actions were not sent.', index + 1));
        return result;
      }
      try {
        const raw = await this.options.publicClient.waitForTransactionReceipt({ hash: submission.hash });
        result.rawReceipts!.push(raw);
        const { receipt, transaction } = await this.checkedReceipt(submission.hash, raw, request, submission.nonce);
        result.transactions!.push(transaction);
        result.receipts.push(receipt);
        result.actions.push({
          index, id: action.id, target: action.target, transactionHash: submission.hash, success: receipt.status === 'success',
          status: receipt.status === 'success' ? 'succeeded' : 'failed', returnDataSource: 'unavailable',
          ...(receipt.status === 'success' ? {} : { error: 'Individual transaction reverted; return data unavailable in standard receipt.' }),
        });
      } catch {
        result.error = `Receipt unverified for ${submission.hash}; remaining baseline actions not sent.`;
        result.actions.push(...unavailable([action], 'unknown', result.error, index).map((a) => ({ ...a, transactionHash: submission.hash })));
        result.actions.push(...unavailable(actions.slice(index + 1), 'not_submitted', result.error, index + 1));
        return result;
      }
    }
    return result;
  }

  private batchCall(plan: ReturnType<typeof preparePlan>, blockNumber?: bigint): CallRequest {
    return {
      account: this.options.account, to: this.options.batchExecutor, data: plan.batchCalldata,
      value: plan.totalValue, gas: minimumBatchTransactionGas(plan.actions, plan.batchCalldata) + 200_000n,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    };
  }

  private async captureComparisonBinding(actions: readonly ValidatedAction[]): Promise<ComparisonBinding | undefined> {
    const number = await this.options.publicClient.getBlockNumber();
    const block = await this.options.publicClient.getBlock({ blockNumber: number });
    if (block.hash === null || block.stateRoot === undefined) return undefined;
    const code = await this.options.publicClient.getCode({ address: this.options.batchExecutor, blockNumber: number });
    if (code === undefined || keccak256(code) !== this.options.expectedExecutorCodeHash) throw new ExecutionGateError('Executor runtime at the starting block does not verify.');
    await assertAuthorizedCaller(this.options.publicClient, this.options.batchExecutor, this.options.account, number);
    return createComparisonBinding(actions, { environment: this.environment, chainId: this.chainId,
      sender: this.options.account, executor: this.options.batchExecutor, executorRuntimeCodeHash: this.options.expectedExecutorCodeHash,
      startingBlock: { number, hash: block.hash, stateRoot: block.stateRoot } });
  }

  private async checkFundsAndBlockGas(gas: bigint, value: bigint): Promise<void> {
    const client = this.options.publicClient;
    const balance = await client.getBalance({ address: this.options.account });
    const block = await client.getBlock({ blockNumber: await client.getBlockNumber() });
    if (balance < value) throw new ExecutionGateError('Insufficient value balance. Fee balance is checked by the submitter.');
    if (gas > block.gasLimit) throw new ExecutionGateError('Transaction gas exceeds block gas limit.');
  }

  private async checkedReceipt(hash: Hash, raw: ReceiptLike, request: SubmitRequest, nonce?: number) {
    const client = this.options.publicClient;
    if (await client.getChainId() !== this.chainId) throw new ExecutionGateError('Receipt RPC chain ID mismatch.');
    const tx = await client.getTransaction({ hash });
    verifyTransaction(tx, { hash, from: this.options.account, to: request.to, data: request.data, value: request.value, chainId: this.chainId, nonce });
    if (raw.blockNumber === undefined) throw new BatchPlanError('Missing receipt block.');
    const canonical = await client.getBlock({ blockNumber: raw.blockNumber });
    if (canonical.hash === null) throw new BatchPlanError('Unmined canonical block.');
    const receipt = verifyReceipt(raw, hash, {
      currentBlockNumber: await client.getBlockNumber(), canonicalBlockHash: canonical.hash,
      ...(canonical.parentHash === undefined ? {} : { canonicalBlockParentHash: canonical.parentHash }),
      ...(canonical.transactions === undefined ? {} : { canonicalBlockTransactionCount: canonical.transactions.length }),
      minimumConfirmations: this.chainId === 31337 ? 1n : 2n,
      ...(this.chainId === ATLANTIC.chainId ? { explorerBaseUrl: ATLANTIC.explorerUrl } : {}),
    });
    return { receipt, transaction: tx };
  }
}

function unavailable(
  actions: readonly ValidatedAction[], status: ActionResult['status'], error: string, offset = 0,
): ActionResult[] {
  return actions.map((a, i) => ({ index: offset + i, id: a.id, target: a.target, status, success: null, returnDataSource: 'unavailable', error }));
}

async function submitSafely(submitter: ApprovedSubmitter, request: SubmitRequest): Promise<Submission> {
  try { return await submitter.submit(request); }
  catch {
    // A thrown submission exception may follow an accepted send and may carry
    // sensitive payloads. Do not log it, classify as not-sent, or retry it.
    return { state: 'unknown', error: 'Submission capability threw; acceptance unknown. Stop and reconcile without retry.' };
  }
}
