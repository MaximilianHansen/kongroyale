// The authoritative host loop + wire writers, shared by the Node server, the in-browser offline host and tools/netlab
// (one code path: the lab measures exactly what ships). Transport-agnostic: a peer is anything with `send(u8)`.
import type { Match } from "../sim/match";
import { PS, alive, makeInput } from "../sim/player";
import { SNAP_EVERY } from "../sim/const";
import { CSF, INPUT_BODY_BYTES, INPUT_BYTES, INPUT_WINDOW, INPUTS_HEAD_BYTES, INVOP_BYTES, M, Reader, Writer, readInput, readInputBody, writeCastHeader, writeCastStat, writeInventory, writePlayer, writeVehicle } from "./proto";
import { makeEconView } from "../sim/economy";
import { writeSnapshotFor } from "./host.hot";
export { NEAR_R, writeSnapshotFor } from "./host.hot";

const EV_TMP = makeEconView();

/** One synchronous snapshot fan-out. Records are byte-identical for every viewer with the same health flags.
 * Explicit begin() avoids a tick-keyed cache going stale when tools mutate a match within a tick. Never use across
 * simulation steps or asynchronous sends. The transport still copies the assembled packet before queuing it. */
export class SnapshotBatch {
  alive = 0; squads = 0; flags = 0;
  private players: Array<Array<{ w: Writer; bytes: Uint8Array | null }>> = [];
  private vehicles: Array<{ w: Writer; bytes: Uint8Array | null }> = [];
  begin(m: Match) {
    this.alive = m.aliveCount(); this.squads = m.squadsLeft(); this.flags = m.headerFlags();
    for (const variants of this.players) if (variants) for (const v of variants) v.bytes = null;
    for (const v of this.vehicles) if (v) v.bytes = null;
  }
  player(w: Writer, p: Match['players'][number], hp: boolean, total: boolean) {
    const variants = this.players[p.id] ??= Array.from({ length: 3 }, () => ({ w: new Writer(new ArrayBuffer(32)), bytes: null }));
    const v = variants[hp ? 2 : total ? 1 : 0];
    if (!v.bytes) { writePlayer(v.w.reset(), p, hp, total); v.bytes = v.w.view(); }
    w.raw(v.bytes);
  }
  vehicle(w: Writer, v: Match['vehs']['list'][number]) {
    const entry = this.vehicles[v.id] ??= { w: new Writer(new ArrayBuffer(256)), bytes: null };
    if (!entry.bytes) { writeVehicle(entry.w.reset(), v); entry.bytes = entry.w.view(); }
    w.raw(entry.bytes);
  }
}


export function writeInventoryFor(w: Writer, m: Match, pid: number, seq: number): Writer {
  const p = m.players[pid];
  w.reset(); writeInventory(w, p, m.econ ? m.econ.view(p, EV_TMP) : null);
  w.u8(p.spectate >= 0 ? p.spectate : 255).u16(seq & 0xffff);
  return w;
}

// ---- caster seats (client/src/caster): full information, no player of their own
const castHead = { tick: 0, time: 0, phase: 0, alive: 0, squads: 0, flags: 0, count: 0 };
/** every player (exact health) + every live vehicle — what a commentator seat draws. Bodies stay as long as for players. */
export function writeCastSnapshot(w: Writer, m: Match, batch?: SnapshotBatch): Writer {
  w.reset();
  castHead.tick = m.tick; castHead.time = m.time; castHead.phase = m.phase; castHead.alive = batch ? batch.alive : m.aliveCount(); castHead.squads = batch ? batch.squads : m.squadsLeft(); castHead.flags = batch ? batch.flags : m.headerFlags(); castHead.count = 0;
  writeCastHeader(w, castHead);
  const countPos = w.o - 1; let count = 0;
  const now = m.phase === 0 ? m.phaseT : m.time;
  for (const p of m.players) {
    if (!alive(p) && !(p.st === PS.Dead && (now - p.deadAt < 4 || (!p.grounded && now - p.deadAt < 12)))) continue;
    if (batch) batch.player(w, p, true, false); else writePlayer(w, p, true, false);
    if (++count >= 255) break;
  }
  w.dv.setUint8(countPos, count);
  const vPos = w.o; w.u8(0); let vn = 0;
  for (const v of m.vehs.list) { if (!v.live) continue; if (batch) batch.vehicle(w, v); else writeVehicle(w, v); vn++; }
  w.dv.setUint8(vPos, vn);
  return w;
}
export function writeCastStats(w: Writer, m: Match): Writer {
  w.reset().u8(M.CastStats).u32(m.tick).u8(m.players.length);
  for (const p of m.players) {
    const flags = (p.bot ? CSF.Bot : 0) | (p.connected ? CSF.Connected : 0) | (p.eliminated ? CSF.Eliminated : 0) | (alive(p) ? CSF.Alive : 0)
      | (p.respawnAt >= 0 ? CSF.Resurging : 0) | (m.teamsOut.has(p.team) ? CSF.SquadOut : 0) | (p.st === PS.Plane ? CSF.Plane : 0) | (m.winnerTeam === p.team ? CSF.Winner : 0);
    writeCastStat(w, p, flags, m.time);
  }
  return w;
}

