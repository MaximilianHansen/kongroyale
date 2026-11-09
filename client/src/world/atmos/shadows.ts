// Sun + shadows and THE material patcher.
//
// Shadows: the sun is static, so the whole island is baked ONCE into a static far shadow
// map, and only two small dynamic cascades are rendered per frame:
//   - three r186's SunLight (atlas of 2 cascades, cascade selection + shadow coords computed PER FRAGMENT from one
//     world-position varying — no per-vertex vDirectionalShadowCoord[4]), with our own cascade fit (AtmosSunShadow):
//     fixed splits (0–~30 m, ~30–150 m), caster ceiling a few hundred metres toward the sun (ridges shadow the
//     player), one shared depth range so the bias is a constant in METRES (a fixed -0.00012 over a 7 km light
//     camera would be an 0.84 m offset = peter-panning), normal offset ≈ 1.2 texels per cascade.
//   - a static far map (DirectionalLight, NOT in the scene → no extra light in any program) fitted to the island's
//     land, rendered once at load through three's own shadow renderer (alpha-tested cards, instancing, skinning all
//     handled), sampled beyond the cascades. Dynamic / tiny casters are skipped for the bake (see farCaster()).
//
// Every lit material in the scene gets:
//   1. getSunShadow() replaced by atmosSunShadow(): 2 cascades → far map → × cloud shadow (direct sun only),
//   2. aerial perspective (atmosAerial) applied in LINEAR space before tone mapping.
// Unlit built-ins (MeshBasic, Points) get 2 only. ShaderMaterials are left alone (they can use ATMOS_PARS).
// Patched materials read the shared non-sampler uniforms from ONE uniform buffer (glsl.ts ATMOS_UBO, and its rule: no
// writes between two patched draws of one render() call); ?atmos=noubo keeps them loose.
import * as THREE from "three";
import { SunLight } from "three/addons/lights/SunLight.js";
import { SunLightShadow } from "three/addons/lights/SunLightShadow.js";
import type { Quality } from "../../engine/engine";
import type { Terrain } from "../../../../shared/world/terrain";
import { ATMOS_PARS, ATMOS_AO_PARS, ATMOS_UBO_DECL, type AtmosUniforms } from "./glsl";
import { atmosFlags } from "./state";
import { bake, onRestore } from "../../engine/res/restore";
const atmosFlagsHas = (f: string) => atmosFlags().has(f);

const TIER = {
  //        cascade map (per cascade) | c0/c1 split | cascade reach | far map | caster ceiling toward the sun
  // cascade 1 reaches 160 m (containers at 150–250 m would get the static far map's 0.7 m blobs); it only
  // re-renders every 4th frame / on a > 12° turn / a 6 m move, so the longer reach costs little
  // ultra cascade 1 → 220 m (the poi-01 apron props at ~150 m would sit in c1's fade to the far map, which
  // has no sub-1 m casters) — paid for by the C1 layer mask (small casters only in cascade 0, see sweep)
  // ultra 1536 per cascade (perf; c0 texel ~2.6 cm, c1 ~20 cm at 150 m — the TAA-rotated taps
  // hide the difference, the raster / atlas clear cost scales with the texel count)
  ultra: { map: 1536, split: 26, far: 220, farMap: 4096, reach: 200 },
  high: { map: 1536, split: 24, far: 160, farMap: 4096, reach: 180 },
  medium: { map: 2048, split: 22, far: 120, farMap: 2048, reach: 240 },
  low: { map: 1536, split: 18, far: 70, farMap: 2048, reach: 200 },
} as const;

// (uniformsGroups: three r186 binds them for any material type, not only ShaderMaterial)
type Patchable = THREE.Material & { defines?: Record<string, unknown>; onBeforeCompile: THREE.Material["onBeforeCompile"]; uniformsGroups?: THREE.UniformsGroup[] };

/** the three r186 internals warmUbo() uses (not in its typings): a program's link check and the state's block-index cache */
interface UboProgram { cacheKey: string; program: unknown; isReady(): boolean }
interface UboState { updateUBOMapping(group: THREE.UniformsGroup, program: unknown): void }

interface SunShadowInternals {
  _viewportCount: number;
  _cameras: THREE.OrthographicCamera[];
  _matrices: THREE.Matrix4[];
  _frustums: THREE.Frustum[];
  _cascadeData: THREE.Vector4[];
  _viewports: THREE.Vector4[];
  _updateMatrix(cam: THREE.Camera, m: THREE.Matrix4, f: THREE.Frustum, vp?: THREE.Vector4): void;
}

/** layer bit marking the casters that render into cascade 1 (sweep: radius ≥ 0.5 m, skinned, instanced/batched) —
 *  cascade 1 (26–220 m) skips pebbles / cans / small crates; they keep cascade-0 contact shadows and the AO */
export const C1_LAYER = 29;
const C1_BIT = 1 << C1_LAYER;
const C1_MASK_ON = !atmosFlags().has("c1all");
const _orient = new THREE.Matrix4();
const _viewToLight = new THREE.Matrix4();
const _dir = new THREE.Vector3();
const _up = new THREE.Vector3();
const _c = new THREE.Vector3();
const _dir2 = new THREE.Vector3();
const _camL = new THREE.Vector3();
const _near = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _far = [0, 1, 2, 3].map(() => new THREE.Vector3());
const _slice = Array.from({ length: 8 }, () => new THREE.Vector3());

/**
 * SunLightShadow with our cascade fit: fixed split + reach, a caster ceiling `reach` metres toward the sun, one shared
 * light-depth range for both cascades, and world-space biases published to the shared uniforms every update.
 */
class AtmosSunShadow extends SunLightShadow {
  split = 30;
  far = 150;
  reach = 500;
  /** world texel size of each cascade (m), filled every update */
  readonly texel = [0.03, 0.15];
  /** cascade SCHEDULE (the sun and the world are static; only the camera and a few dynamic casters move):
   *  - cascade 1 (26–120 m) is fitted with a ~12° rotation MARGIN, so looking around does not invalidate it; it is
   *    re-rendered when the view leaves the margin, the camera moved > 6 m, or every 4th frame (dynamic casters there
   *    lag ≤ 3 frames),
   *  - cascade 0 (the contact shadows, the player's surroundings) every frame while the camera moves / turns, every
   *    other frame while it is still,
   *  - a frame with nothing scheduled skips the shadow pass entirely. `partial` = only cascade `faceBase` renders
   *    (the atlas clear is scissored to it). */
  stagger = true;
  /** Low shadows (display settings): cascade 0 refreshes every 2nd frame even while moving, cascade 1 every 8th */
  slow = false;
  partial = false;
  faceBase = 0;
  skip = false;
  private n = 0;
  private c0Pos = new THREE.Vector3(1e9, 0, 0);
  private c0Dir = new THREE.Vector3();
  private c1Pos = new THREE.Vector3(1e9, 0, 0);
  private c1Dir = new THREE.Vector3();
  private c1Age = 99;
  private c0Age = 99;
  /** rotation margin of cascade 1 (radians) */
  readonly margin = THREE.MathUtils.degToRad(12);
  constructor(private u: AtmosUniforms) { super(); }
  /** decide this frame's cascades BEFORE the shadow render (WebGLShadowMap reads the face count before updateMatrices) */
  plan(vc: THREE.Camera) {
    const me = this as unknown as SunShadowInternals;
    this.view = vc; this.viewMask = vc.layers.mask;
    vc.updateMatrixWorld();
    const dirNow = _dir2.set(0, 0, -1).transformDirection(vc.matrixWorld);
    this.n++;
    this.c0Age++; this.c1Age++;
    const c0Moving = vc.position.distanceTo(this.c0Pos) > 0.02 || dirNow.dot(this.c0Dir) < 0.99999;
    // (perf: a still camera refreshes cascade 0 every 3rd frame — the static world's map is exact, only
    // animated casters' shadows update at a third of the frame rate; a moving camera renders it every frame)
    const r0 = !this.stagger || (c0Moving && (!this.slow || this.c0Age >= 2)) || this.c0Age >= 3;
    // (a still camera refreshes cascade 1 every 8th frame, a moving one every 4th — its dynamic casters are 26–220 m
    // out; the view leaving the margin / a 6 m move still re-render at once)
    const r1 = !this.stagger || this.c1Age >= (c0Moving && !this.slow ? 4 : 8) || vc.position.distanceTo(this.c1Pos) > 6 || dirNow.dot(this.c1Dir) < Math.cos(this.margin * 0.8);
    this.skip = !r0 && !r1;
    this.partial = r0 !== r1;
    this.faceBase = r0 ? 0 : 1;
    me._viewportCount = r0 && r1 ? 2 : 1;
    if (r0) { this.c0Pos.copy(vc.position); this.c0Dir.copy(dirNow); this.c0Age = 0; }
    if (r1) { this.c1Pos.copy(vc.position); this.c1Dir.copy(dirNow); this.c1Age = 0; }
  }
  /** the view camera of the current shadow render + its layer mask (cascade 1 renders only C1_LAYER casters: three's
   *  shadow renderer tests object.layers against the VIEW camera's layers, so the mask is swapped per cascade) */
  view: THREE.Camera | null = null;
  viewMask = 1;
  // during a partial render the shadow renderer's face 0 is cascade `faceBase`
  getCamera(i = 0) {
    const c = i + this.faceBase;
    if (this.view) this.view.layers.mask = c === 1 && C1_MASK_ON ? C1_BIT : this.viewMask;
    if (this.cull) this.cull(c);
    return (this as unknown as SunShadowInternals)._cameras[c];
  }
  /** set by SunShadows during its own cascade render: hides the static caster subtrees outside cascade c's frustum */
  cull: ((c: number) => void) | null = null;
  getFrustum(i = 0) { return (this as unknown as SunShadowInternals)._frustums[i + this.faceBase]; }
  getViewport(i: number) { return (this as unknown as SunShadowInternals)._viewports[i + this.faceBase]; }

