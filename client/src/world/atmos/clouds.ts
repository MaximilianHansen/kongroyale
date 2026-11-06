// Stylized cumulus, raymarched. Each cloud is a prototype SDF volume (cloud-shapes.ts → cloud-bake.ts) instanced with
// its own position / width / yaw. Per pixel we sphere-trace the volume inside the cloud's box (back faces, so the
// camera may be inside the box), then shade the hit with SDF normals, SDF ambient occlusion (the creases between
// florets), a soft self-shadow march toward the sun, a BRIGHT sky ambient (pale blue-grey base → white top — the
// target art's clouds are white masses with light blue-grey bellies, never grey balloons), a wrapped sun term, and
// forward scattering (backlit clouds glow white at their thin edges — a soft halo, no hard outline).
// When a cloud is big on screen (voxel > ~1.5 px), a tiling 3D "cauliflower" detail field is added near the surface
// so florets keep their bumps at 700+ px.
// Draw order: AFTER the water (which is written opaque in the transparent pass) and before every other transparent.
// Cloud shadows: a periodic world-space transmission tile (period = the cloud wrap), painted ONCE from the same sphere
// hierarchies (no drift repaint); every lit material samples it through atmosCloudShadow (direct sun only).
import * as THREE from "three";
import { ATMOS_PARS, type AtmosUniforms } from "./glsl";
import { gradeParams, type AtmosState } from "./state";
import { gradeInv } from "./grade";
import { sculptCloud, type CloudKind } from "./cloud-shapes";
import { bakeCloudVolume, makeDetailNoise, type CloudVolume } from "./cloud-bake";
import type { CloudSpec } from "./cloud-field";
import type { Quality } from "../../engine/engine";
import { flag } from "../../flags";
import { onRestore } from "../../engine/res/restore";

export { cloudField } from "./cloud-field";
export type { CloudSpec } from "./cloud-field";

