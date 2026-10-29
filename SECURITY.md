# Security

This release targets Pharos Atlantic Testnet only and is not independently
audited. Do not use it with mainnet funds, sender-dependent operations or blanket
token approvals. Read [the full boundary](docs/security.md).

Only the immediate deployer is authorized to execute. It remains trusted for
arbitrary reviewed token/allowance CALLs; caller authorization is not a token
sandbox. Use one executor per wallet, verify runtime **and** `authorizedCaller()`,
and do not approve an executor controlled by someone else. Saved local receipts
are pre-hardening observations, not an audit or gas proof for the revised code.

If you find a problem, stop broadcasting and preserve public plan, journal,
receipt/hash and reproduction details. Share only sanitized testnet artifacts
with the repository maintainer through an available private reporting channel.
Do not publish keys, mnemonics, signing configuration or serialized signed
transactions. No private reporting endpoint is claimed until the repo is published.

For uncertain submissions, run read-only reconciliation. Do not resend, replace,
delete locks/intents or reset local state to work around a safety refusal.
The same rule applies to terminal `ABORTED_BEFORE_SEND`: no RPC send was attempted,
but durable sender/nonce intents remain and cannot authorize automatic reuse.
