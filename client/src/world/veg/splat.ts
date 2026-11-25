// Gaussian-splat far trees. Replaces the flat impostor cards of the BIG plants (trees, palms,
// mangroves, bamboo) beyond their LOD1 distance with real 3D point clouds of soft anisotropic blobs:
//
//   • bake (once, at load): every species is captured from 32 directions with the impostor bake materials
//     (splat-bake.ts) and clustered into 5 independent levels of 4096 / 1024 / 256 / 64 / 16 gaussians (splat-build.ts,
//     in workers). A splat = centre, 3D covariance, opacity, albedo, normal. Because the far tree IS the near tree's 3D
//     shape, its rotation, pivot, height and crown can never disagree with the mesh: nothing is clipped, nothing pivots.
//   • draw: one Points draw per level for every species (5 draws for the whole island). A point = a splat; its vertex
//     shader projects the 3D covariance to a screen ellipse (EWA, the 3DGS maths), sizes the point sprite, lights it
//     (the impostors' foliage lighting: wrap diffuse, translucency, calibrated sky / ground ambient, far canopy grade)
//     and sways it with the mesh's own trunk wind. The fragment evaluates the gaussian and keeps the pixel with that
//     probability (stochastic transparency, decorrelated per splat, re-seeded every frame under TAA): no sorting, depth
//     writes, fog / aerial perspective / cloud shadows through atmos like every other material.
//   • levels by SCREEN SIZE: the tree's projected radius picks the level; neighbouring levels dissolve into each other
//     over a ±15 % band with complementary per-pixel masks (never both, never neither).
//   • mesh ↔ splat: the pools keep their LOD1 ↔ "impostor" tier switch (hysteresis, 0.45 s crossfade); the splat tree
//     takes the impostor's place in that crossfade with the same complementary dither — and it stands exactly where the
//     mesh stands.
//   • shadows: a hidden copy of every tree at the 64-splat level casts into atmos' static far map and canopy map (the
//     impostor quads' job); near cascades keep the meshes.
// ?vegsplat=0 = the old impostor cards (A/B).
import * as THREE from "three";
import type { Species } from "./species/types";
import type { SpeciesPool, ImpTarget } from "./lod";
import { VEG_UNIFORMS, VEG_LIGHT, VEG_FADE_T, VEG_DRY_GLSL, vegUniforms } from "./foliage-material";
import { IMP_GRADE } from "./impostor";
import { captureSpecies } from "./splat-bake";
import { buildSplats, SPLAT_FLOATS, type SplatBuildInput, type SplatBuildOutput } from "./splat-build";
import { crownFootprint } from "../../../../shared/world/veg-scatter";
import { cacheGet, cachePut, splatKey } from "./splat-cache";
import { flag } from "../../flags";

export const VEG_SPLAT = flag("vegsplat");
export const VEG_SPLAT_SMALL = flag("vegsplatsmall");

/** splats per level (finest first) and the projected-radius boundaries (px) between neighbouring levels */
export const SPLAT_LEVELS = [4096, 2048, 1024, 512, 256, 128, 64, 32, 16];
/** the understory set (bushes, monstera, banana, heliconia — ≤ 6 m) */
export const SPLAT_LEVELS_SMALL = [1024, 512, 256, 128, 64, 32, 16];
/** splat density: a level of N splats is used while N <= density · P² < 2N (P = the plant's projected radius, px) —
 *  boundary between level l and l+1 at P = √(N_l / density) (live: __kr.veg.splats.setDensity) */
const DENSITY0 = flag("spldens");
/** the band (fraction of a boundary) over which two levels dissolve into each other (boundaries are √2 apart) */
const BAND_LO = 0.9, BAND_HI = 1.1;
/** the level the far-map / canopy shadow copy uses */
const SHADOW_N = 64;
/** levels of at least this many splats are captured from LOD1 (the swap partner), the rest from LOD0 */
const NEAR_N = flag("splnear");
const SPLAT_W = 2048;   // splat data texture width (texels): 2 texels per splat (RGBA32UI)
const FADE_W = 1024;
const MAXSP = 24;
const REC = 16;         // floats per instance record (aI0 … aI3)
const CELL = 64;
const GRID_HALF = 1760;
const GRID = Math.ceil((2 * GRID_HALF) / CELL);
/** live tuning (__kr.veg.splats.U): x = opacity gain, y = size gain, z = min splat sigma (px), w = stochastic (1) / hard (0) */
export const SPLAT_TUNE = { uSplTune: { value: new THREE.Vector4(flag("splop"), flag("splsz"), 0.3, 1) }, uSplCut: { value: flag("splcut") }, uSplKeep: { value: flag("splkeep") }, uSplShOff: { value: flag("splshoff") }, uSplLight: { value: new THREE.Vector4(flag("splshadow"), flag("splocc"), flag("splshfar"), flag("splocfar")) }, uSplNear: { value: new THREE.Vector2(flag("splhue"), flag("splsat")) } };

const V_PARS = /* glsl */ `
attribute vec4 aI0;
attribute vec4 aI1;
attribute vec4 aI2;
attribute vec4 aI3;
uniform highp usampler2D uSplData;
uniform highp sampler2D uSplFade;
uniform vec4 uSplSp[ ${MAXSP * 6} ];
#ifdef SPL_ATMOS
uniform highp sampler2DShadow uAtmFarMap;
uniform mat4 uAtmFarMatrix;
uniform vec4 uAtmFarParams;
#endif
uniform int uSplLevelOff;
uniform int uSplStride;
uniform vec4 uSplBand;
uniform vec2 uSplVp;
uniform vec2 uSplFar;
uniform vec4 uSplTune;
uniform float uSplCut;
uniform float uSplKeep;
uniform float uSplShOff;
uniform vec2 uSplNear;
uniform vec4 uSplLight;
uniform float uFadeNow;
uniform float uTime;
uniform vec3 uWind;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uAmbUp, uAmbSide, uAmbDown;
uniform vec3 uGrade, uSunTint, uShadeTint;
uniform vec4 uImpSplit;
uniform vec4 uImpGrade;
uniform vec2 uImpLit;
flat varying vec3 vSplConic;
flat varying vec3 vSplCol;
flat varying float vSplPs;
flat varying float vSplOp;
flat varying float vSplRank;
flat varying vec3 vSplVis;
flat varying vec3 vSplDirect;
flat varying vec3 vSplAmb;
flat varying vec3 vSplW;
flat varying float vSplDist;
ivec2 splTx( int i, int w ) { return ivec2( i % w, i / w ); }
${VEG_DRY_GLSL}
vec3 splOct( uint p ) {
  float qu = float( ( p >> 10u ) & 1023u ), qv = float( p & 1023u );
  vec2 o = vec2( qu, qv ) / 1023.0 * 2.0 - 1.0;
  vec3 n = vec3( o, 1.0 - abs( o.x ) - abs( o.y ) );
  if ( n.z < 0.0 ) n.xy = ( 1.0 - abs( n.yx ) ) * vec2( n.x >= 0.0 ? 1.0 : -1.0, n.y >= 0.0 ? 1.0 : -1.0 );
  return normalize( n );
}
`;

