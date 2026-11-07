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
//   --transport wt: the WebTransport link instead (client/src/game/wt.ts): the client sends its input window (M.Inputs),
//             unreliable frames (channelOf: the input window, pings, pongs, snapshots) are datagrams, each lost on its own
//             with no resend and free to overtake one another (a snapshot goes as SNAPSHOT_DATAGRAM_COPIES of them, like the
//             server's), and the other frames share one reliable stream that
//             resends a lost one like TCP. --aux is ignored. Default ws
//   --aux:    two sockets per client, like the game (client/src/game/net.ts opens a redundant aux socket; the server sends
//             every frame on both and the client sends every input on both; the first copy wins). Off by default, so
//             the numbers below and older results keep their meaning. tools/performance/net-tail.mts always sets it.
//   --check: exit 1 when hit registration regresses. At every RTT up to CHECK_MAX_RTT_MS (250) the run must fire pellets and
//            have predicted hits, confirm at least CHECK_MIN_CONFIRM_PCT (99) of them and show 0 ghost hits. Longer RTTs are only
//            reported as KNOWN ISSUE lines, never failed: main shotgun at 320 ms RTT, 20 ms jitter confirms 89.7% with 3 ghost hits
//            because every pellet is clamped by the 350 ms rewind cap. Whole grid:
//              for w in pistol smg ar shotgun sniper; do npx tsx tools/netlab.mts --weapon $w --jitter 20 --check; done
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
import { DT, MAX_REWIND_TICKS, WEAPON_DEFS } from "../shared/sim/const";
import { B, PS, SK } from "../shared/sim/player";
import { makeShotResult } from "../shared/sim/hitscan";
import { POIS, WEAPONS, type WeaponId } from "../shared/world/map";
import { M, Reader, readSnapHeader, type SnapHeader } from "../shared/net/proto";
import { Channel, SNAPSHOT_DATAGRAM_COPIES, channelOf, makeTransportStats, type Transport } from "../shared/net/transport";
import { stats } from "./performance/common.mts";
import { ClientMatch } from "../client/src/game/client";
import type { Link } from "../client/src/game/net";

const argv = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const rtts = (argv[0] && !argv[0].startsWith("--") ? argv[0] : "20,80,160,250,320").split(",").map(Number);
const jitter = Number(opt("--jitter", "0")), secs = Number(opt("--secs", "20")), weapon = opt("--weapon", "ar") as WeaponId, killable = argv.includes("--kill"), check = argv.includes("--check");
const transport = opt("--transport", "ws") === "wt" ? "wt" : "ws";
const loss = Number(opt("--loss", "0")) / 100, aux = transport === "ws" && argv.includes("--aux");
/** how much later a lost TCP message arrives: the sender resends it once a later segment's SACK shows the gap (RACK-TLP).
 *  netpath.py, 1% loss, 20 ms jitter, Linux cubic + SACK + RACK: stall peaks 68-100 ms at 50 ms RTT, 167-201 ms at 150 ms,
 *  305-336 ms at 250 ms */
const RESEND_MS = (rtt: number) => Math.max(1.25 * rtt, rtt + 35);

// ---- simulated clock drives performance.now() everywhere
let now = 0;
Object.defineProperty(globalThis, "performance", { value: { now: () => now }, configurable: true });

const td = (() => { try { const b = fsTd.readFileSync(new URL("../public/assets/terrain/island.bin", import.meta.url)); return decodeTerrainFile(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); } catch { return generateTerrain(); } })();
const terrain = new Terrain(td.heights, td.biome);
const { world } = await buildStaticWorld(terrain, td);

/** one TCP socket's direction: its own random stream, delivery in order. `dgram`: a WebTransport session's datagrams
 *  instead (a lost one is gone, and they may overtake each other) */
