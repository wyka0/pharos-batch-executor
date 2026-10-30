# Batch Executor submission

## Current status — live proof complete, publication pending

- Current committed hardening makes each executor deployer-only, checks caller
  ownership as well as runtime, rechecks approval at the final submission boundary
  and rejects incomplete/mismatched measured baselines and infeasible gas bounds.
- The frozen **pre-hardening** local proof measured six independent writes in one
  transaction: 13.88% **execution-only** gas saving and 83.33% execution transaction
  reduction. It is not gas/deployment/authorization proof for the revised contract.
- Five historical local scenarios cover bounded failures and refund ownership/
  withdrawal. Current regressions use offline mocks and an in-process test EVM.
- Skill instructions, runtime, documentation, CI and publication controls are
  included. Local evidence is explicitly not Atlantic explorer proof.
- **Atlantic deployment/execution:** verified. BatchExecutor and TestOnlyCounter
  are source/runtime-bound on chain; the success batch, partial-failure batch and
  three-transaction controlled baseline have canonical receipts and post-state
  verification. See [`evidence/atlantic/`](evidence/atlantic/README.md).
- **GitHub/proof URL:** pending publication; no remote repository URL is invented.
- **GitHub CI:** workflow included, but no hosted CI run has occurred.
- **Screenshots/video:** not created or submitted. Video is optional.
- The original commit `0779e1094fe957998b67c922bb3e5ce6a93955be` and its attribution
  remain unchanged. Hardening and live-workflow commits preserve attribution;
  no publication, remote change or history rewrite is claimed.

## Current committed-tree verification

| Check | Current result |
|---|---|
| Last full `npm run verify` before the current HEAD | Passed: offline contract build, typecheck, lint, **385 TypeScript tests across 19 files**, **44 Solidity tests** with **256 fuzz runs**, production build, safety scan and offline smoke |
| Read-only final audit | Typecheck and ESLint passed; two complete Vitest reruns passed **385/385** after one non-reproduced initial 384/385 run; safety scan passed for 143 Git-visible files |
| Source-bound artifact | BatchExecutor runtime is 3,190 bytes and is verified on Atlantic at `0xF25013Db14c8B412191FF5f0606649A23D974032` |
| Current regressions | Caller/runtime authority, signer-before-approval validation, categorical diagnostics, bounded read retries, staged deployments, conservative gas bounds, uncertain-send recovery, partial failures and rollback semantics |
| Production smoke | Last full verification passed compiled CLI/library checks, three MODEL scenarios, **38 portable declarations** and all 30 manifest-listed frozen proof files |

Offline tests use synthetic in-memory signatures and Foundry's in-process EVM.
Live Atlantic transactions are separately documented in the sanitized evidence
bundle and are not produced by `npm run verify`.

## Reviewed historical offline proof — pre-hardening

The saved proof is from `local_2026-10-29T06-48-37-162Z_e3a049ac`, using
disposable Anvil on chain **31337**, not Atlantic. Its 30 manifest-listed files
and manifest are frozen byte-for-byte:

- [Local proof overview](evidence/local/README.md), [summary](evidence/local/summary.json)
  and [SHA-256 manifest](evidence/local/manifest.json).
- Six raw individual receipts captured before snapshot restoration, one
  six-action success receipt, and four additional one-transaction scenarios:
  mixed failure, gas isolation, return-data cap and refund credit.
- **14 observed local submissions** in total: two setup deployments, six
  individual baseline sends, five batch sends and one separate refund withdrawal.
- The individual branch was discarded after receipt capture. Its hashes are
  saved observations, not current canonical-chain or Atlantic explorer proof.
- The historical executor used a 3,080-byte runtime. New strict comparisons
  reject these legacy unbound captures rather than inventing missing metadata.
- Historical deployment gas was 740,669 executor + 221,814 common test target.
  Derived first-use totals are 495,756 individual versus 1,198,393 batch gas:
  a **702,637-gas batch premium**. The old execution saving would offset executor
  deployment after **20 similar batches only if it persisted**. The separate
  refund withdrawal used 33,387 gas. [Full accounting](docs/evidence.md).

The following are **historical checks recorded at the original review**, not
rerun/current-source or hosted-CI claims:

