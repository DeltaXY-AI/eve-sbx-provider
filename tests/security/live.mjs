import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOptions } from '../../dist/internal/options.js';
import { createSbxEnvironment, shutdownSbx } from '../../dist/internal/sbx-sandbox.js';
import { poolFor, poolDiagnostics } from '../../dist/internal/sbx-pool.js';
import { readVmNetworkPolicy } from '../../dist/internal/sbx-policy.js';
import { runSbx } from '../../dist/internal/sbx-cli.js';
import { isolation, diagnostics } from './isolation.mjs';
import { network } from './network.mjs';

if (process.env.SBX11_LIVE !== '1') { console.error('Set SBX11_LIVE=1 to create scoped local security-test VMs.'); process.exit(2); }
const here = dirname(fileURLToPath(import.meta.url));
const id = `sbx11-${randomBytes(6).toString('hex')}`;
const out = resolve(here, '../../../../research/sbx-provider/raw/step-11', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), `${id}-`));
const storage = join(temporary, 'claims'); const hostFile = join(temporary, 'host-only-canary.txt');
const canaries = [];
function secret() { const value = randomBytes(32).toString('hex'); canaries.push(value); return value; }
const hostCanary = secret(); await writeFile(hostFile, hostCanary);
const originalHostEnv = process.env.SBX11_HOST_ONLY_SECRET; process.env.SBX11_HOST_ONLY_SECRET = hostCanary;
const logs = []; const originalLog = console.log, originalError = console.error;
const capture = (...args) => logs.push(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));
console.log = capture; console.error = capture;
function hasCanary(text) { return canaries.some(value => text.includes(value) || text.includes(Buffer.from(value).toString('base64'))); }
function redact(text) { for (const value of canaries) text = text.replaceAll(value, '[SYNTHETIC-REDACTED]').replaceAll(Buffer.from(value).toString('base64'), '[SYNTHETIC-REDACTED]'); return text; }
let redactions = 0;
async function save(name, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (hasCanary(text)) redactions++;
  await writeFile(join(out, name), redact(text));
}
const rows = {};
const pass = (risk, actual) => { rows[risk] = { status: 'PASS', actual }; };
const block = (risk, reason) => { rows[risk] = { status: 'BLOCKED', reason }; };
const cli = async args => { const r = await runSbx(args); assert.equal(r.exitCode, 0, `sbx ${args[0]} failed (${r.exitCode})`); return r.stdout; };
const inventory = async () => (await cli(['ls', '-q'])).trim().split(/\r?\n/).filter(Boolean).sort();
const inspect = async name => JSON.parse(await cli(['inspect', name, '--json']));
const run = async (connection, command, options = {}) => {
  const process = await connection.spawn({ command, workingDirectory: '/workspace', env: {}, ...options });
  const [stdout, stderr, done] = await Promise.all([new Response(process.stdout).arrayBuffer(), new Response(process.stderr).arrayBuffer(), process.wait()]);
  return { ...done, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) };
};
async function ready(pool) {
  pool.fill(); const deadline = Date.now() + 90000;
  while (Date.now() < deadline) { const info = pool.diagnostics(); if (info.pending === 0 && info.ready.length === info.target) return info; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Security-test ready pool did not fill');
}
const options = validateOptions({ namespace: id, poolSize: 1, trace: true });
const environment = createSbxEnvironment(options); const sessions = [];
const context = suffix => ({ session: { id: `${id}-${suffix}` }, kind: 'session', storagePath: storage });
const events = () => logs.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const fixtures = [
  { path: '/workspace/net-probe.cjs', content: await readFile(join(here, 'net-probe.cjs')) },
  { path: '/workspace/synthetic-fixture.txt', content: Buffer.from('Synthetic SBX-11 fixture; no host environment contents.\n') },
];
const h = { id, out, storage, hostFile, hostCanary, secret, hasCanary, fixtures, options, environment, context, events, logs,
  save, pass, block, cli, inventory, inspect, run, ready, poolFor, readPolicy: name => readVmNetworkPolicy(name, 'sbx') };
h.open = async (suffix, config = {}) => {
  const selected = config.poolSize === 0 ? createSbxEnvironment({ ...options, poolSize: 0 }) : environment;
  const ctx = context(suffix);
  const opened = await selected.start(ctx, config.networkPolicy === undefined ? undefined : { networkPolicy: config.networkPolicy }, h.artifact);
  const session = { ...opened, ctx, environment: selected, ended: false }; sessions.push(session); return session;
};
h.end = async session => { if (session.ended) return; await session.environment.onSessionEnd(session.ctx, null, { reason: 'completed' }); session.ended = true; };
h.absent = async name => { const r = await runSbx(['inspect', name, '--json']); assert.notEqual(r.exitCode, 0); assert.ok(r.stderr.includes(`sandbox '${name}' not found`)); };
const before = await inventory(); const policiesBefore = JSON.parse(await cli(['policy', 'ls', '--json']));
const templateBefore = await cli(['template', 'ls']);
await save('inventory-before.json', before); await save('global-policies-before.json', policiesBefore); await save('templates-before.txt', templateBefore);
await save('host.json', { date: new Date().toISOString(), node: process.version, platform: process.platform, namespace: id, storage,
  sbx: await cli(['version']), hostCanaryDigest: createHash('sha256').update(hostCanary).digest('hex'),
  buildInternetAllowed: true, runtimeDefaultPolicy: 'deny-all', noProductionSecretsUsed: true });
let failure;
try {
  h.artifact = await environment.prepare({ storagePath: storage, templateKey: () => id, log: capture,
    populate: async connection => {
      await connection.writeFiles({ files: fixtures });
      const build = events().filter(e => e.event === 'open' && e.name?.startsWith('eve-dsb-build-')).at(-1)?.name;
      assert.ok(build, 'Prepared build VM must be observed before fixture setup');
      await cli(['exec', '-u', 'root', build, 'sh', '-c', 'mkdir -p /opt/sbx11-protected; printf protected > /opt/sbx11-protected/fixture; chown -R 0:0 /opt/sbx11-protected; chmod 755 /opt/sbx11-protected; chmod 644 /opt/sbx11-protected/fixture']);
      const guestEnvironment = await run(connection, 'node -e "console.log(JSON.stringify(process.env))"');
      assert.ok(!guestEnvironment.stdout.includes(Buffer.from(hostCanary)), 'Host canary must not be baked into the template');
    } });
  await save('template.json', h.artifact);
  h.denyPool = poolFor(h.artifact.template, options); await ready(h.denyPool);
  let paths;
  try { paths = await isolation(h); } catch (error) { rows.isolation = { status: 'FAIL', error: redact(error.stack) }; failure = error.stack; }
  if (paths) {
    try { await network(h, paths); } catch (error) { rows.network = { status: 'FAIL', error: redact(error.stack) }; failure ??= error.stack; }
  }
  try { await diagnostics(h); } catch (error) { rows['diagnostic-leaks'] = { status: 'FAIL', error: redact(error.stack) }; failure ??= error.stack; }
} catch (error) { failure = error.stack; rows.setup = { status: 'FAIL', error: redact(error.stack) }; }
finally {
  for (const session of sessions) { try { await h.end(session); } catch (error) { failure ??= error.stack; } }
  try { await shutdownSbx(id); } catch (error) { failure ??= error.stack; }
  if (h.endpoint) await new Promise(resolve => h.endpoint.close(resolve));
  const after = await inventory(); await save('inventory-after.json', after);
  if (JSON.stringify(before) !== JSON.stringify(after)) failure ??= 'VM inventory changed after scoped cleanup';
  const policyAfter = JSON.parse(await cli(['policy', 'ls', '--json'])); await save('global-policies-after.json', policyAfter);
  const sorted = rules => [...rules].sort((a, b) => `${a.scope}:${a.id}`.localeCompare(`${b.scope}:${b.id}`));
  if (JSON.stringify(sorted(policiesBefore.rules)) !== JSON.stringify(sorted(policyAfter.rules))) failure ??= 'Pre-existing policy inventory changed';
  if (h.artifact && !after.some(name => sessions.some(s => s.state.name === name))) {
    const removed = await runSbx(['template', 'rm', '-f', h.artifact.template]);
    if (removed.exitCode !== 0) failure ??= 'Explicit test-template removal failed';
  }
  await save('templates-after.txt', await cli(['template', 'ls']));
  if (hasCanary(logs.join('\n'))) failure ??= 'Synthetic canary found in raw provider diagnostics';
  await save('provider.log', logs.join('\n'));
  if (redactions) failure ??= 'Evidence required synthetic-canary redaction; inspect failed assertions';
  for (const risk of ['host-file', 'other-session', 'used-vm', 'non-root', 'host-env', 'internet-egress', 'host-direct-ip', 'link-local', 'unsupported-policy', 'policy-mixing', 'diagnostic-leaks']) {
    if (!rows[risk]) block(risk, 'Earlier failed prerequisite prevented this check');
  }
  const status = failure || Object.values(rows).some(row => row.status === 'FAIL') ? 'FAIL'
    : Object.values(rows).some(row => row.status === 'BLOCKED') ? 'BLOCKED' : 'PASS';
  await save('checks.json', rows);
  await save('summary.json', { status, namespace: id, checks: rows, failure: failure ? redact(failure) : undefined,
    evidenceRedactions: redactions, rawLogCanaryMatches: hasCanary(logs.join('\n')) ? 'FOUND' : 0,
    remainingNewVMs: after.filter(n => !before.includes(n)), missingPreexistingVMs: before.filter(n => !after.includes(n)),
    residualLimitations: ['No VM-escape, denial-of-service or prompt-injection guarantee', 'No DigitalOcean metadata-service test', 'sbx-managed assembled-image cache is not pruned'],
    poolsAfterCleanup: poolDiagnostics() });
  if (originalHostEnv === undefined) delete process.env.SBX11_HOST_ONLY_SECRET; else process.env.SBX11_HOST_ONLY_SECRET = originalHostEnv;
  await rm(temporary, { recursive: true, force: true });
  console.log = originalLog; console.error = originalError;
  process.exitCode = status === 'PASS' ? 0 : status === 'BLOCKED' ? 2 : 1;
  console.log(`SBX-11 security ${status} evidence=${out}`);
}
