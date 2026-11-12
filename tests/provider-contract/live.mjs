import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
let createSbxEnvironment, validateOptions, poolFor, disposePools, runSbx;
let env, lifecycle;

if (process.env.SBX9_LIVE !== '1') {
  console.error('Set SBX9_LIVE=1 to run destructive/local runtime contract tests.'); process.exit(2);
}
const id = randomBytes(6).toString('hex');
const namespace = `sbx9-contract-${id}`;
const out = resolve(process.env.SBX9_EVIDENCE || `../../research/sbx-provider/raw/step-09/${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(out,{recursive:true});
const writeEvidence = (name,value)=>writeFile(join(out,name),typeof value==='string'?value:JSON.stringify(value,null,2));

const tempClaims=await import('node:fs/promises');
const storage=await tempClaims.mkdtemp(join(tmpdir(),'sbx9-claims-'));
const owned=new Map();
const mkctx=(suffix)=>{const ctx={session:{id:`${namespace}-${suffix}-${randomUUID()}`,auth:{current:null,initiator:null},turn:{id:'test',sequence:1}},kind:'session',storagePath:storage,resolveProjectPath:resolve};owned.set(ctx.session.id,ctx);return ctx;};
const run=(connection,command,options={})=>connection.spawn({command,workingDirectory:'/workspace',env:{},...options}).then(async p=>{const [stdout,stderr,done]=await Promise.all([new Response(p.stdout).arrayBuffer(),new Response(p.stderr).arrayBuffer(),p.wait()]);return {stdout:Buffer.from(stdout),stderr:Buffer.from(stderr),...done};});
const cli=async(args)=>{const r=await runSbx(args,undefined,env.sbxPath);assert.equal(r.exitCode,0,r.stderr);return r.stdout;};
const check={};const failureEvidence={};let artifact;const sessions=[];let failure;
try {
 // Pack first, extract only the archive, and load the test-only lifecycle seam from the packed dist.
 // The package root export remains limited to SbxSandbox/SbxSandboxOptions.
 const packDir=join(out,'packed');await mkdir(packDir,{recursive:true});
 const npmCli=process.env.npm_execpath;
 assert.ok(npmCli,'Run the live contract via npm run so npm_execpath is available');
 const pack=await promisify(execFile)(process.execPath,[npmCli,'pack','--pack-destination',packDir],{cwd:resolve('.')});
 const tgz=join(packDir,'deltaxy.ai-eve-sbx-provider-0.1.0.tgz');
 const archive=gunzipSync(await readFile(tgz));let offset=0;const extracted=[];
 while(offset+512<=archive.length){const header=archive.subarray(offset,offset+512);if(header.every(byte=>byte===0))break;
   const name=header.toString('utf8',0,100).replace(/\0.*$/s,'');const prefix=header.toString('utf8',345,500).replace(/\0.*$/s,'');const archived=[prefix,name].filter(Boolean).join('/');const relative=archived.replace(/^package\//,'');
   const size=parseInt(header.toString('utf8',124,136).replace(/\0/g,'').trim(),8)||0;const type=header[156];const target=resolve(packDir,'package',relative);
   assert.ok(target===resolve(packDir,'package')||target.startsWith(resolve(packDir,'package')+sep),'Unsafe tar path');
   offset+=512;if(type===0||type===48){await mkdir(dirname(target),{recursive:true});await writeFile(target,archive.subarray(offset,offset+size));extracted.push(relative);}
   offset+=Math.ceil(size/512)*512;
 }
 await writeEvidence('pack.log',pack.stdout+pack.stderr);await writeEvidence('unpack.log',{extracted});
 const packed=pathToFileURL(join(packDir,'package','dist','internal')+'/');
 ({createSbxEnvironment}=await import(new URL('./sbx-sandbox.js',packed)));
 ({validateOptions}=await import(new URL('./options.js',packed)));
 ({poolFor,disposePools}=await import(new URL('./sbx-pool.js',packed)));
 ({runSbx}=await import(new URL('./sbx-cli.js',packed)));
 env=validateOptions({namespace,poolSize:0,trace:true});
 lifecycle=createSbxEnvironment(env);
 const version=await cli(['--no-input','version']);
 const inventoryBefore=await runSbx(['--no-input','ls','-q'],undefined,env.sbxPath);
 await writeEvidence('inventory-before.txt',inventoryBefore.stdout+inventoryBefore.stderr);
 await writeEvidence('host.json',{date:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,sbx:version.trim(),namespace,poolSize:0});
 artifact=await lifecycle.prepare({files:{},isEmpty:false,storagePath:storage,log:console.log,resolveProjectPath:resolve,templateKey:()=>`sbx9-${id}`,resourcesDirectory:async()=>undefined,populate:async c=>c.writeFiles({files:[{path:'/workspace/contract-seed.txt',content:Buffer.from('SBX9_TEMPLATE_SEED\n')} ]})});
 await writeEvidence('template.json',artifact);
 const ctx=mkctx('contract');const {connection,state}=await lifecycle.start(ctx,undefined,artifact);sessions.push([ctx,state]);
 await writeEvidence('primary-vm.json',{sessionId:ctx.session.id,vm:state.name,inspect:JSON.parse(await cli(['--no-input','inspect',state.name,'--json']))});
 const result=await run(connection,'printf "out:%s\\n" "$PWD"; printf "err:%s\\n" "$AI_AGENT" >&2; exit 7',{workingDirectory:'/workspace',env:{AI_AGENT:'per-command'}});
 assert.equal(result.stdout.toString(),'out:/workspace\n');assert.equal(result.stderr.toString(),'err:per-command\n');assert.equal(result.exitCode,7);check['stdout-stderr-exit-cwd-env']='PASS';
 const defaultAgent=await run(connection,'printf %s "$AI_AGENT"');assert.equal(defaultAgent.stdout.toString(),'eve');const override=await run(connection,'printf %s "$AI_AGENT"',{env:{AI_AGENT:'override'}});assert.equal(override.stdout.toString(),'override');check.ai_agent='PASS';
 const cwd=await run(connection,'pwd',{workingDirectory:'/tmp'});assert.equal(cwd.stdout.toString(),'/tmp\n');
 const stdin=await connection.spawn({command:'cat',workingDirectory:'/workspace',env:{},stdin:true});const stdout=new Response(stdin.stdout).arrayBuffer();const stderr=new Response(stdin.stderr).arrayBuffer();const writer=stdin.stdin.getWriter();await writer.write(Buffer.from('stdin-marker'));await writer.close();const done=await stdin.wait();assert.equal(Buffer.from(await stdout).toString(),'stdin-marker');assert.equal(Buffer.from(await stderr).length,0);assert.equal(done.exitCode,0);check.stdin_eof='PASS';
 const binary=randomBytes(256*1024);await connection.writeFiles({files:[{path:'/workspace/nested/a.bin',content:binary}]});assert.deepEqual(Buffer.from(await connection.readFile({path:'/workspace/nested/a.bin'})),binary);assert.equal(await connection.readFile({path:'/workspace/no-such-file'}),null);await assert.rejects(()=>connection.readFile({path:'/workspace'}));
 await connection.writeFiles({files:[{path:'/workspace/nested/a.bin',content:Buffer.from('overwritten')}]});assert.equal(Buffer.from(await connection.readFile({path:'/workspace/nested/a.bin'})).toString(),'overwritten');
 await connection.writeFiles({files:[{path:'/workspace/private/f',content:Buffer.from('x')}]});assert.equal((await run(connection,'chmod 000 /workspace/private')).exitCode,0);await assert.rejects(()=>connection.readFile({path:'/workspace/private/f'}));await run(connection,'chmod 700 /workspace/private');
 await assert.rejects(()=>connection.removePath({path:'/workspace/no-such-file'}));await connection.removePath({path:'/workspace/no-such-file',force:true});await assert.rejects(()=>connection.removePath({path:'/workspace/nested'}));await connection.removePath({path:'/workspace/nested',recursive:true});assert.equal(await connection.readFile({path:'/workspace/nested/a.bin'}),null);check.files='PASS';
 const jobs=Array.from({length:20},(_,i)=>run(connection,`printf 'OUT-${id}-${i}\\n'; printf 'ERR-${id}-${i}\\n' >&2; exit ${i%5}`));const parallel=await Promise.all(jobs);for(let i=0;i<20;i++)assert.deepEqual({stdout:parallel[i].stdout.toString(),stderr:parallel[i].stderr.toString(),exitCode:parallel[i].exitCode},{stdout:`OUT-${id}-${i}\n`,stderr:`ERR-${id}-${i}\n`,exitCode:i%5});await writeEvidence('parallel-20.json',parallel.map((r,i)=>({i,stdout:r.stdout.toString(),stderr:r.stderr.toString(),exitCode:r.exitCode})));check.parallel20='PASS';
 const controller=new AbortController();const p=await connection.spawn({command:'sleep 303 & sleep 304 & echo READY; wait',workingDirectory:'/workspace',env:{},signal:controller.signal});const r=p.stdout.getReader();assert.equal(Buffer.from((await r.read()).value).toString(),'READY\n');const drain=(async()=>{while(!(await r.read()).done){}})();const errors=new Response(p.stderr).arrayBuffer();const abortStarted=Date.now();controller.abort();await assert.rejects(()=>p.wait());await Promise.all([drain,errors]);assert.ok(Date.now()-abortStarted<5000,'Abort must settle within five seconds');const children=await run(connection,"pgrep -f 'sleep 30[34]'");assert.equal(children.exitCode,1,children.stdout.toString()+children.stderr.toString());check.abort='PASS';
 await connection.writeFiles({files:[{path:'/workspace/keep.txt',content:Buffer.from('keep-after-stop')}]});await connection.stop();await connection.stop();const stopped=JSON.parse(await cli(['--no-input','inspect',state.name,'--json']));assert.equal(stopped.state,'stopped');const resumed=await lifecycle.resume(ctx,artifact,state);assert.equal(Buffer.from(await resumed.readFile({path:'/workspace/keep.txt'})).toString(),'keep-after-stop');check.stop_resume='PASS';
 const gone=mkctx('gone');const created=await lifecycle.start(gone,undefined,artifact);await cli(['--no-input','rm','-f',created.state.name]);await assert.rejects(()=>lifecycle.resume(gone,artifact,created.state),e=>{failureEvidence.missing_vm={name:e?.name,message:e?.message};return e?.name==='SandboxSessionGoneError'});await lifecycle.onSessionEnd(gone,created.state,{reason:'completed'});check.missing_vm='PASS';
 const invalid=mkctx('invalid');await assert.rejects(()=>lifecycle.resume(invalid,artifact,{name:'not-a-provider-vm'}),e=>{failureEvidence.invalid_state={name:e?.name,message:e?.message};return /Invalid docker-sandboxes session state/.test(e?.message||'')});check.invalid_state='PASS';
 // Five concurrent sessions use pool zero to avoid adding warm-pool VMs to the bounded five-VM workload.
 const smallOptions=validateOptions({namespace:`${namespace}-small`,poolSize:0,trace:true});
 const small=createSbxEnvironment(smallOptions);const parallelSessions=Array.from({length:5},(_,i)=>mkctx(`small-${i}`));
 const startSamples=[];
 const started=await Promise.all(parallelSessions.map(async(ctx,i)=>{const t=performance.now();const value=await small.start(ctx,undefined,artifact);startSamples.push({sessionId:ctx.session.id,vm:value.state.name,ms:performance.now()-t});sessions.push([ctx,value.state,small]);return {...value,ctx,i}}));
 assert.equal(new Set(started.map(x=>x.state.name)).size,5,'Five sessions must have distinct VMs');
 await Promise.all(started.map(async({connection,i})=>{
   const files=Array.from({length:20},(_,j)=>({path:`/workspace/sbx9/${i}/file-${j}.txt`,content:Buffer.from(`session=${i};file=${j};marker=${id}\n`)}));
   await connection.writeFiles({files});
   const search=await run(connection,`grep -R -nF 'marker=${id}' /workspace/sbx9/${i}`);assert.equal(search.exitCode,0);assert.equal(search.stdout.toString().trim().split('\n').length,20);
   for(let j=0;j<20;j++)assert.equal(Buffer.from(await connection.readFile({path:`/workspace/sbx9/${i}/file-${j}.txt`})).toString(),`session=${i};file=${j};marker=${id}\n`);
 }));
 for(const s of started)await small.onSessionEnd(s.ctx,s.state,{reason:'completed'});
 for(const s of started){const ls=await runSbx(['--no-input','inspect',s.state.name,'--json'],undefined,env.sbxPath);assert.notEqual(ls.exitCode,0,`VM still exists: ${s.state.name}`);}
 await writeEvidence('five-session-mapping.json',startSamples);check.five_sessions='PASS';
 // Pool-size-two readiness, warm assignment, replenishment, and command latency are measured independently.
 const poolOptions=validateOptions({namespace:`${namespace}-pool`,poolSize:2,trace:true});const pooled=createSbxEnvironment(poolOptions);
 const readyPool=poolFor(artifact.template,poolOptions);readyPool.fill();
 const waitPool=async target=>{const deadline=Date.now()+60000;while(Date.now()<deadline){if(readyPool.diagnostics().ready.length>=target)return;await new Promise(r=>setTimeout(r,50));}throw new Error(`Pool did not reach ${target} ready VMs: ${JSON.stringify(readyPool.diagnostics())}`)};
 await waitPool(2);
 const warmCtx=mkctx('latency-warm');const tWarm=performance.now();const warm=await pooled.start(warmCtx,undefined,artifact);const warmMs=performance.now()-tWarm;sessions.push([warmCtx,warm.state,pooled]);
 await waitPool(2);assert.equal(readyPool.diagnostics().ready.length,2,'Pool must replenish to two after assignment');check.pool2_replenished='PASS';
 await writeEvidence('pool-two-after-take.json',readyPool.diagnostics());
 const commandSamples=[];for(let n=0;n<25;n++){const t=performance.now();const r=await run(warm.connection,'true');commandSamples.push(performance.now()-t);assert.equal(r.exitCode,0);}
 assert.ok(warmMs<200,`Ready-pool assignment latency ${warmMs.toFixed(2)}ms misses 200ms target`);const sorted=[...commandSamples].sort((a,b)=>a-b);const commandMedian=sorted[Math.floor(sorted.length/2)];assert.ok(commandMedian<100,`Trivial command median ${commandMedian.toFixed(2)}ms misses 100ms target`);
 await writeEvidence('latency-warm.json',{poolSize:2,assignmentMs:warmMs,commandSamplesMs:commandSamples,commandMedianMs:commandMedian,targetsMs:{assignment:200,command:100}});check.latency_warm='PASS';
 await pooled.onSessionEnd(warmCtx,warm.state,{reason:'completed'});sessions.splice(sessions.findIndex(([c])=>c.session.id===warmCtx.session.id),1);
 // poolSize=0 cold-start cohort, cached image. No timing threshold is claimed for a cold create.
 const coldEnv=validateOptions({namespace:`${namespace}-cold`,poolSize:0,trace:true});const coldLifecycle=createSbxEnvironment(coldEnv);const coldSamples=[];
 for(let n=0;n<5;n++){const c=mkctx(`cold-${n}`);const t=performance.now();const opened=await coldLifecycle.start(c,undefined,artifact);coldSamples.push(performance.now()-t);await coldLifecycle.onSessionEnd(c,opened.state,{reason:'completed'});}
 await writeEvidence('latency-cold.json',{poolSize:0,samplesMs:coldSamples,medianMs:[...coldSamples].sort((a,b)=>a-b)[Math.floor(coldSamples.length/2)],note:'Cached-template cold VM creation; no acceptance threshold specified.'});
 // Remove only this run's uniquely tagged template after every VM using it is gone.
 for(const [session,state,owner] of sessions){await (owner||lifecycle).onSessionEnd(session,state,{reason:'completed'});}sessions.length=0;
 const removed=await runSbx(['--no-input','template','rm','-f',artifact.template],undefined,env.sbxPath);assert.equal(removed.exitCode,0,removed.stderr);
 const missing=mkctx('missing-template');await assert.rejects(()=>lifecycle.start(missing,undefined,artifact),e=>{failureEvidence.missing_template={name:e?.name,message:e?.message};return e?.name==='SandboxTemplateNotProvisionedError'});check.missing_template='PASS-no-rebuild';
 // Pool-size assertions are scoped to a unique template and namespace. Verify zero is empty; pool-two refill events are traced.
 const zero=poolFor(artifact.template,env);zero.fill();assert.deepEqual(zero.diagnostics().ready,[]);assert.equal(zero.diagnostics().target,0);check.pool0='PASS-no-ready-vms';
 await disposePools(`${namespace}-small`);await disposePools(`${namespace}-pool`);await disposePools(`${namespace}-cold`);
 const inventoryAfter=await runSbx(['--no-input','ls','-q'],undefined,env.sbxPath);await writeEvidence('inventory-after.txt',inventoryAfter.stdout+inventoryAfter.stderr);
 await writeEvidence('checks.json',check);await writeEvidence('failures.json',failureEvidence);await writeEvidence('pool-zero.json',zero.diagnostics());
} catch(e){failure=e.stack||String(e);process.exitCode=1;console.error(failure)} finally {
 for(const [ctx,state,owner] of sessions){try{await (owner||lifecycle).onSessionEnd(ctx,state,{reason:'failed'});}catch{}}
 for(const ownedNamespace of [namespace,`${namespace}-small`,`${namespace}-pool`,`${namespace}-cold`]){try{await disposePools(ownedNamespace)}catch(e){failure??=String(e);process.exitCode=1}}
 if(artifact&&runSbx){try{const r=await runSbx(['--no-input','template','rm','-f',artifact.template],undefined,env.sbxPath);if(r.exitCode!==0&&!r.stderr.includes('not found'))throw new Error(r.stderr||r.stdout);}catch(e){failure??=String(e);process.exitCode=1}}
 if(runSbx){try{const r=await runSbx(['--no-input','ls','-q'],undefined,env.sbxPath);await writeEvidence('inventory-after-finally.txt',r.stdout+r.stderr)}catch{}}
 await writeEvidence('summary.json',{status:failure?'FAIL':'PASS',checks:check,failure,namespace,note:'Scoped to this live provider-contract run; inspect inventory before/after. Warm-pool cleanup is namespace-scoped.'});
 console.log(`SBX-9 provider-contract ${failure?'FAIL':'PASS'} evidence=${out}`);
}
