// FLOTSAM — BANANA CO. cargo crates floating in the shallows (the beach target art's crate bobbing in the turquoise
// water, spilled cargo in the wreck lagoon, a couple in the cove). A water mechanic as much as dressing: every crate
// rides the swell through WaterApi.surfaceAt (heave), tilts with the local slope of the surface (pitch / roll, damped),
// drifts a little on a slow orbit and yaws; its waterline ring comes from the proximity bake like any prop crossing the
// surface. Decorative only (no collider): a floating crate in knee-deep water.
// Frustum- & distance-culled + compacted per frame so off-screen / distant crates skip surfaceAt & matrix work.
import * as THREE from "three";
import type { Terrain } from "../../../../shared/world/terrain";
import type { Scope } from "../../engine/res/scope";

const W = 1.0, H = 0.92, D = 0.96;  // crate size (m): the target art's crate is a chunky ~1 m box (near-cube: never a coffin)
const DRAFT = 0.3;                   // how deep it sits (m below the surface at its centre height 0): ~⅔ rides above it
const MAX_CRATE_DIST_SQ = 340 * 340;
const MAX_FOAM_DIST_SQ = 260 * 260;
const MAX_UW_FOAM_DIST_SQ = 45 * 45;
const UP = new THREE.Vector3(0, 1, 0);
const _flFrustum = new THREE.Frustum();
const _flProj = new THREE.Matrix4();
const _flSph = new THREE.Sphere(undefined, 4);
const _flZero = new THREE.Matrix4().makeScale(0, 0, 0);

