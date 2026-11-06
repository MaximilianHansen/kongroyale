// Links: the same interface for a WebSocket to the Node server and for the in-browser offline host.
//
// Redundant transport: a WebSocket is TCP, so ONE lost packet stalls everything behind it for ~RTT + 50 ms (head-of-line
// blocking). After the server's "welcome" (which carries an aux token) we open a second socket; every binary frame
// (inputs up; snapshots, events, inventory, pongs down) travels on both, and both ends keep the first copy (inputs by
// seq, snapshots/events by tick, inventory by seq, pongs by timestamp). A stall now needs both sockets to lose a packet
// at the same moment. JSON (lobby) stays on the primary. Disable with ?aux=0 on the page URL.
import { DT } from "../../../shared/sim/const";
import { Match, type MatchOpts } from "../../../shared/sim/match";
import type { BotDifficulty } from "../ui/api";
import type { StaticWorld } from "../../../shared/sim/world";
import { MatchHost, matchInfo, type HostPeer } from "../../../shared/net/host";
import { flag } from "../flags";
import { ReplayRecorder, packLog } from "../../../shared/net/replay";

export interface Link {
  readonly offline: boolean;
  onJSON: (m: Record<string, unknown>) => void;
  /** `at` = arrival time (MessageEvent.timeStamp on the performance.now() clock), when the transport knows it */
  onBinary: (u8: Uint8Array, at?: number) => void;
  onClose: (reason: string) => void;
  sendJSON(o: unknown): void;
  sendBinary(u8: Uint8Array): void;
  close(): void;
  /** local-only: drive the offline host (called from the frame loop) */
  pump?(): void;
}

const auxWanted = () => flag("aux");
/** a STALLED link — nothing at all from the server for this long (a match sends 30 snapshots + a pong a second)
 *  — takes no more binary frames until something arrives again. Inputs queued behind a dead TCP link came out as one burst
 *  when it recovered (60 a second of stall, on each socket) and tripped the server's per-socket rate limit: strikes, then
 *  the socket was closed. The server keeps ≤ 64 queued inputs (~1 s) anyway; the burst is now ≤ ~3 s of them. */
const STALL_MS = 3000;

export function connectWs(url: string, timeoutMs = 4000): Promise<Link> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); ws.binaryType = "arraybuffer";
    let opened = false, closed = false, aux: WebSocket | null = null, lastRx = performance.now();
    const link: Link = {
      offline: false, onJSON: () => {}, onBinary: () => {}, onClose: () => {},
      sendJSON: (o) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); },
      // WebSocket.send copies the bytes, so views over reused buffers are safe here
      sendBinary: (u8) => { if (performance.now() - lastRx > STALL_MS) return; if (ws.readyState === WebSocket.OPEN) ws.send(u8); if (aux && aux.readyState === WebSocket.OPEN) aux.send(u8); },
      close: () => { closed = true; aux?.close(); ws.close(); },
    };
    const openAux = (token: string) => {
      if (aux || closed || !auxWanted()) return;
      // (admin lobby) the token is the aux socket's FIRST message, never in its URL (URLs reach access logs)
      const u = new URL(url, location.href); u.searchParams.set("attach", "1");
      const a = new WebSocket(u.toString()); a.binaryType = "arraybuffer";
      a.onopen = () => a.send(JSON.stringify({ t: "aux", token }));
      a.onmessage = (e) => { lastRx = performance.now(); if (typeof e.data !== "string") link.onBinary(new Uint8Array(e.data as ArrayBuffer), e.timeStamp); };
      a.onclose = () => { if (aux === a) aux = null; };
      a.onerror = () => { /* the primary keeps working alone */ };
      aux = a;
    };
    const t = setTimeout(() => { if (!opened) { ws.close(); reject(new Error("timeout")); } }, timeoutMs);
    ws.onopen = () => { opened = true; clearTimeout(t); resolve(link); };
    ws.onerror = () => { if (!opened) { clearTimeout(t); reject(new Error("connect failed")); } };
    ws.onclose = (e) => { aux?.close(); if (opened) link.onClose(e.reason || "disconnected"); };
    ws.onmessage = (e) => {
      lastRx = performance.now();
      if (typeof e.data === "string") {
        let m: Record<string, unknown>; try { m = JSON.parse(e.data); } catch { return; }
        if (m.t === "welcome" && typeof m.aux === "string") openAux(m.aux);
        link.onJSON(m);
      } else link.onBinary(new Uint8Array(e.data as ArrayBuffer), e.timeStamp);
    };
  });
}

