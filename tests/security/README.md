# SBX-11 — real security-boundary checks

Run from `packages/eve-sbx-provider` on Node 24 with local sbx 0.51.0:

```sh
npm run test:security:live
```

Exit status: **0 PASS**, **1 FAIL**, **2 BLOCKED**. BLOCKED is not an acceptance pass. Unit validation/pool-partition checks run with `npm test`.

## Scope and safeguards

`live.mjs` imports freshly compiled lifecycle code from the original package and uses actual sbx creates, commands, scoped native policies, file operations and deletion. It creates unique namespaces/templates and one temporary host-only canary directory **outside the repository**. Only synthetic random canaries are used; their actual values are neither saved as fixtures nor printed. No `.env` is loaded. Captured provider logs are checked for canaries **before evidence redaction**; any required redaction fails the run. The host-only env value is restored and temporary host files are removed afterward.

All created sessions/pool VMs are scoped to this run. No global policies, host network adapters/firewall rules, pre-existing VMs, templates, ports or other apps are changed. Existing VM/policy inventories must match after cleanup. Explicit supervisor removal of the unique test-template tag happens only after VM cleanup; sbx-managed assembled-image caches are recorded/not pruned.

`isolation.mjs` covers:

- Host canary locally readable as a positive control, but known native/WSL/Docker host-path projections unreadable in the guest, with empty host/runtime mount inventories.
- Concurrent A/B VMs with distinct identities and a known secret-marker guest path unreadable from B.
- Destruction after session end, confirmed missing native VM, pool refill, and different next ready VM with no marker.
- Actual provider commands report uid/gid 1000, no root supplementary group; write to a root-owned fixture fails with EACCES, and sudo is absent in the default prepared image.
- Host-only env canary absent from guest environment, saved fixture bytes and cloned workspace/home/tmp tar bytes. Explicitly supplied guest env remains an intentional caller action.
- Command/env/stdin/file diagnostic canaries round-trip to the caller without entering normal logs. A trusted test operator replaces Node **inside one disposable test VM only** with a shim that makes the real sbx helper launch emit canaries and fail. Default exceptions/trace-off/on logs must omit those CLI stdout/stderr values. The VM is then destroyed; the clean template is not modified by that session-only shim.

`network.mjs` covers:

- Runtime default deny on a true cold (pool zero) path and an asserted ready-pool warm path.
- Native scoped policy/status and endpoint-counter evidence, with separate allow-all positive controls.
- Direct-IP TCP to this host's actual controlled listener (no DNS) and a separate `host.docker.internal` DNS-path control.
- Public-Internet and link-local checks **only when meaningful controlled endpoints are provisioned**.
- Unsupported domain-list/invalid policies reject with no new VM assignment.
- Four alternating allow/deny sessions drawn from simultaneously ready, separate policy pools; verify native policy and observed endpoint behavior for each.

The mediator can accept a local socket connect and then close/reset it. Evidence records `connected` separately from end-to-end `reached` and endpoint requests; no claim that every denied SYN/local connect event is dropped is made. TCP fixtures do not exhaustively validate UDP, IPv6, DNS side channels or every native control-plane service. No DigitalOcean metadata-service test is claimed.

## Provision the remaining positive controls

A local host listener is created automatically, but is **not a public-Internet endpoint**. Do not substitute an unowned third-party echo service or an arbitrary unreachable link-local address.

Run the provided synthetic-only endpoint on an operator-controlled machine/interface:

```powershell
$env:SBX11_ENDPOINT_BIND = "0.0.0.0"
$env:SBX11_ENDPOINT_PORT = "8080"
node tests/security/endpoint.mjs
```

Its only protocol is:

- `GET /sbx11/<run-id>/<label>` returns `{run,label}` and increments that label's request counter.
- `GET /sbx11/<run-id>/_counts` returns label counters without incrementing them.

Use dedicated/bounded test infrastructure. Expose the public endpoint through a controlled public host/TLS reverse proxy, and separately provide a genuinely reachable **controlled** link-local address (for example an operator-provisioned `169.254.77.11`, not the real metadata address `169.254.169.254`). Routing/listeners must work from an explicit allow-all VM as well as the host running the supervisor. Provisioning routes/aliases/firewall permissions requires the operator's review; this runner deliberately does not change the Windows network configuration or claim arbitrary IPs.

Then configure the supervisor, replacing the examples with your real endpoints:

```powershell
$env:SBX11_PUBLIC_URL = "https://your-controlled-public-endpoint.example"
$env:SBX11_LINK_LOCAL_URL = "http://169.254.77.11:8080"
npm run test:security:live
```

If the supervisor must query counters through a different route to the **same endpoint process/counter store**, also set `SBX11_PUBLIC_CONTROL_URL` or `SBX11_LINK_LOCAL_CONTROL_URL`. URLs must have no credentials; the fixture carries only synthetic run labels. Normal TLS verification remains enabled. A configured endpoint with a failed allow-all control remains BLOCKED.

No link-local packet test is attempted against an unprovisioned address. Read-only daemon policy decisions for a synthetic link-local address are saved as **policy-only evidence**, explicitly not proof of packet blocking.

## Evidence

`research/sbx-provider/raw/step-11/<timestamp>/`: one result per risk in `checks.json`, overall `summary.json`, native policies, controlled endpoint counts, warm/cold identities, host mount/privilege/env evidence, default diagnostic scan, before/after inventories and `provider.log`. The record is `research/sbx-provider/step-11-security.md`.

Build-time Internet access for setup is allowed and disclosed. See package `SECURITY.md` for VM isolation vs network policy vs host tools vs model behavior, legacy-session migration, and unqualified risks. There is no guarantee against all VM escapes, denial of service or prompt injection; no host-OOM test is performed or production multi-tenant readiness claimed.
