import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxSession } from "eve/sandbox";
import {
  defineSandboxProvider,
  type SandboxProvider,
  type WithPrepareOption,
  SANDBOX_AGENT_ENV,
  SandboxSessionGoneError,
  SandboxTemplateNotProvisionedError,
  type SandboxConnection,
  type SandboxProviderImplementation,
} from "eve/sandbox/provider";
import { runSbx, runSbxBytes, type SbxBytesResult } from "./sbx-cli.js";
import { discardChannel, getChannel } from "./sbx-channel.js";
import { claim, claimFile, nameFor, readClaim, validVmName } from "./sbx-claims.js";
import { createVm, disposePools, markVmClaimed, poolFor, removeVm } from "./sbx-pool.js";
import { openNetworkPolicy, validateOptions, type SbxOpenOptions, type SbxNetworkPolicy, type SbxRuntimeOptions, type SbxSandboxOptions } from "./options.js";
import { assertNoHostMounts, readVmNetworkPolicy } from "./sbx-policy.js";

export type { SbxSandboxOptions } from "./options.js";
export type SbxArtifact = { template: string };
type State = { name: string; networkPolicy?: SbxNetworkPolicy };

// Bump when setup or the command-channel protocol changes.
const PROTOCOL_VERSION = 2;
const BASE_SETUP = String.raw`
set -eu
if command -v apk >/dev/null 2>&1; then
  apk --wait 60 add --no-cache bash ripgrep ca-certificates coreutils findutils grep procps >/dev/null
elif command -v apt-get >/dev/null 2>&1; then
  while grep -qsx apt-get /proc/[0-9]*/comm; do sleep 0.5; done
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    if [ -f "$f" ]; then
      sed -i 's|http://deb.debian.org|https://deb.debian.org|g; s|http://security.debian.org|https://security.debian.org|g' "$f"
    fi
  done
  if [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then
    mkdir -p /etc/ssl/certs
    node -e 'const fs = require("node:fs"); const roots = [...require("node:tls").rootCertificates]; const extra = process.env.NODE_EXTRA_CA_CERTS; if (extra && fs.existsSync(extra)) roots.push(fs.readFileSync(extra, "utf8")); fs.writeFileSync("/etc/ssl/certs/ca-certificates.crt", roots.join("\n") + "\n");'
  fi
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends bash ripgrep ca-certificates procps >/dev/null
  rm -rf /var/lib/apt/lists/*
else
  echo 'Unsupported package manager: expected Alpine or Debian' >&2; exit 70
fi
for t in bash node rg; do command -v "$t" >/dev/null 2>&1 || { echo "the base image needs $t" >&2; exit 70; }; done
old=$(getent passwd 1000 | cut -d: -f1 || true)
if [ -n "$old" ] && [ "$old" != agent ]; then
  if command -v userdel >/dev/null 2>&1; then userdel -r "$old" 2>/dev/null || userdel "$old"; else deluser --remove-home "$old" 2>/dev/null || deluser "$old"; fi
  g=$(getent group 1000 | cut -d: -f1 || true)
  if [ -n "$g" ]; then groupdel "$g" 2>/dev/null || delgroup "$g" 2>/dev/null || true; fi
  old=
fi
if [ -z "$old" ]; then
  if command -v useradd >/dev/null 2>&1; then useradd -m -u 1000 -s /bin/bash agent; else adduser -D -u 1000 -s /bin/bash agent; fi
fi
[ "$(id -u agent)" = 1000 ] && [ "$(id -g agent)" = 1000 ]
mkdir -p /workspace && chown 1000:1000 /workspace
`;

function check(result: SbxBytesResult | Awaited<ReturnType<typeof runSbx>>, action: string) {
  if (result.exitCode !== 0) throw new Error(`${action} failed (${result.exitCode})`);
}
function missingSandbox(stderr: string, name: string) {
  return stderr.split(/\r?\n/).some(line => line.trim() === `error: sandbox '${name}' not found`);
}
function validateState(state: Readonly<State>, namespace: string, sessionId: string) {
  if (!state || typeof state.name !== "string" ||
    (!validVmName(state.name, namespace) && state.name !== nameFor(namespace, sessionId))) {
    throw new Error("Invalid docker-sandboxes session state");
  }
  return state.name;
}

