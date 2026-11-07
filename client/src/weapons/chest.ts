// BANANA CO. loot crate — target art loot-01-crate-closed, loot-02-crate-open, loot-03-rarity-lineup.
// Geometry: chest-geo.ts (real bevelled boards, L corner guards, chunky caps, bars, screws, 3-ply rope, skids); textures:
// chest-tex.ts (one painted atlas per style). A whole crate = ONE material (per rarity: only the seam emissive differs)
// and ONE draw. In the game the kit's ChestSystem draws every CLOSED crate through instanced batches per rarity (LOD0
// ≤ 30 m with shadows, LOD1 ≤ 120 m, nothing beyond) + one instanced additive ground aura; an opening crate gets its own
// animated body + hinged lid (InstancedMesh count 1 → the same shader program as the batches: no compile on open) and a
// pooled burst (point light from a FIXED pool that lives in the scene from boot — the light count never changes —,
// god-ray cone, star sparkles); once settled it joins the "opened" batch. Studio stages build real meshes directly.
import * as THREE from "three";
import type { WorldCtx } from "../engine/engine";
import { RARITY_COLOR, type Rarity, type WeaponId } from "../../../shared/world/map";
import { buildCrate, CUBE, TALL, type CrateGeo, type Tint } from "./chest-geo";
import { crateAtlas, type CrateStyle } from "./chest-tex";
import { InstanceBatch, ViewCull, drawn } from "./lib/batch";
import { PartBuilder } from "./lib/builder";
import { addGlint, C } from "./lib/mats";
import { bananaGeometry, filletCyl, lathe, rbox, ringGeo, tf, alignY } from "./lib/geo";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { bananaPath } from "./lib/mats";
import { gunInstance } from "./guns/index";
import type { ChestView } from "./api";
import { CHEST_CRATE } from "../../../shared/sim/crate";
import { flag } from "../flags";
import { shareAttributes } from "../engine/geo-share";
import { releaseGeometryAfterUpload } from "../engine/geometry-release";
import { onRestore } from "../engine/res/restore";

export interface ChestOpts { studio?: boolean; dressed?: boolean; tall?: boolean; style?: CrateStyle; /** keep the burst lit (staging) */ hold?: boolean; /** studio: ground aura + outer halo (loot-03); off for loot-01 (plain white sheet) */ aura?: boolean }

/** metal trim tint per rarity (vertex colour × the painted near-white band cell) — loot-03 */
const BAND: Record<Rarity, string> = { common: "#4c4c4c", uncommon: "#4fb82e", rare: "#3080ec", epic: "#9150e8", legendary: "#f2b40a", mythic: "#d0123f" };
/** seam / aura / burst glow per rarity */
const GLOW: Record<Rarity, string> = { common: "#f2f2f2", uncommon: "#8dff5a", rare: "#62c2ff", epic: "#e27dff", legendary: "#ffe23a", mythic: "#ff4a7c" };
/** seam emissive intensity: an HDR core (the seam is a 2 cm line — bloom makes the halo) */
// a DARK seam albedo (the vertex tint × 0.3): a lit albedo + the HDR core push the "hot line" over the tone shoulder
// to cream and fog the planks with halo
// the seam bead carries an emissive PROFILE (core 1.0, lips ≈0.26 — chest-tex): the core runs HOT (≈3-3.5
// linear → bloom + a white-lemon line) and the lips land ≈0.9-1.0 linear → the saturated rarity colour
const SEAM_I: Record<Rarity, number> = { common: 2.2, uncommon: 3.0, rare: 3.4, epic: 3.2, legendary: 3.3, mythic: 3.8 };
/** lineup (loot-03) seams: white-hot lines with a coloured halo */
const LINEUP_K = 3.0;
/** seam halo strength (additive ribbon ±3 cm round the ring; the tone curve eats ~3×, so it has to be HDR) */
const HALO_K = 1.5;
/** seam emissive core colour: deeper / more saturated than GLOW so the HDR core stays coloured after tone mapping (a
 *  pale core reads as a cream stripe), the bloom + glow band carry the halo */
const SEAM_CORE: Record<Rarity, string> = { common: "#b8b8b8", uncommon: "#5cff2a", rare: "#3aa0ff", epic: "#d060ff", legendary: "#fff040", mythic: "#ff2858" };

// ------------------------------------------------------------------------------------------------ assets
const geoCache = new Map<string, CrateGeo>();
/** a fresh, uncached crate: buildCrate is seeded, so a rebuild gives the same vertices */
function buildFresh(rarity: Rarity, style: CrateStyle, tall: boolean): CrateGeo {
  // the classic (loot-01) crate is banana-yellow metal; the lineup's legendary is a deeper polished gold
  // #ffd400: the grade turns a lit yellow ~6° warmer — measured h39-40 against the target art's h43-45
  const band = rarity === "legendary" && style !== "lineup" ? "#ffd400" : BAND[rarity];
  const tint: Tint = { band, gold: rarity === "legendary", seam: GLOW[rarity] };
  return buildCrate(tall ? TALL : CUBE, tint, style);
}
function arraysOf(g: THREE.BufferGeometry): Record<string, THREE.TypedArray> {
  const out: Record<string, THREE.TypedArray> = {};
  for (const [name, a] of Object.entries(g.attributes)) out[name] = (a as THREE.BufferAttribute).array;
  if (g.index) out.index = g.index.array;
  return out;
}
/** a context restore refills every released crate part in its source phase, so the parts of one crate share one rebuild;
 * the restore runner awaits each hook, so the cache lives until the bake phase rather than a microtask */
const rebuilds = new Map<string, CrateGeo>();
onRestore("bake", () => rebuilds.clear());
function rebuilt(rarity: Rarity, style: CrateStyle, tall: boolean): CrateGeo {
  const key = `${style}:${rarity}:${tall ? "T" : "C"}`;
  let g = rebuilds.get(key);
  if (!g) {
    rebuilds.set(key, (g = buildFresh(rarity, style, tall)));
  }
  return g;
}
/** the parts ?geofree releases after upload; `closed` keeps its arrays, the interact outline welds its hull from them
 * (game/highlight.ts hullOf) */
const RELEASED = ["far", "imp", "seamGlow", "body", "lid", "leftovers"] as const;
function crate(rarity: Rarity, style: CrateStyle, tall: boolean): CrateGeo {
  const key = `${style}:${rarity}:${tall ? "T" : "C"}`;
  let g = geoCache.get(key);
  if (!g) {
    g = buildFresh(rarity, style, tall);
    for (const part of [g.closed, g.far, g.imp, g.seamGlow, g.body, g.lid, g.leftovers]) if (part) shareAttributes(`crate:${style}:${tall ? "T" : "C"}`, part);
    for (const name of RELEASED) if (g[name]) releaseGeometryAfterUpload(g[name]!, () => arraysOf(rebuilt(rarity, style, tall)[name]!));
    geoCache.set(key, g);
  }
  return g;
}
const matCache = new Map<string, THREE.MeshStandardMaterial>();
export function crateMaterial(style: CrateStyle, rarity: Rarity): THREE.MeshStandardMaterial {
  const key = `${style}:${rarity}`;
  let m = matCache.get(key);
  if (!m) {
    const a = crateAtlas(style);
    // Physical for a WARM, weak dielectric specular — the standard 4 % WHITE env reflection adds ~40/255 of blue in
    // sRGB to every lit yellow (measured trim s .52-.77 vs the target art's .90-.98); the highlight
    // bands come from the glint, the reflection of the sky/cyc is tinted and faint
    m = new THREE.MeshPhysicalMaterial({
      map: a.map, normalMap: a.normalMap, normalScale: new THREE.Vector2(0.6, 0.6), roughnessMap: a.orm, metalnessMap: a.orm, aoMap: a.orm, aoMapIntensity: 0.9,
      roughness: 1, metalness: 1, vertexColors: true, emissive: new THREE.Color(SEAM_CORE[rarity]), emissiveMap: a.emissiveMap, emissiveIntensity: SEAM_I[rarity] * (style === "lineup" ? LINEUP_K : 1), envMapIntensity: 1.0,
      specularIntensity: 0.3, specularColor: new THREE.Color(1.0, 0.86, 0.5),
    });
    m.name = `crate-${style}-${rarity}`;
    // the lineup (loot-03) seams are white-hot lines with a coloured halo: a hotter core
    m.userData.seamI = SEAM_I[rarity] * (style === "lineup" ? LINEUP_K : 1);
    // painted-metal highlight bands (the target art's glossy trims) — gated by the atlas roughness so wood stays matte
    addTrimShade(m);
    addGlint(m, 0.7, { rough: true });
    matCache.set(key, m);
  }
  return m;
}
/** the glossy trims (atlas
 *  roughness < 0.45) get form shading of painted metal — a sky-lit top / darker underside, a bright rim on every bevel
 *  (screen-space curvature of the shading normal), cavity darkening in the concave corners and a faint brushed tone */
