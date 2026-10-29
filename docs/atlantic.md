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

## 2. Broadcast only the approved plan

Only after consent, use an existing local signing file **outside the repository**:

```bash
npm run testnet:run -- --plan <plan.json> --approve-plan <exact-sha256-hash> --confirm-atlantic-testnet --env-file <external-local-file>
```

The file has a locally configured `PRIVATE_KEY` and optionally `RPC_URL`; neither
is printed/copied. Do not create a repository environment file or use a literal
key flag. Pure approval, artifacts, balance, nonce, chain, code and fresh simulation/
estimate checks precede key loading. The signer account must match `<sender>`.

The plan expires within an hour. If expired, changed, already attempted, or unsafe,
the runner refuses. Re-planning is allowed only when there is **no uncertain
submission**, and a new plan needs new consent. Deployment approval does not
authorize any subsequent batch or individual baseline.

Public execution state lives under `state/testnet/`: fsynced journal, sender lock,
immutable sender/nonce intents, current execution JSON and immutable snapshots.
Do not remove them or choose a different state directory to bypass an intent.

## 3. Prepare one execution batch

After both deployment receipts/runtime hashes are verified:

```bash
npm run actions:demo -- --target <test-only-counter> --scenario mixed --out state/mixed-actions.json
npm run cli -- simulate --actions state/mixed-actions.json --sender <sender> --executor <executor>
npm run testnet:plan -- --purpose batch --address <sender> --executor <executor> --actions state/mixed-actions.json
```

This new plan contains exactly **one** `execute` transaction. Inspect every
predicted result, gas estimate, value/fee ceiling, code hash and nonce, then
request fresh consent before invoking the gated runner.

`--purpose baseline` is an optional **separate** approval for N individual
transactions. It changes state and is never called a batch. Atlantic does not
provide the local snapshot-reset baseline: do not claim an identical-state
measured comparison without another explicitly justified methodology. Labeled
same-block estimates and the N→1 execution transaction reduction are available
without broadcasting a baseline.

## 4. Reconcile, never resend

```bash
npm run testnet:status -- --plan <original-plan.json>
```

This command is read-only, accepts old expired plans for inspection, and never
loads a key, waits/sends, changes a journal or removes a lock. It verifies the
recorded hash against transaction/receipt/canonical block/runtime/action events.
If a hash is not found, even with a consumed nonce, the outcome stays UNKNOWN.
Absence is not proof of non-broadcast. Unverified/pending/unknown cases require
manual investigation, not a retry or regenerated plan at that nonce.

A confirmed outer batch may still contain failed subcalls. The runner reports
actual event outcomes and whether they match the approved simulation. Inspect
all actions and any failed-value credit; refund withdrawal is separate.
