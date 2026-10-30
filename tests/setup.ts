import { afterEach, beforeEach, vi } from 'vitest';
import { clearFakeSignatures } from './mock-signatures.js';

vi.mock('viem/accounts', () => ({
  generatePrivateKey: () => { throw new Error('Real key generation is forbidden during offline tests.'); },
  privateKeyToAccount: () => { throw new Error('Real signing accounts are forbidden during offline tests.'); },
}));

// Unit tests are offline by construction. An accidental SDK/RPC HTTP call
// fails loudly; integration broadcasts exist only in the explicit local demo.
beforeEach(() => {
  vi.stubGlobal('fetch', () => { throw new Error('Network access forbidden during npm test.'); });
});
afterEach(() => { vi.unstubAllGlobals(); clearFakeSignatures(); });
