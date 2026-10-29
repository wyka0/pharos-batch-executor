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
- After post-sign checks, journal fsync and public-evidence persistence, a final
  **synchronous** approval check runs immediately before `sendRawTransaction`,
  with no intervening await. A deadline reached there produces terminal
  `ABORTED_BEFORE_SEND`, not a submission attempt. Approval is a submission
  deadline; confirmation may finish after it expires.

## Deployer-only CALL authority and token/allowance risk

The constructor sets `authorizedCaller = msg.sender` in write-once storage.
Only that immediate deployer may call `execute`; authorization is checked before
any target CALL. No setter, upgrade, delegatecall, `tx.origin` or forwarding/relayer
bypass exists. Storage rather than a Solidity immutable keeps deployed runtime
bytecode uniform, so a runtime hash **alone** does not establish caller ownership.
The adapter and runner also read `authorizedCaller()` before signing/sending and
when verifying successful executor deployment/batch receipts. The getter must
exist and match the submitting wallet; missing/malformed/mismatched replies fail
closed without replaying `execute` to infer mined outcomes.

Use **one executor per wallet**, not a permissionless shared approval proxy. The
contract blocks strangers from transferring its token balance, consuming an
allowance granted to it via `transferFrom`, or creating token approvals in its
name. The authorized caller is nevertheless trusted for **arbitrary reviewed
CALLs**, including all of those token operations. This is not a token-selector
sandbox, and the contract cannot protect an allowance from its authorized caller.
Never grant broad allowances to an executor controlled by someone else.

There is no automatic token funding, allowance setup, revocation or sweep helper.
A token that permits it can be transferred/recovered by an authorized action in
a fully reviewed valid batch. Do not claim that token approvals cannot exist or
that all tokens are irrecoverable. Do not fund or approve an executor by default;
review exact amounts, spenders, existing allowances and token return semantics
separately. An authorized approval is still an approval risk.

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

These ceilings are **coupled**, not independent guarantees. For action caps `g_i`,
the contract requires execution gas remaining after validation of at least:

```text
60,000 + sum(g_i + ceil(g_i / 63) + 60,000)
```

`minimumBatchTransactionGas(actions, calldata)` adds the 21,000 intrinsic cost
and calldata byte cost to that reservation. It is a **necessary lower bound**,
not a sufficient limit: decoding, authorization/reentrancy checks, validation,
dispatch and any additional chain gas rules also consume gas. Pure approval
checks and the EVM adapter reject bounds below it; fresh estimation/simulation
and current block/runner ceilings still apply. For example, 32 default
100,000-gas calls need **5,230,816 execution reserve alone**, exceeding the
5,000,000 runner ceiling. Passing 3–32 syntax validation never guarantees a plan
fits or succeeds; do not silently split it or raise approved limits.

## Unknown-submission discipline

The runner fsyncs sender/nonce intent markers, its journal and public snapshots
before sending. Exactly one send call is attempted; RPC transport retries are
disabled. A timeout/mismatch/error halts remaining transactions. An offline
computed INTENT hash does **not** prove the RPC accepted the transaction.

If the final approval guard aborts, the journal records
`INTENT → ABORTED_BEFORE_SEND`; abort is terminal and cannot follow `SUBMITTED`.
Both the original INTENT and immutable sender/nonce marker remain. Even a fresh
approval hash cannot authorize automatic reuse. If recording the abort fails,
the original intent remains protected and no send is made. Read-only
reconciliation preserves a consistent local abort without clearing it; a visible
hash, conflicting receipt or advanced nonce stays unresolved and requires manual
investigation. RPC absence alone never clears an intent.

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

There is no configurable caller/admin, proxy or delegatecall path. Native refund
credits are owner scoped: successful-call value is forwarded, failed-call value
is withdrawable credit, and `msg.value` must equal the full action sum. Forced
native balances cannot be spent or swept as action funding. Token behavior is
different: authorized token CALLs can move balances or alter allowances as
described above. Reentrancy protection, bounded CALLs and exact value accounting
remain in force.

Measured savings also require exact plan, starting state/environment, distinct
raw/normalized receipts, mined transaction/order metadata and matching outcome
bindings. Legacy or mismatched captures are rejected rather than upgraded into
proof. See [comparison and historical first-use accounting](evidence.md).

## Publication controls

`.gitignore` excludes environment files, local state, raw runs, logs and generated
tool caches. `package.json` has an explicit publication allowlist. Public-output
checks reject sensitive fields/credential patterns; the repository scanner
never prints matching values. Reviewed local receipts are the only curated
evidence, and the existing set is frozen pre-hardening proof. Scanners cannot
reliably recognize every possible secret, so inspect
the exact staged/packed file list before publishing. No install-time hooks exist.
