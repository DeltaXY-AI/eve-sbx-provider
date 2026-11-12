# SBX-9 provider contract live test

Run from `packages/eve-sbx-provider` on the same host as the local `sbx` daemon, with Node 24.x, Eve `1.0.0-rc.6`, and a working `sbx v0.51.0` runtime:

```powershell
npm run test:provider-contract:live
```

This is a real-runtime destructive integration test. It creates a unique template, VMs, files, background processes, and pool resources. It removes only its unique test template and exact session/pool VMs. Do not run simultaneously with another SBX-9 run in the same namespace (each run has a random namespace). Warm-pool VMs may exist during the test and are disposed by exact namespace. Do not use `sbx reset`, `prune`, or global cleanup.

The runner packs the current package, extracts the tarball, then imports the lifecycle test seam from the packed `dist/internal` path. The package root export remains unchanged. It exercises the provider's actual lifecycle and `SandboxConnection` against local `sbx`; it does not use a model or eve app chat. It writes tarball, host versions, lifecycle traces, commands, stdout/stderr, exit codes, VM mappings, timings, before/after inventory, and a summary under `research/sbx-provider/raw/step-09/<timestamp>/`.

Covered in current live runner: cwd/env/`AI_AGENT=eve` and override, separate stdout/stderr and nonzero exit, stdin and EOF, 256 KiB binary file roundtrip, missing/directory/unreadable reads, nested creation and overwrite, force/recursive removal, 20 parallel routed commands, abort/process-group disappearance, repeated stop/stopped-state evidence/resume with retained data, external VM deletion and `SandboxSessionGoneError`, invalid state, typed missing template without rebuild, five concurrent independent VMs with 20 files each/search/read/end, zero/two pool inventory and replenishment, and cold/warm/command latency samples. It asserts the two specified latency targets without weakening them.

A non-live invocation fails closed unless `SBX9_LIVE=1`; the live npm script sets this opt-in. Unit tests remain available through `npm test`. Do not report an SBX-9 pass until the run's `summary.json` is PASS and every required assertion has evidence. Hardware timing misses remain failures requiring investigation, not threshold changes.
