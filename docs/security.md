# Security boundary

**Testnet-only, not independently audited.** Passing tests and a scanner are
guardrails, not a promise of complete safety for arbitrary targets.

## Default-off signing

- Model, validation, planning, readiness, simulation and reconciliation never
  need signing configuration. Only the separately gated runner imports the
  local signer after pure approval checks and read-only preflight.
- The user must approve the exact public plan hash, sender and Atlantic TESTNET.
  CLI flags are review acknowledgements, not a cryptographic user-authentication
  service. An agent must not invent consent by setting those flags itself.
- Configure an existing external local file with `PRIVATE_KEY` (optional `RPC_URL`
  must exactly match Atlantic). Never put a key in this repo, chat, flags, example,
  CI, evidence or commit. The runner receives a file **path**, not key contents.
- The signer checks the public sender, signs offline, and the runner independently
  checks recovered sender/chain/nonce/to/data/value/gas/price before any intent.
  Signed bytes stay in memory; signing/submission exception objects are never logged.

## Hard limits per plan

| Limit | Ceiling |
|---|---:|
| Approval lifetime | 1 hour |
| Total value | 0.001 test PHRS |
| Maximum gas price | 25 gwei |
| Per-transaction gas | 5,000,000 |
| Total gas/value cost | 0.05 test PHRS |
| Action count | 3–32 |
| Per-action requested CALL gas | 25,000–1,000,000 |
| Action calldata / copied returndata | 4,096 / 2,048 bytes |

The approved gas price is exact; a higher current price blocks execution, not an
automatic fee increase. Balance covers the full remaining approved ceiling.
Fresh estimates, expected simulation outcomes, code hashes, block gas limit,
expiry, chain and latest/pending nonce are checked before sending.

## Unknown-submission discipline

The runner fsyncs sender/nonce intent markers, its journal and public snapshots
before sending. Exactly one send call is attempted; RPC transport retries are
disabled. A timeout/mismatch/error halts remaining transactions. An offline
computed INTENT hash does **not** prove the RPC accepted the transaction.

Use the same durable state directory for a sender. Never delete a lock/intent,
switch state directories, regenerate a plan at an uncertain nonce, replace a
transaction or use another wallet/tool concurrently to bypass safety. Local
locks cannot protect other machines or unrelated tools. On crash, preserve all
state and run read-only reconciliation. No automatic resume/replacement is shipped.

## Target and proof limitations

Targets can revert, return false, consume their gas, or attempt reentrancy/large
return data. Contract bounds isolate these cases; a sufficiently invalid or
underfunded **outer** transaction still reverts everything. Calldata validation
does not establish arbitrary target business semantics or independence.

A code hash does not bind a proxy's implementation or all target storage. A fresh
simulation is not a guarantee against intervening state changes/MEV. Use only
reviewed test-only/sender-independent targets for demonstrations. RPC verification
is an observation, not a trustless light-client proof. Two confirmations are a
policy, not a guarantee against all reorganizations.

No admin/proxy/delegatecall or asset approvals exist. Refund credits are owner
scoped. Native value for successes is forwarded; failures are withdrawable
credits. Forced native balances/tokens have no recovery/sweep mechanism.

## Publication controls

`.gitignore` excludes environment files, local state, raw runs, logs and generated
tool caches. `package.json` has an explicit publication allowlist. Public-output
checks reject sensitive fields/credential patterns; the repository scanner
never prints matching values. Reviewed local receipts are the only curated
evidence. Scanners cannot reliably recognize every possible secret, so inspect
the exact staged/packed file list before publishing. No install-time hooks exist.
