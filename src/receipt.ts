import { decodeAbiParameters, decodeErrorResult, decodeEventLog, getAddress, type Hash, type Log } from 'viem';

import { BATCH_EXECUTOR_ABI } from './abi.js';
import { ReceiptVerificationError } from './errors.js';
import { MAX_RETURN_DATA_BYTES } from './limits.js';
import type { ActionResult, ActualReceipt, ValidatedAction } from './types.js';

export interface ReceiptLike {
  transactionHash?: Hash;
  status?: 'success' | 'reverted';
  gasUsed?: bigint;
  blockNumber?: bigint;
  blockHash?: Hash;
  effectiveGasPrice?: bigint;
  logs?: readonly Log[];
  contractAddress?: `0x${string}` | null;
}

export interface ReceiptChecks {
  currentBlockNumber: bigint;
  canonicalBlockHash: Hash;
  canonicalBlockParentHash?: Hash;
  canonicalBlockTransactionCount?: number;
  minimumConfirmations?: bigint;
  explorerBaseUrl?: string;
}

export function verifyReceipt(receipt: ReceiptLike, expectedHash: Hash, checks: ReceiptChecks): ActualReceipt {
  const fail = (message: string): never => { throw new ReceiptVerificationError(message, expectedHash); };
  if (!/^0x[0-9a-fA-F]{64}$/.test(expectedHash)) fail('invalid transaction hash');
  if (receipt.transactionHash?.toLowerCase() !== expectedHash.toLowerCase()) fail('receipt transaction hash mismatch');
  if (receipt.status !== 'success' && receipt.status !== 'reverted') fail('receipt has missing or unknown status');
  if (typeof receipt.gasUsed !== 'bigint' || receipt.gasUsed <= 0n) fail('receipt has missing or invalid gasUsed');
  if (typeof receipt.blockNumber !== 'bigint' || receipt.blockNumber <= 0n) fail('receipt has missing or invalid blockNumber');
  if (!/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash ?? '') || !/^0x[0-9a-fA-F]{64}$/.test(checks.canonicalBlockHash)) fail('receipt has invalid block hash');
  if (receipt.blockHash?.toLowerCase() !== checks.canonicalBlockHash.toLowerCase()) fail('receipt block is not canonical');
  if (checks.canonicalBlockParentHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(checks.canonicalBlockParentHash)) fail('invalid canonical parent block hash');
  if (checks.canonicalBlockTransactionCount !== undefined &&
    (!Number.isSafeInteger(checks.canonicalBlockTransactionCount) || checks.canonicalBlockTransactionCount < 1)) fail('invalid canonical block transaction count');
  if (typeof receipt.effectiveGasPrice !== 'bigint' || receipt.effectiveGasPrice < 0n) fail('receipt has missing or invalid effectiveGasPrice');
  if (typeof checks.currentBlockNumber !== 'bigint' || (checks.minimumConfirmations ?? 1n) < 1n) fail('invalid confirmation checks');
  const confirmations = checks.currentBlockNumber - receipt.blockNumber! + 1n;
  if (confirmations < (checks.minimumConfirmations ?? 1n)) fail('receipt has insufficient confirmations');
  return {
    evidence: 'actual', txHash: expectedHash, status: receipt.status!, gasUsed: receipt.gasUsed!,
    blockNumber: receipt.blockNumber!, blockHash: receipt.blockHash!, effectiveGasPrice: receipt.effectiveGasPrice!,
    feeWei: receipt.gasUsed! * receipt.effectiveGasPrice!, confirmations,
    ...(checks.canonicalBlockParentHash === undefined ? {} : { parentBlockHash: checks.canonicalBlockParentHash }),
    ...(checks.canonicalBlockTransactionCount === undefined ? {} : { blockTransactionCount: checks.canonicalBlockTransactionCount }),
    ...(checks.explorerBaseUrl === undefined ? {} : { explorerUrl: `${checks.explorerBaseUrl.replace(/\/$/, '')}/tx/${expectedHash}` }),
  };
}

