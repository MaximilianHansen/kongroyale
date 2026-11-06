// The kong asset. Two builds share one format (kong.ts draws either):
//   v2 (the default) — the Tripo kong: a Tripo v3.1 sculpt of the target art's gorilla (chunky
//      sculpted fur clumps, cream muzzle + chest, toothy grin, gold hoops, cargo shorts, peel wraps, star high-tops),
//      fitted to this rig, skinned, re-baked per tier by the build scripts → public/assets/actors/kong2/;
//   v1 — the Blender-sculpt kong (→ public/assets/actors/kong/). ?kong=v1 / ?kong=v2 picks one.
// Per tier the meshes are merged per material ("kbody" = body / fists atlas, "khead" = the face atlas (hi), "kgear" =
// clothing atlas, "kshoe" = sneakers (hi), "keye" = the eyeballs, "kmin" = the far tier with vertex colours). Every
// vertex carries 4 bone indices + weights (aBones / aWeights) in the rig's REST pose (model space) — kong.ts skins them
// against the bone texture (Σ w · B · T(−J)).
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { actorLook } from "./look";
import { flag } from "../flags";
import { releaseAfterUpload } from "../engine/texture-release";

export type AssetMat = "kbody" | "khead" | "kgear" | "kshoe" | "keye" | "kmin";
export interface KongAsset {
  tiers: Array<Array<{ mat: AssetMat; geo: THREE.BufferGeometry }>>;
  tris: { hi: number; lo: number; min: number };
  shadowLo: THREE.BufferGeometry;
  shadowMin: THREE.BufferGeometry;
  materials(tier: 0 | 1 | 2): Record<AssetMat, THREE.Material>;
}

/** ?kongv=1 → the procedural kong (A/B) */
export const USE_ASSET = !flag("kongv");
/** which kong asset draws: ?kong=v1 (the Blender sculpt) / ?kong=v2 (the Tripo kong), else KONG_DEFAULT */
export const KONG_DEFAULT: "v1" | "v2" = "v2";
/** ?kong=alt — an IP-distance variant of v2, away from a famous ape mascot's look (heart-shaped
 *  tan face, forelock tuft, warm-brown fur): the same asset with darker, cooler fur, a dark face with only the muzzle
 *  tan, and the forelock tuft pressed flat (kong.ts ALT_GLSL / ALT_TUFT). Not the default. */
export const KONG_ALT = flag("kong") === "alt";
export const KONG_VER: "v1" | "v2" = flag("kong") === "v1" ? "v1" : flag("kong") === "v2" || KONG_ALT ? "v2" : KONG_DEFAULT;
/** the deploy base (vite `base`, e.g. "/kong/"): public/ files live under it */
export const PUBLIC_BASE: string = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
const BASE = PUBLIC_BASE + (KONG_VER === "v2" ? "assets/actors/kong2/" : "assets/actors/kong/");
/** head scale of the Blender kong (anatomy HS: 0.86 → 1.0, the bigger mascot head);
 *  the face rig (kong.ts kongFaceOff / kongMouth), eye contact and the hats use it */
