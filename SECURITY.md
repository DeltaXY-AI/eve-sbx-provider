# Security boundary — experimental v0.1

This package is a local Eve sandbox backend, not a security certification or a production multi-tenant readiness claim. The reference environment is Windows 11 x64, Node 24, Eve 1.0.0-rc.6, sbx 0.51.0, and the prepared Alpine guest. Read the consuming repository's `research/sbx-provider/step-11-security.md` for exact results and BLOCKED tests. Do not generalize the results to other hosts/images/backends.

## VM/filesystem isolation

New sessions own distinct native VMs. Used session VMs are destroyed, not recycled into ready pools. The provider passes no workspace or host bind mounts, disables shared skills (`--skills off`) and static MCP servers (`--static-mcp none`), and rejects any native host/runtime filesystem mounts reported by sbx before using a build/runtime VM. These flags and checks are not proof against every native runtime escape or against a malicious daemon/kit/base image.

The command helper clears supplementary groups and drops to uid/gid 1000 before accepting requests. Tests use the **actual provider command path**, a root-owned protected fixture, and the absence of sudo in the prepared default image. Trusted authored preparation or a different image can change the guest's security properties; rebuild and repeat the checks after such changes. The local operator's raw sbx CLI can still execute as root. The host/daemon/operator are trusted.

## Network control

Runtime defaults to **deny-all** for both cold creates and ready pools. A per-sandbox `--deny-network "**"` rule is installed **during native create**, before a helper/channel or VM can be assigned to a session. The active wildcard TCP/UDP policy is verified before readiness. No global daemon rules are edited. Ready pools are keyed by namespace, template, requested policy, size and executable.

Only `deny-all` and explicit `allow-all` are supported. Domain lists, unknown strings, nulls and unsupported option shapes reject before assignment. `allow-all` installs a scoped wildcard TCP/UDP allow rule; it does not override higher-priority daemon/organization denies. Build/template preparation may use the Internet for package installation and trusted authored preparation; runtime denial is not a build-time offline guarantee.

Open options apply only to a **new** VM. Reopening an existing session preserves its native VM and policy, even when the caller requests a different policy. Resume checks the native policy against the recorded policy. Existing pre-SBX-11 VMs without a verified scoped provider policy are refused with instructions to end the legacy session and create a new one; the provider does not silently relabel them deny-all or delete them.

Tests distinguish backend policy decisions, observable request denial and endpoint reachability. An unreachable address by itself is not firewall proof. An allow-all positive control must reach the same controlled endpoint; the deny VM must receive no successful endpoint response and the endpoint must record zero requests. The sbx network mediator can accept a **local synthetic TCP handshake** and then reset/close it: the tested property is denial of end-to-end access/data to the controlled destination, not that `socket.connect` always fails before a local connect event. Read the raw `connected`, response and endpoint-counter evidence.

The native rule covers TCP/UDP, but current traffic fixtures exercise HTTP(S) and direct-IP TCP; they are not an exhaustive test of all protocols, DNS side channels, IPv6 routing or every daemon/control-plane endpoint. sbx's proxy/DNS/control-plane services (including its MCP gateway machinery) are not external endpoint reachability proofs. Static MCP servers are disabled, but that does not assert the gateway process is absent. No DigitalOcean metadata-service access test is claimed on Windows. Public-Internet and link-local validation require genuinely reachable, operator-controlled destinations; absent positive controls remain **BLOCKED**, not PASS.

## Host tools are outside the VM boundary

Authored Eve tools, hooks, connections and the Eve server run on the **host**, with their process credentials and filesystem/network access. This provider's VM/network controls do not sandbox those tools or the model provider's API calls. Do not expose unrestricted host sbx/docker/process/filesystem access to an untrusted session. Review tool authorization independently.

## Model behavior is a separate concern

A VM and an egress rule do not make model output trustworthy, solve prompt injection or stop an authorized tool from taking an unsafe action. Validate inputs/outputs and gate sensitive tools separately. No protection against all VM escapes, denial of service, resource exhaustion, noisy-neighbor effects or prompt injection is claimed. No destructive host-OOM test is required or performed. Prefer dedicated test machines and bounded workloads; resource-exhaustion resistance remains unqualified.

## Environment and diagnostic data

The provider does not copy host `process.env` into guest requests. sbx may supply its own guest configuration; explicit `spawn({ env })` values are intentional caller inputs. Do not put real secrets in build seeds or templates unless intentionally granting every resulting session access to them.

Provider default errors and optional lifecycle traces omit raw CLI stdout/stderr and guest error messages, which can echo command, stdin, env and file inputs. Trace fields such as namespace, native VM name and template/image identifiers are metadata: do not put secrets in those identifiers. Command stdout/stderr and file reads are intentionally returned **to the caller**, not redacted. Eve's own instrumentation, authored tools, application logging, model/service logs, sbx daemon logs and operator-run debug commands have separate policies and may expose data; review them independently. The tests verify package logs/default exceptions, not every component's logging configuration.

## Ownership / cleanup

One active serving process per namespace/storage is supported. Different applications require distinct namespaces. Session identity still survives duplicate/concurrent starts, including a tested pool-size-zero process race. The process deletes only its own unclaimed pool candidates and a session's verified durable claim. Templates are never automatically deleted on end/shutdown. Hard-kill orphan cleanup is manual: establish exact recorded unclaimed ownership, exclude all active claims and other apps, then remove individual exact names. PID existence, missing claims alone, age or prefixes never authorize deletion.
