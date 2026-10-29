import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildBroadcastPlan } from '../src/testnet/build-plan.js';
import { broadcastPlanHash, type BroadcastPlan } from '../src/testnet/broadcast-plan.js';
import { stringifyPublicJson } from '../src/evidence.js';
import { validateAddress } from '../src/validation.js';

async function main() {
  const { values } = parseArgs({ strict: true, options: {
    purpose: { type: 'string', default: 'deploy' }, address: { type: 'string' }, executor: { type: 'string' },
    actions: { type: 'string' }, out: { type: 'string' },
  } });
  if (!['deploy', 'batch', 'baseline'].includes(values.purpose!)) throw new Error('Unknown plan purpose.');
  const sender = validateAddress(values.address, '--address');
  if (values.actions && (await stat(values.actions)).size > 1_000_000) throw new Error('Action file too large.');
  const plan = await buildBroadcastPlan({ purpose: values.purpose as BroadcastPlan['purpose'], sender,
    ...(values.executor === undefined ? {} : { executor: validateAddress(values.executor, '--executor') }),
    ...(values.actions === undefined ? {} : { actions: JSON.parse(await readFile(values.actions, 'utf8')) as unknown }),
  });
  const planHash = broadcastPlanHash(plan);
  const file = values.out ?? path.resolve('state', 'plans', `${plan.purpose}_${planHash.slice(7)}.json`);
  if (!file.endsWith('.json')) throw new Error('Public plan output must be a .json file, never an environment file.');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${stringifyPublicJson(plan)}\n`, { flag: 'wx' });
  console.log(stringifyPublicJson({ classification: 'READ ONLY / UNSIGNED', purpose: plan.purpose, network: plan.network, sender: plan.sender,
    planHash, expiresAt: plan.expiresAt, transactionCount: plan.transactions.length,
    transactions: plan.transactions.map(({ id, kind, nonce, to, gasLimit, estimatedGas, expectedContractAddress }) => ({ id, kind, nonce, to, gasLimit, estimatedGas, predictedAddressOnly: expectedContractAddress })),
    maximumCostWei: plan.maximumCostWei, planFile: file,
    broadcastRequires: 'Exact plan-hash approval + --confirm-atlantic-testnet + explicit local --env-file. Nothing has been signed or sent.' }));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Read-only plan failed.'); process.exitCode = 1; });
