# SBX-10 real ownership and restart tests

These are lower-level provider lifecycle tests. They are supplemented by two independently serving Eve applications in `tests/apps/`; run both suites with `npm run test:sbx10:live`. Provider instances in the ownership test below share one supervisor process and are not presented as independent Eve servers.

Run from `packages/eve-sbx-provider` with Node 24 and the local `sbx` daemon:

```sh
npm run test:ownership:live
```

This is an opt-in destructive integration test, not a mocked daemon. It builds and imports the original package's `dist` lifecycle implementation, prepares two unique seeded templates, creates unique namespaces, uses a temporary durable claim store, and removes only this run's known resources. It never deletes pre-existing VMs/templates. Allow several minutes.

- `tests/ownership/live.mjs`: A/B identical session IDs; claimed and ready markers, all stable inspect fields (only advancing `uptime` excluded), claims, channels, corrupt/foreign ownership rejection.
- `tests/start-race/live.mjs`: two simultaneous calls, then two barrier-started actual IPC child runners with one namespace/storage and pool zero. Inspects daemon inventory immediately after both callers finish; exactly one added VM.
- `tests/restart/live.mjs`: external parent kills an active/pooled runner with SIGKILL, restarts it, verifies durable claim/marker reconnection, old ready VM retention, graceful pool/channel release, then performs individually verified exact-name manual cleanup. B is rechecked throughout.
- `tests/cleanup-retry/live.mjs`: null/repeated/never-opened cleanup, changed build seeds with preserved existing VM/files, actual failed background creates, measured two-second retry scheduling, subsequent pool recovery and no unhandled rejection.

`tests/lifecycle/live.mjs` orchestrates these tests and captures JSON under `research/sbx-provider/raw/step-10/<timestamp>/`, including child stdout/stderr, process mappings, claims, inventories, exact manual commands, error timing, and summary. Redirect the console separately to retain the parent trace. Failed attempts remain evidence, not acceptance results. Hard-kill leftovers from an interrupted/failed test must be handled using the README's manual procedure; teardown deliberately does not globally discover/delete them. Templates are explicitly removed by the test supervisor only after app cleanup, never by provider lifecycle methods.
