import { createHash } from 'node:crypto';
import path from 'node:path';
import { keccak256, type Address, type Hash } from 'viem';
import { loadArtifact } from '../artifacts.js';
import { assertAuthorizedCaller } from '../caller.js';
import { ExecutionGateError } from '../errors.js';
import { writePublicSnapshot } from '../public-state.js';
import type { ActualReceipt } from '../types.js';
import { broadcastPlanHash, canonicalJson, DEPLOYMENT_ARTIFACTS, validateHistoricalPlan, type BroadcastPlan, type DeploymentBinding, type DeploymentStage } from './broadcast-plan.js';
import { feeEvidence, type FeeEvidence } from './fees.js';
import { ExecutionJournal } from './journal.js';
import { readPublicJson } from './public-files.js';
import { reconcilePlan, type ReconcileClient, type ReconciliationEvidence } from './reconcile.js';

export interface DeploymentRecord {
  schemaVersion: 1;
  classification: 'VERIFIED ATLANTIC DEPLOYMENT';
  stage: DeploymentStage;
  sender: Address;
  planHash: string;
  plan: BroadcastPlan;
  transactionHash: Hash;
  address: Address;
  runtimeCodeHash: Hash;
  authorizedCaller?: Address;
  blockNumber: string;
  blockHash: Hash;
  verifiedAt: string;
  fees: FeeEvidence;
}

export function deploymentBinding(record: DeploymentRecord): DeploymentBinding {
  return {
    recordHash: `sha256:${createHash('sha256').update(canonicalJson(record)).digest('hex')}`,
    planHash: record.planHash, transactionHash: record.transactionHash, address: record.address,
    runtimeCodeHash: record.runtimeCodeHash, blockNumber: record.blockNumber, blockHash: record.blockHash,
  };
}

/** One durable deployment of each stage per sender in the shared state directory. */
export class DeploymentStore {
  readonly directory: string;

  constructor(directory: string) { this.directory = path.resolve(directory); }

  recordFile(sender: Address, stage: DeploymentStage): string { return this.file(sender, stage, 'verified'); }

  async assertAvailable(sender: Address, stage: DeploymentStage): Promise<void> {
    if (await readPublicJson(this.recordFile(sender, stage), true) !== undefined || await readPublicJson(this.file(sender, stage, 'intent'), true) !== undefined) {
      throw new ExecutionGateError('This deployment stage already has a record or intent. Reconcile the original plan; never redeploy it at another nonce.', {
        code: 'STAGE_ALREADY_CLAIMED', safeCause: 'DEPLOYMENT_STAGE_AVAILABILITY',
      });
    }
  }

  /** Called only under the runner's shared sender lock, before loading a key. */
  async claim(plan: BroadcastPlan, at: string): Promise<void> {
    this.assertDeploymentPlan(plan);
    await this.assertAvailable(plan.sender, plan.deploymentStage!);
    await writePublicSnapshot(this.file(plan.sender, plan.deploymentStage!, 'intent'), {
      schemaVersion: 1, state: 'DEPLOYMENT_CLAIMED', at, planHash: broadcastPlanHash(plan), plan,
    });
  }

  async read(sender: Address, stage: DeploymentStage): Promise<DeploymentRecord> {
    const record = await readPublicJson(this.recordFile(sender, stage)) as DeploymentRecord;
    try {
      const fields = ['schemaVersion', 'classification', 'stage', 'sender', 'planHash', 'plan', 'transactionHash', 'address', 'runtimeCodeHash', 'authorizedCaller', 'blockNumber', 'blockHash', 'verifiedAt', 'fees'];
      if (record === null || typeof record !== 'object' || Object.keys(record).some((key) => !fields.includes(key))) throw new Error('fields');
      this.assertDeploymentPlan(record.plan);
      const tx = record.plan.transactions[0]!;
      if (record.schemaVersion !== 1 || record.classification !== 'VERIFIED ATLANTIC DEPLOYMENT' || record.stage !== stage ||
        record.sender.toLowerCase() !== sender.toLowerCase() || record.plan.sender.toLowerCase() !== sender.toLowerCase() ||
        record.plan.deploymentStage !== stage || record.planHash !== broadcastPlanHash(record.plan) ||
        record.address.toLowerCase() !== tx.expectedContractAddress?.toLowerCase() || record.runtimeCodeHash !== tx.expectedRuntimeCodeHash ||
        !/^0x[0-9a-fA-F]{64}$/.test(record.transactionHash) || !/^0x[0-9a-fA-F]{64}$/.test(record.blockHash) || !/^\d+$/.test(record.blockNumber) || BigInt(record.blockNumber) <= 0n ||
        !Number.isFinite(Date.parse(record.verifiedAt)) || (stage === 'executor' ? record.authorizedCaller?.toLowerCase() !== sender.toLowerCase() : record.authorizedCaller !== undefined)) throw new Error('identity');
      await this.assertClaim(record.plan);
      return record;
    } catch { throw new ExecutionGateError('Verified deployment record is inconsistent with its stage, sender, plan or durable claim.'); }
  }

