// One material recipe for every plant part: MeshStandardMaterial patched with
//   • wind in the vertex shader: trunk sway (height²), branch/frond bob (aBend, low frequency) and leaf flutter
//   • optional camera-facing leaf-cluster cards (VEG_BILLBOARD): canopies are "big sculpted leaf clumps" from every
//     angle (and face the sun in the shadow pass, so the canopy casts dense puffy shadows)
//   • foliage lighting (RE_Direct_Veg, replaces the physical direct term — inherits the CSM cascade shadow): wrapped
//     diffuse for thin leaves, back-lit translucency (lime glow), glossy spec; plus a GI-like tinted fill in shade
//   • mip-aware alpha (coverage kept at distance: leaves don't thin out / shimmer away)
//   • LOD transitions (no 28 m dithered bands): a per-INSTANCE time crossfade (aLodFade = switch time
//     + direction, written by lod.ts when an instance crosses its LOD distance with hysteresis): the incoming and the
//     outgoing tier dissolve into each other over VEG_FADE_T s through complementary dither masks, then nothing is
//     dithered at rest. Detail plants (grass, ferns …) never dither: each one SHRINKS into the ground at its own
//     distance (uFade = [start, end] of the thinning band; the rank encoded in instanceColor.b picks the distance)
//   • per-instance tint (instanceColor) and vertex-colour AO
// All materials share ONE uniform set (`VEG_UNIFORMS`) that the veg module updates per frame.
import * as THREE from "three";
import { flag } from "../../flags";

export const VEG_UNIFORMS = {
  uTime: { value: 12 },
  /** x,z = wind direction (world), y = strength 0..1 */
  uWind: { value: new THREE.Vector3(0.8, 0.55, 0.6) },
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.5) },
  uCamPos: { value: new THREE.Vector3() },
  /** global foliage grade (tunable live via __kr.veg.grade): x = shade fill mult, y = translucency mult, z = saturation */
  // (measured against the target art: its foliage shade is much darker and the greens more saturated and
  // yellower than ours were — shade fill 0.62, full saturation, a yellow push in F_GRADE)
  uGrade: { value: new THREE.Vector3(0.62, 0.7, 1.0) },
  /** warm sun tint (direct light) and cool shade tint (GI fill) — the target art's warm-sun / blue-green-shade split */
  uSunTint: { value: new THREE.Vector3(1.06, 1.0, 0.86) },
  uShadeTint: { value: new THREE.Vector3(0.84, 1.0, 1.12) },
  /** LOD crossfade clock (s, same clock as lod.ts SpeciesPool.update's `now`) */
  uFadeNow: { value: 0 },
  /** post-lighting saturation boost of leaves under a closed canopy (× the canopy occlusion) — the target art's
   * jungle greens measure S p50 .93 (deep, nearly pure greens); the lit result (sky fill + sheen) came out ~.80 */
  uPostSat: { value: 0.3 },
  /** the terrain's linear albedo bake (ctx.shared "terrainAlbedoMap", top-down over the island; veg/index.ts sets it):
   *  rootFade blades blend into the real ground colour under them */
  uTerrainAlbedo: { value: null as THREE.Texture | null },
  uTerrainAlbedoOn: { value: 0 },
  /** atmos' uAtmTemporal mirrored by the veg update: x = TAA on (1 moving, 2 still), y = frame number
   *  — with TAA the impostor view crossfade dither changes every frame and the TAA history averages it into a blend */
  uVegTemporal: { value: new THREE.Vector2(0, 0) },
  /** the LOD1 trees' sun-shadow (cascade) casting dissolves over this distance band (m) instead of a
   *  hard per-tree cut at 56 m (lod.ts SHADOW1_D) — dithered shadow-map texels, which the PCF filter averages into a
   *  soft fade; the static far map (the splat / impostor copy) carries the shadow beyond. y = 0: off */
  uVegShadowBand: { value: new THREE.Vector2(42, 58) },
};

/** the tier crossfade lasts 0.45 s and its dither moves every frame under TAA (a real
 *  blend instead of a fixed screen-door pattern sweeping over the plant). ?vegxfade=0 = the old crossfade (A/B) */
export const VEG_XFADE = flag("vegxfade");
/** LOD crossfade duration (s) — lod.ts keeps both tiers in the buffers this long after a switch */
export const VEG_FADE_T = VEG_XFADE ? 0.45 : 0.28;

/**
 * Sun radiance + the scene IBL's diffuse response for up / side / down normals — measured once from a white Standard
 * material (impostor.ts calibrateImpostorLight). Leaves take their ambient from this hemisphere (with a green canopy /
 * ground bounce below) instead of the IBL cube: shaded undersides read green, not sky-grey, and it is one fetch less.
 */
export const VEG_LIGHT = {
  uSunCol: { value: new THREE.Color(3, 2.9, 2.7) },
  uAmbUp: { value: new THREE.Color(0.55, 0.65, 0.8) },
  uAmbSide: { value: new THREE.Color(0.42, 0.48, 0.55) },
  uAmbDown: { value: new THREE.Color(0.22, 0.24, 0.2) },
};

export interface FoliageOpts {
  map?: THREE.Texture;
  normalMap?: THREE.Texture;
  normalScale?: number;
  color?: THREE.ColorRepresentation;
  roughness?: number;
  metalness?: number;
  alphaTest?: number;
  doubleSide?: boolean;
  /** translucency amount 0..1 and colour (lime) */
  translucency?: number;
  transColor?: THREE.ColorRepresentation;
  /** GI-like ambient fill (fraction of albedo added in shade). Default 0.3 for leaves, 0.1 for bark. */
  fill?: number;
  /** wrap lighting 0 (lambert) .. 1 (fully wrapped) */
  wrap?: number;
  /** species natural height (m) for the height² sway weight */
  height?: number;
  /** trunk sway amplitude (m at the top, at wind 1) */
  sway?: number;
  /** branch / frond bob amplitude (m at aBend 1) — slow */
  bob?: number;
  /** flutter amplitude (m at aBend 1, wind 1) — fast */
  flutter?: number;
  /** distance fade: [start, end]; visible when nearer than start, gone past end (dithered). */
  fadeFar?: [number, number];
  /** distance fade-in: visible only beyond end (dithered) — impostors */
  fadeNear?: [number, number];
  envMapIntensity?: number;
  /** camera-facing cards (needs the aCard attribute: xyz = card centre, w = card size) */
  billboard?: number;
  /** per-card spherical normal bend for billboards (0..1) */
  puff?: number;
  /** billboard card roll range (radians, centred): 2π (default) = any roll; small for textures with baked top light
   * (the canopy masses — a rolled card would light its bumps from the side or below) */
  cardRot?: number;
  /** alpha boost per mip level (keeps coverage at distance) */
  alphaMip?: number;
  /** the map is two cards side by side; the per-vertex aAtlas (0 / 1) picks the half */
  atlas2?: boolean;
  /** no specular at all (grass / ground cover: millions of tiny fragments — the GGX + sky reflection are invisible) */
  matte?: boolean;
  /** detail thinning: the survivors grow this much wider (0..1 of the coverage-preserving factor) — lawn */
  widen?: number;
  /** 0..1: how much of the sun a shadowed fragment gets back (crowns self-shadowing into a dark mass) */
  shadowLift?: number;
  /** two-sided sun response for thin blades (palm fronds): the back face takes 72 % of the front's diffuse */
  twoSide?: boolean;
  /** no depth write, drawn after the opaque world far → near (lawn tufts: the screen-space AO must not see them — it
   * drew a dark ring around every 25 cm tuft, a cellular web over the whole meadow) */
  noDepth?: boolean;
  /** the lowest `rootFade` m of every blade dissolves into the ground (per-blade-column jittered cut, no straight
   * card edge); its colour runs from `rootTint` × albedo at the root (the terrain lawn's colour) to the full albedo */
  rootFade?: number;
  rootTint?: [number, number, number];
  /** multiplier on the sun glint + the sky sheen (default 1) */
  specK?: number;
  /** albedo saturation multiplier for non-leaf parts (bark: the target art's jungle trunks are grey-brown) */
  sat?: number;
  /** 3D crowns: both faces of a card keep the geometry's normal (volumetric clump normals shared by the
   * leaf cards and the clump hull) — three's DOUBLE_SIDED flip would light every back-facing card from the wrong side */
  noFlip?: boolean;
  /** 3D crowns: clump HULL fragments (aAtlas = 1) dissolve toward the silhouette (view angle × the leaf
   * texture's value) — the hull's polygon outline never shows; the leaf cards carry the crown's silhouette */
  hullFade?: boolean;
  /** banana leaves: strength of the dry-margin colour ramp — yellow → brown along the leaf's margins,
   * torn slits and tip, per leaf / per plant (F_SENESCE); 0 / unset = off (compiled out) */
  senesce?: number;
}

