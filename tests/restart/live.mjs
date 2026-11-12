import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { app,end,text,claimFile } from '../lifecycle/helpers.mjs';
export async function restart(h){
 const a=app(h.prefix+'-restart',h.storage,h.artifact,1);h.apps.push(a);
 const b=h.b;const bBefore=await h.inspect([b.opened.state.name,...b.pool.diagnostics().ready]);
 const child=await h.child(a,'survives-hard-kill');const first=await child.request('start','started');
 await h.save('restart-before-kill.json',{...first,b:bBefore,inventory:await h.inventory()});
 child.process.kill('SIGKILL');await child.exited;
 const oldReady=first.pool.ready;
 // Restart a real runner under the same namespace/storage. start() reconnects from claim.
 const second=await h.child(a);const resumed=await second.request('start','started');
 assert.equal(resumed.state.name,first.state.name);assert.equal(resumed.marker,'survives-hard-kill');
 for(const name of oldReady)assert.ok((await h.inventory()).includes(name),'startup must not sweep crash leftovers');
 assert.deepEqual(await h.inspect([b.opened.state.name,...b.pool.diagnostics().ready]),bBefore);
 await h.verifyB();
 await h.save('restart-after.json',{...resumed,oldReady,claim:await readFile(claimFile(h.storage,a.namespace,a.ctx.session.id),'utf8'),inventory:await h.inventory()});
 await second.request('shutdown','stopped');await second.exited;
 for(const name of resumed.pool.ready)assert.ok(!(await h.inventory()).includes(name));
 assert.ok((await h.inventory()).includes(first.state.name),'graceful shutdown retains claimed VM');
 // Exact scoped manual procedure: only names recorded as ready by the killed owner,
 // after quiescing its namespace; compare each against every persisted claim first.
 const commands=[];
 for(const name of oldReady){
  assert.notEqual(name,first.state.name);assert.notEqual(name,b.opened.state.name);
  const claims=await h.claims();assert.ok(!claims.some(c=>c.name===name));
  await h.cli(['inspect',name,'--json']);
  commands.push(`sbx --no-input inspect ${name} --json`,`sbx --no-input rm -f ${name}`);
  await h.cli(['rm','-f',name]);
 }
 const active=await a.env.resume(a.ctx,h.artifact,first.state);assert.equal(await text(active),'survives-hard-kill');
 assert.deepEqual(await h.inspect([b.opened.state.name,...b.pool.diagnostics().ready]),bBefore);
 await h.verifyB();
 await h.save('manual-cleanup.json',{killedOwnerPid:first.pid,knownUnclaimed:oldReady,commands,remaining:await h.inventory(),activeMarker:await text(active),bMarker:await text(b.opened.connection)});
 await end(a);
}