export const KONG_HS = 1.0;
type V3 = [number, number, number];
/** where the asset's face, fists and hat seat are (head-bone / wrist-bone frames, three coords, metres) */
export interface KongFace {
  /** eye midpoint, a touch in front of the balls (eye contact: kong.ts gazeAt) */
  eyeMid: V3;
  /** fist centre below the wrist joint (the weapon hand socket) */
  fist: V3;
  /** brow region the face rig lifts / furrows: centre (|x|, y, z), radii, inner-brow ramp (|x| start, span) */
  brow: { c: V3; r: V3; inner: [number, number] };
  /** the chin drops / cheeks lift with jaw + smile (v1's smooth muzzle); v2's sculpted grin keeps its shape */
  jaw: boolean;
  /** the mouth is PAINTED per expression (kong.ts MOUTH_GLSL) — v1 only: v2's grin is sculpted */
  paintMouth: boolean;
  /** the analytic eyelids' skin colour (linear) — the face colour round the eyes */
  lid: V3;
  /** hat seat on the head bone: y, z, tilt (rad), scale (outfits.ts hats were designed for the 0.86 head) */
  hat: [number, number, number, number];
}
const HK1 = KONG_HS / 0.86;
export const FACE: KongFace = KONG_VER === "v2"
  ? {
    // measured on the Tripo kong in the rig's rest pose
    eyeMid: [0, 0.2, -0.1], fist: [-0.056, -0.146, -0.005],
    brow: { c: [0.077, 0.278, -0.045], r: [0.095, 0.05, 0.075], inner: [0.0, 0.16] },
    jaw: false, paintMouth: false, lid: KONG_ALT ? [0.075, 0.055, 0.046] : [0.738, 0.316, 0.105],
    hat: [KONG_ALT ? 0.335 : 0.37, 0.13, -0.1, 1.0],
  }
  : {
    eyeMid: [0, 0.236 * KONG_HS, -0.2 * KONG_HS], fist: [0, -0.125, -0.02],
    brow: { c: [0.095, 0.336, -0.15], r: [0.1, 0.035, 0.07], inner: [0.03, 0.12] },
    jaw: true, paintMouth: true, lid: [0.84, 0.53, 0.29],
    hat: [0.33 * HK1, 0.02 * HK1, -0.12, HK1],
  };

/** GLTF custom attributes (_bi01 / _bi23 / _bw01 / _bw23) → aBones / aWeights vec4 */
function prep(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const k of ["position", "normal", "tangent", "uv", "color"]) if (src.attributes[k]) g.setAttribute(k, src.attributes[k]);
  if (src.index) g.setIndex(src.index);
  const n = src.attributes.position.count;
  const bi = new Float32Array(n * 4), bw = new Float32Array(n * 4);
  const A = src.attributes as Record<string, THREE.BufferAttribute>;
  for (let i = 0; i < n; i++) {
    bi[i * 4] = Math.round(A._bi01.getX(i)); bi[i * 4 + 1] = Math.round(A._bi01.getY(i));
    bi[i * 4 + 2] = Math.round(A._bi23.getX(i)); bi[i * 4 + 3] = Math.round(A._bi23.getY(i));
    bw[i * 4] = A._bw01.getX(i); bw[i * 4 + 1] = A._bw01.getY(i); bw[i * 4 + 2] = A._bw23.getX(i); bw[i * 4 + 3] = A._bw23.getY(i);
  }
  g.setAttribute("aBones", new THREE.BufferAttribute(bi, 4));
  g.setAttribute("aWeights", new THREE.BufferAttribute(bw, 4));
  // v2 body: the fur under each outfit top (the kong2 build's body_cover) → aCover = (inward dir, packed sink
  // levels); kong.ts KONG_COVER sinks it below the cloth on the kongs wearing that top
  if (A._covd && A._covm) {
    const cv = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { cv[i * 4] = A._covd.getX(i); cv[i * 4 + 1] = A._covd.getY(i); cv[i * 4 + 2] = A._covd.getZ(i); cv[i * 4 + 3] = A._covm.getX(i); }
    g.setAttribute("aCover", new THREE.BufferAttribute(cv, 4));
  }
  return g;
}
const triCount = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3;

