# Batch evidence: local_2026-10-29T06-48-37-162Z_e3a049ac_refund-credit

- Adapter / chain: **local-anvil / 31337**
- Mode / state: **confirmed**
- Plan: `sha256:84e310554832785933ca28c71bb04494e190e8dfae010a1eaef4f2eef62d26e9`
- Actual measured receipt available: **true**

## Single batch transaction

- Hash: `0xdd32955860e82fc550805e22bff774556c6aabe20b60d79535b53de6305b792c`
- Receipt: **success**; block **7**; confirmations **1**
- Gas used: **137127 (ACTUAL)**; fee: **165248542082121 wei (ACTUAL)**
- Failed-call value credit: **1000 wei** (withdrawable credit)

| # | ID | Target | Outcome | Error |
|---:|---|---|---|---|
| 0 | refund-credit-before | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` | succeeded |  |
| 1 | failed-value | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` | failed | call reverted or exhausted its gas limit without revert data |
| 2 | refund-credit-after | `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512` | succeeded |  |

Execution continued after action 1; 1 of 1 remaining actions succeeded, 0 failed, and 0 have unverified outcomes.

## Comparison

| Metric | Individual baseline | Batch |
|---|---:|---:|
| Required transactions / execution steps | 3 | 1 |
| Gas estimate | UNAVAILABLE | 587060 |
| Measured receipt gasUsed | UNAVAILABLE | 137127 |

Baseline: Independent eth_estimateGas calls at the same block; no baseline transactions broadcast.

Estimated gas difference: **UNAVAILABLE** (estimation failure).
Measured gas saving: **UNAVAILABLE** (no comparable verified receipt sets).
Execution transaction reduction: **2 (66.67%)**.

## Limitations and safety

- Gas estimates are not measured usage. The executor reserves gas for every action, so the batch estimate can exceed actual gas used.
- Targets see the executor as msg.sender. Sender-dependent operations and dependent approve/swap/claim workflows are unsupported.
- Deployment, baseline experiments and refund withdrawals are separate transactions and excluded from per-batch execution counts.
- CALL success does not prove application postconditions or interpret a token return value of false.

Complete raw receipts, per-action return/revert bytes, estimates and approved calldata are in the adjacent JSON file.
