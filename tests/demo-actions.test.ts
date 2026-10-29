import { readFile } from 'node:fs/promises';
import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import { BATCH_EXECUTOR_ABI, TEST_ONLY_COUNTER_ABI } from '../src/abi.js';
import { DEMO_SCENARIOS, makeDemoActions } from '../src/demo-actions.js';
import { ATLANTIC } from '../src/network.js';
import { validateActions } from '../src/validation.js';
import { TARGET_A } from './fixtures.js';

describe('test-only action generation and network asset', () => {
  it.each(DEMO_SCENARIOS)('prepares valid %s actions without any network/signing', (scenario) => {
    const actions = validateActions(makeDemoActions(TARGET_A, scenario, 3, 'test'));
    expect(actions).toHaveLength(3);
    expect(actions.every((a) => a.independent)).toBe(true);
    expect(actions[0]?.id).toBe('test-0');
  });

  it('writes distinct keys and fails only the intended middle call', () => {
    const actions = validateActions(makeDemoActions(TARGET_A, 'mixed', 3, 'test'));
    expect(decodeFunctionData({ abi: TEST_ONLY_COUNTER_ABI, data: actions[0]!.calldata }).functionName).toBe('setValue');
    expect(decodeFunctionData({ abi: TEST_ONLY_COUNTER_ABI, data: actions[1]!.calldata }).functionName).toBe('fail');
    expect(decodeFunctionData({ abi: TEST_ONLY_COUNTER_ABI, data: actions[2]!.calldata }).functionName).toBe('setValue');
    expect(actions[0]?.calldata).not.toBe(actions[2]?.calldata);
  });

  it('rejects fewer than three, excessive count and unsafe prefixes', () => {
    expect(() => makeDemoActions(TARGET_A, 'success', 2, 'test')).toThrow(/3..32/);
    expect(() => makeDemoActions(TARGET_A, 'success', 33, 'test')).toThrow(/3..32/);
    expect(() => makeDemoActions(TARGET_A, 'success', 3, '../escape')).toThrow(/id/);
  });

  it('keeps packaged network metadata exactly Atlantic-only', async () => {
    const asset = JSON.parse(await readFile(new URL('../assets/networks.json', import.meta.url), 'utf8')) as {
      defaultNetwork: string; networks: Array<{ chainId: number; rpcUrl: string; explorerUrl: string; nativeToken: string }>;
    };
    expect(asset.defaultNetwork).toBe('atlantic-testnet');
    expect(asset.networks).toHaveLength(1);
    expect(asset.networks[0]).toMatchObject({ chainId: ATLANTIC.chainId, rpcUrl: ATLANTIC.rpcUrl, explorerUrl: ATLANTIC.explorerUrl, nativeToken: 'PHRS' });
  });

  it('includes every compiled executor event and error in the runtime ABI', async () => {
    const artifact = JSON.parse(await readFile(new URL('../artifacts/BatchExecutor.json', import.meta.url), 'utf8')) as {
      abi: Array<{ type: string; name?: string }>;
    };
    const exposed = BATCH_EXECUTOR_ABI.map((entry) => `${entry.type}:${entry.name}`);
    for (const entry of artifact.abi.filter((item) => item.type === 'event' || item.type === 'error')) {
      expect(exposed).toContain(`${entry.type}:${entry.name}`);
    }
  });
});
