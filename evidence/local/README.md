# Curated local EVM proof

**Real disposable Anvil execution, chain 31337. NOT Atlantic explorer proof.**

Source run: `local_2026-10-29T06-48-37-162Z_e3a049ac`. All local assertions passed; 14 transactions including setup/baseline/withdrawal.

Measured: **273942 gas / 6 individual transactions** vs **235910 gas / 1 batch**.
Reduction: **38032 gas (13.88%)**; **83.33% fewer execution transactions**.

LOCAL identical-state snapshot experiment: 6 real individual receipts captured before evm_revert, then 1 real batch from the restored block/state root. Baseline branch hashes are removed and are not current canonical-chain or Atlantic proof.

The Anvil process is stopped. Baseline branch hashes were verified before evm_revert and are no longer queryable.
Curating checks internal consistency and hashes; it does not re-query or claim a current canonical-chain/light-client proof.

- [Summary and setup/withdrawal raw receipts](summary.json)
- [Individual branch capture, including all six raw receipts](individual-before-snapshot-revert.json)
- [SHA-256 file manifest](manifest.json)
- [success — per-action report](local_2026-10-29T06-48-37-162Z_e3a049ac_success.md) / [complete JSON](local_2026-10-29T06-48-37-162Z_e3a049ac_success.json)
- [mixed — per-action report](local_2026-10-29T06-48-37-162Z_e3a049ac_mixed.md) / [complete JSON](local_2026-10-29T06-48-37-162Z_e3a049ac_mixed.json)
- [gas-isolation — per-action report](local_2026-10-29T06-48-37-162Z_e3a049ac_gas-isolation.md) / [complete JSON](local_2026-10-29T06-48-37-162Z_e3a049ac_gas-isolation.json)
- [return-cap — per-action report](local_2026-10-29T06-48-37-162Z_e3a049ac_return-cap.md) / [complete JSON](local_2026-10-29T06-48-37-162Z_e3a049ac_return-cap.json)
- [refund-credit — per-action report](local_2026-10-29T06-48-37-162Z_e3a049ac_refund-credit.md) / [complete JSON](local_2026-10-29T06-48-37-162Z_e3a049ac_refund-credit.json)

Generated submission traces and setup receipts are included; no signing key, environment file, or signed payload is present.
