// poi-jungle kit — materials. painted tileable PBR sets (public/assets/pois/jungle/tex/<name>.jpg + _n + _r), with
// shader patches on MeshStandardMaterial: world-space TRIPLANAR projection (rocks, cliffs, hero meshes — no UV
// stretching), MOSS on upward faces (patchy, noise-broken, a second moss texture), WETNESS below a world height
// (darker + glossier rock near water), and per-vertex tint via vertex colours.
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import { shareTexture } from "../../../engine/texture-release";

export type TexName = "temple-blocks" | "glyph-frieze" | "basalt" | "boulder" | "flagstone" | "planks" | "moss" | "lava-crust" | "sand" | "lava-rock" | "sand2";
const TEX_DIR = "assets/pois/jungle/tex/";

export interface PbrSet { map: THREE.Texture; normalMap: THREE.Texture; roughnessMap: THREE.Texture }

const setCache = new Map<string, Promise<PbrSet>>();

/** solid-colour fallback so a missing/failed texture never breaks a build (it just looks flat) */
function flatTex(hex: string, srgb = true): THREE.Texture {
  const c = document.createElement("canvas"); c.width = c.height = 4;
  const g = c.getContext("2d")!; g.fillStyle = hex; g.fillRect(0, 0, 4, 4);
  const t = new THREE.CanvasTexture(c); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}

/** load a PBR set once (albedo sRGB, normal + roughness linear). Never throws. */
export function pbr(ctx: WorldCtx, name: TexName): Promise<PbrSet> {
  _ctx = ctx;
  let p = setCache.get(name);
  if (!p) {
    const fb = { "temple-blocks": "#9a927e", "glyph-frieze": "#8f8774", basalt: "#2a2a2c", boulder: "#7d7468", flagstone: "#a89c84", planks: "#8a5a32", moss: "#4f8a2a", "lava-crust": "#3a2a22", sand: "#e8d8a8", "lava-rock": "#3b322d", sand2: "#efe3c8" }[name];
    p = Promise.all([
      ctx.assets.texture(`${TEX_DIR}${name}.jpg`).catch(() => flatTex(fb)),
      ctx.assets.texture(`${TEX_DIR}${name}_n.jpg`, { srgb: false }).catch(() => flatTex("#8080ff", false)),
      ctx.assets.texture(`${TEX_DIR}${name}_r.jpg`, { srgb: false }).catch(() => flatTex("#cccccc", false)),
    ]).then(([map, normalMap, roughnessMap]) => ({ map, normalMap, roughnessMap }));
    setCache.set(name, p);
  }
  return p;
}

export interface StoneOpts {
  /** metres per texture tile (uv or triplanar) */
  scale?: number;
  triplanar?: boolean;
  /** 0..1 moss strength on upward faces (0 = none) */
  moss?: number;
  mossColor?: string;
  /** world y below which the surface is wet (darker, glossier); undefined = dry */
  wetY?: number;
  wetFade?: number;
  vertexColors?: boolean;
  color?: string;
  roughness?: number;
  metalness?: number;
  normalScale?: number;
  side?: THREE.Side;
  /** extra emissive (lava crust etc.) */
  emissive?: string;
  emissiveIntensity?: number;
  /** large-scale albedo variation (0..1) breaks tiling repetition */
  variation?: number;
  /** fake bounce light: adds albedo × lift × a sky/green tint as emissive (lifts shadowed stone like GI would) */
  lift?: number;
  /** multiplier on the wet darkening (1 = default 0.55 at full wet) */
  wetDark?: number;
  /** bounce tint from above (sky) / below (ground) for `lift` (defaults: pale sky blue / green-warm) */
  liftTop?: string; liftBottom?: string;
  /** 0..1: how much of the up-facing area the moss mask covers (default 0.5) */
  mossCover?: number;
  /** tiling detail normal (stone grain) strength, faded in under ~10 m (0 = off; default 0.6) */
  detail?: number;
  /** metres per detail tile (default 0.55) */
  detailScale?: number;
  /** wet band following a RIVER profile: [x, water level] pairs sorted by x (the level at a fragment is interpolated in x);
   *  darker + glossy below the level + a splash zone, a thin foam-white line right at the waterline */
  wetLevels?: Array<[number, number]>;
}

/** tileable value noise, 256² (16 lattice cells per tile): R = 3-octave fbm (0..1), G = 1 octave. Replaces per-pixel
 *  procedural hash noise in the stone shader (≈80 hash evaluations per fragment → 4 texture fetches). */