/** the JSON a client needs to (re)build a match locally */
export function matchInfo(m: Match, seed: number, pids: Record<number, number>) {
  return {
    t: "match", seed, mode: m.mode, range: m.range, tick: m.tick, pids, plane: m.plane, plan: m.plan, phase: m.phase, phaseT: m.phaseT, time: m.time,
    names: m.players.map((p) => p.name), teams: m.players.map((p) => p.team),
    chestsOpened: m.chests.filter((q) => q.opened).map((q) => q.id),
    // glass: every pane broken so far (late joiners / reconnects see the same windows)
    glass: m.glass.list(),
    // the server's loot generator decides the chests; the client takes them from here (no second placeLoot)
    chests: m.chests.map((c) => [c.id, +c.x.toFixed(3), +c.y.toFixed(3), +c.z.toFixed(3), +c.yaw.toFixed(3), c.rarity, c.poi, c.box ? 1 : 0]),   // [7]: ammo box
    items: m.items.filter((i) => !i.taken).map((i) => [i.id, i.kind, i.sub, i.rarity, i.count, +i.x.toFixed(2), +i.y.toFixed(2), +i.z.toFixed(2)]),
    // (economy) the Banana Stands: [x, y, z, yaw, poi]
    stands: m.econ ? m.econ.stands.map((s) => [+s.x.toFixed(3), +s.y.toFixed(3), +s.z.toFixed(3), +s.yaw.toFixed(4), s.poi]) : [],
    // the crate walls standing (a late joiner collides with the same ones): [id, owner, x, y, z, yaw, hp]
    covers: m.covers.list.filter((w) => w.live && !w.perm).map((w) => [w.id, w.owner, w.x, w.y, w.z, w.yaw, w.hp]),
  };
}

/** one player's authoritative match outcome (placement, stats, time in match) — sent once the squad's outcome is final */
export interface OutcomeState {
  pid: number;
  /** match time when the squad's outcome became final (null = not final yet) */
  outcomeTime: number | null;
  placement: number; totalSquads: number; kills: number; damage: number; winner: boolean; squadOut: boolean;
}
export function outcomeStateFor(m: Match, pid: number): OutcomeState {
  const p = m.players[pid];
  return { pid, outcomeTime: m.teamOutcomeTimes.get(p.team) ?? null, placement: p.placement || (m.phase === 3 ? (m.winnerTeam === p.team ? 1 : 2) : 0),
    totalSquads: m.squadCount, kills: p.kills, damage: p.damage, winner: m.winnerTeam === p.team, squadOut: m.teamsOut.has(p.team) };
}

export interface HostPeer {
  /** seat in the match (-1 = spectator / not seated yet) */
  pid: number;
  /** deliver one binary frame. `u8` is only valid during the call: copy it if the transport queues. */
  send(u8: Uint8Array): void;
  /** the reliable JSON channel: the player's final outcome ({ t: "result" }) — never part of the binary framing */
  sendResult?(state: OutcomeState): void;
  /** inventory frame counter (the client's dedup id) */
  invSeq: number;
  /** last inventory-op seq applied (-1 = none yet; reset whenever the peer is (re)seated) */
  opSeq?: number;
  /** the client's island stream: false = still streaming (it said so), true / undefined = ready (an older client never
   * says; it is never waited for) */
  streamed?: boolean;
  /** a commentator seat (pid stays −1): gets every event, the full-information CastSnap and CastStats */
  caster?: boolean;
}

/** steps one Match and fans its output out to peers; parses + validates inbound binary frames */
export class MatchHost {
  readonly peers: HostPeer[] = [];
  /** fraction of the next tick already elapsed (the pump sets it; pongs report tick + frac) */
  frac = 0;
  private readonly snapW = new Writer(new ArrayBuffer(16384));
  private readonly snapshotBatch = new SnapshotBatch();
  private readonly invW = new Writer(new ArrayBuffer(256));
  private readonly pongW = new Writer(new ArrayBuffer(32));
  private readonly castW = new Writer(new ArrayBuffer(16384)); private readonly castStatW = new Writer(new ArrayBuffer(4096));
  /** the largest frame a client sends: a full input window */
  private readonly inBuf = new Uint8Array(INPUTS_HEAD_BYTES + INPUT_WINDOW * INPUT_BODY_BYTES); private readonly inR = new Reader(this.inBuf);
  private readonly inp = makeInput();
  private readonly deliveredOutcomes = new WeakMap<HostPeer, string>();
  constructor(readonly m: Match) { m.onInventory = (id) => this.sendInventoryTo(id); }
  /** hold the warm-up (3 s before the plane) while a seated peer is still streaming the island in, at most `maxS` */
  holdForStream(maxS = 40) { this.m.holdWarmup = () => this.m.warmHeldS < maxS && this.peers.some((p) => p.pid >= 0 && p.streamed === false); }

