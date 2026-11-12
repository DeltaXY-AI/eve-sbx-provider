import { defineChannel, POST } from 'eve/channels';
import { drain } from '../lib/sandbox';
export default defineChannel({ routes: [POST('/sbx12/drain', async request => {
  if (request.headers.get('authorization') !== `Bearer ${process.env.SBX12_PASSWORD}`) return new Response('Unauthorized', { status: 401 });
  await drain();
  return Response.json({ drained: true, pid: process.pid, mode: process.env.SBX12_MODE });
})] });