  /** A saved CONFIRMED label is insufficient: verify its original hash on-chain again. */
  async verify(sender: Address, stage: DeploymentStage, client: ReconcileClient, expected?: DeploymentBinding, artifactLoader = loadArtifact): Promise<DeploymentRecord> {
    try {
      const record = await this.read(sender, stage);
      if (expected !== undefined && canonicalJson(deploymentBinding(record)) !== canonicalJson(expected)) throw new Error('record changed');
      const artifact = await artifactLoader(DEPLOYMENT_ARTIFACTS[stage]);
      if (record.plan.transactions[0]!.data !== artifact.bytecode || record.runtimeCodeHash !== artifact.runtimeCodeHash) throw new Error('artifact binding');
      const journal = new ExecutionJournal(this.directory, record.planHash);
      const evidence = await reconcilePlan(record.plan, await journal.readForReconciliation(record.plan), client);
      const step = evidence.steps[0];
      if (!evidence.allTransactionsConfirmed || step?.transactionHash?.toLowerCase() !== record.transactionHash.toLowerCase() || step.receipt?.blockHash !== record.blockHash ||
        step.receipt.blockNumber.toString() !== record.blockNumber || step.deployedAddress?.toLowerCase() !== record.address.toLowerCase() ||
        canonicalJson(feeEvidence(record.plan, record.plan.transactions[0]!, step.receipt)) !== canonicalJson(record.fees)) throw new Error('receipt verification');
      const code = await client.getCode({ address: record.address });
      if (code === undefined || keccak256(code) !== artifact.runtimeCodeHash) throw new Error('current runtime');
      if (stage === 'executor') await assertAuthorizedCaller(client, record.address, sender);
      return record;
    } catch { throw new ExecutionGateError('Required deployment is missing, changed or not canonically verified. Reconcile its original plan before continuing.', {
      code: 'PREREQUISITE_VERIFICATION_FAILED', safeCause: 'DEPLOYMENT_PREREQUISITE',
    }); }
  }

  async prerequisites(sender: Address, stages: readonly DeploymentStage[], client: ReconcileClient, expected?: BroadcastPlan['deploymentPrerequisites'], artifactLoader = loadArtifact): Promise<NonNullable<BroadcastPlan['deploymentPrerequisites']>> {
    const bindings: NonNullable<BroadcastPlan['deploymentPrerequisites']> = {};
    for (const stage of stages) {
      const record = await this.verify(sender, stage, client, expected?.[stage], artifactLoader);
      if (stage === 'counter' && canonicalJson(record.plan.deploymentPrerequisites?.executor) !== canonicalJson(bindings.executor)) throw new ExecutionGateError('Counter was not approved against this executor deployment record.', {
        code: 'PREREQUISITE_VERIFICATION_FAILED', safeCause: 'DEPLOYMENT_PREREQUISITE',
      });
      bindings[stage] = deploymentBinding(record);
    }
    return bindings;
  }

  async verifyPrerequisites(plan: BroadcastPlan, client: ReconcileClient, artifactLoader = loadArtifact): Promise<void> {
    const stages: DeploymentStage[] = plan.purpose === 'deploy' ? plan.deploymentStage === 'counter' ? ['executor'] : [] : ['executor', 'counter'];
    await this.prerequisites(plan.sender, stages, client, plan.deploymentPrerequisites, artifactLoader);
    for (const stage of stages) {
      const record = await this.read(plan.sender, stage);
      if (Date.parse(plan.createdAt) < Date.parse(record.verifiedAt) || plan.transactions[0]!.nonce <= record.plan.transactions[0]!.nonce) throw new ExecutionGateError('This approval predates its verified prerequisite or reuses an earlier nonce. Prepare a fresh plan.', {
        code: 'PREREQUISITE_VERIFICATION_FAILED', safeCause: 'DEPLOYMENT_PREREQUISITE',
      });
    }
  }