interface Sock { q: Array<{ at: number; u8: Uint8Array; json?: unknown }>; rnd: () => number; dgram?: true }
interface Pipe { socks: Sock[]; oneWay: number }
const lcg = (seed: number) => { let s = seed; return () => ((s = (Math.imul(s, 1664525) + 1013904223) | 0), ((s >>> 8) & 0xffff) / 65536); };
/** ws: the main socket (+ the aux one); wt: the session's stream, then its datagrams */
function pipe(oneWay: number, seed: number): Pipe {
  if (transport === "wt") return { oneWay, socks: [{ q: [], rnd: lcg(seed) }, { q: [], rnd: lcg(seed + 1000), dgram: true }] };
  return { oneWay, socks: (aux ? [0, 1] : [0]).map((k) => ({ q: [], rnd: lcg(seed + k * 1000) })) };
}
let lostMsgs = 0;
const sendOn = (p: Pipe, s: Sock, u8: Uint8Array | null, json?: unknown) => {
  let d = p.oneWay + (jitter ? (s.rnd() - 0.5) * 2 * jitter / 2 : 0);
  const lost = loss > 0 && s.rnd() < loss;
  if (lost) lostMsgs++;
  const msg = { at: now + d, u8: u8 ? u8.slice() : new Uint8Array(0), json };
  if (s.dgram) { if (lost) return; let i = s.q.length; while (i > 0 && s.q[i - 1].at > msg.at) i--; s.q.splice(i, 0, msg); return; }
  if (lost) msg.at += RESEND_MS(p.oneWay * 2);
  msg.at = Math.max(s.q.length ? s.q[s.q.length - 1].at : 0, msg.at);   // FIFO (TCP never reorders)
  s.q.push(msg);
};
/** ws: a frame goes out on every socket (the match info only on the main one, like the server's JSON); wt: on the
 *  datagrams or the stream, as channelOf says */
const send = (p: Pipe, u8: Uint8Array | null, json?: unknown) => {
  if (transport === "wt") {
    const dgram = !!u8 && !json && channelOf(u8[0]) === Channel.Unreliable;
    for (let k = dgram && u8![0] === M.Snapshot ? SNAPSHOT_DATAGRAM_COPIES : 1; k > 0; k--) sendOn(p, p.socks[dgram ? 1 : 0], u8, json);
    return;
  }
  for (const s of json ? p.socks.slice(0, 1) : p.socks) sendOn(p, s, u8, json);
};