  /** one authoritative tick + all outbound traffic of that tick */
  tick() {
    const m = this.m;
    m.step();
    if (!m.ev.empty) { const u8 = m.ev.finish(m.tick); for (const p of this.peers) if (p.pid >= 0 || p.caster) p.send(u8); m.ev.reset(); }
    // after the events: the client may already show its results card from them; this confirms / refreshes its numbers
    for (const peer of this.peers) {
      if (peer.pid < 0 || !peer.sendResult || !m.players[peer.pid]) continue;
      if (!m.teamOutcomeTimes.has(m.players[peer.pid].team)) { this.deliveredOutcomes.delete(peer); continue; }
      const state = outcomeStateFor(m, peer.pid);
      // (a rocket in flight can still award a posthumous kill / damage after the squad's outcome: re-sent on change)
      const summary = JSON.stringify([state.outcomeTime, state.placement, state.totalSquads, state.kills, state.damage, state.winner, state.squadOut]);
      if (this.deliveredOutcomes.get(peer) === summary) continue;
      peer.sendResult(state); this.deliveredOutcomes.set(peer, summary);
    }
    if (m.tick % SNAP_EVERY === 0) {
      this.snapshotBatch.begin(m);
      for (const p of this.peers) if (p.pid >= 0) { writeSnapshotFor(this.snapW, m, p.pid, this.snapshotBatch); p.send(this.snapW.view()); }
      // caster seats: one full-information frame, the same bytes for every seat
      let cast: Uint8Array | null = null;
      for (const p of this.peers) if (p.caster) { cast ??= writeCastSnapshot(this.castW, m, this.snapshotBatch).view(); p.send(cast); }
    }
    if (m.tick % 15 === 0) { let st: Uint8Array | null = null; for (const p of this.peers) if (p.caster) { st ??= writeCastStats(this.castStatW, m).view(); p.send(st); } }
    if (m.tick % 60 === 0) for (const p of this.peers) this.sendInventory(p);
  }
  /** a caster seat joined (now or mid-match): its stats right away instead of within 15 ticks */
  sendCastStats(p: HostPeer) { if (p.caster) p.send(writeCastStats(this.castStatW, this.m).view()); }
  sendInventory(p: HostPeer) {
    if (p.pid < 0 || !this.m.players[p.pid]) return;
    p.invSeq = (p.invSeq + 1) & 0xffff;
    writeInventoryFor(this.invW, this.m, p.pid, p.invSeq); p.send(this.invW.view());
  }
  sendInventoryTo(pid: number) { for (const p of this.peers) if (p.pid === pid) this.sendInventory(p); }

  /**
   * One binary frame from a peer. Returns false if malformed (wrong length / unknown type) — the caller counts strikes.
   * `reply` answers on the socket the frame came from (pongs); it gets a view valid only during the call.
   */
  receive(peer: HostPeer, u8: Uint8Array, reply: (u8: Uint8Array) => void): boolean {
    if (u8.length < 1 || u8.length > this.inBuf.length) return false;
    const type = u8[0];
    if (type === M.Input) {
      if (u8.length !== INPUT_BYTES) return false;
      this.inBuf.set(u8); this.inR.o = 1; readInput(this.inR, this.inp);
      if (peer.pid >= 0) this.m.pushInput(peer.pid, this.inp);
      return true;
    }
    if (type === M.Inputs) {
      const count = u8[1];
      if (count < 1 || count > INPUT_WINDOW || u8.length !== INPUTS_HEAD_BYTES + count * INPUT_BODY_BYTES) return false;
      this.inBuf.set(u8); this.inR.o = 2; const first = this.inR.u32();
      for (let k = 0; k < count; k++) {
        readInputBody(this.inR, this.inp); this.inp.seq = first + k;
        // queued from any entry but the newest: the datagram that carried it as the newest was lost (or late)
        if (peer.pid >= 0 && this.m.pushInput(peer.pid, this.inp) && k < count - 1) this.m.netStats.inputsRecovered++;
      }
      return true;
    }
    if (type === M.InvOp) {
      if (u8.length !== INVOP_BYTES) return false;
      const seq = u8[1] | (u8[2] << 8), last = peer.opSeq ?? -1;
      // both sockets carry every op: apply each seq once, and never an older one that arrives late on the slower socket
      if (last >= 0) { const d = (seq - last) & 0xffff; if (d === 0 || d > 0x8000) return true; }
      peer.opSeq = seq;
      if (peer.pid >= 0) this.m.inventoryOp(peer.pid, u8[3], u8[4], u8[5]);
      return true;
    }
    if (type === M.Ping) {
      if (u8.length !== 9) return false;
      this.inBuf.set(u8); this.inR.o = 1; const ct = this.inR.f64();
      if (!Number.isFinite(ct)) return false;
      this.pongW.reset().u8(M.Pong).f64(ct).f64(this.m.tick + this.frac); reply(this.pongW.view());
      return true;
    }
    return false;
  }
}
