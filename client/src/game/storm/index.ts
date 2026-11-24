// THE STORM. Implements ./api.ts.
//
// WALL + DECK — ONE sphere-traced cauliflower volume (./volume.ts): the damage circle's leaning face under the storm
//         deck that runs to the horizon, five octaves of billows on billows, SDF-lit (creases, soft self-shadow, the dark
//         core under the overhang, cream sunlit crowns), the banana-yellow rim lit from inside when seen from the air.
//         Traced at ≤ 1 MP, composited per pixel with depth (palms and terrain in front occlude it; walking into it
//         dissolves it into the murk — nothing is ever clipped).
// ENERGY— forked lightning (camera-facing ribbons, core + halo) crawling ON the traced surface and striking the sand,
//         each bolt lighting the billows around it; a sloped golden sand-dust skirt at the foot of the wall.
// DEBRIS— banana chunks / leaves swirling out of the wall; inside the storm a wrapped cloud of leaves, twigs and
//         pebbles streaks past the camera.
// INSIDE— rolling violet storm sky with the warm gap toward the safe zone, violet murk fog on the world, sky bolts.
// update() allocates nothing; every buffer is preallocated.
import * as THREE from "three";
import type { WorldCtx } from "../../engine/engine";
import type { StormCircle, StormVisual } from "./api";
import { createNoiseTexture } from "./noise";
import * as SH from "./shaders";
import { createStormVolume } from "./volume";
import { flag } from "../../flags";

const WALL_H = 650;                 // metres, top of the front face of the tallest (widest) wall
/** the wall scales with its circle: a towering front around the first big circles, a low ring (seen from the plane as
 * a thin glowing rim round a flat deck) for mid circles, never a 470 m chimney round a 50 m final circle */
const wallHeight = (R: number) => Math.min(WALL_H, Math.max(110, R * 0.25));
const INSIDE_BAND = 15;
/** base/restore knobs on values another module owns (atmos): each frame, a value that differs from what we last wrote was
 * changed by its owner — that is the new base; we write mix(base, target, k). k = 0 restores the base exactly. */
interface Knob { base: number; last: number }
const mkKnob = (): Knob => ({ base: NaN, last: NaN });
function knob(k: Knob, cur: number, target: number, amt: number): number {
  if (cur !== k.last || Number.isNaN(k.base)) k.base = cur;
  const v = amt <= 0 ? k.base : k.base + (target - k.base) * amt;
  k.last = v; return v;
}
interface KnobC { base: THREE.Color; last: THREE.Color; init: boolean }
const mkKnobC = (): KnobC => ({ base: new THREE.Color(), last: new THREE.Color(), init: false });
function knobColor(k: KnobC, cur: THREE.Color, target: THREE.Color, amt: number) {
  if (!k.init || !cur.equals(k.last)) { k.base.copy(cur); k.init = true; }
  cur.copy(k.base); if (amt > 0) cur.lerp(target, amt);
  k.last.copy(cur);
}
const K_FOG = mkKnob(), K_FOGSTART = mkKnob(), K_GLARE = mkKnob(), K_FOGM = mkKnob(), K_FOGH = mkKnob(), K_FOGC = mkKnobC();
const HIDE: Set<string> | null = (() => { const v = flag("stormhide"); return v ? new Set(v.split(",")) : null; })();             // half-width of the soft band at the wall
const COL = {
  dust: new THREE.Color("#f0c878"),
  bolt: new THREE.Color("#ffc21a"),
  boltCore: new THREE.Color("#fff6d0"),
  skyBolt: new THREE.Color("#c8b4ff"),
  skyCore: new THREE.Color("#ffffff"),
  murk: new THREE.Color("#3c2c58"),
  murkDark: new THREE.Color("#18122c"),
  murkLit: new THREE.Color("#8478a8"),
  murkFog: new THREE.Color("#4e4468"),
  /** inside-sky palette (linear; #382a4b … #4d3862 overhead, lit rims lavender, never black) */
  skyDark: new THREE.Color(0.022, 0.014, 0.046),
  skyMid: new THREE.Color(0.12, 0.085, 0.23),
  skyLit: new THREE.Color(0.46, 0.36, 0.66),
  // (darker, more violet: a deep purple murk with a bright gap, not a washed-out lavender)
  grade: new THREE.Color(0.40, 0.27, 0.66),
  gap: new THREE.Color("#ffd9a8"),
  /** the murk fog inside the storm (post fog colour, linear) */
  murkFogLin: new THREE.Color(0.082, 0.056, 0.165),
  violetFlash: new THREE.Color("#b9a4ff"),
  haze: new THREE.Color("#a9c4e0"),
  /** the storm's own aerial perspective: far billows fade to a lavender grey (never sky blue) */
  stormHaze: new THREE.Color("#9c98b8"),
};

// ---------------------------------------------------------------- geometry builders
/** one forked bolt in local space: top at y = 1, the end at y = 0 (bolt-local units = its height). The channel is a
 * midpoint-displaced polyline (jagged at every scale, like real lightning); forks peel off it and fork again. Each path
 * is ONE continuous ribbon (shared, mitred vertices: no gaps or teeth at the joints), drawn twice: a thin HDR core and
 * a wide soft glow. */
