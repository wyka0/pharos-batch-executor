import { describe, expect, it } from 'vitest';
import { renderEvidenceMarkdown, stringifyPublicJson } from '../src/evidence.js';
import { assertPublicData, scanTextForSecrets } from '../src/safety.js';
import type { BatchRunEvidence } from '../src/types.js';

describe('safe public evidence', () => {
  it('serializes gas bigints without changing the measured/model distinction', () => {
    expect(JSON.parse(stringifyPublicJson({ evidence: 'simulated', simulationRef: 'sim_test', modelGas: 123n }))).toEqual({
      evidence: 'simulated', simulationRef: 'sim_test', modelGas: '123',
    });
  });

  it.each(['privateKey', 'PRIVATE_KEY', 'mnemonic', 'api_key', 'serializedTransaction', 'signedTransaction'])('refuses sensitive %s fields at any depth', (field) => {
    expect(() => stringifyPublicJson({ nested: [{ [field]: 'DO-NOT-EMIT' }] })).toThrow(/Sensitive field/);
  });

  it('detects credential patterns but does not mistake public hashes or calldata for keys', () => {
    const keyAssignment = ['PRIVATE', 'KEY'].join('_') + '=' + ['0x', 'ab'.repeat(32)].join('');
    const credentialUrl = ['https://', 'user', ':', 'credential', '@example.test'].join('');
    expect(scanTextForSecrets(keyAssignment)).toContain('literal private-key assignment');
    expect(scanTextForSecrets(credentialUrl)).toContain('credential-bearing URL');
    expect(scanTextForSecrets(`transactionHash: 0x${'ab'.repeat(32)}`)).toEqual([]);
    expect(() => assertPublicData({ data: `0x${'ab'.repeat(64)}` })).not.toThrow();
  });

  it('rejects a credential embedded in a public note without echoing it', () => {
    const token = ['gh', 'p_', 'z'.repeat(32)].join('');
    expect(() => stringifyPublicJson({ note: token })).toThrow(/credential pattern/);
  });

  it('also guards Markdown before it can be printed to the console', () => {
    const token = ['gh', 'p_', 'z'.repeat(32)].join('');
    expect(() => renderEvidenceMarkdown({ note: token } as unknown as BatchRunEvidence)).toThrow(/credential pattern/);
  });
});
