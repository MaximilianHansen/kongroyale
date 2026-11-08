// Kong actor (contract: ./api.ts). Look: procedural on-model kong (kong-parts.ts) on a procedural rig (kong-rig.ts).
//
// Rendering = GPU rigid skinning from a bone texture, so EVERY kong in the scene draws in a handful of calls:
//   - each LOD's parts are merged per material into ONE geometry whose vertices carry their bone index (aBone);
//   - one Mesh + InstancedBufferGeometry per (LOD, material); instance attribute aSlotFade = (kong slot, dither fade);
//   - a float texture holds every kong's 16 bone matrices + 2 texels of per-kong look (team rim, shorts tint, fur
//     tone); the vertex shader fetches its bone matrix, so the draws never change when kongs move or animate.
// LOD tiers by PROJECTED HEIGHT (fov + resolution aware, so the sniper scope gets detail): hi > 200 px, lo > 52 px,
// min (1.5k tris) beyond, switched with ±8 % hysteresis and a 0.3 s screen-door crossfade right after each switch. Only a shadow PROXY casts
// (the lo body shrunk 1.5 cm along its normals, or the min body for small kongs) — the hi/lo/min meshes never do; the
// proxy is skipped in the colour pass. Friend/foe: team rim for squad mates, a warm-red rim for foes that grows with
// distance. The held weapon is a real Object3D on a per-kong hand socket that follows the right wrist bone
// (weapons area's createHeldWeapon); it is hidden once the kong is tiny on screen. Animation is budgeted by the same
// projected height: a min-tier kong re-poses at most 30 times a second, one out of view and casting no shadow into it 10
// times, and its last pose follows its body rigidly in between (ANIM_SMALL_S); drawing never changes, only how often a pose
// is computed.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { WorldCtx } from "../engine/engine";
import type { KongActor, KongPose } from "./api";
import { buildKongMin, buildKongParts, createKongMaterials, type KongMaterials, type MatKey, type PartGeo } from "./kong-parts";
import { KongAnimator, NB, BONES, BONE_LIST, boneIndex, type BoneName } from "./kong-rig";
import { loadKongAsset, EYE_GLSL, KONG_HS, FACE, KONG_VER, KONG_ALT, type KongAsset, type AssetMat } from "./kong-asset";
import { createWeaponsKit } from "../weapons/index";
import type { WeaponsKit } from "../weapons/api";
import type { Rarity, WeaponId } from "../../../shared/world/map";
import { heldMuzzle, HELD_SCALE } from "../weapons/held";
import { UNBOUNCE_GLSL } from "./look";
import { gunSpec } from "../weapons/guns/index";
import { loadAccessories, type AccPiece, type Outfit } from "./outfits";
import { flag } from "../flags";

/** socket-local foregrip of a two-handed gun (GunSpec.foreAnchor − gripAnchor, × HELD_SCALE), null for one-handed */
const foreCache = new Map<WeaponId, THREE.Vector3 | null>();
function heldFore(id: WeaponId): THREE.Vector3 | null {
  if (foreCache.has(id)) return foreCache.get(id)!;
  let v: THREE.Vector3 | null = null;
  try { const s = gunSpec(id); if (s.foreAnchor && id !== "pistol") v = s.foreAnchor.clone().sub(s.gripAnchor).multiplyScalar(HELD_SCALE); } catch { v = null; }
  foreCache.set(id, v);
  return v;
}

type Tier = 0 | 1 | 2;          // hi, lo, min
/** bone-texture rows (live kongs). The game keeps a 50-kong session pool + title/victory/prewarm kongs. */
const MAX_KONGS = 128;
/** bone matrices per kong row: the 16 rig bones + the right / left weapon SOCKETS (instanced far weapons ride them) */
const NBX = NB + 2, SOCK_R = NB, SOCK_L = NB + 1;
/** texels per kong row: 18 matrices × 4 + rim + look + fill + motion + face (eyes) + face (brows / jaw / smile) */
const ROW = NBX * 4 + 6, FACE0 = NBX * 4 + 4, FACE1 = NBX * 4 + 5;
const HEAD_I = boneIndex("head");
/** eye midpoint in the head bone frame (anatomy EYE_C × HS, a touch in front of the balls) */
const EYE_MID = new THREE.Vector3(...FACE.eyeMid);
/** pov: eye height above the head joint (the camera sits here) */
const HEAD_TOP = new THREE.Vector3(0, 0.2 * KONG_HS, 0);
const UPV = new THREE.Vector3(0, 1, 0);
/** projected-height thresholds (px of a 2 m kong) + dither band (fraction) */
// hi (60k) only above 320 px (≈ 6.5 m at 1440p; lower, the crowd drew 1.2 M tris); lo is the 6k Blender tier
/** near fade (m from the camera to the kong's body axis): [gone, fully opaque] */
const NEAR_FADE = [0.5, 1.3];
const PX_HI = 320, PX_LO = 52, HYST = 0.08, FADE_S = 0.3, PX_SHADOW_LO = 200, PX_SHADOW = 26, PX_WEAPON = 22;
/** animation budget (s between full re-poses): a kong drawn under PX_LO (the min tier) re-poses at most every ANIM_SMALL_S,
 *  one that is neither in view nor casting a shadow into it every ANIM_HIDDEN_S; in between, its last pose follows its
 *  body (KongAnimator.follow). Bigger kongs, staged ones (IK, overlays, show poses, post-processed bones) and stills
 *  re-pose every frame. */
const ANIM_SMALL_S = 1 / 30, ANIM_HIDDEN_S = 0.1;
/** held weapons follow the kong's tier: the real (full-detail, shadow-casting) weapon object only on hi kongs; lo kongs
 *  draw an instanced ≤1.5k-tri LOD per weapon id (no shadow), min kongs a ≤0.35k-tri silhouette, hidden below PX_WEAPON */
const WPN_TRIS = [1500, 350], WPN_CELL = [0.03, 0.07];
const TEAM_COLORS = ["#ffffff", "#42e0ff", "#ffd23a", "#ff6b9d", "#7dff5a", "#ff8b3d", "#c58bff", "#5affe1", "#ffb3b3"];
const FOE_RIM = new THREE.Color("#ff3b1f");
/** friend/foe rim vs projected height: faint up close (no hard halo on a kong you are standing next to), strong far
 *  away where the silhouette is all you read. The rim also WIDENS with distance (fresnel exponent near → far).
 *  [px where the ramp starts, px where it is full, near k, far k, near exponent, far exponent] */
// a broad far foe rim (k 0.8, exponent 1.7) floods the whole fur body — 15–30 m foes read as solid red fuzzballs.
// So a thin edge: strength ≤ 0.32, far exponent 3.4–3.6 (≈ the outer 8–12 % of the silhouette), fur stays brown.
const RIM_FRIEND = [300, 60, 0.0, 0.28, 6, 3.4], RIM_FOE = [300, 50, 0.0, 0.32, 6, 3.6];
const rimT = (px: number, r: number[]) => THREE.MathUtils.smoothstep(r[0] - px, 0, r[0] - r[1]);
const rimK = (px: number, r: number[]) => r[2] + (r[3] - r[2]) * rimT(px, r);
const rimP = (px: number, r: number[]) => r[4] + (r[5] - r[4]) * rimT(px, r);
/** character fill: a small warm ambient lift on every kong (the target art lights characters like a studio: fur never goes
 *  near-black in shade) — premultiplied colour added as emissive × albedo */
const FILL = new THREE.Color(0.09, 0.08, 0.062);
/** dev: ?kongtier=0|1|2 forces every kong into one LOD tier (LOD captures) */
/** dev: ?kongproxy=<cm> overrides the shadow proxy shrink (0 = no kong shadows at all) */
const PROXY_CM = flag("kongproxy");
const FORCE_TIER: Tier | null = (() => { try { const v = flag("kongtier"); return v === null ? null : (Math.max(0, Math.min(2, Number(v))) as Tier); } catch { return null; } })();
/** v2 ripe-yellow chroma / value (dev: ?kysat= / ?kyval= to tune) */
const YSAT = flag("kysat"), YVAL = flag("kyval");
// per-kong look variety (subtle: the brand look is chocolate fur + brick-red shorts)
const SHORTS = ["#ffffff", "#f2e6e0", "#ffd9c8", "#e8d0d0", "#fff0e0", "#f6dcd2"].map((c) => new THREE.Color(c));

interface Batch { tier: Tier | "shadow-lo" | "shadow-min" | "weapon" | "wshadow"; mat: MatKey | "proxy" | "weapon"; mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry; slotFade: THREE.InstancedBufferAttribute; n: number; list?: Array<[Slot, number]>; fade?: boolean;
  /** kong-variety: an accessory batch — 0..2 = hats (outfits.ts HAT_IDS), 3..5 = tops (TOP_IDS) */
  acc?: number }
interface Slot { idx: number; anim: KongAnimator; pose: KongPose | null; visible: boolean; alive: boolean; team: THREE.Color; rim: number; foe: boolean; friend: boolean; socket: THREE.Object3D; offSocket: THREE.Object3D | null; weaponVisible: boolean; weaponRarity: Rarity; px: number; inView: boolean; maxTier: Tier; shorts: THREE.Color; fur: number; lodBias: number; rimOverride: THREE.Color | null; rimOverrideK: number; fill: THREE.Color; key: number; hat: number; top: number; wpn: WeaponId | null; off: WeaponId | null; sockW: THREE.Matrix4; offW: THREE.Matrix4; wTier: number; shadow: boolean; wShadow: boolean; tier: Tier; prevTier: Tier; fade: number; seen: boolean; upTick: number; near: number; pov: boolean;
  /** seconds of animation owed since the last full re-pose (the animation budget, ANIM_SMALL_S) */
  animDt: number;
  /** (caster) this kong's team outline colour, linear (null = none) — only drawn once kongOutlines() turned them on */
  outline: THREE.Color | null }

/** rest-pose joint positions (model space): skinned vertices are stored in the rest pose, M_b = B_b · T(−J_b) */
const REST = (() => {
  const out: THREE.Vector3[] = [];
  const at = (b: BoneName): THREE.Vector3 => { const d = BONES[b]; const o = new THREE.Vector3(...d.offset); return d.parent ? o.add(at(d.parent)) : o; };
  for (const b of BONE_LIST) out.push(at(b));
  return out;
})();
const kongGLSL = /* glsl */ `
uniform highp sampler2D uKongBones;
uniform vec3 uKongRest[ ${NB} ];
#ifndef KONG_WEAPON
attribute vec4 aBones;
attribute vec4 aWeights;
#endif
attribute vec2 aSlotFade;
mat4 kFetch( highp sampler2D t, int x, int y ) { return mat4( texelFetch( t, ivec2( x, y ), 0 ), texelFetch( t, ivec2( x + 1, y ), 0 ), texelFetch( t, ivec2( x + 2, y ), 0 ), texelFetch( t, ivec2( x + 3, y ), 0 ) ); }
mat4 kSkinM( highp sampler2D t, float b, int y ) { int i = int( b + 0.5 ); mat4 M = kFetch( t, i * 4, y ); M[ 3 ].xyz -= mat3( M ) * uKongRest[ i ]; return M; }
mat4 kongSkin( highp sampler2D t ) {
  int y = int( aSlotFade.x + 0.5 );
#ifdef KONG_WEAPON
  // instanced far weapons: the right socket, or the left one for an off-hand gun (fade flag 3)
  return kFetch( t, ( aSlotFade.y > 2.5 ? ${SOCK_L} : ${SOCK_R} ) * 4, y );
#else
  mat4 M = kSkinM( t, aBones.x, y ) * aWeights.x;
  if ( aWeights.y > 0.0 ) M += kSkinM( t, aBones.y, y ) * aWeights.y;
  if ( aWeights.z > 0.0 ) M += kSkinM( t, aBones.z, y ) * aWeights.z;
  if ( aWeights.w > 0.0 ) M += kSkinM( t, aBones.w, y ) * aWeights.w;
  return M;
#endif
}
mat4 kongBone() { return kongSkin( uKongBones ); }`;
const ditherGLSL = /* glsl */ `
uniform float uKongDither;
float kongBayer( vec2 p ) {
  // the pattern shifts every frame: TAA (atmos post) resolves the screen-door into a smooth crossfade
  p += vec2( mod( uKongDither, 4.0 ), floor( uKongDither / 4.0 ) );
  ivec2 q = ivec2( mod( p, 4.0 ) );
  int i = q.x + q.y * 4;
  float m[16] = float[16]( 0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0 );
  return ( m[i] + 0.5 ) / 16.0;
}`;

/** face rig without face bones: head-rigid vertices of the body / head materials are displaced in the REST
 *  pose by analytic regions (the same head-local frame as the kong build's anatomy H(): (p − J_head) / KONG_HS) —
 *  brows up / furrowed / worried, the chin drops a little (jaw), cheeks lift with a smile. f = (browUp, browAngry, jaw,
 *  smile); browAngry < 0 = worried / pained (the INNER brow ends rise). */
