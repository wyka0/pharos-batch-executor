#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPublicClient, encodeFunctionData, http, keccak256, toBytes } from 'viem';

import { TEST_ONLY_COUNTER_ABI } from './abi.js';
import { EvmAdapter } from './adapters/evm.js';
import { SimulatedAdapter } from './adapters/simulated.js';
import { loadArtifact } from './artifacts.js';
import { renderEvidenceMarkdown, stringifyPublicJson, writeEvidence } from './evidence.js';
import { runBatch } from './executor.js';
import { ATLANTIC, ATLANTIC_CHAIN } from './network.js';
import { preparePlan } from './plan.js';
import type { BatchActionInput } from './types.js';
import { validateActions, validateAddress } from './validation.js';

const HELP = `Pharos Batch Executor — dry-run by default, Atlantic Testnet only.

Commands:
  demo [--scenario success|mixed|all-fail]     Zero-network model; no wallet
  validate --actions <JSON array file>        Strict input validation
  plan --actions <file>                      Prepare one transaction's calldata
  simulate --actions <file> --sender <addr> --executor <addr>
                                             Read-only Atlantic eth_call / gas
Options: --out <evidence directory>, --help

Real broadcasts are a SEPARATE, plan-hash-gated command: npm run testnet:run.
Never pass a key, mnemonic, secret RPC URL, or environment file to this CLI.
`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    actions: { type: 'string' }, sender: { type: 'string' }, executor: { type: 'string' },
    scenario: { type: 'string', default: 'mixed' }, out: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help || positionals.length === 0) { console.log(HELP); return; }
  if (positionals.length !== 1) throw new Error('Expected one command.');
  const command = positionals[0];
  if (command === 'demo') {
    if (!['success', 'mixed', 'all-fail'].includes(values.scenario!)) throw new Error('Unknown demo scenario.');
    const inputs: BatchActionInput[] = ['a', 'b', 'c'].map((id, i) => ({
      id: `model-${id}`, target: '0x1111111111111111111111111111111111111111', independent: true,
      calldata: encodeFunctionData({ abi: TEST_ONLY_COUNTER_ABI, functionName: 'setValue', args: [keccak256(toBytes(id)), BigInt(i + 1)] }),
      note: 'MODEL target only, not a deployed contract.',
    }));
    const failures = values.scenario === 'success' ? [] : values.scenario === 'mixed' ? ['model-b'] : inputs.map((a) => a.id);
    const adapter = new SimulatedAdapter({ failureReasons: new Map(failures.map((id) => [id, 'Forced MODEL failure'])) });
    const actions = validateActions(inputs);
    const evidence = await runBatch(adapter, actions, {
      individualResult: await adapter.executeIndividual(actions), baselineMethod: 'Deterministic MODEL ONLY; no measured gas or blockchain receipts.',
    });
    console.log(renderEvidenceMarkdown(evidence));
    const files = await writeEvidence(evidence, values.out);
    console.log(`Evidence: ${files.jsonPath}`);
    return;
  }
  if (!['validate', 'plan', 'simulate'].includes(command!)) throw new Error('Unknown command; use --help.');
  if (!values.actions) throw new Error('--actions <JSON array file> is required.');
  if ((await stat(values.actions)).size > 1_000_000) throw new Error('Action file exceeds 1 MB limit.');
  const actions = validateActions(JSON.parse(await readFile(values.actions, 'utf8')) as unknown);
  if (command === 'validate') { console.log(`Validated ${actions.length} caller-declared independent actions.`); return; }
  if (command === 'plan') {
    const plan = preparePlan(actions);
    console.log(stringifyPublicJson({ ...plan, disclosure: 'Unsigned calldata only. Not simulated, signed, submitted or confirmed.' }));
    return;
  }
  const sender = validateAddress(values.sender, '--sender');
  const executor = validateAddress(values.executor, '--executor');
  const artifact = await loadArtifact('BatchExecutor');
  const publicClient = createPublicClient({ chain: ATLANTIC_CHAIN, cacheTime: 0, transport: http(ATLANTIC.rpcUrl, { retryCount: 0, timeout: 20_000 }) });
  const adapter = new EvmAdapter({ id: 'atlantic-testnet', rpcUrl: ATLANTIC.rpcUrl, account: sender,
    batchExecutor: executor, expectedExecutorCodeHash: artifact.runtimeCodeHash, publicClient });
  const evidence = await runBatch(adapter, actions, { rpcUrl: ATLANTIC.rpcUrl, batchExecutorAddress: executor });
  console.log(renderEvidenceMarkdown(evidence));
  console.log(`Evidence: ${(await writeEvidence(evidence, values.out)).jsonPath}`);
  if (evidence.batch.state === 'not_submitted' || evidence.estimates.batch.gas === null) process.exitCode = 1;
}

// This entrypoint is not imported by the library; no import-time execution.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Command failed.');
    process.exitCode = 1;
  });
}
