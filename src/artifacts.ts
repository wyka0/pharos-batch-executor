import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { keccak256, type Abi, type Hex } from 'viem';

export interface ContractArtifact {
  contractName: string; source: string; sourceHash: string; compiler: string; evmVersion: string;
  optimizerRuns: number; abi: Abi; bytecode: Hex; runtimeBytecode: Hex;
  runtimeCodeHash: Hex; bytecodeHash: Hex;
}

export async function loadArtifact(name: 'BatchExecutor' | 'TestOnlyCounter'): Promise<ContractArtifact> {
  // Both src/*.ts and dist/*.js are one directory below the package root.
  const base = new URL('../', import.meta.url);
  const artifact = JSON.parse(await readFile(new URL(`artifacts/${name}.json`, base), 'utf8')) as ContractArtifact;
  const expectedSource = name === 'BatchExecutor' ? 'contracts/BatchExecutor.sol' : 'contracts/test-only/TestOnlyCounter.sol';
  if (artifact.source !== expectedSource || artifact.optimizerRuns !== 200) throw new Error('Unexpected artifact source or optimizer configuration.');
  const source = await readFile(fileURLToPath(new URL(artifact.source, base)));
  const hash = `sha256:${createHash('sha256').update(source).digest('hex')}`;
  if (artifact.contractName !== name || artifact.sourceHash !== hash || artifact.compiler !== 'solc-0.8.24' || artifact.evmVersion !== 'paris' ||
    artifact.runtimeCodeHash !== keccak256(artifact.runtimeBytecode) || artifact.bytecodeHash !== keccak256(artifact.bytecode)) {
    throw new Error('Contract artifact is stale or inconsistent; run npm run contracts:build.');
  }
  return artifact;
}
