import { getAddress } from 'viem';
import type { BatchGasEstimates } from './adapters/types.js';
import { preparePlan } from './plan.js';
import { resultsFromReceipt, verifyReceipt, verifyTransaction, type ReceiptLike, type TransactionLike } from './receipt.js';
import type { ActualReceipt, BatchExecutionResult, ComparisonBinding, ExecutionComparison, IndividualExecutionResult, ValidatedAction } from './types.js';

export function createComparisonBinding(
  actions: readonly ValidatedAction[], observation: Omit<ComparisonBinding, 'actionPlanHash'>,
): ComparisonBinding {
  return { ...structuredClone(observation), sender: getAddress(observation.sender), executor: getAddress(observation.executor),
    actionPlanHash: preparePlan(actions).planHash };
}

export function buildComparison(
  actions: readonly ValidatedAction[],
  estimates: BatchGasEstimates,
  batch: BatchExecutionResult,
  individual?: IndividualExecutionResult,
  baselineMethod = 'Independent eth_estimateGas calls at the same block; no baseline transactions broadcast.',
): ExecutionComparison {
  const plan = preparePlan(actions);
  const count = plan.actions.length;
  const comparison: ExecutionComparison = {
    individual: {
      transactionCount: count,
      estimatedGas: {
        gas: estimates.individualTotal, estimate: true, source: estimates.batch.source,
        ...(estimates.individualTotal === null ? { error: 'One or more individual estimates failed; total unavailable.' } : {}),
      },
    },
    batch: { transactionCount: 1, estimatedGas: estimates.batch },
    transactionReduction: { count: count - 1, fraction: (count - 1) / count },
    baselineMethod,
    limitations: [
      'Gas estimates are not measured usage. The executor reserves gas for every action, so the batch estimate can exceed actual gas used.',
      'Targets see the executor as msg.sender. Sender-dependent operations and dependent approve/swap/claim workflows are unsupported.',
      'Deployment, baseline experiments and refund withdrawals are separate transactions and excluded from per-batch execution counts.',
      'CALL success does not prove application postconditions or interpret a token return value of false.',
      'Measured baselines require the same canonical plan, environment, sender, executor/runtime and starting block/state root, plus receipt-bound mined transactions. Legacy unbound evidence is not upgraded automatically.',
      'Starting headers and canonical receipts are capture-time RPC observations, not a trustless proof. The first transactions must be in the immediate child of the shared starting block; baseline transactions must be consecutive without intervening transactions/blocks.',
    ],
  };
  if (estimates.individualTotal !== null && estimates.individualTotal > 0n && estimates.batch.gas !== null) {
    const diff = estimates.individualTotal - estimates.batch.gas;
    comparison.estimatedSavings = { gas: diff, fraction: fraction(diff, estimates.individualTotal) };
  }
  const batchReceipt = batch.receipt;
  if (batchReceipt?.evidence === 'actual') {
    comparison.batch.measuredGas = { gas: batchReceipt.gasUsed, measured: true, receipts: 1 };
  }
  if (individual !== undefined && (batchReceipt?.evidence === 'actual' ||
    (Array.isArray(individual.receipts) && individual.receipts.some((r) => r?.evidence === 'actual')))) {
    try {
      const total = validateMeasuredBaseline(plan, batch, individual);
      comparison.baselineValidation = { status: 'accepted' };
      comparison.individual.measuredGas = { gas: total, measured: true, receipts: count };
      const diff = total - (batchReceipt as ActualReceipt).gasUsed;
      comparison.measuredSavings = { gas: diff, fraction: fraction(diff, total) };
    } catch {
      const error = 'Measured baseline rejected: incomplete or mismatched action-plan, starting state/environment, mined transaction, receipt, or outcome bindings.';
      comparison.baselineValidation = { status: 'rejected', error };
      comparison.limitations.push(error);
    }
  }
  return comparison;
}