function addTrimShade(m: THREE.Material) {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = function (sh, r) {
    prev?.call(this, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
{
  float trimK = smoothstep(0.5, 0.36, roughnessFactor);
  vec3 wn = inverseTransformDirection(normal, viewMatrix);
  float cv = length(fwidth(normal)) / max(length(fwidth(vViewPosition)), 1e-5);
  float rim = smoothstep(14.0, 45.0, cv);
  diffuseColor.rgb *= mix(1.0, 0.78 + 0.3 * (0.5 + 0.5 * wn.y), trimK);
  diffuseColor.rgb = mix(diffuseColor.rgb, min(diffuseColor.rgb * 1.28 + 0.07, vec3(1.0)), rim * trimK * 0.75);
}`);
  };
  const pk = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => pk() + "|trimShade";
  m.needsUpdate = true;
}

/** impostor LOD material (≥ 48 m): the same atlas colour + seam emissive, no normal / ORM maps and no glint (a much
 *  cheaper fragment for crates that are a few dozen pixels tall) */
export function crateImpMaterial(style: CrateStyle, rarity: Rarity): THREE.MeshStandardMaterial {
  const key = `imp:${style}:${rarity}`;
  let m = matCache.get(key);
  if (!m) {
    const a = crateAtlas(style), full = crateMaterial(style, rarity);
    m = new THREE.MeshStandardMaterial({ map: a.map, vertexColors: true, roughness: 0.62, metalness: 0, emissive: full.emissive.clone(), emissiveMap: a.emissiveMap, emissiveIntensity: full.emissiveIntensity });
    m.name = `crate-imp-${style}-${rarity}`;
    m.userData.seamI = full.userData.seamI;
    matCache.set(key, m);
  }
  return m;
}
/** the opened lid angle (radians about +X at the back hinge; negative = thrown back). 92° —
 * just past upright — from the loot generator's crate shape: every placed chest is validated to swing its lid this far
 * without touching a wall, a shelf or a ceiling (shared/sim/loot-spots.ts crateClear; it was 102° + a 25 % overshoot,
 * and the lid of a chest against a wall swung through it) */
const OPEN_A = -CHEST_CRATE.open;
const openedGeo = new Map<string, THREE.BufferGeometry>();
function openedGeometry(rarity: Rarity, style: CrateStyle, tall: boolean): THREE.BufferGeometry {
  const key = `${style}:${rarity}:${tall ? "T" : "C"}`;
  let g = openedGeo.get(key);
  if (!g) {
    const c = crate(rarity, style, tall);
    const held = [c.body, c.lid, c.leftovers].every((p) => !p || p.attributes.position.array);
    g = mergeOpened(held ? c : buildFresh(rarity, style, tall));
    shareAttributes(`crate:${style}:${tall ? "T" : "C"}`, g);
    releaseGeometryAfterUpload(g, () => arraysOf(mergeOpened(rebuilt(rarity, style, tall))));
    openedGeo.set(key, g);
  }
  return g;
}
/** the opened crate as one geometry: the body, the lid swung open about its hinge, and the leftovers. Under ?geofree a
 * cached crate whose arrays were already uploaded and dropped can't be merged, so openedGeometry passes a fresh build. */
function mergeOpened(c: CrateGeo): THREE.BufferGeometry {
  const lid = c.lid.clone().applyMatrix4(new THREE.Matrix4().makeRotationX(OPEN_A)).translate(c.hinge.x, c.hinge.y, c.hinge.z);
  const body = c.body.clone();
  const parts = [body, lid, ...(c.leftovers ? [c.leftovers] : [])];
  const merged = new THREE.BufferGeometry();
  for (const k of ["position", "normal", "uv", "color"]) {
    const arr = new Float32Array(parts.reduce((n, g) => n + (g.attributes[k] as THREE.BufferAttribute).array.length, 0));
    let o = 0; for (const g of parts) { const A = g.attributes[k] as THREE.BufferAttribute; arr.set(A.array as Float32Array, o); o += A.array.length; }
    merged.setAttribute(k, new THREE.BufferAttribute(arr, (body.attributes[k] as THREE.BufferAttribute).itemSize));
  }
  merged.computeBoundingSphere();
  return merged;
}

let seamT: THREE.CanvasTexture | null = null;
/** vertical glow profile for the seam band: a bright core line fading to nothing above and below */
function seamGlowTex(): THREE.CanvasTexture {
  if (seamT) return seamT;
  const c = document.createElement("canvas"); c.width = 4; c.height = 128;
  const x = c.getContext("2d")!, g = x.createLinearGradient(0, 0, 0, 128);
  // v spans ±3 cm round the 1.8 cm ring: hot at the ring, ~35 % at 1 cm past its edge, gone by 3 cm
  // a tight core (the ring's own height) with a short exponential skirt — no plateau that could fog a plank face
  for (let i = 0; i <= 32; i++) { const v = i / 32, d = Math.abs(v - 0.5) * 2; const a = d < 0.3 ? 1 : Math.exp(-(d - 0.3) * 9) * (1 - d); g.addColorStop(v, `rgba(255,255,255,${Math.max(0, a).toFixed(3)})`); }
  x.fillStyle = g; x.fillRect(0, 0, 4, 128);
  seamT = new THREE.CanvasTexture(c); seamT.colorSpace = THREE.SRGBColorSpace;
  return seamT;
}
const seamGlowMat = (instanced: boolean, col?: THREE.Color) => {
  const m = new THREE.MeshBasicMaterial({ map: seamGlowTex(), color: col ?? 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false });
  m.name = instanced ? "chest-seam-glow" : "chest-seam-glow-1";
  // the ±3 cm halo band WIDENS with the viewing
  // distance (to ±10 cm by 20 m) so the rarity line stays a few pixels tall across a room / a field
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
  {
    vec4 sgC = vec4(0.0, 0.0, 0.0, 1.0);
#ifdef USE_INSTANCING
    sgC = instanceMatrix * sgC;
#endif
    sgC = modelMatrix * sgC;
    float sgD = distance(sgC.xyz, cameraPosition);
    transformed.y += (vMapUv.y - 0.5) * clamp((sgD - 5.0) / 15.0, 0.0, 1.0) * 0.14;
  }`);
  };
  m.customProgramCacheKey = () => "chest-seam-wide";
  return m;
};

let haloT: THREE.CanvasTexture | null = null;
/** soft ROUND radial glow (outer halo / aura) — a rounded-square falloff showed a square edge */
function haloTex(): THREE.CanvasTexture {
  if (haloT) return haloT;
  const S = 256, c = document.createElement("canvas"); c.width = c.height = S;
  const x = c.getContext("2d")!, img = x.createImageData(S, S);
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const u = i / (S - 1) * 2 - 1, v = j / (S - 1) * 2 - 1, d = Math.min(1, Math.hypot(u, v));
    // smooth gaussian-like falloff that reaches exactly 0 at the rim (no visible edge)
    const a = Math.exp(-d * d * 4.2) * (1 - d * d) * (1 - d * d);
    const k = (j * S + i) * 4; img.data[k] = img.data[k + 1] = img.data[k + 2] = 255; img.data[k + 3] = a * 255;
  }
  x.putImageData(img, 0, 0);
  haloT = new THREE.CanvasTexture(c); haloT.colorSpace = THREE.SRGBColorSpace;
  return haloT;
}

// ------------------------------------------------------------------------------------------------ burst (pooled)
const glowTexCache: { t: THREE.Texture | null } = { t: null };
function starTex(): THREE.Texture {
  if (glowTexCache.t) return glowTexCache.t;
  const s = 128, c = document.createElement("canvas"); c.width = c.height = s;
  const x = c.getContext("2d")!, m = s / 2;
  const g = x.createRadialGradient(m, m, 0, m, m, m); g.addColorStop(0, "rgba(255,255,255,1)"); g.addColorStop(0.18, "rgba(255,255,255,.55)"); g.addColorStop(0.5, "rgba(255,255,255,.08)"); g.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = g; x.fillRect(0, 0, s, s);
  // 4-point star with long thin rays (the target art's sparkle stars)
  x.fillStyle = "#fff"; x.beginPath();
  const R = m * 0.98, r = m * 0.09;
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 - Math.PI / 2, rr = k % 2 ? r : R; const px = m + Math.cos(a) * rr, py = m + Math.sin(a) * rr; k ? x.lineTo(px, py) : x.moveTo(px, py); }
  x.closePath(); x.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  glowTexCache.t = t;
  return t;
}

