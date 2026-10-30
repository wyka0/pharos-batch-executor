import { describe, expect, it, vi } from 'vitest';
import {
  isTransientReadRpcError, READ_RPC_BACKOFF_MS, retryReadOnlyRpc, withReadOnlyRpcRetries,
} from '../src/testnet/read-retry.js';

function transientHttp(status: number) {
  return { name: 'HttpRequestError', status };
}

describe('bounded read-only RPC retries', () => {
  it('recovers from a timeout with bounded backoff', async () => {
    const sleep = vi.fn(async (_milliseconds: number) => {});
    const getBlockNumber = vi.fn()
      .mockRejectedValueOnce({ name: 'TimeoutError' })
      .mockResolvedValue(42n);
    const client = withReadOnlyRpcRetries({ getBlockNumber }, { sleep });
    await expect(client.getBlockNumber()).resolves.toBe(42n);
    expect(getBlockNumber).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(READ_RPC_BACKOFF_MS[0]);
  });

  it.each([429, 503])('recovers from HTTP %i', async (status) => {
    const method = vi.fn().mockRejectedValueOnce(transientHttp(status)).mockResolvedValue(1n);
    const client = withReadOnlyRpcRetries({ getBalance: method }, { sleep: async () => {} });
    await expect(client.getBalance()).resolves.toBe(1n);
    expect(method).toHaveBeenCalledTimes(2);
  });

  it('fails closed after the initial attempt and two retries', async () => {
    const error = transientHttp(502);
    const operation = vi.fn(async () => { throw error; });
    const sleep = vi.fn(async (_milliseconds: number) => {});
    await expect(retryReadOnlyRpc(operation, { sleep })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([...READ_RPC_BACKOFF_MS]);
  });

  it('does not retry deterministic contract reverts', async () => {
    const error = { name: 'CallExecutionError', cause: { name: 'ExecutionRevertedError', code: 3 } };
    const call = vi.fn(async () => { throw error; });
    const client = withReadOnlyRpcRetries({ call }, { sleep: async () => {} });
    await expect(client.call()).rejects.toBe(error);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('does not retry invalid JSON-RPC parameters', async () => {
    const error = { name: 'RpcRequestError', code: -32602 };
    const estimateGas = vi.fn(async () => { throw error; });
    const client = withReadOnlyRpcRetries({ estimateGas }, { sleep: async () => {} });
    await expect(client.estimateGas()).rejects.toBe(error);
    expect(estimateGas).toHaveBeenCalledTimes(1);
  });

  it('never wraps or retries sendRawTransaction', async () => {
    const error = { name: 'HttpRequestError', status: 503 };
    const sendRawTransaction = vi.fn(async () => { throw error; });
    const client = withReadOnlyRpcRetries({ sendRawTransaction }, { sleep: async () => {} });
    await expect(client.sendRawTransaction()).rejects.toBe(error);
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });

  it('classifies only allowlisted status, timeout and network metadata', () => {
    expect(isTransientReadRpcError({ name: 'HttpRequestError', status: 504 })).toBe(true);
    expect(isTransientReadRpcError({ name: 'HttpRequestError' })).toBe(true);
    expect(isTransientReadRpcError({ name: 'Error', cause: { code: 'ECONNRESET' } })).toBe(true);
    expect(isTransientReadRpcError({ name: 'HttpRequestError', status: 500 })).toBe(false);
    expect(isTransientReadRpcError({ name: 'RpcRequestError', code: -32000 })).toBe(false);
  });
});
