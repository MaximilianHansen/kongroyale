// KONGBOT context: everything we can learn about the moment a player hit a bug, gathered when the chat bar OPENS (the
// thing they are reacting to is on screen right then) — screenshot, where they are, what the crosshair is on (both the
// DRAWN world and the COLLISION world: "I can see him but can't hit him" is a mismatch between the two), match state,
// perf, video settings, GPU, the browser. Read through window.__kr (the same handle the tools use) so a missing piece
// (title screen, no match yet) just leaves a field null instead of failing the report.
import * as THREE from "three";
import type { Engine } from "../engine/engine";
import { POIS } from "../../../shared/world/map";
import { makeHit, surfaceById, type StaticWorld } from "../../../shared/sim/world";
import { weaponId, consumableId, rarityOf } from "../../../shared/sim/player";
import { frameStats } from "./capture";
import { flagQuery } from "../flags";

const ST = ["ground", "freefall", "glide", "dead", "plane", "spectate", "zip"];
const PHASE = ["warmup", "plane", "play", "results"];
const r2 = (v: number) => Math.round(v * 100) / 100;
const v3 = (v: THREE.Vector3) => [r2(v.x), r2(v.y), r2(v.z)];

interface KrGame {
  inMatch: boolean;
  cm: null | {
    phase: number; time: number; alive: number; squads: number; ping: number; jitter: number; interpTicks: number; range: boolean; mode: string; flags: number;
    storm: Record<string, unknown>; world: StaticWorld;
    pred: { x: number; y: number; z: number; vx: number; vy: number; vz: number; st: number; hp: number; shield: number; grounded: boolean; crouch: boolean; sprint: boolean; swim: boolean; under: boolean; breath: number; swGun: number; surf: number; slope: boolean; active: number; kills: number; damage: number; slots: Array<{ kind: number; id: number; rarity: number; count: number; mag: number }>; ammo: ArrayLike<number> };
  };
  render: null | { actors?: Map<unknown, unknown>; lootViews?: Map<unknown, unknown>; chestViews?: Map<unknown, unknown>; rejected?: number };
  input: { yaw: number; pitch: number; locked: boolean };
  hud: { mapOpen?: boolean };
  lobby: { name?: string };
  lobbyState: () => { code: string | null; mode: string; offline: boolean; isHost: boolean; players: unknown[] };
}
type Kr = Record<string, unknown> & { game?: KrGame; display?: { gpu: string; gpuLevel: string; settings: unknown; bench: unknown }; info?: () => unknown; errors?: string[] };
export const kr = () => (window as unknown as { __kr?: Kr }).__kr ?? ({} as Kr);

const safe = <T>(f: () => T): T | null => { try { return f(); } catch { return null; } };
const ls = (k: string) => safe(() => JSON.parse(localStorage.getItem(k) || "null"));

/** the POI whose EDGE is nearest (inside = within its radius) */
export function nearestPoi(x: number, z: number) {
  let best: { id: string; name: string; dist: number; inside: boolean } | null = null, bestEdge = Infinity;
  for (const p of POIS) {
    const d = Math.hypot(x - p.x, z - p.z);
    if (d - p.r < bestEdge) { bestEdge = d - p.r; best = { id: p.id, name: p.name, dist: Math.round(d), inside: d <= p.r }; }
  }
  return best;
}

/** name<parent<… up to the scene (the same path format the engine's program / material logs use) */
function pathOf(o: THREE.Object3D) {
  const parts: string[] = [];
  for (let n: THREE.Object3D | null = o; n && parts.length < 8; n = n.parent) parts.push(n.name || n.type);
  return parts.join("<");
}

/** the DRAWN world under the crosshair: visible meshes only (Raycaster alone also tests hidden objects), and only those
 *  that still hold their vertex arrays (?geofree drops them after upload; a raycast would read null) */
function visualAim(engine: Engine) {
  const t0 = performance.now();
  const cam = engine.camera, rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(0, 0), cam);
  rc.far = 600;
  const list: THREE.Object3D[] = [];
  engine.scene.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && !(o as THREE.Points).isPoints && (o as THREE.Mesh).geometry.attributes.position?.array) list.push(o); });
  const hits = rc.intersectObjects(list, false).slice(0, 4);
  const ms = Math.round(performance.now() - t0);
  return {
    ms, tested: list.length,
    hits: hits.map((h) => {
      const m = h.object as THREE.Mesh, mat = Array.isArray(m.material) ? m.material[0] : m.material;
      return { dist: r2(h.distance), point: v3(h.point), normal: h.face ? v3(h.face.normal.clone().transformDirection(m.matrixWorld)) : null, object: pathOf(m), type: m.type, material: mat ? `${mat.type} "${mat.name}"` : null, instanceId: h.instanceId ?? null, transparent: !!mat?.transparent, alphaTest: mat?.alphaTest ?? 0 };
    }),
  };
}

