// Post pipeline. ONE full-res shader pass after the scene render; everything else is quarter res or a copy.
//
//   RenderPass        HDR scene into R11G11B10F (4 B/px), projection jittered (Halton 8) when TAA is on
//   AtmosAOPass       1/4 res: contact-weighted SSAO (8/6/4 taps, Alchemy obscurance, small depth bias so 10–20 cm props
//                     ground, per-pixel 4x4 rotation + per-frame rotation) → 4x4 bilateral blur. Reads the scene depth
//                     texture directly. Temporal half rate while the camera is (near) still. No swap.
//   AtmosFinalPass    bloom prefilter (1/4 res: NaN/Inf guard + luminance CAP 8 + soft threshold) into a MIPMAPPED target
//                     (the mip chain is the blur — one pass + a driver mip build instead of 6 blur passes; the final
//                     pass reads 3 mip levels with rotated tent taps); then
//                     the one full-res pass (FINAL_FRAG): TAA resolve in HDR (5-tap cross, Reinhard-YCoCg variance clip,
//                     closest-depth camera reprojection, Catmull-Rom history; the viewmodel < 0.9 m keeps its uv; SKY
//                     pixels — depth 1 — skip the resolve / sharpen / AO) → sharpen → depth-aware AO upsample → bloom →
//                     exposure → tone + OkLab grade + sRGB as ONE 3D-LUT fetch (grade.ts gradeLUT; ?atmos=nolut = the
//                     analytic path it is baked from) → vignette → animated dither.
//                     MRT: location 0 = HDR history (RGBA16F), location 1 = display (RGBA8), blitted to the canvas.
// Flags: ?atmos=notaa (no TAA, straight to screen) · smaa (+SMAA pass, debug) · noao · nobloom · nosharpen · aohalf ·
// aodebug · rgba16 · nolut · hist11. medium: no bloom, 4 AO taps, quarter-res AO. low: scene + the grade pass only.
import * as THREE from "three";
import { EffectComposer, RenderPass, Pass, EffectPass, SMAAEffect, SMAAPreset, EdgeDetectionMode } from "postprocessing";
import type { PostPipeline, Quality, WorldCtx } from "../../engine/engine";
import { atmosFlags, gradeParams, type AtmosState } from "./state";
import { gradeLUT, LUT_GAMMA, LUT_N } from "./grade";
import { toHalf } from "./sky";
import { ATMOS_PARS, type AtmosUniforms } from "./glsl";
import { flag } from "../../flags";
import { onRestore } from "../../engine/res/restore";

const PIXCAP = flag("pixcap");
const MAX_PIXELS: Record<Quality, number> = { ultra: 2560 * 1440, high: 1920 * 1080, medium: 1920 * 1080, low: 1600 * 900 };

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 1.0, 1.0); }`;

/** shared GLSL: depth linearisation + view-position reconstruction from (uv, linear depth) for a (jittered) projection */
const DEPTH_GLSL = /* glsl */ `
uniform float uNear, uFar;
uniform vec4 uProjInfo; // P00, P11, P02, P12 (column-major elements 0, 5, 8, 9)
float linZ(float d) { return uNear * uFar / (uFar - (uFar - uNear) * d); }
vec3 viewAt(vec2 uv, float z) { return vec3((uv * 2.0 - 1.0 + uProjInfo.zw) * z / uProjInfo.xy, -z); }
`;

const mat = (frag: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string | number> = {}) =>
  new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false });

const rt = (w: number, h: number, format: THREE.PixelFormat, type: THREE.TextureDataType = THREE.HalfFloatType, filter: THREE.MagnificationTextureFilter = THREE.LinearFilter) => {
  const t = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), { format, type, minFilter: filter, magFilter: filter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
  t.texture.colorSpace = THREE.NoColorSpace;
  return t;
};

function setProjInfo(v: THREE.Vector4, p: THREE.Matrix4) { const e = p.elements; v.set(e[0], e[5], e[8], e[9]); }

/** draw a fullscreen pass into target: clear first (on a tile GPU the clear becomes the load action — no read-back of the
 *  old contents, the pass overwrites every pixel anyway) */
function draw(renderer: THREE.WebGLRenderer, pass: Pass, target: THREE.WebGLRenderTarget | null) {
  renderer.setRenderTarget(target);
  if (CLEAR_FIRST) renderer.clear(true, false, false);
  const p = pass as unknown as { scene: THREE.Scene; camera: THREE.Camera };
  renderer.render(p.scene, p.camera);
}
let CLEAR_FIRST = false;
(globalThis as unknown as { __atmosClearFirst?: (v: boolean) => void }).__atmosClearFirst = (v) => { CLEAR_FIRST = v; };

// ------------------------------------------------------------------------------------------------------------ AO
const AO_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out highp vec4 oAO;
// always declared: the out target has two attachments, and ANGLE/Metal skips a draw that leaves one unwritten (black AO)
layout(location = 1) out highp vec4 oGI;
#ifdef AO_GI
// GI: the last frame's HDR (TAA history) + the view-projection it was rendered with; x = world radius (m), y = on
uniform sampler2D tHist;
uniform mat4 uPrevVP;
uniform vec2 uGI;
// a GI-only frame counter (advances on every compute, also while the camera is still: the temporal pass
// accumulates the rotating pattern into a clean average)
uniform float uGIFrame;
float ignA(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
// interior occupancy grid (interior.ts)
uniform highp sampler3D uAtmIntVol;
uniform vec4 uAtmIntO;
uniform vec3 uAtmIntInv;
#endif
void outp(vec4 a, vec4 g) {
  oAO = a;
#ifdef AO_GI
  oGI = g;
#else
  oGI = vec4(0.0);
#endif
}
uniform highp sampler2D tDepth;
uniform vec2 uFull;
uniform float uRadius, uIntensity, uFrame, uMaxDist, uBias;
uniform mat4 uCamWorld;
// canopy sky visibility (shadows.ts bakeCanopy: a top-down depth map of the vegetation crowns)
uniform highp sampler2DShadow uAtmCanopyMap;
uniform mat4 uAtmCanopyMatrix;
uniform vec4 uAtmCanopyParams; // x = baked, y = fill kept under a closed canopy, z = tap offset (map uv), w = clearance (m)
${DEPTH_GLSL}
${ATMOS_PARS}
varying vec2 vUv;
// sky visibility at world p: the share of 5 PCF taps (centre + 4 at ±z) with no crown more than w metres above p
float canopySky(vec3 p) {
  if (uAtmCanopyParams.x < 0.5) return 1.0;
  vec4 c = uAtmCanopyMatrix * vec4(p.x, p.y + uAtmCanopyParams.w, p.z, 1.0);
  vec3 q = c.xyz / c.w;
  if (any(lessThan(q.xy, vec2(0.0))) || any(greaterThan(q.xy, vec2(1.0)))) return 1.0;
  vec2 o = vec2(uAtmCanopyParams.z, 0.0), o2 = vec2(0.0, uAtmCanopyParams.z); // footprint in map uv
  float lit = texture(uAtmCanopyMap, q) * 0.28 + 0.18 * (texture(uAtmCanopyMap, vec3(q.xy + o, q.z)) + texture(uAtmCanopyMap, vec3(q.xy - o, q.z))
            + texture(uAtmCanopyMap, vec3(q.xy + o2, q.z)) + texture(uAtmCanopyMap, vec3(q.xy - o2, q.z)));
  return mix(uAtmCanopyParams.y, 1.0, lit);
}
#ifdef AO_GI
// ONE-BOUNCE GI: GI_SAMPLES taps in a disc of ~uGI.x metres round the surface (screen-capped),
// each a visible neighbour: its LAST-FRAME radiance (TAA history, reprojected) × the receiver's cosine × the sender's
// cosine (its normal from two depth taps) × a distance falloff. The receiver's own plane gives nothing (cosine 0); the sky
// and the lens give nothing. rgb = irradiance-like; the materials add albedo × it.
vec3 gatherGI(vec3 P, vec3 N, vec2 uv0, float z0, float rot, float jr) {
  if (uGI.y < 0.5 || z0 > 160.0) return vec3(0.0);
  float R = uGI.x * clamp(z0 / 25.0, 1.0, 3.0);
  vec2 rUV = R * uProjInfo.xy * 0.5 / z0;
  float rPix = rUV.y * uFull.y;
  if (rPix < 3.0) return vec3(0.0);
  float kc = min(1.0, (260.0 * uFull.y / 1440.0) / rPix);
  rUV *= kc; R *= kc;
  float R2 = R * R;
  ivec2 fmax = ivec2(uFull) - 1;
  vec3 acc = vec3(0.0);
#ifdef GI_DBG
  vec4 cnt = vec4(0.0);
#endif
  for (int i = 0; i < GI_SAMPLES; i++) {
    float t = (float(i) + jr) / float(GI_SAMPLES);
    float a = rot * 1.37 + 0.9 + float(i) * 2.3999632;
    vec2 uv = uv0 + vec2(cos(a), sin(a)) * sqrt(t) * rUV;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
    ivec2 tc = min(ivec2(uv * uFull), fmax);
    float d = texelFetch(tDepth, tc, 0).r;
    if (d >= 0.99995) continue;
    float zs = linZ(d);
    vec2 uvt = (vec2(tc) + 0.5) / uFull;
    vec3 Vt = viewAt(uvt, zs);
    vec3 v = Vt - P;
    float vv = dot(v, v);
#ifdef GI_DBG
    { vec3 vq = normalize(v); float cq = dot(N, vq); if (cq > 0.05) cnt.x += 1.0; if (cq > 0.05 && vv <= R2 * 2.0) cnt.y += 1.0; cnt.w = max(cnt.w, cq); }
#endif
    if (vv > R2 * 2.0 || vv < 1e-3 || zs < 0.9) continue;
    vec3 vn = v * inversesqrt(vv);
    float cr = dot(N, vn);
    if (cr < 0.05) continue;
#ifdef GI_DBG
    cnt.z += 1.0;
#endif
    // the sender's normal from its depth neighbours (a container's sunlit TOP must not light the ground behind it)
    ivec2 tx = min(tc + ivec2(2, 0), fmax), ty = min(tc + ivec2(0, 2), fmax);
    vec3 Vx = viewAt((vec2(tx) + 0.5) / uFull, linZ(texelFetch(tDepth, tx, 0).r));
    vec3 Vy = viewAt((vec2(ty) + 0.5) / uFull, linZ(texelFetch(tDepth, ty, 0).r));
    vec3 Ns = normalize(cross(Vx - Vt, Vy - Vt));
    if (dot(Ns, Vt) > 0.0) Ns = -Ns;
    float cs = max(dot(Ns, -vn), 0.0);
    if (cs <= 0.0) continue;
    vec4 pc = uPrevVP * (uCamWorld * vec4(Vt, 1.0));
    vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
    if (puv.x < 0.0 || puv.y < 0.0 || puv.x > 1.0 || puv.y > 1.0) continue;
    vec3 L = texture2D(tHist, puv).rgb;
    float l = dot(L, vec3(0.2126, 0.7152, 0.0722));
    L *= min(1.0, 1.0 / max(l, 1e-4)); // no fireflies from glints / emissive bulbs (cap 1.0, not 3 — a lamp bulb stamped copies of itself)
    acc += L * (cr * cs / (1.0 + vv / (0.6 * R2)));
  }
  // (a disc sample stands for ~π R² / N of the neighbourhood: the gain turns the mean into a one-bounce irradiance of the
  // order of L × the neighbour's solid-angle share — calibrated on the harbor container / concrete pair)
#ifdef GI_DBG
  return vec3(cnt.xy / float(GI_SAMPLES), cnt.w) * 0.5;
#endif
  return acc * (7.0 / float(GI_SAMPLES));
}
float occAt(vec3 p, float lod) {
  vec3 t = (p - uAtmIntO.xyz) * uAtmIntInv;
  if (any(lessThan(t, vec3(0.0))) || any(greaterThan(t, vec3(1.0)))) return 0.0;
  return textureLod(uAtmIntVol, t, lod).r;
}
// INTERIOR SKY VISIBILITY: from a surface, 1 straight-up + 5 rising rays (30°, rotated per pixel)
// marched through the POIs' occupancy grid; the share of sky they reach, weighted by the surface's cosine. A floor inside
// a room sees the sky only through its windows / doors; outdoors (nothing above) = 1.
float interiorVis(vec3 W, vec3 Nw, ivec2 hp) {
  if (uAtmIntO.w < 0.5) return 1.0;
  // (no dark scalloped blotches on interior ceilings) a down-facing surface starts its march one
  // and a half voxels into the room's air — at 0.3 m the start point sat on the slab's 0.5 m voxel boundary and the
  // trilinear occupancy there varied along x / z (the scallops)
  vec3 p = W + Nw * (0.3 + 0.45 * max(-Nw.y, 0.0));
  float up = occAt(p + vec3(0.0, 1.2, 0.0), 0.0) + occAt(p + vec3(0.0, 3.0, 0.0), 1.0) + occAt(p + vec3(0.0, 6.0, 0.0), 1.0) + occAt(p + vec3(0.0, 10.0, 0.0), 2.0);
  if (up < 0.03) return 1.0;
  // (a per-pixel, per-compute rotation and two ray elevations alternating (25° / 50°) — the temporal pass averages
  // them: a floor now sees the sky through a WINDOW (the 30°-only rays passed under every sill), a light pool forms inside)
  float rot = 6.2831853 * ignA(vec2(hp) + uGIFrame * 3.1);
  float sum = 0.0, ws = 0.0;
  for (int k = 0; k < 6; k++) {
    float a = rot + float(k) * 1.2566371;
    float se = ((k + int(uGIFrame)) & 1) == 0 ? 0.42 : 0.77, ce = sqrt(1.0 - se * se);
    vec3 d = k == 0 ? vec3(0.0, 1.0, 0.0) : vec3(cos(a) * ce, se, sin(a) * ce);
    float w = max(dot(Nw, d), 0.0) + 0.08;
    float T = 1.0, t = 0.35;
    for (int s = 0; s < 10; s++) {
      float o = occAt(p + d * t, clamp(log2(t * 0.5), 0.0, 2.0));
      T *= 1.0 - min(o * 1.6, 1.0) * 0.9;
      t += 0.35 + t * 0.18;
    }
    sum += T * w; ws += w;
  }
  return sum / ws;
}
#endif
float bayer4(ivec2 p) {
  int i = (p.x & 3) + ((p.y & 3) << 2);
  // 4x4 ordered pattern (0..15)
  const float B[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  return B[i];
}
void main() {
  ivec2 hp = ivec2(gl_FragCoord.xy);
  ivec2 c = hp * AO_SCALE;
  ivec2 fmax = ivec2(uFull) - 1;
  float d0 = texelFetch(tDepth, c, 0).r;
  float z0 = linZ(d0);
  if (d0 > 0.99995) { outp(vec4(1.0, z0, 1.0, 1.0), vec4(0.0, 0.0, 0.0, 1.0)); return; }
  vec2 uv0 = (vec2(c) + 0.5) / uFull;
  vec3 P = viewAt(uv0, z0);
  // B: the cloud-shadow transmission of this surface (the lit materials read it here instead of sampling the tile)
  // A: the sky visibility under the vegetation canopy (else the jungle understory takes the open sky's fill)
  vec3 W = (uCamWorld * vec4(P, 1.0)).xyz;
  float cloud = atmosCloudShadow(W);
  float sky = z0 < 400.0 ? canopySky(W) : 1.0;
  if (z0 > uMaxDist) { outp(vec4(1.0, z0, cloud, sky), vec4(0.0, 0.0, 0.0, 1.0)); return; }
  // normal from the full-res depth: the flatter side in x and y (no smearing across silhouettes)
  float zr = linZ(texelFetch(tDepth, min(c + ivec2(1, 0), fmax), 0).r), zl = linZ(texelFetch(tDepth, max(c - ivec2(1, 0), ivec2(0)), 0).r);
  float zu = linZ(texelFetch(tDepth, min(c + ivec2(0, 1), fmax), 0).r), zd = linZ(texelFetch(tDepth, max(c - ivec2(0, 1), ivec2(0)), 0).r);
  vec2 px = 1.0 / uFull;
  vec3 dx = abs(zr - z0) < abs(z0 - zl) ? viewAt(uv0 + vec2(px.x, 0.0), zr) - P : P - viewAt(uv0 - vec2(px.x, 0.0), zl);
  vec3 dy = abs(zu - z0) < abs(z0 - zd) ? viewAt(uv0 + vec2(0.0, px.y), zu) - P : P - viewAt(uv0 - vec2(0.0, px.y), zd);
  vec3 N = normalize(cross(dx, dy));
  if (dot(N, P) > 0.0) N = -N;
  // world radius grows with distance (a fixed radius left props at ~150 m with no AO at all): 1x to 30 m, 4x at 120 m+
  float R = uRadius * clamp(z0 / 30.0, 1.0, 4.0);
  // screen radius of the world radius (uv units); tiny → nothing to find; huge (a wall at the lens) → capped
  vec2 rUV = R * uProjInfo.xy * 0.5 / z0;
  float rPix = rUV.y * uFull.y;
  if (rPix < 1.5) { outp(vec4(1.0, z0, cloud, sky), vec4(0.0, 0.0, 0.0, 1.0)); return; }
  // cap (no 20-35 px halos in interiors): ~11 px (at 1440p) within ~6 m of the lens, 40 px from
  // ~30 m out (the outdoor views keep their contact AO). The WORLD radius shrinks with the screen kernel, so the
  // range test drops occluders beyond it: a plant 40 cm in front of a wall no longer darkens a band of the wall
  float capPx = mix(AO_CAP_NEAR, AO_CAP, smoothstep(6.0, 30.0, z0)) * uFull.y / 1440.0;
  float kc = min(1.0, capPx / rPix);
  rUV *= kc; R *= kc;
  float R2 = R * R;
  // per-pixel rotation (4x4 pattern, averaged away by the 4x4 blur) + a per-frame offset (TAA accumulates it)
#ifdef AO_ROT2
  // (half res, no blur pass): a 2x2 rotation pattern — the materials' bilinear lookup averages the four rotations —
  // + a per-frame offset the TAA accumulates
  float b2 = float((hp.x & 1) + ((hp.y & 1) << 1));
  float rot = (b2 * 4.0 + mod(uFrame * 5.0, 16.0)) * (6.2831853 / 16.0);
  float jr = fract(b2 * 0.25 + 0.125 + uFrame * 0.618034);
#else
  float rot = (bayer4(hp) + uFrame * 5.0) * (6.2831853 / 16.0);
  float jr = fract(bayer4(hp + ivec2(1, 2)) * 0.0625 + uFrame * 0.618034);
#endif
  float sum = 0.0;
  for (int i = 0; i < AO_SAMPLES; i++) {
    float t = (float(i) + jr) / float(AO_SAMPLES);
    float a = rot + float(i) * 2.3999632;
    // radii biased toward the centre: the contact term (a crate on sand) gets most of the taps
    vec2 o = vec2(cos(a), sin(a)) * (t * t * 0.85 + 0.15 * t);
    vec2 uv = uv0 + o * rUV;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) continue;
    // the tap's position is rebuilt at the depth TEXEL's centre (the offset uv with the nearest texel's depth put
    // the point off the plane by up to half a texel's depth slope — at grazing angles that read as occlusion on flat walls
    // once the near kernel shrank to a few cm)
    ivec2 tc = min(ivec2(uv * uFull), fmax);
    float zs = linZ(texelFetch(tDepth, tc, 0).r);
    vec3 v = viewAt((vec2(tc) + 0.5) / uFull, zs) - P;
    float vv = dot(v, v);
    // Alchemy-style obscurance: (v.n - bias) / |v|² — close occluders weigh most; range-limited (no far halos)
    // bias: only what depth precision needs (1.5 % of the distance was too much — at 8 m a 12 cm stone or a crate's foot
    // produced NO contact occlusion at all: the props did not look grounded)
    // (the bias never exceeds a quarter of the shrunken kernel — near the lens it would cancel every occluder)
    float occ = max(dot(v, N) - min(uBias * z0 + 0.004, 0.25 * R), 0.0) / (vv + 0.02 * R2);
    sum += occ * max(0.0, 1.0 - vv / R2);
  }
  float ao = max(0.0, 1.0 - uIntensity * R * sum / float(AO_SAMPLES));
  ao = mix(1.0, ao * ao, 1.0 - smoothstep(uMaxDist * 0.6, uMaxDist, z0));
#ifdef AO_GI
  vec3 Nw = normalize((uCamWorld * vec4(N, 0.0)).xyz);
  // (an interleaved-gradient rotation per PIXEL + per compute — the 2x2 pattern stamped bright senders as shifted
  // copies and window edges as vertical streaks; the temporal pass averages the rotations)
  float rotG = 6.2831853 * ignA(vec2(hp) + uGIFrame * 5.588238) / 1.37;
  float jrG = fract(ignA(vec2(hp) + vec2(17.0, 43.0)) + uGIFrame * 0.618034);
  outp(vec4(ao, z0, cloud, sky), vec4(gatherGI(P, N, uv0, z0, rotG, jrG), interiorVis(W, Nw, hp)));
#else
  outp(vec4(ao, z0, cloud, sky), vec4(0.0));
#endif
}`;

