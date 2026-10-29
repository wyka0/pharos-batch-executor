import { createHash } from 'node:crypto';
import { getContractAddress } from 'viem';

import { ExecutionGateError } from '../errors.js';
import { MAX_RETURN_DATA_BYTES } from '../limits.js';
import { ATLANTIC } from '../network.js';
import { preparePlan } from '../plan.js';
import type { BatchActionInput, Hex } from '../types.js';
import { validateActions, validateAddress } from '../validation.js';

export const MAX_TOTAL_COST_WEI = 50_000_000_000_000_000n; // 0.05 TEST PHRS
export const MAX_TOTAL_VALUE_WEI = 1_000_000_000_000_000n; // 0.001 TEST PHRS
export const MAX_GAS_PRICE_WEI = 25_000_000_000n;
export const MAX_TRANSACTION_GAS = 5_000_000n;
export const PLAN_TTL_MS = 60 * 60 * 1000;

export interface PlannedTransaction {
  id: string;
  kind: 'deployment' | 'batch' | 'individual';
  nonce: number;
  to: Hex | null;
  data: Hex;
  valueWei: string;
  gasLimit: string;
  estimatedGas: string;
  expectedContractAddress?: Hex;
  artifactName?: 'BatchExecutor' | 'TestOnlyCounter';
  expectedRuntimeCodeHash?: Hex;
}

export interface BroadcastPlan {
  schemaVersion: 1;
  skill: 'pharos-batch-executor';
  purpose: 'deploy' | 'batch' | 'baseline';
  network: typeof ATLANTIC;
  sender: Hex;
  createdAt: string;
  expiresAt: string;
  planningBlockNumber: string;
  gasPriceWei: string;
  maximumCostWei: string;
  transactions: PlannedTransaction[];
  actions?: BatchActionInput[];
  batchExecutor?: Hex;
  executorRuntimeCodeHash?: Hex;
  targetCodeHashes?: Record<string, Hex>;
  expectedSimulation?: Array<{ id: string; success: boolean; returnData: Hex; returnDataSize: string }>;
  gasEstimates?: {
    blockNumber: string;
    individual: Array<{ id: string; gas: string | null; error?: string }>;
    batch: string;
  };
  disclosures: string[];
}

/** Stable key-order independent hash; binds every public approval field. */
export function broadcastPlanHash(plan: BroadcastPlan): string {
  return `sha256:${createHash('sha256').update(canonicalJson(plan)).digest('hex')}`;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new ExecutionGateError('Plan contains an unsupported value.');
  return serialized;
}

