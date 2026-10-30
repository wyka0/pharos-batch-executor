import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { isAddress, type Address } from 'viem';
import { ExecutionGateError } from '../errors.js';
import { stringifyPublicJson } from '../evidence.js';
import { writePublicSnapshot } from '../public-state.js';
import { broadcastPlanHash, type BroadcastPlan } from './broadcast-plan.js';
import { readPublicJson } from './public-files.js';
import type { ReconciliationEvidence } from './reconcile.js';

export interface JournalEntry {
  at: string; planHash: string; index: number; id: string;
  state: 'INTENT' | 'SUBMITTED' | 'CONFIRMED' | 'REVERTED' | 'UNKNOWN' | 'UNVERIFIED' | 'ABORTED_BEFORE_SEND';
  transactionHash: `0x${string}`;
  nonce: number;
  receipt?: unknown;
  error?: string;
}

export class ExecutionJournal {
  readonly directory: string;
  readonly file: string;
  private readonly lockFile: string;
  private readonly planHash: string;
  private readonly ownedLocks: string[] = [];
  private sender?: Address;
  private readonly lockToken = randomUUID();

  constructor(directory: string, planHash: string) {
    if (!/^sha256:[0-9a-f]{64}$/.test(planHash)) throw new ExecutionGateError('Invalid journal plan hash.');
    this.directory = path.resolve(directory);
    this.file = path.join(this.directory, `${planHash.slice(7)}.ndjson`);
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
        try { await handle.writeFile(JSON.stringify({ schemaVersion: 2, pid: process.pid, host: hostname(), planHash: this.planHash, token: this.lockToken })); await handle.sync(); } finally { await handle.close(); }
      }
      this.sender = sender;
      if ((await this.read()).length !== 0) throw new ExecutionGateError('This plan already has an execution intent. Reconcile existing hashes; never retry the plan.');
      if (await this.readApprovalState() !== 'UNUSED') throw new ExecutionGateError('This approval was already consumed. Reconcile; do not reuse it.');
      for (const nonce of nonces) {
        for (const file of [this.intentFile(nonce), this.reservationFile(nonce)]) {
          try { await stat(file); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
          throw new ExecutionGateError('This sender/nonce already has an intent or approval reservation. Reconcile; do not create a replacement plan to retry.');
        }
      }
    } catch (error) {
      await this.release();
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ExecutionGateError('Execution lock exists; reconcile instead of resubmitting or deleting locks blindly.');
      throw error;
    }
  }

  /** Consumes explicit approval durably BEFORE key loading, even if signing fails. */
  async claimApproval(plan: BroadcastPlan, at: string): Promise<void> {
    this.assertPlan(plan);
    if (this.ownedLocks.length === 0 || this.sender?.toLowerCase() !== plan.sender.toLowerCase()) throw new ExecutionGateError('Sender lock required before approval consumption.');
    const claim = { schemaVersion: 1, state: 'CLAIMED', at, planHash: this.planHash, plan };
    await writePublicSnapshot(this.approvalFile(), claim);
    for (const tx of plan.transactions) await writePublicSnapshot(this.reservationFile(tx.nonce), {
      schemaVersion: 1, state: 'APPROVAL_RESERVED', at, planHash: this.planHash, sender: plan.sender, nonce: tx.nonce,
    });
  }

  assertPlan(plan: BroadcastPlan): void {
    if (broadcastPlanHash(plan) !== this.planHash) throw new ExecutionGateError('Journal does not belong to the approved plan.');
  }

  async abortBeforeIntent(at: string): Promise<void> {
    if (this.ownedLocks.length === 0 || await this.readApprovalState() !== 'CLAIMED') return;
    await writePublicSnapshot(this.abortFile(), { schemaVersion: 1, state: 'ABORTED_BEFORE_SEND', at, planHash: this.planHash });
  }

  async readApprovalState(): Promise<'UNUSED' | 'CLAIMED' | 'ABORTED_BEFORE_SEND'> {
    const claim = await readPublicJson(this.approvalFile(), true) as { planHash?: string; state?: string; plan?: BroadcastPlan } | undefined;
    if (claim === undefined) return 'UNUSED';
    if (claim?.planHash !== this.planHash || claim.state !== 'CLAIMED' || claim.plan === undefined || broadcastPlanHash(claim.plan) !== this.planHash) throw new ExecutionGateError('Approval consumption record is corrupt; do not retry.');
    const abort = await readPublicJson(this.abortFile(), true) as { planHash?: string; state?: string } | undefined;
    if (abort === undefined) return 'CLAIMED';
    if (abort?.planHash !== this.planHash || abort.state !== 'ABORTED_BEFORE_SEND') throw new ExecutionGateError('Terminal approval abort record is corrupt.');
    return 'ABORTED_BEFORE_SEND';
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
    return this.readEntries(false);
  }

  /** Read-only crash recovery: never repairs/truncates a journal or frees a nonce. */
  async readForReconciliation(plan: BroadcastPlan): Promise<JournalEntry[]> {
    this.assertPlan(plan);
    const entries = await this.readEntries(true);
    for (const [index, tx] of plan.transactions.entries()) {
      const file = path.join(this.directory, `intent_${plan.sender.toLowerCase()}_${tx.nonce}.json`);
      const marker = await readPublicJson(file, true) as JournalEntry | undefined;
      if (marker === undefined) continue;
      validateEntry(marker, this.planHash);
      if (marker.state !== 'INTENT' || marker.index !== index || marker.nonce !== tx.nonce || marker.id !== tx.id) throw new ExecutionGateError('Nonce marker conflicts with the plan; manual reconciliation required.');
      const recorded = entries.find((entry) => entry.index === index);
      if (recorded !== undefined && recorded.transactionHash.toLowerCase() !== marker.transactionHash.toLowerCase()) throw new ExecutionGateError('Journal and immutable nonce marker hashes conflict.');
      if (recorded === undefined) entries.push(marker);
    }
    validateJournalSequence(entries, this.planHash);
    return entries;
  }

  private async readEntries(allowPartialTail: boolean): Promise<JournalEntry[]> {
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
      if (contents !== '' && !contents.endsWith('\n')) {
        if (!allowPartialTail) throw new Error('partial append');
        contents = contents.slice(0, contents.lastIndexOf('\n') + 1);
      }
      const entries = contents.split('\n').filter(Boolean).map((line) => JSON.parse(line) as JournalEntry);
      validateJournalSequence(entries, this.planHash);
      return entries;
    }
    catch { throw new ExecutionGateError('Journal is incomplete or corrupt; manual reconciliation required, not a send retry.'); }
  }

  /** Explicit recovery only, after the caller has freshly verified completion. */
  async releaseCompletedLocks(plan: BroadcastPlan, completion: ReconciliationEvidence): Promise<void> {
    this.assertPlan(plan);
    if (plan.schemaVersion !== 2 || completion.planHash !== this.planHash || !completion.allTransactionsConfirmed || completion.unresolvedHashes ||
      completion.steps.length !== plan.transactions.length || completion.steps.some((step) => step.state !== 'CONFIRMED' || step.receipt?.status !== 'success')) {
      throw new ExecutionGateError('Explicit lock recovery requires freshly verified completion of this exact v2 plan.');
    }
    const files = [this.lockFile, path.join(this.directory, `sender_${plan.sender.toLowerCase()}.lock`)];
    const existing: Array<{ file: string; text: string }> = [];
    for (const file of files) {
      let text: string;
      try { if ((await stat(file)).size > 4096) throw new Error('oversized lock'); text = await readFile(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new ExecutionGateError('Lock cannot be safely inspected.'); }
      try {
        const owner = JSON.parse(text) as { schemaVersion: number; pid: number; host: string; planHash: string; token: string };
        if (owner.schemaVersion !== 2 || owner.host !== hostname() || owner.planHash !== this.planHash || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') throw new Error('unknown owner');
        let dead = false;
        try { process.kill(owner.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        if (!dead) throw new Error('owner may be alive');
      } catch { throw new ExecutionGateError('Lock owner is alive, foreign, legacy or unverifiable. No locks removed.'); }
      existing.push({ file, text });
    }
    for (const entry of existing) {
      if (await readFile(entry.file, 'utf8') !== entry.text) throw new ExecutionGateError('Lock changed during explicit recovery.');
      await unlink(entry.file);
    }
  }

  async release(): Promise<void> {
    for (const file of this.ownedLocks.splice(0).reverse()) await unlink(file);
    this.sender = undefined;
  }

  private intentFile(nonce: number): string {
    return path.join(path.dirname(this.file), `intent_${this.sender!.toLowerCase()}_${nonce}.json`);
  }

  private reservationFile(nonce: number): string { return path.join(this.directory, `reservation_${this.sender!.toLowerCase()}_${nonce}.json`); }
  private approvalFile(): string { return path.join(this.directory, `${this.planHash.slice(7)}.approval.json`); }
  private abortFile(): string { return path.join(this.directory, `${this.planHash.slice(7)}.approval-abort.json`); }
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
