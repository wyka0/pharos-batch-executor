import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertPublicData, scanTextForSecrets } from '../dist/safety.js';
import { isDeprecationTestFile, isExecutableRpcScanTarget, scanText as scanTextForDeprecatedRpcMethods } from './check-rpc-methods.mjs';
import { root } from './tooling.mjs';

const run = promisify(execFile);
const findings = [];
let inspected = 0;

// Review scope: exactly what git would publish — tracked files plus untracked-but-not-ignored ones.
// Gitignored material (state/, evidence/runs/, .env.local, dist/out caches) is deliberately out of
// content-scan scope; those exclusions themselves are asserted below.
const listed = (await run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 16_000_000 })).stdout;
const files = listed.split('\0').filter((file) => file.length > 0);

const required = new Set(['SKILL.md', 'README.md', 'LICENSE', 'docs/security.md', 'SUBMISSION.md', 'scripts/testnet-status.ts']);
for (const relative of files) {
  if (relative.includes('..')) { findings.push(`${relative}: unsafe repository path`); continue; }
  const file = path.join(root, relative);
  const info = await stat(file).catch(() => null);
  if (info === null) { findings.push(`${relative}: listed by git but unreadable`); continue; }
  if (info.isSymbolicLink()) { findings.push(`${relative}: symlinks are not accepted in the public package`); continue; }
  if (!info.isFile()) continue;
  if (/^(?:\.env(?:\..*)?|.*\.env)$/i.test(path.basename(relative))) { findings.push(`${relative}: environment file must not be in the package`); continue; }
  if (!/\.(?:ts|mts|mjs|js|json|md|sol|toml|ya?ml|sh|txt|html)$/.test(relative) && !['.gitignore', 'LICENSE', '.gitattributes'].includes(path.basename(relative))) continue;
  if (info.size > 5_000_000) { findings.push(`${relative}: oversized public text file`); continue; }
  const text = await readFile(file, 'utf8');
  inspected++;
  findings.push(...scanTextForSecrets(text).map((label) => `${relative}: ${label}`));
  if (relative.endsWith('.json')) {
    try { assertPublicData(JSON.parse(text)); }
    catch { findings.push(`${relative}: invalid JSON or sensitive public-data field`); }
  }
  required.delete(relative);
}
for (const file of required) findings.push(`${file}: required public file missing`);

// Deprecated public trace RPC methods (disabled on the public Pharos RPC
// endpoints) must not appear in first-party executable files. Documentation,
// evidence, the guard module and the dedicated deprecation test suite are the
// only exemptions; no other file may opt out, by path or inline comment.
const guardModule = path.resolve(path.join(root, 'scripts', 'check-rpc-methods.mjs'));
for (const relative of files) {
  if (!isExecutableRpcScanTarget(relative)) continue;
  const file = path.join(root, relative);
  if (path.resolve(file) === guardModule) continue;
  if (isDeprecationTestFile(relative)) continue;
  const info = await stat(file).catch(() => null);
  if (info === null || !info.isFile() || info.size > 5_000_000) continue;
  const text = await readFile(file, 'utf8');
  findings.push(
    ...scanTextForDeprecatedRpcMethods(text).map(
      (finding) => `${relative}:${finding.line}:${finding.column}: deprecated RPC trace method ${finding.method}`,
    ),
  );
}

// Gitignored secret-bearing material stays out of any published listing.
const ignoredPublicly = ['.env.local', 'state/x', 'evidence/runs/x', 'dist/x', 'node_modules/x', 'out/x'];
for (const candidate of ignoredPublicly) {
  try { await run('git', ['check-ignore', '-q', '--', candidate], { cwd: root }); }
  catch { findings.push(`${candidate}: expected to remain git-ignored, but it is not`); }
}

const ignores = await readFile(path.join(root, '.gitignore'), 'utf8');
for (const rule of ['state/', 'evidence/runs/', '*.env', '.env*', 'node_modules/']) {
  if (!ignores.split(/\r?\n/).includes(rule)) findings.push(`.gitignore: required exclusion ${rule} missing`);
}
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (pkg.files.includes('.env.local') || !Array.isArray(pkg.files) || pkg.files.length === 0 || pkg.files.some((file) => /(?:state|runs|\.env|node_modules|\*\*)/.test(file))) {
  findings.push('package.json: explicit safe publication allowlist required');
}
if (Object.keys(pkg.scripts).some((name) => ['install', 'postinstall', 'preinstall'].includes(name))) findings.push('package.json: unexpected install-time hook');
if (findings.length !== 0) {
  console.error(`Safety checks failed (${findings.length} finding(s)); values are never printed.`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else console.log(`Safety checks passed: ${inspected} git-visible public text files inspected; credentials, environment files and unsafe package paths rejected.`);
