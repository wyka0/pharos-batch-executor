# Batch Executor submission

## Current status — do not submit as live proof yet

- Verified local EVM execution: six independent writes in one transaction,
  actual same-state 13.88% gas saving and 83.33% execution transaction reduction.
- Five local scenarios, complete per-action/receipt evidence, bounded failures,
  refund ownership/withdrawal and offline safety tests are provided.
- Skill instructions, runtime, documentation, CI and publication controls are
  included. Local evidence is explicitly not Atlantic explorer proof.
- **Atlantic deployment/execution:** pending exact plan-specific user approval.
  No signed or broadcast Atlantic transaction is claimed.
- **GitHub/proof URL:** pending publication; no remote repository URL is invented.
- **GitHub CI:** workflow included, but no hosted CI run has occurred.
- **Video:** not recorded or submitted.

## Reviewed offline proof

The saved proof is from `local_2026-10-29T06-48-37-162Z_e3a049ac`, using
disposable Anvil on chain **31337**, not Atlantic:

- [Local proof overview](evidence/local/README.md), [summary](evidence/local/summary.json)
  and [SHA-256 manifest](evidence/local/manifest.json).
- Six raw individual receipts captured before snapshot restoration, one
  six-action success receipt, and four additional one-transaction scenarios:
  mixed failure, gas isolation, return-data cap and refund credit.
- **14 observed local submissions** in total: two setup deployments, six
  individual baseline sends, five batch sends and one separate refund withdrawal.
- The individual branch was discarded after receipt capture. Its hashes are
  saved observations, not current canonical-chain or Atlantic explorer proof.

| Offline check | Verified result |
|---|---|
| `npm run verify` | Contract build, typecheck, lint, 139 TypeScript tests, 34 Solidity tests, production build, safety scan and smoke checks passed |
| Solidity boundaries | 3–32 actions, gas/revert isolation, native-value accounting and 256-run fuzz coverage; executor runtime 3,080 bytes |
| Production smoke | Compiled CLI and library, 32 portable declarations and all 30 manifest-listed local proof files passed |
| `npm run demo:local` | All five scenarios passed; same-state six-versus-one measured comparison reproduced |
| `npm audit --audit-level=low` | 0 reported vulnerabilities at review time; not an independent security audit |
| Skill discovery | `npx --yes skills@1.7.4 add . --list` found exactly one skill; hosted registration/installation is not claimed |
| `npm pack --dry-run --json` | 168 files, including 31 curated proof files; required runtime resources present and protected paths excluded; nothing published |

These checks are local observations, not a GitHub Actions result. Final staged
files must also pass public-data, path and saved-proof integrity inspection
before committing or pushing. Local state and uncurated `evidence/runs/` stay
excluded from publication.

## Draft description

Pharos Batch Executor takes 3–32 caller-declared independent actions and sends
one genuine `BatchExecutor.execute` transaction instead of N individual sends.
The bounded CALL executor records every result and continues after subcall
failure. A six-write identical-state local experiment measured 273,942 gas in
six individual transactions versus 235,910 gas in one batch: 38,032 / 13.88%
gas saved and five / 83.33% fewer execution transactions. Revert/gas-exhaustion
isolation, capped returndata and failed-value credit/withdrawal are verified.
Default operation is simulation; Atlantic writes require exact expiring approval,
offline payload checks, durable intents and no-retry reconciliation.

## Before submitting to Arena

- [x] Implement a genuine bounded-CALL batch for at least three independent actions.
- [x] Verify local success/failure semantics and preserve the same-state receipt comparison.
- [x] Run offline verification, local demonstration, dependency audit, skill discovery and package dry-run inspection.
- [ ] Inspect the final staged public snapshot and complete the local publication commit.
- [ ] Publish the reviewed repository and verify that its URL is openable.
- [ ] Verify the hosted GitHub CI result; local checks do not count as a hosted run.
- [ ] Obtain fresh explicit Atlantic setup approval, deploy and verify runtime.
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
2. Show six independent writes, six local baseline receipts and one batch receipt.
3. Show the exact measured comparison and the discarded-branch disclosure.
4. Show a middle failure and the final action's event/state effect.
5. Show the real approved Atlantic explorer link only after live execution exists.
6. Finish with openable GitHub source, tests and evidence; distinguish local/live.