const SPARK_N = 64;
const SPARK_VERT = /* glsl */ `attribute vec4 aSeed; uniform float uT; uniform float uHold; uniform float uScale; uniform float uPx; varying float vA; varying float vRot;
  void main(){
    // stateless: each star rises from the crate mouth on its own loop (hold) or once (burst), twinkling; spread over the
    // back half (in front of the lid, round the loot)
    float life = 1.4 + aSeed.w * 1.6;
    float t = uHold > 0.5 ? mod(uT * 0.6 + aSeed.w * 7.0, life) : uT - aSeed.w * 0.25;
    float k = clamp(t / life, 0.0, 1.0);
    vec3 p = vec3(aSeed.x * 0.55, 0.0, -abs(aSeed.y) * 0.42 + 0.06) * uScale;
    p.xz *= 0.7 + k * 0.6;
    p.y += (0.2 + k * (0.55 + aSeed.z * 0.75)) * uScale;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float tw = 0.5 + 0.5 * sin(uT * (5.0 + aSeed.z * 7.0) + aSeed.x * 20.0);
    vA = (t < 0.0 ? 0.0 : 1.0) * smoothstep(0.0, 0.1, k) * (1.0 - smoothstep(0.7, 1.0, k)) * (0.35 + 0.65 * tw);
    vRot = aSeed.x * 3.0;
    // a few BIG four-point stars among many small glints
    gl_PointSize = (0.05 + 0.34 * aSeed.z * aSeed.z * aSeed.z) * uScale * uPx * 1100.0 / -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
const SPARK_FRAG = /* glsl */ `uniform sampler2D uMap; uniform vec3 uColor; varying float vA; varying float vRot; void main(){ vec4 t = texture2D(uMap, gl_PointCoord); gl_FragColor = vec4(uColor * t.rgb * vA * t.a, 0.0); }`;
/** god-ray FAN: RAYS quads radiating up out of the crate mouth into the back half (in front of the open lid, behind
 *  the loot), each an AXIAL billboard (turns round its own axis to face the camera — visible from any side), wider
 *  and fainter with length, flickering. Additive. */
const RAYS = 26;
const FAN_VERT = /* glsl */ `attribute vec3 aDir; attribute vec4 aRay; uniform float uT; varying vec2 vQ; varying float vI;
  void main(){
    // aRay: x = side (-1/1), y = along (0/1), z = length (m), w = seed
    float along = aRay.y, L = aRay.z;
    vec3 p = aDir * along * L;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vec3 axis = normalize((modelViewMatrix * vec4(aDir, 0.0)).xyz);
    vec3 side = normalize(cross(axis, normalize(mv.xyz)));
    float sc = length(modelViewMatrix[0].xyz);
    float wdt = (0.02 + 0.09 * along) * (0.6 + 0.8 * fract(aRay.w * 7.3)) * sc;
    mv.xyz += side * aRay.x * wdt;
    vQ = vec2(aRay.x, along);
    vI = 0.55 + 0.45 * sin(uT * (1.3 + fract(aRay.w * 3.1) * 1.7) + aRay.w * 40.0);
    gl_Position = projectionMatrix * mv;
  }`;
const FAN_FRAG = /* glsl */ `uniform vec3 uColor; uniform float uK; varying vec2 vQ; varying float vI;
  void main(){
    float across = 1.0 - abs(vQ.x); across *= across;
    float fade = pow(1.0 - vQ.y, 1.25) * smoothstep(0.0, 0.12, vQ.y);
    gl_FragColor = vec4(uColor * across * fade * vI * uK, 0.0);
  }`;
function fanGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], dir: number[] = [], ray: number[] = [], idx: number[] = [];
  let sd = 77; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < RAYS; i++) {
    // directions: up, leaning back toward the hinge (−Z), spread ±70° sideways
    const yaw = (i / (RAYS - 1) - 0.5) * 2.4 + (rnd() - 0.5) * 0.12, tilt = 0.25 + rnd() * 0.75;
    const d = new THREE.Vector3(Math.sin(yaw) * Math.sin(tilt), Math.cos(tilt), -Math.cos(yaw) * Math.sin(tilt) * 0.9).normalize();
    const L = 0.9 + rnd() * 0.9, seed = rnd();
    const b = i * 4;
    for (const [sx, al] of [[-1, 0], [1, 0], [-1, 1], [1, 1]]) { pos.push(0, 0, 0); dir.push(d.x, d.y, d.z); ray.push(sx, al, L, seed); }
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aDir", new THREE.Float32BufferAttribute(dir, 3));
  g.setAttribute("aRay", new THREE.Float32BufferAttribute(ray, 4));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 2);
  return g;
}

interface Burst { group: THREE.Group; cone: THREE.Mesh; glow: THREE.Sprite; spark: THREE.Points; light: THREE.PointLight | null; t: number; busy: boolean; hold: boolean; scale: number }
function makeBurst(): Omit<Burst, "light"> {
  const group = new THREE.Group(); group.name = "chest-burst";
  const coneMat = new THREE.ShaderMaterial({ vertexShader: FAN_VERT, fragmentShader: FAN_FRAG, uniforms: { uColor: { value: new THREE.Color() }, uK: { value: 0 }, uT: { value: 0 } }, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, side: THREE.DoubleSide, toneMapped: false });
  coneMat.name = "chest-rays";
  const cone = new THREE.Mesh(fanGeometry(), coneMat);
  // the fan starts BEHIND the heap (just in front of the hinge) — from the mouth centre its rays crossed the back-left
  // banana hand and washed it white
  cone.position.set(0, 0.06, -0.42);
  cone.name = "chest-rays"; cone.userData.castShadow = false; cone.castShadow = false; cone.receiveShadow = false; cone.renderOrder = 7; cone.frustumCulled = false;
  // a soft golden haze filling the mouth (the target art's "light pouring out")
  const glowMat = new THREE.SpriteMaterial({ map: haloTex(), color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
  glowMat.name = "chest-burst-glow";
  // pushed back to the lid (in front of the loot it washed the heap pale)
  const glow = new THREE.Sprite(glowMat); glow.name = "chest-burst-glow"; glow.scale.set(1.3, 1.0, 1); glow.position.set(0, 0.38, -0.5); glow.renderOrder = 6; glow.userData.castShadow = false;
  const sg = new THREE.BufferGeometry();
  const seeds = new Float32Array(SPARK_N * 4);
  let s = 12345; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < SPARK_N; i++) { const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()); seeds.set([Math.cos(a) * r, Math.sin(a) * r, rnd(), rnd()], i * 4); }
  sg.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 4));
  sg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SPARK_N * 3), 3));
  sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 3);
  const spMat = new THREE.ShaderMaterial({ vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG, uniforms: { uMap: { value: starTex() }, uColor: { value: new THREE.Color() }, uT: { value: 0 }, uHold: { value: 0 }, uScale: { value: 1 }, uPx: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, toneMapped: false });
  spMat.name = "chest-sparkles";
  const spark = new THREE.Points(sg, spMat); spark.name = "chest-sparkles"; spark.frustumCulled = false; spark.userData.castShadow = false; spark.renderOrder = 8;
  group.add(cone, glow, spark);
  group.visible = false;
  return { group, cone, glow, spark, t: 0, busy: false, hold: false, scale: 1 };
}
const _bc = new THREE.Color(), _gold = new THREE.Color("#ffc43a"), _goldDeep = new THREE.Color(1.0, 0.46, 0.015);
function setBurst(b: Burst, rarity: Rarity, k: number, t: number, px = 1) {
  // rays + haze: the rarity colour pulled toward a warm gold (the target art's light is golden for every crate)
  _bc.set(GLOW[rarity]).lerp(_gold, rarity === "legendary" ? 0.6 : 0.3);
  ((b.cone.material as THREE.ShaderMaterial).uniforms.uColor.value as THREE.Color).copy(_bc).multiplyScalar(1.6);
  (b.cone.material as THREE.ShaderMaterial).uniforms.uK.value = k;
  (b.cone.material as THREE.ShaderMaterial).uniforms.uT.value = t;
  (b.glow.material as THREE.SpriteMaterial).color.copy(_bc).multiplyScalar(0.32 * k);
  const sm = b.spark.material as THREE.ShaderMaterial;
  (sm.uniforms.uColor.value as THREE.Color).copy(_bc).lerp(new THREE.Color(1, 1, 1), 0.6).multiplyScalar(4.2);
  sm.uniforms.uT.value = t; sm.uniforms.uHold.value = b.hold ? 1 : 0; sm.uniforms.uScale.value = b.scale; sm.uniforms.uPx.value = px;
}

// ------------------------------------------------------------------------------------------------ system (kit)
/** 4 pooled bursts share ONE point light (every point light in the scene — even at intensity 0 — is a
 *  loop iteration in every lit fragment of the frame; four were ~0.3-0.6 ms). The most recent open owns it. */
const BURSTS = 4;
interface Member { view: ChestViewEx; rarity: Rarity; style: CrateStyle; tall: boolean; opened: boolean; seen?: boolean }
type Batches = { lod0: InstanceBatch; lod1: InstanceBatch; lod2: InstanceBatch; open: InstanceBatch; openFar: InstanceBatch };

/** smoothstep over 0..1 (clamped) — the distance fades */
const smooth01 = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
/** the kit's chest renderer: batches, aura, light + burst pool. Created once per WorldCtx (with the kit). */
export class ChestSystem {
  readonly root = new THREE.Group();
  private batches = new Map<string, Batches>();
  private aura: THREE.InstancedMesh;
  private halo: THREE.InstancedMesh;
  private seamGlow = new Map<string, THREE.InstancedMesh>();
  readonly members = new Set<Member>();
  readonly animating = new Set<ChestViewEx>();
  private bursts: Burst[] = [];
  private cull = new ViewCull();
  private _p = new THREE.Vector3();
  private _c = new THREE.Color();
  private _m = new THREE.Matrix4();
  private _s = new THREE.Vector3();
  private warmCard: THREE.Mesh;
  private warmOpen: THREE.Group;
  /** the burst that currently owns the shared light */
  lightOwner: Burst | null = null;
  /** distances (m): LOD0 (full, casting) → LOD1 → culled; aura drawn within AURA_R */
  // (perf: +1.0-1.8 ms at wpn-stress): LOD1 stops casting and hands over to a ~150-tri impostor at
  // 48 m; auras / halos / seam glows only within 70 m
  // nothing may pop: the impostor reaches 200 m and SHRINKS away over its last 40 m (a 0.6 m crate is still ~10 px
  // at 120 m with the Auto preset on a Mac); the halo / seam glow fade over their last 18 m (the seam glow is at its
  // BRIGHTEST, 2x, near its edge, so a hard cut shows); the ground aura fades to 0 by 32 m
  static LOD0_R = 26; static LOD1_R = 48; static CULL_R = 200; static FADE_R = 160; static AURA_R = 70; static AURA_FADE_R = 52; static GROUND_R = 32;
  constructor(readonly ctx: WorldCtx) {
    this.root.name = "chest-system";
    // the burst light pool: created NOW, in the scene for good, intensity 0 → the lit-program light count never changes
    const lights = new THREE.Group(); lights.name = "chest-light-pool";
    const l = new THREE.PointLight("#ffcf5a", 0, 5, 2); l.name = "chest-light"; l.castShadow = false; l.position.set(0, -4000, 0);
    lights.add(l);
    for (let i = 0; i < BURSTS; i++) {
      const b = makeBurst() as Burst; b.light = l;
      this.bursts.push(b); this.root.add(b.group);
    }
    this.root.add(lights);
    // prewarm the lid-glow program with the bursts (no compile on the first open)
    this.warmCard = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.1), lidGlowMaterial()); this.warmCard.name = "chest-lid-glow-warm"; this.warmCard.position.set(0, -4000, 0); this.warmCard.frustumCulled = false;
    this.root.add(this.warmCard);
    const auraMat = new THREE.MeshBasicMaterial({ map: haloTex(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, color: 0xffffff });
    auraMat.name = "chest-aura";
    this.aura = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2).translate(0, 0.02, 0), auraMat, 512);
    this.aura.name = "chest-aura"; this.aura.frustumCulled = false; this.aura.count = 0; this.aura.visible = false; this.aura.renderOrder = 4;
    this.aura.castShadow = false; this.aura.receiveShadow = false; this.aura.userData.castShadow = false;
    this.aura.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.aura.setColorAt(0, new THREE.Color(1, 1, 1));
    this.root.add(this.aura);
    // rarity halo: a camera-facing soft glow billboard behind every closed crate (the crate hides its centre; the rim
    // reads as an outer glow — the target art's rarity aura), one instanced draw, additive
    const haloMat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: haloTex() } },
      vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vCol;
        void main() {
          vUv = uv;
          vCol = vec3(1.0);
          #ifdef USE_INSTANCING_COLOR
          vCol = instanceColor;
          #endif
          vec4 c = modelViewMatrix * instanceMatrix * vec4(0.0, 0.55, 0.0, 1.0);
          float s = length(vec3(instanceMatrix[0].xyz));
          c.xy += position.xy * vec2(2.3, 2.1) * s;
          c.xyz += normalize(c.xyz) * 0.7 * s;   // pushed behind the crate centre
          gl_Position = projectionMatrix * c;
        }`,
      fragmentShader: /* glsl */ `uniform sampler2D uTex; varying vec2 vUv; varying vec3 vCol;
        void main() { float a = texture2D(uTex, vUv).a; gl_FragColor = vec4(vCol * a, 0.0); }`,
      transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, toneMapped: false,
    });
    haloMat.name = "chest-halo";
    this.halo = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), haloMat, 512);
    this.halo.name = "chest-halo"; this.halo.frustumCulled = false; this.halo.count = 0; this.halo.visible = false; this.halo.renderOrder = 4;
    this.halo.castShadow = false; this.halo.receiveShadow = false; this.halo.userData.castShadow = false;
    this.halo.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.halo.setColorAt(0, new THREE.Color(1, 1, 1));
    this.root.add(this.halo);
    for (const tall of [false, true]) {
      const m = new THREE.InstancedMesh(crate("common", "classic", tall).seamGlow, seamGlowMat(true), 256);
      m.name = `chest-seam-glow:${tall ? "T" : "C"}`; m.frustumCulled = false; m.count = 0; m.visible = false; m.renderOrder = 5;
      m.castShadow = false; m.receiveShadow = false; m.userData.castShadow = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.setColorAt(0, new THREE.Color(1, 1, 1));
      this.root.add(m); this.seamGlow.set(tall ? "T" : "C", m);
    }
    ctx.scene.add(this.root);
    // every rarity's batches exist from boot (so the prewarm / compile sees them) — hidden until they have members
    for (const r of Object.keys(BAND) as Rarity[]) this.batch(r, "classic", false);
    // (a first open cost a 14.8 ms frame): the per-open body + lid meshes of every rarity are drawn once during the
    // warm frames (far below the world) so their vertex buffers are on the GPU before the first crate opens
    this.warmOpen = new THREE.Group(); this.warmOpen.name = "chest-warm-open"; this.warmOpen.position.set(0, -4000, 0);
    for (const r of Object.keys(BAND) as Rarity[]) { const g = crate(r, "classic", false), m = crateMaterial("classic", r); this.warmOpen.add(instanced1(g.body, m, "warm-body"), instanced1(g.lid, m, "warm-lid")); }
    this.warmOpen.traverse((o) => { o.castShadow = false; (o as THREE.Mesh).frustumCulled = false; });
    this.root.add(this.warmOpen);
  }
  batch(rarity: Rarity, style: CrateStyle, tall: boolean): Batches {
    const key = `${style}:${rarity}:${tall ? "T" : "C"}`;
    let b = this.batches.get(key);
    if (!b) {
      const g = crate(rarity, style, tall), m = crateMaterial(style, rarity);
      b = {
        lod0: new InstanceBatch(g.closed, m, { name: `chest-lod0:${key}`, cap: 96 }),
        lod1: new InstanceBatch(g.far, m, { name: `chest-lod1:${key}`, cap: 256, castShadow: false }),
        lod2: new InstanceBatch(g.imp, crateImpMaterial(style, rarity), { name: `chest-lod2:${key}`, cap: 512, castShadow: false, receiveShadow: false }),
        open: new InstanceBatch(openedGeometry(rarity, style, tall), m, { name: `chest-open:${key}`, cap: 128 }),
        openFar: new InstanceBatch(openedGeometry(rarity, style, tall), m, { name: `chest-open-far:${key}`, cap: 256, castShadow: false }),
      };
      for (const x of [b.lod0, b.lod1, b.lod2, b.open, b.openFar]) this.root.add(x.mesh);
      this.batches.set(key, b);
    }
    return b;
  }
  grabBurst(): Burst | null {
    let best: Burst | null = null;
    for (const b of this.bursts) { if (!b.busy) return b; if (!best || b.t > best.t) best = b; }
    return best; // steal the oldest
  }
  /** the burst shaders compile in the first frames (visible, far below the world), not on the first open */
  private warm = 3;
  update(dt: number, t: number) {
    const cam = this.ctx.camera, scene = this.ctx.scene;
    if (this.warm > 0) {
      this.warm--;
      for (const b of this.bursts) if (!b.busy) { b.group.visible = this.warm > 0; if (this.warm > 0) { b.group.position.set(0, -4000, 0); setBurst(b, "common", 0.001, 0); } }
      this.warmCard.visible = this.warm > 0;
      this.warmOpen.visible = this.warm > 0;
    }
    this.cull.refresh(cam);
    const cp = this.cull.pos;
    for (const b of this.batches.values()) { b.lod0.begin(); b.lod1.begin(); b.lod2.begin(); b.open.begin(); b.openFar.begin(); }
    let na = 0, ng = 0;
    const glowN = new Map<string, number>([["C", 0], ["T", 0]]);
    const pulse = 0.8 + 0.2 * Math.sin(t * 2.6);
    const auraArr = this.aura.instanceMatrix.array as Float32Array, auraCol = this.aura.instanceColor!.array as Float32Array;
    const haloArr = this.halo.instanceMatrix.array as Float32Array, haloCol = this.halo.instanceColor!.array as Float32Array;
    for (const mb of this.members) {
      const o = mb.view.object;
      // gameplay drops a crate view by removing it from the scene (match end): forget it
      if (!o.parent) { if (mb.seen) this.members.delete(mb); continue; }
      mb.seen = true;
      if (!drawn(o, scene)) continue;
      o.updateWorldMatrix(true, false);
      this._p.setFromMatrixPosition(o.matrixWorld);
      const d = this._p.distanceTo(cp);
      if (d > ChestSystem.CULL_R) continue;
      this._p.y += 0.5;
      if (!this.cull.sees(this._p, 1.1)) continue;
      const b = this.batch(mb.rarity, mb.style, mb.tall);
      // far away the crate shrinks into its floor point instead of vanishing (scale about its own origin, on the floor)
      const fm = d > ChestSystem.FADE_R ? this._m.copy(o.matrixWorld).scale(this._s.setScalar(Math.max(0.001, 1 - smooth01((d - ChestSystem.FADE_R) / (ChestSystem.CULL_R - ChestSystem.FADE_R))))) : o.matrixWorld;
      if (mb.opened) (d < ChestSystem.LOD0_R ? b.open : b.openFar).push(fm);
      else if (d < ChestSystem.LOD0_R) b.lod0.push(o.matrixWorld);
      else if (d < ChestSystem.LOD1_R) b.lod1.push(o.matrixWorld);
      else b.lod2.push(fm);
      if (!mb.opened && d < ChestSystem.AURA_R && na < 512) {
        const gf = 1 - smooth01((d - ChestSystem.AURA_FADE_R) / (ChestSystem.AURA_R - ChestSystem.AURA_FADE_R));
        // the ground aura only near (its fill is big and it is sub-pixel detail far away)
        if (d < ChestSystem.GROUND_R) {
          o.matrixWorld.toArray(auraArr, ng * 16);
          this._c.set(GLOW[mb.rarity]).multiplyScalar(((mb.rarity === "common" ? 0.25 : 0.6) * (1 - d / ChestSystem.GROUND_R) + 0.06) * (1 - smooth01((d - 24) / (ChestSystem.GROUND_R - 24))));
          auraCol[ng * 3] = this._c.r; auraCol[ng * 3 + 1] = this._c.g; auraCol[ng * 3 + 2] = this._c.b;
          ng++;
        }
        o.matrixWorld.toArray(haloArr, na * 16);
        {
          const key = mb.tall ? "T" : "C", gm = this.seamGlow.get(key)!, gi = glowN.get(key)!;
          if (gi < 256) {
            o.matrixWorld.toArray(gm.instanceMatrix.array as Float32Array, gi * 16);
            // a ±3 cm halo round the 1.8 cm seam ring, brighter with distance so the line still reads far away
            this._c.set(GLOW[mb.rarity]).multiplyScalar(HALO_K * pulse * Math.min(2, 1 + Math.max(0, d - 20) / 30) * gf);
            const ca = gm.instanceColor!.array as Float32Array; ca[gi * 3] = this._c.r; ca[gi * 3 + 1] = this._c.g; ca[gi * 3 + 2] = this._c.b;
            glowN.set(key, gi + 1);
          }
        }
        this._c.set(GLOW[mb.rarity]).multiplyScalar((mb.rarity === "common" ? 0.07 : 0.3) * gf);
        haloCol[na * 3] = this._c.r; haloCol[na * 3 + 1] = this._c.g; haloCol[na * 3 + 2] = this._c.b;
        na++;
      }
    }
    for (const b of this.batches.values()) { b.lod0.end(); b.lod1.end(); b.lod2.end(); b.open.end(); b.openFar.end(); }
    for (const [m, c] of [[this.aura, ng], [this.halo, na]] as Array<[THREE.InstancedMesh, number]>) { m.count = c; m.visible = c > 0; if (c) { m.instanceMatrix.needsUpdate = true; m.instanceColor!.needsUpdate = true; } }
    for (const [k, m] of this.seamGlow) { const n = glowN.get(k)!; m.count = n; m.visible = n > 0; if (n) { m.instanceMatrix.needsUpdate = true; m.instanceColor!.needsUpdate = true; } }
    // seam pulse (all crates of a rarity breathe together)
    const k = 0.82 + 0.18 * Math.sin(t * 2.6);
    for (const m of matCache.values()) m.emissiveIntensity = m.userData.seamI * k;
    for (const v of this.animating) { if (!v.object.parent) { this.animating.delete(v); v.release(); continue; } v.update(dt, t); }
  }
}