export interface TransactionLike {
  hash: Hash;
  from: `0x${string}`;
  to: `0x${string}` | null;
  input: `0x${string}`;
  value: bigint;
  chainId?: number;
  nonce: number;
  blockNumber?: bigint | null;
  blockHash?: Hash | null;
  transactionIndex?: number | null;
}

export function verifyTransaction(
  tx: TransactionLike,
  expected: { hash: Hash; from: `0x${string}`; to?: `0x${string}`; data: `0x${string}`; value: bigint; chainId: number; nonce?: number },
): void {
  if (tx.hash.toLowerCase() !== expected.hash.toLowerCase() || getAddress(tx.from) !== getAddress(expected.from)) {
    throw new ReceiptVerificationError('transaction hash or sender mismatch', expected.hash);
  }
  if ((tx.to?.toLowerCase() ?? null) !== (expected.to?.toLowerCase() ?? null)) {
    throw new ReceiptVerificationError('transaction recipient mismatch', expected.hash);
  }
  if (tx.input.toLowerCase() !== expected.data.toLowerCase() || tx.value !== expected.value || tx.chainId !== expected.chainId) {
    throw new ReceiptVerificationError('transaction calldata, value, or chain ID mismatch', expected.hash);
  }
  if (expected.nonce !== undefined && tx.nonce !== expected.nonce) {
    throw new ReceiptVerificationError('transaction nonce mismatch', expected.hash);
  }
}

export function decodeRevertData(data: `0x${string}`): string | undefined {
  if (data === '0x') return undefined;
  if (data.startsWith('0x08c379a0')) {
    try { return decodeAbiParameters([{ type: 'string' }], `0x${data.slice(10)}`)[0]; }
    catch { return 'malformed Error(string)'; }
  }
  if (data.startsWith('0x4e487b71')) {
    try { return `Panic(${decodeAbiParameters([{ type: 'uint256' }], `0x${data.slice(10)}`)[0]})`; }
    catch { return 'malformed Panic(uint256)'; }
  }
  try {
    const decoded = decodeErrorResult({ abi: BATCH_EXECUTOR_ABI, data });
    return `${decoded.errorName}(${decoded.args?.map(String).join(', ') ?? ''})`;
  } catch { return `unrecognized revert data: ${data}`; }
}

export interface DecodedActionEvent {
  index: number;
  idBytes32: `0x${string}`;
  target: `0x${string}`;
  success: boolean;
  result: `0x${string}`;
  returnDataSize: bigint;
}

export function verifyActionEvents(actions: readonly ValidatedAction[], events: readonly DecodedActionEvent[]): ActionResult[] {
  const byIndex = new Map<number, DecodedActionEvent>();
  for (const event of events) {
    if (!Number.isSafeInteger(event.index) || event.index < 0 || event.index >= actions.length) {
      throw new ReceiptVerificationError('unexpected ActionExecuted index');
    }
    if (byIndex.has(event.index)) throw new ReceiptVerificationError(`duplicate ActionExecuted event for index ${event.index}`);
    if (event.index !== byIndex.size) throw new ReceiptVerificationError('ActionExecuted events are not in action order');
    if (typeof event.success !== 'boolean' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(event.result) || typeof event.returnDataSize !== 'bigint') {
      throw new ReceiptVerificationError('malformed action return-data evidence');
    }
    byIndex.set(event.index, event);
  }
  return actions.map((action, index) => {
    const event = byIndex.get(index);
    if (event === undefined) throw new ReceiptVerificationError(`missing ActionExecuted event for action ${index} ("${action.id}")`);
    if (event.idBytes32.toLowerCase() !== action.idBytes32.toLowerCase()) throw new ReceiptVerificationError(`ActionExecuted id mismatch at index ${index}`);
    if (getAddress(event.target) !== action.target) throw new ReceiptVerificationError(`ActionExecuted target mismatch at index ${index}`);
    const copied = BigInt((event.result.length - 2) / 2);
    const expectedCopied = event.returnDataSize < BigInt(MAX_RETURN_DATA_BYTES) ? event.returnDataSize : BigInt(MAX_RETURN_DATA_BYTES);
    if (copied !== expectedCopied || event.returnDataSize < 0n) throw new ReceiptVerificationError('invalid bounded return-data evidence');
    return {
      index, id: action.id, target: action.target, status: event.success ? 'succeeded' : 'failed', success: event.success,
      returnData: event.result, returnDataSource: 'event', returnDataSize: event.returnDataSize,
      returnDataTruncated: copied < event.returnDataSize,
      ...(event.success ? {} : { error: decodeRevertData(event.result) ?? 'call reverted or exhausted its gas limit without revert data' }),
    };
  });
}