export function boltGeometry(seed: number, ground: boolean, depth0 = 2): THREE.BufferGeometry {
  let s = seed * 9973 + 17;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) | 0), ((s >>> 8) & 0xffff) / 65536);
  const P: number[] = [], D: number[] = [], S: number[] = [], H: number[] = [], I: number[] = [];
  const strip = (pts: Array<[number, number]>, w0: number, w1: number, halo: boolean) => {
    const base = P.length / 3, n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const w = w0 + (w1 - w0) * (i / (n - 1));
      for (const sd of [-1, 1]) { P.push(pts[i][0], pts[i][1], 0); D.push(dx, dy, 0); S.push(sd, w); H.push(halo ? 1 : 0); }
    }
    for (let i = 0; i < n - 1; i++) { const q = base + i * 2; I.push(q, q + 2, q + 1, q + 1, q + 2, q + 3); }
  };
  /** midpoint displacement between two points: `levels` subdivisions, offsets ∝ segment length × rough */
  const channel = (x0: number, y0: number, x1: number, y1: number, levels: number, rough: number): Array<[number, number]> => {
    let pts: Array<[number, number]> = [[x0, y0], [x1, y1]];
    for (let l = 0; l < levels; l++) {
      const out: Array<[number, number]> = [pts[0]];
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
        const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
        const o = (rnd() - 0.5) * 2 * len * rough;
        out.push([(ax + bx) / 2 - (dy / (len || 1)) * o, (ay + by) / 2 + (dx / (len || 1)) * o], pts[i + 1]);
      }
      pts = out;
    }
    return pts;
  };
  const fork = (pts: Array<[number, number]>, w: number, depth: number) => {
    strip(pts, w, w * 0.3, false); strip(pts, w, w * 0.3, true);
    if (depth <= 0) return;
    const n = pts.length, forks = depth >= 3 ? 2 + ((rnd() * 2) | 0) : depth === 2 ? 1 + ((rnd() * 2) | 0) : (rnd() < 0.6 ? 1 : 0);
    for (let f = 0; f < forks; f++) {
      const i = Math.min(n - 3, ((0.08 + rnd() * 0.72) * n) | 0);
      const [ax, ay] = pts[i], [bx, by] = pts[Math.min(n - 1, i + 3)];
      const dir = Math.atan2(by - ay, bx - ax) + (rnd() < 0.5 ? -1 : 1) * (0.35 + rnd() * 0.6);
      const len = (depth >= 3 ? 0.22 + rnd() * 0.32 : depth === 2 ? 0.12 + rnd() * 0.22 : 0.05 + rnd() * 0.1) * (ground ? 1.0 : 0.9);
      const sub = channel(ax, ay, ax + Math.cos(dir) * len, ay + Math.sin(dir) * len, depth >= 2 ? 4 : 3, 0.34);
      fork(sub, w * (1 - i / n) * 0.55, depth - 1);
    }
  };
  const x1 = (rnd() - 0.5) * (ground ? 0.35 : 0.55);
  // 6 levels at 0.34: straight runs between sharp kinks (7+ levels at low roughness reads as a wavy line)
  fork(channel(0, 1, x1, 0, 6, 0.34), ground ? 0.0085 : 0.0065, depth0);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); g.setAttribute("aDir", new THREE.Float32BufferAttribute(D, 3));
  g.setAttribute("aSide", new THREE.Float32BufferAttribute(S, 2)); g.setAttribute("aHalo", new THREE.Float32BufferAttribute(H, 1));
  g.setIndex(I);
  return g;
}
function debrisGeometry(count: number): THREE.InstancedBufferGeometry {
  const plane = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = plane.index; g.setAttribute("position", plane.getAttribute("position")); g.setAttribute("uv", plane.getAttribute("uv"));
  const seeds = new Float32Array(count * 4); let r = 991;
  for (let i = 0; i < count * 4; i++) { r = (Math.imul(r, 1664525) + 1013904223) | 0; seeds[i] = ((r >>> 8) & 0xffff) / 65536; }
  g.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4));
  g.instanceCount = count;
  return g;
}

interface BoltSlot { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; xf: THREE.Matrix4; t: number; dur: number; idle: number; on: number; kind: 0 | 1 | 2; mid: THREE.Vector3;
  /** re-strikes left on the same channel (real lightning flickers 2-4 times down one path) */
  re: number }

