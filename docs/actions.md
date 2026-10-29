# Actions and supported semantics

Input is a JSON array, not an object wrapping an array. All actions must be
reviewed by the caller as independent.

| Field | Rule |
|---|---|
| `id` | Required; trimmed, case-sensitive unique 1–64 characters: letters, digits, `.`, `_`, `-`; first character alphanumeric |
| `target` | Required nonzero EVM address; mixed-case must have a valid checksum |
| `calldata` | Required even-length `0x` hex; empty `0x`/empty string normalized to `0x`; otherwise at least a 4-byte selector, at most 4,096 bytes |
| `independent` | Required literal boolean `true` |
| `value` | Optional nonnegative wei; decimal string or safe integer; defaults to 0; each value and total fit uint256 |
| `gasLimit` | Optional decimal string/safe integer, 25,000–1,000,000; default 100,000 |
| `note` | Optional public string, at most 512 characters; never put a secret here |

There must be **3–32** actions. Unknown fields (including `dependsOn`) are
rejected rather than ignored. `null`, fractional, negative, unsafe-number,
invalid-address, duplicate-ID and malformed-calldata inputs fail before signing.
The plan boundary revalidates typed inputs and recomputes ID hashes.

The on-chain ID is `keccak256(UTF-8(trimmed id))`. The contract independently
enforces deployer-only caller authority and count/ID/target/calldata/value/gas
bounds before any target call.
Calldata-bearing targets must have code; plain EOA/native transfers require
empty calldata. The executor itself cannot be an action target.

## Genuine independent examples

- Native value transfers to separate reviewed recipients, supplied entirely
  through the submitting transaction's `msg.value`.
- Sender-independent state writes to distinct keys of the included
  `TestOnlyCounter` (test-only, not a production protocol).
- Other target calls only when their actual ABI and sender/independence semantics
  are reviewed. Four valid selector bytes alone do not prove semantic validity.

The immediate deployer is the write-once `authorizedCaller`; use one executor per
wallet. That caller can issue separately reviewed independent token operations:
`transfer` spends **executor-held** tokens, `transferFrom` consumes an existing
allowance to the executor, and `approve` creates an allowance **from the executor**.
The contract blocks strangers from doing these, but trusts the authorized caller.
It does not create funding/allowances automatically or verify ERC20 return values.
No such setup is authorized by a request to validate or simulate a batch.

## Unsupported

Targets see **the executor**, not the wallet, as `msg.sender`. There is no
delegatecall, smart-account impersonation, EIP-7702 delegation or automatic
approval machinery. The executor never signs for a wallet, and a forwarder or
relayer is not the authorized caller merely because the wallet initiated it.

Do not use wallet-owned ERC20 `transfer`, sender-specific claims, claim-then-swap,
approve-then-transfer, swaps consuming prior outputs, or other dependent actions.
Do not use allowances to disguise a dependent workflow as independent, grant
blanket allowances, or assume an executor controlled by another wallet is safe.
Native direct transfers are supported; arbitrary wallet-owned token airdrops
are not automatically enabled by this executor.

Independence is an explicit user assertion, not a theorem the validator can prove
for arbitrary bytecode. Likewise, CALL success is not a business postcondition:
an ERC20-like function returning `false` without reverting is recorded as a
successful low-level call. Receipts do not carry individual-call return data;
batch return/revert data comes from executor events.

## Coupled gas limits

The 3–32 action count and 25,000–1,000,000 per-call gas bounds are syntax limits,
not promises of execution. The combined contract reservation is
`60,000 + sum(gasLimit + ceil(gasLimit / 63) + 60,000)`. Transaction intrinsic and
calldata gas, decoding/authorization/validation and other overhead come on top.
`minimumBatchTransactionGas` is only a necessary lower bound; the adapter and
approval gate reject approved gas below it. Fresh simulation/estimation and the
current block gas limit still apply.

For example, 32 default 100,000-gas actions reserve **5,230,816** execution gas,
already above the runner's unchanged **5,000,000** transaction ceiling. Five
1,000,000-gas calls also exceed it even though each action is individually valid.
Smaller caps may fit, but no accepted count/cap combination guarantees success.
Reject infeasible plans for review; never silently split actions or raise limits.

See [failure semantics](failures.md) for gas bounds, returndata and value credits.
