import { decodeFunctionResult, encodeFunctionData, getAddress, type Address } from 'viem';
import { BATCH_EXECUTOR_ABI } from './abi.js';
import type { EvmPublicClient } from './adapters/evm.js';
import { ExecutionGateError } from './errors.js';

/** Read the write-once caller; never replay execute or infer action outcomes. */
export async function assertAuthorizedCaller(
  client: Pick<EvmPublicClient, 'call'>, executor: Address, sender: Address, blockNumber?: bigint,
): Promise<void> {
  try {
    const reply = await client.call({ account: sender, to: executor,
      data: encodeFunctionData({ abi: BATCH_EXECUTOR_ABI, functionName: 'authorizedCaller' }),
      value: 0n,
      ...(blockNumber === undefined ? {} : { blockNumber }) });
    if (reply.data === undefined || !/^0x[0-9a-fA-F]{64}$/.test(reply.data) || getAddress(decodeFunctionResult({ abi: BATCH_EXECUTOR_ABI,
      functionName: 'authorizedCaller', data: reply.data })) !== getAddress(sender)) throw new Error('caller mismatch');
  } catch {
    throw new ExecutionGateError('Executor authorized caller is missing or does not match the submitting wallet.');
  }
}
