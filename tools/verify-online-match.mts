// VERIFY ONLINE MATCH — plays one whole online match against the REAL game server (server/index.ts, unmodified) over
// real WebSockets, with the real client network code: client/src/game/net.ts (the two-socket link: primary + the
// `?attach=1` aux socket and its token message) and client/src/game/client.ts (ClientMatch: prediction, reconcile,
// snapshot / event / inventory decoding through shared/net/proto.ts). No rendering, no GPU, no browser.
//
//   npx tsx tools/verify-online-match.mts [--clients 4] [--mode trios|solo] [--seed 42] [--speed 16] [--limit 170]
//
//   --clients  headless players (at least 3: two of them run the reconnect checks); bots fill the other seats as in any
//              online match
//   --mode     lobby mode (default trios)
//   --seed     seeds the server's Math.random (lobby + match seed: the same island roll, plane line, storm and loot
//              every run) and each client's scripted inputs. The winner can still differ between runs: which server
//              tick an input lands on depends on real socket timing.
//   --speed    clock rate of the server AND the clients: performance.now() runs this many times faster in both
//              processes. Date.now() is untouched, so heartbeats and AFK timers keep real time. A full match is about
//              13 min of game time; --speed 1 plays it in real time. The server's code is not changed, only its clock.
//   --limit    real seconds the match may take before the run fails with "no winner by the time limit"
//
// What it does:
//   1. starts the server on a free loopback port (KR_EVENT_MODE=0, its own process, stdout / stderr captured)
//   2. connects every client: welcome (terrain hash, world hash and NET_VERSION must match this checkout), the aux
//      socket attach, hello. Client 1 CREATEs the lobby, the rest JOIN by its code, client 1 STARTs
//   3. plays: each client drops from the plane, runs, turns, jumps and fires (a seeded script)
//   4. reconnects, along both paths a normal lobby has:
//        - client 2 drops its link during the PLANE and rejoins by code: it must get a seat back (a bot's) and play on
//        - client 3 drops its link mid-match (PLAY) and rejoins by code: it must be refused a seat ("MATCH IN
//          PROGRESS") but stay in the room, and be back in the lobby when the match ends
//   5. the match must reach RESULTS with one winning squad that every client still in it agrees on (the Victory
//      announcement and its own `result` message), then every client must be back in the room
//   6. a rematch: the host STARTs again and every client (the room-only rejoiner too) must be seated. Then everyone
//      leaves and the server must exit cleanly on SIGTERM
//
// Exits 1, listing the reasons, on: a failed connect or handshake, a hash or version mismatch, an unexpected `error`
// message or socket close, an exception in the client code, a client whose snapshots stop (stuck), clients disagreeing
// on the winner, a server log line reporting a tick error / handler error / uncaught exception / strikes / a socket the
// server closed, the server process dying, or no winner within --limit. Exits 0 and prints a JSON summary on a pass.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Terrain } from "../shared/world/terrain";
import { decodeTerrainFile, generateTerrain } from "../shared/world/terrain-gen";
import { buildStaticWorld } from "../shared/sim/static-world";
import { DT } from "../shared/sim/const";
import { B, PS } from "../shared/sim/player";
import { ANN, NET_VERSION } from "../shared/net/proto";
import type { OutcomeState } from "../shared/net/host";
import { ClientMatch, type EventSink } from "../client/src/game/client";
import { connectWs, type Link } from "../client/src/game/net";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const CLIENTS = Math.max(3, Number(opt("--clients", "4")) | 0), MODE = opt("--mode", "trios") === "solo" ? "solo" : "trios";
const SEED = Number(opt("--seed", "42")) >>> 0, SPEED = Math.max(1, Number(opt("--speed", "16"))), LIMIT_S = Number(opt("--limit", "170"));
/** real seconds without a new snapshot (while seated in a running match) before a client counts as stuck */
const STUCK_REAL_S = 10;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const realNow = performance.now.bind(performance);
const t0Real = realNow();
const say = (...a: unknown[]) => console.log(`[${((realNow() - t0Real) / 1000).toFixed(1).padStart(6)}s]`, ...a);
const failures: string[] = [];
const fail = (why: string) => { if (failures.length < 50) failures.push(why); say("FAIL:", why); };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- the same clock warp in this process as in the server's (performance.now only)
{ const base = realNow(); Object.defineProperty(performance, "now", { value: () => base + (realNow() - base) * SPEED, configurable: true, writable: true }); }

