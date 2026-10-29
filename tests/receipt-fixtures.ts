/** SYNTHETIC unit fixtures, never live/production execution evidence. */
import { encodeAbiParameters, encodeEventTopics, type Address, type Hash, type Log } from 'viem';
import { BATCH_EXECUTOR_ABI } from '../src/abi.js';
import type { ReceiptLike } from '../src/receipt.js';
import type { ValidatedAction } from '../src/types.js';
import { ACCOUNT, EXECUTOR } from './fixtures.js';

export const HASH = `0x${'ab'.repeat(32)}` as Hash;
export const BLOCK_HASH = `0x${'cd'.repeat(32)}` as Hash;

export function rawReceipt(logs: Log[] = []): ReceiptLike & { logs: Log[] } {
  return { transactionHash: HASH, status: 'success', gasUsed: 120_000n, blockNumber: 9n,
    blockHash: BLOCK_HASH, effectiveGasPrice: 10_000_000_000n, logs };
}

export function actionLog(action: ValidatedAction, index: number, success = true, result: `0x${string}` = '0x'): Log {
  return {
    address: EXECUTOR,
    topics: encodeEventTopics({ abi: BATCH_EXECUTOR_ABI, eventName: 'ActionExecuted', args: { index: BigInt(index), id: action.idBytes32, target: action.target } }) as Log['topics'],
    data: encodeAbiParameters([{ type: 'bool' }, { type: 'bytes' }, { type: 'uint256' }], [success, result, BigInt((result.length - 2) / 2)]),
    blockHash: BLOCK_HASH, blockNumber: 9n, logIndex: index, transactionHash: HASH, transactionIndex: 0, removed: false,
  };
}

export function summaryLog(total: number, succeeded: number, sender: Address = ACCOUNT): Log {
  return {
    address: EXECUTOR,
    topics: encodeEventTopics({ abi: BATCH_EXECUTOR_ABI, eventName: 'BatchExecuted', args: { sender } }) as Log['topics'],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [BigInt(total), BigInt(succeeded), BigInt(total - succeeded)]),
    blockHash: BLOCK_HASH, blockNumber: 9n, logIndex: total, transactionHash: HASH, transactionIndex: 0, removed: false,
  };
}
