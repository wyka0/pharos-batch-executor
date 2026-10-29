import { defineChain, type Chain } from 'viem';
import { ExecutionGateError } from './errors.js';

export const ATLANTIC = {
  chainId: 688689, rpcUrl: 'https://atlantic.dplabs-internal.com',
  explorerUrl: 'https://atlantic.pharosscan.xyz/', nativeSymbol: 'PHRS',
} as const;
export const ATLANTIC_CHAIN: Chain = defineChain({
  id: ATLANTIC.chainId, name: 'Pharos Atlantic Testnet',
  nativeCurrency: { name: 'Test PHRS', symbol: 'PHRS', decimals: 18 },
  rpcUrls: { default: { http: [ATLANTIC.rpcUrl] } },
  blockExplorers: { default: { name: 'PharosScan Atlantic', url: ATLANTIC.explorerUrl } },
  testnet: true,
});

export function assertEndpoint(mode: 'local-anvil' | 'atlantic-testnet', rpcUrl: string): void {
  if (mode === 'atlantic-testnet') {
    if (rpcUrl !== ATLANTIC.rpcUrl) throw new ExecutionGateError('Only the official Atlantic Testnet RPC is allowed.');
    return;
  }
  let url: URL;
  try { url = new URL(rpcUrl); } catch { throw new ExecutionGateError('Invalid local RPC URL.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ExecutionGateError('Local Anvil requires a loopback HTTP RPC without credentials, query, or path.');
  }
}