const V_BODY = /* glsl */ `
vec3 transformed = vec3( 0.0 );
bool splDrop = false;
float splPs = 0.0;
{
  vec4 i0 = aI0, i1 = aI1, i2 = aI2, i3 = aI3;
  int slot = int( i1.z + 0.5 );
  vec3 iPos = i0.xyz; float yaw = i0.w; float iScale = i1.x; int sp = int( i1.y + 0.5 );
  int sid = sp * uSplStride + uSplLevelOff + gl_VertexID;
  // splat: [centre xyz (f32), opacity 8 | normal 24] [Σ halfs ×3, albedo √rgb 8×3 | rank 8]
  uvec4 u0 = texelFetch( uSplData, splTx( sid * 2, ${SPLAT_W} ), 0 );
  uvec4 u1 = texelFetch( uSplData, splTx( sid * 2 + 1, ${SPLAT_W} ), 0 );
  vec4 s0 = vec4( uintBitsToFloat( u0.xyz ), float( u0.w & 255u ) / 255.0 );
  vec2 h0 = unpackHalf2x16( u1.x ), h1 = unpackHalf2x16( u1.y ), h2 = unpackHalf2x16( u1.z );
  vec4 cr = vec4( float( u1.w & 255u ), float( ( u1.w >> 8u ) & 255u ), float( ( u1.w >> 16u ) & 255u ), float( u1.w >> 24u ) ) / 255.0;
  vec4 s1 = vec4( h0, h1 );
  float rb = floor( cr.w * 255.0 + 0.5 );
  float sLeaf = mod( rb, 16.0 ) / 15.0;
  vec4 s2 = vec4( h2, floor( rb / 16.0 ) / 15.0, 0.0 );
  vec3 sAlb = cr.rgb * cr.rgb;
  int pb = sp * 6;
  vec4 p0 = uSplSp[ pb ], p1 = uSplSp[ pb + 1 ], p2 = uSplSp[ pb + 2 ], p3 = uSplSp[ pb + 3 ], p4 = uSplSp[ pb + 4 ], p5 = uSplSp[ pb + 5 ];
  float cy = cos( yaw ), sy = sin( yaw );
  mat3 R = mat3( cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy );
  vec3 wc = iPos + R * ( p0.xyz * iScale );
  float camD = distance( wc, uCamPos );
  float focal = projectionMatrix[ 1 ][ 1 ] * uSplVp.y * 0.5;
  float P = p0.w * iScale * focal / max( camD, 1.0 );
  // level dissolve (by screen size): this level keeps the pixels whose level noise lies in [tUp, tLow)
  float tUp = uSplBand.y > 0.0 ? smoothstep( uSplBand.x, uSplBand.y, P ) : 0.0;
  float tLow = uSplBand.w > 0.0 ? smoothstep( uSplBand.z, uSplBand.w, P ) : 1.0;
  // LOD1 mesh ↔ splat crossfade (lod.ts impFade: x = switch time, y = 0 shown | 1 in | −1 out | 2 hidden)
  vec2 fd = texelFetch( uSplFade, splTx( slot, ${FADE_W} ), 0 ).xy;
  float vis = 1.0;
#ifndef SPL_SHADOW
  if ( fd.y != 0.0 ) {
    float k = clamp( ( uFadeNow - fd.x ) / VEG_FADE_T, 0.0, 1.0 );
    vis = fd.y > 1.5 ? 0.0 : fd.y > 0.0 ? k : 1.0 - k;
  }
#else
  tUp = 0.0; tLow = 1.0;
#endif
  vSplVis = vec3( fd.y < 0.0 ? -vis : vis, tUp, tLow );
  vSplRank = s2.z;
  float op = s0.w * uSplTune.x;
  if ( vis <= 0.0 || tLow <= tUp || op <= 0.0 ) splDrop = true;
  // road clearance from the air (the impostors' rule: a crown that would bury a dirt road shrinks toward its base)
  float roadK = 1.0;
#ifndef SPL_SHADOW
  if ( i3.z < 60.0 ) {
    float alt = cameraPosition.y - iPos.y;
    float aw = smoothstep( 90.0, 260.0, alt );
    if ( aw > 0.0 ) {
      vec2 toCam = cameraPosition.xz - iPos.xz;
      float hd = max( length( toCam ), 1.0 );
      vec2 vh = -toCam / hd;
      float cotE = hd / max( alt, 1.0 );
      vec2 rn = normalize( i3.xy + vec2( 1e-4, 0.0 ) );
      vec3 offW = R * vec3( p3.x, 0.0, p3.y ) * iScale;
      float reach = dot( offW.xz, rn ) + p3.z * iScale * cotE * max( dot( vh, rn ), 0.0 ) + p3.w * iScale;
      float k = clamp( ( i3.z - 0.8 ) / max( reach, 0.5 ), 0.0, 1.0 );
      roadK = mix( 1.0, k * k * ( 3.0 - 2.0 * k ) * 0.35 + k * 0.65, aw );
    }
  }
#endif
  if ( uSplFar.y > 0.0 ) roadK *= 1.0 - smoothstep( uSplFar.x, uSplFar.y, distance( iPos, uCamPos ) );
  if ( roadK < 0.03 ) splDrop = true;
  float sc = iScale * roadK;
  // the mesh's trunk sway (foliage-material vegWind, trunk term only): the splat tree bends with its mesh
  vec3 c = s0.xyz;
  {
    // seen steeply from above and far away, palm crowns grow (the impostors' "palm stars" — p2.w = 1.35 on palms)
    vec3 vd = normalize( cameraPosition - wc );
    float tb = mix( 1.0, p2.w, smoothstep( 0.55, 0.95, vd.y ) * smoothstep( 140.0, 280.0, camD ) );
    c = p0.xyz + ( c - p0.xyz ) * tb;
  }
  {
    float ph = dot( iPos, vec3( 0.071, 0.0, 0.053 ) );
    float hN = clamp( c.y / max( p4.x, 0.01 ), 0.0, 1.2 );
    float t = uTime;
    float gust = sin( t * 0.93 + ph ) * 0.45 + sin( t * 1.71 + ph * 1.7 + 1.3 ) * 0.25 + sin( t * 0.31 + ph * 0.3 ) * 0.3 + 0.4;
    vec3 windO = transpose( R ) * vec3( uWind.x, 0.0, uWind.z );
    vec3 side = vec3( -windO.z, 0.0, windO.x );
    c += windO * ( hN * hN * p4.y * uWind.y * gust ) + side * ( hN * hN * p4.y * 0.35 * uWind.y * sin( t * 1.3 + ph * 2.1 ) );
  }
  vec3 w = iPos + R * ( c * sc );
  transformed = w;
  vSplW = w;
  vSplDist = distance( w, uCamPos );
  // ---- EWA: 3D covariance → screen ellipse (px)
  mat3 Sg = mat3( s1.x, s1.y, s1.z, s1.y, s1.w, s2.x, s1.z, s2.x, s2.y );
  float g2 = sc * sc * uSplTune.y * uSplTune.y;
  mat3 Vr = mat3( viewMatrix );
  mat3 Sv = Vr * R * Sg * transpose( R ) * transpose( Vr ) * g2;
  vec3 t = ( viewMatrix * vec4( w, 1.0 ) ).xyz;
  vec4 cl = projectionMatrix * vec4( t, 1.0 );
  if ( cl.w <= 0.05 ) splDrop = true;
  vec3 r0 = vec3( projectionMatrix[ 0 ][ 0 ], projectionMatrix[ 1 ][ 0 ], projectionMatrix[ 2 ][ 0 ] );
  vec3 r1 = vec3( projectionMatrix[ 0 ][ 1 ], projectionMatrix[ 1 ][ 1 ], projectionMatrix[ 2 ][ 1 ] );
  vec3 r3 = vec3( projectionMatrix[ 0 ][ 3 ], projectionMatrix[ 1 ][ 3 ], projectionMatrix[ 2 ][ 3 ] );
  float iw = 1.0 / max( cl.w, 1e-4 );
  vec3 ja = ( r0 * cl.w - cl.x * r3 ) * iw * iw * ( uSplVp.x * 0.5 );
  vec3 jb = ( r1 * cl.w - cl.y * r3 ) * iw * iw * ( uSplVp.y * 0.5 );
  float a = dot( ja, Sv * ja ), b = dot( ja, Sv * jb ), d = dot( jb, Sv * jb );
  float det0 = max( a * d - b * b, 0.0 );
  // screen low-pass (each splat covers at least ~a pixel), its energy kept: the opacity drops as the area grows
  float lp = uSplTune.z * uSplTune.z;
  a += lp; d += lp;
  float det = a * d - b * b;
  op *= pow( max( det0, 1e-12 ) / max( det, 1e-8 ), 0.5 * ( 1.0 - uSplKeep ) );
  op = min( op, s0.w * uSplTune.x );
  float mid = 0.5 * ( a + d ), rad = sqrt( max( 0.25 * ( a - d ) * ( a - d ) + b * b, 0.0 ) );
  float lmax = mid + rad;
  // the sprite ends where the gaussian falls under ~2 % (a faint splat needs a smaller square)
  float cut = min( 3.0, sqrt( max( 2.0 * log( max( op, 1e-3 ) / 0.02 ), 0.0 ) ) ) * uSplCut;
  splPs = min( 2.0 * cut * sqrt( max( lmax, 0.0 ) ) + 1.0, 255.0 );
  vSplConic = vec3( d, -b, a ) / max( det, 1e-8 );
  vSplPs = splPs;
  vSplOp = min( op, 1.0 );
  if ( op < 0.02 ) splDrop = true;
#ifndef SPL_SHADOW
  // ---- light: the MESH's foliage model (foliage-material RE_Direct_Veg / F_FILL) per splat — the far-map shadow the
  // mesh receives, its shadow lift, wrap, translucency, hemisphere ambient, canopy occlusion — so a tree looks the same
  // on both sides of the swap; the impostors' far grading (lime palm crowns, darker bark, lit tops) only fades in
  // beyond ~150 m
  vec3 V = normalize( uCamPos - w );
  float cons = float( ( u0.w >> 28u ) & 15u ) / 15.0;
  vec3 N = normalize( mix( V, R * splOct( u0.w >> 8u ), smoothstep( 0.1, 0.8, cons ) ) );
  float farK = smoothstep( 150.0, 400.0, camD );
  float hy = clamp( c.y / max( p3.z, 0.01 ), 0.0, 1.0 );
  // bark: the LOD1 mesh's own darkening near the swap (p5.y), the impostors' 0.5 far away; leaves: 1 → the far tint
  vec3 alb = sAlb * i2.rgb * mix( mix( p5.y, 0.5, farK ), mix( 1.0, p4.z, farK ), sLeaf ) * mix( 1.0, 0.72 + 0.42 * smoothstep( 0.35, 1.0, hy ), farK );
  float tone = fract( sin( dot( floor( iPos.xz * 4.0 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) < 0.25 ? 0.8 : 1.0;
  alb *= mix( 1.0, tone, smoothstep( 220.0, 420.0, camD ) );
  // dry leaf margins: the bake holds the mean plant's (VEG_DRY_REF); this plant's own dryness (hashed
  // from the same tint floats as its mesh) moves its leaf splats toward yellow / back toward fresh green (p5.z = the
  // material's senescence strength, 0 = species without it)
  if ( p5.z > 0.0 ) alb *= mix( vec3( 1.0 ), vec3( 1.22, 1.03, 0.45 ), clamp( ( vegPlantDry( i2.rgb ) - VEG_DRY_REF ) * p5.z * 0.42, -0.14, 0.28 ) * sLeaf );
  float uTrans = p1.x * mix( 1.0, 0.8, farK ), uFill = p1.y, uWrap = p1.z, uEnvK = p1.w;
  vec3 uTransColor = p2.rgb;
  float occ = i2.w * uSplLight.y * ( 1.0 - uSplLight.w * farK );
  float nl = dot( N, uSunDir );
  nl = max( nl, -nl * p5.x );
  float diff = max( ( nl + uWrap ) / ( ( 1.0 + uWrap ) * ( 1.0 + uWrap ) ), 0.0 );
  float sunVis = 1.0;
#if defined( SPL_ATMOS ) && !defined( SPL_NOFAR )
  if ( uAtmFarParams.w > 0.5 ) {
    // (a splat's centre lies INSIDE its leaf layer: the far-map sample moves out toward the sun by its own size)
    float sr = sqrt( max( s1.x + s1.w + s2.y, 0.0 ) / 3.0 ) * sc;
    vec4 fsc = uAtmFarMatrix * vec4( w + N * uAtmFarParams.y + uSunDir * uSplShOff * sr, 1.0 );
    vec3 q = fsc.xyz / fsc.w; q.z += uAtmFarParams.x;
    if ( all( greaterThan( q, vec3( 0.0 ) ) ) && all( lessThan( q, vec3( 1.0 ) ) ) ) sunVis = texture( uAtmFarMap, q );
  }
#endif
  // (far away the self-shadow and the canopy occlusion ease off: no swap to match there, and the far-map copy's 64 fat
  // blobs over-shadow a crown seen from the air)
  sunVis = mix( 1.0, sunVis, uSplLight.x * ( 1.0 - uSplLight.z * farK ) );
  float sunLit = mix( sunVis, 1.0, p4.w );
  float back = pow( clamp( dot( V, -uSunDir ), 0.0, 1.0 ), 3.0 );
  float thru = clamp( -nl, 0.0, 1.0 );
  vSplDirect = uSunCol * ( diff * sunLit * uSunTint * alb * RECIPROCAL_PI + max( sunVis, 0.35 ) * uTransColor * alb * 2.2 * uTrans * uGrade.y * ( back * 0.9 + thru * 0.35 ) );
  vec3 below = uAmbDown * vec3( 0.75, 1.0, 0.5 ) + uAmbSide * vec3( 0.1, 0.18, 0.04 );
  vec3 hemi = N.y > 0.0 ? mix( uAmbSide, uAmbUp, N.y ) : mix( uAmbSide * vec3( 0.88, 1.0, 0.82 ), below, -N.y );
  vec3 amb = hemi * 0.8 * alb * vec3( 0.8, 0.96, 0.7 ) * uEnvK * ( 1.0 - occ * 0.72 );
  vec3 shT = mix( uShadeTint, vec3( 0.86, 1.0, 0.62 ), clamp( occ / 0.45, 0.0, 1.0 ) );
  vec3 fill = alb * mix( vec3( 1.0 ), uTransColor, 0.3 ) * shT * uFill * uGrade.x * ( 0.72 + 0.28 * N.y ) * ( 1.0 - occ * 0.85 * 0.72 );
  vSplAmb = ( amb + fill ) * ( 1.0 + uImpSplit.z * smoothstep( 150.0, 600.0, camD ) );
#endif
}
`;