  updateMatrices(light: THREE.Light, viewCamera?: THREE.Camera): void {
    if (!viewCamera) return;
    const me = this as unknown as SunShadowInternals;
    const vc = viewCamera as THREE.PerspectiveCamera;
    const S = this.mapSize;
    const insetX = Math.min(0.25, (Math.ceil(this.radius) + 1) / S.x), insetY = Math.min(0.25, (Math.ceil(this.radius) + 1) / S.y);
    for (let i = 0; i < 2; i++) me._viewports[i].set(i + insetX, insetY, 1 - 2 * insetX, 1 - 2 * insetY);
    const resX = S.x * (1 - 2 * insetX), resY = S.y * (1 - 2 * insetY), res = Math.min(resX, resY);

    const camNear = vc.near;
    const camFar = Math.max(camNear + 1, Math.min(this.far, vc.far));
    const split = Math.min(this.split, camFar * 0.5);
    const splits = [camNear, split, camFar];

    _dir.setFromMatrixPosition(light.matrixWorld).negate().normalize();
    _up.set(0, 1, 0);
    if (Math.abs(_up.dot(_dir)) > 0.99) _up.set(0, 0, 1);
    _orient.lookAt(_c.set(0, 0, 0), _dir, _up);
    _viewToLight.copy(_orient).transpose().multiply(vc.matrixWorld);

    // fit from the UNJITTERED projection (post.ts publishes it): the TAA's sub-pixel jitter moved the slice by up to
    // half a cascade-0 texel, so the texel snap below flipped between neighbouring texels on every still-camera refresh —
    // the whole shadow shifted by one texel every 3rd frame
    const inv = (vc.userData.atmProjInv as THREE.Matrix4 | undefined) ?? vc.projectionMatrixInverse;
    let maxZ = -Infinity;
    for (let i = 0; i < 4; i++) {
      const x = i === 0 || i === 1 ? 1 : -1, y = i === 0 || i === 3 ? 1 : -1;
      const n = _near[i].set(x, y, -1).applyMatrix4(inv);
      const f = _far[i];
      if ((vc as THREE.PerspectiveCamera).isPerspectiveCamera) f.copy(n).multiplyScalar(camFar / camNear); else f.set(n.x, n.y, -camFar);
      n.applyMatrix4(_viewToLight); f.applyMatrix4(_viewToLight);
      maxZ = Math.max(maxZ, n.z, f.z);
    }
    maxZ += this.reach; // casters up to `reach` metres toward the sun still land in the cascades (ridges, towers)

    const shadowNear = 1;
    const centers: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3()];
    const radii = [0, 0];
    let minZ = Infinity;
    // alternation: the plan (which cascade) was made by plan() before the shadow renderer read the face count
    const full = !this.partial, only = this.faceBase;
    const upd = (i: number) => full || i === only;
    for (let i = 0; i < 2; i++) {
      if (!upd(i)) continue;
      const cNear = i === 0 ? splits[0] : me._cascadeData[i - 1].z;
      const cFar = splits[i + 1];
      const fade = cFar - 0.12 * (cFar - splits[i]);
      me._cascadeData[i].set(i === 0 ? -1e10 : cNear, cFar, fade, 0);
      const a0 = (cNear - camNear) / (camFar - camNear), a1 = (cFar - camNear) / (camFar - camNear);
      const ctr = centers[i].set(0, 0, 0);
      for (let j = 0; j < 4; j++) {
        _slice[j * 2].lerpVectors(_near[j], _far[j], a0);
        _slice[j * 2 + 1].lerpVectors(_near[j], _far[j], a1);
        ctr.add(_slice[j * 2]).add(_slice[j * 2 + 1]);
      }
      ctr.multiplyScalar(1 / 8);
      let r2 = 0;
      for (let j = 0; j < 8; j++) { r2 = Math.max(r2, _slice[j].distanceToSquared(ctr)); minZ = Math.min(minZ, _slice[j].z); }
      let r = Math.sqrt(r2);
      // cascade 1: a rotation margin — turning the camera up to ~12° keeps the slice inside (no re-render per turn)
      // (+ the 6 m the camera may move before a re-render)
      if (i === 1) r += _camL.set(0, 0, 0).applyMatrix4(_viewToLight).distanceTo(ctr) * Math.sin(this.margin) + 6;
      r /= 1 - 1 / res; // half-texel pad so snapping never clips a corner
      const tx = (2 * r) / resX, ty = (2 * r) / resY;
      ctr.x = Math.round(ctr.x / tx) * tx; ctr.y = Math.round(ctr.y / ty) * ty; // texel snap: no shimmer
      radii[i] = r;
      this.texel[i] = (2 * r) / res;
    }
    // one light-depth range for both cascades → one metre-accurate depth bias
    const range = maxZ - minZ + 2 * shadowNear;
    for (let i = 0; i < 2; i++) {
      if (!upd(i)) continue;
      const cam = me._cameras[i], r = radii[i];
      _c.copy(centers[i]); _c.z = maxZ + shadowNear; _c.applyMatrix4(_orient);
      cam.position.copy(_c);
      cam.quaternion.setFromRotationMatrix(_orient);
      cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
      cam.near = shadowNear; cam.far = range;
      cam.coordinateSystem = this.camera.coordinateSystem;
      (cam as unknown as { _reversedDepth: boolean })._reversedDepth = (this.camera as unknown as { reversedDepth: boolean }).reversedDepth;
      cam.updateProjectionMatrix();
      cam.updateMatrixWorld();
      me._updateMatrix(cam, me._matrices[i], me._frustums[i], me._viewports[i]);
    }
    // biases in metres: normal offset ≈ 1.2 texels (kills acne on slopes), a tiny constant depth bias (no floating)
    const b = this.u.uAtmSunBias.value;
    if (upd(0)) { b.x = -(0.012 + 0.25 * this.texel[0]) / range; b.z = 1.25 * this.texel[0]; }
    if (upd(1)) { b.y = -(0.03 + 0.3 * this.texel[1]) / range; b.w = 1.2 * this.texel[1]; }
  }
}