let _jnoise: THREE.DataTexture | null = null;
export function jungleNoiseTex(): THREE.DataTexture {
  if (_jnoise) return _jnoise;
  const N = 256, C = 16, rnd = mulberry(4242);
  const lat = (P: number) => { const v = new Float32Array(P * P); for (let i = 0; i < v.length; i++) v[i] = rnd(); return v; };
  const L = [lat(C), lat(C * 2), lat(C * 4)];
  const vn = (v: Float32Array, P: number, fx: number, fy: number) => { const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty); const g = (i: number, j: number) => v[(((j % P) + P) % P) * P + (((i % P) + P) % P)]; return (g(ix, iy) * (1 - sx) + g(ix + 1, iy) * sx) * (1 - sy) + (g(ix, iy + 1) * (1 - sx) + g(ix + 1, iy + 1) * sx) * sy; };
  const d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const u = x / N, v = y / N, a = vn(L[0], C, u * C, v * C), b = vn(L[1], C * 2, u * C * 2, v * C * 2), c = vn(L[2], C * 4, u * C * 4, v * C * 4);
    const k = (y * N + x) * 4; d[k] = Math.round((a * 0.5 + b * 0.25 + c * 0.125) * 255); d[k + 1] = Math.round(a * 255); d[k + 2] = Math.round(c * 255); d[k + 3] = 255;
  }
  _jnoise = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
  _jnoise.wrapS = _jnoise.wrapT = THREE.RepeatWrapping; _jnoise.magFilter = THREE.LinearFilter; _jnoise.minFilter = THREE.LinearMipmapLinearFilter; _jnoise.generateMipmaps = true; _jnoise.needsUpdate = true;
  return _jnoise;
}
let _detail: THREE.Texture | null = null;
/** the shared tiling detail normal (stone-detail_n.jpg) */
export function detailNormalTex(ctx: WorldCtx): THREE.Texture {
  if (_detail) return _detail;
  const t = flatTex("#8080ff", false); _detail = t;
  ctx.assets.texture(`${TEX_DIR}stone-detail_n.jpg`, { srgb: false }).then((d) => { d.wrapS = d.wrapT = THREE.RepeatWrapping; d.anisotropy = 8; t.image = d.image; t.needsUpdate = true; }).catch(() => {});
  return t;
}
let _ctx: WorldCtx | null = null;
/** remember the ctx so stone materials can fetch the shared detail normal */
export function bindJungleCtx(ctx: WorldCtx) { _ctx = ctx; }
const NOISE_GLSL = /* glsl */ `
uniform sampler2D uJNoise;
vec2 jnUV(vec3 p){ return (p.xz + p.y * vec2(0.71, 0.37)) * 0.0625; }
float jfbm(vec3 p){ return texture2D(uJNoise, jnUV(p)).r; }
float jnoise(vec3 p){ return texture2D(uJNoise, jnUV(p) + 0.37).g; }
`;

/**
 * A MeshStandardMaterial over a PBR set with the jungle shader patches. `set` may resolve later: the material
 * starts with the flat fallbacks and swaps maps in when the textures arrive (build never waits on the network).
 */
