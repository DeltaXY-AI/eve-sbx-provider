# SBX-10: two independent Eve applications

These are real Eve app fixtures, not two lifecycle objects in one process:

- `app-a/`: its own project root, Node/Nitro server, port, `.eve/.workflow-data`, sandbox cache and namespace.
- `app-b/`: a separate project root, Node/Nitro server, port, durable store and namespace.
- `shared/`: authored agent, sandbox selector, deterministic probe hook and authenticated channels. Both apps use the original `@deltaxy.ai/eve-sbx-provider` public package export.
- `server.mjs`: external child entrypoint; loads compiled Eve output and awaits actual Nitro/Eve SIGTERM handlers on graceful shutdown.
- `live.mjs`: external supervisor and real `sbx` inventory checks. All session creation, sends and ends use the public authenticated Eve HTTP API.

## Run

From `packages/eve-sbx-provider`, Node 24 with the local `sbx` daemon available:

```sh
npm run test:apps:live
```

Run **all** SBX-10 checks (lower-level provider/race/retry plus real apps):

```sh
npm run test:sbx10:live
```

The supervisor stages projects in `research/sbx-provider/raw/step-10-apps/<timestamp>/projects/`. It links only this installed Eve version and the original provider package into a test-local `node_modules`, builds the agent, then deploys the same compiled application independently into both project roots. Ports are selected dynamically on loopback; namespaces include a random run ID. Authentication uses an ephemeral password passed only in environment variables. No user `.env` file is copied or loaded. Credentials are redacted from saved logs.

### Deliberately identical native Eve session IDs

Eve's public create API generates IDs; it does not accept a caller-selected session ID. The supervisor therefore creates one session in **its own test store**, with native sandbox opening temporarily deferred by the fixture selector. It waits for that background preparation attempt to settle, gracefully stops the bootstrap server, and copies that quiescent, never-opened session store into B's separate test store. It then starts both applications normally with different namespaces. Both public Eve session APIs consequently target the same actual `wrun_...` ID, while each application opens and owns a distinct native VM.

This is deliberately controlled test-data seeding, not an operational recipe for cloning live apps. No provider session IDs, framework code, active VM state, claims, or production data are patched/copied. The temporary bootstrap selector error is expected and recorded; normal selectors subsequently succeed through Eve's supported retry path.

### Deterministic probes, no model bill

An authored `turn.started` hook uses the real `ctx.getSandbox()` to read/write a per-app marker and execute `cat` in the VM, then cancels the turn **before** any model call. A cancelled turn is the expected test result; the session stays active. An accidental model call throws. This verifies Eve's actual session/sandbox persistence, cleanup, HTTP routing and restart behavior, without relying on a model to obey test prompts or claiming to test model quality.

### Assertions and cleanup

Both apps have active sessions and ready VMs. The supervisor ends A's session **through Eve**, drains A's provider resources, and gracefully closes A's actual HTTP server. B must retain its PID, claims, VM identities, ready inventory, both guest markers and ability to execute another probe. All inspect fields are compared except advancing `uptime`.

A later A process is hard-killed only after its session and ready pool are recorded. The restarted real app reconnects to its intact claimed VM and marker. Startup must leave the killed runner's ready VM alone. After quiescing A, an explicit operator-style manual step checks exact recorded ready ownership against **all A/B claims**, inspects that individual name, and deletes only that name. B and the claimed VM must still work. A reconnects again; normal final teardown ends both sessions through Eve and requires empty claims and **no fallback VM deletion**.

Final inventories must preserve all pre-existing VMs and template identities. Test-supervisor template removal is explicit and limited to the uniquely built test tag, never a provider shutdown operation. Any `sbx`-generated assembled-image cache retained by the daemon is recorded in `template-inventory-delta.json`; no cache or unrelated resource is pruned.

If interrupted, use recorded exact names and the provider README's manual procedure. Never infer deletion permission from a dead PID, prefix, age, or missing claim alone. One active serving process per namespace remains the only supported serving topology.
