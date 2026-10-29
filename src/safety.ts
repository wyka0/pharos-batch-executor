/** Conservative public-output checks. These are guardrails, not a full DLP tool. */
const PRIVATE_FIELDS = /^(?:private[_-]?key|mnemonic|seed[_-]?phrase|api[_-]?key|secret|password|authorization|envContents|serializedTransaction|signedTransaction|rawTransaction)$/i;

export function scanTextForSecrets(text: string): string[] {
  const findings: string[] = [];
  if (/(?:private[_-]?key)\s*["']?\s*[:=]\s*["']?(?:0x)?[0-9a-f]{64}(?![0-9a-f])/i.test(text) ||
    /--private-key\s+(?:0x)?[0-9a-f]{64}(?![0-9a-f])/i.test(text)) findings.push('literal private-key assignment');
  if (/\bgh[pousr]_[a-z0-9]{20,}\b/i.test(text) || /\bgithub_pat_[a-z0-9_]{30,}\b/i.test(text)) findings.push('GitHub credential pattern');
  if (/https?:\/\/[^\s/"'<>]+:[^\s/"'<>]+@/i.test(text)) findings.push('credential-bearing URL');
  if (/(?:mnemonic|seed[_-]?phrase)\s*["']?\s*[:=]\s*["'](?:[a-z]+\s+){11,23}[a-z]+["']/i.test(text)) findings.push('mnemonic phrase assignment');
  if (/(?:api[_-]?key|secret|password)\s*["']?\s*[:=]\s*["'][a-z0-9_+/=-]{20,}["']/i.test(text)) findings.push('literal secret credential assignment');
  return findings;
}

export function assertPublicData(value: unknown): void {
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (typeof item === 'string' && scanTextForSecrets(item).length !== 0) throw new Error('Public output contains a credential pattern; refused without printing its value.');
    if (item === null || typeof item !== 'object') return;
    if (seen.has(item)) throw new Error('Circular public output is unsupported.');
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (PRIVATE_FIELDS.test(key)) throw new Error('Sensitive field in public output; refused without printing its value.');
      visit(child);
    }
    seen.delete(item);
  };
  visit(value);
}
