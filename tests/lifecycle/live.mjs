import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { mkdir,mkdtemp,readdir,readFile,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { app,context,end,shutdownSbx,runSbx,channelDiagnostics } from './helpers.mjs';
import { ownership } from '../ownership/live.mjs';
import { startRace } from '../start-race/live.mjs';
import { restart } from '../restart/live.mjs';
import { cleanupRetry } from '../cleanup-retry/live.mjs';
if(process.env.SBX10_LIVE!=='1'){console.error('Set SBX10_LIVE=1; creates/deletes unique local test resources.');process.exit(2);}
const prefix='sbx10-'+randomBytes(6).toString('hex');
const out=resolve('../../research/sbx-provider/raw/step-10',new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(out,{recursive:true});
const storage=await mkdtemp(join(tmpdir(),prefix+'-'));
const children=[],apps=[],templates=[];
const save=(name,value)=>writeFile(join(out,name),JSON.stringify(value,null,2));
const cli=async args=>{const r=await runSbx(args);assert.equal(r.exitCode,0,r.stderr||r.stdout);return r.stdout;};
const inventory=async()=> (await cli(['ls','-q'])).trim().split(/\r?\n/).filter(Boolean).sort();
// Uptime necessarily advances while another app shuts down; all identity and state fields must match.
const inspect=async names=>Promise.all(names.map(async name=>{const {uptime,...identity}=JSON.parse(await cli(['inspect',name,'--json']));return identity;}));
const claims=async()=>{const dir=join(storage,'docker-sandboxes-claims');return Promise.all((await readdir(dir).catch(()=>[])).map(async file=>({file,name:(await readFile(join(dir,file),'utf8')).trim()})));};
const h={prefix,out,storage,apps,templates,save,cli,inventory,inspect,claims};
h.child=async(a,marker)=>{
 const p=fork(new URL('./child.mjs',import.meta.url),[],{execArgv:[],env:{...process.env,SBX10_CHILD:JSON.stringify({namespace:a.namespace,storage,artifact:a.artifact,poolSize:a.options.poolSize,marker})},stdio:['ignore','pipe','pipe','ipc']});
 const messages=[],waiters=[];let stdout='',stderr='';p.stdout.on('data',d=>stdout+=d);p.stderr.on('data',d=>stderr+=d);
 const exited=new Promise(r=>p.on('exit',(code,signal)=>{void save(`child-${p.pid}.json`,{pid:p.pid,code,signal,messages,stdout,stderr});r({code,signal});}));
 p.on('message',m=>{messages.push(m);for(const w of [...waiters])if(m.type===w.type||m.type==='error'){clearTimeout(w.timer);waiters.splice(waiters.indexOf(w),1);m.type==='error'?w.reject(new Error(m.error)):w.resolve(m);}});
 const wait=type=>{const old=messages.find(m=>m.type===type);if(old)return Promise.resolve(old);return new Promise((resolve,reject)=>{const w={type,resolve,reject};w.timer=setTimeout(()=>reject(new Error(`Child ${p.pid} timed out waiting for ${type}: ${stderr}`)),120000);waiters.push(w);});};
 const child={process:p,exited,request:(message,type)=>{const result=wait(type);p.send(message);return result;}};children.push(child);await wait('waiting');return child;
};
h.prepare=async seed=>{
 const template=`${prefix}-${seed}`;templates.push(`eve-dsb-tpl:${template}`);
 const artifact=await h.a.env.prepare({storagePath:storage,log:console.log,templateKey:()=>template,populate:c=>c.writeFiles({files:[{path:'/workspace/seed',content:Buffer.from(seed)}]})});return artifact;
};
const before=await inventory();await save('inventory-before.json',before);
await save('host.json',{prefix,storage,node:process.version,platform:process.platform,sbx:await cli(['version']),date:new Date().toISOString()});
const checks={};let failure;
try{
 h.a=app(prefix+'-a',storage,{template:'eve-dsb-tpl:pending'},1);apps.push(h.a);
 h.artifact=await h.prepare('old-seed');h.a.artifact=h.artifact;
 // app() creates its pool eagerly; use the prepared template's actual pool instead.
 h.a=app(prefix+'-a',storage,h.artifact,1);apps.push(h.a);
 h.b=app(prefix+'-b',storage,h.artifact,1);apps.push(h.b);
 for(const [name,test] of Object.entries({ownership,startRace,restart,cleanupRetry})){await test(h);await h.verifyB();checks[name]='PASS';await save('checks.json',checks);}
}catch(e){failure=e.stack;process.exitCode=1;console.error(e);}
finally{
 for(const c of children){if(c.process.connected){try{await c.request('shutdown','stopped');await c.exited;}catch(e){failure??=e.stack;}}}
 for(const a of apps){try{await end(a);await shutdownSbx(a.namespace);}catch(e){failure??=e.stack;process.exitCode=1;}}
 // Explicit test teardown only, never provider lifecycle template deletion.
 for(const template of templates){const r=await runSbx(['template','rm','-f',template]);if(r.exitCode!==0&&!r.stderr.includes('not found')){failure??=r.stderr;process.exitCode=1;}}
 const after=await inventory();await save('inventory-after.json',after);
 const channels=await channelDiagnostics();await save('channels-after.json',channels);
 if(JSON.stringify(before)!==JSON.stringify(after)){failure??='Inventory differs; see recorded exact names. No global cleanup attempted.';process.exitCode=1;}
 if(channels.channelCount!==0){failure??='Channels remain after shutdown';process.exitCode=1;}
 await save('summary.json',{status:failure?'FAIL':'PASS',prefix,storage,checks,failure,remainingNewVMs:after.filter(n=>!before.includes(n)),missingPreexistingVMs:before.filter(n=>!after.includes(n))});
 console.log(`SBX-10 ${failure?'FAIL':'PASS'} evidence=${out}`);
}