async function run(rtt: number) {
  now = 0; lostMsgs = 0;
  const m = new Match({ seed: 7, mode: "solo", world, humans: [{ id: 0, name: "A", team: 0 }, { id: 1, name: "B", team: 1 }] });
  for (const p of m.players) if (p.bot) { m.brains[p.id] = null; p.x = 3000 + p.id * 10; p.z = 3000; p.st = PS.Dead; p.respawnAt = 1e9; }
  const host = new MatchHost(m);
  const islet = POIS.find((q) => q.id === "lobby-islet")!;
  const A = m.players[0], Bp = m.players[1];
  const place = () => {
    A.x = islet.x - 11; A.z = islet.z; A.y = Math.max(0, terrain.height(A.x, A.z)) + 0.05; A.vx = A.vz = 0;
    Bp.x = islet.x + 11; Bp.z = islet.z + 2; Bp.y = Math.max(0, terrain.height(Bp.x, Bp.z)) + 0.05;
    const w = WEAPONS.indexOf(weapon), s = A.slots[0]; s.kind = SK.Weapon; s.id = w; s.rarity = 0; s.mag = 999; s.count = 1; A.active = 0; A.ammo.fill(999);
    Bp.hp = killable ? 100 : 1e9; Bp.shield = killable ? 50 : 0;
  };
  place();
  // kill races: B respawns ON its spot (inside the tick, before history is recorded — exactly like a real respawn)
  let deaths = 0;
  if (killable) { const orig = m.spawnWarmup.bind(m); m.spawnWarmup = (p) => { if (p.id !== 1) return orig(p); deaths++; Bp.x = islet.x + 11; Bp.z = islet.z + 2; Bp.y = Math.max(0, terrain.height(Bp.x, Bp.z)) + 0.05; Bp.st = PS.Ground; Bp.grounded = true; Bp.vx = Bp.vy = Bp.vz = 0; Bp.shield = 50; }; }
  /** per client: when each input seq was sent, the newest snapshot tick and pong seen (the redundant copy is skipped) */
  const tails = [0, 1].map(() => ({ sentAt: new Float64Array(4096), lastTick: -1, lastSnapAt: 0, lastPong: 0, acked: 0 }));
  const rttMs: number[] = [], ackMs: number[] = [], gapMs: number[] = [], hdr = {} as SnapHeader;
  let measuring = false, frames = 0; const base = { corr: [0, 0], snaps: [0, 0], hold: 0 };
  const clients: Array<{ cm: ClientMatch; up: Pipe; down: Pipe; peer: HostPeer; inp: { yaw: number; pitch: number; fire: boolean; mx: number; mz: number; buttons: number; dx: number; dy: number; poll: (o: { mx: number; mz: number; buttons: number; slot: number }, allowFire: boolean) => void } }> = [];
  for (let pid = 0; pid < 2; pid++) {
    const up = pipe(rtt / 2, 11 + pid), down = pipe(rtt / 2, 91 + pid);
    const tl = tails[pid];
    // an input is sent at the first frame that carries it: M.Input, or the newest entry of an input window
    const sendBinary = (u8: Uint8Array) => {
      const dv = new DataView(u8.buffer, u8.byteOffset);
      if (u8[0] === M.Input) tl.sentAt[dv.getUint32(1, true) % 4096] = now;
      else if (u8[0] === M.Inputs) tl.sentAt[(dv.getUint32(2, true) + u8[1] - 1) % 4096] = now;
      send(up, u8);
    };
    const bin: Transport = { kind: transport, stats: makeTransportStats(transport), sendReliable: sendBinary, sendUnreliable: sendBinary, onMessage: () => {}, close: () => {} };
    const link: Link = { offline: false, transport: bin, onJSON: () => {}, onBinary: () => {}, onClose: () => {}, sendJSON: () => {}, sendBinary, close: () => {} };
    const cm = new ClientMatch(world, link);
    const peer: HostPeer = { pid, invSeq: 0, send: (u8) => send(down, u8) };
    host.peers.push(peer);
    const inp = { yaw: 0, pitch: 0, fire: false, mx: 0, mz: 0, buttons: 0, dx: 0, dy: 0, poll(o: { mx: number; mz: number; buttons: number; slot: number }, allowFire: boolean) { o.mx = this.mx; o.mz = this.mz; o.buttons = this.buttons | (this.fire && allowFire ? B.FIRE : 0); o.slot = 0; } };
    clients.push({ cm, up, down, peer, inp });
    const info = { ...matchInfo(m, 7, { [pid + 1]: pid }), myUid: pid + 1 };
    send(down, null, JSON.parse(JSON.stringify(info)));
  }
  // ---- verdicts
  const pred: number[] = [], serv: number[] = []; let clampedN = 0;
  m.shotProbe = (sh, _inp, _k, _t, clamped, res) => { if (sh.id !== 0) return; serv.push(res.victim); if (clamped) clampedN++; };
  const R = makeShotResult();
  clients[0].cm.onTick = () => { const c = clients[0].cm; if (c.pred.fired > 0) for (let k = 0; k < c.pred.fired; k++) pred.push(c.predictShot(k, R).victim); };
  // ---- loop: server at 60 Hz, clients at 144 Hz
  const T = secs * 1000; let nextTick = 0, nextFrame = 0, t0 = -1;
  const rateMs = WEAPON_DEFS[weapon].auto ? 0 : 60000 / WEAPON_DEFS[weapon].rpm + 20;
  let lastSemi = 0;
  while (now < T + rtt + 500) {
    const step = Math.min(nextTick, nextFrame); now = step;
    for (let ci = 0; ci < clients.length; ci++) {
      const c = clients[ci], tl = tails[ci];
      for (let k = 0; k < c.up.socks.length; k++) {
        const up = c.up.socks[k], down = c.down.socks[k];
        while (up.q.length && up.q[0].at <= now) host.receive(c.peer, up.q.shift()!.u8, (r) => sendOn(c.down, down, r));
        while (down.q.length && down.q[0].at <= now) {
          const msg = down.q.shift()!;
          if (msg.json) { c.cm.onJSON(msg.json as Record<string, unknown>); continue; }
          const r = new Reader(msg.u8), kind = r.u8();
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
          c.cm.onBinary(msg.u8);
        }
      }
    }
    if (now >= nextTick) {
      host.tick(); A.hp = 100; if (!killable) Bp.hp = 1e9; if (m.phase !== 0) m.phase = 0;
      // keep the warm-up going forever (respawn timers are on phaseT: shift them with it)
      if (!killable) m.phaseT = 0; else if (m.phaseT > 60) { m.phaseT -= 30; for (const q of m.players) if (q.respawnAt > 0) q.respawnAt -= 30; }
      nextTick += DT * 1000;
    }
    if (now >= nextFrame) {
      const dt = 1 / 144;
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
      for (const c of clients) { (c.inp as unknown as { yaw: number }).yaw = c.inp.yaw; c.cm.update(dt, c.inp as never, true); }
      nextFrame += 1000 / 144;
    }
  }
  const n = Math.min(pred.length, serv.length);
  let agree = 0, predHits = 0, confirmed = 0, ghost = 0, surprise = 0, servHits = 0;
  for (let i = 0; i < n; i++) {
    const p = pred[i], s = serv[i];
    if (p === s) agree++;
    if (p >= 0) { predHits++; if (s === p) confirmed++; else ghost++; }
    if (s >= 0) { servHits++; if (p < 0) surprise++; }
  }
  const pc = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const tail = (v: number[]) => { const s = stats(v), r1 = (x: number) => Math.round(x * 10) / 10; return { n: s.n, p50: r1(s.p50), p99: r1(s.p99), max: r1(s.max) }; };
  const net = { sockets: aux ? 2 : 1, lossPct: loss * 100, lostMsgs, rttMs: tail(rttMs), inputAckMs: tail(ackMs), snapGapMs: tail(gapMs), corrPct: pc(base.corr[0] + base.corr[1], base.snaps[0] + base.snaps[1]), corrPctShooter: pc(base.corr[0], base.snaps[0]), corrPctTarget: pc(base.corr[1], base.snaps[1]), holdPct: pc(base.hold, frames) };
  return { transport, rtt, jitter, weapon, ...(killable ? { kills: deaths } : {}), pellets: n, predMissing: pred.length - serv.length, agreePct: pc(agree, n), predHits, confirmPct: pc(confirmed, predHits), ghost, surprise, servHits, clamped: clampedN, rewindCapMs: Math.round(MAX_REWIND_TICKS * DT * 1000), corrections: clients[0].cm.netStats.moveCorrections, corrMaxMm: Math.round(clients[0].cm.netStats.corrMax * 1000), ...net };
}

