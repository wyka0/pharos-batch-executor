import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { stringifyPublicJson } from '../src/evidence.js';
import { writePublicSnapshot } from '../src/public-state.js';
import { broadcastPlanHash, type BroadcastPlan } from '../src/testnet/broadcast-plan.js';
import { ExecutionJournal } from '../src/testnet/journal.js';
import { atlanticPublicClient } from '../src/testnet/readiness.js';
import { reconcilePlan } from '../src/testnet/reconcile.js';

async function main() {
  const { values } = parseArgs({ strict: true, options: {
    plan: { type: 'string' }, 'state-dir': { type: 'string', default: 'state/testnet' }, out: { type: 'string' },
  } });
  if (!values.plan) throw new Error('--plan <public plan.json> is required. This command is read-only.');
  if ((await stat(values.plan)).size > 1_000_000) throw new Error('Plan file exceeds size limit.');
  const plan = JSON.parse(await readFile(values.plan, 'utf8')) as BroadcastPlan;
  const journal = new ExecutionJournal(path.resolve(values['state-dir']!), broadcastPlanHash(plan));
  const result = await reconcilePlan(plan, await journal.read(), atlanticPublicClient());
  const file = values.out ?? path.resolve('evidence', 'runs', `status_${randomUUID()}.json`);
  if (!file.endsWith('.json')) throw new Error('Public reconciliation output must be a .json file.');
  await writePublicSnapshot(file, result);
  console.log(stringifyPublicJson({ classification: result.classification, planHash: result.planHash,
    allTransactionsConfirmed: result.allTransactionsConfirmed, unresolvedHashes: result.unresolvedHashes,
    steps: result.steps, comparison: result.comparison, evidenceFile: file }));
  if (result.unresolvedHashes) process.exitCode = 1;
}
main().catch(() => {
  console.error('Read-only reconciliation failed. Inspect the public plan/journal and RPC; no keys loaded, transactions sent, or locks removed.');
  process.exitCode = 1;
});