/** Filter by emitter AND topic: an untrusted target cannot spoof executor evidence. */
export function resultsFromReceipt(
  actions: readonly ValidatedAction[], logs: readonly Log[], executor: `0x${string}`, sender: `0x${string}`,
  location?: { transactionHash: Hash; blockHash: Hash; blockNumber: bigint },
): { actions: ActionResult[]; refundCreditWei: bigint } {
  const events: DecodedActionEvent[] = [];
  let summary: { total: bigint; succeeded: bigint; failed: bigint } | undefined;
  let credited = 0n;
  let creditSeen = false;
  let previousLogIndex = -1;
  for (const log of logs) {
    if (log.address.toLowerCase() !== executor.toLowerCase()) continue;
    if (log.removed) throw new ReceiptVerificationError('receipt includes removed executor logs');
    if (location !== undefined && (log.transactionHash?.toLowerCase() !== location.transactionHash.toLowerCase() ||
      log.blockHash?.toLowerCase() !== location.blockHash.toLowerCase() || log.blockNumber !== location.blockNumber)) {
      throw new ReceiptVerificationError('executor log belongs to another transaction or block');
    }
    if (log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex <= previousLogIndex) {
      throw new ReceiptVerificationError('executor logs have invalid or unordered log indices');
    }
    previousLogIndex = log.logIndex;
    if (summary !== undefined) throw new ReceiptVerificationError('executor event after BatchExecuted summary');
    let decoded;
    try { decoded = decodeEventLog({ abi: BATCH_EXECUTOR_ABI, data: log.data, topics: log.topics, strict: true }); }
    catch { throw new ReceiptVerificationError('malformed or unknown executor event'); }
    if (decoded.eventName === 'ActionExecuted') {
      if (creditSeen) throw new ReceiptVerificationError('action event after refund credit');
      events.push({
        index: Number(decoded.args.index), idBytes32: decoded.args.id, target: decoded.args.target,
        success: decoded.args.success, result: decoded.args.result, returnDataSize: decoded.args.returnDataSize,
      });
    } else if (decoded.eventName === 'BatchExecuted') {
      if (summary !== undefined || getAddress(decoded.args.sender) !== getAddress(sender)) throw new ReceiptVerificationError('invalid batch summary sender/count');
      summary = decoded.args;
    } else if (decoded.eventName === 'RefundCredited') {
      if (creditSeen || decoded.args.amount <= 0n || getAddress(decoded.args.sender) !== getAddress(sender)) throw new ReceiptVerificationError('invalid or duplicate refund credit');
      creditSeen = true;
      credited += decoded.args.amount;
    } else {
      throw new ReceiptVerificationError('unexpected executor event in an execute receipt');
    }
  }
  const results = verifyActionEvents(actions, events);
  const failed = results.filter((r) => r.success === false).length;
  if (summary === undefined || summary.total !== BigInt(actions.length) || summary.failed !== BigInt(failed) || summary.succeeded !== BigInt(actions.length - failed)) {
    throw new ReceiptVerificationError('missing or inconsistent BatchExecuted summary');
  }
  const expectedCredit = actions.reduce((sum, a, i) => sum + (results[i]?.success === false ? a.value : 0n), 0n);
  if (credited !== expectedCredit) throw new ReceiptVerificationError('refund-credit evidence mismatch');
  return { actions: results, refundCreditWei: credited };
}
