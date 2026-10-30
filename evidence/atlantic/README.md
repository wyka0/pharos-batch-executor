# Atlantic testnet evidence

Verified live evidence for Pharos Atlantic Testnet (chain **688689**). Generated from canonical RPC reconciliation at commit `8f704ff29754aec698c22e9a2727a3ea8a7eb65b`.

- [Deployments](deployments.json)
- [Three-action success batch](success-batch.json)
- [Partial-failure batch](partial-failure.json)
- [Three-transaction individual baseline](individual-baseline.json)
- [Controlled gas comparison](gas-comparison.json)
- [SHA-256 manifest](manifest.json)

## Explorer links

- BatchExecutor deployment: https://atlantic.pharosscan.xyz/tx/0x0a548e5592cb051884dc54187279fe2830dbb8197976b3e66320a104efebdd0c
- TestOnlyCounter deployment: https://atlantic.pharosscan.xyz/tx/0x69deeec55829ac5beefb548811c44f081202ad2c84d33fca267f8d739c20959f
- Success batch: https://atlantic.pharosscan.xyz/tx/0xf5c66a8a443ca582ac418d4cfbc3e24aad67be90e2cc356a676a57a755c62992
- Partial-failure batch: https://atlantic.pharosscan.xyz/tx/0xbe3c0a33847734fc2ddadb47906a7f3653f109ffad81ffce1043f1014a5032e8
- Individual baseline: https://atlantic.pharosscan.xyz/tx/0xfcdcff317361ff493756f2dc743077b651d7047a287a151b27485dbaf85984b1, https://atlantic.pharosscan.xyz/tx/0x506815a65f1547de7df308caec1adf87a2816239bc245f112023c6383bc1f4f1, https://atlantic.pharosscan.xyz/tx/0xd54f3ea4c6b05abc2ef98c7c5123dc359239a1bf48d7a4b2a4e7211cf05cb18c

## Measurement disclosure

This is a controlled equivalent-fresh-storage comparison at different blocks. It is not an identical-state, same-block or snapshot-restored benchmark. The observed difference is specific to these live transactions and is not a guaranteed or universal gas saving.

Receipt-derived fees are arithmetic calculations, not independently observed balance debits. Deployment/setup gas is reported separately and excluded from the execution-only comparison. Raw local execution state, signer data, environment files and serialized signed transactions are not included.