export interface FoliageMaterials { mat: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial }

/**
 * Dry leaf margins (banana). Per PLANT a dryness 0..1 hashed from its instance tint (detail-gen Tinter:
 * the splat / impostor bank receives the same three floats, so a far plant knows its own dryness too); most plants are
 * fresh (h^1.5, mean 0.4). Per LEAF a stage 0..1 from the leaf's age (encoded by understory.ts in the vertex colour's blue/red
 * ratio: 0.97 → 0.91 = youngest → oldest), its random phase (aPhase, one per leaf) and the plant's dryness.
 * The bake (impostor / splat capture) uses the mean plant (VEG_DRY_REF); splat.ts shifts each far plant by its offset.
 */
/** bump when F_SENESCE / vegDryStage change: it is part of the splat-cache key of the species that use it */
export const VEG_DRY_V = 1;
export const VEG_DRY_GLSL = /* glsl */ `
#define VEG_DRY_REF 0.4
float vegPlantDry( vec3 t ) { float h = fract( dot( t, vec3( 7.13, 3.71, 11.37 ) ) ); return h * sqrt( h ); }
`;
const V_DRY = /* glsl */ `
#ifdef VEG_SENESCE
uniform float uDry;
varying vec2 vVegDry;
${VEG_DRY_GLSL}
vec2 vegDryStage( float d, vec3 vc, float ph ) {
  float age = clamp( ( 0.97 - vc.b / max( vc.r, 1e-3 ) ) / 0.06, 0.0, 1.0 );
  float lr = fract( ph * 4.32 + d * 3.1 );
  float x = 0.45 * age + 0.4 * d + 0.45 * lr;
  return vec2( clamp( ( x - 0.5 ) * 1.7, 0.0, 1.0 ) * uDry, fract( ph * 2.71 ) );
}
#endif
`;

const V_PARS = /* glsl */ `
// the depth pre-pass and the EQUAL colour pass (prepassMaterial / equalMaterial) are different programs that must
// produce bit-identical depths
invariant gl_Position;
attribute float aBend;
attribute float aPhase;
// merged variant geometry (lod.ts PartGroup): the variant slot of this vertex; an instance draws only its own slot
// (instanceColor.g carries 16 · slot)
attribute float aVar;
#ifdef VEG_ATLAS2
attribute float aAtlas;
#endif
#ifdef VEG_HULLFADE
varying float vVegHull;
#endif
#ifdef VEG_BILLBOARD
attribute vec4 aCard;
uniform float uBillboard;
uniform float uPuff;
uniform float uCardRot;
#endif
uniform float uTime;
uniform vec3 uWind;
uniform vec3 uCamPos;
uniform float uHeight;
uniform float uSway;
uniform float uBob;
uniform float uFlutter;
uniform float uFadeNow;
uniform vec4 uFade;
uniform float uWiden;
varying float vDist;
varying float vTF;
varying float vDetailCoverage;
varying vec2 vDetailUv;
#ifdef VEG_ROOTFADE
varying float vVegRootH;
varying vec2 vVegRootUV;
#endif
#ifdef USE_INSTANCING
// x = switch time (s, uFadeNow clock), y = 0 settled visible | +1 fading in | −1 fading out (lod.ts)
attribute vec2 aLodFade;
#endif
// detail thinning rank 0..1 (decoded from instanceColor.b in the colour chunk; 0 = not a detail instance)
float vegThr = 0.0;
${V_DRY}
// canopy ambient occlusion 0..0.7 (decoded from instanceColor.r — detail-gen.ts CanopyGrid)
varying float vOcc;
vec3 vegWind( vec3 p, float bendW, float phase, vec3 iPos, mat3 iRot ) {
  float ph = dot( iPos, vec3( 0.071, 0.0, 0.053 ) );
  float hN = clamp( p.y / max( uHeight, 0.01 ), 0.0, 1.2 );
  float t = uTime;
  float gust = sin( t * 0.93 + ph ) * 0.45 + sin( t * 1.71 + ph * 1.7 + 1.3 ) * 0.25 + sin( t * 0.31 + ph * 0.3 ) * 0.3 + 0.4;
  vec3 windW = vec3( uWind.x, 0.0, uWind.z );
  vec3 windO = transpose( iRot ) * windW;
  vec3 side = vec3( -windO.z, 0.0, windO.x );
  vec3 d = windO * ( hN * hN * uSway * uWind.y * gust );
  d += side * ( hN * hN * uSway * 0.35 * uWind.y * sin( t * 1.3 + ph * 2.1 ) );
  // branch / frond bob: slow, mostly vertical + along the wind, grows with aBend
  float bt = t * 1.9 + ph + phase;
  d += ( vec3( 0.0, sin( bt ) * 0.8, 0.0 ) + windO * ( 0.6 + 0.4 * sin( bt * 0.7 + 1.1 ) ) ) * ( bendW * uBob * ( 0.4 + 0.6 * uWind.y ) );
  // flutter: fast, small, per leaf phase
  float ft = t * 6.3 + ph * 3.0 + phase * 7.0;
  d += vec3( sin( ft * 1.13 ), cos( ft * 1.37 ) * 0.7, sin( ft * 0.91 + 2.0 ) ) * ( bendW * uFlutter * ( 0.3 + 0.7 * uWind.y ) );
  return d;
}
`;

// instanceColor.b carries 8·q on top of the tint (q = 1..31: the detail instance's thinning rank, detail-gen.ts)
const V_COLOR = /* glsl */ `
vOcc = 0.0;
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) || defined( USE_INSTANCING_COLOR )
  vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR
  vColor.rgb *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  {
    vec3 ic = instanceColor.rgb;
    float q = floor( ic.b / 8.0 );
    ic.b -= q * 8.0;
    vegThr = q > 0.0 ? q / 31.0 : 0.0;
    float qo = floor( ic.r / 8.0 );
    ic.r -= qo * 8.0;
    // green carries the per-instance atlas-half flag (8 · k, V_ATLAS) — strip it from the tint
    ic.g -= floor( ic.g / 8.0 ) * 8.0;
    vOcc = qo > 0.0 ? ( qo - 1.0 ) / 30.0 * 0.7 : 0.0;
    vColor.rgb *= ic;
    #ifdef VEG_SENESCE
      vVegDry = vegDryStage( vegPlantDry( ic ), color, aPhase );
    #endif
  }
#elif defined( VEG_SENESCE )
  vVegDry = vegDryStage( VEG_DRY_REF, color, aPhase );
#endif
`;

