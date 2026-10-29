import { randomUUID } from 'node:crypto';
import { mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { stringifyPublicJson } from './evidence.js';

/** Fsynced atomic update of an explicit public state file; keep crash leftovers. */
export async function writePublicState(file: string, value: unknown): Promise<void> {
  const data = `${stringifyPublicJson(value)}\n`;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.pending`;
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
}

/** Immutable, durable evidence snapshot; refuses any existing file. */
export async function writePublicSnapshot(file: string, value: unknown): Promise<void> {
  const data = `${stringifyPublicJson(value)}\n`;
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, 'wx');
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}
