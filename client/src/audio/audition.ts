// The Sound Lab (dev audition page). Live: play every Sfx first-person or placed in the world (distance / angle / real
// terrain occlusion + echoes), drag the listener around the island map to hear the ambience crossfade.
// Offline: window.__renderScenario(spec) renders a scripted scenario through the REAL engine into an
// OfflineAudioContext and returns the stereo PCM (used by offline audition tooling).
import { createAudio, type KongAudio } from "./index";
import { BANK } from "./bank";
import { Mixer } from "./mixer";
import type { PlayOpts } from "./api";
import { loadTerrain } from "../world/terrain/load";
import type { Box } from "../../../shared/world/colliders";
import { POIS, Biome } from "../../../shared/world/map";
import type { Terrain } from "../../../shared/world/terrain";
import { AcousticWorld } from "./world";
import { flag } from "../flags";

type V3 = [number, number, number];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let terrainP: Promise<Terrain> | null = null;
const getTerrain = () => (terrainP ??= loadTerrain());
// the POI colliders are loaded lazily and defensively: a broken POI module must not take the Sound Lab down
let boxesP: Promise<Box[]> | null = null;
const getBoxes = () => (boxesP ??= import("../../../shared/pois/index").then((m) => m.allColliders()).catch((e) => {
  console.warn(`[audio] POI colliders unavailable (${String(e).slice(0, 120)}) — rendering with terrain only`);
  boxesP = null;
  return [] as Box[];
}));

// ============================================================================ offline scenario renderer
export interface ScenarioEvent { t: number; sfx?: string; opts?: PlayOpts; stop?: string; move?: { pos: V3; fwd?: V3 }; env?: Partial<Env> }
interface Env { biome: number; indoors: boolean; inStorm: boolean; altitude: number; storm?: { x: number; z: number; r: number } | null; underwater?: boolean }
export interface Scenario {
  name: string; dur: number; listener?: { pos: V3; fwd?: V3 }; env?: Partial<Env>; events: ScenarioEvent[]; ambience?: boolean; seed?: number;
  /** only the surf sync (surf timing check) */
  surfSolo?: boolean;
  /** render through the player's REDUCED dynamic range (default full) */
  dynamicRange?: "full" | "reduced";
  glide?: { from: V3; to: V3; t0: number; t1: number };
  /** walk the listener along the ground (eye height `eye`, default 1.65) from → to between t0..t1 — drives auto-footsteps */
  walk?: { from: [number, number]; to: [number, number]; t0: number; t1: number; eye?: number; floor?: number }[];
}