function validateMeasuredBaseline(
  plan: ReturnType<typeof preparePlan>, batch: BatchExecutionResult, individual: IndividualExecutionResult,
): bigint {
  const left = batch.comparisonBinding;
  const right = individual.comparisonBinding;
  assertComparable(left !== undefined && right !== undefined);
  for (const binding of [left, right]) {
    assertComparable(binding.actionPlanHash === plan.planHash);
    assertComparable((binding.environment === 'local-evm' && binding.chainId === 31337) ||
      (binding.environment === 'atlantic-testnet' && binding.chainId === 688689));
    assertComparable(typeof binding.startingBlock.number === 'bigint' && binding.startingBlock.number > 0n);
    for (const hash of [binding.startingBlock.hash, binding.startingBlock.stateRoot, binding.executorRuntimeCodeHash]) {
      assertComparable(typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash) && !/^0x0{64}$/.test(hash));
    }
    assertComparable(getAddress(binding.sender) !== '0x0000000000000000000000000000000000000000');
    assertComparable(getAddress(binding.executor) !== '0x0000000000000000000000000000000000000000');
  }
  assertComparable(left.environment === right.environment && left.chainId === right.chainId &&
    getAddress(left.sender) === getAddress(right.sender) && getAddress(left.executor) === getAddress(right.executor) &&
    left.executorRuntimeCodeHash.toLowerCase() === right.executorRuntimeCodeHash.toLowerCase() &&
    left.startingBlock.number === right.startingBlock.number &&
    left.startingBlock.hash.toLowerCase() === right.startingBlock.hash.toLowerCase() &&
    left.startingBlock.stateRoot.toLowerCase() === right.startingBlock.stateRoot.toLowerCase());
  assertComparable(plan.actions.every((a) => a.target.toLowerCase() !== left.executor.toLowerCase()));
  assertComparable(batch.kind === 'batch' && individual.kind === 'individual' && batch.error === undefined &&
    batch.state === 'confirmed' && batch.receipt?.evidence === 'actual' && batch.receipt.status === 'success');
  assertComparable(batch.transaction !== undefined && batch.transactionHash?.toLowerCase() === batch.receipt.txHash.toLowerCase());
  assertComparable(individual.error === undefined && individual.receipts.length === plan.actions.length &&
    individual.transactions?.length === plan.actions.length && individual.actions.length === plan.actions.length &&
    individual.rawReceipts?.length === plan.actions.length &&
    batch.actions.length === plan.actions.length && batch.refundCreditWei === 0n);
  const batchReceipt = batch.receipt;
  const rawBatch = batch.rawReceipt as ReceiptLike | undefined;
  assertComparable(rawBatch !== undefined && Array.isArray(rawBatch.logs));
  checkMinedTransaction(batchReceipt, rawBatch, batch.transaction, left, left.executor, plan.batchCalldata, plan.totalValue, batch.transaction.nonce);
  const batchEvents = resultsFromReceipt(plan.actions, rawBatch.logs, left.executor, left.sender, {
    transactionHash: batchReceipt.txHash, blockHash: batchReceipt.blockHash, blockNumber: batchReceipt.blockNumber,
  });
  assertComparable(batchEvents.refundCreditWei === batch.refundCreditWei);
  // A capture block alone is not enough: both first transactions must start at
  // index zero in its immediate child block (e.g. snapshot-restored branches).
  assertFirstTransaction(batchReceipt, batch.transaction, left);
  const hashes = new Set<string>([batchReceipt.txHash.toLowerCase()]);
  let total = 0n;
  for (const [i, action] of plan.actions.entries()) {
    const receipt = individual.receipts[i]!;
    assertComparable(receipt.evidence === 'actual');
    const actual = receipt;
    const hash = actual.txHash.toLowerCase();
    assertComparable(!hashes.has(hash));
    hashes.add(hash);
    const transaction = individual.transactions![i]!;
    checkMinedTransaction(actual, individual.rawReceipts![i] as ReceiptLike, transaction, right, action.target, action.calldata, action.value, batch.transaction.nonce + i);
    if (i === 0) assertFirstTransaction(actual, transaction, right);
    else {
      const previous = individual.receipts[i - 1] as ActualReceipt;
      const previousTx = individual.transactions![i - 1]!;
      if (actual.blockHash.toLowerCase() === previous.blockHash.toLowerCase()) {
        assertComparable(actual.blockNumber === previous.blockNumber && transaction.transactionIndex === previousTx.transactionIndex! + 1 &&
          actual.blockTransactionCount === previous.blockTransactionCount &&
          actual.parentBlockHash?.toLowerCase() === previous.parentBlockHash?.toLowerCase());
      } else assertComparable(actual.blockNumber === previous.blockNumber + 1n && transaction.transactionIndex === 0 &&
        previousTx.transactionIndex === previous.blockTransactionCount! - 1 &&
        actual.parentBlockHash?.toLowerCase() === previous.blockHash.toLowerCase());
    }
    const observed = individual.actions[i]!;
    const batched = batch.actions[i]!;
    const event = batchEvents.actions[i]!;
    assertComparable(observed.index === i && batched.index === i && observed.id === action.id && batched.id === action.id &&
      getAddress(observed.target) === action.target && getAddress(batched.target) === action.target &&
      batched.returnDataSource === 'event' && observed.returnDataSource === 'unavailable' &&
      batched.success === event.success && batched.returnData?.toLowerCase() === event.returnData?.toLowerCase() &&
      batched.returnDataSize === event.returnDataSize && batched.returnDataTruncated === event.returnDataTruncated &&
      observed.success !== null && observed.success === batched.success &&
      (actual.status === 'success') === observed.success && observed.transactionHash?.toLowerCase() === hash &&
      observed.status === (observed.success ? 'succeeded' : 'failed') && batched.status === (batched.success ? 'succeeded' : 'failed'));
    total += actual.gasUsed;
  }
  assertComparable(total > 0n);
  return total;
}