/** Offline practice: the authoritative Match runs in this tab through the same MatchHost as the Node server. */
export class OfflineLink implements Link {
  readonly offline = true;
  onJSON: (m: Record<string, unknown>) => void = () => {};
  onBinary: (u8: Uint8Array, at?: number) => void = () => {};
  onClose: (reason: string) => void = () => {};
  match: Match | null = null; private host: MatchHost | null = null;
  private acc = 0; private last = performance.now(); private timer = 0;
  // frames are stamped with the HOST's clock (the ideal time of the tick that produced them), not the time this pump
  // happened to run: a practice match has no network, so the client's jitter buffer must see none (bursts of
  // catch-up ticks after hitches read as 200+ ms of jitter and pinned the interpolation delay at its cap)
  private stamp = 0;
  private readonly peer: HostPeer = { pid: 0, invSeq: 0, send: (u8) => this.onBinary(u8.slice(), this.stamp), sendResult: (state) => this.emit({ t: "result", state }) };
  private seed = (Math.random() * 2 ** 31) | 0;
  private queued: Array<() => void> = [];
  /** closed once, for good: no more sends, pumps or queued events (a stale session must never reach the game) */
  private closed = false;
  /** `caster`: a local exhibition — 50 bots and no player of ours; this tab watches through a commentator seat
   *  (client/src/caster), fed the same CastSnap / CastStats frames as a seat on the server */
  constructor(private world: StaticWorld, private name: string, private botDamageToHumans = 1, private botAimRange = Infinity, private range = false, private difficulty: BotDifficulty = "standard", readonly caster = false) {
    if (caster) { this.peer.pid = -1; this.peer.caster = true; }
  }
  /** the lobby message this tab sees: its one player, or (caster) its one seat */
  private room(mode: string, inMatch: boolean, pid = 0) {
    return this.caster
      ? { t: "lobby", code: "LOCAL", mode, host: 1, inMatch, phase: -1, players: [], casters: [{ id: 1, name: this.name, seat: 0, host: true }], exhibit: true, auto: false }
      : { t: "lobby", code: "SOLO", mode, host: 1, inMatch, phase: -1, players: [{ id: 1, name: this.name, squad: 0, pid, host: true }] };
  }
  private emit(o: unknown) { const s = JSON.stringify(o); this.queued.push(() => this.onJSON(JSON.parse(s))); }
  sendJSON(o: unknown) {
    if (this.closed) return;
    const m = o as { t: string; mode?: string; name?: string };
    switch (m.t) {
      case "hello": this.name = String(m.name || "KONG"); break;
      case "mode": this.mode = m.mode === "trios" ? "trios" : "solo"; this.emit(this.room(this.mode, !!this.match)); break;
      case "create": case "practice": case "exhibit": {
        const mode = m.mode === "trios" ? "trios" : "solo"; this.mode = mode;
        this.emit(this.room(mode, false));
        break;
      }
      case "start": {
        if (this.match) { this.match.startNow(); break; }
        const mode = (m.mode === "trios" ? "trios" : "solo");
        // ?seed=N (dev / tools): a reproducible practice match (same plane line, storm plan, loot)
        const fixed = flag("seed");
        this.seed = fixed > 0 ? fixed | 0 : (Math.random() * 2 ** 31) | 0; this.mode = mode;
        // botDifficulty: the practice tier the Match gives its bots (EASY, STANDARD = full-strength bots, HARD)
        const opts: MatchOpts & { botDifficulty: BotDifficulty } = { seed: this.seed, mode: this.range ? "solo" : mode, world: this.world, humans: this.caster ? [] : [{ id: 0, name: this.name, team: 0 }], botDamageToHumans: this.botDamageToHumans, botAimRange: this.botAimRange, botDifficulty: this.difficulty, range: this.range };
        const match = this.match = new Match(opts);
        match.endAfterResults = true;
        if ((globalThis as { __kr?: { recordReplay?: boolean } }).__kr?.recordReplay) {
          const { world: _world, ...recOpts } = opts;
          const rec = match.rec = new ReplayRecorder(recOpts);
          this.setReplay(() => packLog(rec.log(match)));
        }
        const host = this.host = new MatchHost(match); host.peers.push(this.peer); host.holdForStream();
        match.onPhase = (ph) => this.emit({ t: "phase", phase: ph, plane: match.plane, time: match.time, tick: match.tick, plan: match.plan });
        this.emit(this.caster ? { ...matchInfo(match, this.seed, {}), caster: true, seat: 0 } : matchInfo(match, this.seed, { 1: 0 }));
        this.queued.push(() => { if (this.caster) host.sendCastStats(this.peer); else host.sendInventory(this.peer); });
        this.last = performance.now(); this.acc = 0;
        this.timer = window.setInterval(() => this.pump(), 8);
        break;
      }
      case "leave": this.close(); break;
    }
  }
  sendBinary(u8: Uint8Array) { if (this.closed) return; this.host?.receive(this.peer, u8, (r) => this.onBinary(r.slice())); }
  pump() {
    if (this.closed) return;
    // the warm-up waits for this tab's island stream (MatchHost.holdForStream)
    this.peer.streamed = (globalThis as { __kr?: { streamed?: boolean } }).__kr?.streamed !== false;
    while (!this.closed && this.queued.length) this.queued.shift()!();
    const h = this.host; if (!h) return;
    const now = performance.now();
    this.acc += Math.min(0.25, (now - this.last) / 1000); this.last = now;
    let n = 0;
    while (this.acc >= DT && n++ < 8) {
      this.acc -= DT; this.stamp = now - this.acc * 1000; h.tick();
      if (h.m.over) {
        // results done: back to the practice room (START again, switch mode, or LEAVE)
        if (this.timer) clearInterval(this.timer); this.timer = 0; this.match = null; this.host = null; this.setReplay(undefined);
        this.emit(this.room(this.mode, false, -1));
        return;
      }
    }
    h.frac = this.acc / DT; this.stamp = 0;
  }
  private mode: "solo" | "trios" = "solo";
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = 0; this.match = null; this.host = null; this.queued.length = 0; this.setReplay(undefined);
    this.onClose("left");
  }
  private setReplay(log: (() => unknown) | undefined) {
    const kr = (globalThis as { __kr?: Record<string, unknown> }).__kr;
    if (kr) kr.replayLog = log;
  }
}