/** after project_vertex: the point sprite (or nothing) */
const V_POINT = /* glsl */ `
gl_PointSize = splPs;
if ( splDrop ) { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); gl_PointSize = 0.0; }
#ifdef SPL_WET
#endif
`;

const F_PARS = /* glsl */ `
flat varying vec3 vSplConic;
flat varying float vSplPs;
flat varying float vSplOp;
flat varying float vSplRank;
flat varying vec3 vSplVis;
flat varying vec3 vSplCol;
uniform vec2 uVegTemporal;
uniform vec4 uSplTune;
float splNoise( vec2 p, float k ) {
  p += ( uVegTemporal.x > 0.5 ? 5.588238 * mod( uVegTemporal.y + k * 17.0, 64.0 ) : k * 23.17 );
  return fract( 52.9829189 * fract( 0.06711056 * p.x + 0.00583715 * p.y ) );
}
`;

/**
 * the gaussian + its stochastic coverage + the level / mesh dissolves.
 * Stochastic transparency uses a per-splat offset to decorrelate overlapping splats (union, not max).
 * Without TAA (Low preset / FXAA / AA off), a flat 0.4 coverage cut turns large nearby splats into crisp geometric discs,
 * so we perturb the contour with zero-mean multi-lobe angular harmonics scaled by screen size (far trees stay shimmer-free).
 */