// ------------------------------------------------------------------------------------------------ views
export type ChestViewEx = ChestView & { update(dt: number, t: number): void; open(instant?: boolean): void; close(): void; setLidAngle(a: number): void; release(): void };

function instanced1(g: THREE.BufferGeometry, m: THREE.Material, name: string): THREE.InstancedMesh {
  const x = new THREE.InstancedMesh(g, m, 1); x.name = name; x.setMatrixAt(0, new THREE.Matrix4()); x.castShadow = true; x.receiveShadow = true; x.frustumCulled = false;
  return x;
}

export function createChestView(ctx: WorldCtx, rarity: Rarity, opts: ChestOpts = {}, sys?: ChestSystem): ChestViewEx {
  const style: CrateStyle = opts.style ?? (opts.tall ? "lineup" : "classic");
  const tall = !!opts.tall;
  const g = crate(rarity, style, tall), mat = crateMaterial(style, rarity);
  const object = new THREE.Group(); object.name = `chest:${rarity}`;
  let closedMesh: THREE.Object3D | null = null;
  const member: Member | null = sys ? { view: null as unknown as ChestViewEx, rarity, style, tall, opened: false } : null;
  if (!sys) {
    closedMesh = instanced1(g.closed, mat, "chest-closed");
    object.add(closedMesh);
    // a ±3 cm additive halo hugging the 1.8 cm seam ring (a 16 cm band fogged the planks)
    if (style !== "supply") {
      const sg = new THREE.Mesh(g.seamGlow, seamGlowMat(false, new THREE.Color(GLOW[rarity]).multiplyScalar(HALO_K * (style === "lineup" ? 1.9 : 1))));
      sg.name = "chest-seam-glow"; sg.renderOrder = 5; sg.userData.castShadow = false; sg.castShadow = false;
      closedMesh.add(sg);
    }
    if (opts.studio && opts.aura !== false) {
      // studio: a soft coloured halo behind / under the crate (NORMAL blending: visible on the white cyc)
      const col = new THREE.Color(GLOW[rarity]);
      const halo = new THREE.Mesh(new THREE.PlaneGeometry(g.shape.w * 3.0, g.shape.d * 3.0).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: haloTex(), color: col, transparent: true, opacity: rarity === "common" ? 0.3 : 0.55, depthWrite: false, toneMapped: false }));
      halo.position.y = 0.004; halo.name = "chest-halo"; halo.userData.castShadow = false; halo.renderOrder = 2;
      object.add(halo);
      // outer glow: a camera-facing soft billboard pushed BEHIND the crate (a sprite through the crate centre washed
      // the back half of the crate) — its rim reads as an outer glow round the silhouette; NORMAL blending for the cyc
      const hh = g.shape.skid + g.shape.hBody + g.shape.seam + g.shape.hLid;
      const hm = new THREE.ShaderMaterial({
        uniforms: { uTex: { value: haloTex() }, uCol: { value: col }, uA: { value: rarity === "common" ? 0.9 : 1.45 }, uSize: { value: new THREE.Vector2(g.shape.w * 2.9, hh * 2.25) }, uPush: { value: g.shape.w * 0.9 } },
        vertexShader: /* glsl */ `uniform vec2 uSize; uniform float uPush; varying vec2 vUv;
          void main() { vUv = uv; vec4 c = modelViewMatrix * vec4(0.0, ${(0.0).toFixed(1)}, 0.0, 1.0);
            float s = length(vec3(modelMatrix[0].xyz));
            c.xy += position.xy * uSize * s; c.xyz += normalize(c.xyz) * uPush * s; gl_Position = projectionMatrix * c; }`,
        fragmentShader: /* glsl */ `uniform sampler2D uTex; uniform vec3 uCol; uniform float uA; varying vec2 vUv;
          void main() { float a = texture2D(uTex, vUv).a; gl_FragColor = vec4(uCol, min(1.0, a * uA * 1.5)); }`,
        transparent: true, depthWrite: false, toneMapped: false,
      });
      hm.name = "chest-halo-studio";
      const spr = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), hm);
      spr.position.set(0, hh * 0.5, 0); spr.name = "chest-halo-glow"; spr.renderOrder = -1; spr.frustumCulled = false; spr.userData.castShadow = false;
      object.add(spr);
    }
  }
  // animated open state (built on open)
  let body: THREE.InstancedMesh | null = null, lid: THREE.InstancedMesh | null = null, pivot: THREE.Group | null = null, loot: THREE.Group | null = null, lidGlow: THREE.Mesh | null = null;
  let burst: Burst | null = null, ownBurst: Burst | null = null, ownLight: THREE.PointLight | null = null;
  let opened = false, openT = -1, lidA = 0, settled = false;
  const hBody = g.shape.skid + g.shape.hBody;
  const worldScale = () => { object.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixScale(object.matrixWorld).x; };
  const buildOpen = () => {
    if (body) return;
    body = instanced1(g.body, mat, "chest-body");
    pivot = new THREE.Group(); pivot.name = "chest-lid-pivot"; pivot.position.copy(g.hinge);
    lid = instanced1(g.lid, mat, "chest-lid");
    pivot.add(lid);
    // the lid underside light (burst): a card just inside the lid, uv.y 0 at the hinge
    const lgm = lidGlowMaterial();
    const lgG = new THREE.PlaneGeometry(g.shape.w - 0.08, g.shape.d - 0.06);   // (rotated: uv.y 0 at the hinge edge)
    lidGlow = new THREE.Mesh(lgG, lgm); lidGlow.name = "chest-lid-glow"; lidGlow.renderOrder = 5; lidGlow.userData.castShadow = false; lidGlow.castShadow = false;
    // pivot space: the underside is at y ≈ −0.004, spanning z from the hinge (≈ Tk) to the lid's front edge
    lidGlow.rotation.x = Math.PI / 2; lidGlow.position.set(0, -0.012, -g.hinge.z);
    pivot.add(lidGlow);
    object.add(body, pivot);
    // the straw + bananas left in an opened crate (studio loot-02 has its full heap instead)
    if (g.leftovers && !opts.dressed) body.add(instanced1(g.leftovers, mat, "chest-leftovers"));
    if (closedMesh) closedMesh.visible = false;
    if (opts.dressed) { loot = dressing(tall); loot.position.y = g.shape.skid + 0.05; object.add(loot); }
  };
  const view: ChestViewEx = {
    object, hull: g.closed,
    get opened() { return opened; },
    open(instant = false) {
      if (opened) return;
      opened = true;
      if (instant) {
        // it was already open when we arrived: final pose, no burst
        if (sys && member) { member.opened = true; return; }
        buildOpen(); view.setLidAngle(OPEN_A); settled = true; return;
      }
      buildOpen();
      openT = 0;
      if (sys && member) { sys.members.delete(member); sys.animating.add(view); }
      burst = sys ? sys.grabBurst() : null;
      if (!sys) {
        ownBurst = makeBurst() as Burst; ownBurst.light = null; burst = ownBurst;
        object.add(ownBurst.group); ownBurst.group.position.set(0, hBody - 0.05, 0);
        if (opts.studio) { ownLight = new THREE.PointLight("#ffdc96", 0, 3.2 * worldScale(), 2); ownLight.position.set(0.0, hBody + 0.2, -0.15); object.add(ownLight); }
      }
      if (burst) {
        burst.busy = true; burst.t = 0; burst.hold = !!opts.hold; burst.scale = 1;
        if (sys) {
          // pooled burst: placed in world space over this crate (the pool never leaves the scene)
          object.updateWorldMatrix(true, false);
          const s = worldScale();
          burst.scale = 1;
          burst.group.position.set(0, hBody - 0.05, 0).applyMatrix4(object.matrixWorld);
          burst.group.quaternion.setFromRotationMatrix(object.matrixWorld);
          burst.group.scale.setScalar(s);
          if (burst.light) { sys.lightOwner = burst; burst.light.position.copy(burst.group.position).add(new THREE.Vector3(0, 0.35 * s, 0)); burst.light.color.set(GLOW[rarity]).lerp(new THREE.Color("#ffd27a"), 0.35); burst.light.distance = 5 * s; }
        }
        burst.group.visible = true;
      }
    },
    /** (end-game regen) shut again: the animated open parts go, the closed crate (batched: back to the
     * closed LODs with its seam glow / halo / aura; studio: its own mesh) is drawn again; open() works as on a fresh one */
    close() {
      if (!opened) return;
      view.release(); burst = null;
      opened = false; openT = -1; settled = false; lidA = 0;
      if (body) { body.removeFromParent(); pivot?.removeFromParent(); body = null; lid = null; pivot = null; }
      if (lidGlow) { (lidGlow.material as THREE.Material).dispose(); lidGlow = null; }
      if (loot) { loot.removeFromParent(); loot = null; }
      if (ownBurst) { ownBurst.group.removeFromParent(); ownBurst = null; }
      if (ownLight) { ownLight.removeFromParent(); ownLight = null; }
      if (closedMesh) closedMesh.visible = true;
      if (sys && member) { member.opened = false; sys.animating.delete(view); sys.members.add(member); }
    },
    setLidAngle(a: number) { lidA = a; if (pivot) pivot.rotation.x = a; },
    /** give the pooled burst back (view dropped mid-animation) */
    release() { if (burst && burst !== ownBurst) { burst.busy = false; burst.group.visible = false; if (burst.light && sys?.lightOwner === burst) { burst.light.intensity = 0; sys.lightOwner = null; } } burst = null; },
    update(dt: number, t: number) {
      if (openT < 0) return;
      openT += dt;
      // lid: pop (a little lift), thrown open over 0.55 s — it never swings past the open angle (the validated clearance):
      // what was the ease-out-back overshoot now knocks against the stop and rebounds a little
      const T = Math.min(1, openT / 0.55);
      const s = 1.7, k = T - 1;
      const e0 = 1 + s * k * k * k + s * k * k, e = e0 <= 1 ? e0 : 1 - (e0 - 1) * 0.55;
      view.setLidAngle(OPEN_A * e);
      if (pivot) pivot.position.y = g.hinge.y + Math.sin(Math.min(1, openT / 0.25) * Math.PI) * 0.05;
      const hold = !!opts.hold;
      // burst intensity: flash in 0.12 s, decay over ~2 s (hold: settle at a steady glow)
      const bk = openT < 0.12 ? openT / 0.12 : hold ? Math.max(0.55, Math.exp(-(openT - 0.12) * 1.6)) : Math.max(0, Math.exp(-(openT - 0.12) * 1.5) - 0.05);
      if (lidGlow) { const u = (lidGlow.material as THREE.ShaderMaterial).uniforms; u.uK.value = bk * (hold ? 1.35 : 1.1); u.uT.value = openT; (u.uCol.value as THREE.Color).set(GLOW[rarity]).lerp(_goldDeep, 0.8); }
      if (burst) {
        burst.t = openT;
        setBurst(burst, rarity, bk * (hold ? 0.8 : 1.0), openT, worldScale());
        if (burst.light && sys?.lightOwner === burst) burst.light.intensity = 7 * bk;
      }
      // studio: the golden light pouring out lights the lid underside + the heap from inside (world units × scale²)
      if (ownLight) ownLight.intensity = (flag("nolight") ? 0 : 1.6) * bk * worldScale() * worldScale();
      if (loot) { const L = Math.min(1, Math.max(0, (openT - 0.1) / 0.45)); loot.position.y = g.shape.skid + 0.05 + (1 - Math.pow(1 - L, 3)) * 0.06; }
      // settled: release the burst, hand the crate to the opened batch
      if (!hold && openT > 2.4 && !settled) {
        settled = true;
        if (burst) { burst.busy = false; burst.group.visible = false; if (burst.light && sys?.lightOwner === burst) { burst.light.intensity = 0; sys.lightOwner = null; } burst = null; }
        if (sys && member) {
          member.opened = true; sys.animating.delete(view); sys.members.add(member);
          if (body) { body.removeFromParent(); pivot!.removeFromParent(); body = null; lid = null; pivot = null; if (lidGlow) { (lidGlow.material as THREE.Material).dispose(); lidGlow = null; } }
        }
      }
      void lidA; void t;
    },
  };
  if (member) { member.view = view; sys!.members.add(member); }
  return view;
}