// ---- the world, built exactly as the server and the browser build it (welcome must carry the same hashes)
const td = (() => { try { const b = fs.readFileSync(path.join(root, "public/assets/terrain/island.bin")); return decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { return generateTerrain(); } })();
const { world, hash: worldHash } = await buildStaticWorld(new Terrain(td.heights, td.biome), td);
say(`world: terrain hash ${td.hash}, world hash ${worldHash}, NET_VERSION ${NET_VERSION}`);

// ---- the server: its own process, the clock warp + a seeded Math.random preloaded
const port = await new Promise<number>((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const preload = `const K=${SPEED};const r=performance.now.bind(performance);const b=r();Object.defineProperty(performance,"now",{value:()=>b+(r()-b)*K,configurable:true,writable:true});`
  + `let s=${SEED || 1};Math.random=()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};`;
const serverLog: string[] = [];
let tearingDown = false, serverExit: number | null | undefined;
const server: ChildProcess = spawn(process.execPath, ["--import", "tsx", "--import", "data:text/javascript," + encodeURIComponent(preload), "server/index.ts"], {
  cwd: root, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, KR_EVENT_MODE: "0", KR_PORT: String(port), KR_HOST: "127.0.0.1", KR_SERVE: "0", KR_ADMIN_KEY_SHA256: "", KR_TRUST_PROXY: "0", KR_ORIGINS: "" },
});
let serverReady: () => void = () => {};
const ready = new Promise<void>((res) => { serverReady = res; });
/** server log lines that mean something went wrong on the server */
const BAD_LOG = /tick error|MATCH CRASHED|json handler error|uncaught|unhandled rejection|closing a socket|\bby (strikes|heartbeat|send backlog|idle|server)|asset request failed/i;
let plannedDrops = 0, primaryDisconnects = 0;
const onServerLine = (line: string, stream: string) => {
  if (!line.trim()) return;
  serverLog.push(`${stream}: ${line}`);
  if (/KONG ROYALE server on/.test(line)) serverReady();
  if (/^\S+ disconnect: /.test(line) && !tearingDown) primaryDisconnects++;
  if (BAD_LOG.test(line) || (stream === "stderr" && /error/i.test(line))) fail(`server log: ${line.trim()}`);
};
for (const [stream, src] of [["stdout", server.stdout!], ["stderr", server.stderr!]] as const) {
  let buf = "";
  src.setEncoding("utf8");
  src.on("data", (d: string) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { onServerLine(buf.slice(0, i), stream); buf = buf.slice(i + 1); } });
}
server.on("exit", (code, sig) => { serverExit = code; if (!tearingDown) fail(`server process exited mid-run (code ${code}, signal ${sig})`); });

// ---- headless clients
const enum Role { Host, Player, PlaneRejoin, PlayRejoin }
interface Client {
  name: string; role: Role; link: Link | null; uid: number; code: string;
  cm: ClientMatch | null; seated: boolean; lastSnapReal: number; lastSnapTick: number; snaps: number; matches: number;
  /** what this client saw of the match it finished: phases, Victory announcements, its own results, its squad */
  phases: Set<number>; victoryTeams: Set<number>; results: OutcomeState[]; team: number; kills: number;
  /** the room the server last sent: a match running, my seat there (null = not in the room) */
  room: { inMatch: boolean; myPid: number | null } | null;
  expectError: RegExp | null; errorsSeen: string[]; dropped: boolean; rejoined: boolean; refusedSeat: boolean;
  /** the seeded script's state */
  rng: number; yaw: number; mx: number; mz: number; buttons: number; jumpAt: number; lastFrame: number;
  corrections: number; moveCorrections: number; corrOver10cm: number; corrMax: number; snapTotal: number; dupTotal: number;
}
const clients: Client[] = [];
const wsUrl = `ws://127.0.0.1:${port}/ws`;
// net.ts resolves the aux socket's URL against the page and reads ?aux=0 from it
(globalThis as { location?: unknown }).location = { href: `http://127.0.0.1:${port}/`, search: "" };

const rnd = (c: Client) => { c.rng = (Math.imul(c.rng, 1664525) + 1013904223) >>> 0; return c.rng / 4294967296; };
/** every event a sink can get: no-ops except the ones this check reads */
function sinkFor(c: Client): EventSink {
  const own: Partial<EventSink> = {
    announceCode: (code, a) => { if (code === ANN.Victory) c.victoryTeams.add(a); },
    kill: () => { c.kills++; },
    phase: (ph) => { c.phases.add(ph); },
  };
  return new Proxy(own, { get: (t, k) => (t as Record<string | symbol, unknown>)[k] ?? (() => {}) }) as EventSink;
}
/** one world is shared by every ClientMatch in this process: each binds its own glass, tuk-tuks and walls first */
function bindWorld(cm: ClientMatch) { cm.glass.bind(); cm.vehs.bind(); world.cover = cm.covers; }
function retireMatch(c: Client) {
  const s = c.cm?.netStats;
  if (s) {
    c.corrections += s.corrections; c.moveCorrections += s.moveCorrections; c.corrOver10cm += s.corrOver10cm; c.corrMax = Math.max(c.corrMax, s.corrMax);
    c.snapTotal += s.snapshots; c.dupTotal += s.dupFrames;
    // the aux socket carries every snapshot a second time: without duplicates the redundant link never attached
    if (s.snapshots > 300 && s.dupFrames < s.snapshots * 0.5) fail(`${c.name}: the aux socket delivered ${s.dupFrames} duplicate snapshots out of ${s.snapshots}: the second socket did not attach`);
    // the client's prediction must agree with the server's simulation of the same inputs. A few corrections are normal (a
    // server hitch, magnified by --speed, steps a neutral input; a bot shoves us): up to ~4 % of snapshots at --speed 16.
    // A client that predicts differently from the server corrects on nearly every snapshot.
    if (s.snapshots > 300 && s.moveCorrections > s.snapshots * 0.25) fail(`${c.name}: prediction desync: ${s.moveCorrections} movement corrections in ${s.snapshots} snapshots`);
  }
  c.cm = null; c.seated = false;
}

async function connect(c: Client): Promise<void> {
  let link: Link;
  try { link = await connectWs(wsUrl, 4000); } catch (e) { fail(`${c.name}: connect failed: ${String(e)}`); return; }
  c.link = link;
  const welcomed = new Promise<void>((res) => {
    link.onJSON = (m) => { try { onJSON(c, link, m); } catch (e) { fail(`${c.name}: exception handling "${String(m.t)}": ${(e as Error).stack ?? e}`); } if (m.t === "welcome") res(); };
  });
  link.onClose = (why) => { if (c.link === link && !tearingDown) fail(`${c.name}: socket closed unexpectedly: ${why}`); };
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([welcomed, new Promise<void>((res) => { timer = setTimeout(() => { fail(`${c.name}: no welcome within 5 s`); res(); }, 5000); })]);
  clearTimeout(timer);
}
function onJSON(c: Client, link: Link, m: Record<string, unknown>) {
  if (c.link !== link) return;
  switch (m.t) {
    case "welcome": {
      c.uid = m.uid as number;
      if (m.net !== NET_VERSION) fail(`${c.name}: server NET_VERSION ${m.net} != client ${NET_VERSION}`);
      if (m.terrain !== td.hash) fail(`${c.name}: server terrain hash ${m.terrain} != client ${td.hash}`);
      if (m.world !== worldHash) fail(`${c.name}: server world hash ${m.world} != client ${worldHash}`);
      if (typeof m.aux !== "string" || !m.aux) fail(`${c.name}: welcome carries no aux token`);
      link.sendJSON({ t: "hello", name: c.name });
      break;
    }
    case "lobby": {
      c.code = m.code as string;
      const me = (m.players as Array<{ id: number; pid: number }>).find((p) => p.id === c.uid);
      c.room = { inMatch: m.inMatch === true, myPid: me ? me.pid : null };
      if (!m.inMatch && c.seated) retireMatch(c);
      break;
    }
    case "match": {
      retireMatch(c);
      const cm = new ClientMatch(world, link);
      // performance.now() is warped and MessageEvent.timeStamp is not: ClientMatch stamps arrivals with its own clock
      link.onBinary = (u8) => {
        if (c.cm !== cm) return;
        try { bindWorld(cm); cm.onBinary(u8); } catch (e) { fail(`${c.name}: exception decoding a binary frame (type ${u8[0]}): ${(e as Error).stack ?? e}`); }
        if (cm.snapTick() !== c.lastSnapTick) { c.lastSnapTick = cm.snapTick(); c.lastSnapReal = realNow(); c.snaps++; }
      };
      cm.sink = sinkFor(c);
      c.phases.clear(); c.victoryTeams.clear(); c.results.length = 0;
      cm.onJSON({ ...m, myUid: c.uid });
      if (cm.me < 0) fail(`${c.name}: match info without my seat`);
      c.cm = cm; c.seated = true; c.matches++; c.team = cm.pred.team; c.lastSnapReal = realNow(); c.lastSnapTick = -1; c.lastFrame = performance.now();
      c.jumpAt = 6 + rnd(c) * 20;
      // the browser reports its island stream (the warm-up waits for it); this client has nothing to stream
      link.sendJSON({ t: "stream", done: true });
      break;
    }
    case "phase": c.cm?.onJSON(m); break;
    case "result": {
      const st = m.state as OutcomeState;
      if (!c.cm || st.pid !== c.cm.me) { fail(`${c.name}: result for seat ${st?.pid}, my seat is ${c.cm?.me}`); break; }
      c.results.push(st);
      break;
    }
    case "error": {
      const msg = String(m.msg);
      c.errorsSeen.push(msg);
      if (c.expectError && c.expectError.test(msg)) { c.expectError = null; c.refusedSeat = true; break; }
      fail(`${c.name}: server error message: ${msg}`);
      break;
    }
    case "mark": case "voiceroster": case "rtc": case "voice": break;
    default: fail(`${c.name}: unexpected JSON message from the server: ${String(m.t)}`);
  }
}

/** one frame of one client: the seeded script picks the input, ClientMatch predicts it and sends it */
function frame(c: Client) {
  const cm = c.cm; if (!cm || !c.link) return;
  const now = performance.now(), dt = Math.min(0.25, (now - c.lastFrame) / 1000); c.lastFrame = now;
  const st = cm.pred.st;
  c.buttons = 0;
  if (st === PS.Plane) { c.mx = 0; c.mz = 0; if (cm.phase === 1 && (cm.serverTick() - cm.phaseTick) * DT > c.jumpAt) c.buttons = B.JUMP; }
  else if (st === PS.Freefall || st === PS.Glide) { c.mx = 0; c.mz = 1; }
  else {
    if (rnd(c) < 0.02) c.yaw += (rnd(c) - 0.5) * 2;
    if (rnd(c) < 0.05) { c.mx = rnd(c) < 0.5 ? -1 : rnd(c) < 0.5 ? 1 : 0; c.mz = rnd(c) < 0.85 ? 1 : 0; }
    if (rnd(c) < 0.01) c.buttons |= B.JUMP;
    if (rnd(c) < 0.3) c.buttons |= B.SPRINT;
    if (rnd(c) < 0.25) c.buttons |= B.FIRE;
  }
  const inp = {
    yaw: c.yaw, pitch: 0, rideSeat: -1,
    poll: (o: { mx: number; mz: number; buttons: number; slot: number }, allowFire: boolean) => { o.mx = c.mx; o.mz = c.mz; o.buttons = allowFire ? c.buttons : c.buttons & ~B.FIRE; o.slot = cm.pred.active; },
  };
  try { bindWorld(cm); cm.interpolate(); cm.update(dt, inp as never, true); } catch (e) { fail(`${c.name}: exception in ClientMatch.update: ${(e as Error).stack ?? e}`); c.cm = null; }
}

async function until(what: string, ok: () => boolean, realS: number): Promise<boolean> {
  const end = realNow() + realS * 1000;
  while (!ok()) {
    if (serverExit !== undefined) return false;
    if (realNow() > end) { fail(`timed out (${realS} s) waiting for: ${what}`); return false; }
    for (const c of clients) frame(c);
    await sleep(4);
  }
  return true;
}
function dropAndRejoin(c: Client, why: string, expectError: RegExp | null) {
  c.dropped = true; plannedDrops++;
  say(`${c.name}: dropping its link ${why} (seat ${c.cm?.me})`);
  const old = c.link!; retireMatch(c); c.link = null; c.room = null; old.close();
  c.expectError = expectError;
  void (async () => { await connect(c); c.link?.sendJSON({ t: "join", code: clients[0].code }); c.rejoined = true; })();
}

let outcome: unknown = null;
async function main() {
  const up = await Promise.race([ready.then(() => true), sleep(60_000).then(() => false)]);
  if (!up) { fail("the server did not start within 60 s"); return; }
  say(`server up on 127.0.0.1:${port} (speed x${SPEED}, seed ${SEED}, ${MODE}, ${CLIENTS} clients)`);
  for (let i = 0; i < CLIENTS; i++) {
    clients.push({ name: `VERIFY ${i + 1}`, role: i === 0 ? Role.Host : i === 1 ? Role.PlaneRejoin : i === 2 ? Role.PlayRejoin : Role.Player,
      link: null, uid: 0, code: "", cm: null, seated: false, lastSnapReal: 0, lastSnapTick: -1, snaps: 0, matches: 0,
      phases: new Set(), victoryTeams: new Set(), results: [], team: -1, kills: 0, room: null, expectError: null, errorsSeen: [],
      dropped: false, rejoined: false, refusedSeat: false, rng: (SEED * 977 + i * 7919 + 1) >>> 0, yaw: i * 1.3, mx: 0, mz: 1, buttons: 0, jumpAt: 10, lastFrame: 0,
      corrections: 0, moveCorrections: 0, corrOver10cm: 0, corrMax: 0, snapTotal: 0, dupTotal: 0 });
  }
  const host = clients[0];
  await connect(host); if (failures.length) return;
  host.link!.sendJSON({ t: "create", mode: MODE });
  if (!await until("the lobby to be created", () => !!host.code, 10)) return;
  for (const c of clients.slice(1)) { await connect(c); c.link?.sendJSON({ t: "join", code: host.code }); }
  if (!await until("every client in the room", () => clients.every((c) => c.code === host.code && c.room !== null && c.room.myPid !== null), 10)) return;
  say(`lobby ${host.code}: ${CLIENTS} clients in the room, START`);
  host.link!.sendJSON({ t: "start" });
  if (!await until("every client seated", () => clients.every((c) => c.seated), 10)) return;
  say(`match started: match seed ${(host.cm as unknown as { seed: number }).seed}, seats ${clients.map((c) => c.cm!.me).join(",")}, squads ${clients.map((c) => c.team).join(",")}`);

  // ---- the match: a frame every ~4 ms (real), the reconnect script, the stuck check
  const startReal = realNow();
  let lastLog = 0;
  const planeRejoin = clients.find((c) => c.role === Role.PlaneRejoin)!, playRejoin = clients.find((c) => c.role === Role.PlayRejoin)!;
  while (true) {
    for (const c of clients) frame(c);
    if (!planeRejoin.dropped && planeRejoin.cm?.phase === 1) dropAndRejoin(planeRejoin, "during the plane", null);
    if (!playRejoin.dropped && playRejoin.cm?.phase === 2 && playRejoin.cm.time > 60) dropAndRejoin(playRejoin, `mid-match (match time ${playRejoin.cm.time.toFixed(0)} s)`, /MATCH IN PROGRESS/);
    for (const c of clients) if (c.seated && c.cm && realNow() - c.lastSnapReal > STUCK_REAL_S * 1000) { fail(`${c.name}: stuck, no new snapshot for ${STUCK_REAL_S} s (last tick ${c.lastSnapTick}, phase ${c.cm.phase})`); c.seated = false; }
    const hc = host.cm;
    if (realNow() - lastLog > 10_000 && hc) { lastLog = realNow(); say(`phase ${hc.phase}, match time ${hc.time.toFixed(0)} s, alive ${hc.alive}, squads ${hc.squads}, snapshots ${clients.map((c) => c.snaps).join("/")}`); }
    if (planeRejoin.rejoined && playRejoin.rejoined && clients.every((c) => c.room && !c.room.inMatch && !c.seated)) break;
    if (realNow() - startReal > LIMIT_S * 1000) { fail(`no winner by the time limit (${LIMIT_S} s real; phase ${hc?.phase ?? "?"}, match time ${hc?.time.toFixed(0) ?? "?"} s, squads ${hc?.squads ?? "?"})`); return; }
    if (serverExit !== undefined) return;
    await sleep(4);
  }
  say(`match over after ${((realNow() - startReal) / 1000).toFixed(1)} s real: every client is back in the room`);
  checkOutcome(planeRejoin, playRejoin);
  // ---- the rematch: the room still works, and the room-only rejoiner gets a seat this time
  host.link!.sendJSON({ t: "start" });
  if (await until("every client seated for the rematch", () => clients.every((c) => c.seated), 10)) say(`rematch started: ${CLIENTS}/${CLIENTS} seated`);
  await until("a second of the rematch (30 snapshots each)", () => clients.every((c) => c.cm !== null && c.cm.netStats.snapshots >= 30), 10);
}

function checkOutcome(planeRejoin: Client, playRejoin: Client) {
  if (planeRejoin.matches < 2) fail(`${planeRejoin.name}: rejoined during the plane but got no seat back`);
  if (!playRejoin.refusedSeat) fail(`${playRejoin.name}: rejoined mid-match but was not told MATCH IN PROGRESS (errors: ${playRejoin.errorsSeen.join(" | ") || "none"})`);
  if (playRejoin.room?.myPid == null) fail(`${playRejoin.name}: not in the room after the match`);
  if (plannedDrops !== primaryDisconnects) fail(`the server logged ${primaryDisconnects} player disconnects, the script made ${plannedDrops}`);
  // the winner: every client still in the match saw RESULTS and the same Victory, and its own result agrees
  const finishers = clients.filter((c) => c !== playRejoin);
  const teams = new Set<number>(); for (const c of finishers) for (const t of c.victoryTeams) teams.add(t);
  if (teams.size !== 1) { fail(`clients saw ${teams.size} different winning squads: ${[...teams].join(",") || "none"}`); return; }
  const winner = [...teams][0];
  for (const c of finishers) {
    if (!c.phases.has(3)) fail(`${c.name}: never saw the RESULTS phase`);
    if (!c.victoryTeams.size) fail(`${c.name}: never saw the Victory announcement`);
    // the link's report (KONGBOT and playtest bundles): its A/B arm (the server offers no WebTransport here) and the
    // input→ack samples and play seconds ClientMatch gave it
    const rep = c.link?.report?.();
    if (!rep || rep.arm !== "off" || !(rep.ackMs.n > 0) || rep.ackMs.p50 === null || !(rep.playS > 0) || !Number.isFinite(rep.since)) fail(`${c.name}: the link's report lacks its arm, input→ack samples, play seconds or start: ${JSON.stringify(rep && { arm: rep.arm, ackMs: rep.ackMs, playS: rep.playS, since: rep.since })}`);
    const last = c.results[c.results.length - 1];
    if (!last) { fail(`${c.name}: got no result message`); continue; }
    if (last.outcomeTime === null || !(last.placement >= 1)) fail(`${c.name}: result not final: ${JSON.stringify(last)}`);
    if (last.winner !== ((c.team & 0xff) === winner)) fail(`${c.name}: result says winner=${last.winner}, my squad ${c.team}, winning squad ${winner}`);
  }
  outcome = { winningSquad: winner, results: finishers.map((c) => { const r = c.results[c.results.length - 1]; return { name: c.name, squad: c.team, placement: r?.placement, kills: r?.kills, winner: r?.winner, outcomeTime: r?.outcomeTime }; }) };
  say(`winner: squad ${winner}; every client agrees`);
}

const watchdog = setTimeout(() => { fail("watchdog: the run took over --limit + 120 s"); void finish(); }, (LIMIT_S + 120) * 1000);
let finished = false;
async function finish() {
  if (finished) return; finished = true;
  clearTimeout(watchdog);
  tearingDown = true;
  for (const c of clients) { try { c.link?.close(); } catch { /* gone */ } }
  await sleep(300);
  if (serverExit === undefined) {
    const exited = new Promise<boolean>((r) => server.once("exit", () => r(true)));
    server.kill("SIGTERM");
    if (!await Promise.race([exited, sleep(5000).then(() => false)])) { fail("the server did not exit within 5 s of SIGTERM"); server.kill("SIGKILL"); }
    else if (serverExit !== 0) fail(`the server exited with code ${serverExit} after SIGTERM`);
  }
  for (const c of clients) retireMatch(c);
  const summary = {
    ok: failures.length === 0, seconds: +((realNow() - t0Real) / 1000).toFixed(1), seed: SEED, speed: SPEED, mode: MODE, clients: CLIENTS, outcome,
    perClient: clients.map((c) => ({ name: c.name, matches: c.matches, snapshots: c.snapTotal, auxDuplicates: c.dupTotal, corrections: c.corrections, moveCorrections: c.moveCorrections, corrOver10cm: c.corrOver10cm, corrMaxM: +c.corrMax.toFixed(3), errors: c.errorsSeen })),
    failures,
  };
  if (failures.length) { console.log("---- server log (last 40 lines)"); for (const l of serverLog.slice(-40)) console.log(l); }
  console.log(JSON.stringify(summary, null, 2));
  console.log(failures.length ? `VERIFY ONLINE MATCH: FAIL (${failures.length})` : "VERIFY ONLINE MATCH: PASS");
  process.exit(failures.length ? 1 : 0);
}
process.on("uncaughtException", (e) => { fail(`uncaught exception in the verifier: ${e.stack ?? e}`); void finish(); });
process.on("unhandledRejection", (e) => { fail(`unhandled rejection in the verifier: ${String(e)}`); void finish(); });
try { await main(); } catch (e) { fail(`the verifier crashed: ${(e as Error).stack ?? e}`); }
await finish();
