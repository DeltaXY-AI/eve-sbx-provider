# SBX-12 isolated ownership

Run `npm run test:subagents:live` from the provider package. This group is implemented in `assertions.mjs` and the common real-Eve supervisor under `tests/subagents/`.

The three declared workers each receive an explicit independent `SbxSandbox.environment()`, namespace and input seed. The parent has its own environment. Each worker writes a distinct exact synthetic marker at the SAME guest path `private/marker.txt`, plus a known worker-only marker path. A metadata barrier establishes all three files exist before each worker probes its siblings' known paths; all six cross-worker probes must be missing.

Assertions require three distinct worker VMs, owner IDs equal their actual child sessions, own marker readbacks before/after concurrent writes, exact results returned through Eve structured responses, no parent access to worker files, and native deletion on the supported child/parent lifecycle. No parent reading another VM's filesystem is used to collect results.

See `tests/subagents/README.md` for real-model calls, checked-in fixtures, version-specific semantics, lifecycle/native evidence, shared counterpart and safety limits.