/** GLSL: our getSunShadow (2 cascades → static far map → × cloud shadow) — spliced after <shadowmap_pars_fragment> */
const SUN_SHADOW_GLSL = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0 && defined( SHADOWMAP_TYPE_PCF )
#ifndef KR_ATMOS_UBO
uniform vec4 uAtmSunBias;
uniform vec2 uAtmSunRadius;
uniform vec2 uAtmTemporal;
#endif
uniform sampler2DShadow uAtmFarMap;
#ifndef KR_ATMOS_UBO
uniform mat4 uAtmFarMatrix;
uniform vec4 uAtmFarParams;
uniform vec2 uAtmFarSize;
#endif
// one hardware-PCF tap (a bilinear 2x2 compare) — cascade 1 and the far map
float atmPcf1( sampler2DShadow m, vec4 sc, float bias ) {
  vec3 c = sc.xyz / sc.w; c.z += bias;
  if ( any( lessThan( c, vec3( 0.0 ) ) ) || any( greaterThan( c, vec3( 1.0 ) ) ) ) return 1.0;
  return texture( m, c );
}
// cascade 0 (the contact shadows). (A static camera's penumbra flickered up to 19.6/255 luma std
// with a diagonal hatch — a per-pixel / per-frame ROTATED 1–2 tap kernel never converged under the TAA's
// neighbourhood clip): a DETERMINISTIC tent filter, identical in every frame. 9 hardware-bilinear compares on a
// 3x3 grid (tent weights 1-2-1) = a smooth ~5x5-texel tent (C1 penumbra, no stair steps, no noise). ?atmos=pcf4: the
// cheaper 4-tap 3x3 tent. Double-sided foliage cards: one bilinear compare (several layers deep, alpha noise hides it).
float atmPcf4( sampler2DShadow m, vec4 sc, float bias, vec2 o ) {
  vec3 c = sc.xyz / sc.w; c.z += bias;
  if ( any( lessThan( c, vec3( 0.0 ) ) ) || any( greaterThan( c, vec3( 1.0 ) ) ) ) return 1.0;
#ifdef DOUBLE_SIDED
  return texture( m, c );
#elif defined( ATMOS_PCF4 )
  vec2 h = o * 0.5;
  return 0.25 * ( texture( m, vec3( c.xy + vec2( -h.x, -h.y ), c.z ) ) + texture( m, vec3( c.xy + vec2( h.x, -h.y ), c.z ) )
                + texture( m, vec3( c.xy + vec2( -h.x, h.y ), c.z ) ) + texture( m, vec3( c.xy + vec2( h.x, h.y ), c.z ) ) );
#else
  float s = 4.0 * texture( m, c )
    + 2.0 * ( texture( m, vec3( c.xy + vec2( o.x, 0.0 ), c.z ) ) + texture( m, vec3( c.xy - vec2( o.x, 0.0 ), c.z ) )
            + texture( m, vec3( c.xy + vec2( 0.0, o.y ), c.z ) ) + texture( m, vec3( c.xy - vec2( 0.0, o.y ), c.z ) ) )
    + texture( m, vec3( c.xy + o, c.z ) ) + texture( m, vec3( c.xy - o, c.z ) )
    + texture( m, vec3( c.xy + vec2( o.x, -o.y ), c.z ) ) + texture( m, vec3( c.xy + vec2( -o.x, o.y ), c.z ) );
  return s * ( 1.0 / 16.0 );
#endif
}
// cascade 1 (26–220 m, ~20 cm texels): a 4-tap 3x3 tent (one tap drew 4 px stair steps along shadow edges at 30–60 m)
float atmPcfC1( sampler2DShadow m, vec4 sc, float bias, vec2 h ) {
  vec3 c = sc.xyz / sc.w; c.z += bias;
  if ( any( lessThan( c, vec3( 0.0 ) ) ) || any( greaterThan( c, vec3( 1.0 ) ) ) ) return 1.0;
#ifdef DOUBLE_SIDED
  return texture( m, c );
#else
  return 0.25 * ( texture( m, vec3( c.xy + vec2( -h.x, -h.y ), c.z ) ) + texture( m, vec3( c.xy + vec2( h.x, -h.y ), c.z ) )
                + texture( m, vec3( c.xy + vec2( -h.x, h.y ), c.z ) ) + texture( m, vec3( c.xy + vec2( h.x, h.y ), c.z ) ) );
#endif
}
float atmosSunShadow( sampler2DShadow shadowMap, SunLightShadow s ) {
  vec3 wp = vSunShadowWorldPosition.xyz;
  vec3 wn = vSunShadowWorldNormal;
  float viewDepth = vSunShadowWorldPosition.w;
  float shadow = 1.0;
  // faces turned away from the sun receive no direct light anyway: skip every shadow fetch (~⅓ of the lit pixels,
  // more with overdraw). Double-sided cards (leaves) keep sampling: their geometric normal may point either way.
#ifndef DOUBLE_SIDED
  if ( dot( wn, uAtmSunDir ) < -0.08 ) { atmSunVis = 0.0; return 1.0; }
#endif
  vec4 c1 = sunShadowCascade[ 1 ];
  if ( viewDepth < c1.y ) {
    if ( viewDepth >= c1.x ) {
      float cs = atmPcfC1( shadowMap, sunShadowMatrix[ 1 ] * vec4( wp + wn * uAtmSunBias.w, 1.0 ), uAtmSunBias.y, 0.5 * uAtmSunRadius.y / s.shadowMapSize );
      shadow = mix( cs, 1.0, smoothstep( c1.z, c1.y, viewDepth ) );
    }
    vec4 c0 = sunShadowCascade[ 0 ];
    if ( viewDepth < c0.y ) {
      float cs = atmPcf4( shadowMap, sunShadowMatrix[ 0 ] * vec4( wp + wn * uAtmSunBias.z, 1.0 ), uAtmSunBias.x, uAtmSunRadius.x / s.shadowMapSize );
      shadow = mix( cs, shadow, smoothstep( c0.z, c0.y, viewDepth ) );
    }
  }
  // the far map also fills the mid range (from ~1.2× the c0 split): LOD1 plants don't cast into the cascades (veg
  // policy), their impostor crowns are in the far map. min() so objects in both never double-darken.
#ifdef ATMOS_FAR_DEBUG
  if ( uAtmFarParams.w > 0.5 ) { atmSunVis = atmPcf1( uAtmFarMap, uAtmFarMatrix * vec4( wp + wn * uAtmFarParams.y, 1.0 ), uAtmFarParams.x ); return atmSunVis; }
#endif
  float farFrom = sunShadowCascade[ 0 ].y * 1.2;
  if ( uAtmFarParams.w > 0.5 && viewDepth > farFrom ) {
    float fs = atmPcf1( uAtmFarMap, uAtmFarMatrix * vec4( wp + wn * uAtmFarParams.y, 1.0 ), uAtmFarParams.x );
    shadow = min( shadow, mix( 1.0, fs, smoothstep( farFrom, farFrom * 1.8, viewDepth ) ) );
  }
#ifdef ATMOS_SSAO
  shadow = mix( 1.0, shadow, s.shadowIntensity ) * atmosSS( wp ).y;
#else
  shadow = mix( 1.0, shadow, s.shadowIntensity ) * atmosCloudShadow( wp );
#endif
  atmSunVis = shadow;
  return shadow;
}
#define getSunShadow( a, b, c ) atmosSunShadow( a, b )
#endif
`;

/** compat: shaders chained BEFORE atmos (water) that read the sun from directionalLights[0] keep working on SunLight */
const SUN_COLOR_DECL = /* glsl */ `
#if NUM_SUN_LIGHTS > 0
  #define ATM_SUN_COLOR sunLights[ 0 ].color
#elif NUM_DIR_LIGHTS > 0
  #define ATM_SUN_COLOR directionalLights[ 0 ].color
#else
  #define ATM_SUN_COLOR vec3( 0.0 )
#endif
`;

/**
 * The sun-shadow VARYINGS go (perf): three's SunLight passes vSunShadowWorldPosition (vec4) +
 * vSunShadowWorldNormal (vec3) from every vertex of every lit program — 7 floats per vertex through the TBDR parameter
 * buffer, in a geometry-bound frame (5–10 M main-pass vertices). Both are rebuilt per fragment from the varyings the
 * lit shaders already have (vViewPosition, vNormal) with the view matrix: world = Rᵀ(view − t).
 */
const SUN_VARY_RE = /varying vec4 vSunShadowWorldPosition;\s*varying vec3 vSunShadowWorldNormal;/;
const SUN_VARY_SET_RE = /vSunShadowWorldPosition = vec4\( worldPosition\.xyz, - mvPosition\.z \);\s*vSunShadowWorldNormal = shadowWorldNormal;/;
const SM_PARS_V = THREE.ShaderChunk.shadowmap_pars_vertex.replace(SUN_VARY_RE, "");
const SM_V = THREE.ShaderChunk.shadowmap_vertex.replace(SUN_VARY_SET_RE, "");
const SM_PARS_F = THREE.ShaderChunk.shadowmap_pars_fragment.replace(SUN_VARY_RE, "vec4 vSunShadowWorldPosition; vec3 vSunShadowWorldNormal;");
const SUN_VARY_OK = SM_PARS_V !== THREE.ShaderChunk.shadowmap_pars_vertex && SM_V !== THREE.ShaderChunk.shadowmap_vertex && SM_PARS_F !== THREE.ShaderChunk.shadowmap_pars_fragment && !atmosFlagsHas("shvary");
if (!SUN_VARY_OK && !atmosFlagsHas("shvary")) console.warn("[atmos] three's sun-shadow chunks changed: keeping the per-vertex varyings");
const SUN_FROM_VIEW = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
  {
    vec3 atmVP = - vViewPosition;
    mat3 atmVR = mat3( viewMatrix );
    vSunShadowWorldPosition = vec4( ( atmVP - viewMatrix[ 3 ].xyz ) * atmVR, vViewPosition.z );
#ifdef FLAT_SHADED
    vec3 atmVN = normalize( cross( dFdx( atmVP ), dFdy( atmVP ) ) );
#else
    vec3 atmVN = normalize( vNormal );
#endif
    vSunShadowWorldNormal = atmVN * atmVR;
  }
#endif
`;

/** lit materials: the screen-space AO / cloud terms (glsl.ts atmosSS) or a no-op when the post has no AO pass. Other
 *  areas may call atmosSSAO( ATM_WPOS ) / atmosSS( ATM_WPOS ) and read uAtmAOParams in their own chained code */
const SSAO_DECL = /* glsl */ `
#ifndef KR_ATMOS_UBO
uniform float uAtmBounce, uAtmSkyVis;
uniform vec3 uAtmVegFill;
#endif
#ifdef ATMOS_SSAO
${ATMOS_AO_PARS}
#else
#ifndef KR_ATMOS_UBO
uniform vec4 uAtmAOParams;
#endif
vec3 atmosSS3( vec3 wp ) { return vec3( 1.0 ); }
vec2 atmosSS( vec3 wp ) { return vec2( 1.0 ); }
#endif
float atmosSSAO( vec3 wp ) { return atmosSS( wp ).x; }
`;

/** world position for the atmos functions: reuse the sun-shadow position when the program has it (one varying less) */
const WPOS_DECL = /* glsl */ `
#if defined( ATMOS_LIT ) && defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
  #define ATM_WPOS vSunShadowWorldPosition.xyz
  #define vAtmWorld vSunShadowWorldPosition.xyz
  #define ATM_SUN_CLOUD
#else
  varying vec3 vAtmWorld;
  #define ATM_WPOS vAtmWorld
  #define ATM_OWN_VARYING
#endif
float atmSunVis = 1.0;
`;

