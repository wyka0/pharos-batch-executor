import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Each test owns a unique approved temporary directory; no user data. */
export async function testTempDirectory() {
  const base = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, 'pharos-batch-test-'));
}