async function renderScenario(sc: Scenario): Promise<{ name: string; sr: number; l: string; r: string; stats: unknown }> {
  const sr = 48000;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(sc.dur * sr), sampleRate: sr });
  const terrain = await getTerrain();
  const colliders = await getBoxes();
  const audio = createAudio({ context: ctx, terrain, colliders, seed: sc.seed ?? 7, ambience: !!sc.ambience, surfSolo: !!sc.surfSolo });
  const aw = new AcousticWorld(terrain, colliders);
  await audio.ready;
  audio.setDynamicRange?.(sc.dynamicRange ?? "full");
  let pos: V3 = sc.listener?.pos ?? [0, terrain.height(0, 0) + 1.7, 0];
  let fwd: V3 = sc.listener?.fwd ?? [0, 0, -1];
  const env: Env = { biome: 0, indoors: false, inStorm: false, altitude: pos[1], ...(sc.env ?? {}) };
  const step = (128 * 6) / sr; // 16 ms control rate (render-quantum aligned)
  const tickErrors: string[] = [];
  const evs = [...sc.events].sort((a, b) => a.t - b.t);
  let ei = 0;
  const tick = (t: number) => {
    if (sc.glide && t >= sc.glide.t0 && t <= sc.glide.t1 + step) {
      const f = Math.min(1, (t - sc.glide.t0) / (sc.glide.t1 - sc.glide.t0));
      pos = [0, 1, 2].map((i) => sc.glide!.from[i] + (sc.glide!.to[i] - sc.glide!.from[i]) * f) as V3;
    }
    for (const w of sc.walk ?? []) {
      if (t < w.t0 || t > w.t1 + step) continue;
      const f = Math.min(1, (t - w.t0) / (w.t1 - w.t0));
      const x = w.from[0] + (w.to[0] - w.from[0]) * f, z = w.from[1] + (w.to[1] - w.from[1]) * f;
      const g = aw.groundAt(x, (w.floor ?? pos[1] - 1.65) , z);
      pos = [x, g.y + (w.eye ?? 1.65), z];
      const dx = w.to[0] - w.from[0], dz = w.to[1] - w.from[1], n = Math.hypot(dx, dz) || 1;
      fwd = [dx / n, 0, dz / n];
    }
    while (ei < evs.length && evs[ei].t <= t + 1e-6) {
      const e = evs[ei++];
      if (e.move) { pos = e.move.pos; if (e.move.fwd) fwd = e.move.fwd; }
      if (e.env) Object.assign(env, e.env);
      if (e.stop) audio.stopLoop(e.stop);
      if (e.sfx) audio.playEvent(e.sfx, e.opts ?? {});
    }
    env.altitude = pos[1];
    audio.update(step, { pos, fwd, up: [0, 1, 0] }, env);
  };
  // prime listener before t=0 events; analyse the echo cells of the listener + every scripted source up front (the live
  // game does this off the hot path over the first frames — an offline render has no frames to spare)
  audio.world.ensure(pos);
  for (const e of evs) if (e.opts?.pos) audio.world.ensure(e.opts.pos as V3);
  audio.update(0, { pos, fwd, up: [0, 1, 0] }, env);
  for (let t = step; t < sc.dur; t += step) {
    const tt = t;
    // never leave the render suspended: an exception in a tick must not hang the tool (it is reported instead)
    ctx.suspend(tt).then(() => { try { tick(tt); } catch (e) { tickErrors.push(String((e as Error)?.stack ?? e).slice(0, 400)); } finally { ctx.resume(); } });
  }
  tick(0);
  const buf = await ctx.startRendering();
  const enc = (a: Float32Array) => {
    const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  if (tickErrors.length) console.error(`[audio] scenario ${sc.name}: ${tickErrors.length} tick errors — ${tickErrors[0]}`);
  return { name: sc.name, sr, l: enc(buf.getChannelData(0)), r: enc(buf.getChannelData(1)), stats: { ...audio.stats(), tickErrors: tickErrors.slice(0, 3), amb: sc.ambience ? { ...audio.ambience.weights } : undefined, pcmMB: +(audio.lib.pcmBytes / 1e6).toFixed(1), surf: (audio as unknown as { surf?: { log: unknown[] } }).surf?.log ?? [] } };
}

/** processing latency of the master chain: an impulse into the UI bus → where it comes out */
async function chainLatency(): Promise<{ processingMs: number; peakDb: number }> {
  const sr = 48000;
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: sr / 5, sampleRate: sr });
  const m = new Mixer(ctx);
  await m.ready;
  const b = ctx.createBuffer(1, 64, sr);
  b.getChannelData(0)[0] = 0.5;
  const s = ctx.createBufferSource(); s.buffer = b; s.connect(m.buses.ui); s.start(0);
  const out = (await ctx.startRendering()).getChannelData(0);
  let pk = 0, at = 0;
  for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > pk) { pk = Math.abs(out[i]); at = i; }
  let first = 0;
  for (let i = 0; i < out.length; i++) if (Math.abs(out[i]) > pk * 0.1) { first = i; break; }
  return { processingMs: (first / sr) * 1000, peakDb: 20 * Math.log10(pk + 1e-9), ...{ peakAtMs: (at / sr) * 1000, worklet: m.usingWorklet } };
}

