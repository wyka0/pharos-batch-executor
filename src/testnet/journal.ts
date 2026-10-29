import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isAddress, type Address } from 'viem';
import { ExecutionGateError } from '../errors.js';
import { stringifyPublicJson } from '../evidence.js';

export interface JournalEntry {
  at: string; planHash: string; index: number; id: string;
  state: 'INTENT' | 'SUBMITTED' | 'CONFIRMED' | 'REVERTED' | 'UNKNOWN' | 'UNVERIFIED' | 'ABORTED_BEFORE_SEND';
  transactionHash: `0x${string}`;
  nonce: number;
  receipt?: unknown;
  error?: string;
}

export class ExecutionJournal {
  readonly file: string;
  private readonly lockFile: string;
  private readonly planHash: string;
  private readonly ownedLocks: string[] = [];
  private sender?: Address;

  constructor(directory: string, planHash: string) {
    if (!/^sha256:[0-9a-f]{64}$/.test(planHash)) throw new ExecutionGateError('Invalid journal plan hash.');
    this.file = path.join(directory, `${planHash.slice(7)}.ndjson`);
    this.lockFile = `${this.file}.lock`;
    this.planHash = planHash;
  }

  async acquire(sender?: Address, nonces: readonly number[] = []): Promise<void> {
    if (this.ownedLocks.length !== 0) throw new ExecutionGateError('Journal is already acquired.');
    if (sender !== undefined && !isAddress(sender)) throw new ExecutionGateError('Invalid journal sender.');
    if (nonces.some((nonce) => !Number.isSafeInteger(nonce) || nonce < 0)) throw new ExecutionGateError('Invalid journal nonce.');
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      for (const file of [this.lockFile, ...(sender === undefined ? [] : [path.join(path.dirname(this.file), `sender_${sender.toLowerCase()}.lock`)])]) {
        const handle = await open(file, 'wx');
        this.ownedLocks.push(file);
        try { await handle.writeFile(`${process.pid}\n`); await handle.sync(); } finally { await handle.close(); }
      }
      this.sender = sender;
      if ((await this.read()).length !== 0) throw new ExecutionGateError('This plan already has an execution intent. Reconcile existing hashes; never retry the plan.');
      for (const nonce of nonces) {
        try { await stat(this.intentFile(nonce)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        throw new ExecutionGateError('This sender/nonce already has an intent, possibly from another plan. Reconcile; do not create a replacement plan to retry.');
      }
    } catch (error) {
      await this.release();
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ExecutionGateError('Execution lock exists; reconcile instead of resubmitting or deleting locks blindly.');
      throw error;
    }
  }

  async append(entry: JournalEntry): Promise<void> {
    if (this.ownedLocks.length === 0) throw new ExecutionGateError('Journal lock required before submission.');
    validateJournalSequence([...(await this.read()), entry], this.planHash);
    const data = stringifyPublicJson(entry);
    // Never store raw signed payloads, private keys, environment contents, or
    // exception objects. Only explicitly shaped public evidence goes here.
    if (entry.state === 'INTENT' && this.sender !== undefined) {
      // An immutable sender/nonce marker also blocks a NEW plan from retrying
      // an uncertain attempt. Retain it even if subsequent persistence fails.
      const marker = await open(this.intentFile(entry.nonce), 'wx');
      try { await marker.writeFile(`${data}\n`); await marker.sync(); } finally { await marker.close(); }
    }
    const handle = await open(this.file, 'a');
    try {
      await handle.writeFile(`${data.replace(/\n\s*/g, '')}\n`);
      await handle.sync();
    }
    finally { await handle.close(); }
  }

  async read(): Promise<JournalEntry[]> {
    let contents: string;
    try {
      if ((await stat(this.file)).size > 10_000_000) throw new ExecutionGateError('Journal exceeds the safety read limit.');
      contents = await readFile(this.file, 'utf8');
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      if (contents !== '' && !contents.endsWith('\n')) throw new Error('partial append');
      const entries = contents.split('\n').filter(Boolean).map((line) => JSON.parse(line) as JournalEntry);
      validateJournalSequence(entries, this.planHash);
      return entries;
    }
    catch { throw new ExecutionGateError('Journal is incomplete or corrupt; manual reconciliation required, not a send retry.'); }
  }

  async release(): Promise<void> {
    for (const file of this.ownedLocks.splice(0).reverse()) await unlink(file);
    this.sender = undefined;
  }

  private intentFile(nonce: number): string {
    return path.join(path.dirname(this.file), `intent_${this.sender!.toLowerCase()}_${nonce}.json`);
  }
}

function validateEntry(entry: JournalEntry, planHash: string): void {
  const fields = ['at', 'planHash', 'index', 'id', 'state', 'transactionHash', 'nonce', 'receipt', 'error'];
  if (entry === null || typeof entry !== 'object' || Object.keys(entry).some((key) => !fields.includes(key)) ||
    entry.planHash !== planHash || !Number.isSafeInteger(entry.index) || entry.index < 0 || !Number.isSafeInteger(entry.nonce) || entry.nonce < 0 ||
    typeof entry.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(entry.id) || typeof entry.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(entry.transactionHash) ||
    typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at)) || (entry.error !== undefined && typeof entry.error !== 'string') ||
    !['INTENT', 'SUBMITTED', 'CONFIRMED', 'REVERTED', 'UNKNOWN', 'UNVERIFIED', 'ABORTED_BEFORE_SEND'].includes(entry.state) ||
    (entry.state === 'ABORTED_BEFORE_SEND' && entry.receipt !== undefined)) {
    throw new ExecutionGateError('Invalid or unsafe journal entry.');
  }
}

/** Abort is terminal and can follow only an unsent INTENT, never SUBMITTED. */
export function validateJournalSequence(entries: readonly JournalEntry[], planHash: string): void {
  const latest = new Map<number, JournalEntry>();
  const hashes = new Set<string>();
  const nonces = new Set<number>();
  const ids = new Set<string>();
  for (const entry of entries) {
    validateEntry(entry, planHash);
    const previous = latest.get(entry.index);
    if (previous === undefined) {
      if (entry.state !== 'INTENT' || hashes.has(entry.transactionHash.toLowerCase()) || nonces.has(entry.nonce) || ids.has(entry.id)) {
        throw new ExecutionGateError('Journal intent/hash/state sequence is inconsistent; manual investigation required.');
      }
      hashes.add(entry.transactionHash.toLowerCase()); nonces.add(entry.nonce); ids.add(entry.id);
    } else {
      const allowed: readonly JournalEntry['state'][] = previous.state === 'INTENT' ? ['SUBMITTED', 'UNKNOWN', 'ABORTED_BEFORE_SEND']
        : previous.state === 'SUBMITTED' ? ['CONFIRMED', 'REVERTED', 'UNKNOWN', 'UNVERIFIED'] : [];
      if (entry.id !== previous.id || entry.nonce !== previous.nonce || entry.transactionHash.toLowerCase() !== previous.transactionHash.toLowerCase() || !allowed.includes(entry.state)) {
        throw new ExecutionGateError('Journal intent/hash/state sequence is inconsistent; manual investigation required.');
      }
    }
    latest.set(entry.index, entry);
  }
}
