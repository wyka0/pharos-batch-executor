import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { stringifyPublicJson } from '../src/evidence.js';
import { writePublicSnapshot, writePublicState } from '../src/public-state.js';
import { broadcastPlanHash, verifyApproval, type BroadcastPlan } from '../src/testnet/broadcast-plan.js';
import { ExecutionJournal } from '../src/testnet/journal.js';
import { atlanticPublicClient } from '../src/testnet/readiness.js';
import { executeApprovedPlan } from '../src/testnet/runner.js';
import { DeploymentStore } from '../src/testnet/deployments.js';
import { readPublicJson } from '../src/testnet/public-files.js';

async function main() {
  const { values } = parseArgs({ strict: true, options: {
    plan: { type: 'string' }, 'approve-plan': { type: 'string' }, 'confirm-atlantic-testnet': { type: 'boolean' },
    'env-file': { type: 'string' }, 'state-dir': { type: 'string', default: 'state/testnet' },
  } });
  if (!values.plan || !values['approve-plan'] || !values['confirm-atlantic-testnet'] || !values['env-file']) {
    throw new Error('Broadcast refused: explicit plan file, exact approval hash, --confirm-atlantic-testnet, and local --env-file are all required.');
  }
  const plan = await readPublicJson(values.plan) as BroadcastPlan;
  verifyApproval(plan, values['approve-plan'], values['confirm-atlantic-testnet']);
  const hash = broadcastPlanHash(plan);
  const stateDir = path.resolve(values['state-dir']!);
  const evidenceFile = path.join(stateDir, `${hash.slice(7)}.execution.json`);
  const runId = randomUUID();
  let snapshotIndex = 0;
  const result = await executeApprovedPlan(plan, values['approve-plan'], values['confirm-atlantic-testnet'], {
    client: atlanticPublicClient(), journal: new ExecutionJournal(stateDir, hash), deployments: new DeploymentStore(stateDir),
    signerLoader: async () => {
      const { loadLocalSigner } = await import('../src/testnet/signer.js');
      return loadLocalSigner(values['env-file']!, plan.sender);
    },
    onEvidence: async (evidence) => {
      await writePublicSnapshot(path.join(stateDir, 'snapshots', `${hash.slice(7)}_${runId}_${snapshotIndex++}.json`), evidence);
      await writePublicState(evidenceFile, evidence);
    },
  });
  console.log(stringifyPublicJson({ state: result.state, planHash: hash, evidenceFile,
    steps: result.steps.map((s) => ({ id: s.id, state: s.state, hash: s.transactionHash, receipt: s.receipt, fees: s.fees, deploymentRecord: s.deploymentRecord, actions: s.actions, error: s.error })),
    comparison: result.comparison }));
  if (result.state !== 'CONFIRMED') process.exitCode = 1;
}
main().catch(() => {
  // Never print a signing/submission exception: it may carry a raw signed
  // payload. Public evidence + journal preserve hashes and safe error labels.
  console.error('Testnet runner stopped/refused. Inspect the public plan, journal and execution evidence. Do not resend an intent or unknown transaction.');
  process.exitCode = 1;
});