const F_ALPHA = /* glsl */ `
{
  vec2 dp = ( gl_PointCoord - 0.5 ) * vSplPs;
  dp.y = -dp.y;
  float pw = -0.5 * ( vSplConic.x * dp.x * dp.x + 2.0 * vSplConic.y * dp.x * dp.y + vSplConic.z * dp.y * dp.y );
  if ( pw < -4.5 ) discard;
  float alpha = vSplOp * exp( pw );
#ifdef SPL_SHADOW
  if ( alpha < 0.45 ) discard;
#else
  float thr;
  if ( uSplTune.w > 0.5 && uVegTemporal.x > 0.5 ) {
    thr = fract( splNoise( gl_FragCoord.xy, 0.0 ) + vSplRank );
  } else {
    float big = smoothstep( 3.5, 11.0, vSplPs );
    float ang = atan( dp.y, dp.x );
    float ph = vSplRank * 6.2831853;
    float lobe = 0.45 * sin( ang * 3.0 + ph ) + 0.35 * cos( ang * 5.0 - ph * 1.7 ) + 0.20 * sin( ang * 7.0 + ph * 2.9 );
    thr = clamp( 0.41 + lobe * 0.21 * big, 0.16, 0.72 );
  }
  if ( alpha < thr ) discard;
  // level dissolve: [tUp, tLow) of an independent noise
  float nl = splNoise( gl_FragCoord.xy + vec2( 31.0, 7.0 ), 1.0 );
  if ( nl < vSplVis.y || nl >= vSplVis.z ) discard;
#endif
}
`;

/** per splat (vertex): the far-canopy grade, cloud shadow, atmos' vegetation grade + aerial perspective → one colour */
const V_LIGHT = /* glsl */ `
#ifndef SPL_SHADOW
{
  float cloud = 1.0;
  #ifdef SPL_ATMOS
    cloud = atmosCloudShadow( vSplW );
  #endif
  vec3 outgoingLight = vSplDirect * cloud + vSplAmb;
  {
    // near the swap: the mesh's leaf grade (measured side by side: the meshes read ~7° yellower, ~10 % more
    // saturated than the per-splat lighting gives) — fades out as the far grade below takes over
    float nk = 1.0 - smoothstep( 150.0, 400.0, vSplDist );
    float l0 = dot( outgoingLight, vec3( 0.299, 0.587, 0.114 ) );
    outgoingLight = max( mix( vec3( l0 ), outgoingLight, mix( 1.0, uSplNear.y, nk ) ), 0.0 );
    float th0 = uSplNear.x * nk;
    vec3 k0 = vec3( 0.57735 );
    outgoingLight = max( outgoingLight * cos( th0 ) + cross( k0, outgoingLight ) * sin( th0 ) + k0 * dot( k0, outgoingLight ) * ( 1.0 - cos( th0 ) ), 0.0 );
  }
  float mid = smoothstep( 150.0, 600.0, vSplDist );
  float lit = smoothstep( uImpLit.x, uImpLit.y, dot( outgoingLight, vec3( 0.299, 0.587, 0.114 ) ) / max( dot( uSunCol, vec3( 0.299, 0.587, 0.114 ) ) * RECIPROCAL_PI, 1e-4 ) );
  float vfar = smoothstep( 800.0, 1600.0, vSplDist );
  float l = dot( outgoingLight, vec3( 0.299, 0.587, 0.114 ) );
  outgoingLight = mix( vec3( l ), outgoingLight, 1.0 - ( uImpGrade.x * mid + uImpGrade.y * vfar ) * ( 1.0 - uImpSplit.w * lit ) );
  float th = uImpGrade.z * mid + uImpGrade.w * vfar + mix( uImpSplit.x, uImpSplit.y, lit ) * mid;
  vec3 k = vec3( 0.57735 );
  outgoingLight = max( outgoingLight * cos( th ) + cross( k, outgoingLight ) * sin( th ) + k * dot( k, outgoingLight ) * ( 1.0 - cos( th ) ), 0.0 );
  #ifdef SPL_ATMOS
    outgoingLight = max( mix( vec3( dot( outgoingLight, vec3( 0.2126, 0.7152, 0.0722 ) ) ), outgoingLight, uAtmVegGrade.w ), 0.0 ) * uAtmVegGrade.rgb;
    #ifdef SPL_FOG
      outgoingLight = atmosAerial( outgoingLight, vSplW );
    #endif
  #endif
  vSplCol = outgoingLight;
}
#endif
`;

/** the mesh ↔ splat crossfade (same complementary mask as foliage-material F_FADE / the impostors) */
const F_FADE = /* glsl */ `
{
  float a = abs( vSplVis.x );
  if ( a < 1.0 ) {
    vec2 p = gl_FragCoord.xy + ( uVegTemporal.x > 0.5 ? 5.588238 * mod( uVegTemporal.y, 64.0 ) : 0.0 );
    float d = fract( 52.9829189 * fract( 0.06711056 * p.x + 0.00583715 * p.y ) );
    if ( vSplVis.x < 0.0 ) d = 1.0 - d;
    if ( a <= d ) discard;
  }
}
`;

/** what lod.ts SpeciesPool writes into (the impostor link): slot map + per-instance fade */
export class SplatGroup implements ImpTarget {
  n = 0;
  slot = new Int32Array(0);
  F = new Float32Array(0);
  cmap = new Int32Array(0);
  cF = new Float32Array(0);
  lo = 1 << 30; hi = -1; clo = 1 << 30; chi = -1;
  dirty = true;
  flush() { if (this.hi >= this.lo) this.dirty = true; this.lo = this.clo = 1 << 30; this.hi = this.chi = -1; }
}

interface SpeciesEntry { sp: Species; index: number }
interface Level { pts: THREE.Points; buf: THREE.InstancedInterleavedBuffer; list: Float32Array; ids: Int32Array; n: number; mat: THREE.MeshBasicMaterial; dirtyLo: number; dirtyHi: number }

const F2U = new Float32Array(1), U2 = new Uint32Array(F2U.buffer);
const fbits = (v: number) => { F2U[0] = v; return U2[0]; };
/** float → IEEE half bits */
function half(v: number): number {
  F2U[0] = v; const x = U2[0];
  const sign = (x >>> 16) & 0x8000, exp = (x >>> 23) & 0xff, mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00;
  let e = exp - 127 + 15;
  if (e >= 31) return sign | 0x7bff;
  if (e <= 0) { if (e < -10) return sign; const m = (mant | 0x800000) >> (1 - e); return sign | ((m + 0x1000) >> 13); }
  const h = sign | (e << 10) | ((mant + 0x1000) >> 13);
  return h;
}
const half2 = (a: number, b: number) => (half(a) | (half(b) << 16)) >>> 0;
const unorm8 = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));

