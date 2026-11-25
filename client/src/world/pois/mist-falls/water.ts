// MIST FALLS — water: the falls (curling over the lip, aerating as they drop, dissolving into the mist), plunge pool,
// river ribbon, impact foam, spray, the big mist bank, a faint partial rainbow in it; sand bed under the water + cream
// sandbars on the banks (opaque, terrain-grid exact, dithered edges — no sorting holes).
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import { WORLD } from "../../../../../shared/world/map";
import { FALLS, type FallsResolved } from "../../../../../shared/pois/jungle-falls";
import { waterMaterial, poolSurface, riverSurface, fallsMaterial, fallsSheet, cascadeSheet, puffCloud, rainbow, bakeRockDist } from "../_kit/jungle-water";
import { pbr } from "../_kit/jungle-mat";
import { rockProtos } from "../_kit/jungle-rocks";
import { flag } from "../../../flags";

export function buildWater(ctx: WorldCtx, root: THREE.Group, R: FallsResolved) {
  const h = (x: number, z: number) => ctx.terrain.height(x, z);
  const P = FALLS.pool, lvl = P.level;
  const fMat = fallsMaterial(), veilMat = fallsMaterial(0.5);
  const impacts: THREE.Vector3[] = [];
  FALLS.falls.forEach((f, i) => {
    const top = new THREE.Vector3(...f.top), dir = new THREE.Vector3(f.dir[0], 0, f.dir[1]);
    if (f.cascade) {
      const c = cascadeSheet(top, dir, f.width, h, lvl, fMat, 40 + i);
      root.add(c.mesh); impacts.push(c.impact);
      root.add(puffCloud(new THREE.Vector3(c.impact.x, lvl + 0.6, c.impact.z), { count: 14, color: "#ffffff", size: [1.0, 2.4], opacity: 0.7, rise: 1.2, drift: 0.8, spread: [1.6, 0.4, 1.6], life: 2.2, lit: true, power: 1.1 }));
      root.add(puffCloud(new THREE.Vector3(c.impact.x, lvl + 3, c.impact.z), { count: 8, color: "#f2f8ff", size: [4, 8], opacity: 0.16, rise: 1.6, drift: 1.8, spread: [3, 2, 3], life: 7, power: 1.6, lit: true }));
      return;
    }
    const main = fallsSheet(top, lvl, f.width, dir, fMat, { v0: f.v0, seed: 10 + i, spread: 0.62 });   // the falls fan out toward the pool
    // the stream feeding the lip (runs into the curl)
    const back = 11, pts: Array<[number, number]> = [[top.x - dir.x * back, top.z - dir.z * back], [top.x - dir.x * back * 0.5, top.z - dir.z * back * 0.5], [top.x - dir.x * 1.6, top.z - dir.z * 1.6]];
    root.add(riverSurface(pts, [top.y + 1.0, top.y + 0.55, top.y + 0.22], [f.width * 0.6, f.width * 0.54, f.width * 0.5], () => top.y - 1.4, waterMaterial({ clarity: 0.6, foamScale: 1.2 }), { across: 10, step: 0.6, speed: () => 2.2, foamAt: (x, z) => Math.min(1, Math.max(0, 1 - Math.hypot(x - top.x, z - top.z) / 4)) }));
    root.add(main.mesh); impacts.push(main.impact);
    // a thinner, wider back veil (depth + parallax)
    const veil = fallsSheet(top.clone().addScaledVector(dir, -0.4), lvl, f.width * 1.15, dir, veilMat, { v0: f.v0 * 0.8, seed: 20 + i, spread: 0.85, cols: 8 });
    root.add(veil.mesh);
    // impact: churning white foam (lit), rising spray, and a big soft mist bank rolling over the pool
    // impact: fine spray droplets bursting up + a low churn of small puffs (the pool shader draws the churn + spreading
    // foam rings), a soft mist column — never big white blobs
    const imp = main.impact, big = f.width > 4;
    root.add(puffCloud(new THREE.Vector3(imp.x, lvl + 0.9, imp.z), { count: big ? 90 : 40, color: "#ffffff", size: big ? [0.25, 0.75] : [0.2, 0.55], opacity: 0.85, rise: 4.5, drift: 1.8, spread: [f.width * 0.5, 0.6, f.width * 0.5], life: 1.4, lit: true, power: 1.6, grow: 0.3 }));
    root.add(puffCloud(new THREE.Vector3(imp.x, lvl + 0.35, imp.z), { count: big ? 26 : 12, color: "#f6fbff", size: big ? [0.9, 1.8] : [0.7, 1.3], opacity: 0.55, rise: 0.6, drift: 1.2, spread: [f.width * 0.6, 0.15, f.width * 0.6], life: 1.8, lit: true, power: 1.3 }));
    root.add(puffCloud(new THREE.Vector3(imp.x + 1.5, lvl + 3.5, imp.z), { count: big ? 40 : 18, color: "#f3f9ff", size: big ? [6, 13] : [4, 8], opacity: 0.3, rise: 3, drift: 2.5, spread: [f.width * 0.9, 3.0, f.width * 0.9], life: 7, power: 1.5, lit: true }));
    root.add(puffCloud(new THREE.Vector3(imp.x + 7, lvl + 6, imp.z), { count: big ? 22 : 10, color: "#eef7ff", size: big ? [12, 22] : [7, 13], opacity: big ? 0.13 : 0.09, rise: 1.2, drift: 4, spread: [9, 4.5, 10], life: 13, power: 2.0, lit: true }));
  });
  // plunge pool: foam from the impacts (with lace), round the in-pool rocks; gentle outflow toward the outlet
  const inPool = R.boulders.filter((b) => Math.abs(b.y + b.sy * 0.8 - lvl - 0.25) < 1.2 && Math.hypot(b.x - P.x, b.z - P.z) < P.rz + 2);
  const foamAt = (x: number, z: number) => {
    let f = 0;
    impacts.forEach((p, i) => { const r = FALLS.falls[i].width * 1.0 + 2.5; f = Math.max(f, 1 - Math.hypot(x - p.x, z - p.z) / r); });
    for (const b of inPool) f = Math.max(f, 0.55 * (1 - (Math.hypot(x - b.x, z - b.z) - b.sx * 0.95) / 0.9));
    return Math.min(1, Math.max(0, f) * 1.2);
  };
  const flowAt = (x: number, z: number): [number, number] => {
    let fx = 0, fz = 0;
    for (const p of impacts) { const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz) + 1; fx += dx / d * 3 / (1 + d * 0.15); fz += dz / d * 3 / (1 + d * 0.15); }
    const ox = -126 - x, oz = -401 - z, od = Math.hypot(ox, oz) + 1; fx += ox / od * 0.35; fz += oz / od * 0.35;
    return [fx * 0.3, fz * 0.3];
  };
  const sandSet = pbr(ctx, "sand2");   // the island's cream beach sand (soft ripples, pebbles) (a golden ripple sheet reads as stripes)
  // the terrain heights per pixel (the sea water's field texture): pool + river edges sit exactly on the drawn
  // bank instead of the per-vertex depth's sawtooth
  const wU = (ctx.shared.get("water") as { uniforms?: Record<string, { value: unknown }> } | undefined)?.uniforms;
  const ground = wU?.wtrField && wU?.wtrFieldST ? { tex: wU.wtrField as { value: THREE.Texture | null }, st: wU.wtrFieldST as { value: THREE.Vector2 } } : undefined;
  const wMat = waterMaterial({ ground, clarity: 1.1, alpha0: 0.4, glow: 0.5, bed: { map: sandSet, tint: [1.0, 1.0, 1.02], scale: 3.2 }, sigma: [2.6, 0.56, 0.4], scatter: "#007c9a", caustics: 0.6,
    impacts: impacts.slice(0, 4).map((p, i) => [p.x, p.z, FALLS.falls[i].width * 1.1 + 4] as [number, number, number]) });
  root.add(poolSurface(P.x - 1, P.z, P.rx - 1, P.rz + 4, lvl, (x, z) => (x > FALLS.weir.x + 0.8 ? 1e3 : h(x, z)), wMat, { seg: 120, foamAt, flowAt }));
  // the spill over the weir: a short wide cascade from the pool into the river
  { const W = FALLS.weir, top = new THREE.Vector3(W.x + 1.2, lvl, W.gap.z), dir = new THREE.Vector3(1, 0, 0);
    const sp = fallsSheet(top, W.riverY - 0.2, W.gap.hw * 1.7, dir, fMat, { v0: 1.6, seed: 77, spread: 0.1, segs: 10, curl: 0.5, back: 1.2 });
    root.add(sp.mesh);
    root.add(puffCloud(new THREE.Vector3(sp.impact.x + 0.5, W.riverY + 0.4, sp.impact.z), { count: 22, color: "#ffffff", size: [0.8, 1.8], opacity: 0.75, rise: 0.8, drift: 0.8, spread: [0.8, 0.2, W.gap.hw * 0.8], life: 2, lit: true, power: 1.1 })); }
  // river ribbon: rocks get foam collars
  const rr = R.riverRocks;
  // foam collar round every rock that breaks the surface (thin: 0.9 m), fading where the rock is under water
  const riverFoam = (x: number, z: number) => { let f = 0; for (const b of rr) { const d = Math.hypot(x - b.x, z - b.z) - b.sx * 0.95; if (d < 0.9) f = Math.max(f, 0.85 * (1 - d / 0.9)); } return f; };
  // the river: clear turquoise over a visible sandy bed (bed mode: absorption + caustics), a blue channel down the middle
  // (deepen), crisp foam rings + wakes round every rock (baked distance field), chunked so off-screen reaches cull
  const box: [number, number, number, number] = [-130, -452, 400, 140];
  // the ring hugs each rock's real waterline (cross-section of its hi-LOD mesh at the river level there)
  const protos = rockProtos("boulder", 5, RIVER_ROCK_RES[0]);
  const rockDist = bakeRockDist(rr, box, 1536, 540, { geo: (r) => protos[(r.seed ?? 0) % protos.length], level: (x, z) => riverLevelAt(R, x, z) });
  const rMat = waterMaterial({ ground, fade: true, clarity: 1.15, lace: 0.9, foamScale: 0.9, alpha0: 0.25, glow: 0.5, env: 0.65, bed: { map: sandSet, tint: [1.0, 1.0, 1.02], scale: 3.2 }, sigma: [4.2, 0.62, 0.42], scatter: "#00829c", caustics: 1.8, rocks: flag("jdbgNoRocks") ? undefined : { tex: rockDist, box } });
  const gnd = (x: number, z: number) => Math.max(h(x, z), barHeight(R, x, z));
  // the ribbon (a) starts UNDER the weir (not 5 m
  // downstream of it, a straight cut standing 1.7 m over the outlet's sand); (b) ends AT sea level and hands over to the
  // sea along the sea's own waterline (jungle-water W_FADE × W_GROUND) — resolving its last reach to bed + 1.25 on a −2.2 m
  // bed puts it 1.15 m BELOW the sea: a slab under / beside the lagoon with a jagged rim and dry land between; (c) is 2 m
  // wider each side with soft lateral edges, so no bank beyond it shows a mid-air cut
  const rPts: Array<[number, number]> = [[FALLS.weir.x - 2.5, FALLS.river[0][1] - 0.1], ...FALLS.river];
  const rLev = [R.riverLevel[0], ...R.riverLevel.map((l) => Math.max(l, WORLD.SEA_LEVEL))];
  rLev[rLev.length - 1] = WORLD.SEA_LEVEL;
  const rHw = [R.riverHalfW[0], ...R.riverHalfW].map((w) => w + 5);
  root.add(riverSurface(rPts, rLev, rHw, gnd, rMat, { across: 32, step: 1.4, speed: () => 0.9, foamAt: (x, z) => riverFoam(x, z) * 0.35, rapids: 0.35, deepen: true, chunk: 42, fadeEnds: [0, 4] }));
  // rainbow: in the mist between the lookout and the big fall, low and partial
  // the rainbow: a crisp arc standing in the mist in front of the falls (normal blend,
  // saturated bands, both feet fading into the spray) — always facing the viewer
  const a = impacts[0]; void rainbow; root.add(fallsRainbow(a.x + 13, lvl - 0.5, a.z - 3, 34));
}

