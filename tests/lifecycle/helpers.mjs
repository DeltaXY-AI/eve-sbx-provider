import assert from 'node:assert/strict';
import { createSbxEnvironment } from '../../dist/internal/sbx-sandbox.js';
import { validateOptions } from '../../dist/internal/options.js';
import { poolFor } from '../../dist/internal/sbx-pool.js';
export { shutdownSbx } from '../../dist/index.js';
export { claimFile } from '../../dist/internal/sbx-claims.js';
export { channelDiagnostics } from '../../dist/internal/sbx-channel.js';
export { runSbx } from '../../dist/internal/sbx-cli.js';
export const sleep = ms => new Promise(r=>setTimeout(r,ms));
export const context = (storagePath,id='identical-session') => ({storagePath,session:{id},kind:'session'});
export function app(namespace,storagePath,artifact,poolSize=1) {
 const options=validateOptions({namespace,poolSize,trace:true});
 const env=createSbxEnvironment(options),ctx=context(storagePath),pool=poolFor(artifact.template,options);
 return {namespace,options,env,ctx,pool,artifact};
}
export async function ready(pool) {
 const deadline=Date.now()+90000;
 while(Date.now()<deadline){if(pool.diagnostics().ready.length===pool.size && pool.diagnostics().pending===0)return pool.diagnostics();await sleep(50);}
 assert.fail(`Pool not ready: ${JSON.stringify(pool.diagnostics())}`);
}
export const text=async(connection,path='/workspace/marker')=>Buffer.from(await connection.readFile({path})||[]).toString();
export const marker=(connection,value)=>connection.writeFiles({files:[{path:'/workspace/marker',content:Buffer.from(value)}]});
export const end=(a,state=null)=>a.env.onSessionEnd(a.ctx,state,{reason:'completed'});