const AO_BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tAO;
uniform vec2 uHalf;
// writes the two-attachment out target: both outputs, or ANGLE/Metal drops the draw (medium/low AO went black)
layout(location = 0) out highp vec4 oAO;
layout(location = 1) out highp vec4 oGI;
void main() {
  oGI = vec4(0.0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 hmax = ivec2(uHalf) - 1;
  vec4 c = texelFetch(tAO, p, 0);
  float tol = 0.04 * c.y + 0.05;
  vec3 s = vec3(0.0); float w = 0.0;
  // 4x4 window (-2..1): exactly one period of the rotation pattern → noise-free; content shifts by half a texel,
  // which the materials' lookup compensates (uAtmAOSize.z)
  for (int y = -2; y <= 1; y++) for (int x = -2; x <= 1; x++) {
    vec4 t = texelFetch(tAO, clamp(p + ivec2(x, y), ivec2(0), hmax), 0);
    float k = max(0.0, 1.0 - abs(t.y - c.y) / tol);
    s += t.xzw * k; w += k;
  }
  oAO = w > 1e-3 ? vec4(s.x / w, c.y, s.y / w, s.z / w) : c;
}`;

// depth-aware SEPARABLE blur of the GI + interior terms (the gather's 2x2 rotation pattern and 8 taps leave a
// regular dot pattern): 5 taps per axis with weights (.5, 1, 1, 1, .5) — both phases of the 2x2 pattern weigh exactly
// the same, so it cancels — × depth agreement
const GI_BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tGI, tAO;
uniform vec2 uHalf, uDir;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), mx = ivec2(uHalf) - 1, d = ivec2(uDir);
  float z = texelFetch(tAO, p, 0).g;
  float tol = 0.03 * z + 0.08;
  vec4 s = vec4(0.0); float w = 0.0;
  for (int i = -2; i <= 2; i++) {
    ivec2 q = clamp(p + d * i, ivec2(0), mx);
    float k = (i == -2 || i == 2 ? 0.5 : 1.0) * max(0.0, 1.0 - abs(texelFetch(tAO, q, 0).g - z) / tol);
    s += texelFetch(tGI, q, 0) * k; w += k;
  }
  gl_FragColor = w > 1e-4 ? s / w : texelFetch(tGI, p, 0);
}`;

// TEMPORAL accumulation of the GI (half res): the blurred GI of this compute blended into the reprojected
// history (the view-projection of the previous compute; a history whose depth disagrees is dropped). Out 0 = what the
// materials read (rgb GI, a = interior visibility), out 1 = the next history (rgb GI, a = view depth).
const GI_TEMP_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out highp vec4 oGI;
layout(location = 1) out highp vec4 oHist;
uniform sampler2D tCur, tHistGI, tAO, tPrevOut;
uniform mat4 uCamWorld, uPrevVP;
uniform vec4 uProjInfo;
uniform vec2 uHalf;
uniform float uAlphaT;
vec3 viewAtT(vec2 uv, float z) { return vec3((uv * uProjInfo.xy - uProjInfo.zw) * z, -z); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), mx = ivec2(uHalf) - 1;
  vec4 cur = texelFetch(tCur, p, 0);
  float z = texelFetch(tAO, p, 0).g;
  vec3 lo = cur.rgb, hi = cur.rgb;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 q = texelFetch(tCur, clamp(p + ivec2(i, j), ivec2(0), mx), 0).rgb; lo = min(lo, q); hi = max(hi, q);
  }
  vec3 ext = hi - lo;
  lo -= ext + 0.002; hi += ext + 0.002;
  vec2 uv = (vec2(p) + 0.5) / uHalf;
  vec4 W = uCamWorld * vec4(viewAtT(uv, z), 1.0);
  vec4 pc = uPrevVP * W;
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  float a = uAlphaT;
  vec3 res = cur.rgb;
  float intr = cur.a;
  if (a < 0.999 && pc.w > 0.0 && all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) {
    vec4 h = texture(tHistGI, puv);
    if (abs(h.a - pc.w) < 0.04 * pc.w + 0.1) {
      res = mix(clamp(h.rgb, lo, hi), cur.rgb, a);
      intr = mix(texture(tPrevOut, puv).a, cur.a, max(a, 0.08));
    }
  }
  oGI = vec4(res, intr);
  oHist = vec4(res, z);
}`;

class AtmosAOPass extends Pass {
  readonly raw = rt(1, 1, THREE.RGBAFormat, THREE.HalfFloatType, THREE.NearestFilter);
  /** the blurred AO (R) + depth (G) + cloud shadow (B) the MATERIALS read in the next frame (glsl.ts atmosSS): linear
   *  filtering for the one-fetch path */
  readonly out = (() => {
    // two attachments — 0 = (ao, depth, cloud, sky), 1 = (GI rgb, interior sky visibility)
    const t = new THREE.WebGLRenderTarget(1, 1, { count: 2, format: THREE.RGBAFormat, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
    for (const x of t.textures) x.colorSpace = THREE.NoColorSpace;
    return t;
  })();
  /** GI + interior visibility (needs the TAA history; half-res no-blur path only) */
  gi: boolean;
  /** the blurred GI + interior terms the materials read */
  readonly giOut = rt(1, 1, THREE.RGBAFormat, THREE.HalfFloatType, THREE.LinearFilter);
  private giTmp = rt(1, 1, THREE.RGBAFormat, THREE.HalfFloatType, THREE.NearestFilter);
  /** the GI temporal accumulation, ping-pong MRT targets: textures[0] = what the materials read, [1] = history */
  private giTemp = [0, 1].map(() => {
    const t = new THREE.WebGLRenderTarget(1, 1, { count: 2, format: THREE.RGBAFormat, type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
    for (const x of t.textures) x.colorSpace = THREE.NoColorSpace;
    return t;
  });
  private giTempI = 0;
  private giTempMat = (() => {
    const m = mat(GI_TEMP_FRAG, { tCur: { value: null }, tHistGI: { value: null }, tAO: { value: null }, tPrevOut: { value: null }, uCamWorld: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() }, uProjInfo: { value: new THREE.Vector4() }, uHalf: { value: new THREE.Vector2() }, uAlphaT: { value: 1 } });
    m.glslVersion = THREE.GLSL3;
    return m;
  })();
  private giPrevVP = new THREE.Matrix4();
  private giFrame = 0;
  private giStill = 0;
  private giBlurMat = mat(GI_BLUR_FRAG, { tGI: { value: null }, tAO: { value: null }, uHalf: { value: new THREE.Vector2() }, uDir: { value: new THREE.Vector2(1, 0) } });
  /** the TAA history of the last frame (AtmosFinalPass) and the view-projection it was rendered with */
  histTex: (() => THREE.Texture | null) | null = null;
  prevVP: THREE.Matrix4 | null = null;
  /** the camera did not move: the AO / GI rotation pattern holds still (no temporal noise on a static frame) */
  still = false;
  private giRadius = 2.6;
  /** the AO texture holds a valid frame (the materials may read it) */
  valid = false;
  private aoMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  /** the scene depth of this frame (the RenderPass buffer's depth texture), published for the later passes */
  depth: THREE.DepthTexture | null = null;
  frame = 0;

  private samples: number;
  private fullW = 1; private fullH = 1;
  /** at half res the AO is written straight to the lookup texture (2x2 rotation pattern, no blur pass — one render
   *  pass less; the materials' bilinear fetch averages the pattern); ?atmos=aoblur keeps the 4x4 blur */
  get noBlur() { return this.scale === 2 && !atmosFlags().has("aoblur"); }
  constructor(private cam: THREE.PerspectiveCamera, private u: AtmosUniforms, samples: number, radius: number, intensity: number, public scale = 2, gi = false) {
    super("AtmosAOPass");
    this.needsSwap = false;
    this.needsDepthTexture = true;
    this.samples = samples;
    this.gi = gi && scale === 2 && !atmosFlags().has("aoblur");
    this.aoMat = this.makeAO(radius, intensity);
    u.uAtmAO.value = this.out.textures[0];
    u.uAtmGI.value = this.giOut.texture;
    this.giBlurMat.uniforms.tGI.value = this.out.textures[1];
    this.giBlurMat.uniforms.tAO.value = this.out.textures[0];
    u.uAtmGIParams.value.x = this.gi ? 1 : 0;
    // (X − 0.5)/S + 1: the AO texel i sampled full-res pixel S·i, the 4x4 blur (−2..1) moved its content by −½ texel
    u.uAtmAOSize.value.z = this.noBlur ? 0.5 / scale : 1 - 0.5 / scale;
    this.blurMat = mat(AO_BLUR_FRAG, { tAO: { value: this.raw.texture }, uHalf: { value: new THREE.Vector2() } });
    this.blurMat.glslVersion = THREE.GLSL3;
    this.fullscreenMaterial = this.aoMat;
  }

  private makeAO(radius: number, intensity: number, prev?: THREE.ShaderMaterial) {
    const s = this.scale;
    const gi = this.gi && this.noBlur;
    const m = mat(AO_FRAG, {
      ...this.u, uCamWorld: { value: new THREE.Matrix4() },
      tDepth: { value: null }, uFull: { value: new THREE.Vector2(this.fullW, this.fullH) }, uRadius: { value: radius }, uIntensity: { value: intensity },
      uFrame: { value: 0 }, uMaxDist: { value: 320 }, uBias: { value: prev?.uniforms.uBias.value ?? 0.004 }, uNear: { value: 0.1 }, uFar: { value: 1000 }, uProjInfo: { value: new THREE.Vector4() },
      tHist: { value: null }, uPrevVP: { value: new THREE.Matrix4() }, uGI: { value: new THREE.Vector2(this.giRadius, 0) }, uGIFrame: { value: 0 },
    }, { AO_SAMPLES: this.samples, AO_SCALE: s, AO_CAP: "40.0", AO_CAP_NEAR: "11.0", ...(this.noBlur ? { AO_ROT2: 1 } : {}), ...(gi ? { AO_GI: 1, GI_SAMPLES: 8, ...(atmosFlags().has("gidbgcount") ? { GI_DBG: 1 } : {}) } : {}) });
    m.glslVersion = THREE.GLSL3;
    return m;
  }

  /** runtime resolution switch (tools / quality): 2 = half res, 4 = quarter */
  setScale(scale: number) {
    if (scale === this.scale) return;
    const p = this.aoMat;
    this.scale = scale;
    this.aoMat = this.makeAO(p.uniforms.uRadius.value, p.uniforms.uIntensity.value, p);
    p.dispose();
    this.u.uAtmAOSize.value.z = this.noBlur ? 0.5 / scale : 1 - 0.5 / scale;
    this.setSize(this.fullW, this.fullH);
  }

  private lastPos = new THREE.Vector3(1e9, 0, 0);
  private lastQ = new THREE.Quaternion();
  /** this frame reused the last AO (half rate) */
  skipped = false;
  /** frames between AO computes: 2 while the camera moves, 3 while it is still (AtmosPost sets it per frame) */
  period = 2;
  private age = 99;

  render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget) {
    this.depth = inputBuffer.depthTexture;
    const u = this.aoMat.uniforms, c = this.cam;
    // HALF RATE: every other frame reuses the last AO — the materials reproject it through the view-projection it was
    // computed with (exact for the static world; disocclusions take 1.0 for a frame). Jumps (> 2 m, > 10°) recompute.
    // (perf) a STILL camera recomputes every 3rd frame (the reprojection is exact; only moving actors'
    // contact AO lags ≤ 2 frames)
    const jump = c.position.distanceTo(this.lastPos) > 2 || c.quaternion.angleTo(this.lastQ) > 0.17;
    this.age++;
    if (!jump && this.age < this.period && this.valid) { this.skipped = true; this.frame++; return; }
    this.skipped = false;
    this.age = 0;
    this.lastPos.copy(c.position); this.lastQ.copy(c.quaternion);
    u.tDepth.value = this.depth;
    u.uNear.value = c.near; u.uFar.value = c.far;
    c.updateMatrixWorld();
    (u.uCamWorld.value as THREE.Matrix4).copy(c.matrixWorld);
    setProjInfo(u.uProjInfo.value, c.projectionMatrix);
    // (a still camera keeps the rotation pattern: the AO / GI of a static frame do not change between computes)
    if (!this.still) u.uFrame.value = this.frame++ & 1023;
    if (this.gi) {
      const h = this.histTex?.() ?? null;
      u.tHist.value = h;
      if (this.prevVP) (u.uPrevVP.value as THREE.Matrix4).copy(this.prevVP);
      (u.uGI.value as THREE.Vector2).set(this.giRadius, h ? 1 : 0);
      u.uGIFrame.value = this.giFrame & 1023;
    } else if (u.uGI) (u.uGI.value as THREE.Vector2).y = 0;
    this.fullscreenMaterial = this.aoMat;
    if (this.noBlur) {
      draw(renderer, this, this.out);
      if (this.gi) {
        const bu = this.giBlurMat.uniforms;
        this.fullscreenMaterial = this.giBlurMat;
        bu.tGI.value = this.out.textures[1]; bu.uDir.value.set(1, 0); draw(renderer, this, this.giTmp);
        bu.tGI.value = this.giTmp.texture; bu.uDir.value.set(0, 1); draw(renderer, this, this.giOut);
        // temporal accumulation (the rotation pattern changes every compute; a still camera converges to the mean)
        const tu = this.giTempMat.uniforms, prev = this.giTemp[this.giTempI], next = this.giTemp[this.giTempI ^ 1];
        this.giStill = this.still && this.giFrame > 0 ? this.giStill + 1 : 0;
        tu.tCur.value = this.giOut.texture; tu.tHistGI.value = prev.textures[1]; tu.tPrevOut.value = prev.textures[0]; tu.tAO.value = this.out.textures[0];
        (tu.uCamWorld.value as THREE.Matrix4).copy(c.matrixWorld);
        setProjInfo(tu.uProjInfo.value, c.projectionMatrix);
        (tu.uPrevVP.value as THREE.Matrix4).copy(this.giPrevVP);
        tu.uAlphaT.value = this.giFrame === 0 ? 1 : this.giStill > 0 ? Math.max(0.03, 1 / (this.giStill + 4)) : 0.25;
        this.fullscreenMaterial = this.giTempMat;
        draw(renderer, this, next);
        this.giTempI ^= 1;
        this.u.uAtmGI.value = next.textures[0];
        this.giPrevVP.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
        this.giFrame++;
        this.fullscreenMaterial = this.aoMat;
      }
    } else {
      draw(renderer, this, this.raw);
      this.fullscreenMaterial = this.blurMat;
      draw(renderer, this, this.out);
    }
    // the materials of the NEXT frame(s) read this AO through the view-projection it was computed with (jittered: the
    // depth buffer it came from was rendered with it)
    this.u.uAtmAOVP.value.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    this.valid = true;
  }

  /** preset tuning (undefined keeps the tier default) */
  tune(bias?: number, radius?: number, intensity?: number) {
    const u = this.aoMat.uniforms;
    if (bias !== undefined) u.uBias.value = bias;
    if (radius !== undefined) u.uRadius.value = radius;
    if (intensity !== undefined) u.uIntensity.value = intensity;
  }

  setSize(w: number, h: number) {
    this.fullW = w; this.fullH = h;
    const hw = Math.max(1, Math.floor(w / this.scale)), hh = Math.max(1, Math.floor(h / this.scale));
    if (this.noBlur) this.raw.setSize(1, 1); else this.raw.setSize(hw, hh);
    this.out.setSize(hw, hh);
    this.giOut.setSize(hw, hh); this.giTmp.setSize(hw, hh);
    for (const t of this.giTemp) t.setSize(hw, hh);
    this.giTempMat.uniforms.uHalf.value.set(hw, hh);
    this.giFrame = 0; if (this.gi) this.u.uAtmGI.value = this.giOut.texture;
    this.giBlurMat.uniforms.uHalf.value.set(hw, hh);
    this.u.uAtmAOSize.value.x = hw; this.u.uAtmAOSize.value.y = hh;
    this.valid = false; // until the next AO frame (the old content has the old size)
    this.aoMat.uniforms.uFull.value.set(w, h);
    this.blurMat.uniforms.uHalf.value.set(hw, hh);
  }
}

// ----------------------------------------------------------------------------------------------------- composite
const PREFILTER_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform vec2 uTexel;       // full-res texel
uniform float uThreshold, uKnee, uCap;
varying vec2 vUv;
vec3 safe(vec3 c) {
  uvec3 e = floatBitsToUint(c) & uvec3(0x7f800000u);
  return any(equal(e, uvec3(0x7f800000u))) ? vec3(0.0) : clamp(c, 0.0, 6.0e4);
}
vec3 tap(vec2 uv) {
  vec3 c = safe(texture2D(tColor, uv).rgb);
  // luminance CAP: a muzzle flash / sun glint is a small bright spot, not a 600 px orange field
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return c * min(1.0, uCap / max(l, 1e-4));
}
void main() {
  // 4 bilinear taps = a 4x4 box of full-res texels → one quarter-res texel; Karis weights stop fireflies
  vec3 a = tap(vUv + uTexel * vec2(-1.0, -1.0)), b = tap(vUv + uTexel * vec2(1.0, -1.0));
  vec3 c = tap(vUv + uTexel * vec2(-1.0, 1.0)), d = tap(vUv + uTexel * vec2(1.0, 1.0));
  vec4 w = 1.0 / (1.0 + vec4(dot(a, vec3(0.2126, 0.7152, 0.0722)), dot(b, vec3(0.2126, 0.7152, 0.0722)), dot(c, vec3(0.2126, 0.7152, 0.0722)), dot(d, vec3(0.2126, 0.7152, 0.0722))));
  vec3 s = (a * w.x + b * w.y + c * w.z + d * w.w) / (w.x + w.y + w.z + w.w);
  float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
  float k = clamp((l - uThreshold + uKnee) / (2.0 * uKnee), 0.0, 1.0);
  float m = max(k * k * uKnee, l - uThreshold) / max(l, 1e-4); // soft-knee threshold
  gl_FragColor = vec4(s * max(m, 0.0), 1.0);
}`;