// two-card atlas (canopy sprays | dense clump): the billboard maths keeps uv in 0..1, only the texture lookup moves.
// The half is aAtlas (per vertex) XOR the instance's flag (instanceColor.g ≥ 8: detail variants that share one pool
// and one draw — lawn plain / with daisies, jungle grass A / B — detail-gen.ts DETAIL_ALIAS)
const V_ATLAS = /* glsl */ `
#if defined( VEG_ATLAS2 ) && defined( USE_MAP )
  {
    float vegIA = 0.0;
    #ifdef USE_INSTANCING_COLOR
      vegIA = floor( instanceColor.g / 8.0 );
    #endif
    vMapUv = vMapUv * vec2( 0.5, 1.0 ) + vec2( mod( aAtlas + vegIA, 2.0 ) * 0.5, 0.0 );
  }
#endif
#ifdef VEG_HULLFADE
  vVegHull = aAtlas;
#endif
`;

const V_WIND = /* glsl */ `
#ifdef USE_INSTANCING_COLOR
  // (draw merging, lod.ts PartGroup: the vertices of the OTHER variants of a merged geometry leave right here —
  // no wind / billboard / lighting maths; their triangles are degenerate and culled before rasterisation)
  if ( abs( aVar - floor( instanceColor.g / 16.0 ) ) > 0.5 ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); return; }
#endif
#ifdef USE_INSTANCING
  vec3 vegIPos = instanceMatrix[3].xyz;
  mat3 vegIRot = mat3( instanceMatrix );
  float vegIScale = length( vegIRot[0] );
  vegIRot = vegIRot / max( vegIScale, 1e-4 );
#else
  vec3 vegIPos = vec3( 0.0 );
  mat3 vegIRot = mat3( 1.0 );
  float vegIScale = 1.0;
#endif
#ifdef VEG_ROOTFADE
  vVegRootH = position.y;
  // the plant's root on the terrain albedo bake (u = east, v = north over the island's 2 × 1200 m)
  vec3 rootWorld = ( modelMatrix * vec4( vegIPos, 1.0 ) ).xyz;
  vVegRootUV = vec2( rootWorld.x, -rootWorld.z ) / 2400.0 + 0.5;
#endif
#ifdef VEG_BILLBOARD
  vec3 vegWindC = vegWind( aCard.xyz, aBend, aPhase, vegIPos, vegIRot );
  transformed += vegWindC;
#else
  transformed += vegWind( position, aBend, aPhase, vegIPos, vegIRot );
#endif
  vDetailCoverage = 1.0;
  vDetailUv = uv;
#ifdef USE_INSTANCING
  // distance thinning and streaming fade the plant's TEXEL COVERAGE (a stable texture-space dither, F_FADE) — its
  // authored size and shape stay (it used to shrink into the ground, and the lawn's survivors widened). Detail pools
  // carry aLodFade = (−1 sentinel, streamed-in fraction) — lod.ts pushBlock; big plants carry their tier clock there.
  vDetailCoverage = aLodFade.x == -1.0 ? aLodFade.y : 1.0;
  if ( uFade.y > 0.0 ) {
    float vegDc = distance( vegIPos, uCamPos );
    // every plant fades in / out over vegW >= 10 m ending at its own rank's distance; the ranks spread over the rest
    // of the band (lod.ts VEG_DETAIL_W — the CPU keeps exactly the ranks whose band has not ended)
    float vegW = max( 10.0, ( uFade.y - uFade.x ) * 0.3 );
    float vegSpan = max( uFade.y - uFade.x - vegW, 0.0 );
    float vegD = uFade.y - vegSpan * vegThr;
    vDetailCoverage *= 1.0 - smoothstep( vegD - vegW, vegD, vegDc );
  }
#endif
`;

// after project_vertex: pull billboard cards toward camera-facing, recompute gl_Position
const V_BILLBOARD = /* glsl */ `
vec2 vegO = vec2( 0.0 );
float vegCardS = 1.0;
#ifdef VEG_BILLBOARD
{
  vec4 vegC = vec4( aCard.xyz + vegWindC, 1.0 );
  #ifdef USE_INSTANCING
    vegC = instanceMatrix * vegC;
  #endif
  vegC = modelViewMatrix * vegC;
  float r = uCardRot > 6.0 ? aPhase * 6.2831 : ( fract( aPhase * 3.7 ) - 0.5 ) * uCardRot;
  vec2 o = ( uv - 0.5 ) * aCard.w * vegIScale;
  #ifdef VEG_DEPTH
    // shadow pass: 40 % of the cards, shrunk, so sun dapples get through the gaps (and the 2 cm near cascade is not
    // filled six layers deep by every canopy between the camera and the sun)
    o *= fract( aPhase * 7.31 ) < 0.6 ? 0.0 : 0.88;
  #endif
  o = vec2( o.x * cos( r ) - o.y * sin( r ), o.x * sin( r ) + o.y * cos( r ) );
  vec4 bb = vegC + vec4( o, 0.0, 0.0 );
  vegO = o; vegCardS = max( aCard.w * vegIScale, 1e-3 );
  mvPosition = mix( mvPosition, bb, uBillboard );
  gl_Position = projectionMatrix * mvPosition;
  #ifdef VEG_DEPTH
    if ( aPhase >= 2.0 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );   // dark core plug cards never cast
  #endif
  #if !defined( VEG_DEPTH ) && !defined( VEG_BAKE ) && !defined( VEG_PRE )
    vNormal = normalize( vNormal + vec3( o / max( aCard.w * vegIScale, 1e-3 ), 0.0 ) * uPuff * 1.6 );
  #endif
}
#endif
{
  vec4 vegW = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    vegW = instanceMatrix * vegW;
  #endif
  vDist = distance( ( modelMatrix * vegW ).xyz, uCamPos );
}
// LOD crossfade: visible fraction (signed: < 0 = the outgoing tier, it takes the complementary dither mask); a fully
// faded instance is collapsed off-screen (no raster at all)
vTF = 1.0;
#ifdef USE_INSTANCING
if ( aLodFade.x != -1.0 && aLodFade.y != 0.0 ) {   // (x = −1: a detail pool's coverage, not a tier clock)
  float k = clamp( ( uFadeNow - aLodFade.x ) / VEG_FADE_T, 0.0, 1.0 );
  vTF = aLodFade.y > 0.0 ? k : -( 1.0 - k );
  if ( abs( vTF ) <= 0.0 ) gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
}
#endif
#ifdef VEG_BAKE
  vBakeN = normalize( mat3( modelMatrix ) * normal );
  #ifdef VEG_BILLBOARD
    vBakeN = normalize( vBakeN + ( vec4( vegO / vegCardS, 0.0, 0.0 ) * viewMatrix ).xyz * uPuff * 1.6 );
  #endif
#endif
`;

