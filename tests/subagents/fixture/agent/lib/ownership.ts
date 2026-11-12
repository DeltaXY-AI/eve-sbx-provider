import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

// Test-only inspector: reads only this fixture's own persisted claim, then
// independently inspects that exact native name with the operator CLI. It does
// not alter provider identity or lifecycle and never chooses another app's VM.
export async function ownership(sandbox: { readTextFile(options: { path: string }): Promise<string | null> }) {
  const raw = await sandbox.readTextFile({ path: '.sbx12-owner.json' });
  if (raw === null) throw new Error('Missing selector ownership proof');
  const owner = JSON.parse(raw) as { ownerSessionId: string; namespace: string };
  if (!owner.namespace.startsWith(`${process.env.SBX12_RUN}-${process.env.SBX12_MODE}-`)) throw new Error('Foreign fixture namespace');
  const hash = createHash('sha256').update(`${owner.namespace}\0${owner.ownerSessionId}`).digest('hex');
  const file = join(process.cwd(), '.eve', 'sandbox-cache', 'docker-sandboxes-claims', hash);
  const nativeVm = (await readFile(file, 'utf8')).trim();
  if (!/^eve-dsb-p-[0-9a-f]{8}-[0-9a-f-]{36}$/.test(nativeVm)) throw new Error('Unexpected fixture native name');
  const inspected = await promisify(execFile)('sbx', ['--no-input', 'inspect', nativeVm, '--json'], { timeout: 15000, windowsHide: true });
  const native = JSON.parse(inspected.stdout);
  if (native.name !== nativeVm) throw new Error('Native identity does not match the persisted claim');
  return { ...owner, nativeVm, claimFile: file, inspect: native };
}
