# Failure semantics

| Situation | Every action's status | Remaining actions / effects |
|---|---|---|
| Invalid input or failed preflight | Not submitted | No transaction attempted; no effects |
| Successful CALL | `succeeded`, `success: true` | Its low-level effects committed if outer receipt is verified successful |
| Target reverts / exhausts call gas | `failed`, `success: false`, decoded/bounded error bytes | Earlier successful effects remain; later actions still run |
| Every subcall fails | All `failed` | Outer batch may still have a successful receipt; all failures are explicit |
| Outer transaction reverts | All `not_committed`, `success: null` | No action effects or refund credit committed; intermediate call order cannot be proven from receipt |
| RPC fails after send attempt / receipt timeout | All relevant outcomes `unknown` | Acceptance/commitment uncertain; preserve computed hash and stop; no retries |
| Receipt exists but transaction/block/code/events fail verification | `unknown`, batch `unverified` | Raw evidence preserved; no application success assumed |
| Individual baseline submission uncertain | Current action unknown, later actions not submitted | Baseline stops; it is not a batch and is never silently continued/retried |

`Error(string)`, `Panic(uint256)` and known executor errors are decoded when
possible. Empty failure data means a revert or gas exhaustion without reason;
the tool does not pretend it can distinguish them from standard receipt data.
Unknown bytes are retained. Truncated results preserve their full byte count
and explicit truncation flag, not an invented full payload.

CALL success does not imply a protocol claim/transfer succeeded semantically.
The included Solidity test for returning `false` demonstrates this distinction.

## Gas reservation vs gas usage

The batch estimate reflects conservative execution reservation, not just expected
target usage. It can be much larger than actual receipt gas. An individual
reverting call may have no usable estimate; that action's estimate is `null` and
the individual total/estimated savings are unavailable. Do not fill gaps with
21,000 gas or another guess. A failed **batch** estimate blocks broadcasting.

## Failed native value

Value is accepted only when `msg.value` exactly equals the approved action sum.
Failed-call value becomes `refundCredits(sender)`, not an automatic refund.
The owner can separately call `withdrawRefund(recipient)`; failed withdrawal
preserves the credit. That withdrawal needs its own review/approval, gas and
transaction. The shipped Atlantic runner deliberately does not auto-withdraw
or provide an ungated generic transfer command. Use the owner's reviewed wallet
interface for a separate withdrawal. The local demo verifies credit and withdrawal.

Unexpected forced deposits and arbitrary tokens sent to the executor cannot be
swept. Do not send assets directly to the executor or grant it approvals.