/** the crate texture atlas (canvas): [0, 0.5) side planks + logo, [0.5, 0.75) top planks, [0.75, 1] frame battens */
function crateTexture(scope: Scope): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024; c.height = 512;
  const g = c.getContext("2d")!;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const planks = (x0: number, w: number, rows: number, logo: boolean) => {
    const ph = 512 / rows;
    for (let i = 0; i < rows; i++) {
      const y = i * ph;
      // weathered, sun-bleached grey-brown (the target art's crate #5a4a3a–#7a6450 — not a saturated red-orange)
      const base = 116 + rnd() * 34, r = base * 0.66 + 14, gg = base * 0.55 + 12, b = base * 0.44 + 10;
      g.fillStyle = `rgb(${r | 0},${gg | 0},${b | 0})`;
      g.fillRect(x0, y, w, ph);
      // grain: long thin darker / lighter strokes along the plank
      for (let k = 0; k < 26; k++) {
        const gy = y + 4 + rnd() * (ph - 8), a = 0.06 + rnd() * 0.12;
        g.strokeStyle = rnd() < 0.5 ? `rgba(40,22,10,${a})` : `rgba(210,160,110,${a * 0.7})`;
        g.lineWidth = 1 + rnd() * 2.5;
        g.beginPath(); g.moveTo(x0, gy);
        for (let sx = 0; sx <= w; sx += 32) g.lineTo(x0 + sx, gy + Math.sin(sx * 0.02 + k) * 2.5);
        g.stroke();
      }
      // knots
      if (rnd() < 0.6) { const kx = x0 + 30 + rnd() * (w - 60), ky = y + ph * (0.3 + rnd() * 0.4); g.fillStyle = "rgba(45,25,12,0.55)"; g.beginPath(); g.ellipse(kx, ky, 9 + rnd() * 6, 5 + rnd() * 3, 0, 0, Math.PI * 2); g.fill(); }
      // gap + bevel shading between planks
      g.fillStyle = "rgba(20,10,4,0.85)"; g.fillRect(x0, y, w, 4);
      g.fillStyle = "rgba(255,220,170,0.18)"; g.fillRect(x0, y + 4, w, 3);
      g.fillStyle = "rgba(0,0,0,0.22)"; g.fillRect(x0, y + ph - 6, w, 6);
      // nails at both ends
      for (const nx of [x0 + 22, x0 + w - 22]) { g.fillStyle = "#2a2622"; g.beginPath(); g.arc(nx, y + ph * 0.5, 4, 0, Math.PI * 2); g.fill(); g.fillStyle = "rgba(255,255,255,0.25)"; g.beginPath(); g.arc(nx - 1, y + ph * 0.5 - 1, 1.5, 0, Math.PI * 2); g.fill(); }
    }
    if (logo) {
      // stencilled BANANA CO. logo: a banana bunch + the wordmark, weathered
      const cx = x0 + w / 2, cy = 120;
      g.save();
      // a bunch of 4 curved bananas hanging from one crown (crescents: an outer arc and an inner arc)
      g.fillStyle = "#e9bf22"; g.strokeStyle = "#3a2a0a"; g.lineWidth = 5;
      for (let k = 0; k < 4; k++) {
        g.save(); g.translate(cx - 6, cy - 62); g.rotate(-0.62 + k * 0.36);
        g.beginPath();
        g.moveTo(0, 0);
        g.quadraticCurveTo(-46, 58, 8, 128);            // outer curve down to the tip
        g.quadraticCurveTo(-14, 60, 16, 4);             // inner curve back up
        g.closePath(); g.fill(); g.stroke();
        g.fillStyle = "rgba(160,110,10,0.45)"; g.beginPath(); g.ellipse(6, 124, 6, 5, 0, 0, Math.PI * 2); g.fill();   // dark tip
        g.fillStyle = "#e9bf22";
        g.restore();
      }
      g.fillStyle = "#5e4a1a"; g.beginPath(); g.roundRect(cx - 18, cy - 82, 26, 24, 5); g.fill();
      g.font = "bold 58px Impact, 'Arial Black', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.lineWidth = 8; g.strokeText("BANANA CO.", cx, cy + 112); g.fillText("BANANA CO.", cx, cy + 112);
      g.restore();
      // wear: scratch the paint off in places
      for (let k = 0; k < 220; k++) { g.fillStyle = `rgba(${125 + rnd() * 30},${85 + rnd() * 20},${45 + rnd() * 15},${0.3 + rnd() * 0.45})`; g.fillRect(cx - 170 + rnd() * 340, cy - 80 + rnd() * 230, 2 + rnd() * 9, 1 + rnd() * 3); }
    }
    // wet band: the lower ~45 % has been in the water — darker, a green-brown algae tint at the waterline
    const wet = g.createLinearGradient(0, 512 * 0.5, 0, 512);
    wet.addColorStop(0, "rgba(10,30,20,0)"); wet.addColorStop(0.12, "rgba(20,45,25,0.42)"); wet.addColorStop(0.22, "rgba(15,30,25,0.5)"); wet.addColorStop(1, "rgba(5,20,25,0.62)");
    g.fillStyle = wet; g.fillRect(x0, 512 * 0.5, w, 512 * 0.5);
  };
  planks(0, 512, 5, true);
  planks(512, 256, 4, false);
  // battens: darker, rougher wood, edges worn light
  g.fillStyle = "#5f4b37"; g.fillRect(768, 0, 256, 512);
  for (let k = 0; k < 60; k++) { g.strokeStyle = `rgba(${rnd() < 0.5 ? "20,10,5" : "150,110,70"},${0.08 + rnd() * 0.15})`; g.lineWidth = 1 + rnd() * 3; const x = 768 + rnd() * 256; g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (rnd() - 0.5) * 12, 512); g.stroke(); }
  g.fillStyle = "rgba(200,170,130,0.22)"; g.fillRect(768, 0, 256, 10); g.fillRect(768, 502, 256, 10);
  // iron bolts along the battens (the target art's crate has metal fittings at the corners)
  for (let y = 40; y < 512; y += 118) for (const x of [800, 992]) { g.fillStyle = "#2c2a28"; g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill(); g.fillStyle = "rgba(255,255,255,0.28)"; g.beginPath(); g.arc(x - 2, y - 2, 3, 0, Math.PI * 2); g.fill(); }
  const t = scope.texture("tex.world", new THREE.CanvasTexture(c));
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** one quad (a, b, c, d counter-clockwise seen from outside) with a uv rectangle */
function quad(pos: number[], nrm: number[], uv: number[], idx: number[], a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, u0: number, v0: number, u1: number, v1: number) {
  const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
  const i0 = pos.length / 3;
  for (const [p, u, v] of [[a, u0, v0], [b, u1, v0], [c, u1, v1], [d, u0, v1]] as Array<[THREE.Vector3, number, number]>) { pos.push(p.x, p.y, p.z); nrm.push(n.x, n.y, n.z); uv.push(u, v); }
  idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
}
/** an axis-aligned box (centre, half size) with every face mapped to one uv rectangle (+ the side faces optionally to another) */
function box(pos: number[], nrm: number[], uv: number[], idx: number[], c: THREE.Vector3, h: THREE.Vector3, side: [number, number, number, number], top: [number, number, number, number]) {
  const V = (sx: number, sy: number, sz: number) => new THREE.Vector3(c.x + sx * h.x, c.y + sy * h.y, c.z + sz * h.z);
  const S = side, T = top;
  quad(pos, nrm, uv, idx, V(-1, -1, 1), V(1, -1, 1), V(1, 1, 1), V(-1, 1, 1), S[0], S[1], S[2], S[3]);      // +z
  quad(pos, nrm, uv, idx, V(1, -1, -1), V(-1, -1, -1), V(-1, 1, -1), V(1, 1, -1), S[0], S[1], S[2], S[3]);  // -z
  quad(pos, nrm, uv, idx, V(1, -1, 1), V(1, -1, -1), V(1, 1, -1), V(1, 1, 1), S[0], S[1], S[2], S[3]);      // +x
  quad(pos, nrm, uv, idx, V(-1, -1, -1), V(-1, -1, 1), V(-1, 1, 1), V(-1, 1, -1), S[0], S[1], S[2], S[3]);  // -x
  quad(pos, nrm, uv, idx, V(-1, 1, 1), V(1, 1, 1), V(1, 1, -1), V(-1, 1, -1), T[0], T[1], T[2], T[3]);      // +y
  quad(pos, nrm, uv, idx, V(-1, -1, -1), V(1, -1, -1), V(1, -1, 1), V(-1, -1, 1), T[0], T[1], T[2], T[3]);  // -y
}

function crateGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  const sideUV: [number, number, number, number] = [0.004, 0.004, 0.496, 0.996];
  const topUV: [number, number, number, number] = [0.504, 0.004, 0.746, 0.996];
  const batUV: [number, number, number, number] = [0.754, 0.004, 0.996, 0.996];
  // body (slightly inset so the frame battens stand proud)
  box(pos, nrm, uv, idx, new THREE.Vector3(0, 0, 0), new THREE.Vector3(W / 2 - 0.02, H / 2 - 0.02, D / 2 - 0.02), sideUV, topUV);
  // 12 edge battens (square section, proud of the faces) + a diagonal-free top rim: the crate's silhouette
  const b = 0.055, hw = W / 2, hh = H / 2, hd = D / 2;
  for (const sy of [-1, 1]) for (const sz of [-1, 1]) box(pos, nrm, uv, idx, new THREE.Vector3(0, sy * (hh - b), sz * (hd - b)), new THREE.Vector3(hw, b, b), batUV, batUV);
  for (const sy of [-1, 1]) for (const sx of [-1, 1]) box(pos, nrm, uv, idx, new THREE.Vector3(sx * (hw - b), sy * (hh - b), 0), new THREE.Vector3(b, b, hd - 2 * b), batUV, batUV);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(pos, nrm, uv, idx, new THREE.Vector3(sx * (hw - b), 0, sz * (hd - b)), new THREE.Vector3(b, hh - 2 * b, b), batUV, batUV);
  // a middle band around the sides (the target art's crates have a mid rail)
  box(pos, nrm, uv, idx, new THREE.Vector3(0, 0, 0), new THREE.Vector3(hw + 0.012, 0.045, hd + 0.012), batUV, batUV);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

