import { describe, expect, it } from 'vitest';
import { ATLANTIC } from '../src/network.js';
import {
  broadcastPlanHash, MAX_TOTAL_COST_WEI, transactionPayloadHash, validateHistoricalPlan, verifyApproval,
  type BroadcastPlan,
} from '../src/testnet/broadcast-plan.js';
import { ACCOUNT } from './fixtures.js';
import { batchPlan, deployPlan, fixtureBinding, legacyDeployPlan } from './broadcast-fixtures.js';

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

  it('binds calldata, sender, nonce, gas and value to the approval hash', () => {
    const plan = deployPlan();
    const hash = broadcastPlanHash(plan);
    const changed = structuredClone(plan);
    changed.transactions[0]!.data = '0x6001';
    expect(() => verifyApproval(changed, hash, true)).toThrow(/plan-hash/);
    const sender = structuredClone(plan);
    sender.sender = '0x1111111111111111111111111111111111111111';
    expect(() => verifyApproval(sender, hash, true)).toThrow(/plan-hash/);
    const nonce = structuredClone(plan);
    nonce.transactions[0]!.nonce = 9;
    // With the payload hash restamped for the new nonce, validation reaches the CREATE-address gate.
    nonce.transactions[0]!.payloadHash = transactionPayloadHash(nonce, nonce.transactions[0]!);
    expect(() => verifyApproval(nonce, broadcastPlanHash(nonce), true)).toThrow(/Predicted deployment address mismatch/);
    const gas = structuredClone(plan);
    gas.transactions[0]!.gasLimit = '110000';
    expect(() => verifyApproval(gas, hash, true)).toThrow(/plan-hash/);
    const value = structuredClone(plan);
    value.transactions[0]!.valueWei = '1';
    expect(() => verifyApproval(value, hash, true)).toThrow(/plan-hash/);
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
    const future = deployPlan();
    future.createdAt = new Date(Date.now() + 10_000).toISOString();
    expect(() => verifyApproval(future, broadcastPlanHash(future), true)).toThrow(/expired|invalid timestamps/);
  });

  it('rejects inconsistent cost, gas ceilings and a stale predicted address', () => {
    const plan = deployPlan();
    plan.maximumCostWei = (MAX_TOTAL_COST_WEI + 1n).toString();
    expect(() => verifyApproval(plan, broadcastPlanHash(plan), true)).toThrow(/cost/);
    const gasPlan = deployPlan();
    gasPlan.transactions[0]!.gasLimit = '5000001';
    expect(() => verifyApproval(gasPlan, broadcastPlanHash(gasPlan), true)).toThrow(/gas bound/);
    const addressPlan = deployPlan();
    addressPlan.transactions[0]!.expectedContractAddress = ACCOUNT;
    expect(() => verifyApproval(addressPlan, broadcastPlanHash(addressPlan), true)).toThrow(/deployment address mismatch/);
  });

  it('rejects predicted address changes and unknown secret-like fields', () => {
    const plan = deployPlan();
    const unsafe = { ...plan, privateKey: 'never-accepted' } as BroadcastPlan;
    expect(() => verifyApproval(unsafe, broadcastPlanHash(unsafe), true)).toThrow(/unsafe/);
  });
});