/** the COLLISION world under the crosshair (what bullets and feet use) */
function collisionAim(world: StaticWorld, o: THREE.Vector3, d: THREE.Vector3) {
  const shot = makeHit(), walk = makeHit();
  world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 600, shot, true);
  world.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 600, walk, false);
  const pack = (h: ReturnType<typeof makeHit>) => h.hit ? { dist: r2(h.t), point: [r2(h.x), r2(h.y), r2(h.z)], normal: [r2(h.nx), r2(h.ny), r2(h.nz)], surf: surfaceById(h.surf), box: h.box } : null;
  return { bullets: pack(shot), movement: pack(walk) };
}

export function camSpec(engine: Engine) {
  const c = engine.camera, d = new THREE.Vector3();
  c.getWorldDirection(d);
  const t = c.position.clone().addScaledVector(d, 20);
  return { pos: v3(c.position), dir: v3(d), fov: r2(c.fov), near: c.near, far: c.far, cam: [...v3(c.position), ...v3(t), r2(c.fov)].join(",") };
}

export function gatherContext(engine: Engine) {
  const K = kr(), g = K.game, cm = g?.cm ?? null, p = cm?.pred ?? null, ren = engine.renderer, canvas = ren.domElement;
  const gl = ren.getContext() as WebGL2RenderingContext;
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: { effectiveType?: string; rtt?: number; downlink?: number; saveData?: boolean }; userAgentData?: { brands?: unknown; platform?: string; mobile?: boolean } };
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  const cam = camSpec(engine);
  const camPos = engine.camera.position.clone(), camDir = new THREE.Vector3();
  engine.camera.getWorldDirection(camDir);
  const lobby = safe(() => g?.lobbyState()) ?? null;

  return {
    capturedAt: new Date().toISOString(),
    page: { url: location.href, query: flagQuery, visibility: document.visibilityState, focused: document.hasFocus(), fullscreen: !!document.fullscreenElement, pointerLock: !!document.pointerLockElement, uptimeS: Math.round(performance.now() / 1000) },
    env: {
      ua: navigator.userAgent, uaData: nav.userAgentData ? { brands: nav.userAgentData.brands, platform: nav.userAgentData.platform, mobile: nav.userAgentData.mobile } : null,
      platform: navigator.platform, lang: navigator.language, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, tzOffsetMin: new Date().getTimezoneOffset(),
      screen: { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight, colorDepth: screen.colorDepth }, dpr: devicePixelRatio, viewport: { w: innerWidth, h: innerHeight },
      cores: navigator.hardwareConcurrency, memoryGB: nav.deviceMemory ?? null, touch: navigator.maxTouchPoints,
      connection: nav.connection ? { type: nav.connection.effectiveType, rtt: nav.connection.rtt, downlink: nav.connection.downlink, saveData: nav.connection.saveData } : null,
    },
    boot: { stage: K.stage, ready: K.ready, readyAtMs: K.readyAt, streamed: K.streamed, terrainMs: K.terrainMs, buildMs: K.buildMs, prewarmMs: K.prewarmMs, gameStage: K.gameStage, programsAtReady: K.programsAtReady, errors: (K.errors ?? []).slice(-40) },
    gpu: {
      renderer: K.display?.gpu ?? null, level: K.display?.gpuLevel ?? null, bench: K.display?.bench ?? null,
      webgl: safe(() => ({ version: gl.getParameter(gl.VERSION), glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION), maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE), glError: gl.getError(), contextLost: gl.isContextLost(), parallelCompile: !!gl.getExtension("KHR_parallel_shader_compile"), timerQuery: !!gl.getExtension("EXT_disjoint_timer_query_webgl2") })),
    },
    video: K.display?.settings ?? ls("kr-video"),
    gameSettings: ls("kr-preferences-v1") ?? ls("kr-settings"),
    perf: {
      fps: safe(() => Math.round(engine.liveFps())), gpuMs: r2(engine.gpuMs), frameCap: engine.frameCap, refreshHz: engine.refreshHz, dynamicRes: engine.dynamicRes, renderScale: engine.renderScale,
      dprBase: engine.dprBase, pixelRatio: ren.getPixelRatio(), canvas: { w: canvas.width, h: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight },
      renderInfo: safe(() => K.info?.()), frames: frameStats(10),
      heapMB: mem ? { used: Math.round(mem.usedJSHeapSize / 1048576), total: Math.round(mem.totalJSHeapSize / 1048576), limit: Math.round(mem.jsHeapSizeLimit / 1048576) } : null,
    },
    camera: cam,
    game: g ? {
      inMatch: g.inMatch, lobby, callsign: g.lobby?.name ?? null, mapOpen: g.hud?.mapOpen ?? null,
      match: cm ? { phase: PHASE[cm.phase] ?? cm.phase, time: r2(cm.time), mode: cm.mode, range: cm.range, alive: cm.alive, squads: cm.squads, flags: cm.flags, ping: Math.round(cm.ping), jitter: r2(cm.jitter), interpTicks: r2(cm.interpTicks), storm: { ...cm.storm } } : null,
      player: p ? {
        pos: [r2(p.x), r2(p.y), r2(p.z)], vel: [r2(p.vx), r2(p.vy), r2(p.vz)], speed: r2(Math.hypot(p.vx, p.vz)), yawDeg: r2(THREE.MathUtils.radToDeg(g.input.yaw)), pitchDeg: r2(THREE.MathUtils.radToDeg(g.input.pitch)),
        state: ST[p.st] ?? p.st, grounded: p.grounded, crouch: p.crouch, sprint: p.sprint, swim: p.swim, under: p.under, breath: +p.breath.toFixed(2), swGun: +p.swGun.toFixed(2), slope: p.slope, surface: surfaceById(p.surf),
        hp: p.hp, shield: p.shield, kills: p.kills, damage: Math.round(p.damage), active: p.active,
        slots: p.slots.map((s) => s.kind === 1 ? `${weaponId(s.id)}/${rarityOf(s.rarity)} mag ${s.mag}` : s.kind === 2 ? `${consumableId(s.id)}×${s.count}` : "empty"), ammo: Array.from(p.ammo ?? []),
        poi: nearestPoi(p.x, p.z),
      } : null,
      scene: g.render ? { actors: g.render.actors?.size ?? null, loot: g.render.lootViews?.size ?? null, chests: g.render.chestViews?.size ?? null, rejectedShots: g.render.rejected ?? null } : null,
    } : null,
    cameraPoi: nearestPoi(camPos.x, camPos.z),
    aim: {
      visual: safe(() => visualAim(engine)),
      collision: cm?.world ? safe(() => collisionAim(cm.world, camPos, camDir)) : null,
    },
  };
}
export type KongbotContext = ReturnType<typeof gatherContext>;

