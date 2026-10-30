/** Synthetic local signer-file validation only. No real keys, signatures, runner or RPC. */
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Hex } from '../src/types.js';
import { loadLocalSigner, type LocalSignerDependencies } from '../src/testnet/signer.js';
import { ACCOUNT } from './fixtures.js';
import { testTempDirectory } from './temp.js';

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

function dependencies(address: Hex = ACCOUNT): LocalSignerDependencies & { accountFromPrivateKey: ReturnType<typeof vi.fn> } {
  return {
    accountFromPrivateKey: vi.fn((_key: Hex) => ({
      address,
      signTransaction: vi.fn(async () => '0x01' as Hex),
    })),
  };
}

describe('explicit local signer sources', () => {
  it('accepts an explicitly selected absolute .env.local without discovery or signing', async () => {
    const dir = await testTempDirectory(); directories.push(dir);
    const file = path.join(dir, '.env.local');
    const syntheticKey = `0x${'12'.repeat(32)}`;
    await writeFile(file, `UNRELATED_PUBLIC_FIXTURE=value\nPRIVATE_KEY=${syntheticKey}\nRPC_URL=https://atlantic.dplabs-internal.com\n`, { flag: 'wx' });
    const deps = dependencies();

    const signer = await loadLocalSigner(file, ACCOUNT, deps);

    expect(signer.address).toBe(ACCOUNT);
    expect(deps.accountFromPrivateKey).toHaveBeenCalledWith(syntheticKey);
    expect(deps.accountFromPrivateKey.mock.results[0]?.value.signTransaction).not.toHaveBeenCalled();
  });

  it('never auto-discovers or accepts a relative .env.local path', async () => {
    const deps = dependencies();
    await expect(loadLocalSigner('.env.local', ACCOUNT, deps)).rejects.toThrow(/absolute signer configuration path/);
    expect(deps.accountFromPrivateKey).not.toHaveBeenCalled();
  });

  it('rejects a derived address that differs from the approved sender', async () => {
    const dir = await testTempDirectory(); directories.push(dir);
    const file = path.join(dir, 'signer.env');
    await writeFile(file, `PRIVATE_KEY=0x${'34'.repeat(32)}\n`, { flag: 'wx' });
    await expect(loadLocalSigner(file, ACCOUNT, dependencies('0x1111111111111111111111111111111111111111')))
      .rejects.toThrow(/does not match/);
  });
});