const F_PARS = /* glsl */ `
#define VEG_TDITHER ${VEG_XFADE ? "1.0" : "0.0"}
uniform vec3 uSunDir;
uniform float uVegLite;
uniform float uTrans;
uniform float uShadowLift;
uniform float uSpecK;
uniform float uFill;
uniform float uWrap;
uniform float uAlphaMip;
uniform vec3 uTransColor;
uniform vec3 uGrade;
uniform vec3 uSunTint;
uniform vec3 uShadeTint;
uniform vec4 uFade;   // x,y = detail coverage band start/end (0 = off)
uniform float uPostSat;
uniform float uSat;
uniform vec2 uVegShadowBand;
#ifdef VEG_ROOTFADE
varying float vVegRootH;
varying vec2 vVegRootUV;
uniform sampler2D uTerrainAlbedo;
uniform float uTerrainAlbedoOn;
uniform float uRootFade;
uniform vec3 uRootTint;
#endif
uniform vec3 uAmbUp, uAmbSide, uAmbDown;
#ifdef VEG_SENESCE
varying vec2 vVegDry;
#endif
varying float vDist;
varying float vTF;
varying float vDetailCoverage;
varying vec2 vDetailUv;
varying float vOcc;
// the sun's colour BEFORE its shadow (set in the sun loop): translucency is not killed by the leaf's own shadow
vec3 vegSunRaw = vec3( 0.0 );
vec3 vegHemiIrradiance( vec3 nV ) {
  vec3 n = inverseTransformDirection( nV, viewMatrix );
  vec3 below = uAmbDown * vec3( 0.75, 1.0, 0.5 ) + uAmbSide * vec3( 0.1, 0.18, 0.04 );   // green canopy / ground bounce
  vec3 a = n.y > 0.0 ? mix( uAmbSide, uAmbUp, n.y ) : mix( uAmbSide * vec3( 0.88, 1.0, 0.82 ), below, -n.y );
  return PI * a * 0.8;
}
uniform vec2 uVegTemporal;
// the crossfade dither: interleaved gradient noise; under TAA it moves every frame (5.588238 px /
// frame) so the history turns the two tiers' complementary masks into a real blend instead of a fixed screen-door
// pattern sweeping over the plant; without TAA (Low: FXAA) it stays still
float vegDither() {
  vec2 p = gl_FragCoord.xy + ( VEG_TDITHER > 0.5 && uVegTemporal.x > 0.5 ? 5.588238 * mod( uVegTemporal.y, 64.0 ) : 0.0 );
  return fract( 52.9829189 * fract( 0.06711056 * p.x + 0.00583715 * p.y ) );
}
float vegMipAlpha( sampler2D tex, vec2 uv, float a ) {
  vec2 ts = vec2( textureSize( tex, 0 ) );
  vec2 dx = dFdx( uv * ts ), dy = dFdy( uv * ts );
  float lod = 0.5 * log2( max( max( dot( dx, dx ), dot( dy, dy ) ), 1e-8 ) );
  return a * ( 1.0 + max( lod, 0.0 ) * uAlphaMip );
}
`;

const F_HULL = /* glsl */ `
#if defined( VEG_HULLFADE ) && defined( USE_MAP )
if ( vVegHull > 0.5 ) {
  float vegNv = abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) );
  float vegLum = dot( sampledDiffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) );
  diffuseColor.a *= smoothstep( 0.1, 0.45, vegNv + ( vegLum - 0.28 ) * 0.9 );
} else {
  // leaf cards seen edge-on (their geometric normal ⟂ the view) thin out instead of drawing as sticks
  vec3 vegGn = normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) );
  diffuseColor.a *= smoothstep( 0.04, 0.3, abs( dot( vegGn, normalize( vViewPosition ) ) ) );
}
#endif
`;

const F_MAP = /* glsl */ `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv );
  #ifndef VEG_DEPTH
    sampledDiffuseColor.a = vegMipAlpha( map, vMapUv, sampledDiffuseColor.a );
  #endif
  diffuseColor *= sampledDiffuseColor;
#endif
`;

// blades dissolve into the ground over their lowest uRootFade m — the cut height jitters per blade column (two
// octaves of column noise on the texture's u), so no straight card edge ever meets the terrain; the albedo runs from
// the ground's colour at the root to the full blade colour
const F_ROOT = /* glsl */ `
#ifdef VEG_ROOTFADE
{
  float c1 = fract( sin( floor( vMapUv.x * 96.0 ) * 12.9898 + 3.1 ) * 43758.5453 );
  float c2 = fract( sin( floor( vMapUv.x * 29.0 ) * 78.233 + 1.7 ) * 43758.5453 );
  float cut = uRootFade * ( 0.3 + 0.7 * ( 0.65 * c1 + 0.35 * c2 ) );
  diffuseColor.a *= smoothstep( cut * 0.55, cut, vVegRootH );
  diffuseColor.rgb *= mix( uRootTint, vec3( 1.0 ), smoothstep( 0.0, uRootFade * 2.4, vVegRootH ) );
  // the terrain publishes a linear albedo bake: the real splat colour under the plant blends into its lowest blades only
  if ( uTerrainAlbedoOn > 0.5 ) {
    vec3 ground = texture2D( uTerrainAlbedo, vVegRootUV ).rgb;
    diffuseColor.rgb = mix( diffuseColor.rgb, ground, 0.78 * ( 1.0 - smoothstep( 0.0, 0.32, vVegRootH ) ) );
  }
}
#endif
`;

// the dry-margin ramp (banana leaves): yellow → brown along the margins, the torn slits and the tip.
// The margin distance is the leaf map's own alpha at a coarse mip (one fetch from a 32×64 level of the already-bound map:
// the blurred outline drops below 1 near every edge AND every tear); the tip is the ribbon's v (base 0 → tip 1). The
// band widens with the leaf's stage; a per-leaf wobble along the leaf breaks the front; fresh leaves skip it all.
// (VEG_NODRY: bench hook — set it in material.defines to time the ramp in-page, same frame)
const F_SENESCE = /* glsl */ `
#if defined( VEG_SENESCE ) && defined( USE_MAP ) && !defined( VEG_NODRY )
if ( vVegDry.x > 0.002 ) {
  float s = vVegDry.x;
  float eA = textureLod( map, vMapUv, 4.2 ).a;
  float wob = sin( vMapUv.y * 23.0 + vVegDry.y * 6.283 ) * 0.6 + sin( vMapUv.y * 61.0 + vVegDry.y * 19.0 ) * 0.4;
  float lum = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
  // (the torn slits run in toward the midrib: only their outer ends dry — the margin weight fades toward the middle)
  float edge = ( 1.0 - smoothstep( 0.4, 0.74 + 0.24 * s + 0.06 * wob, eA ) ) * ( 0.6 + 0.6 * s ) * smoothstep( 0.06, 0.26 - 0.08 * s, abs( vMapUv.x - 0.5 ) );
  // (smoothstep needs edge0 < edge1: the tip window is built from its width, never inverted)
  float tw = 0.12 * s + 0.2 * s * s + 0.002, t0 = 1.0 - tw * ( 1.0 + 0.15 * wob );
  float tip = smoothstep( t0, t0 + 0.7 * tw, vMapUv.y );
  float m = clamp( max( edge, tip ) * ( 0.9 + 0.12 * wob ), 0.0, 1.0 );
  // ramp: fresh green → warm straw yellow (a short olive transition) → tan-brown only at the driest edges / tips
  vec3 c = mix( diffuseColor.rgb, lum * vec3( 1.78, 1.42, 0.26 ), smoothstep( 0.18, 0.45, m ) );
  diffuseColor.rgb = mix( c, lum * vec3( 1.3, 0.8, 0.32 ), smoothstep( 0.72, 0.98, m ) * smoothstep( 0.45, 0.85, s ) );
}
#endif
`;

const F_FADE = /* glsl */ `
#ifndef VEG_NOFADE
{
  // detail coverage (V_WIND): a fixed texture-space pattern that travels with the plant — no frame / screen noise
  if ( vDetailCoverage < 1.0 ) {
    vec2 cell = floor( vDetailUv * 64.0 );
    float rank = fract( 52.9829189 * fract( dot( cell, vec2( 0.06711056, 0.00583715 ) ) ) );
    if ( vDetailCoverage <= rank ) discard;
  }
  // LOD crossfade (only during the VEG_FADE_T s after a switch): incoming keeps the pixels where d < k, outgoing where
  // d > k — the two tiers partition the screen exactly (no double coverage, no holes)
  float a = abs( vTF );
  if ( a < 1.0 ) { float d = vegDither(); if ( vTF < 0.0 ) d = 1.0 - d; if ( a <= d ) discard; }
}
#endif
#ifdef VEG_CHEAP
  gl_FragColor = vec4( diffuseColor.rgb, 1.0 ); return;   // perf probe only: unlit
#endif
#ifdef VEG_OD
  gl_FragColor = vec4( vec3( 1.0 / 64.0 ), 1.0 ); return; // overdraw probe only: additive count
#endif
`;