export function stoneMaterial(set: PbrSet | Promise<PbrSet>, o: StoneOpts = {}, mossSet?: Promise<PbrSet>): THREE.MeshStandardMaterial {
  const scale = o.scale ?? 2.5;
  const m = new THREE.MeshStandardMaterial({
    color: o.color ?? "#ffffff", roughness: o.roughness ?? 1, metalness: o.metalness ?? 0,
    vertexColors: !!o.vertexColors, side: o.side ?? THREE.FrontSide,
    emissive: o.emissive ?? "#000000", emissiveIntensity: o.emissiveIntensity ?? 0,
  });
  m.normalScale.setScalar(o.normalScale ?? 1);
  const apply = (s: PbrSet) => {
    if (!o.triplanar) { // uv variant: the geometry's UVs are scaled by `scale` for ALL three maps (clones share the GPU image)
      const rep = (t: THREE.Texture) => { const c = shareTexture(t); c.repeat.set(1 / scale, 1 / scale); return c; };
      m.map = rep(s.map); m.normalMap = rep(s.normalMap); m.roughnessMap = rep(s.roughnessMap);
    } else { m.map = s.map; m.normalMap = s.normalMap; m.roughnessMap = s.roughnessMap; }
    m.needsUpdate = true;
  };
  if (set instanceof Promise) set.then(apply); else apply(set);

  const uniforms = {
    uTriScale: { value: 1 / scale },
    uMoss: { value: o.moss ?? 0 },
    uMossColor: { value: new THREE.Color(o.mossColor ?? "#6fae2f") },
    uMossMap: { value: null as THREE.Texture | null },
    uWetY: { value: o.wetY ?? -1e9 },
    uWetFade: { value: o.wetFade ?? 1.5 },
    uVariation: { value: o.variation ?? 0.35 },
    uLift: { value: o.lift ?? 0 },
    uWetDark: { value: o.wetDark ?? 0.55 },
    uJNoise: { value: jungleNoiseTex() },
    uLiftTop: { value: o.liftTop ? new THREE.Color(o.liftTop) : new THREE.Color().setRGB(0.72, 0.85, 1.0) }, uLiftBot: { value: o.liftBottom ? new THREE.Color(o.liftBottom) : new THREE.Color().setRGB(0.62, 0.72, 0.55) },
    uMossCover: { value: o.mossCover ?? 0.5 },
    uDetail: { value: o.detail ?? 0.6 }, uDetailScale: { value: 1 / (o.detailScale ?? 0.55) },
    uDetailMap: { value: _ctx ? detailNormalTex(_ctx) : flatTex("#8080ff", false) },
    uWL: { value: (o.wetLevels ?? [[0, -1e4]]).map(([x, y]) => new THREE.Vector2(x, y)) },
  };
  const nWL = (o.wetLevels ?? [[0, 0]]).length;
  mossSet?.then((s) => { uniforms.uMossMap.value = s.map; });
  m.userData.jungleUniforms = uniforms;

  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.defines = sh.defines || {};
    if (o.triplanar) sh.defines.J_TRIPLANAR = 1;
    if ((o.moss ?? 0) > 0) sh.defines.J_MOSS = 1;
    if (o.wetY !== undefined || o.wetLevels) sh.defines.J_WET = 1;
    if (o.wetLevels) sh.defines.J_WETRIVER = 1;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vJWorldPos; varying vec3 vJWorldNormal;")
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>
        { vec4 jwp = vec4(transformed, 1.0); vec3 jwn = objectNormal;
          #ifdef USE_INSTANCING
            jwp = instanceMatrix * jwp; jwn = mat3(instanceMatrix) * jwn;
          #endif
          jwp = modelMatrix * jwp; vJWorldPos = jwp.xyz; vJWorldNormal = normalize(mat3(modelMatrix) * jwn); }`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>
        varying vec3 vJWorldPos; varying vec3 vJWorldNormal;
        uniform float uTriScale, uMoss, uWetY, uWetFade, uVariation, uLift, uWetDark, uMossCover, uDetail, uDetailScale; uniform vec3 uMossColor, uLiftTop, uLiftBot; uniform sampler2D uMossMap, uDetailMap;
        uniform vec2 uWL[${nWL}];
        float jWaterY(float x){ float y = uWL[0].y; for (int i = 1; i < ${nWL}; i++) { if (x > uWL[i - 1].x) y = mix(uWL[i - 1].y, uWL[i].y, clamp((x - uWL[i - 1].x) / max(0.01, uWL[i].x - uWL[i - 1].x), 0.0, 1.0)); } return y; }
        float jNear;
        ${NOISE_GLSL}
        vec3 jBlendW(){ vec3 n = abs(normalize(vJWorldNormal)); n = pow(n, vec3(6.0)); return n / (n.x+n.y+n.z); }
        vec4 jTri(sampler2D t, vec3 p, vec3 w){ return texture2D(t, p.zy)*w.x + texture2D(t, p.xz)*w.y + texture2D(t, p.xy)*w.z; }`)
      // albedo
      .replace("#include <map_fragment>", `
        jNear = uDetail * (1.0 - smoothstep(5.0, 11.0, length(vJWorldPos - cameraPosition)));
        #ifdef J_TRIPLANAR
          #ifdef USE_MAP
          { vec3 jw = jBlendW(); vec3 jp = vJWorldPos * uTriScale;
            vec4 jc = jTri(map, jp, jw); diffuseColor *= jc; }
          #endif
        #else
          #include <map_fragment>
        #endif
        // break tiling: low-frequency brightness + hue drift in world space
        { float jv = jfbm(vJWorldPos * 0.11); diffuseColor.rgb *= mix(1.0, 0.72 + 0.56 * jv, uVariation);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.06, 1.0, 0.92), uVariation * (jnoise(vJWorldPos * 0.05 + 7.0) - 0.5)); }
        #ifdef J_MOSS
          { vec3 jwn = normalize(vJWorldNormal);
            float mw = smoothstep(0.25, 0.85, jwn.y) * uMoss;
            float mn = jfbm(vJWorldPos * 0.55 + 3.0);
            mw *= smoothstep(0.62 - uMossCover * 0.6, 0.92 - uMossCover * 0.6, mn);
            // creeping moss also on shaded verticals, weaker
            mw = max(mw, uMoss * 0.35 * smoothstep(0.55, 0.8, jfbm(vJWorldPos * 0.9 + 11.0)) * (1.0 - smoothstep(0.2, 0.6, abs(jwn.y))));
            vec3 mc = uMossColor * texture2D(uMossMap, vJWorldPos.xz * 0.6 + vJWorldPos.y * 0.37).rgb * 1.7;
            diffuseColor.rgb = mix(diffuseColor.rgb, mc, clamp(mw, 0.0, 1.0)); }
        #endif`)
      // normal map
      .replace("#include <normal_fragment_maps>", `
        #ifdef J_TRIPLANAR
          #ifdef USE_NORMALMAP
          { vec3 jw = jBlendW(); vec3 jp = vJWorldPos * uTriScale; vec3 wn = normalize(vJWorldNormal);
            vec3 tx = texture2D(normalMap, jp.zy).xyz * 2.0 - 1.0; vec3 ty = texture2D(normalMap, jp.xz).xyz * 2.0 - 1.0; vec3 tz = texture2D(normalMap, jp.xy).xyz * 2.0 - 1.0;
            tx.xy *= normalScale; ty.xy *= normalScale; tz.xy *= normalScale;
            tx = vec3(tx.xy + wn.zy, abs(tx.z) * wn.x); ty = vec3(ty.xy + wn.xz, abs(ty.z) * wn.y); tz = vec3(tz.xy + wn.xy, abs(tz.z) * wn.z);
            vec3 wnrm = normalize(tx.zyx * jw.x + ty.xzy * jw.y + tz.xyz * jw.z);
            normal = normalize((viewMatrix * vec4(wnrm, 0.0)).xyz); }
          #endif
        #else
          #include <normal_fragment_maps>
        #endif
        if (jNear > 0.002) { // tiling stone-grain detail normal (triplanar, whiteout), only near the camera
          vec3 jw = jBlendW(); vec3 jp = vJWorldPos * uDetailScale; vec3 wn = normalize(vJWorldNormal);
          vec3 dx = texture2D(uDetailMap, jp.zy).xyz * 2.0 - 1.0, dy = texture2D(uDetailMap, jp.xz).xyz * 2.0 - 1.0, dz = texture2D(uDetailMap, jp.xy).xyz * 2.0 - 1.0;
          vec3 off = vec3(0.0, dx.y, dx.x) * jw.x + vec3(dy.x, 0.0, dy.y) * jw.y + vec3(dz.x, dz.y, 0.0) * jw.z;
          normal = normalize(normal + (viewMatrix * vec4(off, 0.0)).xyz * jNear);
          diffuseColor.rgb *= 1.0 + (texture2D(uJNoise, jp.xz * 0.37 + jp.y * 0.21).b - 0.5) * 0.18 * jNear;
        }`)
      // roughness
      .replace("#include <roughnessmap_fragment>", `
        float roughnessFactor = roughness;
        #ifdef USE_ROUGHNESSMAP
          #ifdef J_TRIPLANAR
            { vec3 jw = jBlendW(); vec3 jp = vJWorldPos * uTriScale; roughnessFactor *= jTri(roughnessMap, jp, jw).g; }
          #else
            { vec4 texelRoughness = texture2D(roughnessMap, vRoughnessMapUv); roughnessFactor *= texelRoughness.g; }
          #endif
        #endif
        #ifdef J_MOSS
          { vec3 jwn = normalize(vJWorldNormal); roughnessFactor = mix(roughnessFactor, 0.95, smoothstep(0.25, 0.85, jwn.y) * uMoss * 0.6); }
        #endif
        #ifdef J_WET
          #ifdef J_WETRIVER
          { float lv = jWaterY(vJWorldPos.x), yy = vJWorldPos.y + (jfbm(vJWorldPos * 1.7) - 0.5) * 0.18;
            float wet = 1.0 - smoothstep(lv + 0.08, lv + 0.55, yy);
            roughnessFactor = mix(roughnessFactor, 0.14, wet * 0.9); diffuseColor.rgb *= mix(1.0, uWetDark, wet);
            float line = 1.0 - smoothstep(0.0, 0.07, abs(yy - lv - 0.03));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.97, 1.0), line * 0.75); }
          #else
          { float wet = 1.0 - smoothstep(uWetY, uWetY + uWetFade, vJWorldPos.y);
            roughnessFactor = mix(roughnessFactor, 0.18, wet * 0.85); diffuseColor.rgb *= mix(1.0, uWetDark, wet); }
          #endif
        #endif
        // fake GI bounce: sky-blue from above, green-warm from below
        { vec3 jwn = normalize(vJWorldNormal); totalEmissiveRadiance += diffuseColor.rgb * uLift * mix(uLiftBot, uLiftTop, 0.5 + 0.5 * jwn.y); }`);
  };
  // wet needs diffuseColor edits after the map: three orders roughnessmap_fragment after map_fragment, so this works.
  m.customProgramCacheKey = () => `jungle3|${o.triplanar ? 1 : 0}|${(o.moss ?? 0) > 0 ? 1 : 0}|${o.wetY !== undefined ? 1 : 0}|${o.wetLevels ? nWL : 0}`;
  return m;
}