/** deterministic scan for demo spots: a source hidden behind a ridge, a valley with strong echoes, an open beach */
async function findSpots() {
  const t = await getTerrain();
  const boxes = await getBoxes();
  const w = new AcousticWorld(t, boxes);
  const g = (x: number, z: number): V3 => [x, Math.max(0, t.height(x, z)) + 1.7, z];
  let occluded: { listener: V3; source: V3; occ: number } | null = null;
  let echo: { listener: V3; echoes: number; gain: number } | null = null;
  let open: { listener: V3 } | null = null;
  let openScore = 1e9;
  // a room: a point on a box floor with a roof and walls around (the colliders say "inside")
  let room: { listener: V3; enc: number; surf: string } | null = null;
  for (const b of boxes) {
    if (room) break;
    if (!b || b.h[1] > 0.6 || b.h[0] < 2 || b.h[2] < 2 || b.noShoot) continue;
    const top = b.c[1] + b.h[1];
    const L: V3 = [b.c[0], top + 1.65, b.c[2]];
    const e = w.enclosure(L);
    if (e >= 1) room = { listener: L, enc: e, surf: b.surf ?? "stone" };
  }
  for (let z = -900; z <= 900 && !(occluded && echo && open && openScore === 0); z += 37) {
    for (let x = -900; x <= 900; x += 41) {
      const h = t.height(x, z);
      if (h < 3) continue;
      const L = g(x, z);
      if (!occluded) {
        for (const [dx, dz] of [[90, 0], [0, 90], [-90, 0], [0, -90]]) {
          const S = g(x + dx, z + dz);
          if (t.height(S[0], S[2]) < 3) continue;
          const o = w.occlusion(L, [S[0], S[1] + 1.2, S[2]]);
          if (o >= 0.99) { occluded = { listener: L, source: S, occ: o }; break; }
        }
      }
      if (!echo) {
        const e = w.reflections(L, L, 0, true)!;
        const tot = e.reduce((a, b) => a + b.gain, 0);
        if (e.length >= 3 && tot > 0.45) echo = { listener: L, echoes: e.length, gain: tot };
      }
      if (t.biomeAt(x, z) === Biome.Beach && h < 8) {
        // the most open beach: fewest / weakest reflecting faces around (terrain edits move beaches — never require 0)
        // the most open beach = the fewest / weakest reflecting faces around (closeness from the same echo analysis the
        // engine uses); terrain edits move beaches — never require 0
        w.ensure(L);
        const e = w.reflections(L, L, 0, true)!, score = 3 * (w.closeness(L) ?? 1) + e.length * 0.2 + e.reduce((q, r) => q + r.gain, 0);
        if (!open || score < openScore) { open = { listener: L }; openScore = score; }
      }
    }
  }
  return { occluded, echo, open, room };
}

(window as unknown as Record<string, unknown>).__findSpots = findSpots;
(window as unknown as Record<string, unknown>).__renderScenario = renderScenario;
(window as unknown as Record<string, unknown>).__chainLatency = chainLatency;
(window as unknown as Record<string, unknown>).__bank = () => Object.keys(BANK);

// ============================================================================ live lab
let audio: KongAudio | null = null;
let listener: V3 = [0, 30, 0];
let speed = 0;
const env: Env = { biome: 0, indoors: false, inStorm: false, altitude: 0 };

function worldPos(): V3 {
  const d = +$<HTMLInputElement>("dist").value, a = (+$<HTMLInputElement>("ang").value * Math.PI) / 180;
  // angle 0 = straight ahead (−Z = north), + = to the right
  return [listener[0] + Math.sin(a) * d, listener[1], listener[2] - Math.cos(a) * d];
}

