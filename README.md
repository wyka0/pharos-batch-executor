# Pharos Batch Executor

**3–32 independent EVM actions, one real transaction, explicit partial failures.**
An installable `SKILL.md` package and TypeScript/Solidity implementation for
Pharos **Atlantic Testnet (688689)**. Default operation is simulation; live
signing and broadcasting require a fresh, explicitly approved full-plan hash.

> **Status:** local EVM demonstration verified; no Atlantic deployment or
> broadcast is claimed. This is hardened, tested testnet software, **not an
> independently audited mainnet product**. See [submission status](SUBMISSION.md).

## Verified result

The disposable Anvil experiment restores the exact starting block/state root
between the individual baseline and batch execution:

| Execution | Actual receipt gas | Transactions |
|---|---:|---:|
| Six individual writes | 273,942 | 6 |
| One batch, same six writes | 235,910 | 1 |
| Reduction | **38,032 gas / 13.88%** | **5 / 83.33%** |

These are **real local EVM receipts, not Atlantic hashes**. Baseline receipts
were captured/verified before `evm_revert`; their discarded branch is no longer
queryable. Review [curated local evidence](evidence/local/README.md) or reproduce
it with `npm run demo:local`.

The full local demonstration submits **14** transactions: two setup deployments,
six individual baseline transactions, five one-transaction scenario batches,
and one refund withdrawal. Setup/baseline/withdrawal costs are not hidden inside
the one-batch execution count.

## Arena requirements

| Requirement | Implementation and proof |
|---|---|
| At least 3 independent actions | Strict 3–32 validation; explicit independence and unique IDs |
| Genuine batching | One payable `execute(Action[])` transaction; no sequential-send disguise |
| Gas saving / step reduction | Actual same-state local receipts, labeled estimates and counts |
| Clear partial failure | One ordered result event per action; bounded gas/return data; later effects asserted |

## Quick start

Requires a supported Node 22/24/26+ version, npm and Foundry for contract tests.
See [Windows/WSL and Linux setup](docs/setup.md).

```bash
npm ci
npm run verify

# No network, wallet, deployment or key:
npm run demo:simulated -- --scenario mixed
npm run cli -- validate --actions examples/model-actions.json

# Explicit disposable local EVM, never Atlantic:
npm run demo:local
```

`verify` builds source-bound contract artifacts, typechecks, lints, runs offline
unit tests and Solidity tests, builds the production CLI and scans public files.
It does not sign or broadcast. Foundry may download solc if it is not cached.
Offline production smoke checks also verify compiled CLI behavior, portable
declarations and the SHA-256 manifest of the saved local proof.

## Action format

```json
{
  "id": "independent-write-a",
  "target": "0x1111111111111111111111111111111111111111",
  "calldata": "0x12345678",
  "value": "0",
  "gasLimit": "100000",
  "independent": true,
  "note": "Syntax example only; substitute a reviewed deployed target and valid calldata."
}
```

Pass a JSON **array** of at least three such actions. Values are wei, represented
as decimal strings or nonnegative safe integers. Unknown fields, dependencies,
invalid checksums, malformed calldata, duplicate IDs and out-of-range gas are
rejected. [Full format and unsupported workflows](docs/actions.md).

**Important:** a target sees the executor as `msg.sender`, not the wallet.
Native transfers and sender-independent contract writes are suitable examples.
Wallet-owned ERC20 transfers, sender-specific claims, approval/swap sequences
and other dependent workflows are **not supported**. CALL success does not
interpret a token's `false` return or prove application postconditions.

## CLI and Atlantic workflow

```bash
npm run cli -- plan --actions <actions.json>
npm run testnet:readiness -- --address <public-sender>
npm run cli -- simulate --actions <actions.json> --sender <public-sender> --executor <deployed-executor>
npm run testnet:plan -- --purpose deploy --address <public-sender>
npm run testnet:plan -- --purpose batch --address <public-sender> --executor <deployed-executor> --actions <actions.json>
npm run testnet:status -- --plan <public-plan.json>
```

Angle-bracket arguments are placeholders, not runnable defaults. No key is
needed for these read-only commands. Generate realistic test-only write actions
after deployment with `npm run actions:demo -- --target <test-only-counter>
--scenario mixed --out <actions.json>`.

Broadcast is deliberately a separate command. [The approval workflow](docs/atlantic.md)
requires explicit user consent for the exact plan, network and sender, plus
`--approve-plan`, `--confirm-atlantic-testnet` and a local `--env-file` path.
Do not load or paste signing configuration during dry-runs. Any uncertain send
halts remaining transactions and is never retried automatically.

## Skill installation

`SKILL.md` follows the official Pharos SkillEngine repository's instruction
package convention. Skill discovery can be checked without installing into
agent configuration:

```bash
npx skills@1.7.4 add . --list
```

Once a GitHub repository exists, install its skill with
`npx skills@1.7.4 add <repository-url> --skill pharos-batch-executor`.
Keep a full runtime clone as well. **No undocumented hosted registration API,
share URL or automatic ai.pharos.xyz deployment is assumed.**
[Compatibility research and official sources](docs/compatibility.md).

The npm tarball provides the compiled read-only CLI/library and its source,
artifacts and references. Development checks and `testnet:*` scripts require
the **complete repository clone** and development dependencies from `npm ci`;
a production-only npm install is not a substitute for that setup.

## Design and evidence

- [`contracts/BatchExecutor.sol`](contracts/BatchExecutor.sol): permissionless
  non-upgradeable CALL executor; no admin, delegatecall or blanket approvals.
- [`src/`](src/): validation, exact calldata, model/read-only adapters, receipt
  verification, comparisons, public evidence and production CLI.
- [`src/testnet/`](src/testnet/): expiring approval plans, code/nonce/fee checks,
  offline payload verification, durable sender/nonce intents and reconciliation.
- [`tests/`](tests/) and [`contracts/test/`](contracts/test/): offline RPC mocks,
  signer tampering, uncertain submissions, failures, bounds and fuzz coverage.
- [`docs/`](docs/): [architecture](docs/architecture.md), [failure semantics](docs/failures.md),
  [security](docs/security.md), [evidence methodology](docs/evidence.md).

Raw runs and execution state stay local and ignored by Git. Only reviewed,
clearly labeled `evidence/local/` proof is curated for publication. The package
uses a publication allowlist; environment files and raw signed payloads are
excluded. MIT licensed; [security reporting](SECURITY.md).
