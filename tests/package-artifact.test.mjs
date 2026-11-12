import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = (command, args, cwd, env = process.env) => execFileSync(command, args, {
  cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  ...(process.platform === "win32" && command === "npm" ? { shell: true } : {}),
});
const runNpm = (args, cwd, env = process.env) => process.env.npm_execpath
  ? run(process.execPath, [process.env.npm_execpath, ...args], cwd, env)
  : run("npm", args, cwd, env);
const parsePackJson = text => JSON.parse(text.slice(text.indexOf("[")));

test("packed artifact installs into a fresh ESM consumer, resolves types, and has no sbx install/import side effects", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "eve-sbx-package-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const consumer = join(temp, "consumer");
  const packDir = join(temp, "pack");
  const { mkdir } = await import("node:fs/promises");
  await Promise.all([mkdir(consumer, { recursive: true }), mkdir(packDir, { recursive: true })]);

  const dry = parsePackJson(runNpm(["pack", "--dry-run", "--json"], packageRoot))[0];
  const packedPaths = new Set(dry.files.map(file => file.path));
  for (const required of ["package.json", "README.md", "SECURITY.md", "LICENSE", "CHANGELOG.md", "dist/index.js", "dist/index.d.ts",
    "dist/internal/sbx-sandbox.js", "dist/internal/sbx-sandbox.d.ts", "dist/internal/sbx-helper.js"]) {
    assert.ok(packedPaths.has(required), `tarball missing ${required}`);
  }
  for (const forbidden of [".env", "research", "tests", "src"]) {
    assert.ok(![...packedPaths].some(file => file === forbidden || file.startsWith(`${forbidden}/`)),
      `tarball unexpectedly contains ${forbidden}`);
  }
  assert.ok(![...packedPaths].some(file => /docker-sandboxes-claims|\.claim$/.test(file)), "tarball must not contain local claim data");

  const packResult = parsePackJson(runNpm(["pack", "--json", "--pack-destination", packDir], packageRoot))[0];
  const tarball = join(packDir, packResult.filename);
  const tarBytes = await readFile(tarball);
  const sha256 = createHash("sha256").update(tarBytes).digest("hex");
  assert.equal(sha256.length, 64);

  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "sbx-fresh-consumer", private: true, type: "module" }, null, 2));
  const hook = join(temp, "detect-sbx.cjs");
  const marker = join(temp, "sbx-invoked.log");
  await writeFile(hook, `const fs=require('node:fs');const cp=require('node:child_process');const marker=()=>fs.appendFileSync(process.env.SBX_TEST_CLI_MARKER,'invoked\\n');if(process.argv.includes('--no-input'))marker();const spawn=cp.spawn;cp.spawn=function(command,args,...rest){if((Array.isArray(args)&&args.includes('--no-input'))||/(^|[\\\\/])sbx(?:\\.cmd|\\.exe)?$/i.test(String(command))){marker();const e=new Error('fake sbx invocation blocked');e.code='FAKE_SBX';throw e;}return spawn.call(this,command,args,...rest);};\n`);
  const preload = `--import=${pathToFileURL(hook).href}`;
  const installEnv = { ...process.env, NODE_OPTIONS: preload, SBX_TEST_CLI_MARKER: marker };
  runNpm(["install", "--no-audit", "--no-fund", tarball,
    "eve@1.0.0-rc.6", "typescript@7.0.2", "@types/node@24.10.1"], consumer, installEnv);
  await assert.rejects(() => access(marker), { code: "ENOENT" }, "npm install must not invoke sbx");

  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({ compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
    skipLibCheck: true, noEmit: true, types: ["node"],
  }, include: ["index.ts"] }, null, 2));
  await writeFile(join(consumer, "index.ts"), `import { SbxSandbox, shutdownSbx, type SbxSandboxOptions, type SbxOpenOptions, type SbxNetworkPolicy } from "@deltaxy.ai/eve-sbx-provider";\n` +
    `const policy: SbxNetworkPolicy = "deny-all";\n` +
    `const options: SbxSandboxOptions = { namespace: "fresh-consumer", baseImage: "node:22-alpine", networkPolicy: policy, poolSize: 0, sbxPath: "sbx", trace: false };\n` +
    `export const environment = SbxSandbox.environment(options);\n` +
    `const open: SbxOpenOptions = { networkPolicy: "allow-all" };\n` +
    `export const select = () => environment.open(open);\n` +
    `export const shutdown = () => shutdownSbx(options.namespace);\n` +
    `// @ts-expect-error Domain-list policies are deliberately unsupported.\n` +
    `export const invalid = () => environment.open({ networkPolicy: { allow: ["example.com"] } });\n`);
  const tsc = join(consumer, "node_modules", "typescript", "bin", "tsc");
  run(process.execPath, [tsc, "--noEmit", "-p", join(consumer, "tsconfig.json")], consumer);

  // Run the installed artifact itself. If it tries to call the configured fake
  // executable during import/configuration, that child Node process writes marker.
  process.env.NODE_OPTIONS = preload;
  process.env.SBX_TEST_CLI_MARKER = marker;
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function (command, args, ...rest) {
    if ((Array.isArray(args) && args.includes("--no-input")) || /(^|[\\\\/])sbx(?:\\.cmd|\\.exe)?$/i.test(String(command))) {
      appendFileSync(marker, "blocked fake CLI invocation\n");
      throw Object.assign(new Error("fake sbx invocation blocked"), { code: "FAKE_SBX" });
    }
    return originalSpawn.call(this, command, args, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const installedEntry = join(consumer, "node_modules", "@deltaxy.ai", "eve-sbx-provider", "dist", "index.js");
    const { SbxSandbox } = await import(`${pathToFileURL(installedEntry).href}?fresh=${Date.now()}`);
    const env = SbxSandbox.environment({ namespace: "fresh-consumer", sbxPath: process.execPath, poolSize: 0 });
    assert.equal(typeof env, "object");
    await new Promise(resolve => setTimeout(resolve, 250));
    await assert.rejects(() => access(marker), { code: "ENOENT" }, "import/configuration must not invoke the CLI");
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
  assert.equal(packResult.name, "@deltaxy.ai/eve-sbx-provider");
  console.log(JSON.stringify({ consumer, package: packResult.name, version: packResult.version,
    sha256, packedFiles: [...packedPaths].sort(), install: "PASS", typecheck: "PASS", noSbxSideEffects: "PASS" }));
});
