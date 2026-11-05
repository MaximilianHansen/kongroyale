// INSTANT REPLAY for the caster seat. The seat already receives every kong at 20 Hz (CastSnap); this keeps the last
// REC_S seconds of it — every remote's samples, every vehicle's, and the match events with their ticks — and plays any
// window of it back through the SAME renderer at 1× / 0.5× / 0.25×, with every camera still switchable.
//
// How a replay frame draws the past without touching live play:
//   - record() (each frame, before the renderer) copies the new entries of each Remote's / VehRemote's snapshot ring into
//     long typed-array tracks (REC_S × 20 Hz per kong).
//   - begin() swaps a small ring window of RECORDED samples around the replay tick into every remote / vehicle
//     (ring, n, lastTick, extra) and sets ClientMatch.replayTick: the normal interpolate() then blends the past exactly as
//     it blends live data. end() swaps the live rings back right after the renderer's frame, so the snapshots arriving
//     between frames keep landing in the live rings (live data is received AND recorded all through a replay).
//   - events: the seat's sink is wrapped here (sinkFor): every event is recorded with its frame tick (ClientMatch
//     .lastEvTick); while a replay runs the LIVE visual events (shots, hits, blasts, rockets, jumps…) are not drawn — the
//     recorded ones are re-dispatched straight to the renderer at their ticks instead. CasterState never sees a replayed
//     event (the replay calls the raw renderer, not the tee), so nothing is counted twice.
//   - the director waits (Director.paused) and the camera shot from before the replay comes back after it (manual seats).
// Keys (while casting): R = replay what the camera is on (the last REPLAY_S) / back to live, Esc = back to live,
// [ / ] = slower / faster, cameras (1-6, Tab, F …) work as usual during the replay.
import { makePlayerSnap, makeVehSnap, type PlayerSnap, type VehSnap } from "../../../shared/net/proto";
import { MAX_PLAYERS } from "../../../shared/sim/const";
import type { ClientMatch, EventSink } from "../game/client";
import type { GameRender } from "../game/render";
import type { CamShot, CasterRig } from "./rig";
import type { CasterState } from "./state";
import type { Director } from "./director";
import { UI } from "../ui/styles";

/** seconds kept; seconds R replays */
export const REC_S = 90, REPLAY_S = 10;
const HZ = 20, CAP = REC_S * HZ + 40;
/** player sample: tick x y z yaw pitch st bits hp shield held anim seat total */
const PF = 14;
/** vehicle sample: tick x y z yaw pitch roll vf steer hp flags st kind s0 s1 s2 radio gunY gunP gunSpin gunHeat gunBelt gunLock */
const VFN = 24;
const SPEEDS = [0.25, 0.5, 1];
/** events recorded (and replayed); the visual ones are also MUTED live while a replay runs */
const RECORD = new Set(["shot", "hit", "explosion", "rocket", "rocketEnd", "jump", "land", "veh", "vehHit", "bomb", "bombEnd"]);
const MUTE = new Set(["shot", "hit", "explosion", "rocket", "jump", "land", "veh", "vehHit", "bomb"]);

/** a ring of fixed-width float records, oldest first by index */
class Track {
  readonly buf: Float32Array; head = 0; count = 0;
  constructor(readonly f: number) { this.buf = new Float32Array(CAP * f); }
  /** the slot to write the next record into */
  push(): number { const o = this.head * this.f; this.head = (this.head + 1) % CAP; if (this.count < CAP) this.count++; return o; }
  off(i: number) { return ((this.head - this.count + i + CAP) % CAP) * this.f; }
  tick(i: number) { return this.buf[this.off(i)]; }
  /** index of the last record with tick ≤ T (−1 = none) */
  find(T: number): number {
    let lo = 0, hi = this.count - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (this.tick(m) <= T) { r = m; lo = m + 1; } else hi = m - 1; }
    return r;
  }
  reset() { this.head = 0; this.count = 0; }
}

interface RecEvent { tick: number; prop: string; args: unknown[] }
export interface ReplayOpts { from: number; to: number; shot?: Partial<CamShot>; label?: string; speed?: number }

