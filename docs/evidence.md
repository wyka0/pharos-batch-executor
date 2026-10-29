# Evidence and comparison methodology

## Three explicitly different evidence classes

| Class | Hash / block / gas meaning |
|---|---|
| MODEL | `sim_*` reference, no txHash/block/gasUsed; gas is an illustrative model estimate |
| Read-only RPC simulation | No mined receipt or broadcast hash; outcomes are predictions; estimates labeled `source: rpc` |
| Actual EVM receipt | Real hash, status, block number/hash, confirmations, gasUsed, effective price and exact fee; environment still labeled LOCAL or ATLANTIC |

Never relabel a modeled result or local hash as Atlantic proof. Never infer
actual return data by replaying a transaction with eth_call after mining.

## Local identical-state experiment

`scripts/local-demo.ts` deploys a fresh executor/test-only target on its own
loopback Anvil. It captures the initial block/hash/state root, takes a snapshot,
runs six individually verified writes to distinct keys, saves the complete
baseline receipt evidence **before** reverting, restores the same block/state
root, checks untouched keys and executes the same six writes in one transaction.
State effects and all events/receipts are asserted.

The baseline receipts are real observations from a deliberately discarded local
branch. Its hashes are no longer queryable after `evm_revert`; a saved canonical
check was true **at capture time**, not a claim that the branch remains canonical.
The disposable process is stopped after the demo. This is reproducible local
proof, not an Atlantic explorer link or independent network verification.

The five batch scenarios prove success, a middle revert with later state effect,
gas exhaustion isolation, capped large return data, and failed native-value credit.
The owner separately withdraws the credit and verifies it is cleared.

## Metrics

- **Measured gas:** sum of actual individual receipt `gasUsed` versus the actual
  batch receipt `gasUsed`. Measured savings need equivalent verified outcome
  sets and a disclosed fair baseline. No baseline, missing outcomes, an outer
  revert or failed verification means measured savings are unavailable.
- **RPC estimates:** each individual estimate and batch estimate, pinned to the
  same estimation block. Failed individual estimates are `null`; no guessed
  total/saving is emitted. The reservation-heavy batch estimate can exceed the
  individual sum even when measured gas is lower; negative differences are
  disclosed, never spun as savings.
- **Transaction/step reduction:** required execution shape N→1. Setup deployments,
  baseline experiments and refund withdrawals are counted separately. Planned
  step counts do not imply a transaction was sent or that its effects succeeded.

The reproduced six-write result is 273,942→235,910 actual gas (38,032 / 13.88%)
and 6→1 execution transactions (83.33%). These values are local-target-specific,
not a promised gas discount for all arbitrary actions.

## Files and preservation

Raw local/model runs go under ignored `evidence/runs/`. Earlier failed runs are
kept; successful evidence is not overwritten. Atlantic plans/state are ignored
under `state/`; fsynced INTENT/hash records survive uncertain submissions.
The current state JSON is updated atomically, while snapshots and journal entries
preserve transitions. Raw signed payloads and configuration contents are never saved.

`npm run evidence:curate -- <successful-local-run-directory>` checks public data
and internal evidence consistency, then creates an immutable `evidence/local/`
publication set with original receipts, per-action JSON/Markdown, baseline capture,
summary, metadata and SHA-256 manifest. It does **not** re-query the terminated
chain or turn old receipts into a current network proof. Run the safety scanner
and inspect staged/packed files before publishing.

For Arena, provide an actual accessible repo/proof link once published or a
verified Atlantic explorer batch link once explicitly approved and executed.
Do not fill the submission with predicted deployment addresses or local hashes
as if they were live proof. [Submission checklist](../SUBMISSION.md).
