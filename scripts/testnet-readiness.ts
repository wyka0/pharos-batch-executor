import { parseArgs } from 'node:util';
import { getReadiness } from '../src/testnet/readiness.js';
import { stringifyPublicJson } from '../src/evidence.js';
import { validateAddress } from '../src/validation.js';

const { values } = parseArgs({ options: { address: { type: 'string' } }, strict: true });
getReadiness(validateAddress(values.address, '--address')).then((result) => console.log(stringifyPublicJson(result))).catch(() => {
  console.error('Read-only Atlantic readiness failed. Check network access and public address; no signing key loaded.');
  process.exitCode = 1;
});
