import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fork, execFile } from 'node:child_process';
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'eve/client';
import { runSbx } from '../../dist/internal/sbx-cli.js';

if (process.env.SBX10_APPS_LIVE !== '1') {
  console.error('Opt in with SBX10_APPS_LIVE=1; creates unique local Eve app/VM resources.'); process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '../..');
const out = resolve(pkg, '../../research/sbx-provider/raw/step-10-apps', new Date().toISOString().replace(/[:.]/g, '-'));
const prefix = `sbx10-apps-${randomBytes(6).toString('hex')}`;
const password = randomBytes(32).toString('hex');
const redact = value => value.replaceAll(password, '[REDACTED]').replaceAll(Buffer.from(`sbx10:${password}`).toString('base64'), '[REDACTED]');
const save = (name, value) => writeFile(join(out, name), redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 90000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const value = await fn(); if (value) return value; } catch (e) { last = e; } await sleep(200); }
  throw new Error(`Timed out: ${label}`, { cause: last });
}
const cli = async args => { const r = await runSbx(args); assert.equal(r.exitCode, 0, r.stderr || r.stdout); return r.stdout; };
const inventory = async () => (await cli(['ls', '-q'])).trim().split(/\r?\n/).filter(Boolean).sort();
async function freePort() { const s = createServer(); await new Promise((r, j) => { s.once('error', j); s.listen(0, '127.0.0.1', r); }); const port = s.address().port; await new Promise(r => s.close(r)); return port; }
await mkdir(out, { recursive: true });
const projects = join(out, 'projects'); await mkdir(projects);
await cp(here, projects, { recursive: true, filter: source => !['node_modules', '.eve', '.output'].includes(source.split(/[\\/]/).at(-1)) });
await mkdir(join(projects, 'node_modules/@deltaxy.ai'), { recursive: true });
await symlink(pkg, join(projects, 'node_modules/@deltaxy.ai/eve-sbx-provider'), 'junction');
await symlink(join(pkg, 'node_modules/eve'), join(projects, 'node_modules/eve'), 'junction');
const apps = await Promise.all(['a', 'b'].map(async id => {
  const cwd = join(projects, `app-${id}`), port = await freePort();
  return { id, cwd, port, namespace: `${prefix}-${id}`, marker: `${prefix}-${id}-marker`, runs: [] };
}));
const [a, b] = apps; const templates = new Set(); const children = [];
const before = await inventory(); const templateBefore = await cli(['template', 'ls']);
const templateRows = listing => listing.trim().split(/\r?\n/).slice(1).map(line => line.trim().split(/\s+/).slice(0, 3).join(' '));
await save('inventory-before.json', before); await save('templates-before.txt', templateBefore);
await save('host.json', { date: new Date().toISOString(), prefix, node: process.version, platform: process.platform, sbx: await cli(['version']) });
function envFor(app) { return { ...process.env, EVE_TELEMETRY_DISABLED: '1', SBX10_PASSWORD: password,
  SBX10_APP: app.id, SBX10_NAMESPACE: app.namespace, SBX10_MARKER: app.marker,
  SBX10_BOOTSTRAP: app.bootstrap ? '1' : '0', SERVER_SHUTDOWN_TIMEOUT: '20',
  HOST: '127.0.0.1', PORT: String(app.port), NITRO_HOST: '127.0.0.1', NITRO_PORT: String(app.port),
  WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${app.port}`,
  SBX10_SERVER_ENTRY: pathToFileURL(join(app.cwd, '.output/server/index.mjs')).href };
}
function events(app) { return app.runs.flatMap(run => run.output.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } })); }
async function start(app) {
  const child = fork(join(here, 'server.mjs'), [], { cwd: app.cwd, execArgv: [], env: envFor(app), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const run = { pid: child.pid, output: '', child }; app.runs.push(run); children.push(run);
  child.stdout.on('data', d => run.output += d); child.stderr.on('data', d => run.output += d);
  run.exited = new Promise(r => child.once('exit', (code, signal) => { run.exit = { code, signal }; r(run.exit); }));
  app.client = new Client({ baseUrl: `http://127.0.0.1:${app.port}`, auth: { basic: { username: 'sbx10', password } } });
  await until(async () => { if (run.exit) throw new Error(run.output); return await app.client.health({ signal: AbortSignal.timeout(1000) }).catch(() => false); }, `${app.id} healthy`);
  app.run = run; return run;
}
async function stop(app) {
  if (!app.run || app.run.exit) return;
  const response = await fetch(`http://127.0.0.1:${app.port}/sbx10/drain`, { method: 'POST', headers: { authorization: `Bearer ${password}` }, signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200, await response.clone().text());
  app.run.drain = await response.json(); app.run.child.send('shutdown');
  const exit = await until(() => app.run.exit, 'graceful process exit', 30000);
  assert.equal(exit.code, 0, app.run.output);
  assert.ok(!app.run.output.includes('Graceful shutdown timed out'), app.run.output);
}
async function claimList(app) {
  // Storage belongs solely to this test app. Bound discovery to its runtime state.
  const result = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'docker-sandboxes-claims') {
          for (const file of await readdir(path)) result.push({ file: join(path, file), name: (await readFile(join(path, file), 'utf8')).trim() });
        } else if (!['node_modules', '.output', 'agent'].includes(entry.name)) await visit(path);
      }
    }
  }
  await visit(app.cwd); return result;
}
async function scopedNames(app) {
  const existing = new Set(await inventory());
  return [...new Set(events(app).filter(e => e.event === 'create.begin').map(e => e.name))].filter(n => existing.has(n));
}
async function poolReady(app) {
  return until(async () => {
    const claims = await claimList(app), claimed = new Set(claims.map(c => c.name));
    const names = await scopedNames(app); const ready = names.filter(n => !claimed.has(n));
    const completed = new Set(events(app).filter(e => e.event === 'create.ready').map(e => e.name));
    return ready.length === 1 && ready.every(n => completed.has(n)) && { claims, ready };
  }, `${app.id} ready pool`);
}
async function probe(app, sessionId) {
  const offset = events(app).length;
  const delivery = await app.client.sessions.attach(sessionId).send('Run the ownership probe', { signal: AbortSignal.timeout(30000) });
  const result = await delivery.result({ signal: AbortSignal.timeout(120000) });
  assert.equal(result.status, 'cancelled', JSON.stringify(result));
  const proof = await until(() => events(app).slice(offset).find(e => e.event === 'fixture.probe' && e.sessionId === sessionId), 'probe log');
  assert.equal(proof.marker, app.marker); return { result, proof };
}
async function inspect(names) { return Promise.all(names.map(async name => { const { uptime, ...identity } = JSON.parse(await cli(['inspect', name, '--json'])); return identity; })); }
async function readMarker(name, path) { return cli(['exec', name, 'cat', path]); }
async function snapshot(app) {
  const claims = await claimList(app), names = await scopedNames(app), claimed = new Set(claims.map(c => c.name));
  return { namespace: app.namespace, pid: app.run.pid, sessionId: app.sessionId, claims, names, ready: names.filter(n => !claimed.has(n)),
    identities: await inspect(names), markers: await Promise.all(names.map(async name => ({ name, marker: await readMarker(name, claimed.has(name) ? '/workspace/ownership-marker.txt' : '/workspace/pool-marker.txt') }))) };
}
let failure; const checks = {};
try {
  // Build once, deploy the exact same compiled Eve application twice. Runtime
  // namespaces, HTTP listeners and durable stores are independent.
  await mkdir(join(a.cwd, 'agent/sandbox/workspace'), { recursive: true });
  await writeFile(join(a.cwd, 'agent/sandbox/workspace/run-seed.txt'), prefix);
  const build = await promisify(execFile)(process.execPath, [join(pkg, 'node_modules/eve/bin/eve.js'), 'build'], { cwd: a.cwd, env: envFor(a), timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  await save('build.log', build.stdout + build.stderr);
  for (const match of (build.stdout + build.stderr).matchAll(/eve-dsb-tpl:([a-zA-Z0-9_-]+)/g)) templates.add(match[0]);
  await cp(join(a.cwd, '.output'), join(b.cwd, '.output'), { recursive: true });
  // Eve's public create API generates IDs. To deliberately test identical native
  // Eve session IDs, clone ONLY this run's quiescent, never-opened session store
  // before either app creates a VM. No provider IDs or framework code are patched.
  a.bootstrap = true;
  await start(a);
  const { session } = await a.client.sessions.create(); a.sessionId = session.id; b.sessionId = session.id;
  await until(async () => { const snapshot = await session.snapshot({ signal: AbortSignal.timeout(3000) }); return snapshot && snapshot; }, 'idle session');
  await until(() => a.run.output.includes('sandbox opening intentionally deferred'), 'bootstrap selector deferred');
  await sleep(1500);
  assert.deepEqual(await claimList(a), [], 'Bootstrap session must not have opened a VM');
  await stop(a); a.bootstrap = false;
  await cp(join(a.cwd, '.eve'), join(b.cwd, '.eve'), { recursive: true });
  await save('session-bootstrap.json', { method: 'Quiescent clone of this test-only never-opened Eve session store', sessionId: session.id,
    source: join(a.cwd, '.eve'), destination: join(b.cwd, '.eve'), claimsBeforeClone: await claimList(a) });
  await Promise.all(apps.map(start));
  const initial = await Promise.all(apps.map(async app => {
    const proof = await probe(app, app.sessionId); const pool = await poolReady(app);
    for (const name of pool.ready) await cli(['exec', name, 'sh', '-c', `printf %s '${app.marker}-ready' > /workspace/pool-marker.txt`]);
    return { app: app.id, cwd: app.cwd, port: app.port, namespace: app.namespace, pid: app.run.pid, ...proof, ...pool };
  }));
  assert.equal(initial[0].proof.sessionId, initial[1].proof.sessionId);
  assert.notEqual(initial[0].claims[0].name, initial[1].claims[0].name);
  await save('app-mappings.json', initial); checks.twoIndependentAppsSameSessionId = 'PASS';
  const bBefore = await snapshot(b); await save('ownership-before.json', { a: await snapshot(a), b: bBefore, inventory: await inventory() });
  const aNames = await scopedNames(a);
  await a.client.sessions.attach(a.sessionId).end({ reason: 'SBX-10 real app ownership test', signal: AbortSignal.timeout(30000) });
  await until(async () => (await claimList(a)).length === 0, 'Eve session-end cleanup');
  await stop(a);
  for (const name of aNames) assert.ok(!(await inventory()).includes(name), `A resource remains: ${name}`);
  assert.deepEqual(await snapshot(b), bBefore); await probe(b, b.sessionId);
  await save('ownership-after.json', { b: await snapshot(b), inventory: await inventory(), aExit: a.run.exit, aDrain: a.run.drain }); checks.independentGracefulShutdown = 'PASS';
  await start(a);
  const next = await a.client.sessions.create(); a.sessionId = next.session.id;
  await probe(a, a.sessionId); const pool = await poolReady(a);
  const activeName = pool.claims[0].name, oldReady = pool.ready;
  for (const name of oldReady) await cli(['exec', name, 'sh', '-c', `printf %s '${a.marker}-ready' > /workspace/pool-marker.txt`]);
  const killed = a.run; await save('restart-before-kill.json', { a: await snapshot(a), b: await snapshot(b), inventory: await inventory() });
  killed.child.kill('SIGKILL'); await killed.exited;
  await start(a); const resumed = await probe(a, a.sessionId);
  const claims = await claimList(a); assert.equal(claims[0].name, activeName);
  for (const name of oldReady) assert.ok((await inventory()).includes(name), 'No startup crash-orphan sweep');
  assert.deepEqual(await snapshot(b), bBefore);
  await until(() => events(a).filter(e => e.event === 'create.ready').length >= 5, 'restart ready pool');
  await save('restart-after.json', { killedPid: killed.pid, restartedPid: a.run.pid, activeName, oldReady, resumed, claims, inventory: await inventory() });
  checks.realAppHardKillReconnect = 'PASS';
  await stop(a);
  // Explicit manual operator cleanup: recorded ready provenance + all app claims,
  // never a dead-PID or namespace-prefix deletion rule.
  const allClaims = (await Promise.all(apps.map(claimList))).flat(); const manual = [];
  for (const name of oldReady) {
    assert.ok(!allClaims.some(c => c.name === name)); assert.notEqual(name, activeName); assert.ok(!bBefore.names.includes(name));
    const inspected = JSON.parse(await cli(['inspect', name, '--json']));
    const commands = [`sbx --no-input inspect ${name} --json`, `sbx --no-input rm -f ${name}`];
    await cli(['rm', '-f', name]); manual.push({ name, inspected, commands, allClaims });
  }
  assert.equal(await readMarker(activeName, '/workspace/ownership-marker.txt'), a.marker);
  assert.deepEqual(await snapshot(b), bBefore); await probe(b, b.sessionId);
  await save('manual-cleanup.json', { killedPid: killed.pid, manual, activeName, activeMarker: a.marker, b: await snapshot(b), inventory: await inventory() });
  checks.scopedManualCleanup = 'PASS';
  // Reconnect once more, then let finally end this session THROUGH EVE rather
  // than deleting its VM directly as supervisor cleanup.
  await start(a); await probe(a, a.sessionId);
} catch (error) { failure = error.stack; console.error(error); process.exitCode = 1; }
finally {
  for (const app of apps) {
    try {
      if (!app.run?.exit && app.sessionId) {
        await app.client.sessions.attach(app.sessionId).end({ reason: 'SBX-10 test teardown', signal: AbortSignal.timeout(15000) }).catch(() => {});
      }
      await stop(app);
    } catch (error) { failure ??= error.stack; }
  }
  for (const run of children) {
    if (!run.exit) { run.child.kill('SIGKILL'); await run.exited; }
    await save(`server-${run.pid}.log`, run.output);
  }
  // Only exact VM names observed in this run's own create events are eligible
  // for explicit supervisor teardown. Pre-existing names are never removed.
  const fallbackCleanup = [];
  for (const app of apps) for (const name of await scopedNames(app)) {
    assert.ok(!before.includes(name)); fallbackCleanup.push(name); await cli(['rm', '-f', name]);
  }
  if (fallbackCleanup.length && !failure) failure = 'Ordinary teardown required fallback VM deletion';
  await save('teardown.json', { fallbackCleanup, claims: { a: await claimList(a), b: await claimList(b) },
    processes: apps.map(app => ({ app: app.id, runs: app.runs.map(run => ({ pid: run.pid, exit: run.exit, drain: run.drain })) })) });
  for (const template of templates) {
    assert.ok(!templateBefore.includes(template.split(':')[1]), 'Refuse to delete a pre-existing template');
    const r = await runSbx(['template', 'rm', '-f', template]); if (r.exitCode !== 0) failure ??= r.stderr;
  }
  const after = await inventory(); await save('inventory-after.json', after);
  const templateAfter = await cli(['template', 'ls']); await save('templates-after.txt', templateAfter);
  const oldRows = templateRows(templateBefore), newRows = templateRows(templateAfter);
  const removedTemplates = oldRows.filter(row => !newRows.includes(row));
  const retainedNewTemplateCaches = newRows.filter(row => !oldRows.includes(row));
  await save('template-inventory-delta.json', { removedPreexisting: removedTemplates, retainedNewTemplateCaches,
    note: 'sbx-generated assembled-image caches are recorded, not automatically pruned.' });
  if (removedTemplates.length) failure ??= 'Pre-existing template inventory changed';
  if (JSON.stringify(after) !== JSON.stringify(before)) failure ??= 'Before/after inventory mismatch';
  await save('summary.json', { status: failure ? 'FAIL' : 'PASS', prefix, checks, failure, templates: [...templates],
    retainedNewTemplateCaches,
    remainingNewVMs: after.filter(n => !before.includes(n)), missingPreexistingVMs: before.filter(n => !after.includes(n)) });
  if (failure) process.exitCode = 1;
  console.log(`SBX-10 independent Eve apps ${failure ? 'FAIL' : 'PASS'} evidence=${out}`);
}
