import { describe, expect, it } from 'vitest';
import { ATLANTIC } from '../src/network.js';
import { broadcastPlanHash, MAX_TOTAL_COST_WEI, verifyApproval, type BroadcastPlan } from '../src/testnet/broadcast-plan.js';
import { ACCOUNT } from './fixtures.js';
import { deployPlan } from './broadcast-fixtures.js';

describe('broadcast approval gates (no wallet or RPC)', () => {
  it('accepts an exact testnet plan hash and confirmation', () => {
    const plan = deployPlan();
    expect(() => verifyApproval(plan, broadcastPlanHash(plan), true)).not.toThrow();
  });

  it('requires BOTH exact hash approval and explicit testnet confirmation', () => {
    const plan = deployPlan();
    expect(() => verifyApproval(plan, broadcastPlanHash(plan), false)).toThrow(/confirm-atlantic-testnet/);
    expect(() => verifyApproval(plan, 'wrong', true)).toThrow(/plan-hash/);
  });

  it('binds every nonce, calldata, sender, gas and value field to approval', () => {
    const plan = deployPlan();
    const hash = broadcastPlanHash(plan);
    const changed = structuredClone(plan);
    changed.transactions[0]!.data = '0x6001';
    expect(() => verifyApproval(changed, hash, true)).toThrow(/plan-hash/);
  });

  it('rejects mainnet/alternate RPC even if the altered hash is approved', () => {
    const plan = deployPlan();
    const changed = { ...plan, network: { ...ATLANTIC, chainId: 1672 } } as unknown as BroadcastPlan;
    expect(() => verifyApproval(changed, broadcastPlanHash(changed), true)).toThrow(/Atlantic/);
  });

  it('rejects expired/future/overlong approval windows', () => {
    const plan = deployPlan();
    plan.expiresAt = new Date(Date.now() - 1).toISOString();
    expect(() => verifyApproval(plan, broadcastPlanHash(plan), true)).toThrow(/expired/);
  });

  it('rejects inconsistent cost, gas ceilings and nonce gaps', () => {
    const plan = deployPlan();
    plan.maximumCostWei = (MAX_TOTAL_COST_WEI + 1n).toString();
    expect(() => verifyApproval(plan, broadcastPlanHash(plan), true)).toThrow(/cost/);
    const gasPlan = deployPlan();
    gasPlan.transactions[0]!.gasLimit = '5000001';
    expect(() => verifyApproval(gasPlan, broadcastPlanHash(gasPlan), true)).toThrow(/gas bound/);
    const noncePlan = deployPlan();
    noncePlan.transactions[1]!.nonce = 9;
    expect(() => verifyApproval(noncePlan, broadcastPlanHash(noncePlan), true)).toThrow(/consecutive/);
  });

  it('rejects predicted address changes and unknown secret-like fields', () => {
    const plan = deployPlan();
    plan.transactions[0]!.expectedContractAddress = ACCOUNT;
    expect(() => verifyApproval(plan, broadcastPlanHash(plan), true)).toThrow(/deployment address/);
    const unsafe = { ...deployPlan(), privateKey: 'never-accepted' } as BroadcastPlan;
    expect(() => verifyApproval(unsafe, broadcastPlanHash(unsafe), true)).toThrow(/unsafe/);
  });
});
