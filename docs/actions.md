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
enforces count/ID/target/calldata/value/gas bounds before any target call.
Calldata-bearing targets must have code; plain EOA/native transfers require
empty calldata. The executor itself cannot be an action target.

## Genuine independent examples

- Native value transfers to separate reviewed recipients, supplied entirely
  through the submitting transaction's `msg.value`.
- Sender-independent state writes to distinct keys of the included
  `TestOnlyCounter` (test-only, not a production protocol).
- Other target calls only when their actual ABI and sender/independence semantics
  are reviewed. Four valid selector bytes alone do not prove semantic validity.

## Unsupported

Targets see **the executor**, not the wallet, as `msg.sender`. There is no
delegatecall, smart-account impersonation, EIP-7702 delegation or transferFrom
approval machinery. The executor never signs for a wallet.

Do not use wallet-owned ERC20 `transfer`, sender-specific claims, claim-then-swap,
approve-then-transfer, swaps consuming prior outputs, or other dependent actions.
Never grant allowances to the executor to try to enable these workflows.
Native direct transfers are supported; this is not a generic token airdrop tool.

Independence is an explicit user assertion, not a theorem the validator can prove
for arbitrary bytecode. Likewise, CALL success is not a business postcondition:
an ERC20-like function returning `false` without reverting is recorded as a
successful low-level call. Receipts do not carry individual-call return data;
batch return/revert data comes from executor events.

See [failure semantics](failures.md) for gas bounds, returndata and value credits.
