# SBX-12 — three real Eve workers, shared or isolated sandboxes

Run from `packages/eve-sbx-provider`:

```sh
npm run test:subagents:live
```

**This makes real hosted model calls and uses credits**, plus creates/removes uniquely scoped local sbx VMs. Node 24, Eve 1.0.0-rc.6, the existing local daemon and configured `OPENROUTER_API_KEY` are required. The supervisor reads the consuming project's `.env.local`/`.env` without copying either file into fixtures or VMs. Credentials and ephemeral HTTP passwords are redacted from saved logs. No scripted/mock language model or fake provider is substituted.

Default model: the consuming project's selected reference model, `openai/gpt-6-luna`, via installed `@openrouter/ai-sdk-provider@3.1.0`. Fixture reasoning is explicitly `low`, not the main app's `high`; the main app is unchanged. `SBX12_MODEL` can select another model for a separately recorded run. The model routes work/selects tools; it does not extract sentences or grade output quality.

## Version-specific ownership rules read before implementation

Installed `eve/docs/subagents/index.mdx` ("The isolation boundary"), `eve/docs/sandbox/index.mdx` ("Share a parent sandbox"), `eve/docs/tools/workflows.mdx` ("Delegate work: ctx.agent"), and `eve/docs/guides/client/streaming.mdx` are the reference.

- A declared subagent inherits nothing from the parent by default.
- Shared children explicitly export **`defineParentSandbox()`**. They have no child workspace seeds/skills. The parent selector receives the owning parent session and initializes a repeated-safe ownership marker.
- Isolated children each explicitly declare **their own `SbxSandbox.environment()`**, selector, namespace and assigned input seed. Parent has its own environment as well.
- An authored workflow tool's `ctx.agent()` sessions end when that workflow finishes. The supervisor verifies actual recorded child `session.ended` events via the authenticated parent-to-child reader, not just idle replies or terminal hook stdout.

## Checked-in fixture and mechanical work

`fixtures/inputs/clause-001.txt` through `clause-003.txt` contain a fixed ID and a fixed quoted sentence. `fixtures/expected.json` contains the exact corresponding objects; `fixtures/markers.json` contains the three synthetic private markers. Unit tests compare the parser to the checked-in expected file, not to expectations generated from the same parser.

The real parent model calls **`delegate_three` once**. Its durable Eve workflow starts exactly three declared workers with `Promise.all(ctx.agent(...).send(...))`. These are real child sessions/streams through Eve. Each real worker model calls its assigned `process_fixture` tool once; that deterministic tool reads the guest input, parses its exact ID/sentence, writes `results/clause-001.json` (or 002/003), and reads it back. The worker returns the complete tool object using Eve structured output. The supervisor requires byte-equivalent normalized JSON between worker tool trace and value returned through Eve, and between extracted objects and checked-in expectations.

The parent then calls `verify_parent`, which ends the turn only after mechanical checks succeed. A second real parent turn calls only `verify_parent`, after the supervisor has observed all three child **session ends**. This proves parent compute/files remain usable, not merely that it can repeat a model reply.

## Test groups

- `tests/subagents-shared/assertions.mjs`: all four sessions map to **one owning native VM and the parent owning session ID**; exactly three correct noncolliding files; parent reads all artifacts and executes a command after every child ended.
- `tests/subagents-isolated/assertions.mjs`: **three distinct worker VMs**, each owned by its own child session, plus a separate parent VM. All workers use `private/marker.txt` for different exact markers; each reads its own marker before and after the other workers have written theirs. Each probes the two known sibling-only paths and must get missing. The result objects return through Eve, not through parent filesystem access.

A test-only host metadata barrier ensures all three workers have really created/read their marker files before any negative sibling probes. It stores only creation/identity metadata, never transports clause results to the parent. Each negative probe thus has a positive file-existence control in the sibling's live VM; it is not a test against a not-yet-created path.

## Ownership mapping and lifecycle evidence

The selector records the owning session ID/namespace inside the VM. A trusted fixture-only inspector reads only that app's matching durable claim, then performs native `sbx inspect` on the exact name. This does not spoof session IDs or replace the provider. Tool traces include this independent native identity evidence.

All environments use pool size **1** and default runtime deny-all. "One shared VM" means one **session-owning** VM for parent and children, not the absence of a separately recorded unclaimed ready-pool VM. The isolated version has three worker-owning VMs plus one parent-owning VM and separate unclaimed pool resources. The test makes no 100-worker claim.

Owning VMs must disappear through Eve's supported lifecycle: workflow-owned child closure and public parent `session.end()`. Raw post-end `sbx inspect` results are recorded. No used VM may remain among pool survivors. Authenticated drain invokes `shutdownSbx` for this run's namespaces and then awaits actual Nitro/Eve graceful handlers. On PASS no supervisor fallback VM deletion is allowed. Pre-existing VM/template identities must remain unchanged. Only unique test templates are explicitly removed by the supervisor; native assembled-image caches are retained and recorded.

This Eve release can close an end control's delivery stream before the receipt settles. The test therefore requires the actual recorded `session.ended` fact plus native VM deletion, rather than treating the receipt as the only lifecycle authority. This does not bypass Eve cleanup or manually remove owning VMs to obtain a PASS.

## Evidence / limits

`research/sbx-provider/raw/step-12/<timestamp>/` contains staged complete Eve projects, build/server logs, initial parent tool/model events, authenticated child streams, parent snapshots including final end, shared/isolated ownership mappings, expected-vs-actual normalized JSON/hashes, raw native deletion status, baseline/final inventories, and summary. `research/sbx-provider/step-12-subagents.md` records acceptance and total runtime **as context only**.

This is not a regulation-mapping quality benchmark, a 100-worker capacity test, or evidence of token/cost improvements. SBX-11's public/link-local endpoint controls remain independently BLOCKED; this test does not change their status. Host fixture inspectors/barriers are test plumbing, not new untrusted-agent capabilities or a production tool-security claim.
