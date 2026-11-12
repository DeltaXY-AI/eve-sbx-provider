import { defineChannel, POST } from 'eve/channels';
import { shutdownSbx } from '@deltaxy.ai/eve-sbx-provider';

// Test-only, authenticated operator endpoint. The supervisor quiesces requests
// first, drains provider resources here, then asks Nitro to shut down over IPC.
export default defineChannel({
  routes: [POST('/sbx10/drain', async request => {
    if (request.headers.get('authorization') !== `Bearer ${process.env.SBX10_PASSWORD}`) {
      return new Response('Unauthorized', { status: 401 });
    }
    await shutdownSbx(process.env.SBX10_NAMESPACE!);
    return Response.json({ drained: true, app: process.env.SBX10_APP, pid: process.pid });
  })],
});