// shadow casting dissolves with the distance to the camera (uVegShadowBand), shadow-map pass only
const F_SHADOWBAND = /* glsl */ `
#if defined( VEG_DEPTH ) && defined( USE_INSTANCING )
if ( uVegShadowBand.y > 0.0 && vDist > uVegShadowBand.x ) {
  float vegSk = 1.0 - smoothstep( uVegShadowBand.x, uVegShadowBand.y, vDist );
  if ( fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) >= vegSk ) discard;
}
#endif
`;

// replaces the physical direct term for foliage (called per light by three's loop AND by the CSM cascade loop, with
// directLight.color already shadowed)
const F_DIRECT = /* glsl */ `
void RE_Direct_Veg( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  float nl = dot( geometryNormal, directLight.direction );
  #ifdef VEG_TWOSIDE
    // thin sunlit blades (palm fronds): the face turned away from the sun still glows — the target art's crowns read
    // bright lime from below too, never a dark comb against the sky
    nl = max( nl, -nl * 0.72 );
  #elif defined( VEG_LEAF ) && !defined( VEG_BB_FRAG )
    // a broad thin leaf seen from its shaded side keeps ~42 % of the
    // sun its lit face takes (light through the blade) — never a black paddle (not on the canopy mass cards: their
    // shade side is the crown's deep shade)
    nl = max( nl, -nl * 0.42 );
  #endif
  float w = uWrap;
  float diff = max( ( nl + w ) / ( ( 1.0 + w ) * ( 1.0 + w ) ), 0.0 );
  // (a crown's own leaves shadow each other into a dark mass at the cascade's resolution — the target art's palm
  // crowns read sunlit lime throughout: uShadowLift gives the shadowed part of a crown back that much of the sun)
  vec3 vegSunC = mix( directLight.color, max( directLight.color, vegSunRaw ), uShadowLift );
  vec3 irradiance = diff * vegSunC * uSunTint;
  reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseContribution );
  // translucency: light through the leaf toward the viewer (back-lit glow) + a little diffuse transmission
  float back = pow( saturate( dot( geometryViewDir, -directLight.direction ) ), 3.0 );
  float thru = saturate( -nl );
  vec3 tc = uTransColor * material.diffuseContribution * 2.2;
  // a leaf is always in its OWN shadow on the far side: light the glow half from the unshadowed sun
  vec3 tl = max( directLight.color, vegSunRaw * 0.35 );
  reflectedLight.directDiffuse += tl * tc * uTrans * uGrade.y * ( back * 0.9 + thru * 0.35 );
  // glossy leaf spec (front side only). Leaf-cluster cards carry fake puffed normals: a full GGX lobe on them paints
  // whole cards sun-white, so they keep only a trace of it
  #ifndef VEG_MATTE
  if ( uVegLite == 0.0 ) {
    vec3 irr2 = saturate( nl ) * directLight.color * uSpecK;
    #ifdef VEG_BB_FRAG
      irr2 *= 0.18;
    #endif
    reflectedLight.directSpecular += irr2 * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material ) * material.multiScatteringCompensation;
  }
  #endif
}
#undef RE_Direct
#define RE_Direct RE_Direct_Veg
`;

const F_FILL = /* glsl */ `
{
  // under a closed canopy the sky and the bounce are mostly blocked: ambient + reflections drop, the sun keeps its dapples
  // (trunks / stems keep half of it — the target art's jungle trunks read mid grey-brown in the shade (~#806040),
  // ours were near-black #1e1002 under the full occlusion)
  // (leaves keep a bit more too — the jungle view measured V p50 0.22 against the target art's 0.31, its foreground
  // plants read sunny lime there)
  #ifdef VEG_LEAF
    float vegOccK = 0.72;
  #else
    float vegOccK = 0.45;
  #endif
  reflectedLight.indirectDiffuse *= 1.0 - vOcc * vegOccK;
  reflectedLight.indirectSpecular *= 1.0 - vOcc * 0.8;
  // leaves: the sky IBL alone turns shaded foliage grey-teal — tint it toward the canopy's own green bounce
  if ( uTrans > 0.0 ) reflectedLight.indirectDiffuse *= vec3( 0.8, 0.96, 0.7 );
  // GI-like fill: canopy bounce + sky, so shade reads green instead of dead cyan (the target art's bounce-lit look)
  vec3 fillN = normalize( ( vec4( normal, 0.0 ) * viewMatrix ).xyz );
  float up = 0.72 + 0.28 * fillN.y;
  // (the canopy's own bounce is warm lime, not sky blue: the shade tint warms with the occlusion)
  // (… and toward GREEN-yellow, not olive: the target art's jungle shade is #1d3702–#2f5200, ours read #2e3407)
  vec3 vegShT = mix( uShadeTint, vec3( 0.86, 1.0, 0.62 ), clamp( vOcc / 0.45, 0.0, 1.0 ) );
  reflectedLight.indirectDiffuse += diffuseColor.rgb * mix( vec3( 1.0 ), uTransColor, 0.3 ) * vegShT * uFill * uGrade.x * up * ( 1.0 - vOcc * 0.85 * vegOccK );
}
`;

const F_GRADE = /* glsl */ `
{
  // under a closed canopy (vOcc, CanopyGrid) the target art's jungle greens are warmer and more saturated still (hue
  // ~84°, saturation ~0.9 — ours measured 94° / 0.76): the yellow push and the saturation grow with the occlusion
  float vegJk = clamp( vOcc / 0.45, 0.0, 1.0 );
  #ifdef VEG_BB_FRAG
    vegJk = max( vegJk, 0.7 );   // canopy / bush clumps: the target art's crowns are yellow-lime throughout
  #endif
  float l = dot( diffuseColor.rgb, vec3( 0.299, 0.587, 0.114 ) );
  // (the under-canopy saturation boost is for LEAVES — on bark it turned the target art's grey-brown trunks a
  // saturated red-brown; bark carries its own uSat, e.g. 0.8 on the jungle trunks)
  #ifdef VEG_LEAF
    float vegSatK = 1.0 + 0.34 * vegJk;
  #else
    float vegSatK = uSat;
  #endif
  diffuseColor.rgb = max( mix( vec3( l ), diffuseColor.rgb, uGrade.z * vegSatK ), 0.0 );
  // the target art's greens lean yellow-lime (hue ~85°): pull blue out of the albedo
  // (only on GREEN texels — white daisies, yellow bananas / buttercups and red bromeliads keep their colour)
  float vegGr = clamp( ( diffuseColor.g - max( diffuseColor.r, diffuseColor.b ) ) * 6.0, 0.0, 1.0 );
  diffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 1.1, 1.0, 0.74 ), vegGr );
  // + a HUE rotation toward yellow (about the grey axis — keeps the saturation the painted textures carry; a multiply
  // toward yellow mostly desaturated them): up to −29° under the canopy / on crown clumps
  float vegTh = -0.42 * vegJk * vegGr;   // (−24°, not −29°: at −29° the shade mid-tones went olive #2e3407)
  vec3 vegK = vec3( 0.57735 );
  diffuseColor.rgb = max( diffuseColor.rgb * cos( vegTh ) + cross( vegK, diffuseColor.rgb ) * sin( vegTh ) + vegK * dot( vegK, diffuseColor.rgb ) * ( 1.0 - cos( vegTh ) ), 0.0 );
}
`;

// leaves under the canopy — saturation pushed AFTER lighting (the sky fill and the sheen are the grey part)
const F_POSTSAT = /* glsl */ `
#if defined( VEG_LEAF ) && !defined( VEG_DEPTH )
{
  float vegJp = clamp( vOcc / 0.45, 0.0, 1.0 );
  float vegLp = dot( outgoingLight, vec3( 0.299, 0.587, 0.114 ) );
  outgoingLight = max( mix( vec3( vegLp ), outgoingLight, 1.0 + uPostSat * vegJp ), 0.0 );
}
#endif
`;

