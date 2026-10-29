# Architecture

## Why a small executor contract

Before choosing the design, the official SkillEngine instruction package,
Atlantic network configuration, existing local tooling/RPC/funding and Arena
requirements were inspected. No trusted existing Atlantic deployment of a
compatible bounded, continuing multicall was established. A small source-bound
contract provides an auditable **single transaction** without pretending that
N SDK sends are batching. [Official interface research](compatibility.md).

```
Untrusted JSON -> strict validation -> prepared calldata + public plan hash
                                      |                         |
                                      v                         v
                               model / eth_call           explicit approval
                                      |                         |
                                      v                         v
                               predicted results       offline-signature check
                                                                |
                                                      fsynced INTENT + snapshot
                                                                |
                                                final synchronous approval gate
                                                                 |
                                                   expired: terminal abort/stop
                                                   valid: continue below
                                                                 |
                                                          one send attempt
                                                                |
                                      canonical receipt + ordered action events
                                                                |
                                                actual results / unknown halt
```

## Contract

The constructor initializes write-once `authorizedCaller` storage to the immediate
deployer. Only that caller can execute; there is no setter, upgrade, delegatecall
or forwarding bypass. Storage keeps runtime bytecode uniform across deployers,
so ownership needs a separate getter check in addition to the runtime hash. One
executor per wallet replaces a permissionless shared proxy. The caller is trusted
for arbitrary reviewed CALLs, including token transfers/`transferFrom`/approvals;
authorization is not an ABI-selector sandbox.

`execute` checks caller authority, the whole list and exact sum of values before
any target CALL.
It reserves the sum of requested per-action gas, EIP-150 allowance, 60,000 gas
per action, and a 60,000 finish reserve. Each CALL uses the requested gas cap;
normal EVM value-call stipend rules still apply. Failures are results, not a
reason to skip later calls. Both successful and reverted returndata copies are
capped at 2,048 bytes; the full return size is reported.

The gas check uses `gasleft()` **after** decoding, authorization/reentrancy and
validation. `minimumBatchTransactionGas` adds intrinsic/calldata cost to the
execution reservation and rejects obviously undersized approved bounds. That
lower bound is necessary, not sufficient. Count, per-call cap, block limit and
the runner's 5,000,000-gas ceiling must fit together; 32 default 100,000-gas calls
need 5,230,816 execution reserve before other overhead.

Failed-call native value is credited to the submitting caller. A separate
non-reentrant withdrawal avoids a rejecting refund receiver reverting all
successful actions. There is no configurable caller/admin, proxy, delegatecall,
receive function or way to spend forced native balances as caller-supplied value.
There is no allowance-management/sweep helper, but an authorized target CALL can
transfer executor-held tokens or change allowances. Token recovery is conditional
on token semantics and must be a separately reviewed valid action plan.

## Execution classes

1. **MODEL:** no chain or network (`chainId: 0`); deterministic illustrative gas
   values and forced outcomes; `sim_*` references only.
2. **LOCAL EVM:** disposable loopback Anvil, chain 31337, unlocked public test
    account; actual receipts and asserted state effects; no private key loaded.
    The saved run is pre-hardening; fresh current-source local deployment/demo
    is a separate approval, not part of offline verification.
3. **ATLANTIC TESTNET:** exact official chain/RPC only. Public simulation is
   signer-free. Deployment/batch/baseline plans are independently approved.

Adapters are structurally mockable; no import-time signing or broadcasting.
The production CLI does not expose a generic ungated send command. A caller
supplying its own library submitter is responsible for its authorization;
the packaged Atlantic runner adds the mandatory plan/journal boundary.

## Verification

Verify exact hash/sender/recipient/input/value/chain/nonce, canonical receipt
block, at least two Atlantic confirmations, actual gas/legacy price, and expected
deployment runtime and its `authorizedCaller()` at the receipt block. Batch
runtime/caller checks also precede accepting action outcomes. Batch action logs
must be from the executor, belong to that
receipt, appear in order, identify every action exactly once, and match the
summary/refund credit. Never reconstruct actual outcomes by replaying `execute`
with a later `eth_call`; read-only ownership getter calls are not outcome replay.

`buildComparison(validatedActions, estimates, batch, individual)` recomputes the
exact action plan rather than trusting an action count. Measured comparisons need
matching starting block/hash/state root and environment/sender/executor/runtime,
N+1 distinct raw/normalized receipts, receipt-bound mined transactions and events,
and uninterrupted baseline nonce/mining order. Canonical parent hashes and block
transaction counts bind adjacent block boundaries. Missing or mismatched data
withholds individual measured gas and savings without hiding standalone batch
gas. Capture-time RPC bindings are not a trustless proof. Frozen old captures
are retained as historical observations, not silently migrated. [Methodology
and full first-use accounting](evidence.md).

Approval binds all public fields, targets/runtime hashes, nonces, outcomes and
gas/value/fee ceilings. The runner snapshots/freezes plans, signs offline,
recovers/checks the signed sender and every payload field, then persists INTENT.
After **all** pre-send awaits, the synchronous final approval check either invokes
the single submission call or records terminal `ABORTED_BEFORE_SEND`. No await
separates that check from the submission invocation. Abort never removes the
INTENT or sender/nonce marker. Sender locks and durable nonce intent markers
prevent two plans racing or a new plan silently retrying an uncertain nonce
within the same state directory. Cross-tool/machine concurrency is prohibited
operationally, not magically prevented by a local lock.