let _rb: THREE.CanvasTexture | null = null;
function fallsRainbow(x: number, y: number, z: number, width: number): THREE.Mesh {
  _rb ??= (() => { const c = document.createElement("canvas"); c.width = 1024; c.height = 512; const g = c.getContext("2d")!;
    const cx = 512, cy = 512, R = 470, bw = 13, bands = ["#ff2a1e", "#ff7a14", "#ffd81e", "#3fd447", "#1fa6ff", "#3b4cff", "#8a3cff"];
    g.filter = "blur(4px)"; bands.forEach((col, i) => { g.strokeStyle = col; g.globalAlpha = 0.85; g.lineWidth = bw * 1.25; g.beginPath(); g.arc(cx, cy, R - i * bw, Math.PI * 1.02, Math.PI * 1.98); g.stroke(); }); g.filter = "none";
    g.globalCompositeOperation = "destination-in";
    const lg = g.createLinearGradient(0, 0, 1024, 0); lg.addColorStop(0, "rgba(0,0,0,0)"); lg.addColorStop(0.16, "rgba(0,0,0,0.85)"); lg.addColorStop(0.5, "rgba(0,0,0,1)"); lg.addColorStop(0.84, "rgba(0,0,0,0.7)"); lg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = lg; g.fillRect(0, 0, 1024, 512);
    const vg = g.createLinearGradient(0, 0, 0, 512); vg.addColorStop(0, "rgba(0,0,0,0.75)"); vg.addColorStop(0.7, "rgba(0,0,0,1)"); vg.addColorStop(0.92, "rgba(0,0,0,0.55)"); vg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = vg; g.fillRect(0, 0, 1024, 512);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; })();
  const m = new THREE.MeshBasicMaterial({ map: _rb, transparent: true, depthWrite: false, opacity: 0.62, side: THREE.DoubleSide, fog: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 2).translate(0, width / 4, 0), m);
  mesh.position.set(x, y, z); mesh.name = "falls-rainbow-mist"; mesh.renderOrder = 6; mesh.userData.castShadow = false;
  // a glimmer in the mist, not a sticker: soft (0.42, not 0.62) and it melts away as you come close (a camera-facing
  // card 20 m from the player reads as a hard, fully saturated arc pasted over the falls)
  mesh.onBeforeRender = (_r, _s, cam) => { const dx = cam.position.x - x, dz = cam.position.z - z, d = Math.hypot(dx, dz), k = Math.min(1, Math.max(0, (d - 16) / 30));
    m.opacity = 0.42 * k * k * (3 - 2 * k); mesh.rotation.y = Math.atan2(dx, dz); mesh.updateMatrixWorld(); };
  return mesh;
}

