// Isolated, repeatable transport/load test. Works on Linux and macOS; never uses a running public match.
// --transport wt starts the server with KR_WT=1 and has every player bind a WebTransport session (sockets.mts) instead of
// the second WebSocket, so the two transports' server CPU, tick and tails compare at the same 50-player load.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const args=process.argv.slice(2),value=(k,d)=>{const i=args.indexOf(k);return i<0?d:args[i+1];};
// A short real warm-up: the match then flies its plane and sockets.mts times the PLAY phase that follows.
const transport=value('--transport','ws')==='wt'?'wt':'ws';
const warmupS=5,seconds=+value('--seconds','60'),out=path.resolve(value('--out',transport==='wt'?'reports/performance/sockets-final-wt.json':'reports/performance/sockets-final.json'));
if(!Number.isFinite(seconds)||seconds<10)throw Error('--seconds must be at least 10');
if(!fs.existsSync(path.join(root,'dist/index.html')))throw Error('Run npm run build first');
fs.mkdirSync(path.dirname(out),{recursive:true});
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const log=fs.openSync(out.replace(/\.json$/,'')+'.server.log','w');
const runner=path.join(root,'node_modules/.bin/tsx');
const server=spawn(runner,['server/index.ts'],{cwd:root,env:{...process.env,KR_HOST:'127.0.0.1',KR_PORT:String(port),KR_SERVE:'1',KR_PERF_METRICS:'1',KR_EVENT_MODE:'0',KR_WARMUP_S:String(warmupS),...(transport==='wt'?{KR_WT:'1'}:{})},stdio:['ignore',log,log]});
let failure;server.on('error',e=>{failure=e;});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const stop=()=>server.kill('SIGTERM');process.on('SIGINT',stop);process.on('SIGTERM',stop);
try{
  const url=`http://127.0.0.1:${port}`,deadline=Date.now()+60000;
  for(;;){
    if(failure)throw failure;
    if(server.exitCode!==null)throw Error('Server exited; inspect '+out+'.server.log');
    try{if((await fetch(url+'/health',{signal:AbortSignal.timeout(1000)})).ok)break;}catch{}
    if(Date.now()>deadline)throw Error('Server startup timed out');await sleep(200);
  }
  const child=spawn(runner,['tools/performance/sockets.mts','--url',url,'--players','50','--seconds',String(seconds),...(transport==='wt'?['--transport','wt']:['--aux']),'--assets','--warmup-s',String(warmupS),'--out',out],{cwd:root,stdio:'inherit'});
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
  if(code!==0)process.exitCode=code||1;
}finally{
  stop();await Promise.race([new Promise(r=>server.once('exit',r)),sleep(3000)]);if(server.exitCode===null)server.kill('SIGKILL');fs.closeSync(log);
}
