import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { app,end,shutdownSbx,claimFile } from '../lifecycle/helpers.mjs';
export async function startRace(h){
 const a=app(h.prefix+'-race',h.storage,h.artifact,0);h.apps.push(a);
 const before=await h.inventory();
 const pair=await Promise.all([a.env.start(a.ctx,undefined,a.artifact),a.env.start(a.ctx,undefined,a.artifact)]);
 assert.equal(pair[0].state.name,pair[1].state.name);
 assert.deepEqual((await h.inventory()).filter(n=>!before.includes(n)),[pair[0].state.name]);
 await h.save('duplicate-start.json',{states:pair.map(p=>p.state),newVMs:(await h.inventory()).filter(n=>!before.includes(n))});
 await end(a);await shutdownSbx(a.namespace);
 const cross=app(h.prefix+'-process-race',h.storage,h.artifact,0);h.apps.push(cross);
 const inventory=await h.inventory();const children=await Promise.all([h.child(cross),h.child(cross)]);
 const results=await Promise.all(children.map(c=>c.request('start','started')));
 assert.equal(results[0].state.name,results[1].state.name);
 assert.equal((await readFile(claimFile(h.storage,cross.namespace,cross.ctx.session.id),'utf8')).trim(),results[0].state.name);
 const added=(await h.inventory()).filter(n=>!inventory.includes(n));assert.deepEqual(added,[results[0].state.name]);
 await h.save('process-race.json',{results,newVMs:added});
 await Promise.all(children.map(c=>c.request('shutdown','stopped')));await Promise.all(children.map(c=>c.exited));
 await end(cross);
}