// sun VISIBILITY for the lens veil: ONE pixel — 48 depth taps on a Vogel disc (~2.2° radius) round
// the sun's screen position, clamped into the frame (a sun just outside the frame reads the frame edge toward it); sky
// (depth 1) = visible. Blended into a persistent 1x1 target (alpha uBlend: ~8 frames to converge, 1 on a camera cut)
const GLARE_VIS_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tDepth;
uniform vec2 uSun, uDisc;
uniform float uBlend;
void main() {
  float v = 0.0;
  for (int i = 0; i < 48; i++) {
    float r = sqrt((float(i) + 0.5) / 48.0);
    float a = float(i) * 2.3999632;
    vec2 uv = clamp(uSun + vec2(cos(a), sin(a)) * r * uDisc, vec2(0.002), vec2(0.998));
    v += texture2D(tDepth, uv).r >= 1.0 ? 1.0 : 0.0;
  }
  gl_FragColor = vec4(v / 48.0, 0.0, 0.0, uBlend);
}`;

// VOLUMETRIC LIGHT SHAFTS. Quarter res: every pixel marches its view ray
// (20 steps, denser near the lens, a static 4x4 dither — identical every frame, no temporal noise) through the sun's
// shadow: cascade 1 (the 20 cm atlas, trees / roofs / cranes) where the point is inside it, else the static island far
// map. The MEDIUM is what makes the shafts: humid air under the jungle canopy (the canopy map's cover at the camera: a
// closed canopy overhead → dense), the dawn mist (the post fog's height profile), and almost nothing in the open (no
// haze over gameplay). In-scatter = sun × Henyey-Greenstein phase × Σ visibility · density · dt. RGB = in-scatter,
// A = the pixel's linear depth (the final pass upsamples depth-aware).
const SHAFT_FRAG = /* glsl */ `
precision highp float;
uniform highp sampler2D tDepth;
uniform highp sampler2DShadow uAtmFarMap, uAtmCascMap, uAtmCanopyMap;
uniform mat4 uAtmFarMatrix, uAtmCascMatrix, uAtmCascMatrix0, uAtmCanopyMatrix, uCamWorld;
uniform vec4 uAtmFarParams, uAtmCanopyParams;
uniform vec3 uAtmCamPos, uAtmSunDir, uAtmSunColor;
uniform float uAtmSunI, uAtmFogHeight, uPostFog;
uniform vec2 uFull;
// x = density in the open, y = density under a closed canopy, z = share of the post mist's density, w = max distance (m)
uniform vec4 uShaft;
// x = HG g, y = strength, z = cascade on
uniform vec3 uShaft2;
// the in-scatter's soft ceiling (share of a sunlit white card)
uniform float uShaftCap;
${DEPTH_GLSL}
float vis(vec3 p) {
  if (uShaft2.z > 0.5) {
    // cascade 0 first (the near air, ~5 cm texels: sunlight through the leaf gaps = the shafts)
    vec4 c0 = uAtmCascMatrix0 * vec4(p, 1.0);
    vec3 q0 = c0.xyz / c0.w;
    if (q0.x > 0.005 && q0.x < 0.495 && q0.y > 0.005 && q0.y < 0.995 && q0.z > 0.0 && q0.z < 1.0) return texture(uAtmCascMap, vec3(q0.xy, q0.z - 0.0003));
    vec4 c = uAtmCascMatrix * vec4(p, 1.0);
    vec3 q = c.xyz / c.w;
    // cascade 1's atlas half: x in (0.5, 1)
    if (q.x > 0.505 && q.x < 0.995 && q.y > 0.005 && q.y < 0.995 && q.z > 0.0 && q.z < 1.0) return texture(uAtmCascMap, vec3(q.xy, q.z - 0.0004));
  }
  if (uAtmFarParams.w < 0.5) return 1.0;
  vec4 f = uAtmFarMatrix * vec4(p, 1.0);
  vec3 r = f.xyz / f.w;
  if (any(lessThan(r, vec3(0.0))) || any(greaterThan(r, vec3(1.0)))) return 1.0;
  return texture(uAtmFarMap, vec3(r.xy, r.z + uAtmFarParams.x));
}
float canopyUnder(vec3 p) {
  vec4 cq = uAtmCanopyMatrix * vec4(p.x, p.y + 2.0, p.z, 1.0);
  vec3 q3 = cq.xyz / cq.w;
  if (any(lessThan(q3.xy, vec2(0.0))) || any(greaterThan(q3.xy, vec2(1.0)))) return 0.0;
  return 1.0 - texture(uAtmCanopyMap, q3);
}
float forestAt(vec3 p) {
  return (canopyUnder(p) + canopyUnder(p + vec3(7.0, 0.0, 0.0)) + canopyUnder(p - vec3(7.0, 0.0, 0.0))
        + canopyUnder(p + vec3(0.0, 0.0, 7.0)) + canopyUnder(p - vec3(0.0, 0.0, 7.0))) * 0.2;
}
void main() {
  ivec2 hp = ivec2(gl_FragCoord.xy);
  ivec2 fmax = ivec2(uFull) - 1;
  ivec2 c = min(hp * 4 + 1, fmax);
  float d = texelFetch(tDepth, c, 0).r;
  vec2 uv = (vec2(c) + 0.5) / uFull;
  float z = linZ(d);
  vec3 vv = viewAt(uv, 1.0);
  vec3 rd = normalize((uCamWorld * vec4(vv, 0.0)).xyz);
  float tMax = min(d >= 1.0 ? 1e5 : z * length(vv), uShaft.w);
  // the medium: humid FOREST air only where a crown closes overhead — the canopy map (top-down crown depth) at each
  // sample point, ONE tap. (With the camera's shade ring instead, a camera in a tree's shadow at a meadow's edge filled the
  // whole sunlit meadow with a milky veil (the temple behind it washed out).) + the mist's height profile.
  bool canOn = uAtmCanopyParams.x > 0.5;
  float Hf = max(uAtmFogHeight, 1.0);
  // Henyey-Greenstein
  float mu = dot(rd, uAtmSunDir), g = uShaft2.x;
  float ph = (1.0 - g * g) / (12.5663706 * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
  const float B[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.);
  float jit = (B[(hp.x & 3) + ((hp.y & 3) << 2)] + 0.5) / 16.0;
  // FOREST-NESS of the air (0 = open, 1 = under a closed canopy) at 4 anchors along the ray (s = 0, ⅓, ⅔, 1 of the
  // march), each the mean of 5 canopy-map taps over a ±7 m footprint: a sunlit gap in the jungle still holds humid forest
  // air (its shafts glow), a meadow tens of metres wide does not (no veil over it)
  float fAt[4];
  for (int k = 0; k < 4; k++) {
    float sk = float(k) / 3.0;
    fAt[k] = canOn ? forestAt(uAtmCamPos + rd * (tMax * sk * sk)) : 0.0;
  }
  float sum = 0.0, tPrev = 0.0;
  const int N = 14; // 14 steps, not 20, for perf (the static 4x4 dither + the 4-tap blur hide the step)
  for (int i = 0; i < N; i++) {
    float s = (float(i) + jit) / float(N);
    float t = tMax * s * s;
    float dt = t - tPrev; tPrev = t;
    vec3 p = uAtmCamPos + rd * t;
    float fu = s * 3.0; int fi = min(int(fu), 2);
    float under = mix(fAt[fi], fAt[fi + 1], fu - float(fi));
    float m = mix(uShaft.x, uShaft.y, under) + uShaft.z * uPostFog * exp(-max(p.y, 0.0) / Hf);
#if SHAFT_DBG == 1
    m = 0.01;
#endif
#if SHAFT_DBG == 2
    sum += m * dt; continue;
#endif
    sum += vis(p) * m * dt;
  }
  sum += 0.0;
  vec3 ins = uAtmSunColor * uAtmSunI * ph * sum * uShaft2.y;
  // soft ceiling: the in-scatter saturates toward ~0.35 of the sun's white (never a white-out veil)
  float il = max(dot(ins, vec3(0.2126, 0.7152, 0.0722)), 1e-5), cap = uShaftCap * uAtmSunI * dot(uAtmSunColor, vec3(0.2126, 0.7152, 0.0722)) * 0.3183;
  ins *= cap * (1.0 - exp(-il / cap)) / il;
  gl_FragColor = vec4(ins, z);
}`;

// the shafts' static 4x4 dither → a separable 4-tap box (exactly one dither period per axis), depth-aware
const SHAFT_BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tIn;
uniform vec2 uSize, uDir;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy), mx = ivec2(uSize) - 1, d = ivec2(uDir);
  vec4 c0 = texelFetch(tIn, p, 0);
  vec3 s = vec3(0.0); float w = 0.0;
  for (int i = -2; i <= 1; i++) {
    vec4 t = texelFetch(tIn, clamp(p + d * i, ivec2(0), mx), 0);
    float k = max(0.05, 1.0 - abs(t.a - c0.a) / (0.08 * c0.a + 0.5));
    s += t.rgb * k; w += k;
  }
  gl_FragColor = vec4(s / w, c0.a);
}`;

// ONE full-res pass after the AO: TAA resolve in HDR + AO + bloom +
// tone + grade + sRGB/dither, written as MRT — location 0 = the HDR history (RGBA16F), location 1 = the display image
// (RGBA8), which is then BLITTED to the canvas (a copy, no shader). Without TAA (?atmos=notaa / smaa) the same shader
// runs with TAA compiled out, straight to the canvas.
const FINAL_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
#if defined( USE_TAA )
layout(location = 0) out highp vec4 oHist;
layout(location = 1) out highp vec4 oOut;
#else
layout(location = 0) out highp vec4 oOut;
#endif
uniform sampler2D tColor;
uniform sampler2D tHist;
uniform highp sampler2D tDepth;
uniform sampler2D tAO;
uniform sampler2D tBloom;
#ifdef GI_DEBUG
uniform sampler2D tGIdbg;
#endif
uniform mat4 uReproj;       // prev view-proj × inverse(current view-proj), both unjittered
// TAAU: uRes = the OUTPUT (canvas / history) size, uSrcRes = the scene render's size (render scale)
uniform vec2 uHalf, uRes, uSrcRes, uBloomTexel;
uniform float uAlpha, uReset, uNearFix, uStill, uSharpMove;
// TAA in motion: x = the blend a moving pixel reaches, y = at this many px of motion, z = history sharpening
uniform vec3 uTaaMove;
// the viewmodel drawn at NATIVE resolution into its own target (premultiplied rgb, a =
// coverage) while the scene renders below 100 % — composited over the upscaled world here, never in the history
uniform sampler2D tVM;
uniform float uVMOn;
// FXAA: x = sub-pixel blend, y = absolute edge threshold, z = relative edge threshold (Reinhard luma)
uniform vec3 uFxaa;
#ifdef OBJ_VEL
// per-pixel OBJECT motion (GPU-skinned kongs + their guns): rg = prev uv − cur uv (camera + object
// motion), b = 1 where such an object is the visible surface; tObjVelPrev = last frame's (disocclusion trails)
uniform highp sampler2D tObjVel, tObjVelPrev;
#endif
uniform float uAO, uBloom, uExposure, uSat, uCon, uWarm, uShadeWarm, uVig, uToe, uToScreen, uSharp, uFrame, uPivot, uKnee;
uniform highp sampler3D uLUT;
// post height fog / mist (dawn): density, camera, fog + glow colours (the materials' own fog is off while this runs)
uniform float uPostFog, uPostFogStart;
// sun glare (lens veil): xy = the sun's screen uv (may lie outside 0..1), z = strength (0 when the sun is far off-axis)
uniform vec3 uGlare;
uniform vec3 uGlareColor;
uniform sampler2D tGlareVis;
uniform float uAspect;
uniform mat4 uCamWorld;
uniform vec3 uAtmCamPos, uAtmFogColor, uAtmGlowColor, uAtmSunDir;
uniform float uAtmFogHeight;
// aerial grade: 0 on the ground → 1 from ~900 m (the plane, the drop, the aerial master shot)
uniform float uAerial, uAerialLC;
// rain: x = streaks, y = rainbow, z = puddles, w = time (s)
uniform vec4 uRain;
uniform vec3 uRainSky, uRainSkyLow;
#ifdef USE_SHAFTS
uniform sampler2D tShaft;
uniform vec2 uShaftSize;
uniform float uShaftOn;
#endif
${DEPTH_GLSL}
varying vec2 vUv;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
#ifdef USE_SHAFTS
// depth-aware 2x2 upsample of the quarter-res shafts (a tap whose depth disagrees with this pixel's weighs little)
vec3 shaftUp(float z) {
  vec2 hp = vUv * uShaftSize - 0.5;
  vec2 b = floor(hp), f = hp - b;
  ivec2 i0 = ivec2(b), mx = ivec2(uShaftSize) - 1;
  vec4 a = texelFetch(tShaft, clamp(i0, ivec2(0), mx), 0), e = texelFetch(tShaft, clamp(i0 + ivec2(1, 0), ivec2(0), mx), 0);
  vec4 g = texelFetch(tShaft, clamp(i0 + ivec2(0, 1), ivec2(0), mx), 0), h = texelFetch(tShaft, clamp(i0 + ivec2(1, 1), ivec2(0), mx), 0);
  vec4 w = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
  vec4 dz = abs(vec4(a.w, e.w, g.w, h.w) - z) / (0.05 * z + 0.3);
  w *= 1.0 / (1.0 + dz * dz) + 1e-3;
  return (a.rgb * w.x + e.rgb * w.y + g.rgb * w.z + h.rgb * w.w) / dot(w, vec4(1.0));
}
#endif

// height fog broken into drifting mist BANKS, integrated from the camera to the surface (same model as glsl.ts
// atmosAerial's fog, evaluated once per pixel here so the foliage / terrain / water all get it — the veg shaders skip
// the per-material aerial perspective)
vec3 postFog(vec3 col, vec3 p) {
  vec3 dv = p - uAtmCamPos;
  float dist = length(dv);
  vec3 dir = dv / max(dist, 1e-3);
  float Hf = max(uAtmFogHeight, 1.0);
  float py = max(p.y, -2.0);
  float e0 = exp(-uAtmCamPos.y / Hf);
  float fogInt = abs(dv.y) < 0.05 ? dist * e0 : dist * Hf * (e0 - exp(-py / Hf)) / dv.y;
  fogInt = max(fogInt - uPostFogStart * exp(-max(uAtmCamPos.y, 0.0) / Hf), 0.0);
  float bands = 0.35 + 0.65 * smoothstep(-0.3, 0.7, sin(p.x * 0.0105 + 1.3 * sin(p.z * 0.0071)) * sin(p.z * 0.0093 + 0.8 * sin(p.x * 0.0057) + 1.7));
  float fog = 1.0 - exp(-max(fogInt, 0.0) * uPostFog * bands);
  float sunward = pow(max(dot(dir, uAtmSunDir), 0.0), 6.0);
  return mix(col, mix(uAtmFogColor, uAtmGlowColor, sunward * 0.6), clamp(fog, 0.0, 0.92));
}

vec3 safe(vec3 c) {
  uvec3 e = floatBitsToUint(c) & uvec3(0x7f800000u);
  return any(equal(e, uvec3(0x7f800000u))) ? vec3(0.0) : clamp(c, 0.0, 6.0e4);
}
vec3 rein(vec3 c) { return c / (1.0 + dot(c, LUMA)); }
vec3 unrein(vec3 c) { return c / max(1.0 - dot(c, LUMA), 1e-3); }
vec3 ycocg(vec3 c) { return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b, 0.5 * c.r - 0.5 * c.b, -0.25 * c.r + 0.5 * c.g - 0.25 * c.b); }
vec3 rgb(vec3 c) { return vec3(c.x + c.y - c.z, c.x + c.z, c.x - c.y - c.z); }
// 5-tap Catmull-Rom (bilinear-optimised) of any linear-filtered texture of size res
vec3 crTex(sampler2D t, vec2 uv, vec2 res) {
  vec2 p = uv * res, t1 = floor(p - 0.5) + 0.5, f = p - t1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f), w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2, o12 = w2 / w12;
  vec2 t0 = (t1 - 1.0) / res, t3 = (t1 + 2.0) / res, tc = (t1 + o12) / res;
  vec3 r = texture2D(t, vec2(tc.x, t0.y)).rgb * (w12.x * w0.y) + texture2D(t, vec2(t0.x, tc.y)).rgb * (w0.x * w12.y)
         + texture2D(t, tc).rgb * (w12.x * w12.y) + texture2D(t, vec2(t3.x, tc.y)).rgb * (w3.x * w12.y)
         + texture2D(t, vec2(tc.x, t3.y)).rgb * (w12.x * w3.y);
  float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return r / ws;
}
// the history stays sharp under sub-pixel motion
vec3 histCR(vec2 uv) {
#ifdef HIST_BILINEAR
  return safe(texture2D(tHist, uv).rgb);
#endif
  return safe(crTex(tHist, uv, uRes));
}
// (keeps distant things in focus at a 3D resolution < 100 %) the scene texel under this output
// pixel, reconstructed with Catmull-Rom instead of a bilinear tap, de-ringed against its 2x2 texel footprint (no dark /
// bright halos round HDR highlights)
vec3 upCur(vec2 uv) {
  vec2 p = uv * uSrcRes - 0.5;
  ivec2 b = ivec2(floor(p)), mx = ivec2(uSrcRes) - 1;
  vec3 a0 = texelFetch(tColor, clamp(b, ivec2(0), mx), 0).rgb, a1 = texelFetch(tColor, clamp(b + ivec2(1, 0), ivec2(0), mx), 0).rgb;
  vec3 a2 = texelFetch(tColor, clamp(b + ivec2(0, 1), ivec2(0), mx), 0).rgb, a3 = texelFetch(tColor, clamp(b + ivec2(1, 1), ivec2(0), mx), 0).rgb;
  vec3 lo = min(min(a0, a1), min(a2, a3)), hi = max(max(a0, a1), max(a2, a3));
  return clamp(crTex(tColor, uv, uSrcRes), lo, hi);
}
float cbrt(float x) { return sign(x) * pow(abs(x), 1.0 / 3.0); }
vec3 toOklab(vec3 c) {
  float l = cbrt(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
  float m = cbrt(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
  float s = cbrt(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  return vec3(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
              1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
              0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 fromOklab(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
             -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
             -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
// tone curve: Khronos PBR-Neutral's shoulder (hue-keeping highlight compression + desaturation to white) with its toe
// applied to LUMINANCE — the original toe works on the min channel (x → 6.25 x²) and crushed the blue sky's red and the
// yellows' blue to exactly 0 (14–28 % of pixels had a zero channel). grade.ts mirrors this on the CPU.
vec3 tone(vec3 c) {
  float y = dot(c, LUMA);
  float off = y < 0.08 ? y - 6.25 * y * y : 0.04;
  c *= max(y - off * uToe, 0.0) / max(y, 1e-5);
  const float S = 0.76, D = 0.15;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < S) return c;
  float d = 1.0 - S;
  float np = 1.0 - d * d / (peak + d - S);
  c *= np / peak;
  float g = 1.0 - 1.0 / (D * (peak - np) + 1.0);
  return mix(c, vec3(np), g);
}
// soft gamut compression toward the grey of the same OkLab L: the lowest channel rolls off toward a floor of 2.5 % of
// the grey level (C1 at the knee), the highest rolls off under 1
vec3 gamutSoft(vec3 c, float L) {
  float g = max(L * L * L, 1e-6);
  float mn = min(c.r, min(c.g, c.b)), mx = max(c.r, max(c.g, c.b));
  float t = 1.0;
  // below A of the grey level the lowest channel is compressed toward a FLOOR F (never 0: dark saturated foliage kept
  // landing on B = 0)
  const float A = 0.2, F = 0.025, K = A - F;
  float r = mn / g;
  if (r < A && mn < g) { float x = A - r; float rp = A - x / (1.0 + x / K); t = min(t, (1.0 - rp) / (1.0 - r)); }
  float H = uKnee;
  if (mx > H && mx > g) { float tgt = 1.0 - (1.0 - H) * (1.0 - H) / (mx - 2.0 * H + 1.0); t = min(t, max(tgt - g, 0.0) / (mx - g)); }
  return g + (c - g) * clamp(t, 0.0, 1.0);
}
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float rh(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float rnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rh(i), rh(i + vec2(1, 0)), f.x), mix(rh(i + vec2(0, 1)), rh(i + vec2(1, 1)), f.x), f.y); }
// puddle mask on flat ground (world xz): broad blotches with a crisp-ish rim
float puddleMask(vec2 xz) {
  float n = rnoise(xz * 0.13) * 0.55 + rnoise(xz * 0.37 + 7.3) * 0.33 + rnoise(xz * 1.3 + 2.1) * 0.12;
  return smoothstep(0.645, 0.675, n);
}
// rain streaks: 3 layers of slanted streaks in screen space (near = long, bright, sparse), each hidden behind geometry
// closer than its layer depth
float rainStreaks(vec2 fc, float zScene, float t) {
  float acc = 0.0;
  for (int L = 0; L < 3; L++) {
    float fl = float(L);
    float dep = 2.5 * pow(2.6, fl);
    if (zScene < dep) continue;
    float colW = 34.0 / (1.0 + fl * 0.9), rowH = 150.0 / (1.0 + fl * 1.1), wpx = 1.3 - fl * 0.25;
    vec2 q = vec2(fc.x + fc.y * 0.16, fc.y) * (1440.0 / uRes.y);
    q.y += t * (2400.0 - fl * 700.0);
    vec2 g = vec2(q.x / colW, q.y / rowH);
    vec2 cell = floor(g), f = fract(g);
    float h = rh(cell + fl * 17.0);
    if (h < 0.38) continue;
    float x0 = 0.15 + 0.7 * rh(cell + 3.7 + fl);
    float dx = abs(f.x - x0) * colW;
    float y0 = rh(cell + 9.1) * 0.5, len = 0.35 + 0.3 * rh(cell + 5.3);
    float along = smoothstep(y0, y0 + 0.08, f.y) * (1.0 - smoothstep(y0 + len - 0.1, y0 + len, f.y));
    acc += (1.0 - smoothstep(0.0, wpx, dx)) * along * (0.55 + 0.45 * h) * (1.0 - fl * 0.25);
  }
  return acc;
}
vec3 rainbowCol(float t) {
  // t: 0 inner (violet) → 1 outer (red)
  float r = smoothstep(0.42, 0.8, t) + 0.35 * (1.0 - smoothstep(0.0, 0.18, t));
  float g = smoothstep(0.18, 0.45, t) * (1.0 - smoothstep(0.62, 0.9, t));
  float b = 1.0 - smoothstep(0.2, 0.52, t);
  return vec3(r, g, b);
}

#if defined( USE_FXAA ) && !defined( USE_TAA )
// FXAA — the spatial AA mode of the video settings. (The console variant blurred every
// textured pixel, Laplacian 930 vs 2524 AA-off): FXAA 3.11 QUALITY — only pixels on a real luma edge move, and only along
// the edge (end-point search, 8 steps); no sub-pixel blending, edge threshold 0.25 (relative) / 0.083. In Reinhard space on the HDR scene, at the scene's
// own texels (under a 3D resolution < 100 % the output pixel keeps its sub-texel position).
float fxL(vec2 uv) { return dot(rein(texture2D(tColor, uv).rgb), LUMA); }
vec3 fxaaAt(vec3 cM) {
  vec2 px = 1.0 / uSrcRes;
  vec2 uv = (floor(vUv * uSrcRes) + 0.5) * px;
  float lM = dot(rein(cM), LUMA);
  float lS = fxL(uv + vec2(0.0, -px.y)), lN = fxL(uv + vec2(0.0, px.y)), lE = fxL(uv + vec2(px.x, 0.0)), lW = fxL(uv + vec2(-px.x, 0.0));
  float mxL = max(max(max(lS, lN), max(lE, lW)), lM), mnL = min(min(min(lS, lN), min(lE, lW)), lM);
  float range = mxL - mnL;
  if (range < max(uFxaa.y, mxL * uFxaa.z)) return cM;
  float lNW = fxL(uv + vec2(-px.x, px.y)), lNE = fxL(uv + px), lSW = fxL(uv - px), lSE = fxL(uv + vec2(px.x, -px.y));
  float lNS = lN + lS, lWE = lW + lE;
  float subA = (2.0 * (lNS + lWE) + (lNW + lNE + lSW + lSE)) / 12.0;
  float sub = clamp(abs(subA - lM) / range, 0.0, 1.0);
  sub = (-2.0 * sub + 3.0) * sub * sub;
  float subBlend = sub * sub * uFxaa.x;
  float edgeH = abs(lNW + lSW - 2.0 * lW) + 2.0 * abs(lNS - 2.0 * lM) + abs(lNE + lSE - 2.0 * lE);
  float edgeV = abs(lNW + lNE - 2.0 * lN) + 2.0 * abs(lWE - 2.0 * lM) + abs(lSW + lSE - 2.0 * lS);
  bool hor = edgeH >= edgeV;
  float l1 = hor ? lS : lW, l2 = hor ? lN : lE;
  float g1 = abs(l1 - lM), g2 = abs(l2 - lM);
  float stp = hor ? px.y : px.x;
  float lAvg; float gScaled;
  if (g1 >= g2) { stp = -stp; lAvg = 0.5 * (l1 + lM); gScaled = 0.25 * g1; } else { lAvg = 0.5 * (l2 + lM); gScaled = 0.25 * g2; }
  vec2 cuv = uv; if (hor) cuv.y += 0.5 * stp; else cuv.x += 0.5 * stp;
  vec2 off = hor ? vec2(px.x, 0.0) : vec2(0.0, px.y);
  vec2 u1 = cuv - off, u2 = cuv + off;
  float e1 = fxL(u1) - lAvg, e2 = fxL(u2) - lAvg;
  bool r1 = abs(e1) >= gScaled, r2 = abs(e2) >= gScaled;
  const float QS[8] = float[8](1.0, 1.5, 2.0, 2.0, 2.0, 2.0, 4.0, 8.0);
  for (int i = 0; i < 8; i++) {
    if (r1 && r2) break;
    if (!r1) { u1 -= off * QS[i]; e1 = fxL(u1) - lAvg; r1 = abs(e1) >= gScaled; }
    if (!r2) { u2 += off * QS[i]; e2 = fxL(u2) - lAvg; r2 = abs(e2) >= gScaled; }
  }
  float d1 = hor ? uv.x - u1.x : uv.y - u1.y, d2 = hor ? u2.x - uv.x : u2.y - uv.y;
  bool near1 = d1 < d2;
  float dMin = min(d1, d2), len = d1 + d2;
  bool mLess = lM - lAvg < 0.0;
  bool good = ((near1 ? e1 : e2) < 0.0) != mLess;
  float pixOff = good ? 0.5 - dMin / len : 0.0;
  pixOff = max(pixOff, subBlend);
  vec2 fuv = uv; if (hor) fuv.y += pixOff * stp; else fuv.x += pixOff * stp;
  return texture2D(tColor, fuv + (vUv - uv)).rgb;
}
#endif

void main() {
  // output pixel (history / display) and its scene texel (they differ only under a render scale < 1)
  ivec2 ipo = ivec2(gl_FragCoord.xy);
  bool up = uSrcRes.x < uRes.x - 0.5;
  ivec2 ip = up ? ivec2(vUv * uSrcRes) : ipo, mx = ivec2(uSrcRes) - 1;
  // ---- TAA resolve (HDR): 5-tap cross neighbourhood in Reinhard-compressed YCoCg, closest-depth reprojection
  vec3 cur = safe(up ? upCur(vUv) : texelFetch(tColor, ip, 0).rgb);
#ifdef FIN_X_DEPTH
  float d0 = 0.5;
#else
  float d0 = texelFetch(tDepth, ip, 0).r;
#endif
  vec3 c = cur;
#if defined( USE_FXAA ) && !defined( USE_TAA )
  if (d0 < 1.0) {
    c = fxaaAt(cur);
    // pixels FXAA left alone (no luma edge) take the same neighbourhood-clamped unsharp mask as
    // the TAA path — the spatial mode keeps the textures' detail (edges stay FXAA-smoothed)
    if (uSharp > 0.0 && all(equal(c, cur))) {
      vec3 n1 = rein(clamp(texelFetch(tColor, min(ip + ivec2(1, 0), mx), 0).rgb, 0.0, 6.0e4)), n2 = rein(clamp(texelFetch(tColor, max(ip - ivec2(1, 0), ivec2(0)), 0).rgb, 0.0, 6.0e4));
      vec3 n3 = rein(clamp(texelFetch(tColor, min(ip + ivec2(0, 1), mx), 0).rgb, 0.0, 6.0e4)), n4 = rein(clamp(texelFetch(tColor, max(ip - ivec2(0, 1), ivec2(0)), 0).rgb, 0.0, 6.0e4));
      vec3 k0 = rein(cur), lo4 = min(min(n1, n2), min(n3, n4)), hi4 = max(max(n1, n2), max(n3, n4));
      c = unrein(clamp(k0 + (k0 - 0.25 * (n1 + n2 + n3 + n4)) * uSharp, min(lo4, k0), max(hi4, k0)));
    }
  }
#endif
  // SKY pixels (nothing wrote depth: sky dome, cloud impostors, sun): no reprojection / neighbourhood / sharpen / AO —
  // the sky is a smooth gradient and the clouds are pre-filtered soft tiles; a third to all of the frame skips the
  // TAA's 15 taps (the far-plane test is exact: the scene buffer clears to depth 1)
  bool isSky = d0 >= 1.0;
  // the first-person viewmodel (< uNearFix m) is drawn WITHOUT
  // the jitter (shadows.ts uAtmJitter) and shown straight from this frame — no history, so no smear / ghost however it
  // bobs, sways or recoils; a light edge filter below stands in for the TAA on its silhouette
  bool isVM = !isSky && linZ(d0) < uNearFix;
#ifdef USE_TAA
  vec3 m1 = vec3(0.0), m2 = vec3(0.0), lo = vec3(1e3), hi = vec3(-1e3), nsum = vec3(0.0);
  float dmin = d0; vec2 dof = vec2(0.0);
  if (isSky) { lo = hi = ycocg(rein(cur)); nsum = rein(cur) * 4.0; }
#ifdef FIN_NO_NEIGH
  else { lo = hi = ycocg(rein(cur)); nsum = rein(cur) * 4.0; m1 = lo * 5.0; m2 = lo * lo * 5.0; }
#else
  else {
    // (perf: the neighbourhood was the final pass's costliest part, ~0.12 of 0.5 ms) unrolled, the
    // neighbours guarded by a clamp (the materials already never emit NaN / Inf; the centre keeps the full guard)
    ivec2 qx0 = min(ip + ivec2(1, 0), mx), qx1 = max(ip - ivec2(1, 0), ivec2(0));
    ivec2 qy0 = min(ip + ivec2(0, 1), mx), qy1 = max(ip - ivec2(0, 1), ivec2(0));
    vec3 r0 = rein(cur);
    vec3 r1 = rein(clamp(texelFetch(tColor, qx0, 0).rgb, 0.0, 6.0e4)), r2 = rein(clamp(texelFetch(tColor, qx1, 0).rgb, 0.0, 6.0e4));
    vec3 r3 = rein(clamp(texelFetch(tColor, qy0, 0).rgb, 0.0, 6.0e4)), r4 = rein(clamp(texelFetch(tColor, qy1, 0).rgb, 0.0, 6.0e4));
    nsum = r1 + r2 + r3 + r4;
    vec3 s0 = ycocg(r0), s1 = ycocg(r1), s2 = ycocg(r2), s3 = ycocg(r3), s4 = ycocg(r4);
    m1 = s0 + s1 + s2 + s3 + s4;
    m2 = s0 * s0 + s1 * s1 + s2 * s2 + s3 * s3 + s4 * s4;
    lo = min(min(min(s0, s1), min(s2, s3)), s4);
    hi = max(max(max(s0, s1), max(s2, s3)), s4);
#ifndef TAA_NO_DILATE
    // closest depth of the cross (the reprojection of a thin foreground edge follows the edge, not the background)
    // (skipped while the camera is still — the camera-only reprojection is the identity then)
    if (uStill < 0.5) {
    float e1 = texelFetch(tDepth, qx0, 0).r, e2 = texelFetch(tDepth, qx1, 0).r, e3 = texelFetch(tDepth, qy0, 0).r, e4 = texelFetch(tDepth, qy1, 0).r;
    if (e1 < dmin) { dmin = e1; dof = vec2(1.0, 0.0); }
    if (e2 < dmin) { dmin = e2; dof = vec2(-1.0, 0.0); }
    if (e3 < dmin) { dmin = e3; dof = vec2(0.0, 1.0); }
    if (e4 < dmin) { dmin = e4; dof = vec2(0.0, -1.0); }
    }
#endif
    // a background pixel next to the viewmodel reprojects by ITS OWN depth (the viewmodel's zero motion would glue the
    // old background to the gun's silhouette while running — the ghost trail round the stock)
    if (!isVM && linZ(dmin) < uNearFix) { dmin = d0; dof = vec2(0.0); }
  }
#endif
  vec3 res = cur;
  // this pixel's reprojection distance (output px) — the motion-adaptive sharpen below
  float mvPx = 0.0;
  // the unsharp masks' neighbourhood mean (Reinhard space); TAA_STABLE replaces it below with the RESOLVED image's
  vec3 nmean = 0.25 * nsum;
  if (uReset < 0.5 && !isSky && !isVM) {
    vec2 uvD = vUv + dof / uSrcRes;
    vec4 pc = uReproj * vec4(vec3(uvD, dmin) * 2.0 - 1.0, 1.0);
    vec2 motion = uStill > 0.5 ? vec2(0.0) : pc.xy / pc.w * 0.5 + 0.5 - uvD;
#ifdef OBJ_VEL
    // a moving object reprojects by its own motion vector (the closest-depth neighbour's, like the camera path)
    vec4 ovel = texelFetch(tObjVel, clamp(ip + ivec2(dof), ivec2(0), mx), 0);
    float objCur = ovel.b;
    if (objCur > 0.5) motion = ovel.rg;
#endif
    // the viewmodel (and anything glued to the lens) moves WITH the camera: no reprojection
    if (linZ(dmin) < uNearFix) motion = vec2(0.0);
    vec2 puv = vUv + motion;
    mvPx = length(motion * uRes);
    if (all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0)))) {
      // a still camera reprojects onto the texel centres: the history texel itself (the Catmull-Rom weights are 0/1)
      vec2 mp = motion * uRes;
#ifdef FIN_X_HIST
      vec3 h = ycocg(rein(cur));
#else
      vec3 h = ycocg(rein(dot(mp, mp) < 1e-4 ? safe(texelFetch(tHist, ipo, 0).rgb) : histCR(puv)));
#endif
      vec3 mu = m1 / 5.0, sig = sqrt(abs(m2 / 5.0 - mu * mu));
      vec3 bmin = max(lo, mu - 1.25 * sig), bmax = min(hi, mu + 1.25 * sig);
      // (else far crane cables and railings stipple into dashes) a sub-pixel wire is
      // missing from the jittered cross in some frames, and the clip erased it from the history there — on STATIC pixels
      // the box keeps a minimum half-extent (luma .06, chroma .03 in Reinhard-YCoCg), so the accumulated partial coverage
      // survives; moving pixels keep the tight box (no ghosting)
      float stat = 1.0 - clamp(length(motion * uRes) * 2.0, 0.0, 1.0);
#ifdef OBJ_VEL
      // object pixels never get the static box widening; a pixel an object just uncovered (the history there was the
      // object) takes the tight box + a fast blend — no trail behind a running kong
      float objWas = texelFetch(tObjVelPrev, clamp(ivec2(puv * uSrcRes), ivec2(0), mx), 0).b;
      float disocc = objWas > 0.5 && objCur < 0.5 ? 1.0 : 0.0;
      if (objCur > 0.5 || disocc > 0.5) stat = 0.0;
#endif
      vec3 bc = 0.5 * (bmin + bmax), bh = max(0.5 * (bmax - bmin), vec3(0.06, 0.03, 0.03) * stat);
      bmin = bc - bh; bmax = bc + bh;
      // clip toward the box centre (not a per-channel clamp: no hue shifts on the ghost)
      vec3 cc = 0.5 * (bmax + bmin), ext = 0.5 * (bmax - bmin) + 1e-4, dv = h - cc;
      vec3 ts = abs(dv / ext);
      float mts = max(ts.x, max(ts.y, ts.z));
      if (mts > 1.0) h = cc + dv / mts;
      float a = mix(uAlpha * (up ? uSrcRes.x / uRes.x : 1.0), 0.3, clamp(mvPx / 16.0, 0.0, 1.0));
      // a moving camera leans on this frame sooner (uTaaMove.x: the blend reached from ~uTaaMove.y px of motion)
      a = max(a, uTaaMove.x * smoothstep(0.15, uTaaMove.y, mvPx));
#ifdef OBJ_VEL
      a = max(a, disocc * 0.4);
#endif
#ifndef HIST_R11
      // the history there was the viewmodel (alpha 0): the gun just moved off this pixel — take this frame
      if (texture2D(tHist, puv).a < 0.995) a = 1.0;
#endif
      res = unrein(max(rgb(mix(h, ycocg(rein(cur)), a)), 0.0));
#ifdef TAA_STABLE
      // the ground sparkled while flying in when both unsharp
      // masks used THIS frame's jittered cross as their mean — it carries the full sub-pixel jitter noise of the canopy /
      // terrain detail, and the mask multiplied it into every output frame (2/3 of the descent shimmer: a still camera
      // shimmered 3x more with the sharpen than without). The mean of the RESOLVED neighbours instead = the history's
      // neighbours (reprojected, temporally stable) blended with this frame's exactly like the centre (same a): the same
      // sharpening of the image, without the jitter. Viewmodel texels in the history (a < 1) keep this frame's mean.
      {
        vec2 ht = 1.0 / uRes;
        vec4 g1 = texture2D(tHist, puv + vec2(ht.x, 0.0)), g2 = texture2D(tHist, puv - vec2(ht.x, 0.0));
        vec4 g3 = texture2D(tHist, puv + vec2(0.0, ht.y)), g4 = texture2D(tHist, puv - vec2(0.0, ht.y));
        if (min(min(g1.a, g2.a), min(g3.a, g4.a)) > 0.995)
          nmean = mix(0.25 * (rein(safe(g1.rgb)) + rein(safe(g2.rgb)) + rein(safe(g3.rgb)) + rein(safe(g4.rgb))), 0.25 * nsum, a);
      }
#endif
      // (the moving image kept only 55 % of the still image's
      // detail) each frame's resample of the history at a fractional offset is a mild low-pass that compounds over the
      // ~10-frame accumulation. A matching unsharp step INTO the history while it moves (bounded by this frame's
      // neighbourhood — no ringing, no drift) cancels that loss; a still camera reads the history texel-exact (no loss)
      float hk = uTaaMove.z * smoothstep(0.05, 0.6, mvPx) * (1.0 - smoothstep(8.0, 24.0, mvPx));
      if (hk > 0.0) {
        vec3 k0 = rein(res), lo3 = rgb(lo), hi3 = rgb(hi);
        res = unrein(clamp(k0 + (k0 - nmean) * hk, min(min(lo3, hi3), k0), max(max(lo3, hi3), k0)));
      }
    }
  }
  if (isVM) {
    // viewmodel edge filter (FXAA-style sub-pixel blend toward the cross mean, only across real edges; flat and
    // textured interiors keep this frame's texels untouched)
    float yc = ycocg(rein(cur)).x, rng = hi.x - lo.x;
    float sub = clamp(abs(ycocg(0.25 * nsum).x - yc) / max(rng, 1e-4), 0.0, 1.0);
    float bl = sub * sub * (3.0 - 2.0 * sub); bl = bl * bl * 0.55 * smoothstep(0.04, 0.12, rng);
    res = unrein(mix(rein(cur), 0.25 * nsum, bl));
  }
#ifdef HIST_R11
  // the history is R11G11B10F (half the bytes of RGBA16F — the final pass is bandwidth-bound): Metal TRUNCATES on the
  // conversion (measured), so a uniform [0, 1) ulp dither before the write = unbiased stochastic rounding (no drift, no
  // stuck values in the 10 % blend); ulp = 2^(e − 6) for R, G and 2^(e − 5) for B
  {
    vec3 e = floor(log2(max(res, vec3(1e-6))));
    float n = ign(gl_FragCoord.xy * 1.13 + uFrame * 7.31);
    oHist = vec4(res + n * exp2(e - vec3(6.0, 6.0, 5.0)), 1.0);
  }
#else
  oHist = vec4(res, isVM ? 0.0 : 1.0);
#endif
  c = res;
#ifdef USE_SHARPEN
  if (!isSky && !isVM) {
    // unsharp mask: the resolved centre against the current frame's cross mean, limited to the neighbourhood range
    // (no halos); the history itself stays unsharpened
    // motion-adaptive — every resampled history frame
    // loses a little high frequency while the camera moves, so the mask strengthens with the reprojection distance
    // (uSharp still → uSharp × (1 + uSharpMove) from ~3 px of motion) and under a 3D resolution < 100 % (TAAU)
    vec3 k0 = rein(res);
    vec3 lo3 = rgb(lo), hi3 = rgb(hi);
    float sk = uSharp * (1.0 + uSharpMove * smoothstep(0.2, 3.0, mvPx)) * (1.0 + 1.5 * max(1.0 - uSrcRes.x / uRes.x, 0.0));
    c = unrein(clamp(k0 + (k0 - nmean) * sk, min(min(lo3, hi3), k0), max(max(lo3, hi3), k0)));
  }
#endif
#endif
  if (uVMOn > 0.5) {
    ivec2 vmx = ivec2(uRes) - 1;
    vec4 v = texelFetch(tVM, ipo, 0);
    vec4 v1 = texelFetch(tVM, min(ipo + ivec2(1, 0), vmx), 0), v2 = texelFetch(tVM, max(ipo - ivec2(1, 0), ivec2(0)), 0);
    vec4 v3 = texelFetch(tVM, min(ipo + ivec2(0, 1), vmx), 0), v4 = texelFetch(tVM, max(ipo - ivec2(0, 1), ivec2(0)), 0);
    float amx = max(max(max(v1.a, v2.a), max(v3.a, v4.a)), v.a);
    if (amx > 0.0) {
      // silhouette / hard interior edges: a light blend toward the cross mean (the native pass has no AA of its own)
      vec4 avg = 0.25 * (v1 + v2 + v3 + v4);
      float amn = min(min(min(v1.a, v2.a), min(v3.a, v4.a)), v.a);
      float ly = dot(rein(max(v.rgb, 0.0)), LUMA), la = dot(rein(max(avg.rgb, 0.0)), LUMA);
      float e = max(amx - amn, smoothstep(0.04, 0.2, abs(ly - la)) * 0.6);
      v = mix(v, avg, 0.4 * e);
      float a = clamp(v.a, 0.0, 1.0);
      c = c * (1.0 - a) + max(v.rgb, 0.0);
      if (a > 0.5) { isSky = false; isVM = true; d0 = 0.0; }
    }
  }
#ifdef USE_SHAFTS
  // (shafts read against DARK air — the understory; over an already bright surface they would only wash it milky:
  // the add falls off with the pixel's luminance)
  if (uShaftOn > 0.5) c += shaftUp(linZ(d0)) * clamp(1.0 - dot(c, LUMA) * 2.2, 0.12, 1.0);
#endif
  if (uRain.x + uRain.y + uRain.z > 0.0) {
    float zs = isSky ? 1e5 : linZ(d0);
    vec3 vv = viewAt(vUv, 1.0);
    vec3 rdw = normalize((uCamWorld * vec4(vv, 0.0)).xyz);
    // ---- puddles: flat ground within 90 m, a world-space mask; darker wet base + a screen-space mirror reflection
    if (uRain.z > 0.0 && !isSky && !isVM && zs < 90.0) {
      vec3 P = viewAt(vUv, zs);
      vec3 wp = (uCamWorld * vec4(P, 1.0)).xyz;
      ivec2 ax = min(ip + ivec2(1, 0), mx), ay = min(ip + ivec2(0, 1), mx);
      vec3 Px = viewAt((vec2(ax) + 0.5) / uSrcRes, linZ(texelFetch(tDepth, ax, 0).r)), Py = viewAt((vec2(ay) + 0.5) / uSrcRes, linZ(texelFetch(tDepth, ay, 0).r));
      vec3 Nv = normalize(cross(Px - P, Py - P));
      if (dot(Nv, P) > 0.0) Nv = -Nv;
      vec3 Nw = (uCamWorld * vec4(Nv, 0.0)).xyz;
      float pm = Nw.y > 0.965 ? puddleMask(wp.xz) * uRain.z * smoothstep(90.0, 50.0, zs) : 0.0;
      if (pm > 0.001) {
        vec3 up = vec3(uCamWorld[0][1], uCamWorld[1][1], uCamWorld[2][1]);
        vec3 V = normalize(P), R = reflect(V, up);
        vec3 refl = mix(uRainSkyLow, uRainSky, smoothstep(0.0, 0.5, (uCamWorld * vec4(R, 0.0)).y));
        float t = 0.25, hitK = 0.0;
        for (int i = 0; i < 28; i++) {
          vec3 Q = P + R * t;
          if (Q.z > -0.05) break;
          vec2 quv = ((Q.xy / -Q.z) * uProjInfo.xy - uProjInfo.zw) * 0.5 + 0.5;
          if (quv.x < 0.0 || quv.x > 1.0 || quv.y < 0.0 || quv.y > 1.0) break;
          float sz = linZ(texture2D(tDepth, quv).r);
          float qz = -Q.z;
          if (qz > sz + 0.02 && qz < sz + 0.6 + 0.06 * sz) { refl = texture2D(tColor, quv).rgb; hitK = 1.0; break; }
          t *= 1.17;
        }
        float cosT = clamp(dot(-V, up), 0.0, 1.0);
        float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
        c = mix(c, mix(c * 0.55, refl, mix(0.35, 0.95, F)), pm);
      }
    }
    // ---- rainbow (sky + far distance, above the horizon): primary 40.5–42.5° round the antisolar point + Alexander band
    if (uRain.y > 0.0 && zs > 250.0) {
      float th = degrees(acos(clamp(dot(rdw, -uAtmSunDir), -1.0, 1.0)));
      float hz = smoothstep(-0.005, 0.03, rdw.y) * smoothstep(250.0, 600.0, zs);
      float t = (th - 40.4) / 2.3;
      float env = smoothstep(-0.25, 0.08, t) * (1.0 - smoothstep(0.92, 1.25, t));
      float l = dot(c, LUMA);
      c += rainbowCol(clamp(t, 0.0, 1.0)) * env * uRain.y * hz * (0.18 + 0.5 * l);
      c *= 1.0 + hz * uRain.y * (0.07 * (1.0 - smoothstep(38.0, 40.5, th)) - 0.05 * smoothstep(42.5, 44.0, th) * (1.0 - smoothstep(49.0, 51.0, th)));
    }
    // ---- rain streaks (sunlit, a touch brighter toward the sun)
    if (uRain.x > 0.0) {
      float st = rainStreaks(gl_FragCoord.xy, zs, uRain.w);
      float sunward = pow(max(dot(rdw, uAtmSunDir), 0.0), 3.0);
      c += vec3(0.85, 0.9, 1.0) * st * uRain.x * (0.5 + 0.8 * sunward + 0.4 * dot(c, LUMA));
    }
  }
  if (uPostFog > 0.0) {
    // surface position from the depth; far water (no depth write) and anything below the horizon behind it: the sea plane
    vec3 wp; bool hitP = true;
    if (!isSky) wp = (uCamWorld * vec4(viewAt(vUv, linZ(d0)), 1.0)).xyz;
    else {
      vec3 rdw = normalize((uCamWorld * vec4(viewAt(vUv, 1.0), 0.0)).xyz);
      hitP = rdw.y < -1e-3;
      wp = uAtmCamPos + rdw * (max(uAtmCamPos.y, 0.0) / max(-rdw.y, 1e-3));
    }
    if (hitP) c = postFog(c, wp);
#ifdef FOG_DEBUG
    oOut = vec4(length(wp - uAtmCamPos) / 1000.0, wp.y / 100.0, hitP ? 1.0 : 0.0, 1.0); return;
#endif
  }
#if defined( SHAFT_DEBUG ) && defined( USE_SHAFTS )
  { oOut = vec4(shaftUp(linZ(d0)) * 8.0, 1.0); return; }
#endif
#ifdef GI_DEBUG
  { vec4 g = texture2D(tGIdbg, vUv); oOut = vec4(vUv.x > 0.5 ? vec3(g.a) : g.rgb * 2.0, 1.0); return; } // left: GI rgb, right: interior visibility
#endif
#ifdef AO_DEBUG
  // the AO the materials apply (glsl.ts atmosSSAO) is already in the scene colour; debug shows the raw AO texture
  oOut = vec4(texture2D(tAO, vUv).rrr, 1.0); return;
#endif
  if (uGlare.z > 0.0) {
    // veiling glare of a sun just outside / inside the frame (the beach target art's white-hot corner): a soft radial
    // veil in screen space from the sun's projected position. (No white 7-spoke star on a closed room's ceiling,
    // no trunks washed white:) scaled by the sun's VISIBILITY (tGlareVis: the sky share of a disc of depth taps round the
    // sun, clamped into the frame when the sun is just outside it, smoothed over ~8 frames), purely radial (no spokes),
    // and the hot core lands on SKY pixels (through leaf gaps) — opaque surfaces take only the faint wide veil
    float vis = texture2D(tGlareVis, vec2(0.5)).r;
    vec2 sd = (vUv - uGlare.xy) * vec2(uAspect, 1.0);
    float r2 = dot(sd, sd);
    // (no milky veil over opaque foliage) the veil is scattered light
    // in front of the SKY and the far distance only — an opaque surface within ~150 m keeps its full contrast
    float farK = isSky ? 1.0 : smoothstep(150.0, 700.0, linZ(d0));
    float core = exp(-r2 / 0.07) * 0.9;
    c += uGlareColor * (uGlare.z * vis * vis * farK) * (core + exp(-r2 / 0.5) * 0.25);
  }
#ifdef USE_BLOOM
  {
    // the prefiltered quarter-res glow's mip chain = the blur: levels 1..3 (1/8 .. 1/32 res), ONE trilinear tap per
    // level between levels (lod 1.5 / 2.5 / 3.5: the driver's box mips blended across two levels read as a soft tent),
    // offset on a rotated diagonal per level so the mip grids never line up (3 taps, not 6)
    vec2 t = uBloomTexel;
#ifdef BLOOM3
    vec3 b = textureLod(tBloom, vUv + t * vec2(0.7, 0.3), 1.5).rgb * 0.5
           + textureLod(tBloom, vUv + t * vec2(-0.6, 1.4), 2.5).rgb * 0.32
           + textureLod(tBloom, vUv + t * vec2(2.8, -1.2), 3.5).rgb * 0.18;
#else
    // (perf): 2 taps — a tight glow (lod 1.7) + the wide veil (lod 3.3), offset on rotated diagonals
    vec3 b = textureLod(tBloom, vUv + t * vec2(0.7, 0.3), 1.7).rgb * 0.62
           + textureLod(tBloom, vUv + t * vec2(-1.6, 2.2), 3.3).rgb * 0.38;
#endif
    c += b * uBloom;
  }
#endif
  if (uAerial > 0.0) {
    // from the air the target art's island is warm and rich, its open sea a deep saturated blue: land (not
    // blue-dominant) takes a little warmth + saturation, blue / cyan water deepens toward #02709e
    float l = dot(c, LUMA);
    float sea = smoothstep(1.15, 1.6, c.b / max(c.r, 1e-4)) * smoothstep(0.8, 1.05, c.b / max(c.g, 1e-4));
    vec3 land = max(mix(vec3(l), c, 1.12), 0.0) * vec3(1.04, 1.01, 0.94);
    // (gives the crowns a lit / shade separation) local contrast on the land — each pixel against the
    // mean of an 8-tap ring (~9 px at 1440p): sunlit crown tops lift and lean yellow-lime, the gaps between crowns sink
    // toward a cool blue-green (the target art's value split: shade hue ~122°, lit tops ~66°)
    {
      vec2 px = 9.0 / uSrcRes * (uSrcRes.y / 1440.0);
      float lm = 0.0;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.7853982 + 0.39;
        lm += dot(safe(texture2D(tColor, vUv + vec2(cos(a), sin(a)) * px).rgb), LUMA);
      }
      lm = max(lm / 8.0, 1e-4);
      float gr = smoothstep(0.0, 0.08, (c.g - max(c.r, c.b)) / max(c.g, 1e-4));
      float r = clamp(l / lm, 0.4, 2.5);
      float kk = uAerialLC * gr;
      land *= pow(r, 0.65 * kk);
      float litK = smoothstep(0.9, 1.35, r);
      land *= mix(vec3(1.0), mix(vec3(0.93, 1.0, 1.04), vec3(1.1, 1.04, 0.84), litK), kk);
    }
    vec3 water = max(mix(vec3(l), c, 1.15), 0.0) * vec3(0.72, 0.86, 0.95);
    // the open sea far out deepens toward the target art's #02709e (the view ray's slope: steep = the lagoons below)
    {
      vec3 rdA = normalize((uCamWorld * vec4(viewAt(vUv, 1.0), 0.0)).xyz);
      water *= mix(vec3(1.0), vec3(0.78, 0.9, 0.97), smoothstep(-0.8, -0.5, rdA.y));
    }
    c = mix(c, mix(land, water, sea), uAerial);
  }
  vec2 q = (vUv - 0.5) * vec2(1.25, 1.0);
  float vig = 1.0 - uVig * smoothstep(0.45, 1.25, length(q) * 1.6);