export class SunShadows {
  readonly sun: SunLight;
  readonly shadow: AtmosSunShadow;
  readonly tier: (typeof TIER)[Quality];
  /** static far shadow map (whole island, baked once) */
  readonly farLight = new THREE.DirectionalLight(0xffffff, 0);
  /** top-down depth of the vegetation crowns (sky visibility under the canopy — post.ts canopySky), baked with the far map */
  readonly canopyLight = new THREE.DirectionalLight(0xffffff, 0);
  private farPending = false;
  private farBakes = 0;
  private farCasterKey = -1;
  private farLastBake = -1e9;
  private readonly hook: THREE.Mesh;
  private patched = new WeakSet<THREE.Material>();
  /** the post runs the AO pass: lit materials take AO + cloud shadow from its screen-space texture (ATMOS_SSAO) */
  ssao = false;
  private frame = 0;
  /** programs whose uniform-block index three already holds (warmUbo), and the program count when the last pass ended */
  private uboWarm = new WeakSet<object>();
  private uboSeen = 0;
  private sunDir = new THREE.Vector3(0, 1, 0);
  private land = new THREE.Box3(new THREE.Vector3(-1200, -10, -1200), new THREE.Vector3(1200, 400, 1200));

  /** @param group the atmos uniform buffer (glsl.ts ATMOS_UBO) patched materials read, or null = loose uniforms */
  constructor(private scene: THREE.Scene, private renderer: THREE.WebGLRenderer, private u: AtmosUniforms, quality: Quality, terrain?: Terrain,
    private readonly group: THREE.UniformsGroup | null = null) {
    this.tier = TIER[quality];
    renderer.shadowMap.type = THREE.PCFShadowMap; // r186 removed PCFSoft (it warns + falls back every load)
    const sun = new SunLight(0xffffff, 3);
    sun.name = "atmos-sun";
    sun.castShadow = true;
    const sh = new AtmosSunShadow(u);
    sh.split = this.tier.split; sh.far = this.tier.far; sh.reach = this.tier.reach;
    sh.mapSize.set(this.tier.map, this.tier.map);
    sh.radius = 1.5;
    sh.bias = 0; sh.normalBias = 0; // ours come from uAtmSunBias (metre-accurate, per cascade)
    // pre-create the atlas: R8 colour (the depth pass writes it, nobody reads it) + 24-bit compare depth
    sh.map = makeShadowTarget(this.tier.map * 2, this.tier.map, atmosFlagsHas("shadow24") ? THREE.UnsignedIntType : THREE.UnsignedShortType, sun.name);
    sun.shadow = sh;
    this.shadow = sh;
    this.sun = sun;
    scene.add(sun);
    // alternating cascades: on a one-cascade frame the atlas clear must not wipe the other → scissor it
    const sm = renderer.shadowMap as THREE.WebGLShadowMap & { render: (l: THREE.Light[], s: THREE.Scene, c: THREE.Camera) => void };
    const smRender = sm.render.bind(sm);
    const clear = renderer.clear.bind(renderer);
    const scis = new THREE.Vector4();
    sm.render = (lights, sc, cam) => {
      const mine = lights.includes(sun) && sun.castShadow && (sm.autoUpdate || sm.needsUpdate);
      if (mine) {
        sh.plan(cam);
        // nothing scheduled this frame (still camera): the atlas keeps both cascades; other lights still render
        if (sh.skip) { (sh as unknown as SunShadowInternals)._viewportCount = 2; sh.skip = false; const rest = lights.filter((l) => l !== sun); if (rest.length) smRender(rest, sc, cam); return; }
      }
      renderer.clear = (c?: boolean, d?: boolean, st?: boolean) => {
        if (sh.partial && renderer.getRenderTarget() === sh.map) {
          const state = renderer.state;
          state.setScissorTest(true); state.scissor(scis.set(sh.faceBase * sh.mapSize.x, 0, sh.mapSize.x, sh.mapSize.y));
          clear(c, d, st);
          state.setScissorTest(false);
        } else clear(c, d, st);
      };
      // subtrees with no shadow caster in them are hidden for the cascade render (three's shadow renderer walks the
      // whole scene graph once per cascade — ~1.8k objects — to find ~10–50 casters)
      const hidden = mine ? this.noCasterRoots : EMPTY, hid = this.hid;
      hid.length = 0;
      for (const o of hidden) if (o.visible && o.parent) { o.visible = false; hid.push(o); }
      // (perf: the shadow render was 0.3–0.5 ms of main-thread time — three walks every caster subtree
      // of the island once per cascade): static caster subtrees whose bounds miss the cascade's frustum are hidden too
      if (mine && ((this.unitCull && this.casterUnits.length) || this.c1Only.size)) sh.cull = this.cullFn;
      // the 1-cascade viewport count lives only inside the shadow render: WebGLLights reads it too, and a light-count
      // change on a partial frame would truncate the cascade uniform arrays to 1 (→ undefined matrix → crash)
      try { smRender(lights, sc, cam); } finally {
        sh.cull = null;
        for (const o of this.culled) o.visible = true;
        this.culled.length = 0;
        for (const o of hid) o.visible = true;
        renderer.clear = clear; (sh as unknown as SunShadowInternals)._viewportCount = 2; sh.faceBase = 0; sh.partial = false;
        if (sh.view) { sh.view.layers.mask = sh.viewMask; sh.view = null; }
      }
    };
    u.uAtmSunRadius.value.set(1.1, 1.0); // cascade-0 tap offset (texels); cascade 1: the 4-tap tent's spacing
    // the light shafts (post.ts) march through cascade 1
    u.uAtmCascMap.value = sh.map.depthTexture;
    u.uAtmCascMatrix.value = (sh as unknown as SunShadowInternals)._matrices[1];
    u.uAtmCascMatrix0.value = (sh as unknown as SunShadowInternals)._matrices[0];

    // far map: fitted to the island's land once; baked in the first render after build (and on setSun)
    if (terrain) this.land = landBounds(terrain);
    const fl = this.farLight;
    fl.name = "atmos-far-shadow"; fl.castShadow = true;
    fl.shadow.autoUpdate = false;
    fl.shadow.mapSize.set(this.tier.farMap, this.tier.farMap);
    fl.shadow.map = makeShadowTarget(this.tier.farMap, this.tier.farMap, THREE.UnsignedShortType, fl.name);
    u.uAtmFarMap.value = fl.shadow.map.depthTexture;
    u.uAtmFarMatrix.value = fl.shadow.matrix;
    u.uAtmFarSize.value.set(this.tier.farMap, this.tier.farMap);

    // canopy map: 2048² over the land box, straight down (camera up = −Z: map u = +X, v = −Z)
    const cl = this.canopyLight;
    cl.name = "atmos-canopy"; cl.castShadow = true;
    cl.shadow.autoUpdate = false;
    cl.shadow.mapSize.set(2048, 2048);
    cl.shadow.map = makeShadowTarget(2048, 2048, THREE.UnsignedShortType, cl.name);
    cl.shadow.camera.up.set(0, 0, -1);
    u.uAtmCanopyMap.value = cl.shadow.map.depthTexture;
    u.uAtmCanopyMatrix.value = cl.shadow.matrix;
    this.fitCanopy();
    // initialise the map (depth 1 = open sky): the AO pass samples it before / without any bake (?modules without veg) —
    // an uninitialised depth texture on a sampler2DShadow made the whole AO pass output zero (a black world)
    bake(() => { const prev = renderer.getRenderTarget(); renderer.setRenderTarget(cl.shadow.map as THREE.WebGLRenderTarget); renderer.clear(true, true, false); renderer.setRenderTarget(prev); });

    // the bake runs INSIDE a scene render (three's shadow renderer needs the live render state): a no-op mesh drawn
    // first in the opaque list calls renderer.shadowMap.render([farLight]) when a bake is pending
    const hookMat = new THREE.ShaderMaterial({
      vertexShader: "void main(){ gl_Position = vec4(2.0, 2.0, 2.0, 1.0); }",
      fragmentShader: "void main(){ gl_FragColor = vec4(0.0); }",
      colorWrite: false, depthWrite: false, depthTest: false,
    });
    const hookGeo = new THREE.BufferGeometry();
    hookGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
    this.hook = new THREE.Mesh(hookGeo, hookMat);
    this.hook.name = "atmos-shadow-bake";
    this.hook.frustumCulled = false; this.hook.renderOrder = -1e9;
    this.hook.castShadow = false; this.hook.receiveShadow = false;
    this.hook.onBeforeRender = (r, sc, cam) => { if (this.farPending && sc === this.scene) this.bakeFar(r, sc as THREE.Scene, cam); };
    // visible only while a bake is pending (otherwise a no-op draw + program switch in every frame)
    this.hook.visible = false;
    scene.add(this.hook);
    onRestore("bake", () => { if (this.farBakes) this.requestFarBake(); });
  }

