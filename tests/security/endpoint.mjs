import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

// Synthetic-only controlled endpoint. No file access, secrets, or application
// operations. Run separately on an operator-controlled public/link-local host
// when provisioning the corresponding positive controls.
export function createEndpoint() {
  const counts = new Map();
  const server = createServer((request, response) => {
    const parts = new URL(request.url, 'http://endpoint.invalid').pathname.split('/').filter(Boolean);
    if (parts.length !== 3 || parts[0] !== 'sbx11' || !parts.slice(1).every(p => /^[a-zA-Z0-9_-]{1,160}$/.test(p))) {
      response.writeHead(404).end(); return;
    }
    const [, run, label] = parts;
    const counters = counts.get(run) ?? {}; counts.set(run, counters);
    if (label === '_counts') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(counters)); return;
    }
    counters[label] = (counters[label] ?? 0) + 1;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ run, label }));
  });
  return { server, counts };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createEndpoint();
  server.listen(Number(process.env.SBX11_ENDPOINT_PORT || 8080), process.env.SBX11_ENDPOINT_BIND || '127.0.0.1', () => {
    console.log(JSON.stringify({ event: 'sbx11.endpoint.ready', address: server.address() }));
  });
}
