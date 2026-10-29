# Atlantic Testnet: gated workflow

Network is fixed to chain **688689**, RPC
`https://atlantic.dplabs-internal.com`, explorer
`https://atlantic.pharosscan.xyz/`. Native currency is **test PHRS**.
Mainnet and alternate RPCs are rejected. All placeholders below must be replaced
with reviewed public values; do not paste a signing key.

## 1. Inspect without a key

```bash
npm run testnet:readiness -- --address <sender>
npm run testnet:plan -- --purpose deploy --address <sender>
```

The deployment plan contains **two setup transactions**: BatchExecutor and the
test-only counter. Predicted addresses are not proof of deployment. Inspect the
public JSON, cost ceiling, exact nonces, expiration and printed approval hash.
Stop for explicit approval of that exact plan. “Continue” is not consent.

The executor constructor authorizes the **immediate deployer**. The packaged
deployment transaction is sent directly by the reviewed wallet, giving that
wallet its own executor. Runtime bytecode is uniform across callers; verify both
the source-bound runtime and `authorizedCaller()` at the successful deployment
receipt block. Old permissionless deployments and another wallet's executor are
not compatible substitutes. Do not deploy through a factory/forwarder and assume
the wallet is the constructor caller.

## 2. Broadcast only the approved plan

Only after consent, use an existing local signing file **outside the repository**:

```bash
npm run testnet:run -- --plan <plan.json> --approve-plan <exact-sha256-hash> --confirm-atlantic-testnet --env-file <external-local-file>
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
subsequent batch or individual baseline, and a new hash alone does not clear an
existing marker.

Public execution state lives under `state/testnet/`: fsynced journal, sender lock,
immutable sender/nonce intents, current execution JSON and immutable snapshots.
Do not remove them or choose a different state directory to bypass an intent.

## 3. Prepare one execution batch

After both deployment receipts/runtime hashes and the executor caller are verified:

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
