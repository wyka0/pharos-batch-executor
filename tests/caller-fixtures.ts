/** SYNTHETIC getter replies only; never wallet/deployment evidence. */
import { encodeFunctionData, encodeFunctionResult, type Address } from 'viem';
import { BATCH_EXECUTOR_ABI } from '../src/abi.js';
import { ACCOUNT } from './fixtures.js';

export const CALLER_GETTER_DATA = encodeFunctionData({ abi: BATCH_EXECUTOR_ABI, functionName: 'authorizedCaller' });

export function callerReply(sender: Address = ACCOUNT) {
  return { data: encodeFunctionResult({ abi: BATCH_EXECUTOR_ABI, functionName: 'authorizedCaller', result: sender }) };
}