describe('version-2 execution-plan approval bindings', () => {
  it('accepts v1 only for historical reconciliation, never execution', () => {
    const legacy = legacyDeployPlan();
    expect(() => verifyApproval(legacy, broadcastPlanHash(legacy), true)).toThrow(/v2 independently approved plan/);
    expect(() => validateHistoricalPlan(legacy)).not.toThrow();
    const withStage = structuredClone(legacy);
    withStage.schemaVersion = 1;
    (withStage as { deploymentStage?: string }).deploymentStage = 'executor';
    expect(() => validateHistoricalPlan(withStage)).toThrow(/Invalid historical deployment fields/);
  });

  it('requires the complete legacy payload hash when the plan hash is restamped', () => {
    const plan = deployPlan();
    const changed = structuredClone(plan);
    changed.transactions[0]!.data = `${changed.transactions[0]!.data.slice(0, -2)}01` as `0x${string}`;
    expect(() => verifyApproval(changed, broadcastPlanHash(changed), true)).toThrow(/payload hash/);
    const missing = structuredClone(plan);
    delete missing.transactions[0]!.payloadHash;
    expect(() => verifyApproval(missing, broadcastPlanHash(missing), true)).toThrow(/payload hash/);
    const hostileType = structuredClone(plan);
    hostileType.transactions[0]!.type = 'eip1559' as never;
    expect(() => verifyApproval(hostileType, broadcastPlanHash(hostileType), true)).toThrow(/payload hash/);
    const hostilePayload = structuredClone(plan);
    hostilePayload.transactions[0]!.payloadHash = fixtureBinding().recordHash;
    expect(() => verifyApproval(hostilePayload, broadcastPlanHash(hostilePayload), true)).toThrow(/payload hash/);
  });

  it('requires exactly ONE explicitly selected deployment stage with correctly shaped prerequisites', () => {
    const counter = deployPlan(ACCOUNT, 'counter', 1);
    expect(() => verifyApproval(counter, broadcastPlanHash(counter), true)).not.toThrow();
    delete (counter as { deploymentPrerequisites?: unknown }).deploymentPrerequisites;
    expect(() => verifyApproval(counter, broadcastPlanHash(counter), true)).toThrow(/prerequisites/);

    const stageOneWithInheritance = deployPlan();
    stageOneWithInheritance.deploymentPrerequisites = { executor: fixtureBinding() };
    expect(() => verifyApproval(stageOneWithInheritance, broadcastPlanHash(stageOneWithInheritance), true))
      .toThrow(/Stage 1 cannot inherit/);

    const wrongStage = deployPlan(ACCOUNT, 'counter', 1);
    wrongStage.deploymentPrerequisites = { counter: fixtureBinding() };
    expect(() => verifyApproval(wrongStage, broadcastPlanHash(wrongStage), true)).toThrow(/prerequisites/);

    const malformedBinding = deployPlan(ACCOUNT, 'counter', 1);
    malformedBinding.deploymentPrerequisites!.executor!.blockNumber = '0';
    expect(() => verifyApproval(malformedBinding, broadcastPlanHash(malformedBinding), true)).toThrow(/record binding/);
  });

  it('execution approvals must bind both deployment stages and the executor to the verified records', () => {
    const batch = batchPlan();
    expect(() => verifyApproval(batch, broadcastPlanHash(batch), true)).not.toThrow();
    delete batch.deploymentPrerequisites!.counter;
    expect(() => verifyApproval(batch, broadcastPlanHash(batch), true)).toThrow(/prerequisites/);
    const driftedExecutor = batchPlan();
    driftedExecutor.batchExecutor = '0x7777777777777777777777777777777777777777';
    expect(() => verifyApproval(driftedExecutor, broadcastPlanHash(driftedExecutor), true))
      .toThrow(/differs from the verified deployment binding/);
    const stageOnBatch = batchPlan();
    stageOnBatch.deploymentStage = 'counter';
    expect(() => verifyApproval(stageOnBatch, broadcastPlanHash(stageOnBatch), true))
      .toThrow(/cannot deploy a stage/);
  });

  it('transactionPayloadHash deterministically binds every public unsigned field', () => {
    const plan = deployPlan();
    const tx = plan.transactions[0]!;
    expect(tx.type).toBe('legacy');
    expect(transactionPayloadHash(plan, tx)).toBe(tx.payloadHash);
    const { expectedContractAddress, ...withoutAddress } = tx;
    const { to, ...withoutToRest } = tx;
    void expectedContractAddress;
    void to;
    // A spread that drops `to` simulates a signer-parsed CREATE transaction (`to: undefined`).
    const withoutTo = { ...withoutToRest, to: undefined } as unknown as typeof tx;
    expect(transactionPayloadHash(plan, { ...tx, nonce: tx.nonce + 1 })).not.toBe(tx.payloadHash);
    expect(transactionPayloadHash(plan, { ...tx, gasLimit: '110000' })).not.toBe(tx.payloadHash);
    // An omitted `to` binds identically to the explicit CREATE destination (`to: null`).
    expect(transactionPayloadHash(plan, withoutTo)).toBe(tx.payloadHash);
    // expectedContractAddress is approval-level data, not a payload field: it does not change the payload hash.
    expect(transactionPayloadHash(plan, withoutAddress)).toBe(tx.payloadHash);
    expect(transactionPayloadHash(plan, { ...tx, valueWei: '1' })).not.toBe(tx.payloadHash);
    expect(transactionPayloadHash(plan, { ...tx, data: '0x6001' })).not.toBe(tx.payloadHash);
    expect(transactionPayloadHash({ ...plan, gasPriceWei: '11000000000' }, tx)).not.toBe(tx.payloadHash);
    expect(transactionPayloadHash({ ...plan, sender: '0x1111111111111111111111111111111111111111' }, tx))
      .not.toBe(tx.payloadHash);
    const alternateNetwork = { ...plan, network: { ...ATLANTIC, chainId: 1672 } } as unknown as BroadcastPlan;
    expect(transactionPayloadHash(alternateNetwork, tx as never)).not.toBe(tx.payloadHash);
  });
});
