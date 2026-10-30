# Atlantic Testnet: gated workflow

Network is fixed to chain **688689**, RPC
`https://atlantic.dplabs-internal.com`, explorer
`https://atlantic.pharosscan.xyz/`. Native currency is **test PHRS**.
Mainnet and alternate RPCs are rejected. All placeholders below must be replaced
with reviewed public values; do not paste a signing key.

## 1. Inspect without a key: one stage per approved plan

Deployment is staged: **each stage is exactly one, separately planned and
separately approved transaction**. Stage 1 deploys `BatchExecutor`; stage 2 —
only after stage 1 is durably verified — deploys the test-only counter. Neither
stage runs automatically; there is no combined plan.

```bash
npm run testnet:readiness -- --address <sender>
npm run testnet:plan -- --purpose deploy --stage executor --address <sender>
```

The stage-1 plan contains **one** deployment transaction: the executor creation
from fresh chain observations (chain, pending nonce, gas price, balances, code).
Predicted addresses are not proof of deployment. Inspect the public JSON, cost
ceiling, exact nonce, expiration, payload hash and printed approval hash. Stop
for explicit approval of that exact plan. "Continue" is not consent.

The executor constructor authorizes the **immediate deployer**. The packaged
deployment transaction is sent directly by the reviewed wallet, giving that
wallet its own executor. Runtime bytecode is uniform across callers; verify both
the source-bound runtime and `authorizedCaller()` at the successful deployment
receipt block. Old permissionless deployments and another wallet's executor are
not compatible substitutes. Do not deploy through a factory/forwarder and assume
the wallet is the constructor caller.

After stage 1 is broadcast and confirmed, re-plan stage 2 — this is deliberate
freshness, not ceremony. It rebuilds every observation and derives the counter's
CREATE address from the **actual current nonce**, and binds the verified stage-1
record (plan hash, transaction hash, block, runtime code hash) as a prerequisite:

```bash
npm run testnet:plan -- --purpose deploy --stage counter --address <sender>
```

Trying to plan stage 2 before the stage-1 record exists, or replaying stage 1
after a record/intent is durable, is refused. A stage-1 approval never authorizes
stage 2: the approval hash covers the whole plan including its stage selection
and prerequisites, so it cannot be replayed across stages.

## 2. Broadcast only the approved stage plan

Only after consent, use an explicitly selected absolute local signing-file path.
An external current-user-only file is preferred. An existing Git-ignored
`.env.local` is also supported when selected explicitly; it is never discovered
automatically and does not need to be copied. The signer loader rejects relative
paths, symlinks, non-files and files over 64 KiB, but does not verify Windows ACLs.

Validate the signer source without consuming approval or creating an intent:

```bash
npm run testnet:validate-signer -- --address <sender> --env-file <absolute-local-file>
```

The runner takes the plan payload hash as the exact approval:

```bash
npm run testnet:run -- --plan <stage-plan.json> --approve-plan <exact-sha256-hash> --confirm-atlantic-testnet --env-file <absolute-local-file>
```

The file has a locally configured `PRIVATE_KEY` and optionally `RPC_URL`; neither
is printed/copied. Do not create a repository environment file or use a literal
key flag. Pure approval, artifacts, balance, nonce, chain, code/caller and fresh simulation/
estimate checks precede key loading. The signer account must match `<sender>`.

The plan expires within an hour. If expired, changed, already attempted, or unsafe,
the runner refuses. After signed-payload verification, post-sign checks, journal
fsync and evidence persistence, it rechecks approval **synchronously immediately
before submission**, with no intervening await. An expired approval then records
terminal `ABORTED_BEFORE_SEND`: no RPC send, no automatic retry, and retained
INTENT/sender/nonce markers. If abort recording fails, the original intent still
blocks reuse. A submission made before expiry may be confirmed afterward.

Re-planning needs fresh consent and an unencumbered nonce; it cannot automatically
reuse an aborted or uncertain intent. Deployment approval does not authorize a
subsequent stage, batch or individual baseline, and a new hash alone does not
clear an existing marker. Each stage, batch and baseline lives under its own
plan hash in the shared state directory; a completed stage's record unlocks the
next stage's planning, nothing else.

Public execution state lives under `state/testnet/`: fsynced journal, sender
lock, immutable sender/nonce intents, per-stage deployment claims and verified
records, approval consumption records, and current execution JSON snapshots.
Do not remove them or choose a different state directory to bypass an intent.

## 3. Prepare one execution batch

Batch planning requires **both deployment records to verify fresh** (executor
source-bound runtime, current code, `authorizedCaller()`, and the counter bound
to the exact stage-1 record). Missing, changed or stale prerequisite bindings
refuse the plan before any signature:

```bash
npm run actions:demo -- --target <test-only-counter> --scenario mixed --out state/mixed-actions.json
npm run cli -- simulate --actions state/mixed-actions.json --sender <sender> --executor <executor>
npm run testnet:plan -- --purpose batch --address <sender> --executor <executor> --actions state/mixed-actions.json
```

This new plan contains exactly **one** `execute` transaction. Inspect every
predicted result, gas estimate, value/fee ceiling, code hash and nonce, then
request fresh consent before invoking the gated runner.

Review total gas feasibility, not only each action's syntax. The approved gas
must cover at least `minimumBatchTransactionGas` and pass fresh simulation/
estimation, the current block limit and the unchanged 5,000,000 runner ceiling.
That helper is only a necessary lower bound. For 32 default 100,000-gas actions,
5,230,816 execution reserve alone exceeds the ceiling; the plan must be rejected,
not silently split or given higher limits. Review token balance/allowance CALLs
separately; ownership is not a sandbox against the authorized caller.

`--purpose baseline` is an optional **separate** approval for N individual
transactions. It changes state and is never called a batch. Atlantic does not
provide the local snapshot-reset baseline. Strict `buildComparison` requires
matching canonical plans, shared starting block/hash/state root/environment,
distinct raw/normalized receipts, exact mined transactions and uninterrupted
nonce/mining order including canonical parent/count metadata. Sequential live
runs do not meet that shared-starting-state requirement. The shipped Atlantic
report does not infer a measured saving from them; another methodology would
require separate review, not forged bindings. Labeled same-block estimates, the
planned N→1 execution count and standalone verified batch gas are available
without broadcasting a baseline. [Methodology and first-use costs](evidence.md).

## 4. Reconcile, never resend

```bash
npm run testnet:status -- --plan <original-plan.json>
```

This command is read-only, accepts old expired plans for inspection, and never
loads a key, waits/sends, changes a journal or removes a lock. It verifies the
recorded hash against transaction/receipt/canonical block/runtime/caller/action
events. A consistent terminal abort can remain `ABORTED_BEFORE_SEND`, without
freeing its intent. A visible aborted hash/receipt or advanced nonce is a conflict
and stays unresolved. Otherwise, a hash not found remains UNKNOWN, including
when its nonce was consumed. Absence is not proof of non-broadcast.
Unverified/pending/unknown cases require manual investigation, not a retry or
regenerated plan at that nonce.

A confirmed outer batch may still contain failed subcalls. The runner reports
actual event outcomes and whether they match the approved simulation. Inspect
all actions and any failed-value credit; refund withdrawal is separate.