// ------------------------------------------------------------------------------------------------ loot heap (loot-02)
let shieldTex: THREE.CanvasTexture | null = null;
/** coconut-wood face: fibrous brown with dark cracks and an embossed banana-in-shield emblem */
function coconutShieldTex(): THREE.CanvasTexture {
  if (shieldTex) return shieldTex;
  const s = 512, c = document.createElement("canvas"); c.width = c.height = s;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(s * 0.42, s * 0.38, s * 0.05, s / 2, s / 2, s * 0.52);
  g.addColorStop(0, "#9a6a40"); g.addColorStop(0.7, "#6e4527"); g.addColorStop(1, "#4a2c17");
  x.fillStyle = g; x.fillRect(0, 0, s, s);
  let sd = 5; const r = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) { x.strokeStyle = r() < 0.5 ? `rgba(40,22,10,${0.2 + r() * 0.3})` : `rgba(190,140,90,${0.12 + r() * 0.16})`; x.lineWidth = 1 + r() * 2.5; const px = r() * s; x.beginPath(); x.moveTo(px, 0); x.bezierCurveTo(px + (r() - 0.5) * 60, s * 0.3, px + (r() - 0.5) * 60, s * 0.7, px + (r() - 0.5) * 40, s); x.stroke(); }
  // shield emblem with a banana (embossed: light rim, darker fill)
  x.save(); x.translate(s / 2, s / 2);
  const shield = () => { x.beginPath(); x.moveTo(-90, -100); x.lineTo(90, -100); x.lineTo(90, 10); x.quadraticCurveTo(90, 80, 0, 118); x.quadraticCurveTo(-90, 80, -90, 10); x.closePath(); };
  x.lineWidth = 16; x.strokeStyle = "#b9824d"; shield(); x.stroke();
  x.lineWidth = 6; x.strokeStyle = "#3a200e"; x.translate(3, 4); shield(); x.stroke(); x.translate(-3, -4);
  x.fillStyle = "#c48b53"; x.beginPath(); x.moveTo(-40, -58); x.bezierCurveTo(-70, 0, -30, 70, 40, 70); x.bezierCurveTo(10, 50, -20, 10, -12, -50); x.closePath(); x.fill();
  x.strokeStyle = "#3a200e"; x.lineWidth = 4; x.stroke();
  x.restore();
  shieldTex = new THREE.CanvasTexture(c); shieldTex.colorSpace = THREE.SRGBColorSpace; shieldTex.anisotropy = 8;
  return shieldTex;
}