// ---------------------------------------------------------------- canvas-painted textures (small, procedural)
export function canvasTex(w: number, h: number, paint: (g: CanvasRenderingContext2D, w: number, h: number) => void, o: { srgb?: boolean; repeat?: boolean } = {}): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  paint(c.getContext("2d")!, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = o.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (o.repeat !== false) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** a cluster of stylized ivy/creeper leaves on transparent — for alpha-tested leaf cards */
export function leafClusterTex(kind: "ivy" | "fern" | "vine" = "ivy"): THREE.CanvasTexture {
  return canvasTex(256, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const rnd = mulberry(kind === "ivy" ? 11 : kind === "fern" ? 23 : 37);
    const leaf = (x: number, y: number, r: number, a: number, col: string, dark: string) => {
      g.save(); g.translate(x, y); g.rotate(a);
      g.fillStyle = col; g.beginPath();
      if (kind === "fern") {
        g.moveTo(0, 0);
        for (let i = 0; i < 7; i++) { const t = i / 7; g.lineTo(-r * 0.4 * (1 - t) - 2, -r * t); }
        g.lineTo(0, -r * 1.05);
        for (let i = 6; i >= 0; i--) { const t = i / 7; g.lineTo(r * 0.4 * (1 - t) + 2, -r * t); }
      } else { // heart / ivy leaf
        g.moveTo(0, 0); g.bezierCurveTo(-r, -r * 0.3, -r * 0.9, -r * 1.1, 0, -r * 1.15); g.bezierCurveTo(r * 0.9, -r * 1.1, r, -r * 0.3, 0, 0);
      }
      g.closePath(); g.fill();
      g.strokeStyle = dark; g.lineWidth = 2; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -r); g.stroke();
      g.restore();
    };
    const n = kind === "vine" ? 9 : kind === "ivy" ? 40 : 16;
    for (let i = 0; i < n; i++) {
      // ivy: a ROUND clump (denser in the middle, ragged outline) — never a square carpet tile
      let x: number, y: number;
      if (kind === "ivy") { const a0 = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * 84 * (0.75 + 0.35 * Math.sin(a0 * 3 + 1)); x = w / 2 + Math.cos(a0) * rr; y = h / 2 + Math.sin(a0) * rr; }
      else { x = 30 + rnd() * (w - 60); y = 30 + rnd() * (h - 60); }
      const r = (kind === "ivy" ? 15 : 28) + rnd() * (kind === "ivy" ? 17 : 34), a = rnd() * Math.PI * 2;
      const L = 0.22 + rnd() * 0.2, hue = 88 + rnd() * 30, sat = 44 + rnd() * 20;
      leaf(x, y, r, a, `hsl(${hue} ${sat}% ${Math.round(L * 100)}%)`, `hsl(${hue} ${sat}% ${Math.round(L * 55)}%)`);
    }
  }, { repeat: false });
}