export interface FlotsamSpot { x: number; z: number; yaw: number }

/**
 * Deterministic floating spots: for each seed area, candidates on a spiral around the anchor with 0.6–1.6 m of water,
 * clear of every static collider (containers, hulls, piers) by ≥ 2.2 m and of each other by ≥ 3 m.
 */
export function flotsamSpots(T: Terrain, anchors: Array<{ x: number; z: number; n: number; r: number; dMin?: number; dMax?: number; face?: { x: number; z: number } }>, blockers: Array<{ x: number; z: number; r: number }>): FlotsamSpot[] {
  const out: FlotsamSpot[] = [];
  for (const a of anchors) {
    let placed = 0;
    for (let k = 0; k < 900 && placed < a.n; k++) {
      const ang = k * 2.39996, rad = a.r * Math.sqrt((k + 0.5) / 900);
      const x = a.x + Math.cos(ang) * rad, z = a.z + Math.sin(ang) * rad, d = -T.height(x, z);
      if (d < (a.dMin ?? 0.6) || d > (a.dMax ?? 1.6)) continue;
      // the floor all around must be water too (no crate touching a sand bank)
      if ([[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]].some(([ox, oz]) => -T.height(x + ox, z + oz) < (a.dMin ?? 0.6) * 0.75)) continue;
      if (blockers.some((b) => Math.hypot(b.x - x, b.z - z) < b.r + 2.2)) continue;
      if (out.some((o) => Math.hypot(o.x - x, o.z - z) < 3)) continue;
      // (face: one side turned to that point, ~17° off — the beach target art's crate shows its front face and lid,
      // never a corner-on long box that reads as a coffin)
      const yaw = a.face ? Math.atan2(a.face.x - x, a.face.z - z) + 0.3 : ((k * 0.7317) % 1) * Math.PI * 2;
      out.push({ x, z, yaw });
      placed++;
    }
  }
  return out;
}

/** the foam collar a floating crate wears: a flat decal at the waterline — dense bubbly contact foam hugging the crate's
 *  footprint, lace opening outward, wisps that pulse with the lapping (the target art's floating crate). The proximity
 *  bake (0.59 m texels) is too coarse for a 1 m object, so the crate carries its own. Lit like any surface (atmos). */
