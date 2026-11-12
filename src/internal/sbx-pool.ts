import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { discardChannel, getChannel, type SbxChannel } from "./sbx-channel.js";
import { runSbx } from "./sbx-cli.js";
import type { SbxRuntimeOptions } from "./options.js";
import { assertNoHostMounts, readVmNetworkPolicy } from "./sbx-policy.js";
import { SandboxTemplateNotProvisionedError } from "eve/sandbox/provider";

function trace(enabled: boolean, event: string, details: object = {}) {
  if (enabled) console.error(JSON.stringify({ at: new Date().toISOString(), event, hostPid: process.pid, ...details }));
}
// Only VMs this process created and has not successfully claimed are eligible
// for synchronous shutdown cleanup. No global prefix sweep is performed.
const ownedNames = new Map<string, string>();
export function markVmClaimed(name: string) { ownedNames.delete(name); }
export async function removeVm(name: string, executable: string, signal?: AbortSignal) {
  await discardChannel(name);
  const r = await runSbx(["rm", "-f", name], signal, executable);
  const missing = r.stderr.split(/\r?\n/).some(l => l.trim() === `error: sandbox '${name}' not found`);
  if (r.exitCode !== 0 && !missing) throw new Error(`Delete sandbox failed (${r.exitCode})`);
  ownedNames.delete(name);
}
export async function createVm(template: string, options: SbxRuntimeOptions) {
  const namespace = createHash("sha256").update(options.namespace).digest("hex").slice(0, 8);
  const name = `eve-dsb-p-${namespace}-${randomUUID()}`;
  ownedNames.set(name, options.sbxPath);
  trace(options.trace, "create.begin", { name, template, namespace, networkPolicy: options.networkPolicy });
  try {
    // Native deny is installed atomically at creation, before guest processes or
    // a helper can be exposed. No global policy is ever modified.
    const r = await runSbx(["create", "--name", name, "-t", template, "--pull", "never",
      "--skills", "off", "--static-mcp", "none",
      ...(options.networkPolicy === "deny-all" ? ["--deny-network", "**"] : []), "shell"], undefined, options.sbxPath);
    if (r.exitCode !== 0) {
      if (r.stderr.includes(`error: image "${template}" is not cached locally and pull_policy=never`)) {
        throw new SandboxTemplateNotProvisionedError({ providerName: "docker-sandboxes",
          reason: `Prepared template ${template} is missing; rebuild the application.`, templateKey: template });
      }
      throw new Error(`Create sandbox failed (${r.exitCode})`);
    }
    if (options.networkPolicy === "allow-all") {
      const allowed = await runSbx(["policy", "allow", "network", "--sandbox", name, "--protocol", "tcp,udp", "**"], undefined, options.sbxPath);
      if (allowed.exitCode !== 0) throw new Error(`Set sandbox allow-all policy failed (${allowed.exitCode})`);
    }
    await assertNoHostMounts(name, options.sbxPath);
    if (await readVmNetworkPolicy(name, options.sbxPath) !== options.networkPolicy) {
      throw new Error("Sandbox runtime network policy verification failed");
    }
    const channel = await getChannel(name, options.sbxPath, options.trace);
    trace(options.trace, "create.ready", { name, template, namespace, networkPolicy: options.networkPolicy });
    return { name, channel };
  } catch (error) {
    try { await removeVm(name, options.sbxPath); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "VM creation and cleanup failed"); }
    throw error;
  }
}

type Ready = { name: string; channel: SbxChannel };
export class Pool {
  private ready: Ready[] = [];
  private pending = new Set<Promise<void>>();
  private retry?: ReturnType<typeof setTimeout>;
  private closed = false;
  readonly size: number;
  constructor(readonly template: string, readonly options: SbxRuntimeOptions) {
    this.size = options.poolSize;
  }
  take() {
    const vm = this.ready.shift();
    if (vm) this.fill();
    return vm;
  }
  fill() {
    if (this.closed || this.retry) return;
    while (this.ready.length + this.pending.size < this.size) {
      const work = Promise.resolve().then(async () => {
        const vm = await createVm(this.template, this.options);
        if (this.closed) await removeVm(vm.name, this.options.sbxPath);
        else {
          this.ready.push(vm);
          trace(this.options.trace, "pool.ready", { template: this.template, ready: this.ready.length, target: this.size });
        }
      }).catch(error => {
        // Background failures must remain visible even when verbose tracing is off.
        trace(true, "pool.error", { namespace: this.options.namespace, template: this.template, error: String(error), retryDelayMs: 2000 });
        if (!this.closed && !this.retry) {
          trace(this.options.trace, "pool.retry.scheduled", { template: this.template, delayMs: 2000 });
          this.retry = setTimeout(() => {
            this.retry = undefined;
            trace(this.options.trace, "pool.retry", { template: this.template });
            this.fill();
          }, 2000);
          this.retry.unref();
        }
      }).finally(() => { this.pending.delete(work); });
      this.pending.add(work);
    }
  }
  diagnostics() { return { template: this.template, networkPolicy: this.options.networkPolicy, target: this.size, ready: this.ready.map(v => v.name), pending: this.pending.size }; }
  async dispose() {
    this.closed = true;
    clearTimeout(this.retry);
    await Promise.all([...this.pending]);
    const results = await Promise.allSettled(this.ready.splice(0).map(vm => removeVm(vm.name, this.options.sbxPath)));
    const errors = results.filter(r => r.status === "rejected").map(r => r.reason);
    if (errors.length) throw new AggregateError(errors, "Pool cleanup failed");
  }
}
const pools = new Map<string, Pool>();
export function poolFor(template: string, options: SbxRuntimeOptions) {
  installExitCleanup();
  const key = JSON.stringify([options.namespace, template, options.networkPolicy, options.poolSize, options.sbxPath]);
  let pool = pools.get(key);
  if (!pool) { pool = new Pool(template, options); pools.set(key, pool); }
  return pool;
}
export function poolDiagnostics() { return [...pools.values()].map(p => p.diagnostics()); }
export async function disposePools(namespace?: string) {
  const owned = [...pools.entries()].filter(([, pool]) => namespace === undefined || pool.options.namespace === namespace);
  for (const [key] of owned) pools.delete(key);
  await Promise.all(owned.map(([, pool]) => pool.dispose()));
}
// Register only when the caller actually creates a pool; importing the package
// remains free of process hooks, child processes, and daemon calls.
let exitCleanupInstalled = false;
function installExitCleanup() {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  // Exit handlers cannot await. Remove only this process's unclaimed pool VMs,
  // using the exact executable path configured when each VM was created.
  process.once("exit", () => {
  for (const [name, executable] of ownedNames) {
    const result = spawnSync(executable, ["--no-input", "rm", "-f", name], {
      windowsHide: true, encoding: "utf8", timeout: 15000,
    });
    if (result.error || result.status !== 0) {
      process.stderr.write(JSON.stringify({ event: "pool.exit-cleanup-failed", name,
        error: result.error ? "CLI launch failed" : undefined, status: result.status }) + "\n");
    } else ownedNames.delete(name);
  }
  });
}