/** twisted 3-ply hemp rope, tileable along U (u runs along the rope in 0.6 m tiles, v around it): three helical strands
 *  with rounded shading and dark grooves between them, fine fibres along each strand, a few frayed hairs */
let _rope: THREE.CanvasTexture | null = null;
export function ropeTex(): THREE.CanvasTexture {
  if (_rope) return _rope;
  _rope = canvasTex(256, 64, (g, w, h) => {
    const img = g.createImageData(w, h), rnd = mulberry(606), fib = new Float32Array(w * 4);
    for (let i = 0; i < fib.length; i++) fib[i] = rnd();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      // strand phase: 3 strands, helix pitch = 1 tile across per 85 px along
      const ph = ((x / 85.333 + y / h) * 3) % 1, prof = Math.sin(ph * Math.PI);          // 0 at the groove, 1 at the crown
      const f = fib[(Math.floor(x * 0.9 + ph * 40) % w) * 4 + (y & 3)];                     // fibres run along the strand
      const lum = 0.35 + 0.65 * Math.pow(prof, 0.6) - 0.12 * f + (ph < 0.08 || ph > 0.92 ? -0.25 : 0);
      const i = (y * w + x) * 4;
      img.data[i] = Math.round(Math.min(255, 196 * lum + 12)); img.data[i + 1] = Math.round(Math.min(255, 156 * lum + 8)); img.data[i + 2] = Math.round(Math.min(255, 98 * lum + 4)); img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    g.strokeStyle = "rgba(235,210,160,0.35)"; g.lineWidth = 0.8;
    for (let k = 0; k < 40; k++) { const x = rnd() * w, y = rnd() * h; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 3 + rnd() * 6, y + (rnd() - 0.5) * 3); g.stroke(); }
  });
  return _rope;
}

