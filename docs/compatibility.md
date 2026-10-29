# Official interfaces and compatibility research

Inspected on 2026-10-29 before selecting the executor design:

1. [Official Pharos SkillEngine repository](https://github.com/PharosNetwork/pharos-skill-engine)
   at commit [`a873387c9e34e9ae8e71360d43dc33329a335a24`](https://github.com/PharosNetwork/pharos-skill-engine/commit/a873387c9e34e9ae8e71360d43dc33329a335a24).
   Its root `SKILL.md` uses name/description/version frontmatter and linked
   reference resources. Network constants live in `assets/networks.json`;
   `references/script-gen.md` explicitly describes viem TypeScript interaction
   scripts. Foundry is the official contract/tooling path.
2. [Official Atlantic configuration](https://docs.pharos.xyz/getting-started/network/atlantic-testnet.md):
   chain 688689, RPC `https://atlantic.dplabs-internal.com`, explorer
   `https://atlantic.pharosscan.xyz/`. The documented RPC rate limit is
   500 requests / 5 minutes; limit polling and parallel traffic accordingly.
3. [Arena Batch Executor task](https://pharos-agent-arena.vercel.app/tasks/batch-executor):
   accepts ≥3 independent actions, executes a genuine batch, reports gas/step
   reduction, explains partial failures; submission needs an openable proof link
   and a repo link when code is written. Optional video is a separate deliverable.

## What compatibility means here

This repository is an instruction skill package with a discoverable root
`SKILL.md`, linked documentation, network asset and locally executable runtime.
The runtime takes a validated action list and prepares one contract transaction.
It can be used by an agent that installs/loads the instructions and has a full
repository clone plus the stated toolchain.

The inspected official documents do **not** establish a public API for custom
hosted skill registration, authenticated skill publishing, or generating an
ai.pharos.xyz share URL. This repository does not invent such endpoints, API
credentials, callbacks, hosted execution or a completed platform registration.
Skill package discovery is not proof of hosted registration or live execution.

The core official package supports more networks and some direct key-argument
templates. This task intentionally narrows the runtime to **Atlantic only** and
uses offline local-file signing so secret bytes never appear in CLI arguments.
Actual live deployment/batching and GitHub publication must be verified separately.
