import { afterEach, beforeEach, vi } from 'vitest';

// Unit tests are offline by construction. An accidental SDK/RPC HTTP call
// fails loudly; integration broadcasts exist only in the explicit local demo.
beforeEach(() => {
  vi.stubGlobal('fetch', () => { throw new Error('Network access forbidden during npm test.'); });
});
afterEach(() => { vi.unstubAllGlobals(); });