  /** the video settings' shadow quality, live. epic = the ultra tier; high: shorter cascade 1; medium: 1024²
   *  cascades out to 120 m; low: 768² cascades out to 70 m, refreshed at half rate (the baked far map covers the rest). */
  setQuality(level: "low" | "medium" | "high" | "epic") {
    const cfg = { epic: { map: 1536, split: 26, far: 220 }, high: { map: 1536, split: 24, far: 160 }, medium: { map: 1024, split: 22, far: 120 }, low: { map: 768, split: 18, far: 70 } }[level];
    const sh = this.shadow;
    sh.split = cfg.split; sh.far = cfg.far; sh.slow = level === "low";
    if (sh.mapSize.x !== cfg.map) {
      const old = sh.map;
      sh.mapSize.set(cfg.map, cfg.map);
      sh.map = makeShadowTarget(cfg.map * 2, cfg.map, atmosFlagsHas("shadow24") ? THREE.UnsignedIntType : THREE.UnsignedShortType, this.sun.name);
      old?.dispose();
      this.u.uAtmCascMap.value = sh.map.depthTexture;
    }
    this.renderer.shadowMap.needsUpdate = true;
  }

  setSun(dir: THREE.Vector3, color: THREE.Color, intensity: number) {
    this.sunDir.copy(dir).normalize();
    this.sun.position.copy(this.sunDir);
    this.sun.color.copy(color);
    this.sun.intensity = intensity;
    this.u.uAtmSunI.value = intensity;
    this.sun.updateMatrixWorld();
    this.fitFar();
    this.requestFarBake();
  }

  /** load window: static content may still stream in; afterwards only explicit requests re-bake (no in-match hitch) */
  private streamUntil = 0;
  requestFarBake() { this.farPending = true; this.hook.visible = true; if (!this.streamUntil) this.streamUntil = performance.now() + 25000; }

  /** ortho camera of the far map = the land box seen along the sun */
  private fitFar() {
    const fl = this.farLight, cam = fl.shadow.camera;
    const ctr = this.land.getCenter(new THREE.Vector3());
    const D = 4000;
    fl.position.copy(ctr).addScaledVector(this.sunDir, D);
    fl.target.position.copy(ctr);
    fl.updateMatrixWorld(true); fl.target.updateMatrixWorld(true);
    const view = new THREE.Matrix4().lookAt(fl.position, ctr, new THREE.Vector3(0, 1, 0)).setPosition(fl.position).invert();
    const b = new THREE.Box3();
    const p = new THREE.Vector3();
    for (let i = 0; i < 8; i++) {
      p.set(i & 1 ? this.land.max.x : this.land.min.x, i & 2 ? this.land.max.y : this.land.min.y, i & 4 ? this.land.max.z : this.land.min.z).applyMatrix4(view);
      b.expandByPoint(p);
    }
    cam.left = b.min.x; cam.right = b.max.x; cam.bottom = b.min.y; cam.top = b.max.y;
    cam.near = Math.max(1, -b.max.z - 50); cam.far = -b.min.z + 50;
    cam.updateProjectionMatrix();
    const texel = Math.max((cam.right - cam.left) / fl.shadow.mapSize.x, (cam.top - cam.bottom) / fl.shadow.mapSize.y);
    const range = cam.far - cam.near;
    // depth bias (NDC) ≈ 0.35 m + ⅓ texel, normal offset ≈ 1.2 texels, PCF radius 1 texel
    this.u.uAtmFarParams.value.set(-(0.35 + texel * 0.33) / range, texel * 1.2, 1.0, this.u.uAtmFarParams.value.w);
  }

  /** ortho camera of the canopy map: the land box seen from straight above */
  private fitCanopy() {
    const cl = this.canopyLight, cam = cl.shadow.camera;
    const ctr = this.land.getCenter(new THREE.Vector3());
    const top = this.land.max.y + 200;
    cl.position.set(ctr.x, top, ctr.z);
    cl.target.position.set(ctr.x, this.land.min.y, ctr.z);
    cl.updateMatrixWorld(true); cl.target.updateMatrixWorld(true);
    const hx = (this.land.max.x - this.land.min.x) / 2, hz = (this.land.max.z - this.land.min.z) / 2, h = Math.max(hx, hz);
    cam.left = -h; cam.right = h; cam.bottom = -h; cam.top = h;
    cam.near = 1; cam.far = top - this.land.min.y + 20;
    cam.updateProjectionMatrix();
    // taps at ±4 m round the point (map uv); a crown ≥ 2.5 m above the surface blocks its sky; a closed canopy keeps
    // 45 % of the open-sky fill
    this.u.uAtmCanopyParams.value.set(this.u.uAtmCanopyParams.value.x, 0.45, 4 / (2 * h), 2.5);
  }

  /** the canopy map: only the vegetation's big-plant impostors (every tree / palm on the island, drawn un-faded by the
   *  veg module whenever a > 900 m wide ortho camera renders them) */
  private bakeCanopy(r: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera) {
    const off: THREE.Object3D[] = [], forced: THREE.Object3D[] = [];
    let n = 0;
    scene.traverse((o) => {
      const canopy = /^veg:impostor/.test(o.name) && o.castShadow && o.userData.farShadow === "force";
      if (canopy) { n++; if (!o.visible) { o.visible = true; forced.push(o); } }
      else if (o.castShadow) { o.castShadow = false; off.push(o); }
    });
    if (n) {
      this.canopyLight.updateMatrixWorld(true); this.canopyLight.target.updateMatrixWorld(true);
      this.canopyLight.shadow.needsUpdate = true;
      r.shadowMap.render([this.canopyLight], scene, cam);
    }
    for (const o of off) o.castShadow = true;
    for (const o of forced) o.visible = false;
    this.u.uAtmCanopyParams.value.x = n ? 1 : 0;
  }