  /** Only freshly verified effects are passed here by runner/reconciliation. */
  async save(plan: BroadcastPlan, transactionHash: Hash, receipt: ActualReceipt, address: Address, at = new Date().toISOString()): Promise<DeploymentRecord> {
    this.assertDeploymentPlan(plan);
    await this.assertClaim(plan);
    const tx = plan.transactions[0]!;
    if (receipt.status !== 'success' || receipt.txHash.toLowerCase() !== transactionHash.toLowerCase() || address.toLowerCase() !== tx.expectedContractAddress?.toLowerCase()) throw new ExecutionGateError('Only verified successful deployment effects can be recorded.');
    const record: DeploymentRecord = {
      schemaVersion: 1, classification: 'VERIFIED ATLANTIC DEPLOYMENT', stage: plan.deploymentStage!, sender: plan.sender,
      planHash: broadcastPlanHash(plan), plan: structuredClone(plan), transactionHash, address,
      runtimeCodeHash: tx.expectedRuntimeCodeHash!, ...(plan.deploymentStage === 'executor' ? { authorizedCaller: plan.sender } : {}),
      blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, verifiedAt: at, fees: feeEvidence(plan, tx, receipt),
    };
    const file = this.recordFile(plan.sender, plan.deploymentStage!);
    const existing = await readPublicJson(file, true) as DeploymentRecord | undefined;
    if (existing !== undefined) return this.sameRecord(existing, record);
    try { await writePublicSnapshot(file, record); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ExecutionGateError('Durable deployment record persistence failed; reconcile without redeploying.');
      return this.sameRecord(await this.read(plan.sender, plan.deploymentStage!), record);
    }
    return record;
  }

  async recordReconciliation(evidence: ReconciliationEvidence, artifactLoader = loadArtifact): Promise<DeploymentRecord | undefined> {
    if (evidence.plan.schemaVersion !== 2 || evidence.plan.purpose !== 'deploy' || !evidence.allTransactionsConfirmed) return undefined;
    const plan = evidence.plan;
    const artifact = await artifactLoader(DEPLOYMENT_ARTIFACTS[plan.deploymentStage!]);
    const tx = plan.transactions[0]!;
    if (tx.data !== artifact.bytecode || tx.expectedRuntimeCodeHash !== artifact.runtimeCodeHash) throw new ExecutionGateError('Recovered deployment does not match the source-bound artifact.');
    const step = evidence.steps[0]!;
    if (step.state !== 'CONFIRMED' || step.receipt === undefined || step.transactionHash === undefined || step.deployedAddress === undefined) throw new ExecutionGateError('Recovered deployment effects are incomplete.');
    return this.save(plan, step.transactionHash, step.receipt, step.deployedAddress, evidence.observedAt);
  }

  private sameRecord(existing: DeploymentRecord, next: DeploymentRecord): DeploymentRecord {
    // Preserve the original verification timestamp/hash across idempotent recovery.
    if (canonicalJson({ ...existing, verifiedAt: next.verifiedAt }) !== canonicalJson(next)) throw new ExecutionGateError('Existing verified deployment record conflicts with recovered evidence; no overwrite or redeployment.');
    return existing;
  }

  private async assertClaim(plan: BroadcastPlan): Promise<void> {
    const claim = await readPublicJson(this.file(plan.sender, plan.deploymentStage!, 'intent')) as { state?: string; planHash?: string; plan?: BroadcastPlan };
    if (claim?.state !== 'DEPLOYMENT_CLAIMED' || claim.planHash !== broadcastPlanHash(plan) || canonicalJson(claim.plan) !== canonicalJson(plan)) throw new ExecutionGateError('Deployment record has no matching durable stage intent.');
  }

  private assertDeploymentPlan(plan: BroadcastPlan): void {
    validateHistoricalPlan(plan);
    if (plan.schemaVersion !== 2 || plan.purpose !== 'deploy' || plan.transactions.length !== 1 || plan.deploymentStage === undefined) throw new ExecutionGateError('Only a single v2 deployment stage can create a durable deployment record.');
  }

  private file(sender: Address, stage: DeploymentStage, kind: 'verified' | 'intent'): string {
    if (!/^0x[0-9a-fA-F]{40}$/.test(sender) || !['executor', 'counter'].includes(stage)) throw new ExecutionGateError('Invalid deployment record identity.');
    return path.join(this.directory, `deployment_${sender.toLowerCase()}_${stage}.${kind}.json`);
  }
}
