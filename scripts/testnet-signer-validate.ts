import path from 'node:path';
import { parseArgs } from 'node:util';
import { stringifyPublicJson } from '../src/evidence.js';
import { loadLocalSigner } from '../src/testnet/signer.js';
import { validateAddress } from '../src/validation.js';

async function main() {
  const { values } = parseArgs({ strict: true, options: {
    address: { type: 'string' }, 'env-file': { type: 'string' },
  } });
  if (!values.address || !values['env-file']) throw new Error('Explicit --address and --env-file are required.');
  if (!path.isAbsolute(values['env-file'])) throw new Error('--env-file must be an explicitly selected absolute path.');
  const expectedAddress = validateAddress(values.address, '--address');
  const signer = await loadLocalSigner(values['env-file'], expectedAddress);
  if (signer.address.toLowerCase() !== expectedAddress.toLowerCase()) throw new Error('Signer address mismatch.');
  console.log(stringifyPublicJson({
    classification: 'LOCAL SIGNER VALIDATION ONLY — NO SIGNING OR BROADCAST',
    signerAddress: signer.address,
    expectedAddress,
    signerFile: values['env-file'],
    validation: 'PASS',
    protections: {
      explicitAbsolutePathRequired: true,
      regularFileRequired: true,
      symlinkRejected: true,
      windowsAclVerified: false,
    },
    warning: 'Windows file ownership and ACLs are not verified by this command; protect the explicitly selected file separately.',
  }));
}

main().catch(() => {
  console.error('Local signer validation refused. No approval consumed, intent created, transaction signed or broadcast.');
  process.exitCode = 1;
});
