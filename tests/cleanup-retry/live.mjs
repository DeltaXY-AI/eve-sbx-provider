import assert from 'node:assert/strict';
import { app,end,ready,text,marker,sleep,shutdownSbx } from '../lifecycle/helpers.mjs';
export async function cleanupRetry(h){
 const never=app(h.prefix+'-never',h.storage,h.artifact,0);h.apps.push(never);
 const before=await h.inventory();await end(never);await end(never);assert.deepEqual(await h.inventory(),before);
 const a=app(h.prefix+'-build',h.storage,h.artifact,0);h.apps.push(a);
 const old=await a.env.start(a.ctx,undefined,h.artifact);await marker(old.connection,'old-session-file');
 const artifact=await h.prepare('new-seed');
 const existing=await a.env.start(a.ctx,undefined,artifact);assert.equal(existing.state.name,old.state.name);assert.equal(await text(existing.connection),'old-session-file');assert.equal(await text(existing.connection,'/workspace/seed'),'old-seed');
 const fresh={...a.ctx,session:{id:'new-build-session'}};const created=await a.env.start(fresh,undefined,artifact);
 assert.equal(await text(created.connection,'/workspace/seed'),'new-seed');
 await h.save('build-change.json',{oldArtifact:h.artifact,newArtifact:artifact,oldState:old.state,existingState:existing.state,newState:created.state,oldSeed:await text(existing.connection,'/workspace/seed'),newSeed:await text(created.connection,'/workspace/seed')});
 await a.env.onSessionEnd(fresh,null,{reason:'completed'});await a.env.onSessionEnd(fresh,null,{reason:'completed'});
 // A missing template causes background creates to fail. Make that exact image
 // available later, without replacing the pool or manually calling fill again.
 const retryArtifact={template:`eve-dsb-tpl:${h.prefix}-retry`};h.templates.push(retryArtifact.template);
 const retry=app(h.prefix+'-retry',h.storage,retryArtifact,1);h.apps.push(retry);
 const events=[];const original=console.error;console.error=(line,...rest)=>{try{const e=JSON.parse(line);if(e.template===retryArtifact.template)events.push({...e,time:Date.now()});}catch{}original(line,...rest);};
 const unhandled=[];const listener=e=>unhandled.push(String(e));process.on('unhandledRejection',listener);
 try{
  retry.pool.fill();
  const deadline=Date.now()+30000;
  while(events.filter(e=>e.event==='pool.error').length<2 && Date.now()<deadline)await sleep(50);
  const errors=events.filter(e=>e.event==='pool.error');assert.equal(errors.length,2,JSON.stringify(events));
  const retryStart=events.find(e=>e.event==='create.begin' && e.time>errors[0].time);
  assert.ok(retryStart && retryStart.time-errors[0].time>=1900 && retryStart.time-errors[0].time<5000,'Retry starts after bounded 2s delay (excluding CLI create/cleanup duration)');
  await old.connection.stop();await h.cli(['template','save',old.state.name,retryArtifact.template]);
  await ready(retry.pool);assert.equal(unhandled.length,0);
  await h.save('cleanup-retry.json',{neverOpened:'PASS',nullAndRepeated:'PASS',events,unhandled,filled:retry.pool.diagnostics()});
 }finally{console.error=original;process.off('unhandledRejection',listener);await shutdownSbx(retry.namespace);}
 await end(a);await end(a);
}
