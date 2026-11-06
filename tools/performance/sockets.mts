// Real WebSocket load; launch a PRIVATE test server, then pass --url http://127.0.0.1:5795. Writes a kong-perf-result
// (schema.ts). No public-server traffic unless the operator explicitly points this command there.
// The players drive inputs through the match's real warm-up and plane; the timed window starts when snapshots report
// the PLAY phase, so --seconds measures ground play, not the warm-up islet. --max-setup-s bounds the wait for PLAY.
// Tails follow netlab's definitions: pings go out on both sockets and the first pong counts; input→ack samples every
// input the first time a snapshot acknowledges it. The generator never stops sending inputs once seated (the /health
// reads keep the loop driving), and a loop gap over GEN_GAP_MAX_MS fails the run as invalid, not as a server stall.
import { WebSocket } from 'ws';
import { Writer, M, writeInput, Reader, readSnapHeader, type SnapHeader } from '../../shared/net/proto';
import { makeInput, B } from '../../shared/sim/player';
import { arg,env,save,source,stats } from './common.mts';
import { RESULT_SCHEMA, RESULT_VERSION, type Metric, type RunResult } from './schema.ts';
const base=arg('--url','http://127.0.0.1:5795'),count=+arg('--players','50'),seconds=+arg('--seconds','25'),aux=process.argv.includes('--aux'),assets=process.argv.includes('--assets');
const maxSetupS=+arg('--max-setup-s','120'),warmupS=arg('--warmup-s','server default'),out=arg('--out','reports/performance/sockets.json');
const PLAY=2, TICK_HZ=60, GEN_GAP_MAX_MS=50;
const startedAt=new Date().toISOString(),run0=performance.now(),environment=env();
const sleep=(n:number)=>new Promise(r=>setTimeout(r,n)),peers:any[]=[],errors:string[]=[],rtt:number[]=[],gaps:number[]=[],ack:number[]=[],loopGaps:number[]=[];
let bytes=0,packets=0,matchSeed=-1,aliveDrops=0,active=false,disconnects=0,phase=-1,alive=0,firstTick=-1,lastTick=-1,inputsSent=0,skippedSteps=0;
const phaseSeen:Record<number,number>={};
const wait=async(f:()=>boolean,label:string,ms=60000)=>{const end=performance.now()+ms;while(!f()){if(performance.now()>end)throw Error('timeout '+label);await sleep(10);}};
try{
  for(let i=0;i<count;i++){
    const p:any={ws:new WebSocket(base.replace(/^http/,'ws')+'/ws'),uid:0,token:'',code:'',pid:-1,seq:0,last:0,lastTick:-1,w:new Writer(new ArrayBuffer(64)),input:makeInput(),sent:new Float64Array(4096),snaps:0,acked:0,lastPong:0};peers.push(p);
    const onMessage=(data:any,binary:boolean)=>{
      if(active){bytes+=data.length;packets++;}
      if(!binary){const j=JSON.parse(String(data));if(j.t==='welcome'){p.uid=j.uid;p.token=j.aux;}if(j.t==='lobby')p.code=j.code;if(j.t==='match'){p.pid=j.pids[p.uid];matchSeed=j.seed;}if(j.t==='error')errors.push(j.msg);return;}
      const r=new Reader(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));const kind=r.u8(),now=performance.now();
      // The main and aux sockets both carry snapshots: only the first copy of each tick counts, stale copies are dropped.
      if(kind===M.Snapshot){const h={} as SnapHeader;readSnapHeader(r,h);if(h.tick<=p.lastTick)return;p.lastTick=h.tick;
        if(p===peers[0]){if(active&&h.alive<alive)aliveDrops+=alive-h.alive;phase=h.phase;alive=h.alive;if(active){phaseSeen[h.phase]=(phaseSeen[h.phase]??0)+1;if(firstTick<0)firstTick=h.tick;lastTick=h.tick;}}
        const acked=p.acked;if(h.lastSeq>acked)p.acked=h.lastSeq;
        if(!active)return;
        // lastSeq is cumulative and inputs run at 60 Hz, snapshots at 30: sample every input it acknowledges for the first time
        p.snaps++;if(p.last)gaps.push(now-p.last);p.last=now;for(let q=Math.max(acked+1,h.lastSeq-4095);q<=h.lastSeq;q++){const at=p.sent[q%4096];if(at)ack.push(now-at);}return;}
      if(kind===M.Pong){const sent=r.f64();if(sent>p.lastPong){p.lastPong=sent;if(active)rtt.push(now-sent);}}
    };
    p.ws.on('message',onMessage);p.ws.on('error',(e:Error)=>errors.push(e.message));p.ws.on('close',()=>{if(active)disconnects++;});
    await wait(()=>!!p.uid,'welcome');p.ws.send(JSON.stringify({t:'hello',name:'BENCH '+i}));
    if(aux){p.aux=new WebSocket(base.replace(/^http/,'ws')+'/ws?attach=1');p.aux.on('open',()=>p.aux.send(JSON.stringify({t:'aux',token:p.token})));p.aux.on('message',onMessage);p.aux.on('error',(e:Error)=>errors.push(e.message));p.aux.on('close',()=>{if(active)disconnects++;});await wait(()=>p.aux.readyState===WebSocket.OPEN,'aux');}
    p.ws.send(JSON.stringify(i===0?{t:'create',mode:'trios'}:{t:'join',code:peers[0].code}));await wait(()=>!!p.code,'join');
  }
  peers[0].ws.send('{"t":"start"}');await wait(()=>peers.every(p=>p.pid>=0),count+' seats');
  // One input per 60 Hz step per player, like a client; skipped steps (a late loop) are counted, not hidden.
  let lastStep=-1,lastLoop=0,lastPing=0,assetRequest:Promise<any>|null=null;
  const httpResults:any[]=[],clock0=performance.now();
  const drive=(now:number)=>{
    if(active&&lastLoop)loopGaps.push(now-lastLoop);lastLoop=now;
    const tick=Math.floor((now-clock0)*TICK_HZ/1000);
    if(tick!==lastStep){if(active&&lastStep>=0)skippedSteps+=tick-lastStep-1;lastStep=tick;for(const p of peers){p.input.seq=++p.seq;p.input.mx=Math.sin((tick+p.pid)*.05)*.5;p.input.mz=.8;p.input.yaw=tick*.015+p.pid;p.input.buttons=tick%120<40?B.FIRE:tick%90<20?B.JUMP:0;p.sent[p.seq%4096]=now;writeInput(p.w.reset(),p.input);const data=Buffer.from(p.w.view());p.ws.send(data);p.aux?.send(data);if(active)inputsSent++;}}
    if(now-lastPing>=250){lastPing=now;for(const p of peers){p.w.reset().u8(M.Ping).f64(performance.now());const data=Buffer.from(p.w.view());p.ws.send(data);p.aux?.send(data);}}
  };
  const setup0=performance.now();
  while(phase!==PLAY){if(performance.now()-setup0>maxSetupS*1000)throw Error(`no PLAY phase within ${maxSetupS} s (last phase ${phase}); is KR_WARMUP_S huge?`);drive(performance.now());await sleep(2);}
  // keep driving while /health answers: awaiting it here sent no inputs for 2-4 RTTs and read as a server stall
  const setupMs=performance.now()-setup0;let health0:any=null;fetch(base+'/health').then(r=>r.json()).then(j=>{health0=j;},e=>errors.push(String(e)));
  while(health0===null){if(errors.length)throw Error(errors[0]);drive(performance.now());await sleep(2);}
  active=true;const start=performance.now(),aliveAtStart=alive;
  while(performance.now()-start<seconds*1000){
    const now=performance.now();drive(now);
    // Asset-serving contention is part of a real match: a player joins while others are already fighting.
    if(assets&&!assetRequest&&now-start>4000){assetRequest=(async()=>{const html=await(await fetch(base)).text(),urls=[...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+\.(?:js|css))"/g)].map(m=>m[1]);for(const url of urls.slice(0,12)){const t=performance.now();const r=await fetch(base+url,{headers:{'accept-encoding':'br'}});await r.arrayBuffer();httpResults.push({url,ms:performance.now()-t,status:r.status,encoding:r.headers.get('content-encoding')});}})();}
    await sleep(2);
  }
  // the window's last stretch: a pause after the final drive() would otherwise never enter loopGaps
  const end=performance.now();loopGaps.push(end-lastLoop);const elapsed=end-start;active=false;
  const health=await(await fetch(base+'/health')).json();await assetRequest;
  const perf0=(health0 as any).performance,perf1=(health as any).performance;
  const s=elapsed/1000,ms=(v:number[]):Metric=>({status:'ok',unit:'ms',better:'lower',summary:stats(v)});
  let loopGapMax=0;for(const g of loopGaps)if(g>loopGapMax)loopGapMax=g;
  const minSnapshots=Math.min(...peers.map(p=>p.snaps)),serverTicksPerSecond=(lastTick-firstTick)/s,inputsPerPlayerSecond=inputsSent/count/s;
  const lifetime=(m:any):Metric=>perf1?{status:'ok',unit:'ms',better:'lower',summary:m}:{status:'unsupported',unit:'ms',reason:'server runs without KR_PERF_METRICS=1'};
  const result:RunResult={schema:RESULT_SCHEMA,version:RESULT_VERSION,tool:'bench:server',startedAt,durationMs:performance.now()-run0,source:source(process.cwd()),environment,
    config:{players:count,seconds,aux,assets,mode:'trios',warmupS},
    cases:[{
      scenario:{id:'server/trios-play',version:3,seed:-1,workload:'socket-load'},
      windows:{untimedSetupMs:Math.round(setupMs),measuredMs:Math.round(elapsed),measuredFrom:'first PLAY snapshot',serverLifetimeMetrics:'server start to end of window (includes lobby, warm-up and plane)',bytes:'every frame received on every socket (main and aux) in the window',seed:'chosen at random by the server per match; see detail.matchSeed',transport:'real WebSocket; loopback when URL is local; no WAN inference'},
      load:{players:count,sockets:count*(aux?2:1),inputsPerPlayerSecond,skippedInputSteps:skippedSteps,serverTicksPerSecond,minSnapshotsPerClient:minSnapshots,aliveAtStart,aliveDropsInWindow:aliveDrops,aliveAtEnd:alive,...Object.fromEntries(Object.entries(phaseSeen).map(([k,v])=>['snapshotsInPhase'+k,v]))},
      metrics:{
        rttMs:ms(rtt),snapshotGapMs:ms(gaps),inputToAcknowledgmentMs:ms(ack),generatorLoopGapMs:ms(loopGaps),
        bytesPerPlayerSecond:{status:'ok',unit:'bytes/s',better:'lower',value:bytes/s/count},
        serverCpuMsPerSecond:perf0&&perf1?{status:'ok',unit:'ms',better:'lower',value:(perf1.cpuMs-perf0.cpuMs)/s}:{status:'unsupported',unit:'ms',reason:'server runs without KR_PERF_METRICS=1'},
        serverTickMsLifetime:lifetime(perf1?.tickMs),eventLoopDelayMsLifetime:lifetime(perf1?.eventLoopDelayMs),
      },
      gates:[
        {id:'noErrorsOrDisconnects',pass:!errors.length&&!disconnects,detail:`${errors.length} errors, ${disconnects} disconnects`},
        {id:'measuredInPlay',pass:Object.keys(phaseSeen).join()===String(PLAY),detail:`snapshots by phase: ${JSON.stringify(phaseSeen)}`},
        {id:'inputLoadAchieved',pass:inputsPerPlayerSecond>=TICK_HZ*.95,detail:`${inputsPerPlayerSecond.toFixed(1)} inputs per player per s (target ${TICK_HZ}), ${skippedSteps} skipped steps`},
        {id:'generatorKeptPace',pass:loopGapMax<=GEN_GAP_MAX_MS,detail:`generator loop gap max ${loopGapMax.toFixed(1)} ms (limit ${GEN_GAP_MAX_MS}): a longer pause sends no inputs and would read as a server stall`},
        {id:'serverKeptTickRate',pass:serverTicksPerSecond>=TICK_HZ*.95,detail:`${serverTicksPerSecond.toFixed(1)} server ticks per s (target ${TICK_HZ})`},
        {id:'noDeathsInWindow',pass:aliveDrops===0,detail:`${aliveDrops} drops in the alive count during the window; ${aliveAtStart} alive at the start, ${alive} at the end (whole match, bots included)`},
        {id:'snapshotsDelivered',pass:minSnapshots>=s*28,detail:`fewest snapshots for one client: ${minSnapshots} in ${s.toFixed(1)} s`},
        {id:'serverTickP99Within60Hz',pass:!(perf1?.tickMs?.p99>1000/TICK_HZ),detail:`lifetime server tick p99 ${perf1?.tickMs?.p99?.toFixed(2) ?? 'n/a'} ms`},
      ],
      detail:{matchSeed,bytes,packets,httpResults,health,errors:errors.slice(0,20)},
    }],
    errors,artifacts:[]};
  save(out,result);
  const c=result.cases[0];console.log(JSON.stringify({load:c.load,gates:c.gates},null,2));console.log('wrote',out);
  for(const g of c.gates)if(!g.pass){console.error(`FAIL: ${g.id}: ${g.detail}`);process.exitCode=1;}
}finally{active=false;for(const p of peers){p.ws.close();p.aux?.close();}}