#ifdef USE_LUT
  // analytic tone curve, then grade + sRGB encode = ONE 3D fetch (grade.ts gradeLUT bakes the analytic path below)
  {
    vec3 sh = pow(clamp(tone(c * uExposure), 0.0, 1.0), vec3(1.0 / LUT_GAMMA));
#ifdef FIN_X_LUT
    c = sh;
#else
    c = texture(uLUT, sh * ((LUT_N - 1.0) / LUT_N) + 0.5 / LUT_N).rgb;
#endif
    // vignette on the (perceptual) display value ≈ on OkLab L
    c *= vig;
    if (uToScreen > 0.5) c += (ign(gl_FragCoord.xy + uFrame * 5.588238) + ign(gl_FragCoord.xy * 1.37 + 17.0 + uFrame * 3.1) - 1.0) / 255.0;
    else c = mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
  }
#else
  c = tone(c * uExposure);
  // ---- grade in OkLab: contrast on L (power S-curve around 0.55, bounded 0..1), saturation + warm split tone on chroma
  vec3 lab = toOklab(max(c, 0.0));
  float L = clamp(lab.x, 0.0, 1.0);
  float PV = uPivot;
  L = L < PV ? PV * pow(L / PV, uCon) : 1.0 - (1.0 - PV) * pow((1.0 - L) / (1.0 - PV), uCon);
  vec2 ab = lab.yz * uSat;
  float sh = 1.0 - smoothstep(0.25, 0.6, L), hl = smoothstep(0.55, 0.92, L);
  ab += vec2(0.12, 1.0) * (uShadeWarm * 0.045 * sh + uWarm * 0.045 * hl);
  // vignette on lightness only (hue stays)
  L *= vig;
  c = clamp(gamutSoft(fromOklab(vec3(L, ab)), L), 0.0, 1.0);
  if (uToScreen > 0.5) {
    c = mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    // triangular dither (±1 LSB, animated — never enters the history): no banding in the smooth sky gradient
    c += (ign(gl_FragCoord.xy + uFrame * 5.588238) + ign(gl_FragCoord.xy * 1.37 + 17.0 + uFrame * 3.1) - 1.0) / 255.0;
  }