function buildButtons() {
  const groups: Record<string, string[]> = {};
  for (const k of Object.keys(BANK)) {
    const g = k.startsWith("fire:") || k.startsWith("reload:") || k === "equip" || k === "dryfire" ? "Weapons"
      : k.startsWith("step:") || ["jump", "land", "slide"].includes(k) ? "Movement"
      : k.startsWith("impact:") || k === "whizz" || k === "explosion" ? "Bullets & explosions"
      : k.startsWith("hit") || k === "kill" || k === "elim:self" ? "Hit feedback"
      : k.includes("chest") || k.startsWith("pickup") || k.includes("heal") || k.includes("shield") ? "Loot & items"
      : k.startsWith("plane") || k.startsWith("jump:") || k.startsWith("freefall") || k.startsWith("glider") ? "Drop"
      : k.startsWith("storm") ? "Storm" : "UI & stings";
    (groups[g] ??= []).push(k);
  }
  const root = $("events");
  for (const [g, list] of Object.entries(groups)) {
    const sec = document.createElement("section");
    sec.innerHTML = `<h2>${g}</h2>`;
    for (const k of list.sort()) {
      const def = BANK[k];
      const row = document.createElement("div"); row.className = "row";
      row.innerHTML = `<span class="lbl">${k}</span>`;
      const mk = (label: string, fn: () => void) => { const b = document.createElement("button"); b.textContent = label; b.onclick = fn; row.appendChild(b); };
      if (def.loop) {
        mk("start 1P", () => audio?.playEvent(k, { loopId: k }));
        if (def.spatial) mk("start in world", () => audio?.playEvent(k, { loopId: k, pos: worldPos() }));
        mk("stop", () => audio?.stopLoop(k));
      } else {
        mk("1P", () => audio?.playEvent(k));
        if (def.spatial) mk("world", () => audio?.playEvent(k, { pos: worldPos() }));
        if (k.startsWith("fire:")) {
          const rpm = { pistol: 400, smg: 900, ar: 620, shotgun: 70, sniper: 50, rocket: 30, bow: 60, minigun: 900 }[k.slice(5)] ?? 600;
          mk("burst 1P", () => { for (let i = 0; i < 8; i++) setTimeout(() => audio?.playEvent(k), (i * 60000) / rpm); });
          mk("burst world", () => { const p = worldPos(); for (let i = 0; i < 8; i++) setTimeout(() => audio?.playEvent(k, { pos: p }), (i * 60000) / rpm); });
        }
      }
      sec.appendChild(row);
    }
    root.appendChild(sec);
  }
}

async function drawMap() {
  const t = await getTerrain();
  const cv = $<HTMLCanvasElement>("map"), g = cv.getContext("2d")!;
  const W = cv.width, img = g.createImageData(W, W);
  const col: Record<number, [number, number, number]> = {
    [Biome.DeepOcean]: [14, 70, 130], [Biome.Reef]: [40, 170, 190], [Biome.Beach]: [236, 216, 160], [Biome.Grass]: [110, 170, 70],
    [Biome.Jungle]: [40, 110, 50], [Biome.Rock]: [130, 125, 120], [Biome.Cinder]: [60, 50, 55], [Biome.Path]: [180, 150, 100],
    [Biome.Farmland]: [150, 170, 80], [Biome.Paved]: [160, 160, 160], [Biome.Lagoon]: [60, 190, 170],
  };
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const wx = (x / W) * 2400 - 1200, wz = (y / W) * 2400 - 1200;
    const c = col[t.biomeAt(wx, wz)] ?? [255, 0, 255];
    const h = t.height(wx, wz), sh = Math.max(0.6, Math.min(1.25, 0.85 + h / 250));
    const i = (y * W + x) * 4;
    img.data[i] = c[0] * sh; img.data[i + 1] = c[1] * sh; img.data[i + 2] = c[2] * sh; img.data[i + 3] = 255;
  }
  const base = img;
  const redraw = () => {
    g.putImageData(base, 0, 0);
    g.font = "10px system-ui"; g.fillStyle = "#fff";
    for (const p of POIS) g.fillText(p.name, ((p.x + 1200) / 2400) * W - 20, ((p.z + 1200) / 2400) * W);
    const lx = ((listener[0] + 1200) / 2400) * W, lz = ((listener[2] + 1200) / 2400) * W;
    g.fillStyle = "#ffd23a"; g.beginPath(); g.arc(lx, lz, 6, 0, Math.PI * 2); g.fill();
    g.strokeStyle = "#ffd23a"; g.beginPath(); g.moveTo(lx, lz); g.lineTo(lx, lz - 14); g.stroke();
    const p = worldPos(), px = ((p[0] + 1200) / 2400) * W, pz = ((p[2] + 1200) / 2400) * W;
    g.strokeStyle = "#ff5a3c"; g.beginPath(); g.arc(px, pz, 4, 0, Math.PI * 2); g.stroke();
  };
  const place = (x: number, z: number) => {
    listener = [x, Math.max(0, t.height(x, z)) + +$<HTMLInputElement>("alt").value, z];
    env.biome = t.biomeAt(x, z);
    redraw();
  };
  cv.onclick = (e) => {
    const r = cv.getBoundingClientRect();
    place(((e.clientX - r.left) / r.width) * 2400 - 1200, ((e.clientY - r.top) / r.height) * 2400 - 1200);
  };
  const row = $("poiRow");
  for (const p of POIS) {
    const b = document.createElement("button"); b.textContent = p.name.toLowerCase(); b.onclick = () => place(p.x, p.z); row.appendChild(b);
  }
  $<HTMLInputElement>("alt").oninput = () => { $("altv").textContent = `${$<HTMLInputElement>("alt").value} m`; place(listener[0], listener[2]); };
  for (const id of ["dist", "ang"]) $<HTMLInputElement>(id).addEventListener("input", redraw);
  place(POIS[0].x, POIS[0].z + 60);
}