const VERT = /* glsl */ `
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// impostor tile pass: a fullscreen quad over the tile; each texel is a point of the impostor plane (cloud-local
// coordinates), the ray runs from the camera through it — exactly the rays the box raster would have produced
const VERT_TILE = /* glsl */ `
uniform vec3 uPlaneO, uPlaneU, uPlaneV;
varying vec3 vLocal;
void main() {
  vec2 uv = position.xy * 0.5 + 0.5;
  vLocal = uPlaneO + uv.x * uPlaneU + uv.y * uPlaneV;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// the impostor billboard: the tile (premultiplied linear radiance + alpha) on a world-fixed plane through the cloud
const VERT_BB = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const FRAG_BB = /* glsl */ `
uniform sampler2D uTile;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTile, vUv);
  if (c.a < 0.003) discard;
  // tone map / encode the STRAIGHT colour, then premultiply (tone(c·a) ≠ tone(c)·a: a bright rim on the low tier)
  gl_FragColor = vec4(c.rgb / c.a, c.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= gl_FragColor.a;
}`;

// the far sea writes no depth and would take its cloud
// shadow per clipmap VERTEX (30–130 m cells → blobs, and only on the direct-sun share → faint). A horizontal plane just
// below sea level, drawn after the water and before the clouds, MULTIPLIES the frame by the shadow tile per pixel:
// depth-tested, so land (above it) keeps its own material shadow and the clouds drawn later are never darkened. Only
// while the aerial puffs cast (camera above ~300 m).
const SEA_VERT = /* glsl */ `
varying vec3 vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const SEA_FRAG = /* glsl */ `
uniform sampler2D uAtmCloudShadowMap;
uniform vec4 uAtmCloudShadowParams;
uniform vec2 uAtmCloudDrift;
uniform vec3 uSeaShade;
varying vec3 vW;
void main() {
  float t = texture2D(uAtmCloudShadowMap, (vW.xz - uAtmCloudDrift - uAtmCloudShadowParams.xy) * uAtmCloudShadowParams.z).r;
  float k = (1.0 - t) * uAtmCloudShadowParams.w;
  if (k < 0.004) discard;
  gl_FragColor = vec4(mix(vec3(1.0), uSeaShade, k), 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
${ATMOS_PARS}
uniform sampler3D uVol;
uniform sampler3D uDetail;
uniform vec3 uBMin, uBMax;
uniform float uVoxel;
uniform vec3 uCamLocal, uSunLocal;
uniform float uScale;
uniform mat4 uL2W;
uniform mat4 uProjView;
uniform float uPixAng;
uniform vec3 uCloudLit, uCloudShade, uCloudTop, uCloudBase;
uniform float uKeyUp;
uniform float uOpacity, uFluff, uRim, uAmbient, uFluffK, uDetailAmp, uDetailFreq, uHaze, uMinCamY, uKeyToCam, uSteps, uFuzzPx, uWrap, uBigNormal, uKeyNearSun;
// torn / wispy fringe strength; cotton normal (floret-scale shading texture on big-on-screen clouds)
uniform float uWisp, uCotton;
// the lit tops' luminance rolls off toward a cap
// (radiance of the target art's brightest cloud white: #eff1f4 away from the sun, #fbfcfc beside it — forward
// scattering), z = extra sun near the sun (the beach clouds' brilliant tops)
uniform vec4 uCloudCap;
// per cloud: floret emphasis (0 = a big cumulus shaded as lobe-scale masses, 1 = a fair-weather puff whose every floret
// is its own lit dome with a shaded crease round it — the aerial target art's cauliflower)
uniform float uFloret;
// per cloud: how far the lee side (faces away from the sky) falls toward a deeper blue-grey (independent of uFloret)
uniform float uLee;
// per cloud: multiplier on the lobe-scale normal's share (puffs: the cotton lumps shade, the mass still reads)
uniform float uNormK;
// per cloud: multiplier on the runtime cauliflower detail (puffs: the fine cotton lumps live in the noise — their
// florets are only a few voxels across in the baked volume)
uniform float uDetailK;
// per cloud: sun share (the aerial target art's puffs are greyer than ground cumulus: top-band L* p50 .84 / p90 .93)
uniform float uSunK, uAmbK, uAmbCool;
varying vec3 vLocal;

float gAmp = 0.0;
// band limit (else 4K clouds read as popcorn noise with no big-lobe form): each detail octave only where its
// cells span ≥ ~5 screen px (fully from ~12 px) — at 4K / zoomed the finer octaves no longer turn the big lobes to grain
float gPxW = 1.0; // screen pixels per prototype unit at the hit (set in main)
float octW(float f) { return smoothstep(5.0, 12.0, gPxW / (12.0 * f)); }
float sdfBase(vec3 p) { return texture(uVol, (p - uBMin) / (uBMax - uBMin)).r; }
// the march uses one detail octave (the silhouette's florets), shading adds the finer one
float sdfMarch(vec3 p) {
  float d = sdfBase(p);
  if (gAmp > 0.0) {
    float w = (1.0 - smoothstep(uVoxel * 2.0, uVoxel * 6.0, d)) * mix(0.7, 1.0, smoothstep(0.01, 0.07, p.y));
    if (w > 0.0) d -= gAmp * w * (texture(uDetail, p * uDetailFreq).r - 0.4) * 0.8 * octW(uDetailFreq);
  }
  return d;
}
float sdf(vec3 p) {
  float d = sdfBase(p);
  if (gAmp > 0.0) {
    // bumps near the surface only (the belly keeps most of it); the sculpted florets carry the cauliflower, this is a
    // soft irregularity on top
    float w = (1.0 - smoothstep(uVoxel * 2.0, uVoxel * 6.0, d)) * mix(0.7, 1.0, smoothstep(0.01, 0.07, p.y));
    if (w > 0.0) {
      float f1 = uDetailFreq, f2 = uDetailFreq * 2.3;
      float b = (texture(uDetail, p * f1).r - 0.4) * 0.6 * octW(f1) + (texture(uDetail, p * f2 + 0.31).r - 0.4) * 0.4 * octW(f2);
      d -= gAmp * w * b;
    }
  }
  return d;
}
vec2 boxHit(vec3 ro, vec3 rd) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (uBMin - ro) * inv, t1 = (uBMax - ro) * inv;
  vec3 mn = min(t0, t1), mx = max(t0, t1);
  return vec2(max(max(mn.x, mn.y), mn.z), min(min(mx.x, mx.y), mx.z));
}

void main() {
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocal - ro);
  vec2 tb = boxHit(ro, rd);
#ifdef CLOUD_TILE
  if (tb.x > tb.y || tb.y < 0.0) discard; // the tile's corners miss the box (cleared to transparent)
#endif
  float t = max(tb.x, 0.0);
  float tEnd = tb.y;
  // screen footprint of one voxel at the box entry → detail amplitude (0 while the cloud is small on screen)
  float voxPx = uVoxel / max((t + 0.05) * uPixAng, 1e-7);
  gAmp = uDetailAmp * uDetailK * smoothstep(0.6, 2.2, voxPx);
  gPxW = 1.0 / max((t + 0.05) * uPixAng, 1e-7);
  float best = 1e9, tBest = t;
  bool hit = false;
  for (int i = 0; i < CLOUD_STEPS; i++) {
    if (float(i) >= uSteps) break;
    vec3 p = ro + rd * t;
    float d = sdfMarch(p);
    float pix = max(t * uPixAng, 1e-6);
    float e = d / (pix * 1.1 + uFluff * uFluffK);
    if (e < best) { best = e; tBest = t; }
    if (d < pix * 0.3) { hit = true; tBest = t; break; }
    t += max(d * 0.9, pix * 0.5);
    if (t > tEnd) break;
  }
  vec3 p = ro + rd * tBest;
  float pix = max(tBest * uPixAng, 1e-6);
  // SILHOUETTE: a smooth SDF-distance falloff — ~1.2 px of anti-aliasing plus a cotton fuzz at floret
  // scale (capped at ~3 px so a big cloud never grows a translucent band), modulated only by the floret-scale detail.
  // No grazing-angle band, no noise-broken fringe, no behind-probe.
  float dm = 0.0, alpha = 1.0;
  if (!hit) {
    dm = max(sdfMarch(p), 0.0);
    float fl = texture(uDetail, p * uDetailFreq * 0.55 + 0.37).r;
    float fuzz = min(uFluff * uFluffK, pix * uFuzzPx) * (0.3 + 1.4 * fl);
    // a second, finer noise tears the outer fringe into wisps — thin vapour strands
    // reaching out of the silhouette where the noise is high, clean sky where it is low (never a uniform halo band)
    float fl2 = texture(uDetail, p * uDetailFreq * 2.9 + 0.13).r;
    float edge = dm / (pix * 1.2 + fuzz);
    alpha = 1.0 - smoothstep(0.0, 1.0, edge + (0.5 - fl2) * uWisp * smoothstep(0.05, 0.5, edge));
  }
  // in front of the sun disc a soft fringe would let the 14x HDR disc bleed through as a bright lens: close it
  if (!hit) alpha = max(alpha, step(0.02, alpha) * smoothstep(0.9994, 0.99993, dot(rd, uSunLocal)));
  float fringe = 1.0 - alpha;
  // fade what hugs the camera (flying through a cloud during the drop): no full-screen pop
  alpha *= smoothstep(0.0, 60.0, tBest * uScale);
  // (a 30 m fade, not 120 m — between 210 and 330 m the aerial puffs hung as translucent blue ghosts over the sea in
  // every hill-top / peak view)
  alpha *= uOpacity * smoothstep(uMinCamY - 30.0, uMinCamY, uAtmCamPos.y);
  if (alpha < 0.01) discard;

  // SDF normal (tetrahedral); a tighter gradient when the detail field is on (its bumps must shade)
  // (≥ 1.6 voxels — a sub-voxel step picked up the trilinear kinks of the SDF volume as terraces on big clouds at 4K)
  float h = gAmp > 0.0 ? uVoxel * 1.6 : uVoxel * 2.0;
  const vec2 k = vec2(1.0, -1.0);
  vec3 n = normalize(k.xyy * sdf(p + k.xyy * h) + k.yyx * sdf(p + k.yyx * h) + k.yxy * sdf(p + k.yxy * h) + k.xxx * sdf(p + k.xxx * h));
  // a fringe pixel takes the colour of the silhouette surface it belongs to (never a grey / blue outline); a hit is
  // snapped ONTO the surface (the march stops up to ⅓ px inside it, in steps along the ray — the crease-AO probes read
  // that offset as contour rings over every lit dome)
  if (!hit) p -= n * dm; else p -= n * sdf(p);
  // stylised key: the sun pulled toward the camera side (the target art lights every cloud from the front-side — a
  // cloud beside the sun is brilliant, a dawn cloud shows its peach lit flank, never only its backlit shaded face)
  // the pull depends on the view: looking TOWARD the sun (the beach: clouds 20–40° from it) the key swings to the
  // camera side so those clouds read brilliant white (as in the target art) instead of backlit grey dough; side /
  // back-lit views (aerial, harbor) keep the real sun → a clear lit side and a blue-grey shaded side
  float toSun = dot(rd, uSunLocal);
  // (+ a stylised lift of the key toward the zenith — a low dawn sun lights the cumulus TOPS peach, the bellies stay
  // mauve; 0 = the real sun)
  vec3 L = normalize(uSunLocal - rd * (uKeyToCam + uKeyNearSun * smoothstep(0.25, 0.85, toSun)) + vec3(0.0, uKeyUp, 0.0));
  // shading normal bent toward the eye at the lobe silhouettes: a front lobe's grazing limb takes the shading of the
  // surface around it instead of a dark crescent over the lobe behind it (which read as drawn lines between lobes)
  float nv = max(dot(n, -rd), 0.0);
  float gz = 1.0 - nv;
  // two-scale shading normal: the lit / shade split follows the LOBE-scale form (a smoothed field gradient), the
  // florets only modulate it — per-floret normals gave every floret its own highlight ("bubble wrap", not a cloud mass)
  const float HB = 0.022;
  vec3 nB = normalize(k.xyy * sdfBase(p + k.xyy * HB) + k.yyx * sdfBase(p + k.yyx * HB) + k.yxy * sdfBase(p + k.yxy * HB) + k.xxx * sdfBase(p + k.xxx * HB));
  // (else a big cloud at 4K reads as faceted flat planes with no floret detail) the lobe-scale normal's share
  // eases off once the cloud is big on screen (~>900 px across), and a cotton texture — the gradient of the floret-scale
  // detail noise — modulates the shading of big-on-screen clouds (band-limited like the detail octaves: never below ~5 px)
  float bigScr = smoothstep(700.0, 1800.0, gPxW);
  vec3 nM = normalize(mix(n, nB, uBigNormal * uNormK * (1.0 - 0.7 * uFloret) * (1.0 - 0.45 * bigScr)));
  if (uCotton > 0.0) {
    float fc = uDetailFreq * 2.3, hc = 0.35 / (fc * 12.0);
    vec3 pc = p * fc + 0.57;
    float c0 = texture(uDetail, pc).r;
    vec3 gc = vec3(texture(uDetail, pc + vec3(hc * fc, 0.0, 0.0)).r - c0, texture(uDetail, pc + vec3(0.0, hc * fc, 0.0)).r - c0, texture(uDetail, pc + vec3(0.0, 0.0, hc * fc)).r - c0);
    gc -= nM * dot(gc, nM); // tangential only
    nM = normalize(nM - gc * uCotton * octW(fc) * (0.35 + 0.65 * bigScr) / max(hc * fc, 1e-4) * 0.04);
  }
  vec3 nS = normalize(nM - rd * 0.35 * gz * gz * gz);
  float ndl = dot(nS, L);

  // soft self-shadow toward the sun (other lobes / florets shading this one)
  float sh = 1.0;
  float ts = uVoxel * 3.0;
  vec3 ps = p + n * uVoxel * 1.5;
  for (int j = 0; j < CLOUD_SHADOW_STEPS; j++) {
#ifdef CLOUD_TILE
    if (j >= 5) break;
#else
    if (j >= (uSteps < 24.0 ? 2 : 3)) break;
#endif
    float d = sdfBase(ps + L * ts);
    // (penumbra factor 2.5, not 5 — the hard factor cut blocky, decal-like shadow shapes into the big lobes at 4K)
    sh = min(sh, 2.5 * d / ts);
    ts += clamp(d, uVoxel * 2.0, 0.11);
  }
  sh = smoothstep(0.0, 1.0, clamp(sh, 0.0, 1.0));

  // ambient occlusion from the field: the creases between florets (fine + floret scale)
  float ao = 0.0;
#ifdef CLOUD_TILE
  ao += (0.012 - sdf(p + n * 0.012)) * 30.0;   // all detail octaves: the florets' creases
#else
  ao += (0.012 - sdfMarch(p + n * 0.012)) * 26.0;
#endif
  ao += (0.045 - sdfBase(p + n * 0.045)) * 7.0;
  ao = clamp(1.0 - ao * (1.0 + 0.9 * uFloret), 0.0, 1.0);

  float hgt = clamp(p.y / max(uBMax.y, 1e-3), 0.0, 1.0);
  // sky ambient: blue-grey belly → light grey-blue flanks → white top, lifted with height; creases a deeper blue-grey
  float up = nS.y;
  vec3 amb = mix(uCloudBase, uCloudShade, smoothstep(-0.95, -0.2, up) * 0.75 + smoothstep(-0.2, 0.3, up) * 0.25);
  amb = mix(amb, uCloudTop, smoothstep(0.1, 0.95, up) * 0.85 + hgt * 0.15);
  // creases fall toward a deeper cool grey with a lavender cast (the harbor target art's shade is #c5cadc / #b8c0d6 —
  // a cyan-blue crease tint pushes the median cloud saturation to .17 vs the target art's .09–.13)
  amb *= mix(vec3(0.6, 0.62, 0.71), vec3(1.0), ao);
  // fair-weather puffs (seen from the plane): the flanks away from the sky fall to a deeper blue-grey — the aerial
  // target art's puffs go from a white sunward top to #89a7c2 on the lee side (p5 L* .70–.74), never uniformly white
  // (measured: aerial puffs p5 L* .745 / S .058 vs the target art's .709 / .118 — hence the lee side deeper and bluer)
  amb *= mix(vec3(1.0), vec3(0.62, 0.75, 0.95), uLee * (1.0 - smoothstep(-0.3, 0.75, up)));
  // (the aerial puffs are a cool, even blue-grey-white in the target art — top-band S .12–.13, p90 .91: a cool cast
  // over the whole puff, not only on its lee side)
  amb *= mix(vec3(1.0), vec3(0.9, 0.95, 1.03), uAmbCool);
  amb *= uAmbient * uAmbK;
  // sun: a soft wrap (clouds scatter — no hard per-floret terminator), self-shadowed; narrower than (ndl+0.6)/1.6,
  // which lit ~75 % of every cloud and left no shaded side (the frame read flat: aerial p5 L .79 vs .70)
  float wrap = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);
  float direct = wrap * wrap * mix(0.25, 1.0, sh) * mix(0.55, 1.0, ao);
  float nearSun = smoothstep(0.3, 0.85, toSun);
  vec3 sunC = uAtmSunColor * uCloudLit * uSunK * (1.0 + uCloudCap.z * nearSun);
  vec3 col = amb + sunC * direct;
  // forward scattering: looking toward the sun the mass brightens a little; only the OUTER fringe (thin vapour) glows
  // — interior creases get nothing (else grazing-rim / forward-scatter lines show on the lobe creases)
  // (multiple scattering: a cloud near the sun glows white through its body — the target art's clouds beside the sun
  // are brilliant, not backlit grey)
  float fwd = pow(clamp(dot(rd, uSunLocal), 0.0, 1.0), 3.0);
  // (body share 0.7, not 1.6, with more self-shadow in it — near the sun the uniform glow washed the lobes' form out;
  // the thin outer fringe and the silhouette limb keep the silver lining)
  col += sunC * fwd * uRim * (0.7 * (0.25 + 0.75 * sh) * mix(0.5, 1.0, ao) + (0.6 * fringe + 0.2 * gz * gz * gz) * fwd);

  // aerial perspective: a PALE haze (the horizon colour), capped — distant clouds stay white, never sky-blue
  vec4 wp = uL2W * vec4(p, 1.0);
  vec3 dv = wp.xyz - uAtmCamPos;
  float dist = length(dv);
  vec3 dir = dv / max(dist, 1.0);
  float haze = (1.0 - exp(-dist * uAtmHazeDensity * uHaze));
  // (a NEUTRAL pale haze — the cyan horizon colour tinted every distant cloud cyan: median S .15–.19 vs .09)
  vec3 hz = atmosHorizonSky(dir);
  hz = mix(hz, vec3(dot(hz, vec3(0.2126, 0.7152, 0.0722))), 0.75);
  col = mix(col, hz * 1.05, clamp(haze, 0.0, 0.25));
  {
    float lc = dot(col, vec3(0.2126, 0.7152, 0.0722));
    float cap = mix(uCloudCap.x, uCloudCap.y, nearSun), k0 = cap * 0.7;
    if (lc > k0 && cap > 0.0) { float e = lc - k0, r = cap - k0; col *= (k0 + e / (1.0 + e / r)) / lc; }
  }
#ifdef CLOUD_FRAG_DEPTH
  // exact depth of the cloud surface (only while the camera is near / inside this cloud's box: writing gl_FragDepth
  // turns off early-z, and far away the box's back faces are a good enough depth for the test)
  vec4 clip = uProjView * wp;
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
#endif
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb *= alpha; // premultiplied after the (non-linear) tone map / encode
}`;

const TIERS: Record<Quality, { steps: number; shadow: number; res: number; detail: number }> = {
  ultra: { steps: 44, shadow: 4, res: 160, detail: 1 },
  high: { steps: 40, shadow: 4, res: 144, detail: 1 },
  medium: { steps: 32, shadow: 3, res: 112, detail: 0 },
  low: { steps: 28, shadow: 3, res: 96, detail: 0 },
};

/** prototype variants per kind (each is one baked volume) */
const VARIANTS: Record<CloudKind, number> = { cumulus: 4, tower: 2, humilis: 2, puff: 3, cotton: 2 };
/** the wind wraps the cloud field with this period (m) — the shadow tile has the same period, so it never repaints */
const WRAP = 24000;
const SHADOW_RES = 4096;

/** a cloud: the raymarched box (near / inside the cloud) and the impostor billboard (everywhere else) */
interface Inst {
  spec: CloudSpec; vol: CloudVolume; mesh: THREE.Mesh; mat: THREE.ShaderMaterial; matNear: THREE.ShaderMaterial;
  matTile: THREE.ShaderMaterial; bb: THREE.Mesh; bbMat: THREE.ShaderMaterial;
  tile: THREE.WebGLRenderTarget | null;
  /** camera position relative to the cloud centre when the tile was rendered; plane basis + extent at that time */
  rel: THREE.Vector3; n: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3; off: THREE.Vector3;
  /** metres per tile texel at render time (the resolution check) */
  mPerTex: number;
  valid: boolean;
  /** box centre in mesh-local units, and its world position this frame */
  cLocal: THREE.Vector3; C: THREE.Vector3;
}

/** impostor tiles re-rendered per frame (texels) — the rest wait a frame; first sight / camera cuts are unlimited */
const TILE_BUDGET: Record<Quality, number> = { ultra: 700_000, high: 500_000, medium: 300_000, low: 250_000 };
/** tile texels per screen pixel (a touch above 1: the billboard resamples the tile) */
const TILE_DENSITY: Record<Quality, number> = { ultra: 1.2, high: 1.0, medium: 0.8, low: 0.7 };
const TILE_MAX = 2048;
const BB_GEO = new THREE.PlaneGeometry(1, 1);
const _v = new THREE.Vector3(), _d = new THREE.Vector3(), _p = new THREE.Vector3();
const _corner = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _cc = new THREE.Color();
const _frustum = new THREE.Frustum();
const _sph = new THREE.Sphere();

export class Clouds {
  readonly group = new THREE.Group();
  readonly shadowTex: THREE.DataTexture;
  private vols = new Map<string, CloudVolume>();
  private insts: Inst[] = [];
  private shared: Record<string, THREE.IUniform>;
  private tier: (typeof TIERS)[Quality];
  private inv = new THREE.Matrix4();
  private rotInv = new THREE.Matrix3();
  private detail: THREE.Data3DTexture;
  private paintedSun = new THREE.Vector3();
  /** impostor tile pass: fullscreen quad + ortho camera */
  private tileScene = new THREE.Scene();
  private tileQuad: THREE.Mesh;
  private tileCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private lastCam = new THREE.Vector3(1e9, 0, 0);
  /** ?atmos=cloudmarch: no impostors (every cloud raymarched every frame, for A/B) */
  private noImpostors = false;
  /** ?atmos=nocloudshadow */
  noShadow = false;
  /** the sea's cloud shadow (see SEA_FRAG) */
  readonly seaShadow: THREE.Mesh;
  /** stats for tools: tiles rendered last frame / total */
  tilesLast = 0;
  tilesTotal = 0;

  constructor(private u: AtmosUniforms, private state: AtmosState, private renderer: THREE.WebGLRenderer, private quality: Quality, private shotMode = false) {
    this.tier = TIERS[quality];
    this.noImpostors = flag("atmos").includes("cloudmarch");
    const qg = new THREE.BufferGeometry();
    qg.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    this.tileQuad = new THREE.Mesh(qg);
    this.tileQuad.frustumCulled = false;
    this.tileScene.add(this.tileQuad);
    this.detail = makeDetailNoise();
    this.shared = {
      ...u,
      uProjView: { value: new THREE.Matrix4() },
      uPixAng: { value: 0.001 },
      uCloudLit: { value: new THREE.Color() }, uCloudShade: { value: new THREE.Color() },
      uCloudTop: { value: new THREE.Color() }, uCloudBase: { value: new THREE.Color() },
      uOpacity: { value: 1 }, uFluff: { value: 0.007 }, uRim: { value: 0.35 }, uAmbient: { value: 1 },
      uDetail: { value: this.detail }, uDetailAmp: { value: this.tier.detail ? 0.02 : 0 }, uDetailFreq: { value: 2.2 },
      uHaze: { value: 0.3 }, uKeyToCam: { value: 0.3 }, uKeyUp: { value: 0 }, uFuzzPx: { value: 3 }, uWrap: { value: 0.6 }, uBigNormal: { value: 0.6 }, uKeyNearSun: { value: 0 },
      uWisp: { value: 0 }, uCotton: { value: 0 }, uCloudCap: { value: new THREE.Vector4(0, 0, 0, 0) },
    };
    this.group.name = "atmos-clouds";
    // R8 tile (5.9 m / texel over the 24 km wrap period), painted on a canvas once, uploaded single-channel
    this.shadowTex = new THREE.DataTexture(new Uint8Array(SHADOW_RES * SHADOW_RES).fill(255), SHADOW_RES, SHADOW_RES, THREE.RedFormat, THREE.UnsignedByteType);
    this.shadowTex.wrapS = this.shadowTex.wrapT = THREE.RepeatWrapping; // periodic with the cloud wrap
    this.shadowTex.colorSpace = THREE.NoColorSpace;
    this.shadowTex.flipY = false; // rows = +z (mirrored in z, the shadows land with no cloud above them)
    this.shadowTex.generateMipmaps = true; this.shadowTex.minFilter = THREE.LinearMipmapLinearFilter; this.shadowTex.magFilter = THREE.LinearFilter;
    this.shadowTex.unpackAlignment = 1;
    this.shadowTex.needsUpdate = true;
    u.uAtmCloudShadowMap.value = this.shadowTex;
    u.uAtmCloudShadowParams.value.set(-WRAP / 2, -WRAP / 2, 1 / WRAP, state.preset.cloudShadow);
    // the sea's cloud shadow: a camera-following plane 1 m below sea level (land within ~1 m of the sea keeps its own)
    const seaMat = new THREE.ShaderMaterial({
      vertexShader: SEA_VERT, fragmentShader: SEA_FRAG,
      // (the target art's shadowed sea: #2586c6 → #2a82af — ~20 % darker, the blue losing most)
      uniforms: { uAtmCloudShadowMap: u.uAtmCloudShadowMap, uAtmCloudShadowParams: u.uAtmCloudShadowParams, uAtmCloudDrift: u.uAtmCloudDrift, uSeaShade: { value: new THREE.Vector3(0.74, 0.73, 0.63) } },
      transparent: true, depthWrite: false, depthTest: true, fog: false, toneMapped: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), seaMat);
    sea.name = "atmos-cloud-sea-shadow";
    sea.renderOrder = 0.25; // after the water (0), before the clouds (0.5)
    sea.frustumCulled = false; sea.castShadow = false; sea.receiveShadow = false;
    sea.userData.castShadow = false; sea.userData.receiveShadow = false; sea.userData.farShadow = false;
    sea.visible = false;
    this.seaShadow = sea;
    this.group.add(sea);
    onRestore("bake", () => this.invalidate());
  }

  private volume(kind: CloudKind, v: number): CloudVolume {
    const key = `${kind}:${v % VARIANTS[kind]}`;
    let vol = this.vols.get(key);
    if (!vol) {
      const seed = { cumulus: 11, tower: 41, humilis: 71, puff: 101, cotton: 131 }[kind] + (v % VARIANTS[kind]) * 5;
      // reject towers taller than 1.1× their width (they read as a "peanut" puff)
      let proto = sculptCloud(kind, seed);
      for (let k = 1; k < 12 && proto.max[1] > 1.1; k++) proto = sculptCloud(kind, seed + k * 131);
      const small = kind === "puff" || kind === "cotton";
      // puffs: the full tier resolution (at 0.75× the florets are ~3 voxels across → smooth balloons at 4K)
      const res = kind === "cotton" ? Math.round(this.tier.res * 0.75) : this.tier.res;
      vol = bakeCloudVolume(this.renderer, proto, res, small ? 0.008 : 0.006);
      this.vols.set(key, vol);
    }
    return vol;
  }

  build(specs: CloudSpec[]) {
    for (const i of this.insts) {
      this.group.remove(i.mesh); this.group.remove(i.bb);
      i.mat.dispose(); i.matNear.dispose(); i.matTile.dispose(); i.bbMat.dispose(); i.tile?.dispose();
    }
    this.insts = [];
    const geoCache = new Map<CloudVolume, THREE.BufferGeometry>();
    for (const spec of specs) {
      const vol = this.volume(spec.kind, spec.v);
      let geo = geoCache.get(vol);
      if (!geo) {
        const s = vol.bmax.clone().sub(vol.bmin), c = vol.bmax.clone().add(vol.bmin).multiplyScalar(0.5);
        geo = new THREE.BoxGeometry(s.x, s.y, s.z).translate(c.x, c.y, c.z);
        geoCache.set(vol, geo);
      }
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG,
        defines: { CLOUD_STEPS: this.tier.steps, CLOUD_SHADOW_STEPS: this.tier.shadow },
        uniforms: {
          ...this.shared,
          uVol: { value: vol.texture }, uBMin: { value: vol.bmin }, uBMax: { value: vol.bmax }, uVoxel: { value: vol.voxel },
          uCamLocal: { value: new THREE.Vector3() }, uSunLocal: { value: new THREE.Vector3(0, 1, 0) },
          uScale: { value: spec.w }, uL2W: { value: new THREE.Matrix4() },
          // puff fringe 1.6 (a wider cotton fringe blurs the scalloped outline into a balloon at 4K)
          uFluffK: { value: spec.kind === "puff" ? 2.6 : 1 },
          // the puffs' floret emphasis stays low (.2: no floret becomes its own lit dome with a dark ring — the target
          // art's puffs are soft cotton with a big lit / lee form), the lee side carried by uLee instead
          uFloret: { value: spec.kind === "puff" ? 0.2 : spec.kind === "cotton" ? 0.2 : 0 },
          uLee: { value: spec.kind === "puff" ? 0.5 : spec.kind === "cotton" ? 0.45 : 0.3 },
          uNormK: { value: spec.kind === "puff" ? 0.6 : 1 },
          // puffs — a stronger key (sunlit white tops) over a lower ambient (camera-facing flanks light blue-grey, the
          // target art's contrast), finer cotton lumps
          uDetailK: { value: spec.kind === "puff" ? 3.2 : spec.kind === "cotton" ? 1.5 : 1 },
          uSunK: { value: spec.kind === "puff" ? 0.45 : 1 }, uAmbK: { value: spec.kind === "puff" ? 0.9 : 1 }, uAmbCool: { value: spec.kind === "puff" ? 1.5 : 0 },
          // low fair-weather puffs of the aerial (bases ~200 m) are seen from the air only: they fade out below a
          // camera altitude of ~300 m (they would otherwise sit big and close in the ground views)
          uMinCamY: { value: spec.tag === "aerial" ? 325 : -1e9 },
          uSteps: { value: this.tier.steps },
        },
        // no depth write: the AO must not see (and speckle) clouds; gl_FragDepth still depth-TESTS the true surface
        side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: true, forceSinglePass: true,
        premultipliedAlpha: true, blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
        fog: false, toneMapped: true,
      });
      // the near variant shares the uniforms object: same per-frame updates, exact gl_FragDepth
      const matNear = new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG, uniforms: mat.uniforms,
        defines: { ...mat.defines, CLOUD_FRAG_DEPTH: 1 },
        side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: true, forceSinglePass: true,
        premultipliedAlpha: true, blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
        fog: false, toneMapped: true,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `cloud-${spec.kind}`;
      mesh.position.set(spec.x, spec.y, spec.z);
      mesh.rotation.y = spec.rot;
      mesh.scale.setScalar(spec.w);
      // AFTER the water (renderOrder 0, written opaque in the transparent pass — it used to paint over every cloud in
      // front of the sea), BEFORE every other transparent (≥ 1: FX, storm wall, glass, beams)
      mesh.renderOrder = 0.5;
      mesh.castShadow = false; mesh.receiveShadow = false;
      mesh.userData.castShadow = false; mesh.userData.receiveShadow = false;
      mesh.frustumCulled = true;
      this.group.add(mesh);
      // impostor: the same march into a tile (shares every uniform object, + the plane), shown on a billboard
      const matTile = new THREE.ShaderMaterial({
        vertexShader: VERT_TILE, fragmentShader: FRAG,
        uniforms: { ...mat.uniforms, uPlaneO: { value: new THREE.Vector3() }, uPlaneU: { value: new THREE.Vector3() }, uPlaneV: { value: new THREE.Vector3() } },
        // tiles are rendered rarely: a finer march, more self-shadow taps
        defines: { ...mat.defines, CLOUD_TILE: 1, CLOUD_STEPS: 64, CLOUD_SHADOW_STEPS: 6 },
        depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false, fog: false,
      });
      const bbMat = new THREE.ShaderMaterial({
        vertexShader: VERT_BB, fragmentShader: FRAG_BB, uniforms: { uTile: { value: null } },
        side: THREE.DoubleSide, transparent: true, depthWrite: false, depthTest: true,
        premultipliedAlpha: true, blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
        fog: false, toneMapped: true,
      });
      const bb = new THREE.Mesh(BB_GEO, bbMat);
      bb.name = `cloud-imp-${spec.kind}`;
      bb.matrixAutoUpdate = false;
      bb.renderOrder = 0.5;
      bb.castShadow = false; bb.receiveShadow = false;
      bb.userData.castShadow = false; bb.userData.receiveShadow = false;
      bb.visible = false;
      this.group.add(bb);
      this.insts.push({
        spec, vol, mesh, mat, matNear, matTile, bb, bbMat, tile: null,
        rel: new THREE.Vector3(), n: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(), off: new THREE.Vector3(), mPerTex: 1, valid: false,
        cLocal: vol.bmin.clone().add(vol.bmax).multiplyScalar(0.5), C: new THREE.Vector3(),
      });
    }
    this.paintShadow();
  }

  /** every impostor tile is re-rendered on the next frame (preset / sun change) */
  invalidate() { for (const i of this.insts) i.valid = false; }

  /**
   * Cloud transmission on the ground (y = 0 plane), projected along the sun from every lobe of every cloud at ZERO
   * drift, into a tile with the wind-wrap period — so it is painted once per preset, never on drift. Soft discs, union
   * via "darken" (overlapping lobes do not stack into black), then a blur.
   */
  paintShadow() {
    const t0 = performance.now();
    const S = SHADOW_RES, scale = S / WRAP, half = WRAP / 2;
    const s = this.state.sunDir;
    const m = new THREE.Matrix4(), v = new THREE.Vector3(), pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    const off = document.createElement("canvas"); off.width = off.height = S;
    const o = off.getContext("2d", { willReadFrequently: true })!;
    o.fillStyle = "#fff"; o.fillRect(0, 0, S, S);
    o.globalCompositeOperation = "darken";
    // the sun's ground azimuth in tile space (x = +X, y = +Z) and the elongation of a sphere's shadow along it
    const azA = Math.atan2(s.z, s.x), el = Math.min(2.5, 1 / Math.max(0.3, s.y));
    for (const inst of this.insts) {
      // only the low fair-weather puffs cast (the aerial target art shows a few small clouds casting shadows). The composed
      // heroes sit 2–9 km out for the ground views; their 1–2 km shadows darkened half the island in the aerial and
      // would sweep over the POIs during a match
      if (inst.spec.tag !== "aerial") continue;
      pos.set(inst.spec.x, inst.spec.y, inst.spec.z);
      q.setFromAxisAngle(Y, inst.spec.rot);
      sc.setScalar(inst.spec.w);
      m.compose(pos, q, sc);
      const sp = inst.vol.proto.spheres, w = inst.spec.w;
      for (let i = 0; i < inst.vol.proto.count; i++) {
        const r = sp[i * 5 + 3] * w;
        if (r < w * 0.02) continue; // beads are below the tile's resolution (florets paint — the scalloped outline)
        v.set(sp[i * 5], sp[i * 5 + 1], sp[i * 5 + 2]).applyMatrix4(m);
        const gx = v.x - (s.x / s.y) * v.y, gz = v.z - (s.z / s.y) * v.y;
        // wrap into the tile (periodic)
        const wx = ((gx + half) % WRAP + WRAP) % WRAP, wz = ((gz + half) % WRAP + WRAP) % WRAP;
        const rr = Math.max(1.5, r * 1.04 * scale); // the sphere's footprint + a thin penumbra
        for (const ox of [0, -S, S]) for (const oz of [0, -S, S]) {
          const cx = wx * scale + ox, cy = wz * scale + oz;
          if (cx < -rr * el || cy < -rr * el || cx > S + rr * el || cy > S + rr * el) continue;
          // a sphere's shadow on the ground is an ELLIPSE stretched
          // along the sun's azimuth by 1 / sin(elevation), with a tight penumbra (~6 %) — the union keeps the puff's outline
          o.save();
          o.translate(cx, cy); o.rotate(azA); o.scale(el, 1);
          const g = o.createRadialGradient(0, 0, 0, 0, 0, rr);
          g.addColorStop(0, "rgb(0,0,0)"); g.addColorStop(0.93, "rgb(0,0,0)"); g.addColorStop(1, "rgb(255,255,255)");
          o.fillStyle = g; o.beginPath(); o.arc(0, 0, rr, 0, Math.PI * 2); o.fill();
          o.restore();
        }
      }
    }
    // soft edges (~20 m), then keep one channel
    const b = document.createElement("canvas"); b.width = b.height = S;
    const bx = b.getContext("2d", { willReadFrequently: true })!;
    bx.fillStyle = "#fff"; bx.fillRect(0, 0, S, S);
    bx.filter = "blur(0.6px)"; bx.drawImage(off, 0, 0); bx.filter = "none";
    const px = bx.getImageData(0, 0, S, S).data;
    const out = this.shadowTex.image.data as Uint8Array;
    for (let i = 0, n = S * S; i < n; i++) out[i] = px[i * 4];
    this.shadowTex.needsUpdate = true;
    this.paintedSun.copy(s);
    const w = globalThis as unknown as { __kr?: { atmosCloudShadowMs?: number } };
    if (w.__kr) w.__kr.atmosCloudShadowMs = Math.round(performance.now() - t0);
  }

  applyPreset() {
    const p = this.state.preset;
    const u = this.shared;
    // ambient colours are DISPLAY targets (measured on the target art) → radiance through the inverse grade; the sun
    // tint is divided by the sun colour so a warm sun does not turn the whites cream (#f6f3ec instead of cool whites)
    const gp = gradeParams(p);
    const set = (c: THREE.Color, hex: string) => { const v = gradeInv(hex, gp); c.setRGB(v[0], v[1], v[2], THREE.LinearSRGBColorSpace); };
    set(u.uCloudShade.value as THREE.Color, p.cloudShade);
    set(u.uCloudTop.value as THREE.Color, p.cloudTop);
    set(u.uCloudBase.value as THREE.Color, p.cloudBase ?? p.cloudShade);
    const tint = new THREE.Color(p.cloudLit), sc = this.state.sunColorLin;
    (u.uCloudLit.value as THREE.Color).setRGB(tint.r / Math.max(sc.r, 0.05), tint.g / Math.max(sc.g, 0.05), tint.b / Math.max(sc.b, 0.05), THREE.LinearSRGBColorSpace).multiplyScalar(p.cloudSun ?? 1);
    u.uOpacity.value = p.cloudOpacity;
    u.uRim.value = p.cloudRim ?? 0.35;
    u.uKeyToCam.value = p.cloudKeyToCam ?? 0.3;
    u.uKeyUp.value = p.cloudKeyUp ?? 0;
    u.uFuzzPx.value = p.cloudFuzz ?? 3;
    u.uWrap.value = p.cloudWrap ?? 0.6;
    u.uBigNormal.value = p.cloudBigNormal ?? 0.6;
    u.uKeyNearSun.value = p.cloudKeyNearSun ?? 0;
    u.uWisp.value = p.cloudWisp ?? 0;
    {
      // the highlight caps: luminance of the display whites through the inverse grade
      const Y = (hex: string) => { const v = gradeInv(hex, gp); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
      (u.uCloudCap.value as THREE.Vector4).set(p.cloudCapFar ? Y(p.cloudCapFar) : 0, p.cloudCapNear ? Y(p.cloudCapNear) : 0, p.cloudNearSunBoost ?? 0, 0);
    }
    u.uCotton.value = this.tier.detail ? p.cloudCotton ?? 0 : 0;
    u.uFluff.value = p.cloudFluff ?? 0.007;
    if (this.tier.detail) { u.uDetailAmp.value = p.cloudDetailAmp ?? 0.02; u.uDetailFreq.value = p.cloudDetailFreq ?? 2.2; }
    this.u.uAtmCloudShadowParams.value.w = p.cloudShadow;
    if (this.insts.length && this.paintedSun.distanceTo(this.state.sunDir) > 1e-4) this.paintShadow(); // the sun moved
    this.invalidate();
  }

  /**
   * per frame: camera-space uniforms, wind drift (wrapped), per-cloud local camera + sun — and the IMPOSTORS: a cloud
   * away from the camera is not marched every frame; its march is rendered into a tile (texel ≈ screen pixel) on a plane
   * through the cloud's centre facing the camera, and shown as a billboard fixed to the cloud. The projection from the
   * eye onto that plane is exact for the eye position it was rendered from (any camera rotation, any screen position);
   * it is re-rendered when the eye has moved enough relative to the cloud to show parallax (> ~0.75 px), when the
   * needed resolution changed (zoom / distance), and on preset changes. Near / inside a cloud (the drop): the box march.
   */
  update(cam: THREE.PerspectiveCamera, t: number, viewH: number) {
    const u = this.shared;
    cam.updateMatrixWorld();
    const pv = u.uProjView.value as THREE.Matrix4;
    pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const pixAng = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5)) / Math.max(1, viewH)) / Math.max(cam.zoom, 1e-3);
    u.uPixAng.value = pixAng;
    // a light trade wind (0.5 m/s): over a 20-min match the sky moves ~0.6 km, the composed views stay composed
    const drift = this.state.cloudDrift.set(t * 0.48, t * 0.15);
    const H = WRAP / 2;
    const wrap = (x: number) => ((x + H) % WRAP + WRAP) % WRAP - H;
    const cut = cam.position.distanceTo(this.lastCam) > 150; // teleport / view switch / respawn
    this.lastCam.copy(cam.position);
    _frustum.setFromProjectionMatrix(pv);
    const density = TILE_DENSITY[this.quality];
    const todo: Array<{ inst: Inst; err: number; C: THREE.Vector3; R: number }> = [];
    for (const inst of this.insts) {
      const m = inst.mesh;
      // the aerial's low puffs are faded out below ~210–330 m of camera altitude: don't even raster their boxes there
      const show = inst.spec.tag !== "aerial" || cam.position.y > 295;
      if (!show) { m.visible = false; inst.bb.visible = false; continue; }
      const px = wrap(inst.spec.x + drift.x), pz = wrap(inst.spec.z + drift.y);
      m.position.set(px, inst.spec.y, pz);
      // centre + bounding radius (world) — no per-cloud matrix inverse / allocation unless the cloud is marched or its
      // tile re-rendered (prep); the camera in cloud-local units comes from the yaw + uniform scale directly
      // (perf: the centre from the yaw + scale directly; the mesh's world matrix is composed only when prep / a tile
      // render needs it)
      const cr0 = Math.cos(inst.spec.rot), sr0 = Math.sin(inst.spec.rot), w0 = inst.spec.w, cl = inst.cLocal;
      const C = inst.C.set(px + (cr0 * cl.x + sr0 * cl.z) * w0, inst.spec.y + cl.y * w0, pz + (-sr0 * cl.x + cr0 * cl.z) * w0);
      const R = 0.5 * inst.vol.bmin.distanceTo(inst.vol.bmax) * inst.spec.w;
      const dx = cam.position.x - m.position.x, dy = cam.position.y - m.position.y, dz = cam.position.z - m.position.z;
      const cr = Math.cos(inst.spec.rot), sr = Math.sin(inst.spec.rot), iw = 1 / inst.spec.w;
      const lx = (cr * dx - sr * dz) * iw, ly = dy * iw, lz = (sr * dx + cr * dz) * iw;
      // near / inside the box (drop phase, the plane, a mountain top): exact depth; otherwise early-z
      const b0 = inst.vol.bmin, b1 = inst.vol.bmax, pad = 0.35;
      const near = lx > b0.x - pad && lx < b1.x + pad && ly > b0.y - pad && ly < b1.y + pad && lz > b0.z - pad && lz < b1.z + pad;
      const d = cam.position.distanceTo(C);
      if (this.noImpostors || near || d < R * 1.6) {
        this.prep(inst, cam, pixAng);
        m.visible = true; inst.bb.visible = false;
        m.material = near ? inst.matNear : inst.mat;
        continue;
      }
      m.visible = false;
      // impostor: keep the billboard glued to the drifting cloud
      if (inst.valid && inst.tile) {
        inst.bb.visible = true;
        const e = inst.bb.matrix.elements;
        e[12] = C.x + inst.off.x; e[13] = C.y + inst.off.y; e[14] = C.z + inst.off.z;
        inst.bb.matrixWorldNeedsUpdate = true;
      } else inst.bb.visible = false;
      let err = Infinity;
      if (inst.valid && inst.tile) {
        const rel = _d.copy(cam.position).sub(C).sub(inst.rel);
        const dn = rel.dot(inst.n);
        const perp = Math.sqrt(Math.max(0, rel.lengthSq() - dn * dn));
        err = ((perp + 0.3 * Math.abs(dn)) * R) / (d * d) / pixAng;
        // resolution: tile texels vs screen pixels now (zoomed scope, walked closer / away)
        const ratio = inst.mPerTex / ((d * pixAng) / density);
        if (ratio > 1.45 || ratio < 0.4) err = Math.max(err, 2);
      }
      if (err > 0.75) {
        const inView = _frustum.intersectsSphere(_sph.set(C, R));
        todo.push({ inst, err: inView ? err : err * 0.05, C, R });
      }
    }
    // re-render the worst tiles first within the per-frame texel budget (first sight / cuts / shots: everything)
    this.tilesLast = 0;
    if (todo.length) {
      todo.sort((a, b) => b.err - a.err);
      let budget = this.shotMode || cut ? Infinity : TILE_BUDGET[this.quality];
      for (const job of todo) {
        if (budget <= 0 && job.inst.valid) break;
        this.prep(job.inst, cam, pixAng);
        const texels = this.renderTile(job.inst, cam, pixAng / density, job.C);
        if (texels < 0) { job.inst.mesh.visible = true; job.inst.bb.visible = false; job.inst.mesh.material = job.inst.mat; continue; }
        budget -= texels;
        this.tilesLast++; this.tilesTotal++;
      }
      u.uPixAng.value = pixAng;
    }
    // the shadow tile was painted at zero drift and is periodic with the wrap: just slide it
    this.u.uAtmCloudDrift.value.set(drift.x % WRAP, drift.y % WRAP);
    // the tile holds only the aerial puffs' shadows, and those puffs fade out below ~325 m of camera altitude — their
    // shadows fade with them (a hill-top / ground camera saw dark blobs sliding over the sea under an empty sky)
    const y = cam.position.y, fade = Math.min(1, Math.max(0, (y - 295) / 30));
    this.u.uAtmCloudShadowParams.value.w = this.noShadow ? 0 : this.state.preset.cloudShadow * fade * fade * (3 - 2 * fade);
    const sea = this.seaShadow;
    sea.visible = this.u.uAtmCloudShadowParams.value.w > 0.01;
    if (sea.visible) {
      // 12 km square under the camera (the aerial sees ~3 km; the drop's horizon is beyond the tile's puffs anyway)
      sea.position.set(cam.position.x, -1, cam.position.z);
      sea.scale.set(12000, 1, 12000);
      sea.updateMatrixWorld();
    }
  }

  /** the march uniforms of one cloud for this camera (box march or a tile render) */
  private prep(inst: Inst, cam: THREE.PerspectiveCamera, pixAng: number) {
    const m = inst.mesh, uu = inst.mat.uniforms;
    m.updateMatrixWorld();
    this.inv.copy(m.matrixWorld).invert();
    (uu.uCamLocal.value as THREE.Vector3).copy(cam.position).applyMatrix4(this.inv);
    // march budget by screen size: a distant bank 200 px wide converges in ~16 steps; a hero at 1000 px needs the tier's
    const dist = Math.max(1, cam.position.distanceTo(m.position));
    const px = inst.spec.w / (dist * pixAng);
    uu.uSteps.value = Math.min(this.tier.steps, Math.max(16, Math.round(px / 18)));
    this.rotInv.setFromMatrix4(this.inv);
    (uu.uSunLocal.value as THREE.Vector3).copy(this.state.sunDir).applyMatrix3(this.rotInv).normalize();
    (uu.uL2W.value as THREE.Matrix4).copy(m.matrixWorld);
  }

  /** render one impostor tile for the current camera; returns the texels rendered (−1: the camera is too close) */
  private renderTile(inst: Inst, cam: THREE.PerspectiveCamera, texAng: number, C: THREE.Vector3): number {
    const n = inst.n.copy(C).sub(cam.position);
    const dist = n.length();
    n.divideScalar(dist);
    const right = inst.right.crossVectors(n, Math.abs(n.y) > 0.95 ? _v.set(0, 0, -1) : _v.set(0, 1, 0)).normalize();
    const up = inst.up.crossVectors(right, n).normalize();
    // the box's 8 corners, projected from the eye onto the plane through C
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    const mw = inst.mesh.matrixWorld, b0 = inst.vol.bmin, b1 = inst.vol.bmax;
    for (let i = 0; i < 8; i++) {
      _corner.set(i & 1 ? b1.x : b0.x, i & 2 ? b1.y : b0.y, i & 4 ? b1.z : b0.z).applyMatrix4(mw);
      const w = _corner.sub(cam.position);
      const dn = w.dot(n);
      if (dn < dist * 0.05) return -1;
      w.multiplyScalar(dist / dn).add(cam.position).sub(C);
      const a = w.dot(right), b = w.dot(up);
      u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, b); v1 = Math.max(v1, b);
    }
    let mPerTex = dist * texAng;
    let W = Math.ceil((u1 - u0) / mPerTex) + 4, Hh = Math.ceil((v1 - v0) / mPerTex) + 4;
    const over = Math.max(W, Hh) / TILE_MAX;
    if (over > 1) { mPerTex *= over; W = Math.ceil((u1 - u0) / mPerTex) + 4; Hh = Math.ceil((v1 - v0) / mPerTex) + 4; }
    W = Math.max(16, W); Hh = Math.max(16, Hh);
    // reuse the tile when it is big enough and not wasteful (no reallocation churn while walking); fill all of it
    let tile = inst.tile;
    if (!tile || W > tile.width || Hh > tile.height || W < tile.width * 0.6 || Hh < tile.height * 0.6) {
      tile?.dispose();
      const r16 = (x: number) => Math.min(TILE_MAX, Math.ceil(x * 1.1 / 16) * 16);
      tile = new THREE.WebGLRenderTarget(r16(W), r16(Hh), { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      tile.texture.colorSpace = THREE.NoColorSpace;
      inst.tile = tile;
      inst.bbMat.uniforms.uTile.value = tile.texture;
    }
    const ext = tile.width * mPerTex, eyt = tile.height * mPerTex;
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
    // plane (cloud-local) for the tile pass
    const Ow = _p.copy(C).addScaledVector(right, uc - ext / 2).addScaledVector(up, vc - eyt / 2);
    const tu = inst.matTile.uniforms;
    const O = (tu.uPlaneO.value as THREE.Vector3).copy(Ow).applyMatrix4(this.inv.copy(mw).invert());
    (tu.uPlaneU.value as THREE.Vector3).copy(Ow).addScaledVector(right, ext).applyMatrix4(this.inv).sub(O);
    (tu.uPlaneV.value as THREE.Vector3).copy(Ow).addScaledVector(up, eyt).applyMatrix4(this.inv).sub(O);
    // camera-side uniforms for this tile (the per-cloud ones were set by update for this camera)
    this.shared.uPixAng.value = mPerTex / dist;
    inst.mat.uniforms.uSteps.value = Math.min(64, Math.max(20, Math.round(tile.width / 14)));
    const r = this.renderer;
    const prevRT = r.getRenderTarget(), prevAC = r.autoClear, prevA = r.getClearAlpha();
    r.getClearColor(_cc);
    r.setRenderTarget(tile);
    r.setClearColor(0x000000, 0); r.clear(true, false, false);
    r.autoClear = false;
    this.tileQuad.material = inst.matTile;
    r.render(this.tileScene, this.tileCam);
    r.setRenderTarget(prevRT); r.setClearColor(_cc, prevA); r.autoClear = prevAC;
    // the billboard: the tile rectangle on that plane, facing the eye; stored relative to the cloud centre
    inst.off.copy(right).multiplyScalar(uc).addScaledVector(up, vc);
    _m.makeBasis(_s.copy(right).multiplyScalar(ext), _v.copy(up).multiplyScalar(eyt), _d.copy(n).negate());
    _m.setPosition(C.x + inst.off.x, C.y + inst.off.y, C.z + inst.off.z);
    inst.bb.matrix.copy(_m);
    inst.bb.matrixWorldNeedsUpdate = true;
    inst.bb.visible = true;
    inst.rel.copy(cam.position).sub(C);
    inst.mPerTex = mPerTex;
    inst.valid = true;
    return tile.width * tile.height;
  }

  get count() { return this.insts.length; }
}
