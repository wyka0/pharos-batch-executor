import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionJournal, type JournalEntry } from '../src/testnet/journal.js';
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

  it('retains an aborted INTENT and immutable sender/nonce marker across plans', async () => {
    const dir = await testTempDirectory(); directories.push(dir);
    const journal = new ExecutionJournal(dir, planHash);
    const intent: JournalEntry = { at: new Date().toISOString(), planHash, index: 0, id: 'fixture', state: 'INTENT', transactionHash: HASH, nonce: 1 };
    await journal.acquire(ACCOUNT, [1]);
    await journal.append(intent);
    await journal.append({ ...intent, state: 'ABORTED_BEFORE_SEND', error: 'Fixture final guard expired; no send attempted.' });
    await journal.release();
    expect((await journal.read()).map((entry) => entry.state)).toEqual(['INTENT', 'ABORTED_BEFORE_SEND']);
    const marker = (await readdir(dir)).find((name) => name.startsWith('intent_'))!;
    expect(JSON.parse(await readFile(path.join(dir, marker), 'utf8'))).toEqual(intent);
    await expect(new ExecutionJournal(dir, planHash).acquire(ACCOUNT, [1])).rejects.toThrow(/execution intent/);
    await expect(new ExecutionJournal(dir, `sha256:${'bb'.repeat(32)}`).acquire(ACCOUNT, [1])).rejects.toThrow(/sender\/nonce already has an intent/);
  });

  it.each(['INTENT', 'SUBMITTED', 'CONFIRMED', 'REVERTED', 'UNKNOWN', 'UNVERIFIED'] as const)('rejects %s after a terminal pre-send abort', async (state) => {
    const dir = await testTempDirectory(); directories.push(dir);
    const journal = new ExecutionJournal(dir, planHash);
    const intent: JournalEntry = { at: new Date().toISOString(), planHash, index: 0, id: 'fixture', state: 'INTENT', transactionHash: HASH, nonce: 1 };
    await journal.acquire(ACCOUNT, [1]);
    await journal.append(intent);
    await journal.append({ ...intent, state: 'ABORTED_BEFORE_SEND' });
    await expect(journal.append({ ...intent, state })).rejects.toThrow(/sequence is inconsistent/);
    expect((await journal.read()).map((entry) => entry.state)).toEqual(['INTENT', 'ABORTED_BEFORE_SEND']);
    await journal.release();
  });

  it('cannot relabel a submitted transaction as aborted before send', async () => {
    const dir = await testTempDirectory(); directories.push(dir);
    const journal = new ExecutionJournal(dir, planHash);
    const intent: JournalEntry = { at: new Date().toISOString(), planHash, index: 0, id: 'fixture', state: 'INTENT', transactionHash: HASH, nonce: 1 };
    await journal.acquire();
    await journal.append(intent);
    await journal.append({ ...intent, state: 'SUBMITTED' });
    await expect(journal.append({ ...intent, state: 'ABORTED_BEFORE_SEND' })).rejects.toThrow(/sequence is inconsistent/);
    await journal.release();
  });

  it('refuses a corrupt saved abort transition and does not clear it', async () => {
    const dir = await testTempDirectory(); directories.push(dir);
    const journal = new ExecutionJournal(dir, planHash);
    const intent: JournalEntry = { at: new Date().toISOString(), planHash, index: 0, id: 'fixture', state: 'INTENT', transactionHash: HASH, nonce: 1 };
    const contents = [intent, { ...intent, state: 'SUBMITTED' }, { ...intent, state: 'ABORTED_BEFORE_SEND' }].map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await writeFile(journal.file, contents);
    await expect(journal.read()).rejects.toThrow(/corrupt/);
    expect(await readFile(journal.file, 'utf8')).toBe(contents);
  });

  it('an aborted-before-send record cannot contain a mined receipt', async () => {
    const dir = await testTempDirectory(); directories.push(dir);
    const journal = new ExecutionJournal(dir, planHash);
    const intent: JournalEntry = { at: new Date().toISOString(), planHash, index: 0, id: 'fixture', state: 'INTENT', transactionHash: HASH, nonce: 1 };
    await journal.acquire();
    await journal.append(intent);
    await expect(journal.append({ ...intent, state: 'ABORTED_BEFORE_SEND', receipt: { gasUsed: '1' } })).rejects.toThrow(/Invalid or unsafe/);
    await journal.release();
  });
});