function foamCollarMaterial(foamTex: THREE.Texture): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.95, 0.975, 1.0), roughness: 0.9, metalness: 0, transparent: true, depthWrite: false });
  m.name = "flotsam-foam";
  m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -8;
  const uni = { fcTime: { value: 0 }, fcTex: { value: foamTex }, fcHalf: { value: new THREE.Vector2(W / 2, D / 2) } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vFcP;\nvarying vec2 vFcW;\nvarying float vFcId;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>
vFcP = position.xz;
vFcW = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xz;
vFcId = float(gl_InstanceID);`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
varying vec2 vFcP;
varying vec2 vFcW;
varying float vFcId;
uniform float fcTime;
uniform vec2 fcHalf;
uniform highp sampler2DArray fcTex;`)
      .replace("#include <alphamap_fragment>", `
{
  // distance outside the crate's footprint (rounded box), metres
  vec2 q = abs(vFcP) - fcHalf + 0.08;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.08;
  float ang = atan(vFcP.y, vFcP.x);
  float t = fcTime + vFcId * 3.7;
  vec4 f = texture(fcTex, vec3(vFcW / 1.5 + vec2(t * 0.012, -t * 0.009), 0.0));
  vec4 f2 = texture(fcTex, vec3(vFcW / 0.7 + vec2(-t * 0.02, t * 0.015), 0.0));
  float lace = max(f.r, f2.r * 0.8), dens = f.g;
  // (not a 1 px line: a BUBBLY collar 0.3-0.6 m wide that breathes with the crate's
  // bob (the same phase as Flotsam.update: sin(t·1.3 + i·1.917)), soft patches with round bubble holes, + two ripple
  // rings pushed out by each bob, fading as they spread)
  float bob = sin(fcTime * 1.3 + vFcId * 1.917);
  float wC = 0.3 + 0.16 * (0.5 + 0.5 * bob) + 0.14 * f.g + 0.05 * sin(ang * 3.0 + vFcId);
  vec4 f3 = texture(fcTex, vec3(vFcW / 0.35 + vec2(t * 0.03, t * 0.02), 0.0));
  float v = (1.0 - smoothstep(0.0, wC, d)) * 0.55 + (f.g - 0.5) * 0.5 + (f2.r - 0.5) * 0.35 - f2.b * 0.45 - f3.b * 0.35 + (f3.r - 0.5) * 0.2;
  float a1 = smoothstep(0.36, 0.56, v) * step(-0.02, d);
  float a0 = (1.0 - smoothstep(0.03, 0.09, d)) * step(-0.02, d) * smoothstep(0.25, 0.5, f.g * 0.5 + f2.g * 0.5 + 0.2);   // contact line
  float ph = fract((fcTime * 1.3 + vFcId * 1.917) / 6.2832 + 0.25);
  float ring = 0.0;
  for (int k = 0; k < 2; k++) {
    float pk = fract(ph + float(k) * 0.5);
    float rr = wC + pk * 1.3;
    ring += exp(-pow((d - rr) / (0.035 + 0.04 * pk), 2.0)) * (1.0 - pk) * (1.0 - pk);
  }
  ring *= smoothstep(0.3, 0.6, lace * 0.6 + f2.g * 0.4);
  float a = max(max(a1, a0), ring * 0.55);
  diffuseColor.a *= a;
  if (diffuseColor.a < 0.004) discard;
}`);
  };
  m.customProgramCacheKey = () => "flotsam-foam-v4";
  (m as unknown as { fcUniforms: typeof uni }).fcUniforms = uni;
  return m;
}

export class Flotsam {
  readonly mesh: THREE.InstancedMesh;
  readonly foam: THREE.InstancedMesh | null = null;
  readonly #scope: Scope;
  readonly #prevVis: Uint8Array;
  #fq = new THREE.Quaternion();
  #m = new THREE.Matrix4();
  #q = new THREE.Quaternion();
  #qy = new THREE.Quaternion();
  #n = new THREE.Vector3();
  #p = new THREE.Vector3();
  #s = new THREE.Vector3(1, 1, 1);
  #tilt: Array<{ pitch: number; roll: number }>;
  #flTime = { value: 0 };

