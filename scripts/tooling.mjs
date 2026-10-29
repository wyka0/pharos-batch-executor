import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');

export function wslPath(file) {
  const normalized = path.resolve(file).replaceAll('\\', '/');
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) throw new Error('Expected an absolute Windows drive path.');
  return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
}

export function runForge(args) {
  const windows = process.platform === 'win32';
  const command = windows ? 'wsl.exe' : (process.env.FORGE_BIN ?? 'forge');
  const toolArgs = windows
    ? ['-d', process.env.WSL_DISTRO ?? 'Ubuntu', '--', ...(process.env.FORGE_BIN
      ? [process.env.FORGE_BIN]
      : ['/bin/bash', wslPath(path.join(root, 'scripts', 'forge-session.sh'))]), ...args, '--root', wslPath(root)]
    : [...args, '--root', root];
  const result = spawnSync(command, toolArgs, { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error(`Foundry failed (exit ${result.status ?? 'unknown'}).`);
}