const faceGLSL = /* glsl */ `
vec3 kongFaceOff( vec3 P, vec4 f ) {
  vec3 q = ( P - uKongRest[ ${HEAD_I} ] ) / ${KONG_HS.toFixed(3)};
  float ax = abs( q.x ), sx = q.x < 0.0 ? -1.0 : 1.0;
  vec3 o = vec3( 0.0 );
  // brows (v1 anatomy brow_ctrl: an arc x 0.03–0.16, y 0.32–0.345 over each eye, z ≈ −0.15; v2: the Tripo sculpt's
  // brow ridges, kong-asset.ts FACE.brow)
  vec3 bq = ( vec3( ax, q.y, q.z ) - vec3( ${FACE.brow.c.map((v) => v.toFixed(3)).join(", ")} ) ) / vec3( ${FACE.brow.r.map((v) => v.toFixed(3)).join(", ")} );
  float wb = 1.0 - smoothstep( 0.55, 1.0, length( bq ) );
  float inner = 1.0 - clamp( ( ax - ${FACE.brow.inner[0].toFixed(3)} ) / ${FACE.brow.inner[1].toFixed(3)}, 0.0, 1.0 );
  o.y += wb * ( f.x * 0.02 - f.y * 0.016 * inner + max( f.y, 0.0 ) * 0.003 );
  o.z -= wb * f.y * 0.006 * inner;
  o.x -= wb * sx * max( f.y, 0.0 ) * 0.006 * inner;
#ifdef KONG_JAW
  // jaw: the chin under the painted mouth (MOUTH_Y 0.112) drops + tucks back a touch for the open mouths
  float wj = ( 1.0 - smoothstep( 0.04, 0.1, q.y ) ) * smoothstep( -0.06, 0.0, q.y ) * ( 1.0 - smoothstep( -0.14, -0.08, q.z ) ) * ( 1.0 - smoothstep( 0.1, 0.16, ax ) );
  o.y -= wj * f.z * 0.02; o.z += wj * f.z * 0.006;
  // cheeks (anatomy round cheek at (±0.13, 0.14)) up + out with a smile, down with a frown
  float cx = ( ax - 0.12 ) / 0.05, cy = ( q.y - 0.14 ) / 0.05;
  float wc = exp( -cx * cx - cy * cy ) * ( 1.0 - smoothstep( -0.14, -0.08, q.z ) );
  o.y += wc * f.w * 0.008; o.x += sx * wc * max( f.w, 0.0 ) * 0.004;
#endif
  return o * ${KONG_HS.toFixed(3)};
}`;

/** the mouth is PAINTED analytically on the smooth sculpted muzzle (no carved
 *  permanent grin, no teeth strip, no lip slivers at 4K) from the face state f = (browUp, browAngry, jaw, smile):
 *  idle = a soft closed smile line with dimples; aim = a short flat smirk; hurt = a clenched-teeth grimace turned down;
 *  victory = a wide open D-grin (upper teeth, tongue); wow = a round "O". q = head-local position (displaced).
 *  Anti-aliased with fwidth — crisp and identical on the hi and lo heads. */
const MOUTH_GLSL = /* glsl */ `
vec3 kongMouth( vec3 col, vec3 q, vec4 f ) {
  if ( q.z > -0.2 || q.y < -0.02 || q.y > 0.2 || abs( q.x ) > 0.2 ) return col;
  float j = clamp( f.z, 0.0, 1.0 ), s = clamp( f.w, -1.0, 1.0 ), sp = max( s, 0.0 ), sn = max( -s, 0.0 );
  float px = max( fwidth( q.y ), 1e-5 ) * 1.2;
  // width: a smile widens, an open O narrows
  float W = 0.088 * ( 1.0 + 0.35 * sp - 0.1 * sn ) * ( 1.0 - 0.45 * j * ( 1.0 - sp ) * ( 1.0 - sn ) );
  float u = q.x / W, uu = clamp( abs( u ), 0.0, 1.0 ), sq = sqrt( max( 1.0 - uu * uu, 0.0 ) );
  // centre line: corners up for a smile, down for a frown; a smirk tilts it with the aim brows
  float yc = 0.112 + s * 0.032 * ( uu * uu - 0.35 ) + max( f.y, 0.0 ) * 0.014 * u;
  // opening: a flat upper lip + round lower (D-grin) when smiling, an ellipse for the O, a thin band for the grimace
  float top = yc + j * ( 0.014 + 0.034 * ( 1.0 - sp ) * ( 1.0 - sn ) ) * sq;
  float bot = yc - j * ( 0.04 + 0.036 * ( 1.0 - sn ) ) * sq;
  float lw = 0.0052 * ( 1.0 - 0.5 * pow( uu, 4.0 ) );          // the line tapers into the corners
  float ex = abs( u ) - 1.0;                                     // > 0 beyond the corners
  float din = max( max( q.y - top - lw, bot - lw - q.y ), ex * W - lw * 0.5 );
  float m = 1.0 - smoothstep( -px, px, din );
  if ( m <= 0.0 && ex * W > 0.02 ) return col;
  // the opening's interior: dark red, upper teeth (the grimace: both rows, clenched), a tongue in a big grin / O
  float open = 1.0 - smoothstep( -px, px, max( max( q.y - top, bot - q.y ), ex * W ) );
  float ht = top - bot;
  float teethH = mix( 0.42, 1.0, smoothstep( 0.2, 0.6, sn ) ) * ht;
  float teeth = open * ( 1.0 - smoothstep( -px, px, ( top - teethH ) - q.y ) ) * step( 0.004, ht );
  float gap = sn > 0.3 ? 1.0 - smoothstep( 0.0, px * 2.0, abs( q.y - ( top + bot ) * 0.5 ) - 0.0012 ) : 0.0;
  float sep = sn > 0.3 ? 1.0 - smoothstep( 0.0, px * 1.5, abs( fract( q.x / 0.022 + 0.5 ) - 0.5 ) * 0.022 - 0.0009 ) : 0.0;
  vec2 tq = vec2( q.x / ( W * 0.55 ), ( q.y - bot ) / max( ht * 0.5, 1e-4 ) );
  float tongue = open * ( 1.0 - smoothstep( 1.0 - px * 40.0, 1.0, length( tq ) ) ) * ( 1.0 - sn ) * smoothstep( 0.01, 0.03, ht );
  vec3 line = vec3( 0.16, 0.055, 0.035 );
  vec3 inside = mix( vec3( 0.2, 0.03, 0.035 ), vec3( 0.36, 0.07, 0.07 ), clamp( ( q.y - bot ) / max( ht, 1e-4 ), 0.0, 1.0 ) );
  inside = mix( inside, vec3( 0.86, 0.36, 0.36 ), tongue );
  inside = mix( inside, vec3( 0.96, 0.94, 0.88 ) * ( 1.0 - 0.5 * max( gap, sep ) ), teeth );
  vec3 mc = mix( line, inside, open );
  // a soft lower-lip shade + highlight under the line (depth without geometry), smile dimples at the corners
  float lipY = bot - lw - q.y;
  float lip = ( 1.0 - smoothstep( 0.0, 0.016, lipY ) ) * step( 0.0, lipY ) * ( 1.0 - uu * uu ) * step( abs( u ), 1.0 );
  col *= 1.0 - 0.1 * lip * ( 1.0 - smoothstep( 0.0, 0.006, lipY ) ) ;
  col *= 1.0 + 0.06 * lip * smoothstep( 0.004, 0.01, lipY );
  // dimples: a short ")" bracket round each smiling corner (yc here is the corner height: uu clamps to 1 past it)
  // (a short curl that grows out of the line end and turns up: a circle tangent to the corner, its lower-outer arc)
  vec2 dq = vec2( abs( q.x ) - W * 0.985, q.y - yc - 0.01 );
  float dimple = smoothstep( 0.2, 0.5, sp ) * ( 1.0 - smoothstep( 0.1, 0.3, j ) ) * ( 1.0 - smoothstep( 0.0, px * 1.5, abs( length( dq ) - 0.01 ) - lw * 0.5 ) ) * step( 0.0, dq.x ) * step( dq.y, 0.004 );
  col = mix( col, line, dimple );
  return mix( col, mc, m );
}`;

/** character lighting (the target art lights the kongs like a studio): the sky's env reflection is dimmed on the saturated
 *  materials (a glossy yellow mirroring the blue sky reads pale tan: sneakers / wraps measured #634c25), and the
 *  sky's blue indirect diffuse is warmed so creams + yellows stay cream / yellow in shade. Eyes, teeth, gold untouched. */
function kongIndirect(mat: string): string {
  const k = mat.replace(/-lo$/, "");
  // (kbody / khead / kgear / kmin: the Blender kong — fur reflected the golden-hour sky as purple speckle at full env)
  const spec: Record<string, number> = { fur: 0.55, hair: 0.55, skin: 0.6, shorts: 0.45, peel: 0.35, sneaker: 0.3, rubber: 0.45, pack: 0.45, min: 0.5, weapon: 0.6, kbody: 0.4, khead: 0.45, kgear: 0.3, kshoe: 0.4, kmin: 0.4 };
  // (a warm tint on the fill + atmos's warm bounce turns every yellow orange — the fill is left neutral and the
  // bounce divided back out, see look.ts)
  // against purple-grey shorts / lavender calves in shade, the Blender kong's shade keeps its own
  // hue — the blue sky irradiance is pulled 60 % toward its (slightly warm) luminance, so brown fur stays brown and the
  // red shorts stay red out of the sun, the direct sun untouched
  // v2: the pull acts on the sky IRRADIANCE only — indirectDiffuse is irradiance × albedo here, so pulling
  // the product toward its luminance also bleached the albedo (ripe-yellow sneakers / peel wraps read pale mustard)
  const shade = k === "kbody" || k === "khead" || k === "kgear" || k === "kshoe" || k === "kmin"
    ? KONG_VER === "v2"
      ? "{ vec3 kA = max( material.diffuseColor, vec3( 0.004 ) ); vec3 kI = reflectedLight.indirectDiffuse / kA; float kIl = dot( kI, vec3( 0.2126, 0.7152, 0.0722 ) ); reflectedLight.indirectDiffuse = mix( kI, vec3( kIl ) * vec3( 1.05, 1.0, 0.92 ), 0.6 ) * kA; }"
      : "{ vec3 kI = reflectedLight.indirectDiffuse; float kIl = dot( kI, vec3( 0.2126, 0.7152, 0.0722 ) ); reflectedLight.indirectDiffuse = mix( kI, vec3( kIl ) * vec3( 1.05, 1.0, 0.92 ), 0.6 ); }" : "";
  return `${UNBOUNCE_GLSL}${shade}${k in spec ? `reflectedLight.indirectSpecular *= ${spec[k].toFixed(2)};` : ""}`;
}

/** vertex-clustering decimation that keeps the albedo + facets: every vertex snaps to the mean position of its grid
 *  cell (shared by every triangle → crack-free), but colours and normals are averaged only among the vertices of the
 *  same cell that also share a paint colour bucket and a facing (dominant axis of the source face normal) — a pale
 *  average of yellow + brown + green (a crumpled far gun) cannot happen. Input: non-indexed position/normal/color. */