export function createStormVisual(ctx: WorldCtx): StormVisual {
  const noise = createNoiseTexture();
  const root = new THREE.Group(); root.name = "storm";
  ctx.scene.add(root);

  // ---------------------------------------------------------------- shared uniforms
  const uTime = { value: 12 }, uCenter = { value: new THREE.Vector2() }, uR = { value: 900 };
  const uFlash = { value: 0 }, uStrike = { value: 0 }, uInside = { value: 0 }, uFlashV = { value: 0 };
  const uSunDir = { value: new THREE.Vector3(0.4, 0.62, 0.55).normalize() };
  const uBolt = { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] };
  const uGapDir = { value: new THREE.Vector2(1, 0) }, uWind = { value: new THREE.Vector3(1, 0, 0) };
  const uNoise = { value: noise };
  const uLipK = { value: 0 };

  // ---------------------------------------------------------------- the wall + deck volume (./volume.ts)
  const vol = createStormVolume({ boltCol: COL.bolt, hazeCol: COL.stormHaze, bolts: uBolt.value, quality: ctx.quality, ground: (x, z) => ctx.terrain.height(x, z), half: ctx.terrain.half });
  root.add(vol.mesh);
  (globalThis as { __stormVol?: unknown }).__stormVol = vol;   // dev: trace bench handle

  // ---------------------------------------------------------------- golden dust at the foot of the wall
  const uLean = { value: 0 };
  const dustGeo = new THREE.CylinderGeometry(1, 1, 1, 360, 8, true); dustGeo.translate(0, 0.5, 0);
  const dustCol = new THREE.Color(1.0, 0.66, 0.26);          // sunlit sand in the air (linear, HDR-ish)
  const mkDust = (off: number, hgt: number, alpha: number, order: number) => {
    const m = new THREE.Mesh(dustGeo, new THREE.ShaderMaterial({ vertexShader: SH.DUST_VERT, fragmentShader: SH.DUST_FRAG,
      uniforms: { uNoise, uTime, uCenter, uR, uLean, uInside, uLipK, uStrike, uOff: { value: off }, uHgt: { value: hgt }, uAlpha: { value: alpha }, uColDust: { value: dustCol }, uBoltCol: { value: COL.bolt } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    m.frustumCulled = false; m.renderOrder = order; m.name = "storm-dust"; root.add(m);
    return m;
  };
  // a LOW curtain (≤ 45 m): a tall one washed the whole lower wall a pale pink
  const dusts = [mkDust(14, 45, 1.25, 4)];

  // ---------------------------------------------------------------- yellow glow on the ground at the wall base
  const glowGeo = new THREE.RingGeometry(0.8, 1.05, 256, 1); glowGeo.rotateX(-Math.PI / 2);
  const glowMat = new THREE.ShaderMaterial({ vertexShader: SH.GLOW_VERT, fragmentShader: SH.GLOW_FRAG,
    uniforms: { uNoise, uTime, uCenter, uR, uStrike, uFlash, uBoltCol: { value: COL.bolt }, uLipK }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const glow = new THREE.Mesh(glowGeo, glowMat); glow.frustumCulled = false; glow.renderOrder = 5; root.add(glow);

  // ---------------------------------------------------------------- lightning: 12 slots (4 wall/sky, 1 ground strike, 7 crawlers)
  // wall forks branch three levels deep and lie diagonally on the face
  const boltShapes = Array.from({ length: 10 }, (_, i) => boltGeometry(i + 1, false, 3));
  const strikeShapes = Array.from({ length: 4 }, (_, i) => boltGeometry(i + 41, true));
  /** crawlers (small veins across the face): one fork level — clean jagged lines, not scribbles */
  const crawlShapes = Array.from({ length: 6 }, (_, i) => boltGeometry(i + 91, false, 2));   // (forks, never squiggles)
  /** sky bolts (inside the storm): a single fork level — a clean jagged channel, not a scribble */
  const skyShapes = Array.from({ length: 6 }, (_, i) => boltGeometry(i + 71, true, 1));
  const bolts: BoltSlot[] = [];
  for (let i = 0; i < 12; i++) {
    const xf = new THREE.Matrix4();
    const mat = new THREE.ShaderMaterial({ vertexShader: SH.BOLT_VERT, fragmentShader: SH.BOLT_FRAG,
      uniforms: { uXf: { value: xf }, uCore: { value: COL.boltCore.clone() }, uGlow: { value: COL.bolt.clone() }, uOn: { value: 0 } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending });
    const mesh = new THREE.Mesh(i === 4 ? strikeShapes[0] : boltShapes[i % boltShapes.length], mat);
    mesh.frustumCulled = false; mesh.renderOrder = 960; mesh.visible = false; root.add(mesh);
    bolts.push({ mesh, mat, xf, t: 0, dur: 0.8, idle: 0.3 + i * 0.7, on: 0, kind: i === 4 ? 1 : 0, mid: new THREE.Vector3(), re: 0 });
  }

  // ---------------------------------------------------------------- debris (wall swirl + inside flurry)
  const uAnchor = { value: new THREE.Vector3() }, uAlong = { value: new THREE.Vector3(1, 0, 0) }, uOut = { value: new THREE.Vector3(0, 0, 1) };
  const mkDebris = (count: number, mode: number) => {
    const u = { uWind, uTime, uAnchor, uAlong, uOut, uAmt: { value: 0 }, uMode: { value: mode }, uSpan: { value: 900 } };
    const m = new THREE.Mesh(debrisGeometry(count), new THREE.ShaderMaterial({ vertexShader: SH.DEBRIS_VERT, fragmentShader: SH.DEBRIS_FRAG, uniforms: u, transparent: true, side: THREE.DoubleSide }));
    m.frustumCulled = false; m.renderOrder = 7; m.visible = false; root.add(m);
    return { mesh: m, amt: u.uAmt };
  };
  // 2.6k pieces in the camera's 34 m cell (≈ 7x denser)
  const wallDebris = mkDebris(420, 1), innerDebris = mkDebris(2600, 0);

  // ---------------------------------------------------------------- inside: rolling sky dome
  const domeMat = new THREE.ShaderMaterial({ vertexShader: SH.DOME_VERT, fragmentShader: SH.DOME_FRAG,
    uniforms: { uNoise, uSph: vol.u.uSph, uTime, uInside, uFlashV, uGapDir, uMurkDark: { value: COL.skyDark }, uMurkMid: { value: COL.skyMid }, uMurkLit: { value: COL.skyLit }, uHorizon: { value: COL.murkFogLin }, uGapCol: { value: COL.gap }, uVioletFlash: { value: COL.violetFlash } },
    transparent: true, depthWrite: false, depthTest: true, side: THREE.BackSide, fog: false });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), domeMat);
  // drawn first in the transparent pass (after the water + atmos clouds it replaces, before debris / bolts / grade)
  dome.scale.set(2400, 900, 2400); dome.frustumCulled = false; dome.renderOrder = 1; dome.visible = false; root.add(dome);

  // ---------------------------------------------------------------- inside: a multiplicative violet grade (keeps contrast,
  // never a flat purple wash) — a camera-attached triangle drawn last
  const uGrade = { value: COL.grade }, uGradeIns = { value: 0 };
  const gradeGeo = new THREE.BufferGeometry();
  gradeGeo.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const gradeMat = new THREE.ShaderMaterial({
    vertexShader: SH.GRADE_VERT, fragmentShader: SH.GRADE_FRAG,
    uniforms: { uGradeCol: uGrade, uGapDir, uIns: uGradeIns, uFlashV, uInvProj: { value: ctx.camera.projectionMatrixInverse }, uCamWorld: { value: ctx.camera.matrixWorld } },
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
  });
  const grade = new THREE.Mesh(gradeGeo, gradeMat); grade.frustumCulled = false; grade.renderOrder = 1100; grade.visible = false;
  ctx.camera.add(grade);
  const gapMat = new THREE.ShaderMaterial({ vertexShader: SH.GRADE_VERT, fragmentShader: SH.GAPGLOW_FRAG,
    uniforms: { uGapCol: { value: COL.gap }, uGapDir, uIns: uGradeIns, uInvProj: gradeMat.uniforms.uInvProj, uCamWorld: gradeMat.uniforms.uCamWorld },
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false, blending: THREE.AdditiveBlending });
  const gapGlow = new THREE.Mesh(gradeGeo, gapMat); gapGlow.frustumCulled = false; gapGlow.renderOrder = 1101; gapGlow.visible = false;
  ctx.camera.add(gapGlow);

  // ---------------------------------------------------------------- inside: wet, glossy ground near the camera
  const wetGeo = new THREE.PlaneGeometry(136, 136, 40, 40); wetGeo.rotateX(-Math.PI / 2);
  const wetMat = new THREE.ShaderMaterial({ vertexShader: SH.WET_VERT, fragmentShader: SH.WET_FRAG,
    uniforms: { uNoise, uGapDir, uSkyCol: { value: new THREE.Color("#3a2a5e") }, uGapCol: { value: COL.gap }, uInside, uTime, uFlashV },
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, fog: false });
  const wet = new THREE.Mesh(wetGeo, wetMat); wet.frustumCulled = false; wet.renderOrder = 2; wet.visible = false; wet.name = "storm-wet"; root.add(wet);
  let wetX = 1e9, wetZ = 1e9;
  const shotCam = new THREE.Vector3(1e9, 0, 0);
  let sunBase = -1, sunSet = -1, envBase = 1, envSet = -1, satBase = 1, satSet = -1;

  // ---------------------------------------------------------------- state
  const circle: StormCircle = { cx: 0, cz: 0, r: 900, tx: 0, tz: 0, tr: 900, shrinking: false, phase: 1 };
  let dispX = 0, dispZ = 0, dispR = 900, snapped = false, flashE = 0, insideVal = 0, visible = true;
  const fogBase = new THREE.Color(); let fogBaseDensity = 0, fogApplied = false;
  const tmp = new THREE.Vector3(), upS = new THREE.Vector3(), fwd = new THREE.Vector3(), tan = new THREE.Vector3(), inw = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), camP = new THREE.Vector3();
  let rngS = 12345;
  const rnd = () => ((rngS = (Math.imul(rngS, 1664525) + 1013904223) | 0), ((rngS >>> 8) & 0xffff) / 65536);

  const restoreFog = () => {
    const fog = ctx.scene.fog as THREE.FogExp2 | null;
    if (fog && fogApplied) { fog.color.copy(fogBase); fog.density = fogBaseDensity; }
    fogApplied = false;
  };

  /** face radius at height y (the wall leans over the safe zone; small circles stand straight) */
  let wallH = WALL_H, focusAng = 0;
  // the face leans over the safe zone (a 30-40° leading slope); small circles stand straighter
  const overhang = (R: number) => Math.min(wallHeight(R) * 0.42, R * 0.14);
  const faceR = (R: number, y: number) => R - overhang(R) * Math.pow(Math.max(0, y) / wallHeight(R), 1.3);
  /** the TRACED surface radius at angle th, height y: march outward from the clear zone with the CPU copy of the storm
   * SDF, so bolts crawl on the billows the player sees (not inside them, not floating in front) */
  const surfR = (th: number, y: number) => {
    const c = Math.cos(th), s = Math.sin(th);
    let r = faceR(dispR, y) - 200;
    for (let i = 0; i < 48; i++) { const d = vol.sdf(dispX + c * r, y, dispZ + s * r, 4); if (d < 2) break; r += Math.max(2, d * 0.8); }
    return r;
  };

  /** CPU sphere trace of the storm volume along the camera ray through NDC (nx, ny): the bolts go ON billows the player
   * actually sees. Writes hitP / hitT, returns false on a miss (sky, ground, too far). */
  const rayDir = new THREE.Vector3(), hitP = new THREE.Vector3(); let hitT = 0;
  let camRef: THREE.PerspectiveCamera | null = null;
  function traceWall(nx: number, ny: number, maxT: number): boolean {
    const cam = camRef; if (!cam) return false;
    rayDir.set(nx, ny, 0.5).unproject(cam).sub(cam.position).normalize();
    const o = cam.position; let t = 4;
    for (let i = 0; i < 80; i++) {
      const x = o.x + rayDir.x * t, y = o.y + rayDir.y * t, z = o.z + rayDir.z * t;
      if (y < -5 || y > wallH + 420 || t > maxT) return false;
      const d = vol.sdf(x, y, z, t < 900 ? 3 : 2);
      if (d < Math.max(0.8, t * 0.003)) { hitP.set(x, y, z); hitT = t; return y > Math.max(0, ctx.terrain.height(x, z)) + 6; }
      t += Math.max(d * 0.85, t * 0.004, 1.5);
    }
    return false;
  }
  (globalThis as { __stormDbg?: unknown }).__stormDbg = { traceWall: (x: number, y: number, m: number) => traceWall(x, y, m) ? hitT : -1 };
  /** a random visible point of the wall face inside the NDC box (a few tries), or false */
  function pickOnWall(x0: number, x1: number, y0: number, y1: number, maxT: number): boolean {
    for (let k = 0; k < 4; k++) if (traceWall(x0 + (x1 - x0) * rnd(), y0 + (y1 - y0) * rnd(), maxT) && hitT > 40) return true;
    return false;
  }

  /** the bolt's plane: vertical, square to the camera's line of sight to (x, z) — tan across the view, inw toward the camera */
  function faceCam(x: number, z: number) {
    let ix = camP.x - x, iz = camP.z - z; const l = Math.hypot(ix, iz) || 1; ix /= l; iz /= l;
    inw.set(ix, 0, iz); tan.set(-iz, 0, ix);
  }
  /** (re)strike a bolt slot: where, what shape, how long */
  function strike(b: BoltSlot, mode: "wall" | "sky" | "ground" | "crawl", viewAng: number) {
    const R = dispR;
    // a stroke lives 0.14-0.25 s (a leader, a dark gap, a return stroke), then re-strikes down the same
    // channel 0-2 times after 60-180 ms — never a glowing rod that hangs in the air for half a second
    b.t = 0; b.dur = 0.14 + rnd() * 0.11; b.re = rnd() < 0.55 ? 1 + ((rnd() * 2) | 0) : 0;
    b.idle = mode === "sky" ? 0.4 + rnd() * 1.6 : 0.15 + rnd() * 0.9;
    if (mode === "sky") {
      // a big white-violet fork 250-650 m away, biased toward where the camera looks, from the clouds to the ground
      // three slots spread across the view (left / centre / right), never stacked on each other
      const slot = bolts.indexOf(b) % 3;
      const a = Math.atan2(fwd.z, fwd.x) + (slot - 1) * 0.42 + (rnd() - 0.5) * 0.22, d = 320 + rnd() * 300;
      const bx = camP.x + Math.cos(a) * d, bz = camP.z + Math.sin(a) * d, S = 520 + rnd() * 160;
      tan.set(-Math.sin(a), 0, Math.cos(a)); inw.set(-Math.cos(a), 0, -Math.sin(a));
      b.xf.makeBasis(tmp.copy(tan).multiplyScalar(S), upS.copy(up).multiplyScalar(S), inw).setPosition(bx, -10, bz);
      b.mid.set(bx, S * 0.5, bz);
      b.mesh.geometry = skyShapes[(rnd() * skyShapes.length) | 0];
      (b.mat.uniforms.uCore.value as THREE.Color).copy(COL.skyCore); (b.mat.uniforms.uGlow.value as THREE.Color).copy(COL.skyBolt);
      return;
    }
    if (mode !== "ground" && pickOnWall(-0.95, 0.95, -0.2, 0.92, 3200)) {
      faceCam(hitP.x, hitP.z);   // the fork faces the camera: on a receding wall it never collapses into a rod
      const crawl = mode === "crawl";
      let S = Math.min(300, wallH * 0.9, Math.max(80, hitT * (crawl ? 0.12 + rnd() * 0.1 : 0.24 + rnd() * 0.2)));
      // the whole fork must lie ON the wall: its top end has to trace to the wall too (never hanging in the sky)
      const hx = hitP.x, hy = hitP.y, hz = hitP.z, hT = hitT, rx = rayDir.x, ry = rayDir.y, rz = rayDir.z;
      const onWall = (x: number, y: number, z: number) => { tmp.set(x, y, z).project(camRef!); return Math.abs(tmp.x) < 1 && Math.abs(tmp.y) < 1 && traceWall(tmp.x, tmp.y, hT * 1.25 + 60); };
      let ok = false;
      for (let k = 0; k < 4 && !ok; k++) {
        ok = onWall(hx, hy + S * 0.45, hz) && onWall(hx, hy - S * 0.5, hz) && onWall(hx + tan.x * S * 0.3, hy, hz + tan.z * S * 0.3) && onWall(hx - tan.x * S * 0.3, hy, hz - tan.z * S * 0.3);
        if (!ok) S *= 0.55;
      }
      // never shorter than 80 m, never longer than 300 m
      // (a fork too short for its distance reads as a glowing stub: ≥ 12 % of the range, i.e. ≥ ~7° of the view)
      if (!ok || S < Math.max(80, hT * 0.12)) { b.t = 0; b.dur = 0; b.idle = 0.1; b.re = 0; return; }
      hitP.set(hx, hy, hz); hitT = hT; rayDir.set(rx, ry, rz);
      // lean: crawlers any way round; big wall forks run diagonally down the face (35-75°), never plumb
      const a = crawl ? (rnd() - 0.5) * 2.4 : (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 0.7), ca = Math.cos(a), sa = Math.sin(a);
      // rotate in the face plane, THEN mirror the finished x axis: mirroring tan alone left x·y = 2·sin·cos,
      // a sideways fork's axes nearly parallel — the fork collapsed into a straight glowing rod
      tmp.copy(tan).multiplyScalar(ca * S).addScaledVector(up, sa * S);
      upS.copy(tan).multiplyScalar(-sa * S).addScaledVector(up, ca * S);
      if (rnd() < 0.5) tmp.negate();
      // centred on the hit, lifted a few metres off the billow toward the camera
      const px = hitP.x - rayDir.x * 6 - upS.x * 0.55, py = hitP.y - rayDir.y * 6 - upS.y * 0.55, pz = hitP.z - rayDir.z * 6 - upS.z * 0.55;
      b.xf.makeBasis(tmp, upS, inw).setPosition(px, py, pz);
      b.mid.set(hitP.x - rayDir.x * 20, hitP.y, hitP.z - rayDir.z * 20);
      b.mesh.geometry = crawl ? crawlShapes[(rnd() * crawlShapes.length) | 0] : boltShapes[(rnd() * boltShapes.length) | 0];
      (b.mat.uniforms.uCore.value as THREE.Color).copy(COL.boltCore); (b.mat.uniforms.uGlow.value as THREE.Color).copy(COL.bolt);
      flashE = Math.max(flashE, crawl ? 0.18 : 0.32);
      return;
    }
    if (mode === "crawl") { b.t = 0; b.dur = 0; b.idle = 0.15; b.re = 0; return; }
    const ground = mode === "ground";
    if (ground && pickOnWall(-0.9, 0.95, -0.25, 0.2, 1400) && hitP.y < wallH * 0.35) {
      faceCam(hitP.x, hitP.z);
      const gx = hitP.x - rayDir.x * 25, gz = hitP.z - rayDir.z * 25, gy = Math.max(0, ctx.terrain.height(gx, gz));
      const S = Math.min(300, wallH * 0.8, Math.max(120, hitT * 0.6));
      if (Math.hypot(gx - camP.x, gz - camP.z) < Math.max(90, S * 0.6)) { b.t = 0; b.dur = 0; b.idle = 0.15; b.re = 0; return; }
      b.xf.makeBasis(tmp.copy(tan).multiplyScalar(S * (rnd() < 0.5 ? 1 : -1)), upS.copy(up).multiplyScalar(S), inw).setPosition(gx, gy, gz);
      b.mid.set(gx, gy + S * 0.4, gz);
      b.mesh.geometry = strikeShapes[(rnd() * strikeShapes.length) | 0];
      (b.mat.uniforms.uCore.value as THREE.Color).copy(COL.boltCore); (b.mat.uniforms.uGlow.value as THREE.Color).copy(COL.bolt);
      return;
    }
    const hs = wallH / WALL_H;
    const S = Math.min(300, ground ? wallH * (0.55 + rnd() * 0.2) : (160 + rnd() * 140) * Math.max(0.55, hs));
    const y0 = ground ? 0 : (40 + rnd() * 220) * hs;
    // a fork is only ever seen whole — its middle ≥ max(90 m, 0.8 × its length) from
    // the camera; standing at the wall, the strike lands further along the face (or waits)
    let th = 0, rFace = 0, bx = 0, bz = 0, placed = false;
    for (let k = 0; k < 5 && !placed; k++) {
      const off = (rnd() - 0.5) * (ground ? 420 : 620) * (1 + k * 0.6);
      th = viewAng + off / Math.max(R, 60);
      rFace = ground ? surfR(th, 30) - 25 : surfR(th, y0 + S * 0.5) - 10;
      bx = dispX + Math.cos(th) * rFace; bz = dispZ + Math.sin(th) * rFace;
      placed = Math.hypot(bx - camP.x, y0 + S * 0.5 - camP.y, bz - camP.z) >= Math.max(90, S * 0.8);
    }
    if (!placed) { b.t = 0; b.dur = 0; b.idle = 0.15; b.re = 0; return; }
    faceCam(bx, bz);
    b.xf.makeBasis(tmp.copy(tan).multiplyScalar(S * (rnd() < 0.5 ? 1 : -1)), upS.copy(up).multiplyScalar(S), inw).setPosition(bx, y0, bz);
    b.mid.set(bx, y0 + S * 0.55, bz);
    b.mesh.geometry = ground ? strikeShapes[(rnd() * strikeShapes.length) | 0] : boltShapes[(rnd() * boltShapes.length) | 0];
    (b.mat.uniforms.uCore.value as THREE.Color).copy(COL.boltCore); (b.mat.uniforms.uGlow.value as THREE.Color).copy(COL.bolt);
  }
  /** flicker envelope over a stroke of `dur` s: the leader, a dark gap, the return stroke that fades out by `dur` */
  const envelope = (t: number, dur: number) => t < 0.045 ? 1.35 : t < 0.072 ? 0.1 : t < 0.11 ? 1.15 : Math.max(0, 1 - (t - 0.11) / Math.max(0.03, dur - 0.11));

  /** the atmos knobs (post fog, fog colour / height, sun glare) toward the storm murk by `ins` (0 restores them) */
  function atmosOverride(ins: number) {
    const post = (ctx as unknown as { post?: { composite?: { mat?: THREE.ShaderMaterial; glare?: number } } }).post?.composite;
    const au = (ctx.shared.get("atmos") as { uniforms?: Record<string, { value: unknown }> } | undefined)?.uniforms;
    const agl = camP.y - Math.max(0, ctx.terrain.height(camP.x, camP.z));
    const dens = 0.0105 - 0.006 * Math.min(1, Math.max(0, (agl - 20) / 180));
    if (post?.mat?.uniforms?.uPostFog) {
      const U = post.mat.uniforms;
      U.uPostFog.value = knob(K_FOG, U.uPostFog.value as number, dens, ins);
      U.uPostFogStart.value = knob(K_FOGSTART, U.uPostFogStart.value as number, 10, ins);
      post.glare = knob(K_GLARE, post.glare ?? 0, 0, ins);
    } else if (au?.uAtmFogDensity) au.uAtmFogDensity.value = knob(K_FOGM, au.uAtmFogDensity.value as number, dens, ins);
    if (au?.uAtmFogHeight) au.uAtmFogHeight.value = knob(K_FOGH, au.uAtmFogHeight.value as number, 420, ins);
    if (au?.uAtmFogColor) knobColor(K_FOGC, au.uAtmFogColor.value as THREE.Color, COL.murkFogLin, ins);
  }
  const visual: StormVisual = {
    get inside() { return insideVal; },
    set(c: StormCircle) {
      Object.assign(circle, c);
      if (!snapped) { dispX = c.cx; dispZ = c.cz; dispR = c.r; snapped = true; }
      root.visible = visible && circle.phase > 0;
    },
    flash(strength = 1) { flashE = Math.max(flashE, Math.min(strength, 1.5)); for (let i = 0; i < bolts.length; i++) { const b = bolts[i]; if (b.idle > 0.05) b.idle = Math.min(b.idle, 0.05 + i * 0.08 + rnd() * 0.05); } },
    setVisible(v: boolean) { visible = v; root.visible = v && circle.phase > 0; if (!v) restoreFog(); },
    compile: (renderer) => vol.compile(renderer),
    update(dt: number, t: number, cam: THREE.PerspectiveCamera): number {
      // circle motion: the sim's circle; displayed with a short ease so jumps (late join) glide
      if (ctx.shotMode) { dispX = circle.cx; dispZ = circle.cz; dispR = circle.r; }
      else {
        if (circle.shrinking) { const k = Math.min(1, dt * 0.05); circle.cx += (circle.tx - circle.cx) * k; circle.cz += (circle.tz - circle.cz) * k; circle.r += (circle.tr - circle.r) * k; }
        const d = Math.min(1, dt * 3); dispX += (circle.cx - dispX) * d; dispZ += (circle.cz - dispZ) * d; dispR += (circle.r - dispR) * d;
      }
      // (globalThis.__stormOff: bench switch — measures the frame with / without the storm)
      const on = visible && circle.phase > 0 && dispR < 4000 && !(globalThis as { __stormOff?: boolean }).__stormOff;
      root.visible = on;
      if (!on) {
        insideVal = 0; uInside.value = 0; if (fogApplied) restoreFog();
        // leaving / hiding the storm while inside it: give the sun + sky light back
        const sunL = ctx.shared.get("sun") as THREE.DirectionalLight | undefined;
        if (sunL && sunSet >= 0 && sunL.intensity === sunSet) { sunL.intensity = sunBase; sunSet = -1; }
        const sc = ctx.scene as THREE.Scene & { environmentIntensity: number };
        if (envSet >= 0 && sc.environmentIntensity === envSet) { sc.environmentIntensity = envBase; envSet = -1; }
        { const su = ((ctx as unknown as { post?: { composite?: { mat?: THREE.ShaderMaterial } } }).post?.composite?.mat?.uniforms?.uSat) as { value: number } | undefined;
          if (su && satSet >= 0 && su.value === satSet) { su.value = satBase; satSet = -1; } }
        grade.visible = false; gapGlow.visible = false; wet.visible = false;
        atmosOverride(0);
        return 0;
      }
      wallH = wallHeight(dispR);
      uCenter.value.set(dispX, dispZ); uR.value = Math.max(dispR, 10); uTime.value = t; uLean.value = overhang(dispR) / wallH;
      const sun = ctx.shared.get("sunDir") as THREE.Vector3 | undefined; if (sun) uSunDir.value.copy(sun);
      // the wall is lit by the day's sun at full strength (its own intensity is dimmed while we stand inside the storm)
      { const sl = ctx.shared.get("sun") as THREE.DirectionalLight | undefined; if (sl) vol.u.uSunCol.value.copy(sl.color).multiplyScalar(sunSet >= 0 && sl.intensity === sunSet ? sunBase : sl.intensity); }
      cam.getWorldDirection(fwd); camP.copy(cam.position); camRef = cam;
      uLipK.value = Math.min(1, Math.max(0, (camP.y - wallH * 0.85) / 380));
      { const v = vol.u; v.uCenter.value.set(dispX, dispZ); v.uR.value = Math.max(dispR, 10); v.uH.value = wallH; v.uOv.value = overhang(dispR); v.uTime.value = t;
        v.uFaceOut.value = Math.min(100, dispR * 0.25); v.uNearFade.value = 1 - Math.min(1, Math.max(0, (insideVal - 0.25) / 0.4)); v.uSunDir.value.copy(uSunDir.value); v.uLipK.value = uLipK.value; v.uHazeK.value = camP.y > wallH ? 1 / 40000 : 1 / 2600; }

      // inside factor: soft band at the wall base; above the deck there is no murk
      const dx = camP.x - dispX, dz = camP.z - dispZ, dist = Math.sqrt(dx * dx + dz * dz);
      let ins = Math.min(1, Math.max(0, (dist - (dispR - INSIDE_BAND)) / (2 * INSIDE_BAND)));
      ins = ins * ins * (3 - 2 * ins);
      // up to the cloud tops you are IN the storm (murk, fog, storm sky); above them you look down on the deck
      const hF = Math.min(1, Math.max(0, (wallH * 1.35 - camP.y) / (wallH * 0.3)));
      ins *= hF * hF * (3 - 2 * hF);
      // …and flying THROUGH the cloud mass (a glider skimming the wall top, a redeploy through the deck) is being in it
      // too: the CPU copy of the storm SDF at the camera (without it, from 180 m the frame was a flat lavender murk with
      // a sawtooth hole cut through it)
      if (camP.y > 12) {
        const sd = vol.sdf(camP.x, camP.y, camP.z, 3);
        const cin = Math.min(1, Math.max(0, (8 - sd) / 40));
        ins = Math.max(ins, cin * cin * (3 - 2 * cin));
      }
      insideVal = ins; uInside.value = ins;

      // the wall section the camera faces (ray vs the circle, else the nearest point)
      let viewAng = Math.atan2(dz, dx);
      { const fx = fwd.x, fz = fwd.z, fl = Math.hypot(fx, fz) || 1; const b = (dx * fx + dz * fz) / fl, c = dist * dist - dispR * dispR, disc = b * b - c; if (disc > 0) { const s = -b + Math.sqrt(disc); if (s > 0) viewAng = Math.atan2(dz + (fz / fl) * s, dx + (fx / fl) * s); } }
      // the NEAREST piece of wall that is on screen (debris + lightning live there, not on the far wall the view ray hits)
      {
        const near = Math.atan2(dz, dx), step = 40 / Math.max(dispR, 60), hf = Math.tan((cam.fov * Math.PI / 360)) * cam.aspect * 0.85;
        const fl = Math.hypot(fwd.x, fwd.z) || 1, fx = fwd.x / fl, fz = fwd.z / fl;
        let best = 1e12;
        for (let k = -45; k <= 45; k++) {
          const th = near + k * step, rf = faceR(dispR, wallH * 0.3);
          const px = dispX + Math.cos(th) * rf - camP.x, pz = dispZ + Math.sin(th) * rf - camP.z;
          const along = px * fx + pz * fz; if (along < 20) continue;
          const side = Math.abs(px * -fz + pz * fx); if (side > along * hf) continue;
          const d2 = px * px + pz * pz; if (d2 < best) { best = d2; focusAng = th; }
        }
        if (best === 1e12) focusAng = viewAng;
      }

      // wall + deck (hidden once we are deep inside: the murk and the storm sky take over)
      const showWall = ins < 0.65;
      vol.mesh.visible = showWall; for (const dm of dusts) dm.visible = showWall;
      // the ground glow is the aerial read (yellow light spilling onto the sea inside the rim); from the ground the
      // traced wall's own golden foot + the dust skirt do that job (a flat glow sheet cannot follow the terrain)
      // (the ground glow read as a flat orange sheet over the harbor from the air — the lip's own emissive glow
      // + bloom does that job now)
      glow.visible = false;

      // lightning
      if (!ctx.shotMode) flashE = Math.max(0, flashE - dt * 2.2);
      const skyMode = ins > 0.5, aerial = camP.y > wallH * 1.4;
      let strikeAmt = 0;
      // (shots) the bolts are struck once — after the view camera settles: a fork faced to a stale camera is a rod
      if (ctx.shotMode && shotCam.distanceToSquared(camP) > 0.25) { shotCam.copy(camP); for (const b of bolts) { b.dur = 0.8; b.re = 0; } }
      // budget CPU raymarching: at most 1 bolt placement per live frame (never 12 at once on storm phase start),
      // and skip wall raymarches completely when aerial (in the plane, bolts are hidden — only deck glow flickers)
      let struck = false;
      for (let i = 0; i < bolts.length; i++) {
        const b = bolts[i];
        b.t += ctx.shotMode ? 0 : dt;
        const mode: "wall" | "sky" | "ground" | "crawl" = skyMode ? "sky" : i === 4 ? "ground" : i > 4 ? "crawl" : "wall";
        // a re-strike down the same channel 60-180 ms after the stroke (no new placement)
        if (b.re > 0 && b.dur > 0 && b.t > b.dur + 0.06 + (b.re & 1) * 0.12) { b.re--; b.t = 0.04; flashE = Math.max(flashE, 0.2); }
        if (b.t > b.dur + b.idle || (ctx.shotMode && b.dur === 0.8)) {
          if (aerial && !ctx.shotMode) {
            b.t = 0; b.dur = 0.16 + rnd() * 0.1; b.idle = 0.2 + rnd() * 0.8; b.re = 0;
          } else if (!struck || ctx.shotMode) {
            struck = true;
            strike(b, mode, mode === "sky" ? viewAng : focusAng);
            if (ctx.shotMode) b.t = [0.02, 0.09, 0.03, 0.1][i & 3];   // frozen shots: most bolts caught mid-stroke
          }
        }
        const env = b.t < b.dur ? envelope(b.t, b.dur) : 0;
        const vis = env > 0.01 && (!skyMode || i < 3) && !aerial;
        b.mesh.visible = vis; b.on = vis ? env : 0;
        b.mat.uniforms.uOn.value = b.on;
        const L = uBolt.value[i < 4 ? i : 3];
        if (i < 4) L.set(b.mid.x, b.mid.y, b.mid.z, vis || aerial ? env * (aerial ? 0.8 : 1) : 0);
        if (i > 4 && skyMode) { b.mesh.visible = false; b.on = 0; b.mat.uniforms.uOn.value = 0; }
        if (i === 4 && vis) { strikeAmt = env; uBolt.value[3].set(b.mid.x, 60, b.mid.z, env); }
      }
      if (aerial) for (let i = 0; i < 4; i++) {
        // from above: flashes flicker inside the deck near the rim instead of visible bolts
        const a = viewAng + (i - 1.5) * 0.9 + Math.sin(t * 0.3 + i) * 0.3, rr = dispR + 90 + i * 60;
        uBolt.value[i].x = dispX + Math.cos(a) * rr; uBolt.value[i].z = dispZ + Math.sin(a) * rr; uBolt.value[i].y = wallH * 0.85;
      }
      uStrike.value = strikeAmt; uFlash.value = flashE; vol.u.uFlash.value = flashE;
      // trace the wall + deck for this frame (bolt light is final now)
      if (showWall && !(globalThis as { __stormNoTrace?: boolean }).__stormNoTrace) vol.trace(ctx.renderer, cam);

      // debris: the swirl in front of the wall (safe side, near) and the flurry inside the storm
      const wallDist = Math.abs(dist - dispR);
      const swirl = !skyMode && wallDist < 1100 && camP.y < wallH;
      wallDebris.mesh.visible = swirl; wallDebris.amt.value = swirl ? 1 - Math.max(0, (wallDist - 700) / 400) : 0;
      if (swirl) {
        const ca = Math.cos(focusAng), sa = Math.sin(focusAng), rf = faceR(dispR, 0) - 20;
        uAnchor.value.set(dispX + ca * rf, 0, dispZ + sa * rf);
        uAlong.value.set(-sa, 0, ca); uOut.value.set(-ca, 0, -sa);
        uAnchor.value.y = Math.max(0, ctx.terrain.height(uAnchor.value.x, uAnchor.value.z));
      }
      innerDebris.mesh.visible = ins > 0.01; innerDebris.amt.value = ins;
      // wind: out of the storm + along the wall
      const inv = dist > 1e-3 ? 1 / dist : 0, ox = dx * inv, oz = dz * inv;
      uWind.value.set(-ox * 0.45 - oz * 0.9, 0, -oz * 0.45 + ox * 0.9).normalize();

      // inside: the storm sky + gap toward the safe zone + sky-bolt flashes
      dome.visible = ins > 0.002;
      if (dome.visible) {
        dome.position.copy(camP);
        uGapDir.value.set(-ox, -oz);
        let fl = 0; for (let i = 0; i < 3; i++) fl += bolts[i].on;
        // frozen view-camera frames catch the bolts mid-stroke, but not the whole-sky flash (it lasts a few frames live)
        uFlashV.value = (ctx.shotMode ? 0.12 : Math.min(1, fl * 0.16 + flashE * 0.3)) * ins;
      } else uFlashV.value = 0;

      // inside: grade the frame toward violet and dim the sun (the storm blots it out); restored when safe
      grade.visible = ins > 0.002; gapGlow.visible = grade.visible;
      uGradeIns.value = ins;
      // wet ground: a sheet draped on the terrain around the camera (re-draped every few metres)
      // (the draped wet sheet cut hard-edged polygons across slopes and the sky: off)
      wet.visible = false && ins > 0.2 && camP.y - Math.max(0, ctx.terrain.height(camP.x, camP.z)) < 30;
      if (wet.visible) {
        const sx = Math.round(camP.x / 3.5) * 3.5, sz = Math.round(camP.z / 3.5) * 3.5;
        if (sx !== wetX || sz !== wetZ) {
          wetX = sx; wetZ = sz; wet.position.set(sx, 0, sz);
          const pa = wet.geometry.getAttribute("position") as THREE.BufferAttribute, arr = pa.array as Float32Array;
          for (let i = 0; i < pa.count; i++) arr[i * 3 + 1] = Math.max(ctx.terrain.height(sx + arr[i * 3], sz + arr[i * 3 + 2]), 0.02) + 0.06;
          pa.needsUpdate = true;
        }
      }
      const sunL = ctx.shared.get("sun") as THREE.DirectionalLight | undefined;
      if (sunL) {
        if (sunL.intensity !== sunSet) sunBase = sunL.intensity;          // someone (atmos) set it: that is the base
        sunL.intensity = sunSet = sunBase * (1 - 0.8 * ins);
      }
      // the sky light too (the storm blots out the blue sky): environment intensity, same base/restore trick
      { const sc = ctx.scene as THREE.Scene & { environmentIntensity: number };
        if (sc.environmentIntensity !== envSet) envBase = sc.environmentIntensity;
        sc.environmentIntensity = envSet = envBase * (1 - 0.55 * ins); }
      // colour: inside the storm the world loses most of its saturation (a dusky violet: a lime banana leaf goes
      // olive-grey). Same base/restore trick on the composite's OkLab saturation (atmos post; skipped if absent).
      // TODO: a grade override in the atmos api would replace this lookup.
      { const su = ((ctx as unknown as { post?: { composite?: { mat?: THREE.ShaderMaterial } } }).post?.composite?.mat?.uniforms?.uSat) as { value: number } | undefined;
        if (su) { if (su.value !== satSet) satBase = su.value; su.value = satSet = satBase * (1 - 0.68 * ins); } }
      // world fog: violet murk inside. The atmos module applies its height fog IN POST (composite uPostFog, colour + height
      // from the shared uniforms) and draws a sun glare veil there: both driven here with the base/restore knobs
      // (a formal atmos override would be cleaner). Visibility ~150 m on the ground.
      atmosOverride(ins);
      const fog = ctx.scene.fog as THREE.FogExp2 | null;
      if (fog && (fog as THREE.FogExp2).isFogExp2) {
        if (ins <= 0.0001) { if (fogApplied) restoreFog(); fogBase.copy(fog.color); fogBaseDensity = fog.density; }
        else {
          // ~150 m visibility on the ground; thinner up high (a redeploy inside the storm still sees the island below)
          const agl = camP.y - Math.max(0, ctx.terrain.height(camP.x, camP.z)), dens = 0.017 - 0.01 * Math.min(1, Math.max(0, (agl - 20) / 180));
          fog.color.copy(fogBase).lerp(COL.murkFog, Math.min(1, ins * 1.5)); fog.density = fogBaseDensity + (dens - fogBaseDensity) * ins; fogApplied = true;
        }
      }
      if (HIDE) {
        // dev bisect: ?stormhide=vol,dust,dome,grade,gap,debris,bolts
        if (HIDE.has("vol")) vol.mesh.visible = false;
        if (HIDE.has("dust")) for (const dm of dusts) dm.visible = false;
        if (HIDE.has("dome")) dome.visible = false;
        if (HIDE.has("grade")) grade.visible = false;
        if (HIDE.has("gap")) gapGlow.visible = false;
        if (HIDE.has("debris")) { wallDebris.mesh.visible = false; innerDebris.mesh.visible = false; }
        if (HIDE.has("bolts")) for (const b of bolts) b.mesh.visible = false;
      }
      return ins;
    },
    dispose() {
      restoreFog();
      ctx.scene.remove(root); ctx.camera.remove(grade); ctx.camera.remove(gapGlow); gradeGeo.dispose(); gradeMat.dispose(); gapMat.dispose();
      const sunL = ctx.shared.get("sun") as THREE.DirectionalLight | undefined; if (sunL && sunBase >= 0) sunL.intensity = sunBase;
      if (envSet >= 0) (ctx.scene as THREE.Scene & { environmentIntensity: number }).environmentIntensity = envBase;
      root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
      for (const g of [...boltShapes, ...strikeShapes, ...skyShapes, ...crawlShapes]) g.dispose();
      vol.dispose();
      noise.dispose();
    },
  };
  return visual;
}
