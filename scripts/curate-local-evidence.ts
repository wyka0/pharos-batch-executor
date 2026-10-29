import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { decodeEventLog, encodeFunctionData, getContractAddress, type Hash } from 'viem';
import { BATCH_EXECUTOR_ABI } from '../src/abi.js';
import { assertEndpoint } from '../src/network.js';
import { preparePlan } from '../src/plan.js';
import { writePublicSnapshot } from '../src/public-state.js';
import { resultsFromReceipt } from '../src/receipt.js';
import { savedReceiptLogs, verifySavedReceipt, type SavedRawReceipt, type SavedReceipt } from '../src/saved-evidence.js';
import { assertPublicData, scanTextForSecrets } from '../src/safety.js';
import type { ActionResult, BatchRunEvidence } from '../src/types.js';
import { validateActions } from '../src/validation.js';

type SavedAction = Omit<ActionResult, 'returnDataSize'> & { returnDataSize?: string };
type SavedIndividual = { receipts: SavedReceipt[]; rawReceipts: SavedRawReceipt[]; actions: SavedAction[] };
type SavedComparison = {
  individual: { transactionCount: number; measuredGas: { gas: string; measured: true; receipts: number } };
  batch: { transactionCount: number; measuredGas: { gas: string; measured: true; receipts: number } };
  measuredSavings: { gas: string; fraction: number }; baselineMethod: string;
  transactionReduction: { count: number; fraction: number };
};
type SavedRun = {
  schemaVersion: number; skill: string; runId: string; metadata: { chainId: number; adapter: string };
  plan: BatchRunEvidence['plan']; individual?: SavedIndividual; comparison: SavedComparison;
  batch: { kind: string; state: string; receipt: SavedReceipt; rawReceipt: SavedRawReceipt;
    actions: SavedAction[]; refundCreditWei: string; transactionHash: Hash };
};
type Trace = { classification: string; hash: Hash; nonce: number; gasPrice: string;
  request: { to: string; data: string; value: string; gas: string } };

function checkTrace(trace: Trace, receipt: SavedReceipt, expected: { nonce: number; to: string; data: string; value: string }): void {
  assert.equal(trace.classification, 'LOCAL ANVIL ONLY');
  assert.equal(trace.hash, receipt.txHash);
  assert.equal(trace.nonce, expected.nonce);
  assert.equal(trace.request.to.toLowerCase(), expected.to.toLowerCase());
  assert.equal(trace.request.data, expected.data);
  assert.equal(trace.request.value, expected.value);
  assert.equal(trace.gasPrice, receipt.effectiveGasPrice);
  assert(BigInt(trace.request.gas) >= BigInt(receipt.gasUsed));
}