const HALF_MAPS = flag("konghalf") && !flag("view") && !flag("cam");
let loadFullMaps: (() => Promise<void>) | null = null;
let fullMaps: Promise<void> | null = null;
export function fullKongMaps(): Promise<void> {
  return (fullMaps ??= (loadFullMaps?.() ?? Promise.resolve()).catch((e) => { fullMaps = null; console.warn("[kong] full-size maps failed to load:", e); }));
}
function halve(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.width >> 1; c.height = img.height >> 1;
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

let cache: Promise<KongAsset | null> | null = null;
export function loadKongAsset(renderer: THREE.WebGLRenderer): Promise<KongAsset | null> {
  if (!USE_ASSET) return Promise.resolve(null);
  return (cache ??= (async () => {
    try {
      const tl = new THREE.TextureLoader();
      const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      const halved = new Map<THREE.Texture, string>();
      loadFullMaps = () => Promise.all([...halved].map(async ([t, url]) => {
        const full = await tl.loadAsync(url);
        halved.delete(t); t.dispose(); releaseAfterUpload(t, async () => (await tl.loadAsync(url)).image).image = full.image; t.needsUpdate = true;
      })).then(() => undefined);
      const tex = async (name: string, srgb: boolean, half = false) => {
        const url = BASE + name + ".webp";
        const t: THREE.Texture<HTMLImageElement> = releaseAfterUpload(await tl.loadAsync(url), async () => { const img = (await tl.loadAsync(url)).image; return halved.has(t) ? halve(img) : img; });
        if (half && HALF_MAPS) { halved.set(t, url); (t as THREE.Texture).image = halve(t.image); }
        t.flipY = false; t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = aniso; t.needsUpdate = true;
        return t;
      };
      const [gltf, ...maps] = await Promise.all([
        new GLTFLoader().loadAsync(BASE + "kong.glb"),
        tex("hi-kong-albedo", true), tex("hi-kong-normal", false, true), tex("hi-kong-ao", false),
        tex("hi-gear-albedo", true, true), tex("hi-gear-normal", false, true), tex("hi-gear-ao", false),
        tex("lo-kong-albedo", true), tex("lo-kong-normal", false), tex("lo-kong-ao", false),
        tex("lo-gear-albedo", true), tex("lo-gear-normal", false), tex("lo-gear-ao", false),
        // the hi head (face) has its own 2048 atlas
        tex("hi-head-albedo", true), tex("hi-head-normal", false, true), tex("hi-head-ao", false),
        // … and the hi sneakers theirs (4× the texel density of the shared clothing atlas)
        tex("hi-shoes-albedo", true, true), tex("hi-shoes-normal", false, true), tex("hi-shoes-ao", false),
      ]);
      const byName = new Map<string, THREE.BufferGeometry>();
      gltf.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) byName.set(m.name || m.parent?.name || "", prep(m.geometry)); });
      const get = (n: string) => { const g = byName.get(n); if (!g) throw new Error(`kong.glb: no mesh ${n} (have ${[...byName.keys()].join(",")})`); return g; };
      const hi: Array<{ mat: AssetMat; geo: THREE.BufferGeometry }> = [{ mat: "kbody", geo: get("hi_kong") }, { mat: "khead", geo: get("hi_head") }, { mat: "kgear", geo: get("hi_gear") }, { mat: "kshoe", geo: get("hi_shoes") }, { mat: "keye", geo: get("hi_eyes") }];
      const lo = [{ mat: "kbody" as const, geo: get("lo_kong") }, { mat: "kgear" as const, geo: get("lo_gear") }, { mat: "keye" as const, geo: get("lo_eyes") }];
      const min = [{ mat: "kmin" as const, geo: get("min_all") }];
      const sum = (l: Array<{ geo: THREE.BufferGeometry }>) => l.reduce((s, x) => s + triCount(x.geo), 0);
      const posOnly = (gs: THREE.BufferGeometry[]) => mergeGeometries(gs.map((g) => { const o = new THREE.BufferGeometry(); for (const k of ["position", "normal", "aBones", "aWeights"]) o.setAttribute(k, g.attributes[k]); o.setIndex(g.index); return o; }), false)!;
      const T = { hi: maps.slice(0, 6), lo: maps.slice(6, 12), head: maps.slice(12, 15), shoes: maps.slice(15, 18) };
      const mats = new Map<number, Record<AssetMat, THREE.Material>>();
      const materials = (tier: 0 | 1 | 2) => {
        let m = mats.get(tier);
        if (m) return m;
        const t = tier === 0 ? T.hi : T.lo;
        // fur + skin: a satin sheen (the target art's glossy sculpted fur), baked AO in the atlas
        const body = actorLook(tier === 0
          ? new THREE.MeshPhysicalMaterial({ map: t[0], normalMap: t[1], aoMap: t[2], aoMapIntensity: 1.0, roughness: 0.6, metalness: 0, sheen: 0.45, sheenColor: new THREE.Color("#b8834f"), sheenRoughness: 0.45, name: "kbody" })
          : new THREE.MeshStandardMaterial({ map: t[0], normalMap: t[1], aoMap: t[2], roughness: 0.62, metalness: 0, name: "kbody-lo" }), { key: "kbody" + tier, spec: 0.55 });
        const th = tier === 0 ? T.head : t;
        const head = tier === 0
          ? actorLook(new THREE.MeshPhysicalMaterial({ map: th[0], normalMap: th[1], aoMap: th[2], aoMapIntensity: 0.6, roughness: 0.58, metalness: 0, sheen: 0.4, sheenColor: new THREE.Color("#b8834f"), sheenRoughness: 0.45, name: "khead" }), { key: "khead" + tier, spec: 0.55 })
          : body;
        const gear = actorLook(new THREE.MeshStandardMaterial({ map: t[3], normalMap: t[4], aoMap: t[5], roughness: 0.62, metalness: 0, envMapIntensity: 0.6, name: tier === 0 ? "kgear" : "kgear-lo" }), { key: "kgear" + tier, spec: 0.4 });
        const eye = new THREE.MeshPhysicalMaterial({ color: "#ffffff", roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.05, name: "keye" });
        eye.defines = { USE_UV: "" };
        const kmin = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0, name: "kmin" });
        const shoe = tier === 0
          ? actorLook(new THREE.MeshStandardMaterial({ map: T.shoes[0], normalMap: T.shoes[1], aoMap: T.shoes[2], roughness: 0.45, metalness: 0, envMapIntensity: 0.6, name: "kshoe" }), { key: "kshoe0", spec: 0.4 })
          : gear;
        m = { kbody: body, khead: head, kgear: gear, kshoe: shoe, keye: eye, kmin };
        mats.set(tier, m);
        return m;
      };
      const asset: KongAsset = {
        tiers: [hi, lo, min], tris: { hi: sum(hi), lo: sum(lo), min: sum(min) },
        shadowLo: posOnly(lo.slice(0, 2).map((x) => x.geo)), shadowMin: posOnly([min[0].geo]),
        materials,
      };
      (globalThis as { __kongAsset?: KongAsset }).__kongAsset = asset;   // dev: live material tuning from tools
      console.info(`[kong] ${KONG_VER === "v2" ? "Tripo" : "Blender"} kong (${KONG_VER}): hi ${asset.tris.hi} / lo ${asset.tris.lo} / min ${asset.tris.min} tris`);
      return asset;
    } catch (e) {
      console.warn("[kong] Blender kong unavailable, using the procedural kong:", e);
      return null;
    }
  })());
}