/** soft radial sprite (mist / spray / smoke / glow) */
export function softSpriteTex(inner = 0.0, power = 1.6): THREE.CanvasTexture {
  return canvasTex(128, 128, (g, w, h) => {
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (x + 0.5) / w - 0.5, dy = (y + 0.5) / h - 0.5, d = Math.min(1, Math.hypot(dx, dy) * 2);
      const a = Math.pow(Math.max(0, 1 - Math.max(0, d - inner) / (1 - inner)), power);
      const i = (y * w + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.round(a * 255);
    }
    g.putImageData(img, 0, 0);
  }, { repeat: false });
}

/** rainbow arc on transparent (drawn in the top half; use on a 2:1 quad) */
export function rainbowTex(): THREE.CanvasTexture {
  return canvasTex(512, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h, R = h * 0.92, bands = ["#ff3b3b", "#ff9a2e", "#ffe83a", "#5ad14a", "#3fb9ff", "#5b6cff", "#b35bff"];
    bands.forEach((c, i) => { g.strokeStyle = c; g.globalAlpha = 0.55; g.lineWidth = R * 0.028; g.beginPath(); g.arc(cx, cy, R - i * R * 0.028, Math.PI, 2 * Math.PI); g.stroke(); });
    // soften edges
    g.globalCompositeOperation = "destination-in";
    const grd = g.createRadialGradient(cx, cy, R * 0.75, cx, cy, R); grd.addColorStop(0, "rgba(0,0,0,0.0)"); grd.addColorStop(0.35, "rgba(0,0,0,1)"); grd.addColorStop(1, "rgba(0,0,0,0.0)");
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  }, { repeat: false });
}

/** "BANANA CO." stencil crate side, painted in code */
export function crateTex(label = "BANANA CO."): THREE.CanvasTexture {
  return canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = "#b8823f"; g.fillRect(0, 0, w, h);
    const rnd = mulberry(5);
    for (let i = 0; i < 5; i++) { // planks
      const y = (i * h) / 5; g.fillStyle = `hsl(31 52% ${40 + rnd() * 10}%)`; g.fillRect(0, y + 3, w, h / 5 - 6);
      g.strokeStyle = "rgba(60,30,10,0.35)"; g.lineWidth = 2;
      for (let k = 0; k < 6; k++) { g.beginPath(); g.moveTo(0, y + 10 + rnd() * (h / 5 - 20)); g.bezierCurveTo(w * 0.3, y + rnd() * (h / 5), w * 0.6, y + rnd() * (h / 5), w, y + rnd() * (h / 5)); g.stroke(); }
    }
    g.fillStyle = "#7a4a1e"; g.fillRect(0, 0, 26, h); g.fillRect(w - 26, 0, 26, h); g.fillRect(0, 0, w, 26); g.fillRect(0, h - 26, w, 26);
    g.fillStyle = "rgba(60,30,10,0.85)"; g.font = "bold 74px Helvetica, Arial"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(label, w / 2, h / 2 + 4);
    g.strokeStyle = "rgba(60,30,10,0.85)"; g.lineWidth = 6; g.strokeRect(w * 0.14, h * 0.32, w * 0.72, h * 0.36);
    for (let i = 0; i < 8; i++) { g.fillStyle = "#4b3a2a"; g.beginPath(); g.arc(13 + (i % 2) * (w - 26), 40 + (i >> 1) * 140, 5, 0, 7); g.fill(); }
  });
}

