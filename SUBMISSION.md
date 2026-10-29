# Batch Executor submission

## Current status — do not submit as live proof yet

- Current local hardening makes each executor deployer-only, checks caller
  ownership as well as runtime, rechecks approval at the final submission boundary
  and rejects incomplete/mismatched measured baselines and infeasible gas bounds.
- The frozen **pre-hardening** local proof measured six independent writes in one
  transaction: 13.88% **execution-only** gas saving and 83.33% execution transaction
  reduction. It is not gas/deployment/authorization proof for the revised contract.
- Five historical local scenarios cover bounded failures and refund ownership/
  withdrawal. Current regressions use offline mocks and an in-process test EVM;
  no fresh current-source Anvil deployment or gas experiment has been run.
- Skill instructions, runtime, documentation, CI and publication controls are
  included. Local evidence is explicitly not Atlantic explorer proof.
- **Atlantic deployment/execution:** pending exact plan-specific user approval.
  No signed or broadcast Atlantic transaction is claimed.
- **GitHub/proof URL:** pending publication; no remote repository URL is invented.
- **GitHub CI:** workflow included, but no hosted CI run has occurred.
- **Video:** not recorded or submitted.
- The original commit `0779e1094fe957998b67c922bb3e5ce6a93955be` and its attribution
  remain unchanged. Hardening edits are uncommitted; no publication, remote change
  or history rewrite is part of this work.

## Current working-tree offline verification

| Check | Current result |
|---|---|
| Full `npm run verify` | Passed: contract build, typecheck, lint, 301 TypeScript tests across 15 files, 44 Solidity tests with 256 fuzz runs, production build, safety scan and offline smoke |
| Source-bound artifact | Revised BatchExecutor runtime is 3,190 compiled bytes, not an on-chain observation or measured deployment/execution gas |
| New regressions | Passed: caller/token/allowance authority, final-boundary expiry/retained intents, strict comparison bindings/order and coupled gas bounds; refund-callback reentrancy (nested withdrawal and execution rejected without double payment); late outer-transaction rollback (completed action effects, native-value transfers, refund credits and logs rolled back) |
| Production smoke | Compiled CLI/library, three MODEL scenarios, 33 portable declarations and all 30 manifest-listed saved proof files passed |

These results were observed locally on 2026-10-29. Tests used only synthetic
in-memory signatures and Foundry's in-process EVM; no real signing configuration,
RPC node, network submission or fresh local/Atlantic deployment was used.

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
deployment/setup/withdrawal costs. The revised contract's gas remains unmeasured.
Revert/gas-exhaustion isolation, capped returndata and failed-value credit/
withdrawal have historical proof and separate current offline regressions.
Default operation is simulation; Atlantic writes require exact expiring approval,
caller/runtime and offline payload checks, a final synchronous submission gate,
durable intents and no-retry reconciliation. Missing or mismatched comparison
bindings withhold measured baseline gas/savings rather than fabricating proof.

## Before submitting to Arena

- [x] Implement a genuine bounded-CALL batch for at least three independent actions.
- [x] Preserve historical local success/failure and same-state receipt evidence unchanged.
- [x] Preserve the original commit and historical offline/demo/audit/discovery/package review record.
- [x] Complete full offline verification of the revised working tree.
- [ ] Obtain separate approval for fresh current-contract deployment/gas evidence; do not regenerate frozen proof.
- [ ] Inspect the final public snapshot and obtain separate commit/publication approval.
- [ ] Publish the reviewed repository and verify that its URL is openable.
- [ ] Verify the hosted GitHub CI result; local checks do not count as a hosted run.
- [ ] Obtain fresh explicit Atlantic setup approval, deploy and verify runtime and authorized caller.
- [ ] Obtain separate batch approval and verify ≥3 action events in one receipt.
- [ ] Show a partial-failure batch: exact failing action and later verified effects.
- [ ] Add the actual Atlantic batch explorer link (not a predicted address/local hash).
- [ ] Label live estimates versus measured receipt gas and disclose baseline method.
- [ ] Re-run affected checks and inspect staged/packed public data after any further changes.
- [ ] Update this document with actual accessible proof/repo URLs and remaining limits.
- [ ] Optionally record a video; do not claim the optional video points beforehand.

Arena: https://pharos-agent-arena.vercel.app/tasks/batch-executor

## Suggested 90-second video outline

1. Show the skill/action schema and Atlantic-only default-off safety boundary.
2. Show six independent writes and the historical six-baseline/one-batch receipts, labeled pre-hardening.
3. Show execution-only versus first-use costs, strict comparison requirements and the discarded-branch disclosure.
4. Show a middle failure and the final action's event/state effect.
5. Show the real approved Atlantic explorer link only after live execution exists.
6. Finish with openable GitHub source, tests and evidence; distinguish local/live.
