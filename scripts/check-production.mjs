/** Offline compiled-package checks. No RPC, signer, Anvil or install operation. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { scanTextForSecrets } from '../dist/safety.js';
import { root } from './tooling.mjs';

function cli(args, expectedExit = 0) {
  const result = spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, expectedExit, 'Compiled CLI exit code differs from the expectation; raw output not echoed.');
  assert.equal(scanTextForSecrets((result.stdout ?? '') + (result.stderr ?? '')).length, 0, 'Compiled output contained a credential pattern; output refused.');
  return result;
}

assert.match(cli(['--help']).stdout, /dry-run by default/);
assert.match(cli(['validate', '--actions', 'examples/model-actions.json']).stdout, /Validated 3/);
const unsigned = JSON.parse(cli(['plan', '--actions', 'examples/model-actions.json']).stdout);
assert.equal(unsigned.actions.length, 3);
assert.match(unsigned.batchCalldata, /^0x[a-f0-9]+$/);
assert.match(unsigned.disclosure, /Not simulated, signed, submitted or confirmed/);
assert.match(cli(['validate', '--actions', 'examples/invalid-empty.json'], 1).stderr, /at least 3/);

const directory = path.join(root, 'evidence', 'runs', `production_${randomUUID()}`);
for (const scenario of ['success', 'mixed', 'all-fail']) cli(['demo', '--scenario', scenario, '--out', directory]);
const modelFiles = (await readdir(directory)).filter((name) => name.endsWith('.json'));
assert.equal(modelFiles.length, 3);
for (const name of modelFiles) {
  const e = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
  assert.equal(e.metadata.chainId, 0);
  assert.equal(e.batch.actions.length, 3);
  assert.equal(e.batch.receipt.evidence, 'simulated');
  assert.match(e.batch.receipt.simulationRef, /^sim_/);
  assert.equal(e.batch.transactionHash, undefined);
  assert.equal(e.batch.receipt.txHash, undefined);
  assert.equal(e.batch.receipt.gasUsed, undefined);
  assert.equal(e.comparison.measuredSavings, undefined);
  assert.equal(e.measurementDisclosures.estimatesAreModelValues, true);
}

const library = await import('pharos-batch-executor');
assert.equal(library.ATLANTIC.chainId, 688689);
assert.equal(library.ATLANTIC_CHAIN.id, 688689);
assert.equal(library.validateActions(JSON.parse(await readFile(path.join(root, 'examples', 'model-actions.json'), 'utf8'))).length, 3);
let declarations = 0;
async function checkDeclarations(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await checkDeclarations(file);
    else if (entry.name.endsWith('.d.ts')) {
      assert.doesNotMatch(await readFile(file, 'utf8'), /(?:\.\.\/)+node_modules\/|viem\/_types\//, 'Nonportable declaration references an internal dependency path.');
      declarations++;
    }
  }
}
await checkDeclarations(path.join(root, 'dist'));
assert(declarations > 0);

// Integrity of immutable SAVED proof, not a new RPC or canonical-chain check.
const proof = path.join(root, 'evidence', 'local');
const manifest = JSON.parse(await readFile(path.join(proof, 'manifest.json'), 'utf8'));
assert.equal(manifest.classification, 'SAVED LOCAL EVM OBSERVATIONS — NOT ATLANTIC');
assert.equal(manifest.currentRpcVerificationPerformed, false);
assert.equal(manifest.baselineBranchDiscarded, true);
const names = manifest.files.map((file) => file.path);
assert.equal(new Set(names).size, names.length);
assert.deepEqual((await readdir(proof)).sort(), [...names, 'manifest.json'].sort());
for (const file of manifest.files) {
  assert.match(file.path, /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
  const name = path.join(proof, file.path);
  const info = await lstat(name);
  assert(info.isFile() && !info.isSymbolicLink());
  const bytes = await readFile(name);
  assert.equal(bytes.length, file.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, 'Saved proof differs from its manifest.');
}

console.log(`Production checks passed: compiled help/validation/unsigned plan, expected invalid-input exit, three MODEL scenarios, library exports and ${declarations} portable declarations.`);
console.log(`Saved local evidence integrity passed: ${names.length} files match the manifest. No network, signing, broadcast or fresh receipt verification performed.`);
