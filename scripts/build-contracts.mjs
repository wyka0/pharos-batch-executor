import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { keccak256 } from 'viem';
import { root, runForge } from './tooling.mjs';

runForge(['build']);
await mkdir(path.join(root, 'artifacts'), { recursive: true });
for (const [name, source] of [
  ['BatchExecutor', 'contracts/BatchExecutor.sol'],
  ['TestOnlyCounter', 'contracts/test-only/TestOnlyCounter.sol'],
]) {
  const artifact = JSON.parse(await readFile(path.join(root, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
  const sourceHash = `sha256:${createHash('sha256').update(await readFile(path.join(root, source))).digest('hex')}`;
  const exported = {
    contractName: name, source, sourceHash,
    compiler: 'solc-0.8.24', evmVersion: 'paris', optimizerRuns: 200,
    abi: artifact.abi, bytecode: artifact.bytecode.object, runtimeBytecode: artifact.deployedBytecode.object,
    runtimeCodeHash: keccak256(artifact.deployedBytecode.object),
    bytecodeHash: keccak256(artifact.bytecode.object),
  };
  await writeFile(path.join(root, 'artifacts', `${name}.json`), `${JSON.stringify(exported, null, 2)}\n`);
  console.log(`${name}: source-bound artifact exported; runtime ${((exported.runtimeBytecode.length - 2) / 2)} bytes.`);
}
