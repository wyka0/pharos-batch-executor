# Evidence and comparison methodology

## Three explicitly different evidence classes

| Class | Hash / block / gas meaning |
|---|---|
| MODEL | `sim_*` reference, no txHash/block/gasUsed; gas is an illustrative model estimate |
| Read-only RPC simulation | No mined receipt or broadcast hash; outcomes are predictions; estimates labeled `source: rpc` |
| Actual EVM receipt | Real hash, status, block number/hash, confirmations, gasUsed, effective price and exact fee; environment still labeled LOCAL or ATLANTIC |

Never relabel a modeled result or local hash as Atlantic proof. Never infer
actual return data by replaying `execute` with `eth_call` after mining. Reading
the write-once `authorizedCaller()` getter is an ownership check, not outcome
replay. A compiled artifact, an in-memory test signature or an in-process Foundry
test is not a deployment receipt or a measured network experiment.

## Frozen historical local experiment — pre-hardening

`evidence/local/` preserves run `local_2026-10-29T06-48-37-162Z_e3a049ac` from
the original commit `0779e1094fe957998b67c922bb3e5ce6a93955be`, on chain **31337**.
It used the **pre-hardening** executor, whose compiled runtime was 3,080 bytes.
The revised contract adds deployer-only authorization and has a 3,190-byte
compiled runtime. The old receipts do not measure the revised contract's
deployment cost, execution gas or caller protection.

That disposable Anvil run deployed a fresh executor/test-only target, captured
the starting block/hash/state root and took a snapshot. It ran six individually
verified writes to distinct keys, saved the baseline receipts **before** reverting,
restored the same starting block/state root, checked untouched keys and executed
the same six writes in one transaction. State effects and events were asserted
at capture time.

The baseline receipts are real observations from a deliberately discarded local
branch. Its hashes are no longer queryable after `evm_revert`; a saved canonical
check was true **at capture time**, not a claim that the branch remains canonical.
The disposable process was stopped. These are historical local observations,
not an Atlantic explorer link or independent current-chain verification.

The five saved scenarios demonstrated success, a middle revert with a later state
effect, gas-exhaustion isolation, capped large return data and failed native-value
credit. The owner separately withdrew the credit and verified it was cleared.
Current-source regressions are separate offline tests. A new `demo:local` run
requires separate approval, produces new evidence and may have different gas;
it must not replace or silently relabel this frozen proof.

## Execution-only metrics and full first-use accounting

- **Measured execution gas:** sum of actual individual receipt `gasUsed` versus
  the actual batch receipt `gasUsed`, excluding setup and later withdrawals.
  Current comparisons require the strict bindings below. No baseline, incomplete
  or mismatched captures, an outer revert or unverified outcomes means no measured
  baseline/saving is emitted. Standalone batch receipt gas can still be reported
  as consumption, not proof of successful action effects.
- **RPC estimates:** each individual estimate and batch estimate, pinned to the
  same estimation block. Failed individual estimates are `null`; no guessed
  total/saving is emitted. The reservation-heavy batch estimate can exceed the
  individual sum even when measured gas is lower; negative differences are
  disclosed, never spun as savings.
- **Transaction/step reduction:** required execution shape N→1. Setup deployments,
  baseline experiments and refund withdrawals are counted separately. Planned
  step counts do not imply a transaction was sent or that its effects succeeded.

The following numbers are from the **historical pre-hardening** receipts only:

| Item | Receipt gas | Transactions | Treatment |
|---|---:|---:|---|
| Six individual writes | 273,942 | 6 | Execution-only baseline |
| Same six writes in one batch | 235,910 | 1 | Execution-only batch |
| BatchExecutor deployment | 740,669 | 1 | Batch-specific first-use overhead |
| TestOnlyCounter deployment | 221,814 | 1 | Common setup if both alternatives need a new target |
| Refund withdrawal | 33,387 | 1 | Separate, optional lifecycle operation in the refund scenario |

The historical execution-only difference is **38,032 gas / 13.88%**, with
**6→1 transactions / 83.33%** reduction. It is workload-specific, not a promised
discount. Historical RPC estimates were 273,942 individual versus 1,087,905 batch:
the estimate difference is **−813,963 gas / −297.13%**, not a saving.

For a first use that includes the same new test target in each alternative,
accounting derived from those receipts is:

| Alternative | Calculation | First-use gas | Transactions |
|---|---|---:|---:|
| Individual | 221,814 target + 273,942 execution | 495,756 | 7 |
| Batch | 221,814 target + 740,669 executor + 235,910 execution | 1,198,393 | 3 |

Thus the batch has a **702,637-gas first-use premium**; the 13.88% execution-only
reduction must not be advertised as a first-use gas saving. These are derived
alternative totals, not two newly executed first-use experiments. If the target
already exists, omit its deployment from both alternatives; the premium remains.
Do not include the refund withdrawal in the successful six-write scenario, but
do include it whenever a workload actually needs that separate operation.