/** small deterministic PRNG */
export function mulberry(seed: number) {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}


// ---------------------------------------------------------------- interiors (no occlusion-aware GI in the engine)
/** An interior volume (world AABB) whose surfaces must read DARK from outside (sun + sky IBL scaled down past a door
 *  plane) and be lit only by baked-style warm "lamps" (analytic point falloff, no shadows, no real lights → no program
 *  recompiles, no per-pixel light loop on the rest of the world). Patch any MeshStandardMaterial with it. */
export interface InteriorBox { min: THREE.Vector3; max: THREE.Vector3; /** remaining fraction of the exterior light inside */ dark: number;
  /** optional doorway ramp: unit axis pointing INTO the room; exterior light fades from dot(p, axis) = ramp[0] to ramp[1] */
  axis?: THREE.Vector3; ramp?: [number, number] }
export interface InteriorZone {
  min: THREE.Vector3; max: THREE.Vector3;
  /** unit axis pointing INTO the interior from the doorway, and the door plane offset along it (dot(p, axis)) */
  axis: THREE.Vector3; door: number; ramp: number;
  /** remaining fraction of the exterior lighting deep inside (0.05–0.15) */
  dark: number;
  /** lamps: xyz + strength */
  lamps: THREE.Vector4[]; lampColor: THREE.Color;
  /** lamp falloff k in 1/(1 + k·d²) (default 0.14; larger = harder pools of light) */
  falloff?: number;
  /** world heights [y0, y1]: lamp light fades out above y0 → gone by y1 (dark vaults / ceilings) */
  fadeY?: [number, number];
  /** several rooms (a dungeon, tower storeys): replaces min / max / axis / door / ramp / dark when given */
  boxes?: InteriorBox[];
}
/** Patch a MeshStandardMaterial with an interior zone: inside any of the zone's boxes the sun + sky light is scaled by that
 *  box's `dark` (ramped across its doorway), and the zone's lamps add warm analytic light (no real lights, no shadows). */
