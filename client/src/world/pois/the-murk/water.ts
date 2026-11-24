// THE MURK water: the swamp's own surface (tea-coloured, still, glossy) at WATER_Y over the swamp bed, easing down to
// the sea level where the swamp meets the deep NE lagoon (so it hands over to the water area's lagoon without a step).
// A 2 m grid mesh; per vertex: the surface height and the water column (depth) → colour + opacity in the shader;
// triangles above the bed are dropped. Normals: animated ripples (analytic, no textures). Lily pads: one instanced mesh.
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import type { Scope } from "../../../engine/res/scope";
import { releaseAfterUpload } from "../../../engine/texture-release";
import { murkSurface, shelfTop, shelfCells, groundAt, SURF, LAYOUT, GM, gmRadius, CX, CZ } from "../../../../../shared/pois/the-murk";
import { canvasTex } from "./fx";
import { SceneGrab } from "../../water/grab";
import { flag } from "../../../flags";

const { x0: X0, x1: X1, z0: Z0, z1: Z1, step: STEP } = SURF;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const _mkVP = new THREE.Matrix4();
const _mkFrustum = new THREE.Frustum();

export interface MurkWater { mesh: THREE.Mesh; shelf: THREE.Mesh; haze: THREE.Mesh | null; levelAt(x: number, z: number): number; uniforms: { uTime: { value: number }; uDbg: { value: number } }; update(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void }

/** canopy cover 0..1 at (x, z): the swamp water under the crowns reflects the dark canopy, not the open sky */
export type CoverFn = (x: number, z: number) => number;
/** the reflection map (1 m texels over SURF + a 24 m margin): R = canopy cover (the leaf ceiling the tea mirrors, with
 *  its sun gaps), G = height / 32 of the solid things standing in the water (huts, trunks, the hero, walks + rails), so
 *  the shader can march the reflected ray and mirror them — a planar reflection's read without a second scene render */
const RM = { x0: SURF.x0 - 24, z0: SURF.z0 - 24, w: SURF.x1 - SURF.x0 + 48, h: SURF.z1 - SURF.z0 + 48 };
function reflMap(cover: CoverFn, scope: Scope): THREE.DataTexture {
  const fill = () => {
    const W = RM.w, Hh = RM.h, d = new Uint8Array(W * Hh * 4);
    for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) { const k = (j * W + i) * 4; d[k] = Math.round(255 * cover(RM.x0 + i + 0.5, RM.z0 + j + 0.5)); d[k + 3] = 255; }
    const put = (x: number, z: number, hgt: number) => {
      const i = Math.floor(x - RM.x0), j = Math.floor(z - RM.z0);
      if (i < 0 || j < 0 || i >= W || j >= Hh) return;
      const k = (j * W + i) * 4 + 1; d[k] = Math.max(d[k], Math.min(255, Math.round(hgt / 32 * 255)));
    };
    const rect = (cx: number, cz: number, yaw: number, hw: number, hd: number, hgt: number) => {
      const c = Math.cos(yaw), sn = Math.sin(yaw), R = Math.hypot(hw, hd) + 1;
      for (let z = Math.floor(cz - R); z <= cz + R; z++) for (let x = Math.floor(cx - R); x <= cx + R; x++) {
        const dx = x + 0.5 - cx, dz = z + 0.5 - cz, lx = dx * c - dz * sn, lz = dx * sn + dz * c;
        if (Math.abs(lx) <= hw + 0.35 && Math.abs(lz) <= hd + 0.35) put(x + 0.5, z + 0.5, hgt);
      }
    };
    const disc = (cx: number, cz: number, r: number, hgt: number) => { for (let z = Math.floor(cz - r - 1); z <= cz + r + 1; z++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) if (Math.hypot(x + 0.5 - cx, z + 0.5 - cz) <= r + 0.5) put(x + 0.5, z + 0.5, hgt); };
    for (const k of LAYOUT.decks) rect(k.x, k.z, k.yaw, k.w / 2, k.d / 2, k.y + 0.95);
    for (const p of LAYOUT.parts) rect(p.h.x, p.h.z, p.h.yaw, p.h.w / 2 + p.h.overhang * 0.5, p.h.d / 2 + p.h.overhang * 0.5, p.ridgeY);
    for (const t of LAYOUT.trees) disc(t.x, t.z, 0.6 * t.s + 0.2, t.top[1]);
    for (const r of LAYOUT.roots) if (r.kind === "trunk") { const e = r.pts[r.pts.length - 1]; disc(e[0], e[2], r.r0, e[1]); }
    disc(GM.x, GM.z, gmRadius(2), 8); disc(GM.x, GM.z, gmRadius(10), 24);
    return { data: d, width: W, height: Hh };
  };
  const t = scope.texture("tex.world", new THREE.DataTexture(fill().data, RM.w, RM.h, THREE.RGBAFormat));
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return releaseAfterUpload(t, fill);
}

/** the swamp bed seen through the tea: silt with sunk leaf litter, twigs, seed pods and sand ripples (tiles every 3.2 m;
 *  ×2 albedo — the vertex colour carries the large-scale value) */
