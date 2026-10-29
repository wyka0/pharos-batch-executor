# Failure semantics

| Situation | Every action's status | Remaining actions / effects |
|---|---|---|
| Invalid input or failed preflight | Not submitted | No transaction attempted; no effects |
| Unauthorized caller | Not submitted, or `not_committed` if externally broadcast and reverted | Rejected before any target CALL; token balances/allowances cannot be changed by a stranger |
| Approval expires at final send boundary | All affected actions `not_submitted`, step `ABORTED_BEFORE_SEND` | No RPC submission attempted; earlier confirmed setup remains, later steps stop; INTENT and sender/nonce markers stay protected |
| Successful CALL | `succeeded`, `success: true` | Its low-level effects committed if outer receipt is verified successful |
| Target reverts / exhausts call gas | `failed`, `success: false`, decoded/bounded error bytes | Earlier successful effects remain; later actions still run |
| Every subcall fails | All `failed` | Outer batch may still have a successful receipt; all failures are explicit |
| Outer transaction reverts | All `not_committed`, `success: null` | No action effects or refund credit committed; intermediate call order cannot be proven from receipt |
| RPC fails after send attempt / receipt timeout | All relevant outcomes `unknown` | Acceptance/commitment uncertain; preserve computed hash and stop; no retries |
| Receipt exists but transaction/block/code/caller/events fail verification | `unknown`, batch `unverified` | Raw evidence preserved; verified gas can remain available without assuming action success |
| Individual baseline submission uncertain | Current action unknown, later actions not submitted | Baseline stops; it is not a batch and is never silently continued/retried |
| Comparison captures are incomplete/mismatched | Original action evidence is unchanged | `baselineValidation: rejected`; no individual measured gas or measured savings, while standalone batch gas remains |

`Error(string)`, `Panic(uint256)` and known executor errors are decoded when
possible. Empty failure data means a revert or gas exhaustion without reason;
the tool does not pretend it can distinguish them from standard receipt data.
Unknown bytes are retained. Truncated results preserve their full byte count
and explicit truncation flag, not an invented full payload.

CALL success does not imply a protocol claim/transfer succeeded semantically.
The included Solidity test for returning `false` demonstrates this distinction.

`ABORTED_BEFORE_SEND` is a terminal local pre-send record, not permission to resend
its computed hash, clear an intent or regenerate a replacement plan at that nonce.
If abort persistence fails, the original INTENT remains and no send is made.
Read-only reconciliation can preserve a consistent abort, but a visible hash,
conflicting receipt or advanced nonce is unresolved; absence alone never makes
reuse safe. Expiry is checked immediately before submission after all pre-send
awaits; a transaction submitted before the deadline may confirm afterward.

## Gas reservation vs gas usage

The batch estimate reflects conservative execution reservation, not just expected
target usage. It can be much larger than actual receipt gas. An individual
reverting call may have no usable estimate; that action's estimate is `null` and
the individual total/estimated savings are unavailable. Do not fill gaps with
21,000 gas or another guess. A failed **batch** estimate blocks broadcasting.

The contract requires `60,000 + sum(g_i + ceil(g_i / 63) + 60,000)` gas **remaining
after validation**. `minimumBatchTransactionGas` adds transaction intrinsic and
calldata gas, but still omits other execution/network overhead; it is a necessary,
not sufficient, lower bound. Undersized approved bounds are rejected. All caps
must fit the block and the runner's 5,000,000-gas ceiling together. For 32 default
100,000-gas actions, execution reserve alone is 5,230,816: count-valid input is
not a feasible approved transaction at that ceiling.

## Failed native value

Value is accepted only when `msg.value` exactly equals the approved action sum.
Failed-call value becomes `refundCredits(sender)`, not an automatic refund.
The owner can separately call `withdrawRefund(recipient)`; failed withdrawal
preserves the credit. That withdrawal needs its own review/approval, gas and
transaction. The shipped Atlantic runner deliberately does not auto-withdraw
or provide an ungated generic transfer command. Use the owner's reviewed wallet
interface for a separate withdrawal. Frozen pre-hardening local receipts and
current in-process Solidity tests cover credit and withdrawal separately.

Forced native deposits cannot be swept or used as caller-supplied batch funding.
Tokens are different: an authorized reviewed token CALL may recover an
executor-held balance or change an allowance if the token allows it. There is
no automatic token rescue/approval endpoint or protection against the trusted
authorized caller. Do not send assets directly or grant blanket approvals by
default, especially to an executor controlled by another wallet.
