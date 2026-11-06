// KONG ROYALE audio engine — implements the GameAudio contract (./api.ts).
//
// Sample-based, layered, spatial. Every Sfx is an EventDef in ./bank.ts: round-robin variants + random pitch/gain so no
// two shots are identical; distance crossfades (body → tail → far report), speed-of-sound delay, air absorption,
// occlusion + echoes computed against the real heightfield and POI colliders (./world.ts), HRTF panning, a ducking
// mix bus with a glue compressor + look-ahead limiter (./mixer.ts), and biome ambience beds with directional surf
// (./ambience.ts).
//
//   const audio = createAudio();                    // starts fetching/decoding immediately (context suspended)
//   button.onclick = () => audio.unlock();          // resume on a user gesture (required by browsers)
//   audio.play("fire:ar");                          // YOUR gun (no pos → first person)
//   audio.play("fire:ar", { pos: [x, y, z] });       // someone else's gun
//   audio.play("chest:hum", { pos, loopId: "chest:17" }); audio.stopLoop("chest:17");
//   audio.play("heal:use", { dur: 5.5, item: "leaf-bundle", loopId: "use" }); audio.stopLoop("use") // cancel
//   each frame: audio.update(dt, { pos, fwd, up }, { biome, indoors, inStorm, altitude, storm: { x, z, r } });
//
// Real-time rules: one blast = one voice (burst merge), voice stealing by priority (your own sounds and the 4
// nearest shooters are never stolen; quiet far tails go first), echoes capped, every expensive world query cached and the
// listener-independent echo analysis done off the hot path (world.work() inside update()).
import type { GameAudio, PlayOpts, Sfx, StormCircle } from "./api";
import type { Terrain } from "../../../shared/world/terrain";
import type { Box } from "../../../shared/world/colliders";
import { CONSUMABLES, WEAPONS } from "../../../shared/world/map";
import { Library, type ManifestFile } from "./loader";
import { Mixer, antiImage, BUS_DB, type Bus } from "./mixer";
import { Radio } from "./radio";
import { BANK, ALIAS, RELOAD_S, DROP_GROUPS, HELI_GUN_GROUPS, loadPriority, decodeRate, lazyGroup, prefetchGroup, type EventDef, type Layer } from "./bank";
import { AcousticWorld, trim, type V3 } from "./world";
import { SurfSync, type WaterLike } from "./surf";
import { Ambience } from "./ambience";
import { StepCadence, loadFloorMap, loadRoomsMap, stepSurfaceAt, stepSurfaceUnderLive, type RayWorld } from "./steps";
import { setT } from "./param";
import { flag } from "../flags";
import { lowMemSaver } from "../low-mem-device";
import { GameBridge } from "./bridge";
import { FootDriver, type FootEvent } from "./feet";

/** leaving a match frees the decoded sound of every loaded on-demand group (?audioevict; on by default on low-memory
 *  devices, low-mem-device.ts): the next match decodes what it plays again */
const AUDIO_EVICT = lowMemSaver(flag("audioevict"));

export interface AudioOptions {
  /** render into this context (OfflineAudioContext for the audition tool) instead of a live one */
  context?: BaseAudioContext;
  /** where manifest.json + files live (default `${BASE_URL}assets/audio/kr/`) */
  base?: string;
  terrain?: Terrain | null;
  colliders?: Box[];
  seed?: number;
  /** false = don't start the ambience system (audition of single sounds) */
  ambience?: boolean;
  /** (tools: the surf timing check): only the surf sync runs — no beds, no sprinkles, full surf weight */
  surfSolo?: boolean;
}

export interface AudioStats {
  state: string; sampleRate: number; baseLatencyMs: number; outputLatencyMs: number; codec: string;
  loaded: number; total: number; failed: number; voices: number; loops: number; played: number; culled: number;
  lastPlayCostUs: number; boxes: number; limiterGrDb: number; limiterGrMaxDb: number; worklet: boolean;
  /** echoes triggered, auto-footsteps played, listener enclosure (0 outdoors .. 1 in a room), auto-steps on */
  echoes: number; autoSteps: number; indoor: number; autoStepsOn: boolean;
  /** burst-merged triggers, voices stolen / newcomers dropped by the priority allocator, max play() cost, the
   * off-hot-path echo analysis (cells built, last slice ms), storm wall (distance to the wall m, <0 = safe side) */
  merged: number; stolen: number; dropped: number; maxPlayCostUs: number; cellsBuilt: number; workMs: number; stormWall: number | null;
  /** ambience one-shots played per group (level at the listener, dB, of the last one) */
  sprinkles: Record<string, [number, number]>;
  /** gameplay bridge — sounds it voiced, and the parts still bridged; decoded PCM (MB) */
  bridged: number; bridgeOn: string; pcmMB: number;
  /** your reload sounds — started (= sim reload starts), gameplay calls de-duplicated, starts the edge
   * detector voiced itself, gameplay calls; the start log [audio time, weapon, "edge" | "call"] */
  reload: { started: number; deduped: number; bridged: number; calls: number }; reloads: [number, string, string][];
  /** ms from createAudio to the boot set / the whole library decoded; the slowest play() calls [ms, sfx, frame] */
  bootMs: number; loadMs: number; slow: [number, string, number][];
  /** foot-plant driven steps (feet.ts) — driver live, plants voiced (yours / others'), the last plants
   * [audio time, gait, local, lead s] and the last steps actually played [audio start, sample group, local] */
  feet: { active: boolean; local: number; remote: number; log: { t: number; kind: string; local: boolean; lead: number }[]; played: [number, string, boolean][];
    /** crowd feet: kongs moving within 20 m (teammates half), kongs whose feet are voiced (≤ 3), the dB on others'
     * feet (crowd dip + warm-up), how much their steps may still duck the beds (0..1) */
    crowd: number; voiced: number; othersDb: number; bedDuck: number };
}

export interface KongAudio extends GameAudio {
  readonly ctx: BaseAudioContext;
  readonly lib: Library;
  readonly mixer: Mixer;
  readonly world: AcousticWorld;
  readonly ambience: Ambience;
  /** resolves when every file is decoded */
  readonly ready: Promise<void>;
  setWorld(terrain: Terrain | null, colliders?: Box[]): void;
  stats(): AudioStats;
  /** internal events too (e.g. "fx:tinnitus", "ui:countdown-go") */
  playEvent(name: string, o?: PlayOpts): void;
  /** current listener (after the last update) */
  readonly listener: { pos: V3; fwd: V3; up: V3; vel: V3; speed: number };
  /** dev: set to {} to collect the worst ms per update() section */
  prof: Record<string, number> | null;
}

type Env = { biome: number; indoors: boolean; inStorm: boolean; altitude: number; storm?: StormCircle | null; underwater?: boolean };

const dbg = (db: number) => Math.pow(10, db / 20);
const NOLAP = (_k: string) => {};
/** the loudest layer offset of an event (incl. loudness matching) — for culling before any world query */
const LMAX = new WeakMap<EventDef, number>();
const HALF_PI = Math.PI / 2;
/** inside-the-storm roar level vs the wall emitter at its reference distance (calibrated: 10 m inside ≈ 5 m outside) */
const STORM_INNER = 1.4;
/** remote one-shots nearer than this (m) are voiced synchronously in play(); only farther ones are queued */
const NEAR_SYNC = 60;
/** the plane ride mix (you aboard, the chase camera orbiting): cabin layers + the exterior drone, linear gains —
 * tuned so the ride sits at -21..-23 LUFS with ≤ -6 dBTP and the GO / RAMP cues ≥ 8 dB over it in 1-5 kHz */
const RIDE_CABIN = 0.63;   // (-2 dB: the drop's winds / cabin sit under the canopy snap and the landing)
const RIDE_EXT = 0.2;
/** far (equal-power) voices — the unpanned crosstalk share that reaches both ears (lateral ILD ≈ 18 dB) and the
 * panned path's trim that keeps the level where it was (front: 0.87·(0.707 + 0.14) ≈ 0.707) */
const XT_GAIN = 0.14;
const XT_NORM = 0.87;
/** the loudest an ambience one-shot may peak at the listener (dBFS) — beds and their events stay well under the fight */
const AMB_PEAK = -20.5;
/** the fight library waits for the game's ready flag at most this long (s) */
const BOOT_DEFER_MAX = 60;
/** a second local reload request within this many seconds of a reload start is the same reload */
const RELOAD_DEDUP = 0.15;
const STORM_GROUPS = ["storm/wall", "storm/wall-b", "storm/wall-c", "storm/shear", "storm/crackle"];

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

interface Voice {
  nodes: AudioNode[]; srcs: AudioBufferSourceNode[]; end: number; group: string; start: number; out: GainNode; emitter?: string;
  /** yours (no pos): never stolen by other sounds */
  local: boolean;
  /** level at the listener when triggered (dB, after distance / occlusion) + priority — the stealing score */
  db: number; prio: number; dist: number;
}
/** one gun: where it last fired from (remote shooters are matched by weapon + proximity) */
interface Emitter { key: string; name: string; pos: V3 | null; t: number }
interface LoopVoice {
  name: string; def: EventDef; out: GainNode; lp: BiquadFilterNode; panner?: PannerNode; srcs: AudioBufferSourceNode[];
  /** dual loops (plane cabin/flyover, storm inside/wall): near layers → inner (2D), far layers → outer → air LP → panner */
  inner?: GainNode; outer?: GainNode; outerLp?: BiquadFilterNode; pos?: V3;
  /** (storm wall): a 1 kHz presence on the far band that grows with distance — the wall's shear carries over the beds */
  farPk?: BiquadFilterNode;
  /** (storm wall): the inside roar's HDR duck — it dips under an enemy's feet / gunfire near you */
  duck?: GainNode; vol: number; rate: number; local: boolean; occ: number; lastOcc: number;
  prevDist?: number; stopping?: boolean; nextSpr: number; extra: AudioNode[];
  /** (plane): how much you are RIDING it (0..1, smoothed) — see updateLoop */
  ride?: number;
  /** library groups it plays (lazy ones are released a while after the loop stops) */
  groups: string[];
  /** layers whose level wanders (Layer.drift): gain node, base gain, ± dB, seconds to the next target */
  drift: { g: GainNode; base: number; db: number; next: number }[];
  /** layers that re-seek (Layer.shuffle): every few seconds a fresh source at a random point of the loop crossfades
   * in over the old one — a loop with a strong envelope (the chest hum's swells) then has no period at all */
  shuf: { buf: AudioBuffer; lp: [number, number]; gn: GainNode; src: AudioBufferSourceNode; fader: GainNode; next: number; every: [number, number] }[];
  /** layers whose level follows your speed / turn rate (Layer.speed / Layer.turn) */
  ctl?: { g: GainNode; L: Layer }[];
  /** (bay): how open the ramp is (0..1, smoothed) */
  open?: number;
}
/** a layer's dB at x on a [x0, x1, dB0, dB1] ramp (clamped) */
const ramp4 = (x: number, r: [number, number, number, number]) => r[2] + (r[3] - r[2]) * Math.min(1, Math.max(0, (x - r[0]) / (r[1] - r[0])));
/** equal-power crossfade curves (shared) */
const XF_IN = new Float32Array(33).map((_, i) => Math.sin((i / 32) * HALF_PI));
const XF_OUT = new Float32Array(33).map((_, i) => Math.cos((i / 32) * HALF_PI));
/** heal / shield use in progress: start cue + loop until `end`, completion cue scheduled at `end` */
interface UseSession { id: string; kind: "heal" | "shield"; t0: number; end: number; out: GainNode; srcs: AudioBufferSourceNode[]; nodes: AudioNode[]; bridged: boolean; local: boolean }

class Engine implements KongAudio {
  readonly ctx: BaseAudioContext;
  radio: Radio | null = null;
  readonly lib: Library;
  readonly mixer: Mixer;
  readonly world: AcousticWorld;
  readonly ambience: Ambience;
  readonly ready: Promise<void>;
  readonly listener = { pos: [0, 0, 0] as V3, fwd: [0, 0, -1] as V3, up: [0, 1, 0] as V3, vel: [0, 0, 0] as V3, speed: 0 };
  private voices: Voice[] = [];
  private loops = new Map<string, LoopVoice>();
  private pendingLoops = new Map<string, { name: string; o: PlayOpts }>();
  private lastTrig = new Map<string, number>();
  private recent: { k: string; t: number; x: number; y: number; z: number; local: boolean }[] = [];
  private warned = new Set<string>();
  private seed: number;
  private played = 0;
  private culled = 0;
  private merged = 0;
  private stolen = 0;
  private dropped = 0;
  private lastCost = 0;
  private maxCost = 0;
  private loopTick = 0;
  private live: boolean;
  private env: Env = { biome: 0, indoors: false, inStorm: false, altitude: 0 };
  private indoorS = 0;
  /** enclosure of the listener measured from the colliders (roof + walls), when gameplay doesn't say */
  private autoIndoor = 0;
  private encT = 0;
  private emitters: Emitter[] = [];
  private emitterSeq = 0;
  private echoCount = 0;
  private autoStepCount = 0;
  // auto footsteps (local player) until gameplay starts sending its own `step:*` (then they switch off for good)
  private autoSteps = true;
  private stepsSuspended = false;
  private cadence = new StepCadence();
  /** every footstep (yours on the view-bob troughs, others' on the kong rig's foot plants) — feet.ts */
  readonly feet = new FootDriver((e) => this.footEvent(e));
  private lastGround: { y: number; surf: string } | null = null;
  private groundT = 0;
  private uses = new Map<string, UseSession>();
  private tagged = new Map<string, Voice>();
  /** your reload in progress (bridge: cut it when the sim cancels the reload) */
  private localReload: { v: Voice; t0: number; end: number } | null = null;
  /** storm wall: signed distance of the listener to the wall (m, > 0 = inside the storm), null = no storm known */
  private stormD: number | null = null;
  private stormIn = 0;
  private frame = 0;
  /** closeness of the listener's surroundings (0 open beach … 1 valley / canyon), from the echo analysis */
  private openS = 0.5;
  private lastOwnShot = -1;
  private tmpA: V3 = [0, 0, 0];
  /** the local player left the plane this ride (jump:exit / freefall / glider / landing) — the ride mix ends */
  private planeExit = false;
  private planeActive = false;
  /** surf crashes / laps on the water's own breaker phase */
  readonly surf: SurfSync;
  /** how far under water the camera is (0..1, smoothed) — muffles the world, the underwater bed rises */
  private uwK = 0;
  private uwBed: { gain: GainNode; stop(): void } | null = null;
  private waterRef: WaterLike | undefined;
  private waterRefT = -1;
  /** (the drop): the cargo ramp is open this ride (plane:ramp heard) — the bay wind joins the cabin */
  private rampOpen = false;
  /** how fast you are turning (rad/s of the view's yaw, smoothed) — the glider's fabric flutters in a turn */
  private turnRate = 0;
  private yawPrev = NaN;

