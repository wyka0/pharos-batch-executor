import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DEMO_SCENARIOS, makeDemoActions, type DemoScenario } from '../src/demo-actions.js';
import { stringifyPublicJson } from '../src/evidence.js';
import { writePublicSnapshot } from '../src/public-state.js';
import { validateAddress } from '../src/validation.js';

async function main() {
  const { values } = parseArgs({ strict: true, options: {
    target: { type: 'string' }, scenario: { type: 'string', default: 'mixed' }, count: { type: 'string' },
    prefix: { type: 'string' }, out: { type: 'string' },
  } });
  if (!DEMO_SCENARIOS.includes(values.scenario as DemoScenario)) throw new Error('Unknown test-only scenario.');
  const count = values.count === undefined ? (values.scenario === 'success' ? 6 : 3) : Number(values.count);
  const actions = makeDemoActions(validateAddress(values.target, '--target'), values.scenario as DemoScenario, count,
    values.prefix ?? `demo-${randomUUID().slice(0, 8)}`);
  if (values.out === undefined) console.log(stringifyPublicJson(actions));
  else {
    if (!values.out.endsWith('.json')) throw new Error('Public actions output must be a .json file.');
    await writePublicSnapshot(values.out, actions);
    console.log(`Prepared ${actions.length} TEST-ONLY actions at ${values.out}. Not simulated, signed or broadcast.`);
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Action generation failed.'); process.exitCode = 1; });
