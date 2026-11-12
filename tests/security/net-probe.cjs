// Saved guest fixture: only synthetic run labels, never secret canary values.
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const [mode, base, run, label] = process.argv.slice(2);
const url = new URL(`/sbx11/${run}/${label}`, base);
let connected = false;
let settled = false;
function done(value) {
  if (settled) return;
  settled = true;
  console.log(JSON.stringify({ ...value, connected }));
}
function bodyResult(body, status) {
  let matches = false;
  try { const parsed = JSON.parse(body); matches = parsed.run === run && parsed.label === label; } catch {}
  done({ reached: status === 200 && matches, status, responseMatches: matches });
}
if (mode === 'tcp') {
  if (!net.isIP(url.hostname)) throw new Error('Direct TCP mode requires a literal IP; no DNS');
  const socket = net.createConnection({ host: url.hostname, port: Number(url.port || 80) });
  let body = '';
  socket.setTimeout(3500, () => { done({ reached: false, code: 'TIMEOUT' }); socket.destroy(); });
  socket.on('connect', () => {
    connected = true;
    socket.end(`GET ${url.pathname} HTTP/1.0\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
  });
  socket.on('data', data => { body += data.toString(); if (body.length > 65536) socket.destroy(); });
  socket.on('error', error => done({ reached: false, code: error.code || 'ERROR' }));
  socket.on('close', () => {
    const split = body.indexOf('\r\n\r\n');
    bodyResult(split < 0 ? '' : body.slice(split + 4), Number(/^HTTP\/\S+ (\d+)/.exec(body)?.[1] || 0));
  });
} else {
  const client = url.protocol === 'https:' ? https : http;
  const request = client.get(url, { timeout: 3500, agent: false }, response => {
    let body = '';
    response.on('data', data => { body += data.toString(); });
    response.on('end', () => bodyResult(body, response.statusCode));
  });
  request.on('socket', socket => socket.once('connect', () => { connected = true; }));
  request.on('timeout', () => { done({ reached: false, code: 'TIMEOUT' }); request.destroy(); });
  request.on('error', error => done({ reached: false, code: error.code || 'ERROR' }));
}