/** Pure safety gate: runs BEFORE RPC, journal acquisition or key loading. */
export function verifyApproval(plan: BroadcastPlan, approval: string, confirmed: boolean, now = Date.now()): void {
  const fail = (message: string): never => { throw new ExecutionGateError(message); };
  if (!confirmed) fail('--confirm-atlantic-testnet is required; nothing broadcast.');
  const fields = new Set(['schemaVersion', 'skill', 'purpose', 'network', 'sender', 'createdAt', 'expiresAt', 'planningBlockNumber', 'gasPriceWei', 'maximumCostWei', 'transactions', 'actions', 'batchExecutor', 'executorRuntimeCodeHash', 'targetCodeHashes', 'expectedSimulation', 'gasEstimates', 'disclosures']);
  if (plan === null || typeof plan !== 'object' || Object.keys(plan).some((field) => !fields.has(field))) fail('Unknown/unsafe broadcast-plan fields.');
  if (plan.schemaVersion !== 1 || plan.skill !== 'pharos-batch-executor') fail('Unsupported broadcast-plan schema.');
  if (canonicalJson(plan.network) !== canonicalJson(ATLANTIC)) fail('Only official Atlantic Testnet chain 688689 is allowed.');
  validateAddress(plan.sender, 'planned sender');
  if (decimal(plan.planningBlockNumber) <= 0n || !Array.isArray(plan.disclosures) || !plan.disclosures.every((s) => typeof s === 'string')) fail('Invalid plan provenance/disclosures.');
  if (approval !== broadcastPlanHash(plan)) fail('Exact plan-hash approval is missing or mismatched.');
  const created = Date.parse(plan.createdAt);
  const expires = Date.parse(plan.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || created > now || expires <= now || expires - created > PLAN_TTL_MS || expires <= created) {
    fail('Approval plan is expired or has invalid timestamps; regenerate and approve a fresh plan.');
  }
  const gasPrice = decimal(plan.gasPriceWei);
  if (gasPrice <= 0n || gasPrice > MAX_GAS_PRICE_WEI) fail('Plan gas price exceeds testnet ceiling.');
  if (!Array.isArray(plan.transactions) || plan.transactions.length === 0 || plan.transactions.length > 32) fail('Invalid planned transaction count.');
  let cost = 0n;
  let totalValue = 0n;
  const ids = new Set<string>();
  let previousNonce: number | undefined;
  for (const tx of plan.transactions) {
    const transactionFields = new Set(['id', 'kind', 'nonce', 'to', 'data', 'valueWei', 'gasLimit', 'estimatedGas', 'expectedContractAddress', 'artifactName', 'expectedRuntimeCodeHash']);
    if (tx === null || typeof tx !== 'object' || Object.keys(tx).some((field) => !transactionFields.has(field))) fail('Unknown/unsafe planned transaction fields.');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(tx.id) || ids.has(tx.id)) fail('Invalid or duplicate transaction identifier.');
    ids.add(tx.id);
    if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 0 || (previousNonce !== undefined && tx.nonce !== previousNonce + 1)) fail('Planned nonces must be consecutive safe integers.');
    previousNonce = tx.nonce;
    const gas = decimal(tx.gasLimit);
    const estimate = decimal(tx.estimatedGas);
    const value = decimal(tx.valueWei);
    if (gas <= 0n || gas > MAX_TRANSACTION_GAS || estimate <= 0n || estimate > gas) fail('Invalid transaction gas bound or estimate.');
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data) || tx.data.length > 1_000_000) fail('Malformed planned calldata.');
    totalValue += value;
    cost += gas * gasPrice + value;
  }
  if (totalValue > MAX_TOTAL_VALUE_WEI || cost > MAX_TOTAL_COST_WEI || decimal(plan.maximumCostWei) !== cost) fail('Plan exceeds testnet value/cost ceiling or has inconsistent cost.');

  if (plan.purpose === 'deploy') {
    if (plan.transactions.length !== 2) fail('Deployment plan must contain exactly two SETUP transactions, not a batch.');
    const names = ['BatchExecutor', 'TestOnlyCounter'] as const;
    for (const [i, tx] of plan.transactions.entries()) {
      if (tx.kind !== 'deployment' || tx.to !== null || tx.valueWei !== '0' || tx.artifactName !== names[i]) fail('Invalid deployment transaction.');
      if (!/^0x[0-9a-fA-F]{64}$/.test(tx.expectedRuntimeCodeHash ?? '')) fail('Missing deployment runtime binding.');
      const address = getContractAddress({ from: plan.sender, nonce: BigInt(tx.nonce) });
      if (address.toLowerCase() !== tx.expectedContractAddress?.toLowerCase()) fail('Predicted deployment address mismatch.');
    }
  } else if (plan.purpose === 'batch' || plan.purpose === 'baseline') {
    const actions = validateActions(plan.actions);
    const prepared = preparePlan(actions);
    validateAddress(plan.batchExecutor, 'executor');
    if (actions.some((a) => a.target.toLowerCase() === plan.batchExecutor!.toLowerCase())) fail('Executor cannot be an action target.');
    if (!/^0x[0-9a-fA-F]{64}$/.test(plan.executorRuntimeCodeHash ?? '')) fail('Missing approved executor runtime binding.');
    if (plan.purpose === 'batch') {
      const tx = plan.transactions[0]!;
      if (plan.transactions.length !== 1 || tx.kind !== 'batch' || tx.to?.toLowerCase() !== plan.batchExecutor?.toLowerCase() || tx.data !== prepared.batchCalldata || decimal(tx.valueWei) !== prepared.totalValue) fail('Batch approval must describe exactly ONE transaction matching every validated action.');
    } else {
      if (plan.transactions.length !== actions.length) fail('Baseline must contain one individual transaction per action.');
      for (const [i, tx] of plan.transactions.entries()) {
        const action = actions[i]!;
        if (tx.kind !== 'individual' || tx.to?.toLowerCase() !== action.target.toLowerCase() || tx.data !== action.calldata || decimal(tx.valueWei) !== action.value) fail('Baseline calldata does not match approved independent actions.');
      }
    }
    if (plan.expectedSimulation?.length !== actions.length) fail('Missing per-action approved simulation outcomes.');
    for (const [i, outcome] of plan.expectedSimulation!.entries()) {
      if (outcome === null || typeof outcome !== 'object' || outcome.id !== actions[i]!.id || typeof outcome.success !== 'boolean' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(outcome.returnData) || Object.keys(outcome).some((field) => !['id', 'success', 'returnData', 'returnDataSize'].includes(field))) fail('Invalid approved action outcome.');
      const size = decimal(outcome.returnDataSize);
      const copied = size < BigInt(MAX_RETURN_DATA_BYTES) ? size : BigInt(MAX_RETURN_DATA_BYTES);
      if (BigInt((outcome.returnData.length - 2) / 2) !== copied) fail('Approved return-data prefix is inconsistent with its size.');
    }
    const targets = new Set(actions.map((a) => a.target));
    if (plan.targetCodeHashes === undefined || Object.keys(plan.targetCodeHashes).length !== targets.size || Object.entries(plan.targetCodeHashes).some(([address, hash]) => !targets.has(address as Hex) || !/^0x[0-9a-fA-F]{64}$/.test(hash))) fail('Missing or invalid target code bindings.');
    const estimates = plan.gasEstimates;
    if (estimates === undefined || Object.keys(estimates).some((key) => !['blockNumber', 'individual', 'batch'].includes(key)) ||
      decimal(estimates.blockNumber) <= 0n || decimal(estimates.batch) <= 0n || estimates.individual?.length !== actions.length) fail('Missing or invalid RPC gas estimates.');
    for (const [i, estimate] of estimates!.individual.entries()) {
      if (estimate === null || typeof estimate !== 'object' || Object.keys(estimate).some((key) => !['id', 'gas', 'error'].includes(key)) ||
        estimate.id !== actions[i]!.id || (estimate.gas !== null && decimal(estimate.gas) <= 0n) ||
        (estimate.gas === null && typeof estimate.error !== 'string') || (estimate.error !== undefined && typeof estimate.error !== 'string')) fail('Invalid individual RPC estimate.');
    }
  } else fail('Unknown plan purpose.');
}

/** Read-only reconciliation accepts expired plans, but never creates approval. */
export function validateHistoricalPlan(plan: BroadcastPlan): void {
  verifyApproval(plan, broadcastPlanHash(plan), true, Date.parse(plan.createdAt));
}

export function decimal(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || value.length > 78) throw new ExecutionGateError('Invalid unsigned decimal plan field.');
  return BigInt(value);
}
