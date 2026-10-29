import { buildComparison } from '../comparison.js';
import type { ActionResult, ActualReceipt, ExecutionComparison } from '../types.js';
import { decimal, type BroadcastPlan } from './broadcast-plan.js';

export function planComparison(plan: BroadcastPlan, step?: {
  state: string; receipt?: ActualReceipt; actions?: ActionResult[]; refundCreditWei?: bigint;
}): ExecutionComparison | undefined {
  if (plan.gasEstimates === undefined || plan.actions === undefined) return undefined;
  const estimates = plan.gasEstimates.individual.map((item) => ({ gas: item.gas === null ? null : decimal(item.gas),
    source: 'rpc' as const, estimate: true as const, ...(item.error === undefined ? {} : { error: item.error }) }));
  return buildComparison(plan.actions.length, {
    individual: estimates, individualTotal: estimates.every((item) => item.gas !== null)
      ? estimates.reduce((sum, item) => sum + item.gas!, 0n) : null,
    batch: { gas: decimal(plan.gasEstimates.batch), source: 'rpc', estimate: true },
  }, {
    kind: 'batch', state: step?.state === 'CONFIRMED' ? 'confirmed' : 'unverified',
    ...(plan.purpose === 'batch' && step?.receipt !== undefined ? { receipt: step.receipt } : {}),
    actions: step?.actions ?? [], refundCreditWei: step?.refundCreditWei ?? 0n,
  }, undefined, `RPC ESTIMATES at block ${plan.gasEstimates.blockNumber}. No same-state Atlantic baseline receipts supplied; measured gas savings are unavailable.`);
}
