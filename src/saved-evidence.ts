import type { Address, Hash, Log } from 'viem';
import { verifyReceipt } from './receipt.js';
import { assertPublicData } from './safety.js';
import type { ActualReceipt } from './types.js';

/** JSON-serialized observations, not new network responses or light-client proof. */
export interface SavedReceipt {
  evidence: 'actual'; txHash: Hash; status: 'success' | 'reverted'; gasUsed: string;
  blockNumber: string; blockHash: Hash; effectiveGasPrice: string; feeWei: string; confirmations: string;
}

export interface SavedRawReceipt {
  transactionHash: Hash; status: 'success' | 'reverted'; gasUsed: string;
  blockNumber: string; blockHash: Hash; effectiveGasPrice: string;
  logs: Array<Omit<Log, 'blockNumber'> & { blockNumber: string }>;
  from?: Address; to?: Address | null; contractAddress?: Address | null;
}

function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error('Saved receipt quantity is not a decimal string.');
  return BigInt(value);
}

/** Checks the raw receipt against the saved normalized observation. No RPC. */
export function verifySavedReceipt(saved: SavedReceipt, raw: SavedRawReceipt): ActualReceipt {
  assertPublicData({ saved, raw });
  if (saved.evidence !== 'actual') throw new Error('Only saved actual receipts can be curated.');
  const verified = verifyReceipt({ transactionHash: raw.transactionHash, status: raw.status,
    gasUsed: decimal(raw.gasUsed), blockNumber: decimal(raw.blockNumber), blockHash: raw.blockHash,
    effectiveGasPrice: decimal(raw.effectiveGasPrice) }, saved.txHash, {
    // The canonical hash/confirmation count are SAVED claims, not fresh checks.
    currentBlockNumber: decimal(saved.blockNumber) + decimal(saved.confirmations) - 1n,
    canonicalBlockHash: saved.blockHash,
  });
  if (saved.status !== verified.status || decimal(saved.gasUsed) !== verified.gasUsed ||
    decimal(saved.blockNumber) !== verified.blockNumber || decimal(saved.effectiveGasPrice) !== verified.effectiveGasPrice ||
    decimal(saved.feeWei) !== verified.feeWei || decimal(saved.confirmations) !== verified.confirmations) {
    throw new Error('Saved normalized receipt does not match its raw receipt.');
  }
  savedReceiptLogs(raw);
  return verified;
}

/** Revives quantities and binds ALL saved logs to their receipt, in log order. */
export function savedReceiptLogs(raw: SavedRawReceipt): Log[] {
  if (!Array.isArray(raw.logs)) throw new Error('Saved raw receipt has no log array.');
  let previous = -1;
  return raw.logs.map((log) => {
    if (log.removed !== false || log.transactionHash?.toLowerCase() !== raw.transactionHash.toLowerCase() ||
      log.blockHash?.toLowerCase() !== raw.blockHash.toLowerCase() || decimal(log.blockNumber) !== decimal(raw.blockNumber) ||
      log.logIndex === null || !Number.isSafeInteger(log.logIndex) || log.logIndex <= previous) {
      throw new Error('Saved log is removed, unordered, or belongs to a different receipt.');
    }
    previous = log.logIndex;
    return { ...log, blockNumber: decimal(log.blockNumber) };
  });
}