export class Replay {
  active = false; speed = 1; tick = 0; from = 0; to = 0; label = "";
  /** fired when a replay starts / ends (UI, highlights) */
  onChange: ((on: boolean) => void) | null = null;
  private readonly pt: Track[] = []; private readonly vt: Track[] = [];
  private readonly lastN: Int32Array; private readonly lastT: Float64Array; private readonly vLastN: Int32Array; private readonly vLastT: Float64Array;
  private readonly pRings: PlayerSnap[][] = []; private readonly vRings: VehSnap[][] = [];
  private readonly bp: Array<{ ring: PlayerSnap[]; n: number; lastTick: number; extra: number; gap: number; veh: number; seat: number }> = [];
  private readonly bv: Array<{ ring: VehSnap[]; n: number; lastTick: number; extra: number; gap: number; live: boolean; kind: number; radio: number }> = [];
  private events: RecEvent[] = [];
  private evNext = 0;
  private swapped = false;
  private shotBefore: CamShot | null = null; private autoBefore = false; private lineBefore = "";
  private readonly bombs = new Set<number>();
  private ui: { bug: HTMLElement; frame: HTMLElement; bar: HTMLElement; label: HTMLElement; spd: HTMLElement; clock: HTMLElement } | null = null;
  private readonly offs: Array<() => void> = [];

  constructor(readonly cm: ClientMatch, readonly render: GameRender, readonly state: CasterState, readonly rig: CasterRig, readonly director: Director) {
    for (let i = 0; i < MAX_PLAYERS; i++) { this.pt.push(new Track(PF)); this.pRings.push(Array.from({ length: cm.remotes[i]?.ring.length ?? 12 }, makePlayerSnap)); }
    for (let i = 0; i < cm.vehicles.length; i++) { this.vt.push(new Track(VFN)); this.vRings.push(Array.from({ length: cm.vehicles[i].ring.length }, makeVehSnap)); }
    this.lastN = new Int32Array(MAX_PLAYERS); this.lastT = new Float64Array(MAX_PLAYERS).fill(-1);
    this.vLastN = new Int32Array(cm.vehicles.length); this.vLastT = new Float64Array(cm.vehicles.length).fill(-1);
    const onKey = (e: KeyboardEvent) => {
      if (!this.ui || isTyping(e)) return;
      if (e.code === "KeyR" && !e.ctrlKey && !e.metaKey) { if (this.active) this.stop(); else this.replayShot(); e.preventDefault(); }
      else if (e.code === "Escape" && this.active) this.stop();
      else if (e.code === "BracketLeft" && this.active) this.setSpeed(-1);
      else if (e.code === "BracketRight" && this.active) this.setSpeed(1);
    };
    window.addEventListener("keydown", onKey); this.offs.push(() => window.removeEventListener("keydown", onKey));
  }

  /** the replayable window [oldest, newest] (ticks): REC_S back from the newest sample (a kong that died long ago keeps
   *  older samples, but the rest of the island is gone from the tracks by then) */
  span(): [number, number] {
    let lo = Infinity, hi = -Infinity;
    for (const t of this.pt) if (t.count) { lo = Math.min(lo, t.tick(0)); hi = Math.max(hi, t.tick(t.count - 1)); }
    return lo === Infinity ? [0, 0] : [Math.max(lo, hi - (REC_S - 1) * 60), hi];
  }
  /** where each kong last fired from, where each was last hit (event positions: exact, and live even mid-replay) */
  private readonly shotFrom = new Float64Array(MAX_PLAYERS * 4).fill(NaN); private readonly hitAt = new Float64Array(MAX_PLAYERS * 4).fill(NaN);
  /** the distance of a kill (the killer's last muzzle → the victim's last hit), NaN when the events don't say */
  killDistance(killer: number, victim: number): number {
    const a = killer * 4, b = victim * 4, F = this.shotFrom, H = this.hitAt, tick = this.cm.lastEvTick;
    if (!(tick - F[a + 3] < 120) || !(tick - H[b + 3] < 60)) return NaN;
    return Math.hypot(F[a] - H[b], F[a + 1] - H[b + 1], F[a + 2] - H[b + 2]);
  }
  /** the tick live play is drawing now (what "now" means for a replay window) */
  liveTick() { return this.cm.renderTick(); }