function clusterKeep(src: THREE.BufferGeometry, cell: number): THREE.BufferGeometry {
  const P = src.attributes.position as THREE.BufferAttribute, N = src.attributes.normal as THREE.BufferAttribute, C = src.attributes.color as THREE.BufferAttribute;
  const n = P.count, G = 4096, Hh = 2048;
  const cellOf = new Int32Array(n), keyOf = new Int32Array(n);
  const cellMap = new Map<number, number>(), cellSum: number[] = [];
  const keyMap = new Map<number, number>(), kSum: number[] = [], kCell: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), fn = new THREE.Vector3();
  for (let t = 0; t < n; t += 3) {
    a.fromBufferAttribute(P, t); b.fromBufferAttribute(P, t + 1); c.fromBufferAttribute(P, t + 2);
    fn.subVectors(c, b).cross(b.clone().sub(a)).negate();
    const ax = Math.abs(fn.x), ay = Math.abs(fn.y), az = Math.abs(fn.z);
    const face = ax >= ay && ax >= az ? (fn.x > 0 ? 0 : 1) : ay >= az ? (fn.y > 0 ? 2 : 3) : (fn.z > 0 ? 4 : 5);
    for (let v = t; v < t + 3; v++) {
      const x = P.getX(v), y = P.getY(v), z = P.getZ(v);
      const ck = ((Math.round(x / cell) + Hh) * G + (Math.round(y / cell) + Hh)) * G + (Math.round(z / cell) + Hh);
      let ci = cellMap.get(ck);
      if (ci === undefined) { ci = cellSum.length / 4; cellMap.set(ck, ci); cellSum.push(0, 0, 0, 0); }
      cellSum[ci * 4] += x; cellSum[ci * 4 + 1] += y; cellSum[ci * 4 + 2] += z; cellSum[ci * 4 + 3]++;
      cellOf[v] = ci;
      const cr = C.getX(v), cg = C.getY(v), cb = C.getZ(v);
      const key = (ci * 6 + face) * 512 + Math.round(cr * 7) * 64 + Math.round(cg * 7) * 8 + Math.round(cb * 7);
      let ki = keyMap.get(key);
      if (ki === undefined) { ki = kCell.length; keyMap.set(key, ki); kCell.push(ci); kSum.push(0, 0, 0, 0, 0, 0, 0); }
      kSum[ki * 7] += cr; kSum[ki * 7 + 1] += cg; kSum[ki * 7 + 2] += cb; kSum[ki * 7 + 3] += N.getX(v); kSum[ki * 7 + 4] += N.getY(v); kSum[ki * 7 + 5] += N.getZ(v); kSum[ki * 7 + 6]++;
      keyOf[v] = ki;
    }
  }
  const K = kCell.length, pos = new Float32Array(K * 3), nor = new Float32Array(K * 3), col = new Float32Array(K * 3);
  for (let k = 0; k < K; k++) {
    const ci = kCell[k], m = cellSum[ci * 4 + 3], w = kSum[k * 7 + 6];
    pos[k * 3] = cellSum[ci * 4] / m; pos[k * 3 + 1] = cellSum[ci * 4 + 1] / m; pos[k * 3 + 2] = cellSum[ci * 4 + 2] / m;
    col[k * 3] = kSum[k * 7] / w; col[k * 3 + 1] = kSum[k * 7 + 1] / w; col[k * 3 + 2] = kSum[k * 7 + 2] / w;
    const nx = kSum[k * 7 + 3], ny = kSum[k * 7 + 4], nz = kSum[k * 7 + 5], l = Math.hypot(nx, ny, nz) || 1;
    nor[k * 3] = nx / l; nor[k * 3 + 1] = ny / l; nor[k * 3 + 2] = nz / l;
  }
  const idx: number[] = [], seen = new Set<number>(), NC = cellSum.length / 4;
  for (let t = 0; t < n; t += 3) {
    const c0 = cellOf[t], c1 = cellOf[t + 1], c2 = cellOf[t + 2];
    if (c0 === c1 || c1 === c2 || c0 === c2) continue;
    const lo = Math.min(c0, c1, c2), hi = Math.max(c0, c1, c2), mid = c0 + c1 + c2 - lo - hi;
    const s = (lo * NC + mid) * NC + hi;
    if (seen.has(s)) continue; seen.add(s);
    idx.push(keyOf[t], keyOf[t + 1], keyOf[t + 2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("normal", new THREE.BufferAttribute(nor, 3)); g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/** kong-variety (fur poking through the tops): the v2 body fur under the kong's outfit top sinks below the cloth, up to
 *  COVER_SINK m along its inward direction (aCover.xyz), by the 4-bit level packed for that top in aCover.w (0 at the
 *  top's edges → the full sink from 5 cm inside them: the kong2 build's body_cover). The top index + 1 rides
 *  the motion texel's .a. Colour pass only: the shadow / velocity passes keep the plain fur (hidden by the cloth). */
const COVER_SINK = 0.08;
const COVER_GLSL = `#ifdef KONG_COVER
{ int tk = int( texelFetch( uKongBones, ivec2( ${NBX * 4 + 3}, int( aSlotFade.x + 0.5 ) ), 0 ).a + 0.5 );
  if ( tk > 0 ) { int lv = ( int( aCover.w + 0.5 ) >> ( 4 * ( tk - 1 ) ) ) & 15; transformed += aCover.xyz * ( float( lv ) * ${(COVER_SINK / 15).toFixed(5)} ); } }
#endif`;
/** a kong in a vehicle seat: its hat stays off (hats pressed through the tuk-tuk roof) */
const seated = (s: { pose: KongPose | null }) => s.pose !== null && (s.pose.state === "drive" || s.pose.state === "ride");
/** motion-vector pass (TAA): every drawn kong + its gun re-rendered against the scene depth, writing
 *  rg = prev uv − cur uv (camera AND skinned-bone motion: last tick's bone texture × last tick's unjittered view-proj),
 *  b = 1. The atmos TAA resolve (post.ts OBJ_VEL, ctx.shared "post:objvel") reprojects kong pixels with it — no ghosts. */
const velVert = /* glsl */ `
uniform highp sampler2D uKongBonesPrev;
uniform mat4 uVP, uPrevVP;
${kongGLSL}
varying vec4 vCur, vPrev;
void main() {
  int y = int( aSlotFade.x + 0.5 );
  mat4 B = kongSkin( uKongBones );
  float valid = texelFetch( uKongBones, ivec2( ${NBX * 4 + 3}, y ), 0 ).g;
  mat4 Bp = valid > 0.5 ? kongSkin( uKongBonesPrev ) : B;
  vec4 wp = B * vec4( position, 1.0 ), pp = Bp * vec4( position, 1.0 );
  gl_Position = projectionMatrix * viewMatrix * wp;   // the scene's (jittered) projection: the same pixels + depth
  vCur = uVP * wp; vPrev = ( valid > 0.5 ? uPrevVP : uVP ) * pp;
}`;
const velFrag = /* glsl */ `
varying vec4 vCur, vPrev;
void main() { gl_FragColor = vec4( ( vPrev.xy / vPrev.w - vCur.xy / vCur.w ) * 0.5, 1.0, 1.0 ); }`;

// ---- (caster) TEAM OUTLINES + X-RAY (client/src/caster/look.ts turns them on; the player game never builds them).
// Two extra draws per body batch, sharing its instanced geometry (same instances, same bone texture):
//   HULL  — the inverted hull of every kong, pushed out along its screen-space normal by a constant pixel width and back
//           along the view ray a little (only the silhouette against what is behind survives, no lines across the body),
//           drawn back faces only, depth-tested like the body: a crisp outline in the kong's team colour.
//   XRAY  — the kong's body pulled TOWARD the eye along each pixel's own view ray (same pixel, nearer depth) by more than a
//           kong is thick, drawn only where the depth buffer is NEARER still (depthFunc GREATER): what survives is exactly
//           the part of the kong hidden behind something else in the world — never the kong's own front, never sky. It is
//           a translucent team-coloured silhouette with a brighter fresnel edge, faded out with distance.
// Per-kong colour: a 1 × MAX_KONGS float texture (rgb = linear colour, a = 1 on) written with the bone upload.
const outlineHead = /* glsl */ `
uniform highp sampler2D uKongOutline;
uniform float uOn;
${kongGLSL}
varying vec4 vCol;
bool kongOutlineOff( out vec4 oc ) {
  oc = texelFetch( uKongOutline, ivec2( 0, int( aSlotFade.x + 0.5 ) ), 0 );
  // (a crossfade's outgoing tier carries a negative fade, the near-camera screen door a small one: no outline there)
  return oc.a <= 0.0 || uOn <= 0.0 || ( aSlotFade.y < 0.35 );
}`;
const hullVert = /* glsl */ `
uniform float uPx, uPush; uniform vec2 uRes;
${outlineHead}
void main() {
  vec4 oc; if ( kongOutlineOff( oc ) ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }
  mat4 B = kongSkin( uKongBones );
  vec4 mv = viewMatrix * ( B * vec4( position, 1.0 ) );
  mv.xyz += normalize( mv.xyz ) * uPush;
  vec4 clip = projectionMatrix * mv;
  vec3 nv = normalize( mat3( viewMatrix ) * ( mat3( B ) * normal ) );
  vec2 d = ( projectionMatrix * vec4( nv, 0.0 ) ).xy; float l = length( d ); d = l > 1e-5 ? d / l : vec2( 0.0 );
  clip.xy += d * uPx * ( uRes.y / 1080.0 ) * 2.0 / uRes * clip.w;
  vCol = oc;
  gl_Position = clip;
}`;
const hullFrag = /* glsl */ `
varying vec4 vCol;
void main() { gl_FragColor = vec4( vCol.rgb, 1.0 ); }`;
const xrayVert = /* glsl */ `
uniform float uPull, uFar, uAlpha;
${outlineHead}
varying float vFres;
void main() {
  vec4 oc; if ( kongOutlineOff( oc ) ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }
  mat4 B = kongSkin( uKongBones );
  vec4 mv = viewMatrix * ( B * vec4( position, 1.0 ) );
  float dist = length( mv.xyz );
  vec3 nv = normalize( mat3( viewMatrix ) * ( mat3( B ) * normal ) );
  vFres = 1.0 - abs( dot( nv, -mv.xyz / max( dist, 1e-4 ) ) );
  mv.xyz -= mv.xyz / max( dist, 1e-4 ) * min( uPull, dist * 0.5 );
  vCol = vec4( oc.rgb, uAlpha * ( 1.0 - smoothstep( uFar * 0.65, uFar, dist ) ) );
  gl_Position = projectionMatrix * mv;
}`;
const xrayFrag = /* glsl */ `
varying vec4 vCol; varying float vFres;
void main() { float e = pow( clamp( vFres, 0.0, 1.0 ), 1.6 ); gl_FragColor = vec4( vCol.rgb * ( 0.75 + 0.9 * e ), vCol.a * ( 0.32 + 0.68 * e ) ); }`;

/** the caster's handle on the outline passes */
export interface KongOutlines {
  /** outline on / off, x-ray on / off, outline width (px at 1080p), x-ray strength 0..1, x-ray reach (m) */
  set(o: { outline?: boolean; xray?: boolean; widthPx?: number; xrayAlpha?: number; xrayFar?: number }): void;
  readonly state: { outline: boolean; xray: boolean; widthPx: number; xrayAlpha: number; xrayFar: number };
}

/** a procedural part → model-space rest geometry with the 4-bone skin attributes (one bone, weight 1) */
function rigidPart(p: PartGeo): THREE.BufferGeometry {
  const g = p.geo.clone();
  const b = boneIndex(p.bone), J = REST[b];
  g.translate(J.x, J.y, J.z);
  const n = g.attributes.position.count, bi = new Float32Array(n * 4), bw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { bi[i * 4] = b; bw[i * 4] = 1; }
  g.setAttribute("aBones", new THREE.BufferAttribute(bi, 4)); g.setAttribute("aWeights", new THREE.BufferAttribute(bw, 4));
  return g;
}
/** per-material colour code after <color_fragment>: shorts tint / recolour, fur tone, the analytic eyes */
/** ?kong=alt (kong-asset.ts KONG_ALT): the fur goes deeper and cooler; on the head (vKHead: head-rigid vertices, head
 *  frame, −z forward) the tan skin turns a dark gorilla grey-brown except the muzzle (below the nose, front of the face) */
const ALT_FUR = `{ float al = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ); float fk = 1.0 - smoothstep( 0.07, 0.16, al );
  diffuseColor.rgb = mix( diffuseColor.rgb, mix( vec3( al ), diffuseColor.rgb, 0.65 ) * 0.5, fk ); }`;
const ALT_FACE = `if ( vKHead.y > -8.0 ) { float al = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  float skin = smoothstep( 0.12, 0.22, al ) * step( diffuseColor.b * 1.6, diffuseColor.r ) * step( 0.08 * diffuseColor.r, diffuseColor.b );   // (not the gold hoops)
  float muzzle = smoothstep( 0.16, 0.11, vKHead.y ) * smoothstep( -0.02, -0.08, vKHead.z );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.06, 0.044, 0.037 ) * ( 0.55 + 1.2 * al ), skin * ( 1.0 - muzzle ) ); }`;
/** ?kong=alt: the forelock tuft (the spikes on the head's top-front) pressed down to a low cap; the mane behind stays */
const ALT_TUFT = `if ( vKHead.y > 0.32 ) { float tk = ( vKHead.y - 0.32 ) * 0.75 * smoothstep( 0.22, 0.06, vKHead.z ); transformed.y -= tk * ${KONG_HS.toFixed(3)}; vKHead.y -= tk; }`;
function colorCode(mat: string): string {
  const k = mat.replace(/-lo$/, "");
  const LUMA = "dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) )";
  if (KONG_ALT && (k === "kbody" || k === "khead")) return `diffuseColor.rgb *= mix( vKLook.a, 1.0, smoothstep( 0.18, 0.4, ${LUMA} ) );\n${ALT_FUR}\n${ALT_FACE}`;
  if (KONG_ALT && k === "kmin") return `${ALT_FUR}\n` + colorCode("kmin-base");
  if (k === "shorts") return `if ( vKLook.r < 0.0 ) diffuseColor.rgb = -vKLook.rgb * clamp( ${LUMA} / 0.118, 0.3, 1.2 ); else diffuseColor.rgb *= vKLook.rgb;`;
  if (k === "fur" || k === "hair") return "diffuseColor.rgb *= vKLook.a;";
  if (k === "kbody" || k === "khead") return `diffuseColor.rgb *= mix( vKLook.a, 1.0, smoothstep( 0.18, 0.4, ${LUMA} ) );`;
  // clothing atlas: only the brick-red shorts fabric takes the per-kong tint / outfit recolour
  // (linear space: ripe yellow is (0.93, 0.54, 0.0) — an r − 1.4·max(g, b) test counts the sneakers + peel as
  //  "red" and recolours them with the outfit; the green-weighted test keeps only the brick-red fabric)
  // against a purple-grey smudge on the lo shorts at 10 m: a RATIO test (dark / AO-shaded reds and
  // the hem's brown bleed still count as fabric) + everything that is not a bright yellow / cream is matte (kRed also
  // drives the roughness: the lo shorts' failed-test texels were glossy and mirrored the blue sky)
  // v2: ripe yellow (sneakers, peel wraps) gets more chroma and a touch less value — in the sun the post's
  // neutral tone curve compresses a bright yellow toward white (it read pale mustard next to the guns' yellow)
  const ripe = KONG_VER === "v2" && (k === "kgear" || k === "kshoe")
    ? `{ float yl = ${LUMA}; float yy = smoothstep( 0.35, 0.8, ( diffuseColor.r - diffuseColor.b ) / max( yl, 1e-3 ) ) * smoothstep( 0.02, 0.12, diffuseColor.g - diffuseColor.b ) * smoothstep( 0.1, 0.25, yl ); diffuseColor.rgb = mix( diffuseColor.rgb, max( vec3( yl ) + ( diffuseColor.rgb - vec3( yl ) ) * ${YSAT.toFixed(3)}, 0.0 ) * ${YVAL.toFixed(3)}, yy ); }\n` : "";
  if (k === "kshoe") return ripe;
  if (k === "kgear") return ripe + `{ float red = smoothstep( 1.15, 1.7, diffuseColor.r / max( max( diffuseColor.g * 2.6, diffuseColor.b * 1.6 ), 0.004 ) ) * smoothstep( 0.012, 0.03, diffuseColor.r ); kRed = max( red, 1.0 - smoothstep( 0.2, 0.34, ${LUMA} ) ); vec3 tint = vKLook.r < 0.0 ? -vKLook.rgb * clamp( ${LUMA} / 0.118, 0.3, 1.2 ) : diffuseColor.rgb * vKLook.rgb; diffuseColor.rgb = mix( diffuseColor.rgb, tint, red ); }`;
  // the far tier (vertex colours): the shorts keep the kong's tint / outfit colour (else teal shorts turn red at the
  // switch). Fur and shorts share the colours here, so the test is the shorts' far higher red / green ratio.
  if (k === "kmin" || k === "kmin-base") return `{ float red = smoothstep( 8.0, 14.0, diffuseColor.r / max( diffuseColor.g, 1e-4 ) ) * smoothstep( 0.06, 0.12, diffuseColor.r ); vec3 tint = vKLook.r < 0.0 ? -vKLook.rgb * clamp( ${LUMA} / 0.118, 0.3, 1.2 ) : diffuseColor.rgb * vKLook.rgb; diffuseColor.rgb = mix( diffuseColor.rgb, tint, red ); }`;
  if (k === "keye") return EYE_GLSL;
  return "";
}

class KongManager {
  slots: Slot[] = [];
  private free: number[] = [];
  group = new THREE.Group();
  /** the procedural kong's painted materials: only the procedural body draws with them (?kongv=1, or kong.glb failed
   *  to load), so they are painted on first use. (perf: painting them up front cost 0.5-0.8 s of main thread in every
   *  boot, inside the first createKong, though the Blender kong never draws them) */
  private get mats(): KongMaterials { return this.paintedMats ??= createKongMaterials(); }
  private paintedMats: KongMaterials | null = null;
  weapons: WeaponsKit;
  tris = { hi: 0, lo: 0, min: 0 };
  batches: Batch[] = [];
  /** bone textures, ping-pong per tick: [cur] = this tick's bones, [cur ^ 1] = last tick's (motion vectors) */
  private datas = [new Float32Array(ROW * 4 * MAX_KONGS), new Float32Array(ROW * 4 * MAX_KONGS)];
  private texs: THREE.DataTexture[];
  private cur = 0;
  private uBones: { value: THREE.DataTexture };
  private uBonesPrev: { value: THREE.DataTexture };
  private uRest = { value: REST };
  /** engine ticks (frame() calls): the bone upload + motion vectors run once per tick */
  private tick = 0; private uploadedTick = -1;
  private projU = new THREE.Matrix4(); private vpCur = new THREE.Matrix4(); private vpPrev = new THREE.Matrix4();
  private uDither = { value: 0 };
  private ditherFrame = 0;
  private camPos = new THREE.Vector3();
  private frustum = new THREE.Frustum(); private projView = new THREE.Matrix4(); private sphere = new THREE.Sphere();
  private drawSize = new THREE.Vector2();
  private tierList: Array<Array<[Slot, number]>> = [[], [], []];
  /** colour pass never draws a proxy (instanceCount 0 when the draw material is this one) */
  private proxyMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
  private shadowList: Array<Slot[]> = [[], []];
  // ---- motion vectors (see velVert)
  private velScene = new THREE.Scene();
  private velRT: THREE.WebGLRenderTarget[] = [];
  private velIdx = 0;
  private velMeshes: Array<[Batch, THREE.Mesh]> = [];
  private velWpn = new Map<WeaponId, Batch>();
  private velMatB: THREE.ShaderMaterial | null = null; private velMatW: THREE.ShaderMaterial | null = null;
  private velMat(weapon: boolean) {
    const mk = () => new THREE.ShaderMaterial({
      vertexShader: velVert, fragmentShader: velFrag, defines: weapon ? { KONG_WEAPON: "" } : {},
      uniforms: { uKongBones: this.uBones, uKongBonesPrev: this.uBonesPrev, uKongRest: this.uRest, uVP: { value: this.vpCur }, uPrevVP: { value: this.vpPrev } },
      depthWrite: false, depthFunc: THREE.LessEqualDepth, polygonOffset: true, polygonOffsetFactor: weapon ? -4 : -1, polygonOffsetUnits: weapon ? -4 : -1,
    });
    return weapon ? (this.velMatW ??= mk()) : (this.velMatB ??= mk());
  }

  constructor(readonly ctx: WorldCtx, asset: KongAsset | null = null, acc: { hats: AccPiece[]; tops: AccPiece[] } | null = null) {
    this.group.name = "kongs";
    for (let i = MAX_KONGS - 1; i >= 0; i--) this.free.push(i);
    this.texs = this.datas.map((d) => { const t = new THREE.DataTexture(d, ROW, MAX_KONGS, THREE.RGBAFormat, THREE.FloatType); t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; return t; });
    this.uBones = { value: this.texs[0] }; this.uBonesPrev = { value: this.texs[1] };
    this.weapons = createWeaponsKit(ctx);
    this.asset = asset;
    if (asset) {
      // the Blender-built kong: per tier one mesh per material (body atlas, clothing atlas, eyes / the far tier)
      this.tris = { ...asset.tris };
      for (const tier of [0, 1, 2] as Tier[]) {
        const M = asset.materials(tier);
        for (const { mat, geo } of asset.tiers[tier]) {
          const material = this.assetMaterial(M[mat], mat, tier);
          this.addBatch(tier, mat, geo, material, false);
          this.addBatch(tier, mat, geo, this.fadeTwin(material), false).fade = true;
        }
      }
      this.addBatch("shadow-lo", "proxy", asset.shadowLo, this.proxyMat, true);
      this.addBatch("shadow-min", "proxy", asset.shadowMin, this.proxyMat, true);
      // kong-variety: hats + tops as instanced skinned batches (hi + lo tiers; no shadow, no min tier) — a batch only
      // draws when a visible kong of its tier wears it
      if (acc) [...acc.hats, ...acc.tops].forEach((a, i) => {
        const material = this.patchKong(a.mat, "acc" as MatKey);
        const id = i < acc.hats.length ? i : 3 + i - acc.hats.length;
        // all three tiers (else the far tier drops the hat + top at ~26 m): the min tier draws the lo pieces
        for (const tier of [0, 1, 2] as const) {
          const geo = a.tiers[Math.min(tier, 1)];
          this.addBatch(tier, "acc" as MatKey, geo, material, false).acc = id;
          const f = this.addBatch(tier, "acc" as MatKey, geo, this.fadeTwin(material), false); f.fade = true; f.acc = id;
        }
      });
    } else {
      const hi = buildKongParts("hi"), lo = buildKongParts("lo"), min = buildKongMin();
      this.tris = { hi: hi.tris, lo: lo.tris, min: min.tris };
      const tierParts: Array<[Tier, PartGeo[]]> = [[0, hi.parts], [1, lo.parts], [2, min.parts]];
      for (const [tier, parts] of tierParts) {
        const byMat = new Map<MatKey, THREE.BufferGeometry[]>();
        for (const p of parts) (byMat.get(p.mat) ?? byMat.set(p.mat, []).get(p.mat)!).push(rigidPart(p));
        for (const [mat, geos] of byMat) {
          const material = tier === 0 ? this.kongMaterial(mat) : this.loMaterial(mat);
          const merged = mergeGeometries(geos, false)!;
          this.addBatch(tier, mat, merged, material, false);
          // crossfading instances draw through a DITHER twin: the solid program has no `discard`, so Apple's hidden
          // surface removal keeps working for every kong that is not mid-crossfade (almost all of them)
          this.addBatch(tier, mat, merged, this.fadeTwin(material), false).fade = true;
          for (const g of geos) g.dispose();
        }
      }
      // shadow proxies: merged lo body (near) / min body (far), all one material, shrunk inward in the depth pass
      const whole = (parts: PartGeo[]) => mergeGeometries(parts.map((p) => { const g = rigidPart(p), o = new THREE.BufferGeometry(); for (const k of ["position", "normal", "aBones", "aWeights"]) o.setAttribute(k, g.attributes[k]); o.setIndex(g.index); return o; }), false)!;
      this.addBatch("shadow-lo", "proxy", whole(lo.parts), this.proxyMat, true);
      this.addBatch("shadow-min", "proxy", whole(min.parts), this.proxyMat, true);
    }
    // the batches no frame before ready draws (the lo tier, every dither twin, the hats and tops; the min tier's solid
    // batch draws in the boot warm frames): ?deferkong=1 compiles them after ready (game/index.ts prewarmMatch) instead
    // of in the boot compile and the title's warm-up
    for (const b of this.batches) if (typeof b.tier === "number" && (b.tier === 1 || b.fade || b.acc !== undefined)) b.mesh.userData.krMatchOnly = true;
    ctx.scene.add(this.group);
    ctx.onUpdate((dt) => this.frame(dt));
    // body motion vectors: every colour batch (solid + dither twins) shares its geometry with a velocity mesh
    for (const b of this.batches) if (typeof b.tier === "number") { const m = new THREE.Mesh(b.geo, this.velMat(false)); m.frustumCulled = false; m.visible = false; this.velScene.add(m); this.velMeshes.push([b, m]); }
    ctx.shared.set("post:objvel", (r: THREE.WebGLRenderer, depth: THREE.Texture | null) => this.velocityPass(r, depth));
  }

  /** render the kong motion vectors against the scene depth (called by the TAA resolve; null = nothing moving drawn) */
  private velocityPass(r: THREE.WebGLRenderer, depth: THREE.Texture | null): { cur: THREE.Texture; prev: THREE.Texture } | null {
    if (!depth || !(depth as THREE.DepthTexture).isDepthTexture) return null;
    let any = false;
    for (const [b, m] of this.velMeshes) { m.visible = b.n > 0; any ||= m.visible; }
    for (const b of this.velWpn.values()) { b.mesh.visible = b.n > 0; any ||= b.mesh.visible; }
    if (!any) return null;
    const img = depth.image as { width: number; height: number };
    if (!this.velRT.length) for (let i = 0; i < 2; i++) {
      const t = new THREE.WebGLRenderTarget(img.width, img.height, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, stencilBuffer: false, generateMipmaps: false });
      t.texture.colorSpace = THREE.NoColorSpace; this.velRT.push(t);
    }
    this.velIdx ^= 1;
    const rt = this.velRT[this.velIdx], prev = this.velRT[this.velIdx ^ 1];
    // (never dispose / resize a target while the SCENE's depth texture is attached: three's render-target dispose
    // disposes its depthTexture too)
    if (rt.width !== img.width || rt.height !== img.height || rt.depthTexture !== depth) {
      rt.depthTexture = null; rt.dispose(); rt.setSize(img.width, img.height); rt.depthTexture = depth as THREE.DepthTexture;
    }
    const was = r.getRenderTarget(), ac = r.autoClear, cc = r.getClearColor(this._cc), ca = r.getClearAlpha();
    r.setRenderTarget(rt); r.setClearColor(0x000000, 0); r.clear(true, false, false);
    r.autoClear = false;
    r.render(this.velScene, this.ctx.camera);
    r.autoClear = ac; r.setClearColor(cc, ca); r.setRenderTarget(was);
    return { cur: rt.texture, prev: prev.texture };
  }
  private _cc = new THREE.Color();

  // ---- (caster) team outlines + x-ray: built on the first kongOutlines() call only
  private outl: { data: Float32Array; tex: THREE.DataTexture; hull: THREE.ShaderMaterial; xray: THREE.ShaderMaterial; api: KongOutlines } | null = null;
  enableOutlines(): KongOutlines {
    if (this.outl) return this.outl.api;
    const data = new Float32Array(MAX_KONGS * 4);
    const tex = new THREE.DataTexture(data, 1, MAX_KONGS, THREE.RGBAFormat, THREE.FloatType); tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    const uTex = { value: tex }, uOn = { value: 1 }, uXOn = { value: 0 }, uRes = { value: new THREE.Vector2(1920, 1080) };
    const hull = new THREE.ShaderMaterial({ vertexShader: hullVert, fragmentShader: hullFrag, side: THREE.BackSide,
      uniforms: { uKongBones: this.uBones, uKongRest: this.uRest, uKongOutline: uTex, uOn, uPx: { value: 2.4 }, uPush: { value: 0.06 }, uRes } });
    const xray = new THREE.ShaderMaterial({ vertexShader: xrayVert, fragmentShader: xrayFrag, side: THREE.FrontSide, transparent: true, depthWrite: false, depthFunc: THREE.GreaterDepth,
      uniforms: { uKongBones: this.uBones, uKongRest: this.uRest, uKongOutline: uTex, uOn: uXOn, uPull: { value: 0.9 }, uFar: { value: 320 }, uAlpha: { value: 0.55 } } });
    hull.name = "kong-outline-hull"; xray.name = "kong-outline-xray";
    const vp = new THREE.Vector4();
    // every drawn body batch (all tiers, solid + dither twins, hats / tops) gets a hull + an x-ray twin; eyes sit inside
    for (const b of this.batches) {
      if (typeof b.tier !== "number" || b.mat === "keye") continue;
      for (const [mat, order] of [[hull, 0], [xray, 60]] as const) {
        const m = new THREE.Mesh(b.geo, mat);
        m.name = `${b.mesh.name}-${mat === hull ? "outline" : "xray"}`;
        m.frustumCulled = false; m.castShadow = false; m.receiveShadow = false; m.userData.castShadow = false; m.userData.farShadow = false; m.renderOrder = order;
        // (any override-material pass — water bake, depth / normal prepasses — never sees the outlines)
        m.onBeforeRender = (r, scene) => {
          this.upload(r);
          if ((scene as THREE.Scene).overrideMaterial || !m.visible) { b.geo.instanceCount = 0; return; }
          r.getCurrentViewport(vp); uRes.value.set(Math.max(1, vp.z), Math.max(1, vp.w)); b.geo.instanceCount = b.n;
        };
        m.onAfterRender = () => { b.geo.instanceCount = b.n; };
        // visible only while its batch draws something and its pass is on (set each tick in frame())
        m.visible = false; m.userData.outlineOf = b; m.userData.outlinePass = mat === hull ? 0 : 1;
        this.group.add(m); this.outlineMeshes.push(m);
      }
    }
    const st = { outline: true, xray: false, widthPx: 2.4, xrayAlpha: 0.55, xrayFar: 320 };
    const api: KongOutlines = {
      state: st,
      set: (o) => {
        if (o.outline !== undefined) st.outline = o.outline; if (o.xray !== undefined) st.xray = o.xray;
        if (o.widthPx !== undefined) st.widthPx = o.widthPx; if (o.xrayAlpha !== undefined) st.xrayAlpha = o.xrayAlpha; if (o.xrayFar !== undefined) st.xrayFar = o.xrayFar;
        uOn.value = st.outline ? 1 : 0; uXOn.value = st.xray ? 1 : 0; hull.uniforms.uPx.value = st.widthPx; xray.uniforms.uAlpha.value = st.xrayAlpha; xray.uniforms.uFar.value = st.xrayFar;
      },
    };
    this.outl = { data, tex, hull, xray, api };
    return api;
  }
  private readonly outlineMeshes: THREE.Mesh[] = [];
  /** per tick: an outline mesh draws when its batch does and its pass is on */
  private outlineFrame() {
    const o = this.outl; if (!o) return;
    const st = o.api.state;
    for (const m of this.outlineMeshes) { const b = m.userData.outlineOf as Batch; m.visible = b.n > 0 && (m.userData.outlinePass === 0 ? st.outline : st.xray); }
  }

  readonly asset: KongAsset | null;
  private assetMats = new Map<THREE.Material, THREE.Material>();
  private assetMaterial(m: THREE.Material, mat: AssetMat, tier: Tier): THREE.Material {
    let p = this.assetMats.get(m);
    if (!p) { p = this.patchKong(m, `${mat}${tier ? "-lo" : ""}` as MatKey); this.assetMats.set(m, p); }
    return p;
  }
  private kongMaterial(mat: MatKey): THREE.Material {
    return this.patchKong(this.mats.mats[mat as keyof KongMaterials["mats"]], mat);
  }
  private loMats = new Map<MatKey, THREE.Material>();
  /** lo / min tiers (crowds): the sheen-less MeshStandard twin of a Physical material (same maps) — a crowd kong is
   *  < 330 px tall, the sheen lobe is invisible there but costs ALU on every fur / skin pixel */
  private loMaterial(mat: MatKey): THREE.Material {
    let m = this.loMats.get(mat);
    if (m) return m;
    const src = this.mats.mats[mat as keyof KongMaterials["mats"]] as THREE.MeshPhysicalMaterial;
    if (!src.isMeshPhysicalMaterial) m = this.kongMaterial(mat);
    else {
      const st = new THREE.MeshStandardMaterial({ color: src.color, map: src.map, normalMap: src.normalMap, normalScale: src.normalScale, roughness: src.roughness, metalness: src.metalness, vertexColors: src.vertexColors, name: `${mat}-lo` });
      m = this.patchKong(st, `${mat}-lo` as MatKey);
    }
    this.loMats.set(mat, m);
    return m;
  }
  private fades = new Map<THREE.Material, THREE.Material>();
  private fadeTwin(m: THREE.Material): THREE.Material {
    let f = this.fades.get(m);
    if (f) return f;
    f = m.clone();
    f.defines = { ...(m.defines ?? {}), KONG_DITHER: "" };
    f.onBeforeCompile = m.onBeforeCompile;
    const key = m.customProgramCacheKey();
    f.customProgramCacheKey = () => `${key}-fade`;
    f.name = `${m.name}-fade`;
    this.fades.set(m, f);
    return f;
  }
  /** GPU-skin a material from the bone texture (+ dither crossfade, team rim, character fill; fur / shorts tints) */
  private patchKong(m: THREE.Material, mat: MatKey | "weapon" | `${MatKey}-lo`): THREE.Material {
    const uBones = this.uBones, uDither = this.uDither;
    const base = mat.replace(/-lo$/, ""), face = base === "kbody" || base === "khead", eye = base === "keye";
    if (mat === "weapon") m.defines = { ...(m.defines ?? {}), KONG_WEAPON: "" };
    if (face && FACE.jaw) m.defines = { ...(m.defines ?? {}), KONG_JAW: "" };
    if (base === "kbody" && KONG_VER === "v2") m.defines = { ...(m.defines ?? {}), KONG_COVER: "" };
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uKongBones = uBones; sh.uniforms.uKongDither = uDither; sh.uniforms.uKongRest = this.uRest;
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", `#include <common>\n${kongGLSL}\n${face ? faceGLSL : ""}\n#ifdef KONG_COVER\nattribute vec4 aCover;\n#endif\nvarying vec4 vKTeam; varying vec4 vKLook; varying vec3 vKFill; varying float vKFade; varying float vKRimP; varying vec4 vKFace; varying float vKKey;${face ? " varying vec3 vKHead; varying vec4 vKFace1;" : ""}`)
        .replace("#include <beginnormal_vertex>", `#include <beginnormal_vertex>\nmat4 kB = kongBone(); objectNormal = mat3( kB ) * objectNormal;\n#ifdef USE_TANGENT\nobjectTangent = mat3( kB ) * objectTangent;\n#endif\n{ int y = int( aSlotFade.x + 0.5 ); vKTeam = texelFetch( uKongBones, ivec2( ${NBX * 4}, y ), 0 ); vKLook = texelFetch( uKongBones, ivec2( ${NBX * 4 + 1}, y ), 0 ); vec4 kf = texelFetch( uKongBones, ivec2( ${NBX * 4 + 2}, y ), 0 ); vKFill = kf.rgb; vKRimP = kf.a; vKFade = aSlotFade.y; vKFace = texelFetch( uKongBones, ivec2( ${FACE0}, y ), 0 ); vKKey = texelFetch( uKongBones, ivec2( ${NBX * 4 + 3}, y ), 0 ).b; }`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n${face ? `vKHead = vec3( 0.0, -9.0, 0.0 ); vKFace1 = vec4( 0.0 ); if ( abs( aBones.x - ${HEAD_I}.0 ) < 0.5 && aWeights.x > 0.99 ) { vKFace1 = texelFetch( uKongBones, ivec2( ${FACE1}, int( aSlotFade.x + 0.5 ) ), 0 ); transformed += kongFaceOff( transformed, vKFace1 ); vKHead = ( transformed - uKongRest[ ${HEAD_I} ] ) / ${KONG_HS.toFixed(3)};${KONG_ALT ? ` ${ALT_TUFT}` : ""} }` : ""}\n${COVER_GLSL}\ntransformed = ( kB * vec4( transformed, 1.0 ) ).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", `#include <common>\n${ditherGLSL}\nvarying vec4 vKTeam; varying vec4 vKLook; varying vec3 vKFill; varying float vKFade; varying float vKRimP; varying vec4 vKFace; varying float vKKey; float kEyeCatch = 0.0; float kRed = 0.0; float kLid = 0.0;${face ? ` varying vec3 vKHead; varying vec4 vKFace1;\n${MOUTH_GLSL}` : ""}`)
        .replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\n#ifdef KONG_DITHER\nif ( vKFade < 1.5 ) { float kb = kongBayer( gl_FragCoord.xy ); if ( vKFade >= 0.0 ? kb >= vKFade : kb < -vKFade ) discard; }\n#endif")
        .replace("#include <color_fragment>", `#include <color_fragment>\n${colorCode(mat)}${face && FACE.paintMouth ? "\ndiffuseColor.rgb = kongMouth( diffuseColor.rgb, vKHead, vKFace1 );" : ""}`)
        .replace("#include <aomap_fragment>", `#include <aomap_fragment>\n${kongIndirect(mat)}`)
        // clothing atlas: the shorts fabric is matte (0.9 — glossier showed sky-blue sheen blotches on the red), sneakers +
        // peel satin (0.45)
        .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>\n${mat.startsWith("kgear") ? "roughnessFactor = mix( 0.45, 0.92, kRed );" : eye ? "roughnessFactor = mix( roughnessFactor, 0.62, kLid );" : ""}`)
        .replace("#include <lights_physical_fragment>", `#include <lights_physical_fragment>\n${eye ? "#ifdef USE_CLEARCOAT\nmaterial.clearcoat *= 1.0 - kLid;\n#endif" : ""}`)
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n{ float fr = pow( 1.0 - clamp( dot( normalize( vNormal ), normalize( vViewPosition ) ), 0.0, 1.0 ), max( 1.0, vKRimP ) ); totalEmissiveRadiance += vKTeam.rgb * fr * vKTeam.a + diffuseColor.rgb * vKFill + vec3( kEyeCatch * 2.4 );\n  // showcase key (setLook key, e.g. the title mascot): a warm studio light from the lens, so a backlit hero keeps a lit face\n  if ( vKKey > 0.0 ) totalEmissiveRadiance += diffuseColor.rgb * vKKey * vec3( 1.0, 0.95, 0.86 ) * ( 0.2 + 0.8 * clamp( dot( normalize( vNormal ), normalize( vViewPosition ) ), 0.0, 1.0 ) ); }");
        // (the scene target has no alpha, so no per-kong TAA "trust" there: kongs write true per-pixel motion vectors
        // in a velocity pass the TAA resolve reprojects with: see velocityPass())
    };
    m.customProgramCacheKey = () => `kong-bones6-${KONG_VER}-${mat}`;
    return m;
  }

  // ---------------------------------------------------------------------------------------- instanced far weapons
  private wpnGeo = new Map<WeaponId, THREE.BufferGeometry[]>();
  private wpnBatches = new Map<string, Batch>();
  private wpnMat: THREE.Material | null = null;
  /** the lo / min LOD geometry of a weapon id, in hand-socket space, from the object createHeldWeapon returned (its
   *  coarsest LOD level, re-clustered down to the tier's triangle budget) */
  learnWeapon(id: WeaponId, o: THREE.Object3D) {
    if (this.wpnGeo.has(id)) return;
    o.updateMatrixWorld(true);
    // geometry in SOCKET space: o's own local transform (HELD_SCALE, grip offset) × mesh relative to o
    const inv = new THREE.Matrix4().copy(o.matrix).multiply(new THREE.Matrix4().copy(o.matrixWorld).invert());
    const lod = o as THREE.LOD;
    // re-clustering the held chain's coarsest level (already colour-averaged) gives a pale crumpled blob, so the
    // tier-1 gun decimates the FULL gun with a colour + normal preserving clusterer (clusterKeep) — positions
    // are shared per cell (no cracks), colours / normals averaged only within one paint colour + one facing, so the
    // yellow body, brown straps and green caps stay separate and flat faces stay flat.
    const src = lod.isLOD && lod.levels.length ? lod.levels[0].object : o;
    const parts: THREE.BufferGeometry[] = [];
    src.updateMatrixWorld(true);
    src.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh || !m.geometry?.attributes.position) return;
      if (c !== src && c.name === "held-accent") return;
      let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
      g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
      if (!g.attributes.color) { const col = (m.material as THREE.MeshStandardMaterial).color ?? new THREE.Color(1, 1, 1); const a = new Float32Array(g.attributes.position.count * 3); for (let i = 0; i < a.length; i += 3) { a[i] = col.r; a[i + 1] = col.g; a[i + 2] = col.b; } g.setAttribute("color", new THREE.BufferAttribute(a, 3)); }
      if (!g.attributes.normal) g.computeVertexNormals();
      for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "color" && k !== "normal") g.deleteAttribute(k);
      parts.push(g);
    });
    if (!parts.length) return;
    const whole = mergeGeometries(parts, false)!;
    const out: THREE.BufferGeometry[] = [];
    const t0 = performance.now();
    for (let t = 0; t < WPN_TRIS.length; t++) {
      // tris ∝ 1 / cell²: jump straight to the budget, then nudge
      let cell = WPN_CELL[t] * 0.5, g = clusterKeep(whole, cell);
      for (let k = 0; k < 5 && g.index!.count / 3 > WPN_TRIS[t]; k++) { cell *= Math.max(1.08, Math.sqrt(g.index!.count / 3 / WPN_TRIS[t]) * 1.04); g = clusterKeep(whole, cell); }
      out.push(g);
    }
    this.wpnGeo.set(id, out);
    console.info(`[kong] weapon LOD ${id}: ${out.map((g) => g.index!.count / 3).join(" / ")} tris in ${(performance.now() - t0).toFixed(0)} ms`);
  }
  /** the far-weapon batches' one material: kong-patched and atmos-patched when it is made, so no batch ever draws it
   *  unpatched and the match warm-up (index.ts prewarmMatch, weaponWarm) links its final program before a match */
  weaponMaterial(): THREE.Material {
    if (this.wpnMat) return this.wpnMat;
    const m = this.patchKong(Object.assign(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.05 }), { name: "kong-weapon" }), "weapon");
    (this.ctx.shared.get("atmos") as { patch?: (m: THREE.Material) => void } | undefined)?.patch?.(m);
    return this.wpnMat = m;
  }
  /** tiny meshes carrying the far-weapon material and its motion-vector material, for the warm-up compile (positions +
   *  normals, like a weapon batch: the program key reads which attributes the geometry has) */
  weaponWarm(): THREE.Object3D {
    const g = new THREE.Group(), geo = new THREE.PlaneGeometry(0.01, 0.01);
    g.add(new THREE.Mesh(geo, this.weaponMaterial()), new THREE.Mesh(geo, this.velMat(true)));
    g.traverse((o) => { o.frustumCulled = false; });
    return g;
  }
  private weaponBatch(id: WeaponId, t: number): Batch | null {
    const key = `${id}|${t}`;
    let b = this.wpnBatches.get(key);
    if (b) return b;
    const gs = this.wpnGeo.get(id);
    if (!gs) return null;
    b = this.addBatch("weapon", "weapon", gs[t], this.weaponMaterial(), false);
    b.list = [];
    b.mesh.name = `kong-weapon-${id}-${t ? "min" : "lo"}`;
    this.wpnBatches.set(key, b);
    return b;
  }

  /** weapon shadow: the ≤1.5k-tri LOD of a weapon id drawn only into the shadow map (hi + lo kongs), so no full-detail
   *  held weapon ever renders into a cascade (otherwise 18–60k-tri casting weapons per kong) */
  private weaponShadowBatch(id: WeaponId): Batch | null {
    const key = `${id}|s`;
    let b = this.wpnBatches.get(key);
    if (b) return b;
    const gs = this.wpnGeo.get(id);
    if (!gs) return null;
    b = this.addBatch("wshadow", "proxy", gs[0], this.proxyMat, true, true);
    b.list = [];
    b.mesh.name = `kong-weapon-${id}-shadow`;
    this.wpnBatches.set(key, b);
    return b;
  }

  private weaponVelBatch(id: WeaponId): Batch | null {
    let b = this.velWpn.get(id);
    if (b) return b;
    const gs = this.wpnGeo.get(id);
    if (!gs) return null;
    const geo = new THREE.InstancedBufferGeometry();
    for (const k of Object.keys(gs[0].attributes)) geo.setAttribute(k, gs[0].attributes[k]);
    geo.setIndex(gs[0].index);
    const slotFade = new THREE.InstancedBufferAttribute(new Float32Array(MAX_KONGS * 2 * 2), 2); slotFade.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aSlotFade", slotFade); geo.instanceCount = 0;
    const mesh = new THREE.Mesh(geo, this.velMat(true)); mesh.frustumCulled = false; mesh.visible = false; mesh.name = `kong-vel-${id}`;
    this.velScene.add(mesh);
    b = { tier: "weapon", mat: "weapon", mesh, geo, slotFade, n: 0, list: [] };
    this.velWpn.set(id, b);
    return b;
  }

  private depthMaterial(shrink: number, weapon = false) {
    const d = new THREE.MeshDepthMaterial();
    if (weapon) d.defines = { KONG_WEAPON: "" };
    const uBones = this.uBones, uRest = this.uRest;
    d.onBeforeCompile = (sh) => {
      sh.uniforms.uKongBones = uBones; sh.uniforms.uKongRest = uRest;
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", `#include <common>\n${kongGLSL}`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n{ mat4 kB = kongBone(); transformed = ( kB * vec4( transformed - normal * ${shrink.toFixed(4)}, 1.0 ) ).xyz; }`);
    };
    d.customProgramCacheKey = () => `kong-bones4-depth-${shrink}${weapon ? "-w" : ""}`;
    return d;
  }

  warmBatches(): THREE.Object3D {
    for (const id of this.wpnGeo.keys()) { this.weaponBatch(id, 0); this.weaponBatch(id, 1); this.weaponShadowBatch(id); }
    return this.group;
  }

  private addBatch(tier: Batch["tier"], mat: Batch["mat"], merged: THREE.BufferGeometry, material: THREE.Material, proxy: boolean, weapon = false): Batch {
    const geo = new THREE.InstancedBufferGeometry();
    for (const k of Object.keys(merged.attributes)) geo.setAttribute(k, merged.attributes[k]);
    geo.setIndex(merged.index);
    const slotFade = new THREE.InstancedBufferAttribute(new Float32Array(MAX_KONGS * 2 * 2), 2);   // a kong can be in 2 tiers while it crossfades
    slotFade.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aSlotFade", slotFade);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = `kong-${typeof tier === "number" ? ["hi", "lo", "min"][tier] : tier}-${mat}`;
    if (tier === "weapon") mesh.userData.castShadow = false;
    mesh.frustumCulled = false; mesh.visible = false;
    mesh.castShadow = proxy; mesh.receiveShadow = !proxy;
    mesh.userData.castShadow = proxy; mesh.userData.farShadow = false;
    if (proxy) mesh.customDepthMaterial = this.depthMaterial(weapon ? 0 : PROXY_CM !== null ? PROXY_CM / 100 : tier === "shadow-lo" ? 0.015 : 0.025, weapon);
    if (proxy && PROXY_CM === 0) { mesh.castShadow = false; mesh.userData.castShadow = false; }
    const b: Batch = { tier, mat, mesh, geo, slotFade, n: 0 };
    // bone texture upload right before the first kong draw of each render (after every apply() of the tick);
    // the proxy never draws in a colour pass; any override-material pass (water proximity bake) skips kongs
    const before = (r: THREE.WebGLRenderer, scene: THREE.Scene | null, drawMat: THREE.Material | null) => {
      this.upload(r);
      geo.instanceCount = (proxy && drawMat === material) || (scene && scene.overrideMaterial) ? 0 : b.n;
    };
    mesh.onBeforeRender = (r, scene, _c, _g, m) => before(r, scene as THREE.Scene, m);
    mesh.onAfterRender = () => { geo.instanceCount = b.n; };
    mesh.onBeforeShadow = (r) => { this.upload(r); geo.instanceCount = b.n; };
    this.batches.push(b);
    this.group.add(mesh);
    return b;
  }

  acquire(seed: number): Slot {
    // past the cap a kong still animates (muzzle/bones work) but is not drawn — never throw into gameplay
    const idx = this.free.pop() ?? -1;
    if (idx < 0) console.warn(`[kong] more than ${MAX_KONGS} live kongs — extra kongs are not drawn`);
    const r = (k: number) => { const x = Math.sin((seed + 1) * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
    const s: Slot = {
      idx, anim: new KongAnimator(seed), pose: null, visible: true, alive: true, team: new THREE.Color("#ffffff"), rim: 0, foe: false, friend: false, socket: new THREE.Object3D(), offSocket: null,
      weaponVisible: false, weaponRarity: "common", px: 0, inView: false, maxTier: 0, shorts: SHORTS[seed % SHORTS.length].clone(), fur: 0.9 + r(1) * 0.2, lodBias: 1, rimOverride: null, rimOverrideK: 0, fill: FILL.clone(), key: 0, hat: -1, top: -1,
      wpn: null, off: null, sockW: new THREE.Matrix4(), offW: new THREE.Matrix4(), wTier: -1, shadow: false, wShadow: false, tier: 1, prevTier: 1, fade: 0, seen: false, upTick: -9, near: 1, pov: false, outline: null, animDt: 0,
    };
    s.socket.name = "hand-socket";
    this.slots.push(s);
    return s;
  }
  release(s: Slot) { s.alive = false; const i = this.slots.indexOf(s); if (i >= 0) { this.slots.splice(i, 1); if (s.idx >= 0) this.free.push(s.idx); } }

  /** per tick: pick each visible kong's LOD tier(s) + dither weights + shadow proxy (uses the main camera) */
  frame(dt = 1 / 60) {
    this.uDither.value = [0, 10, 2, 8, 5, 15, 7, 13, 1, 11, 3, 9, 4, 14, 6, 12][this.ditherFrame++ & 15];
    const cam = this.ctx.camera;
    cam.updateMatrixWorld();
    this.tick++;
    this.projU.copy(cam.projectionMatrix);   // unjittered here (the TAA jitters it only inside its render)
    this.camPos.setFromMatrixPosition(cam.matrixWorld);
    this.projView.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    this.ctx.renderer.getDrawingBufferSize(this.drawSize);
    const pxPerM = this.drawSize.y / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * Math.max(0.01, cam.zoom ? 1 / cam.zoom : 1));
    for (const l of this.tierList) l.length = 0;
    for (const l of this.shadowList) l.length = 0;
    for (const b of this.wpnBatches.values()) b.list!.length = 0;
    for (const s of this.slots) {
      s.inView = false; s.shadow = false;
      if (!s.visible || !s.pose || s.idx < 0) { s.px = 0; s.seen = false; continue; }
      this.sphere.center.set(s.pose.x, s.pose.y + 1.0, s.pose.z);
      const d = this.sphere.center.distanceTo(this.camPos);
      const px = (2.0 * pxPerM) / Math.max(0.3, d) * s.lodBias;
      s.px = px;
      // shadow proxy: also for kongs just off-screen (their shadow may be in view)
      this.sphere.radius = 1.8;
      const inView = this.frustum.intersectsSphere(this.sphere);
      if (px > PX_SHADOW) { this.sphere.radius = 7; if (inView || this.frustum.intersectsSphere(this.sphere)) { this.shadowList[px > PX_SHADOW_LO ? 0 : 1].push(s); s.shadow = true; } }
      if (!inView) { s.seen = false; continue; }
      s.inView = true;
      if (FORCE_TIER !== null) { this.tierList[FORCE_TIER].push([s, 2]); s.tier = FORCE_TIER; continue; }
      // tier with HYSTERESIS (±HYST around each threshold) + a short TEMPORAL dither crossfade (FADE_S) only right after a
      // switch. A steady-state dither band would leave every kong near a threshold permanently screen-doored — in live
      // play (TAA clamps the pattern away) a 9–13 m kong reads as a see-through ghost. Staged stills never fade.
      const hiOK = s.maxTier === 0;
      const want = (cur: Tier): Tier => {
        const up = 1 + HYST, dn = 1 - HYST;
        if (cur === 0) return !hiOK ? (px < PX_LO ? 2 : 1) : px >= PX_HI * dn ? 0 : px >= PX_LO * dn ? 1 : 2;
        if (cur === 1) return hiOK && px > PX_HI * up ? 0 : px >= PX_LO * dn ? 1 : 2;
        return px > PX_LO * up ? (hiOK && px > PX_HI * up ? 0 : 1) : 2;
      };
      const fresh = !s.seen;
      const t = fresh ? (hiOK && px >= PX_HI ? 0 : px >= PX_LO ? 1 : 2) as Tier : want(s.tier);
      if (t !== s.tier) { s.prevTier = s.tier; s.tier = t; s.fade = fresh || this.ctx.shotMode ? 0 : 1; }
      s.seen = true;
      // NEAR FADE — a kong whose body comes within ~1.3 m of the camera screen-doors out (the
      // warm-up crowd pressed a bot's head + shoulder fur over the bottom-centre third of the screen). Distance to the
      // body axis (hips → head); gone below 0.5 m. Never in staged stills.
      let near = 1;
      if (!this.ctx.shotMode && !s.pov) {
        const py = s.pose.y, cy = Math.min(Math.max(this.camPos.y, py + 0.4), py + 1.75);
        const dn = Math.hypot(this.camPos.x - s.pose.x, this.camPos.y - cy, this.camPos.z - s.pose.z);
        near = dn >= NEAR_FADE[1] ? 1 : Math.max(0, (dn - NEAR_FADE[0]) / (NEAR_FADE[1] - NEAR_FADE[0]));
      }
      s.near = near;
      if (near <= 0.02) { s.inView = false; continue; }
      if (near < 0.995) { s.fade = 0; this.tierList[s.tier].push([s, Math.max(0.005, near)]); }
      else if (s.fade > 0) {
        s.fade = Math.max(0, s.fade - dt / FADE_S);
        const a = Math.min(0.995, Math.max(0.005, 1 - s.fade));
        this.tierList[s.tier].push([s, a]); this.tierList[s.prevTier].push([s, -a]);
      } else this.tierList[s.tier].push([s, 2]);
    }
    for (const b of this.velWpn.values()) b.list!.length = 0;
    // held weapons by tier: the real object on hi kongs only, instanced LODs (no shadow) on lo / min kongs
    for (const s of this.slots) {
      let wt = -1;
      if (s.weaponVisible && s.visible && s.pose && s.idx >= 0) {
        if (s.px === 0) wt = 0;                                   // not ticked yet (staging applies before the first frame)
        else if (s.inView && s.px > PX_WEAPON && s.near > 0.4) {
          wt = FORCE_TIER ?? s.tier;
        }
      }
      s.wTier = wt;
      // weapon shadows (lo LOD, shadow pass only) for every kong whose body proxy casts and that is big enough to matter
      s.wShadow = !!s.wpn && s.weaponVisible && s.visible && s.shadow && s.px >= PX_LO && PROXY_CM !== 0;
      if (s.wShadow) {
        this.weaponShadowBatch(s.wpn!)?.list!.push([s, 2]);
        if (s.off) this.weaponShadowBatch(s.off)?.list!.push([s, 3]);
      }
      const real = wt === 0;
      if (s.socket.visible !== real) s.socket.visible = real;
      if (s.offSocket && s.offSocket.visible !== (real && !!s.off)) s.offSocket.visible = real && !!s.off;
      if (wt > 0) {
        if (s.wpn) this.weaponBatch(s.wpn, wt - 1)?.list!.push([s, 2]);
        if (s.off) this.weaponBatch(s.off, wt - 1)?.list!.push([s, 3]);
      }
      // gun motion vectors (the ≤1.5k LOD in socket space covers the real gun's silhouette)
      if (wt >= 0 && s.inView) { if (s.wpn) this.weaponVelBatch(s.wpn)?.list!.push([s, 2]); if (s.off) this.weaponVelBatch(s.off)?.list!.push([s, 3]); }
    }
    for (const b of this.velWpn.values()) {
      const arr = b.slotFade.array as Float32Array; let n = 0;
      for (const [s, f] of b.list!) { arr[n * 2] = s.idx; arr[n * 2 + 1] = f; n++; }
      b.n = n; b.geo.instanceCount = n;
      if (n) { b.slotFade.needsUpdate = true; b.slotFade.clearUpdateRanges(); b.slotFade.addUpdateRange(0, n * 2); }
    }
    for (const b of this.batches) {
      let n = 0;
      const arr = b.slotFade.array as Float32Array;
      if (b.list) for (const [s, f] of b.list) { arr[n * 2] = s.idx; arr[n * 2 + 1] = f; n++; }
      else if (typeof b.tier === "number") { const fade = !!b.fade, acc = b.acc; for (const [s, f] of this.tierList[b.tier]) if ((f < 1.5) === fade && (acc === undefined || (acc < 3 ? s.hat === acc && !seated(s) : s.top === acc - 3))) { arr[n * 2] = s.idx; arr[n * 2 + 1] = f; n++; } }
      else for (const s of this.shadowList[b.tier === "shadow-lo" ? 0 : 1]) { arr[n * 2] = s.idx; arr[n * 2 + 1] = 2; n++; }
      b.n = n; b.geo.instanceCount = n; b.mesh.visible = n > 0;
      if (n) { b.slotFade.needsUpdate = true; b.slotFade.clearUpdateRanges(); b.slotFade.addUpdateRange(0, n * 2); }
    }
    this.outlineFrame();
  }

  /** write the bone matrices + per-kong look of every drawn kong (once per render call) */
  private upload(_r: THREE.WebGLRenderer) {
    if (this.uploadedTick === this.tick) return;
    this.uploadedTick = this.tick;
    this.cur ^= 1;
    const D = this.datas[this.cur], tex = this.texs[this.cur];
    this.uBones.value = tex; this.uBonesPrev.value = this.texs[this.cur ^ 1];
    this.vpPrev.copy(this.vpCur); this.vpCur.multiplyMatrices(this.projU, this.ctx.camera.matrixWorldInverse);
    for (const s of this.slots) {
      if (!s.pose || !s.visible || s.px <= 0 || s.idx < 0) continue;
      const o = s.idx * ROW * 4;
      for (let b = 0; b < NB; b++) D.set(s.anim.world[b].elements, o + b * 16);
      // first-person body (pov): the head collapses onto its joint (the camera sits inside it)
      if (s.pov) { const h = o + HEAD_I * 16; for (let c = 0; c < 3; c++) { D[h + c] *= 0.001; D[h + 4 + c] *= 0.001; D[h + 8 + c] *= 0.001; } }
      if (s.wpn || s.off) { D.set(s.sockW.elements, o + SOCK_R * 16); if (s.off) D.set(s.offW.elements, o + SOCK_L * 16); }
      // team rim, scaled with on-screen size for BOTH teams: squad colour for friends, hot red for foes — faint up close
      // (no halo on the kong next to you), strong at 30 m+ where only the silhouette reads
      const t = o + NBX * 16;
      let rp = 3;
      if (s.rimOverride) { D[t] = s.rimOverride.r; D[t + 1] = s.rimOverride.g; D[t + 2] = s.rimOverride.b; D[t + 3] = s.rimOverrideK; }
      else if (s.foe) { D[t] = FOE_RIM.r; D[t + 1] = FOE_RIM.g; D[t + 2] = FOE_RIM.b; D[t + 3] = rimK(s.px, RIM_FOE); rp = rimP(s.px, RIM_FOE); }
      else if (s.friend) { D[t] = s.team.r; D[t + 1] = s.team.g; D[t + 2] = s.team.b; D[t + 3] = rimK(s.px, RIM_FRIEND); rp = rimP(s.px, RIM_FRIEND); }
      else { D[t] = s.team.r; D[t + 1] = s.team.g; D[t + 2] = s.team.b; D[t + 3] = 0; }
      D[t + 4] = s.shorts.r; D[t + 5] = s.shorts.g; D[t + 6] = s.shorts.b; D[t + 7] = s.fur;
      D[t + 8] = s.fill.r; D[t + 9] = s.fill.g; D[t + 10] = s.fill.b; D[t + 11] = rp;
      // motion-vector bookkeeping: g = 1 when last tick's row (the other ping-pong texture) is this kong's previous pose
      D[t + 12] = 1; D[t + 13] = s.upTick === this.tick - 1 ? 1 : 0; D[t + 14] = s.key; D[t + 15] = s.top >= 0 ? s.top + 1 : 0;
      D.set(s.anim.face, o + FACE0 * 4);
      s.upTick = this.tick;
    }
    tex.needsUpdate = true;
    if (this.outl) {
      const O = this.outl.data; O.fill(0);
      for (const s of this.slots) if (s.outline && s.idx >= 0) { const k = s.idx * 4; O[k] = s.outline.r; O[k + 1] = s.outline.g; O[k + 2] = s.outline.b; O[k + 3] = 1; }
      this.outl.tex.needsUpdate = true;
    }
  }
}

