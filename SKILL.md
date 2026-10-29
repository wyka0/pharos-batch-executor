---
name: pharos-batch-executor
description: >
  Bundle 3 to 32 caller-declared independent EVM actions into ONE genuine
  bounded-CALL transaction on Pharos Atlantic Testnet. Validate action lists,
  simulate without signing, report every success/failure and remaining action,
  compare estimated/measured gas and transaction counts, and reconcile uncertain
  submissions without retrying. Use for independent batch transfers or calls,
  not dependent approve/swap workflows. Dry-run by default; explicit per-plan
  approval is mandatory before any Atlantic signing or broadcast.
version: 0.1.0
requires:
  anyBins:
    - node
---

# Pharos Batch Executor

## Scope and non-negotiable safety rules

- **Atlantic TESTNET only:** chain `688689`, RPC
  `https://atlantic.dplabs-internal.com`, explorer
  `https://atlantic.pharosscan.xyz/`. Never substitute another network or RPC.
- The normal execution shape is one `BatchExecutor.execute(Action[])`
  transaction. N individual baseline sends are **not** a batch.
- Default to `demo` (zero-network model) or `simulate` (read-only `eth_call`).
  Neither needs a signing key. Never load a key just to inspect readiness.
- Require 3–32 actions, unique identifiers and explicit `independent: true`.
  Independence is a caller assertion, not something inferred from calldata.
- Targets see the executor as `msg.sender`, **not** the wallet. Reject
  sender-dependent claims, approval-then-swap sequences, ERC20 transfers of the
  wallet's balance, or actions consuming another action's output. Do not approve
  assets to this executor to work around that restriction.
- A successful low-level CALL is not application-level success. Inspect return
  values/postconditions where relevant; `false` without revert is CALL success.
- Never expose keys, mnemonics, tokens, environment contents or signed payloads
  in chat, command arguments, logs, evidence or version control.
- A user saying “continue” is **not** deployment or transaction approval.
  Do not generate your own consent by copying the computed plan hash into flags.
- Never resend an `INTENT`, `UNKNOWN` or `UNVERIFIED` submission. Run read-only
  reconciliation, preserve the hash, and stop. Never delete locks or intent
  markers to bypass this rule.

## Runtime prerequisites

Use a complete clone of this repository containing `package.json`, `src/`,
`contracts/` and `artifacts/`. A skill installer is not a hosted execution API
and may install only instruction resources. Run all commands from the complete
repository root, not from an unrelated agent working directory.

Node `22.12+` in the supported 22/24/26+ release lines and npm are required.
For contract verification and the disposable local demo, install Foundry and
check `cast --version`, `forge --version` and `anvil --version`.
Windows uses WSL Ubuntu by default; see [setup](docs/setup.md).

```bash
npm ci
npm run verify
npm run demo:simulated -- --scenario mixed
```

The zero-network model uses `sim_*` references, not fabricated transaction
hashes or measured gas. `npm run demo:local` is explicit **local EVM** execution
with real receipts; it does not touch Atlantic or load a private key.

## Workflow

1. **Validate input.** Read [action semantics](docs/actions.md). Use
   `npm run cli -- validate --actions <file.json>`. Report validation errors
   before any signing/submission; do not silently drop or split actions.
2. **Inspect tooling and public readiness.** Use
   `npm run testnet:readiness -- --address <sender>`. Confirm the exact chain,
   available balance and absence of pending transactions. No key is loaded.
3. **Prepare and simulate.** Use `plan` for unsigned calldata, or
   `simulate --actions <file> --sender <sender> --executor <executor>` after a
   source-bound executor deployment exists. Show all predicted action results
   and label every gas estimate. A failed individual estimate is `null`, not
   an invented fallback. A failed batch simulation/estimate blocks execution.
4. **Request approval.** If deployment is needed, generate
   `npm run testnet:plan -- --purpose deploy --address <sender>`.
   This is **two setup transactions**, not the execution batch.
   For a deployed executor use `--purpose batch --executor <executor>
   --actions <file>`. Show the exact SHA-256 plan hash, sender, network,
   transaction count, nonces, destinations/predicted deployment addresses,
   action outcomes, maximum value/fee ceiling and expiry. Stop and obtain
   explicit user approval of this exact plan. A later batch/baseline requires
   its own approval; deployment approval does not authorize them.
5. **Execute only after approval.** Follow the exact command in
   [Atlantic workflow](docs/atlantic.md). Supply only a local path to existing
   signing configuration, never its contents. The runner loads it lazily,
   verifies the signed payload offline, fsyncs INTENT, and attempts each send
   once. Use the same durable state directory and do not use the sender
   concurrently in another wallet/tool.
6. **Verify and report.** Verify transaction fields, canonical receipt block,
   confirmations, runtime code, receipt-bound ordered action events and refund
   accounting. Report every action and what happened after a failure. Save
   complete public evidence. For uncertainty, use `npm run testnet:status --
   --plan <plan.json>`; it has no signing or broadcast capability.

## Required final report

- Environment: MODEL, LOCAL EVM, or ATLANTIC TESTNET; exact chain ID.
- One verified batch hash/explorer link **only when actually available**.
- Every action's ID, target, outcome, revert/error and any truncated return data.
- Remaining actions after a subcall failure ran independently; an outer revert
  committed none of the actions; uncertain outcomes must remain unknown.
- Individual vs batch transaction counts; RPC/model estimates separately from
  receipt `gasUsed`. Measured savings only with equivalent verified receipts
  and a disclosed fair baseline. Negative differences are not “savings.”
- Failed-call value credit is withdrawable by its owner, not automatically
  refunded. A withdrawal is a separate, separately approved transaction.
- Evidence paths and unresolved blockers. Do not claim hosted registration,
  GitHub publication, deployment, live proof or completion without verification.

References: [actions](docs/actions.md), [architecture](docs/architecture.md),
[failure semantics](docs/failures.md), [security](docs/security.md),
[evidence](docs/evidence.md), [official interfaces](docs/compatibility.md).