async function main() {
  const directory = process.argv[2];
  if (!directory || process.argv.length !== 3) throw new Error('Usage: npm run evidence:curate -- <successful-local-run-directory>');
  const source = path.resolve(directory);
  // Read each bounded public file ONCE and validate all inputs before creating
  // the immutable destination. A failed preflight cannot leave partial proof.
  const files = new Map<string, Buffer>();
  async function publicFile(name: string): Promise<Buffer> {
    const existing = files.get(name);
    if (existing) return existing;
    assert(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name), 'Unsafe evidence filename.');
    const info = await lstat(path.join(source, name));
    assert(info.isFile() && !info.isSymbolicLink() && info.size <= 5_000_000, 'Unsafe public evidence file.');
    const bytes = await readFile(path.join(source, name));
    assert.equal(scanTextForSecrets(bytes.toString('utf8')).length, 0, 'Credential pattern refused; value not emitted.');
    files.set(name, bytes);
    return bytes;
  }
  async function publicJson<T>(name: string): Promise<T> {
    const value = JSON.parse((await publicFile(name)).toString('utf8')) as T;
    assertPublicData(value);
    return value;
  }
  const summary = await publicJson<{
    classification: string; runId: string; chainId: number; executor: `0x${string}`; sender: `0x${string}`;
    testOnlyTarget: `0x${string}`; setupTransactions: number; baselineTransactions: number;
    demonstrationBatchTransactions: number; refundWithdrawalTransactions: number;
    totalSubmittedLocalTransactions: number; restoredStateRoot: string; restoredBlockHash: string;
    baselineMethod: string; comparison: SavedComparison;
    scenarios: Array<{ runId: string; receipt: SavedReceipt; transactionHash: Hash;
      outcomes: Array<{ id: string; success: boolean; error?: string; truncated: boolean }> }>;
    deploymentReceipts: Array<{ name: string; address: string; receipt: SavedReceipt; rawReceipt: SavedRawReceipt; bytecodeHash: Hash }>;
    withdrawal: { receipt: SavedReceipt; rawReceipt: SavedRawReceipt };
  }>('summary.json');
  assert.equal(summary.classification, 'REAL LOCAL EVM ONLY — NOT ATLANTIC. All assertions passed.');
  assert.equal(summary.chainId, 31337);
  assert.match(summary.runId, /^local_[a-zA-Z0-9_.-]+$/);
  assert.equal(summary.totalSubmittedLocalTransactions, 14);
  assert.deepEqual([summary.setupTransactions, summary.baselineTransactions, summary.demonstrationBatchTransactions, summary.refundWithdrawalTransactions], [2, 6, 5, 1]);
  const labels = ['success', 'mixed', 'gas-isolation', 'return-cap', 'refund-credit'];
  assert.deepEqual(summary.scenarios.map((s) => s.runId), labels.map((label) => `${summary.runId}_${label}`));
  const metadata = await publicJson<{ classification: string; runId: string; chainId: number; sender: string; rpcUrl: string }>('metadata.json');
  assert.equal(metadata.classification, 'LOCAL ANVIL ONLY, NOT ATLANTIC');
  assert.equal(metadata.runId, summary.runId);
  assert.equal(metadata.chainId, 31337);
  assert.equal(metadata.sender, summary.sender);
  assertEndpoint('local-anvil', metadata.rpcUrl);
  const traceNames = (await readdir(source)).filter((name) => /^submission_\d+\.json$/.test(name));
  assert.deepEqual(traceNames.sort(), Array.from({ length: 12 }, (_, i) => `submission_${i}.json`).sort());
  const traces = await Promise.all(Array.from({ length: 12 }, (_, i) => publicJson<Trace>(`submission_${i}.json`)));
  const baseline = await publicJson<{ beforeBlockHash: string; beforeStateRoot: string; individual: SavedIndividual }>('individual-before-snapshot-revert.json');
  assert.equal(baseline.beforeBlockHash, summary.restoredBlockHash);
  assert.equal(baseline.beforeStateRoot, summary.restoredStateRoot);
  assert.equal(baseline.individual.receipts.length, 6);
  assert.equal(baseline.individual.rawReceipts.length, 6);
  assert.equal(baseline.individual.actions.length, 6);
  const baselineGas = baseline.individual.receipts.reduce((sum, r, i) => {
    const raw = baseline.individual.rawReceipts[i]!;
    const verified = verifySavedReceipt(r, raw);
    assert.equal(verified.status, 'success');
    assert.equal(raw.from?.toLowerCase(), summary.sender.toLowerCase());
    assert.equal(raw.to?.toLowerCase(), summary.testOnlyTarget.toLowerCase());
    assert.equal(baseline.individual.actions[i]!.transactionHash, r.txHash);
    assert.equal(baseline.individual.actions[i]!.index, i);
    assert.equal(baseline.individual.actions[i]!.success, true);
    return sum + verified.gasUsed;
  }, 0n);
  assert.equal(baselineGas, BigInt(summary.comparison.individual.measuredGas.gas));
  assert.equal(summary.deploymentReceipts.length, 2);
  for (const [i, deployment] of summary.deploymentReceipts.entries()) {
    const name = ['BatchExecutor', 'TestOnlyCounter'][i]!;
    assert.equal(deployment.name, name);
    const submitted = await publicJson<{ classification: string; name: string; address: string; hash: Hash; nonce: number; bytecodeHash: Hash }>(`setup_${name}.submitted.json`);
    const raw = await publicJson<SavedRawReceipt>(`setup_${name}.receipt.json`);
    assert.deepEqual(raw, deployment.rawReceipt);
    const verified = verifySavedReceipt(deployment.receipt, raw);
    assert.equal(verified.status, 'success');
    assert.equal(submitted.classification, 'LOCAL ANVIL ONLY');
    assert.equal(submitted.name, name);
    assert.equal(submitted.nonce, i);
    assert.equal(submitted.hash, verified.txHash);
    assert.equal(submitted.bytecodeHash, deployment.bytecodeHash);
    assert.equal(submitted.address, deployment.address);
    assert.equal(deployment.address, getContractAddress({ from: summary.sender, nonce: BigInt(i) }));
    assert.equal(deployment.address, i === 0 ? summary.executor : summary.testOnlyTarget);
    assert.equal(raw.contractAddress?.toLowerCase(), deployment.address.toLowerCase());
    assert.equal(raw.from?.toLowerCase(), summary.sender.toLowerCase());
    assert.equal(raw.to, null);
  }
  assert.equal(summary.deploymentReceipts[1]!.receipt.blockHash, baseline.beforeBlockHash);
  for (const [scenarioIndex, scenario] of summary.scenarios.entries()) {
    const e = await publicJson<SavedRun>(`${scenario.runId}.json`);
    await publicFile(`${scenario.runId}.md`);
    assert.equal(e.schemaVersion, 1);
    assert.equal(e.skill, 'pharos-batch-executor');
    assert.equal(e.runId, scenario.runId);
    assert.equal(e.metadata.chainId, 31337);
    assert.equal(e.metadata.adapter, 'local-anvil');
    assert.equal(e.batch.kind, 'batch');
    assert.equal(e.batch.state, 'confirmed');
    const receipt = verifySavedReceipt(e.batch.receipt, e.batch.rawReceipt);
    assert.equal(receipt.status, 'success');
    assert.deepEqual(e.batch.receipt, scenario.receipt);
    assert.equal(e.batch.transactionHash, receipt.txHash);
    assert.equal(scenario.transactionHash, receipt.txHash);
    assert.equal(e.batch.rawReceipt.from?.toLowerCase(), summary.sender.toLowerCase());
    assert.equal(e.batch.rawReceipt.to?.toLowerCase(), summary.executor.toLowerCase());
    assert.equal(e.plan.batchExecutorAddress, summary.executor);
    const actions = validateActions(e.plan.actions.map((a) => ({ id: a.id, target: a.target, calldata: a.calldata,
      value: a.valueWei, gasLimit: a.gasLimit, independent: a.independent, ...(a.note === undefined ? {} : { note: a.note }) })));
    const prepared = preparePlan(actions);
    assert.equal(prepared.planHash, e.plan.planHash);
    assert.equal(prepared.batchCalldata, e.plan.batchCalldata);
    assert(actions.every((a, i) => e.plan.actions[i]!.index === i && e.plan.actions[i]!.idBytes32 === a.idBytes32 && a.target === summary.testOnlyTarget));
    const logs = savedReceiptLogs(e.batch.rawReceipt);
    const results = resultsFromReceipt(actions, logs, summary.executor, summary.sender, {
      transactionHash: receipt.txHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber,
    });
    assert.deepEqual(results.actions.map((a) => ({ ...a, returnDataSize: a.returnDataSize!.toString() })), e.batch.actions);
    assert.deepEqual(results.actions.map((a) => ({ id: a.id, success: a.success, ...(a.error === undefined ? {} : { error: a.error }), truncated: a.returnDataTruncated })), scenario.outcomes);
    assert.equal(results.refundCreditWei.toString(), e.batch.refundCreditWei);
    const expected = scenarioIndex === 0 ? Array<boolean>(6).fill(true) : scenarioIndex === 3 ? [true, true, true] : [true, false, true];
    assert.deepEqual(results.actions.map((a) => a.success), expected);
    if (scenarioIndex === 3) assert.equal(results.actions[1]!.returnDataTruncated, true);
    assert.equal(results.refundCreditWei, scenarioIndex === 4 ? 1000n : 0n);
    checkTrace(traces[6 + scenarioIndex]!, e.batch.receipt, { nonce: 2 + scenarioIndex, to: summary.executor, data: prepared.batchCalldata, value: prepared.totalValue.toString() });
    if (scenarioIndex === 0) {
      assert.deepEqual(e.individual, baseline.individual);
      assert.deepEqual(e.comparison, summary.comparison);
      for (const [i, action] of actions.entries()) {
        const observed = baseline.individual.actions[i]!;
        assert.equal(observed.id, action.id);
        assert.equal(observed.target, action.target);
        assert.equal(observed.status, 'succeeded');
        checkTrace(traces[i]!, baseline.individual.receipts[i]!, { nonce: 2 + i, to: action.target, data: action.calldata, value: action.value.toString() });
      }
    }
  }
  const batchGas = BigInt(summary.comparison.batch.measuredGas.gas);
  assert.equal(batchGas, BigInt(summary.scenarios[0]!.receipt.gasUsed));
  assert(baselineGas > batchGas);
  assert.equal(summary.comparison.individual.transactionCount, 6);
  assert.equal(summary.comparison.batch.transactionCount, 1);
  assert.equal(summary.comparison.individual.measuredGas.receipts, 6);
  assert.equal(summary.comparison.batch.measuredGas.receipts, 1);
  assert.equal(summary.comparison.individual.measuredGas.measured, true);
  assert.equal(summary.comparison.batch.measuredGas.measured, true);
  assert.equal(summary.comparison.measuredSavings.gas, (baselineGas - batchGas).toString());
  assert.equal(summary.comparison.measuredSavings.fraction, Number((baselineGas - batchGas) * 1_000_000n / baselineGas) / 1_000_000);
  assert.equal(summary.comparison.transactionReduction.count, 5);
  assert.equal(summary.comparison.transactionReduction.fraction, 5 / 6);
  assert.equal(summary.comparison.baselineMethod, summary.baselineMethod);
  const withdrawal = verifySavedReceipt(summary.withdrawal.receipt, summary.withdrawal.rawReceipt);
  assert.equal(withdrawal.status, 'success');
  const withdrawData = encodeFunctionData({ abi: BATCH_EXECUTOR_ABI, functionName: 'withdrawRefund', args: [summary.sender] });
  checkTrace(traces[11]!, summary.withdrawal.receipt, { nonce: 7, to: summary.executor, data: withdrawData, value: '0' });
  const withdrawalLogs = savedReceiptLogs(summary.withdrawal.rawReceipt).filter((log) => log.address.toLowerCase() === summary.executor.toLowerCase());
  assert.equal(withdrawalLogs.length, 1);
  const event = decodeEventLog({ abi: BATCH_EXECUTOR_ABI, data: withdrawalLogs[0]!.data, topics: withdrawalLogs[0]!.topics, strict: true });
  assert.equal(event.eventName, 'RefundWithdrawn');
  if (event.eventName !== 'RefundWithdrawn') throw new Error('Missing withdrawal event.');
  assert.equal(event.args.sender.toLowerCase(), summary.sender.toLowerCase());
  assert.equal(event.args.recipient.toLowerCase(), summary.sender.toLowerCase());
  assert.equal(event.args.amount, 1000n);
  const hashes = [...summary.deploymentReceipts.map((d) => d.receipt.txHash), ...traces.map((t) => t.hash)];
  assert.equal(new Set(hashes).size, 14);
  const markdown = [
    '# Curated local EVM proof', '',
    '**Real disposable Anvil execution, chain 31337. NOT Atlantic explorer proof.**', '',
    `Source run: \`${summary.runId}\`. All local assertions passed; 14 transactions including setup/baseline/withdrawal.`, '',
    `Measured: **${baselineGas} gas / 6 individual transactions** vs **${batchGas} gas / 1 batch**.`,
    `Reduction: **${baselineGas - batchGas} gas (${(Number((baselineGas - batchGas) * 1_000_000n / baselineGas) / 10_000).toFixed(2)}%)**; **83.33% fewer execution transactions**.`, '',
    summary.baselineMethod, '',
    'The Anvil process is stopped. Baseline branch hashes were verified before evm_revert and are no longer queryable.',
    'Curating checks internal consistency and hashes; it does not re-query or claim a current canonical-chain/light-client proof.', '',
    '- [Summary and setup/withdrawal raw receipts](summary.json)',
    '- [Individual branch capture, including all six raw receipts](individual-before-snapshot-revert.json)',
    '- [SHA-256 file manifest](manifest.json)',
    ...summary.scenarios.map((s) => `- [${s.runId.slice(summary.runId.length + 1)} — per-action report](${s.runId}.md) / [complete JSON](${s.runId}.json)`),
    '', 'Generated submission traces and setup receipts are included; no signing key, environment file, or signed payload is present.', '',
  ].join('\n');
  files.set('README.md', Buffer.from(markdown, 'utf8'));
  const destination = path.resolve(import.meta.dirname, '..', 'evidence', 'local');
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination); // Refuse to overwrite any earlier curated/user proof.
  const manifestFiles: Array<{ path: string; sha256: string; bytes: number }> = [];
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const handle = await open(path.join(destination, name), 'wx');
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    manifestFiles.push({ path: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
  }
  await writePublicSnapshot(path.join(destination, 'manifest.json'), {
    schemaVersion: 1, classification: 'SAVED LOCAL EVM OBSERVATIONS — NOT ATLANTIC', sourceRunId: summary.runId,
    curatedAt: new Date().toISOString(), internallyChecked: true, currentRpcVerificationPerformed: false,
    baselineBranchDiscarded: true, files: manifestFiles,
  });
  console.log(`Curated ${files.size - 1} original local evidence files plus README/manifest at ${destination}. No current RPC query or Atlantic proof claimed.`);
}
main().catch(() => { console.error('Local evidence curation refused: source is incomplete/inconsistent/unsafe or the destination exists. No values echoed, current RPC queried, or existing proof overwritten.'); process.exitCode = 1; });
