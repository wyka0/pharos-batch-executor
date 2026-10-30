const RETRYABLE_HTTP_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENETDOWN', 'ENETUNREACH',
  'EHOSTUNREACH', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
]);

/** Explicit method allowlist. Transaction/signing/submission methods are absent. */
export const RETRIED_READ_METHODS = new Set<PropertyKey>([
  'getChainId', 'getBlockNumber', 'getBlock', 'getBalance', 'getGasPrice',
  'getTransactionCount', 'getCode', 'call', 'estimateGas', 'readContract',
  'getTransaction', 'getTransactionReceipt',
]);

export const READ_RPC_MAX_RETRIES = 2;
export const READ_RPC_BACKOFF_MS = [100, 200] as const;

interface RetryDependencies {
  sleep?(milliseconds: number): Promise<void>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

/** Static metadata only; never inspect exception messages or response bodies. */
export function isTransientReadRpcError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<object>();
  for (let depth = 0; depth < 12; depth++) {
    const item = record(current);
    if (item === undefined || seen.has(item)) break;
    seen.add(item);
    const status = typeof item.status === 'number' ? item.status : typeof item.statusCode === 'number' ? item.statusCode : undefined;
    if (status !== undefined && RETRYABLE_HTTP_STATUS.has(status)) return true;
    if (item.name === 'TimeoutError' || item.name === 'SocketClosedError') return true;
    if (typeof item.code === 'string' && RETRYABLE_NETWORK_CODES.has(item.code)) return true;
    // A status-less viem HTTP request error represents transport/fetch failure.
    if (item.name === 'HttpRequestError' && status === undefined) return true;
    current = item.cause;
  }
  return false;
}

export async function retryReadOnlyRpc<T>(operation: () => Promise<T>, dependencies: RetryDependencies = {}): Promise<T> {
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= READ_RPC_MAX_RETRIES || !isTransientReadRpcError(error)) throw error;
      await sleep(READ_RPC_BACKOFF_MS[attempt]!);
    }
  }
}

export function withReadOnlyRpcRetries<T extends object>(client: T, dependencies: RetryDependencies = {}): T {
  const cached = new Map<PropertyKey, unknown>();
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const existing = cached.get(property);
      if (existing !== undefined) return existing;
      const method = value as (...args: unknown[]) => unknown;
      const wrapped = RETRIED_READ_METHODS.has(property)
        ? (...args: unknown[]) => retryReadOnlyRpc(async () => await Reflect.apply(method, target, args), dependencies)
        : (...args: unknown[]) => Reflect.apply(method, target, args);
      cached.set(property, wrapped);
      return wrapped;
    },
  });
}
