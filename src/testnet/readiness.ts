import { createPublicClient, http, type Address, type Chain, type HttpTransport, type PublicClient } from 'viem';
import { ExecutionGateError } from '../errors.js';
import { ATLANTIC, ATLANTIC_CHAIN } from '../network.js';
import { withReadOnlyRpcRetries } from './read-retry.js';

/** Public-client only: no wallet, key, signing or submission capability. */
export function atlanticPublicClient(): PublicClient<HttpTransport, Chain> {
  const client = createPublicClient({ chain: ATLANTIC_CHAIN, cacheTime: 0,
    // Keep transport-level retries disabled. Only allowlisted read methods are
    // retried by the strict wrapper; sendRawTransaction remains single-attempt.
    transport: http(ATLANTIC.rpcUrl, { retryCount: 0, timeout: 20_000 }) });
  return withReadOnlyRpcRetries(client);
}

export async function getReadiness(address: Address) {
  const client = atlanticPublicClient();
  const chainId = await client.getChainId();
  if (chainId !== ATLANTIC.chainId) throw new ExecutionGateError('Readiness RPC chain ID mismatch.');
  const [balanceWei, gasPriceWei, blockNumber, pendingNonce, latestNonce] = await Promise.all([
    client.getBalance({ address }), client.getGasPrice(), client.getBlockNumber(),
    client.getTransactionCount({ address, blockTag: 'pending' }), client.getTransactionCount({ address, blockTag: 'latest' }),
  ]);
  return {
    classification: 'READ ONLY — no signing key loaded and no transaction broadcast.',
    observedAt: new Date().toISOString(), network: ATLANTIC, address, chainId, blockNumber,
    balanceWei, gasPriceWei, pendingNonce, latestNonce, noPendingTransactions: pendingNonce === latestNonce,
  };
}