/** river rocks' LOD resolutions (hi / mid / far) — the water's foam-ring bake uses the hi mesh's waterline */
export const RIVER_ROCK_RES: [number, number, number] = [18, 9, 5];
/** river water level at (x, z): the nearest centreline segment's level, interpolated along it */
export function riverLevelAt(R: FallsResolved, x: number, z: number): number {
  let best = Infinity, lv = R.riverLevel[0];
  for (let i = 0; i + 1 < FALLS.river.length; i++) {
    const [ax, az] = FALLS.river[i], [bx, bz] = FALLS.river[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
    const d = Math.hypot(x - ax - dx * t, z - az - dz * t); if (d < best) { best = d; lv = R.riverLevel[i] + (R.riverLevel[i + 1] - R.riverLevel[i]) * t; }
  }
  return lv;
}

/** bar height at (x, z) from the baked sandbar grids (−∞ outside) */
export function barHeight(R: FallsResolved, x: number, z: number): number {
  let best = -Infinity;
  for (const b of R.bars ?? []) { const fi = (x - b.x0) / b.step, fj = (z - b.z0) / b.step, i = Math.floor(fi), j = Math.floor(fj); if (i < 0 || j < 0 || i >= b.nx - 1 || j >= b.nz - 1) continue;
    const q = [b.h[j * b.nx + i], b.h[j * b.nx + i + 1], b.h[(j + 1) * b.nx + i], b.h[(j + 1) * b.nx + i + 1]]; if (q.some((v) => v === null)) continue;
    const u = fi - i, v = fj - j; best = Math.max(best, ((q[0] as number) * (1 - u) + (q[1] as number) * u) * (1 - v) + ((q[2] as number) * (1 - u) + (q[3] as number) * u) * v); }
  return best;
}

/** sand: pool bed + river bed (under the water) + cream sandbars (on the terrain's 2 m grid, same diagonals → never
 *  z-fights) + the sandbar MOUNDS (their own 1 m grids, standing proud of the bed at the waterline). Coverage is computed
 *  PER FRAGMENT from the patch shapes (noise-perturbed ellipses, feathered, clipped by height + slope) — no grid-stepped
 *  edges; the mounds fade out where they sink into the bank. Opaque, alpha-tested. */
export function buildSand(ctx: WorldCtx, root: THREE.Group, R: FallsResolved) {
  const t = ctx.terrain, CELL = WORLD.CELL, HALF = WORLD.HALF;
  const sand = pbr(ctx, "sand2");
  const patches: Array<{ cx: number; cz: number; rx: number; rz: number; yaw: number; maxY: number; bar: boolean }> = [];
  const P = FALLS.pool;
  patches.push({ cx: P.x, cz: P.z, rx: P.rx + 2, rz: P.rz + 2, yaw: 0, maxY: P.level + 0.3, bar: false });
  FALLS.river.forEach(([x, z], i) => { if (i > 12) return; patches.push({ cx: x, cz: z, rx: R.riverHalfW[i] + 3, rz: R.riverHalfW[i] + 3, yaw: 0, maxY: R.riverLevel[i] + 0.3, bar: false }); });
  for (const [x, z, rx, rz, yaw] of FALLS.sandbars) patches.push({ cx: x, cz: z, rx, rz, yaw, maxY: 1e4, bar: true });
  const N = patches.length;
  const uP = patches.map((q) => new THREE.Vector4(q.cx, q.cz, 1 / q.rx, 1 / q.rz)), uQ = patches.map((q) => new THREE.Vector4(Math.cos(q.yaw), Math.sin(q.yaw), q.maxY, q.bar ? 1 : 0));
  const mk = (mound: boolean) => {
    const mat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.95, vertexColors: true, alphaTest: 0.5, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
    // the terrain-grid sand relies on its custom per-fragment ellipse mask (and deepUnder cuts out the channel center),
    // so baking it without that shader turns the river valley into a jagged white ribbon with a dark hole down the middle
    if (!mound) mat.userData.farSkip = true;
    mat.color.setRGB(1.0, 0.98, 0.95);   // the island's cream beach sand (warm cream sandbars)
    sand.then((s) => { mat.map = s.map; mat.normalMap = s.normalMap; mat.roughnessMap = s.roughnessMap; mat.normalScale.setScalar(0.7); mat.map.repeat.set(1 / 4.6, 1 / 4.6); mat.needsUpdate = true; });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uSP = { value: uP }; sh.uniforms.uSQ = { value: uQ };
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vSdW; varying vec3 vSdN;").replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n vSdW = (modelMatrix * vec4(transformed, 1.0)).xyz; vSdN = normalize(mat3(modelMatrix) * objectNormal);");
      sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
        varying vec3 vSdW; varying vec3 vSdN; uniform vec4 uSP[${N}]; uniform vec4 uSQ[${N}];
        float sdN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); float a = fract(sin(dot(i, vec2(127.1,311.7)))*43758.5), b = fract(sin(dot(i+vec2(1,0), vec2(127.1,311.7)))*43758.5), c = fract(sin(dot(i+vec2(0,1), vec2(127.1,311.7)))*43758.5), d = fract(sin(dot(i+vec2(1,1), vec2(127.1,311.7)))*43758.5); return mix(mix(a,b,f.x), mix(c,d,f.x), f.y); }`)
        .replace("#include <alphatest_fragment>", `{
          ${mound ? "float cov = diffuseColor.a;" : `float cov = 0.0; float slope = length(vSdN.xz) / max(0.2, vSdN.y);
          float nz = (sdN(vSdW.xz * 0.11) - 0.5) * 0.42 + (sdN(vSdW.xz * 0.37 + 7.0) - 0.5) * 0.16 + (sdN(vSdW.xz * 1.3 + 3.0) - 0.5) * 0.05;
          for (int i = 0; i < ${N}; i++) {
            vec2 d = vSdW.xz - uSP[i].xy; vec2 l = vec2(d.x * uSQ[i].x + d.y * uSQ[i].y, -d.x * uSQ[i].y + d.y * uSQ[i].x) * uSP[i].zw;
            float c = 1.0 - smoothstep(0.66, 1.0, length(l) + nz);
            c *= 1.0 - smoothstep(uSQ[i].z, uSQ[i].z + 0.55, vSdW.y);
            if (uSQ[i].w > 0.5) c *= 1.0 - smoothstep(0.3, 0.52, slope);
            cov = max(cov, c);
          }`}
          diffuseColor.a = smoothstep(0.0, 1.0, cov * 1.6 - 0.3 + (sdN(vSdW.xz * 0.9) - 0.5) * 0.25);
          diffuseColor.rgb *= mix(0.86, 1.0, smoothstep(0.2, 0.8, cov));
        }
        #include <alphatest_fragment>`);
    };
    mat.customProgramCacheKey = () => `jungle-sand-v3|${mound ? 1 : 0}|${N}`;
    return mat;
  };
  // the terrain-grid sand (bed + banks): every cell within any patch's reach
  const cells = new Set<number>(), key = (i: number, j: number) => i * 4096 + j;
  for (const pt of patches) { const R0 = Math.max(pt.rx, pt.rz) * 1.25 + 2;
    const j0 = Math.floor((pt.cx - R0 + HALF) / CELL), j1 = Math.ceil((pt.cx + R0 + HALF) / CELL), i0 = Math.floor((pt.cz - R0 + HALF) / CELL), i1 = Math.ceil((pt.cz + R0 + HALF) / CELL);
    for (let i = i0; i < i1; i++) for (let j = j0; j < j1; j++) { const x = -HALF + j * CELL, z = -HALF + i * CELL; if (t.height(x, z) > pt.maxY + 0.7) continue; cells.add(key(i, j)); } }
  // the pool and the river draw their sandy bed INSIDE the water
  // (bed mode: opaque wherever the water is ≥ 0.2 m deep), so the sand cells deep under them were shaded for nothing — an
  // alpha-tested layer with a per-pixel patch loop under the whole river / pool, 0.77 ms at 5K at the river bridge. A cell
  // goes only when all 4 corners lie ≥ 0.45 m under the surface, well inside the pool ellipse or the ribbon's opaque core
  // (≤ 0.7 half-width from the centreline, away from the ribbon's faded ends); the banks / shallows keep every cell.
  const deepUnder = (x: number, z: number) => {
    const g = t.height(x, z);
    if (((x - (P.x - 1)) / (P.rx - 3)) ** 2 + ((z - P.z) / (P.rz + 2)) ** 2 < 1 && x < FALLS.weir.x - 2 && g < P.level - 0.45) return true;
    for (let i = 1; i + 1 < FALLS.river.length && i < 10; i++) {
      const [ax, az] = FALLS.river[i], [bx, bz] = FALLS.river[i + 1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
      if (Math.hypot(x - ax - dx * u, z - az - dz * u) < Math.min(R.riverHalfW[i], R.riverHalfW[i + 1]) * 0.7 && g < riverLevelAt(R, x, z) - 0.45) return true;
    }
    return false;
  };
  { const pos: number[] = [], col: number[] = [], uv: number[] = [], idx: number[] = [], vid = new Map<number, number>();
    const vert = (i: number, j: number) => { const k = key(i, j); let v = vid.get(k); if (v !== undefined) return v; const x = -HALF + j * CELL, z = -HALF + i * CELL; v = pos.length / 3; pos.push(x, t.height(x, z) + 0.035, z); col.push(1, 1, 1, 1); uv.push(x, z); vid.set(k, v); return v; };
    const under = (i: number, j: number) => deepUnder(-HALF + j * CELL, -HALF + i * CELL);
    let culled = 0;
    for (const k of cells) { const i = Math.floor(k / 4096), j = k % 4096;
      if (under(i, j) && under(i, j + 1) && under(i + 1, j) && under(i + 1, j + 1)) { culled++; continue; }
      const a00 = vert(i, j), a01 = vert(i, j + 1), a10 = vert(i + 1, j), a11 = vert(i + 1, j + 1);
      if (((i + j) & 1) === 0) idx.push(a00, a11, a01, a00, a10, a11); else idx.push(a00, a10, a01, a01, a10, a11); }
    root.add(sandMesh(pos, col, uv, idx, mk(false), "jungle-sand"));
    (globalThis as { __krSandCull?: unknown }).__krSandCull = { cells: cells.size, culled }; }
  // the mounds (1 m grids): vertex alpha = how far the sand stands proud of the bank (it dissolves where it sinks in)
  const mm = mk(true);
  for (const b of R.bars ?? []) {
    const pos: number[] = [], col: number[] = [], uv: number[] = [], idx: number[] = [], vid = new Map<number, number>();
    const vert = (i: number, j: number) => { const k = j * b.nx + i; let v = vid.get(k); if (v !== undefined) return v; const x = b.x0 + i * b.step, z = b.z0 + j * b.step, y = b.h[k] as number, th = t.height(x, z); v = pos.length / 3; pos.push(x, Math.max(y, th - 0.3) + 0.03, z); const a = Math.min(1, Math.max(0, (y - th + 0.05) / 0.3)); col.push(1, 0.99, 0.96, a); uv.push(x, z); vid.set(k, v); return v; };
    for (let j = 0; j + 1 < b.nz; j++) for (let i = 0; i + 1 < b.nx; i++) {
      if ([b.h[j * b.nx + i], b.h[j * b.nx + i + 1], b.h[(j + 1) * b.nx + i], b.h[(j + 1) * b.nx + i + 1]].some((v) => v === null)) continue;
      const a00 = vert(i, j), a01 = vert(i + 1, j), a10 = vert(i, j + 1), a11 = vert(i + 1, j + 1); idx.push(a00, a10, a01, a01, a10, a11);
    }
    if (idx.length) root.add(sandMesh(pos, col, uv, idx, mm, "jungle-sandbar"));
  }
}
function sandMesh(pos: number[], col: number[], uv: number[], idx: number[], mat: THREE.Material, name: string): THREE.Mesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 4)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  const nrm = g.attributes.normal as THREE.BufferAttribute; let up = 0; for (let i = 0; i < nrm.count; i++) up += nrm.getY(i);
  if (up < 0) { const ix = g.index!.array as Uint32Array; for (let q = 0; q < ix.length; q += 3) { const sw = ix[q + 1]; ix[q + 1] = ix[q + 2]; ix[q + 2] = sw; } g.computeVertexNormals(); }
  const m = new THREE.Mesh(g, mat); m.name = name; m.receiveShadow = true; m.castShadow = false; m.userData.castShadow = false; m.userData.farShadow = false; m.matrixAutoUpdate = false; m.updateMatrix();
  return m;
}
