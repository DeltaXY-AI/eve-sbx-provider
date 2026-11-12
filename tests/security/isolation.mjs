import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runSbxBytes } from '../../dist/internal/sbx-cli.js';
import { discardChannel, getChannel } from '../../dist/internal/sbx-channel.js';

export async function isolation(h) {
  const a = await h.open('isolation-a'), b = await h.open('isolation-b');
  const mounts = await h.inspect(a.state.name);
  assert.deepEqual(mounts.host_mounts, []); assert.deepEqual(mounts.runtime_mounts, []);
  assert.ok((await readFile(h.hostFile)).equals(Buffer.from(h.hostCanary)), 'Host positive control');
  const unix = h.hostFile.replaceAll('\\', '/');
  const drive = /^([a-zA-Z]):(.*)$/.exec(unix);
  const paths = [h.hostFile, unix, ...(drive ? [`/mnt/${drive[1].toLowerCase()}${drive[2]}`, `/host_mnt/${drive[1].toLowerCase()}${drive[2]}`, `/run/host/${drive[1].toLowerCase()}${drive[2]}`] : [])];
  for (const path of [...new Set(paths)]) assert.equal(await a.connection.readFile({ path }), null, 'Host-only canary path must be unreadable');
  await h.save('host-filesystem.json', { hostPositiveControl: true, paths, inspect: mounts, hostCanaryReadableInGuest: false });
  h.pass('host-file', 'No host/runtime mounts; known host-only paths unreadable; host positive control succeeds');

  const marker = h.secret();
  await a.connection.writeFiles({ files: [{ path: '/workspace/private-session-marker', content: Buffer.from(marker) }] });
  assert.equal(await b.connection.readFile({ path: '/workspace/private-session-marker' }), null);
  assert.notEqual(a.state.name, b.state.name);
  await h.save('session-isolation.json', { a: a.state, b: b.state, knownPathReadableFromB: false });
  h.pass('other-session', 'Distinct native VMs; B cannot read A known guest marker path');
  await h.end(a); await h.absent(a.state.name); await h.ready(h.denyPool);
  const c = await h.open('after-destruction');
  assert.ok(h.events().some(event => event.event === 'session.ready' && event.name === c.state.name && event.warm === true), 'Use a genuinely ready-pool VM');
  assert.notEqual(c.state.name, a.state.name);
  assert.equal(await c.connection.readFile({ path: '/workspace/private-session-marker' }), null);
  await h.save('no-reassignment.json', { destroyed: a.state.name, next: c.state.name, markerPresent: false, pool: h.denyPool.diagnostics() });
  h.pass('used-vm', 'Ended session VM destroyed; next warm session has a different identity and no marker');

  const privilege = await h.run(b.connection, `node -e 'const fs=require("node:fs");let write;try{fs.writeFileSync("/opt/sbx11-protected/fixture","overwrite");write="SUCCEEDED"}catch(e){write=e.code}console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),write}))'; command -v sudo >/dev/null && printf 'SUDO_PRESENT' || true`);
  const privilegeInfo = JSON.parse(privilege.stdout.toString());
  assert.equal(privilegeInfo.uid, 1000); assert.equal(privilegeInfo.gid, 1000); assert.ok(!privilegeInfo.groups.includes(0));
  assert.equal(privilegeInfo.write, 'EACCES');
  await h.save('privileges.json', privilegeInfo); h.pass('non-root', 'Actual provider command: uid/gid1000, no root group, root fixture write denied, sudo absent');

  for (const [label, opened] of [['session-a', b], ['template-clone', c]]) {
    const dump = await h.run(opened.connection, 'node -e "console.log(JSON.stringify(process.env))"; tar -cf - -C / workspace home/agent tmp 2>/dev/null');
    assert.ok(!dump.stdout.includes(Buffer.from(h.hostCanary)), 'No inherited host environment canary in guest env/workspace/home/tmp');
    for (const file of h.fixtures) assert.ok(!file.content.includes(Buffer.from(h.hostCanary)));
    await h.save(`environment-${label}.json`, { native: opened.state, hostOnlyKeyPresent: dump.stdout.includes(Buffer.from('SBX11_HOST_ONLY_SECRET')), hostCanaryFound: false,
      scannedGuestBytes: dump.stdout.length, fixtures: h.fixtures.map(f => ({ path: f.path, bytes: f.content.length })) });
    assert.ok(!dump.stdout.includes(Buffer.from('SBX11_HOST_ONLY_SECRET')));
  }
  h.pass('host-env', 'Host-only env canary absent from guest env and cloned workspace/home/tmp; saved fixture bytes clean');
  await h.end(b);
  // A distinct pool-size-zero environment must exercise the true cold path.
  const cold = await h.open('cold-default', { poolSize: 0 });
  assert.equal(cold.state.networkPolicy, 'deny-all');
  assert.ok(h.events().some(event => event.event === 'session.ready' && event.name === cold.state.name && event.warm === false), 'Pool size zero must exercise a cold create');
  await h.save('warm-cold-defaults.json', { warm: c.state, cold: cold.state, effectiveDefault: 'deny-all', tracePathAssertions: true });
  return { cold, warm: c };
}

