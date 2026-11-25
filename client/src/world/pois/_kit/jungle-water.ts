// poi-jungle kit — the water this area owns (waterfalls, plunge pool, river reaches), spray + mist, rainbow, lava,
// god-ray cards. Stylized-AAA recipe:
//   • still/flowing water: depth-graded turquoise (shallow mint → cyan → deep blue) over a visible sand bed, animated
//     flow-mapped ripple normals, Worley "caustic lace" in the shallows, sky fresnel + sun glint, foam on shores, around
//     rocks, at falls impacts and in rapids (per-vertex foam + flow attributes baked from the layout).
//   • waterfalls: curved free-fall sheets with scrolling multi-scale streak textures (accelerating with the drop),
//     ragged translucent edges, a glassy band over the lip, sun/back-light shading; spray + mist billboards at the foot.
// All animation reads `waterTime` (set from the engine clock by bindWaterTime; frozen in shot mode).
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import { canvasTex, mulberry } from "./jungle-mat";

export const waterTime = { value: 12 };
export const waterSun = { value: new THREE.Vector3(-0.3, 0.85, -0.44).normalize() };
const bound = new WeakSet<object>();
/** drive waterTime + waterSun from the engine (idempotent per ctx) */
export function bindWaterTime(ctx: WorldCtx) {
  if (bound.has(ctx)) return; bound.add(ctx);
  ctx.onUpdate((_dt, t) => {
    waterTime.value = t;
    const sd = ctx.shared.get("sunDir") as THREE.Vector3 | undefined; if (sd) waterSun.value.copy(sd).normalize();
  });
}

export const WATER = {
  shallow: new THREE.Color("#8ff5e0"), mid: new THREE.Color("#22d3e2"), deep: new THREE.Color("#0b7fc4"),
  foam: new THREE.Color("#ffffff"), sky: new THREE.Color("#9fdcff"),
};

const NOISE = /* glsl */ `
vec2 h2(vec2 p){ p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3))); return -1.0 + 2.0 * fract(sin(p) * 43758.5453123); }
float n2(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(dot(h2(i+vec2(0,0)), f-vec2(0,0)), dot(h2(i+vec2(1,0)), f-vec2(1,0)), u.x), mix(dot(h2(i+vec2(0,1)), f-vec2(0,1)), dot(h2(i+vec2(1,1)), f-vec2(1,1)), u.x), u.y); }
float fbm2(vec2 p){ return 0.5*n2(p) + 0.25*n2(p*2.1+3.0) + 0.125*n2(p*4.3+7.0); }
// Worley F2-F1 (cell edges) — stylized caustic / foam lace
vec2 hh2(vec2 p){ return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
float worleyEdge(vec2 p, float t){
  vec2 i = floor(p), f = fract(p); float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y)); vec2 o = hh2(i + g); o = 0.5 + 0.45 * sin(t + 6.2831 * o);
    float d = length(g + o - f); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return d2 - d1;
}
`;

// ---------------------------------------------------------------- still / flowing water
/** baked tileable water detail (512², 24 m period): rg = height gradient (normal xz), b = height (foam breakup noise),
 *  a = Worley F2−F1 lace. Built once on the CPU from periodic noise — the shader does 5 texture fetches instead of ~60
 *  procedural noise evaluations per pixel. */
let _wtex: THREE.DataTexture | null = null;
export const WATER_TILE = 24;
export function waterDetailTex(): THREE.DataTexture {
  if (_wtex) return _wtex;
  const N = 512, rnd = mulberry(8080);
  const lat = (P: number) => { const v = new Float32Array(P * P); for (let i = 0; i < v.length; i++) v[i] = rnd(); return v; };
  const octs = [[8, 0.5], [16, 0.25], [32, 0.14], [64, 0.07], [128, 0.035]].map(([P, a]) => ({ P, a, v: lat(P) }));
  const H = new Float32Array(N * N);
  // periodic Worley (16 × 16 cells)
  const C = 16, pts = new Float32Array(C * C * 2); for (let i = 0; i < pts.length; i++) pts[i] = 0.15 + 0.7 * rnd();
  const data = new Uint8Array(N * N * 4), px = WATER_TILE / N;
  // (as one task this bake took ~140 ms on the main thread where the first water material is made, so
  // it fills in 64-row slices, one per task; the texture starts neutral (flat, no lace) and re-uploads when done)
  for (let k = 0; k < N * N; k++) { data[k * 4] = 128; data[k * 4 + 1] = 128; data[k * 4 + 2] = 128; data[k * 4 + 3] = 0; }
  const rowsH = (y0: number, y1: number) => { for (let y = y0; y < y1; y++) for (let x = 0; x < N; x++) {
    let h = 0;
    for (const o of octs) {
      const fx = x / N * o.P, fy = y / N * o.P, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const g = (i: number, j: number) => o.v[((j % o.P + o.P) % o.P) * o.P + ((i % o.P + o.P) % o.P)];
      h += o.a * ((g(ix, iy) * (1 - sx) + g(ix + 1, iy) * sx) * (1 - sy) + (g(ix, iy + 1) * (1 - sx) + g(ix + 1, iy + 1) * sx) * sy);
    }
    H[y * N + x] = h;
  } };
  const rowsD = (y0: number, y1: number) => { for (let y = y0; y < y1; y++) for (let x = 0; x < N; x++) {
    const k = y * N + x, hx = (H[y * N + ((x + 1) % N)] - H[y * N + ((x + N - 1) % N)]) / (2 * px), hy = (H[((y + 1) % N) * N + x] - H[((y + N - 1) % N) * N + x]) / (2 * px);
    const fx = x / N * C, fy = y / N * C, cx = Math.floor(fx), cy = Math.floor(fy); let d1 = 9, d2 = 9;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const gx = cx + i, gy = cy + j, wx = ((gx % C) + C) % C, wy = ((gy % C) + C) % C; const ox = gx + pts[(wy * C + wx) * 2], oy = gy + pts[(wy * C + wx) * 2 + 1]; const d = Math.hypot(ox - fx, oy - fy); if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d; }
    data[k * 4] = Math.max(0, Math.min(255, 128 + hx * 40)); data[k * 4 + 1] = Math.max(0, Math.min(255, 128 + hy * 40));
    data[k * 4 + 2] = Math.max(0, Math.min(255, H[k] * 255)); data[k * 4 + 3] = Math.max(0, Math.min(255, (d2 - d1) * 255));
  } };
  _wtex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  _wtex.wrapS = _wtex.wrapT = THREE.RepeatWrapping; _wtex.magFilter = THREE.LinearFilter; _wtex.minFilter = THREE.LinearMipmapLinearFilter; _wtex.generateMipmaps = true; _wtex.anisotropy = 4; _wtex.needsUpdate = true;
  const S = 64, jobs: Array<() => void> = [];
  for (let y = 0; y < N; y += S) jobs.push(() => rowsH(y, y + S));
  for (let y = 0; y < N; y += S) jobs.push(() => rowsD(y, y + S));
  const tex = _wtex;
  const run = () => { const f = jobs.shift(); if (!f) { tex.needsUpdate = true; return; } f(); setTimeout(run, 0); };
  if (typeof setTimeout === "function") setTimeout(run, 0); else { while (jobs.length) jobs.shift()!(); }
  return _wtex;
}
export interface WaterOpts { clarity?: number; foamScale?: number; ripple?: number; lace?: number; glow?: number; /** alpha at the waterline (clear shallows) */ alpha0?: number; shallow?: string; mid?: string; deep?: string; env?: number;
  /** BED mode: the sandy bed is rendered INSIDE the water (refracted by depth, per-channel absorption exp(−σ·d) toward the
   *  scattered colour, animated caustics) → clear turquoise shallows over sand, a blue channel; opaque except the
   *  last ~0.2 m at the shore (the real sand / terrain shows through) */
  bed?: { map: Promise<{ map: THREE.Texture }>; /** linear rgb multiplier (may exceed 1: desaturates the golden sand to cream) */ tint?: [number, number, number]; scale?: number }; sigma?: [number, number, number]; scatter?: string; caustics?: number;
  /** crisp foam rings + wakes round rocks from a baked distance field (bakeRockDist) */
  rocks?: { tex: THREE.Texture; box: [number, number, number, number] };
  /** falls impacts [x, z, radius] (≤ 4): animated radial foam rings spreading over the pool */
  impacts?: Array<[number, number, number]>;
  /** the terrain heights PER PIXEL: the water's field texture
   *  (R = the terrain's 2 m samples, uv = xz·st.x + st.y — ctx.shared "water" uniforms wtrField / wtrFieldST), read with
   *  the terrain's own triangle rule → the waterline, its soft edge and its foam sit exactly where the drawn bank crosses
   *  the surface (the per-vertex depth on 1.4-1.6 m ribbon cells drew it as a sawtooth that floated off the bank) */
  ground?: { tex: { value: THREE.Texture | null }; st: { value: THREE.Vector2 } };
  /** the geometry carries a `wfade` attribute (alpha × 0..1: ribbon ends / lateral edges) */
  fade?: boolean }
