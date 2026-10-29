import type { BatchGasEstimates } from './adapters/types.js';
import type { BatchExecutionResult, ExecutionComparison, IndividualExecutionResult } from './types.js';

export function buildComparison(
  count: number,
  estimates: BatchGasEstimates,
  batch: BatchExecutionResult,
  individual?: IndividualExecutionResult,
  baselineMethod = 'Independent eth_estimateGas calls at the same block; no baseline transactions broadcast.',
): ExecutionComparison {
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
    ],
  };
  if (estimates.individualTotal !== null && estimates.individualTotal > 0n && estimates.batch.gas !== null) {
    const diff = estimates.individualTotal - estimates.batch.gas;
    comparison.estimatedSavings = { gas: diff, fraction: fraction(diff, estimates.individualTotal) };
  }
  const batchReceipt = batch.receipt;
  if (individual !== undefined && individual.receipts.length === count && individual.receipts.every((r) => r.evidence === 'actual')) {
    const total = individual.receipts.reduce((sum, r) => sum + (r.evidence === 'actual' ? r.gasUsed : 0n), 0n);
    comparison.individual.measuredGas = { gas: total, measured: true, receipts: count };
    if (batchReceipt?.evidence === 'actual') {
      comparison.batch.measuredGas = { gas: batchReceipt.gasUsed, measured: true, receipts: 1 };
      // Only comparable, verified outcomes qualify as measured savings.
      const equivalent = batch.state === 'confirmed' && batchReceipt.status === 'success' &&
        batch.actions.length === count && individual.actions.length === count &&
        batch.actions.every((a, i) => a.index === i && a.id === individual.actions[i]?.id && a.target === individual.actions[i]?.target &&
          a.success !== null && a.success === individual.actions[i]?.success &&
          (individual.receipts[i]?.status === 'success') === individual.actions[i]?.success);
      if (equivalent && total > 0n) {
        const diff = total - batchReceipt.gasUsed;
        comparison.measuredSavings = { gas: diff, fraction: fraction(diff, total) };
      } else comparison.limitations.push('Measured savings withheld: outcomes are not verified and equivalent.');
    }
  } else if (batchReceipt?.evidence === 'actual') {
    comparison.batch.measuredGas = { gas: batchReceipt.gasUsed, measured: true, receipts: 1 };
  }
  return comparison;
}

function fraction(numerator: bigint, denominator: bigint): number {
  return Number(numerator * 1_000_000n / denominator) / 1_000_000;
}