export async function diagnostics(h) {
  const opened = await h.open('diagnostics');
  const [command, env, stdin, file] = Array.from({ length: 4 }, () => h.secret());
  assert.ok((await h.run(opened.connection, `printf %s '${command}'`)).stdout.equals(Buffer.from(command)));
  assert.ok((await h.run(opened.connection, 'printf %s "$SYNTHETIC_VALUE"', { env: { SYNTHETIC_VALUE: env } })).stdout.equals(Buffer.from(env)));
  const process = await opened.connection.spawn({ command: 'cat', workingDirectory: '/workspace', env: {}, stdin: true });
  const output = new Response(process.stdout).arrayBuffer(); const errors = new Response(process.stderr).arrayBuffer();
  const writer = process.stdin.getWriter(); await writer.write(Buffer.from(stdin)); await writer.close();
  assert.equal((await process.wait()).exitCode, 0); await errors; assert.ok(Buffer.from(await output).equals(Buffer.from(stdin)));
  await opened.connection.writeFiles({ files: [{ path: '/workspace/diagnostic-input', content: Buffer.from(file) }] });
  assert.ok(Buffer.from(await opened.connection.readFile({ path: '/workspace/diagnostic-input' })).equals(Buffer.from(file)));
  // Guest error messages containing input/path data must not leak through an exception.
  await assert.rejects(() => opened.connection.readFile({ path: '/workspace' }), error => !h.hasCanary(error.stack));
  await assert.rejects(() => opened.connection.writeFiles({ files: [{ path: `/opt/sbx11-protected/${file}`, content: Buffer.from('x') }] }),
    error => { assert.ok(!h.hasCanary(error.stack), 'Guest EACCES path text must not leak the file-input canary'); return true; });

  // Force a REAL CLI bootstrap failure, not a mocked runSbx: replace Node in
  // this one disposable VM as the trusted operator. sbx exec now emits every
  // input canary to stdout/stderr and exits 23. The channel must NOT log/embed it.
  await discardChannel(opened.state.name);
  const script = `set -eu\np=$(command -v node)\nmv "$p" "$p.sbx11-real"\ncat > "$p" <<'SBX11_SHIM'\n#!/bin/sh\nprintf '%s\\n' '${command}' '${env}'\nprintf '%s\\n' '${stdin}' '${file}' >&2\nexit 23\nSBX11_SHIM\nchmod 755 "$p"\n`;
  const patched = await runSbxBytes(['exec', '-i', '-u', 'root', opened.state.name, 'sh', '-s'], Buffer.from(script));
  assert.equal(patched.exitCode, 0);
  const rawCli = await runSbxBytes(['exec', opened.state.name, 'node', '--version']);
  assert.equal(rawCli.exitCode, 23, 'Forced native CLI failure positive control');
  const rawDiagnostics = Buffer.concat([rawCli.stdout, Buffer.from(rawCli.stderr)]);
  assert.ok([command, env, stdin, file].every(value => rawDiagnostics.includes(Buffer.from(value))), 'The real CLI must actually emit all four canaries before testing suppression');
  for (const trace of [false, true]) {
    await assert.rejects(() => getChannel(opened.state.name, 'sbx', trace), error => {
      assert.ok(!h.hasCanary(error.stack), 'CLI diagnostic text must be metadata-only'); return true;
    });
  }
  assert.ok(!h.hasCanary(h.logs.join('\n')), 'Normal package logs must contain no synthetic canaries before any evidence redaction');
  await h.save('diagnostic-leaks.json', { commandEnvStdinFileRoundtrips: true, actualCliFailure: true, rawCliExitCode: 23, rawCliEmittedCanaries: 4, traceModes: [false, true], rawLogCanaryMatches: 0,
    note: 'Requested command/file/stdin outputs are intentionally returned to the caller; default exceptions and provider logs omit raw CLI/guest error text.' });
  h.pass('diagnostic-leaks', 'Four input canaries and actual CLI failure; trace-off/on exceptions and raw logs contain none');
  await h.end(opened);
}
