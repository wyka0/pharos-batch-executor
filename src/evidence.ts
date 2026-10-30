import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { summarizePartialFailure } from './summary.js';
import { assertPublicData } from './safety.js';
import type { BatchRunEvidence } from './types.js';

export function stringifyPublicJson(value: unknown): string {
  assertPublicData(value);
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item, 2);
}
export function stringifyEvidence(evidence: BatchRunEvidence): string { return stringifyPublicJson(evidence); }

/** Immutable run files: refuse to overwrite earlier execution evidence. */
export async function writeEvidence(evidence: BatchRunEvidence, directory = path.resolve('evidence', 'runs')) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(evidence.runId)) throw new Error('Unsafe evidence run id.');
  await mkdir(directory, { recursive: true });
  const jsonPath = path.join(directory, `${evidence.runId}.json`);
  const markdownPath = path.join(directory, `${evidence.runId}.md`);
  await writeFile(jsonPath, `${stringifyEvidence(evidence)}\n`, { encoding: 'utf8', flag: 'wx' });
  await writeFile(markdownPath, renderEvidenceMarkdown(evidence), { encoding: 'utf8', flag: 'wx' });
  return { jsonPath, markdownPath };
}

export function renderEvidenceMarkdown(e: BatchRunEvidence): string {
  assertPublicData(e);
  const receipt = e.batch.receipt;
  const summary = summarizePartialFailure(e.batch.actions);
  const c = e.comparison;
  const lines = [
    `# Batch evidence: ${e.runId}`, '',
    `- Adapter / chain: **${e.metadata.adapter} / ${e.metadata.chainId}**`,
    `- Mode / state: **${e.batch.state}**`,
    `- Plan: \`${e.plan.planHash}\``,
    `- Actual measured receipt available: **${receipt?.evidence === 'actual'}**`, '',
    '## Single batch transaction', '',
    `- Hash: ${e.batch.transactionHash === undefined ? '**none — nothing broadcast**' : `\`${e.batch.transactionHash}\``}`,
    ...(receipt?.evidence === 'actual' ? [
      `- Receipt: **${receipt.status}**; block **${receipt.blockNumber}**; confirmations **${receipt.confirmations}**`,
      `- Receipt gas used: **${receipt.gasUsed}**; receipt-derived fee calculation: **${receipt.feeWei} wei**`,
      '- Independently observed balance debit: **unavailable**. Receipt arithmetic does not establish the Atlantic fee-settlement policy.',
      ...(receipt.explorerUrl === undefined ? [] : [`- Explorer: ${receipt.explorerUrl}`]),
    ] : receipt?.evidence === 'simulated' ? [
      `- Reference: \`${receipt.simulationRef}\` — **MODEL ONLY; no blockchain hash or block**`,
      `- Model gas: **${receipt.modelGas} (MODEL ESTIMATE, NOT MEASURED)**`,
    ] : ['- No mined receipt; simulation predictions are not execution evidence.']),
    `- Failed-call value credit: **${e.batch.refundCreditWei} wei** (${e.batch.state === 'confirmed' ? 'withdrawable credit' : 'predicted / unverified; not an automatic refund'})`,
    '', '| # | ID | Target | Outcome | Error |', '|---:|---|---|---|---|',
    ...e.batch.actions.map((a) => `| ${a.index} | ${cell(a.id)} | \`${a.target}\` | ${a.status} | ${cell(a.error ?? '')} |`),
    '', summary.remainingActionsBehavior, '',
    '## Comparison', '',
    '| Metric | Individual baseline | Batch |', '|---|---:|---:|',
    `| Required transactions / execution steps | ${c.individual.transactionCount} | ${c.batch.transactionCount} |`,
    `| Gas estimate | ${c.individual.estimatedGas.gas ?? 'UNAVAILABLE'} | ${c.batch.estimatedGas.gas ?? 'UNAVAILABLE'} |`,
    `| Measured receipt gasUsed | ${c.individual.measuredGas?.gas ?? 'UNAVAILABLE'} | ${c.batch.measuredGas?.gas ?? 'UNAVAILABLE'} |`,
    '', `Baseline: ${c.baselineMethod}`, '',
    c.estimatedSavings === undefined ? 'Estimated gas difference: **UNAVAILABLE** (estimation failure).' :
      `Estimated gas saving: **${c.estimatedSavings.gas} (${percent(c.estimatedSavings.fraction)})**. Negative means the reserved estimate is higher, not a saving.`,
    c.measuredSavings === undefined ? 'Measured gas saving: **UNAVAILABLE** (no comparable verified receipt sets).' :
      `Measured gas saving: **${c.measuredSavings.gas} (${percent(c.measuredSavings.fraction)})**.`,
    `Execution transaction reduction: **${c.transactionReduction.count} (${percent(c.transactionReduction.fraction)})**.`,
    '', '## Limitations and safety', '', ...c.limitations.map((item) => `- ${item}`), '',
    'Complete raw receipts, per-action return/revert bytes, estimates and approved calldata are in the adjacent JSON file.', '',
  ];
  return lines.join('\n');
}

function percent(n: number): string { return `${(n * 100).toFixed(2)}%`; }
function cell(s: string): string { return s.replaceAll('|', '\\|').replace(/[\r\n]/g, ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