#endif
  oOut = vec4(c, 1.0);
}`;

/** 1x1 "no moving object here" motion texture (b = 0) */
const NO_VEL = (() => { const t = new THREE.DataTexture(new Uint8Array(4), 1, 1); t.needsUpdate = true; return t; })();
class AtmosFinalPass extends Pass {
  /** bloom: prefilter target (1/4 res) WITH mipmaps — three builds the chain after the prefilter render */
  private pre: THREE.WebGLRenderTarget;
  private bloom: boolean;
  private preMat: THREE.ShaderMaterial;
  /** the one-pass material (no TAA: straight to the screen; TAA "mrt": history + display MRT) */
  readonly mat: THREE.ShaderMaterial;
  /** TAA: two MRT targets (history RGBA16F + display RGBA8), ping-pong (a two-pass resolve → display and a
   *  shader copy instead of the blit: both 0.02–0.1 ms slower, measured on an M5-class GPU) */
  private hist: THREE.WebGLRenderTarget[] = [];
  private idx = 0;
  reset = true;
  readonly reproj = new THREE.Matrix4();
  frame = 0;
  private w = 1; private h = 1;
  private dw = 1; private dh = 1;
  /** the scene render's size (= w, h unless a render scale < 1 is set) */
  private iw = 1; private ih = 1;
  /** tone + grade + sRGB as an N³ table (grade.ts gradeLUT), rebuilt per preset */
  readonly lut = (() => {
    const t = new THREE.Data3DTexture(new Uint16Array(LUT_N ** 3 * 4), LUT_N, LUT_N, LUT_N);
    t.format = THREE.RGBAFormat; t.type = THREE.HalfFloatType; t.colorSpace = THREE.NoColorSpace;
    t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
    t.generateMipmaps = false; t.unpackAlignment = 1; t.needsUpdate = true;
    return t;
  })();
  /** light shafts: quarter-res in-scatter (rgb) + linear depth (a) */
  readonly shaftRT = rt(1, 1, THREE.RGBAFormat, THREE.HalfFloatType, THREE.NearestFilter);
  private shaftTmp = rt(1, 1, THREE.RGBAFormat, THREE.HalfFloatType, THREE.NearestFilter);
  private shaftBlur = mat(SHAFT_BLUR_FRAG, { tIn: { value: null }, uSize: { value: new THREE.Vector2(1, 1) }, uDir: { value: new THREE.Vector2(1, 0) } });
  private shaftMat: THREE.ShaderMaterial | null = null;
  /** preset: x = open density, y = canopy density, z = mist share, w = max distance; g, strength */
  readonly shaft = new THREE.Vector4(0, 0, 0, 120);
  readonly shaft2 = new THREE.Vector3(0.5, 0, 1);
  readonly shaftCap = { value: 0.2 };
  private renderShafts(renderer: THREE.WebGLRenderer, depth: THREE.Texture | null) {
    const on = this.shafts && !!depth && this.shaft2.y > 0 && this.au.uAtmSunDir.value.y > -0.05;
    this.mat.uniforms.uShaftOn.value = on ? 1 : 0;
    if (!on) return;
    if (!this.shaftMat) {
      const au = this.au;
      const dbg = atmosFlags().has("shaftvis") ? 1 : atmosFlags().has("shaftmed") ? 2 : 0;
      this.shaftMat = mat(SHAFT_FRAG, {
        tDepth: { value: null }, uFull: { value: new THREE.Vector2(this.w, this.h) }, uNear: { value: 0.1 }, uFar: { value: 1000 }, uProjInfo: { value: new THREE.Vector4() },
        uCamWorld: { value: new THREE.Matrix4() }, uShaft: { value: this.shaft }, uShaft2: { value: this.shaft2 }, uShaftCap: this.shaftCap, uPostFog: this.mat.uniforms.uPostFog,
        uAtmFarMap: au.uAtmFarMap, uAtmFarMatrix: au.uAtmFarMatrix, uAtmFarParams: au.uAtmFarParams, uAtmCascMap: au.uAtmCascMap, uAtmCascMatrix: au.uAtmCascMatrix, uAtmCascMatrix0: au.uAtmCascMatrix0,
        uAtmCanopyMap: au.uAtmCanopyMap, uAtmCanopyMatrix: au.uAtmCanopyMatrix, uAtmCanopyParams: au.uAtmCanopyParams,
        uAtmCamPos: au.uAtmCamPos, uAtmSunDir: au.uAtmSunDir, uAtmSunColor: au.uAtmSunColor, uAtmSunI: au.uAtmSunI, uAtmFogHeight: au.uAtmFogHeight,
      }, { SHAFT_DBG: dbg });
    }
    const u = this.shaftMat.uniforms, cam = this.cam;
    u.tDepth.value = depth; u.uNear.value = cam.near; u.uFar.value = cam.far;
    u.uFull.value.set(this.iw, this.ih);
    cam.updateMatrixWorld();
    (u.uCamWorld.value as THREE.Matrix4).copy(cam.matrixWorld);
    setProjInfo(u.uProjInfo.value, cam.projectionMatrix);
    // the cascade atlas is valid once the sun rendered it (else the far map alone)
    this.shaft2.z = this.au.uAtmCascMap.value ? 1 : 0;
    const prev = this.fullscreenMaterial;
    this.fullscreenMaterial = this.shaftMat;
    draw(renderer, this, this.shaftRT);
    const bu = this.shaftBlur.uniforms;
    bu.uSize.value.set(this.shaftRT.width, this.shaftRT.height);
    this.fullscreenMaterial = this.shaftBlur;
    bu.tIn.value = this.shaftRT.texture; bu.uDir.value.set(1, 0); draw(renderer, this, this.shaftTmp);
    bu.tIn.value = this.shaftTmp.texture; bu.uDir.value.set(0, 1); draw(renderer, this, this.shaftRT);
    this.fullscreenMaterial = prev;
  }
  setGrade(p: Parameters<typeof gradeLUT>[0]) {
    (this.lut.image as { data: Uint16Array }).data = toHalf(gradeLUT(p));
    this.lut.needsUpdate = true;
  }

  private unrestore = onRestore("bake", () => { this.reset = true; });
  dispose() { this.unrestore(); for (const t of this.hist) t.dispose(); this.hist.length = 0; super.dispose(); }
  constructor(private cam: THREE.PerspectiveCamera, private ao: AtmosAOPass | null, readonly taa: boolean, bloom: boolean, sharpen: number, private au: AtmosUniforms, readonly shafts = false, fxaa = false) {
    super("AtmosFinalPass");
    this.needsSwap = true;
    this.needsDepthTexture = true;
    this.preMat = mat(PREFILTER_FRAG, { tColor: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.3 }, uKnee: { value: 0.5 }, uCap: { value: 8 } });
    this.bloom = bloom;
    this.pre = new THREE.WebGLRenderTarget(1, 1, { format: THREE.RGBAFormat, type: THREE.HalfFloatType, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: bloom });
    this.pre.texture.colorSpace = THREE.NoColorSpace;
    const defines: Record<string, number | string> = {};
    if (ao && atmosFlags().has("aodebug")) defines.AO_DEBUG = 1;
    if (atmosFlags().has("nodilate")) defines.TAA_NO_DILATE = 1;
    // terrain shimmer: the unsharp masks can sharpen against the resolved neighbourhood — OPT-IN (?atmos=taastable)
    // until measured in a browser (default = this frame's jittered cross)
    if (atmosFlags().has("taastable")) defines.TAA_STABLE = 1;
    if (atmosFlags().has("fogdebug")) defines.FOG_DEBUG = 1;
    if (ao && atmosFlags().has("gidebug")) defines.GI_DEBUG = 1;
    if (atmosFlags().has("shaftdebug")) defines.SHAFT_DEBUG = 1;
    if (bloom) defines.USE_BLOOM = 1;
    if (shafts) defines.USE_SHAFTS = 1;
    if (fxaa && !taa) defines.USE_FXAA = 1;
    const F = atmosFlags();
    if (!F.has("nolut")) Object.assign(defines, { USE_LUT: 1, LUT_GAMMA: LUT_GAMMA.toFixed(2), LUT_N: LUT_N.toFixed(1) });
    const common: Record<string, THREE.IUniform> = {
      tDepth: { value: null }, tAO: { value: ao?.out.textures[0] ?? null }, tGIdbg: { value: ao?.giOut.texture ?? null }, tBloom: { value: bloom ? this.pre.texture : null }, uBloomTexel: { value: new THREE.Vector2() },
      uReproj: { value: this.reproj }, uHalf: { value: new THREE.Vector2() }, uRes: { value: new THREE.Vector2() }, uSrcRes: { value: new THREE.Vector2() },
      uAlpha: { value: 0.1 }, uReset: { value: 1 }, uNearFix: { value: 0.9 }, uStill: { value: 0 }, uSharpMove: { value: 0.35 }, uTaaMove: { value: new THREE.Vector3(0.1, 2.0, 0.4) },
      tVM: { value: NO_VEL }, uVMOn: { value: 0 }, uFxaa: { value: new THREE.Vector3(0.0, 0.0833, 0.25) },
      uAO: { value: 1 }, uBloom: { value: 0.3 }, uExposure: { value: 1 }, uSat: { value: 1 }, uCon: { value: 1 }, uWarm: { value: 0 }, uShadeWarm: { value: 0 },
      uVig: { value: 0 }, uToe: { value: 1 }, uToScreen: { value: 1 }, uSharp: { value: sharpen }, uFrame: { value: 0 },
      uNear: { value: 0.1 }, uFar: { value: 1000 }, uProjInfo: { value: new THREE.Vector4() },
      uLUT: { value: this.lut }, uPivot: { value: 0.55 }, uKnee: { value: 0.96 },
      uPostFog: { value: 0 }, uPostFogStart: { value: 180 }, uGlare: { value: new THREE.Vector3() }, tGlareVis: { value: this.glareVis.texture }, uGlareColor: { value: new THREE.Color(1, 0.97, 0.92) }, uAspect: { value: 1.78 }, uCamWorld: { value: new THREE.Matrix4() },
      uAtmCamPos: au.uAtmCamPos, uAtmFogColor: au.uAtmFogColor, uAtmGlowColor: au.uAtmGlowColor, uAtmSunDir: au.uAtmSunDir, uAtmFogHeight: au.uAtmFogHeight,
      tShaft: { value: this.shaftRT.texture }, uShaftSize: { value: new THREE.Vector2(1, 1) }, uShaftOn: { value: 0 },
      uRain: { value: new THREE.Vector4() }, uRainSky: { value: new THREE.Color() }, uRainSkyLow: { value: new THREE.Color() }, uAerial: { value: 0 }, uAerialLC: { value: 1 },
    };
    const mk = (d: Record<string, number | string>) => {
      const m = mat(FINAL_FRAG, { ...common, tColor: { value: null }, tHist: { value: null } }, d);
      m.glslVersion = THREE.GLSL3;
      return m;
    };
    // ?atmos=hist11: R11G11B10 history (measured on an M5-class GPU: no faster than RGBA16F — the resolve is
    // latency-bound, not bandwidth-bound — so the full-precision history stays the default)
    const r11 = atmosFlags().has("hist11");
    this.mat = mk({ ...defines, ...(taa ? { USE_TAA: 1, OBJ_VEL: 1, ...(sharpen > 0 ? { USE_SHARPEN: 1 } : {}), ...(r11 ? { HIST_R11: 1 } : {}) } : {}) });
    this.mat.uniforms.tObjVel = { value: NO_VEL }; this.mat.uniforms.tObjVelPrev = { value: NO_VEL };
    if (taa) {
      for (let i = 0; i < 2; i++) {
        const t = new THREE.WebGLRenderTarget(1, 1, { count: 2, type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
        t.textures[0].colorSpace = THREE.NoColorSpace;
        if (r11) { t.textures[0].format = THREE.RGBFormat; t.textures[0].type = THREE.UnsignedInt101111Type; }
        t.textures[1].type = THREE.UnsignedByteType; t.textures[1].colorSpace = THREE.NoColorSpace;
        t.textures[1].minFilter = t.textures[1].magFilter = THREE.NearestFilter;
        this.hist.push(t);
      }
    }
    this.fullscreenMaterial = this.mat;
  }

  /** sun glare strength (preset `glare`); the veil fades out as the sun leaves the view cone */
  glare = 0;
  /** 1x1 sun visibility (GLARE_VIS_FRAG), blended over frames */
  readonly glareVis = (() => { const t = rt(1, 1, THREE.RGBAFormat, THREE.HalfFloatType, THREE.NearestFilter); return t; })();
  private visMat = new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: GLARE_VIS_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
    uniforms: { tDepth: { value: null }, uSun: { value: new THREE.Vector2() }, uDisc: { value: new THREE.Vector2(0.03, 0.05) }, uBlend: { value: 1 } },
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  private visReset = true;
  private _gv = new THREE.Vector3();
  private _gf = new THREE.Vector3();
  private updateGlare() {
    const u = this.mat.uniforms, g = u.uGlare.value as THREE.Vector3;
    if (this.glare <= 0) { g.z = 0; return; }
    const cam = this.cam, sun = u.uAtmSunDir.value as THREE.Vector3;
    cam.updateMatrixWorld();
    const f = this._gf.set(0, 0, -1).transformDirection(cam.matrixWorld);
    const ang = Math.acos(Math.min(1, Math.max(-1, f.dot(sun)))) * 180 / Math.PI;
    // full within the frame's half-diagonal (~35–45°), gone by ~58°
    const halfV = cam.fov / 2, halfD = Math.atan(Math.tan(halfV * Math.PI / 180) * Math.hypot(1, cam.aspect)) * 180 / Math.PI;
    const k = 1 - Math.min(1, Math.max(0, (ang - halfD * 0.8) / (halfD * 0.55)));
    if (k <= 0 || f.dot(sun) <= 0.05) { g.z = 0; return; }
    // project a far point along the sun (unjittered view-projection is fine for a soft veil)
    const p = this._gv.copy(sun).multiplyScalar(1000).add(cam.position).applyMatrix4(cam.matrixWorldInverse);
    const x = (cam.projectionMatrix.elements[0] * p.x + cam.projectionMatrix.elements[8] * p.z) / -p.z;
    const y = (cam.projectionMatrix.elements[5] * p.y + cam.projectionMatrix.elements[9] * p.z) / -p.z;
    g.set(x * 0.5 + 0.5, y * 0.5 + 0.5, this.glare * k * k * (3 - 2 * k));
    u.uAspect.value = cam.aspect;
  }

  /** the sun's visibility for the veil: a 1x1 pass over the scene depth (only while the veil is on) */
  private updateGlareVis(renderer: THREE.WebGLRenderer, depth: THREE.Texture | null) {
    const g = this.mat.uniforms.uGlare.value as THREE.Vector3;
    if (g.z <= 0 || !depth) { this.visReset = true; return; }
    const vu = this.visMat.uniforms, cam = this.cam;
    vu.tDepth.value = depth;
    vu.uSun.value.set(g.x, g.y);
    // disc radius ≈ 2.2° (the sun's glow core) in uv units of each axis
    const r = Math.tan(2.2 * Math.PI / 180) / Math.tan(cam.fov * Math.PI / 360) * 0.5;
    vu.uDisc.value.set(r / cam.aspect, r);
    vu.uBlend.value = this.visReset || this.reset ? 1 : 0.22;
    this.visReset = false;
    const prev = this.fullscreenMaterial;
    this.fullscreenMaterial = this.visMat;
    renderer.setRenderTarget(this.glareVis);
    const p = this as unknown as { scene: THREE.Scene; camera: THREE.Camera };
    renderer.render(p.scene, p.camera);
    this.fullscreenMaterial = prev;
  }

  /** the latest TAA history (HDR scene radiance of the last frame) */
  histTex(): THREE.Texture | null { return this.taa && !this.reset ? this.hist[this.idx].textures[0] : null; }
  /** runtime bloom toggle (tools) */
  private savedBloom = -1;
  setBloom(on: boolean) {
    const b = this.mat.uniforms.uBloom;
    if (!on && this.savedBloom < 0) { this.savedBloom = b.value; b.value = 0; }
    else if (on && this.savedBloom >= 0) { b.value = this.savedBloom; this.savedBloom = -1; }
  }

  private bloomAge = 99;
  /** object motion vectors (ctx.shared "post:objvel", the actors area's kongs): rendered against the scene depth right
   *  before the resolve; null / no objects → a blank texture (the camera-only path) */
  objVel: ((r: THREE.WebGLRenderer, depth: THREE.Texture | null) => { cur: THREE.Texture; prev: THREE.Texture } | null) | null = null;
  render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget) {
    // (perf) the bloom prefilter (a full-res read + mip build, ~0.08 ms) runs on the frames the AO pass
    // skips (half rate each, alternating) — the soft glow lags at most one frame
    this.bloomAge++;
    // (on the AO's off frames only, at the AO's period — 2 moving, 3 still: frames alternate AO / bloom / nothing)
    const period = this.ao?.period ?? 2;
    if (this.bloom && (this.reset || this.bloomAge >= period + 1 || (this.bloomAge >= period && (!this.ao || this.ao.skipped)))) {
      this.preMat.uniforms.tColor.value = inputBuffer.texture;
      this.fullscreenMaterial = this.preMat;
      draw(renderer, this, this.pre); // three regenerates the mip chain after this render (the blur)
      this.bloomAge = 0;
    }
    const u = this.mat.uniforms;
    u.tDepth.value = this.ao?.depth ?? inputBuffer.depthTexture;
    const rain = u.uRain.value as THREE.Vector4;
    if (u.uPostFog.value > 0 || rain.x + rain.y + rain.z > 0) { this.cam.updateMatrixWorld(); (u.uCamWorld.value as THREE.Matrix4).copy(this.cam.matrixWorld); }
    this.updateGlare();
    this.updateGlareVis(renderer, u.tDepth.value);
    this.renderShafts(renderer, u.tDepth.value);
    u.uFrame.value = this.frame++ & 255;
    u.uNear.value = this.cam.near; u.uFar.value = this.cam.far;
    u.uReset.value = this.reset ? 1 : 0;
    const screen = this.renderToScreen ? null : outputBuffer;
    if (!this.taa) {
      u.tColor.value = inputBuffer.texture;
      u.uToScreen.value = this.renderToScreen ? 1 : 0;
      this.fullscreenMaterial = this.mat;
      draw(renderer, this, screen);
      return;
    }
    const prev = this.hist[this.idx], next = this.hist[this.idx ^ 1];
    const ov = this.objVel && !this.reset ? this.objVel(renderer, inputBuffer.depthTexture) : null;
    u.tObjVel.value = ov?.cur ?? NO_VEL; u.tObjVelPrev.value = ov?.prev ?? NO_VEL;
    u.tColor.value = inputBuffer.texture;
    u.tHist.value = prev.textures[0];
    u.uToScreen.value = 1; // the display attachment is 8-bit: always sRGB-encoded + dithered
    this.fullscreenMaterial = this.mat;
    draw(renderer, this, next);
    this.idx ^= 1;
    this.reset = false;
    // blit the display attachment to the canvas (or the composer's output buffer)
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const props = renderer.properties as unknown as { get(o: object): { __webglFramebuffer?: WebGLFramebuffer } };
    const src = props.get(next).__webglFramebuffer!;
    const dst = this.renderToScreen ? null : (renderer.setRenderTarget(outputBuffer), props.get(outputBuffer).__webglFramebuffer ?? null);
    const state = renderer.state as unknown as { bindFramebuffer(t: number, f: WebGLFramebuffer | null): boolean };
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, src);
    state.bindFramebuffer(gl.DRAW_FRAMEBUFFER, dst);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    const dw = this.renderToScreen ? this.dw : this.w, dh = this.renderToScreen ? this.dh : this.h;
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, dw, dh, gl.COLOR_BUFFER_BIT, dw === this.w && dh === this.h ? gl.NEAREST : gl.LINEAR);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    state.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    renderer.setRenderTarget(null);
  }

  setSize(w: number, h: number) { this.setSizes(w, h, w, h, w, h); }
  /** TAAU: the scene / AO / bloom / shafts run at (w, h); the TAA history and the display at (ow, oh); the canvas at (dw, dh) */
  setSizes(w: number, h: number, ow: number, oh: number, dw: number, dh: number) {
    this.w = ow; this.h = oh; this.iw = w; this.ih = h; this.dw = dw; this.dh = dh;
    // bloom at QUARTER resolution: the prefilter's 4 bilinear taps cover the 4x4 full-res texels of each output pixel
    const qw = Math.max(1, w >> 2), qh = Math.max(1, h >> 2);
    this.pre.setSize(qw, qh);
    this.preMat.uniforms.tColor.value = null;
    this.preMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.mat.uniforms.uBloomTexel.value.set(1 / qw, 1 / qh);
    const s = this.ao?.scale ?? 2;
    this.mat.uniforms.uHalf.value.set(Math.max(1, Math.floor(w / s)), Math.max(1, Math.floor(h / s)));
    this.mat.uniforms.uRes.value.set(ow, oh);
    this.mat.uniforms.uSrcRes.value.set(w, h);
    for (const t of this.hist) t.setSize(ow, oh);
    const sw = Math.max(1, Math.ceil(w / 4)), sh = Math.max(1, Math.ceil(h / 4));
    this.shaftRT.setSize(sw, sh); this.shaftTmp.setSize(sw, sh);
    this.mat.uniforms.uShaftSize.value.set(sw, sh);
    this.reset = true;
  }
}

/** anti-aliasing mode — TAA (temporal, sharpest at rest; the viewmodel and moving kongs are handled), FXAA
 *  (spatial, no temporal smear), off */
export type AAMode = "taa" | "fxaa" | "off";
export interface PostOptions { aa: AAMode; ao: boolean; bloom: boolean; shafts: boolean; gi: boolean }

/** the viewmodel pass's own near plane (m): an aimed gun's receiver / stock sit 3-10 cm from the
 *  eye — the world camera's 10 cm near cut them open */
const VM_NEAR = 0.01;
/** a pass that runs a callback between two passes of the chain (the native viewmodel draw) */
class HookPass extends Pass {
  constructor(private fn: (r: THREE.WebGLRenderer) => void) { super("AtmosHookPass"); this.needsSwap = false; }
  render(renderer: THREE.WebGLRenderer) { this.fn(renderer); }
}

/** Halton(2,3) sub-pixel jitter, 8 phases */
const HALTON: Array<[number, number]> = (() => {
  const h = (i: number, b: number) => { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; };
  return Array.from({ length: 8 }, (_, i) => [h(i + 1, 2) - 0.5, h(i + 1, 3) - 0.5] as [number, number]);
})();

export class AtmosPost implements PostPipeline {
  composer: EffectComposer | null = null;
  ao: AtmosAOPass | null = null;
  composite: AtmosFinalPass | null = null;
  /** true when the final pass resolves TAA (jittered projection) */
  taa = false;
  private w = 1; private h = 1;
  private frame = 0;
  private proj = new THREE.Matrix4();
  private projInv = new THREE.Matrix4();
  private vp = new THREE.Matrix4();
  private vpInv = new THREE.Matrix4();
  private prevVP = new THREE.Matrix4();
  private prevPos = new THREE.Vector3();
  private prevQ = new THREE.Quaternion();
  private hasPrev = false;
  /** last frame's projection [5] (1 / tan(fov / 2)): a zoom drops the TAA history */
  private prevE5 = 0;
  /** the camera did not move since the last frame (AO / bloom / shadow schedules, the TAA's identity reprojection) */
  private still = false;
  /** the height fog / mist runs in the final pass (the materials' own fog density is zeroed — index.ts) */
  get fogInPost() { return !!this.composite; }
  /** tools: the materials skip the screen-space AO / cloud lookup (A/B of its cost) */
  ssOff = false;
  private noAerial = atmosFlags().has("noaerialgrade");

  /** the live post options (the video settings switch them without a reload — configure()) */
  opts: PostOptions;
  /** the materials were built for the screen-space AO / cloud-shadow path (AO can be switched on and off at runtime) */
  readonly ssCapable: boolean;
  private cssW = 0; private cssH = 0;

  constructor(private ctx: WorldCtx, private state: AtmosState, private quality: Quality, private u: AtmosUniforms) {
    const r = ctx.renderer;
    const f = atmosFlags();
    r.toneMappingExposure = state.preset.exposure;
    // low (so its look does not diverge): the same tone curve + LUT grade as ultra in ONE cheap pass
    // (no AO / TAA / bloom / sharpen)
    const low = quality === "low";
    this.opts = {
      aa: low || f.has("notaa") ? "off" : "taa",
      ao: !f.has("noao") && !low,
      bloom: quality !== "medium" && !low && !f.has("nobloom"),
      shafts: (quality === "ultra" || quality === "high") && !f.has("noshafts"),
      gi: (quality === "ultra" || quality === "high") && !f.has("nogi"),
    };
    this.ssCapable = !f.has("nopost") && !f.has("noao") && !low;
    if (f.has("nopost")) { r.toneMapping = THREE.NeutralToneMapping; return; }
    this.build();
  }

  /** switch AA mode / AO / bloom / light shafts / GI live (rebuilds the pass chain; the materials keep
   *  their programs — the AO is a runtime uniform switch for them) */
  configure(o: Partial<PostOptions>) {
    if (!this.composer) return;
    const next = { ...this.opts, ...o };
    if (JSON.stringify(next) === JSON.stringify(this.opts)) return;
    this.opts = next;
    this.build();
  }

  private build() {
    const ctx = this.ctx, r = ctx.renderer, f = atmosFlags(), o = this.opts, quality = this.quality;
    if (this.composer) {
      this.composer.dispose();
      this.composer = null; this.ao = null; this.composite = null;
      this.u.uAtmAOParams.value.x = 0;
      this.u.uAtmAO.value = null; this.u.uAtmGI.value = null; this.u.uAtmGIParams.value.x = 0;
      this.hasPrev = false;
    }
    r.toneMapping = THREE.NoToneMapping; // the composite tone-maps (materials skip it when rendering to a target anyway)

    const composer = new EffectComposer(r, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
    const rp = new RenderPass(ctx.scene, ctx.camera);
    rp.needsDepthBlit = false; // the AO / TAA passes read the scene buffer's own depth texture (no per-frame depth copy)
    composer.addPass(rp);

    const cam = ctx.camera;
    // contact-weighted AO: short radius, most taps near the centre
    const aoCfg = { ultra: [8, 0.9, 1.7], high: [6, 0.9, 1.7], medium: [4, 0.8, 1.5], low: [4, 0.8, 1.5] }[quality];
    if (o.ao && this.ssCapable) {
      // The AO is applied INSIDE each lit material (a post-multiply upsample drew stair-step halos / a ghost box),
      // through a depth-aware bilinear that
      // drops every tap whose depth disagrees (→ 1.0, never a borrowed halo), and translucent FX never see it.
      // HALF resolution on ultra / high (quarter res drew 20-35 px halos in interiors) — the near-lens kernel is capped at ~11 px
      // and the 4x4 blur is 8 px wide there (quarter res made every contact gradient ≥ 16 px). ?atmos=aoquarter = quarter
      // res; medium (and low, when the settings switch AO on there) keep quarter.
      const scale = f.has("aoquarter") || quality === "medium" || quality === "low" ? 4 : 2;
      const gi = o.gi && o.aa === "taa" && !f.has("smaa");
      this.ao = new AtmosAOPass(cam, this.u, aoCfg[0], aoCfg[1], aoCfg[2], scale, gi);
      composer.addPass(this.ao);
    }
    const useTaa = o.aa === "taa" && !f.has("smaa");
    this.taa = useTaa;
    // sharpen: a weak mask (0.25) kept only 54 % of the AA-off detail under TAA (distant things looked out of focus); at
    // ~0.7 the lookout measured TAA still 82 % of AA-off, strafe 89 % of still with the history sharpening below);
    // the mask stays clamped to this frame's neighbourhood (no halos)
    const sharpen = f.has("nosharpen") ? 0 : quality === "medium" || quality === "low" ? 0.6 : 0.8;
    composer.addPass(new HookPass((rr) => this.renderVM(rr)));
    this.composite = new AtmosFinalPass(cam, this.ao, useTaa, o.bloom, sharpen, this.u, o.shafts, o.aa === "fxaa");
    composer.addPass(this.composite);
    if (f.has("smaa")) composer.addPass(new EffectPass(cam, new SMAAEffect({ preset: SMAAPreset.HIGH, edgeDetectionMode: EdgeDetectionMode.LUMA })));
    // the scene buffers as R11G11B10F: 4 bytes / px like the backbuffer (half of RGBA16F) — the scene render's own
    // bandwidth; the TAA history stays RGBA16F (accumulation precision). Set AFTER addPass (passes size their own
    // targets from the composer's type at addPass). ?atmos=rgba16 keeps half floats.
    if (!f.has("rgba16") && !f.has("smaa")) {
      for (const b of [composer.inputBuffer, composer.outputBuffer]) { b.texture.format = THREE.RGBFormat; b.texture.type = THREE.UnsignedInt101111Type; b.dispose(); }
    }
    this.composer = composer;
    if (this.ao && this.composite) { const fin = this.composite; this.ao.histTex = () => fin.histTex(); this.ao.prevVP = this.prevVP; }
    this.applyPreset();
    if (this.cssW > 0) this.setSize(this.cssW, this.cssH);
    // the engine re-derives the canvas pixel ratio / render scale for the new AA mode (TAAU needs TAA)
    (ctx as unknown as { onPostRebuilt?: () => void }).onPostRebuilt?.();
  }

  applyPreset() {
    const p = this.state.preset;
    this.ctx.renderer.toneMappingExposure = p.exposure;
    const u = this.composite?.mat.uniforms;
    if (!u) return;
    u.uExposure.value = p.exposure;
    u.uSat.value = p.saturation; u.uCon.value = p.contrast; u.uWarm.value = p.warmth; u.uShadeWarm.value = p.shadeWarmth ?? 0.05;
    u.uVig.value = p.vignette; u.uBloom.value = p.bloom; u.uAO.value = p.ao ?? 1; u.uToe.value = p.toe ?? 1;
    u.uPivot.value = p.pivot ?? 0.55; u.uKnee.value = p.knee ?? 0.96;
    u.uPostFog.value = atmosFlags().has("nofog") ? 0 : p.fogDensity;
    u.uPostFogStart.value = p.fogStart ?? 180;
    u.uAerialLC.value = p.aerialLC ?? 1;
    this.composite!.glare = atmosFlags().has("noglare") ? 0 : p.glare ?? 0;
    this.composite!.shaft.set(p.shaftOpen ?? 0, p.shaftCanopy ?? 0, p.shaftMist ?? 0, p.shaftDist ?? 120);
    (u.uRain.value as THREE.Vector4).set(p.rainStreaks ?? 0, p.rainbow ?? 0, p.puddles ?? 0, 0);
    (u.uRainSky.value as THREE.Color).copy(this.u.uAtmMid.value); (u.uRainSkyLow.value as THREE.Color).copy(this.u.uAtmHorizon.value);
    const gp = this.u.uAtmGIParams.value;
    gp.y = atmosFlags().has("nobounce") ? 0 : p.gi ?? 0; gp.z = atmosFlags().has("nointerior") ? 0 : p.interiorLoss ?? 0;
    this.composite!.shaft2.set(p.shaftG ?? 0.55, p.shafts ?? 0, 1);
    this.composite!.shaftCap.value = p.shaftCap ?? 0.2;
    (u.uGlareColor.value as THREE.Color).set(p.glowColor).lerp(new THREE.Color(1, 1, 1), p.glareWhite ?? 0.6);
    this.ao?.tune(p.aoBias, p.aoRadius, p.aoIntensity !== undefined ? p.aoIntensity * (p.ao ?? 1) : undefined);
    this.composite?.setGrade(gradeParams(p));
  }

  render(dt: number) {
    const composer = this.composer;
    if (!composer) { this.ctx.renderer.render(this.ctx.scene, this.ctx.camera); return; }
    const cam = this.ctx.camera;
    const taa = this.taa ? this.composite! : null;
    cam.updateMatrixWorld();
    this.still = this.hasPrev && cam.position.distanceToSquared(this.prevPos) < 1e-6 && cam.quaternion.angleTo(this.prevQ) < 1e-4;
    if (taa) {
      this.proj.copy(cam.projectionMatrix);
      // the cascade fit (shadows.ts) reads the unjittered inverse projection
      cam.userData.atmProjInv = this.projInv.copy(this.proj).invert();
      this.vp.multiplyMatrices(this.proj, cam.matrixWorldInverse);
      // camera cut (teleport / view switch): drop the history
      if (!this.hasPrev || cam.position.distanceTo(this.prevPos) > 6 || cam.quaternion.angleTo(this.prevQ) > 0.6) taa.reset = true;
      // a FOV change (ADS in / out, sprint / slide
      // kick) scales the whole image about the centre — the history resampled at the zoom smeared it for ~0.5 s. While
      // the zoom moves faster than 0.08 % per frame, this frame is shown without history (crisp; the jitter is invisible
      // inside a zoom), the history restarts from it once the zoom settles
      { const e5 = this.proj.elements[5]; if (this.hasPrev && Math.abs(e5 - this.prevE5) > 0.0008 * e5) taa.reset = true; this.prevE5 = e5; }
      taa.reproj.copy(this.prevVP).multiply(this.vpInv.copy(this.vp).invert());
      const [jx, jy] = HALTON[this.frame++ % HALTON.length];
      const e = cam.projectionMatrix.elements;
      e[8] += (2 * jx) / this.w; e[9] += (2 * jy) / this.h;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      // the viewmodel's vertices undo it (shadows.ts patch): the resolve shows it without history (FINAL_FRAG isVM)
      this.u.uAtmJitter.value.set((2 * jx) / this.w, (2 * jy) / this.h, this.composite!.mat.uniforms.uNearFix.value, 0);
    }
    if (this.ao) {
      this.ao.frame = this.frame;
      // a still camera (tools, spectating, a player standing still aiming): AO + bloom refresh every 3rd frame
      this.ao.period = this.still ? 3 : 2;
      this.ao.still = this.still;
    }
    // a still camera (the reprojection is the identity): the final pass skips the depth dilation, the materials' cascade-0
    // PCF takes ONE rotated tap per frame (the TAA accumulates the same kernel — uAtmTemporal.x = 2)
    this.composite!.mat.uniforms.uStill.value = this.still ? 1 : 0;
    // a perfectly still camera accumulates longer (the 8-phase jitter's residual on edges averages out further)
    this.composite!.mat.uniforms.uAlpha.value = this.still ? 0.06 : 0.1;
    this.composite!.objVel = (this.ctx.shared.get("post:objvel") as AtmosFinalPass["objVel"]) ?? null;
    (this.composite!.mat.uniforms.uRain.value as THREE.Vector4).w = ((this.ctx as unknown as { time?: number }).time ?? 0) % 1000;
    { const y = cam.position.y, k = Math.min(1, Math.max(0, (y - 250) / 650)); this.composite!.mat.uniforms.uAerial.value = this.noAerial ? 0 : k * k * (3 - 2 * k) * (this.state.preset.aerialGrade ?? 1); }
    if (this.taa) this.u.uAtmTemporal.value.x = this.still ? 2 : 1;
    setProjInfo(this.composite!.mat.uniforms.uProjInfo.value, cam.projectionMatrix);
    // the screen-space AO / cloud terms apply to THIS scene render only (other renders — impostor bakes, probes, the
    // far-shadow bake — see 0: a different camera must not reproject the main camera's AO)
    const aoP = this.u.uAtmAOParams.value;
    aoP.x = this.ao?.valid && !this.ssOff ? 1 : 0;
    // under a 3D resolution < 100 % the viewmodel leaves the scene render and is drawn at native resolution by
    // renderVM (between the AO and the final pass), composited by the final pass
    const vm = this.vmActive = this.vmNative();
    if (vm) for (const o of vm) o.visible = false;
    try { composer.render(dt); } finally { if (vm) for (const o of vm) o.visible = true; }
    aoP.x = 0;
    this.u.uAtmJitter.value.z = 0;
    if (taa) {
      cam.projectionMatrix.copy(this.proj);
      cam.projectionMatrixInverse.copy(this.proj).invert();
      this.prevVP.copy(this.vp);
      this.prevPos.copy(cam.position); this.prevQ.copy(cam.quaternion);
      this.hasPrev = true;
    }
  }

  // ---- native viewmodel (bilinear-upscaled it kept only 24 % of native sharpness on an M1 at Medium): while
  // the scene renders below 100 % the first-person viewmodel is drawn ALONE, at the canvas resolution, unjittered, into
  // vmRT (premultiplied colour + coverage) and composited over the upscaled world by the final pass — the weapon stays
  // native-sharp at any 3D resolution and never enters the TAA history. ?atmos=novmnative = the in-scene path.
  private vmRT: THREE.WebGLRenderTarget | null = null;
  private vmScene = (() => { const sc = new THREE.Scene(); sc.matrixWorldAutoUpdate = false; sc.matrixAutoUpdate = false; return sc; })();
  private vmLights: THREE.Object3D[] = [];
  private vmLightAge = 1e9;
  /** the camera children drawn by the viewmodel pass (the viewmodel + anything flagged userData.vmPass: the banana
   *  bomb's throwing hands), rescanned when the camera's child count changes; vmOn = those visible this frame */
  private vmList: THREE.Object3D[] = [];
  private vmKids = -1;
  private vmOn: THREE.Object3D[] = [];
  private vmActive: THREE.Object3D[] | null = null;
  private vmColor = new THREE.Color();
  private vmSaved = new THREE.Matrix4();
  private vmKidArr: THREE.Object3D[] = [];
  private readonly vmNoKids: THREE.Object3D[] = [];
  private vmProj = new THREE.Matrix4();
  private vmNative(): THREE.Object3D[] | null {
    // (drawn IN the scene at 100 % 3D resolution, the
    // viewmodel shared its depth buffer, so a rock / wall / tree a step away was drawn
    // THROUGH the gun) the native pass at EVERY resolution: its own depth, composited over the world — the world never
    // cuts into the hands or the gun, the world behind the gun keeps its TAA history, no screen-space AO steps on it
    if (atmosFlags().has("novmnative")) return null;
    const cam = this.ctx.camera;
    if (cam.children.length !== this.vmKids) { this.vmKids = cam.children.length; this.vmList = cam.children.filter((o) => o.name === "viewmodel" || o.userData.vmPass === true); }
    this.vmOn.length = 0;
    for (const o of this.vmList) if (o.visible && o.parent === cam) this.vmOn.push(o);
    return this.vmOn.length ? this.vmOn : null;
  }
  private renderVM(r: THREE.WebGLRenderer) {
    const u = this.composite?.mat.uniforms;
    const vm = this.vmActive;
    if (!u) return;
    u.uVMOn.value = 0;
    if (!vm) return;
    const cam = this.ctx.camera, scene = this.ctx.scene;
    if (!this.vmRT) {
      this.vmRT = new THREE.WebGLRenderTarget(this.fullW, this.fullH, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, stencilBuffer: false, generateMipmaps: false });
      this.vmRT.texture.colorSpace = THREE.NoColorSpace;
    }
    if (this.vmRT.width !== this.outW || this.vmRT.height !== this.outH) this.vmRT.setSize(this.outW, this.outH);
    // the scene's lights (same count → the viewmodel's programs are the ones the scene render uses; rescanned ~1 / s)
    if (++this.vmLightAge > 60) {
      this.vmLightAge = 0; this.vmLights = [];
      scene.traverseVisible((o) => { if ((o as THREE.Light).isLight) this.vmLights.push(o); });
    }
    const kids = this.vmKidArr; kids.length = 0;
    for (const o of vm) kids.push(o);
    for (const l of this.vmLights) if (l.visible) kids.push(l);
    const sc = this.vmScene;
    sc.children = kids; // (no reparenting: the matrices stay the ones the scene walk just computed)
    // (otherwise the gun + hands read ~20 % brighter indoors / under the canopy): the IBL at the SCENE's intensity
    // (atmos/env.ts sets scene.environmentIntensity 0.52-0.95 per preset; this scene kept the default 1 — in shade, where
    // the image-based fill is all the light there is, the gun got up to 1 / 0.52 × of it)
    sc.fog = scene.fog; sc.environment = scene.environment; sc.environmentIntensity = scene.environmentIntensity; sc.environmentRotation.copy(scene.environmentRotation); sc.background = null;
    // unjittered projection, no jitter undo, no screen-space AO (that texture is the world's) — the camera's AO / cloud
    // / interior terms instead (uAtmVMEnv, atmos/index.ts) — and its OWN near plane: 1 cm, so an aimed
    // gun whose stock / receiver sits a hand-width from the eye is drawn closed, never cut open by the world's 10 cm
    // near plane (a 50 m far keeps the depth precision: the pass only ever holds the hands and what they carry)
    const pm = cam.projectionMatrix, saved = this.vmSaved.copy(pm);
    { this.vmProj.copy(this.taa ? this.proj : pm); const e = this.vmProj.elements, n = VM_NEAR, f = 50; e[10] = -(f + n) / (f - n); e[14] = (-2 * f * n) / (f - n); }
    cam.userData.vmNear = VM_NEAR;   // (tools: what the viewmodel pass clips at)
    pm.copy(this.vmProj); cam.projectionMatrixInverse.copy(pm).invert();
    const jz = this.u.uAtmJitter.value.z, aoX = this.u.uAtmAOParams.value.x;
    this.u.uAtmJitter.value.z = 0; this.u.uAtmAOParams.value.x = 0; this.u.uAtmVMEnv.value.x = 1;
    const sm = r.shadowMap, smA = sm.autoUpdate, smN = sm.needsUpdate, ac = r.autoClear, ca = r.getClearAlpha();
    r.getClearColor(this.vmColor);
    sm.autoUpdate = false; sm.needsUpdate = false; r.autoClear = false;
    for (const o of vm) o.visible = true;
    try {
      r.setRenderTarget(this.vmRT);
      r.setClearColor(0x000000, 0);
      r.clear(true, true, false);
      r.render(sc, cam);
    } finally {
      for (const o of vm) o.visible = false;
      sc.children = this.vmNoKids;
      r.setClearColor(this.vmColor, ca);
      sm.autoUpdate = smA; sm.needsUpdate = smN; r.autoClear = ac;
      this.u.uAtmJitter.value.z = jz; this.u.uAtmAOParams.value.x = aoX; this.u.uAtmVMEnv.value.x = 0;
      pm.copy(saved); cam.projectionMatrixInverse.copy(pm).invert();
    }
    u.tVM.value = this.vmRT.texture;
    u.uVMOn.value = 1;
  }

  /** Read the actual target: its size includes DPR, render scale, and integer rounding. */
  getSceneHeight() { return this.composer?.inputBuffer.height ?? this.ctx.renderer.domElement.height; }

  setSize(w: number, h: number) {
    this.cssW = w; this.cssH = h;
    const pr = this.ctx.renderer.getPixelRatio();
    this.fullW = Math.max(1, Math.floor(w * pr)); this.fullH = Math.max(1, Math.floor(h * pr));
    this.composer?.setSize(w, h);
    this.applyScale();
  }

  /** (perf — dynamic resolution / TAAU) render the scene (+ AO, bloom, shafts) at s × the canvas and let
   *  the TAA resolve reconstruct the full-resolution frame. 0.5..1; the engine may call it every frame (cheap when
   *  unchanged). Needs TAA (no-TAA tiers ignore it). */
  setRenderScale(s: number) {
    const v = Math.min(1, Math.max(0.5, Number.isFinite(s) ? s : 1));
    if (Math.abs(v - this.renderScale) < 0.01) return;
    this.renderScale = v;
    this.applyScale();
  }
  renderScale = 1;
  private fullW = 1; private fullH = 1;
  private outW = 1; private outH = 1;
  pixScale = 1;
  private applyScale() {
    const composer = this.composer;
    const sc = this.renderScale;
    const k = this.pixScale = PIXCAP && !atmosFlags().has("smaa") ? Math.min(1, Math.sqrt(MAX_PIXELS[this.quality] / (this.fullW * this.fullH))) : 1;
    const cw = Math.max(1, Math.round(this.fullW * k)), ch = Math.max(1, Math.round(this.fullH * k));
    this.outW = this.taa ? cw : this.fullW; this.outH = this.taa ? ch : this.fullH;
    const sw = Math.max(1, Math.round(cw * sc)), sh = Math.max(1, Math.round(ch * sc));
    this.w = sw; this.h = sh;
    if (!composer) return;
    if (sc === 1 && composer.inputBuffer.width === sw && composer.inputBuffer.height === sh && this.composite && (this.composite as unknown as { iw: number; w: number }).iw === sw && (this.composite as unknown as { iw: number; w: number }).w === this.outW) return;
    composer.inputBuffer.setSize(sw, sh);
    composer.outputBuffer.setSize(sw, sh);
    for (const p of (composer as unknown as { passes: Pass[] }).passes) {
      if (p === this.composite) this.composite.setSizes(sw, sh, this.outW, this.outH, this.fullW, this.fullH);
      else p.setSize(sw, sh);
    }
    if (this.composite) this.composite.reset = true;
  }
}