function siltTexture(scope: Scope): THREE.CanvasTexture {
  const S = 512, t = canvasTex(scope, S, S, (g) => {
    let seed = 0x51a7; const r = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    g.fillStyle = "#807058"; g.fillRect(0, 0, S, S);
    let wx = 0, wy = 0, wr = 0;
    const at = (x: number, y: number, rr: number) => { wx = x; wy = y; wr = rr; };
    const W = (f: (ox: number, oy: number) => void) => { for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { if (wx + ox + wr < 0 || wx + ox - wr > S || wy + oy + wr < 0 || wy + oy - wr > S) continue; f(ox, oy); } };
    for (let k = 0; k < 260; k++) { const x = r() * S, y = r() * S, rr = 10 + r() * 40, l = 34 + r() * 22; at(x, y, rr);
      W((ox, oy) => { const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rr); gr.addColorStop(0, `hsla(${32 + r() * 18},${22 + r() * 14}%,${l}%,0.35)`); gr.addColorStop(1, "hsla(35,20%,40%,0)"); g.fillStyle = gr; g.fillRect(x + ox - rr, y + oy - rr, 2 * rr, 2 * rr); }); }
    g.lineWidth = 3;
    for (let k = 0; k < 40; k++) { const y = r() * S, x = r() * S, len = 60 + r() * 120; at(x + len / 2, y, len / 2 + 12);
      W((ox, oy) => { g.strokeStyle = "rgba(160,140,100,0.18)"; g.beginPath(); g.moveTo(x + ox, y + oy); g.quadraticCurveTo(x + ox + len / 2, y + oy - 8 + r() * 16, x + ox + len, y + oy + (r() - 0.5) * 10); g.stroke(); }); }
    for (let k = 0; k < 150; k++) { const x = r() * S, y = r() * S, a = r() * 6.283, L = 9 + r() * 16, hue = [24, 32, 40, 60][Math.floor(r() * 4)], lt = 22 + r() * 22; at(x, y, L * 1.3);
      W((ox, oy) => { g.save(); g.translate(x + ox, y + oy); g.rotate(a); g.fillStyle = `hsla(${hue},${40 + r() * 20}%,${lt}%,0.85)`; g.beginPath(); g.ellipse(0, 0, L, L * 0.38, 0, 0, 6.283); g.fill();
        g.strokeStyle = `hsla(${hue},30%,${lt + 14}%,0.6)`; g.lineWidth = 1; g.beginPath(); g.moveTo(-L, 0); g.lineTo(L * 1.2, 0); g.stroke(); g.restore(); }); }
    for (let k = 0; k < 28; k++) { const x = r() * S, y = r() * S, a = r() * 6.283, L = 20 + r() * 50; at(x, y, L + 4);
      W((ox, oy) => { g.strokeStyle = `rgba(${50 + r() * 20},${38 + r() * 14},${24},0.8)`; g.lineWidth = 2 + r() * 2; g.beginPath(); g.moveTo(x + ox, y + oy); g.lineTo(x + ox + Math.cos(a) * L, y + oy + Math.sin(a) * L); g.stroke(); }); }
    for (let k = 0; k < 90; k++) { const x = r() * S, y = r() * S; at(x, y, 5); W((ox, oy) => { g.fillStyle = `rgba(40,32,20,${0.4 + r() * 0.4})`; g.beginPath(); g.arc(x + ox, y + oy, 1.5 + r() * 2.5, 0, 6.283); g.fill(); }); }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** the staged view light (stage.ts) carries its own warm fog: the swamp haze is thinned under it */
let hazeScale = 1;
export function setMurkHaze(k: number) { hazeScale = k; }

export function buildWater(ctx: WorldCtx, cover: CoverFn = () => 0, scope: Scope): MurkWater {
  const mwScope = scope.child("water");
  const nx = Math.round((X1 - X0) / STEP) + 1, nz = Math.round((Z1 - Z0) / STEP) + 1;
  const H = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) H[j * nx + i] = ctx.terrain.height(X0 + i * STEP, Z0 + j * STEP);
  // the surface + the silt shelf come from the shared layout (the sim walks the same shelf): depth ≤ MAX_DEPTH everywhere
  const Lv = new Float32Array(nx * nz), Bd = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, x = X0 + i * STEP, z = Z0 + j * STEP;
    Lv[k] = murkSurface(x, z); Bd[k] = Math.max(H[k], shelfTop(x, z));
  }
  const pos: number[] = [], dep: number[] = [], idx: number[] = [];
  const map = new Int32Array(nx * nz).fill(-1);
  const vert = (i: number, j: number) => {
    const k = j * nx + i;
    if (map[k] >= 0) return map[k];
    map[k] = pos.length / 3;
    pos.push(X0 + i * STEP, Lv[k], Z0 + j * STEP);
    // the lagoon hand-over fades the swamp surface out as its level nears the sea (the lagoon water shows there)
    const edge = Math.min(i, j, nx - 1 - i, nz - 1 - j) * STEP;
    dep.push(Lv[k] - Bd[k], smooth(0.1, 0.32, Lv[k]) * smooth(0, 5, edge), cover(X0 + i * STEP, Z0 + j * STEP));
    return map[k];
  };
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const ks = [j * nx + i, j * nx + i + 1, (j + 1) * nx + i, (j + 1) * nx + i + 1];
    if (ks.every((k) => Lv[k] - H[k] < -0.05)) continue;
    if (ks.every((k) => Lv[k] < 0.1)) continue;
    const a = vert(i, j), b = vert(i + 1, j), c = vert(i, j + 1), d = vert(i + 1, j + 1);
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aMurk", new THREE.Float32BufferAttribute(dep, 3));
  const nor = new Float32Array(pos.length); for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.setIndex(idx);
  g.computeBoundingBox();
  if (g.boundingBox) { g.boundingBox.min.y -= 0.25; g.boundingBox.max.y += 0.25; }
  g.computeBoundingSphere();

  const dbg = flag("murkdbg");
  const uniforms = { uTime: { value: 0 }, uDbg: { value: dbg } };
  // SCENE GRAB: share global water's SceneGrab when available so the GPU never allocates or blits two full-screen
  // HDR + depth copies in the same frame; fall back to a dedicated grab only if water hasn't published one.
  const sharedGrab = ctx.shared.get("waterGrab") as SceneGrab | undefined;
  const grab = ctx.quality !== "low" && !flag("murknoscene") ? (sharedGrab ?? new SceneGrab(mwScope)) : null;
  if (grab && !sharedGrab) grab.colour = true;
  const uMk = {
    uMkCol: { value: null as THREE.Texture | null }, uMkDepth: { value: null as THREE.Texture | null },
    uMkGrab: { value: new THREE.Vector4(1, 1, 0, 0) }, uMkNF: { value: new THREE.Vector2(0.1, 1000) }, uMkProj: { value: new THREE.Matrix4() },
  };
  const uRefl = { value: reflMap(cover, mwScope) }, uReflBox = { value: new THREE.Vector4(RM.x0, RM.z0, 1 / RM.w, 1 / RM.h) };
  // TRANSLUCENT tea: the bed, the piles, roots and a wading kong's legs show through the shallows (opacity follows the
  // water column, ≤ MAX_DEPTH deep), and the surface turns into a mirror toward grazing angles (Fresnel → alpha).
  // The silt shelf under it is opaque and drawn first (it depth-rejects the terrain / sea beneath the pools).
  const mat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.1, metalness: 0, transparent: true, depthWrite: true, envMapIntensity: 1.0, name: "murk:water" });
  const mkSsrSteps = ctx.quality === "ultra" ? 12 : ctx.quality === "high" ? 9 : 6;
  const mkSsrGrow = ctx.quality === "ultra" ? "1.5" : "1.75";
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uMurkTime = uniforms.uTime;
    sh.uniforms.uMurkDbg = uniforms.uDbg;
    sh.uniforms.uMurkRefl = uRefl; sh.uniforms.uMurkReflBox = uReflBox;
    Object.assign(sh.uniforms, uMk);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec3 aMurk;\nvarying vec3 vMurk;\nvarying vec3 vMurkW;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvMurk = aMurk;\nvMurkW = (modelMatrix * vec4(transformed, 1.0)).xyz;")
      // shadow lookup 0.8 m above the surface: hummocks just under the water no longer shade whole shadow texels of it
      // (the canopy, 10 m+ up, still does)
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n#if defined( USE_SHADOWMAP ) || defined( USE_ENVMAP )\n  worldPosition.y += 0.8;\n#endif");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec3 vMurk;
varying vec3 vMurkW;
uniform float uMurkTime;
uniform float uMurkDbg;
uniform sampler2D uMurkRefl;
uniform vec4 uMurkReflBox;
uniform sampler2D uMkCol;
uniform sampler2D uMkDepth;
uniform vec4 uMkGrab;   // 1/width, 1/height, depth valid, linear colour valid
uniform vec2 uMkNF;
uniform mat4 uMkProj;
vec3 mkNW = vec3(0.0, 1.0, 0.0);
float mkViewZ(float d) { float n = uMkNF.x, f = uMkNF.y; return (2.0 * n * f) / ((f + n) - (d * 2.0 - 1.0) * (f - n)); }
// world height of the opaque surface seen at screen uv (from the grabbed depth; TAA jitter included via uMkProj)
float mkWY(vec2 uv, float z) {
  vec2 ndc = uv * 2.0 - 1.0;
  vec3 vp = vec3(z * (ndc.x + uMkProj[2][0]) / uMkProj[0][0], z * (ndc.y + uMkProj[2][1]) / uMkProj[1][1], -z);
  return cameraPosition.y + (transpose(mat3(viewMatrix)) * vp).y;
}
vec2 mkUv(vec4 c) { return clamp(c.xy / max(c.w, 1e-4) * 0.5 + 0.5, 0.0, 1.0); }
vec4 mkSSR(vec3 P, vec3 R, float dist) {
  if (uMkGrab.w < 0.5 || R.y < 0.002) return vec4(0.0);
  vec4 cp0 = uMkProj * (viewMatrix * vec4(P, 1.0)), cpDir = uMkProj * (viewMatrix * vec4(R, 0.0));
  float t0 = 0.0, st = 0.15 + dist * 0.01, hit = 0.0;
  // the first sample where the ray ran BEHIND a thin object (a hull, a pile) beyond the thickness tolerance: a miss
  // that passed under something reflects that thing's shaded side, never the bright sky (no white streaks under boats)
  vec2 huv = vec2(0.0), ouv = vec2(-1.0);
  for (int i = 0; i < ${mkSsrSteps}; i++) {
    float t1 = t0 + st;
    vec4 c = cp0 + cpDir * t1;
    if (c.w <= 0.0) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float sz = mkViewZ(texture2D(uMkDepth, uv).r), dz = c.w - sz;
    // (things floating AT the surface — lily pads, leaves, the tea itself — are never mirror hits: their image lies
    // hidden under themselves; a ray passing over them marches on)
    bool floating = mkWY(uv, sz) < P.y + 0.08;
    if (dz > 0.0 && dz < 3.0 && ouv.x < 0.0 && (R.y * t1) < 2.5 && !floating) ouv = uv;
    if (dz > 0.0 && dz < st * 2.0 + 0.4 && !floating) {
      float ta = t0, tb = t1;
      for (int k = 0; k < 3; k++) {
        float tm = 0.5 * (ta + tb);
        if ((cp0.w + cpDir.w * tm) > mkViewZ(texture2D(uMkDepth, mkUv(cp0 + cpDir * tm)).r)) tb = tm; else ta = tm;
      }
      huv = mkUv(cp0 + cpDir * tb);
      hit = 1.0; break;
    }
    t0 = t1; st *= ${mkSsrGrow};
  }
  if (hit <= 0.0) return ouv.x >= 0.0 ? vec4(texture2D(uMkCol, ouv).rgb * 0.45, 1.0) : vec4(0.0);
  vec2 e = smoothstep(vec2(0.0), vec2(0.08), huv) * (1.0 - smoothstep(vec2(0.92), vec2(1.0), huv));
  return vec4(texture2D(uMkCol, huv).rgb, hit * e.x * e.y);
}
vec4 mkMap(vec2 q) { return texture2D(uMurkRefl, (q - uMurkReflBox.xy) * uMurkReflBox.zw); }
// the mirrored scene: march the reflected ray through the solid-height map (huts, trunks, walks), else the canopy it
// reaches at ~13 m (dark leaf ceiling / bright sun gaps = the sky radiance), toward the horizon the far treeline
vec3 mkReflect(vec3 P, vec3 V, vec3 N, vec3 sky) {
  // the mirror sees a gently rippled surface (the full ripple normal shatters it into blobs)
  vec3 R = reflect(-V, normalize(mix(vec3(0.0, 1.0, 0.0), N, 0.2))); R.y = max(R.y, 0.015);
  vec3 wood = vec3(0.045, 0.03, 0.018), leaf = vec3(0.03, 0.05, 0.016), line = vec3(0.028, 0.04, 0.018);
  const float HS[4] = float[4](1.3, 2.8, 5.0, 9.0);
  for (int i = 0; i < 4; i++) {
    float t = (HS[i] - P.y) / R.y;
    if (t * length(R.xz) > 70.0) break;
    vec4 m = mkMap(P.xz + R.xz * t);
    if (m.g * 32.0 > HS[i]) return wood * (0.8 + 0.4 * m.r);
  }
  float tc = (13.0 - P.y) / R.y; vec4 mc = mkMap(P.xz + R.xz * tc);
  vec3 c = mix(max(sky, vec3(0.42, 0.48, 0.42)), leaf, smoothstep(0.35, 0.8, mc.r));
  return mix(c, line, smoothstep(0.3, 0.08, R.y) * 0.85);
}
float mkH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float mkN(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mkH(i), mkH(i + vec2(1, 0)), u.x), mix(mkH(i + vec2(0, 1)), mkH(i + vec2(1, 1)), u.x), u.y); }
float mkRip(vec2 p, float t) { return 0.0; }
// analytic ripples: 7 directional sine waves (smooth, exact gradient) — still swamp water, tiny amplitudes
vec2 mkGrad(vec2 p, float t) {
  vec2 g = vec2(0.0);
  const vec3 W[7] = vec3[7](vec3(0.83, 0.55, 1.7), vec3(-0.44, 0.9, 2.3), vec3(0.97, -0.25, 3.1), vec3(-0.71, -0.7, 4.3), vec3(0.2, 0.98, 5.9), vec3(0.6, -0.8, 7.7), vec3(-0.93, 0.36, 10.3));
  for (int k = 0; k < 7; k++) {
    vec2 d = W[k].xy; float f = W[k].z, a = 0.011 / (1.0 + float(k) * 0.45);
    float ph = dot(d, p) * f + t * (0.6 + float(k) * 0.23) + float(k) * 1.7;
    g += d * (a * f * cos(ph));
  }
  return g;
}`)
      .replace("#include <color_fragment>", `#include <color_fragment>
  float mkD = vMurk.x;
  // tea: amber-gold in the shallows (the bed shows through), deep strong-tea brown, a green film in patches
  // (with the scene composite this is the in-scatter colour of the tea body; the bed shows through by absorption)
  // (tea ABSORBS: a low in-scatter albedo — a bright body read as milky beige under the open sun from the aerial)
  vec3 mkShallow = vec3(0.4, 0.31, 0.12), mkDeep = vec3(0.24, 0.18, 0.07), mkFilm = vec3(0.19, 0.2, 0.08);
  float film = smoothstep(0.55, 0.8, mkN(vMurkW.xz * 0.06 + 3.0));
  vec3 mkC = mix(mkShallow, mkDeep, smoothstep(0.02, 0.65, mkD));
  mkC = mix(mkC, mkFilm, film * 0.45 * smoothstep(0.1, 0.4, mkD));
  // (under the canopy the tea glows amber — lit in-scatter of the green-gold light under the leaves, the intended
  // colour; in the open sun it stays the dark absorbing body)
  diffuseColor.rgb = mkC * (1.0 + 1.4 * vMurk.z);
  diffuseColor.a = smoothstep(0.0, 0.1, mkD) * mix(0.5, 0.93, smoothstep(0.03, 0.6, mkD)) * vMurk.y;`)
      .replace("#include <opaque_fragment>", `{
    // Fresnel: toward grazing angles the tea is a mirror (reflections carry the alpha, not the column)
    float mkF = pow(1.0 - saturate(dot(normal, geometryViewDir)), 5.0);
    diffuseColor.a = mix(diffuseColor.a, 1.0, mkF * 0.92 * vMurk.y * smoothstep(0.0, 0.1, vMurk.x));
  }
  #include <opaque_fragment>
  if (uMkGrab.z > 0.5 && uMkGrab.w > 0.5) {
    // COMPOSITE: what lies behind the surface (grabbed), absorbed along the view ray through the tea, + the tea's lit
    // in-scatter, + the reflections (totalSpecular carries the Fresnel-weighted mirror)
    vec2 suv = clamp(gl_FragCoord.xy * uMkGrab.xy, 0.0, 1.0);
    float wz = vViewPosition.z;
    float sz0 = mkViewZ(texture2D(uMkDepth, suv).r);
    float th0 = max(0.0, sz0 - wz);
    // refraction wobble from the RIPPLE only (the flat surface's own view-space normal is subtracted: the full normal
    // shifted the whole image ~40 px up-screen = a ghost copy of every lily pad / buoy / pile under itself)
    vec3 mkFlatV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    vec2 ruv = clamp(suv + (normal - mkFlatV).xy * 0.35 * min(th0, 0.8) / max(wz * 0.08, 1.0), 0.0, 1.0);
    float sz = mkViewZ(texture2D(uMkDepth, ruv).r);
    // never refract something that stands ABOVE the surface (a pad, a hull, a pile above the tea) into the water
    if (sz < wz || mkWY(ruv, sz) > vMurkW.y - 0.02) { ruv = suv; sz = sz0; }
    float path = max(0.0, sz - wz) * length(vViewPosition) / max(wz, 1e-3);
    // per-metre extinction: clear amber tea (blue goes first) — the bed, piles and roots read through ~0.7 m at eye level
    vec3 Tr = exp(-vec3(0.45, 0.7, 1.4) * path);
    vec3 behind = texture2D(uMkCol, ruv).rgb;
    float F = 0.02 + 0.98 * pow(1.0 - saturate(dot(normal, geometryViewDir)), 5.0);
    vec3 body = totalDiffuse;
    float edge = smoothstep(0.0, 0.07, path);
    vec3 col = (behind * Tr + body * (1.0 - Tr)) * (1.0 - F * edge) + totalSpecular * edge + totalEmissiveRadiance;
    gl_FragColor = vec4(col, vMurk.y);
  }`)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
  {
    vec2 g = mkGrad(vMurkW.xz, uMurkTime);
    // fade the fine ripples with distance (no shimmer far away)
    g *= 1.0 - smoothstep(25.0, 90.0, length(vMurkW - cameraPosition));
    vec3 nW = normalize(vec3(-g.x, 1.0, -g.y));
    if (uMurkDbg != 1.0) normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
    mkNW = uMurkDbg != 1.0 ? nW : vec3(0.0, 1.0, 0.0);
  }`)
      .replace("#include <lights_fragment_end>", "#include <lights_fragment_end>\n  reflectedLight.directDiffuse *= 1.0 - 0.8 * vMurk.z;\n  reflectedLight.directSpecular *= 1.0 - 0.9 * vMurk.z;")
      .replace("#include <lights_fragment_maps>", `#include <lights_fragment_maps>
  if (uMurkDbg == 2.0) { radiance = vec3(0.0); }
#if defined( RE_IndirectSpecular )
  if (uMurkDbg != 2.0) {
    vec3 mkV = normalize(cameraPosition - vMurkW);
    // (the analytic fallback — sky / leaf ceiling where the trace finds nothing — kept dimmer than the env: from the
    // aerial the open tea read as a milky mirror)
    radiance = mkReflect(vMurkW, mkV, mkNW, radiance) * vec3(0.6, 0.56, 0.46);
    // the real mirrored scene where the trace finds it (a gently rippled mirror: coherent images, a slight wobble)
    // (the trace only where the mirror carries weight — Fresnel ≥ ~6 %, view ≤ 30° over the surface; 9 steps ×1.75 + 3
    // refine: ~30 m reach. Looking down into the tea shows its body + the bed)
    vec4 ssr = mkV.y < 0.5 && uMurkDbg != 3.0 ? mkSSR(vMurkW + vec3(0.0, 0.02, 0.0), reflect(-mkV, normalize(mix(vec3(0.0, 1.0, 0.0), mkNW, 0.14))), length(cameraPosition - vMurkW)) : vec4(0.0);
    radiance = mix(radiance, ssr.rgb * vec3(0.92, 0.86, 0.72), ssr.a);
  }
  irradiance *= mix(1.0, 0.55, vMurk.z);
#endif`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n  roughnessFactor = mix(0.035, 0.26, smoothstep(0.55, 0.8, mkN(vMurkW.xz * 0.06 + 3.0))) + 0.2 * smoothstep(25.0, 140.0, length(vMurkW - cameraPosition));");
  };
  mat.customProgramCacheKey = () => "murk-water-10-" + ctx.quality;
  mwScope.geometry("geo.world", g);
  mwScope.material(mat);
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = "murk:water";
  // no shadow-map lookup on the tea (its coarse cascades stair-stepped from above): the canopy's shade is the smooth
  // per-vertex cover; the bed / shelf seen through it still takes the real shadows
  mesh.receiveShadow = mesh.castShadow = mesh.userData.farShadow = false;
  const bindGrab = (renderer: THREE.WebGLRenderer, camera: THREE.Camera, active: boolean) => {
    if (active) sharedGrab ? grab!.ensureCopied(renderer, 1, true) : grab!.copy(renderer);
    uMk.uMkCol.value = grab!.texture; uMk.uMkDepth.value = grab!.depth;
    uMk.uMkGrab.value.set(1 / grab!.size.x, 1 / grab!.size.y, active && grab!.depth ? 1 : 0, active && grab!.texture && !grab!.fromCanvas ? 1 : 0);
    uMk.uMkNF.value.set(ctx.camera.near, ctx.camera.far);
    uMk.uMkProj.value.copy(camera.projectionMatrix);
  };
  let murkNear = false;
  if (grab) {
    mesh.onBeforeRender = (renderer, _scene, camera) => {
      if (camera === ctx.camera) bindGrab(renderer, camera, murkNear);
    };
  }
  const levelAt = (x: number, z: number) => {
    const fi = Math.max(0, Math.min(nx - 1.001, (x - X0) / STEP)), fj = Math.max(0, Math.min(nz - 1.001, (z - Z0) / STEP));
    const i = Math.floor(fi), j = Math.floor(fj), u = fi - i, v = fj - j;
    return (Lv[j * nx + i] * (1 - u) + Lv[j * nx + i + 1] * u) * (1 - v) + (Lv[(j + 1) * nx + i] * (1 - u) + Lv[(j + 1) * nx + i + 1] * u) * v;
  };
  // ---- the silt shelf (shared shelfCells: the same cells + flat tops as the colliders), opaque, drawn first
  const sp: number[] = [], sc: number[] = [], si: number[] = [], su: number[] = [];
  const hash = (x: number, z: number) => { const h = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return h - Math.floor(h); };
  // (flat quads per cell at the collider's exact top; the cells share nothing, so no vertex welding)
  for (const [x, z, top] of shelfCells()) {
    const n = hash(Math.floor(x / 6), Math.floor(z / 6)) * 0.5 + hash(x, z) * 0.5, leaf = hash(Math.floor(x / 4) + 7, Math.floor(z / 4) - 3) > 0.7 ? 1 : 0;
    // olive-brown silt with leaf-litter patches (seen through the tea: it must read as a bed, not a black hole)
    const c = new THREE.Color().setRGB(0.95 + 0.4 * n - 0.12 * leaf, 0.92 + 0.38 * n + 0.04 * leaf, 0.9 + 0.36 * n - 0.15 * leaf);
    const b0 = sp.length / 3;
    for (const [dx, dz] of [[0, 0], [STEP, 0], [0, STEP], [STEP, STEP]]) { sp.push(x + dx, top, z + dz); sc.push(c.r, c.g, c.b); su.push((x + dx) / 3.2, (z + dz) / 3.2); }
    si.push(b0, b0 + 2, b0 + 1, b0 + 1, b0 + 2, b0 + 3);
  }
  // the shelf's STEP FACES: where a neighbouring cell sits lower (or there is none — the bed drops away), a
  // vertical silt face down to the neighbour's top / the collider's bottom (shelfBoxes) — otherwise the parity tool finds the
  // collider's sides with nothing drawn
  {
    const cells = shelfCells(), topAt = new Map<string, number>();
    for (const [x, z, top] of cells) topAt.set(`${Math.round(x)},${Math.round(z)}`, top);
    for (const [x, z, top] of cells) {
      const gmin = Math.min(groundAt(x, z), groundAt(x + STEP, z), groundAt(x, z + STEP), groundAt(x + STEP, z + STEP), groundAt(x + STEP / 2, z + STEP / 2));
      const bot = Math.min(gmin, top - 0.3) - 0.3;
      // edges: [neighbour dx, dz, edge a (x, z), edge b (x, z)] — wound so the face looks OUT of this cell
      for (const [nx, nz, ax, az, bx, bz] of [[-STEP, 0, x, z + STEP, x, z], [STEP, 0, x + STEP, z, x + STEP, z + STEP], [0, -STEP, x, z, x + STEP, z], [0, STEP, x + STEP, z + STEP, x, z + STEP]] as Array<[number, number, number, number, number, number]>) {
        const nt = topAt.get(`${Math.round(x + nx)},${Math.round(z + nz)}`);
        const lo = nt === undefined ? Math.max(bot, Math.min(groundAt(ax, az), groundAt(bx, bz)) - 0.1) : nt;
        if (top - lo < 0.03) continue;
        const b0 = sp.length / 3;
        sp.push(ax, top, az, bx, top, bz, ax, lo, az, bx, lo, bz);
        for (let i = 0; i < 4; i++) sc.push(0.82, 0.78, 0.72);
        su.push(0, top / 1.6, Math.hypot(bx - ax, bz - az) / 3.2, top / 1.6, 0, lo / 1.6, Math.hypot(bx - ax, bz - az) / 3.2, lo / 1.6);
        si.push(b0, b0 + 1, b0 + 2, b0 + 1, b0 + 3, b0 + 2);
      }
    }
  }
  const sg = mwScope.geometry("geo.world", new THREE.BufferGeometry());
  sg.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
  sg.setAttribute("color", new THREE.Float32BufferAttribute(sc, 3));
  sg.setAttribute("uv", new THREE.Float32BufferAttribute(su, 2));
  sg.setIndex(si); sg.computeVertexNormals(); sg.computeBoundingSphere();
  const siltMat = mwScope.material(new THREE.MeshStandardMaterial({ vertexColors: true, map: siltTexture(mwScope), roughness: 0.95, metalness: 0, name: "murk:silt" }));
  const shelf = new THREE.Mesh(sg, siltMat);
  shelf.name = "murk:silt"; shelf.receiveShadow = true; shelf.castShadow = shelf.userData.farShadow = false; shelf.renderOrder = -10;
  // ---- THE SWAMP HAZE in normal play (not only on the staged camera):
  // one full-screen quad drawn LAST, reading the depth the tea already grabbed this frame — humid golden air thickens
  // with view distance (sky and far gaps fade into it, so blue sky never reads through the canopy), fading out as the
  // camera leaves the swamp. Drawn only where the grab is live (camera < 260 m; not on the low tier).
  let haze: THREE.Mesh | null = null;
  let update = (_r: THREE.WebGLRenderer, _c: THREE.PerspectiveCamera) => {};
  if (grab) {
    const hz = { uHzCol: { value: new THREE.Color("#d8b066").convertSRGBToLinear().multiplyScalar(0.62) }, uHzK: { value: 0 }, uHzInvProj: { value: new THREE.Matrix4() }, uHzCam: { value: new THREE.Matrix4() } };
    const hm = mwScope.material(new THREE.ShaderMaterial({
      name: "murk:haze", transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
      uniforms: { ...hz, uMkDepth: uMk.uMkDepth, uMkGrab: uMk.uMkGrab, uMkNF: uMk.uMkNF },
      vertexShader: "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: `uniform sampler2D uMkDepth; uniform vec4 uMkGrab; uniform vec2 uMkNF; uniform vec3 uHzCol; uniform float uHzK; uniform mat4 uHzInvProj; uniform mat4 uHzCam;
float vz(float d) { float n = uMkNF.x, f = uMkNF.y; return (2.0 * n * f) / ((f + n) - (d * 2.0 - 1.0) * (f - n)); }
void main() {
  if (uMkGrab.z < 0.5 || uHzK <= 0.0) discard;
  vec2 uv = clamp(gl_FragCoord.xy * uMkGrab.xy, 0.0, 1.0);
  float d = texture2D(uMkDepth, uv).r;
  float z = d >= 0.99999 ? 400.0 : vz(d);
  // (a sky dome / far land past 180 m counts as sky — nothing under the swamp canopy is that far)
  bool sky = z > 180.0;
  // the swamp air is a LOW layer: a ray climbing into the canopy crosses little of it — the leaf ceiling stays
  // dark and contrasty (the frame's top 40 %), the haze gathers along the channel at eye level and in the sky gaps
  vec4 vd = uHzInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  float up = normalize(mat3(uHzCam) * normalize(vd.xyz / vd.w)).y;
  float low = 1.0 - 0.8 * smoothstep(0.08, 0.5, up);
  // nothing within 6 m, ~33 % at 40 m along the channel; the sky / sun gaps read as warm hazy light (never blue)
  float f = sky ? 0.86 : (1.0 - exp(-max(0.0, z - 6.0) * 0.012)) * 0.7 * low;
  gl_FragColor = vec4(uHzCol, f * uHzK);
}`,
    }));
    haze = new THREE.Mesh(mwScope.geometry("geo.world", new THREE.PlaneGeometry(2, 2)), hm);
    haze.name = "murk:haze"; haze.renderOrder = 1000;
    haze.frustumCulled = haze.castShadow = haze.receiveShadow = haze.visible = false;
    let hzK = 0;
    haze.onBeforeRender = (r, _s, camera) => {
      hz.uHzK.value = camera === ctx.camera ? hzK : 0;
      if (camera !== ctx.camera) return;
      bindGrab(r, camera, true);
      hz.uHzInvProj.value.copy(ctx.camera.projectionMatrixInverse); hz.uHzCam.value.copy(ctx.camera.matrixWorld);
    };
    update = (renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera) => {
      const c = ctx.camera.position, d = Math.hypot(c.x - CX, c.z - CZ);
      murkNear = d < 260;
      hzK = smooth(125, 80, d) * smooth(48, 26, c.y) * hazeScale;
      haze!.visible = hzK > 0.001;
      hz.uHzK.value = hzK;
      if (sharedGrab && murkNear) {
        _mkVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        _mkFrustum.setFromProjectionMatrix(_mkVP);
        if (hzK > 0.001 || (mesh.visible && _mkFrustum.intersectsBox(g.boundingBox!))) grab.request(renderer.info.render.frame, 1, true);
      }
    };
  }
  return { mesh, shelf, haze, levelAt, uniforms, update };
}

/** lily pads: instanced notched leaves with a curled rim (painted canvas atlas: 4 leaves — veins, mottling, sun-bleached
 *  and rotting edges, a flower). Drawn AFTER the tea (transparent queue) so they are never in its scene grab: no
 *  refracted / reflected copy of a pad can appear under it. */
export function buildLilies(ctx: WorldCtx, spots: Array<[number, number]>, levelAt: (x: number, z: number) => number, rng: () => number, scope: Scope): THREE.InstancedMesh {
  const tex = canvasTex(scope, 512, 512, (g) => {
    const pad = (cx: number, cy: number, r: number, hue: number, age: number) => {
      g.save(); g.translate(cx, cy);
      const notch = rng() * Math.PI * 2, nw = 0.16 + rng() * 0.06;
      const outline = () => {
        g.beginPath(); g.moveTo(0, 0);
        for (let k = 0; k <= 48; k++) { const a = notch + nw + k / 48 * (Math.PI * 2 - 2 * nw), rr = r * (0.97 + 0.03 * Math.sin(a * 7 + hue)); g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); }
        g.closePath();
      };
      outline(); g.save(); g.clip();
      const gr = g.createRadialGradient(0, 0, r * 0.05, 0, 0, r);
      gr.addColorStop(0, `hsl(${hue + 8},45%,40%)`); gr.addColorStop(0.55, `hsl(${hue},50%,33%)`); gr.addColorStop(0.9, `hsl(${hue - 6},48%,27%)`); gr.addColorStop(1, `hsl(${hue - 20},40%,22%)`);
      g.fillStyle = gr; g.fillRect(-r, -r, 2 * r, 2 * r);
      for (let k = 0; k < 70; k++) { const a = rng() * 6.283, d = Math.sqrt(rng()) * r, s2 = 2 + rng() * 7;
        g.fillStyle = rng() < 0.55 ? `hsla(${hue + 14},55%,48%,${0.12 + rng() * 0.12})` : `hsla(${hue - 10},45%,18%,${0.1 + rng() * 0.12})`;
        g.beginPath(); g.ellipse(Math.cos(a) * d, Math.sin(a) * d, s2, s2 * (0.5 + rng() * 0.5), a, 0, 6.283); g.fill(); }
      for (let k = 0; k < 6 * age; k++) { const a = rng() * 6.283, d = r * (0.4 + rng() * 0.55);
        g.fillStyle = `hsla(${28 + rng() * 10},55%,${26 + rng() * 10}%,0.55)`; g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, 1.5 + rng() * 3.5, 0, 6.283); g.fill(); }
      g.lineCap = "round";
      for (let k = 0; k < 15; k++) {
        const a = notch + nw + 0.12 + k / 14 * (Math.PI * 2 - 2 * nw - 0.24);
        g.strokeStyle = `hsla(${hue + 18},45%,58%,0.42)`; g.lineWidth = 2.2;
        g.beginPath(); g.moveTo(0, 0); const mx = Math.cos(a) * r * 0.55, my = Math.sin(a) * r * 0.55; g.lineTo(mx, my);
        g.lineTo(Math.cos(a + 0.03) * r * 0.93, Math.sin(a + 0.03) * r * 0.93); g.stroke();
        g.lineWidth = 1.1; g.strokeStyle = `hsla(${hue + 18},40%,55%,0.3)`;
        for (const sg of [-1, 1]) { g.beginPath(); g.moveTo(mx, my); g.lineTo(Math.cos(a + sg * 0.12) * r * 0.9, Math.sin(a + sg * 0.12) * r * 0.9); g.stroke(); }
      }
      g.lineWidth = r * 0.09; g.strokeStyle = `hsla(${hue - 30 + 22 * age},${45 - age * 10}%,${30 + age * 6}%,0.55)`; outline(); g.stroke();
      g.restore();
      g.lineWidth = 2; g.strokeStyle = `hsla(${hue - 25},35%,16%,0.8)`; outline(); g.stroke();
      g.fillStyle = `hsla(${hue + 20},40%,55%,0.6)`; g.beginPath(); g.arc(0, 0, 3, 0, 6.283); g.fill();
      g.restore();
    };
    const q = 128;
    pad(q, q, q * 0.9, 96, 0.3); pad(3 * q, q, q * 0.86, 84, 1.0); pad(q, 3 * q, q * 0.84, 72, 1.6); pad(3 * q, 3 * q, q * 0.88, 104, 0.6);
    for (let ring = 0; ring < 2; ring++) for (let k = 0; k < 8; k++) {
      const a = k / 8 * Math.PI * 2 + ring * 0.39, rr = ring ? 11 : 19;
      g.fillStyle = ring ? "#fbeef2" : "#f2d4de"; g.strokeStyle = "rgba(160,90,110,0.5)"; g.lineWidth = 1;
      g.beginPath(); g.ellipse(3 * q + Math.cos(a) * rr, 3 * q + Math.sin(a) * rr, ring ? 10 : 14, ring ? 5 : 6.5, a, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    g.fillStyle = "#f2c94a"; g.beginPath(); g.arc(3 * q, 3 * q, 7, 0, Math.PI * 2); g.fill();
  });
  // curled leaf: a disc whose rim lifts ~3.5 cm (pads cup slightly at the edge), UVs planar
  const geo = scope.geometry("geo.world", new THREE.CircleGeometry(0.5, 20, 0, Math.PI * 2));
  {
    const ring = new THREE.RingGeometry(0.0001, 0.5, 20, 3); ring.rotateX(-Math.PI / 2);
    const pp = ring.attributes.position as THREE.BufferAttribute, uv = ring.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < pp.count; i++) { const x = pp.getX(i), z = pp.getZ(i), r = Math.hypot(x, z) / 0.5; pp.setY(i, 0.035 * Math.pow(r, 4)); uv.setXY(i, x + 0.5, 0.5 - z); }
    ring.computeVertexNormals();
    geo.copy(ring); ring.dispose();
  }
  const mat = scope.material(new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, transparent: true, depthWrite: true, roughness: 0.38, metalness: 0, envMapIntensity: 0.9, side: THREE.DoubleSide, name: "murk:lily-leaf" }));
  // pick one of the four pads per instance via the UV offset (instanceColor.r)
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("#include <uv_vertex>", `#include <uv_vertex>
  #ifdef USE_INSTANCING_COLOR
    { float q = floor(instanceColor.r * 3.99); vMapUv = vMapUv * 0.5 + vec2(mod(q, 2.0), floor(q / 2.0)) * 0.5; }
  #endif`).replace("#include <color_vertex>", "#include <color_vertex>\n#ifdef USE_INSTANCING_COLOR\n vColor.rgb = vec3(1.0);\n#endif");
  };
  mat.customProgramCacheKey = () => "murk-lily-2";
  const ms: THREE.Matrix4[] = [];
  for (const [x, z] of spots) {
    const n = 7 + Math.floor(rng() * 10);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 2.8, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      const lv = levelAt(px, pz);
      if (lv - ctx.terrain.height(px, pz) < 0.08 || lv < 0.3) continue;
      const s = 0.35 + rng() * 0.5;
      ms.push(new THREE.Matrix4().compose(new THREE.Vector3(px, lv + 0.006, pz), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * 6.28), new THREE.Vector3(s, 1, s)));
    }
  }
  const im = new THREE.InstancedMesh(geo, mat, Math.max(1, ms.length));
  ms.forEach((m, i) => { im.setMatrixAt(i, m); im.setColorAt(i, new THREE.Color(rng(), 0, 0)); });
  im.count = ms.length;
  im.name = "murk:lilies";
  im.receiveShadow = true; im.castShadow = false;
  // (after the tea in the transparent queue)
  im.renderOrder = 5;
  im.computeBoundingSphere();
  return im;
}