export class SplatSet {
  built = false;
  building = false;
  readonly group = new SplatGroup();
  readonly U = SPLAT_TUNE;
  /** stats for probes */
  stats: Record<string, unknown> = {};
  pools: SpeciesPool[] = [];
  private species: SpeciesEntry[] = [];
  private spIndex = new Map<Species, number>();
  private dataTex: THREE.DataTexture | null = null;
  private fadeTex: THREE.DataTexture | null = null;
  private levels: Level[] = [];
  private shadowPts: THREE.Points | null = null;
  /** per master slot: the instance record (aI0 … aI3) and bounding centre + boundR · scale */
  private rec = new Float32Array(0);
  private ctr = new Float32Array(0);
  private cellS = new Int32Array(GRID * GRID + 1);
  private cellY0 = new Float32Array(GRID * GRID); private cellY1 = new Float32Array(GRID * GRID);
  private visCells: number[] = [];
  private frustum = new THREE.Frustum();
  private cullCam = new THREE.PerspectiveCamera();
  private lastPos = new THREE.Vector3(Infinity, 0, 0);
  private lastDir = new THREE.Vector3();
  private lastFocal = 0;
  private lastSel = -1e9;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private stride: number;
  private readonly LV: number[];
  private BOUNDS: number[] = [];
  private dens = DENSITY0;
  /** the understory's far shrink-out (lod.ts ImpostorSet.underFar's rule): reach for a ground-level eye, m (0 = none) */
  underFar = 0;
  private farBand = new THREE.Vector2(0, 0);
  private setBounds() { this.BOUNDS.length = 0; for (let l = 0; l < this.LV.length - 1; l++) this.BOUNDS.push(Math.sqrt(this.LV[l] / this.dens)); }
  roadAt: ((x: number, z: number) => { dx: number; dz: number; d: number }) | null = null;
  /** atmos' API (shared uniforms + GLSL for custom shaders) — set by the veg system */
  atmos: (() => { uniforms?: Record<string, THREE.IUniform>; glsl?: string } | undefined) | null = null;
  /** probes: draw no splats at all (perf attribution) */
  hide = false;
  /** Main-view selection height (px). Offscreen draws only change the per-pass shader uniform. */
  vpH = 900;
  timing = { sel: 0, selMax: 0, bakeMs: 0, captureMs: 0, workerMs: 0, lastCapture: 0, lastWorker: 0, startAt: 0 };

  constructor(readonly scene: THREE.Scene, readonly o: { name: string; levels: number[]; shadow: boolean } = { name: "big", levels: SPLAT_LEVELS, shadow: true }) {
    this.LV = o.levels;
    this.stride = this.LV.reduce((a, b) => a + b, 0);
    this.setBounds();
    this.uniforms = {
      uSplFar: { value: this.farBand },
      uSplData: { value: null }, uSplFade: { value: null },
      uSplSp: { value: Array.from({ length: MAXSP * 6 }, () => new THREE.Vector4()) },
      uSplVp: { value: new THREE.Vector2(1600, 900) }, uSplStride: { value: this.stride },
      uFadeNow: VEG_UNIFORMS.uFadeNow, uTime: VEG_UNIFORMS.uTime, uWind: VEG_UNIFORMS.uWind, uCamPos: VEG_UNIFORMS.uCamPos,
      uSunDir: VEG_UNIFORMS.uSunDir, uGrade: VEG_UNIFORMS.uGrade, uSunTint: VEG_UNIFORMS.uSunTint, uShadeTint: VEG_UNIFORMS.uShadeTint,
      uVegTemporal: VEG_UNIFORMS.uVegTemporal,
      ...VEG_LIGHT, ...IMP_GRADE, ...SPLAT_TUNE,
    };
  }

  /** bake every big impostor species (textures loaded) — async: capture on the GPU, cluster in workers */
  async build(renderer: THREE.WebGLRenderer, pools: SpeciesPool[]): Promise<void> {
    if (this.building || this.built) return;
    this.building = true;
    const t0 = performance.now();
    this.timing.startAt = Math.round(t0);
    this.pools = pools;
    this.vpH = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
    for (const p of pools) if (!this.spIndex.has(p.sp)) { this.spIndex.set(p.sp, this.species.length); this.species.push({ sp: p.sp, index: this.species.length }); }
    if (this.species.length > MAXSP) throw new Error(`veg splats: ${this.species.length} species > ${MAXSP}`);
    const res = flag("splres");
    const opts = { res, levels: this.LV, spread: flag("splspread"), thick: flag("splthick") };
    // workers (up to 4 in parallel); the main thread captures the next species while they cluster
    const nW = typeof Worker === "undefined" ? 0 : Math.min(4, Math.max(1, (navigator.hardwareConcurrency ?? 4) - 2));
    const workers: Worker[] = [];
    try { for (let i = 0; i < nW; i++) workers.push(new Worker(new URL("./splat-worker.ts", import.meta.url), { type: "module" })); }
    catch (e) { console.warn("veg splats: no worker, clustering on the main thread", e); }
    const busy = new Set<number>();
    const waiters: Array<() => void> = [];
    const runOn = (inp: SplatBuildInput): Promise<SplatBuildOutput> => new Promise((res2, rej) => {
      if (!workers.length) { try { res2(buildSplats(inp)); } catch (e) { rej(e); } return; }
      const go = () => {
        const k = workers.findIndex((_, i) => !busy.has(i));
        if (k < 0) { waiters.push(go); return; }
        busy.add(k);
        const w = workers[k];
        w.onmessage = (e: MessageEvent<{ ok: boolean; out?: SplatBuildOutput; error?: string }>) => {
          busy.delete(k); waiters.shift()?.();
          if (e.data.ok && e.data.out) res2(e.data.out); else rej(new Error(e.data.error));
        };
        w.onerror = (e) => { busy.delete(k); waiters.shift()?.(); rej(new Error(e.message)); };
        w.postMessage(inp, [inp.rgba.buffer, inp.nd.buffer]);
      };
      go();
    });
    const outs: Promise<SplatBuildOutput>[] = [];
    let capMs = 0;
    try {
      // captures render + read back synchronously; at most 8 wait for a worker (each holds ~16 MB of pixels)
      const inflight: Promise<void>[] = [];
      let hits = 0;
      // the fine levels (≥ NEAR_N splats — the ones shown around the swap distance) are captured from the LOD1 mesh the
      // splat tree swaps with; the coarse ones (far away, a few pixels per splat) from the full LOD0 tree — LOD1's sparse
      // crown cards thin out to see-through specks from the air
      const near = this.LV.filter((n) => n >= NEAR_N), far = this.LV.filter((n) => n < NEAR_N);
      const jobs: Array<{ src: "lod0" | "lod1"; levels: number[] }> = [];
      if (near.length) jobs.push({ src: "lod1", levels: near });
      if (far.length) jobs.push({ src: "lod0", levels: far });
      // (every cache lookup at once: one by one they queued behind the load's other work, ~4 s for 32 hits)
      const o2s = jobs.map((j) => ({ ...opts, levels: j.levels, res: j.src === "lod0" ? Math.round(opts.res * 0.75) : opts.res }));
      const keys = this.species.map((e) => jobs.map((j, ji) => splatKey(e.sp, { ...o2s[ji], src: j.src })));
      const cached = await Promise.all(keys.map((ks) => Promise.all(ks.map((k) => cacheGet(k)))));
      for (const e of this.species) {
        const parts: Promise<SplatBuildOutput>[] = [];
        for (let ji = 0; ji < jobs.length; ji++) {
          const j = jobs[ji];
          // (the far levels' fine voxels are coarser: a 192 px capture resolves them)
          const o2 = o2s[ji];
          const key = keys[e.index][ji];
          const hit = cached[e.index][ji];
          if (hit) { parts.push(Promise.resolve(hit)); hits++; continue; }
          const tc = performance.now();
          const c = captureSpecies(renderer, e.sp, o2, j.src);
          capMs += performance.now() - tc;
          let done!: (o: SplatBuildOutput) => void, fail!: (err: unknown) => void;
          parts.push(new Promise<SplatBuildOutput>((r1, r2) => { done = r1; fail = r2; }));
          const job = c.then((inp) => { this.timing.lastCapture = Math.round(performance.now() - t0); return runOn(inp); }).then((o) => { this.timing.lastWorker = Math.round(performance.now() - t0); void cachePut(key, o); done(o); }, fail);
          inflight.push(job);
          if (inflight.length >= 8) await inflight.shift();
        }
        outs[e.index] = Promise.all(parts).then((ps) => {
          const data = new Float32Array(ps.reduce((a, q) => a + q.data.length, 0));
          let off = 0; for (const q of ps) { data.set(q.data, off); off += q.data.length; }
          return { id: ps[0].id, data, levels: ps.flatMap((q) => q.levels), used: ps.flatMap((q) => q.used), ms: ps.reduce((a, q) => a + q.ms, 0), msAcc: ps.reduce((a, q) => a + (q.msAcc ?? 0), 0), nf: ps.reduce((a, q) => a + (q.nf ?? 0), 0) };
        });
      }
      await Promise.all(inflight);
      this.stats.cacheHits = hits;
      const res3 = await Promise.all(outs);
      this.timing.captureMs = Math.round(capMs);
      this.timing.workerMs = res3.reduce((a, o) => a + o.ms, 0);
      this.stats.acc = res3.map((o) => [o.id, o.ms, o.msAcc, o.nf]);
      this.stats.used = Object.fromEntries(res3.map((o) => [o.id, o.used]));
      this.makeTextures(res3);
      this.makeMeshes();
    } finally { for (const w of workers) w.terminate(); this.building = false; }
    this.built = true;
    this.refresh(true);
    this.timing.bakeMs = Math.round(performance.now() - t0);
  }