let manager: Promise<KongManager> | null = null;
export function kongManager(ctx: WorldCtx): Promise<KongManager> {
  return (manager ??= (async () => {
    const release = ctx.hold("kong-asset");
    try {
      const [asset, acc] = await Promise.all([loadKongAsset(ctx.renderer), loadAccessories().catch((e) => { console.warn("[kong] accessories unavailable:", e); return null; })]);
      return new KongManager(ctx, asset, asset ? acc : null);
    } finally { release(); }
  })());
}

/** (caster) turn the team outline + x-ray passes on (built on the first call; the player game never calls it) */
export async function kongOutlines(ctx: WorldCtx): Promise<KongOutlines> { return (await kongManager(ctx)).enableOutlines(); }

/** KongActor + rig access for staging (align a glider's hand points / a set's muzzle to the animated bones) */
export interface KongActorEx extends KongActor {
  /** world matrix of a bone after the last apply() (character → world). Do not mutate. */
  bone(name: BoneName): THREE.Matrix4;
  /** the animator (advance phase, read state) */
  animator: KongAnimator;
  /** resolves once the held weapon for the current pose has been created (staging awaits it before a shot) */
  weaponReady(): Promise<void>;
  /** LOD bias: >1 keeps the hi body further out (hero kongs in view-camera shots) */
  setLodBias(k: number): void;
  /** (caster) this kong's team outline colour (null = none); drawn once kongOutlines() has turned the passes on */
  setOutline(color: THREE.ColorRepresentation | null): void;
  /** staging: aim the held weapon this far (radians) left(+)/right(−) of the body yaw and up(+) — cross-body shots */
  setAimOffset(yaw: number, pitch?: number): void;
  /** staging: a second weapon in the LEFT fist (dual pistols), aimed at body yaw + yaw; null removes it */
  setOffhand(id: WeaponId | null, yaw?: number, pitch?: number): Promise<void>;
  /** muzzle of the off-hand weapon (world) */
  offMuzzle(out: THREE.Vector3): THREE.Vector3;
  /** staging look: a fixed fresnel rim (e.g. warm key/bounce on a hero kong; overrides the team rim) + fur value */
  setLook(o: { rim?: THREE.ColorRepresentation | null; rimStrength?: number; fur?: number; fill?: THREE.ColorRepresentation; shorts?: THREE.ColorRepresentation; key?: number }): void;
  /** outfits / props: `o` rides `bone` (bone-local matrix `local`), re-posed every apply(); detach() removes it */
  attach(o: THREE.Object3D, bone: BoneName, local?: THREE.Matrix4): void;
  detach(o: THREE.Object3D): void;
  /** kong-variety: the match outfit (instanced hat + top, shorts colour); null = the default look */
  setOutfit(o: Outfit | null): void;
}