/** the canvas right after the next frame is drawn (the drawing buffer is not preserved, so it is read inside step()),
 *  downscaled to ≤ 1920 px wide, JPEG. The HUD is DOM and is not in it (its state is in the context). */
export interface Shot { dataUrl: string; w: number; h: number; frame: { calls: number; triangles: number; points: number; lines: number } | null }
export function grabScreenshot(engine: Engine, maxW = 1920): Promise<Shot | null> {
  return new Promise((resolve) => {
    let done = false, frame: Shot["frame"] = null;
    const e = engine as unknown as { step: (dt: number) => void };
    const orig = e.step;
    const finish = (v: Shot | null) => { if (!done) { done = true; if (e.step === wrapped) e.step = orig; resolve(v); } };
    const wrapped = function (this: unknown, dt: number) {
      if (done) { orig.call(this, dt); return; }
      // renderer.info resets on every render() call (the post chain makes many): count the WHOLE frame once
      const info = engine.renderer.info, auto = info.autoReset;
      info.autoReset = false; info.reset();
      try { orig.call(this, dt); } finally { info.autoReset = auto; }
      frame = { calls: info.render.calls, triangles: info.render.triangles, points: info.render.points, lines: info.render.lines };
      if (e.step === wrapped) e.step = orig;
      try {
        const src = engine.renderer.domElement, s = Math.min(1, maxW / src.width);
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(src.width * s)); c.height = Math.max(1, Math.round(src.height * s));
        c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
        c.toBlob((b) => {
          if (!b) { finish(null); return; }
          const fr = new FileReader();
          fr.onload = () => finish({ dataUrl: String(fr.result), w: c.width, h: c.height, frame });
          fr.onerror = () => finish(null);
          fr.readAsDataURL(b);
        }, "image/jpeg", 0.85);
      } catch { finish(null); }
    };
    e.step = wrapped;
    // a hidden tab / suspended engine never steps: report without a picture
    setTimeout(() => finish(null), 2000);
  });
}
