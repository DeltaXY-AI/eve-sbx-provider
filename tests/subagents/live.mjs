import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { execFile, fork } from 'node:child_process';
import { cp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'eve/client';
import { runSbx } from '../../dist/internal/sbx-cli.js';
import { assertShared } from '../subagents-shared/assertions.mjs';
import { assertIsolated } from '../subagents-isolated/assertions.mjs';

if (process.env.SBX12_LIVE !== '1') { console.error('Set SBX12_LIVE=1; real model calls and scoped local VM creation/deletion.'); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url)), pkg = resolve(here, '../..'), repo = resolve(pkg, '../..');
const out = resolve(repo, 'research/sbx-provider/raw/step-12', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
// Reuse the configured reference provider/credential without copying .env into
// either app or guest. Never print credentials. No scripted-model fallback.
for (const file of ['.env.local', '.env']) { try { process.loadEnvFile(join(repo, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
const password = randomBytes(32).toString('hex');
const secrets = [password, Buffer.from(`sbx12:${password}`).toString('base64'), ...Object.entries(process.env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value?.length >= 8).map(([, value]) => value)];
const redact = text => { for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]'); return text; };
const save = (name, value) => writeFile(join(out, name), redact(typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
if (!process.env.OPENROUTER_API_KEY) { await save('summary.json', { status: 'BLOCKED', reason: 'OPENROUTER_API_KEY is required for real hosted delegation' }); console.error('SBX-12 BLOCKED: configured model credential unavailable.'); process.exit(2); }
const id = `sbx12-${randomBytes(6).toString('hex')}`, model = process.env.SBX12_MODEL || 'openai/gpt-6-luna';
const started = Date.now(), expected = JSON.parse(await readFile(join(here, 'fixtures/expected.json'), 'utf8'));
const markers = JSON.parse(await readFile(join(here, 'fixtures/markers.json'), 'utf8'));
const normalize = value => Array.isArray(value) ? `[${value.map(normalize).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${normalize(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => createHash('sha256').update(normalize(value)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 90000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const value = await fn(); if (value) return value; } catch (error) { last = error; } await sleep(100); }
  throw new Error(`Timed out: ${label}`, { cause: last });
}
const cli = async args => { const result = await runSbx(args); assert.equal(result.exitCode, 0, result.stderr); return result.stdout; };
const inventory = async () => (await cli(['ls', '-q'])).trim().split(/\r?\n/).filter(Boolean).sort();
const templateRows = text => text.trim().split(/\r?\n/).slice(1).map(line => line.trim().split(/\s+/).slice(0, 3).join(' '));
const before = await inventory(), templateBefore = await cli(['template', 'ls']);
await save('inventory-before.json', before); await save('templates-before.txt', templateBefore); await save('expected.json', expected);
async function packageRoot(name) {
  const require = createRequire(import.meta.url); let directory = dirname(require.resolve(name));
  for (let depth = 0; depth < 6; depth++, directory = dirname(directory)) {
    try { const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); if (manifest.name === name) return { root: directory, version: manifest.version }; } catch {}
  }
  throw new Error(`Cannot resolve reference package ${name}`);
}
const eve = await packageRoot('eve'), openrouter = await packageRoot('@openrouter/ai-sdk-provider'), zod = await packageRoot('zod');
await save('host.json', { date: new Date().toISOString(), node: process.version, platform: process.platform, sbx: await cli(['version']),
  eve: eve.version, model, modelProvider: '@openrouter/ai-sdk-provider', modelProviderVersion: openrouter.version, reasoning: 'low',
  fixtureExpectedDigest: digest(expected), runId: id, note: 'Real hosted model; integration assertions only, not a quality/scale/token-cost benchmark.' });
const cases = [], checks = {};
async function stage(mode) {
  const cwd = join(out, `${mode}-project`); await cp(join(here, 'fixture'), cwd, { recursive: true });
  const manifest = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8'));
  manifest.name = `sbx12-${mode}-fixture`; manifest.dependencies['@deltaxy.ai/eve-sbx-provider'] = `file:${pkg.replaceAll('\\', '/')}`;
  await writeFile(join(cwd, 'package.json'), JSON.stringify(manifest, null, 2));
  await mkdir(join(cwd, 'node_modules/@openrouter'), { recursive: true });
  await mkdir(join(cwd, 'node_modules/@deltaxy.ai'), { recursive: true });
  for (const [name, path] of [['eve', eve.root], ['@deltaxy.ai/eve-sbx-provider', pkg], ['zod', zod.root], ['@openrouter/ai-sdk-provider', openrouter.root]]) {
    await symlink(path, join(cwd, 'node_modules', name), 'junction');
  }
  const rootWorkspace = join(cwd, 'agent/sandbox/workspace'); await mkdir(rootWorkspace, { recursive: true });
  await cp(join(here, 'fixtures/inputs'), join(rootWorkspace, 'inputs'), { recursive: true });
  await cp(join(here, 'fixtures/expected.json'), join(rootWorkspace, 'expected.json'));
  await writeFile(join(rootWorkspace, '.sbx12-run.txt'), id);
  for (const number of ['001', '002', '003']) {
    const worker = join(cwd, 'agent/subagents', `worker_${number}`), clause = `clause-${number}`;
    await mkdir(join(worker, 'tools'), { recursive: true }); await mkdir(join(worker, 'hooks'));
    await writeFile(join(worker, 'agent.ts'), `import { defineAgent } from 'eve';\nimport { fixtureModel, modelSettings } from '../../lib/model';\nexport default defineAgent({ description: 'Deterministic worker for ${clause}', model: fixtureModel(), ...modelSettings, tool: false });\n`);
    await writeFile(join(worker, 'instructions.md'), `You are assigned only ${clause}. Call process_fixture exactly once with {}. Do not use bash or any other tool to parse/write anything. All data work is mechanical in process_fixture. Return that tool's COMPLETE JSON object exactly unchanged as the structured result. Do not invent or omit fields.\n`);
    await writeFile(join(worker, 'tools/process_fixture.ts'), `import { makeWorkerTool } from '../../../lib/worker-tool';\nexport default makeWorkerTool('${clause}');\n`);
    await writeFile(join(worker, 'hooks/lifecycle.ts'), `export { default } from '../../../lib/lifecycle';\n`);
    if (mode === 'shared') {
      await writeFile(join(worker, 'sandbox.ts'), `import { defineParentSandbox } from 'eve/sandbox';\nexport default defineParentSandbox();\n`);
    } else {
      const workspace = join(worker, 'sandbox/workspace/inputs'); await mkdir(workspace, { recursive: true });
      await cp(join(here, `fixtures/inputs/${clause}.txt`), join(workspace, `${clause}.txt`));
      await writeFile(join(worker, 'sandbox/workspace/.sbx12-run.txt'), id);
      await writeFile(join(worker, 'sandbox/sandbox.ts'), `import { makeSandbox } from '../../../lib/sandbox';\nconst definition = makeSandbox('worker-${number}');\nexport const environment = definition.environment;\nexport default definition.selector;\n`);
    }
  }
  const listener = createServer(); await new Promise((r, j) => { listener.once('error', j); listener.listen(0, '127.0.0.1', r); });
  const port = listener.address().port; await new Promise(r => listener.close(r));
  return { mode, cwd, port, output: '', templates: new Set(), buildOutput: '', parentIds: [] };
}
function environmentFor(test) { return { ...process.env, EVE_TELEMETRY_DISABLED: '1', SBX12_RUN: id, SBX12_MODE: test.mode,
  SBX12_MODEL: model, SBX12_PASSWORD: password, SERVER_SHUTDOWN_TIMEOUT: '20',
  HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1', PORT: String(test.port), NITRO_PORT: String(test.port),
  WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${test.port}`, SBX12_SERVER_ENTRY: pathToFileURL(join(test.cwd, '.output/server/index.mjs')).href }; }
const events = test => test.output.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
async function missing(name) { const result = await runSbx(['inspect', name, '--json']); return result.exitCode !== 0 && result.stderr.includes(`error: sandbox '${name}' not found`); }
async function start(test) {
  try {
    const build = await promisify(execFile)(process.execPath, [join(eve.root, 'bin/eve.js'), 'build'], { cwd: test.cwd, env: environmentFor(test), timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
    test.buildOutput = build.stdout + build.stderr;
  } catch (error) { test.buildOutput = (error.stdout || '') + (error.stderr || ''); throw error; }
  finally {
    for (const match of test.buildOutput.matchAll(/eve-dsb-tpl:[a-zA-Z0-9_-]+/g)) test.templates.add(match[0]);
    await save(`${test.mode}-build.log`, test.buildOutput);
  }
  test.child = fork(join(here, 'server.mjs'), [], { cwd: test.cwd, execArgv: [], env: environmentFor(test), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  test.pid = test.child.pid; test.child.stdout.on('data', data => test.output += data); test.child.stderr.on('data', data => test.output += data);
  test.exited = new Promise(resolve => test.child.once('exit', (code, signal) => { test.exit = { code, signal }; resolve(test.exit); }));
  test.client = new Client({ baseUrl: `http://127.0.0.1:${test.port}`, auth: { basic: { username: 'sbx12', password } } });
  await until(async () => { if (test.exit) throw new Error('Fixture server exited early'); return await test.client.health({ signal: AbortSignal.timeout(1000) }).catch(() => false); }, `${test.mode} health`);
}
async function stop(test) {
  if (!test.child || test.exit) return;
  const response = await fetch(`http://127.0.0.1:${test.port}/sbx12/drain`, { method: 'POST', headers: { authorization: `Bearer ${password}` }, signal: AbortSignal.timeout(60000) });
  assert.equal(response.status, 200); test.drain = await response.json(); test.child.send('shutdown');
  await until(() => test.exit, 'graceful fixture exit', 35000);
  assert.equal(test.exit.code, 0); assert.ok(!test.output.includes('Graceful shutdown timed out'));
}
async function runCase(mode) {
  const caseStart = Date.now(), test = await stage(mode); cases.push(test);
  await start(test);
  const { session, delivery } = await test.client.sessions.create({ message: 'Run the fixed three-worker fixture: call delegate_three exactly once, wait for its results, then call verify_parent. Do not do extraction yourself.' });
  test.session = session; test.parentIds.push(session.id);
  const stream = []; for await (const event of delivery.stream({ signal: AbortSignal.timeout(360000) })) stream.push(event);
  await save(`${mode}-initial-events.json`, stream);
  const result = await delivery.result({ signal: AbortSignal.timeout(15000) }); await save(`${mode}-initial-result.json`, result);
  assert.equal(result.status, 'completed', JSON.stringify(result.error));
  const snapshot = await session.snapshot({ signal: AbortSignal.timeout(15000) });
  const opened = snapshot.events.filter(event => event.type === 'child.opened');
  assert.equal(opened.length, 3, 'Exactly three real Eve child sessions, not 100 or repeated delegations');
  const delegated = snapshot.events.filter(event => event.type === 'call.settled' && event.data.outcome === 'completed' && event.data.output?.workers);
  assert.equal(delegated.length, 1, 'The model delegates exactly once through the real workflow tool');
  const returned = delegated[0].data.output;
  const workerProofs = events(test).filter(event => event.event === 'sbx12.worker');
  assert.equal(workerProofs.length, 3);
  const parentProof = events(test).filter(event => event.event === 'sbx12.parent').at(-1); assert.ok(parentProof);
  for (const worker of workerProofs) assert.ok(opened.some(event => event.data.sessionId === worker.result.sessionId), 'Tool trace must correspond to a real announced child');
  const byId = values => [...values].sort((a, b) => a.workerId.localeCompare(b.workerId));
  assert.equal(normalize(byId(returned.workers)), normalize(byId(workerProofs.map(p => p.result))), 'Worker structured results must reach parent unchanged through Eve');
  const childEvents = [];
  for (const event of opened) {
    // Terminal hook stdout is not the lifecycle authority. Read the actual
    // authenticated child event stream and wait for its recorded session.ended.
    const values = await until(async () => {
      const items = []; for await (const item of session.agent(event).stream({ startIndex: 0, follow: false, signal: AbortSignal.timeout(20000) })) items.push(item);
      return items.some(item => item.type === 'session.ended') ? items : false;
    }, `child ${event.data.sessionId} recorded lifecycle end`);
    assert.ok(values.some(item => item.type === 'call.settled' && item.data.outcome === 'completed' && item.data.output?.workerId), 'Real deterministic worker tool trace required');
    childEvents.push({ opened: event, events: values });
  }
  const childEnds = childEvents.map(value => ({ sessionId: value.opened.data.sessionId, event: value.events.find(item => item.type === 'session.ended') }));
  await save(`${mode}-child-events.json`, childEvents);
  if (mode === 'isolated') for (const worker of workerProofs) await until(() => missing(worker.result.nativeVm), 'isolated child VM deleted through Eve');
  assert.ok(!(await missing(parentProof.result.nativeVm)), 'Parent VM must remain after workers end');
  const beforeFollowupCount = events(test).filter(event => event.event === 'sbx12.parent').length;
  const followup = await session.send('Verification-only follow-up: all children have ended. Call verify_parent only now. Do not call delegate_three or any worker.');
  const followupResult = await followup.result({ signal: AbortSignal.timeout(120000) }); assert.equal(followupResult.status, 'completed', JSON.stringify(followupResult.error));
  const parentProofs = events(test).filter(event => event.event === 'sbx12.parent');
  assert.equal(parentProofs.length, beforeFollowupCount + 1); const followupProof = parentProofs.at(-1);
  assert.equal(events(test).filter(event => event.event === 'sbx12.worker').length, 3, 'Verification follow-up must not start more workers');
  const h = { normalize, workerProofs, parentProof, followupProof, returned, expected, markers, session };
  const assertions = mode === 'shared' ? assertShared(h) : assertIsolated(h);
  const mappings = { parent: parentProof, workers: workerProofs, returnedThroughEve: returned,
    childSessionEnds: childEnds, parentAfterChildEnds: followupProof };
  await save(`${mode}-mappings.json`, mappings);
  await save(`${mode}-expected-vs-actual.json`, { expected, actual: byId(returned.workers).map(w => w.clause),
    normalizedExpected: normalize(expected), normalizedActual: normalize(byId(returned.workers).map(w => w.clause)),
    expectedDigest: digest(expected), actualDigest: digest(byId(returned.workers).map(w => w.clause)), assertions });
  await session.end({ reason: 'SBX-12 fixture complete', signal: AbortSignal.timeout(30000) });
  // This Eve release can close the final control-delivery stream before its
  // receipt settles. Establish completion independently from the recorded
  // session.ended fact plus deletion of every native owning VM below.
  test.ended = true;
  const owningVMs = [...new Set([parentProof.result.nativeVm, ...workerProofs.map(p => p.result.nativeVm)])];
  for (const name of owningVMs) await until(() => missing(name), `owning VM removed: ${name}`);
  const nativeRemoval = await Promise.all(owningVMs.map(async name => {
    const args = ['inspect', name, '--json']; const result = await runSbx(args);
    assert.notEqual(result.exitCode, 0); assert.ok(result.stderr.includes(`error: sandbox '${name}' not found`));
    return { args: ['sbx', '--no-input', ...args], ...result };
  }));
  const afterEnd = await inventory();
  const created = [...new Set(events(test).filter(event => event.event === 'create.begin').map(event => event.name))];
  const readyOnlySurvivors = created.filter(name => afterEnd.includes(name));
  assert.ok(readyOnlySurvivors.every(name => !owningVMs.includes(name)), 'No used VM may return to any pool');
  await save(`${mode}-lifecycle.json`, { owningVMs, nativeRemoval, allOwningVMsMissing: true, noUsedVmReturnedToPool: true, readyOnlySurvivors,
    parentSessionEndedThroughEve: session.id, childSessionEnds: childEnds });
  const finalSnapshot = await session.snapshot({ signal: AbortSignal.timeout(20000) });
  assert.ok(finalSnapshot.events.some(event => event.type === 'session.ended'));
  assert.equal(finalSnapshot.events.filter(event => event.type === 'child.opened').length, 3);
  await save(`${mode}-parent-snapshot.json`, finalSnapshot);
  await stop(test);
  for (const name of created) assert.ok(!(await inventory()).includes(name), 'Graceful drain must remove this process pool VMs');
  await save(`${mode}-server.log`, test.output);
  checks[mode] = { status: 'PASS', assertions, pid: test.pid, port: test.port, parentSessionId: session.id,
    owningVMs, runtimeMs: Date.now() - caseStart, exit: test.exit, drain: test.drain };
}
let failure;
try {
  for (const mode of ['shared', 'isolated']) await runCase(mode);
} catch (error) { failure = error.stack; console.error(redact(error.stack || String(error))); process.exitCode = 1; }
finally {
  const fallbackCleanup = [];
  for (const test of cases) {
    if (test.session && !test.ended && !test.exit) {
      try { await test.session.end({ reason: 'SBX-12 failed-run teardown', signal: AbortSignal.timeout(15000) }); await sleep(1500); } catch {}
    }
    try { await stop(test); } catch (error) { failure ??= error.stack; }
    if (test.child && !test.exit) { test.child.kill('SIGKILL'); await test.exited; }
    await save(`${test.mode}-server.log`, test.output);
    // Explicit failure-only teardown uses names traced by this run, never PID
    // existence, prefix discovery or a global orphan sweep.
    const runtimeNames = events(test).filter(event => event.event === 'create.begin').map(event => event.name);
    const buildNames = test.buildOutput.split(/\r?\n/).flatMap(line => { try { const e = JSON.parse(line); return e.event === 'open' && e.name?.startsWith('eve-dsb-build-') ? [e.name] : []; } catch { return []; } });
    const existing = new Set(await inventory());
    for (const name of new Set([...runtimeNames, ...buildNames])) if (existing.has(name)) {
      assert.ok(!before.includes(name)); fallbackCleanup.push(name); await cli(['rm', '-f', name]);
    }
    for (const template of test.templates) {
      if (templateBefore.includes(template.split(':')[1])) { failure ??= 'Refused removal of a pre-existing template'; continue; }
      const result = await runSbx(['template', 'rm', '-f', template]);
      if (result.exitCode !== 0 && !result.stderr.includes('not found')) failure ??= 'Explicit test-template cleanup failed';
    }
  }
  if (fallbackCleanup.length && !failure) failure = 'Normal cleanup unexpectedly required fallback deletion';
  const after = await inventory(); await save('inventory-after.json', after);
  if (normalize(before) !== normalize(after)) failure ??= 'Final native inventory differs from baseline';
  const templateAfter = await cli(['template', 'ls']); await save('templates-after.txt', templateAfter);
  const oldRows = templateRows(templateBefore), newRows = templateRows(templateAfter);
  const removedPreexistingTemplates = oldRows.filter(row => !newRows.includes(row));
  if (removedPreexistingTemplates.length) failure ??= 'Pre-existing template inventory changed';
  await save('summary.json', { status: failure ? 'FAIL' : 'PASS', checks, failure: failure ? redact(failure) : undefined,
    eve: eve.version, model, modelProvider: `@openrouter/ai-sdk-provider@${openrouter.version}`, reasoning: 'low',
    totalRuntimeMs: Date.now() - started, fallbackCleanup, remainingNewVMs: after.filter(name => !before.includes(name)),
    missingPreexistingVMs: before.filter(name => !after.includes(name)), removedPreexistingTemplates,
    retainedNativeTemplateCaches: newRows.filter(row => !oldRows.includes(row)),
    exclusions: ['No 100-worker capacity claim', 'No legal-mapping accuracy claim', 'No token/cost improvement claim', 'SBX-11 public/link-local controls remain separately BLOCKED'] });
  if (failure) process.exitCode = 1;
  console.log(`SBX-12 subagents ${failure ? 'FAIL' : 'PASS'} evidence=${out}`);
}