export async function createKong(ctx: WorldCtx, opts: { variant?: number; lod?: "hi" | "lo" } = {}): Promise<KongActorEx> {
  const mgr = await kongManager(ctx);
  const seed0 = opts.variant ?? 0;
  const slot = mgr.acquire(seed0);
  if (opts.lod === "lo") slot.maxTier = 1;
  // planted-foot ground snap: the terrain under each foot while the kong stands on the terrain (within 12 cm), the pose's
  // own floor height otherwise (decks, roofs, stairs)
  const T = ctx.terrain;
  if (T) slot.anim.groundAt = (x, z, y) => {
    const p = slot.pose;
    if (!p || Math.abs(T.height(p.x, p.z) - y) > 0.06) return y;
    return Math.min(y + 0.3, Math.max(y - 0.25, T.height(x, z)));
  };
  const g = new THREE.Group();
  g.name = "kong";
  g.add(slot.socket);
  slot.socket.visible = false;
  let weapon: THREE.Object3D | null = null, weaponKey = "", pending: Promise<void> = Promise.resolve();
  const muzzleLocal = new THREE.Vector3(0.02, 0.02, -0.42);
  // hand socket: at the fist centre (wrist + fist offset), oriented along the AIM (yaw + pitch + recoil kick) so every
  // weapon points where the kong shoots, whatever the arm pose does; reload rolls + dips it
  // fist centre below the wrist joint (the Blender kong's fists are 1.3× the procedural ones — anatomy FS)
  const FIST = mgr.asset ? new THREE.Vector3(...FACE.fist) : new THREE.Vector3(0.0, -0.112, -0.024);
  // off-hand (staging: dual pistols) — a second socket on the left fist, aimed like the main one
  const offSocket = new THREE.Object3D(); offSocket.name = "hand-socket-l"; offSocket.visible = false; g.add(offSocket);
  slot.offSocket = offSocket;
  const offMuzzleLocal = new THREE.Vector3(0.02, 0.02, -0.42);
  let offYaw = 0, offPitch = 0, offOn = false;
  const socketWorld = new THREE.Matrix4(), socketWorld2 = new THREE.Matrix4(), fistPos = new THREE.Vector3(), aimQ = new THREE.Quaternion(), aimE = new THREE.Euler(0, 0, 0, "YXZ"), ONE = new THREE.Vector3(1, 1, 1);
  const invParent = new THREE.Matrix4();
  const attached: Array<{ o: THREE.Object3D; bone: BoneName; local: THREE.Matrix4 }> = [];
  const ensureWeapon = (id: WeaponId | null) => {
    const key = id ?? "";
    if (key === weaponKey) return; weaponKey = key;
    if (weapon) { weapon.removeFromParent(); weapon = null; }
    slot.weaponVisible = false; slot.socket.visible = false; slot.wpn = null;
    if (!id) return;
    heldMuzzle(id, muzzleLocal);
    slot.anim.foreGrip = heldFore(id);
    // hold the ready flag (shot mode captures after it) until the weapon is on the socket
    const release = ctx.hold(`kong-weapon-${id}`);
    pending = mgr.weapons.createHeldWeapon(id, slot.weaponRarity).then((o) => {
      if (weaponKey !== key) return;
      mgr.learnWeapon(id, o);
      weapon = o; o.traverse((c) => { c.castShadow = false; c.userData.castShadow = false; c.userData.farShadow = false; }); slot.socket.add(o);
      slot.wpn = id; slot.weaponVisible = true; slot.socket.visible = slot.wTier === 0 || slot.px === 0;
    }).catch((e) => { console.warn("[kong] held weapon failed", id, e); }).finally(release);
  };
  const eyeM = new THREE.Matrix4(), eyeV = new THREE.Vector3(), gazeXY = { x: 0, y: 0 };
  // ?fp3=0 = the older outstretched POV arms (A/B)
  const POV_TUCK = flag("fp3");
  // first-person body (pov): freefall places the head behind the camera (offset learned from the last frame) + fist IK
  let inPov = false;
  const povP: KongPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, vx: 0, vz: 0, vy: 0, state: "freefall", crouch: false, sprint: false, weapon: null, team: 0, friendly: true };
  const povOff = new THREE.Vector3(0, 1.6, 0), povF = new THREE.Vector3(), povR = new THREE.Vector3(), povU = new THREE.Vector3(), povC = new THREE.Vector3();
  const ikR = { target: new THREE.Vector3(), pole: new THREE.Vector3(), twist: 0.5 }, ikL = { target: new THREE.Vector3(), pole: new THREE.Vector3(), twist: -0.5 };
  const povIK = () => ({ R: ikR, L: ikL });
  const actor: KongActorEx = {
    object: g,
    pov(camera: THREE.Camera, p: KongPose, dt: number) {
      slot.pov = true; inPov = true;
      Object.assign(povP, p);
      const glide = p.state === "glide";
      camera.updateMatrixWorld();
      povC.setFromMatrixPosition(camera.matrixWorld);
      camera.getWorldDirection(povF);
      povR.crossVectors(povF, UPV).normalize(); povU.crossVectors(povR, povF);
      // the body hangs from a level frame (yaw only): its head sits behind + below the camera so the shoulders stay out of
      // the view — freefall 0.3 / 0.12 m (drop-04), glide 0.15 / 0.22 m (fists forward on the control bar)
      const fl = Math.hypot(povF.x, povF.z) > 1e-3 ? 1 / Math.hypot(povF.x, povF.z) : 0, hx = povF.x * fl, hz = povF.z * fl;
      povP.yaw = Math.atan2(-hx, -hz);
      const back = glide ? 0.15 : 0.3, down = glide ? 0.22 : 0.12;
      if (glide) {
        povP.x = povC.x - hx * back - povOff.x; povP.y = povC.y - down - povOff.y; povP.z = povC.z - hz * back - povOff.z;
        // the body's own arms stay BEHIND the camera (out of every view) — the 1P
        // fists on the risers are the viewmodel's parachute hands (weapons/viewmodel.ts AIR), the body keeps the legs
        const rx = -hz, rz = hx;
        const tk = POV_TUCK ? 1 : 0;
        ikR.target.copy(povC).addScaledVector(povR, 0.46 - 0.04 * tk).addScaledVector(povU, -0.04 - 0.26 * tk).addScaledVector(povF, 0.85 - 1.17 * tk);
        ikL.target.copy(povC).addScaledVector(povR, -0.46 + 0.04 * tk).addScaledVector(povU, -0.04 - 0.26 * tk).addScaledVector(povF, 0.85 - 1.17 * tk);
        ikR.pole.set(rx, -0.8, rz); ikL.pole.set(-rx, -0.8, -rz);
      } else {
        povP.x = povC.x - povF.x * back - povU.x * down - povOff.x;
        povP.y = povC.y - povF.y * back - povU.y * down - povOff.y;
        povP.z = povC.z - povF.z * back - povU.z * down - povOff.z;
        // no outstretched body arms — tucked behind the camera; the viewmodel draws the skydive hands
        const tk = POV_TUCK ? 1 : 0;
        ikR.target.copy(povC).addScaledVector(povR, 0.5 - 0.08 * tk).addScaledVector(povU, -0.26 - 0.04 * tk).addScaledVector(povF, 0.78 - 1.1 * tk);
        ikL.target.copy(povC).addScaledVector(povR, -0.5 + 0.08 * tk).addScaledVector(povU, -0.26 - 0.04 * tk).addScaledVector(povF, 0.78 - 1.1 * tk);
        ikR.pole.copy(povR).addScaledVector(povU, -0.6); ikL.pole.copy(povR).negate().addScaledVector(povU, -0.6);
      }
      slot.anim.ik = povIK;
      actor.apply(povP, dt);
      inPov = false;
      povOff.setFromMatrixPosition(slot.anim.bone("head")).add(HEAD_TOP).sub(povC.set(povP.x, povP.y, povP.z));
    },
    apply(p: KongPose, dt: number) {
      if (!inPov && slot.pov) { slot.pov = false; if (slot.anim.ik === povIK) slot.anim.ik = null; }
      slot.pose = p;
      slot.team.set(TEAM_COLORS[p.team % TEAM_COLORS.length]);
      slot.friend = !!p.team && p.friendly;
      slot.foe = !!p.team && !p.friendly;
      // the animation budget: the size and visibility from the last frame() pick how often this kong re-poses (a kong
      // seen for the first time has px 0 and re-poses at once); between re-poses the owed time accumulates
      const an = slot.anim;
      const every = ctx.shotMode || FORCE_TIER !== null || slot.px === 0 || slot.px >= PX_LO || an.ik || an.overlay || an.showPose || an.postPose ? 0
        : slot.inView || slot.shadow ? ANIM_SMALL_S : ANIM_HIDDEN_S;
      slot.animDt += dt;
      if (slot.animDt >= every) {
        // eye contact: the camera in front of the face within 12 m → the eyes find it (lobby, view cameras, a foe facing
        // you); else free saccades. Head bone frame = rest model axes at the head joint (face −Z, eyes ≈ (±0.07, 0.2, −0.16)).
        eyeM.copy(an.bone("head")).invert();
        eyeV.copy(ctx.camera.position).applyMatrix4(eyeM).sub(EYE_MID);
        const d = eyeV.length();
        an.gazeAt = d > 0.3 && d < 12 && -eyeV.z > 0.35 * d && p.state !== "dead"
          ? (gazeXY.x = THREE.MathUtils.clamp(-eyeV.x / d, -0.36, 0.36), gazeXY.y = THREE.MathUtils.clamp(eyeV.y / d + 0.03, -0.28, 0.3), gazeXY) : null;
        an.update(p, slot.animDt);
        slot.animDt = 0;
        if (ctx.shotMode) an.settleFace();
      } else an.follow(p);
      ensureWeapon(p.state === "dead" || p.state === "freefall" || p.state === "glide" || p.state === "plane" || p.state === "emote" || p.state === "zip" || p.state === "drive" ? null : p.weapon);
      // hand socket at the right fist, aimed along yaw/pitch (world) — expressed in g's parent space
      fistPos.copy(FIST).applyMatrix4(an.bone("wristR"));
      const rl = an.reloadDip;
      aimE.set(an.gunPitch + an.aimPitchOff + an.recoil.x * 0.05 - rl * 0.5, p.yaw + an.aimYawOff + (an.twoHanded ? 0.0 : 0.04), -rl * 0.9 + (an.twoHanded ? 0 : -0.12));
      aimQ.setFromEuler(aimE);
      socketWorld.compose(fistPos, aimQ, ONE);
      g.updateMatrixWorld();
      invParent.copy(g.matrixWorld).invert();
      slot.socket.matrix.multiplyMatrices(invParent, socketWorld);
      slot.socket.matrix.decompose(slot.socket.position, slot.socket.quaternion, slot.socket.scale);
      slot.sockW.copy(socketWorld);
      if (offOn) {
        fistPos.set(-FIST.x, FIST.y, FIST.z).applyMatrix4(an.bone("wristL"));
        aimE.set(an.aim + offPitch + an.recoil.x * 0.04, p.yaw + offYaw, 0.12);
        socketWorld2.compose(fistPos, aimQ.setFromEuler(aimE), ONE);
        offSocket.matrix.multiplyMatrices(invParent, socketWorld2);
        offSocket.matrix.decompose(offSocket.position, offSocket.quaternion, offSocket.scale);
        slot.offW.copy(socketWorld2);
      }
      for (const a of attached) { a.o.matrix.multiplyMatrices(invParent, an.bone(a.bone)).multiply(a.local); a.o.matrixWorldNeedsUpdate = true; }
    },
    muzzle(out) { return out.copy(muzzleLocal).applyMatrix4(socketWorld); },
    swimEvt: () => slot.anim.swimEvt, swimEvtKind: () => slot.anim.swimEvtKind,
    setVisible(v) { slot.visible = v; g.visible = v; },
    dispose() { mgr.release(slot); g.removeFromParent(); },
    bone(name) { return slot.anim.bone(name); },
    animator: slot.anim,
    weaponReady: () => pending,
    setLodBias(k: number) { slot.lodBias = k; },
    setOutline(color) { if (color === null) slot.outline = null; else (slot.outline ??= new THREE.Color()).set(color); },
    setAimOffset(yaw: number, pitch = 0) { slot.anim.aimYawOff = yaw; slot.anim.aimPitchOff = pitch; },
    async setOffhand(id, yaw = 0, pitch = 0) {
      offYaw = yaw; offPitch = pitch;
      offSocket.clear(); offOn = false; offSocket.visible = false; slot.off = null;
      if (!id) return;
      const release = ctx.hold(`kong-offhand-${id}`);
      try { const o = await mgr.weapons.createHeldWeapon(id, slot.weaponRarity); mgr.learnWeapon(id, o); heldMuzzle(id, offMuzzleLocal); o.traverse((c) => { c.castShadow = false; c.userData.castShadow = false; c.userData.farShadow = false; }); offSocket.add(o); offOn = true; slot.off = id; offSocket.visible = slot.wTier === 0 || slot.px === 0; }
      finally { release(); }
    },
    offMuzzle(out) { return out.copy(offMuzzleLocal).applyMatrix4(socketWorld2); },
    setLook(o) {
      if (o.rim !== undefined) slot.rimOverride = o.rim === null ? null : new THREE.Color(o.rim);
      if (o.rimStrength !== undefined) slot.rimOverrideK = o.rimStrength;
      if (o.fur !== undefined) slot.fur = o.fur;
      if (o.fill !== undefined) slot.fill.set(o.fill);
      if (o.key !== undefined) slot.key = o.key;
      // outfit colour: a full RECOLOUR of the shorts fabric (negative look = recolour by the map's luminance in the shader)
      if (o.shorts !== undefined) { slot.shorts.set(o.shorts); slot.shorts.setRGB(-slot.shorts.r, -slot.shorts.g, -slot.shorts.b); }
    },
    attach(o, bone, local = new THREE.Matrix4()) {
      o.matrixAutoUpdate = false; g.add(o); attached.push({ o, bone, local });
      g.updateMatrixWorld(); invParent.copy(g.matrixWorld).invert();
      o.matrix.multiplyMatrices(invParent, slot.anim.bone(bone)).multiply(local); o.matrixWorldNeedsUpdate = true;
    },
    detach(o) { const i = attached.findIndex((a) => a.o === o); if (i >= 0) attached.splice(i, 1); o.removeFromParent(); },
    setOutfit(o) {
      slot.hat = o?.hat ?? -1; slot.top = o?.top ?? -1;
      // the shorts: the outfit's colour (a full recolour of the fabric), else back to the kong's own subtle tint
      if (o?.shorts) { slot.shorts.set(o.shorts); slot.shorts.setRGB(-slot.shorts.r, -slot.shorts.g, -slot.shorts.b); }
      else slot.shorts.copy(SHORTS[(seed0 % SHORTS.length + SHORTS.length) % SHORTS.length]);
    },
  };
  return actor;
}

export type { MatKey };
