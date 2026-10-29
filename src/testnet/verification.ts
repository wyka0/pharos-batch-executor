import { keccak256, type Hash } from 'viem';
import type { EvmPublicClient } from '../adapters/evm.js';
import { assertAuthorizedCaller } from '../caller.js';
import { ExecutionGateError } from '../errors.js';
import { ATLANTIC } from '../network.js';
import { resultsFromReceipt, verifyReceipt, verifyTransaction, type ReceiptLike } from '../receipt.js';
import type { ActionResult, ActualReceipt } from '../types.js';
import { validateActions } from '../validation.js';
import { decimal, type BroadcastPlan, type PlannedTransaction } from './broadcast-plan.js';

/** Shared by the broadcaster and read-only reconciliation. No signer/send. */
export async function verifyPlannedReceipt(
  plan: BroadcastPlan, tx: PlannedTransaction, hash: Hash, raw: ReceiptLike, client: EvmPublicClient,
): Promise<ActualReceipt> {
  if (await client.getChainId() !== ATLANTIC.chainId) throw new ExecutionGateError('Receipt RPC chain ID mismatch.');
  verifyTransaction(await client.getTransaction({ hash }), { hash, from: plan.sender,
    ...(tx.to === null ? {} : { to: tx.to }), data: tx.data, value: decimal(tx.valueWei), chainId: 688689, nonce: tx.nonce });
  if (raw.blockNumber === undefined) throw new ExecutionGateError('Missing receipt block.');
  const block = await client.getBlock({ blockNumber: raw.blockNumber });
  if (block.hash === null) throw new ExecutionGateError('Missing canonical block hash.');
  const receipt = verifyReceipt(raw, hash, { currentBlockNumber: await client.getBlockNumber(), canonicalBlockHash: block.hash,
    ...(block.parentHash === undefined ? {} : { canonicalBlockParentHash: block.parentHash }),
    ...(block.transactions === undefined ? {} : { canonicalBlockTransactionCount: block.transactions.length }),
    minimumConfirmations: 2n, explorerBaseUrl: ATLANTIC.explorerUrl });
  if (receipt.gasUsed > decimal(tx.gasLimit) || receipt.effectiveGasPrice !== decimal(plan.gasPriceWei)) {
    throw new ExecutionGateError('Receipt gas usage or legacy gas price violates the approved limits.');
  }
  return receipt;
}

export async function verifyPlannedEffects(
  plan: BroadcastPlan, tx: PlannedTransaction, raw: ReceiptLike, receipt: ActualReceipt, client: EvmPublicClient,
): Promise<{ deployedAddress?: `0x${string}`; actions?: ActionResult[]; refundCreditWei?: bigint }> {
  if (receipt.status !== 'success') throw new ExecutionGateError('Reverted transaction has no committed effects.');
  if (tx.kind === 'deployment') {
    if (raw.contractAddress?.toLowerCase() !== tx.expectedContractAddress?.toLowerCase()) throw new ExecutionGateError('Deployment receipt address mismatch.');
    const code = await client.getCode({ address: raw.contractAddress!, blockNumber: receipt.blockNumber });
    if (code === undefined || code === '0x' || keccak256(code) !== tx.expectedRuntimeCodeHash) throw new ExecutionGateError('Deployed runtime bytecode mismatch.');
    if (tx.artifactName === 'BatchExecutor') await assertAuthorizedCaller(client, raw.contractAddress!, plan.sender, receipt.blockNumber);
    return { deployedAddress: raw.contractAddress! };
  }
  if (tx.kind === 'batch') {
    const code = await client.getCode({ address: plan.batchExecutor!, blockNumber: receipt.blockNumber });
    if (code === undefined || code === '0x' || keccak256(code) !== plan.executorRuntimeCodeHash) throw new ExecutionGateError('Executor code at the receipt block does not verify.');
    await assertAuthorizedCaller(client, plan.batchExecutor!, plan.sender, receipt.blockNumber);
    if (raw.logs === undefined) throw new ExecutionGateError('Missing batch logs.');
    return resultsFromReceipt(validateActions(plan.actions), raw.logs, plan.batchExecutor!, plan.sender, {
      transactionHash: receipt.txHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber,
    });
  }
  const index = plan.transactions.findIndex((entry) => entry.id === tx.id);
  return { actions: planActions(plan, index).map((a) => ({ ...a, success: true, status: 'succeeded', transactionHash: receipt.txHash })) };
}

export function planActions(plan: BroadcastPlan, index: number): ActionResult[] {
  if (plan.purpose === 'deploy') return [];
  const actions = validateActions(plan.actions);
  const selected = plan.purpose === 'baseline' ? [actions[index]!] : actions;
  return selected.map((a, i) => ({ index: plan.purpose === 'baseline' ? index : i, id: a.id, target: a.target,
    status: 'not_submitted', success: null, returnDataSource: 'unavailable' }));
}
