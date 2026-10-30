import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ExecutionGateError } from '../errors.js';
import { assertPublicData } from '../safety.js';

/** Public JSON only. In particular, never open an environment file as a plan. */
export async function readPublicJson(file: string, optional = false): Promise<unknown> {
  if (path.extname(file) !== '.json' || /^(?:\.env(?:\..*)?|.*\.env)$/i.test(path.basename(file))) {
    throw new ExecutionGateError('An explicit public .json file is required. Environment files are not public input.');
  }
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1_000_000) throw new Error('unsafe public file');
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    assertPublicData(value);
    return value;
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ExecutionGateError('Public JSON is missing, oversized, unsafe or corrupt; its contents were not logged.');
  }
}