const sessionChannels = new Map<string, Set<string>>();
/** Call after draining requests. Releases this process's resources, not session VMs or templates. */
export async function shutdownSbx(namespace: string): Promise<void> {
  await disposePools(namespace);
  const names = sessionChannels.get(namespace);
  if (names) {
    await Promise.all([...names].map(name => discardChannel(name)));
    sessionChannels.delete(namespace);
  }
}
async function scopedClaim(file: string, namespace: string, sessionId: string) {
  const name = await readClaim(file);
  if (name) validateState({ name }, namespace, sessionId);
  return name;
}
function connect(name: string, options: SbxRuntimeOptions): SandboxConnection {
  let names = sessionChannels.get(options.namespace);
  if (!names) sessionChannels.set(options.namespace, names = new Set());
  names.add(name);
  async function request(action: string, payload: object, signal?: AbortSignal) {
    signal?.throwIfAborted();
    try { return await (await getChannel(name, options.sbxPath, options.trace)).request(payload, signal); }
    catch (error) {
      if (signal?.aborted) throw signal.reason;
      const cause = error as Error & { code?: string };
      throw Object.assign(new Error(`${action} failed: ${cause.message}`, { cause }), { code: cause.code });
    }
  }
  return {
    async spawn(spawnOptions) {
      spawnOptions.signal?.throwIfAborted();
      const env = { ...SANDBOX_AGENT_ENV, ...spawnOptions.env };
      for (const key of Object.keys(env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new Error("Invalid environment key");
      }
      return (await getChannel(name, options.sbxPath, options.trace)).spawn({ ...spawnOptions, env });
    },
    async readFile({ path, signal }) {
      const reply = await request("Read file", { op: "read", path }, signal);
      return reply.missing ? null : Buffer.from(reply.d!, "base64");
    },
    async writeFiles({ files, signal }) {
      await request("Write files", {
        op: "write", files: files.map(({ path, content }) => ({ path, d: Buffer.from(content).toString("base64") })),
      }, signal);
    },
    async removePath({ path, force, recursive, signal }) {
      await request("Remove path", { op: "rm", path, force, recursive }, signal);
    },
    async stop() {
      await discardChannel(name);
      const result = await runSbx(["stop", name], undefined, options.sbxPath);
      if (!missingSandbox(result.stderr, name)) check(result, "Stop sandbox");
    },
    // Keep the long-lived helper between Eve steps; the provider owns its lifecycle.
  };
}

// Internal lifecycle factory exported for package-owned black-box contract tests.
// It is intentionally absent from the package root export map.
export function createSbxEnvironment(options: SbxRuntimeOptions): SandboxProviderImplementation<SbxOpenOptions | undefined, SbxArtifact, State, {}> {
  return {
    async prepare(ctx) {
      const key = ctx.templateKey({ provider: "docker-sandboxes", baseImage: options.baseImage,
        setup: BASE_SETUP, protocolVersion: PROTOCOL_VERSION });
      const template = `eve-dsb-tpl:${key}`;
      const build = `eve-dsb-build-${randomUUID()}`;
      let kitDirectory: string | undefined;
      let failure: unknown;
      try {
        ctx.log(`Preparing ${template} from ${options.baseImage}`);
        if (options.baseImage.includes("trixie-slim")) {
          kitDirectory = await mkdtemp(join(tmpdir(), "eve-sbx-build-"));
          await writeFile(join(kitDirectory, "spec.yaml"),
            `schemaVersion: "2"\nkind: sandbox\nname: shell\nsandbox:\n  image: ${JSON.stringify(options.baseImage)}\n`);
          const kit = join(kitDirectory, "build.zip");
          check(await runSbx(["kit", "pack", kitDirectory, "--output", kit], undefined, options.sbxPath), "Pack Debian build kit");
          check(await runSbx(["create", "--name", build, "--pull", "missing", "--skills", "off", "--static-mcp", "none", kit], undefined, options.sbxPath), "Create Debian build sandbox");
        } else {
          check(await runSbx(["create", "--name", build, "-t", options.baseImage, "--pull", "missing", "--skills", "off", "--static-mcp", "none", "shell"], undefined, options.sbxPath), "Create build sandbox");
        }
        await assertNoHostMounts(build, options.sbxPath);
        check(await runSbxBytes(["exec", "-i", "-u", "root", build, "sh", "-s"], Buffer.from(BASE_SETUP), undefined, options.sbxPath), "Set up base image");
        const connection = connect(build, options);
        await ctx.populate(connection);
        await connection.stop();
        check(await runSbx(["template", "save", build, template], undefined, options.sbxPath), "Save sandbox template");
        return { template };
      } catch (error) { failure = error; throw error; }
      finally {
        try {
          await discardChannel(build);
          sessionChannels.get(options.namespace)?.delete(build);
          const removed = await runSbx(["rm", "-f", build], undefined, options.sbxPath);
          if (!missingSandbox(removed.stderr, build)) check(removed, "Remove build sandbox");
        } catch (cleanupError) {
          if (failure) throw new AggregateError([failure, cleanupError], "Template preparation and cleanup failed");
          throw cleanupError;
        } finally { if (kitDirectory) await rm(kitDirectory, { recursive: true, force: true }); }
      }
    },
    async start(ctx, openOptions, artifact) {
      // Reject unsupported policies before looking at claims or assigning a VM.
      const networkPolicy = openNetworkPolicy(openOptions, options.networkPolicy);
      const runtime = { ...options, networkPolicy };
      if (!artifact || typeof artifact.template !== "string" || !artifact.template.startsWith("eve-dsb-tpl:")) {
        throw new SandboxTemplateNotProvisionedError({ providerName: "docker-sandboxes",
          reason: "The deployment has no prepared docker-sandboxes template; rebuild the application.", templateKey: "unprepared" });
      }
      const file = claimFile(ctx.storagePath, options.namespace, ctx.session.id);
      const existing = await scopedClaim(file, options.namespace, ctx.session.id);
      const pool = poolFor(artifact.template, runtime);
      if (existing) {
        await assertNoHostMounts(existing, options.sbxPath);
        const existingPolicy = await readVmNetworkPolicy(existing, options.sbxPath);
        await getChannel(existing, options.sbxPath, options.trace);
        pool.fill();
        if (options.trace) console.error(JSON.stringify({ event: "session.claim", namespace: options.namespace, name: existing }));
        return { connection: connect(existing, options), state: { name: existing, networkPolicy: existingPolicy } };
      }
      let candidate = pool.take();
      if (candidate && !candidate.channel.healthy) { await removeVm(candidate.name, options.sbxPath); candidate = undefined; }
      const warm = !!candidate;
      if (options.trace) console.error(JSON.stringify({ event: warm ? "session.pool" : "session.cold", namespace: options.namespace, name: candidate?.name }));
      try {
        candidate ??= await createVm(artifact.template, runtime);
        let name: string;
        try { name = await claim(file, candidate.name); validateState({ name }, options.namespace, ctx.session.id); }
        catch (error) { await removeVm(candidate.name, options.sbxPath); throw error; }
        if (name !== candidate.name) {
          await removeVm(candidate.name, options.sbxPath);
          if (options.trace) console.error(JSON.stringify({ event: "session.lost-claim", namespace: options.namespace, spare: candidate.name, name }));
          await getChannel(name, options.sbxPath, options.trace);
        } else markVmClaimed(name);
        if (options.trace) console.error(JSON.stringify({ event: "session.ready", namespace: options.namespace, name, warm }));
        const actualPolicy = name === candidate.name ? networkPolicy : await readVmNetworkPolicy(name, options.sbxPath);
        return { connection: connect(name, options), state: { name, networkPolicy: actualPolicy } };
      } finally { pool.fill(); }
    },
    async resume(ctx, _artifact, state) {
      const name = validateState(state, options.namespace, ctx.session.id);
      let channel;
      try {
        await assertNoHostMounts(name, options.sbxPath);
        const actualPolicy = await readVmNetworkPolicy(name, options.sbxPath);
        if (state.networkPolicy !== undefined && actualPolicy !== state.networkPolicy) {
          throw new Error("Session sandbox network policy changed outside the provider");
        }
        channel = await getChannel(name, options.sbxPath, options.trace);
      }
      catch (error) {
        if (error instanceof SandboxSessionGoneError) {
          const file = claimFile(ctx.storagePath, options.namespace, ctx.session.id);
          if (await readClaim(file) === name) await rm(file, { force: true });
        }
        throw error;
      }
      if (options.trace) console.error(JSON.stringify({ event: "session.resume", namespace: options.namespace, name, helperPid: channel.helperPid }));
      return connect(name, options);
    },
    async onSessionEnd(ctx, state, { signal }) {
      const file = claimFile(ctx.storagePath, options.namespace, ctx.session.id);
      const owner = await scopedClaim(file, options.namespace, ctx.session.id);
      const name = state === null ? owner : validateState(state, options.namespace, ctx.session.id);
      // A random pool VM is owned by this session only through its durable claim.
      // Missing claims (never opened/already ended) are a no-op, not a prefix sweep.
      if (!name) return;
      if (name !== owner && name !== nameFor(options.namespace, ctx.session.id)) {
        if (!owner) return;
        throw new Error("Session state does not match its sandbox claim");
      }
      await removeVm(name, options.sbxPath, signal);
      sessionChannels.get(options.namespace)?.delete(name);
      if (owner === name) await rm(file, { force: true });
    },
  };
}

export const SbxSandbox: SandboxProvider<WithPrepareOption<SbxSandboxOptions, SandboxSession>, SbxOpenOptions | undefined, SandboxSession> = defineSandboxProvider({
  name: "docker-sandboxes",
  environment(rawOptions: SbxSandboxOptions) {
    // Validate synchronously, before prepare/start can issue any sbx command.
    const options = validateOptions(rawOptions);
    return createSbxEnvironment(options);
  },
});
