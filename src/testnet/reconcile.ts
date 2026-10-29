import { TransactionNotFoundError, TransactionReceiptNotFoundError, type Hash, type Log } from 'viem';
import { ExecutionGateError } from '../errors.js';
import { ATLANTIC } from '../network.js';
import { verifyTransaction, type ReceiptLike } from '../receipt.js';
import type { ActionResult, ActualReceipt, ExecutionComparison } from '../types.js';
import { broadcastPlanHash, validateHistoricalPlan, type BroadcastPlan } from './broadcast-plan.js';
import { planComparison } from './comparison.js';
import type { JournalEntry } from './journal.js';
import type { RunnerReadClient } from './runner.js';
import { planActions, verifyPlannedEffects, verifyPlannedReceipt } from './verification.js';

export interface ReconcileClient extends RunnerReadClient {
  getTransactionReceipt(args: { hash: Hash }): Promise<(ReceiptLike & { logs: readonly Log[] }) | null>;
}

export interface ReconciliationStep {
  index: number; id: string;
  state: 'CONFIRMED' | 'REVERTED' | 'UNVERIFIED' | 'PENDING' | 'UNKNOWN' | 'NOT_SUBMITTED';
  transactionHash?: Hash; receipt?: ActualReceipt; rawReceipt?: ReceiptLike;
  actions?: ActionResult[]; refundCreditWei?: bigint; deployedAddress?: `0x${string}`;
  error?: string;
}

export interface ReconciliationEvidence {
  schemaVersion: 1; classification: 'READ-ONLY ATLANTIC RECONCILIATION'; observedAt: string;
  planHash: string; plan: BroadcastPlan; latestNonce: number; pendingNonce: number;
  allTransactionsConfirmed: boolean; unresolvedHashes: boolean;
  steps: ReconciliationStep[]; comparison?: ExecutionComparison; disclosures: string[];
}

/** No signer, lock acquisition, send, replacement, retry or journal mutation. */
export async function reconcilePlan(
  plan: BroadcastPlan, entries: readonly JournalEntry[], client: ReconcileClient,
): Promise<ReconciliationEvidence> {
  validateHistoricalPlan(plan);
  const hash = broadcastPlanHash(plan);
  const hashes = journalHashes(plan, entries, hash);
  if (await client.getChainId() !== ATLANTIC.chainId) throw new ExecutionGateError('Reconciliation RPC chain ID mismatch.');
  const [latestNonce, pendingNonce] = await Promise.all([
    client.getTransactionCount({ address: plan.sender, blockTag: 'latest' }),
    client.getTransactionCount({ address: plan.sender, blockTag: 'pending' }),
  ]);
  const steps: ReconciliationStep[] = [];
  for (const [index, tx] of plan.transactions.entries()) {
    const transactionHash = hashes.get(index);
    const step: ReconciliationStep = { index, id: tx.id, state: 'NOT_SUBMITTED',
      ...(plan.purpose === 'deploy' ? {} : { actions: planActions(plan, index) }) };
    steps.push(step);
    if (transactionHash === undefined) {
      step.error = 'No intent recorded in this local journal. No submission is attributed to this plan; other state directories or senders are not covered.';
      continue;
    }
    step.transactionHash = transactionHash;
    let raw: (ReceiptLike & { logs: readonly Log[] }) | null;
    try { raw = await client.getTransactionReceipt({ hash: transactionHash }); }
    catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) raw = null;
      else {
        step.state = 'UNKNOWN'; step.error = 'Receipt RPC failed. Acceptance and outcome remain unknown; do not resend.';
        markUnknown(step);
        continue;
      }
    }
    if (raw !== null) {
      step.rawReceipt = raw;
      try {
        step.receipt = await verifyPlannedReceipt(plan, tx, transactionHash, raw, client);
        if (step.receipt.status === 'reverted') {
          step.state = 'REVERTED'; step.error = 'Outer transaction reverted. No action effects committed; intermediate calls cannot be inferred from this receipt.';
          markUnknown(step, 'not_committed');
        } else {
          Object.assign(step, await verifyPlannedEffects(plan, tx, raw, step.receipt, client));
          step.state = 'CONFIRMED';
        }
      } catch {
        step.state = 'UNVERIFIED'; step.error = 'Receipt exists but chain, transaction, confirmations, canonical block, code, or action evidence did not verify.';
        markUnknown(step);
      }
      continue;
    }
    try {
      const observed = await client.getTransaction({ hash: transactionHash });
      verifyTransaction(observed, { hash: transactionHash, from: plan.sender,
        ...(tx.to === null ? {} : { to: tx.to }), data: tx.data, value: BigInt(tx.valueWei), chainId: 688689, nonce: tx.nonce });
      step.state = 'PENDING';
      step.error = 'Matching transaction is visible but no verified receipt is available. Pending/mining outcome unresolved; do not resend.';
    } catch (error) {
      step.state = 'UNKNOWN';
      step.error = error instanceof TransactionNotFoundError && latestNonce > tx.nonce
        ? 'This nonce is consumed, but the approved hash is not located. A replacement or RPC inconsistency is possible; no outcome or retry safety is assumed.'
        : 'Approved hash was not located or did not verify. Absence is not proof of non-broadcast; do not resend.';
    }
    markUnknown(step);
  }
  return {
    schemaVersion: 1, classification: 'READ-ONLY ATLANTIC RECONCILIATION', observedAt: new Date().toISOString(),
    planHash: hash, plan, latestNonce, pendingNonce, steps,
    allTransactionsConfirmed: steps.every((step) => step.state === 'CONFIRMED'),
    unresolvedHashes: steps.some((step) => ['UNKNOWN', 'UNVERIFIED', 'PENDING'].includes(step.state)),
    ...(planComparison(plan) === undefined ? {} : { comparison: planComparison(plan, plan.purpose === 'batch' ? steps[0] : undefined) }),
    disclosures: [
      'READ ONLY: no signing key was loaded, no transaction was sent, no lock was removed, and the execution journal was not changed.',
      'Expired approval plans can be inspected, but expiration is never bypassed for execution.',
      'INTENT hashes are offline-computed. A missing RPC result is not proof that the transaction was never accepted.',
      'Verification is an RPC-backed observation at this time, not an independent cryptographic light-client proof.',
      'A batch transaction can be confirmed with failed subcalls. Action results are taken from receipt-bound executor events, never replayed eth_call results.',
    ],
  };
}

function journalHashes(plan: BroadcastPlan, entries: readonly JournalEntry[], hash: string): Map<number, Hash> {
  const result = new Map<number, Hash>();
  for (const entry of entries) {
    const tx = plan.transactions[entry.index];
    if (entry.planHash !== hash || tx === undefined || entry.id !== tx.id || entry.nonce !== tx.nonce || !/^0x[0-9a-fA-F]{64}$/.test(entry.transactionHash)) {
      throw new ExecutionGateError('Journal entry does not match this approved transaction plan.');
    }
    const previous = result.get(entry.index);
    if ((previous === undefined && entry.state !== 'INTENT') || (previous !== undefined && (entry.state === 'INTENT' || previous !== entry.transactionHash))) {
      throw new ExecutionGateError('Journal intent/hash sequence is inconsistent; manual investigation required.');
    }
    result.set(entry.index, entry.transactionHash);
  }
  return result;
}

function markUnknown(step: ReconciliationStep, status: ActionResult['status'] = 'unknown'): void {
  if (step.actions) step.actions = step.actions.map((a) => ({ ...a, status, success: null, returnDataSource: 'unavailable',
    transactionHash: step.transactionHash, error: step.error ?? 'Outcome unverified.' }));
}