  private makeTextures(outs: SplatBuildOutput[]) {
    const nSp = this.species.length;
    const texels = nSp * this.stride * 2;
    const h = Math.ceil(texels / SPLAT_W);
    const data = new Uint32Array(SPLAT_W * h * 4);
    outs.forEach((o, si) => {
      const n = o.data.length / SPLAT_FLOATS;
      for (let k = 0; k < n; k++) {
        const s = k * SPLAT_FLOATS, q = (si * this.stride + k) * 8, d = o.data;
        data[q] = fbits(d[s]); data[q + 1] = fbits(d[s + 1]); data[q + 2] = fbits(d[s + 2]);
        data[q + 3] = ((d[s + 15] << 8) | unorm8(d[s + 3])) >>> 0;
        data[q + 4] = half2(d[s + 4], d[s + 5]); data[q + 5] = half2(d[s + 6], d[s + 7]); data[q + 6] = half2(d[s + 8], d[s + 9]);
        const tag = (Math.min(15, Math.floor(d[s + 10] * 16)) << 4) | Math.round(Math.max(0, Math.min(1, d[s + 11])) * 15);
        data[q + 7] = (unorm8(Math.sqrt(Math.max(0, d[s + 12]))) | (unorm8(Math.sqrt(Math.max(0, d[s + 13]))) << 8) | (unorm8(Math.sqrt(Math.max(0, d[s + 14]))) << 16) | (tag << 24)) >>> 0;
      }
    });
    this.dataTex = new THREE.DataTexture(data, SPLAT_W, h, THREE.RGBAIntegerFormat, THREE.UnsignedIntType);
    this.dataTex.internalFormat = "RGBA32UI";
    this.dataTex.minFilter = this.dataTex.magFilter = THREE.NearestFilter; this.dataTex.generateMipmaps = false; this.dataTex.needsUpdate = true;
    this.uniforms.uSplData.value = this.dataTex;
    // species parameters: centre + radius | trans, fill, wrap, envK | trans colour | crown footprint | height, sway
    const P = this.uniforms.uSplSp.value as THREE.Vector4[];
    for (const { sp, index } of this.species) {
      let leaf = sp.parts[0];
      for (const p of sp.parts) if (vegUniforms(p.mats).uTrans.value > vegUniforms(leaf.mats).uTrans.value) leaf = p;
      const L = vegUniforms(leaf.mats);
      const cf = crownFootprint(sp.kind, sp.variant) ?? { x: 0, z: 0, r: sp.radius };
      const b = index * 6;
      P[b].set(sp.center.x, sp.center.y, sp.center.z, sp.boundR);
      P[b + 1].set(L.uTrans.value * 0.8, L.uFill.value, L.uWrap.value, leaf.mats.mat.envMapIntensity);
      P[b + 2].set(L.uTransColor.value.r, L.uTransColor.value.g, L.uTransColor.value.b, sp.kind === "palm" || sp.kind === "palm-leaning" ? 1.35 : 1.06);
      P[b + 3].set(cf.x, cf.z, sp.height, cf.r);
      const lu = leaf.mats.mat.userData.veg as { uShadowLift?: { value: number } };
      const palm = sp.kind === "palm" || sp.kind === "palm-leaning";
      P[b + 4].set(L.uHeight.value, L.uSway.value, palm ? 1.18 : 1, lu.uShadowLift?.value ?? 0);
      // back-face sun response (foliage-material RE_Direct_Veg: palm fronds 0.72, thin leaves 0.42, crown clumps 0)
      // the LOD1 bark's vertex-colour darkening vs the captured geometry (1 when the capture is LOD1 itself; ?splsrc=lod0:
      // canopy darken() — jungle 0.55, mangrove 0.7)
      let l0 = 0, l1 = 0;
      for (const part of sp.parts) {
        if (vegUniforms(part.mats).uTrans.value > 0.3) continue;
        const m = (g: THREE.BufferGeometry) => { const c = g.attributes.color as THREE.BufferAttribute | undefined; if (!c) return 0; let a = 0; for (let i = 0; i < c.count; i++) a += c.getX(i) + c.getY(i) + c.getZ(i); return a / Math.max(1, c.count); };
        l0 += m(part.lod1); l1 += m(part.lod1);
      }
      const barkK = l0 > 0 && l1 > 0 ? Math.min(1.2, Math.max(0.3, l1 / l0)) : 1;
      P[b + 5].set((leaf.mats.mat.userData.vegBackSun as number | undefined) ?? 0, barkK, (leaf.mats.mat.userData.vegSenesce as number | undefined) ?? 0, 0);
    }
  }

  private bandOf(level: number, v = new THREE.Vector4()) {
    const B = this.BOUNDS, up = level > 0 ? B[level - 1] : 0, low = level < B.length ? B[level] : 0;
    return v.set(up * BAND_LO, up * BAND_HI, low * BAND_LO, low * BAND_HI);
  }
  private bands: THREE.Vector4[] = [];
  /** live tuning: splats per px² of projected radius (more = finer levels at the same size) */
  setDensity(c: number) {
    this.dens = c; this.setBounds();
    this.bands.forEach((v, l) => this.bandOf(l, v));
    this.lastSel = -1e9;
  }
  get density() { return this.dens; }
  /** the quality tier's factor on the default density (VegSystem.setQuality) */
  setDensityK(k: number) { this.setDensity(DENSITY0 * k); }

