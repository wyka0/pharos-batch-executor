import { rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionJournal } from '../src/testnet/journal.js';
import { HASH } from './receipt-fixtures.js';
import { ACCOUNT } from './fixtures.js';
import { testTempDirectory } from './temp.js';

const directories: string[] = [];
const planHash = `sha256:${'aa'.repeat(32)}`;
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('durable execution journal', () => {
  it('requires exclusive ownership and persists intent before an attempted submission', async () => {
    const dir = await testTempDirectory(); directories.push(dir);
    const first = new ExecutionJournal(dir, planHash);
    const second = new ExecutionJournal(dir, planHash);
    await first.acquire();
    await expect(second.acquire()).rejects.toThrow(/lock exists/);
    await first.append({ at: new Date().toISOString(), planHash, index: 0, id: 'fixture', state: 'INTENT', transactionHash: HASH, nonce: 1 });
    await first.release();
    expect((await second.read())[0]?.state).toBe('INTENT');
    await expect(second.acquire()).rejects.toThrow(/already has an execution intent/);
  });

  it('refuses corrupt journals rather than clearing them or submitting again', async () => {
    const dir = await testTempDirectory(); directories.push(dir);
    const journal = new ExecutionJournal(dir, planHash);
    await writeFile(journal.file, '{incomplete');
    await expect(journal.acquire()).rejects.toThrow(/corrupt/);
  });

  it('requires an owned lock for append and rejects unsafe hash/path inputs', async () => {
    const dir = await testTempDirectory(); directories.push(dir);
    const journal = new ExecutionJournal(dir, planHash);
    await expect(journal.append({ at: '', planHash, index: 0, id: '', state: 'INTENT', transactionHash: HASH, nonce: 0 })).rejects.toThrow(/lock required/);
    expect(() => new ExecutionJournal(dir, '../escape')).toThrow(/hash/);
  });

  it('locks the sender across different plans and retains sender/nonce intents', async () => {
    const dir = await testTempDirectory(); directories.push(dir);
    const first = new ExecutionJournal(dir, planHash);
    const otherHash = `sha256:${'bb'.repeat(32)}`;
    const second = new ExecutionJournal(dir, otherHash);
    await first.acquire(ACCOUNT, [1]);
    await expect(second.acquire(ACCOUNT, [1])).rejects.toThrow(/lock exists/);
    await first.append({ at: new Date().toISOString(), planHash, index: 0, id: 'fixture', state: 'INTENT', transactionHash: HASH, nonce: 1 });
    await first.release();
    await expect(second.acquire(ACCOUNT, [1])).rejects.toThrow(/sender\/nonce already has an intent/);
    await second.acquire(ACCOUNT, [2]);
    await second.release();
  });
});
