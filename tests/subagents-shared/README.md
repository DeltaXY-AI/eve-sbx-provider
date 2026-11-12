# SBX-12 shared ownership

Run `npm run test:subagents:live` from the provider package. This group is implemented in `assertions.mjs` and the common real-Eve supervisor under `tests/subagents/`.

The supervisor stages a complete Eve app and three declared workers. Every child explicitly exports `defineParentSandbox()` (Eve 1.0.0-rc.6); children have no independent workspace/skill seed. A real parent model invokes the bounded durable `delegate_three` tool, which dispatches all workers through `ctx.agent`. Worker tools produce `results/clause-001.json` through `clause-003.json` from the checked-in fixed text.

Assertions require one shared session-owning native VM, parent ownership for all children, three exact noncolliding artifacts, real child tool/session-end traces, parent read/command usability after all children end, and deletion only when the parent ends. Unclaimed ready-pool VMs are separate resources, not additional session-owning VMs.

See `tests/subagents/README.md` for fixtures, credentials/cost warning, version-specific semantics, evidence, isolated counterpart and safety limits.