function checkMinedTransaction(
  receipt: ActualReceipt, raw: ReceiptLike, tx: TransactionLike, binding: ComparisonBinding,
  to: `0x${string}`, data: `0x${string}`, value: bigint, nonce: number,
): void {
  assertComparable(receipt.parentBlockHash !== undefined && receipt.blockTransactionCount !== undefined);
  const checked = verifyReceipt(raw, receipt.txHash, {
    canonicalBlockHash: receipt.blockHash, canonicalBlockParentHash: receipt.parentBlockHash,
    canonicalBlockTransactionCount: receipt.blockTransactionCount,
    minimumConfirmations: binding.environment === 'atlantic-testnet' ? 2n : 1n,
    currentBlockNumber: receipt.blockNumber + receipt.confirmations - 1n });
  if (checked.status !== receipt.status || checked.gasUsed !== receipt.gasUsed || checked.blockNumber !== receipt.blockNumber ||
    checked.effectiveGasPrice !== receipt.effectiveGasPrice || checked.feeWei !== receipt.feeWei || !Number.isSafeInteger(nonce) || nonce < 0 ||
    tx.blockNumber !== receipt.blockNumber || tx.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    !Number.isSafeInteger(tx.transactionIndex) || tx.transactionIndex! < 0 || tx.transactionIndex! >= receipt.blockTransactionCount ||
    receipt.blockNumber <= binding.startingBlock.number) {
    throw new Error('Invalid receipt/mined transaction binding.');
  }
  verifyTransaction(tx, { hash: receipt.txHash, from: binding.sender, to, data, value, chainId: binding.chainId, nonce });
}

function assertFirstTransaction(receipt: ActualReceipt, tx: TransactionLike, binding: ComparisonBinding): void {
  assertComparable(receipt.blockNumber === binding.startingBlock.number + 1n && tx.transactionIndex === 0 &&
    receipt.parentBlockHash?.toLowerCase() === binding.startingBlock.hash.toLowerCase());
}

function assertComparable(condition: unknown): asserts condition {
  if (!condition) throw new Error('Invalid measured baseline.');
}

function fraction(numerator: bigint, denominator: bigint): number {
  return Number(numerator * 1_000_000n / denominator) / 1_000_000;
}