  // ---------------------------------------------------------------- recording
  /** copy the newest snapshot entries of every remote / vehicle into the tracks (call every frame, outside begin/end) */
  record() {
    if (this.swapped) return;
    const cm = this.cm;
    if (cm.phase === 0 && this.events.length && this.lastWarm !== true) { /* a new match (warm-up): forget the last one */ this.clear(); }
    this.lastWarm = cm.phase === 0;
    for (let id = 0; id < cm.remotes.length && id < MAX_PLAYERS; id++) {
      const rm = cm.remotes[id], L = rm.ring.length, n = rm.n;
      let k = this.lastN[id]; if (n < k) k = 0; k = Math.max(k, n - L);
      for (; k < n; k++) {
        const s = rm.ring[k % L]; if (s.tick <= this.lastT[id]) continue;
        const tr = this.pt[id], o = tr.push(), B = tr.buf;
        B[o] = s.tick; B[o + 1] = s.x; B[o + 2] = s.y; B[o + 3] = s.z; B[o + 4] = s.yaw; B[o + 5] = s.pitch; B[o + 6] = s.st;
        B[o + 7] = (s.crouch ? 1 : 0) | (s.sprint ? 2 : 0) | (s.swim ? 4 : 0) | (s.grounded ? 8 : 0) | (s.hasHp ? 16 : 0);
        B[o + 8] = s.hp; B[o + 9] = s.shield; B[o + 10] = s.held; B[o + 11] = s.anim; B[o + 12] = s.seat; B[o + 13] = s.total;
        this.lastT[id] = s.tick;
      }
      this.lastN[id] = n;
    }
    for (let id = 0; id < cm.vehicles.length; id++) {
      const vr = cm.vehicles[id], L = vr.ring.length, n = vr.n;
      let k = this.vLastN[id]; if (n < k) k = 0; k = Math.max(k, n - L);
      for (; k < n; k++) {
        const s = vr.ring[k % L]; if (s.tick <= this.vLastT[id]) continue;
        const tr = this.vt[id], o = tr.push(), B = tr.buf;
        B[o] = s.tick; B[o + 1] = s.x; B[o + 2] = s.y; B[o + 3] = s.z; B[o + 4] = s.yaw; B[o + 5] = s.pitch; B[o + 6] = s.roll; B[o + 7] = s.vf; B[o + 8] = s.steer;
        B[o + 9] = s.hp; B[o + 10] = s.flags; B[o + 11] = s.st; B[o + 12] = s.kind; B[o + 13] = s.s0; B[o + 14] = s.s1; B[o + 15] = s.s2; B[o + 16] = s.radio;
        B[o + 17] = s.gunY; B[o + 18] = s.gunP; B[o + 19] = s.gunSpin; B[o + 20] = s.gunHeat; B[o + 21] = s.gunBelt; B[o + 22] = s.gunLock ? 1 : 0; B[o + 23] = s.tyres;
        this.vLastT[id] = s.tick;
      }
      this.vLastN[id] = n;
    }
    // events older than the tracks are useless
    if (this.events.length > 12000) { const drop = this.events.length - 9000; this.events.splice(0, drop); this.evNext = Math.max(0, this.evNext - drop); }
  }
  private lastWarm = false;
  private clear() { if (this.active) this.stop(); for (const t of this.pt) t.reset(); for (const t of this.vt) t.reset(); this.lastT.fill(-1); this.vLastT.fill(-1); this.events = []; this.evNext = 0; }

  /** the seat's event sink: records every visual event with its tick; mutes the live ones while a replay is drawn */
  sinkFor(render: GameRender): EventSink {
    const self = this;
    return new Proxy(render, { get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (typeof v !== "function") return v;
      if (typeof prop !== "string" || !RECORD.has(prop)) return v.bind(target);
      return (...args: unknown[]) => {
        const tick = self.cm.lastEvTick;
        self.events.push({ tick, prop, args });
        if (prop === "shot") { const o = (args[0] as number) * 4; if (o >= 0 && o < self.shotFrom.length) { self.shotFrom[o] = args[2] as number; self.shotFrom[o + 1] = args[3] as number; self.shotFrom[o + 2] = args[4] as number; self.shotFrom[o + 3] = tick; } }
        else if (prop === "hit") { const o = (args[1] as number) * 4; if (o >= 0 && o < self.hitAt.length) { self.hitAt[o] = args[4] as number; self.hitAt[o + 1] = args[5] as number; self.hitAt[o + 2] = args[6] as number; self.hitAt[o + 3] = tick; } }
        if (self.active && MUTE.has(prop)) return;
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    } }) as unknown as EventSink;
  }

