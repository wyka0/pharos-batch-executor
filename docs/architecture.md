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
                                                         one send attempt
                                                                |
                                      canonical receipt + ordered action events
                                                                |
                                                actual results / unknown halt
```

## Contract

`execute` validates the whole list and exact sum of values before side effects.
It reserves the sum of requested per-action gas, EIP-150 allowance, 60,000 gas
per action, and a 60,000 finish reserve. Each CALL uses the requested gas cap;
normal EVM value-call stipend rules still apply. Failures are results, not a
reason to skip later calls. Both successful and reverted returndata copies are
capped at 2,048 bytes; the full return size is reported.

Failed-call native value is credited to the submitting caller. A separate
non-reentrant withdrawal avoids a rejecting refund receiver reverting all
successful actions. There is no admin, proxy, delegatecall, allowance management,
receive function or way to spend forced balances as caller-supplied value.

## Execution classes

1. **MODEL:** no chain or network (`chainId: 0`); deterministic illustrative gas
   values and forced outcomes; `sim_*` references only.
2. **LOCAL EVM:** disposable loopback Anvil, chain 31337, unlocked public test
   account; actual receipts and asserted state effects; no private key loaded.
3. **ATLANTIC TESTNET:** exact official chain/RPC only. Public simulation is
   signer-free. Deployment/batch/baseline plans are independently approved.

Adapters are structurally mockable; no import-time signing or broadcasting.
The production CLI does not expose a generic ungated send command. A caller
supplying its own library submitter is responsible for its authorization;
the packaged Atlantic runner adds the mandatory plan/journal boundary.

## Verification

Verify exact hash/sender/recipient/input/value/chain/nonce, canonical receipt
block, at least two Atlantic confirmations, actual gas/legacy price, and expected
deployment runtime. Batch action logs must be from the executor, belong to that
receipt, appear in order, identify every action exactly once, and match the
summary/refund credit. Never reconstruct actual outcomes with a later eth_call.

Approval binds all public fields, targets/runtime hashes, nonces, outcomes and
gas/value/fee ceilings. The runner snapshots/freezes plans, signs offline,
recovers/checks the signed sender and every payload field, then persists INTENT
before the one send attempt. Sender locks and durable nonce intent markers
prevent two plans racing or a new plan silently retrying an uncertain nonce
within the same state directory. Cross-tool/machine concurrency is prohibited
operationally, not magically prevented by a local lock.
