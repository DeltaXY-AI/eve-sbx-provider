import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { getChannel } from '../../dist/internal/sbx-channel.js';
import { ready,marker,text,end,shutdownSbx,claimFile,channelDiagnostics } from '../lifecycle/helpers.mjs';
export async function ownership(h){
 const a=h.a,b=h.b;
 for(const x of [a,b]){x.opened=await x.env.start(x.ctx,undefined,x.artifact);await marker(x.opened.connection,x.namespace);await ready(x.pool);}
 const readyChannels=await Promise.all(b.pool.diagnostics().ready.map(name=>getChannel(name)));
 for(const c of readyChannels)await c.request({op:'write',files:[{path:'/workspace/pool-marker',d:Buffer.from(b.namespace+'-ready').toString('base64')}]});
 const readyMarkers=()=>Promise.all(readyChannels.map(async c=>Buffer.from((await c.request({op:'read',path:'/workspace/pool-marker'})).d,'base64').toString()));
 const snapshot=async()=>({readyMarkers:await readyMarkers(),state:b.opened.state,claim:await readFile(claimFile(h.storage,b.namespace,b.ctx.session.id),'utf8'),pool:b.pool.diagnostics(),marker:await text(b.opened.connection),identities:await h.inspect([b.opened.state.name,...b.pool.diagnostics().ready])});
 const before=await snapshot();h.verifyB=async()=>assert.deepEqual(await snapshot(),before);await h.save('ownership-before.json',{a:{namespace:a.namespace,state:a.opened.state,pool:a.pool.diagnostics()},b:before});
 await end(a);await end(a);await shutdownSbx(a.namespace);
 assert.deepEqual(await snapshot(),before);
 const channels=await channelDiagnostics();assert.ok(!channels.channels.some(c=>c.name===a.opened.state.name));
 // Neither a foreign namespace state nor a poisoned claim can authorize deletion.
 await assert.rejects(()=>end(a,b.opened.state),/Invalid/);
 const file=claimFile(h.storage,a.namespace,a.ctx.session.id);
 await writeFile(file,b.opened.state.name);await assert.rejects(()=>end(a),/Invalid/);
 const {rm}=await import('node:fs/promises');await rm(file);
 assert.deepEqual(await snapshot(),before);await h.save('ownership-after.json',{b:await snapshot(),channels});
}