/** GLSL for the eye material (big cartoon-mascot eyes): from the eyeball's front-projection uv (ep = sin of
 *  the angle off the rest gaze, anti-aliased with fwidth — round at any resolution and at every LOD, the lo eyeball is
 *  60 tris): a BIG round warm-brown iris (RI 0.56, the whole iris shows at idle), a big pupil (shrinks for "wow"), a
 *  catch-light ≥ 40 % of the pupil + a small bounce light, a soft shadow under the upper lid; the LIDS are drawn on the
 *  ball in the face skin colour with a thin lash line — they close for blinks / focus (aim) / a pained wince / death
 *  (vKFace.x), the lower lid rises for a happy squint (vKFace.w > 0), wide open for "wow" (< 0); the iris follows the
 *  gaze (vKFace.yz). kLid feeds the roughness + clearcoat hooks (lids are skin). */
export const EYE_GLSL = /* glsl */ `
{
  // (the glTF export flips v: +ep.y must point UP the face — unflipped, blinks close from below, squints from above and
  //  the iris looks DOWN when the camera is above)
  vec2 ep = ( vUv - 0.5 ) * 2.0; ep.y = -ep.y;
  float aa = max( fwidth( ep.y ), 1e-4 ) * 1.3;
  float blink = clamp( vKFace.x, 0.0, 1.0 ), sq = vKFace.w;
  vec2 c = clamp( vKFace.yz, vec2( -0.34 ), vec2( 0.3 ) );
  vec2 d = ep - c; float er = length( d ), ea = max( fwidth( er ), 1e-4 ) * 1.2;
  float RI = 0.56, RP = 0.27 * ( 1.0 + 0.55 * min( sq, 0.0 ) );
  float iris = 1.0 - smoothstep( RI - ea, RI + ea, er );
  float pupil = 1.0 - smoothstep( RP - ea, RP + ea, er );
  float fib = 0.93 + 0.07 * sin( atan( d.y, d.x ) * 27.0 ) * sin( er * 40.0 );
  // warm amber-brown iris, lighter toward the bottom (lit from below like a toy's glass eye), dark limbal ring
  vec3 irisC = mix( vec3( 0.2, 0.085, 0.025 ), vec3( 0.72, 0.4, 0.12 ), smoothstep( RP, RI * 0.92, er ) * ( 0.5 + 0.5 * smoothstep( 0.3, -0.5, d.y ) ) ) * fib;
  irisC = mix( irisC, vec3( 0.05, 0.022, 0.01 ), smoothstep( RI * 0.84, RI, er ) );
  vec3 whiteC = vec3( 0.96, 0.95, 0.93 ) * ( 1.0 - 0.18 * smoothstep( 0.6, 1.0, length( ep ) ) );
  vec3 col = mix( whiteC, irisC, iris );
  col = mix( col, vec3( 0.012, 0.009, 0.01 ), pupil );
  // lids: the upper edge sits above the iris at idle (hidden under the sculpted lid) and comes down with blink / focus /
  // wince; the lower lid rises (curving up) for a happy squint
  float top0 = 0.84 - 0.12 * max( sq, 0.0 );
  float low0 = -0.84 + 0.72 * max( sq, 0.0 );
  float eU = mix( top0, low0 + 0.05, blink ) - 0.12 * ep.x * ep.x;
  float eL = low0 - ( 0.08 - 0.4 * max( sq, 0.0 ) ) * ep.x * ep.x;
  float kU = smoothstep( eU - aa, eU + aa, ep.y ), kL = 1.0 - smoothstep( eL - aa, eL + aa, ep.y );
  // soft lid shadow on the ball under the upper lid (the eye sits IN the face, not on it)
  col *= 1.0 - 0.3 * smoothstep( eU - 0.3, eU, ep.y );
  kLid = max( kU, kL );
  vec3 skin = vec3( ${FACE.lid.map((v) => v.toFixed(3)).join(", ")} );
  float lash = kU * ( 1.0 - smoothstep( eU + 0.02, eU + 0.07, ep.y ) );
  vec3 lidC = mix( skin * ( 0.84 + 0.16 * smoothstep( eU, eU + 0.5, ep.y ) ), vec3( 0.05, 0.025, 0.012 ), lash );
  lidC = mix( lidC, skin * 0.78, kL * ( 1.0 - smoothstep( eL - 0.05, eL - 0.015, ep.y ) ) );
  diffuseColor.rgb = mix( col, lidC, kLid );
  // catch-lights: a big key (0.12 — ~45 % of the pupil) on the upper pupil edge + a small bounce, hidden under the lids
  vec2 cc = c * 0.7;
  kEyeCatch = ( 1.0 - smoothstep( 0.12 - ea, 0.12 + ea, length( ( ep - cc - vec2( -0.15, 0.17 ) ) * vec2( 1.0, 0.9 ) ) ) ) + 0.6 * ( 1.0 - smoothstep( 0.05 - ea, 0.05 + ea, length( ep - cc - vec2( 0.17, -0.16 ) ) ) );
  kEyeCatch *= 1.0 - kLid;
}`;