  private material(level: number, shadow: boolean): THREE.MeshBasicMaterial {
    const off = this.LV.slice(0, level).reduce((a, b) => a + b, 0);
    const band = this.bands[level] ?? (this.bands[level] = this.bandOf(level));
    const own = {
      uSplLevelOff: { value: off },
      uSplBand: { value: shadow ? new THREE.Vector4() : band },
    };
    const U = this.uniforms;
    const defs = `#define VEG_FADE_T ${VEG_FADE_T.toFixed(3)}\n` + (shadow ? "#define SPL_SHADOW\n" : "");
    const patchV = (vs: string) => defs + vs
      .replace("#include <common>", "#include <common>\n" + V_PARS)
      .replace("#include <begin_vertex>", V_BODY)
      .replace("#include <project_vertex>", "#include <project_vertex>\n" + V_POINT);
    if (shadow) {
      const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }) as unknown as THREE.MeshBasicMaterial;
      m.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, U, own);
        sh.vertexShader = patchV(sh.vertexShader);
        sh.fragmentShader = defs + sh.fragmentShader
          .replace("#include <common>", "#include <common>\n" + F_PARS + "\n")
          .replace("#include <clipping_planes_fragment>", F_ALPHA + "\n#include <clipping_planes_fragment>");
      };
      m.customProgramCacheKey = () => "veg-impostor-splat-depth";
      return m;
    }
    const atm = this.atmos?.();
    const DBG = flag("spldbg");
    const adefs = (atm?.glsl && atm.uniforms && !DBG.includes("noatm") ? "#define SPL_ATMOS\n" + (this.scene.fog && !DBG.includes("nofog") ? "#define SPL_FOG\n" : "") + (DBG.includes("nofar") ? "#define SPL_NOFAR\n" : "") : "");
    const m = new THREE.ShaderMaterial({
      uniforms: { ...U, ...own, ...(adefs ? atm!.uniforms : {}) },
      vertexShader: defs + adefs + "#include <common>\n" + V_PARS + (adefs ? atm!.glsl : "") + `
void main() {
${V_BODY}
  vec4 mvPosition = viewMatrix * vec4( transformed, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
${V_POINT}
${V_LIGHT}
}`,
      fragmentShader: defs + "#include <common>\n" + F_PARS + `
void main() {
${F_ALPHA}
${F_FADE}
  gl_FragColor = vec4( vSplCol, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    }) as unknown as THREE.MeshBasicMaterial;
    m.customProgramCacheKey = () => "veg-impostor-splat";
    return m;
  }

  private geometry(level: number, buf: THREE.InstancedInterleavedBuffer, count: number): THREE.InstancedBufferGeometry {
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(this.LV[level] * 3), 3));
    for (let k = 0; k < 4; k++) geo.setAttribute(`aI${k}`, new THREE.InterleavedBufferAttribute(buf, 4, k * 4));
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    return geo;
  }

  private makeMeshes() {
    for (let L = 0; L < this.LV.length; L++) {
      const list = new Float32Array(REC * 256);
      const buf = new THREE.InstancedInterleavedBuffer(list, REC); buf.setUsage(THREE.DynamicDrawUsage);
      const mat = this.material(L, false);
      const pts = new THREE.Points(this.geometry(L, buf, 0), mat);
      pts.frustumCulled = false;
      pts.name = `veg:impostor:splat-${this.o.name}:L${L}`;
      pts.castShadow = false; pts.receiveShadow = false;
      pts.userData.castShadow = false; pts.userData.farShadow = false;
      pts.renderOrder = 1;
      pts.visible = false;
      // Water's 4096² coverage bake also visits these Points. Its viewport must never become the next main-view LOD input.
      pts.onBeforeRender = (r) => { r.getCurrentViewport(VP4); (this.uniforms.uSplVp.value as THREE.Vector2).set(VP4.z, VP4.w); };
      this.scene.add(pts);
      this.levels.push({ pts, buf, list, ids: new Int32Array(256).fill(-1), n: 0, mat, dirtyLo: Infinity, dirtyHi: -1 });
    }
  }

  /** (re)fill the instance records + fade texture from the pools; links the pools (lod.ts SpeciesPool.imp) */
  refresh(force = false) {
    if (!this.built) return;
    if (!force && !this.pools.some((p) => p.impDirty)) return;
    const g = this.group;
    let n = 0;
    for (const p of this.pools) { n += p.n; p.impDirty = false; }
    g.n = n;
    // cell-sorted master order (64 m cells)
    const cl = (v: number) => Math.min(GRID - 1, Math.max(0, Math.floor((v + GRID_HALF) / CELL)));
    const cellOf = new Int32Array(n), cnt = new Int32Array(GRID * GRID + 1);
    this.cellY0.fill(1e9); this.cellY1.fill(-1e9);
    let o = 0;
    for (const p of this.pools) {
      for (let i = 0; i < p.n; i++) {
        const k = cl(p.ctr[i * 4 + 2]) * GRID + cl(p.ctr[i * 4]);
        cellOf[o + i] = k; cnt[k + 1]++;
        const r = p.ctr[i * 4 + 3];
        this.cellY0[k] = Math.min(this.cellY0[k], p.ctr[i * 4 + 1] - r); this.cellY1[k] = Math.max(this.cellY1[k], p.ctr[i * 4 + 1] + r);
      }
      o += p.n;
    }
    for (let k = 0; k < GRID * GRID; k++) cnt[k + 1] += cnt[k];
    this.cellS.set(cnt);
    const fillAt = cnt.slice(0, GRID * GRID);
    g.slot = new Int32Array(n);
    for (let j = 0; j < n; j++) g.slot[j] = fillAt[cellOf[j]]++;
    const fh = Math.max(1, Math.ceil(n / FADE_W));
    g.F = new Float32Array(FADE_W * fh * 2);
    g.cmap = new Int32Array(n).fill(-1); g.cF = new Float32Array(2);
    this.ctr = new Float32Array(n * 4);
    const rec = this.rec = new Float32Array(Math.max(1, n) * REC);
    o = 0;
    for (const p of this.pools) {
      const si = this.spIndex.get(p.sp) ?? 0;
      for (let i = 0; i < p.n; i++) {
        const ms = g.slot[o + i], b = ms * REC, w = p.raw, c = p.col;
        rec[b] = w[i * 5]; rec[b + 1] = w[i * 5 + 1]; rec[b + 2] = w[i * 5 + 2]; rec[b + 3] = w[i * 5 + 3];
        rec[b + 4] = w[i * 5 + 4]; rec[b + 5] = si; rec[b + 6] = ms;
        const r = c[i * 3];
        rec[b + 8] = r - 8 * Math.floor(r / 8); rec[b + 9] = c[i * 3 + 1]; rec[b + 10] = c[i * 3 + 2];
        // canopy occlusion (detail-gen encodeOcc: 8 · (1 + q) on the red tint, q = 0..30 → 0..0.7)
        { const qo = Math.floor(r / 8); rec[b + 11] = qo > 0 ? ((qo - 1) / 30) * 0.7 : 0; }
        rec[b + 14] = 999;
        if (this.roadAt) { const q = this.roadAt(w[i * 5], w[i * 5 + 2]); if (q.d < 60) { rec[b + 12] = q.dx; rec[b + 13] = q.dz; rec[b + 14] = q.d; } }
        this.ctr[ms * 4] = p.ctr[i * 4]; this.ctr[ms * 4 + 1] = p.ctr[i * 4 + 1]; this.ctr[ms * 4 + 2] = p.ctr[i * 4 + 2];
        this.ctr[ms * 4 + 3] = p.sp.boundR * w[i * 5 + 4];
        p.impFade(i, g.F, ms * 2);
      }
      p.imp = { g, offset: o };
      o += p.n;
    }
    this.fadeTex?.dispose();
    this.fadeTex = new THREE.DataTexture(g.F, FADE_W, fh, THREE.RGFormat, THREE.FloatType);
    this.fadeTex.minFilter = this.fadeTex.magFilter = THREE.NearestFilter; this.fadeTex.generateMipmaps = false; this.fadeTex.needsUpdate = true;
    this.uniforms.uSplFade.value = this.fadeTex;
    for (let l = 0; l < this.levels.length; l++) {
      const L = this.levels[l];
      // Records changed (including a remapped master slot): invalidate the identity cache. Each level grows only to
      // its actual high-water mark; reserving the entire island at EVERY level wasted CPU and GPU buffer storage.
      L.ids.fill(-1);
    }
    // the far-map / canopy shadow copy: every tree at the shadow level
    if (this.shadowPts) { this.scene.remove(this.shadowPts); this.shadowPts.geometry.dispose(); this.shadowPts = null; }
    if (this.o.shadow) {
      const SHADOW_LEVEL = Math.max(0, this.LV.indexOf(SHADOW_N));
      const pts = new THREE.Points(this.geometry(SHADOW_LEVEL, new THREE.InstancedInterleavedBuffer(rec, REC), n), this.levels[SHADOW_LEVEL].mat);
      pts.customDepthMaterial = this.material(SHADOW_LEVEL, true);
      pts.frustumCulled = false; pts.visible = false;
      pts.castShadow = true; pts.receiveShadow = false;
      pts.userData.castShadow = true; pts.userData.farShadow = "force";
      pts.name = "veg:impostor:splat-shadow";
      pts.onBeforeShadow = (r) => { const gl = r.getContext(); const vp = gl.getParameter(gl.VIEWPORT) as Int32Array; (this.uniforms.uSplVp.value as THREE.Vector2).set(vp[2], vp[3]); };
      this.scene.add(pts);
      this.shadowPts = pts;
    }
    g.dirty = false;
    this.lastSel = -1e9;
  }

  get meshes(): THREE.Object3D[] { return [...this.levels.map((l) => l.pts), ...(this.shadowPts ? [this.shadowPts] : [])]; }
  /** instances drawn per level (probes) */
  get drawn() { return this.levels.map((l) => l.n); }
  /** splats submitted (probes) */
  get points() { return this.levels.reduce((a, l, i) => a + l.n * this.LV[i], 0); }

  /** per frame: fade upload + (when the view / tiers changed) the per-level instance lists */
  update(cam: THREE.PerspectiveCamera, now: number, sceneHeight: number, force = false) {
    if (!this.built) return;
    this.vpH = sceneHeight;
    if (this.underFar > 0) {
      // (the impostor understory's band: its reach grows 8 m per m of eye height above 30 m — a descent sweeps it in)
      const far = Math.min(8000, this.underFar + Math.max(0, cam.position.y - 30) * 8);
      if (Math.abs(far - this.farBand.y) > 20) force = true;
      this.farBand.set(far - Math.max(90, far * 0.25), far);
    }
    const g = this.group;
    let tiers = false;
    if (g.dirty || g.hi >= g.lo) { g.flush(); if (this.fadeTex) this.fadeTex.needsUpdate = true; g.dirty = false; tiers = true; }
    const dir = cam.getWorldDirection(TMPV);
    const focal = (this.vpH * 0.5) / Math.tan((cam.fov * Math.PI) / 360);
    const moved = cam.position.distanceTo(this.lastPos);
    const turned = dir.dot(this.lastDir) < Math.cos((4 * Math.PI) / 180);
    if (!force && !tiers && moved < 3 && !turned && Math.abs(focal - this.lastFocal) < focal * 0.03 && now - this.lastSel < 400) return;
    const t0 = performance.now();
    this.lastPos.copy(cam.position); this.lastDir.copy(dir); this.lastFocal = focal; this.lastSel = now;
    // widened frustum, apex pulled back (a turn of a few degrees or a few metres of travel never uncovers a cell)
    const cc = this.cullCam;
    cc.fov = Math.min(170, cam.fov + 14); cc.aspect = cam.aspect; cc.near = 0.1; cc.far = 9000; cc.updateProjectionMatrix();
    TMPM.makeTranslation(-dir.x * 12, -dir.y * 12, -dir.z * 12).premultiply(cam.matrixWorld);
    cc.matrixWorldInverse.copy(TMPM).invert();
    this.frustum.setFromProjectionMatrix(TMPM.multiplyMatrices(cc.projectionMatrix, cc.matrixWorldInverse));
    const vis = this.visCells; vis.length = 0;
    const px = cam.position.x, py = cam.position.y, pz = cam.position.z;
    for (let kz = 0; kz < GRID; kz++) for (let kx = 0; kx < GRID; kx++) {
      const k = kz * GRID + kx, s0 = this.cellS[k], s1 = this.cellS[k + 1];
      if (s0 === s1) continue;
      const x0 = kx * CELL - GRID_HALF, z0 = kz * CELL - GRID_HALF;
      BOX.min.set(x0 - 25, this.cellY0[k], z0 - 25); BOX.max.set(x0 + CELL + 25, this.cellY1[k], z0 + CELL + 25);
      if (!this.frustum.intersectsBox(BOX)) continue;
      const dx = Math.max(x0, Math.min(px, x0 + CELL)) - px, dz = Math.max(z0, Math.min(pz, z0 + CELL)) - pz;
      vis.push(Math.floor(dx * dx + dz * dz) * 65536 + k);
    }
    vis.sort((a, b) => a - b);
    const L = this.levels, nL = L.length;
    for (const l of L) { l.n = 0; l.dirtyLo = Infinity; l.dirtyHi = -1; }
    const F = g.F, C = this.ctr, R = this.rec;
    // CPU ranges per level (P = projected radius, px): the shader's bands + a margin for the travel until the next pass
    const loK = BAND_LO * 0.93, hiK = BAND_HI * 1.07, N0 = this.LV[0], DENS = this.dens, BOUNDS = this.BOUNDS;
    const farLim = this.farBand.y > 0 ? (this.farBand.y + 40) * (this.farBand.y + 40) : Infinity;
    for (const key of vis) {
      const k = key % 65536, s0 = this.cellS[k], s1 = this.cellS[k + 1];
      for (let i = s0; i < s1; i++) {
        if (F[i * 2 + 1] === 2) continue;           // the mesh tier holds it (settled)
        const dx = C[i * 4] - px, dy = C[i * 4 + 1] - py, dz = C[i * 4 + 2] - pz;
        if (dx * dx + dz * dz > farLim) continue;
        const P = (C[i * 4 + 3] * focal) / Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz));
        // the level this size falls in (level l holds P ≥ √(N_l / DENSITY), N_l = N0 / 2^l → l = ⌈log2(N0 / (DENSITY·P²))⌉) and its
        // neighbours only when inside their CPU margin
        const lf = Math.log2(N0 / (DENS * P * P));
        const lc = Math.min(nL - 1, Math.max(0, Math.ceil(lf - 1e-6)));
        for (let l = Math.max(0, lc - 1); l <= Math.min(nL - 1, lc + 1); l++) {
          const up = l > 0 ? BOUNDS[l - 1] * hiK : Infinity, low = l < nL - 1 ? BOUNDS[l] * loK : 0;
          if (P < low || P > up) continue;
          const e = L[l];
          if (e.n === e.ids.length) {
            const cap = Math.max(256, e.ids.length * 2);
            const list = new Float32Array(cap * REC); list.set(e.list); e.list = list;
            const ids = new Int32Array(cap).fill(-1); ids.set(e.ids); e.ids = ids;
            e.buf = new THREE.InstancedInterleavedBuffer(list, REC); e.buf.setUsage(THREE.DynamicDrawUsage);
            e.pts.geometry.dispose(); e.pts.geometry = this.geometry(l, e.buf, 0);
          }
          // Preserve the exact selected records AND their draw order. No upload when the slot already contains the
          // same immutable record; transitions still update the separate fade texture every time they change.
          if (e.ids[e.n] !== i) {
            const d = e.n * REC, s = i * REC, A = e.list;
            for (let j = 0; j < REC; j++) A[d + j] = R[s + j];
            e.ids[e.n] = i; e.dirtyLo = Math.min(e.dirtyLo, e.n); e.dirtyHi = e.n;
          }
          e.n++;
        }
      }
    }
    for (const l of L) {
      const geo = l.pts.geometry as THREE.InstancedBufferGeometry;
      geo.instanceCount = l.n;
      l.pts.visible = l.n > 0 && !this.hide;
      // Keep unconsumed ranges when a diagnostic hides the draw. Three merges and clears them after GPU upload.
      if (l.dirtyHi >= l.dirtyLo) {
        let lo = l.dirtyLo * REC, hi = (l.dirtyHi + 1) * REC;
        for (const range of l.buf.updateRanges) { lo = Math.min(lo, range.start); hi = Math.max(hi, range.start + range.count); }
        l.buf.clearUpdateRanges(); l.buf.addUpdateRange(lo, hi - lo); l.buf.needsUpdate = true;
      }
    }
    const ms = performance.now() - t0;
    this.timing.sel = ms; this.timing.selMax = Math.max(this.timing.selMax, ms);
  }
}

const VP4 = new THREE.Vector4();
const TMPV = new THREE.Vector3();
const TMPM = new THREE.Matrix4();
const BOX = new THREE.Box3();
