import { describe, expect, it, vi } from 'vitest';
import { assertAuthorizedCaller } from '../src/caller.js';
import { CALLER_GETTER_DATA, callerReply } from './caller-fixtures.js';
import { ACCOUNT, EXECUTOR, TARGET_B } from './fixtures.js';

describe('write-once caller getter — read only', () => {
  it('binds the submitting wallet using only the getter at the requested block', async () => {
    const client = { call: vi.fn(async () => callerReply()) };
    await assertAuthorizedCaller(client, EXECUTOR, ACCOUNT, 9n);
    expect(client.call).toHaveBeenCalledExactlyOnceWith({ account: ACCOUNT, to: EXECUTOR, data: CALLER_GETTER_DATA, value: 0n, blockNumber: 9n });
  });

  it.each([
    ['another wallet', callerReply(TARGET_B)], ['missing data', {}], ['missing getter', { data: '0x' as const }],
    ['malformed data', { data: '0x01' as const }], ['extra ABI words', { data: `${callerReply().data}${'00'.repeat(32)}` as `0x${string}` }],
  ])('fails closed for %s', async (_label, reply) => {
    const client = { call: vi.fn(async () => reply) };
    await expect(assertAuthorizedCaller(client, EXECUTOR, ACCOUNT)).rejects.toThrow(/authorized caller/);
    expect(client.call).toHaveBeenCalledExactlyOnceWith({ account: ACCOUNT, to: EXECUTOR, data: CALLER_GETTER_DATA, value: 0n });
  });

  it('sanitizes a failed getter without logging RPC exception contents or replaying execute', async () => {
    const client = { call: vi.fn(async () => { throw new Error('untrusted sensitive RPC contents'); }) };
    await expect(assertAuthorizedCaller(client, EXECUTOR, ACCOUNT)).rejects.toThrow('Executor authorized caller is missing or does not match the submitting wallet.');
    expect(client.call).toHaveBeenCalledTimes(1);
  });
});