function loop() {
  let last = performance.now();
  let fake = 0;
  const an = audio!.ctx instanceof AudioContext ? (audio!.ctx as AudioContext).createAnalyser() : null;
  if (an) { an.fftSize = 2048; audio!.mixer.out.connect(an); }
  const buf = new Float32Array(2048);
  const frame = () => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    // simulate motion for speed-driven winds: move the listener along -Z at `speed`, then snap back
    fake += speed * dt;
    const p: V3 = [listener[0], listener[1], listener[2] - (fake % 50)];
    audio!.update(dt, { pos: p, fwd: [0, 0, -1], up: [0, 1, 0] }, env);
    if (an) {
      an.getFloatTimeDomainData(buf);
      let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v));
      $("meter").style.width = `${Math.min(100, Math.max(0, (20 * Math.log10(pk + 1e-9) + 60) / 60 * 100))}%`;
    }
    const s = audio!.stats();
    $("stats").textContent = JSON.stringify(s, null, 1).replace(/[{}"]/g, "");
    $("weights").textContent = Object.entries(audio!.ambience.weights).map(([k, v]) => `${k.padEnd(9)} ${"█".repeat(Math.round(v * 30))} ${v.toFixed(2)}`).join("\n");
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

if (!flag("headless")) {
  buildButtons();
  drawMap();
  $("unlock").onclick = async () => {
    if (!audio) {
      audio = createAudio({ terrain: await getTerrain(), colliders: await getBoxes() });
      $("status").textContent = "loading…";
      audio.ready.then(() => { $("status").textContent = `ready · ${audio!.stats().loaded} files · ${audio!.lib.ext}`; });
      loop();
    }
    await audio.unlock();
    $("unlock").textContent = "audio on";
  };
  $<HTMLInputElement>("master").oninput = () => audio?.setMaster(+$<HTMLInputElement>("master").value);
  $<HTMLInputElement>("dist").oninput = () => { $("distv").textContent = `${$<HTMLInputElement>("dist").value} m`; };
  $<HTMLInputElement>("ang").oninput = () => { $("angv").textContent = `${$<HTMLInputElement>("ang").value}°`; };
  $<HTMLInputElement>("speed").oninput = () => { speed = +$<HTMLInputElement>("speed").value; $("speedv").textContent = `${speed} m/s`; };
  $<HTMLInputElement>("indoor").onchange = () => { env.indoors = $<HTMLInputElement>("indoor").checked; };
  $<HTMLInputElement>("storm").onchange = () => { env.inStorm = $<HTMLInputElement>("storm").checked; };
}
