import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildBroadcastPlan } from '../src/testnet/build-plan.js';
import { broadcastPlanHash, type BroadcastPlan, type DeploymentStage } from '../src/testnet/broadcast-plan.js';
import { stringifyPublicJson } from '../src/evidence.js';
import { validateAddress } from '../src/validation.js';
import { DeploymentStore } from '../src/testnet/deployments.js';
import { atlanticPublicClient } from '../src/testnet/readiness.js';
import { readPublicJson } from '../src/testnet/public-files.js';
import { writePublicSnapshot } from '../src/public-state.js';

async function main() {
  const { values } = parseArgs({ strict: true, options: {
    purpose: { type: 'string', default: 'deploy' }, address: { type: 'string' }, executor: { type: 'string' },
    actions: { type: 'string' }, out: { type: 'string' },
    stage: { type: 'string' }, scenario: { type: 'string' }, 'state-dir': { type: 'string', default: 'state/testnet' },
  } });
  if (!['deploy', 'batch', 'baseline'].includes(values.purpose!)) throw new Error('Unknown plan purpose.');
  const sender = validateAddress(values.address, '--address');
  const plan = await buildBroadcastPlan({ purpose: values.purpose as BroadcastPlan['purpose'], sender,
    ...(values.stage === undefined ? {} : { stage: values.stage as DeploymentStage }),
    ...(values.scenario === undefined ? {} : { scenario: values.scenario as 'success' | 'mixed' }),
    ...(values.executor === undefined ? {} : { executor: validateAddress(values.executor, '--executor') }),
    ...(values.actions === undefined ? {} : { actions: await readPublicJson(values.actions) }),
  }, { client: atlanticPublicClient(), deployments: new DeploymentStore(values['state-dir']!) });
  const planHash = broadcastPlanHash(plan);
  const file = values.out ?? path.resolve('state', 'plans', `${plan.deploymentStage ?? plan.purpose}_${planHash.slice(7)}.json`);
  if (!file.endsWith('.json')) throw new Error('Public plan output must be a .json file, never an environment file.');
  await writePublicSnapshot(file, plan);
  console.log(stringifyPublicJson({ classification: 'READ ONLY / UNSIGNED', purpose: plan.purpose, network: plan.network, sender: plan.sender,
    planHash, deploymentStage: plan.deploymentStage, deploymentPrerequisites: plan.deploymentPrerequisites, expiresAt: plan.expiresAt, transactionCount: plan.transactions.length,
    transactions: plan.transactions.map(({ id, kind, type, nonce, to, valueWei, payloadHash, gasLimit, estimatedGas, expectedContractAddress }) => ({ id, kind, type, nonce, to, valueWei, payloadHash, gasLimit, estimatedGas, predictedAddressOnly: expectedContractAddress })),
    maximumCostWei: plan.maximumCostWei, planFile: file,
    broadcastRequires: 'Exact plan-hash approval + --confirm-atlantic-testnet + explicit local --env-file. Nothing has been signed or sent.' }));
}
main().catch(() => { console.error('Read-only planning refused. Check the selected stage, public inputs, verified deployment records and RPC. No keys loaded or transactions sent.'); process.exitCode = 1; });