// the sun is the only direct light foliage takes: POI point / spot lights (temple torches …) are compiled out of every
// veg program — each one was a full GGX + translucency evaluation on every lit leaf fragment of the island
const LIGHTS_SUN_ONLY = THREE.ShaderChunk.lights_fragment_begin
  .replace("#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )", "#if 0")
  .replace("#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )", "#if 0")
  .replace("#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )", "#if 0")
  .replace("getSunLightInfo( sunLight, directLight );", "getSunLightInfo( sunLight, directLight );\n\t\tvegSunRaw = directLight.color;");
// leaves: hemisphere ambient (VEG_LIGHT) instead of the IBL irradiance fetch
// (perf: bark / stems / nuts take the same calibrated hemisphere as the leaves — the IBL irradiance cube fetch
// (textureCubeUV: 2 fetches + ~60 ALU) on every trunk fragment was measurable at the jungle cameras)
const LIGHTS_MAPS_VEG = THREE.ShaderChunk.lights_fragment_maps
  .replace("iblIrradiance += getIBLIrradiance( geometryNormal );", "iblIrradiance += vegHemiIrradiance( geometryNormal ) * envMapIntensity;")
  .replace("#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )", "#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular ) && !defined( VEG_MATTE )\nif ( uVegLite == 0.0 ) {")
  .replace(/#endif\s*$/, "}\n#endif\n");
// leaf-cluster cards: their puffed normals turn edge-on at random → the sky reflection greyed whole cards; keep a trace

// broad leaves: the sky reflection at grazing angles washed monstera / banana leaves pale teal; undersides are matte
const LIGHTS_MAPS_VEG_LEAF = LIGHTS_MAPS_VEG.replace("radiance += iblRadiance;", "radiance += iblRadiance * ( gl_FrontFacing ? 0.28 : 0.1 ) * uSpecK;");
// (the sky reflection is skipped on matte parts — VEG_MATTE — and on the LOD1 tier through uVegLite, see liteMaterial)
const LIGHTS_MAPS_VEG_MATTE = LIGHTS_MAPS_VEG;
if (!LIGHTS_SUN_ONLY.includes("vegSunRaw") || !LIGHTS_MAPS_VEG.includes("vegHemiIrradiance") || !LIGHTS_MAPS_VEG.includes("!defined( VEG_MATTE )\nif ( uVegLite == 0.0 ) {") || !LIGHTS_MAPS_VEG.endsWith("}\n#endif\n")) console.warn("veg: three shader chunks changed — foliage lighting patch not applied");

const NORMAL_NOFLIP = THREE.ShaderChunk.normal_fragment_begin.replace("normal *= faceDirection;", "");

let keySeq = 0;

export function foliageMaterial(o: FoliageOpts): FoliageMaterials {
  const mat = new THREE.MeshStandardMaterial({
    map: o.map, color: o.color ?? 0xffffff,
    roughness: o.roughness ?? 0.55, metalness: o.metalness ?? 0,
    // opaque parts (bark, stems, nuts) never alpha-test: a discard in the shader costs the GPU its hidden-surface removal
    alphaTest: o.alphaTest ?? (o.translucency ? 0.5 : 0), side: o.doubleSide === false ? THREE.FrontSide : THREE.DoubleSide,
    vertexColors: true, envMapIntensity: o.envMapIntensity ?? 0.7,
    // (perf: no per-fragment aerial perspective — atmos' haze starts beyond ~250 m of optical depth and the dawn
    // mist beyond 180 m, while every veg MESH tier ends by ~120 m: the fog code was ~0.25 ms of pure cost at a jungle
    // camera. The impostors keep it.)
    fog: false,
  });
  if (o.normalMap) { mat.normalMap = o.normalMap; mat.normalScale.set(o.normalScale ?? 1, o.normalScale ?? 1); }
  const leafy = !!o.translucency;
  const own = {
    uHeight: { value: o.height ?? 10 },
    uSway: { value: o.sway ?? 0.35 },
    uBob: { value: o.bob ?? 0 },
    uFlutter: { value: o.flutter ?? 0.05 },
    uTrans: { value: o.translucency ?? 0 },
    uShadowLift: { value: o.shadowLift ?? 0 },
    uSpecK: { value: o.specK ?? 1 },
    uSat: { value: o.sat ?? 1 },
    uFill: { value: o.fill ?? (leafy ? 0.3 : 0.1) },
    uWrap: { value: o.wrap ?? (leafy ? 0.45 : 0.15) },
    uAlphaMip: { value: o.alphaMip ?? 0.28 },
    uBillboard: { value: o.billboard ?? 0 },
    uPuff: { value: o.puff ?? 0.5 },
    uCardRot: { value: o.cardRot ?? 6.2832 },
    uTransColor: { value: new THREE.Color(o.transColor ?? 0xa8ff3c) },
    uFade: { value: new THREE.Vector4(o.fadeFar?.[0] ?? 0, o.fadeFar?.[1] ?? 0, o.fadeNear?.[0] ?? 0, o.fadeNear?.[1] ?? 0) },
    uWiden: { value: o.widen ?? 0 },
    uRootFade: { value: o.rootFade ?? 0 },
    uRootTint: { value: new THREE.Vector3(...(o.rootTint ?? [1, 1, 1])) },
    // (only on materials that use it: splat-cache keys hash these uniforms — other species keep their cached bakes)
    ...(o.senesce ? { uDry: { value: o.senesce } } : {}),
  };
  const bb = o.billboard !== undefined;
  const dry = !!o.senesce;
  const key = `veg3:${!!o.map}:${!!o.normalMap}:${bb}:${leafy}:${!!o.atlas2}:${!!o.matte}:${!!o.twoSide}:${!!o.rootFade}:${!!o.noFlip}:${!!o.hullFade}:${dry}`;
  const patchVertex = (sh: THREE.WebGLProgramParametersWithUniforms, depth: boolean) => {
    Object.assign(sh.uniforms, VEG_UNIFORMS, VEG_LIGHT, own);
    const defs = (bb ? "#define VEG_BILLBOARD\n" : "") + (depth ? "#define VEG_DEPTH\n" : "") + (o.atlas2 ? "#define VEG_ATLAS2\n" : "") + (o.rootFade ? "#define VEG_ROOTFADE\n" : "") + (o.hullFade && !depth ? "#define VEG_HULLFADE\n" : "") + (dry && !depth ? "#define VEG_SENESCE\n" : "");
    sh.vertexShader = defs + `#define VEG_FADE_T ${VEG_FADE_T.toFixed(3)}\n` + sh.vertexShader
      .replace("#include <color_vertex>", V_COLOR)
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n" + V_ATLAS)
      .replace("#include <common>", "#include <common>\n" + V_PARS)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n" + V_WIND)
      .replace("#include <project_vertex>", "#include <project_vertex>\n" + V_BILLBOARD);
  };
  mat.onBeforeCompile = (sh) => {
    patchVertex(sh, false);
    sh.uniforms.uVegLite = VEG_FULL;
    // (perf: leaf-cluster billboard cards are matte — their GGX trace (×0.18) and sky reflection (×0.2) on fake
    // puffed normals cost a cube fetch + ~80 ALU per canopy fragment for glints the painted masses already carry)
    const matte = o.matte || bb;
    sh.fragmentShader = (o.hullFade ? "#define VEG_HULLFADE\nvarying float vVegHull;\n" : "") + (o.twoSide ? "#define VEG_TWOSIDE\n" : "") + (o.rootFade ? "#define VEG_ROOTFADE\n" : "") + (dry ? "#define VEG_SENESCE\n" : "") + (leafy ? "#define VEG_LEAF\n" : "") + (bb ? "#define VEG_BB_FRAG\n" : "") + (matte ? "#define VEG_MATTE\n" : "") + sh.fragmentShader
      .replace("#include <common>", "#include <common>\n" + F_PARS)
      .replace("#include <normal_fragment_begin>", o.noFlip ? NORMAL_NOFLIP : "#include <normal_fragment_begin>")
      .replace("#include <normal_fragment_maps>", "if ( uVegLite == 0.0 ) {\n#include <normal_fragment_maps>\n}")
      .replace("#include <map_fragment>", F_MAP + F_HULL + F_ROOT + F_SENESCE + F_GRADE)
      .replace("#include <alphatest_fragment>", "#include <alphatest_fragment>\n" + F_FADE)
      .replace("#include <lights_physical_pars_fragment>", "#include <lights_physical_pars_fragment>\n" + F_DIRECT)
      .replace("#include <lights_fragment_begin>", LIGHTS_SUN_ONLY)
      .replace("#include <lights_fragment_maps>", matte ? LIGHTS_MAPS_VEG_MATTE : leafy ? LIGHTS_MAPS_VEG_LEAF : LIGHTS_MAPS_VEG)
      .replace("#include <aomap_fragment>", "#include <aomap_fragment>\n" + F_FILL)
      .replace("#include <opaque_fragment>", F_POSTSAT + "#include <opaque_fragment>");
  };
  mat.customProgramCacheKey = () => key;
  // meshes without the per-instance LOD fade attribute (detail pools, the studio) read "settled, visible"
  (mat as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { aLodFade: [0, 0], aAtlas: [0], aVar: [0] };

  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: o.map, alphaTest: bb ? Math.min(0.66, mat.alphaTest + 0.14) : mat.alphaTest, side: THREE.DoubleSide });
  depth.onBeforeCompile = (sh) => {
    patchVertex(sh, true);
    sh.fragmentShader = "#define VEG_DEPTH\n" + sh.fragmentShader
      .replace("#include <common>", "#include <common>\n" + F_PARS)
      .replace("#include <map_fragment>", F_MAP)
      .replace("#include <alphatest_fragment>", "#include <alphatest_fragment>\n" + F_FADE + F_SHADOWBAND);
  };
  depth.customProgramCacheKey = () => "d" + key;
  (depth as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { aLodFade: [0, 0], aAtlas: [0], aVar: [0] };
  if (o.noDepth) { mat.depthWrite = false; mat.userData.vegNoDepth = true; }
  mat.userData.veg = own;
  mat.userData.vegBillboard = bb;
  mat.userData.vegAtlas2 = !!o.atlas2;
  mat.userData.vegNoFlip = !!o.noFlip;
  mat.userData.vegHullFade = !!o.hullFade;
  mat.userData.vegSenesce = o.senesce ?? 0;
  /** the back-face sun response of RE_Direct_Veg: two-sided blades 0.72, thin leaves 0.42, clumps 0 */
  mat.userData.vegBackSun = o.twoSide ? 0.72 : leafy && !bb ? 0.42 : 0;
  depth.userData.veg = own;
  mat.name = `veg-mat-${++keySeq}`;
  return { mat, depth };
}

/**
 * Perf: the foliage GPU cost is ~85 % SHADING (an unlit probe saved 1.9 of 2.2 ms) at 4–6 layers
 * of alpha-tested overdraw; a discard in the shader turns off the GPU's hidden-surface removal. Alpha-tested parts
 * draw twice —
 *   1. prepassMaterial: the same vertex path (wind, billboards, LOD crossfade collapse), a trivial fragment shader
 *      (texture alpha → alpha test + crossfade dither), depth only (no colour write), before everything else;
 *   2. equalMaterial: the full foliage shading with depthFunc EQUAL, no depth write and NO discard — every pixel is
 *      shaded exactly once, by the surface the pre-pass kept (invariant gl_Position keeps the two passes' depths equal).
 */
const preCache = new WeakMap<THREE.Material, THREE.MeshBasicMaterial>();
export function prepassMaterial(fm: FoliageMaterials): THREE.MeshBasicMaterial {
  const src = fm.mat;
  let m = preCache.get(src);
  if (m) return m;
  const own = src.userData.veg as Record<string, { value: unknown }>;
  const bb = !!src.userData.vegBillboard, at = !!src.userData.vegAtlas2;
  m = new THREE.MeshBasicMaterial({ map: src.map, alphaTest: src.alphaTest, side: src.side, vertexColors: true, colorWrite: false, depthWrite: true, fog: false, toneMapped: false });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, VEG_UNIFORMS, VEG_LIGHT, own);
    const defs = "#define VEG_PRE\n" + (bb ? "#define VEG_BILLBOARD\n" : "") + (at ? "#define VEG_ATLAS2\n" : "");
    sh.vertexShader = defs + `#define VEG_FADE_T ${VEG_FADE_T.toFixed(3)}\n` + sh.vertexShader
      .replace("#include <color_vertex>", V_COLOR)
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n" + V_ATLAS)
      .replace("#include <common>", "#include <common>\n" + V_PARS)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n" + V_WIND)
      .replace("#include <project_vertex>", "#include <project_vertex>\n" + V_BILLBOARD);
    sh.fragmentShader = defs + sh.fragmentShader
      .replace("#include <common>", "#include <common>\n" + F_PARS)
      .replace("#include <map_fragment>", F_MAP)
      .replace("#include <alphatest_fragment>", "#include <alphatest_fragment>\n" + F_FADE + "\ngl_FragColor = vec4( 0.0 ); return;");
  };
  m.customProgramCacheKey = () => `vegpre:${bb}:${at}`;
  (m as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { aLodFade: [0, 0], aAtlas: [0], aVar: [0] };
  m.userData.veg = own;
  m.name = src.name + "-pre";
  preCache.set(src, m);
  return m;
}
const eqCache = new WeakMap<THREE.Material, THREE.MeshStandardMaterial>();
export function equalMaterial(fm: FoliageMaterials): THREE.MeshStandardMaterial {
  const src = fm.mat;
  let m = eqCache.get(src);
  if (!m) {
    m = src.clone();
    m.onBeforeCompile = src.onBeforeCompile;
    m.customProgramCacheKey = src.customProgramCacheKey;
    m.alphaTest = 0;
    m.depthFunc = THREE.EqualDepth; m.depthWrite = false;
    m.defines = { ...(src.defines ?? {}), VEG_NOFADE: 1 };
    m.userData = src.userData;
    (m as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { aLodFade: [0, 0], aAtlas: [0], aVar: [0] };
    m.name = src.name + "-eq";
    (m as unknown as { vegSrc: THREE.Material }).vegSrc = src;
    eqCache.set(src, m);
  }
  return m;
}

const liteCache = new WeakMap<THREE.Material, THREE.MeshStandardMaterial>();
const VEG_FULL = { value: 0 };
const VEG_LITE = { value: 1 };
/**
 * Perf: the LOD1 tier (15–85 m) of a part — no GGX sun glint, no sky-reflection fetch, no normal map: at that
 * distance the glint is sub-pixel sparkle, the sky sheen a flat tint the fill already carries, the bump detail below a
 * pixel. It shares its part's program and skips the glint and sky reflection on a per-material uniform (uVegLite), so a
 * species without a normal map compiles one program instead of two before the island is ready (RAY-132).
 */
export function liteMaterial(fm: FoliageMaterials): THREE.MeshStandardMaterial {
  const src = fm.mat;
  let m = liteCache.get(src);
  if (!m) {
    m = src.clone();
    m.onBeforeCompile = (sh, r) => { src.onBeforeCompile(sh, r); sh.uniforms.uVegLite = VEG_LITE; };
    m.customProgramCacheKey = src.customProgramCacheKey;
    // (no normal map: a fetch with implicit gradients inside the uVegLite branch gets flattened on D3D11, so it would
    // still run on every LOD1 fragment; species with a normal map keep a separate lite program for this)
    m.normalMap = null;
    m.userData = src.userData;
    (m as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { aLodFade: [0, 0], aAtlas: [0], aVar: [0] };
    m.name = src.name + "-lite";
    liteCache.set(src, m);
  }
  return m;
}

const noFadeCache = new WeakMap<THREE.Material, THREE.MeshStandardMaterial>();
/**
 * The same foliage material with the distance-fade discard compiled out — for OPAQUE LOD0 parts (bark, stems, canes,
 * logs): a shader that can discard turns off the GPU's hidden-surface removal for every fragment it draws.
 */
export function noFadeMaterial(fm: FoliageMaterials): THREE.MeshStandardMaterial {
  const src = fm.mat;
  let m = noFadeCache.get(src);
  if (!m) {
    m = src.clone();
    m.onBeforeCompile = src.onBeforeCompile;
    m.customProgramCacheKey = src.customProgramCacheKey;
    m.defines = { ...(src.defines ?? {}), VEG_NOFADE: 1 };
    m.userData = src.userData;
    (m as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { aLodFade: [0, 0], aAtlas: [0], aVar: [0] };
    m.name = src.name + "-nofade";
    noFadeCache.set(src, m);
  }
  return m;
}

export type VegUniforms = {
  uHeight: { value: number }; uSway: { value: number }; uBob: { value: number }; uFlutter: { value: number };
  uTrans: { value: number }; uFill: { value: number }; uWrap: { value: number }; uAlphaMip: { value: number };
  uBillboard: { value: number }; uPuff: { value: number }; uTransColor: { value: THREE.Color }; uFade: { value: THREE.Vector4 };
};

/** per-material foliage uniforms (shared by the colour and depth materials) */
export function vegUniforms(m: FoliageMaterials): VegUniforms {
  return m.mat.userData.veg as VegUniforms;
}


/** F_HULL for a bake view: the clump hull dissolves toward its silhouette as seen from THIS view,
 *  leaf cards seen edge-on thin out — what the real tree shows from that direction */
const BAKE_HULL = /* glsl */ `
{
  vec3 vv = normalize( cameraPosition - vBakeP );
  if ( vVegHull > 0.5 ) {
    float nv = abs( dot( normalize( vBakeN ), vv ) );
    float lum = dot( sampledDiffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) );
    diffuseColor.a *= smoothstep( 0.1, 0.45, nv + ( lum - 0.28 ) * 0.9 );
  } else {
    vec3 gn = normalize( cross( dFdx( vBakeP ), dFdy( vBakeP ) ) );
    diffuseColor.a *= smoothstep( 0.04, 0.3, abs( dot( gn, vv ) ) );
  }
}
`;

/** GLSL pieces reused by the impostor material (same lighting as the meshes → no LOD pop) */
export const VEG_GLSL = { F_PARS, F_DIRECT, F_FILL, F_GRADE };

const keptPrograms = new WeakSet<object>();

export function retireMaterial(renderer: THREE.WebGLRenderer, m: THREE.Material) {
  const program = (renderer.properties.get(m) as { currentProgram?: object }).currentProgram;
  if (program && !keptPrograms.has(program)) keptPrograms.add(program);
  else m.dispose();
}

/**
 * Impostor bake materials for a foliage material: same vertex path (wind, billboard cards — which face the bake
 * camera), unlit output of either the graded albedo (alpha kept hard) or the object-space normal (toward the camera).
 */
export function bakeMaterial(src: FoliageMaterials, pass: "albedo" | "normal", o: { tint?: number; yRange?: [number, number]; /** lit-top height ramp (default on) */ ramp?: boolean; /** written alpha (default 1) — the splat bake tags bark / leaves */ alphaOut?: number; /** keep the geometry normal on back faces when the material does (noFlip crowns) */ honourNoFlip?: boolean; /** the mesh's clump-hull silhouette fade + edge-on card thinning (F_HULL), per bake view */ hullFade?: boolean } = {}): THREE.Material {
  const s = src.mat;
  const own = s.userData.veg as VegUniforms;
  const bb = !!s.userData.vegBillboard, at = !!s.userData.vegAtlas2;
  const m = new THREE.MeshBasicMaterial({ map: s.map, color: s.color.clone().multiplyScalar(o.tint ?? 1), alphaTest: s.alphaTest || 0.5, side: THREE.DoubleSide, vertexColors: true, toneMapped: false });
  const yr = o.yRange ?? [0, 1];
  const hf = !!(o.hullFade && s.userData.vegHullFade);
  // (the bake captures the dry margins of the MEAN plant — splat.ts offsets each far plant by its own)
  const dry = pass === "albedo" && !!s.userData.vegSenesce;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, VEG_UNIFORMS, own, { uBakeY: { value: new THREE.Vector2(yr[0], yr[1]) } });
    const defs = "#define VEG_BAKE\n" + (bb ? "#define VEG_BILLBOARD\n" : "") + (at ? "#define VEG_ATLAS2\n" : "") + (hf ? "#define VEG_HULLFADE\n#define VEG_BAKE_HULL\n" : "") + (dry ? "#define VEG_SENESCE\n" : "");
    sh.vertexShader = defs + `#define VEG_FADE_T ${VEG_FADE_T.toFixed(3)}\n` + sh.vertexShader
      .replace("#include <uv_vertex>", "#include <uv_vertex>\n" + V_ATLAS)
      .replace("#include <common>", "#include <common>\nvarying vec3 vBakeN;\nvarying float vBakeY;\n#ifdef VEG_BAKE_HULL\nvarying vec3 vBakeP;\n#endif\n" + V_PARS)
      .replace("#include <begin_vertex>", "#include <begin_vertex>\n" + V_WIND)
      .replace("#include <project_vertex>", "#include <project_vertex>\n" + V_BILLBOARD + "\nvBakeY = ( modelMatrix * vec4( transformed, 1.0 ) ).y;\nvOcc = 0.0;\n#ifdef VEG_SENESCE\nvVegDry = vegDryStage( VEG_DRY_REF, color, aPhase );\n#endif\n#ifdef VEG_BAKE_HULL\nvBakeP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n#endif");
    sh.fragmentShader = defs + sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vBakeN;\nvarying float vBakeY;\nuniform vec2 uBakeY;\n" + (hf ? "varying vec3 vBakeP;\nvarying float vVegHull;\n" : "") + F_PARS)
      .replace("#include <map_fragment>", F_MAP + (hf ? BAKE_HULL : "") + (pass === "albedo" ? F_SENESCE + F_GRADE + (o.ramp === false ? "" : "\n{ float hy = clamp( ( vBakeY - uBakeY.x ) / max( uBakeY.y - uBakeY.x, 0.01 ), 0.0, 1.0 ); diffuseColor.rgb *= 0.72 + 0.42 * smoothstep( 0.35, 1.0, hy ); }") : ""))
      .replace("#include <opaque_fragment>", pass === "albedo"
        ? `gl_FragColor = vec4( outgoingLight, ${(o.alphaOut ?? 1).toFixed(3)} );`
        : `gl_FragColor = vec4( normalize( vBakeN ) * ( ${o.honourNoFlip && s.userData.vegNoFlip ? "1.0" : "( gl_FrontFacing ? 1.0 : -1.0 )"} ) * 0.5 + 0.5, 1.0 );`);
  };
  m.customProgramCacheKey = () => `vegbake3:${pass}:${bb}:${at}:${o.ramp === false ? 0 : 1}:${o.alphaOut ?? 1}:${o.honourNoFlip && s.userData.vegNoFlip ? 1 : 0}:${hf ? 1 : 0}:${dry ? 1 : 0}`;
  (m as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { aLodFade: [0, 0], aAtlas: [0], aVar: [0] };
  return m;
}