  /** which casters go into the static far map: static, not tiny, not grass-like, not animated */
  private farCaster(o: THREE.Object3D): boolean {
    const ud = o.userData;
    if (ud.farShadow === false) return false;
    if (ud.farShadow === true || ud.farShadow === "force") return true;
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) return false;
    if (/grass|fern|flower|weed|clover|pebble|shell|decal|kong|bot-|player|rocket|loot|chest|fx|viewmodel|held|glider|plane|storm|particle|spark|splash/i.test(o.name)) return false;
    const m = o as THREE.Mesh;
    const g = m.geometry as THREE.BufferGeometry | undefined;
    if (!g) return false;
    // instanced / batched: the geometry is ONE instance at an unknown per-instance scale (impostor quads are unit
    // cards scaled per tree) — the name filter above is the only filter. Plain meshes: skip sub-texel objects.
    if ((m as THREE.InstancedMesh).isInstancedMesh || (m as unknown as THREE.BatchedMesh).isBatchedMesh) return true;
    const s = o.getWorldScale(_c);
    // (0.8 m: pallet stacks / forklifts beyond cascade 1 keep a soft far-map shadow)
    return geomRadius(g) * Math.max(s.x, s.y, s.z) > 0.8;
  }

  private bakeFar(r: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.Camera) {
    this.farPending = false;
    this.hook.visible = false;
    const t0 = performance.now();
    const off: THREE.Object3D[] = [];
    const forced: THREE.Object3D[] = [];
    scene.traverse((o) => {
      if (o.userData.farShadow === "force" && !o.visible) { o.visible = true; forced.push(o); }
      if (!o.castShadow) return;
      if (!this.farCaster(o)) { o.castShadow = false; off.push(o); }
    });
    const cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    this.farLight.updateMatrixWorld(true); this.farLight.target.updateMatrixWorld(true);
    this.farLight.shadow.needsUpdate = true;
    r.shadowMap.render([this.farLight], scene, cam);
    for (const o of off) o.castShadow = true;
    for (const o of forced) o.visible = false;
    if (!atmosFlagsHas("nocanopy")) this.bakeCanopy(r, scene, cam);
    r.setClearColor(cc, ca);
    // (written inside the main render: glsl.ts ATMOS_UBO's rule — in time for the patched draws after this hook)
    this.u.uAtmFarParams.value.w = 1;
    this.farBakes++;
    this.farLastBake = performance.now();
    const w = globalThis as unknown as { __kr?: { atmosFarBake?: unknown } };
    if (w.__kr) w.__kr.atmosFarBake = { n: this.farBakes, ms: Math.round(performance.now() - t0), skipped: off.length };
  }

  /**
   * three looks up a program's block index (gl.getUniformBlockIndex, a synchronous GPU-process round trip) the first
   * time the program draws with the buffer. At a match start the kongs, weapons and items draw for the first time, and
   * those lookups waited on the busy GPU process for up to 14 ms each (23 of them, ~45 ms plus two extra long frames).
   * Look them up ahead: every program that carries the block and has finished linking (isReady() never blocks; without
   * KHR_parallel_shader_compile it is true at once), at most 8 a frame, and only while the program list has grown.
   */
  private warmUbo() {
    const progs = this.renderer.info.programs as unknown as UboProgram[] | null;
    if (!progs || progs.length === this.uboSeen) return;
    const state = this.renderer.state as unknown as UboState;
    let n = 0, pending = false;
    for (let i = 0; i < progs.length; i++) {
      const p = progs[i];
      if (this.uboWarm.has(p) || !p.cacheKey.includes("KR_ATMOS_UBO")) continue;
      if (n >= 8 || !p.isReady()) { pending = true; continue; }
      state.updateUBOMapping(this.group!, p.program);
      this.uboWarm.add(p); n++;
    }
    if (!pending) this.uboSeen = progs.length;
  }

  /** per frame: periodic material sweep; re-bake the far map while the world is still streaming in */
  update() {
    if (this.group) this.warmUbo();
    // the no-caster subtrees + static caster units: refreshed every 30 frames while the world streams in, every 60 after
    // (new casters streaming into a pruned group wait ≤ 0.5 s)
    // (every 120 frames after the load window, half a period after the sweep — the two full-scene walks never share
    // a frame)
    const streaming = performance.now() < this.streamUntil || !this.streamUntil;
    if (streaming ? this.frame % 30 === 0 : this.frame % 120 === 60) this.findNoCasterRoots();
    // material sweep: every 24 frames while the world streams in, every 120 after (a scene traversal of ~2k objects)
    const every = performance.now() < this.streamUntil || !this.streamUntil ? 24 : 120;
    if ((this.frame++ % every) === 0) {
      const n = this.sweep();
      if (n !== this.farCasterKey) {
        // new static casters appeared (async POI content): re-bake, but only a few times and never back-to-back
        const first = this.farCasterKey < 0;
        this.farCasterKey = n;
        const now = performance.now();
        if (!first && this.farBakes < 6 && now < this.streamUntil && now - this.farLastBake > 1500) this.requestFarBake();
      }
    }
  }

  /** visible subtrees (≤ 3 levels below the scene) that hold no shadow caster: hidden during the cascade render */
  private noCasterRoots: THREE.Object3D[] = [];
  private hid: THREE.Object3D[] = [];
  /** static caster subtrees with their world bounds (refreshed with the no-caster roots): culled per cascade */
  private casterUnits: Array<{ o: THREE.Object3D; box: THREE.Box3 }> = [];
  private culled: THREE.Object3D[] = [];
  private unitCull = !atmosFlagsHas("nounitcull");
  /** veg LOD1 sets cast into cascade 1 (?atmos=nolod1shadow: off) */
  readonly lod1Shadows = !atmosFlagsHas("nolod1shadow");
  private cullFn = (c: number) => {
    // restore the previous cascade's culled units, then hide the ones outside this cascade's frustum
    for (const o of this.culled) o.visible = true;
    this.culled.length = 0;
    const f = (this.shadow as unknown as SunShadowInternals)._frustums[c];
    if (this.unitCull) for (const u of this.casterUnits) if (u.o.visible && !f.intersectsBox(u.box)) { u.o.visible = false; this.culled.push(u.o); }
    if (c === 0) for (const o of this.c1Only) if (o.visible) { o.visible = false; this.culled.push(o); }
  };

  private findNoCasterRoots() {
    const out: THREE.Object3D[] = [];
    const units: Array<{ o: THREE.Object3D; box: THREE.Box3 }> = [];
    // one traversal: per subtree, whether it holds a caster and whether its casters can be bounded statically
    const info = new Map<THREE.Object3D, { cast: boolean; dyn: boolean; n: number }>();
    const scan = (o: THREE.Object3D): { cast: boolean; dyn: boolean; n: number } => {
      const isDraw = (o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine;
      let cast = !!(o.castShadow && isDraw), n = 1;
      // unboundable: skinned / unculled (camera-LOD'd instancing) / named dynamic content
      let dyn = cast && ((o as THREE.SkinnedMesh).isSkinnedMesh || !o.frustumCulled || DYN_RE.test(o.name));
      if (DYN_RE.test(o.name)) dyn = true;
      for (const c of o.children) { const r = scan(c); cast ||= r.cast; dyn ||= r.dyn && r.cast; n += r.n; }
      const r = { cast, dyn, n };
      info.set(o, r);
      return r;
    };
    for (const c of this.scene.children) scan(c);
    const visit = (o: THREE.Object3D, depth: number) => {
      for (const c of o.children) {
        if (!c.visible || c === this.sun || c === this.hook) continue;
        const r = info.get(c)!;
        if (!r.cast) { out.push(c); continue; }
        // a bounded static unit: small enough, or a leaf of the ≤ 3-level walk
        if (!r.dyn && c.children.length && (r.n <= 24 || depth >= 3)) {
          const box = casterBox(c);
          if (!box.isEmpty()) { units.push({ o: c, box: box.expandByScalar(4) }); continue; }
        }
        if (depth < 3 && c.children.length) visit(c, depth + 1);
      }
    };
    visit(this.scene, 0);
    this.noCasterRoots = out;
    this.casterUnits = units;
  }

  /** patch every material in the scene that is not yet patched; returns the static caster count (bake trigger) */
  sweep(): number {
    let casters = 0;
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      if (this.lod1Shadows && o.name.endsWith(":lod1")) this.adoptLod1(o);
      if (o.castShadow) {
        if (!(o as THREE.SkinnedMesh).isSkinnedMesh) casters++;
        // (the beach's dressing palms are planted into the veg impostor set after the first bake and need a
        // far-map shadow too): instanced far-map casters count by their instance number — a replant re-bakes
        if (o.userData.farShadow === "force" && (o as THREE.InstancedMesh).isInstancedMesh) casters += (o as THREE.InstancedMesh).count * 1e-3;
        if (!(o.layers.mask & C1_BIT) && !c1Checked.has(o)) { c1Checked.add(o); if (c1Caster(o)) o.layers.enable(C1_LAYER); }
      }
      if (Array.isArray(m)) m.forEach((x) => this.patch(x)); else this.patch(m);
    });
    return casters;
  }

  /** cascade-1-only casters (veg LOD1 sets whose LOD0 sibling casts: between the LOD0 radius and the
   *  far map's fade-in nothing would ground the palms); hidden while cascade 0 renders */
  private c1Only = new Set<THREE.Object3D>();
  private adoptLod1(o: THREE.Object3D) {
    const m = /^veg:(.+):lod1$/.exec(o.name);
    if (!m || !(o as THREE.InstancedMesh).isInstancedMesh || this.c1Only.has(o)) return;
    const sib = o.parent?.getObjectByName(`veg:${m[1]}:lod0`);
    if (!sib || !sib.castShadow) return;
    this.c1Only.add(o);
    o.castShadow = true;
    o.userData.castShadow = true; // (atmos' afterBuild policy: explicit flags win)
    o.layers.enable(C1_LAYER);
  }

  /** (perf) materials patched since the last drainPatched() — the stream hides the ones that already had a
   *  program (drawn unpatched while their POI was still building) until their PATCHED program is compiled, instead of a
   *  live frame recompiling them (440-530 ms 'integrate:interiors:compile' frames) */
  freshPatched: THREE.Material[] = [];
  drainPatched(): THREE.Material[] { const a = this.freshPatched; this.freshPatched = []; return a; }
  patch(mat: THREE.Material) {
    if (this.patched.has(mat)) return;
    this.patched.add(mat);
    const m = mat as Patchable & { isMeshStandardMaterial?: boolean; isMeshLambertMaterial?: boolean; isMeshPhongMaterial?: boolean; isMeshToonMaterial?: boolean; isMeshBasicMaterial?: boolean; isPointsMaterial?: boolean; isShaderMaterial?: boolean };
    if (m.isShaderMaterial) return; // custom shaders own their look; they can import ATMOS_PARS + shared uniforms
    const lit = !!(m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial);
    const unlit = !!(m.isMeshBasicMaterial || m.isPointsMaterial);
    if (!lit && !unlit) return;
    // (only a material this patch really changes may be reported. Pushed
    // before the two returns above, every ShaderMaterial the boot's sweeps met — the sky dome, the horizon skirt, the
    // cloud impostors — reached main.ts integrateFresh as "patched after it compiled" and was hidden until the first
    // streamed POI finished integrating: the title's whole sky blinked black for ~8-11 frames on every load)
    if (this.freshPatched.length < 20000) this.freshPatched.push(mat);

    const prevHook = m.onBeforeCompile;
    const prevHookSrc = String(prevHook);
    const protoKey = THREE.Material.prototype.customProgramCacheKey;
    const hadKey = m.customProgramCacheKey !== protoKey;
    const prevKey = m.customProgramCacheKey;

    m.defines = m.defines || {};
    m.defines.ATMOS = 1;
    if (this.group) m.defines.KR_ATMOS_UBO = 1;
    if (lit) m.defines.ATMOS_LIT = 1;
    if (lit && this.ssao) m.defines.ATMOS_SSAO = 1;
    if (lit && (m.userData?.veg || /^terrain/i.test(m.name))) m.defines.ATMOS_SKYVIS = 1;
    if (lit && m.userData?.veg) m.defines.ATMOS_VEG = 1;
    // the per-preset vegetation grade (lit leaves / bark AND the far impostors, which are unlit quads)
    if (m.userData?.veg || (hadKey && /^veg-impostor/.test(String(prevKey.call(m))))) m.defines.ATMOS_VEGG = 1;
    if (lit && atmosFlagsHas("fardebug")) m.defines.ATMOS_FAR_DEBUG = 1;
    if (lit && atmosFlagsHas("pcf4")) m.defines.ATMOS_PCF4 = 1;
    // the crane cables (9–12 cm wire ropes, 0.3–0.6 px at 150–400 m) rasterise as dashes that
    // walk under a strafe, so wire materials keep a minimum screen width (the tube grows along its normal to ~1.2 px)
    if (lit && (m.userData?.thinWire || /^(cable|wire|wire-?rope|stay)s?$/i.test(m.name)) && !atmosFlagsHas("nothin")) m.defines.ATMOS_THIN = 1;

    const u = this.u, group = this.group;
    m.onBeforeCompile = function (shader, renderer) {
      if (prevHook && prevHook !== protoHook) prevHook.call(this, shader, renderer);
      // the uniform buffer: decided per compile from this material's own defines (a clone that chains this hook without
      // them compiles loose), and attached here, where the block is injected (three runs the hook once per material and
      // program key, before that program's first draw)
      const ubo = !!group && !!(this as Patchable).defines?.KR_ATMOS_UBO;
      if (ubo) (this as Patchable).uniformsGroups = [group!];
      // shared uniform objects — one update per frame reaches every material (under the buffer only the samplers are
      // active loose uniforms: the block's members have other names, uAtmK<row>)
      for (const k of Object.keys(u) as Array<keyof AtmosUniforms>) shader.uniforms[k] = u[k];
      // a clone of an already-patched material (harbor indoorMat / warehouse indoor twins) chains the source's hook,
      // which injected atmos already: a second injection redefines every uAtm* symbol and the program fails to link
      if (shader.vertexShader.includes(ATMOS_MARK)) return;
      shader.vertexShader = ATMOS_MARK + (ubo ? ATMOS_UBO_DECL : "") + shader.vertexShader;
      if (lit && SUN_VARY_OK) shader.vertexShader = shader.vertexShader.replace("#include <shadowmap_pars_vertex>", SM_PARS_V).replace("#include <shadowmap_vertex>", SM_V);
      shader.vertexShader = shader.vertexShader
        .replace("#include <project_vertex>", `#include <project_vertex>
#ifdef ATMOS_THIN
  {
    // grow the wire along its (view-space) normal so it never rasterises thinner than uAtmThin.x px in radius
    float atmPx = -mvPosition.z * 2.0 / ( projectionMatrix[ 1 ][ 1 ] * uAtmRes.y );
    mvPosition.xyz += normalize( transformedNormal ) * max( 0.0, uAtmThin.x * atmPx - uAtmThin.y );
    gl_Position = projectionMatrix * mvPosition;
  }
#endif
  // the viewmodel (< uAtmJitter.z m from the lens) is drawn WITHOUT the TAA jitter
  if ( uAtmJitter.z > 0.0 && -mvPosition.z < uAtmJitter.z ) gl_Position.xy += uAtmJitter.xy * gl_Position.w;`)
        .replace("#include <fog_pars_vertex>", `${WPOS_DECL}\n#ifndef KR_ATMOS_UBO\nuniform vec4 uAtmJitter;\n#ifdef ATMOS_THIN\nuniform vec2 uAtmRes, uAtmThin;\n#endif\n#endif\n#include <fog_pars_vertex>`)
        .replace("#include <fog_vertex>", `#include <fog_vertex>
#ifdef ATM_OWN_VARYING
{ vec4 ap = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  ap = batchingMatrix * ap;
#endif
#ifdef USE_INSTANCING
  ap = instanceMatrix * ap;
#endif
  vAtmWorld = ( modelMatrix * ap ).xyz; }
#endif`);
      let fs = shader.fragmentShader
        // compat for custom code chained before us (water): directionalLights[0] → the atmos sun (a SunLight)
        .replace(/#if NUM_DIR_LIGHTS > 0(?=\s*\n[^\n]*directionalLights\[0\]\.color)/g, "#if ( NUM_DIR_LIGHTS > 0 || NUM_SUN_LIGHTS > 0 )")
        .replace(/directionalLights\[0\]\.color/g, "ATM_SUN_COLOR")
        .replace("#include <fog_pars_fragment>", `${WPOS_DECL}\n${SUN_COLOR_DECL}\n${ATMOS_PARS}\n#include <fog_pars_fragment>`)
        .replace("#include <opaque_fragment>", `#if defined( ATMOS_LIT ) && !defined( ATM_SUN_CLOUD )
  outgoingLight *= atmosCloudShadow( ATM_WPOS );
#endif
#if defined( ATMOS_LIT ) && ( NUM_SUN_LIGHTS > 0 || NUM_DIR_LIGHTS > 0 )
  if ( uAtmRimLight > 0.0 ) {
    // low-sun rim / backlight: silhouettes facing away from the camera toward the sun catch a warm edge
    vec3 atmSv = normalize( ( viewMatrix * vec4( uAtmSunDir, 0.0 ) ).xyz );
    vec3 atmV = normalize( vViewPosition );
    float atmRim = pow( 1.0 - clamp( dot( normal, atmV ), 0.0, 1.0 ), 3.0 ) * pow( clamp( dot( -atmV, atmSv ), 0.0, 1.0 ), 2.0 );
    outgoingLight += diffuseColor.rgb * uAtmSunColor * atmRim * uAtmRimLight * mix( 0.4, 1.0, atmSunVis );
  }
#endif
  // NaN / Inf never leave a patched material (a degenerate normal upstream otherwise becomes a bloom-sized black
  // square). Fallback = the surface's own albedo under a plausible sun + sky (the cove banana sculpture was
  // a solid black silhouette); exponent-bit test survives fast-math
  bool atmBad = any( equal( floatBitsToUint( outgoingLight ) & uvec3( 0x7f800000u ), uvec3( 0x7f800000u ) ) );
  vec3 atmAlb = any( equal( floatBitsToUint( diffuseColor.rgb ) & uvec3( 0x7f800000u ), uvec3( 0x7f800000u ) ) ) ? vec3( 0.5 ) : clamp( diffuseColor.rgb, 0.0, 1.0 );
  vec3 atmFallback = atmAlb * ( 0.5 + 0.8 * max( uAtmSunDir.y, 0.0 ) ) * vec3( 1.0, 0.97, 0.93 );
  if ( atmBad ) outgoingLight = atmFallback;
#ifdef ATMOS_VEGG
  outgoingLight = max( mix( vec3( dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) ) ), outgoingLight, uAtmVegGrade.w ), 0.0 ) * uAtmVegGrade.rgb;
#endif
#ifdef USE_FOG
  outgoingLight = atmosAerial( outgoingLight, ATM_WPOS );
#endif
  if ( any( equal( floatBitsToUint( outgoingLight ) & uvec3( 0x7f800000u ), uvec3( 0x7f800000u ) ) ) ) outgoingLight = atmFallback;
#include <opaque_fragment>`);
      if (lit) {
        // rain: wet materials — darker albedo, glossier (up-facing surfaces wettest)
        const WET_UP = `
#ifndef FLAT_SHADED
  float atmUp = ( normalize( vNormal ) * mat3( viewMatrix ) ).y;
#else
  float atmUp = 0.6;
#endif
  float atmWetK = uAtmWet * mix( 0.55, 1.0, smoothstep( 0.2, 0.85, atmUp ) );`;
        fs = fs.replace("#include <color_fragment>", `#include <color_fragment>
  if ( uAtmWet > 0.0 ) {
${WET_UP}
    diffuseColor.rgb *= 1.0 - 0.32 * atmWetK; }`);
        fs = fs.replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
  if ( uAtmWet > 0.0 ) {
${WET_UP}
    roughnessFactor = mix( roughnessFactor, min( roughnessFactor, 0.1 + 0.25 * ( 1.0 - atmUp ) ), atmWetK ); }`);
        fs = fs.replace("#include <shadowmap_pars_fragment>", `${SUN_VARY_OK ? SM_PARS_F : "#include <shadowmap_pars_fragment>"}\n${SSAO_DECL}\n${SUN_SHADOW_GLSL}`);
        if (SUN_VARY_OK) fs = fs.replace(/void\s+main\s*\(\s*\)\s*\{/, (m) => m + SUN_FROM_VIEW);
        // screen-space AO on THIS surface's light (indirect fully, direct by a share) — inside the material, so
        // translucent layers drawn over it are not darkened by it (a post-multiply's "ghost box")
        fs = fs.replace("#include <aomap_fragment>", `#include <aomap_fragment>
  if ( uAtmBounce > 0.0 ) {
    // warm multi-bounce (cream sand in shade went grey #92897a vs the target art's #86694c): the fill on a warm
    // albedo takes that albedo's chroma once more (albedo / luminance: luminance-neutral); cool / green / grey surfaces
    // are left alone (concrete stays neutral, foliage keeps its own ambient)
    vec3 atmAlb = clamp( diffuseColor.rgb, 0.0, 1.0 );
    float atmL = max( dot( atmAlb, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-3 );
    float atmWarm = smoothstep( 0.15, 0.6, ( atmAlb.r - atmAlb.b ) / atmL ) * smoothstep( -0.02, 0.06, ( atmAlb.r - atmAlb.g ) / atmL );
    reflectedLight.indirectDiffuse *= mix( vec3( 1.0 ), atmAlb / atmL, uAtmBounce * atmWarm );
  }
#ifdef ATMOS_SSAO
  {
    float atmAO = atmosSS3( ATM_WPOS ).x;
    // interiors — the sky fill falls off by the interior sky visibility (windows / doors only)
    // (the sky visibility near an opening reads as a light POOL — a bump at mid visibility (right inside a window / door),
    // falling to (1 − loss) deep in the room; continuous at 1 (outdoors) and 0)
    float atmInt = mix( 1.0 - uAtmGIParams.z, 1.0, atmGIv.a ) + 0.8 * atmGIv.a * ( 1.0 - atmGIv.a ) * uAtmGIParams.z;
    reflectedLight.indirectDiffuse *= atmAO * atmInt;
    reflectedLight.indirectSpecular *= atmAO * mix( 1.0, atmInt, 0.8 );
    float atmAOd = mix( 1.0, atmAO, uAtmAOParams.y );
    reflectedLight.directDiffuse *= atmAOd;
    reflectedLight.directSpecular *= atmAOd;
    // one-bounce COLOURED GI gathered from the neighbours' last-frame radiance (the concrete beside
    // a sunlit yellow container turns yellow, a sunlit window pool lights the room) — on this surface's diffuse albedo
    // (the receiver's albedo enters mostly by its LUMINANCE — a warm concrete × yellow paint went orange (hue 34°);
    // the stylised bounce carries the SENDER's hue: grey concrete by a yellow container reads yellow, hue 40–55°)
    // (only a near-grey receiver: a saturated one — a yellow container beside a red one — keeps its own albedo, else the
    // red bounce painted it pink)
    float atmRl = dot( material.diffuseColor, vec3( 0.2126, 0.7152, 0.0722 ) );
    float atmRs = ( max( material.diffuseColor.r, max( material.diffuseColor.g, material.diffuseColor.b ) ) - min( material.diffuseColor.r, min( material.diffuseColor.g, material.diffuseColor.b ) ) ) / max( max( material.diffuseColor.r, max( material.diffuseColor.g, material.diffuseColor.b ) ), 1e-4 );
    vec3 atmRecv = mix( material.diffuseColor, vec3( atmRl ), 0.65 * ( 1.0 - smoothstep( 0.15, 0.45, atmRs ) ) );
    reflectedLight.indirectDiffuse += atmRecv * atmGIv.rgb * uAtmGIParams.y * mix( 0.6, 1.0, atmAO );
  }
#endif`);
        // (under the jungle canopy the fill would keep its open-sky strength — a full-bright lime understory):
        // the indirect light (incl. fill terms other areas add after the AO) is scaled by the sky visibility of the
        // canopy map, right before it is summed
        // only the OUTDOOR ground cover takes it — vegetation (userData.veg) and the terrain (KR_TERRAIN): a tree crown
        // over a roof drew a soft dark blob on the interior walls below it (the Mango Market A/B)
        const SKYVIS = `#ifdef ATMOS_VEG
  reflectedLight.indirectDiffuse *= uAtmVegFill;
#endif
#if defined( ATMOS_SSAO ) && ( defined( ATMOS_SKYVIS ) || defined( KR_TERRAIN ) )
  {
    float atmSky = mix( 1.0, atmosSS3( ATM_WPOS ).z, uAtmSkyVis );
    reflectedLight.indirectDiffuse *= atmSky;
    reflectedLight.indirectSpecular *= atmSky;
  }
#endif
`;
        const at = fs.search(/vec3 totalDiffuse = reflectedLight|vec3 outgoingLight = reflectedLight/);
        if (at >= 0) fs = fs.slice(0, at) + SKYVIS + fs.slice(at);
      }
      shader.fragmentShader = (ubo ? ATMOS_UBO_DECL : "") + fs;
    };
    m.customProgramCacheKey = function () { return (hadKey ? prevKey.call(this) : prevHookSrc) + "|atmos21"; };
    m.needsUpdate = true;
  }
}
const protoHook = THREE.Material.prototype.onBeforeCompile;
const ATMOS_MARK = "// atmos-patched\n";
const EMPTY: THREE.Object3D[] = [];

/** objects whose cascade-1 membership was decided (small static casters are not re-measured every sweep) */
const c1Checked = new WeakSet<THREE.Object3D>();
/** cascade-1 casters: skinned (kongs), instanced / batched (their per-instance size is unknown), and plain meshes with a
 *  world radius ≥ 0.5 m; `userData.c1Shadow` true / false overrides */
function c1Caster(o: THREE.Object3D): boolean {
  if (o.userData.c1Shadow !== undefined) return !!o.userData.c1Shadow;
  if ((o as THREE.SkinnedMesh).isSkinnedMesh || (o as THREE.InstancedMesh).isInstancedMesh || (o as unknown as THREE.BatchedMesh).isBatchedMesh) return true;
  const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  if (!g) return false;
  const s = o.getWorldScale(_c);
  return geomRadius(g) * Math.max(s.x, s.y, s.z) >= 0.5;
}

/** subtrees that move or are camera-LOD'd: never bounded / culled as a unit */
const DYN_RE = /kong|player|bot-|fx|rocket|projectile|glider|plane|loot|chest|storm|viewmodel|held|particle/i;

/** world AABB of the casters in a subtree (bounding spheres of their geometry / instances) */
const _sph = new THREE.Sphere();
const _bs = new WeakMap<THREE.BufferGeometry, THREE.Sphere>();
function geomSphere(g: THREE.BufferGeometry): THREE.Sphere {
  if (g.boundingSphere && Number.isFinite(g.boundingSphere.radius)) return g.boundingSphere;
  let s = _bs.get(g);
  if (s) return s;
  const pa = g.getAttribute("position") as THREE.BufferAttribute | undefined;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  if (pa) {
    const step = Math.max(1, Math.floor(pa.count / 4096));
    for (let i = 0; i < pa.count; i += step) {
      const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
      if (!Number.isFinite(x + y + z)) continue;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z; if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
    }
  }
  s = x1 >= x0 ? new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0)) : new THREE.Sphere(new THREE.Vector3(), -1);
  _bs.set(g, s);
  return s;
}
function casterBox(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    if (!o.castShadow) return;
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const im = o as THREE.InstancedMesh & THREE.BatchedMesh;
    if (im.isInstancedMesh || im.isBatchedMesh) {
      if (!im.boundingSphere) { try { im.computeBoundingSphere(); } catch { /* NaN instances */ } }
      if (!im.boundingSphere || !Number.isFinite(im.boundingSphere.radius)) { box.makeEmpty(); box.expandByPoint(_c.set(-1e5, -1e5, -1e5)); box.expandByPoint(_c.set(1e5, 1e5, 1e5)); return; }
      _sph.copy(im.boundingSphere).applyMatrix4(o.matrixWorld);
    } else {
      const s = geomSphere(m.geometry);
      if (s.radius < 0) return;
      _sph.copy(s).applyMatrix4(o.matrixWorld);
    }
    if (!Number.isFinite(_sph.radius)) return;
    box.expandByPoint(_c.copy(_sph.center).subScalar(_sph.radius));
    box.expandByPoint(_c.copy(_sph.center).addScalar(_sph.radius));
  });
  return box;
}