The complete saved demonstration submitted **14** transactions: two setup
deployments, six baseline writes, five scenario batches and one refund withdrawal.
It did not submit only one transaction overall.

Executor deployment amortizes only if repeated batches continue to save gas:
`ceil(740,669 / 38,032) = 20` similar batches would offset that historical
deployment overhead. This is a conditional arithmetic illustration, not a
measurement of current-contract break-even. One executor is bound to one deployer;
another wallet needs its own deployment. Revised authorization, different
targets/calldata, chain gas rules or smaller batches can change or eliminate
the saving. Native value is not gas; exact receipt fees are `gasUsed ×
effectiveGasPrice`, and different gas prices prevent treating a gas ratio as an
identical fee ratio.

## Strict measured-comparison API and capture requirements

`buildComparison` takes the **validated action list**, not an arbitrary action
count:

```ts
const actions = validateActions(input);
const comparison = buildComparison(actions, estimates, batchCapture,
  individualCapture, 'Describe the actual identical-starting-state experiment.');
```

The boundary revalidates actions and recomputes the canonical plan hash. A
measured baseline is accepted only when all of the following are available and
consistent:

1. Both `comparisonBinding` records identify that exact ordered plan, including
   IDs, targets, calldata, values and per-action gas limits. Environment/chain,
   sender, executor/runtime code hash and starting block number/hash/state root
   must match. Missing, malformed or zero-sentinel header/runtime hashes fail.
2. One raw/normalized batch receipt and exactly N raw/normalized individual
   receipts agree on status, block, `gasUsed`, price and fee. All N+1 hashes are
   distinct. Capture-time canonical checks require at least one local or two
   Atlantic confirmations.
3. Mined transaction records bind each receipt hash and block/index to the exact
   sender, chain and nonce. The batch has the prepared `execute` calldata and total
   value; every baseline transaction has its action's target/calldata/value.
   Both first nonces match; individual nonces are consecutive.
4. Both first transactions are index zero in the immediate child of the shared
   starting block, whose hash must match each receipt block's parent. Subsequent
   baseline transactions are adjacent within a block, or go from the **last**
   transaction of one block to index zero of its immediate child. Captured
   `parentBlockHash` and `blockTransactionCount` are required; missing metadata,
   intervening transactions/blocks and inconsistent mining order are rejected.
5. The outer batch is confirmed successful, all outcomes are receipt-bound and
   complete, batch events match the canonical actions and reported return data,
   and individual receipt statuses agree with the corresponding batch CALL
   outcomes. Equivalent failed zero-value calls can qualify; outstanding
   failed-value credit cannot. CALL success still does not prove token return
   values or business postconditions.

Accepted captures expose `baselineValidation.status: 'accepted'`, individual
`measuredGas` and `measuredSavings`. Rejected captures expose `status: 'rejected'`
with a sanitized reason, **withhold individual measured gas and measured savings**,
and retain any standalone batch receipt gas. Model/RPC estimates and planned N→1
counts are not upgraded into measurements as a fallback.

The EVM adapter captures the starting header and the same mined transaction it
verifies, including canonical receipt-block parent/count metadata. It checks
executor runtime and `authorizedCaller()` at the starting and successful receipt
blocks. `createComparisonBinding` canonicalizes supplied observations; it does
not manufacture or independently prove them. These are RPC-backed capture-time
observations, not a trustless state proof or a proof of arbitrary independence.
Target behavior can still depend on caller, storage or block context. A fair
workload must be reviewed for those semantics, not merely labeled independent.

The frozen legacy captures lack these new bindings and are **not accepted as a
new strict comparison**. Their saved values remain untouched as historical proof;
do not retrofit invented metadata. Atlantic has no local snapshot restoration,
so a separately run live baseline does not establish the required shared starting
state. The shipped Atlantic report provides estimates and standalone batch gas,
not an automatic identical-state measured saving.

## Files and preservation

Raw local/model runs go under ignored `evidence/runs/`. Earlier failed runs are
kept; successful evidence is not overwritten. Atlantic plans/state are ignored
under `state/`; fsynced INTENT/hash records survive uncertain submissions.
The current state JSON is updated atomically, while snapshots and journal entries
preserve transitions. Raw signed payloads and configuration contents are never saved.

The existing `evidence/local/` publication set is frozen: **30 manifest-listed
files plus the manifest itself** must remain byte-for-byte equal to the original
commit. Its manifest SHA-256 is
`b788da219371205d79b2dcfc5d5b9f94bc777078ea5e94e487b8164331fc9df1`.
The curation script checks public data and internal consistency; it does **not**
re-query the terminated chain or turn old receipts into current proof. Do not
rerun curation to replace this set. Fresh current-contract/local or Atlantic
evidence requires separate approval and a separately reviewed capture, without
overwriting saved proof. Run public-data/path checks before any separately
authorized publication.

For Arena, provide an actual accessible repo/proof link once published or a
verified Atlantic explorer batch link once explicitly approved and executed.
Do not fill the submission with predicted deployment addresses or local hashes
as if they were live proof. [Submission checklist](../SUBMISSION.md).
