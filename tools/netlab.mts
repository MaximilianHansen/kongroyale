// NETLAB — hit registration under latency, measured with the REAL code paths: the authoritative Match + MatchHost (the
// same host loop the Node server runs) and two headless ClientMatch instances (the browser's prediction /
// interpolation / lag-comp input code), connected by FIFO latency pipes with jitter and TCP-like loss. Simulated clock
// (deterministic: the same options give the same numbers on every machine).
//
//   npx tsx tools/netlab.mts [rtt ms list, default 20,80,160,250,320] [--jitter 20] [--loss 1] [--aux] [--secs 20] [--weapon ar] [--kill] [--check]
//   --jitter: each message's one-way delay moves by a uniform amount in ±jitter/2 ms; messages never overtake each other
//   --loss:   percent of messages lost per socket and direction. Each socket is TCP: a lost message is resent RESEND_MS(rtt)
//             later and every later message on that socket waits behind it (head-of-line blocking), as tools/performance/
//             netpath.py measured on Linux TCP
//   --aux:    two sockets per client, like the game (client/src/game/net.ts opens a redundant aux socket; the server sends
//             every frame on both and the client sends every input on both; the first copy wins). Off by default, so
//             the numbers below and older results keep their meaning. tools/performance/net-tail.mts always sets it.
//   --check: exit 1 when hit registration regresses. At every RTT up to CHECK_MAX_RTT_MS (250) the run must fire pellets and
//            hit, confirm at least CHECK_MIN_CONFIRM_PCT (99) of its predicted hits and show 0 ghost hits; on a steady simulated
//            link (RTT up to CHECK_STEADY_RTT_MS, 250, jitter ≤ 20, no loss) at most CHECK_MAX_DEFERRED_PCT (1) of its hits
//            may wait for the server. Longer RTTs are only reported as KNOWN ISSUE lines, never failed. While the link stalls,
//            above about 220 ms RTT on a rough link, or past the RTT the rewind cap allows, the client predicts no hit
//            (ClientMatch.linkSlow): the server's verdict draws the marker, so those rows have no ghosts and fewer (or no)
//            predicted hits to confirm. Whole grid:
//              for w in pistol smg ar shotgun sniper; do npx tsx tools/netlab.mts --weapon $w --jitter 20 --check; done
//   --serve PORT / --connect URL: the same duel over REAL WebSockets and a real clock, so a real or emulated network sets
//           the RTT, jitter and loss (the RTT list, --jitter and --loss are ignored). --serve runs the host side (Match +
//           MatchHost, as the server does) on PORT and waits for one --connect process, which runs both players' clients
//           (with --aux, two sockets each, like the game) and prints the result line with the measured RTT. One duel per
//           --serve. --serve prints a random token (or takes --token) that every socket must present; --check judges
//           the duel at its measured RTT. Only against a --serve you started yourself:
//             npx tsx tools/netlab.mts --serve 5800 --weapon shotgun --token T
//             npx tsx tools/netlab.mts --connect ws://10.77.0.1:5800 --token T --aux --weapon shotgun --secs 30
//           Both sides need the same --weapon, --secs and --kill.
//   --kill: B is KILLABLE (100 hp + 50 shield, respawns on the spot 3 s later, warm-up rules) — measures kill races: pellets
//           fired at a target our own in-flight bullets already killed must not show a (ghost) hit marker
//
// Shooter A (seat 0) aims at what it DRAWS for target B (seat 1) — B strafes / sprints / jumps under its own client —
// and fires. For every pellet we compare the client's prediction (ClientMatch.predictShot on the drawn hitboxes, what
// the HUD shows instantly) with the server's lag-compensated verdict (Match.shotProbe). Reports per RTT:
//   agree   = pellets where client and server name the same victim
//   confirm = predicted hits the server confirmed (what the player feels: "my hit marker was real")
//   ghost   = predicted hits the server rejected;  surprise = server hits the client predicted as misses
//   clamped = shots older than the rewind cap (MAX_REWIND_TICKS)
//   deferred = pellets whose drawn hit the client left to the server because the link was slow or stalled
//             (ClientMatch.predDefer, by signal: rtt / snap / ack), also counted as predicted misses;
//             deferredMarkerPct = the server's hits whose marker waited for it; markerDelayMs = how long (fire → verdict)
//   serverInputs = the server's input pacing over the whole duel (shared/net/input-gaps.ts): live ticks, ticks a player's
//             queue was empty (inputGapTicksPct, worst player too) and catch-up bursts of more than one input per tick
// and the transport tails of the window the shooter fires in, as the clients see them (first copy of each frame):
//   rttMs      = ping → pong, both clients;  inputAckMs = each input sent → the first snapshot that acknowledges it (lastSeq),
//   snapGapMs  = time between snapshots (30 Hz: 33 ms when nothing is late);  corrPct = prediction corrections per 100
//   snapshots, both clients (the server replays late inputs 1:1, so a late input shows as a pause, not a correction);
//   holdPct    = the shooter's frames that held the target in place because interpolation ran out of snapshots
import { Terrain } from "../shared/world/terrain";
import { decodeTerrainFile, generateTerrain } from "../shared/world/terrain-gen";
import { buildStaticWorld } from "../shared/sim/static-world";
import fsTd from "node:fs";
import { Match } from "../shared/sim/match";
import { MatchHost, matchInfo, type HostPeer } from "../shared/net/host";
import { trackInputGaps } from "../shared/net/input-gaps";
import { DT, MAX_REWIND_TICKS, WEAPON_DEFS } from "../shared/sim/const";
import { B, PS, SK } from "../shared/sim/player";
import { makeShotResult } from "../shared/sim/hitscan";
import { POIS, WEAPONS, type WeaponId } from "../shared/world/map";
import { M, Reader, SURF_PLAYER, readSnapHeader, type SnapHeader } from "../shared/net/proto";
import { stats } from "./performance/common.mts";
import { ClientMatch, type EventSink } from "../client/src/game/client";
import type { Link } from "../client/src/game/net";
import { WebSocket, WebSocketServer } from "ws";
import { randomBytes } from "node:crypto";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const rtts = (argv[0] && !argv[0].startsWith("--") ? argv[0] : "20,80,160,250,320").split(",").map(Number);
const jitter = Number(opt("--jitter", "0")), secs = Number(opt("--secs", "20")), weapon = opt("--weapon", "ar") as WeaponId, killable = argv.includes("--kill"), check = argv.includes("--check");
const loss = Number(opt("--loss", "0")) / 100, aux = argv.includes("--aux"), servePort = Number(opt("--serve", "0")), connectUrl = opt("--connect", ""), token = opt("--token", "");
/** how much later a lost TCP message arrives: the sender resends it once a later segment's SACK shows the gap (RACK-TLP).
 *  netpath.py, 1% loss, 20 ms jitter, Linux cubic + SACK + RACK: stall peaks 68-100 ms at 50 ms RTT, 167-201 ms at 150 ms,
 *  305-336 ms at 250 ms */
