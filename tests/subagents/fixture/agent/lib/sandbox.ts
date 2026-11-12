import { defineSandbox } from 'eve/sandbox';
import { SbxSandbox, shutdownSbx } from '@deltaxy.ai/eve-sbx-provider';

export const roles = ['parent', 'worker-001', 'worker-002', 'worker-003'] as const;
export function namespaceFor(role: string) { return `${process.env.SBX12_RUN}-${process.env.SBX12_MODE}-${role}`; }
export function makeSandbox(role: string) {
  const namespace = namespaceFor(role);
  const environment = SbxSandbox.environment({ namespace, poolSize: 1, trace: true });
  const selector = defineSandbox(async ({ session }) => {
    const sandbox = await environment.open();
    // Idempotent selector initialization. defineParentSandbox() must enter the
    // PARENT selector with the owning parent session, not a spoofed child ID.
    await sandbox.writeTextFile({ path: '.sbx12-owner.json', content: JSON.stringify({ ownerSessionId: session.id, namespace }) });
    return sandbox;
  });
  return { environment, selector };
}
export async function drain() { for (const role of roles) await shutdownSbx(namespaceFor(role)); }
