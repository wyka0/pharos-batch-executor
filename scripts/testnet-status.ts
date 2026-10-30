import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { stringifyPublicJson } from '../src/evidence.js';
import { writePublicSnapshot } from '../src/public-state.js';
import { broadcastPlanHash, type BroadcastPlan } from '../src/testnet/broadcast-plan.js';
import { ExecutionJournal } from '../src/testnet/journal.js';
import { atlanticPublicClient } from '../src/testnet/readiness.js';
import { reconcilePlan } from '../src/testnet/reconcile.js';
import { DeploymentStore, deploymentBinding } from '../src/testnet/deployments.js';
import { readPublicJson } from '../src/testnet/public-files.js';

async function main() {
  const { values } = parseArgs({ strict: true, options: {
    plan: { type: 'string' }, 'state-dir': { type: 'string', default: 'state/testnet' }, out: { type: 'string' },
    'release-completed-locks': { type: 'boolean' },
  } });
  if (!values.plan) throw new Error('--plan <public plan.json> is required. This command is read-only.');
  const plan = await readPublicJson(values.plan) as BroadcastPlan;
  const journal = new ExecutionJournal(path.resolve(values['state-dir']!), broadcastPlanHash(plan));
  const result = await reconcilePlan(plan, await journal.readForReconciliation(plan), atlanticPublicClient());
  const approvalState = await journal.readApprovalState();
  if (approvalState === 'ABORTED_BEFORE_SEND') for (const step of result.steps) {
    if (step.state === 'NOT_SUBMITTED') { step.state = 'ABORTED_BEFORE_SEND'; step.error = 'Local pre-intent approval abort is terminal; the consumed approval and reservations remain.'; }
  }
  const record = await new DeploymentStore(journal.directory).recordReconciliation(result);
  if (values['release-completed-locks']) await journal.releaseCompletedLocks(plan, result);
  const file = values.out ?? path.resolve('evidence', 'runs', `status_${randomUUID()}.json`);
  if (!file.endsWith('.json')) throw new Error('Public reconciliation output must be a .json file.');
  await writePublicSnapshot(file, { ...result, approvalState, deploymentRecord: record === undefined ? undefined : deploymentBinding(record), completedLocksReleased: values['release-completed-locks'] === true });
  console.log(stringifyPublicJson({ classification: result.classification, planHash: result.planHash,
    allTransactionsConfirmed: result.allTransactionsConfirmed, unresolvedHashes: result.unresolvedHashes,
    steps: result.steps, comparison: result.comparison, approvalState, deploymentRecord: record === undefined ? undefined : deploymentBinding(record),
    completedLocksReleased: values['release-completed-locks'] === true, evidenceFile: file }));
  if (result.unresolvedHashes) process.exitCode = 1;
}
main().catch(() => {
  console.error('Reconciliation or explicit local recovery failed. Inspect the public plan/journal and RPC; no keys loaded or transactions sent. Existing intents must be preserved.');
  process.exitCode = 1;
});
