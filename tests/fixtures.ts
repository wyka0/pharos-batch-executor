import type { Address } from 'viem';
import type { BatchActionInput } from '../src/types.js';

export const TARGET_A: Address = '0x1111111111111111111111111111111111111111';
export const TARGET_B: Address = '0x2222222222222222222222222222222222222222';
export const TARGET_C: Address = '0x3333333333333333333333333333333333333333';
export const EXECUTOR: Address = '0x4444444444444444444444444444444444444444';
export const ACCOUNT: Address = '0x5555555555555555555555555555555555555555';

export function threeActions(): BatchActionInput[] {
  return [
    { id: 'one', target: TARGET_A, calldata: '0x12345678', independent: true },
    { id: 'two', target: TARGET_B, calldata: '0xabcdef01', independent: true },
    { id: 'three', target: TARGET_C, calldata: '0x01020304', independent: true },
  ];
}