  // ---------------------------------------------------------------- playback
  /** R: the last REPLAY_S of whatever the camera is on (the fight's kongs, or the watched kong) */
  replayShot() {
    const live = this.liveTick(), [lo] = this.span();
    const s = this.rig.shot(), f = s.fight >= 0 ? this.state.fight(s.fight) : null;
    const shot: Partial<CamShot> = f ? { mode: "drone", group: f.players.slice(), fight: -1, target: s.target } : { ...s };
    const who = f ? f.where : s.target >= 0 ? this.state.players[s.target]?.name ?? "" : "";
    this.play({ from: Math.max(lo, live - REPLAY_S * 60), to: live - 2, shot, label: who });
  }
  play(o: ReplayOpts) {
    const [lo, hi] = this.span();
    const from = Math.max(lo, o.from), to = Math.min(hi, o.to);
    if (!(to - from > 30)) { this.toast("NOTHING RECORDED THERE YET"); return; }
    if (!this.active) { this.shotBefore = this.rig.shot(); this.autoBefore = this.director.enabled; }
    else this.endBombs();
    this.active = true; this.from = from; this.to = to; this.tick = from; this.label = o.label ?? ""; this.speed = o.speed ?? (this.speed || 1);
    this.evNext = this.firstEvent(from); this.director.paused = true;
    if (o.shot) this.rig.set(o.shot, false);
    // the desk's director line says what is on screen (the director itself waits)
    this.lineBefore = this.director.line; this.director.line = `<i style="color:#ff3b30">REPLAY</i>${this.label ? ` — ${this.label}` : ""}`;
    this.ui?.bug.classList.add("on"); this.ui?.frame.classList.add("on");
    this.onChange?.(true);
  }
  stop() {
    if (!this.active) return;
    this.active = false; this.director.paused = false; this.endBombs(); this.director.line = this.lineBefore;
    // back to live: a hand-driven seat gets its shot back; the autopilot picks up its story
    if (!this.director.enabled && this.shotBefore) this.rig.set(this.shotBefore, false);
    else if (this.director.enabled) { this.director.current = null; }
    this.shotBefore = null;
    this.ui?.bug.classList.remove("on"); this.ui?.frame.classList.remove("on");
    this.onChange?.(false);
  }
  setSpeed(d: number) {
    const i = SPEEDS.indexOf(this.speed); this.speed = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 2 : i) + d))];
  }
  private endBombs() { for (const id of this.bombs) this.render.bombEnd?.(id); this.bombs.clear(); }
  private firstEvent(T: number) { let lo = 0, hi = this.events.length; while (lo < hi) { const m = (lo + hi) >> 1; if (this.events[m].tick <= T) lo = m + 1; else hi = m; } return lo; }

  /** before the renderer's frame: advance the replay clock, fire its events, swap the recorded past in */
  begin(dt: number) {
    if (!this.active) return;
    this.tick += dt * 60 * this.speed;
    if (this.tick >= this.to) { this.stop(); return; }
    const T = this.tick, r = this.render as unknown as Record<string, (...a: unknown[]) => void>;
    while (this.evNext < this.events.length && this.events[this.evNext].tick <= T) {
      const e = this.events[this.evNext++];
      if (e.prop === "bomb") this.bombs.add(e.args[0] as number); else if (e.prop === "bombEnd") this.bombs.delete(e.args[0] as number);
      try { r[e.prop]?.apply(this.render, e.args); } catch { /* a stale FX id: skip */ }
    }
    this.swapIn(T);
  }
  /** right after the renderer's frame: the live rings back */
  end() { if (this.swapped) this.swapOut(); }

  private swapIn(T: number) {
    const cm = this.cm, live = Math.floor(cm.serverTick());
    for (let id = 0; id < cm.remotes.length && id < MAX_PLAYERS; id++) {
      const rm = cm.remotes[id], tr = this.pt[id], ring = this.pRings[id], L = ring.length;
      this.bp[id] = { ring: rm.ring, n: rm.n, lastTick: rm.lastTick, extra: rm.extra, gap: rm.gap, veh: rm.veh, seat: rm.seat };
      let k = 0;
      const j = tr.find(T);
      if (j >= 0) {
        const tj = tr.tick(j), next = j + 1 < tr.count ? tr.tick(j + 1) : Infinity;
        // present at T: a sample within 20 ticks before it, or the next one follows without a gap (it never left)
        if (T - tj <= 20 || next - tj <= 16) {
          const lo = Math.max(0, j - (L >> 1) + 1), hi = Math.min(tr.count - 1, lo + L - 1);
          for (let i = lo; i <= hi; i++) {
            const o = tr.off(i), B = tr.buf, s = ring[k++];
            s.id = id; s.tick = B[o]; s.x = B[o + 1]; s.y = B[o + 2]; s.z = B[o + 3]; s.yaw = B[o + 4]; s.pitch = B[o + 5]; s.st = B[o + 6];
            const b = B[o + 7]; s.crouch = (b & 1) !== 0; s.sprint = (b & 2) !== 0; s.swim = (b & 4) !== 0; s.grounded = (b & 8) !== 0; s.hasHp = (b & 16) !== 0;
            s.hp = B[o + 8]; s.shield = B[o + 9]; s.held = B[o + 10]; s.anim = B[o + 11]; s.seat = B[o + 12]; s.total = B[o + 13]; s.team = rm.team;
          }
        }
      }
      rm.ring = ring; rm.n = k; rm.extra = 0; rm.gap = 3; rm.veh = -1; rm.seat = 0;
      if (k) rm.lastTick = live;
    }
    for (let id = 0; id < cm.vehicles.length; id++) {
      const vr = cm.vehicles[id], tr = this.vt[id], ring = this.vRings[id], L = ring.length;
      this.bv[id] = { ring: vr.ring, n: vr.n, lastTick: vr.lastTick, extra: vr.extra, gap: vr.gap, live: vr.live, kind: vr.kind, radio: vr.radio };
      let k = 0;
      const j = tr.find(T);
      if (j >= 0) {
        const tj = tr.tick(j), next = j + 1 < tr.count ? tr.tick(j + 1) : Infinity;
        // vehicles are refreshed every few snapshots when parked: a wider window of "still there"
        if (T - tj <= 400 || next - tj <= 400) {
          const lo = Math.max(0, j - (L >> 1) + 1), hi = Math.min(tr.count - 1, lo + L - 1);
          for (let i = lo; i <= hi; i++) {
            const o = tr.off(i), B = tr.buf, s = ring[k++];
            s.id = id; s.tick = B[o]; s.x = B[o + 1]; s.y = B[o + 2]; s.z = B[o + 3]; s.yaw = B[o + 4]; s.pitch = B[o + 5]; s.roll = B[o + 6]; s.vf = B[o + 7]; s.steer = B[o + 8];
            s.hp = B[o + 9]; s.flags = B[o + 10]; s.st = B[o + 11]; s.kind = B[o + 12]; s.s0 = B[o + 13]; s.s1 = B[o + 14]; s.s2 = B[o + 15]; s.radio = B[o + 16];
            s.gunY = B[o + 17]; s.gunP = B[o + 18]; s.gunSpin = B[o + 19]; s.gunHeat = B[o + 20]; s.gunBelt = B[o + 21]; s.gunLock = B[o + 22] !== 0; s.tyres = B[o + 23];
          }
          // who sits where at T (the sample at / before T)
          const m = ring[Math.min(k - 1, Math.max(0, j - lo))];
          const seats = [m.s0, m.s1, m.s2];
          seats.forEach((pid, seat) => { const rm = pid >= 0 ? cm.remotes[pid] : null; if (rm) { rm.veh = id; rm.seat = seat; } });
          vr.kind = m.kind; vr.radio = m.radio;
        }
      }
      vr.ring = ring; vr.n = k; vr.extra = 0; vr.gap = 3; vr.live = k > 0; if (k) vr.lastTick = live;
    }
    cm.replayTick = T;
    this.swapped = true;
  }
  private swapOut() {
    const cm = this.cm;
    for (let id = 0; id < this.bp.length; id++) { const rm = cm.remotes[id], b = this.bp[id]; rm.ring = b.ring; rm.n = b.n; rm.lastTick = b.lastTick; rm.extra = b.extra; rm.gap = b.gap; rm.veh = b.veh; rm.seat = b.seat; }
    for (let id = 0; id < this.bv.length; id++) { const vr = cm.vehicles[id], b = this.bv[id]; vr.ring = b.ring; vr.n = b.n; vr.lastTick = b.lastTick; vr.extra = b.extra; vr.gap = b.gap; vr.live = b.live; vr.kind = b.kind; vr.radio = b.radio; }
    cm.replayTick = -1;
    this.swapped = false;
  }

  // ---------------------------------------------------------------- the on-screen bug
  /** the REPLAY bug + frame, inside the desk (they stay on in the clean feed: they are part of the broadcast) */
  attach(deskEl: HTMLElement) {
    if (!cssOn) { const st = document.createElement("style"); st.textContent = REPLAY_CSS; document.head.appendChild(st); cssOn = true; }
    this.ui?.bug.remove(); this.ui?.frame.remove();
    const frame = document.createElement("div"); frame.className = "krp-frame"; deskEl.appendChild(frame);
    const bug = document.createElement("div"); bug.className = "krp-bug";
    bug.innerHTML = `<div class="row"><b><i></i>REPLAY</b><span class="lbl"></span><span class="spd"></span><span class="clk"></span></div><div class="bar"><u></u></div><div class="hint">R / ESC LIVE · [ ] SPEED · 1-6 CAMERAS</div>`;
    deskEl.appendChild(bug);
    bug.addEventListener("click", () => this.stop());
    this.ui = { bug, frame, bar: bug.querySelector("u")!, label: bug.querySelector(".lbl")!, spd: bug.querySelector(".spd")!, clock: bug.querySelector(".clk")! };
  }
  /** the bug's numbers (after the frame) */
  frameUi() {
    const u = this.ui; if (!u || !this.active) return;
    const k = (this.tick - this.from) / Math.max(1, this.to - this.from);
    u.bar.style.width = `${(k * 100).toFixed(1)}%`;
    if (u.label.textContent !== this.label) u.label.textContent = this.label;
    const sp = this.speed === 1 ? "1×" : this.speed === 0.5 ? "½× SLOW-MO" : "¼× SLOW-MO"; if (u.spd.textContent !== sp) u.spd.textContent = sp;
    const ago = Math.max(0, (this.liveTick() - this.tick) / 60), c = `−${Math.floor(ago / 60)}:${String(Math.floor(ago % 60)).padStart(2, "0")}`;
    if (u.clock.textContent !== c) u.clock.textContent = c;
  }
  private toast(text: string) { const t = document.querySelector<HTMLElement>(".kc-toast"); if (t) { t.textContent = text; t.classList.add("on"); setTimeout(() => t.classList.remove("on"), 1500); } }
  dispose() { if (this.active) this.stop(); if (this.swapped) this.swapOut(); for (const f of this.offs) f(); this.offs.length = 0; this.ui?.bug.remove(); this.ui?.frame.remove(); this.ui = null; }
}

