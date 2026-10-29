# Setup

## Supported toolchain

- Node `^22.12.0 || ^24.0.0 || >=26.0.0`; development verified on Node 24.
  `skills@1.7.4` discovery additionally needs Node 22.20+.
- npm, using committed `package-lock.json` and `npm ci`.
- Foundry (`cast`, `forge`, `anvil`); verified with Foundry 1.2.3.
- Solidity 0.8.24, optimizer 200 runs, EVM `paris`. No vendored forge-std is
  needed. The Paris target avoids assuming later opcode support on Atlantic.

Install Foundry using its official installation instructions, inspect the
installer before running it, and check all three binaries' versions. Do not
configure a signing key for installation, tests, model demos or readiness.

```bash
node --version
npm --version
cast --version
forge --version
anvil --version
npm ci
npm run verify
```

Contract builds download solc only when it is absent from Foundry's cache.
Unit tests prohibit HTTP `fetch`; they use mocked RPC and fresh in-memory
test-only keys. `verify` does not start Anvil or submit network transactions.
Its production smoke checks write three explicitly modeled runs to ignored
`evidence/runs/` and verify the immutable saved local evidence manifest.

## Windows / WSL

Run npm from the Windows clone. Foundry scripts invoke WSL Ubuntu and resolve
`$HOME/.foundry/bin/forge` and `$HOME/.foundry/bin/anvil` in that distro.
Windows drive paths are mapped to `/mnt/<drive>/...` without shell interpolation.
Only the exact disposable Anvil process/port started by the demo is stopped.

Optional, non-secret overrides:

| Variable | Windows meaning | Linux/macOS meaning |
|---|---|---|
| `WSL_DISTRO` | Distro name, default `Ubuntu` | Not used |
| `FORGE_BIN` | Absolute Foundry executable path inside WSL | Executable/path, default `forge` |
| `ANVIL_BIN` | Absolute Anvil executable path inside WSL | Executable/path, default `anvil` |

Do not install signing configuration into the repository. See
[Atlantic approval](atlantic.md) and [security](security.md).

## Commands

| Command | Behavior |
|---|---|
| `npm run verify` | Contract build, TS/lint/unit/Solidity checks, production build, safety scan and offline production smoke |
| `npm run smoke` | Compiled CLI/model/library/declaration checks and saved manifest integrity; requires `dist/` |
| `npm run demo:simulated` | Deterministic zero-network MODEL; defaults to mixed failure |
| `npm run demo:local` | Fresh loopback Anvil, real local receipts, five assertions-backed scenarios |
| `npm run build` | Production JS/declarations in `dist/` |
| `node dist/cli.js --help` | Production CLI smoke test |
| `npm run testnet:readiness -- --address <sender>` | Public read-only Atlantic observation |
| `npm run testnet:plan -- ...` | Unsigned public approval plan; no signer |
| `npm run testnet:run -- ...` | Explicitly gated live TESTNET path only |
| `npm run testnet:status -- --plan <plan>` | Read-only reconciliation; never sends or clears state |

All application and test paths are relative to the repository root. Generated
state and raw evidence are ignored; do not delete earlier runs to hide failures.
