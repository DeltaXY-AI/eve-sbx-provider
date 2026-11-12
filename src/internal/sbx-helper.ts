// One native node -e argument. Single quotes avoid sbx's long-argument quoting
// issue on Windows. stdout is reserved for protocol; file/output bytes are base64.
export const HELPER = String.raw`
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const readline = require('node:readline');
const account = fs.readFileSync('/etc/passwd', 'utf8').split('\n')
  .map((line) => line.split(':')).find((fields) => fields[2] === '1000');
if (!account) throw new Error('Helper needs an account at uid 1000');
if (process.getuid() === 0) {
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
}
if (process.getuid() !== 1000 || process.getgid() !== 1000) throw new Error('Helper must run as uid/gid 1000');
Object.assign(process.env, { HOME: account[5], USER: account[0], LOGNAME: account[0] });
const jobs = new Map();
let closing = false;
function send(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}
function report(id, error) {
  send({ id, error: { name: error.name, code: error.code, message: error.message || String(error) } });
}
function kill(job) {
  if (!job.child.pid) return;
  try { process.kill(-job.child.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function finishShutdown() {
  if (closing && jobs.size === 0) process.stdout.write('', () => process.exit(0));
}
function shutdown() {
  if (closing) return;
  closing = true;
  for (const job of jobs.values()) {
    try { kill(job); } catch (error) { report(job.id, error); }
  }
  finishShutdown();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdout.on('error', () => {
  for (const job of jobs.values()) { try { kill(job); } catch {} }
  process.exit(1);
});
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('close', shutdown);
input.on('line', (line) => {
  let r;
  try {
    r = JSON.parse(line);
    if (!r || typeof r.id !== 'string') throw new Error('Request must have a string id');
    if (closing) throw new Error('Helper is shutting down');
    if (r.op === 'kill') {
      const job = jobs.get(r.id);
      if (job) kill(job);
    } else if (r.op === 'in' || r.op === 'inEnd') {
      const job = jobs.get(r.id);
      if (!job) return;
      if (r.op === 'inEnd') job.child.stdin.end();
      else job.child.stdin.write(Buffer.from(r.d, 'base64'));
    } else if (r.op === 'spawn') {
      if (jobs.has(r.id)) throw new Error('Duplicate request id');
      const child = spawn('bash', ['-lc', r.command], {
        cwd: r.cwd, env: { ...process.env, ...r.env },
        detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const job = { id: r.id, child, failed: false };
      jobs.set(r.id, job);
      // Acknowledging spawn lets the host report launch errors from spawn(),
      // rather than pretending an invalid working directory started a process.
      child.on('spawn', () => send({ id: r.id, started: 1, pid: child.pid }));
      child.stdout.on('data', (d) => send({ id: r.id, s: 1, d: d.toString('base64') }));
      child.stderr.on('data', (d) => send({ id: r.id, s: 2, d: d.toString('base64') }));
      child.on('error', (error) => { job.failed = true; report(r.id, error); });
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') {
          job.failed = true;
          report(r.id, error);
          try { kill(job); } catch (failure) { report(r.id, failure); }
        }
      });
      // Keep the job until its pipes close: the shell can exit while background
      // descendants still hold stdout open, and abort must kill those too.
      child.on('close', (code, signal) => {
        jobs.delete(r.id);
        if (!job.failed) send({ id: r.id, exit: code ?? 128 + (constants.signals[signal] || 0) });
        finishShutdown();
      });
      if (!r.stdin) child.stdin.end();
    } else if (r.op === 'read') {
      try { send({ id: r.id, ok: 1, d: fs.readFileSync(r.path).toString('base64') }); }
      catch (error) {
        if (error.code === 'ENOENT') send({ id: r.id, ok: 1, missing: 1 });
        else throw error;
      }
    } else if (r.op === 'write') {
      for (const file of r.files) {
        fs.mkdirSync(path.dirname(file.path), { recursive: true });
        fs.writeFileSync(file.path, Buffer.from(file.d, 'base64'));
      }
      send({ id: r.id, ok: 1 });
    } else if (r.op === 'rm') {
      fs.rmSync(r.path, { force: !!r.force, recursive: !!r.recursive });
      send({ id: r.id, ok: 1 });
    } else throw new Error('Unknown operation: ' + r.op);
  } catch (error) {
    if (r && typeof r.id === 'string') report(r.id, error);
    else { process.stderr.write('Invalid channel request\n'); shutdown(); }
  }
});
send({ ready: 1, pid: process.pid, nodeVersion: process.version });
`;