let strawT: THREE.CanvasTexture | null = null;
function strawTex(): THREE.CanvasTexture {
  if (strawT) return strawT;
  const S = 256, c = document.createElement("canvas"); c.width = c.height = S;
  const x = c.getContext("2d")!; x.fillStyle = "#c9a052"; x.fillRect(0, 0, S, S);
  let sd = 9; const r = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 700; i++) { x.strokeStyle = r() < 0.6 ? `rgba(245,215,130,${0.4 + r() * 0.5})` : `rgba(120,85,30,${0.3 + r() * 0.4})`; x.lineWidth = 1 + r() * 2; const px = r() * S, py = r() * S, a = r() * Math.PI; x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * (10 + r() * 30), py + Math.sin(a) * (10 + r() * 30)); x.stroke(); }
  strawT = new THREE.CanvasTexture(c); strawT.colorSpace = THREE.SRGBColorSpace; strawT.wrapS = strawT.wrapT = THREE.RepeatWrapping; strawT.repeat.set(3, 3);
  return strawT;
}

let ammoT: THREE.CanvasTexture | null = null;
/** olive ammo-box skin: painted metal with edge wear and a pale banana stencil (BoxGeometry face UVs) */
function ammoTex(): THREE.CanvasTexture {
  if (ammoT) return ammoT;
  const S = 256, c = document.createElement("canvas"); c.width = c.height = S;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, 0, S); g.addColorStop(0, "#7b8a3c"); g.addColorStop(1, "#5d6a2a"); x.fillStyle = g; x.fillRect(0, 0, S, S);
  let sd = 3; const r = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 40; i++) { x.fillStyle = `rgba(${r() < 0.5 ? "40,48,18" : "150,160,90"},${0.08 + r() * 0.12})`; x.beginPath(); x.ellipse(r() * S, r() * S, 10 + r() * 40, 3 + r() * 8, r() * 3, 0, Math.PI * 2); x.fill(); }
  x.strokeStyle = "rgba(40,46,16,.8)"; x.lineWidth = 6; x.strokeRect(6, 6, S - 12, S - 12);
  x.strokeStyle = "rgba(190,200,120,.35)"; x.lineWidth = 2; x.strokeRect(12, 12, S - 24, S - 24);
  // a crisp stencilled banana (the box faces are ~1.6:1, so the decal is drawn narrow to land round on them), a
  // dark outline + a lit ridge — a fat blob reads as a yellow smear
  x.save(); x.translate(S * 0.5, S * 0.52); x.scale(0.62, 1);
  x.fillStyle = "#f2c21c"; bananaPath(x, 0, 0, S * 0.66, -0.35); x.fill();
  x.strokeStyle = "rgba(60,48,12,.9)"; x.lineWidth = 7; x.stroke();
  x.fillStyle = "rgba(255,240,160,.8)"; bananaPath(x, -S * 0.02, -S * 0.05, S * 0.42, -0.35); x.fill();
  x.restore();
  ammoT = new THREE.CanvasTexture(c); ammoT.colorSpace = THREE.SRGBColorSpace; ammoT.anisotropy = 8;
  return ammoT;
}

