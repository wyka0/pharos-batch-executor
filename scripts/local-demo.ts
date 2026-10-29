/** Explicit LOCAL-only demo. npm test/verify never invoke this file. */
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPublicClient, createTestClient, createWalletClient, defineChain, encodeFunctionData,
  getContractAddress, http, keccak256, toBytes, type Address,
  type Hash,
} from 'viem';

import { BATCH_EXECUTOR_ABI, TEST_ONLY_COUNTER_ABI } from '../src/abi.js';
import { EvmAdapter, type ApprovedSubmitter } from '../src/adapters/evm.js';
import { loadArtifact } from '../src/artifacts.js';
import { stringifyPublicJson, writeEvidence } from '../src/evidence.js';
import { runBatch } from '../src/executor.js';
import { writePublicSnapshot } from '../src/public-state.js';
import { verifyReceipt, verifyTransaction } from '../src/receipt.js';
import type { BatchActionInput, BatchRunEvidence } from '../src/types.js';
import { validateActions } from '../src/validation.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OWNER: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // PUBLIC disposable Anvil account, no key.
const localChain = defineChain({ id: 31337, name: 'Disposable local Anvil',
  nativeCurrency: { name: 'Local ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['http://127.0.0.1'] } }, testnet: true });

function wslPath(file: string): string {
  const match = /^([A-Za-z]):\/(.*)$/.exec(path.resolve(file).replaceAll('\\', '/'));
  if (!match) throw new Error('Expected a Windows drive path.');
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]}`;
}

async function startAnvil(port: number, directory: string) {
  const pidFile = path.join(directory, 'anvil.pid');
  const args = ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--gas-price', '10000000000', '--silent'];
  const binary = process.env.ANVIL_BIN ?? (process.platform === 'win32' ? '__default_anvil__' : 'anvil');
  const child = process.platform === 'win32'
    ? spawn('wsl.exe', ['-d', process.env.WSL_DISTRO ?? 'Ubuntu', '--', '/bin/bash', wslPath(path.join(ROOT, 'scripts', 'anvil-session.sh')), wslPath(pidFile), binary, ...args], { stdio: 'ignore', windowsHide: true })
    : spawn(binary, args, { stdio: 'ignore' });
  child.on('error', () => { console.error('Failed to start local Anvil; check ANVIL_BIN/WSL_DISTRO.'); });
  return { child, pidFile, port };
}

async function stopAnvil(session: { child: ChildProcess; pidFile: string; port: number }) {
  if (process.platform === 'win32') {
    try {
      const pid = (await readFile(session.pidFile, 'utf8')).trim();
      if (/^[1-9]\d{0,8}$/.test(pid)) {
        const cmdline = spawnSync('wsl.exe', ['-d', process.env.WSL_DISTRO ?? 'Ubuntu', '--', '/bin/cat', `/proc/${pid}/cmdline`], { encoding: 'utf8', windowsHide: true });
        if (cmdline.stdout?.includes(`--port\u0000${session.port}\u0000`) && cmdline.stdout.includes('anvil')) {
          spawnSync('wsl.exe', ['-d', process.env.WSL_DISTRO ?? 'Ubuntu', '--', '/bin/kill', '--', pid], { stdio: 'ignore', windowsHide: true });
        }
      }
    } catch { /* Process may have exited before PID collection. */ }
  }
  session.child.kill();
}

async function main() {
  const runId = `local_${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`;
  const directory = path.join(ROOT, 'evidence', 'runs', runId);
  await mkdir(directory, { recursive: true });
  const port = randomInt(28_000, 38_000);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const session = await startAnvil(port, directory);
  const transport = http(rpcUrl, { retryCount: 0, timeout: 3_000 });
  const client = createPublicClient({ chain: localChain, transport, pollingInterval: 100, cacheTime: 0 });
  const wallet = createWalletClient({ chain: localChain, account: OWNER, transport });
  const testClient = createTestClient({ mode: 'anvil', chain: localChain, transport });
  try {
    const deadline = Date.now() + 45_000;
    let ready = false;
    while (Date.now() < deadline && session.child.exitCode === null) {
      try { ready = await client.getChainId() === 31337; } catch { /* read-only startup poll */ }
      if (ready) break;
      await delay(200);
    }
    assert(ready && session.child.exitCode === null, 'Own local Anvil process must be running on chain 31337.');
    console.log('LOCAL EVM ONLY — real disposable-chain receipts; NOT Atlantic or mainnet.');
    await writePublicSnapshot(path.join(directory, 'metadata.json'), { classification: 'LOCAL ANVIL ONLY, NOT ATLANTIC', runId, rpcUrl, chainId: 31337, sender: OWNER });

    const deploymentReceipts: unknown[] = [];
    async function deploy(name: 'BatchExecutor' | 'TestOnlyCounter') {
      assert.equal(await client.getChainId(), 31337);
      const artifact = await loadArtifact(name);
      const nonce = await client.getTransactionCount({ address: OWNER, blockTag: 'pending' });
      const address = getContractAddress({ from: OWNER, nonce: BigInt(nonce) });
      const estimate = await client.estimateGas({ account: OWNER, data: artifact.bytecode });
      const hash = await wallet.sendTransaction({ data: artifact.bytecode, gas: (estimate * 12n + 9n) / 10n, gasPrice: await client.getGasPrice(), type: 'legacy', nonce });
      await writePublicSnapshot(path.join(directory, `setup_${name}.submitted.json`), { classification: 'LOCAL ANVIL ONLY', name, address, hash, nonce, bytecodeHash: artifact.bytecodeHash });
      const raw = await client.waitForTransactionReceipt({ hash });
      await writePublicSnapshot(path.join(directory, `setup_${name}.receipt.json`), raw);
      const block = await client.getBlock({ blockNumber: raw.blockNumber });
      const receipt = verifyReceipt(raw, hash, { currentBlockNumber: await client.getBlockNumber(), canonicalBlockHash: block.hash! });
      verifyTransaction(await client.getTransaction({ hash }), { hash, from: OWNER, data: artifact.bytecode, value: 0n, chainId: 31337, nonce });
      assert.equal(receipt.status, 'success');
      assert.equal(raw.contractAddress?.toLowerCase(), address.toLowerCase());
      assert.equal(keccak256((await client.getCode({ address }))!), artifact.runtimeCodeHash);
      deploymentReceipts.push({ name, address, receipt, rawReceipt: raw, bytecodeHash: artifact.bytecodeHash });
      return address;
    }
    const executor = await deploy('BatchExecutor');
    const target = await deploy('TestOnlyCounter');
    const artifact = await loadArtifact('BatchExecutor');

    let submissionIndex = 0;
    const submitter: ApprovedSubmitter = { async submit(request) {
      assert.equal(await client.getChainId(), 31337);
      const gasPrice = await client.getGasPrice();
      assert((await client.getBalance({ address: OWNER })) >= request.value + request.gas * gasPrice);
      const nonce = await client.getTransactionCount({ address: OWNER, blockTag: 'pending' });
      let hash: Hash | undefined;
      try {
        hash = await wallet.sendTransaction({ ...request, gasPrice, nonce, type: 'legacy' });
        await writePublicSnapshot(path.join(directory, `submission_${submissionIndex++}.json`), { classification: 'LOCAL ANVIL ONLY', hash, nonce, request, gasPrice });
        return { state: 'submitted', hash, nonce };
      } catch {
        // No send retry even on a disposable chain.
        return { state: 'unknown', ...(hash === undefined ? {} : { hash }), error: 'Local submission or persistence outcome unknown; no retry.' };
      }
    } };
    const adapter = new EvmAdapter({ id: 'local-anvil', rpcUrl, account: OWNER, batchExecutor: executor,
      expectedExecutorCodeHash: artifact.runtimeCodeHash, publicClient: client, submitter });
    const key = (name: string) => keccak256(toBytes(name));
    const writeAction = (name: string, value: bigint): BatchActionInput => ({
      id: name, target, independent: true,
      calldata: encodeFunctionData({ abi: TEST_ONLY_COUNTER_ABI, functionName: 'setValue', args: [key(name), value] }),
    });
    const readSlot = (name: string) => client.readContract({ address: target, abi: TEST_ONLY_COUNTER_ABI, functionName: 'slots', args: [key(name)] });

    // FAIR baseline: capture real receipts, then restore the exact pre-state.
    const actions = validateActions(Array.from({ length: 6 }, (_, i) => writeAction(`independent-${i}`, BigInt(i + 10))));
    const before = await client.getBlock({ blockTag: 'latest' });
    const snapshot = await testClient.snapshot();
    const individual = await adapter.executeIndividual(actions);
    await writeFile(path.join(directory, 'individual-before-snapshot-revert.json'), stringifyPublicJson({
      classification: 'Actual LOCAL receipts captured and verified before the snapshot was reverted. These hashes are not Atlantic evidence and are no longer queryable after branch removal.',
      beforeBlockHash: before.hash, beforeStateRoot: before.stateRoot, individual,
    }), { flag: 'wx' });
    assert.equal(individual.receipts.length, 6);
    assert(individual.actions.every((a) => a.success === true));
    await testClient.revert({ id: snapshot });
    const restored = await client.getBlock({ blockTag: 'latest' });
    assert.equal(restored.hash, before.hash);
    assert.equal(restored.stateRoot, before.stateRoot);
    for (const action of actions) assert.equal(await readSlot(action.id), 0n);

    const baselineMethod = 'LOCAL identical-state snapshot experiment: 6 real individual receipts captured before evm_revert, then 1 real batch from the restored block/state root. Baseline branch hashes are removed and are not current canonical-chain or Atlantic proof.';
    const success = await runBatch(adapter, actions, {
      mode: 'execute', runId: `${runId}_success`, rpcUrl, batchExecutorAddress: executor, individualResult: individual, baselineMethod,
    });
    await writeEvidence(success, directory);
    assert.equal(success.batch.state, 'confirmed');
    assert.equal(success.batch.actions.length, 6);
    assert.equal(success.comparison.batch.measuredGas?.receipts, 1);
    assert((success.comparison.measuredSavings?.gas ?? 0n) > 0n, 'Measured saving must be positive, not invented.');
    for (const [i, action] of actions.entries()) assert.equal(await readSlot(action.id), BigInt(i + 10));

    const scenarioEvidence: BatchRunEvidence[] = [success];
    async function scenario(label: string, middle: BatchActionInput, check: (e: BatchRunEvidence) => void) {
      const inputs = [writeAction(`${label}-before`, 101n), middle, writeAction(`${label}-after`, 303n)];
      const evidence = await runBatch(adapter, validateActions(inputs), { mode: 'execute', runId: `${runId}_${label}`, rpcUrl, batchExecutorAddress: executor });
      await writeEvidence(evidence, directory);
      assert.equal(evidence.batch.state, 'confirmed');
      assert.equal(await readSlot(`${label}-before`), 101n);
      assert.equal(await readSlot(`${label}-after`), 303n, 'Action AFTER failure must actually change chain state.');
      check(evidence);
      scenarioEvidence.push(evidence);
    }
    await scenario('mixed', { id: 'forced-failure', target, independent: true,
      calldata: encodeFunctionData({ abi: TEST_ONLY_COUNTER_ABI, functionName: 'fail' }) }, (e) => {
      assert.deepEqual(e.batch.actions.map((a) => a.success), [true, false, true]);
      assert.equal(e.batch.actions[1]?.error, 'TestOnly: forced failure');
      assert.equal(e.estimates.individual[1]?.gas, null);
      assert.equal(e.comparison.estimatedSavings, undefined);
    });
    await scenario('gas-isolation', { id: 'gas-exhaustion', target, independent: true, gasLimit: 25_000,
      calldata: encodeFunctionData({ abi: TEST_ONLY_COUNTER_ABI, functionName: 'burnGas' }) }, (e) => {
      assert.deepEqual(e.batch.actions.map((a) => a.success), [true, false, true]);
    });
    await scenario('return-cap', { id: 'large-return', target, independent: true,
      calldata: encodeFunctionData({ abi: TEST_ONLY_COUNTER_ABI, functionName: 'largeReturn', args: [16_384n] }) }, (e) => {
      assert.equal(e.batch.actions[1]?.success, true);
      assert.equal(e.batch.actions[1]?.returnDataTruncated, true);
      assert.equal(e.batch.actions[1]?.returnData?.length, 4098);
    });
    await scenario('refund-credit', { id: 'failed-value', target, independent: true, value: '1000',
      calldata: encodeFunctionData({ abi: TEST_ONLY_COUNTER_ABI, functionName: 'fail' }), note: 'Nonpayable target rejects value; caller receives a pull-refund credit.' }, (e) => {
      assert.deepEqual(e.batch.actions.map((a) => a.success), [true, false, true]);
      assert.equal(e.batch.refundCreditWei, 1000n);
    });
    assert.equal(await client.readContract({ address: executor, abi: BATCH_EXECUTOR_ABI, functionName: 'refundCredits', args: [OWNER] }), 1000n);
    const withdrawData = encodeFunctionData({ abi: BATCH_EXECUTOR_ABI, functionName: 'withdrawRefund', args: [OWNER] });
    const withdrawalEstimate = await client.estimateGas({ account: OWNER, to: executor, data: withdrawData });
    const withdrawal = await submitter.submit({ to: executor, data: withdrawData, value: 0n, gas: withdrawalEstimate * 2n });
    assert(withdrawal.hash);
    const withdrawRaw = await client.waitForTransactionReceipt({ hash: withdrawal.hash });
    const withdrawBlock = await client.getBlock({ blockNumber: withdrawRaw.blockNumber });
    const withdrawReceipt = verifyReceipt(withdrawRaw, withdrawal.hash, { currentBlockNumber: await client.getBlockNumber(), canonicalBlockHash: withdrawBlock.hash! });
    assert.equal(withdrawReceipt.status, 'success');
    assert.equal(await client.readContract({ address: executor, abi: BATCH_EXECUTOR_ABI, functionName: 'refundCredits', args: [OWNER] }), 0n);

    const summary = {
      classification: 'REAL LOCAL EVM ONLY — NOT ATLANTIC. All assertions passed.',
      runId, chainId: 31337, sender: OWNER, executor, testOnlyTarget: target,
      setupTransactions: 2, baselineTransactions: 6, demonstrationBatchTransactions: 5, refundWithdrawalTransactions: 1,
      totalSubmittedLocalTransactions: 14,
      baselineMethod, restoredStateRoot: restored.stateRoot, restoredBlockHash: restored.hash,
      comparison: success.comparison,
      scenarios: scenarioEvidence.map((e) => ({ runId: e.runId, transactionHash: e.batch.transactionHash, receipt: e.batch.receipt,
        outcomes: e.batch.actions.map((a) => ({ id: a.id, success: a.success, error: a.error, truncated: a.returnDataTruncated })) })),
      deploymentReceipts, withdrawal: { receipt: withdrawReceipt, rawReceipt: withdrawRaw },
    };
    await writeFile(path.join(directory, 'summary.json'), `${stringifyPublicJson(summary)}\n`, { flag: 'wx' });
    console.log(`Measured baseline: ${success.comparison.individual.measuredGas?.gas} gas / 6 transactions.`);
    console.log(`Measured batch: ${success.comparison.batch.measuredGas?.gas} gas / 1 transaction.`);
    console.log(`Measured saving: ${success.comparison.measuredSavings?.gas} gas (${((success.comparison.measuredSavings?.fraction ?? 0) * 100).toFixed(2)}%).`);
    console.log('Five scenarios passed: success, mixed failure, gas isolation, return cap, refund credit + withdrawal.');
    console.log(`Complete local evidence: ${directory}`);
  } finally { await stopAnvil(session); }
}

main().catch((error: unknown) => {
  // Local-only harness: no secret or signing key is ever loaded here.
  console.error(error instanceof Error ? error.message : 'Local demonstration failed.');
  console.error('No Atlantic transaction was sent; any collected local evidence is preserved.');
  process.exitCode = 1;
});