| Historical check | Recorded result |
|---|---|
| `npm run verify` | Contract build, typecheck, lint, 139 TypeScript tests, 34 Solidity tests, production build, safety scan and smoke checks passed |
| Solidity boundaries | 3–32 actions, gas/revert isolation, native-value accounting and 256-run fuzz coverage; old executor runtime 3,080 bytes |
| Production smoke | Compiled CLI and library, 32 portable declarations and all 30 manifest-listed local proof files passed |
| `npm run demo:local` | All five scenarios passed; same-state six-versus-one measured comparison reproduced |
| `npm audit --audit-level=low` | 0 reported vulnerabilities at review time; not an independent security audit |
| Skill discovery | `npx --yes skills@1.7.4 add . --list` found exactly one skill; hosted registration/installation is not claimed |
| `npm pack --dry-run --json` | 168 files, including 31 curated proof files; required runtime resources present and protected paths excluded; nothing published |

These checks are local observations, not a GitHub Actions result. Final public
files need public-data, path and saved-proof integrity inspection before any
separately authorized commit/publication. Local state and uncurated
`evidence/runs/` stay excluded. No dependency-audit, discovery or package dry-run
result is newly claimed for the revised tree unless separately rerun.

## Draft description

Pharos Batch Executor takes 3–32 caller-declared independent actions and sends
one genuine `BatchExecutor.execute` transaction instead of N individual sends.
The deployer-only bounded CALL executor records every result and continues after
subcall failure. A **pre-hardening** six-write identical-state local experiment
measured 273,942 gas in six individual transactions versus 235,910 gas in one
batch: 38,032 / 13.88%
execution gas saved and five / 83.33% fewer execution transactions, excluding
deployment/setup/withdrawal costs. For the revised contract, a controlled live
Atlantic fresh-storage comparison observed **136,959 gas / 3 individual receipts**
versus **133,722 gas / 1 batch receipt**: **3,237 gas / 2.3635%** and **66.67%
fewer execution transactions**. It is a different-block, different-key comparison,
not an identical-state benchmark or universal saving. A live partial-failure batch
verified success / deliberate failure / later success in one outer transaction.
Revert/gas-exhaustion isolation, capped returndata and failed-value credit/
withdrawal also retain historical proof and current offline regressions.
Default operation is simulation; Atlantic writes require exact expiring approval,
caller/runtime and offline payload checks, a final synchronous submission gate,
durable intents and no-retry reconciliation. Missing or mismatched comparison
bindings withhold measured baseline gas/savings rather than fabricating proof.

## Before submitting to Arena

- [x] Implement a genuine bounded-CALL batch for at least three independent actions.
- [x] Preserve historical local success/failure and same-state receipt evidence unchanged.
- [x] Preserve the original commit and historical offline/demo/audit/discovery/package review record.
- [x] Complete full offline verification of the revised working tree.
- [x] Obtain separate approvals for current-contract deployment and execution evidence without regenerating frozen proof.
- [x] Create a sanitized tracked Atlantic evidence bundle with SHA-256 manifest.
- [ ] Inspect the final public snapshot and obtain separate commit/publication approval.
- [ ] Publish the reviewed repository and verify that its URL is openable.
- [ ] Verify the hosted GitHub CI result; local checks do not count as a hosted run.
- [x] Obtain fresh explicit Atlantic setup approval, deploy and verify runtime and authorized caller.
- [x] Obtain separate batch approval and verify ≥3 action events in one receipt.
- [x] Show a partial-failure batch: exact failing action and later verified effects.
- [x] Add actual Atlantic batch explorer links and receipt hashes.
- [x] Label live estimates versus measured receipt gas and disclose the controlled baseline method.
- [ ] Re-run affected checks and inspect staged/packed public data after any further changes.
- [ ] Update this document with actual accessible proof/repo URLs and remaining limits.
- [ ] Capture submission screenshots.
- [ ] Optionally record a video; do not claim optional video points beforehand.
- [ ] Complete and submit the Arena form.

Arena: https://pharos-agent-arena.vercel.app/tasks/batch-executor

## Suggested 90-second video outline

1. Show the skill/action schema and Atlantic-only default-off safety boundary.
2. Show the verified Atlantic three-action success batch and three individual baseline receipts.
3. Show the 2.3635% controlled fresh-storage result with its different-block disclosure; label the historical six-write proof separately.
4. Show the live middle failure and the final action's event/state effect.
5. Show the real Atlantic explorer links from the tracked evidence bundle.
6. Finish with openable GitHub source, tests and evidence; distinguish local/live.