/** loot-02 dressing (every piece rests on something, nothing intersects, the bunch stands tips-up, the rounds
 *  read as rounds). The target art's heap, left → right as the camera sees it: a hand of
 *  bananas standing TIPS-UP in the back-left corner; two olive ammo boxes (open tops, a row of fat BRASS rounds with
 *  copper tips) front-centre-left, the back one propped higher; a riveted coconut-wood shield STANDING on the straw at the
 *  front right, leaning back; a banana gun lying SIDE-ON across the back of the heap (stock resting on the back ammo box,
 *  barrel on the shield's rim, muzzle up to the right); loose bananas lying along the left and right rims; leaves fanned
 *  behind the shield. Every piece rests on the straw, a box or the rim (crate-local, y = 0 at the crate floor + 5 cm,
 *  `top` = the rim). */
/** loot-02 gun centre (crate-local x / z, y above the straw) — dev: ?gunat=x,y,z */
const GUN_AT = (() => { try { const q = flag("gunat"); if (q) { const [x, y, z] = q.split(",").map(Number); return new THREE.Vector3(x, y, z); } } catch { /* */ } return new THREE.Vector3(0.02, 0.42, -0.08); })();
const GUN_ID = (() => { try { return (flag("gunid") as WeaponId | null) ?? "rocket"; } catch { return "rocket" as WeaponId; } })();
const GUN_POSE = (() => { const d = { s: 0.9, pitch: 0.5, roll: 0.0 }; /* the hero gun presented higher, muzzle up to the lid corner */ try { const q = flag("gunpose"); if (q) { const [s, p, r] = q.split(",").map(Number); return { s, pitch: p, roll: r }; } } catch { /* */ } return d; })();
/** muzzle direction sign along crate x: +1 = muzzle up to the right, −1 = muzzle down to the left (dev: ?gunrev=1) */
const GUN_REV = (() => { try { const q = flag("gunrev"); if (q !== null) return q === "1"; } catch { /* */ } return true; })();
function dressing(tall: boolean): THREE.Group {
  const g = new THREE.Group(); g.name = "chest-loot";
  const b = new PartBuilder();
  const top = (tall ? TALL : CUBE).hBody - 0.05;
  const cw = (tall ? TALL : CUBE).w - 0.1, cd = (tall ? TALL : CUBE).d - 0.1;
  // the straw lies ~11 cm under the rim (the target art's rim hides the bottoms of the boxes and the shield — the heap
  // sits IN the crate and rises out of it, it does not perch on the rim)
  const floor = top - 0.11;
  // ---- packing straw filling the crate to just under the rim, a lumpy mound
  {
    const sg = new THREE.PlaneGeometry(cw, cd, 28, 28).rotateX(-Math.PI / 2);
    const p = sg.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); const edge = Math.min(1, Math.min(cw / 2 - Math.abs(x), cd / 2 - Math.abs(z)) / 0.08); p.setY(i, floor - 0.03 + edge * (0.03 + 0.025 * Math.sin(x * 23) * Math.cos(z * 19) + 0.015 * Math.sin(x * 51 + z * 37))); }
    sg.computeVertexNormals();
    const sm = new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ map: strawTex(), roughness: 0.9, color: "#eadcb0" }));
    sm.name = "chest-straw"; sm.receiveShadow = true; g.add(sm);
  }
  // ---- ammo boxes: open-topped olive boxes, a dark interior, a row of fat brass rounds standing in each
  const ammoM = new THREE.MeshStandardMaterial({ map: ammoTex(), roughness: 0.62, metalness: 0.1 }); ammoM.name = "chest-ammo";
  const BW = 0.38, BH = 0.21, BD = 0.24;
  const box = (x: number, y: number, z: number, ry: number, rx: number, n: number) => {
    const M = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, 0)), new THREE.Vector3(1, 1, 1));
    const bm = new THREE.Mesh(new RoundedBoxGeometry(BW, BH, BD, 3, 0.02), ammoM); bm.applyMatrix4(M.clone().multiply(tf([0, BH / 2, 0]))); g.add(bm);
    const add = (geo: THREE.BufferGeometry, col: string, kind: Parameters<PartBuilder["add"]>[2], m: THREE.Matrix4) => b.add(geo, col, kind, M.clone().multiply(m));
    // rim lip + the dark inside (the rounds stand in it) + two latches + a carry handle
    add(rbox(BW + 0.014, 0.03, BD + 0.014, 0.01, 2), "#5a662a", "matte", tf([0, BH - 0.012, 0]));
    add(rbox(BW - 0.05, 0.012, BD - 0.05, 0.004, 1), "#1d2210", "matte", tf([0, BH + 0.004, 0]));
    for (const sx of [-1, 1]) add(rbox(0.05, 0.05, 0.02, 0.008, 1), "#3d4520", "matte", tf([sx * BW * 0.3, BH * 0.62, BD / 2 + 0.008]));
    add(rbox(0.12, 0.018, 0.03, 0.008, 1), "#2e3416", "matte", tf([0, BH * 0.45, BD / 2 + 0.012]));
    for (let i = 0; i < n; i++) {
      const px = -((n - 1) / 2) * 0.07 + i * 0.07;
      // a real round — a fat brass case with an extractor groove, a short rounded brass ogive and a copper tip
      add(lathe([[0.0001, -0.02], [0.027, -0.02], [0.027, 0.036], [0.024, 0.04], [0.027, 0.044], [0.027, 0.05], [0.0001, 0.05]], 22), "#d8a52e", "metal", tf([px, BH - 0.01, 0]));
      add(lathe([[0.0265, 0], [0.026, 0.014], [0.022, 0.034], [0.015, 0.048], [0.0072, 0.056], [0.0001, 0.058]], 22), "#f0c23c", "metal", tf([px, BH + 0.04, 0]));
      add(lathe([[0.0162, 0], [0.012, 0.009], [0.006, 0.015], [0.0001, 0.0165]], 16), "#8a4a22", "metal", tf([px, BH + 0.082, 0]));
    }
  };
  box(-0.2, floor + 0.02, -0.07, 0.34, -0.1, 4);         // back box, propped on the mound, tipped toward the camera
  box(-0.07, floor - 0.05, 0.2, 0.24, 0.0, 4);           // front box
  // ---- bananas
  const banana = (pos: THREE.Vector3, dir: THREE.Vector3, up: THREE.Vector3, len: number, r: number, bend = 0.95) => {
    const bg = bananaGeometry({ length: len, radius: r, bend, facets: 5, round: 0.3, along: 30, radial: 30 });
    const xp = dir.clone().normalize(), yp = up.clone().projectOnPlane(xp).normalize(), zp = new THREE.Vector3().crossVectors(xp, yp);
    const m = new THREE.Matrix4().makeBasis(xp, yp, zp).setPosition(pos);
    b.addGradient(bg, C.bananaDeep, C.banana, "y", "gloss", m);
    b.add(filletCyl(r * 0.36, r * 1.3, r * 0.1, 10, r * 0.28, r * 0.42), C.brownDark, "matte", alignY(pos.clone().addScaledVector(xp, -r * 0.5), xp.clone().negate()));
    b.add(new THREE.SphereGeometry(r * 0.2, 8, 6), "#3a2414", "matte", tf(new THREE.Vector3(len, 0, 0).applyMatrix4(m).toArray() as [number, number, number]));
  };
  // a hand of bananas standing TIPS-UP in the back-left corner: stems gathered in a crown on the straw, the fruit
  // curving up and back (bellies to the camera), leaning on the back wall
  // the concave side faces SIDEWAYS (+X, to the camera's right) so every finger shows its full crescent — facing back,
  // the curve was edge-on to the camera and the hand read as five straight pale cones
  const crown = new THREE.Vector3(-0.36, floor + 0.02, -0.3);
  for (let i = 0; i < 5; i++) {
    const a = -0.55 + i * 0.26;
    const dir = new THREE.Vector3(Math.sin(a) * 0.45 - 0.18, 1, -0.22 + Math.cos(a * 2) * 0.05);
    banana(crown.clone().add(new THREE.Vector3(Math.sin(a) * 0.09, 0.0, Math.cos(a) * 0.03 - 0.02)), dir, new THREE.Vector3(1, 0, 0.25 - i * 0.08), 0.46, 0.062, 1.05);
  }
  b.add(filletCyl(0.05, 0.08, 0.014, 14), C.brownDark, "matte", tf([crown.x, crown.y - 0.01, crown.z]));
  // loose bananas lying ALONG the rims (bellies on the rim board, a little over the edge)
  // front-left corner: two bananas lying diagonally over the rim (stems inside, tips over the corner)
  banana(new THREE.Vector3(-0.36, top + 0.06, 0.02), new THREE.Vector3(-0.45, 0.02, 0.9), new THREE.Vector3(0, 1, 0), 0.44, 0.062, 0.85);
  banana(new THREE.Vector3(-0.2, top + 0.05, 0.36), new THREE.Vector3(-0.95, 0.04, 0.3), new THREE.Vector3(0.1, 1, 0), 0.4, 0.058, 0.9);
  // front-right corner (in front of the shield): one lying across the corner, tip over the rim
  banana(new THREE.Vector3(0.2, top + 0.02, 0.38), new THREE.Vector3(0.93, 0.02, -0.37), new THREE.Vector3(0, 1, 0.2), 0.4, 0.058, 0.9);
  // right rim, behind the shield: a pair lying along the rim
  banana(new THREE.Vector3(0.49, top + 0.06, -0.38), new THREE.Vector3(-0.04, 0.06, 1), new THREE.Vector3(0.35, 1, 0), 0.42, 0.06, 0.9);
  banana(new THREE.Vector3(0.42, top + 0.13, -0.34), new THREE.Vector3(0.03, 0.1, 1), new THREE.Vector3(-0.2, 1, 0), 0.38, 0.055, 0.9);
  // leaves fanned behind the shield (back right)
  const leafS = new THREE.Shape(); leafS.moveTo(0, 0); leafS.bezierCurveTo(0.1, 0.07, 0.14, 0.24, 0, 0.4); leafS.bezierCurveTo(-0.14, 0.24, -0.1, 0.07, 0, 0);
  const lg = new THREE.ExtrudeGeometry(leafS, { depth: 0.004, bevelEnabled: false });
  // three big glossy leaves fanned out to the RIGHT of the shield (the target art's leaf spray between shield + rim)
  for (const [x, y, z, rz, ry, k] of [[0.4, floor + 0.06, -0.24, -0.5, 0.3, 1.35], [0.43, floor + 0.04, -0.1, -0.85, 0.45, 1.45], [0.44, floor + 0.02, 0.04, -1.2, 0.6, 1.2]]) b.add(lg, C.leaf, "leaf", tf([x, y, z], [0.25, ry, rz], k));
  const built = b.build({ name: "chest-loot" });
  g.add(built.root);
  // ---- coconut shield STANDING on the straw at the front right, leaning back ~17°, its face to the camera side
  const sh = new THREE.Group(); sh.name = "chest-shield";
  const R = 0.215;
  const face = new THREE.Mesh(lathe([[0.0001, 0.06], [R * 0.4, 0.052], [R * 0.75, 0.032], [R * 0.97, 0.004], [R, 0]], 48), new THREE.MeshStandardMaterial({ map: coconutShieldTex(), roughness: 0.78, metalness: 0 }));
  { const p = face.geometry.attributes.position as THREE.BufferAttribute, uv = new Float32Array(p.count * 2); for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) / (2 * R) + 0.5; uv[i * 2 + 1] = -p.getZ(i) / (2 * R) + 0.5; } face.geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); }
  sh.add(face);
  const sb = new PartBuilder();
  sb.add(new THREE.TorusGeometry(R, 0.024, 12, 64), "#868d95", "metal", tf([0, 0.006, 0], [Math.PI / 2, 0, 0]));
  sb.add(ringGeo(R + 0.012, R - 0.03, 0.032, 0.006, 64), "#666c73", "metal", tf([0, -0.004, 0]));
  for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; sb.add(new THREE.SphereGeometry(0.012, 10, 8), "#4a4f55", "metal", tf([Math.cos(a) * R, 0.026, Math.sin(a) * R])); }
  sb.add(filletCyl(R * 0.98, 0.02, 0.004, 48), "#3a2414", "matte", tf([0, -0.012, 0]));
  for (const a of [2.3, 4.0]) sb.add(new THREE.TorusGeometry(0.028, 0.008, 8, 16), C.rope, "rope", tf([Math.cos(a) * R, 0.0, Math.sin(a) * R], [0, -a, 0]));
  const sbb = sb.build({ name: "chest-shield-rim" }); sh.add(sbb.root);
  const sN = new THREE.Vector3(-0.3, 0.3, 0.9).normalize();
  sh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), sN);
  // its lowest rim point sits on the straw (the in-plane "down" is −Y projected onto the disc)
  const sDown = new THREE.Vector3(0, -1, 0).projectOnPlane(sN).normalize();
  const sC = new THREE.Vector3(0.24, 0, 0.17);
  sC.y = floor + 0.01 - sDown.y * (R + 0.024);
  sh.position.copy(sC);
  g.add(sh);
  // ---- the gun: lying ON TOP of the heap like the target art — seen from its LEFT side, muzzle up to the right toward
  // the lid's far corner, its top rolled toward the camera so the magazine + fore-grip sink BEHIND the ammo boxes into
  // the straw; the receiver rests on the back box's rounds, the barrel on the shield's upper rim
  const gun = gunInstance(GUN_ID);
  gun.root.scale.setScalar(GUN_POSE.s);
  const fwd = (GUN_REV ? new THREE.Vector3(-0.92, -GUN_POSE.pitch, 0.14) : new THREE.Vector3(0.92, GUN_POSE.pitch, -0.14)).normalize(); // muzzle direction (gun −Z)
  const upv = new THREE.Vector3(-0.2, 0.9, GUN_POSE.roll).projectOnPlane(fwd).normalize(); // gun +Y: up, rolled toward the camera
  const xax = new THREE.Vector3().crossVectors(upv, fwd.clone().negate());
  gun.root.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(xax, upv, fwd.clone().negate()));
  const acc = gun.pivots.accent; if (acc) acc.visible = false;
  const gh = new THREE.Group(); gh.add(gun.root); g.add(gh);
  gh.updateMatrixWorld(true);
  const gb = new THREE.Box3().setFromObject(gun.root);
  const gc = gb.getCenter(new THREE.Vector3());
  gh.position.set(GUN_AT.x - gc.x, GUN_AT.y + floor - gc.y, GUN_AT.z - gc.z);
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// ------------------------------------------------------------------------------------------------ lid glow (burst)
/** the golden light painted on the open lid's underside (instead of a flat
 *  peach panel): a gold wash brightest at the hinge (the crate mouth), radial rays fanning from the mouth, soft plank
 *  lines; ordered-dither noise so the gradient never bands. One shared program (per-view material clones). */
