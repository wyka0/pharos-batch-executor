import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertPublicData, scanTextForSecrets } from '../dist/safety.js';
import { root } from './tooling.mjs';

const EXCLUDED = new Set(['.git', 'node_modules', 'dist', 'coverage', 'out', 'cache', 'lib', 'forge-cache', 'state']);
const findings = [];
let inspected = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) { findings.push(`${relative}: symlinks are not accepted in the public package`); continue; }
    if (entry.isDirectory()) {
      if (!EXCLUDED.has(entry.name) && relative !== 'evidence/runs') await walk(file);
      continue;
    }
    if (/^(?:\.env(?:\..*)?|.*\.env)$/i.test(entry.name)) { findings.push(`${relative}: environment file must not be in the package`); continue; }
    if (!/\.(?:ts|mts|mjs|js|json|md|sol|toml|ya?ml|sh|txt|html)$/.test(entry.name) && !['.gitignore', 'LICENSE', '.gitattributes'].includes(entry.name)) continue;
    if ((await stat(file)).size > 5_000_000) { findings.push(`${relative}: oversized public text file`); continue; }
    const text = await readFile(file, 'utf8');
    inspected++;
    findings.push(...scanTextForSecrets(text).map((label) => `${relative}: ${label}`));
    if (entry.name.endsWith('.json')) {
      try { assertPublicData(JSON.parse(text)); }
      catch { findings.push(`${relative}: invalid JSON or sensitive public-data field`); }
    }
  }
}
await walk(root);
for (const file of ['SKILL.md', 'README.md', 'LICENSE', 'docs/security.md', 'SUBMISSION.md', 'scripts/testnet-status.ts']) {
  try { await stat(path.join(root, file)); } catch { findings.push(`${file}: required public file missing`); }
}
const ignores = await readFile(path.join(root, '.gitignore'), 'utf8');
for (const rule of ['state/', 'evidence/runs/', '*.env', '.env*', 'node_modules/']) {
  if (!ignores.split(/\r?\n/).includes(rule)) findings.push(`.gitignore: required exclusion ${rule} missing`);
}
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!Array.isArray(pkg.files) || pkg.files.length === 0 || pkg.files.some((file) => /(?:state|runs|\.env|node_modules|\*\*)/.test(file))) {
  findings.push('package.json: explicit safe publication allowlist required');
}
if (Object.keys(pkg.scripts).some((name) => ['install', 'postinstall', 'preinstall'].includes(name))) findings.push('package.json: unexpected install-time hook');
if (findings.length !== 0) {
  console.error(`Safety checks failed (${findings.length} finding(s)); values are never printed.`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else console.log(`Safety checks passed: ${inspected} public text files inspected; credentials, environment files and unsafe package paths rejected.`);
