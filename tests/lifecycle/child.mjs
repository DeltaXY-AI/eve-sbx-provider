import { app, ready, marker, text, shutdownSbx, channelDiagnostics } from './helpers.mjs';
const config=JSON.parse(process.env.SBX10_CHILD);
const a=app(config.namespace,config.storage,config.artifact,config.poolSize);
let opened;
process.on('message',async message=>{
 try {
  if(message==='start'){
   opened=await a.env.start(a.ctx,undefined,a.artifact);
   if(config.marker)await marker(opened.connection,config.marker);
   await ready(a.pool);
   process.send({type:'started',pid:process.pid,state:opened.state,pool:a.pool.diagnostics(),marker:await text(opened.connection)});
  } else if(message==='shutdown') {
   await shutdownSbx(a.namespace);const channels=await channelDiagnostics();if(channels.channelCount!==0)throw new Error('Shutdown left channels open');process.send({type:'stopped',channels});process.disconnect();
  }
 } catch(error){process.send({type:'error',error:error.stack});process.exitCode=1;process.disconnect();}
});
process.send({type:'waiting',pid:process.pid});