const CHECK_MAX_RTT_MS = 250, CHECK_MIN_CONFIRM_PCT = 99;
const failures: string[] = [];
for (const rtt of rtts) {
  const r = await run(rtt);
  console.log(JSON.stringify(r));
  if (!check) continue;
  const problems: string[] = [];
  if (r.pellets === 0 || r.predHits === 0) problems.push(`no data (${r.pellets} pellets, ${r.predHits} predicted hits)`);
  if (r.predMissing !== 0) problems.push(`${r.predMissing} predicted pellets have no server verdict`);
  if (r.confirmPct < CHECK_MIN_CONFIRM_PCT) problems.push(`confirm ${r.confirmPct}% < ${CHECK_MIN_CONFIRM_PCT}%`);
  if (r.ghost > 0) problems.push(`${r.ghost} ghost hits`);
  if (!problems.length) continue;
  const label = `${weapon} rtt=${rtt}ms jitter=${jitter}${killable ? " kill" : ""}: ${problems.join(", ")}`;
  if (rtt > CHECK_MAX_RTT_MS) console.log(`KNOWN ISSUE (not failed, rtt > ${CHECK_MAX_RTT_MS} ms): ${label}`);
  else failures.push(label);
}
if (check) {
  if (failures.length) { console.error("NETLAB CHECK FAILED:\n  " + failures.join("\n  ")); process.exit(1); }
  console.log("NETLAB CHECK PASSED");
}
