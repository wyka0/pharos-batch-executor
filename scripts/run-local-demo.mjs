import { spawnSync } from 'node:child_process';
import { root } from './tooling.mjs';

for (const args of [['scripts/build-contracts.mjs'], ['--import', 'tsx', 'scripts/local-demo.ts']]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
}
