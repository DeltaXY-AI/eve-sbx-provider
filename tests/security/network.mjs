import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { createEndpoint } from './endpoint.mjs';
import { runSbx } from '../../dist/internal/sbx-cli.js';

export async function network(h, { cold, warm }) {
  await h.ready(h.denyPool);
  const allowOptions = { ...h.options, networkPolicy: 'allow-all' };
  const allowPool = h.poolFor(h.artifact.template, allowOptions); allowPool.fill(); await h.ready(allowPool);
  const allow = await h.open('allow-control', { networkPolicy: 'allow-all' });
  await h.ready(allowPool);
  const beforeInvalid = await h.inventory();
  for (const policy of [null, '', 'balanced', { allow: ['example.com'] }, ['example.com']]) {
    await assert.rejects(() => h.environment.start(h.context('invalid'), { networkPolicy: policy }, h.artifact), /networkPolicy/);
  }
  assert.deepEqual(await h.inventory(), beforeInvalid);
  h.pass('unsupported-policy', 'Invalid/domain-list policies reject before claim, pool take or VM assignment');
  await h.save('unsupported-policy.json', { rejected: ['null', 'empty', 'balanced', 'domain-list object', 'array'], vmInventoryUnchanged: true });

  const { server } = createEndpoint(); h.endpoint = server;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', resolve); });
  const port = server.address().port, localControl = `http://127.0.0.1:${port}`;
  let sequence = 0;
  const evidence = [];
  async function counts(base) {
    const response = await fetch(new URL(`/sbx11/${h.id}/_counts`, base), { signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); return response.json();
  }
  async function probe(opened, target, mode, label) {
    const command = `node /workspace/net-probe.cjs ${mode} ${JSON.stringify(target.base)} ${h.id} ${label}`;
    const result = await h.run(opened.connection, command);
    assert.equal(result.exitCode, 0, 'Network fixture must return a structured probe result');
    const value = JSON.parse(result.stdout.toString());
    const hits = (await counts(target.control))[label] || 0;
    const policy = await runSbx(['policy', 'check', 'network', '--sandbox', opened.state.name, '--json', target.base]);
    assert.ok([0, 1].includes(policy.exitCode), 'Read-only authorizer check must report allow/deny');
    const row = { native: opened.state, mode, target: target.base, label, result: value, endpointRequests: hits, policyExitCode: policy.exitCode, policy: JSON.parse(policy.stdout) };
    evidence.push(row); return row;
  }
  async function positive(target, mode = 'tcp') {
    const label = `positive-${sequence++}`;
    try {
      const value = await probe(allow, target, mode, label);
      return value.result.reached && value.endpointRequests > 0 && value.policy.allowed === true ? value : false;
    } catch (error) { evidence.push({ target: target.base, mode, positiveControlError: error.message }); return false; }
  }
  async function denial(target, mode, kind) {
    for (const [path, opened] of [['cold', cold], ['warm', warm]]) {
      assert.equal(opened.state.networkPolicy, 'deny-all');
      const row = await probe(opened, target, mode, `${kind}-${path}-${sequence++}`);
      assert.equal(row.result.reached, false, `${path} runtime deny must prevent endpoint access`);
      assert.equal(row.endpointRequests, 0, 'Controlled endpoint must observe zero denied requests');
      assert.equal(row.policy.allowed, false, 'Backend authorizer must report an explicit denial');
    }
  }

  // Each local address is an actual address owned by this test host/listener.
  // No scans of unrelated LAN machines, no metadata-service guesses.
  const localIPs = Object.values(networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address);
  const localTargets = localIPs.map(ip => ({ base: `http://${ip}:${port}`, control: localControl }));
  let hostTarget;
  for (const target of localTargets) if (await positive(target)) { hostTarget = target; break; }
  if (hostTarget) {
    await denial(hostTarget, 'tcp', 'host-direct-ip');
    h.pass('host-direct-ip', 'Controlled host/LAN literal-IP TCP: allow-all reaches endpoint; both deny paths receive no response and endpoint sees zero requests');
  } else h.block('host-direct-ip', 'No controlled host/LAN address reached from allow-all; network unreachability is not proof of denial');

  const dnsTarget = { base: `http://host.docker.internal:${port}`, control: localControl };
  const dnsPositive = await positive(dnsTarget, 'http');
  if (dnsPositive) {
    await denial(dnsTarget, 'http', 'host-dns');
    h.pass('controlled-host-dns', 'Controlled host DNS endpoint: positive allow control and zero warm/cold deny requests');
  } else h.block('controlled-host-dns', 'host.docker.internal positive control unavailable; not counted as internet evidence');

  // PUBLIC endpoint must run endpoint.mjs (or its exact protocol) on an
  // operator-controlled Internet host. Never substitute a third-party echo site.
  let publicTarget;
  if (process.env.SBX11_PUBLIC_URL) {
    const url = new URL(process.env.SBX11_PUBLIC_URL);
    assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password);
    publicTarget = { base: url.origin, control: process.env.SBX11_PUBLIC_CONTROL_URL || url.origin };
  }
  const publicPositive = publicTarget ? await positive(publicTarget, 'http') : false;
  if (publicPositive) {
    await denial(publicTarget, 'http', 'internet');
    h.pass('internet-egress', 'Controlled public endpoint positive allow-all; warm/cold default deny paths observe zero requests');
  } else h.block('internet-egress', publicTarget ? 'Controlled public endpoint positive control failed' : 'No operator-controlled public endpoint configured (SBX11_PUBLIC_URL); host-only tests are not internet proof');

  let linkTarget;
  if (process.env.SBX11_LINK_LOCAL_URL) {
    const url = new URL(process.env.SBX11_LINK_LOCAL_URL);
    assert.equal(url.protocol, 'http:'); assert.ok(isIP(url.hostname) === 4 && url.hostname.startsWith('169.254.'));
    assert.notEqual(url.hostname, '169.254.169.254', 'Do not probe a real metadata service; use a controlled test address');
    linkTarget = { base: url.origin, control: process.env.SBX11_LINK_LOCAL_CONTROL_URL || url.origin };
  }
  if (linkTarget && await positive(linkTarget, 'tcp')) {
    await denial(linkTarget, 'tcp', 'link-local');
    h.pass('link-local', 'Controlled link-local literal-IP TCP positive control; warm/cold deny paths observe zero requests');
  } else {
    // Read-only backend evidence is useful but explicitly insufficient alone.
    await h.save('link-local-policy-only.json', { probeNotRunWithoutReachableControl: true,
      policies: await Promise.all([cold, warm].map(async opened => {
        const check = await runSbx(['policy', 'check', 'network', '--sandbox', opened.state.name, '--json', '169.254.77.11:8080']);
        return { native: opened.state, exitCode: check.exitCode, check: JSON.parse(check.stdout) };
      })) });
    h.block('link-local', linkTarget ? 'Controlled link-local allow-all positive control failed' : 'No reachable controlled link-local test destination configured; backend policy checks alone are not a firewall test');
  }

  const mixingTarget = hostTarget || (dnsPositive ? dnsTarget : publicPositive ? publicTarget : undefined);
  if (mixingTarget) {
    const mode = isIP(new URL(mixingTarget.base).hostname) && new URL(mixingTarget.base).protocol === 'http:' ? 'tcp' : 'http';
    const mixing = [];
    for (const [index, policy] of ['deny-all', 'allow-all', 'deny-all', 'allow-all'].entries()) {
      await Promise.all([h.ready(h.denyPool), h.ready(allowPool)]);
      const selectedPool = policy === 'deny-all' ? h.denyPool : allowPool;
      const expected = selectedPool.diagnostics().ready[0];
      const opened = await h.open(`mix-${index}`, { networkPolicy: policy });
      assert.equal(opened.state.name, expected, 'Assignment must come from the matching ready policy pool');
      assert.equal(opened.state.networkPolicy, policy);
      assert.equal(await h.readPolicy(opened.state.name), policy);
      const row = await probe(opened, mixingTarget, mode, `mix-${index}`);
      assert.equal(row.result.reached, policy === 'allow-all');
      assert.equal(row.endpointRequests > 0, policy === 'allow-all');
      assert.equal(row.policy.allowed, policy === 'allow-all');
      mixing.push({ policy, expected, ...row }); await h.end(opened);
    }
    await h.save('policy-mixing.json', { mixing, denyPool: h.denyPool.diagnostics(), allowPool: allowPool.diagnostics() });
    h.pass('policy-mixing', 'Four alternating assignments from simultaneously ready policy-separated pools; native rules and controlled endpoint behavior agree');
  } else h.block('policy-mixing', 'No reachable controlled endpoint; pool identity/unit checks alone do not establish traffic behavior');
  await h.save('network-probes.json', { port, localIPs, evidence });
  await h.save('native-policies.json', await Promise.all([cold, warm, allow].map(async opened => ({ native: opened.state,
    inspect: await h.inspect(opened.state.name), rules: JSON.parse(await h.cli(['policy', 'ls', opened.state.name, '--json'])) }))));
}