let cssOn = false;
const vh = (px: number) => `${(px / 10.8).toFixed(3)}vh`;
const REPLAY_CSS = `
.krp-frame { position: absolute; inset: 0; pointer-events: none; opacity: 0; transition: opacity .25s; box-shadow: inset 0 0 0 ${vh(4)} rgba(255,59,48,.85), inset 0 0 ${vh(140)} rgba(0,0,0,.5); }
.krp-frame.on { opacity: 1; }
.krp-bug { position: absolute; top: ${vh(96)}; left: 50%; transform: translateX(-50%) translateY(-${vh(8)}); opacity: 0; transition: opacity .2s, transform .2s; pointer-events: none;
  min-width: ${vh(430)}; background: rgba(20,6,8,.86); border: 2px solid #ff3b30; border-radius: ${vh(8)}; padding: ${vh(6)} ${vh(12)} ${vh(7)}; font-family: ${UI.cond}; color: #fff; box-shadow: 0 ${vh(8)} ${vh(30)} rgba(0,0,0,.45); }
.krp-bug.on { opacity: 1; transform: translateX(-50%); pointer-events: auto; cursor: pointer; }
.krp-bug .row { display: flex; align-items: center; gap: ${vh(10)}; font-weight: 800; letter-spacing: .08em; }
.krp-bug b { font-size: ${vh(24)}; color: #ff3b30; letter-spacing: .18em; display: flex; align-items: center; gap: ${vh(7)}; }
.krp-bug b i { width: ${vh(13)}; height: ${vh(13)}; border-radius: 50%; background: #ff3b30; animation: krpBlink 1s infinite; }
@keyframes krpBlink { 50% { opacity: .25; } }
.krp-bug .lbl { font-size: ${vh(19)}; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.krp-bug .spd { font-size: ${vh(15)}; color: ${UI.yellow}; } .krp-bug .clk { font-size: ${vh(15)}; color: ${UI.creamDim}; min-width: ${vh(40)}; text-align: right; }
.krp-bug .bar { height: ${vh(4)}; background: rgba(255,255,255,.15); border-radius: ${vh(2)}; margin-top: ${vh(5)}; overflow: hidden; }
.krp-bug .bar u { display: block; height: 100%; width: 0; background: #ff3b30; }
.krp-bug .hint { font-size: ${vh(11.5)}; letter-spacing: .16em; color: ${UI.creamDim}; margin-top: ${vh(4)}; font-weight: 700; }
.kc.clean .krp-bug .hint { display: none; }
`;

function isTyping(e: Event) { const t = e.target as HTMLElement | null; return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable); }
