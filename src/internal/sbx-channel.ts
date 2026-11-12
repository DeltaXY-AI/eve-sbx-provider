import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { SandboxSessionGoneError, type SandboxConnection } from "eve/sandbox/provider";
import { launchSbx } from "./sbx-cli.js";
import { HELPER } from "./sbx-helper.js";

type Reply = {
  id?: string; ready?: number; pid?: number; started?: number; nodeVersion?: string;
  s?: number; d?: string; exit?: number; ok?: number; missing?: number;
  error?: { name?: string; code?: string; message: string };
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // Streams may fail before the consumer reaches wait(). Keep that failure
  // observable through the original promise, without an unhandled rejection.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
function remoteError(reply: Reply) {
  const code = typeof reply.error?.code === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(reply.error.code) ? reply.error.code : undefined;
  // Guest error messages can echo paths, command/env/stdin/file values. Keep
  // untrusted diagnostic text out of default exceptions and traces.
  return Object.assign(new Error(`Sandbox operation failed${code ? ` (${code})` : ""}`), { code });
}
type Pending = { receive(reply: Reply): void; fail(error: Error): void };
const channels = new Map<string, Promise<SbxChannel>>();
const live = new Set<SbxChannel>();
let totalOpens = 0;
function trace(enabled: boolean, event: string, name: string, extra: object = {}) {
  if (enabled) console.error(JSON.stringify({ at: new Date().toISOString(), event, name, hostPid: process.pid, ...extra }));
}
let exitCleanupInstalled = false;
function installExitCleanup() {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once("exit", () => {
    // Idle pipes are unreferenced. Closing stdin at host exit makes the helper
    // kill its jobs; no async process-exit handler is required.
    for (const channel of live) channel.endInput();
  });
}

export class SbxChannel {
  readonly name: string;
  readonly child: ReturnType<typeof launchSbx>;
  readonly tracing: boolean;
  helperPid: number | undefined;
  nodeVersion: string | undefined;
  healthy = true;
  private initialized = false;
  private pending = new Map<string, Pending>();
  private ready = deferred<void>();
  private closed = deferred<void>();
  private writes: Promise<void> = Promise.resolve();
  private stderr = "";
  private bootstrapOutput = "";
  private failure: Error | undefined;
  private onDead: () => void;
  private timer: ReturnType<typeof setTimeout>;

  constructor(name: string, onDead: () => void, executable = "sbx", tracing = false) {
    installExitCleanup();
    this.name = name;
    this.onDead = onDead;
    this.tracing = tracing;
    // On slim images exec starts as root; HELPER clears groups and drops to
    // the prepared uid/gid 1000 account before accepting any requests.
    this.child = launchSbx(["exec", "-i", name, "node", "-e", HELPER], undefined, executable);
    totalOpens++;
    live.add(this);
    trace(this.tracing, "open", name, { cliPid: this.child.pid });
    this.timer = setTimeout(() => this.fail(new Error("Sandbox command channel readiness timed out")), 30000);
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-16384); });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("close", (code, signal) => {
      const missing = this.stderr.split(/\r?\n/).some((line) => line.trim() === `error: sandbox '${name}' not found`);
      const diagnostics = (this.bootstrapOutput + this.stderr).trim();
      const runtimeMissing = /(?:node.*(?:not found|no such file)|(?:not found|no such file).*node|executable file not found)/i.test(diagnostics);
      const error = missing
        ? new SandboxSessionGoneError("Session sandbox is gone.")
        : new Error(runtimeMissing
          ? "Sandbox command channel requires Node.js inside the prepared image"
          : `Sandbox command channel ended (${code ?? signal})`);
      this.fail(error);
      this.closed.resolve();
    });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        let reply: Reply;
        try { reply = JSON.parse(line) as Reply; }
        catch (error) {
          // sbx can print a launch failure on stdout before the helper exists.
          // Preserve that diagnostic until CLI close instead of a JSON error.
          if (this.initialized) throw error;
          this.bootstrapOutput = (this.bootstrapOutput + line + "\n").slice(-16384);
          return;
        }
        if (!reply || typeof reply !== "object") throw new Error("Invalid channel response");
        if (reply.ready === 1 && !this.initialized) {
          if (this.bootstrapOutput) throw new Error("Non-protocol output before helper readiness");
          this.initialized = true;
          this.helperPid = reply.pid;
          this.nodeVersion = reply.nodeVersion;
          clearTimeout(this.timer);
          trace(this.tracing, "ready", name, { helperPid: reply.pid, nodeVersion: reply.nodeVersion });
          this.ready.resolve();
          this.updateReferences();
        } else if (typeof reply.id === "string") this.pending.get(reply.id)?.receive(reply);
        else throw new Error("Unexpected channel response");
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  waitReady() { return this.ready.promise; }
  endInput() { this.child.stdin.end(); }
  private updateReferences() {
    const method = this.healthy && (!this.initialized || this.pending.size > 0) ? "ref" : "unref";
    this.child[method]();
    // Native child-process pipes are sockets on Node; these optional methods
    // keep an idle channel from preventing a short-lived test process exiting.
    for (const pipe of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      (pipe as unknown as { ref?(): void; unref?(): void })[method]?.();
    }
  }
  private finish(id: string) {
    this.pending.delete(id);
    this.updateReferences();
  }
  private fail(error: Error) {
    if (this.failure) return;
    // CLI output and OS/protocol errors may contain arbitrary guest-controlled
    // data. Never attach the original error/cause to default diagnostics.
    error = error instanceof SandboxSessionGoneError ? error : new Error("Sandbox command channel failed");
    this.failure = error;
    this.healthy = false;
    clearTimeout(this.timer);
    this.ready.reject(error);
    for (const request of this.pending.values()) request.fail(error);
    this.pending.clear();
    this.onDead();
    live.delete(this);
    trace(this.tracing, "closed", this.name, { reason: error.message });
    this.child.stdin.destroy();
    this.child.kill();
    this.updateReferences();
  }
  send(request: object): Promise<void> {
    if (!this.healthy) return Promise.reject(this.failure);
    const line = JSON.stringify(request) + "\n";
    const write = this.writes.then(() => new Promise<void>((resolve, reject) => {
      if (!this.healthy) { reject(this.failure); return; }
      this.child.stdin.write(line, (error) => error ? reject(error) : resolve());
    }));
    this.writes = write.catch((error: Error) => { this.fail(error); });
    return write;
  }
  async request(payload: object, signal?: AbortSignal): Promise<Reply> {
    signal?.throwIfAborted();
    const id = randomUUID();
    const result = deferred<Reply>();
    const cleanup = () => { signal?.removeEventListener("abort", abort); this.finish(id); };
    const abort = () => {
      cleanup();
      result.reject(signal?.reason);
      void this.send({ id, op: "kill" }).catch(() => {});
    };
    this.pending.set(id, {
      receive: (reply) => {
        cleanup();
        if (reply.error) result.reject(remoteError(reply));
        else result.resolve(reply);
      },
      fail: (error) => { cleanup(); result.reject(error); },
    });
    this.updateReferences();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else void this.send({ ...payload, id }).catch((error: Error) => { cleanup(); result.reject(error); });
    return result.promise;
  }
  async spawn(options: Parameters<SandboxConnection["spawn"]>[0]) {
    const { signal } = options;
    signal?.throwIfAborted();
    const id = randomUUID();
    const started = deferred<void>();
    const completion = deferred<{ exitCode: number }>();
    let stdout!: ReadableStreamDefaultController<Uint8Array>;
    let stderr!: ReadableStreamDefaultController<Uint8Array>;
    let done = false;
    let outputCanceled = false;
    let errorsCanceled = false;
    let abortReason: unknown;
    let killRequest: Promise<void> | undefined;
    const output = new ReadableStream<Uint8Array>({
      start(controller) { stdout = controller; }, cancel() { outputCanceled = true; },
    });
    const errors = new ReadableStream<Uint8Array>({
      start(controller) { stderr = controller; }, cancel() { errorsCanceled = true; },
    });
    const cleanup = () => { signal?.removeEventListener("abort", abort); this.finish(id); };
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      cleanup();
      if (!outputCanceled) stdout.error(error);
      if (!errorsCanceled) stderr.error(error);
      started.reject(error); completion.reject(error);
    };
    const kill = () => {
      if (done) return Promise.resolve();
      killRequest ??= this.send({ id, op: "kill" }).catch((error: Error) => { fail(error); throw error; });
      return killRequest;
    };
    const abort = () => {
      abortReason = signal?.reason ?? new DOMException("Aborted", "AbortError");
      void kill().catch(() => {});
    };
    this.pending.set(id, {
      receive: (reply) => {
        if (reply.error) { fail(remoteError(reply)); return; }
        if (reply.started) { started.resolve(); return; }
        if (reply.s === 1 || reply.s === 2) {
          if (reply.s === 1 && !outputCanceled) stdout.enqueue(Buffer.from(reply.d!, "base64"));
          if (reply.s === 2 && !errorsCanceled) stderr.enqueue(Buffer.from(reply.d!, "base64"));
        } else if (typeof reply.exit === "number") {
          done = true;
          cleanup();
          if (!outputCanceled) stdout.close();
          if (!errorsCanceled) stderr.close();
          completion.resolve({ exitCode: reply.exit });
        }
      }, fail,
    });
    this.updateReferences();
    signal?.addEventListener("abort", abort, { once: true });
    // Queue spawn before kill even if the signal races with this submission.
    void this.send({ id, op: "spawn", command: options.command, cwd: options.workingDirectory,
      env: options.env, stdin: !!options.stdin }).catch(fail);
    if (signal?.aborted) abort();
    await started.promise;
    return {
      stdout: output, stderr: errors,
      ...(options.stdin ? { stdin: new WritableStream<Uint8Array>({
        write: (chunk) => {
          if (done) throw new Error("Command stdin is closed");
          return this.send({ id, op: "in", d: Buffer.from(chunk).toString("base64") });
        },
        close: () => done ? undefined : this.send({ id, op: "inEnd" }),
        abort: () => kill(),
      }) } : {}),
      async wait() {
        const result = await completion.promise;
        await killRequest;
        if (abortReason !== undefined) throw abortReason;
        return result;
      }, kill,
    };
  }
  async dispose() {
    if (this.healthy) this.endInput();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.closed.promise,
        new Promise<void>((resolve) => { timer = setTimeout(() => { this.fail(new Error("Channel shutdown timeout")); resolve(); }, 5000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
}

export function getChannel(name: string, executable = "sbx", tracing = false): Promise<SbxChannel> {
  const existing = channels.get(name);
  if (existing) return existing.then((channel) => channel.healthy ? channel : getChannel(name, executable, tracing));
  // The microtask lets us register the shared opening promise before a launch
  // error can evict it. No inspect/ls or runtime installation on this path.
  const opening = Promise.resolve().then(async () => {
    const channel = new SbxChannel(name, () => {
      if (channels.get(name) === opening) channels.delete(name);
    }, executable, tracing);
    await channel.waitReady();
    return channel;
  });
  channels.set(name, opening);
  void opening.catch(() => { if (channels.get(name) === opening) channels.delete(name); });
  return opening;
}
export async function discardChannel(name: string) {
  const opening = channels.get(name);
  if (!opening) return;
  channels.delete(name);
  const channel = await opening.catch(() => undefined);
  await channel?.dispose();
}
export async function channelDiagnostics() {
  const entries = await Promise.all([...channels.values()].map((entry) => entry.catch(() => undefined)));
  return { totalOpens, channelCount: channels.size, channels: entries.filter((c) => c?.healthy).map((c) => ({ name: c!.name, helperPid: c!.helperPid, nodeVersion: c!.nodeVersion })) };
}