export function interiorPatch(m: THREE.MeshStandardMaterial, Z: InteriorZone, tag = "int", o: { /** metals: keep their own env reflections, kill only the sun */ keepIndirect?: boolean } = {}) {
  const boxes: InteriorBox[] = Z.boxes ?? [{ min: Z.min, max: Z.max, dark: Z.dark, axis: Z.axis, ramp: [Z.door, Z.door + Z.ramp] }];
  const nb = boxes.length, packed = boxes.flatMap((b) => [
    new THREE.Vector4(b.min.x, b.min.y, b.min.z, b.dark), new THREE.Vector4(b.max.x, b.max.y, b.max.z, b.ramp ? b.ramp[0] : 0),
    new THREE.Vector4(b.axis?.x ?? 0, b.axis?.y ?? 0, b.axis?.z ?? 0, b.ramp ? b.ramp[1] : 1)]);
  const u = { uIntB: { value: packed }, uIntL: { value: Z.lamps }, uIntC: { value: Z.lampColor }, uIntFall: { value: Z.falloff ?? 0.14 }, uIntFade: { value: new THREE.Vector2(...(Z.fadeY ?? [1e5, 1e5 + 1])) } };
  const n = Z.lamps.length, prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey?.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r);
    Object.assign(sh.uniforms, u);
    if (!sh.vertexShader.includes("vIntW")) sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vIntW; varying vec3 vIntN;")
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>
        { vec4 iw = vec4(transformed, 1.0); vec3 inn = objectNormal;
          #ifdef USE_INSTANCING
            iw = instanceMatrix * iw; inn = mat3(instanceMatrix) * inn;
          #endif
          vIntW = (modelMatrix * iw).xyz; vIntN = normalize(mat3(modelMatrix) * inn); }`);
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
      varying vec3 vIntW; varying vec3 vIntN; uniform vec3 uIntC; uniform vec2 uIntFade; uniform float uIntFall; uniform vec4 uIntL[${n}]; uniform vec4 uIntB[${nb * 3}];`)
      .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>
        {
          vec3 q = vIntW; float k = 1.0, inAny = 0.0;
          for (int i = 0; i < ${nb}; i++) {
            vec4 a = uIntB[i * 3], b = uIntB[i * 3 + 1], c = uIntB[i * 3 + 2];
            vec3 inb = step(a.xyz, q) * step(q, b.xyz); float ib = inb.x * inb.y * inb.z;
            if (ib < 0.5) continue;
            inAny = 1.0;
            float ramp = dot(c.xyz, c.xyz) > 0.5 ? smoothstep(b.w, c.w, dot(q, c.xyz)) : 1.0;
            k = min(k, mix(1.0, a.w, ramp));
          }
          reflectedLight.directDiffuse *= k; reflectedLight.directSpecular *= k;
          ${o.keepIndirect ? "" : "reflectedLight.indirectDiffuse *= k; reflectedLight.indirectSpecular *= k;"}
          if (inAny > 0.5) {
            vec3 fl = vec3(0.0), nn = normalize(vIntN);
            for (int i = 0; i < ${n}; i++) { vec3 d = uIntL[i].xyz - q; float dd = dot(d, d); fl += uIntL[i].w / (1.0 + dd * uIntFall) * (0.15 + 0.85 * max(0.0, dot(nn, d * inversesqrt(dd + 1e-4)))); }
            fl *= 1.0 - 0.92 * smoothstep(uIntFade.x, uIntFade.y, q.y);
            // metals: no diffuse, a tinted specular sheen (material.diffuseColor already carries 1 − metalness)
            reflectedLight.directDiffuse += material.diffuseColor * (1.0 - metalnessFactor) * uIntC * fl;
            reflectedLight.directSpecular += uIntC * fl * material.specularColorBlended * (1.0 - roughnessFactor) * 0.35;
          }
        }`);
  };
  m.customProgramCacheKey = () => `${prevKey ? prevKey() : ""}|${tag}${n}b${nb}${o.keepIndirect ? "k" : ""}|m4`;
  m.needsUpdate = true;
  return m;
}


/** carved-stone material for a hero mesh: crisp world-space block texture (triplanar, moss on tops) multiplied by
 *  the mesh's baked luminance (keeps its painted eye/brow/cavity shading, drops its blurry colour) */
export function heroStoneMaterial(set: Promise<PbrSet>, bake: THREE.Texture | null, o: StoneOpts & { bakeMix?: number; /** cavity contrast of the bake (default 2.4) */ bakeGain?: number;
  /** carved seams: unit-space heights (the hero mesh is 0..1 tall) of horizontal joints, drawn only where local x < seamFront
   *  (the back / sides — never across the face) */ seams?: number[]; seamFront?: number } = {}, moss?: Promise<PbrSet>): THREE.MeshStandardMaterial {
  const m = stoneMaterial(set, { triplanar: true, ...o }, moss);
  const seams = o.seams ?? [], nS = Math.max(1, seams.length);
  const prev = m.onBeforeCompile, u = { uBake: { value: bake }, uBakeMix: { value: o.bakeMix ?? 0.65 }, uBakeGain: { value: o.bakeGain ?? 2.4 }, uSeams: { value: seams.length ? seams : [9] }, uSeamFront: { value: o.seamFront ?? 0.0 } };
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec2 vBakeUv; varying vec3 vHeroP;").replace("#include <uv_vertex>", "#include <uv_vertex>\n vBakeUv = uv;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n vHeroP = position;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>\nuniform sampler2D uBake; uniform float uBakeMix, uBakeGain, uSeamFront; uniform float uSeams[${nS}]; varying vec2 vBakeUv; varying vec3 vHeroP;\nfloat hSeam;`)
      .replace("// break tiling: low-frequency", `{ vec3 bk = texture2D(uBake, vBakeUv).rgb; float bl = dot(bk, vec3(0.3, 0.55, 0.15)); diffuseColor.rgb *= mix(1.0, clamp(bl * uBakeGain, 0.12, 1.5), uBakeMix); }
        hSeam = 0.0;
        { float yy = vHeroP.y + 0.0035 * sin(vHeroP.x * 31.0 + vHeroP.z * 17.0) + 0.002 * sin(vHeroP.z * 73.0);
          for (int i = 0; i < ${nS}; i++) hSeam = max(hSeam, 1.0 - smoothstep(0.0012, 0.0036, abs(yy - uSeams[i])));
          hSeam *= smoothstep(uSeamFront + 0.06, uSeamFront - 0.04, vHeroP.x);
          diffuseColor.rgb *= 1.0 - 0.62 * hSeam; }
        // break tiling: low-frequency`);
  };
  const k = m.customProgramCacheKey.bind(m); m.customProgramCacheKey = () => k() + `|herostone${seams.length}`;
  return m;
}
