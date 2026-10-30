# Pharos Batch Executor

**3–32 independent EVM actions, one real transaction, explicit partial failures.**
An installable `SKILL.md` package and TypeScript/Solidity implementation for
Pharos **Atlantic Testnet (688689)**. Default operation is simulation; live
signing and broadcasting require a fresh, explicitly approved full-plan hash.

> **Status:** deployer-authorized hardening is committed and verified on Pharos
> Atlantic Testnet. The tracked [Atlantic evidence bundle](evidence/atlantic/README.md)
> records deployments, a three-action success batch, a partial-failure batch and
> a controlled individual baseline. The saved local EVM proof remains separately
> labeled **pre-hardening**. This is testnet software, **not an independently
> audited mainnet product**. See [submission status](SUBMISSION.md).

## Historical execution-only result — pre-hardening

The frozen disposable Anvil experiment restored the exact starting block/state
root between the individual baseline and batch execution:

| Execution | Actual receipt gas | Transactions |
|---|---:|---:|
| Six individual writes | 273,942 | 6 |
| One batch, same six writes | 235,910 | 1 |
| Reduction | **38,032 gas / 13.88%** | **5 / 83.33%** |

These are **real historical local EVM receipts, not Atlantic hashes**. They measure
the old executor, not the revised 3,190-byte runtime. Baseline receipts were
captured before `evm_revert`; their discarded branch is no longer queryable.
The [curated local evidence](evidence/local/README.md) is unchanged. New comparisons
reject its legacy unbound captures rather than inventing current metadata.

First-use gas is different: the historical executor deployment cost **740,669**
gas, and common test-target setup cost **221,814**. Including that setup gives
**495,756 individual vs 1,198,393 batch gas**, a **702,637-gas batch premium**.
Deployment would amortize after roughly **20 similar batches only if** the old
38,032-gas execution saving persisted. This historical arithmetic is not applied
to the revised contract. [Full accounting and strict comparison requirements](docs/evidence.md).

The saved local demonstration contains 14 observed local submissions: two setup
deployments, six baseline writes, five scenario batches, and one refund
withdrawal. These are historical local-chain observations, not Atlantic
execution evidence. Setup/baseline/withdrawal costs are not hidden inside the
one-batch execution count.

## Verified Atlantic testnet evidence — current contract

Chain **688689**, deployed by
`0x299Ce4113abF88F4997737184aa8A7a3D58AC15C`:

- BatchExecutor [`0xF250…4032`](https://atlantic.pharosscan.xyz/address/0xF25013Db14c8B412191FF5f0606649A23D974032),
  deployed in [`0x0a54…dd0c`](https://atlantic.pharosscan.xyz/tx/0x0a548e5592cb051884dc54187279fe2830dbb8197976b3e66320a104efebdd0c).
- TestOnlyCounter [`0xD541…b47E`](https://atlantic.pharosscan.xyz/address/0xD54115B2c5698AAf468aa3d6623A3Dc3A650b47E),
  deployed in [`0x69de…959f`](https://atlantic.pharosscan.xyz/tx/0x69deeec55829ac5beefb548811c44f081202ad2c84d33fca267f8d739c20959f).
- Three-action success batch [`0xf5c6…2992`](https://atlantic.pharosscan.xyz/tx/0xf5c66a8a443ca582ac418d4cfbc3e24aad67be90e2cc356a676a57a755c62992):
  one outer transaction, three successful writes, **133,722 gas**.
- Partial-failure batch [`0xbe3c…32e8`](https://atlantic.pharosscan.xyz/tx/0xbe3c0a33847734fc2ddadb47906a7f3653f109ffad81ffce1043f1014a5032e8):
  success / deliberate failure / success, outer receipt successful, **110,637 gas**.
- Controlled three-transaction baseline: **136,959 gas** total across
  [`0xfcdc…84b1`](https://atlantic.pharosscan.xyz/tx/0xfcdcff317361ff493756f2dc743077b651d7047a287a151b27485dbaf85984b1),
  [`0x5068…4f1`](https://atlantic.pharosscan.xyz/tx/0x506815a65f1547de7df308caec1adf87a2816239bc245f112023c6383bc1f4f1)
  and [`0xd54f…b18c`](https://atlantic.pharosscan.xyz/tx/0xd54f3ea4c6b05abc2ef98c7c5123dc359239a1bf48d7a4b2a4e7211cf05cb18c).

For the controlled live comparison, the batch used **3,237 less receipt gas /
2.3635%** and reduced execution transaction count **3→1 / 66.67%**. This is an
equivalent-fresh-storage comparison at different blocks—not an identical-state,
same-block or snapshot-restored benchmark. It is specific to these transactions,
not a guaranteed or universal saving. Receipt-derived fees are arithmetic, not
independently observed balance debits. [Evidence and hashes](evidence/atlantic/README.md).

## Arena requirements

| Requirement | Implementation and proof |
|---|---|
| At least 3 independent actions | Strict 3–32 validation; explicit independence and unique IDs |
| Genuine batching | One payable `execute(Action[])` transaction; no sequential-send disguise |
| Gas saving / step reduction | Current Atlantic controlled comparison: 136,959 individual vs 133,722 batch gas; 3→1 transactions, with limitations disclosed |
| Clear partial failure | Verified Atlantic success/failure/success receipt; one ordered result event per action and later state effect |

## Quick start

Requires a supported Node 22/24/26+ version, npm and Foundry for contract tests.
See [Windows/WSL and Linux setup](docs/setup.md).

```bash
npm ci
npm run verify

# No network, wallet, deployment or key:
npm run demo:simulated -- --scenario mixed
npm run cli -- validate --actions examples/model-actions.json
```

`verify` builds source-bound contract artifacts, typechecks, lints, runs offline
unit tests and Solidity tests, builds the production CLI and scans public files.
It uses only test-generated in-memory signatures and Foundry's in-process test
EVM; it does not load real-wallet configuration, start Anvil/RPC or submit network
transactions. Contract builds run offline and require Solidity 0.8.24 in the
local Foundry cache.
Offline production smoke checks also verify compiled CLI behavior, portable
declarations and the SHA-256 manifest of the saved local proof.

`npm run demo:local` is a separate, explicitly approved loopback deployment/demo,
not part of `verify`. It would create **new current-source** receipts, not reproduce
or replace the frozen proof. Do not run it during offline-only hardening.

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

Action syntax limits are not execution guarantees. The contract reserves gas for
all calls together; **32 default 100,000-gas calls require 5,230,816 execution
reserve**, before intrinsic/calldata/validation overhead, exceeding the runner's
unchanged 5,000,000-gas ceiling. Undersized approved bounds are rejected.

**Caller boundary:** the constructor binds `authorizedCaller` to the immediate
deployer in write-once storage. Only that caller can execute; there is no setter,
upgrade, delegatecall or forwarding bypass. Use one executor per wallet, not a
permissionless shared approval proxy. Runtime hashes and the caller getter are
checked before signing/sending and when verifying successful deployment/batch
receipts.

**Important:** targets see the executor as `msg.sender`, not the wallet. The
authorized caller remains trusted for arbitrary reviewed CALLs, including
executor-held token transfers, pre-existing `transferFrom` allowances and token
approvals. Strangers cannot make those calls; this is not a sandbox against the
authorized caller. Do not fund or approve an executor by default. Wallet-owned
`transfer`, sender-specific claims, approve-then-swap and other dependent workflows
are **not supported**. CALL success does not interpret a token's `false` return
or prove business postconditions.

## CLI and Atlantic workflow

```bash
npm run cli -- plan --actions <actions.json>
npm run testnet:readiness -- --address <public-sender>
npm run cli -- simulate --actions <actions.json> --sender <public-sender> --executor <deployed-executor>
npm run testnet:plan -- --purpose deploy --stage executor --address <public-sender>
npm run testnet:plan -- --purpose deploy --stage counter --address <public-sender> # only after stage 1 verifies on-chain
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
The signer path must be absolute and explicitly selected; use
`npm run testnet:validate-signer -- --address <sender> --env-file <absolute-path>`
to check its derived public address without consuming approval, signing or
broadcasting. `.env.local` is never auto-discovered.
Do not load or paste signing configuration during dry-runs. Approval is checked
synchronously immediately before submission, after all pre-send awaits. Expiry
at that boundary produces terminal `ABORTED_BEFORE_SEND` with no RPC send;
durable sender/nonce intents remain. Neither an abort nor an uncertain send
authorizes an automatic retry or replacement plan.

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

- [`contracts/BatchExecutor.sol`](contracts/BatchExecutor.sol): deployer-only,
  non-upgradeable bounded CALL executor; no caller setter or delegatecall.
- [`src/`](src/): validation, exact calldata, model/read-only adapters, receipt
  verification, comparisons, public evidence and production CLI.
- [`src/testnet/`](src/testnet/): expiring approval plans, code/nonce/fee checks,
  offline payload verification, durable sender/nonce intents and reconciliation.
- [`tests/`](tests/) and [`contracts/test/`](contracts/test/): offline RPC mocks,
  signer tampering, uncertain submissions, failures, bounds and fuzz coverage.
- [`docs/`](docs/): [architecture](docs/architecture.md), [failure semantics](docs/failures.md),
  [security](docs/security.md), [evidence methodology](docs/evidence.md).
- [`evidence/atlantic/`](evidence/atlantic/): sanitized live deployment, batch,
  partial-failure and controlled-baseline evidence with a SHA-256 manifest.

Raw runs and execution state stay local and ignored by Git. Reviewed,
clearly labeled proof is curated under `evidence/local/` (historical Anvil) and
`evidence/atlantic/` (sanitized live testnet summaries). Environment files and
raw signed payloads are excluded. MIT licensed; [security reporting](SECURITY.md).