  constructor(readonly spots: FlotsamSpot[], foamTex: THREE.Texture | undefined, parentScope: Scope) {
    this.#scope = parentScope.child("flotsam");
    const mat = this.#scope.material(new THREE.MeshStandardMaterial({ map: crateTexture(this.#scope), roughness: 0.82, metalness: 0 }));
    mat.name = "water-flotsam-crate";
    // the SUBMERGED part (below its waterline, local y < DRAFT − H/2): the wood fades into the water's teal with depth and
    // loses its contrast — otherwise the submerged half reads as a uniform cyan glass block with hard edges
    const wl = (DRAFT - H / 2).toFixed(3);
    const flTime = this.#flTime;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.flTime = flTime;
      sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying float vFlY;\nvarying vec3 vFlP;\nvarying vec3 vFlN;\nvarying float vFlId;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvFlY = position.y; vFlP = position; vFlN = normal; vFlId = float(gl_InstanceID);");
      sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
varying float vFlY;
varying vec3 vFlP;
varying vec3 vFlN;
varying float vFlId;
uniform float flTime;
float flH(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float flVN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(flH(i), flH(i + vec2(1.0, 0.0)), f.x), mix(flH(i + vec2(0.0, 1.0)), flH(i + vec2(1.0, 1.0)), f.x), f.y); }`)
        .replace("#include <map_fragment>", `#include <map_fragment>
{
  float below = ${wl} - vFlY;                                    // metres under the waterline (local)
  float k = smoothstep(-0.02, 0.04, below);
  vec3 soft = mix(vec3(dot(diffuseColor.rgb, vec3(0.3333))), diffuseColor.rgb, 0.45);   // contrast + saturation drop
  // (the water tints the submerged half by its TRUE thickness (scene depth) and adds its caustics: here only a wet
  // darkening + a little contrast loss — a dark-teal albedo made it a hard flat blue slab under the crate. Through the
  // clear water the submerged half reads as a soft shadowy shape, never a cyan glass block with hard edges)
  diffuseColor.rgb = mix(diffuseColor.rgb, soft * vec3(0.72, 0.8, 0.8), k);
  // (WASH on the crate's sides — at the beach camera's grazing angle the flat collar projects to a few px,
  // so the contact must also stand UP: bubbly white foam slapping 4-16 cm up the sides at the waterline, surging with
  // each bob (the same phase as Flotsam.update), holes + frayed top edge, a wet dark band just above it)
  float side = 1.0 - smoothstep(0.35, 0.7, abs(vFlN.y));
  float u = (abs(vFlN.x) > 0.5 ? vFlP.z : vFlP.x) + (vFlN.x + vFlN.z) * 1.7 + vFlId * 5.3;
  float bob = 0.5 + 0.5 * sin(flTime * 1.3 + vFlId * 1.917 + u * 1.2);
  float nA = flVN(vec2(u * 9.0, flTime * 0.7)), nB = flVN(vec2(u * 23.0 + 7.0, (vFlY - flTime * 0.05) * 30.0));
  float top = 0.04 + 0.1 * bob + 0.06 * nA;
  float above = vFlY - ${wl};
  float wash = (1.0 - smoothstep(top - 0.03, top + 0.01, above)) * smoothstep(-0.05, 0.0, above) * side;
  wash *= smoothstep(0.22, 0.45, nB * 0.7 + nA * 0.3 + 0.12 * (1.0 - above / max(top, 0.01)));
  float wet = (1.0 - smoothstep(top, top + 0.12, above)) * step(0.0, above) * side;
  diffuseColor.rgb *= 1.0 - 0.3 * wet;
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.97, 1.0), wash * 0.95);
}`);
    };
    mat.customProgramCacheKey = () => "flotsam-crate-v6";
    (mat as unknown as { flTime: typeof flTime }).flTime = flTime;
    const crateGeo = this.#scope.geometry("geo.world", crateGeometry());
    this.mesh = new THREE.InstancedMesh(crateGeo, mat, Math.max(1, spots.length));
    this.#prevVis = new Uint8Array(spots.length);
    this.mesh.name = "flotsam-crates";                   // (not "water-…": the waterline bake skips the water's own meshes)
    this.mesh.count = spots.length;
    // (no shadow onto the seabed a metre down: through the water it printed a crisp dark box beside the crate)
    this.mesh.castShadow = false; this.mesh.receiveShadow = true; this.mesh.userData.castShadow = false;
    this.mesh.userData.farShadow = false;              // (it moves: keep it out of the static far shadow map)
    this.mesh.frustumCulled = false;                   // (per-instance frustum/distance culled in update())
    this.#tilt = spots.map(() => ({ pitch: 0, roll: 0 }));
    if (foamTex) {
      const g = this.#scope.geometry("geo.world", new THREE.PlaneGeometry(W + 4.4, D + 4.4));
      g.rotateX(-Math.PI / 2);                             // flat on the water (local xy → world xz via the instance)
      // (after rotateX the plane lies in local xz: the shader reads its footprint coordinates from position.xz)
      this.foam = new THREE.InstancedMesh(g, this.#scope.material(foamCollarMaterial(foamTex)), Math.max(1, spots.length));
      this.foam.name = "flotsam-foam"; this.foam.count = spots.length;
      this.foam.castShadow = false; this.foam.receiveShadow = true; this.foam.frustumCulled = false; this.foam.renderOrder = 1;
      this.foam.userData.castShadow = false; this.foam.userData.noFoam = true; this.foam.userData.farShadow = false;
    }
    this.update(12, (_x, _z) => 0);
  }

  /** ride the swell for visible crates only: frustum + distance cull off-screen/distant crates before surfaceAt */
  update(t: number, surfaceAt: (x: number, z: number) => number, dt = 1 / 60, camera?: THREE.Camera, underActive = false) {
    const expK = 1 - Math.exp(-dt * 2.2);
    let hasCam = false, cx = 0, cy = 0, cz = 0;
    if (camera) {
      _flProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _flFrustum.setFromProjectionMatrix(_flProj);
      cx = camera.position.x; cy = camera.position.y; cz = camera.position.z;
      hasCam = true;
    }
    const maxFoamSq = underActive ? MAX_UW_FOAM_DIST_SQ : MAX_FOAM_DIST_SQ;
    let visCrate = 0, visFoam = 0, dirty = false, foamDirty = false;
    for (let i = 0; i < this.spots.length; i++) {
      const sp = this.spots[i], prev = this.#prevVis[i];
      let d2 = 0, vis = true;
      if (hasCam) {
        d2 = (sp.x - cx) ** 2 + cy * cy + (sp.z - cz) ** 2;
        _flSph.center.set(sp.x, 0, sp.z);
        vis = d2 <= MAX_CRATE_DIST_SQ && _flFrustum.intersectsSphere(_flSph);
      }
      if (!vis) {
        if (prev) {
          this.#prevVis[i] = 0;
          this.mesh.setMatrixAt(i, _flZero); dirty = true;
          if (this.foam) { this.foam.setMatrixAt(i, _flZero); foamDirty = true; }
        }
        continue;
      }
      const k = prev ? expK : 1;
      this.#prevVis[i] = 1; visCrate++;
      const ph = i * 1.917, x = sp.x + Math.sin(t * 0.045 + ph) * 0.35, z = sp.z + Math.cos(t * 0.038 + ph * 1.3) * 0.35;
      const e = 0.55, h = surfaceAt(x, z), hx = surfaceAt(x + e, z) - surfaceAt(x - e, z), hz = surfaceAt(x, z + e) - surfaceAt(x, z - e);
      const tl = this.#tilt[i];
      tl.pitch += (-hz / (2 * e) * 0.85 + Math.sin(t * 0.9 + ph) * 0.03 - tl.pitch) * k;
      tl.roll += (-hx / (2 * e) * 0.85 + Math.sin(t * 0.7 + ph * 2.1) * 0.03 - tl.roll) * k;
      this.#n.set(tl.roll, 1, tl.pitch).normalize();
      this.#q.setFromUnitVectors(UP, this.#n); this.#qy.setFromAxisAngle(UP, sp.yaw + Math.sin(t * 0.05 + ph) * 0.2); this.#q.multiply(this.#qy);
      this.#p.set(x, h + H / 2 - DRAFT + Math.sin(t * 1.3 + ph) * 0.015, z); this.#s.set(1, 1, 1);
      this.#m.compose(this.#p, this.#q, this.#s); this.mesh.setMatrixAt(i, this.#m); dirty = true;
      if (this.foam) {
        if (!hasCam || d2 <= maxFoamSq) {
          this.#fq.copy(this.#qy); this.#p.set(x, h + 0.03, z); this.#m.compose(this.#p, this.#fq, this.#s);
          this.foam.setMatrixAt(i, this.#m); foamDirty = true; visFoam++;
        } else {
          if (prev === 1) { this.foam.setMatrixAt(i, _flZero); foamDirty = true; }
          this.#prevVis[i] = 2;
        }
      }
    }
    this.mesh.visible = visCrate > 0;
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
    if (visCrate > 0) this.#flTime.value = t;
    if (this.foam) {
      this.foam.visible = visFoam > 0;
      if (foamDirty) this.foam.instanceMatrix.needsUpdate = true;
      if (visFoam > 0) (this.foam.material as unknown as { fcUniforms: { fcTime: { value: number } } }).fcUniforms.fcTime.value = t;
    }
  }
}