/** bounding radius without three's computeBoundingSphere (it console.errors on NaN positions some POI meshes carry) */
const _radii = new WeakMap<THREE.BufferGeometry, number>();
function geomRadius(g: THREE.BufferGeometry): number {
  if (g.boundingSphere && Number.isFinite(g.boundingSphere.radius)) return g.boundingSphere.radius;
  let r = _radii.get(g);
  if (r !== undefined) return r;
  const pa = g.getAttribute("position") as THREE.BufferAttribute | undefined;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  if (pa) {
    const step = Math.max(1, Math.floor(pa.count / 4096));
    for (let i = 0; i < pa.count; i += step) {
      const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
      if (!Number.isFinite(x + y + z)) continue;
      if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z; if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
    }
  }
  r = x1 >= x0 ? 0.5 * Math.hypot(x1 - x0, y1 - y0, z1 - z0) : 0;
  _radii.set(g, r);
  return r;
}

/** shadow render target: R8 colour (written by the depth pass, never read) + a compare-mode depth texture */
function makeShadowTarget(w: number, h: number, depthType: THREE.TextureDataType, name: string) {
  const rt = new THREE.WebGLRenderTarget(w, h, { format: THREE.RedFormat, type: THREE.UnsignedByteType, generateMipmaps: false, depthBuffer: true });
  const d = new THREE.DepthTexture(w, h, depthType);
  d.format = THREE.DepthFormat;
  d.compareFunction = THREE.LessEqualCompare;
  d.minFilter = THREE.LinearFilter; d.magFilter = THREE.LinearFilter;
  d.name = name + ".shadowMap";
  rt.depthTexture = d;
  rt.texture.name = name + ".color";
  return rt;
}

/** land bounding box (terrain above −2 m) + headroom for trees/cranes */
function landBounds(t: Terrain): THREE.Box3 {
  const H = t.half, N = 96;
  const b = new THREE.Box3();
  let maxY = 0;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const x = -H + (2 * H * i) / N, z = -H + (2 * H * j) / N;
    const y = t.height(x, z);
    if (y > -2) { b.expandByPoint(_c.set(x, y, z)); maxY = Math.max(maxY, y); }
  }
  if (b.isEmpty()) return new THREE.Box3(new THREE.Vector3(-H, -10, -H), new THREE.Vector3(H, 400, H));
  b.expandByVector(new THREE.Vector3(60, 0, 60));
  b.min.y = -12; b.max.y = maxY + 60;
  return b;
}
