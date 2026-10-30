import type { ActualReceipt } from '../types.js';
import type { BroadcastPlan, PlannedTransaction } from './broadcast-plan.js';

/** Receipt arithmetic and gas-limit budgeting do not resolve Atlantic settlement. */
export interface FeeEvidence {
  estimatedGas: string;
  approvedGasLimit: string;
  approvedGasPriceWei: string;
  gasLimitBudgetWei: string;
  receiptGasUsed: string | null;
  receiptEffectiveGasPriceWei: string | null;
  receiptDerivedFeeWei: string | null;
  independentlyObservedBalanceDebitWei: null;
  balanceDebitStatus: 'not-observed';
  feePolicy: 'unresolved';
}

export function feeEvidence(plan: BroadcastPlan, tx: PlannedTransaction, receipt?: ActualReceipt): FeeEvidence {
  return {
    estimatedGas: tx.estimatedGas, approvedGasLimit: tx.gasLimit, approvedGasPriceWei: plan.gasPriceWei,
    gasLimitBudgetWei: (BigInt(tx.gasLimit) * BigInt(plan.gasPriceWei)).toString(),
    receiptGasUsed: receipt?.gasUsed.toString() ?? null,
    receiptEffectiveGasPriceWei: receipt?.effectiveGasPrice.toString() ?? null,
    receiptDerivedFeeWei: receipt === undefined ? null : (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    independentlyObservedBalanceDebitWei: null, balanceDebitStatus: 'not-observed', feePolicy: 'unresolved',
  };
}