const RESEND_MS = (rtt: number) => Math.max(1.25 * rtt, rtt + 35);

// ---- the clock every module reads through performance.now(): simulated, or (--serve / --connect) the wall clock from
// the moment the duel starts, advanced by realTime() at every frame, tick and message
let now = 0;
const wall = performance.now.bind(performance); let wall0 = wall();
const realTime = () => (now = wall() - wall0);
Object.defineProperty(globalThis, "performance", { value: { now: () => now }, configurable: true });

const td = (() => { try { const b = fsTd.readFileSync(new URL("../public/assets/terrain/island.bin", import.meta.url)); return decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { return generateTerrain(); } })();
const terrain = new Terrain(td.heights, td.biome);
const { world } = await buildStaticWorld(terrain, td);

/** one TCP socket's direction: its own random stream, delivery in order */
interface Sock { q: Array<{ at: number; u8: Uint8Array; json?: unknown }>; rnd: () => number }
interface Pipe { socks: Sock[]; oneWay: number }
const lcg = (seed: number) => { let s = seed; return () => ((s = (Math.imul(s, 1664525) + 1013904223) | 0), ((s >>> 8) & 0xffff) / 65536); };
function pipe(oneWay: number, seed: number): Pipe { return { oneWay, socks: (aux ? [0, 1] : [0]).map((k) => ({ q: [], rnd: lcg(seed + k * 1000) })) }; }
let lostMsgs = 0;
const sendOn = (p: Pipe, s: Sock, u8: Uint8Array | null, json?: unknown) => {
  let d = p.oneWay + (jitter ? (s.rnd() - 0.5) * 2 * jitter / 2 : 0);
  if (loss && s.rnd() < loss) { d += RESEND_MS(p.oneWay * 2); lostMsgs++; }
  const at = Math.max(s.q.length ? s.q[s.q.length - 1].at : 0, now + d);   // FIFO (TCP never reorders)
  s.q.push({ at, u8: u8 ? u8.slice() : new Uint8Array(0), json });
};
/** a frame goes out on every socket (the match info only on the main one, like the server's JSON) */
const send = (p: Pipe, u8: Uint8Array | null, json?: unknown) => { for (const s of json ? p.socks.slice(0, 1) : p.socks) sendOn(p, s, u8, json); };

type Inp = { yaw: number; pitch: number; fire: boolean; mx: number; mz: number; buttons: number; dx: number; dy: number; poll: (o: { mx: number; mz: number; buttons: number; slot: number }, allowFire: boolean) => void };

/** the authoritative side: the match on the lobby islet, A armed, B tanky (or killable), bots parked out of the way */
function makeHost() {
  const m = new Match({ seed: 7, mode: "solo", world, humans: [{ id: 0, name: "A", team: 0 }, { id: 1, name: "B", team: 1 }] });
  for (const p of m.players) if (p.bot) { m.brains[p.id] = null; p.x = 3000 + p.id * 10; p.z = 3000; p.st = PS.Dead; p.respawnAt = 1e9; }
  const host = new MatchHost(m);
  const islet = POIS.find((q) => q.id === "lobby-islet")!;
  const A = m.players[0], Bp = m.players[1];
  A.x = islet.x - 11; A.z = islet.z; A.y = Math.max(0, terrain.height(A.x, A.z)) + 0.05; A.vx = A.vz = 0;
  Bp.x = islet.x + 11; Bp.z = islet.z + 2; Bp.y = Math.max(0, terrain.height(Bp.x, Bp.z)) + 0.05;
  const w = WEAPONS.indexOf(weapon), s = A.slots[0]; s.kind = SK.Weapon; s.id = w; s.rarity = 0; s.mag = 999; s.count = 1; A.active = 0; A.ammo.fill(999);
  Bp.hp = killable ? 100 : 1e9; Bp.shield = killable ? 50 : 0;
  // kill races: B respawns ON its spot (inside the tick, before history is recorded — exactly like a real respawn)
  const out = { m, host, gaps: trackInputGaps(m), deaths: 0, serv: [] as number[], clamped: 0, tick() {
    host.tick(); A.hp = 100; if (!killable) Bp.hp = 1e9; if (m.phase !== 0) m.phase = 0;
    // keep the warm-up going forever (respawn timers are on phaseT: shift them with it)
    if (!killable) m.phaseT = 0; else if (m.phaseT > 60) { m.phaseT -= 30; for (const q of m.players) if (q.respawnAt > 0) q.respawnAt -= 30; }
  } };
  if (killable) { const orig = m.spawnWarmup.bind(m); m.spawnWarmup = (p) => { if (p.id !== 1) return orig(p); out.deaths++; Bp.x = islet.x + 11; Bp.z = islet.z + 2; Bp.y = Math.max(0, terrain.height(Bp.x, Bp.z)) + 0.05; Bp.st = PS.Ground; Bp.grounded = true; Bp.vx = Bp.vy = Bp.vz = 0; Bp.shield = 50; }; }
  m.shotProbe = (sh, _inp, _k, _t, clamped, res) => { if (sh.id !== 0) return; out.serv.push(res.victim); if (clamped) out.clamped++; };
  return out;
}

/** the two players' browsers: ClientMatch each, B's scripted dodging, A's aim and trigger, and the transport tails */
function makeClients(sendUp: (pid: number, u8: Uint8Array) => void) {
  /** per client: when each input seq was sent, the newest snapshot tick and pong seen (the redundant copy is skipped) */
  const tails = [0, 1].map(() => ({ sentAt: new Float64Array(4096), lastTick: -1, lastSnapAt: 0, lastPong: 0, acked: 0 }));
  const rttMs: number[] = [], ackMs: number[] = [], gapMs: number[] = [], hdr = {} as SnapHeader;
  let measuring = false, frames = 0, t0 = -1, lastSemi = 0; const base = { corr: [0, 0], snaps: [0, 0], hold: 0 };
  const T = secs * 1000, rateMs = WEAPON_DEFS[weapon].auto ? 0 : 60000 / WEAPON_DEFS[weapon].rpm + 20;
  const clients = [0, 1].map((pid) => {
    const tl = tails[pid];
    const sendBinary = (u8: Uint8Array) => { if (u8[0] === M.Input) tl.sentAt[new DataView(u8.buffer, u8.byteOffset).getUint32(1, true) % 4096] = now; sendUp(pid, u8); };
    const link: Link = { offline: false, onJSON: () => {}, onBinary: () => {}, onClose: () => {}, sendJSON: () => {}, sendBinary, close: () => {} };
    const inp: Inp = { yaw: 0, pitch: 0, fire: false, mx: 0, mz: 0, buttons: 0, dx: 0, dy: 0, poll(o, allowFire) { o.mx = this.mx; o.mz = this.mz; o.buttons = this.buttons | (this.fire && allowFire ? B.FIRE : 0); o.slot = 0; } };
    return { cm: new ClientMatch(world, link), inp };
  });
  const pred: number[] = [], R = makeShotResult();
  // a pellet whose hit the client left to the server (ClientMatch.linkSlow): when it was fired (-1 = predicted as usual),
  // which signals fired, and how long the server's verdict took to draw its marker (EV.Shot comes with that pellet's EV.Hit)
  const deferAt: number[] = [], deferBy = [0, 0, 0], markerMs: number[] = []; let ownShots = 0, ownHits = 0;
  clients[0].cm.onTick = () => {
    const c = clients[0].cm; if (c.pred.fired === 0) return;
    for (let k = 0; k < c.pred.fired; k++) {
      pred.push(c.predictShot(k, R).victim);
      deferAt.push(c.predDefer ? now : -1); for (let b = 0; b < 3; b++) if (c.predDefer & (1 << b)) deferBy[b]++;
    }
  };
  const ownShot = (_w: number, _x: number, _y: number, _z: number, surf: number, hit: boolean) => { const at = deferAt[ownShots++]; if (!hit || surf !== SURF_PLAYER) return; ownHits++; if (at >= 0) markerMs.push(now - at); };
  clients[0].cm.sink = new Proxy({ ownShot } as Record<string | symbol, unknown>, { get: (o, k) => o[k] ?? (() => {}) }) as unknown as EventSink;
  return {
    clients, pred,
    /** hits whose marker waited for the server: pellets deferred (and by which signal), the share of the server's hits
     *  whose marker came late, and how late (fire → the server's verdict) */
    deferrals() {
      const s = stats(markerMs), r1 = (x: number) => Math.round(x * 10) / 10;
      return { deferred: deferAt.filter((a) => a >= 0).length, deferredBy: { rtt: deferBy[0], snap: deferBy[1], ack: deferBy[2] }, deferredMarkerPct: ownHits ? r1((100 * markerMs.length) / ownHits) : 0, markerDelayMs: { n: s.n, p50: r1(s.p50), p95: r1(s.p95), max: r1(s.max) } };
    },
    /** a frame from the server reached client `pid` (on any of its sockets) */
    receive(pid: number, u8: Uint8Array | null, json?: unknown) {
      const c = clients[pid], tl = tails[pid];
      if (json) { c.cm.onJSON(json as Record<string, unknown>); return; }
      const r = new Reader(u8!), kind = r.u8();
      if (kind === M.Snapshot) {
        readSnapHeader(r, hdr);
        if (hdr.tick > tl.lastTick) {
          if (measuring && tl.lastSnapAt) gapMs.push(now - tl.lastSnapAt);
          // lastSeq is cumulative and inputs run at 60 Hz, snapshots at 30: sample every input it acknowledges for the first time
          if (measuring) for (let s = Math.max(tl.acked + 1, hdr.lastSeq - 4095); s <= hdr.lastSeq; s++) if (tl.sentAt[s % 4096]) ackMs.push(now - tl.sentAt[s % 4096]);
          if (hdr.lastSeq > tl.acked) tl.acked = hdr.lastSeq;
          tl.lastTick = hdr.tick; tl.lastSnapAt = now;
        }
      } else if (kind === M.Pong) { const sent = r.f64(); if (sent > tl.lastPong) { tl.lastPong = sent; if (measuring) rttMs.push(now - sent); } }
      c.cm.onBinary(u8!);
    },
    /** one drawn frame on both clients */
    frame(dt: number) {
      // target B: strafe left/right every 0.7 s, sprint, hop now and then
      const b = clients[1].inp, ph = Math.floor(now / 700);
      b.mx = ph % 2 ? 1 : -1; b.mz = (ph % 5 === 0) ? 1 : 0; b.buttons = (ph % 3 === 0 ? B.SPRINT : 0) | ((Math.floor(now / 1900) % 2 === 0 && now % 1900 < 60) ? B.JUMP : 0);
      b.yaw = -Math.PI / 2;
      // shooter A: aim at the chest of what it draws for B (render interpolation) and fire
      const a = clients[0].inp, cm = clients[0].cm;
      cm.interpolate(); if (measuring) frames++;
      const r = cm.remotes[1];
      if (r.n > 0 && cm.started) {
        const ex = cm.pred.x, ez = cm.pred.z, ey = cm.pred.y + 1.65;
        const dx = r.x - ex, dz = r.z - ez, dy = r.y + (r.crouch ? 0.8 : 1.2) - ey;
        a.yaw = Math.atan2(-dx, -dz); a.pitch = Math.atan2(dy, Math.hypot(dx, dz));
        if (t0 < 0) t0 = now;
        const firing = now - t0 > 1500 && now < T;
        // the transport tails cover the firing window: counters read at its start, then replaced by their change at its end
        if (firing !== measuring) {
          measuring = firing;
          for (let k = 0; k < 2; k++) { const ns = clients[k].cm.netStats; base.corr[k] = ns.moveCorrections - base.corr[k]; base.snaps[k] = ns.snapshots - base.snaps[k]; }
          base.hold = clients[0].cm.netStats.holdFrames - base.hold;
        }
        if (rateMs === 0) a.fire = firing; else if (firing && now - lastSemi > rateMs) { a.fire = !a.fire; lastSemi = now; } else if (!firing) a.fire = false;
      }
      for (const c of clients) c.cm.update(dt, c.inp as never, true);
    },
    /** the firing window has ended (plus the time for its last shots to reach the server) */
    done: (graceMs: number) => now > T + graceMs,
    tails() {
      const pc = (x: number, y: number) => (y ? Math.round((x / y) * 1000) / 10 : 0);
      const tail = (v: number[]) => { const s = stats(v), r1 = (x: number) => Math.round(x * 10) / 10; return { n: s.n, p50: r1(s.p50), p99: r1(s.p99), max: r1(s.max) }; };
      return { rttMs: tail(rttMs), inputAckMs: tail(ackMs), snapGapMs: tail(gapMs), corrPct: pc(base.corr[0] + base.corr[1], base.snaps[0] + base.snaps[1]), corrPctShooter: pc(base.corr[0], base.snaps[0]), corrPctTarget: pc(base.corr[1], base.snaps[1]), holdPct: pc(base.hold, frames) };
    },
  };
}

/** client prediction vs server verdict, pellet by pellet in firing order */
function verdicts(pred: number[], serv: number[]) {
  const n = Math.min(pred.length, serv.length);
  let agree = 0, predHits = 0, confirmed = 0, ghost = 0, surprise = 0, servHits = 0;
  for (let i = 0; i < n; i++) {
    const p = pred[i], s = serv[i];
    if (p === s) agree++;
    if (p >= 0) { predHits++; if (s === p) confirmed++; else ghost++; }
    if (s >= 0) { servHits++; if (p < 0) surprise++; }
  }
  const pc = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return { pellets: n, predMissing: pred.length - serv.length, agreePct: pc(agree, n), predHits, confirmPct: pc(confirmed, predHits), ghost, surprise, servHits };
}

async function run(rtt: number) {
  now = 0; lostMsgs = 0;
  const H = makeHost();
  const ups = [pipe(rtt / 2, 11), pipe(rtt / 2, 12)], downs = [pipe(rtt / 2, 91), pipe(rtt / 2, 92)];
  const C = makeClients((pid, u8) => send(ups[pid], u8));
  for (let pid = 0; pid < 2; pid++) {
    const peer: HostPeer = { pid, invSeq: 0, send: (u8) => send(downs[pid], u8) };
    H.host.peers.push(peer);
    const info = { ...matchInfo(H.m, 7, { [pid + 1]: pid }), myUid: pid + 1 };
    send(downs[pid], null, JSON.parse(JSON.stringify(info)));
  }
  // ---- loop: server at 60 Hz, clients at 144 Hz
  let nextTick = 0, nextFrame = 0;
  while (now < secs * 1000 + rtt + 500) {
    const step = Math.min(nextTick, nextFrame); now = step;
    for (let pid = 0; pid < 2; pid++) {
      const peer = H.host.peers[pid];
      for (let k = 0; k < ups[pid].socks.length; k++) {
        const up = ups[pid].socks[k], down = downs[pid].socks[k];
        while (up.q.length && up.q[0].at <= now) H.host.receive(peer, up.q.shift()!.u8, (r) => sendOn(downs[pid], down, r));
        while (down.q.length && down.q[0].at <= now) { const msg = down.q.shift()!; C.receive(pid, msg.json ? null : msg.u8, msg.json); }
      }
    }
    if (now >= nextTick) { H.tick(); nextTick += DT * 1000; }
    if (now >= nextFrame) { C.frame(1 / 144); nextFrame += 1000 / 144; }
  }
  const cm = C.clients[0].cm;
  return { rtt, jitter, weapon, ...(killable ? { kills: H.deaths } : {}), ...verdicts(C.pred, H.serv), clamped: H.clamped, ...C.deferrals(), rewindCapMs: Math.round(MAX_REWIND_TICKS * DT * 1000), corrections: cm.netStats.moveCorrections, corrMaxMm: Math.round(cm.netStats.corrMax * 1000), sockets: aux ? 2 : 1, lossPct: loss * 100, lostMsgs, serverInputs: H.gaps.report(), ...C.tails() };
}

/** --serve: the host side of one duel over real WebSockets. Every socket must say hello with the duel's token before
 *  anything it sends counts; malformed text closes it. Exits non-zero when a player leaves before the duel ends. */
async function serve(port: number, token: string) {
  const H = makeHost(), socks: WebSocket[][] = [[], []];
  const wss = new WebSocketServer({ port, perMessageDeflate: false, maxPayload: 4096 });
  for (let pid = 0; pid < 2; pid++) H.host.peers.push({ pid, invSeq: 0, send: (u8) => { const b = Buffer.from(u8); for (const ws of socks[pid]) if (ws.readyState === WebSocket.OPEN) ws.send(b); } });
  console.error(`netlab: serving one duel on :${port} (${weapon}, ${secs} s); connect with --token ${token}`);
  let finished = false, aborted: Error | null = null;
  const close = () => { wss.close(); for (const s of socks.flat()) s.terminate(); };
  try {
    await new Promise<void>((resolve, reject) => {
      wss.on("connection", (ws) => {
        let pid = -1;
        ws.on("message", (data: Buffer, binary: boolean) => {
          realTime();
          if (binary) { if (pid >= 0) H.host.receive(H.host.peers[pid], new Uint8Array(data.buffer, data.byteOffset, data.byteLength), (r) => ws.send(Buffer.from(r))); return; }
          let j: { pid?: unknown; token?: unknown; t?: unknown };
          try { j = JSON.parse(String(data)); } catch { ws.terminate(); return; }
          if (j === null || typeof j !== "object") { ws.terminate(); return; }
          if (pid < 0) {
            if (j.token !== token || (j.pid !== 0 && j.pid !== 1)) { ws.terminate(); return; }
            pid = j.pid; socks[pid].push(ws);
            // the first socket of a player is its main socket: it gets the match info, like the server's JSON
            if (socks[pid].length === 1) ws.send(JSON.stringify({ ...matchInfo(H.m, 7, { [pid + 1]: pid }), myUid: pid + 1 }));
            if (socks[0].length && socks[1].length) resolve();
          } else if (j.t === "done") ws.send(JSON.stringify({ t: "verdicts", serv: H.serv, clamped: H.clamped, deaths: H.deaths, inputs: H.gaps.report() }), () => { finished = true; });
        });
        // an oversized or broken frame is an error on that socket only (ws closes it); never an uncaught exception
        ws.on("error", () => ws.terminate());
        ws.on("close", () => { if (!finished && pid >= 0) { finished = true; aborted = Error("a client left before the duel ended"); reject(aborted); } });
      });
      wss.on("error", reject);
    });
    // server loop: 60 Hz on the wall clock from the moment both players are in, catching up at most 8 ticks after a stall
    let nextTick = realTime();
    while (!finished) {
      realTime();
      for (let n = 0; now >= nextTick && n < 8; n++) { H.tick(); nextTick += DT * 1000; }
      if (now - nextTick > 200) nextTick = now;
      await new Promise((r) => setTimeout(r, Math.max(0, nextTick - now - 1)));
    }
    if (aborted) throw aborted;
  } finally { close(); }
}

/** --connect: both players' clients of one duel over real WebSockets; returns the result line */
async function connect(url: string, token: string) {
  const sockets: WebSocket[][] = [[], []];
  const C = makeClients((pid, u8) => { for (const ws of sockets[pid]) if (ws.readyState === WebSocket.OPEN) ws.send(u8); });
  let verdict: { serv: number[]; clamped: number; deaths: number; inputs: unknown } | null = null;
  // one clock origin for the whole duel, set before the first socket opens: frames that arrive during the handshake
  // (the main sockets get the match info and snapshots while the aux sockets are still connecting) never see time go back
  wall0 = wall(); realTime();
  await Promise.all([0, 1].flatMap((pid) => (aux ? [0, 1] : [0]).map((k) => new Promise<void>((resolve, reject) => {
    // a player's main socket says hello first, so it is the one the server sends the match info on
    setTimeout(() => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      ws.on("open", () => { sockets[pid].push(ws); ws.send(JSON.stringify({ pid, token })); resolve(); });
      ws.on("message", (data: Buffer, binary: boolean) => {
        realTime();
        if (binary) return C.receive(pid, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        const j = JSON.parse(String(data));
        if (j.t === "verdicts") verdict = j; else C.receive(pid, null, j);
      });
      ws.on("error", reject);
    }, k * 300);
  }))));
  // client loop: 144 frames a second on the wall clock; a late frame takes the real elapsed time as its dt
  let nextFrame = now, last = now;
  while (!C.done(1500)) {
    realTime();
    if (now >= nextFrame) { C.frame(Math.max(1e-4, (now - last) / 1000)); last = now; nextFrame = Math.max(nextFrame + 1000 / 144, now - 50); }
    await new Promise((r) => setTimeout(r, Math.max(0, nextFrame - now - 1)));
  }
  sockets[0][0].send(JSON.stringify({ t: "done" }));
  for (let waited = 0; !verdict; waited += 10) { if (waited > 10000) throw Error("no verdicts from the server"); await new Promise((r) => setTimeout(r, 10)); }
  for (const s of sockets.flat()) s.close();
  const v = verdict as { serv: number[]; clamped: number; deaths: number; inputs: unknown }, t = C.tails(), cm = C.clients[0].cm;
  return { transport: "ws", url, rtt: t.rttMs.p50, jitter: "real", weapon, ...(killable ? { kills: v.deaths } : {}), ...verdicts(C.pred, v.serv), clamped: v.clamped, ...C.deferrals(), rewindCapMs: Math.round(MAX_REWIND_TICKS * DT * 1000), corrections: cm.netStats.moveCorrections, corrMaxMm: Math.round(cm.netStats.corrMax * 1000), sockets: aux ? 2 : 1, serverInputs: v.inputs, ...t };
}

if (servePort) {
  try { await serve(servePort, token || randomBytes(8).toString("hex")); } catch (e) { console.error(`netlab: ${(e as Error).message}`); process.exit(1); }
  process.exit();
}

const CHECK_MAX_RTT_MS = 250, CHECK_MIN_CONFIRM_PCT = 99, CHECK_STEADY_RTT_MS = 250, CHECK_MAX_DEFERRED_PCT = 1;
const failures: string[] = [];
// --connect: one duel over the real network, judged at its measured RTT; otherwise one simulated duel per RTT
const runs = connectUrl ? [() => connect(connectUrl, token)] : rtts.map((rtt) => () => run(rtt));
for (const go of runs) {
  const r = await go(), rtt = r.rtt;
  console.log(JSON.stringify(r));
  if (!check) continue;
  const problems: string[] = [];
  if (r.pellets === 0 || r.servHits === 0) problems.push(`no data (${r.pellets} pellets, ${r.servHits} hits)`);
  if (r.predMissing !== 0) problems.push(`${r.predMissing} predicted pellets have no server verdict`);
  if (r.predHits > 0 && r.confirmPct < CHECK_MIN_CONFIRM_PCT) problems.push(`confirm ${r.confirmPct}% < ${CHECK_MIN_CONFIRM_PCT}%`);
  // a steady link must keep its instant markers: the deferral is for slow and stalled links only
  if (!connectUrl && rtt <= CHECK_STEADY_RTT_MS && jitter <= 20 && loss === 0 && r.deferredMarkerPct > CHECK_MAX_DEFERRED_PCT) problems.push(`${r.deferredMarkerPct}% of hits waited for the server > ${CHECK_MAX_DEFERRED_PCT}%`);
  if (r.ghost > 0) problems.push(`${r.ghost} ghost hits`);
  if (!problems.length) continue;
  const label = `${weapon} rtt=${rtt}ms jitter=${r.jitter}${killable ? " kill" : ""}: ${problems.join(", ")}`;
  if (rtt > CHECK_MAX_RTT_MS) console.log(`KNOWN ISSUE (not failed, rtt > ${CHECK_MAX_RTT_MS} ms): ${label}`);
  else failures.push(label);
}
if (check) {
  if (failures.length) { console.error("NETLAB CHECK FAILED:\n  " + failures.join("\n  ")); process.exit(1); }
  console.log("NETLAB CHECK PASSED");
}
if (connectUrl) process.exit();
