# Action examples

`model-actions.json` uses valid TestOnlyCounter calldata but a **placeholder**
address. It is for offline validation/calldata preparation only, not a deployed
target or live broadcast plan. `invalid-empty.json` demonstrates fail-fast count
validation and must exit nonzero.

```bash
npm run cli -- validate --actions examples/model-actions.json
npm run cli -- plan --actions examples/model-actions.json
npm run cli -- validate --actions examples/invalid-empty.json
```

After separately approved/verified Atlantic setup, generate a fresh list using
the actual TestOnlyCounter address:

```bash
npm run actions:demo -- --target <deployed-test-only-counter> --scenario success --out state/success-actions.json
npm run actions:demo -- --target <deployed-test-only-counter> --scenario mixed --out state/mixed-actions.json
```

Generator scenarios: `success`, `mixed`, `all-fail`, `gas-isolation`, `return-cap`,
`refund-credit`. Default count is six for success and three otherwise; optional
`--count` is 3–32. Distinct prefixes/keys prevent accidentally reusing prior demo
state. These commands prepare inputs only: no RPC, simulation, key or broadcast.
Review the real target, semantics and values before simulation/approval. Refund
withdrawal is separate and is never auto-broadcast by this skill.