/**
 * Water as a lit MeshStandardMaterial (so it takes the sun, CSM shadows, the sky environment reflection and atmos
 * fog like everything else) with the stylized body injected: depth-graded colour, flow-mapped ripple normals, foam.
 * A share of the body colour is emissive (light scattered inside the water) so shadowed water stays turquoise.
 * Detail comes from the baked tile (waterDetailTex) sampled at two flow phases × two scales.
 */
export function waterMaterial(o: WaterOpts = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.06, metalness: 0, transparent: true, depthWrite: false, envMapIntensity: o.env ?? 1.1 });
  const uniforms = {
    uTime: waterTime, uShallow: { value: o.shallow ? new THREE.Color(o.shallow) : WATER.shallow }, uMid: { value: o.mid ? new THREE.Color(o.mid) : WATER.mid }, uDeep: { value: o.deep ? new THREE.Color(o.deep) : WATER.deep },
    uFoamC: { value: WATER.foam }, uClarity: { value: o.clarity ?? 1 }, uFoamScale: { value: o.foamScale ?? 1 },
    uRipple: { value: o.ripple ?? 1 }, uLace: { value: o.lace ?? 1 }, uGlow: { value: o.glow ?? 0.7 }, uWT: { value: waterDetailTex() }, uA0: { value: o.alpha0 ?? 0.55 },
    uBed: { value: null as THREE.Texture | null }, uBedTint: { value: new THREE.Vector3(...(o.bed?.tint ?? [1, 1, 1])) }, uBedScale: { value: 1 / (o.bed?.scale ?? 3) },
    uSigma: { value: new THREE.Vector3(...(o.sigma ?? [0.95, 0.32, 0.2])) }, uScatter: { value: new THREE.Color(o.scatter ?? "#0f6f9a") }, uCaus: { value: o.caustics ?? 1.1 },
    uImp: { value: Array.from({ length: 4 }, (_, i) => new THREE.Vector3(...(o.impacts?.[i] ?? [0, 0, -1]))) },
    uRockDist: { value: o.rocks?.tex ?? null }, uRockBox: { value: o.rocks ? new THREE.Vector4(o.rocks.box[0], o.rocks.box[1], 1 / o.rocks.box[2], 1 / o.rocks.box[3]) : new THREE.Vector4() },
    uGround: o.ground?.tex ?? { value: null as THREE.Texture | null }, uGroundST: o.ground?.st ?? { value: new THREE.Vector2() },
  };
  o.bed?.map.then((b) => { uniforms.uBed.value = b.map; });
  m.userData.water = uniforms;
  const shallowC = o.bed ? new THREE.Color("#5ee2dc") : (o.shallow ? new THREE.Color(o.shallow) : WATER.shallow);
  const midC = o.bed ? new THREE.Color(o.scatter ?? "#00829c").lerp(WATER.mid, 0.52) : (o.mid ? new THREE.Color(o.mid) : WATER.mid);
  const deepC = o.bed ? new THREE.Color(o.scatter ?? "#00829c").lerp(WATER.deep, 0.45) : (o.deep ? new THREE.Color(o.deep) : WATER.deep);
  m.userData.farWater = {
    kind: "surface",
    shallow: [shallowC.r, shallowC.g, shallowC.b],
    mid: [midC.r, midC.g, midC.b],
    deep: [deepC.r, deepC.g, deepC.b],
    foam: [0.92, 0.98, 1.0],
    clarity: o.clarity ?? 1,
    foamScale: o.foamScale ?? 1,
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.defines = sh.defines || {};
    if (o.bed) sh.defines.W_BED = 1;
    if (o.rocks) sh.defines.W_ROCKS = 1;
    if (o.impacts?.length) sh.defines.W_IMPACTS = 1;
    if (o.ground) sh.defines.W_GROUND = 1;
    if (o.fade) sh.defines.W_FADE = 1;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float depth; attribute float foam; attribute vec2 flow; varying vec3 vWWp; varying float vWDepth; varying float vWFoam; varying vec2 vWFlow;\n#ifdef W_FADE\nattribute float wfade; varying float vWFade;\n#endif")
      .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\n vWWp = (modelMatrix * vec4(transformed, 1.0)).xyz; vWDepth = depth; vWFoam = foam; vWFlow = flow;\n#ifdef W_FADE\n vWFade = wfade;\n#endif");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform float uTime, uClarity, uFoamScale, uRipple, uLace, uGlow, uA0, uBedScale, uCaus; uniform vec3 uShallow, uMid, uDeep, uFoamC, uBedTint, uSigma, uScatter; uniform sampler2D uWT, uBed, uRockDist; uniform vec4 uRockBox; uniform vec3 uImp[4];
        varying vec3 vWWp; varying float vWDepth; varying float vWFoam; varying vec2 vWFlow;
        #ifdef W_FADE
        varying float vWFade;
        #endif
        #ifdef W_GROUND
        uniform highp sampler2D uGround; uniform vec2 uGroundST;
        // the DRAWN terrain height at xz: the 2 m samples (texel centres) interpolated with Terrain.height()'s own diagonal
        // rule (even global cell parity: (i,j)–(i+1,j+1), odd: (i,j+1)–(i+1,j)) — the triangles the terrain draws within
        // ~80 m (terrain lod.ts NEAR_FULL)
        float wGroundH(vec2 xz) {
          vec2 f = (xz * uGroundST.x + uGroundST.y) * vec2(textureSize(uGround, 0)) - 0.5;
          vec2 c = floor(f); vec2 t = f - c; ivec2 ci = ivec2(c);
          float h00 = texelFetch(uGround, ci, 0).r, h01 = texelFetch(uGround, ci + ivec2(1, 0), 0).r;
          float h10 = texelFetch(uGround, ci + ivec2(0, 1), 0).r, h11 = texelFetch(uGround, ci + ivec2(1, 1), 0).r;
          if (((ci.x + ci.y) & 1) == 0) return t.x >= t.y ? h00 + (h01 - h00) * t.x + (h11 - h01) * t.y : h00 + (h10 - h00) * t.y + (h11 - h10) * t.x;
          return t.x + t.y <= 1.0 ? h00 + (h01 - h00) * t.x + (h10 - h00) * t.y : h11 + (h10 - h11) * (1.0 - t.x) + (h01 - h11) * (1.0 - t.y);
        }
        #endif
        vec3 wN; float wFoam; vec3 wBody;
        ${NOISE}`)
      .replace("#include <map_fragment>", `#include <map_fragment>
        {
          vec2 p = vWWp.xz; float spd = length(vWFlow);
          float ph0 = fract(uTime * 0.18), ph1 = fract(uTime * 0.18 + 0.5), bw = abs(ph0 - 0.5) * 2.0;
          vec2 o0 = vWFlow * ph0 * 5.5, o1 = vWFlow * ph1 * 5.5, adv = o0 * (1.0 - bw) + o1 * bw;
          vec2 still = vec2(uTime * 0.06, uTime * 0.045);
          vec2 q0 = (p - o0 + still) / ${WATER_TILE.toFixed(1)}, q1 = (p - o1 + still + 7.3) / ${WATER_TILE.toFixed(1)};
          vec4 A0 = texture2D(uWT, q0), A1 = texture2D(uWT, q1);
          vec4 B0 = texture2D(uWT, q0 * 3.7 + 0.31), B1 = texture2D(uWT, q1 * 3.7 + 0.31);
          vec2 g = mix(A0.rg, A1.rg, bw) * 2.0 - 1.0 + (mix(B0.rg, B1.rg, bw) * 2.0 - 1.0) * 0.7;
          float amp = (0.55 + 1.5 * min(spd, 1.5)) * uRipple;
          wN = normalize(vec3(-g.x * 0.42 * amp, 1.0, -g.y * 0.42 * amp));
          // dE: the water depth at THIS pixel — exact against the drawn bank with W_GROUND (the edge, its alpha + foam), else
          // the per-vertex depth; the colour keeps the vertex profile (the ribbon's deepened channel) away from the edge
          #ifdef W_GROUND
          // (min with the vertex depth + 2 m: a surface's own masks stay — the pool's weir cut, where its ground sampler
          //  returns a wall, never shows the higher pool water over the river valley)
          float dE = min(vWWp.y - wGroundH(p), vWDepth + 2.0);
          float d = max(mix(dE, vWDepth, smoothstep(0.25, 0.9, min(dE, vWDepth))), 0.0);
          #else
          float dE = vWDepth;
          float d = max(vWDepth, 0.0);
          #endif
          vec3 col = mix(uShallow, uMid, smoothstep(0.05, 1.3 * uClarity, d));
          col = mix(col, uDeep, smoothstep(1.5 * uClarity, 5.5 * uClarity, d));
          // caustic light: soft, wobbling cell edges (~1.6 m cells), strongest in the shallows
          float laceE = texture2D(uWT, (p - adv * 0.4) / 26.0 + vec2(A0.b - 0.5, A1.b - 0.5) * 0.035).a;
          float lace = 1.0 - smoothstep(0.02, 0.2, laceE);
          col += vec3(0.5, 0.62, 0.5) * lace * (1.0 - smoothstep(0.15, 1.6, d)) * 0.045 * uLace;
          col *= 0.92 + 0.16 * texture2D(uWT, p / 190.0).b;
          wBody = col;
          #ifdef W_BED
          {
            vec3 V = normalize(vWWp - cameraPosition);
            vec2 bp = p + V.xz / max(0.3, -V.y) * d * 0.7 + g * 0.06 * min(d, 2.0);          // refracted bed point, wobbling
            vec3 bed = texture2D(uBed, bp * uBedScale).rgb * uBedTint;
            bed *= 0.84 + 0.3 * texture2D(uWT, bp / 17.0).b;                                   // pebbly patches
            // caustics: the zero-isolines of two drifting gradient-noise fields (curvy closed loops, never straight Worley
            // polygons), sharpened to thin bright threads, bent by the surface ripples; brightest where the two nets cross
            vec2 cw = bp * 0.62 + g * 0.18;
            cw += (vec2(texture2D(uWT, cw / 7.0 + vec2(uTime * 0.011, 0.0)).b, texture2D(uWT, cw / 7.0 + vec2(0.37, -uTime * 0.012)).b) - 0.5) * 1.1;
            float k1 = 1.0 - abs(n2(cw * 1.15 + vec2(uTime * 0.21, uTime * 0.13)));
            float k2 = 1.0 - abs(n2(cw * 1.6 + vec2(-uTime * 0.17, uTime * 0.19) + 5.1));
            float caus = pow(k1, 14.0) * 0.8 + pow(k2, 18.0) * 0.55 + pow(k1 * k2, 10.0) * 0.9;
            caus *= 0.55 + 0.45 * smoothstep(0.3, 0.7, texture2D(uWT, bp / 31.0 + vec2(uTime * 0.004, 0.0)).b + 0.1);   // patchy
            caus *= smoothstep(0.05, 0.45, d) * (1.0 - smoothstep(1.2, 3.6, d));
            caus *= 1.0 - smoothstep(0.35, 1.0, length(fwidth(cw)) * 1.6);   // fade out where the threads would alias (far)
            bed *= 1.0 + caus * uCaus;
            vec3 T = exp(-uSigma * d);
            col = bed * T + uScatter * (1.0 - T);
            wBody = uScatter * (1.0 - T) * 1.4 + bed * T * 0.18;
          }
          #endif
          float fn = mix(A0.b, A1.b, bw) - 0.5 + 0.35 * (mix(B0.b, B1.b, bw) - 0.5);
          float shore = 1.0 - smoothstep(0.0, 0.16, max(dE, 0.0));
          float baked = vWFoam * uFoamScale;
          float laceN = 1.0 - smoothstep(0.02, 0.18, texture2D(uWT, (p - adv * 1.2) / 12.0 + vec2(A0.b, A1.b) * 0.04).a);
          wFoam = clamp(shore * smoothstep(-0.05, 0.35, fn) * 0.8 + smoothstep(0.25, 1.0, baked) * mix(0.55 + 0.45 * laceN, 1.0, smoothstep(0.5, 0.9, baked)) * smoothstep(-0.35, 0.35, fn + baked * 0.5 - 0.1), 0.0, 1.0);
          // foam streaks stretched along the flow in fast water
          vec2 fd = normalize(vWFlow + 1e-4);
          float streaks = smoothstep(0.55, 0.8, texture2D(uWT, vec2(dot(p - adv * 2.2, vec2(fd.y, -fd.x)) * 0.09, dot(p - adv * 2.2, fd) * 0.012)).b);
          wFoam = max(wFoam, streaks * smoothstep(2.0, 3.2, spd) * 0.45);
          #ifdef W_ROCKS
          { vec2 ru = (p - uRockBox.xy) * uRockBox.zw; vec2 fdir = normalize(vWFlow + 1e-4);
            float rd = texture2D(uRockDist, ru).r * 6.0, rw = texture2D(uRockDist, ru - fdir * uRockBox.zw * 2.4).r * 6.0;
            float fnr = texture2D(uWT, (p - adv * 0.8) / 3.1).b;                   // fine breakup (3 m tile)
            float rw0 = 0.07 + 0.2 * fnr;                                            // ragged contact ring 0.07–0.27 m
            float ring = 1.0 - smoothstep(rw0 * 0.5, rw0, rd);
            // broken foam patches just outside the ring, thinning out by ~0.8 m (no lace web)
            float halo = (1.0 - smoothstep(0.0, 0.7, rd)) * smoothstep(0.6, 0.72, fnr + 0.22 * (1.0 - rd));
            // a short streaky wake downstream
            float wake = (1.0 - smoothstep(0.05, 0.7, rw)) * smoothstep(0.2, 0.8, rd) * smoothstep(0.3, 1.1, spd) * streaks;
            float rf = max(ring, max(halo * 0.9, wake * 0.8));
            wFoam = max(wFoam, smoothstep(0.3, 0.55, rf) * smoothstep(0.02, 0.12, d)); }
          #endif
          #ifdef W_IMPACTS
          for (int i = 0; i < 4; i++) { if (uImp[i].z < 0.0) continue;
            float r = length(p - uImp[i].xy) / uImp[i].z;                       // 0 at the impact, 1 at its reach
            float rings = smoothstep(0.55, 0.95, sin(r * 11.0 - uTime * 3.2 + fn * 2.5) * 0.5 + 0.5);
            float churn = 1.0 - smoothstep(0.0, 0.42, r);
            wFoam = max(wFoam, clamp(churn * (0.75 + 0.25 * laceN) + rings * (1.0 - smoothstep(0.35, 1.0, r)) * smoothstep(0.2, 0.4, r) * 0.8 * laceN, 0.0, 1.0)); }
          #endif
          #ifdef W_GROUND
          // a thin broken contact line right where the drawn bank enters the water (≥ ~1.5 px wide at any
          // distance: its depth band widens with the pixel footprint)
          float cw = max(0.035, 1.6 * fwidth(dE));
          wFoam = max(wFoam, (1.0 - smoothstep(cw * 0.3, cw, dE)) * smoothstep(-0.1, 0.2, fn + 0.35 * laceN) * 0.6);
          #endif
          diffuseColor.rgb = mix(col, uFoamC, wFoam);
          float alpha = mix(uA0, 0.93, smoothstep(0.0, 2.6 * uClarity, d));
          #ifdef W_BED
          alpha = smoothstep(0.0, 0.2, max(dE, 0.0));
          #endif
          #ifdef W_GROUND
          // the soft intersection by the TRUE depth: the water (and its contact line) starts exactly at the bank
          // and fades in over its first centimetres — never a vertex-interpolated cut standing off the bank
          alpha = max(alpha, wFoam * 0.97) * smoothstep(-0.002, 0.012, dE);
          #else
          alpha = max(alpha, wFoam * 0.97) * smoothstep(-0.05, 0.1, vWDepth);
          #endif
          #ifdef W_FADE
          alpha *= vWFade;
          #ifdef W_GROUND
          // (a river's mouth) the sea water takes over from ITS waterline: where the bed is below sea level the sea's
          // surface is drawn at the same level (the river ends at it) — the river's mint melts into the sea over its first
          // ~1.4 m of depth (several metres of shallows): no step, no dry strip, no seam
          alpha *= 1.0 - smoothstep(0.0, 1.4, -wGroundH(p));
          #endif
          #endif
          diffuseColor.a = alpha;
        }`)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n roughnessFactor = mix(0.05, 0.75, wFoam);")
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);")
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n totalEmissiveRadiance += wBody * uGlow * (1.0 - wFoam) + uFoamC * wFoam * 0.32;");
  };
  m.customProgramCacheKey = () => `jungle-water-v10|${o.bed ? 1 : 0}|${o.rocks ? 1 : 0}|${o.impacts?.length ? 1 : 0}|${o.ground ? 1 : 0}|${o.fade ? 1 : 0}`;
  return m;
}

/** a distance field (metres to the nearest rock WATERLINE, 0..6 m → 0..1) over a world box, for the water's foam rings.
 *  With `section` (the rock's real mesh + the water level at it) the outline is the mesh's actual cross-section at the
 *  water plane (a 48-bin radial profile: rocks are star-shaped about their centre) — the ring hugs the visible rock
 *  instead of an ellipse around its widest extent; rocks that do not cross the surface make no ring. */
export function bakeRockDist(rocks: Array<{ x: number; y?: number; z: number; sx: number; sy?: number; sz: number; ry: number; seed?: number }>, box: [number, number, number, number], W = 1024, H = 512,
  section?: { geo: (r: { seed?: number }) => THREE.BufferGeometry; level: (x: number, z: number) => number }): THREE.DataTexture {
  const [x0, z0, w, h] = box, data = new Uint8Array(W * H).fill(255), cell = 8, near = new Map<number, number[]>();
  const NB = 48, prof: Array<Float32Array | null> = rocks.map(() => null);
  if (section) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    rocks.forEach((r, ri) => {
      const g = section.geo(r), P = g.attributes.position as THREE.BufferAttribute, ix = g.index!.array, L = section.level(r.x, r.z);
      m.compose(new THREE.Vector3(r.x, r.y ?? 0, r.z), q.setFromEuler(e.set(0, r.ry, 0)), new THREE.Vector3(r.sx, r.sy ?? 1, r.sz));
      const R = new Float32Array(NB).fill(-1); let hit = false;
      const put = (x: number, z: number) => { const dx = x - r.x, dz = z - r.z, ang = Math.atan2(dz, dx), k = ((Math.round(ang / (Math.PI * 2) * NB) % NB) + NB) % NB; R[k] = Math.max(R[k], Math.hypot(dx, dz)); hit = true; };
      for (let t = 0; t < ix.length; t += 3) {
        a.fromBufferAttribute(P, ix[t]).applyMatrix4(m); b.fromBufferAttribute(P, ix[t + 1]).applyMatrix4(m); c.fromBufferAttribute(P, ix[t + 2]).applyMatrix4(m);
        const vs = [a, b, c];
        for (let k = 0; k < 3; k++) { const u = vs[k], v = vs[(k + 1) % 3]; if ((u.y - L) * (v.y - L) > 0 || u.y === v.y) continue; const f = (L - u.y) / (v.y - u.y); put(u.x + (v.x - u.x) * f, u.z + (v.z - u.z) * f); }
      }
      if (!hit) return;
      // fill empty bins from their neighbours (coarse meshes leave gaps), then a light smoothing pass
      for (let pass = 0; pass < NB; pass++) { let any = false; for (let k = 0; k < NB; k++) if (R[k] < 0) { const l = R[(k + NB - 1) % NB], rr = R[(k + 1) % NB]; if (l >= 0 || rr >= 0) { R[k] = Math.max(l, rr); any = true; } } if (!any) break; }
      prof[ri] = R;
    });
  }
  rocks.forEach((r, i) => { if (section && !prof[i]) return; const R = Math.max(r.sx, r.sz) + 6; for (let cx = Math.floor((r.x - R) / cell); cx <= Math.floor((r.x + R) / cell); cx++) for (let cz = Math.floor((r.z - R) / cell); cz <= Math.floor((r.z + R) / cell); cz++) { const k = cx * 10007 +
 cz; let l = near.get(k); if (!l) near.set(k, (l = [])); l.push(i); } });
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const x = x0 + (i + 0.5) / W * w, z = z0 + (j + 0.5) / H * h, l = near.get(Math.floor(x / cell) * 10007 + Math.floor(z / cell)); if (!l) continue;
    let d = 6;
    for (const k of l) { const r = rocks[k], pr = prof[k];
      if (pr) { const dx = x - r.x, dz = z - r.z, rad = Math.hypot(dx, dz); if (rad - Math.max(r.sx, r.sz) * 1.3 > d) continue;
        const fa = ((Math.atan2(dz, dx) / (Math.PI * 2) * NB) % NB + NB) % NB, k0 = Math.floor(fa), t = fa - k0, Rb = pr[k0 % NB] * (1 - t) + pr[(k0 + 1) % NB] * t;
        d = Math.min(d, rad - Rb); continue; }
      const c = Math.cos(r.ry), sn = Math.sin(r.ry), dx = x - r.x, dz = z - r.z, lx = dx * c - dz * sn, lz = dx * sn + dz * c;
      const q = Math.hypot(lx / (r.sx * 0.9), lz / (r.sz * 0.9)); d = Math.min(d, (q - 1) * Math.min(r.sx, r.sz) * 0.9); }
    data[j * W + i] = Math.round(Math.min(1, Math.max(0, d / 6)) * 255);
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
  return t;
}

/** attributes for a water surface: `depth` from the ground sampler, `foam` 0..1, `flow` metres/second (xz) */
function waterAttrs(g: THREE.BufferGeometry, ground: (x: number, z: number) => number, level: (i: number) => number, foamAt?: (x: number, z: number) => number, flowAt?: (x: number, z: number, i: number) => [number, number]) {
  const pos = g.attributes.position as THREE.BufferAttribute, n = pos.count;
  const depth = new Float32Array(n), foam = new Float32Array(n), flow = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i), z = pos.getZ(i), y = level(i);
    pos.setY(i, y);
    depth[i] = y - ground(x, z);
    foam[i] = foamAt ? foamAt(x, z) : 0;
    const f = flowAt ? flowAt(x, z, i) : [0, 0]; flow[i * 2] = f[0]; flow[i * 2 + 1] = f[1];
  }
  g.setAttribute("depth", new THREE.BufferAttribute(depth, 1));
  g.setAttribute("foam", new THREE.BufferAttribute(foam, 1));
  g.setAttribute("flow", new THREE.BufferAttribute(flow, 2));
  g.computeBoundingSphere(); g.computeBoundingBox();
}

/** a flat water disc/ellipse (pool) at `level` */
export function poolSurface(cx: number, cz: number, rx: number, rz: number, level: number, ground: (x: number, z: number) => number, mat: THREE.Material, o: { seg?: number; foamAt?: (x: number, z: number) => number; flowAt?: (x: number, z: number) => [number, number] } = {}): THREE.Mesh {
  const seg = o.seg ?? 96;
  const g = new THREE.PlaneGeometry(rx * 2, rz * 2, seg, seg); g.rotateX(-Math.PI / 2);
  const pos = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) { let x = pos.getX(i), z = pos.getZ(i); const d = Math.hypot(x / rx, z / rz); if (d > 1) { x /= d; z /= d; } pos.setXYZ(i, x + cx, level, z + cz); }
  waterAttrs(g, ground, () => level, o.foamAt, o.flowAt ? (x, z) => o.flowAt!(x, z) : undefined);
  const m = new THREE.Mesh(g, mat); m.name = "jungle-water"; m.renderOrder = 2; m.matrixAutoUpdate = false; m.updateMatrix();
  m.userData.castShadow = false; m.castShadow = false; m.receiveShadow = false;
  return m;
}

/** a river ribbon along a centreline: level per centre point (monotonic), half width per point, flow along the tangent */
export function riverSurface(pts: Array<[number, number]>, levels: number[], halfW: number[], ground: (x: number, z: number) => number, mat: THREE.Material, o: { across?: number; step?: number; speed?: (t: number) => number; foamAt?: (x: number, z: number) => number; /** foam from the level drop (rapids), default 0.9 */ rapids?: number; /** visual depth profile: deeper mid-channel, shallow sandy margins */ deepen?: boolean; /** split into ~chunk-metre meshes */ chunk?: number;
  /** a `wfade` attribute (material `fade: true`): alpha fades in over the first [0] m, out over the last [1] m
   *  (where the sea takes over at the mouth) and over the last 12 % of the half width (no straight cut in mid-air where a
   *  bank lies beyond the ribbon) */ fadeEnds?: [number, number] } = {}): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, "centripetal");
  const L = curve.getLength(), nAlong = Math.max(8, Math.round(L / (o.step ?? 1.5))), nAcross = o.across ?? 24;
  // cumulative length at control points → interpolate level/width by arc length
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const at = (arr: number[], s: number) => { const S = s * cum[cum.length - 1]; let k = 0; while (k < cum.length - 2 && cum[k + 1] < S) k++; const t = Math.min(1, Math.max(0, (S - cum[k]) / (cum[k + 1] - cum[k] || 1))); const u = t * t * (3 - 2 * t); return arr[k] + (arr[k + 1] - arr[k]) * u; };
  const pos: number[] = [], lev: number[] = [], flowT: Array<[number, number, number]> = [], idx: number[] = [], across: number[] = [], fade: number[] = [];
  const sm = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const P = new THREE.Vector3(), T = new THREE.Vector3();
  for (let i = 0; i <= nAlong; i++) {
    const s = i / nAlong; curve.getPointAt(s, P); curve.getTangentAt(s, T);
    const nx = -T.z, nz = T.x, hw = at(halfW, s), lv = at(levels, s);
    // speed ∝ slope of the level profile (rapids where the river drops)
    const ds = 1 / nAlong, slope = (at(levels, Math.max(0, s - ds)) - at(levels, Math.min(1, s + ds))) / (2 * ds * L);
    const spd = (o.speed ? o.speed(s) : 0.6) + Math.min(2.2, slope * 26);
    for (let j = 0; j <= nAcross; j++) {
      const a = j / nAcross * 2 - 1, edge = 1 - a * a * 0.35;
      pos.push(P.x + nx * hw * a, lv, P.z + nz * hw * a); lev.push(lv); flowT.push([T.x * spd * edge, T.z * spd * edge, Math.min(1, Math.max(0, slope * 9 - 0.25))]); across.push(a);
      if (o.fadeEnds) fade.push((o.fadeEnds[0] > 0 ? sm(0, o.fadeEnds[0], s * L) : 1) * (o.fadeEnds[1] > 0 ? sm(0, o.fadeEnds[1], (1 - s) * L) : 1) * (1 - sm(0.88, 1.0, Math.abs(a))));
    }
    if (i < nAlong) for (let j = 0; j < nAcross; j++) { const a = i * (nAcross + 1) + j, b = a + nAcross + 1; idx.push(a, a + 1, b, a + 1, b + 1, b); } // CCW seen from above (+Y normal) — not face-down (culled)
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  g.setAttribute("normal", new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  waterAttrs(g, ground, (i) => lev[i], (x, z) => Math.min(1, (o.foamAt ? o.foamAt(x, z) : 0)), (_x, _z, i) => [flowT[i][0], flowT[i][1]]);
  if (o.fadeEnds) g.setAttribute("wfade", new THREE.Float32BufferAttribute(fade, 1));
  // rapids foam: add the slope term
  const foam = g.attributes.foam as THREE.BufferAttribute; for (let i = 0; i < foam.count; i++) foam.setX(i, Math.min(1, foam.getX(i) + flowT[i][2] * (o.rapids ?? 0.9)));
  if (o.deepen) { // the bed under a real river is a trough: shade as if the middle were ~2.5x deeper than the margins
    const dep = g.attributes.depth as THREE.BufferAttribute;
    for (let i = 0; i < dep.count; i++) { const a = across[i], k = 0.55 + 2.2 * (1 - a * a) ** 1.5; dep.setX(i, dep.getX(i) > 0 ? dep.getX(i) * k : dep.getX(i)); }
  }
  const m = new THREE.Mesh(g, mat); m.name = "jungle-river"; m.renderOrder = 2; m.matrixAutoUpdate = false; m.updateMatrix();
  m.userData.castShadow = false; m.castShadow = false; m.receiveShadow = false;
  if (!o.chunk) return m;
  // split into chunks of ~o.chunk metres along the river: each its own draw + bounding sphere → off-screen reaches cull
  const grp = new THREE.Group(); grp.name = "jungle-river";
  const rows = nAlong + 1, per = Math.max(2, Math.round(o.chunk / (L / nAlong))), idxAll = g.index!.array as Uint32Array | Uint16Array;
  for (let r0 = 0; r0 < rows - 1; r0 += per) {
    const r1 = Math.min(rows - 1, r0 + per), vA = r0 * (nAcross + 1), vB = (r1 + 1) * (nAcross + 1), sub = new THREE.BufferGeometry();
    for (const [k, a] of Object.entries(g.attributes)) { const at = a as THREE.BufferAttribute; sub.setAttribute(k, new THREE.BufferAttribute((at.array as Float32Array).slice(vA * at.itemSize, vB * at.itemSize), at.itemSize)); }
    const ix: number[] = []; for (let t = r0 * nAcross * 6; t < r1 * nAcross * 6; t++) ix.push(idxAll[t] - vA);
    sub.setIndex(ix); sub.computeBoundingSphere(); sub.computeBoundingBox();
    const cm = new THREE.Mesh(sub, mat); cm.name = "jungle-river-chunk"; cm.renderOrder = 2; cm.matrixAutoUpdate = false; cm.updateMatrix(); cm.userData.castShadow = false; cm.castShadow = false;
    grp.add(cm);
  }
  g.dispose();
  return grp as unknown as THREE.Mesh;
}

// ---------------------------------------------------------------- waterfall
/** tileable vertical streak mask (R = streak intensity): distinct ropes of aerated water with dark gaps between them,
 *  foam clumps riding down them, a few fine droplet trails. `lighten` compositing keeps the gaps dark (no white-out). */
let _streak: THREE.CanvasTexture | null = null;
export function streakTex(): THREE.CanvasTexture {
  if (_streak) return _streak;
  _streak = canvasTex(256, 512, (g, w, h) => {
    g.fillStyle = "#000"; g.fillRect(0, 0, w, h);
    const rnd = mulberry(4242);
    g.globalCompositeOperation = "lighten";
    const rope = (x: number, y: number, len: number, wd: number, a: number) => {
      for (const dx of [-w, 0, w]) for (const dy of [-h, 0, h]) {
        const grd = g.createLinearGradient(0, y + dy, 0, y + dy + len);
        grd.addColorStop(0, "rgba(255,255,255,0)"); grd.addColorStop(0.15, `rgba(255,255,255,${a})`); grd.addColorStop(0.8, `rgba(255,255,255,${a * 0.85})`); grd.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = grd; g.beginPath(); g.ellipse(x + dx, y + dy + len / 2, wd, len / 2, 0, 0, Math.PI * 2); g.fill();
      }
    };
    for (let i = 0; i < 17; i++) rope(rnd() * w, rnd() * h, 140 + rnd() * 360, 3 + rnd() * 6, 0.6 + rnd() * 0.4);    // main ropes
    for (let i = 0; i < 40; i++) rope(rnd() * w, rnd() * h, 60 + rnd() * 200, 1.0 + rnd() * 1.8, 0.4 + rnd() * 0.5); // fine strands
    for (let i = 0; i < 60; i++) { const x = rnd() * w, y = rnd() * h, r = 2 + rnd() * 6; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, `rgba(255,255,255,${0.7 + rnd() * 0.3})`); gr.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, r, r * 1.8, 0, 0, 7); g.fill(); } // foam clumps
  }, { srgb: false });
  return _streak;
}

export function fallsMaterial(opacity = 1): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: waterTime, uSun: waterSun, uStreak: { value: streakTex() }, uThin: { value: new THREE.Color("#5fb8cf") }, uGlass: { value: new THREE.Color("#2e9e9a") }, uOpacity: { value: opacity } },
    vertexShader: /* glsl */ `
      attribute float len; attribute float wid; attribute float fseed; attribute float fall;
      varying vec2 vUv; varying vec3 vN; varying vec3 vWp; varying float vLen; varying float vWid; varying float vSeed; varying float vFall;
      void main(){ vUv = uv; vLen = len; vWid = wid; vSeed = fseed; vFall = fall; vec4 wp = modelMatrix * vec4(position, 1.0); vWp = wp.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */ `
      uniform float uTime, uOpacity; uniform vec3 uSun, uThin, uGlass; uniform sampler2D uStreak;
      varying vec2 vUv; varying vec3 vN; varying vec3 vWp; varying float vLen; varying float vWid; varying float vSeed; varying float vFall;
      ${NOISE}
      void main(){
        float v = vUv.y, s = v * vLen, f = clamp(vFall, 0.0, 1.0);
        float sp = 2.5 + 11.0 * sqrt(f);                          // accelerating: slow over the lip, fast low down
        float a1 = texture2D(uStreak, vec2(vUv.x * vWid / 8.0 + vSeed, (s - uTime * sp) / 16.0)).r;
        float a2 = texture2D(uStreak, vec2(vUv.x * vWid / 3.2 + 0.37 + vSeed, (s - uTime * sp * 1.3) / 7.0)).r;
        float a3 = texture2D(uStreak, vec2(vUv.x * vWid / 20.0 + 0.71 + vSeed, (s - uTime * sp * 0.85) / 30.0)).r;
        float streak = smoothstep(0.12, 0.8, max(max(a1, a3 * 0.9), a2 * 0.8));
        // ragged edges: strands peel off the sides (the thin streak layer is the alpha there), width breathes
        float ed = min(vUv.x, 1.0 - vUv.x);
        float rag = 0.5 + 0.5 * n2(vec2(vUv.x * 4.0 + vSeed * 9.0, (s - uTime * sp * 0.6) * 0.18));
        float edgeW = 0.06 + 0.2 * rag * (0.35 + f);
        float edge = smoothstep(0.0, edgeW, ed);
        float strands = smoothstep(0.25, 0.7, a2 + a1 * 0.4);
        edge = max(edge, strands * smoothstep(0.0, edgeW * 0.35, ed) * 0.85);
        float core = smoothstep(0.08, 0.35, ed);
        float holes = smoothstep(0.35, 0.75, n2(vec2(vUv.x * vWid * 0.25 + vSeed * 4.0, (s - uTime * sp * 0.9) * 0.06)));
        // aeration: glassy over the lip, turning white as it falls; thin (non-streak) water stays blue + translucent
        float aer = clamp(streak * (0.85 + 0.35 * f) + smoothstep(0.3, 0.9, f) * 0.45, 0.0, 1.0);
        float glass = 1.0 - smoothstep(0.0, 0.07, f);
        float alpha = mix(0.32 + 0.66 * aer, 0.8, glass) * (1.0 - 0.5 * holes * (1.0 - glass) * (1.0 - aer));
        alpha *= edge * uOpacity;
        // the sheet emerges from the feeding water (fades in over the approach, ragged) and dissolves into the mist at the base
        float emerge = smoothstep(-0.95, -0.25, vFall + 0.25 * (n2(vec2(vUv.x * 7.0 + vSeed * 5.0, uTime * 0.4)) ));
        alpha *= emerge * (1.0 - smoothstep(0.84, 1.0, v));
        vec3 n = normalize(vN); vec3 L = normalize(uSun); vec3 V = normalize(cameraPosition - vWp);
        if (dot(n, V) < 0.0) n = -n;
        float sun = max(dot(n, L), 0.0), back = pow(max(dot(-V, L), 0.0), 3.0);
        float lit = 0.72 + 0.38 * sun + 0.45 * back;
        vec3 white = vec3(1.0, 1.0, 0.98), thin = mix(uThin, white, 0.3);
        vec3 col = mix(thin * 0.82, white, aer) * lit;
        col = mix(col, (uGlass * (0.75 + 0.45 * sun) + vec3(0.55) * smoothstep(0.55, 0.9, a2)) , glass * 0.8);
        col = mix(col, thin * lit * 0.95, (1.0 - core) * 0.3 * (1.0 - glass));
        float fres = pow(1.0 - abs(dot(n, V)), 3.0);
        col += vec3(0.25, 0.35, 0.45) * fres * 0.35;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  if (opacity >= 0.8) {
    const gC = new THREE.Color("#2e9e9a"), mC = new THREE.Color("#7ecce0"), fC = new THREE.Color("#eef8fc");
    m.userData.farWater = { kind: "falls", glass: [gC.r, gC.g, gC.b], mid: [mC.r, mC.g, mC.b], foam: [fC.r, fC.g, fC.b] };
  }
  return m;
}

/**
 * A waterfall sheet: the feeding water runs ~2 m toward the lip, CURLS over it (quarter circle) and drops in a ballistic
 * arc to `bottomY`. `top` = lip centre (the water surface at the edge), `dir` = horizontal outflow, `v0` = exit speed;
 * `spread` widens it toward the base. uv.y 0 → 1 along the arc; `fall` attribute 0 at the lip → 1 at the base.
 */
export function fallsSheet(top: THREE.Vector3, bottomY: number, width: number, dir: THREE.Vector3, mat: THREE.Material, o: { v0?: number; spread?: number; segs?: number; seed?: number; cols?: number; curl?: number; back?: number; /** lip bulge (m) */ lip?: number } = {}): { mesh: THREE.Mesh; impact: THREE.Vector3 } {
  const v0 = o.v0 ?? 2.2, cols = o.cols ?? 16, spread = o.spread ?? 0.35, R = o.curl ?? 0.9, back = o.back ?? 2.0;
  const d = dir.clone().setY(0).normalize(), right = new THREE.Vector3(-d.z, 0, d.x);
  // profile in the (d, y) plane: approach → curl → ballistic fall
  const prof: Array<[number, number, number]> = []; // [horizontal, y, fall 0..1]
  for (let i = 0; i <= 4; i++) { const t = i / 4; prof.push([-back + back * t, top.y + 0.28 * (1 - t) * (1 - t), -1 + t]); }
  for (let i = 1; i <= 6; i++) { const a = (i / 6) * Math.PI * 0.42; prof.push([R * Math.sin(a), top.y - R * (1 - Math.cos(a)), 0]); }
  const [x0, y0] = prof[prof.length - 1], vy0 = -Math.max(1.6, v0 * 0.9), drop = y0 - bottomY;
  const tFall = (-vy0 - Math.sqrt(vy0 * vy0 + 2 * 9.8 * drop)) / -9.8;
  const segs = o.segs ?? 34;
  for (let i = 1; i <= segs; i++) { const t = tFall * (i / segs) ** 1.35; prof.push([x0 + v0 * t, y0 + vy0 * t - 4.9 * t * t, i / segs]); }
  const cum = [0]; for (let i = 1; i < prof.length; i++) cum.push(cum[i - 1] + Math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]));
  const L = cum[cum.length - 1];
  const rnd = mulberry(o.seed ?? 1), sd = rnd();
  const pos: number[] = [], uvs: number[] = [], lenA: number[] = [], widA: number[] = [], sdA: number[] = [], fallA: number[] = [], idx: number[] = [];
  // the lip is CURVED + irregular (bulging out in the middle, wobbling), never a straight pipe outlet
  const lipC = (u: number) => (o.lip ?? 0.75) * (Math.sin(Math.PI * u) * 0.8 + 0.28 * Math.sin(u * 6.3 + sd * 11) + 0.14 * Math.sin(u * 13.1 + sd * 3)), lipY = (u: number) => 0.14 * Math.sin(u * 8.7 + sd * 5) * Math.sin(Math.PI * u);
  for (let i = 0; i < prof.length; i++) {
    const [hz, y, f] = prof[i], ff = Math.max(0, f), w = width * (1 + spread * ff ** 1.2) * (f < 0 ? 0.92 : 1);
    for (let j = 0; j <= cols; j++) {
      const u = j / cols, belly = 0.35 * Math.sin(Math.PI * u) * Math.sqrt(ff) + 0.18 * Math.sin(u * 9.0 + sd * 20) * ff + lipC(u) * (f < 0 ? Math.max(0, 1 + f * 1.2) : 1);
      pos.push(top.x + right.x * (u - 0.5) * w + d.x * (hz + belly), y + lipY(u) * (1 - ff), top.z + right.z * (u - 0.5) * w + d.z * (hz + belly));
      uvs.push(u, cum[i] / L); lenA.push(L); widA.push(w); sdA.push(sd); fallA.push(f);
    }
    if (i + 1 < prof.length) for (let j = 0; j < cols; j++) { const a = i * (cols + 1) + j, b = a + cols + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("len", new THREE.Float32BufferAttribute(lenA, 1)); g.setAttribute("wid", new THREE.Float32BufferAttribute(widA, 1));
  g.setAttribute("fseed", new THREE.Float32BufferAttribute(sdA, 1)); g.setAttribute("fall", new THREE.Float32BufferAttribute(fallA, 1));
  g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
  const m = new THREE.Mesh(g, mat); m.name = "jungle-falls"; m.renderOrder = 3; m.matrixAutoUpdate = false; m.updateMatrix();
  m.userData.castShadow = false; m.castShadow = false;
  const last = prof[prof.length - 1];
  return { mesh: m, impact: new THREE.Vector3(top.x + d.x * last[0], bottomY, top.z + d.z * last[0]) };
}

/**
 * A cascade that slides down a terrain face: from `start` it marches along `dir` to the rim edge (where the ground drops
 * away), then follows the ground (0.35 m proud) down the steepest line until it reaches `bottomY`. Same shader as the
 * free-fall sheets (streaks scroll along the path).
 */
export function cascadeSheet(start: THREE.Vector3, dir: THREE.Vector3, width: number, ground: (x: number, z: number) => number, bottomY: number, mat: THREE.Material, seed = 3): { mesh: THREE.Mesh; impact: THREE.Vector3; lip: THREE.Vector3 } {
  const d = dir.clone().setY(0).normalize();
  const p = new THREE.Vector3(start.x, 0, start.z);
  let guard = 0;
  while (ground(p.x, p.z) > start.y - 0.8 && guard++ < 200) p.addScaledVector(d, 0.5);
  const lip = new THREE.Vector3(p.x, start.y, p.z);
  const path: THREE.Vector3[] = [lip.clone().addScaledVector(d, -2.5), lip.clone()];
  const q = p.clone(); let y = start.y; guard = 0;
  while (y > bottomY + 0.2 && guard++ < 400) {
    // steepest descent, biased along dir
    const e = 1.0, gx = ground(q.x + e, q.z) - ground(q.x - e, q.z), gz = ground(q.x, q.z + e) - ground(q.x, q.z - e);
    const g = new THREE.Vector2(-gx, -gz); if (g.lengthSq() < 1e-6) g.set(d.x, d.z); g.normalize();
    q.x += (g.x * 0.7 + d.x * 0.3) * 0.6; q.z += (g.y * 0.7 + d.z * 0.3) * 0.6;
    y = Math.max(bottomY, Math.min(y, ground(q.x, q.z) + 0.35));
    path.push(new THREE.Vector3(q.x, y, q.z));
  }
  const curve = new THREE.CatmullRomCurve3(path, false, "centripetal");
  const L = curve.getLength(), n = Math.max(12, Math.round(L / 0.8)), cols = 4;
  const pos: number[] = [], uvs: number[] = [], idx: number[] = [], len: number[] = [], wid: number[] = [], sd: number[] = [], fall: number[] = [];
  const P = new THREE.Vector3(), T = new THREE.Vector3(), rnd = mulberry(seed), s0 = rnd();
  for (let i = 0; i <= n; i++) {
    const t = i / n; curve.getPointAt(t, P); curve.getTangentAt(t, T);
    const side = new THREE.Vector3(-T.z, 0, T.x).normalize(), w = width * (1 + 0.5 * t);
    for (let j = 0; j <= cols; j++) { const u = j / cols; pos.push(P.x + side.x * (u - 0.5) * w, P.y, P.z + side.z * (u - 0.5) * w); uvs.push(u, t); len.push(L); wid.push(w); sd.push(s0); fall.push(Math.min(1, t * 1.6)); }
    if (i < n) for (let j = 0; j < cols; j++) { const a = i * (cols + 1) + j, b = a + cols + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("len", new THREE.Float32BufferAttribute(len, 1)); g.setAttribute("wid", new THREE.Float32BufferAttribute(wid, 1)); g.setAttribute("fseed", new THREE.Float32BufferAttribute(sd, 1)); g.setAttribute("fall", new THREE.Float32BufferAttribute(fall, 1));
  g.setIndex(idx); g.computeVertexNormals(); g.computeBoundingSphere();
  const m = new THREE.Mesh(g, mat); m.name = "jungle-cascade"; m.renderOrder = 3; m.matrixAutoUpdate = false; m.updateMatrix(); m.userData.castShadow = false;
  return { mesh: m, impact: path[path.length - 1].clone().setY(bottomY), lip };
}

// ---------------------------------------------------------------- billboard particles (spray / mist / smoke / glow / motes)
export interface PuffOpts { count: number; color?: string; size?: [number, number]; opacity?: number; rise?: number; drift?: number; spread?: [number, number, number]; life?: number; additive?: boolean; power?: number; grow?: number; lit?: boolean; dir?: [number, number, number] }
const softCache = new Map<string, THREE.CanvasTexture>();
export function softSpriteTex(inner = 0.0, power = 1.6, lumpy = 0): THREE.CanvasTexture {
  const key = `${inner}|${power}|${lumpy}`;
  let t = softCache.get(key);
  if (!t) {
    t = canvasTex(128, 128, (g, w, h) => {
      const img = g.createImageData(w, h), rnd = mulberry(77);
      const lobes = Array.from({ length: 7 }, () => [0.5 + (rnd() - 0.5) * 0.4, 0.5 + (rnd() - 0.5) * 0.4, 0.18 + rnd() * 0.16]);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const fx = (x + 0.5) / w, fy = (y + 0.5) / h, dx = fx - 0.5, dy = fy - 0.5;
        let dd = Math.min(1, Math.hypot(dx, dy) * 2);
        if (lumpy > 0) { let m = 0; for (const [lx, ly, lr] of lobes) m = Math.max(m, 1 - Math.hypot(fx - lx, fy - ly) / lr); dd = Math.min(dd, 1 - lumpy * Math.max(0, m) * (1 - dd) * 2); }
        const a = Math.pow(Math.max(0, 1 - Math.max(0, dd - inner) / (1 - inner)), power);
        const i = (y * w + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.round(a * 255);
      }
      g.putImageData(img, 0, 0);
    }, { repeat: false });
    softCache.set(key, t);
  }
  return t;
}
/** a cloud of camera-facing quads animated by time: each loops rising/drifting from its origin (no point-size limits) */
export function puffCloud(origin: THREE.Vector3, o: PuffOpts): THREE.Mesh {
  const n = o.count, rnd = mulberry(Math.round(origin.x * 7 + origin.z * 13 + n * 3 + (o.size?.[1] ?? 0) * 11));
  const base = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index; g.setAttribute("position", base.attributes.position); g.setAttribute("uv", base.attributes.uv);
  const off = new Float32Array(n * 3), seed = new Float32Array(n * 4);
  const sp = o.spread ?? [3, 1, 3];
  for (let i = 0; i < n; i++) {
    off[i * 3] = origin.x + (rnd() * 2 - 1) * sp[0]; off[i * 3 + 1] = origin.y + (rnd() * 2 - 1) * sp[1]; off[i * 3 + 2] = origin.z + (rnd() * 2 - 1) * sp[2];
    seed[i * 4] = rnd(); seed[i * 4 + 1] = rnd(); seed[i * 4 + 2] = rnd(); seed[i * 4 + 3] = rnd();
  }
  g.setAttribute("offset", new THREE.InstancedBufferAttribute(off, 3));
  g.setAttribute("seed", new THREE.InstancedBufferAttribute(seed, 4));
  g.instanceCount = n;
  const size = o.size ?? [3, 7];
  const dir = o.dir ?? [0, 1, 0];
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { uTime: waterTime, uSun: waterSun, uTex: { value: softSpriteTex(0, o.power ?? 1.6, o.lit ? 0.6 : 0) }, uColor: { value: new THREE.Color(o.color ?? "#ffffff") }, uOpacity: { value: o.opacity ?? 0.35 }, uSize: { value: new THREE.Vector2(size[0], size[1]) }, uRise: { value: o.rise ?? 1.5 }, uDrift: { value: o.drift ?? 0.6 }, uLife: { value: o.life ?? 6 }, uGrow: { value: o.grow ?? 0.8 }, uDir: { value: new THREE.Vector3(...dir).normalize() }, uLit: { value: o.lit ? 1 : 0 } },
    vertexShader: /* glsl */ `
      attribute vec3 offset; attribute vec4 seed; uniform float uTime, uRise, uDrift, uLife, uGrow; uniform vec2 uSize; uniform vec3 uDir;
      varying float vA; varying vec2 vUv; varying float vSeed;
      void main(){
        float ph = fract(uTime / uLife + seed.x);
        vec3 p = offset + uDir * (uRise * ph * uLife * 0.35) + vec3(sin(uTime * 0.3 + seed.y * 6.28), 0.0, cos(uTime * 0.27 + seed.z * 6.28)) * uDrift * ph;
        vA = sin(ph * 3.14159);
        float s = mix(uSize.x, uSize.y, seed.w) * (1.0 - uGrow * 0.5 + uGrow * ph);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float rot = seed.y * 6.28 + uTime * (seed.z - 0.5) * 0.3; float c = cos(rot), sn = sin(rot);
        vec2 q = vec2(position.x * c - position.y * sn, position.x * sn + position.y * c);
        mv.xy += q * s;
        vUv = uv; vSeed = seed.z;
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex; uniform vec3 uColor; uniform float uOpacity, uLit; uniform vec3 uSun; varying float vA; varying vec2 vUv; varying float vSeed;
      void main(){ float a = texture2D(uTex, vUv).a * vA * uOpacity;
        vec3 c = uColor;
        if (uLit > 0.5) { float sh = 0.82 + 0.25 * clamp((vUv.y - 0.3) * 1.5 + dot(vec2(vUv.x - 0.5, 0.0), normalize(uSun.xz)) * 0.6, -1.0, 1.0); c *= sh; }
        if (a < 0.003) discard;
        gl_FragColor = vec4(c, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment> }`,
  });
  // a real bounding sphere (origin + spread + the rise/drift travel + the biggest sprite) → frustum-culled like any mesh
  { const reach = Math.hypot(sp[0], sp[1], sp[2]) + (o.rise ?? 1.5) * (o.life ?? 6) * 0.35 + (o.drift ?? 0.6) + size[1] * (1 + (o.grow ?? 0.8) * 0.5);
    const c = origin.clone().addScaledVector(new THREE.Vector3(...dir).normalize(), (o.rise ?? 1.5) * (o.life ?? 6) * 0.175); g.boundingSphere = new THREE.Sphere(c, reach); }
  const mesh = new THREE.Mesh(g, m); mesh.name = "jungle-puffs"; mesh.frustumCulled = true; mesh.renderOrder = 4;
  mesh.userData.castShadow = false; mesh.castShadow = false;
  return mesh;
}

/** rainbow: a faint PARTIAL arc (only the stretch that stands in the mist) — soft bands, both ends dissolving, brightest
 *  low where the spray is densest. Additive, faces the camera about Y. */
let _rainbow: THREE.CanvasTexture | null = null;
export function rainbowTex(): THREE.CanvasTexture {
  if (_rainbow) return _rainbow;
  _rainbow = canvasTex(1024, 512, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h, R = h * 0.92, bw = R * 0.02;
    const bands = ["#ff3a2a", "#ff8f1e", "#ffe330", "#4fe04a", "#33b4ff", "#4b58ff", "#9a55ff"];
    g.filter = "blur(5px)";
    g.filter = "blur(9px)";
    bands.forEach((c, i) => { g.strokeStyle = c; g.globalAlpha = 0.55; g.lineWidth = bw * 1.5; g.beginPath(); g.arc(cx, cy, R - i * bw, Math.PI * 1.12, Math.PI * 1.5); g.stroke(); });
    g.filter = "none";
    // dissolve both ends + keep only the part inside the mist (fades out upward)
    g.globalCompositeOperation = "destination-in";
    const lg = g.createLinearGradient(0, 0, w, 0); lg.addColorStop(0, "rgba(0,0,0,0)"); lg.addColorStop(0.12, "rgba(0,0,0,0.9)"); lg.addColorStop(0.42, "rgba(0,0,0,1)"); lg.addColorStop(0.62, "rgba(0,0,0,0)"); lg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = lg; g.fillRect(0, 0, w, h);
    const vg = g.createLinearGradient(0, 0, 0, h); vg.addColorStop(0, "rgba(0,0,0,0.25)"); vg.addColorStop(0.45, "rgba(0,0,0,0.9)"); vg.addColorStop(1, "rgba(0,0,0,1)");
    g.fillStyle = vg; g.fillRect(0, 0, w, h);
  }, { repeat: false });
  return _rainbow;
}
export function rainbow(x: number, y: number, z: number, width: number, opacity = 0.3): THREE.Mesh {
  const m = new THREE.MeshBasicMaterial({ map: rainbowTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity, side: THREE.DoubleSide, fog: false, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, width / 2), m);
  mesh.position.set(x, y, z); mesh.name = "jungle-rainbow"; mesh.renderOrder = 5; mesh.userData.castShadow = false;
  mesh.onBeforeRender = (_r, _s, cam) => { mesh.rotation.y = Math.atan2(cam.position.x - x, cam.position.z - z); mesh.updateMatrixWorld(); };
  return mesh;
}


/** an emissive lava ribbon following a ground sampler along a polyline (widths in metres) */
export function lavaRibbon(points: THREE.Vector3[], width: number, ground: (x: number, z: number) => number, mat: THREE.Material, lift = 0.12): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.4);
  const n = Math.max(8, Math.round(curve.getLength() / 2));
  const pos = new Float32Array((n + 1) * 2 * 3), uv = new Float32Array((n + 1) * 2 * 2), idx: number[] = [];
  const t = new THREE.Vector3(), p = new THREE.Vector3(), r = new THREE.Vector3();
  for (let i = 0; i <= n; i++) {
    const u = i / n; curve.getPoint(u, p); curve.getTangent(u, t); r.set(-t.z, 0, t.x).normalize();
    const w = width * (0.7 + 0.3 * Math.sin(u * 23.1) * Math.sin(u * 7.3 + 1.0));
    for (let s = 0; s < 2; s++) {
      const sx = p.x + r.x * w * (s - 0.5), sz = p.z + r.z * w * (s - 0.5);
      const k = (i * 2 + s) * 3; pos[k] = sx; pos[k + 1] = ground(sx, sz) + lift; pos[k + 2] = sz;
      uv[(i * 2 + s) * 2] = s; uv[(i * 2 + s) * 2 + 1] = u * curve.getLength() / (width * 2.2);
    }
    if (i < n) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat); m.name = "jungle-lava"; m.receiveShadow = false; m.matrixAutoUpdate = false; m.updateMatrix();
  return m;
}

/** a god-ray card: additive quad, gradient along its length, oriented along `dir` at `pos` */
export function godRay(pos: THREE.Vector3, dir: THREE.Vector3, length: number, width: number, color = "#fff2c8", opacity = 0.12): THREE.Mesh {
  const c = document.createElement("canvas"); c.width = 16; c.height = 128;
  const g = c.getContext("2d")!; const grd = g.createLinearGradient(0, 0, 0, 128);
  grd.addColorStop(0, "rgba(255,255,255,0)"); grd.addColorStop(0.25, "rgba(255,255,255,1)"); grd.addColorStop(0.8, "rgba(255,255,255,0.6)"); grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd; g.fillRect(0, 0, 16, 128);
  const hg = g.createLinearGradient(0, 0, 16, 0); hg.addColorStop(0, "rgba(0,0,0,1)"); hg.addColorStop(0.3, "rgba(0,0,0,0)"); hg.addColorStop(0.7, "rgba(0,0,0,0)"); hg.addColorStop(1, "rgba(0,0,0,1)");
  g.globalCompositeOperation = "destination-out"; g.fillStyle = hg; g.fillRect(0, 0, 16, 128);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width, length), new THREE.MeshBasicMaterial({ map: tex, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  const d = dir.clone().normalize();
  m.position.copy(pos).addScaledVector(d, length / 2);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), d);
  m.name = "jungle-godray"; m.renderOrder = 6; m.userData.castShadow = false;
  return m;
}