const LID_GLOW_FRAG = /* glsl */ `uniform float uK; uniform float uT; uniform vec3 uCol; varying vec2 vUv;
  float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main(){
    // vUv.y = 0 at the hinge (mouth) → 1 at the lid's free edge; vUv.x across
    vec2 c = vec2(0.5, -0.25);
    vec2 d = vUv - c; float r = length(d), a = atan(d.x, d.y);
    float rays = 0.55 + 0.45 * pow(0.5 + 0.5 * sin(a * 23.0 + 1.3) * sin(a * 9.0 - uT * 0.4), 2.0);
    // a real hot spot — lemon-white at the mouth centre, deep gold toward the free edge + the sides (the lid
    // interior: #ffe45a centre → #d99a08 rim), not a flat orange panel
    float fall = (0.3 + 0.7 * exp(-max(0.0, vUv.y) * 1.8)) * (1.0 - 0.62 * smoothstep(0.08, 0.5, abs(vUv.x - 0.5)));
    float planks = 0.88 + 0.12 * smoothstep(0.0, 0.03, abs(fract(vUv.x * 3.0) - 0.5) - 0.46);
    float on = clamp(uK * 1.3, 0.0, 1.0);
    float glow = fall * rays * planks;
    vec3 col = mix(uCol * 0.62, vec3(1.0, 0.84, 0.22), smoothstep(0.25, 0.85, glow)) * (0.55 + 0.75 * glow) + vec3(1.0, 0.92, 0.6) * pow(glow, 3.0) * 0.5;
    float a2 = on * clamp(0.84 + 0.14 * fall, 0.0, 0.97) + (h(gl_FragCoord.xy) - 0.5) / 255.0;
    gl_FragColor = vec4(col, a2);
  }`;
let lidGlowBase: THREE.ShaderMaterial | null = null;
function lidGlowMaterial(): THREE.ShaderMaterial {
  lidGlowBase ??= Object.assign(new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: LID_GLOW_FRAG, uniforms: { uK: { value: 0 }, uT: { value: 0 }, uCol: { value: new THREE.Color(1.0, 0.72, 0.1) } },
    transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
  }), { name: "chest-lid-glow" });
  const m = lidGlowBase.clone(); m.uniforms = { uK: { value: 0 }, uT: { value: 0 }, uCol: { value: new THREE.Color(1.0, 0.72, 0.1) } };
  return m;
}

export { RARITY_COLOR };