  constructor(o: AudioOptions = {}) {
    // live = a real-time context (the game, or a test page passing its own AudioContext); offline renders (the audition
    // tool's OfflineAudioContext) run every slow job inline and load the whole library up front
    const Off = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    this.live = !o.context || !(Off && o.context instanceof Off);
    this.ctx = o.context ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)({ latencyHint: "interactive" });
    this.seed = (o.seed ?? (Math.random() * 2 ** 31)) >>> 0;
    this.ambSeed = (this.seed ^ 0x9e3779b9) >>> 0;
    const base = o.base ?? `${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/"}assets/audio/kr/`;
    this.lib = new Library(this.ctx, base);
    if (this.live) { loadFloorMap(base); loadRoomsMap(base); }   // the drawn-floor + rooms maps (steps.ts), in the background
    this.mixer = new Mixer(this.ctx);
    // the tuk-tuk radio (radio.ts): streamed stations, nothing loads until a tuk-tuk tunes in
    if (this.live) this.radio = new Radio(this.ctx as AudioContext, base, this.mixer.master, this.mixer.buses.world, this.lib, this.lib.ext);
    const kr = (globalThis as unknown as { __kr?: { engine?: { terrain?: Terrain } } }).__kr;
    this.world = new AcousticWorld(o.terrain ?? kr?.engine?.terrain ?? null, o.colliders ?? []);
    if (!o.colliders) {
      import("../../../shared/pois/index").then((m) => this.world.setBoxes(m.allColliders())).catch(() => {});
    }
    this.ambience = new Ambience(this, o.ambience !== false && !o.surfSolo);
    // the breakers you hear are the ones the water draws (surf.ts) — only with the ambience on
    const eng = this;
    this.surf = new SurfSync({
      ctx: this.ctx, listener: this.listener, live: this.live,
      height: (x, z) => this.world.terrain ? this.world.terrain.height(x, z) : null,
      water: () => eng.waterApi(),
      surfWeight: () => (o.surfSolo ? 1 : o.ambience === false ? 0 : Math.max(this.ambience.weights.surf ?? 0, this.surf?.nearK ?? 0) * (1 - this.indoorS) * (this.uwK > 0.5 ? 0 : 1)),
      surfShot: (g, pos, db, when, ref) => this.surfShot(g, pos, db, when, ref),
    });
    // bridge (live): other players' reloads / heals / jumps / gliders / crouch steps + your pickups' rarity, until gameplay
    // makes those calls itself (see bridge.ts)
    if (this.live) this.bridge = new GameBridge((n, q) => this.playEvent(n, q), (tier) => this.oneShot(`loot/rarity-${Math.min(4, tier)}`, "p1", -12, this.ctx.currentTime + 0.03), (id) => this.stopLoop(id));
    // live: the long ambience beds decode on demand around you and are released when you leave (≈ 330 MB of PCM if all
    // were resident); offline renders (the audition tool) load everything up front
    // (+ the storm, the drop's winds and rare one-shots; long loops / beds / dark distant layers decode at 24-32 kHz)
    const lazy = this.live ? lazyGroup : undefined;
    this.lib.rateFor = decodeRate;
    // the library does not compete with the world for the loading screen. Only
    // what the title / lobby needs (UI, the plane, hit confirms) loads during boot; the ~700 fight / foley files start the
    // moment the game is ready (`__kr.ready`, or after BOOT_DEFER_MAX s) — a live context only (offline renders load all)
    const bootSet = (id: string) => id.startsWith("ui/") || id.startsWith("hit/") || /^air\/(plane|rattle)/.test(id);
    const deferred = this.live && typeof window !== "undefined" && !!(globalThis as unknown as { __kr?: unknown }).__kr;
    this.ready = Promise.all([this.mixer.ready, this.lib.loadManifest()])
      .then(() => deferred ? this.lib.loadAll(loadPriority, 6, lazy, prefetchGroup, bootSet) : undefined)
      .then(() => deferred ? this.gameReady() : undefined)
      .then(() => { this.bootMs = Math.round(performance.now() - this.t0); return this.lib.loadAll(loadPriority, 10, lazy, prefetchGroup); })
      .then(() => {
        this.loadMs = Math.round(performance.now() - this.t0);
        this.retryPending();
        this.warm();
      });
    if (this.live && typeof document !== "undefined") {
      // some browsers suspend on interruption (calls, bluetooth switch): resume on the next gesture
      const kick = () => { if (this.ctx.state !== "running") (this.ctx as AudioContext).resume?.().catch(() => {}); };
      addEventListener("pointerdown", kick, { capture: true });
      addEventListener("keydown", kick, { capture: true });
    }
  }

  /** boot timing (ms from createAudio): the boot set decoded / the full library decoded */
  private t0 = typeof performance !== "undefined" ? performance.now() : 0;
  private bootMs = 0;
  private loadMs = 0;
  /** resolves when the game says it is ready (the title is playable), or after BOOT_DEFER_MAX s */
  private gameReady(): Promise<void> {
    return new Promise((res) => {
      const t0 = performance.now();
      const poll = () => {
        const kr = (globalThis as unknown as { __kr?: { ready?: boolean } }).__kr;
        if (kr?.ready || performance.now() - t0 > BOOT_DEFER_MAX * 1000) res();
        else setTimeout(poll, 150);
      };
      poll();
    });
  }

  // ------------------------------------------------------------------ contract
  async unlock(): Promise<void> {
    const c = this.ctx as AudioContext;
    if (c.state !== "running" && c.resume) await c.resume().catch(() => {});
    // iOS: play one silent buffer inside the gesture
    const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.ctx.destination); s.start();
  }

  play(s: Sfx, o: PlayOpts = {}): void { this.playEvent(s, o); }

  stopLoop(loopId: string): void {
    const pend = this.pendingLoops.get(loopId);
    if (pend) {
      this.pendingLoops.delete(loopId);
      const now = this.ctx.currentTime;
      this.idleUnused((BANK[pend.name]?.layers ?? []).map((L) => this.grp(L.g)).filter((g): g is string => !!g), now);
      if (pend.name === "heli:rotor") this.idleUnused(HELI_GUN_GROUPS, now);
    }
    const u = this.uses.get(loopId);
    if (u) { this.endUse(u, false); return; }
    const tv = this.tagged.get(loopId);
    if (tv) { this.tagged.delete(loopId); if (tv.end > this.ctx.currentTime) this.fadeOut(tv, 0.06); return; }
    const l = this.loops.get(loopId);
    if (!l || l.stopping) return;
    l.stopping = true;
    if (l.def.loop === "plane") { this.planeActive = false; this.rampOpen = false; if (loopId !== "plane:bay") this.stopLoop("plane:bay"); }
    const t = this.ctx.currentTime;
    l.out.gain.cancelScheduledValues(t);
    l.out.gain.setValueAtTime(l.out.gain.value, t);
    l.out.gain.setTargetAtTime(0, t, 0.08);
    for (const s of l.srcs) { try { s.stop(t + 0.5); } catch { /* */ } }
    // a restart of the same loopId replaces the map entry: this fading voice keeps fading and is freed on its own
    setTimeoutSafe(() => { if (this.loops.get(loopId) === l) this.loops.delete(loopId); this.disconnectLoop(l); }, 600, this.live);
  }

  /** leaving the match (to the title / lobby): only the match's
   *  render calls update(), so without this every bed / loop would freeze at its last gain and keep playing under the title */
  endSession(): void {
    this.sessionOff = true;
    for (const id of [...this.loops.keys()]) this.stopLoop(id);
    for (const id of [...this.uses.keys()]) this.stopLoop(id);
    for (const id of [...this.tagged.keys()]) this.stopLoop(id);
    this.pendingLoops.clear(); this.stormStart = null; this.echoJobs.length = 0; this.qHead = this.queue.length;
    this.planeActive = false; this.rampOpen = false; this.planeExit = false; this.stormD = null; this.stormIn = 0; this.localReload = null;
    this.ambience.stopAll();
    if (this.uwBed) { this.uwBed.stop(); this.uwBed = null; } this.uwK = 0;
    const t = this.ctx.currentTime;
    for (const v of this.voices) if (v.end > t && !v.group.startsWith("ui/")) this.fadeOut(v, 0.15);
    if (AUDIO_EVICT) { this.lib.releaseLoaded(prefetchGroup); this.dropWanted = false; this.stormFetched = false; }
  }
  /** endSession() ran and no match update() since: the idle slice starts nothing */
  private sessionOff = false;

  setMaster(v: number): void { this.mixer.setMaster(v); }
  setDynamicRange(profile: "full" | "reduced"): void { this.mixer.setDynamicRange(profile); }
  setMix(levels: { combat: number; ui: number; ambience: number }): void { this.mixer.setMix(levels); }

  update(dt: number, l: { pos: [number, number, number]; fwd: [number, number, number]; up: [number, number, number] }, env: Env): void {
    const L = this.listener;
    this.frame++; this.sessionOff = false;
    if (dt > 0 && dt < 0.5) {
      const vx = (l.pos[0] - L.pos[0]) / dt, vy = (l.pos[1] - L.pos[1]) / dt, vz = (l.pos[2] - L.pos[2]) / dt;
      const k = 1 - Math.exp(-dt / 0.25);
      if (Math.hypot(vx, vy, vz) < 400) { // ignore teleports
        L.vel[0] += (vx - L.vel[0]) * k; L.vel[1] += (vy - L.vel[1]) * k; L.vel[2] += (vz - L.vel[2]) * k;
      }
      L.speed = Math.hypot(L.vel[0], L.vel[1], L.vel[2]);
      const yaw = Math.atan2(l.fwd[0], -l.fwd[2]);
      if (Number.isFinite(this.yawPrev) && Math.hypot(l.fwd[0], l.fwd[2]) > 0.2) {
        let dy = yaw - this.yawPrev; dy -= Math.round(dy / (2 * Math.PI)) * 2 * Math.PI;
        this.turnRate += (Math.min(6, Math.abs(dy) / dt) - this.turnRate) * (1 - Math.exp(-dt / 0.15));
      }
      this.yawPrev = yaw;
    }
    L.pos[0] = l.pos[0]; L.pos[1] = l.pos[1]; L.pos[2] = l.pos[2];
    L.fwd[0] = l.fwd[0]; L.fwd[1] = l.fwd[1]; L.fwd[2] = l.fwd[2];
    L.up[0] = l.up[0]; L.up[1] = l.up[1]; L.up[2] = l.up[2];
    this.env = env;
    // (the drop): once the ramp is open the wind roars through the bay until you jump (the engine drives it itself)
    if (this.planeActive && this.rampOpen && !this.planeExit && !this.loops.has("plane:bay") && !this.pendingLoops.has("plane:bay") && BANK["plane:bay"]) this.trigger("plane:bay", { loopId: "plane:bay" }, true);
    const P = this.prof;
    this.lapT = P ? performance.now() : 0;
    if (this.live) {
      // never let the idle slice starve the audio: when frames are long / the main thread is never idle (a stalled
      // tab, a GPU-bound frame), requestIdleCallback's 12 ms timeout is all that runs it — a far event could wait, a lazy
      // group never start loading (a stalled match could ride a silent drop for ~15 s). After 60 ms without a slice,
      // a small one runs right here (≤ 0.4 ms)
      const now = performance.now();
      if (now - this.lastSliceT > 60 && this.frame > 2) { this.lastSliceT = now; this.slice(0.4); }
      // loops waiting for a group that just decoded start now (not at the next slice)
      if (this.pendingDirty && this.pendingLoops.size) { this.pendingDirty = false; this.retryPending(); }
    }
    this.encT -= dt;
    if (this.live && this.frame > 2) this.reloadEdge();
    if (this.live && this.frame > 2) {
      this.feet.tick(dt, this.ctx.currentTime, this.listener.pos);
      // the driver voices other kongs' crouch-walks too: the bridge's distance-cadence crouch steps stop
      if (this.feet.active && this.bridge) this.bridge.on.crouch = false;
    }
    if (this.autoSteps && !this.stepsSuspended && !this.feet.active) this.footsteps(dt);
    this.lap("steps");
    // the AudioParam side of the mix (listener, loops, beds, filters) runs at a 60 Hz control rate, not at the frame
    // rate: each automation call takes a lock the audio thread holds while it renders, so at 240 fps the per-frame calls
    // spike update() in a real match (2-8 ms). Every change is a smoothed setTargetAtTime (tc ≥ 50 ms), so
    // 16 ms steps are inaudible. Offline renders tick every control step.
    this.ctlAcc += dt;
    if (this.ctlAcc < 1 / 62 && this.live && this.frame > 2) { this.scheduleSlice(); return; }
    const cdt = Math.min(0.25, this.ctlAcc);
    this.ctlAcc = 0;
    this.setListener();
    const indoorTarget = Math.max(env.indoors ? 1 : 0, this.autoIndoor >= 0.5 ? this.autoIndoor : 0);
    // (the first control ticks snap to it: spawning in a room must not start with a 0.2 s glide out of the open)
    if (this.frame <= 3) this.indoorS = indoorTarget;
    else this.indoorS += (indoorTarget - this.indoorS) * (1 - Math.exp(-cdt / 0.2));
    this.lap("listener");
    this.mixer.setIndoor(this.indoorS, env.inStorm, this.openS);
    this.stormWall(env);
    // the island holds its breath only once the wall is the loudest thing around (within ~70 m, ≤ 4 dB): hushing the
    // beds 7 dB from 250 m out, with the wall still ~-40 LUFS, leaves a quiet hole 60-150 m before the wall
    this.mixer.setStormNear(this.stormD === null ? 0 : smooth(-70, -15, this.stormD) * (1 - this.stormIn));
    this.useBridge();
    this.lap("storm");
    this.loopTick -= cdt;
    const heavy = this.loopTick <= 0;
    if (heavy) this.loopTick = 0.15;
    for (const lv of this.loops.values()) { this.updateLoop(lv, cdt, heavy); if (P) this.lap("l." + lv.name); }
    this.lap("loops");
    if (this.frame > 1) this.ambience.update(cdt, env);
    this.lap("ambience");
    if (this.frame > 1) { this.surf.only = (env as { _surfOnly?: "crash" | "lap" })._surfOnly; this.surf.one = !!(env as { _surfOne?: boolean })._surfOne; this.surf.update(cdt); this.underwater(cdt, env); }
    this.lap("surf");
    // everything else — other players' queued one-shots, the acoustic analysis, the slow periodic queries, the ambience
    // probe / starts / sprinkles — runs in a time-boxed slice in the main thread's idle time (done inline, update()
    // reached 26 ms in a real match on a loaded machine). Offline renders run it inline.
    if (this.live) this.scheduleSlice(); else this.slice(50);
  }

  private lapT = 0;
  private ctlAcc = 0;
  private lap(k: string) { const P = this.prof; if (!P) return; const t = performance.now(); P[k] = Math.max(P[k] ?? 0, t - this.lapT); this.lapT = t; }

  private sliceQueued = false;
  private sliceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSliceT = 0;
  private pendingDirty = false;
  private runSlice = (d?: { timeRemaining(): number; didTimeout: boolean }) => {
    this.sliceQueued = false;
    this.lastSliceT = performance.now();
    if (this.sliceTimer !== null) { clearTimeout(this.sliceTimer); this.sliceTimer = null; }
    // an idle period: use what is left of it (≤ 1.5 ms); called by the fallback timer: a 0.8 ms slice
    const budget = d && !d.didTimeout ? Math.max(0.3, Math.min(1.5, d.timeRemaining() - 0.3)) : 0.8;
    const t0 = performance.now();
    try { this.slice(budget); } finally {
      const P = this.prof; if (P) P.slice = Math.max(P.slice ?? 0, performance.now() - t0);
    }
  };
  /** at most one slice per frame: requestIdleCallback (12 ms deadline) — else a zero-delay task after the frame */
  private scheduleSlice() {
    if (this.sliceQueued) return;
    this.sliceQueued = true;
    const g = globalThis as unknown as { requestIdleCallback?: (cb: (d: { timeRemaining(): number; didTimeout: boolean }) => void, o?: { timeout: number }) => number };
    if (g.requestIdleCallback) g.requestIdleCallback(this.runSlice, { timeout: 12 });
    else this.sliceTimer = setTimeout(() => this.runSlice(), 0);
  }

  /** the time-boxed slow work: queued remote one-shots first (their timing is kept from the play() call), then the echo
   * analysis, then the periodic listener queries and the ambience, each only while budget is left */
  private slice(budgetMs: number) {
    const t0 = performance.now();
    const L = this.listener.pos;
    this.lapT = this.prof ? t0 : 0;
    // every step is gated by what it may cost, not just "some budget left" (otherwise a real match hit 8.1 ms in one slice
    // against its 1.5 ms budget — a bed start, a loop start or a burst of echo jobs began with 0.05 ms left). Bounded
    // steps first; the ones that build voices (a bed, the storm wall, a pending loop) only with ≥ 0.8 ms in hand — or once
    // they have waited long enough that the audio would suffer
    const left = () => budgetMs - (performance.now() - t0);
    // finished voices are disconnected here, in idle time (each disconnect takes the audio graph's lock) — ≤ 24 per slice
    this.reap(24);
    if (this.sessionOff) return;   // (back at the title: no bed, sprinkle, storm or queued one-shot may start)
    // your own shots' echoes (queued by trigger: they start ≥ 50 ms after the shot; a job that missed its time is dropped)
    if (this.echoJobs.length) {
      const now = this.ctx.currentTime;
      let k = 0;
      for (; k < this.echoJobs.length; k++) {
        const j = this.echoJobs[k];
        if (j.at > now + 0.005) this.echo(j.g, j.pos, j.at, j.db, j.bus, { rate: j.rate }, j.emitter, j.dist, j.local);
        if (left() < 0.3 * budgetMs) { k++; break; }
      }
      this.echoJobs.splice(0, k);
    }
    this.lap("s.reap");
    this.drain(Math.max(0.05, left() * 0.6));
    this.lap("s.queue");
    // the listener's own echo cell (your shots' slap-back) is analysed ahead of time
    if (this.world.terrain && (this.frame & 7) === 1 && left() > 0.2) this.world.reflectors(L);
    if (this.frame > 1 && left() > 0.15) this.world.work(Math.min(0.25, left() - 0.1));
    this.lap("s.work");
    if (this.encT <= 0 && this.frame > 2 && left() > 0.4) {
      // probe at YOUR head (the predicted player — the 3P camera can sit outside the room or above
      // the roof), colliders + the drawn rooms map (shacks, ship decks, cave halls are drawn, not boxed)
      this.encT = 0.2;
      const pr = (globalThis as unknown as { __kr?: { game?: { cm?: { pred?: { x: number; y: number; z: number; hp?: number } } } } }).__kr?.game?.cm?.pred;
      const H: V3 = pr && Number.isFinite(pr.x) ? [pr.x, pr.y + 1.6, pr.z] : L;
      this.autoIndoor = this.world.boxCount || this.world.terrain ? this.world.enclosure(H) : 0;
    }
    while (this.encQueue.length && left() > 0.35) this.world.enclosure(this.encQueue.pop()!);
    // how open the place is sets the outdoor space: an open beach is dry, a valley / street canyon rings
    if (this.world.terrain && this.frame - this.closeF >= 16 && left() > 0.2) { this.closeF = this.frame; const cl = this.world.closeness(L); if (cl !== null) this.openS = Math.max(cl, this.urban * 0.85); }
    if (this.frame - this.nearF >= 6 && left() > 0.45) { this.nearF = this.frame; this.streetSlaps(); }
    // loops' occlusion (chest hum, storm wall) every 0.15 s
    if (this.occDue && left() > 0.3) { this.occDue = false; for (const lv of this.loops.values()) this.loopOcclusion(lv); }
    this.lap("s.listener");
    if (this.frame > 1 && left() > 0.35) this.ambience.slow(left() > 0.9);
    this.lap("s.ambience");
    if ((this.frame & 127) === 64) { this.lib.evict(this.ctx.currentTime, (this.ambience.weights.alt ?? 0) > 0.8 ? 3 : 9); if (!this.loops.has("plane:drone")) this.dropWanted = false; }
    if (this.lib.requested && left() > 0.2) this.lib.pump(1);
    const now = this.ctx.currentTime;
    if (this.bridge && now - this.bridgeT >= 0.05 && left() > 0.25) { this.bridgeT = now; this.bridge.tick(now, this.listener.pos); }
    if (this.stormStart && (left() > 0.8 || now - this.stormStartT > 0.4)) {
      const p = this.stormStart; this.stormStart = null;
      const lv = this.loops.get("__storm");
      if (this.stormD !== null && (!lv || lv.stopping)) this.startLoop("storm:wall", BANK["storm:wall"], { pos: p, loopId: "__storm" });
    }
    // loops waiting for a group to decode (lazy groups load on demand)
    if ((this.frame & 15) === 5 && this.pendingLoops.size && this.lib.total && left() > 0.8) this.retryPending();
    this.lap("s.lib");
    if (this.queued > 0 && this.live) this.scheduleSlice();
  }
  private closeF = -99;
  private nearF = -99;
  /** how walled-in the listener's spot is (0 open … 1 a lane with walls all round) — street slaps + the urban tail */
  private urban = 0;
  private occDue = true;
  private bridge: GameBridge | null = null;
  private dropWanted = false;
  private bridgeT = -1;
  /** the storm wall's loop waits for the slice (start position) */
  private stormStart: V3 | null = null;
  private stormStartT = 0;
  /** re-aim the street-slap taps at the nearest walls around you (a lane, a container row): up to 4 faces 1.2-20 m away
   * with ≥ 1.5 m between their distances; delay = the round trip, level falls with the path, brighter when nearer, panned to
   * the wall's side. Outdoors in the open no face is found and the taps fall silent. */
  private streetSlaps() {
    const L = this.listener;
    const nf = this.world.nearFaces(L.pos);
    this.urban = this.indoorS > 0.5 ? 0 : nf.urban;
    const taps: { delay: number; gain: number; pan: number; lp: number }[] = [];
    // listener right vector (fwd × up) for the pans
    const rx = L.fwd[1] * L.up[2] - L.fwd[2] * L.up[1], rz = L.fwd[0] * L.up[1] - L.fwd[1] * L.up[0], ry = L.fwd[2] * L.up[0] - L.fwd[0] * L.up[2];
    const rn = Math.hypot(rx, ry, rz) || 1;
    let last = -9;
    const used: { dist: number; dir: V3 }[] = [];
    const pan = (d: V3) => Math.max(-0.9, Math.min(0.9, (d[0] * rx + d[1] * ry + d[2] * rz) / rn));
    for (const f of nf.faces) {
      if (taps.length >= 4 || this.indoorS > 0.5 || this.urban < 0.05) break;
      // (a face within 2 m would only comb-filter the shot: the slaps start at ~12 ms)
      if (f.dist < 2 || f.dist - last < 1.5) continue;
      last = f.dist;
      const path = 2 * f.dist;
      used.push(f);
      taps.push({ delay: path / 343, gain: 1.2 * (8 / (path + 8)), pan: pan(f.dir), lp: 2600 + 7000 * Math.exp(-path / 30) });
    }
    // a street rings: the slap bounces between two OPPOSITE walls (flutter) — 2nd-order taps at 2·(a + b)
    for (let i = 0; i < used.length && taps.length < 6; i++) for (let j = i + 1; j < used.length && taps.length < 6; j++) {
      const a = used[i], b = used[j];
      if (a.dir[0] * b.dir[0] + a.dir[2] * b.dir[2] > -0.5) continue;
      const path = 2 * (a.dist + b.dist);
      if (path > 70) continue;
      taps.push({ delay: path / 343, gain: 0.75 * (8 / (path + 8)), pan: 0.5 * (pan(a.dir) + pan(b.dir)), lp: 2200 + 5000 * Math.exp(-path / 30) });
      if (path * 2 < 70 && taps.length < 6) taps.push({ delay: (2 * path) / 343, gain: 0.45 * (8 / (2 * path + 8)), pan: pan(a.dir), lp: 1800 + 4000 * Math.exp(-path / 20) });
    }
    this.mixer.setER(taps);
  }

  /** a lazy group is needed: live → its fetches start from the idle slice (lib.pump); offline → now. `urgent` (the
   * plane, the drop's winds, the storm wall): the fetch starts now — a fetch() call costs microseconds, the decode runs
   * off the main thread — and the loop waiting for it starts the frame it lands */
  private want(g: string, urgent = false) {
    if (!this.live) { void this.lib.loadGroup(g); return; }
    if (urgent) { void this.lib.loadGroup(g).then(() => { this.pendingDirty = true; }); return; }
    this.lib.request(g);
  }
  private stormFetched = false;

  /** start the loops that were waiting for their groups to decode (a snapshot: a still-missing one re-queues itself) */
  private retryPending() {
    const ps = [...this.pendingLoops.values()];
    this.pendingLoops.clear();
    for (const p of ps) this.playEvent(p.name, p.o);
  }

  /** dev: set `audio.prof = {}` to collect the worst ms per update() section */
  prof: Record<string, number> | null = null;

  // ------------------------------------------------------------------ extras
  setWorld(terrain: Terrain | null, colliders?: Box[]) {
    this.world.terrain = terrain;
    if (colliders) this.world.setBoxes(colliders);
  }

  stats(): AudioStats {
    const c = this.ctx as AudioContext;
    return {
      state: this.ctx.state, sampleRate: this.ctx.sampleRate, baseLatencyMs: (c.baseLatency ?? 0) * 1000,
      outputLatencyMs: (c.outputLatency ?? 0) * 1000, codec: this.lib.ext, loaded: this.lib.loaded, total: this.lib.total,
      failed: this.lib.failed.length, voices: this.voices.length, loops: this.loops.size, played: this.played, culled: this.culled,
      lastPlayCostUs: Math.round(this.lastCost * 1000), boxes: this.world.boxCount, limiterGrDb: +this.mixer.limiterGR.toFixed(1), limiterGrMaxDb: +this.mixer.limiterGRMax.toFixed(1), worklet: this.mixer.usingWorklet,
      echoes: this.echoCount, autoSteps: this.autoStepCount, indoor: +this.indoorS.toFixed(2), autoStepsOn: this.autoSteps && !this.stepsSuspended,
      merged: this.merged, stolen: this.stolen, dropped: this.dropped, maxPlayCostUs: Math.round(this.maxCost * 1000),
      cellsBuilt: this.world.cellsBuilt, workMs: +this.world.workMs.toFixed(2), stormWall: this.stormD === null ? null : Math.round(this.stormD),
      sprinkles: this.sprStats,
      reload: { ...this.rlStats }, reloads: this.rlLog.slice(-1500), bootMs: this.bootMs, loadMs: this.loadMs, slow: this.slowLog.slice(0, 12),
      feet: { active: this.feet.active, local: this.feet.local, remote: this.feet.remote, log: this.feet.log.slice(-64), played: this.stepLog.slice(-128),
        crowd: this.feet.crowd, voiced: this.feet.voiced, othersDb: +this.feet.othersDb.toFixed(1), bedDuck: +this.feet.bedDuck.toFixed(2) },
      bridged: this.bridge?.played ?? 0, bridgeOn: this.bridge ? Object.entries(this.bridge.on).filter(([, v]) => v).map(([k]) => k).join(",") : "", pcmMB: +(this.lib.pcmBytes / 1e6).toFixed(1),
    };
  }

  playEvent(name: string, o: PlayOpts = {}): void {
    const t0 = performance.now();
    if (name === "gun:spinup") { this.wantHeliGun(); this.idleUnused(HELI_GUN_GROUPS, this.ctx.currentTime); }
    try {
      // other players' one-shots (the bulk of a 50-player match) are QUEUED: play() returns in microseconds and
      // update() voices them within a time budget, keeping their exact timing (speed-of-sound delay from the call
      // time). Your own sounds, loops and loop updates stay synchronous (no added latency where it matters).
      // only FAR events are queued (> 60 m: a speed-of-sound delay of ≥ 60 ms hides a frame of queueing). Near shots,
      // impacts, steps and whizzes are voiced right here (≤ 0.2 ms each) — queued, in a real match near
      // events started p99 107 ms late (seconds in a stalled tab) and 3 of 488 were dropped for lateness
      if (o.pos && !o.loopId && !BANK[name]?.loop) {
        const p = o.pos, L = this.listener.pos;
        // (the last remote shot's muzzle: a whizz in the same tick flies along the line from it — see trigger)
        if (name.startsWith("fire:")) { const F = this.lastFire; F.x = p[0]; F.y = p[1]; F.z = p[2]; F.t = this.ctx.currentTime; }
        if (Math.hypot(p[0] - L[0], p[1] - L[1], p[2] - L[2]) > NEAR_SYNC) this.enqueue(name, o);
        else this.trigger(name, o);
      } else this.trigger(name, o);
    } finally {
      this.lastCost = performance.now() - t0;
      if (this.lastCost > this.maxCost) this.maxCost = this.lastCost;
      // (the slowest calls with their names, so a slow play() can be traced)
      if (this.lastCost > 2 && this.live) this.noteSlow(this.lastCost, this.loopProf && BANK[name]?.loop ? `${name} [${this.loopProf}]` : name);
    }
  }

  private slowLog: [number, string, number][] = [];
  private noteSlow(ms: number, name: string) {
    const L = this.slowLog;
    if (L.length >= 12 && ms <= L[L.length - 1][0]) return;
    L.push([+ms.toFixed(2), name, this.frame]);
    L.sort((a, b) => b[0] - a[0]);
    if (L.length > 12) L.length = 12;
  }

  private lastFire = { x: 0, y: 0, z: 0, t: -9 };
  private queue: { name: string; o: PlayOpts; t: number }[] = [];
  private qHead = 0;
  private enqueue(name: string, o: PlayOpts) {
    const p = o.pos!;
    this.queue.push({ name, o: { ...o, pos: [p[0], p[1], p[2]] }, t: this.ctx.currentTime });
    if (this.queue.length - this.qHead > 512) this.qHead = this.queue.length - 512; // runaway guard (tab hidden)
  }
  /** voice queued remote events for up to `budgetMs` (at least one per call), oldest first */
  private drain(budgetMs: number) {
    const q = this.queue;
    if (this.qHead >= q.length) return;
    const t0 = performance.now();
    while (this.qHead < q.length) {
      const r = q[this.qHead++];
      this.trigger(r.name, r.o, false, r.t);
      if (performance.now() - t0 > budgetMs) break;
    }
    if (this.qHead >= q.length) { q.length = 0; this.qHead = 0; } else if (this.qHead > 256) { q.splice(0, this.qHead); this.qHead = 0; }
  }
  /** events waiting in the queue (stats / tests) */
  get queued() { return this.queue.length - this.qHead; }

  // ------------------------------------------------------------------ internals
  /** the ambience draws from its OWN random stream — a gunshot (or any other event) never reshuffles the beds'
   * sprinkles, so an offline render with and without a shot share the same bed up to the shot's arrival (the far-audibility
   * measurement subtracts them) and a live bed never changes character because someone fired */
  private ambSeed = 0;
  ambRnd = () => {
    let t = (this.ambSeed = (this.ambSeed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rnd = () => {
    // mulberry32
    let t = (this.seed = (this.seed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  private ear(): V3 { return this.listener.pos; }

  private dist(p: V3) { const L = this.listener.pos; return Math.hypot(p[0] - L[0], p[1] - L[1], p[2] - L[2]); }

  /** the library group for a layer: itself, or its stand-in while an asset is missing (null = skip the layer) */
  grp(g: string): string | null {
    if (this.lib.groups.has(g) || !(g in ALIAS)) return g;
    return ALIAS[g];
  }

  private lastL = new Float64Array(9).fill(NaN);
  private setListener() {
    const Ln = this.ctx.listener, L = this.listener, t = this.ctx.currentTime, P = this.lastL;
    // only when the camera actually moved / turned (3 cm, ~0.2°): no automation event flood
    let moved = false;
    for (let i = 0; i < 9 && !moved; i++) {
      const v = i < 3 ? L.pos[i] : i < 6 ? L.fwd[i - 3] : L.up[i - 6];
      if (!(Math.abs(v - P[i]) <= (i < 3 ? 0.03 : 0.0035))) moved = true;
    }
    if (!moved) return;
    P[0] = L.pos[0]; P[1] = L.pos[1]; P[2] = L.pos[2]; P[3] = L.fwd[0]; P[4] = L.fwd[1]; P[5] = L.fwd[2]; P[6] = L.up[0]; P[7] = L.up[1]; P[8] = L.up[2];
    if (Ln.positionX) {
      Ln.positionX.setValueAtTime(L.pos[0], t); Ln.positionY.setValueAtTime(L.pos[1], t); Ln.positionZ.setValueAtTime(L.pos[2], t);
      Ln.forwardX.setValueAtTime(L.fwd[0], t); Ln.forwardY.setValueAtTime(L.fwd[1], t); Ln.forwardZ.setValueAtTime(L.fwd[2], t);
      Ln.upX.setValueAtTime(L.up[0], t); Ln.upY.setValueAtTime(L.up[1], t); Ln.upZ.setValueAtTime(L.up[2], t);
    } else {
      (Ln as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(...L.pos);
      (Ln as unknown as { setOrientation(...a: number[]): void }).setOrientation(...L.fwd, ...L.up);
    }
  }

  distGain(d: number, sp: NonNullable<EventDef["spatial"]>) {
    let g: number;
    const c = sp.curve;
    if (c) g = d <= sp.ref ? 1 : dbg(-c.a * Math.log2(Math.min(d, c.knee) / sp.ref) - c.b * Math.log2(Math.max(d, c.knee) / c.knee));
    else g = d <= sp.ref ? 1 : sp.ref / (sp.ref + sp.rolloff * (d - sp.ref));
    return g * (1 - smooth(sp.max * 0.8, sp.max, d));
  }

  /** dB that makes a layer exactly as loud (manifest P) as the group it is matched to — 0 when unknown */
  private matchCache = new WeakMap<Layer, number>();
  matchDb(L: Layer): number {
    if (!L.match) return 0;
    const c = this.matchCache.get(L);
    if (c !== undefined) return c;
    const g = this.grp(L.g);
    const a = this.lib.groupP(L.match), b = g ? this.lib.groupP(g) : null;
    if (!this.lib.total) return 0; // manifest not in yet: don't cache
    const v = a !== null && b !== null ? Math.max(-24, Math.min(24, a - b)) : 0;
    this.matchCache.set(L, v);
    return v;
  }

  /** the loudest layer (its db + loudness match), for culling */
  private layerMax(def: EventDef): number {
    let m = LMAX.get(def);
    if (m === undefined) {
      m = 0;
      for (const l of def.layers) m = Math.max(m, (l.db ?? 0) + this.matchDb(l) + (l.band === "ftail" && def.spatial?.bands?.ftail ? def.spatial.bands.ftail[2] * 3 : 0));
      if (this.lib.total) LMAX.set(def, m);
    }
    return m;
  }

  airHz(d: number, sp: NonNullable<EventDef["spatial"]>) {
    return sp.air ? Math.max(700, 20000 * Math.exp(-d / sp.air)) : 20000;
  }

  makePanner(p: V3, d: number, hrtfRange = 60): PannerNode {
    const pn = this.ctx.createPanner();
    // a point source is mono: down-mix whatever feeds it BEFORE panning. (Otherwise a stereo tail layer made the voice
    // stereo, and the PannerNode's stereo equal-power law then added the mono body into the near ear at up to +6 dB —
    // a gun was louder at 80 m with its tail than without, and HRTF vs equal-power voices differed in level)
    pn.channelCount = 1; pn.channelCountMode = "explicit";
    pn.panningModel = d < hrtfRange ? "HRTF" : "equalpower";
    pn.distanceModel = "linear"; pn.rolloffFactor = 0; pn.refDistance = 1; pn.maxDistance = 1e5;
    if (pn.positionX) { pn.positionX.value = p[0]; pn.positionY.value = p[1]; pn.positionZ.value = p[2]; }
    else (pn as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(...p);
    return pn;
  }

  /** one blast = one sound: false when this trigger is part of a burst already voiced (same emitter within win s) */
  private burstOk(key: string, b: NonNullable<EventDef["burst"]>, pos: V3 | undefined, now: number): boolean {
    // ring buffer of the last 64 triggers (reused records: no garbage per shot)
    const r = this.recent;
    let n = 0;
    for (let i = 0; i < r.length; i++) {
      const e = r[i];
      if (e.k !== key || now - e.t > b.win || now < e.t) continue;
      if (pos ? e.local || Math.hypot(e.x - pos[0], e.y - pos[1], e.z - pos[2]) > b.radius : !e.local) continue;
      if (++n >= b.max) return false;
    }
    let e = r[this.recentI];
    if (!e) r[this.recentI] = e = { k: "", t: 0, x: 0, y: 0, z: 0, local: false };
    this.recentI = (this.recentI + 1) & 63;
    e.k = key; e.t = now; e.x = pos ? pos[0] : 0; e.y = pos ? pos[1] : 0; e.z = pos ? pos[2] : 0; e.local = !pos;
    return true;
  }
  private recentI = 0;

  private trigger(name: string, o: PlayOpts, internal = false, at?: number) {
    if (name === "plane:ramp" && this.planeActive) this.rampOpen = true;
    if (!internal && this.bridge && !(o as { _bridge?: boolean })._bridge) {
      this.bridge.sawReal(name, o);
      if (!o.pos && name.startsWith("pickup:")) this.bridge.pickup(this.ctx.currentTime, o.tier);
    }
    if (!internal && !o.pos) {
      // gameplay drives the local feet itself → stop auto-steps; death suspends them until you are back in play
      if (name.startsWith("step:")) this.autoSteps = false;
      if (name === "jump:exit" || name === "land") this.planeExit = true;
      if (name === "jump:exit") this.stopLoop("plane:bay");
      else if (name === "elim:self") { this.stepsSuspended = true; for (const u of this.uses.values()) this.endUse(u, false); }
      else if (name === "land" || name === "jump" || name === "ui:resurgence" || name.startsWith("fire:")) this.stepsSuspended = false;
    }
    // YOUR reload is voiced exactly once per sim reload start (render.ts's own edge test
    // fired it twice 10-31 ms apart on 6 of 11 reloads, and missed 1 of 2 in another run). Gameplay's call only prompts the
    // match-state edge detector; a second call within RELOAD_DEDUP s of a reload start is dropped
    if (!internal && !o.pos && name.startsWith("reload:") && !(o as { _rl?: boolean })._rl) { this.localReloadCall(name, o); return; }
    let def = BANK[name];
    if (name === "ui:countdown" && (o.rate ?? 1) >= 1.4) { def = BANK["ui:countdown-go"]; o = { ...o, rate: 1 }; }
    if (!internal) {
      // bridge until gameplay plays `hurt`: render.ts signals damage TAKEN as a local hit:body at volume 0.55
      if (name === "hit:body" && !o.pos && o.volume !== undefined && Math.abs(o.volume - 0.55) < 0.005) { name = "hurt"; def = BANK.hurt; o = { ...o, volume: 1 }; }
      // the engine drives the storm wall itself whenever it knows the circle (env.storm / the match): a 2D
      // "inside" loop request is covered by it
      if (name === "storm:loop" && this.stormD !== null) return;
      if (name === "heal:use" || name === "shield:use") { if (this.useStart(name, o)) return; }
      // steps: the surface is what the feet stand on (deck, container roof, interior floor, paving, swamp water):
      // YOUR steps from the predicted player (the sim's ground box + the drawn-floor map + the terrain's visible
      // splat, steps.ts), remote ones from the colliders / map / splat under the given feet
      // EVERY step is re-resolved (gameplay's `step:<biome>` said "water" for an
      // enemy on the galleon deck); with a live match the engine voices the feet itself on the animation's foot plants
      // (feet.ts) — gameplay's distance-stride calls are dropped then (a mantle's hand-plant scuff still plays)
      if (name.startsWith("step:")) {
        const st = this.localSt();
        if (this.feet.active && (o.pos || st === 0)) return;
        // (no match at all — an offline render / the audition — and no position: the requested surface is played as is)
        if (o.pos || st >= 0) {
          const n2 = `step:${o.pos ? this.remoteGround(o.pos[0], o.pos[1], o.pos[2]) : this.localGround()}`;
          if (BANK[n2]) { name = n2; def = BANK[n2]; }
        }
      }
      // sprint steps (gameplay sends sprint at volume ≥ 0.85, walk 0.6-0.65, crouch 0.3): the recorded running set
      // (gameplay's fallback path only: it sends sprints at 0.85-0.9; a volume of exactly 1 is a direct request for that set)
      if (name.startsWith("step:") && (o.volume ?? 0.6) >= 0.8 && (o.volume ?? 0.6) < 0.999 && name.split(":").length === 2 && BANK[name + ":run"] && this.lib.has(`step/${name.slice(5)}-run`)) { name = name + ":run"; def = BANK[name]; }
      // another kong's landing / jump is a foot sound too — once the nearest few kongs' feet are voiced
      // (feet.ts) only theirs are (the warm-up islet: 49 kongs hopping about)
      if ((name === "land" || name === "jump") && o.pos && !this.feet.nearFoot(o.pos[0], o.pos[2])) { this.culled++; return; }
      // jumps and landings carry the surface you push off / land on (a sand landing is not a deck landing)
      if (name === "land" || name === "jump") {
        const surf = o.pos ? this.remoteGround(o.pos[0], o.pos[1], o.pos[2]) : this.localGround();
        const landSet = name === "land" && this.lib.has(`step/${surf}-land`);
        this.trigger(landSet ? `step:${surf}:land` : `step:${surf}`, { ...o, volume: (o.volume ?? 1) * (name === "land" ? (landSet ? 1 : 1.35) : 0.8), rate: name === "land" ? (landSet ? 1 : 0.9) : 1.05 }, true);
      }
    }
    if (!def) { if (!this.warned.has(name)) { this.warned.add(name); console.warn(`[audio] no sound for "${name}"`); } return; }
    if (def.loop) { this.startLoop(name, def, o); return; }
    const PR = this.prof;
    if (PR) this.pt = performance.now();
    const plap = PR ? this.plap : NOLAP;
    // `at` = when the event happened (a queued remote event is processed up to a frame later: it keeps its timing)
    const now = at ?? this.ctx.currentTime;
    const pos = o.pos as V3 | undefined;
    if (def.burst && !this.burstOk(def.burst.by === "group" ? (def.group ?? name) : name, def.burst, pos, now)) { this.merged++; return; }
    if (def.gap) {
      const k = pos ? `${name}@${Math.round(pos[0])},${Math.round(pos[2])}` : name;
      const last = this.lastTrig.get(k) ?? -1;
      if (now - last < def.gap && now >= last) return;
      this.lastTrig.set(k, now);
      if (this.lastTrig.size > 512) trim(this.lastTrig, 128);
    }
    const local = !pos;
    const sp = def.spatial;
    let gainDb = local ? (def.dbLocal ?? def.db ?? 0) : (def.db ?? 0);
    const bus: Bus = local ? (def.busLocal ?? def.bus) : def.bus;
    let d = 0, occ = 0, lpHz = 20000, delay = 0;
    if (!local && sp && pos) {
      d = this.dist(pos);
      if (d > sp.max) { this.culled++; return; }
      const g = this.distGain(d, sp);
      // inaudible before any world query → cull (most of a 50-player match happens far away)
      if (gainDb + 20 * Math.log10(Math.max(g, 1e-6)) + 20 * Math.log10(Math.max(1e-4, o.volume ?? 1)) + this.layerMax(def) < -72) { this.culled++; return; }
      if (sp.occl) { const q = this.tmpA; q[0] = pos[0]; q[1] = pos[1] + 1.2; q[2] = pos[2]; occ = this.world.occl(this.ear(), q, now); }
      gainDb += 20 * Math.log10(Math.max(g, 1e-6)) - occ * (sp.occlDb ?? 12);
      lpHz = Math.min(this.airHz(d, sp), 20000 * Math.pow((sp.occlHz ?? 750) / 20000, occ));
      if (this.indoorS > 0.5 && d > 12) lpHz = Math.min(lpHz, def.group === "step" ? 3500 : 2500); // you're inside, they're outside
      // the speed-of-sound delay fades in between 30 and 100 m (≤ 9 ms at 40 m, 61 ms at 60 m, full d/343 past 100 m):
      // a near shot lands with its muzzle flash — "zero lag" — while a distant one still arrives late like the real thing
      if (sp.travel && d > 30) delay = Math.min(2.6, d / 343) * smooth(30, 100, d);
      // a queued (far) event that could only start > 80 ms late is dropped (a hidden tab); never one within 40 m
      if (at !== undefined && d > 40 && now + delay < this.ctx.currentTime - 0.08) { this.culled++; return; }
    }
    gainDb += 20 * Math.log10(Math.max(1e-4, o.volume ?? 1));
    // in the storm, someone's feet near you are the one thing you must hear (+5 dB, with the roar's duck below)
    // … and in a BUSY place (the harbor's clanks and chains, the murk's frogs, a town) an enemy's feet near you lift a
    // few dB with how busy the beds are (without it a sprint 15 m away in the harbor sat ~2 dB over the bed — masked)
    if (!local && def.group === "step") gainDb += 8 * this.stormIn + this.busyLift();
    // a crowd's feet dip (≤ 8 dB) and the warm-up's another 7 dB (feet.ts othersDb; 0 with one or two
    // kongs about) — on the steps and on the body thump of another kong's landing / jump
    if (!local && (def.group === "step" || def === BANK.land || def === BANK.jump)) gainDb += this.feet.othersDb;
    if (gainDb + this.layerMax(def) < -72) { this.culled++; return; }

    const group = def.group ?? name;
    const isGun = def.group === "gun";
    const prio = local ? 9 : (def.prio ?? 1);
    // gun emitters are matched before allocation so the stealer knows who is near
    const emitter = isGun ? this.emitterFor(name, pos ?? null, now) : undefined;
    plap("spatial");
    // dev (acceptance checks): everything a trigger does to the MIX (the beds' far-fight duck) without its sound — the
    // bed a distant shot is heard against is the ducked bed
    if ((o as { _silent?: boolean })._silent && !this.warming) {
      if (!local && (isGun || def.shock) && gainDb > -54) this.mixer.duckFar(this.farDuckDb(gainDb), now + delay);
      else if (!local && def.group === "step" && gainDb > -42 && occ < 0.9 && this.feet.bedDuck > 0) this.mixer.duckFar(this.stepDuckDb(gainDb) * (1 - 0.4 * occ) * this.feet.bedDuck, now + delay);
      if (!local && (isGun || def.group === "step")) this.stormDuck(gainDb, isGun, now + delay);
      if (def.cueDuck) this.mixer.duckCue(def.cueDuck[0], def.cueDuck[1], now + delay);
      if (def.confirm && local) this.mixer.duckConfirm(now + delay);
      return;
    }
    if (def.cap && !this.allocate(group, def.cap, local, gainDb, prio, d, emitter)) return;

    const out = this.ctx.createGain();
    out.gain.value = dbg(gainDb);
    const nodes: AudioNode[] = [out];
    let tail: AudioNode = out;
    if (lpHz < 19000) {
      const f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = lpHz; f.Q.value = 0.5;
      tail.connect(f); tail = f; nodes.push(f);
    }
    if (!local && def.eq3p) for (const [ty, hz, g, q] of def.eq3p) {
      const f = this.ctx.createBiquadFilter(); f.type = ty; f.frequency.value = hz; f.gain.value = g; f.Q.value = q;
      tail.connect(f); tail = f; nodes.push(f);
    }
    let sweepPn: PannerNode | null = null;
    let xtalk: GainNode | null = null;
    if (!local && pos && sp) {
      const far = d >= (sp.hrtf ?? 60);
      if (far) {
        // past the HRTF range the equal-power panner has no front/back and hard-pans a lateral
        // source (far ear -160 dB). A source BEHIND you loses its top (the pinna shadow: up to -7 dB above 3.5 kHz), and a
        // little of the voice reaches both ears unpanned (the head is not a wall: lateral ILD ≈ 18 dB, not infinite)
        const L = this.listener, dx = pos[0] - L.pos[0], dz = pos[2] - L.pos[2], hn = Math.hypot(dx, dz) || 1;
        const fh = Math.hypot(L.fwd[0], L.fwd[2]) || 1;
        const cosF = (dx * L.fwd[0] + dz * L.fwd[2]) / (hn * fh);
        const rear = smooth(0.1, -0.85, cosF);
        if (rear > 0.02) {
          const sh = this.ctx.createBiquadFilter(); sh.type = "highshelf"; sh.frequency.value = 3500; sh.gain.value = -7 * rear;
          tail.connect(sh); tail = sh; nodes.push(sh);
        }
        out.gain.value *= XT_NORM;
        xtalk = this.ctx.createGain(); xtalk.gain.value = XT_GAIN;
        tail.connect(xtalk); nodes.push(xtalk);
      }
      const pn = this.makePanner(pos, d, sp.hrtf ?? 60);
      tail.connect(pn); tail = pn; nodes.push(pn);
      if (name === "whizz") sweepPn = pn;
    }
    // a blast within shell-shock range bypasses the shell-shock filter it triggers (its own crack / body / debris stay bright)
    // (warm-up: the full path runs, but into a silent sink — no -70 dBFS blip at t = 0)
    const dest = this.warming ? this.sink : def.shock && (local || d < 40) ? this.mixer.blast : name === "hurt" ? this.mixer.hurtIn : this.mixer.buses[bus];
    tail.connect(dest);
    if (xtalk) xtalk.connect(dest);
    // reverb send (spatial world sounds + your own gun): room when inside, the "yard" outside
    const sendDb = def.send ?? (sp ? -20 : -99);
    if (sendDb > -60 && (local || d < 250) && !this.warming) {
      const sg = this.ctx.createGain();
      sg.gain.value = dbg(sendDb + (local ? 0 : Math.min(6, d / 40)));
      tail.connect(sg);
      // (only the space that is sounding: each connect() takes the audio graph's lock)
      if (this.indoorS > 0.02) sg.connect(this.mixer.reverbInput(bus, "room"));
      if (this.indoorS < 0.98) sg.connect(this.mixer.reverbInput(bus, "yard"));
      nodes.push(sg);
    }
    // the walls around you slap your shots back (street slaps, mixer.erSend) — your gun, and guns / blasts within 40 m
    if ((isGun || def.shock) && this.urban > 0.05 && (local || d < 40) && !this.warming) {
      const eg = this.ctx.createGain();
      eg.gain.value = dbg((local ? 3 : -3 - d / 8) + 20 * Math.log10(this.urban));
      tail.connect(eg).connect(this.mixer.erSend);
      nodes.push(eg);
    }

    plap("alloc+nodes");
    const t0 = Math.max(this.ctx.currentTime, now + delay);
    if (sweepPn && pos) this.whizzSweep(sweepPn, pos, t0);
    let end = t0;
    const srcs: AudioBufferSourceNode[] = [];
    // where is the shot? a gun fired inside a room gets the room tail instead of the outdoor one
    let inRoom = 0;
    // (a remote shot is voiced synchronously now — a shooter's room is looked up only if already known for that spot;
    // an unknown spot is analysed in the next idle slice and its first shot gets the outdoor tail)
    if (isGun) {
      if (local) inRoom = this.indoorS;
      else if (pos && d < 120) {
        const q = this.tmpA; q[0] = pos[0]; q[1] = pos[1] + 1.2; q[2] = pos[2];
        const c = this.live ? this.world.enclosureCached(q) : this.world.enclosure(q);
        if (c === null) { if (this.encQueue.length < 16) this.encQueue.push([q[0], q[1], q[2]]); } else inRoom = c;
      }
    }
    // outdoors, the terrain/walls around the shot supply the slap-back (analysed off the hot path: null = not yet). The
    // baked outdoor tail follows the place: an open beach gets a short dry tail, a valley / street canyon the full one +
    // its echoes — so the two sound clearly different.
    const src0 = pos ?? this.listener.pos;
    plap("enclosure");
    const wantEcho = !this.warming && !(o as { _solo?: string; _noecho?: boolean })._solo && !(o as { _noecho?: boolean })._noecho && sp?.echo !== undefined && !!this.world.terrain && d < 700 && inRoom < 0.5 && this.echoBudget(local, d);
    const echoes = wantEcho ? this.world.reflections(src0, this.listener.pos, now) ?? [] : [];
    const close = sp?.echo !== undefined && inRoom < 0.5 ? this.world.closeness(src0) : null;
    // a valley / canyon rolls: faces all round throw the slap back and forth (second-order echoes between the two
    // strongest faces) — an open beach gets none of it
    const rapid = local && isGun && now - this.lastOwnShot < 0.25;
    if (local && isGun) this.lastOwnShot = now;
    if (rapid && echoes.length > 2) echoes.length = 2;
    if (!rapid && close !== null && close > 0.6 && echoes.length >= 2 && (local || d < 200)) {
      const [a, b] = echoes;
      const roll = 0.6 + 0.4 * close;
      for (const [k, e] of [
        [0, { ...a, delay: a.delay + b.delay + 0.03, gain: a.gain * roll, dist: a.dist + b.dist, surf: a.surf * 0.8 * roll }],
        [1, { ...b, delay: 2 * b.delay + a.delay + 0.05, gain: b.gain * 0.8 * roll, dist: a.dist + 2 * b.dist, surf: b.surf * 0.65 * roll }],
        [0, { ...a, delay: 2 * (a.delay + b.delay) + 0.07, gain: a.gain * 0.55 * roll, dist: 2 * (a.dist + b.dist), surf: a.surf * 0.5 * roll }],
      ] as const) {
        if (e.delay < 1.4) echoes.push({ ...e, pos: k ? b.pos : a.pos });
      }
    }
    // (a walled-in street / market lane rings like a valley — its own tail is the full one, not the open field's)
    // (a valley / canyon holds your shot up to +5 dB — the open beach -8 dB: ≥ 3 dB apart in the 0.5-2.5 s roll)
    const tailTrim = close === null ? 1 : dbg(Math.min(5, -8 + 13 * Math.max(close, local || d < 40 ? this.urban * 0.9 : 0)));
    plap("reflections");
    const solo = (o as { _solo?: string })._solo; // dev: render one distance band alone (calibration)
    // keyframed actions (reloads): layers start at a fraction `u` of the action's duration and nothing sounds after it
    const actDur = name.startsWith("reload:") ? (o.dur ?? RELOAD_S[name.slice(7) as keyof typeof RELOAD_S] ?? 2) : 0;
    // (the reload began `rlOff` s before this call: keys already past are skipped, the rest keep the sim's timeline)
    const rlOff = actDur ? Math.max(0, Math.min(actDur, (o as { _rlOff?: number })._rlOff ?? 0)) : 0;
    let keyed = false;
    const mute = (o as { _mute?: string })._mute; // dev: drop one band (calibration)
    // the distance CURVE sets the whole shot's loudness; the rolling far tail rising against the report (the range cue)
    // must not add to it — all distance bands share the energy: report² + tail² = curve²
    let bandNorm = 1;
    if (!local && sp?.bands?.ftail) {
      const ft = def.layers.find((l) => l.band === "ftail");
      if (ft) { const wt = this.layerWeight(ft, false, d, sp) * dbg(ft.db ?? 0); bandNorm = 1 / Math.sqrt(1 + wt * wt); }
    }
    for (const L of def.layers) {
      if (solo && (L.band ?? "none") !== solo) continue;
      if (L.ifMissing && this.lib.has(L.ifMissing)) continue;
      if (mute && mute === L.band) continue;
      let w = this.layerWeight(L, local, d, sp) * (L.band ? bandNorm : 1);
      // a distant shot's rolling tail is the terrain around YOU ringing — a valley / street
      // canyon holds it (+4 dB), an open beach lets it go (-6 dB), indoors it is only a muffled rumble through the walls
      if (L.band === "ftail" && !local) w *= this.ftailEnv();
      // YOUR shot's outdoor tail follows your surroundings too (open beach -3 dB … valley / canyon +4 dB): the tail
      // is the range's own recording, the same take everywhere (alone, valley − beach read 0.0 dB)
      if (L.band === "tail" && local) w *= dbg(-3 + 7 * Math.max(0, Math.min(1, this.openS)));
      if (w <= 0.001) continue;
      if (L.chance !== undefined && this.rnd() > L.chance) continue;
      const g0 = this.grp(L.g);
      if (!g0) continue;
      const room = L.band === "tail" && inRoom > 0.02 && this.lib.has(g0 + "-in");
      for (let ai = 0; ai < (room ? 2 : 1); ai++) {
        const grp = ai ? g0 + "-in" : g0, k0 = room ? (ai ? inRoom : 1 - inRoom) : 1;
        const k = L.band === "tail" && !ai ? k0 * tailTrim : k0;
        if (k * w <= 0.01) continue;
        const pk = this.lib.pick(grp, this.rnd);
        if (!pk) continue;
        const s = this.source(pk.buf, pk.file, L, o, w * k * (L.match ? dbg(this.matchDb(L)) : 1) * (ai && L.inDb ? dbg(L.inDb) : 1));
        if ((o as { _dbg?: boolean })._dbg) console.log("[audio dbg]", name, L.g, pk.id, "w", w.toFixed(3), "k", k.toFixed(3), "match", this.matchDb(L).toFixed(2), "gain", s.g.gain.value.toFixed(4), "ev", gainDb.toFixed(1));
        s.src.connect(s.g).connect(out);
        let at = t0 + (L.u !== undefined ? L.u * actDur - rlOff : (L.delay ?? 0)) + (L.jitter ? this.rnd() * L.jitter : 0);
        if (L.u !== undefined) { keyed = true; if (at < t0 - 0.02) continue; at = Math.max(t0, at); }
        s.src.start(at);
        if (def.group === "step") { this.stepLog.push([at, pk.id, local]); if (this.stepLog.length > 256) this.stepLog.splice(0, 128); }
        srcs.push(s.src); nodes.push(s.g);
        end = Math.max(end, at + pk.buf.duration / s.src.playbackRate.value);
      }
    }
    plap("layers");
    if ((o as { _dbg?: boolean })._dbg) console.log("[audio dbg] srcs", srcs.length, "nodes", nodes.length, "echoes", echoes.length, "close", close, "voices", this.voices.length, "delay", delay.toFixed(3), "lp", lpHz.toFixed(0), "occ", occ.toFixed(2));
    if (!srcs.length) { for (const n of nodes) n.disconnect(); return; }
    if (keyed && actDur > 0) {
      // the action ends at u = 1: whatever still rings is faded out over the last 15 ms (no sound after the reload)
      const tEnd = t0 + actDur - rlOff;
      out.gain.setValueAtTime(out.gain.value, tEnd - 0.015);
      out.gain.linearRampToValueAtTime(0, tEnd);
      for (const s of srcs) { try { s.stop(tEnd + 0.005); } catch { /* */ } }
      end = Math.min(end, tEnd + 0.01);
    }
    // full-auto clarity: the next shot from the same gun chokes the previous shot's ringing tail (and its echoes)
    if (emitter) this.choke(emitter, t0);
    const v: Voice = { nodes, srcs, end, group, start: now, out, emitter, local, db: gainDb, prio, dist: d };
    // a one-shot with a loopId can be cut short with stopLoop(loopId) (a reload interrupted by a swap / a shot)
    if (o.loopId) this.tagged.set(o.loopId, v);
    if (local && name.startsWith("reload:")) this.localReload = { v, t0, end: t0 + (actDur || this.reloadDur(name)) - rlOff };
    this.voices.push(v);
    this.played++;
    if (emitter && !local) this.limitEmitter(emitter, d < 60 ? 3 : 2, t0);

    // echoes off hills / cliffs / walls (loud events only)
    if (echoes.length && sp?.echo !== undefined) {
      // a face throws back what reaches it: your own crack up close; a distant gun's REPORT / dist thud (whichever band
      // is heard at that range, loudness-matched like the direct) — explosions echo their far boom
      let src: Layer | undefined;
      if (isGun && !local && sp.bands) {
        let bw = 0;
        for (const L of def.layers) {
          if (L.band !== "near" && L.band !== "far" && L.band !== "dist") continue;
          const w = this.layerWeight(L, false, d, sp);
          if (w > bw && this.grp(L.g) && this.lib.has(this.grp(L.g)!)) { bw = w; src = L; }
        }
      }
      src ??= (isGun ? def.layers.find((l) => l.band === "near") : undefined) ?? def.layers.find((l) => l.band === "far") ?? def.layers[0];
      const mdb = this.matchDb(src);
      for (const e of echoes) {
        // your own shot: perceptual level (a 15-35 m face slaps back ~-5 dB, 270 m ~-18 dB); others: the physical ratio,
        // and a reflection (a longer path) never comes back louder than 3 dB under the direct sound
        const g = local ? e.surf * Math.min(1.4, Math.max(0.1, 100 / (e.dist + 10))) : Math.min(e.gain, 0.7);
        const edb = gainDb + (local ? sp.echo + 1 : Math.min(-3, sp.echo)) + 20 * Math.log10(g) + mdb, ebus: Bus = def.bus === "p3" ? "p3" : def.bus;
        // a shot's echoes (≥ 50 ms after it) are built in the next idle slice: the shot itself stays cheap (others'
        // shots too — a near remote shot is voiced synchronously in play())
        if (this.live) this.echoJobs.push({ g: src.g, pos: [e.pos[0], e.pos[1], e.pos[2]], at: t0 + e.delay, db: edb, bus: ebus, rate: o.rate ?? 1, emitter, dist: e.dist, local });
        else this.echo(src.g, e.pos, t0 + e.delay, edb, ebus, o, emitter, e.dist, local);
      }
    }
    plap("echoes");
    if (this.warming) return;
    if (local && def.duck) { this.mixer.duck(def.duck); this.radio?.duck(-9 * def.duck); }   // (the cab radio dips under your shots)
    if (def.cueDuck) this.mixer.duckCue(def.cueDuck[0], def.cueDuck[1], t0);
    if (def.confirm && local) this.mixer.duckConfirm(t0);
    // rarity: a pickup of rare+ loot gets its sweetener on top (uncommon … legendary)
    if (o.tier !== undefined && o.tier >= 1 && name.startsWith("pickup:")) this.oneShot(`loot/rarity-${Math.min(4, Math.round(o.tier))}`, bus, gainDb - 2, t0 + 0.05);
    // any AUDIBLE gunfire / explosion pulls the ambience beds back a few dB (the fight is the information)
    if (!local && (isGun || def.shock) && gainDb > -54) { this.mixer.duckFar(this.farDuckDb(gainDb), t0); if (gainDb > -36) this.radio?.duck(-Math.min(8, (gainDb + 36) * 0.4), 0.3); }
    // an enemy moving close by pulls the beds back a little too (HDR mix: feet near you outrank the jungle) — one or two
    // kongs, not a crowd: otherwise 49 kongs' feet held the beds 3.7 dB down (11 dB in 1-4 kHz) the whole warm-up
    else if (!local && def.group === "step" && gainDb > -42 && occ < 0.9 && this.feet.bedDuck > 0) this.mixer.duckFar(this.stepDuckDb(gainDb) * (1 - 0.4 * occ) * this.feet.bedDuck, t0);
    // inside the storm the roar is the loudest bed of all: it dips under an enemy near you too
    if (!local && (isGun || def.group === "step")) this.stormDuck(gainDb, isGun, t0);
    if (def.shock && pos && d < 16 && occ < 0.5) {
      const a = 1 - d / 16;
      // the blast's own crack + thump land first, THEN the world goes dull (and the ears ring)
      this.mixer.shellshock(a, t0 + 0.1);
      if (d < 9) this.trigger("fx:tinnitus", { volume: a }, true);
    }
  }

  /**
   * a whizz flies PAST you — the panner sweeps along the bullet's line through the point where it passed closest
   * (not from that fixed point). The line comes from the shot that fired it (the remote `fire:*` of this tick —
   * render.ts plays the shot and then its whizz); without one, the bullet is taken as coming from in front of you. The
   * asset's pass (its loudest instant) is ~90 ms in: the sweep crosses the closest point there, 6 m either side.
   */
  private whizzSweep(pn: PannerNode, W: V3, t0: number) {
    if (!pn.positionX) return;
    const L = this.listener, F = this.lastFire;
    let ux = W[0] - F.x, uy = W[1] - F.y, uz = W[2] - F.z;
    let n = Math.hypot(ux, uy, uz);
    if (!(this.ctx.currentTime - F.t < 0.2 && n > 3)) {
      // no shooter known: the bullet came from ahead — the horizontal direction across the listener-to-pass line, pointing away from where you look
      const rx = W[0] - L.pos[0], rz = W[2] - L.pos[2], rn = Math.hypot(rx, rz) || 1;
      let px = -rz / rn, pz = rx / rn;
      const f = px * L.fwd[0] + pz * L.fwd[2];
      if (Math.abs(f) < 0.2) { const s = this.rnd() < 0.5 ? -1 : 1; px *= s; pz *= s; } else if (f > 0) { px = -px; pz = -pz; }
      ux = px; uy = 0; uz = pz; n = 1;
    }
    ux /= n; uy /= n; uz /= n;
    const R = 6, T = 0.18, tc = t0 + 0.09;
    const P = [pn.positionX, pn.positionY, pn.positionZ], u = [ux, uy, uz];
    for (let i = 0; i < 3; i++) {
      P[i].cancelScheduledValues(0);
      P[i].setValueAtTime(W[i] - u[i] * R, t0);
      P[i].linearRampToValueAtTime(W[i], tc);
      P[i].linearRampToValueAtTime(W[i] + u[i] * R * (T - 0.09) / 0.09, t0 + T);
    }
  }

  /** JIT warm-up of the world queries every remote shot runs (the first shot of a match must not pay the interpreter) */
  private warming = false;
  private sink!: GainNode;
  private warm() {
    const L = this.listener.pos;
    this.sink ??= this.ctx.createGain();
    this.sink.gain.value = 0;
    const v0 = this.voices.length, e0 = this.emitters.length, played = this.played, culled = this.culled;
    const steps = this.autoSteps, susp = this.stepsSuspended;
    this.warming = true;
    try { this.warmPaths(L); } finally {
      this.warming = false;
      // everything the warm-up started is torn down at once: no voice, emitter, burst record or reload state survives it
      for (const v of this.voices.splice(v0)) { for (const s of v.srcs) { try { s.stop(); } catch { /* */ } s.disconnect(); } for (const n of v.nodes) n.disconnect(); }
      this.emitters.length = Math.min(this.emitters.length, e0);
      for (const r of this.recent) if (r) r.t = -1e9;
      this.tagged.clear(); this.lastTrig.clear(); this.localReload = null; this.lastOwnShot = -1;
      this.autoSteps = steps; this.stepsSuspended = susp;
      this.played = played; this.culled = culled;
    }
  }
  private warmPaths(L: V3) {
    for (let i = 0; i < 8; i++) {
      const p: V3 = [L[0] + 20 + i * 7, L[1] + 1, L[2] + 12 - i * 3];
      this.world.occlusion(L, p);
      this.world.enclosure(p);
      this.world.groundAt(p[0], p[1], p[2]);
      this.world.rayBox(p, [1, 0, 0], 30);
    }
    // the full remote-shot path (nodes, HRTF panner, layers) into the silent sink, then freed: the first real shot of the
    // match no longer pays for the cold path. Every kind of remote one-shot the first seconds of a match throw at it:
    // shots, impacts, steps with their EQ, a whizz, a blast on the blast bus, a hit
    const warmup: [string, number][] = [["fire:ar", 25], ["fire:shotgun", 32], ["impact:wood", 20], ["step:wood", 9], ["whizz", 2], ["explosion", 30], ["hit:body", 6], ["land", 12]];
    for (const [nm, d] of warmup) this.trigger(nm, { pos: [L[0] + d, L[1], L[2] - 7] }, true);
    // your own first landing / glider / reload / confirm must not pay the cold path either (they are synchronous)
    this.trigger("land", {});
    for (const nm of ["glider:open", "jump:exit", "equip", "reload:ar", "hit:body", "pickup:ammo", "fire:pistol"]) this.trigger(nm, {}, true);
  }

  /** the listener's surroundings → the rolling far tail's level (linear): open 0 → -6 dB … closed 1 → +4 dB, -6 dB indoors */
  private ftailEnv() {
    const c = Math.max(this.openS, this.urban * 0.85);
    return dbg(-6 + 10 * Math.min(1, Math.max(0, c)) - 6 * this.indoorS);
  }

  /** how far the beds dip under someone's gunfire / a blast heard at `gainDb` (up to 9 dB — a distant fight must read
   * over the harbor's clanks and the jungle's birds whatever they happen to be doing at that moment) */
  // (a loud distant shot — a sniper at 300-600 m arrives at ≈ -20..-30 dB — pulls the beds down up to 12 dB: the
  // HDR moment that makes a far sniper the one thing you hear)
  private farDuckDb(gainDb: number) { return Math.min(gainDb > -34 ? 12 : 9, 2 + (gainDb + 54) / 4); }
  /** the beds dip under an enemy's feet near you — up to 10 dB within ~20 m, ~8 dB at 35 m: someone running up
   * on you is the one thing the island makes room for */
  private stepDuckDb(gainDb: number) { return Math.min(10, 2 + (gainDb + 42) / 3); }
  /** how busy the beds around you are in the 1-5 kHz band an enemy's step lives in (0 open field … 1 the harbor) → dB
   * lift of a remote step (≤ 4 dB) */
  private busyLift() {
    const w = this.ambience.weights;
    const busy = Math.min(1, (w.harbor ?? 0) + 0.7 * (w.lagoon ?? 0) + 0.4 * (w.town ?? 0) + 0.3 * (w.jungle ?? 0) + 0.3 * (w.volcanic ?? 0));
    return 4 * busy;
  }

  /** the storm's inside roar dips under an enemy (feet within ~20 m, gunfire within ~80 m): up to 12 dB, back in ~0.6 s */
  private stormDuck(gainDb: number, gun: boolean, at: number) {
    if (this.stormIn < 0.15) return;
    const lv = this.loops.get("__storm");
    if (!lv?.duck || lv.stopping) return;
    const db = gun ? Math.min(10, Math.max(0, (gainDb + 50) / 2.2)) : Math.min(15, Math.max(0, (gainDb + 52) / 1.8));
    if (db < 1) return;
    const p = lv.duck.gain, t = Math.max(at, this.ctx.currentTime);
    p.cancelScheduledValues(t);
    p.setTargetAtTime(dbg(-db * this.stormIn), t, 0.015);
    p.setTargetAtTime(1, t + 0.2, 0.3);
  }

  /** a plain 2D one-shot of `group` on `bus` at time `at` (sweeteners) */
  private oneShot(group: string, bus: Bus, db: number, at: number) {
    const pk = this.lib.pick(group, this.rnd);
    if (!pk) return;
    const s = this.ctx.createBufferSource(); s.buffer = pk.buf;
    const g = this.ctx.createGain(); g.gain.value = dbg(db + this.lib.normDb(pk.file));
    s.connect(g).connect(this.mixer.buses[bus]);
    s.start(at);
    this.voices.push({ nodes: [g], srcs: [s], end: at + pk.buf.duration, group: "sweet", start: this.ctx.currentTime, out: g, local: true, db, prio: 9, dist: 0 });
  }

  /** echo voices are the first thing to give up in a busy fight (cap 12, none for far remote shots when busy) */
  private echoBudget(local: boolean, d: number): boolean {
    if (local) return true;
    let n = 0, e = 0;
    for (const v of this.voices) { n++; if (v.group === "echo") e++; }
    if (e >= 12) return false;
    return !(n > 48 && d > 150);
  }

  /**
   * Voice cap with priority. Never stolen: your own voices and the 4 nearest remote emitters. Otherwise the quietest,
   * oldest voice goes first (a far tail); if everything playing matters more than the newcomer, the newcomer is dropped.
   */
  private allocate(group: string, cap: number, local: boolean, db: number, prio: number, dist: number, emitter?: string): boolean {
    let n = 0;
    for (const v of this.voices) if (v.group === group) n++;
    if (n < cap) return true;
    const now = this.ctx.currentTime;
    // the 4 nearest remote emitters (voices without an emitter count on their own) are protected — found without
    // allocating: an insertion list of 4 (key, distance) in reused arrays
    const nk = this.nearK, nd = this.nearD;
    let nn = 0;
    for (const v of this.voices) {
      if (v.group !== group || v.local) continue;
      const k: string | Voice = v.emitter ?? v;
      let j = 0;
      for (; j < nn; j++) if (nk[j] === k) break;
      if (j < nn) { if (v.dist < nd[j]) nd[j] = v.dist; else continue; }
      else if (nn < 4) { nk[nn] = k; nd[nn] = v.dist; j = nn++; }
      else { let w = 0; for (let i = 1; i < 4; i++) if (nd[i] > nd[w]) w = i; if (v.dist >= nd[w]) continue; nk[w] = k; nd[w] = v.dist; }
    }
    const isProt = (k: string | Voice) => { for (let i = 0; i < nn; i++) if (nk[i] === k) return true; return false; };
    let far4 = 0;
    for (let i = 0; i < nn; i++) if (nd[i] > far4) far4 = nd[i];
    let victim: Voice | null = null, best = Infinity;
    for (const v of this.voices) {
      if (v.group !== group || v.local || isProt(v.emitter ?? v)) continue;
      const s = v.db + 6 * v.prio - 18 * Math.max(0, now - v.start - 0.1);
      if (s < best) { best = s; victim = v; }
    }
    const newcomerNear = !local && (nn < 4 || dist < far4 || (emitter !== undefined && isProt(emitter)));
    for (let i = 0; i < 4; i++) nk[i] = null;
    if (!victim) {
      if (!local && !newcomerNear) { this.dropped++; return false; }
      // your own sound (or a nearer shooter) with a cap full of protected voices: the oldest remote, else the oldest
      let old: Voice | null = null;
      for (const v of this.voices) if (v.group === group && !v.local && (!old || v.start < old.start)) old = v;
      if (!old) for (const v of this.voices) if (v.group === group && (!old || v.start < old.start)) old = v;
      if (old) { this.kill(old); this.stolen++; }
      return true;
    }
    if (!local && !newcomerNear && db + 6 * prio < best) { this.dropped++; return false; }
    this.kill(victim);
    this.stolen++;
    return true;
  }
  private nearK: (string | Voice | null)[] = [null, null, null, null];
  private pt = 0;
  private plap = (k: string) => { const P = this.prof; if (!P) return; const q = performance.now(); P["t." + k] = Math.max(P["t." + k] ?? 0, q - this.pt); this.pt = q; };
  private nearD = new Float64Array(4);

  /** a remote gun keeps at most `max` voices (its older shots are already choked under the new transient). The oldest
   * is cut when the NEW shot lands (`at`), not now: a distant burst is still in flight (speed of sound) — cutting it now killed every
   * shot of a 150 m burst but the last two before it was ever heard */
  private limitEmitter(emitter: string, max: number, at: number) {
    let n = 0;
    for (const v of this.voices) if (v.emitter === emitter && v.group === "gun") n++;
    while (n > max) {
      let old: Voice | null = null;
      for (const v of this.voices) if (v.emitter === emitter && v.group === "gun" && (!old || v.start < old.start)) old = v;
      if (!old) break;
      this.kill(old, at);
      n--;
    }
  }

  private layerWeight(L: Layer, local: boolean, d: number, sp?: EventDef["spatial"]) {
    if (L.who === "local" && !local) return 0;
    if (L.who === "remote" && local) return 0;
    if (local || !sp || !L.band) return 1;
    const B = sp.bands;
    if (B) {
      // equal-power crossfades between loudness-matched layers: the curve alone sets the level, the bands the character
      switch (L.band) {
        case "near": return Math.cos(HALF_PI * smooth(B.near[0], B.near[1], d));
        case "far": return Math.sin(HALF_PI * smooth(B.near[0], B.near[1], d)) * Math.cos(HALF_PI * smooth(B.far[0], B.far[1], d));
        case "dist": return Math.sin(HALF_PI * smooth(B.far[0], B.far[1], d));
        case "tail": return Math.cos(HALF_PI * smooth(B.tail[0], B.tail[1], d));
        // the rolling tail rises against the report with range, up to +9 dB (the report stays the louder part: the air
        // darkens the report, not the already-dark tail, so an uncapped tail would stop the shot getting quieter)
        case "ftail": { const f = B.ftail; return f ? smooth(f[0], f[1], d) * dbg(Math.min(9, f[2] * Math.log2(Math.max(1, d / f[3])))) : 0; }
      }
    }
    const near = sp.near ?? [30, 120], far = sp.far ?? [40, 150];
    if (L.band === "near") return 1 - smooth(near[0], near[1], d);
    if (L.band === "far") return smooth(far[0], far[1], d);
    // tail: the local-field reverb of the shot — holds out to mid range, thins towards the horizon
    return 1 - 0.75 * smooth(near[0] * 1.5, near[1] * 3, d);
  }

  private source(buf: AudioBuffer, file: ManifestFile, L: Layer, o: PlayOpts, w: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const semis = L.pitch ? (this.rnd() * 2 - 1) * L.pitch : 0;
    src.playbackRate.value = (o.rate ?? 1) * (L.rate ?? 1) * Math.pow(2, semis / 12);
    const g = this.ctx.createGain();
    // round-robin level variance ±0.8 dB — ±0.25 dB on the distance bands (a far report's level IS the range cue)
    const jit = L.band === "far" || L.band === "dist" || L.band === "ftail" ? 0.5 : 1.6;
    g.gain.value = w * dbg((L.db ?? 0) + this.lib.normDb(file) + (this.rnd() - 0.5) * jit);
    return { src, g };
  }

  private encQueue: V3[] = [];
  private echoJobs: { g: string; pos: V3; at: number; db: number; bus: Bus; rate: number; emitter?: string; dist: number; local: boolean }[] = [];
  private echo(group: string, p: V3, at: number, db: number, bus: Bus, o: PlayOpts, emitter?: string, path = 100, local = false) {
    if (db < -60) return;
    const g0 = this.grp(group);
    if (!g0) return;
    // echoes never steal: a full echo budget simply skips the newcomer (a burst's echoes overlap — nobody hears one go)
    let ne = 0;
    for (const v of this.voices) if (v.group === "echo") ne++;
    if (ne >= (local ? 18 : 12)) return;
    this.echoCount++;
    const pk = this.lib.pick(g0, this.rnd);
    if (!pk) return;
    const src = this.ctx.createBufferSource();
    src.buffer = pk.buf;
    src.playbackRate.value = (o.rate ?? 1) * Math.pow(2, (this.rnd() - 0.5) * 0.6 / 12);
    const g = this.ctx.createGain(); g.gain.value = dbg(db + this.lib.normDb(pk.file));
    // the air + the rough face eat the top: a near face returns a bright slap, a far ridge a dull thud
    const f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 700 + 3200 * Math.exp(-path / 350); f.Q.value = 0.5;
    const hpf = this.ctx.createBiquadFilter(); hpf.type = "highpass"; hpf.frequency.value = 150; hpf.Q.value = 0.5;
    const pn = this.makePanner(p, 999, 0);
    src.connect(g).connect(f).connect(hpf).connect(pn).connect(this.mixer.buses[bus]);
    src.start(at);
    this.voices.push({ nodes: [g, f, hpf, pn], srcs: [src], end: at + pk.buf.duration, group: "echo", start: this.ctx.currentTime, out: g, emitter, local, db, prio: local ? 9 : 0, dist: path });
  }

  /** the gun that fired `name` from `pos` (null = you): same weapon within 3 m and 1.5 s = the same shooter */
  private emitterFor(name: string, pos: V3 | null, now: number): string {
    // drop stale shooters in place
    let j = 0;
    for (let i = 0; i < this.emitters.length; i++) { const q = this.emitters[i]; if (now - q.t < 1.5 && now >= q.t) this.emitters[j++] = q; }
    this.emitters.length = j;
    let e: Emitter | undefined;
    for (const q of this.emitters) {
      if (q.name !== name) continue;
      if (pos ? q.pos && Math.hypot(q.pos[0] - pos[0], q.pos[1] - pos[1], q.pos[2] - pos[2]) < 3 : !q.pos) { e = q; break; }
    }
    if (!e) { e = { key: `${name}#${pos ? ++this.emitterSeq : "me"}`, name, pos: pos ? [pos[0], pos[1], pos[2]] : null, t: now }; this.emitters.push(e); }
    e.t = now;
    if (pos && e.pos) { e.pos[0] = pos[0]; e.pos[1] = pos[1]; e.pos[2] = pos[2]; }
    return e.key;
  }

  /** pull the still-ringing voices of this emitter down ~10 dB as the new shot lands (its transient masks the drop) */
  private choke(emitter: string, at: number) {
    for (const v of this.voices) {
      if (v.emitter !== emitter || v.end <= at || v.group === "__dying") continue;
      const p = v.out.gain;
      const cur = p.value;
      p.cancelScheduledValues(at);
      p.setValueAtTime(cur, at);
      p.setTargetAtTime(cur * 0.3, at, 0.025);
    }
  }

  /**
   * Auto footsteps for the local player (listener = first-person camera). Grounded = the camera sits 0.95..1.9 m above
   * the box top / heightfield under it; cadence follows gameplay's view-bob (walk 2.7 steps/s, sprint 3.5, crouch 2.5)
   * so the feet land with the bob. Surface comes from the collider under the feet or the biome. Switched off for good
   * the moment gameplay plays its own local `step:*`.
   */
  /** the local player's step surface: the predicted player's feet + sim ground surface (render.ts' cm.pred), else the
   * collider / terrain under the listener */
  private localSwim(): boolean {
    try { return !!(globalThis as unknown as { __kr?: { game?: { cm?: { pred?: { swim?: boolean } } } } }).__kr?.game?.cm?.pred?.swim; } catch { return false; }
  }
  private localGround(): string {
    const cm = (globalThis as unknown as { __kr?: { game?: { cm?: { pred?: { x: number; y: number; z: number; surf: number; swim?: boolean }; world?: RayWorld } } } }).__kr?.game?.cm;
    const pr = cm?.pred;
    const t = this.world.terrain;
    // YOUR feet resolve exactly like everyone else's (steps.ts stepSurfaceUnder on the sim world: the surface
    // under the centre of the feet, the drawn-floor map, the visible splat) — the sim's capsule support id (`surf`) named
    // a container 0.3 m beside you when you stood on the apron next to it
    if (pr && t && pr.swim) return "water";
    if (pr && t && cm?.world && typeof cm.world.raycast === "function") return stepSurfaceUnderLive(cm.world, t, pr.x, pr.y, pr.z);
    if (pr && t) return stepSurfaceAt(t, pr.surf, pr.x, pr.y, pr.z);
    const L = this.listener.pos;
    return this.world.groundAt(L[0], L[1] - 1.4, L[2]).surf;
  }
  /** another kong's step surface under a foot: the sim world's standable boxes (cm.world, the same boxes the mover uses —
   * POIs, veg trunks, rocks) + the drawn-floor map + the visible splat (steps.ts stepSurfaceUnder); without a match the
   * acoustic world's POI boxes */
  remoteGround(x: number, y: number, z: number): string {
    const w = (globalThis as unknown as { __kr?: { game?: { cm?: { world?: RayWorld & { terrain?: Terrain } } } } }).__kr?.game?.cm?.world;
    const t = this.world.terrain ?? w?.terrain;
    if (w && typeof w.raycast === "function" && t) return stepSurfaceUnderLive(w, t, x, y, z);
    return this.world.groundAt(x, y, z).surf;
  }
  /** the predicted player's movement state (shared/sim/player.ts PS: 0 = on foot), -1 = no match */
  private localSt(): number {
    const pr = (globalThis as unknown as { __kr?: { game?: { cm?: { pred?: { st: number } } } } }).__kr?.game?.cm?.pred;
    return pr ? pr.st : -1;
  }
  /** a foot plant (feet.ts): the surface under THAT foot — yours from the predicted player (sim ground box + drawn-floor
   * map + visible splat; swimming = water), others' from the colliders / map / splat under their foot — and the set for
   * the gait (walk / sprint / crouch), scheduled on the audio clock at the plant */
  private footEvent(e: FootEvent) {
    if (this.stepsSuspended && e.local) return;
    const r = this.stepNameFor(e);
    if (!r) return;
    const [name, vol] = r;
    const P = this.tmpStep; P[0] = e.x; P[1] = e.y; P[2] = e.z;
    this.trigger(name, e.local ? { volume: vol, rate: e.rate } : { pos: P, volume: vol, rate: e.rate }, true, e.at);
  }
  private tmpStep: V3 = [0, 0, 0];
  /** the step event a foot plant plays — [event name, volume] — exactly as footEvent resolves it (tests call this on the
   * audit's positions in the live game) */
  stepNameFor(e: Pick<FootEvent, "local" | "kind" | "x" | "y" | "z" | "volume">): [string, number] | null {
    const surf = e.local ? this.localGround() : this.remoteGround(e.x, e.y, e.z);
    // a foot plant while SWIMMING (yours: the sim says so; another kong's: its feet are under the surface) is a stroke
    if (surf === "water" && BANK["water:stroke"] && (e.local ? this.localSwim() : e.y < -0.6)) return ["water:stroke", Math.max(0.55, e.volume)];
    let name = e.kind === "walk" ? `step:${surf}` : `step:${surf}:${e.kind}`, vol = e.volume;
    if (!BANK[name] || (e.kind !== "walk" && !this.lib.has(`step/${surf}-${e.kind}`))) { name = `step:${surf}`; if (e.kind === "crouch") vol *= 0.35; }
    return BANK[name] ? [name, vol] : null;
  }
  /** the last steps played [audio start time, sample group, local] (stats().feet.played) */
  private stepLog: [number, string, boolean][] = [];
  private footsteps(dt: number) {
    const L = this.listener;
    if (dt <= 0 || dt > 0.25) return;
    this.groundT -= dt;
    if (this.groundT <= 0 || !this.lastGround) {
      this.groundT = 0.05;
      this.lastGround = this.world.groundAt(L.pos[0], L.pos[1] - 1.4, L.pos[2]);
    }
    const G = this.lastGround;
    const h = L.pos[1] - G.y;
    const hs = Math.hypot(L.vel[0], L.vel[2]);
    const grounded = h > 0.9 && h < 1.95 && Math.abs(L.vel[1]) < 4 && hs < 11;
    const s = this.cadence.tick(dt, hs, grounded, h < 1.35);
    if (!s) return;
    this.autoStepCount++;
    this.trigger(`step:${G.surf}`, s, true);
  }

  kill(v: Voice, at?: number) {
    const t = Math.max(this.ctx.currentTime, at ?? 0);
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setValueAtTime(v.out.gain.value, t);
    v.out.gain.linearRampToValueAtTime(0, t + 0.015);
    for (const s of v.srcs) { try { s.stop(t + 0.02); } catch { /* */ } }
    v.end = t + 0.03;
    v.group = "__dying";
  }

  private reap(max = 1e9) {
    const t = this.ctx.currentTime;
    if (this.tagged.size > 32) for (const [k, v] of this.tagged) if (v.end < t) this.tagged.delete(k);
    if (!this.voices.length) return;
    let j = 0, n = 0;
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i];
      if (v.end + 0.05 < t && n < max) { n++; for (const s of v.srcs) s.disconnect(); for (const nd of v.nodes) nd.disconnect(); }
      else this.voices[j++] = v;
    }
    this.voices.length = j;
  }

  // ------------------------------------------------------------------ heal / shield use
  /**
   * `heal:use` / `shield:use`: a start cue, a sip / fizz loop for exactly the use time and a completion cue per
   * consumable landing at the end; stopLoop(loopId) (or the match state, see useBridge) cancels it with a short fade.
   * Returns false when the loop assets are missing (the caller then plays the legacy one-shot).
   */
  private useStart(name: string, o: PlayOpts): boolean {
    const kind = name === "shield:use" ? "shield" : "heal";
    if (!this.lib.has(`loot/${kind}-loop`)) return false;
    const local = !o.pos;
    const id = o.loopId ?? (local ? "use" : `use@${Math.round(o.pos![0])},${Math.round(o.pos![2])}`);
    const old = this.uses.get(id);
    if (old) this.endUse(old, false);
    let dur = o.dur, item = o.item, bridged = false;
    if (dur === undefined && local) {
      // bridge until gameplay passes dur/item: read the use from the local player's predicted state
      const p = this.gamePred();
      if (p && p.useTotal > 0) { dur = p.useTotal; bridged = true; const sl = p.slots?.[p.active]; if (sl && item === undefined) item = CONSUMABLES[sl.id]; }
    }
    dur = Math.max(0.6, Math.min(12, dur ?? 2));
    const now = this.ctx.currentTime, t0 = now, end = now + dur;
    const def = BANK[name];
    const out = this.ctx.createGain();
    out.gain.value = dbg((local ? (def.dbLocal ?? def.db ?? 0) : (def.db ?? 0)) + 20 * Math.log10(Math.max(1e-4, o.volume ?? 1)));
    const nodes: AudioNode[] = [out];
    let tail: AudioNode = out;
    if (!local) {
      const d = this.dist(o.pos as V3);
      if (d > 30) return true;
      const g = this.distGain(d, def.spatial!);
      out.gain.value *= g;
      const pn = this.makePanner(o.pos as V3, d, 30);
      tail.connect(pn); tail = pn; nodes.push(pn);
    }
    tail.connect(this.mixer.buses[local ? "p1" : "p3"]);
    const srcs: AudioBufferSourceNode[] = [];
    const one = (g: string, at: number, db: number) => {
      const pk = this.lib.pick(g, this.rnd);
      if (!pk) return;
      const s = this.ctx.createBufferSource(); s.buffer = pk.buf;
      const gg = this.ctx.createGain(); gg.gain.value = dbg(db + this.lib.normDb(pk.file));
      s.connect(gg).connect(out); s.start(at); srcs.push(s); nodes.push(gg);
    };
    // per-consumable start / loop / completion when the library has them (a leaf bundle is wrapped, not drunk)
    // the red banana is peeled + munched like the golden one
    if (item === "red-banana") item = "golden-banana";
    const own = (g: string, fb: string) => (item && this.lib.has(`${g}-${item}`) ? `${g}-${item}` : fb);
    one(own("loot/start", `loot/${kind}-start`), t0, 0);
    // the loop: fades in under the start cue, holds, and ends just as the completion cue lands
    const lp = this.lib.pick(own("loot/use", `loot/${kind}-loop`), this.rnd)!;
    const ls = this.ctx.createBufferSource(); ls.buffer = lp.buf; ls.loop = true;
    const lpnt = lp.file.loop ?? [0, lp.buf.duration];
    ls.loopStart = lpnt[0]; ls.loopEnd = lpnt[1];
    const lg = this.ctx.createGain();
    const lv = dbg(this.lib.normDb(lp.file) - 6);   // under the start / done cues: present, never busy
    // (the use loop is decoded at 32 kHz — its own anti-image low-pass; the start / done cues stay full-rate)
    const aa = lp.buf.sampleRate < this.ctx.sampleRate ? antiImage(this.ctx, lp.buf.sampleRate) : null;
    if (aa) { aa.output.connect(out); nodes.push(...aa.nodes); }
    lg.gain.setValueAtTime(0, t0);
    lg.gain.linearRampToValueAtTime(lv, t0 + 0.25);
    lg.gain.setValueAtTime(lv, Math.max(t0 + 0.26, end - 0.12));
    lg.gain.linearRampToValueAtTime(0, end + 0.02);
    ls.connect(lg).connect(aa ? aa.input : out);
    ls.start(t0 + 0.05, lpnt[0] + this.rnd() * (lpnt[1] - lpnt[0]));
    ls.stop(end + 0.05);
    srcs.push(ls); nodes.push(lg);
    // the completion cue: the consumable's own sting if there is one
    // (the smoothie is the SHIELD item now: its drink sounds stay, but it finishes on the shield "charged" ping, not
    // the heal kalimba its own done cue was built as)
    const done = item === "smoothie" ? "loot/shield-done" : own("loot/done", `loot/${kind}-done`);
    if (this.lib.has(done)) one(done, end - 0.03, local ? 0 : -6);
    const u: UseSession = { id, kind, t0, end, out, srcs, nodes, bridged, local };
    this.uses.set(id, u);
    this.played++;
    return true;
  }

  private endUse(u: UseSession, natural: boolean) {
    this.uses.delete(u.id);
    const t = this.ctx.currentTime;
    if (!natural && t < u.end - 0.02) {
      u.out.gain.cancelScheduledValues(t);
      u.out.gain.setValueAtTime(u.out.gain.value, t);
      u.out.gain.linearRampToValueAtTime(0, t + 0.07);
      for (const s of u.srcs) { try { s.stop(t + 0.08); } catch { /* */ } }
    }
    const endT = natural ? u.end + 2.5 : t + 0.1;
    this.voices.push({ nodes: u.nodes, srcs: u.srcs, end: endT, group: "use", start: u.t0, out: u.out, local: u.local, db: 0, prio: 9, dist: 0 });
  }

  /** fade a voice out over `sec` and stop it (a cancelled reload / tagged one-shot) */
  private fadeOut(v: Voice, sec: number) {
    const t = this.ctx.currentTime;
    v.out.gain.cancelScheduledValues(t);
    v.out.gain.setValueAtTime(v.out.gain.value, t);
    v.out.gain.linearRampToValueAtTime(0, t + sec);
    for (const s of v.srcs) { try { s.stop(t + sec + 0.01); } catch { /* */ } }
    v.end = Math.min(v.end, t + sec + 0.02);
  }

  // ------------------------------------------------------------------ your reload: exactly one sound per sim reload start
  /** the local reload timer as last seen (pred.reloadT), how many control ticks it has read ≤ 0, the last start */
  private rlPrev = 0;
  private rlZero = 99;
  private rlLast = -9;
  /** the match state is readable (live game): the reload follows it */
  private rlSeen = false;
  /** stats (tests): local reload sounds started, gameplay calls de-duplicated, starts found by the edge detector itself */
  private rlStats = { started: 0, deduped: 0, bridged: 0, calls: 0 };
  /** the log of local reload starts (tests: `__audio.stats().reloads`) — [audio time, weapon, source] */
  private rlLog: [number, string, string][] = [];

  /** gameplay asked for your reload sound (render.ts, or a future contract call with {dur, loopId}) */
  private localReloadCall(name: string, o: PlayOpts) {
    this.rlStats.calls++;
    const now = this.ctx.currentTime;
    // the edge detector first: when the match state shows the reload starting, it voices it (on the sim's timeline)
    if (this.reloadEdge()) { this.rlStats.deduped++; return; }
    if (now - this.rlLast < RELOAD_DEDUP) { this.rlStats.deduped++; return; }
    const p = this.gamePred() as { reloadT?: number; reloadTotal?: number } | null;
    if (p && p.reloadT !== undefined) {
      // the match is live: the sim says whether a reload is running — a call without one is a stale / spurious edge
      if (!(p.reloadT > 0)) { this.rlStats.deduped++; return; }
      // a reload that is running but was never voiced (the detector ran before this frame's sim tick): voice it now
      if (this.localReload && now < this.localReload.end) { this.rlStats.deduped++; return; }
      const total = p.reloadTotal && p.reloadTotal > 0 ? p.reloadTotal : (o.dur ?? this.reloadDur(name));
      this.startLocalReload(name, total, Math.max(0, total - p.reloadT), o, "call");
      return;
    }
    // offline (the Sound Lab / renders): no match state — the call is the start
    this.startLocalReload(name, o.dur ?? this.reloadDur(name), 0, o, "call");
  }

  private startLocalReload(name: string, dur: number, off: number, o: PlayOpts, src: string) {
    const now = this.ctx.currentTime;
    this.rlLast = now;
    this.rlStats.started++;
    if (src === "edge") this.rlStats.bridged++;
    if (this.rlLog.length < 4096) this.rlLog.push([+now.toFixed(3), name.slice(7), src]);
    // a new reload replaces one still sounding (reload-cancel-reload)
    if (this.localReload && now < this.localReload.end) this.fadeOut(this.localReload.v, 0.03);
    this.localReload = null;
    this.trigger(name, { ...o, dur, loopId: o.loopId ?? "reload", _rl: true, _rlOff: off } as PlayOpts, false);
  }

  /** the rising edge of the local reload timer (pred.reloadT): from ≤ 0 (held ≥ 2 control ticks, or no reload sounding)
   * to > 0, or a jump back up to ≈ the full time (a chained shotgun shell, a cancel + restart within one tick). A reconcile
   * that nudges the timer up a little (online: the snapshot's reload flag resets it) is not a start. Returns true when it
   * started one. */
  private reloadEdge(): boolean {
    const p = this.gamePred() as { reloadT?: number; reloadTotal?: number; active: number; slots?: { id: number; kind?: number }[] } | null;
    if (!p || p.reloadT === undefined) { this.rlSeen = false; return false; }
    this.rlSeen = true;
    const cur = p.reloadT, prev = this.rlPrev, total = p.reloadTotal && p.reloadTotal > 0 ? p.reloadTotal : 0;
    this.rlPrev = cur;
    if (!(cur > 0)) { this.rlZero++; return false; }
    const zeroRun = this.rlZero; this.rlZero = 0;
    const now = this.ctx.currentTime;
    const sounding = !!this.localReload && now < this.localReload.end;
    const fresh = prev <= 0 && (zeroRun >= 2 || !sounding);
    const restart = prev > 0 && total > 0 && cur - prev > 0.3 && cur >= total - 0.12 && cur <= total + 0.02;
    // catch-up: a reload is running that was never voiced (the prediction was already > 0 when the sim's reload began — a
    // mispredicted shot on an empty mag reconciled into a reload): voice the rest of it on the sim's timeline
    const catchUp = !fresh && !restart && !sounding && cur > 0.3 && total > 0 && cur < total - 0.05 && now - this.rlLast > 0.25;
    if (!fresh && !restart && !catchUp) return false;
    if (this.ctx.currentTime - this.rlLast < RELOAD_DEDUP) return false;
    const sl = p.slots?.[p.active];
    const w = sl ? WEAPONS[sl.id] : undefined;
    if (!w) return false;
    const T = total || RELOAD_S[w];
    this.startLocalReload(`reload:${w}`, T, Math.max(0, T - cur), {}, catchUp ? "catchup" : "edge");
    return true;
  }

  /** the sim's reload time per weapon (the reload assets are timed to it) */
  private reloadDur(name: string): number {
    return RELOAD_S[name.slice(7) as keyof typeof RELOAD_S] ?? 2;
  }

  /** watch the local use: finished → free it; interrupted (use timer gone early, switched item, died) → cancel */
  private useBridge() {
    // your reload: the sim dropped the reload timer early (swapped weapon, fired a loaded shotgun) → the rest of the
    // reload sound stops too
    const r = this.localReload;
    if (r) {
      const t = this.ctx.currentTime;
      if (t > r.end) this.localReload = null;
      else if (t > r.t0 + 0.12 && t < r.end - 0.15) {
        if (this.rlSeen && this.rlZero >= 2) { this.fadeOut(r.v, 0.05); this.localReload = null; }
      }
    }
    if (!this.uses.size) return;
    const t = this.ctx.currentTime;
    for (const u of [...this.uses.values()]) {
      if (t > u.end + 0.1) { this.endUse(u, true); continue; }
      if (!u.bridged) continue;
      const p = this.gamePred();
      if (p && p.useT <= 0 && t < u.end - 0.2 && t > u.t0 + 0.1) this.endUse(u, false);
    }
  }

  /** the local player's predicted sim state (debug handle the game publishes) — bridge only, never required */
  private gamePred(): { useT: number; useTotal: number; active: number; slots?: { id: number }[] } | null {
    if (!this.live) return null;
    try {
      const g = (globalThis as unknown as { __kr?: { game?: { cm?: { pred?: { useT: number; useTotal: number; active: number; slots?: { id: number }[] } } } } }).__kr?.game;
      return g?.cm?.pred ?? null;
    } catch { return null; }
  }

  // ------------------------------------------------------------------ storm wall
  private stormCircle(env: Env): StormCircle | null {
    if (env.storm !== undefined) return env.storm && env.storm.r > 0 && env.storm.r < 4000 ? env.storm : null;
    if (!this.live) return null;
    // bridge until gameplay passes env.storm: the match's storm state from the game's debug handle
    try {
      const cm = (globalThis as unknown as { __kr?: { game?: { cm?: { phase: number; storm: { cx: number; cz: number; r: number; phase: number } } } } }).__kr?.game?.cm;
      if (!cm || cm.phase < 1 || cm.phase > 2 || !cm.storm || cm.storm.phase < 1) return null;
      const s = cm.storm;
      return Number.isFinite(s.r) && s.r > 0 && s.r < 4000 ? { x: s.cx, z: s.cz, r: s.r } : null;
    } catch { return null; }
  }

  /** the wall emitter sits on the circle at the point nearest you; inside the storm the 2D roar takes over */
  private stormWall(env: Env) {
    const s = this.stormCircle(env);
    const L = this.listener.pos;
    const lv = this.loops.get("__storm");
    if (!s) {
      this.stormD = null; this.stormIn = 0;
      if (lv && !lv.stopping) this.stopLoop("__storm");
      return;
    }
    const dx = L[0] - s.x, dz = L[2] - s.z, dc = Math.hypot(dx, dz);
    const sd = dc - s.r;
    // the wall's loops decode before you can hear it (400 m out: the loop then starts without a decode wait), and are
    // released again a while after you leave it behind (lazy groups)
    if (sd > -400 && !this.stormFetched) { this.stormFetched = true; for (const g of STORM_GROUPS) if (this.lib.groups.has(g)) this.want(g, true); }
    else if (sd < -500) this.stormFetched = false;
    this.stormD = sd;
    this.stormIn = smooth(-3, 12, sd);
    const gp = this.loops.get("storm:loop");
    if (gp && !gp.stopping) this.stopLoop("storm:loop");
    if (sd < -240) { if (lv && !lv.stopping) this.stopLoop("__storm"); return; }
    const nx = dc > 1 ? dx / dc : 1, nz = dc > 1 ? dz / dc : 0;
    const t = this.world.terrain;
    const wx = s.x + nx * s.r, wz = s.z + nz * s.r;
    const wy = Math.max(L[1] + 2, (t ? Math.max(0, t.height(wx, wz)) : 0) + 6);
    const pos: V3 = [wx, wy, wz];
    // (the loop itself starts from the idle-time slice: building its voice is not a per-frame job)
    if (!lv || lv.stopping) { if (!this.stormStart) this.stormStartT = this.ctx.currentTime; this.stormStart = pos; }
    else lv.pos = pos;
  }

  // ------------------------------------------------------------------ loops
  /** section timings (ms) of the last loop start — attached to the slow-call log when a play() is slow */
  private loopProf = "";
  private startLoop(name: string, def: EventDef, o: PlayOpts) {
    const lt0 = performance.now();
    this.loopProf = "";
    const id = o.loopId ?? name;
    const ex = this.loops.get(id);
    if (ex && !ex.stopping) {
      if (o.pos) { if (ex.pos) { ex.pos[0] = o.pos[0]; ex.pos[1] = o.pos[1]; ex.pos[2] = o.pos[2]; } else ex.pos = [o.pos[0], o.pos[1], o.pos[2]]; }
      if (o.volume !== undefined) ex.vol = o.volume;
      if (o.rate !== undefined) ex.rate = o.rate;
      return;
    }
    // the plane phase begins: the whole drop's winds decode now (the freefall must not wait for its decode after the jump)
    // (live: 4 s in — the lobby's beds are released first as you climb; the ramp opens well after that)
    if (def.loop === "plane" && !this.planeActive) { this.planeActive = true; this.planeExit = false; this.rampOpen = false; }
    if (def.loop === "freefall" || def.loop === "glider") this.planeExit = true;
    // the whole drop (cabin, flyover, freefall, glider) is requested — and starts loading — the moment the plane loop is
    // asked for (fetched from idle slices only, a stalled match rode a silent plane for ~15 s)
    if (def.loop === "plane" && !this.dropWanted) { this.dropWanted = true; for (const g of DROP_GROUPS) if (this.lib.groups.has(g)) this.want(g, true); }
    if (def.loop === "plane") for (const g of DROP_GROUPS) this.lib.markUsed(g);
    if (name === "heli:rotor") this.wantHeliGun();
    // (a stopping loop with this id keeps its fade; the new one replaces it in the map — no hard cut, no click)
    const layers: { L: Layer; g: string }[] = [];
    for (const L of def.layers) {
      // a layer for you (no pos) or for the world only, as in a one-shot (layerWeight): gun:fire's stereo take aboard,
      // its mono sum out in the world
      if (L.who && (L.who === "local") !== !o.pos) continue;
      const g = this.grp(L.g);
      if (!g || !this.lib.groups.has(g)) continue; // optional layer not in this library
      if (!this.lib.has(g)) {
        // not decoded yet (a lazy group decodes on demand now): retried from update() until it is
        if (this.lib.isLazy(g)) this.want(g, true);
        this.pendingLoops.set(id, { name, o: { ...o, pos: o.pos ? [o.pos[0], o.pos[1], o.pos[2]] : undefined } });
        return;
      }
      layers.push({ L, g });
    }
    if (!layers.length) { this.pendingLoops.set(id, { name, o: { ...o, pos: o.pos ? [o.pos[0], o.pos[1], o.pos[2]] : undefined } }); return; }
    for (const { g } of layers) this.lib.markUsed(g);
    const lt1 = performance.now();
    // the loop's lowest decode rate (a 24 kHz cabin / wind, a 32 kHz storm / chest hum) → its bus's anti-image entry
    let rate = this.ctx.sampleRate;
    for (const { g } of layers) rate = Math.min(rate, this.lib.rateOf(g));
    const out = this.ctx.createGain(); out.gain.value = 0;
    const lp = this.ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 20000; lp.Q.value = 0.5;
    const local = !o.pos;
    const lv: LoopVoice = { name, def, out, lp, srcs: [], pos: o.pos ? ([...o.pos] as V3) : undefined, vol: o.volume ?? 1, rate: o.rate ?? 1, local, occ: 0, lastOcc: 0, nextSpr: 0.3 + this.rnd(), extra: [], groups: layers.map((x) => x.g), drift: [], shuf: [] };
    const bus = this.mixer.aaIn(local ? (def.busLocal ?? def.bus) : def.bus, rate);
    const dual = def.loop === "plane" || def.loop === "wall";
    if (dual) {
      // near layers → inner (2D: the cabin / inside the storm); far layers → outer → air absorption → panner
      lv.inner = this.ctx.createGain(); lv.outer = this.ctx.createGain();
      lv.inner.gain.value = 0; lv.outer.gain.value = 0;
      if (def.loop === "wall") {
        // inside the storm: the roar is all around you — a low-mid wind roar, not a sub drone, and a carve at 1.5-4 kHz so
        // an enemy's feet and gunfire still read through it (the crackles are sparse one-shots on top)
        const sh = this.ctx.createBiquadFilter(); sh.type = "lowshelf"; sh.frequency.value = 130; sh.gain.value = -6;
        const pk = this.ctx.createBiquadFilter(); pk.type = "peaking"; pk.frequency.value = 2200; pk.Q.value = 0.7; pk.gain.value = -9.5;
        lv.duck = this.ctx.createGain();
        lv.inner.connect(sh).connect(pk).connect(lv.duck).connect(out);
        lv.extra.push(sh, pk, lv.duck);
      } else lv.inner.connect(out);
      lv.panner = this.makePanner(lv.pos ?? this.listener.pos, 0, 1e9);
      // mono into the HRTF: a stereo bed through the panner smears its direction
      lv.panner.channelCount = 1; lv.panner.channelCountMode = "explicit";
      lv.outerLp = this.ctx.createBiquadFilter(); lv.outerLp.type = "lowpass"; lv.outerLp.frequency.value = 20000; lv.outerLp.Q.value = 0.5;
      if (def.loop === "wall") {
        lv.farPk = this.ctx.createBiquadFilter(); lv.farPk.type = "peaking"; lv.farPk.frequency.value = 1100; lv.farPk.Q.value = 0.7; lv.farPk.gain.value = 0;
        lv.outer.connect(lv.farPk).connect(lv.outerLp);
        lv.extra.push(lv.farPk);
      } else lv.outer.connect(lv.outerLp);
      lv.outerLp.connect(lv.panner).connect(out);
      out.connect(lp).connect(bus);
    } else if (!local && def.spatial) {
      lv.panner = this.makePanner(lv.pos!, 0, 1e9);
      out.connect(lp).connect(lv.panner).connect(bus);
    } else out.connect(lp).connect(bus);
    const now = this.ctx.currentTime;
    const lt2 = performance.now();
    for (const { L, g } of layers) {
      const pk = this.lib.pick(g, this.rnd)!;
      const src = this.ctx.createBufferSource();
      src.buffer = pk.buf; src.loop = true;
      const lpnt = pk.file.loop ?? [0, pk.buf.duration];
      src.loopStart = lpnt[0]; src.loopEnd = lpnt[1];
      const gn = this.ctx.createGain(); gn.gain.value = dbg(this.lib.normDb(pk.file) + (L.db ?? 0));
      if (L.drift) lv.drift.push({ g: gn, base: gn.gain.value, db: L.drift, next: this.rnd() * 1.5 });
      if (L.shuffle) {
        const fader = this.ctx.createGain();
        src.connect(fader).connect(gn); lv.extra.push(fader);
        lv.shuf.push({ buf: pk.buf, lp: [lpnt[0], lpnt[1]], gn, src, fader, next: L.shuffle[0] + this.rnd() * (L.shuffle[1] - L.shuffle[0]), every: L.shuffle });
      } else src.connect(gn);
      let tail: AudioNode = gn;
      // (the drop): a layer whose level follows your speed / your turn rate gets its own control gain (after the
      // drift gain: both can move it) — see updateLoop
      if (L.speed || L.turn) { const ctl = this.ctx.createGain(); ctl.gain.value = 0; gn.connect(ctl); tail = ctl; (lv.ctl ??= []).push({ g: ctl, L }); lv.extra.push(ctl); }
      tail.connect(dual ? (L.band === "far" ? lv.outer! : lv.inner!) : out);
      // random phase so two identical loops never align
      src.start(now, lpnt[0] + this.rnd() * (lpnt[1] - lpnt[0]));
      lv.srcs.push(src); lv.extra.push(gn);
    }
    this.loops.set(id, lv);
    const lt3 = performance.now();
    this.updateLoop(lv, 0, true, true);
    const lt4 = performance.now();
    this.loopProf = `pre ${(lt1 - lt0).toFixed(1)} graph ${(lt2 - lt1).toFixed(1)} srcs ${(lt3 - lt2).toFixed(1)} upd ${(lt4 - lt3).toFixed(1)}`;
  }

  private updateLoop(lv: LoopVoice, dt: number, heavy: boolean, first = false) {
    if (lv.stopping) return;
    const def = lv.def, sp = def.spatial, t = this.ctx.currentTime;
    // (the freefall wind swells in over ~1 s under the exit whoosh — the exit is the moment, the wind its aftermath)
    // (the glider's wind swells in over ~1.5 s: the canopy SNAPS open into a moment of quiet — the deceleration you hear)
    const tc = first ? (def.loop === "freefall" ? 0.35 : def.loop === "glider" ? 0.5 : def.loop === "bay" ? 0.2 : 0.05) : 0.12;
    let db = (lv.local ? (def.dbLocal ?? def.db ?? 0) : (def.db ?? 0)) + 20 * Math.log10(Math.max(1e-4, lv.vol));
    let lpHz = 20000, rate = lv.rate;
    const L = this.listener;
    if (lv.pos && lv.panner) {
      const p = lv.panner;
      if (p.positionX) { setT(p.positionX, lv.pos[0], t, 0.05, 0.02, true); setT(p.positionY, lv.pos[1], t, 0.05, 0.02, true); setT(p.positionZ, lv.pos[2], t, 0.05, 0.02, true); }
    }
    if (def.loop === "plane") {
      const d = lv.pos ? this.dist(lv.pos) : 0;
      // the game hears the ride from its CHASE camera (render.ts planeCamera: 34-44 m behind / above the plane), not
      // from a cabin seat (a cabin mix for a 2 m listener the game never uses gave the chase camera the
      // exterior drone at full level: -14.6 LUFS, the loudest part of every match). While you are aboard (the drone loop
      // started, you have not jumped: no jump:exit / freefall / glider yet) the ride mix plays wherever the camera orbits
      // within ~70 m: the cabin layers (engine bark, prop harmonics, panel buzz — the ride's body) + the exterior drone at a
      // riding level (the prop you see). After the jump (or from the ground) only the exterior drone, by distance.
      const rideT = !this.planeExit && !this.loops.has("freefall:wind") && !this.loops.has("glider:wind") ? 1 - smooth(70, 110, d) : 0;
      lv.ride = first || lv.ride === undefined ? rideT : lv.ride + (rideT - lv.ride) * (1 - Math.exp(-dt / 0.2));
      const ride = lv.ride;
      // (once you are out in the wind — freefall / glider — the departing plane sinks under it: the roar of 40-60 m/s
      // of air masks a prop 200 m away, the plane is a far shape, not the loudest thing in the sky)
      const windMask = this.loops.has("freefall:wind") ? 0.22 : this.loops.has("glider:wind") ? 0.45 : 1;
      const outW = (lv.pos ? ride * RIDE_EXT + (1 - ride) * (sp ? this.distGain(d, sp) : 1) : 0) * (ride > 0.5 ? 1 : windMask);
      setT(lv.inner!.gain, ride * RIDE_CABIN, t, tc);
      setT(lv.outer!.gain, outW, t, tc);
      if (sp) setT(lv.outerLp!.frequency, Math.min(20000, this.airHz(d, sp)), t, tc);
      // gentle doppler on the flyover
      if (lv.pos && dt > 0) {
        const pd = lv.prevDist ?? d;
        const vr = (d - pd) / dt;
        lv.prevDist = d;
        if (d > 20) rate *= Math.max(0.85, Math.min(1.15, 343 / (343 + vr)));
      }
    } else if (def.loop === "wall") {
      const d = lv.pos ? this.dist(lv.pos) : 0;
      const ins = this.stormIn;
      // outside: the wall is a place (spatial, rising ~21 dB over the last 150 m); inside: all around you, with the wall
      // behind you fading — an equal-power crossfade at the wall's own level, so crossing it never drops the level
      const e = HALF_PI * ins;
      const outW = (sp ? this.distGain(d, sp) : 1) * Math.cos(e);
      setT(lv.inner!.gain, Math.sin(e) * STORM_INNER, t, tc);
      setT(lv.outer!.gain, outW, t, tc);
      if (lv.farPk) setT(lv.farPk.gain, 3.5 * smooth(40, 150, d), t, 0.3, 0.02, true);
      if (sp) setT(lv.outerLp!.frequency, Math.min(20000, this.airHz(d, sp)), t, tc);
      if (heavy) this.occDue = true;
      lv.lastOcc += (lv.occ - lv.lastOcc) * (first ? 1 : 0.35);
      // (a storm wall is hundreds of metres tall: a ridge between you and its foot takes only a little of it — 3 dB)
      db -= lv.lastOcc * 3 * (1 - ins);
      if ((this.env as { _muteStorm?: boolean })._muteStorm) db = -200; // dev: the bed as heard beside the wall, without it
    } else if (def.loop === "freefall") {
      // real freefall recordings — the body of the fall from ~10 m/s, the bright rush and the dive's buffeting
      // crossfade in by speed (Layer.speed in bank.ts); the whole wind opens up and lifts with it (eyes level ≈ 39 m/s,
      // full dive ≈ 60 m/s: +3 dB, the low-pass 8.7 → 12.9 kHz)
      const v = L.speed;
      const k = Math.min(1, Math.max(0, (v - 12) / 48));
      db += 20 * Math.log10(0.2 + 0.8 * k);
      lpHz = 900 + 200 * v;
      rate *= 0.92 + Math.min(0.16, v / 380);
    } else if (def.loop === "bay") {
      // the ramp is open — as much of it as you are riding the plane (its ride mix), swelling open over ~2 s
      const ride = this.loops.get("plane:drone")?.ride ?? 0;
      const want = this.rampOpen && !this.planeExit ? 1 : 0;
      lv.open = first || lv.open === undefined ? 0 : lv.open + (want - lv.open) * (1 - Math.exp(-dt / 0.7));
      db += 20 * Math.log10(Math.max(1e-4, ride * lv.open));
    } else if (def.loop === "glider") {
      const v = L.speed;
      db += 20 * Math.log10(0.35 + 0.65 * Math.min(1, v / 24));
      lpHz = 1300 + 220 * v;
      rate *= 0.95 + Math.min(0.15, v / 300);
    } else if (lv.pos && sp) {
      const d = this.dist(lv.pos);
      if (heavy && sp.occl) this.occDue = true;
      if (first && sp.occl) this.loopOcclusion(lv);
      lv.lastOcc += (lv.occ - lv.lastOcc) * (first ? 1 : 0.35);
      db += 20 * Math.log10(Math.max(1e-6, this.distGain(d, sp))) - lv.lastOcc * 10;
      lpHz = Math.min(this.airHz(d, sp), 20000 * Math.pow(1100 / 20000, lv.lastOcc));
    }
    if (def.loop === "zip") {
      // the trolley follows the ride speed — rate = speed / 16 m/s: louder (+8 dB from a crawl to full speed) and
      // brighter as it runs (the wheels' roar opens up), its whine pitch is the playbackRate itself
      const k = Math.min(1.6, Math.max(0.3, lv.rate));
      db += 20 * Math.log10(0.25 + 0.75 * Math.min(1, k)) + 3 * Math.max(0, k - 1);
      lpHz = Math.min(lpHz, 2500 + 9000 * Math.min(1, k));
    }
    setT(lv.out.gain, db < -80 ? 0 : dbg(db), t, tc);
    setT(lv.lp.frequency, Math.min(20000, lpHz), t, tc);
    // layers that follow your speed (freefall body → rush → dive buffeting) or your turn (the glider's fabric)
    if (lv.ctl) for (const c of lv.ctl) {
      let d = c.L.speed ? ramp4(L.speed, c.L.speed) : -60;
      if (c.L.turn) d = Math.max(d, ramp4(this.turnRate, c.L.turn));
      setT(c.g.gain, d <= -59 ? 0 : dbg(d), t, first ? 0.03 : 0.15);
    }
    for (const s of lv.srcs) setT(s.playbackRate, rate, t, 0.1, 0.001);
    // re-seeking layers: a fresh source at a random point of the loop crossfades in (equal power, 0.9 s) over the old one
    for (const sh of lv.shuf) {
      sh.next -= dt;
      if (sh.next > 0 || dt <= 0) continue;
      sh.next = sh.every[0] + this.rnd() * (sh.every[1] - sh.every[0]);
      const xf = 0.9;
      const src = this.ctx.createBufferSource(); src.buffer = sh.buf; src.loop = true;
      src.loopStart = sh.lp[0]; src.loopEnd = sh.lp[1];
      src.playbackRate.value = rate;
      const fader = this.ctx.createGain(); fader.gain.value = 0;
      src.connect(fader).connect(sh.gn);
      src.start(t, sh.lp[0] + this.rnd() * (sh.lp[1] - sh.lp[0]));
      fader.gain.setValueCurveAtTime(XF_IN, t, xf);
      sh.fader.gain.cancelScheduledValues(t);
      sh.fader.gain.setValueCurveAtTime(XF_OUT, t, xf);
      const old = sh.src, oldF = sh.fader;
      try { old.stop(t + xf + 0.02); } catch { /* */ }
      old.onended = () => { old.disconnect(); oldF.disconnect(); };
      const i = lv.srcs.indexOf(old); if (i >= 0) lv.srcs[i] = src; else lv.srcs.push(src);
      const j = lv.extra.indexOf(oldF); if (j >= 0) lv.extra[j] = fader; else lv.extra.push(fader);
      sh.src = src; sh.fader = fader;
    }
    // wandering layer levels: each drifting layer glides to a new random level every 1.2-3.6 s — two loops of different
    // lengths then never line up the same way twice (the envelope has no period to repeat)
    for (const dr of lv.drift) {
      dr.next -= dt;
      if (dr.next > 0) continue;
      const span = 1.2 + this.rnd() * 2.4;
      dr.next = span;
      const g = dr.base * dbg((this.rnd() * 2 - 1) * dr.db);
      dr.g.gain.cancelScheduledValues(t);
      dr.g.gain.setTargetAtTime(g, t, span / 3);
    }
    // random one-shots inside the loop (rattles, flaps, crackles): the loop never repeats the same way twice
    if (def.sprinkle && dt > 0) {
      lv.nextSpr -= dt;
      if (lv.nextSpr <= 0) {
        const sp2 = def.sprinkle;
        lv.nextSpr = sp2.every[0] + this.rnd() * (sp2.every[1] - sp2.every[0]);
        // in a turn the wing's fabric snaps up to 4× as often
        if (def.loop === "glider") lv.nextSpr /= 1 + 3 * Math.min(1, Math.max(0, (this.turnRate - 0.2) / 1.0));
        const g = this.grp(sp2.g);
        const pk = g ? this.lib.pick(g, this.rnd) : undefined;
        if (!pk && g && this.lib.isLazy(g)) this.want(g);
        else if (g && this.lib.isLazy(g)) this.lib.markUsed(g);
        if (pk) {
          const s = this.ctx.createBufferSource(); s.buffer = pk.buf;
          s.playbackRate.value = rate * Math.pow(2, ((this.rnd() * 2 - 1) * (sp2.pitch ?? 1)) / 12);
          const gg = this.ctx.createGain(); gg.gain.value = dbg(sp2.db + this.lib.normDb(pk.file) - this.rnd() * 6);
          const target = def.loop === "wall" ? (this.stormIn > 0.5 && this.rnd() < 0.6 ? lv.inner! : lv.outer!) : lv.inner ?? lv.out;
          let node: AudioNode = gg;
          const nodes: AudioNode[] = [gg];
          if (target !== lv.outer && (this.ctx as AudioContext).createStereoPanner) {
            const pn = this.ctx.createStereoPanner(); pn.pan.value = this.rnd() * 1.6 - 0.8; gg.connect(pn); node = pn; nodes.push(pn);
          }
          s.connect(gg); node.connect(target);
          s.start(t);
          this.voices.push({ nodes, srcs: [s], end: t + pk.buf.duration / s.playbackRate.value, group: "sprinkle", start: t, out: gg, local: true, db: -30, prio: 0, dist: 0 });
        }
      }
    }
  }

  /** a positional loop's occlusion (idle-time slice, every 0.15 s) */
  private loopOcclusion(lv: LoopVoice) {
    if (!lv.pos || lv.stopping) return;
    const t = this.ctx.currentTime;
    if (lv.def.loop === "wall") lv.occ = this.world.occl(this.ear(), lv.pos, t, 0.5);
    else if (lv.def.spatial?.occl && lv.def.loop === "plain") lv.occ = this.world.occl(this.ear(), lv.pos, t, 0.3);
  }

  private wantHeliGun() {
    for (const g of HELI_GUN_GROUPS) if (this.lib.groups.has(g)) { this.lib.markUsed(g); if (!this.lib.has(g)) this.want(g, true); }
  }

  private idleUnused(groups: string[], t: number, except?: LoopVoice) {
    const others = [...this.loops.values()].filter((o) => o !== except && !o.stopping);
    const pending = [...this.pendingLoops.values()];
    const heliUp = others.some((o) => o.name === "heli:rotor") || pending.some((p) => p.name === "heli:rotor");
    const inUse = (g: string) => others.some((o) => o.groups.includes(g)) || pending.some((p) => (BANK[p.name]?.layers ?? []).some((L) => this.grp(L.g) === g));
    for (const g of groups) if (!prefetchGroup(g) && !(heliUp && HELI_GUN_GROUPS.includes(g)) && !inUse(g)) this.lib.markIdle(g, t);
  }

  private disconnectLoop(l: LoopVoice) {
    // the drop's winds are done for this life once they stop (freed at the next eviction pass: ~1 s); others idle 9 s
    const drop = l.def.loop === "freefall" || l.def.loop === "glider" || l.def.loop === "plane";
    // (the plane itself stays resident — prefetched at load, it must sound the frame the next plane phase starts)
    this.idleUnused(l.groups, drop ? -1e9 : this.ctx.currentTime, l);
    if (drop && l.def.sprinkle && !prefetchGroup(l.def.sprinkle.g)) this.lib.markIdle(l.def.sprinkle.g, -1e9);
    if (l.name === "heli:rotor") this.idleUnused(HELI_GUN_GROUPS, this.ctx.currentTime, l);
    for (const s of l.srcs) { try { s.stop(); } catch { /* */ } s.disconnect(); }
    for (const n of l.extra) n.disconnect();
    l.out.disconnect(); l.lp.disconnect(); l.panner?.disconnect(); l.inner?.disconnect(); l.outer?.disconnect(); l.outerLp?.disconnect();
  }

  // ------------------------------------------------------------------ used by ambience.ts
  /** a looping bed routed to `bus` (optionally at a world position); a second, different-length `<group>-b` layer
   * plays alongside when the library has one (the two never line up the same way twice) */
  bed(group: string, bus: Bus, pos?: V3): { gain: GainNode; panner?: PannerNode; lp: BiquadFilterNode; stop(): void } | null {
    const bt0 = performance.now();
    try { return this.bedStart(group, bus, pos); } finally { const ms = performance.now() - bt0; if (ms > 2 && this.live) this.noteSlow(ms, `bed ${group}`); }
  }
  private bedStart(group: string, bus: Bus, pos?: V3): { gain: GainNode; panner?: PannerNode; lp: BiquadFilterNode; stop(): void } | null {
    if (this.lib.isLazy(group)) {
      // decode on demand (base + its -b layer together); the ambience asks again next frame
      const hasB = this.lib.groups.has(group + "-b");
      if (!this.lib.has(group) || (hasB && !this.lib.has(group + "-b"))) { this.want(group); if (hasB) this.want(group + "-b"); return null; }
      this.lib.markUsed(group); this.lib.markUsed(group + "-b");
    }
    const pk = this.lib.pick(group, this.ambRnd);
    if (!pk) return null;
    const gain = this.ctx.createGain(); gain.gain.value = 0;
    const lp = this.ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 20000; lp.Q.value = 0.5;
    const srcs: AudioBufferSourceNode[] = [], norms: GainNode[] = [];
    const add = (p: NonNullable<typeof pk>, db: number) => {
      const src = this.ctx.createBufferSource();
      src.buffer = p.buf; src.loop = true;
      const lpnt = p.file.loop ?? [0, p.buf.duration];
      src.loopStart = lpnt[0]; src.loopEnd = lpnt[1];
      const norm = this.ctx.createGain(); norm.gain.value = dbg(this.lib.normDb(p.file) + db);
      src.connect(norm).connect(gain);
      src.start(this.ctx.currentTime, lpnt[0] + this.ambRnd() * (lpnt[1] - lpnt[0]));
      srcs.push(src); norms.push(norm);
    };
    // (lib.pick returns a reused record: use each pick before the next one)
    const hasB = this.lib.has(group + "-b");
    add(pk, hasB ? -2 : 0);
    const b = hasB ? this.lib.pick(group + "-b", this.ambRnd) : undefined;
    if (b) add(b, -3);
    gain.connect(lp);
    let panner: PannerNode | undefined;
    // (beds at a place — surf lines, the falls, a fountain, a radio — pan equal-power: HRTF on a diffuse bed buys nothing
    // and costs the audio thread two convolutions per render quantum each)
    // a bed decoded at 24 kHz enters its bus through the shared anti-image low-pass (no mirrored 12-20 kHz band)
    const dest = this.mixer.aaIn(bus, Math.min(this.lib.rateOf(group), hasB ? this.lib.rateOf(group + "-b") : 1e9));
    if (pos) { panner = this.makePanner(pos, 999, 0); lp.connect(panner).connect(dest); }
    else lp.connect(dest);
    return {
      gain, panner, lp,
      stop: () => {
        const t = this.ctx.currentTime;
        this.lib.markIdle(group, t); this.lib.markIdle(group + "-b", t);
        gain.gain.setTargetAtTime(0, t, 0.3);
        for (const s of srcs) { try { s.stop(t + 1.5); } catch { /* */ } }
        setTimeoutSafe(() => { for (const s of srcs) s.disconnect(); for (const n of norms) n.disconnect(); gain.disconnect(); lp.disconnect(); panner?.disconnect(); }, 1700, this.live);
      },
    };
  }

  /** a one-shot sprinkle at a world position on the ambience bus */
  private sprStats: Record<string, [number, number]> = {};
  sprinkle(group: string, pos: V3, db: number, bus: Bus = "amb") {
    const pk = this.lib.pick(group, this.ambRnd);
    if (!pk) { if (this.lib.isLazy(group)) this.want(group); return; }
    if (this.lib.isLazy(group)) this.lib.markIdle(group, this.ctx.currentTime + pk.buf.duration);
    const d = this.dist(pos);
    const occ = this.world.occl(this.ear(), pos, this.ctx.currentTime, 0.5);
    const src = this.ctx.createBufferSource(); src.buffer = pk.buf;
    src.playbackRate.value = Math.pow(2, (this.ambRnd() * 2 - 1) * 1.5 / 12);
    const g = this.ctx.createGain();
    let lvl = db + 20 * Math.log10(12 / (12 + 0.9 * Math.max(0, d - 12))) - occ * 9;
    // an ambience event never peaks over AMB_PEAK dBFS at the listener (unchecked, Wreck Bay's surf crashes
    // and the lab's arcs peaked at -4 dBFS, louder than your own gun) — the file's true peak after its normalisation, the
    // bus trim and 3 dB for an HRTF near ear
    const tp = pk.file.lufs?.TP;
    if (tp !== undefined && bus === "amb") lvl = Math.min(lvl, AMB_PEAK - 3 - (tp + this.lib.normDb(pk.file)) - BUS_DB[bus]);
    g.gain.value = dbg(lvl + this.lib.normDb(pk.file));
    const st = (this.sprStats[group] ??= [0, 0]); st[0]++; st[1] = Math.round(lvl);
    const f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = Math.min(20000 * Math.exp(-d / 180), 20000 * Math.pow(1200 / 20000, occ)); f.Q.value = 0.5;
    const pn = this.makePanner(pos, d, 80);
    // (a 32 kHz ambience one-shot enters its bus through the anti-image low-pass)
    src.connect(g).connect(f).connect(pn).connect(this.mixer.aaIn(bus, pk.buf.sampleRate));
    const sg = this.ctx.createGain(); sg.gain.value = dbg(-16); pn.connect(sg).connect(this.mixer.reverbInput(bus, "yard"));
    src.start();
    this.voices.push({ nodes: [g, f, pn, sg], srcs: [src], end: this.ctx.currentTime + pk.buf.duration, group: "sprinkle", start: this.ctx.currentTime, out: g, local: true, db: -30, prio: 0, dist: d });
  }

  /** the water module's API (ctx.shared "water", live only), looked up at most once a second */
  waterApi(): WaterLike | undefined {
    if (!this.live) return undefined;
    const t = this.ctx.currentTime;
    if (!this.waterRef && t - this.waterRefT > 1) {
      this.waterRefT = t;
      try { this.waterRef = (globalThis as unknown as { __kr?: { engine?: { shared?: Map<string, unknown> } } }).__kr?.engine?.shared?.get("water") as WaterLike | undefined; } catch { /* */ }
    }
    return this.waterRef;
  }

  /** under the surface the world goes dull and far (the mixer's underwater low-pass) and a real hydrophone
   * bed rises; live from the water module's isUnderwater(), offline from env.underwater */
  private underwater(dt: number, env: Env) {
    let under = !!env.underwater;
    const wa = this.waterApi();
    if (wa) { try { under = under || wa.isUnderwater(); } catch { /* */ } }
    this.uwK += ((under ? 1 : 0) - this.uwK) * (1 - Math.exp(-dt / (under ? 0.06 : 0.15)));
    if (this.uwK < 0.002 && !under) this.uwK = 0;
    this.mixer.setUnderwater(this.uwK);
    if (this.uwK > 0.05 && !this.uwBed) this.uwBed = this.bed("amb/underwater", "ui");
    if (this.uwBed) {
      setT(this.uwBed.gain.gain, dbg(-8) * this.uwK, this.ctx.currentTime, 0.08, 0.01);
      if (this.uwK === 0) { this.uwBed.stop(); this.uwBed = null; }
    }
  }

  /** a scheduled ambience one-shot whose LOUDNESS PEAK lands at `when` (a crash's build-up starts before
   * it), distance law ref / max(ref, d) (-6 dB per doubling past `ref`), occlusion, air absorption, HRTF */
  surfShot(group: string, pos: V3, db: number, when: number, ref: number) {
    const pk = this.lib.pick(group, this.ambRnd);
    if (!pk) { if (this.lib.isLazy(group)) this.want(group); return; }
    const now = this.ctx.currentTime;
    const lead = peakTime(pk.buf);
    let t0 = when - lead, off = 0;
    if (t0 < now) { off = now - t0; t0 = now; }
    if (off > lead + 0.2) return;            // (its peak is already past)
    if (this.lib.isLazy(group)) this.lib.markIdle(group, now + pk.buf.duration);
    const d = this.dist(pos);
    const occ = this.world.occl(this.ear(), pos, now, 0.5);
    let lvl = db + 20 * Math.log10(ref / Math.max(ref, d)) - occ * 9;
    const tp = pk.file.lufs?.TP;
    // (a breaker you see is THE event of a beach — the synced crashes may peak 6 dB over the ambience-event ceiling; the
    // capped like other events they sat 9-12 dB under the beach's own bed, i.e. inaudible)
    if (tp !== undefined) lvl = Math.min(lvl, AMB_PEAK + (group === "amb1/crash" ? 6 : 0) - 3 - (tp + this.lib.normDb(pk.file)) - BUS_DB.amb);
    const src = this.ctx.createBufferSource(); src.buffer = pk.buf;
    const g = this.ctx.createGain(); g.gain.value = dbg(lvl + this.lib.normDb(pk.file));
    const f = this.ctx.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = Math.min(20000 * Math.exp(-d / 220), 20000 * Math.pow(1200 / 20000, occ)); f.Q.value = 0.5;
    const pn = this.makePanner(pos, d, 80);
    src.connect(g).connect(f).connect(pn).connect(this.mixer.aaIn("amb", pk.buf.sampleRate));
    const sg = this.ctx.createGain(); sg.gain.value = dbg(-16); pn.connect(sg).connect(this.mixer.reverbInput("amb", "yard"));
    src.start(t0, off);
    const st = (this.sprStats[group] ??= [0, 0]); st[0]++; st[1] = Math.round(lvl);
    this.voices.push({ nodes: [g, f, pn, sg], srcs: [src], end: t0 + pk.buf.duration - off, group: "sprinkle", start: t0, out: g, local: true, db: -30, prio: 0, dist: d });
  }

  get envNow() { return this.env; }
  get indoor() { return this.indoorS; }
}

/** where a buffer is loudest (s): 60 ms windows (10 ms hop) of the channel sum through a 300-6000 Hz band (2nd-order
 * RBJ high-pass + low-pass) — the band / window a crash is measured in —
 * cached per buffer; surfShot lines that up with the visual break. (A channel-0 one-pole high-pass put two of
 * the eight crashes' peaks 0.6-0.9 s late on their swell's build-up; the asset build also cuts every crash with its
 * band peak at exactly 1.30 s) */
const PEAK_T = new WeakMap<AudioBuffer, number>();
function biq(kind: "hp" | "lp", f: number, sr: number): [number, number, number, number, number] {
  const w = 2 * Math.PI * f / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * Math.SQRT1_2), a0 = 1 + al;
  const b1 = kind === "hp" ? -(1 + cs) : 1 - cs, b0 = kind === "hp" ? (1 + cs) / 2 : (1 - cs) / 2;
  return [b0 / a0, b1 / a0, b0 / a0, (-2 * cs) / a0, (1 - al) / a0];
}
function peakTime(b: AudioBuffer): number {
  let v = PEAK_T.get(b);
  if (v !== undefined) return v;
  const sr = b.sampleRate, n = b.length, chs = Array.from({ length: b.numberOfChannels }, (_, i) => b.getChannelData(i));
  const F = [biq("hp", 300, sr), biq("lp", Math.min(6000, sr * 0.45), sr)], z = F.map(() => [0, 0, 0, 0]);
  const hop = Math.max(1, Math.round(sr * 0.01)), W = 6;
  const e: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    let x = 0; for (const c of chs) x += c[i];
    for (let k = 0; k < 2; k++) {
      const [b0, b1, b2, a1, a2] = F[k], s = z[k];
      const y = b0 * x + b1 * s[0] + b2 * s[1] - a1 * s[2] - a2 * s[3];
      s[1] = s[0]; s[0] = x; s[3] = s[2]; s[2] = y; x = y;
    }
    acc += x * x;
    if ((i + 1) % hop === 0) { e.push(acc); acc = 0; }
  }
  let best = -1, bi = 0;
  for (let i = 0; i + W <= e.length; i++) { let s2 = 0; for (let k = i; k < i + W; k++) s2 += e[k]; if (s2 > best) { best = s2; bi = i; } }
  v = (bi + W / 2) * hop / sr;
  PEAK_T.set(b, v);
  return v;
}

function setTimeoutSafe(fn: () => void, ms: number, live: boolean) {
  if (live) setTimeout(fn, ms); // offline renders keep the (stopped) nodes until the context is discarded
}

export type { Engine };

export function createAudio(opts?: AudioOptions): KongAudio {
  const e = new Engine(opts);
  if (!opts?.context && typeof window !== "undefined") (window as unknown as { __audio?: KongAudio }).__audio = e;
  return e;
}
