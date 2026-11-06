// THE STORM WALL + DECK as one sphere-traced cauliflower volume.
//
// Shape: a signed distance field in world metres. The base is the damage circle's leaning face (the top leans over the
// safe zone) under a ceiling that is the wall top near the face and the storm deck outward, to the horizon. On top of it
// five octaves of a baked "sphere grid" (random spheres, one per cell, tileable 3D texture) are ADDED with a smooth
// union, each clipped to a thin shell around the current surface (Inigo Quilez's fbm-SDF): lobes → billows → florets →
// buds → (shading only) grain. That is cauliflower by construction: bumps on bumps, crisp creases, round crowns.
// Lighting: SDF normals, SDF ambient occlusion (creases), a 4-tap soft shadow toward the light (the overhang shades the
// face — the dark core), a storm palette ramp (indigo creases → purple → lavender → cream sunlit crowns), warm sand
// bounce, golden dust at the foot, lightning pooled around live bolts, the banana-yellow rim lit from inside (aerial),
// aerial haze. The camera approaching the face dissolves it (no clipped geometry, ever).
//
// Cost control: traced at ≤ ~1 MP (half res at 1440p) into an MRT target (premultiplied colour + view depth), octaves
// are skipped while the ray is far from the surface (each octave can only grow the surface by a known bound) and by
// distance (LOD); an analytic bound skips every ray that cannot touch the storm. A full-res composite triangle draws it
// into the scene with gl_FragDepth = the traced depth, so foreground palms / terrain occlude it per pixel.
import * as THREE from "three";
import { flag } from "../../flags";
import { contextEpoch } from "../../engine/res/restore";

const N = 64;            // texels per tile edge
const CELLS = 6;         // sphere cells per tile edge

/** tileable sphere-grid SDF (in cell units): one jittered sphere per cell, min over the 27 neighbours */
export function bakeSphereGrid(seed = 7): { tex: THREE.Data3DTexture; data: Float32Array } {
  const C = CELLS, nc = C * C * C;
  const sp = new Float32Array(nc * 4);
  let s = seed * 7919 + 13;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) | 0), ((s >>> 8) & 0xffffff) / 16777216);
  for (let i = 0; i < nc; i++) { sp[i * 4] = 0.5 + (rnd() - 0.5) * 0.7; sp[i * 4 + 1] = 0.5 + (rnd() - 0.5) * 0.7; sp[i * 4 + 2] = 0.5 + (rnd() - 0.5) * 0.7; sp[i * 4 + 3] = 0.42 + rnd() * 0.3; }
  const data = new Float32Array(N * N * N), half = new Uint16Array(N * N * N);
  const k = C / N;
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const px = (x + 0.5) * k, py = (y + 0.5) * k, pz = (z + 0.5) * k;
    const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
    let best = 9;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy, cz = iz + dz;
      const w = ((((cz % C) + C) % C) * C + (((cy % C) + C) % C)) * C + (((cx % C) + C) % C);
      const ox = cx + sp[w * 4] - px, oy = cy + sp[w * 4 + 1] - py, oz = cz + sp[w * 4 + 2] - pz;
      const d = Math.sqrt(ox * ox + oy * oy + oz * oz) - sp[w * 4 + 3];
      if (d < best) best = d;
    }
    const i = (z * N + y) * N + x;
    data[i] = best; half[i] = THREE.DataUtils.toHalfFloat(Math.max(-1, Math.min(1.5, best)));
  }
  const tex = new THREE.Data3DTexture(half, N, N, N);
  tex.format = THREE.RedFormat; tex.type = THREE.HalfFloatType;
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping; tex.unpackAlignment = 1; tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, data };
}

/** the storm SDF (GLSL): uniforms + base shape + octaves. Shared by the tracer and any debug shader. */
export const STORM_SDF = /* glsl */ `
uniform highp sampler3D uSph;
uniform vec2 uCenter;
uniform float uR, uH, uOv, uTime, uFaceOut;
#define CELLS ${CELLS.toFixed(1)}
float sphG(vec3 q) { return texture(uSph, q * (1.0 / CELLS)).r; }
float sminK(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
float smaxK(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return max(a, b) + h * h * k * 0.25; }
// face radius at height y: the base of the wall stands a little outside the damage circle (the octaves bulge it back in
// to about the circle), the top leans over the safe zone
float faceR(float y) { return uR + uFaceOut - uOv * pow(clamp(y / uH, 0.0, 1.5), 1.3); }
// the ceiling: the wall top near the face, sagging into the deck outward, the deck lower toward the horizon
float topY(float r) { float o = max(r - uR, 0.0); return uH * (1.0 - 0.22 * smoothstep(80.0, 900.0, o)) - 0.012 * max(o - 900.0, 0.0); }
// cumulonimbus towers on the skyline (without them: a dead-straight top shelf where the far wall meets the
// sky): the ceiling rises up to ~150 m where a 380 m sphere-grid cell sits (world-anchored, so the towers stay put as the
// circle moves); slope ≤ 0.45, the field stays a safe distance bound
float tower(vec2 xz) { return 235.0 * clamp(0.25 - sphG(vec3(xz.x, 11.0, xz.y) * (1.0 / 400.0)), 0.0, 1.0); }   // (taller, slope ≤ 0.6)
float baseSdf(vec3 p) {
  float r = length(p.xz - uCenter);
  return smaxK(faceR(p.y) - r, p.y - topY(r) - tower(p.xz), 90.0);
}
// one octave of bubbles ANCHORED to the current surface: the zero set of (c·sphere-grid + a·c) + d is a rounded dome
// wherever a sphere sits near the surface (paraboloid profile, height ≤ its radius) and nothing where the sphere floats
// away from it — no detached balls, no clipped flat caps. ×0.5 keeps the field 1-Lipschitz (a safe distance bound).
#define LAM 1.6
float octv(float d, vec3 q, float c, float a) {
  float n = (c * (sphG(q / c) + a) + LAM * d) * (1.0 / (1.0 + LAM));
  return sminK(n, d, 0.38 * c);
}
const mat3 ROTO = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
// lod = octaves (1..6; 6 adds the shading-only grain). Far from the surface the remaining octaves are skipped with a
// conservative bound (their total growth), so the tracer pays for detail only where it can matter.
// gExact = false when the value is only a lower bound (octaves skipped far from the surface): never a hit
bool gExact = true;
float stormSdf(vec3 p, int lod) {
  gExact = false;
  float d = baseSdf(p);
  if (d > 640.0) return d - 620.0;
  vec3 q = ROTO * (p - vec3(0.0, uTime * 0.9, 0.0));
  // the deck, out past the wall: big cumulus heads (half-kilometre domes) before the wall's own billows
  float wD = smoothstep(250.0, 750.0, length(p.xz - uCenter) - uR);
  if (wD > 0.0) d = mix(d, octv(d, q + vec3(31.0, 0.0, 7.0), 540.0, -0.12), wD);
  if (lod < 1) { gExact = true; return d; }
  d = octv(d, q * vec3(1.0, 1.15, 1.0), 220.0, 0.0);
  if (lod < 2) { gExact = true; return d; }
  if (d > 110.0) return d - 102.0;
  q = ROTO * q + vec3(17.0, 3.0, 11.0);
  d = octv(d, q, 85.0, -0.05);
  // what you see is where it hurts: no billow reaches more than ~20 m inside the (leaning) damage face
  d = smaxK(d, uR - 20.0 - uOv * pow(clamp(p.y / uH, 0.0, 1.5), 1.3) - length(p.xz - uCenter), 40.0);
  if (lod < 3) { gExact = true; return d; }
  if (d > 36.0) return d - 31.0;
  q = ROTO * q + vec3(5.0, 13.0, 2.0);
  d = octv(d, q, 32.0, -0.04);
  if (lod < 4) { gExact = true; return d; }
  if (d > 11.0) return d - 9.0;
  q = ROTO * q + vec3(3.0, 1.0, 7.0);
  d = octv(d, q, 12.0, -0.02);
  if (lod < 5) { gExact = true; return d; }
  if (d > 4.0) return d - 3.0;
  q = ROTO * q + vec3(1.0, 9.0, 4.0);
  d = octv(d, q, 4.8, 0.02);
  if (lod < 6) { gExact = true; return d; }
  q = ROTO * q + vec3(2.0, 5.0, 8.0);
  gExact = true;
  return octv(d, q, 1.9, 0.06);
}
`;

const TRACE_VERT = /* glsl */ `
out vec2 vNdc;
void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const TRACE_FRAG = /* glsl */ `
precision highp float;
${STORM_SDF}
uniform mat4 uInvProj, uCamWorld, uView;
uniform vec3 uCam, uSunDir, uSunCol, uHazeCol, uBoltCol;
uniform float uPixAng, uHazeK, uLipK, uFlash, uNearFade, uDebug, uHalf;
uniform vec4 uBolt[4];
// the island's ground height (m, ≥ 0 = sea level) on a 256² grid over the world square: the wall's foot
uniform sampler2D uGround;
float groundAt(vec2 xz) { return texture(uGround, xz / (2.0 * uHalf) + 0.5).r; }
in vec2 vNdc;
layout(location = 0) out highp vec4 oCol;
layout(location = 1) out highp vec4 oDep;

const vec3 MURK = vec3(0.10, 0.08, 0.16);
// premultiplied colour + view depth, with the cloud the camera started in laid over it
void emit(vec3 col, float a, float z, float murk, float zMurk) {
  float m = murk * uNearFade;
  oCol = vec4(MURK * m + col * a * (1.0 - m), m + a * (1.0 - m));
  // a miss with no murk is FAR, not at the murk exit: the composite takes the nearest of 2×2 depths, so a near zMurk
  // beside a silhouette dragged the cloud's soft fringe in front of the whole world (a dotted storm outline drawn over
  // trees and terrain everywhere)
  oDep = vec4(a > 0.01 ? z : m > 0.004 ? zMurk : -1e5, 0.0, 0.0, 1.0);
}
// ray vs the vertical cylinder |xz - C| = rad: returns (tIn, tOut), tIn > tOut when the ray never crosses it
vec2 cyl(vec3 ro, vec3 rd, float rad) {
  vec2 o = ro.xz - uCenter; vec2 d = rd.xz;
  float a = dot(d, d), b = dot(o, d), c = dot(o, o) - rad * rad;
  if (a < 1e-8) return c < 0.0 ? vec2(-1e9, 1e9) : vec2(1e9, -1e9);
  float disc = b * b - a * c;
  if (disc < 0.0) return vec2(1e9, -1e9);
  float s = sqrt(disc);
  return vec2((-b - s) / a, (-b + s) / a);
}

void main() {
  vec4 v = uInvProj * vec4(vNdc, 1.0, 1.0);
  vec3 rd = normalize(mat3(uCamWorld) * (v.xyz / v.w));
  vec3 ro = uCam;
  oCol = vec4(0.0); oDep = vec4(-1e5, 0.0, 0.0, 1.0);
  // ---- analytic bounds: the storm lives outside the inner cylinder (face minus lean minus the biggest bulge) and
  // below its tallest crowns
  float rIn = uR + uFaceOut - uOv - 390.0;
  float yMax = uH + 420.0;
  float t0 = 0.0, tMax = 16000.0;
  vec2 ci = cyl(ro, rd, rIn);
  if (ci.x < ci.y && ci.y > 0.0 && ci.x < 0.0) t0 = ci.y;                 // camera inside the clear zone: from its exit
  if (ro.y > yMax) { if (rd.y >= -1e-4) return; t0 = max(t0, (yMax - ro.y) / rd.y); }
  else if (rd.y > 1e-4) tMax = min(tMax, (yMax - ro.y) / rd.y);
  if (rd.y < -1e-4) tMax = min(tMax, (-60.0 - ro.y) / rd.y);                // under the ground: terrain hides it
  if (t0 >= tMax) return;

  // ---- trace
  float t = t0, tHit = -1.0, minR = 1e9, tMinR = 0.0;
  float d0 = stormSdf(ro + rd * t, 4);
  // the camera is IN a billow (flying through the wall top, standing in a bulge): march out of it and carry the cloud
  // it crossed as murk in front of whatever the ray finds behind — never an empty hole
  float murk = 0.0, tOut = 0.0;
  if (d0 < 0.0 && t0 <= 0.0) {
    for (int i = 0; i < 24; i++) { float d = stormSdf(ro + rd * t, 3); if (d > 0.4 || t > 500.0) break; t += max(-d, 1.5); }
    tOut = t; murk = (1.0 - exp(-t / 45.0)) * 0.9;
    t += 0.5;
  }
  float dLast = 1e9; int iters = 0, fb = 0;
  // over-relaxed sphere tracing (Keinert et al.): step ω·d, and step back when consecutive spheres stop overlapping.
  // The marched field carries the silhouette octaves only (the two finest are shading-only, see the normal below).
  float omega = 1.35, prevD = 0.0, stepL = 0.0;
  for (int i = 0; i < 64; i++) {
    if (t > tMax) break;
    iters++;
    vec3 p = ro + rd * t;
    int lod = t < 900.0 ? 3 : t < 2500.0 ? 2 : 1;
    float d = stormSdf(p, lod);
    float px = t * uPixAng;
    bool fail = omega > 1.0 && (d + prevD) < stepL;
    if (fail) { stepL -= omega * stepL; omega = 1.0; }
    else {
      dLast = d;
      if (gExact && d < max(0.05, px * (1.2 + t * 0.0002))) { tHit = t; break; }
      float ratio = d / max(px, 1e-3);
      if (ratio < minR) { minR = ratio; tMinR = t; }
      stepL = max(d * omega, px * (0.6 + t * 0.0007));
    }
    prevD = d;
    t += stepL;
  }
  // out of steps while skimming the billows (grazing rays): finish on the big forms only (never a hole to the sky,
  // never a false floating blob)
  if (tHit < 0.0 && t < tMax) {
    for (int i = 0; i < 28; i++) {
      if (t > tMax) break;
      fb++;
      float d = stormSdf(ro + rd * t, 1);
      // a grazing ray this deep into its budget is skimming the billows: accept within a few pixels
      if (gExact && d < max(0.5, t * uPixAng * 4.0)) { tHit = t; break; }
      t += max(d, t * uPixAng * 2.0);
    }
    // still skimming inside the wall's shell: that is the wall (a hole to the sky would be worse)
    if (tHit < 0.0 && t < tMax && baseSdf(ro + rd * t) < 60.0) tHit = t;
  }
  if (uDebug > 0.5 && uDebug < 1.5) {
    // debug: green→red = main-loop steps, blue = miss after the fallback, magenta = hit in the fallback
    float it = float(iters) / 64.0;
    vec3 dc = tHit < 0.0 ? (fb > 0 ? vec3(0.0, 0.3, 1.0) : vec3(0.0, 0.0, 0.25)) : fb > 0 ? vec3(1.0, 0.0, 1.0) : vec3(it, 1.0 - it, 0.0);
    oCol = vec4(dc, 1.0); oDep = vec4(-5.0, 0.0, 0.0, 1.0); return;
  }
  float zMurk = (uView * vec4(ro + rd * max(tOut, 0.5), 1.0)).z;
  // a ray that skimmed the surface within ~1.5 px is the cloud's soft fringe (anti-aliased silhouettes against the
  // sky, never a stair-stepped outline — and a little fuzz on every edge): shade the closest approach, fade it
  float edgeA = 1.0;
  if (tHit < 0.0 && minR < 1.6 && tMinR > t0) { tHit = tMinR; edgeA = smoothstep(1.6, 0.15, minR); }
  if (tHit < 0.0) { emit(vec3(0.0), 0.0, -1e5, murk, zMurk); return; }

  // ---- land on the surface (early accepts + over-relaxation leave the point a little off it: banding)
  { float dr = stormSdf(ro + rd * tHit, 3); tHit = max(tHit + dr * 0.9, t0); }
  // ---- shade the hit
  vec3 p = ro + rd * tHit;
  float px = tHit * uPixAng;
  // bud octave (4.8 m) only between ~60 and 160 m: closer it reads as marbled wallpaper, farther it is sub-pixel
  int lodN = tHit < 60.0 ? 4 : tHit < 160.0 ? 5 : tHit < 1100.0 ? 4 : tHit < 3500.0 ? 3 : 2;
  float h = max(0.4, px * 1.5);
  vec2 kk = vec2(1.0, -1.0);
  vec3 gN = kk.xyy * stormSdf(p + kk.xyy * h, lodN) + kk.yyx * stormSdf(p + kk.yyx * h, lodN) +
            kk.yxy * stormSdf(p + kk.yxy * h, lodN) + kk.xxx * stormSdf(p + kk.xxx * h, lodN);
  vec3 n = normalize(gN);
  // the field is NOT a unit-slope distance (the octave blends compress it): its local slope, for occlusion / shadows
  float slope = clamp(length(gN) / (4.0 * h), 0.2, 1.0);
  // the billow-scale normal (the 220 + 85 m forms, sampled wide): lighting reads at the scale of the lobes — each lobe
  // gets a lit crown and a shaded belly — and the fine normal only adds texture on top
  // (pits under ~24 m drop out of the lighting normal near the camera; far away the 14 m scale keeps the
  // cauliflower crisp — there a pit is a pixel, not a crater)
  float farK = smoothstep(150.0, 600.0, tHit);
  float hc = max(mix(24.0, 14.0, farK), px * 6.0);
  int lodC = tHit < 400.0 ? 3 : 2;
  vec3 nC = normalize(kk.xyy * stormSdf(p + kk.xyy * hc, lodC) + kk.yyx * stormSdf(p + kk.yyx * hc, lodC) +
                      kk.yxy * stormSdf(p + kk.yxy * hc, lodC) + kk.xxx * stormSdf(p + kk.xxx * hc, lodC));
  float r = length(p.xz - uCenter);
  vec2 inward = (uCenter - p.xz) / max(r, 1.0);
  vec3 inw3 = vec3(inward.x, 0.0, inward.y);
  // from the air the whole ring reads as the dark deck (charcoal blue-grey); only the lip glows
  // (at 0.9 the wall's bright lavender crowns + AO pits leaked 10 % into the dark deck — the "crater" look)
  // (the lower half of the wall must not look yellow from high altitude and purple closer to the ground) the
  // altitude ramp uLipK turned the WHOLE inner face into deck + lip glow: from the plane (720 m) the face down to the water
  // read banana-yellow / mustard. From the air only the upper face joins the deck (and carries the golden lip); the lower
  // face keeps the storm's violet it has from the ground.
  float deck = max(smoothstep(60.0, 420.0, r - uR), uLipK * smoothstep(0.45, 0.85, p.y / uH));

  // ---- SOFT CUMULUS SHADING (not flat mottled wallpaper or mud). A storm cloud is not a
  // solid: light wraps deep round every billow, the shaded side is a luminous purple (light scattered inside), only the
  // creases between billows go dark. The KEY is the storm's own: from above and from the sunlit safe zone the face looks
  // over (the leading face is lit whatever the sun's azimuth; a physically sun-lit wall would be a black cliff on
  // half the circle), leaning toward the sun; the real sun adds a warm cream sheen on the crowns that face it.
  vec3 sunH = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(1e-4, 0.0, 0.0));
  vec3 K = normalize(inw3 * 0.42 + vec3(0.0, 1.0, 0.0) + sunH * 0.45);
  float ao1 = tHit < 700.0 ? stormSdf(p + n * max(5.0, px * 3.0), 4) : slope * max(5.0, px * 3.0);
  float ao2 = stormSdf(p + nC * max(22.0, px * 10.0), 3), ao3 = stormSdf(p + nC * max(70.0, px * 28.0), 2);
  float occ = clamp(1.0 - ao1 / (slope * max(5.0, px * 3.0)), 0.0, 1.0) * 0.06 + clamp(1.0 - ao2 / (slope * max(22.0, px * 10.0)), 0.0, 1.0) * 0.3 + clamp(1.0 - ao3 / (slope * max(70.0, px * 28.0)), 0.0, 1.0) * 0.55;
  float ao = clamp(1.0 - occ * 1.2, 0.0, 1.0);
  ao = ao * ao * (3.0 - 2.0 * ao);
  // billows shade the ones below / behind them (soft shadow along the key)
  float sh = 1.0, st = 8.0;
  for (int j = 0; j < 2; j++) { float dd = stormSdf(p + K * st, j == 0 ? 3 : 2); sh = min(sh, clamp(dd / (slope * st) * 1.3 + 0.15, 0.0, 1.0)); st *= 4.5; }
  sh = sh * sh * (3.0 - 2.0 * sh);
  // light at the scale of the lobes: the fine normal only adds a little texture, so the small concave gaps between
  // buds never read as dark pits
  vec3 nL = normalize(nC * (0.92 - 0.3 * farK) + n * (0.08 + 0.3 * farK));
  float ndl = dot(nL, K);
  // a firmer terminator: each lobe a lit dome over a shaded belly, not smoke
  float lit = smoothstep(-0.18, 0.82, ndl) * mix(0.45, 1.0, sh);   // (a pit's own shadow never goes black)
  float ndv = clamp(dot(n, -rd), 0.0, 1.0);
  float behind = r - faceR(p.y);
  float core = smoothstep(-30.0, 170.0, behind) * (1.0 - deck);          // deep inside the wall: darker, bluer
  float hgt = clamp(p.y / uH, 0.0, 1.2);
  // stylised storm ramp (linear, pre-tone-map; target colours: creases #2a2238, body #5a4a7a, crowns lavender, the
  // sunlit leading face cream-pink #e8d0d0)
  vec3 cCrease = vec3(0.022, 0.016, 0.052), cShade = vec3(0.060, 0.042, 0.135), cBody = vec3(0.17, 0.12, 0.36);
  vec3 cLit = vec3(0.40, 0.32, 0.64), cCrown = vec3(0.95, 0.80, 0.86);
  vec3 col = mix(cShade, cBody, smoothstep(0.0, 0.45, lit));
  col = mix(col, cLit, smoothstep(0.4, 0.8, lit));
  // the palest crowns only where the real sun reaches them too (a sunlit leading edge), never the whole face
  float sunF = max(dot(nL, uSunDir), 0.0);
  col = mix(col, cCrown, smoothstep(0.66, 1.0, lit) * (0.3 + 0.7 * smoothstep(0.05, 0.7, sunF)) * (0.35 + 0.65 * smoothstep(0.1, 0.6, hgt)) * (1.0 - core) * 0.85);
  // sunlit cream crowns: the upper rim of every lobe — its normal turned up and toward the
  // light — is cream, the belly under it violet: billows read as stacked domes from 5 m to 2 km
  float crownUp = smoothstep(0.18, 0.8, dot(nC, normalize(vec3(0.0, 1.0, 0.0) + sunH * 0.55 + inw3 * 0.25)));
  col = mix(col, cCrown * (0.82 + 0.18 * sunF), crownUp * smoothstep(0.42, 0.92, lit) * (0.4 + 0.6 * smoothstep(0.04, 0.45, hgt)) * (1.0 - core) * 0.8);
  col *= mix(0.62, 1.0, 1.0 - core);
  col = mix(cCrease, col, mix(0.42, 1.0, ao));
  // the real sun: crowns facing it catch a warm cream sheen (the sunlit leading face)
  col += vec3(0.9, 0.72, 0.62) * sunF * sunF * lit * ao * 0.25 * (1.0 - core);
  // silver lining: edges seen against the light glow (backlit billows)
  float back = pow(max(dot(rd, uSunDir), 0.0), 4.0);
  col += vec3(1.0, 0.9, 0.86) * pow(1.0 - ndv, 3.0) * (0.06 + 0.5 * back) * ao;
  // warm sand bounce under the lowest billows
  col += vec3(0.05, 0.035, 0.02) * max(-nL.y, 0.0) * smoothstep(110.0, 0.0, p.y) * ao;
  if (uDebug > 2.5) { oCol = vec4(col, 1.0); oDep = vec4((uView * vec4(p, 1.0)).z, 0.0, 0.0, 1.0); return; }
  if (uDebug > 1.5) { oCol = vec4(lit, sh, ao, 1.0); oDep = vec4((uView * vec4(p, 1.0)).z, 0.0, 0.0, 1.0); return; }
  // the dust-lit foot from afar: sand blown into the lowest billows, sunlit gold
  float dust = smoothstep(55.0, 0.0, p.y) * (1.0 - deck) * smoothstep(90.0, 400.0, tHit);
  col = mix(col, vec3(0.62, 0.48, 0.28) * (0.5 + 0.5 * lit), dust * 0.5);
  // lightning INSIDE the wall: billows around a live bolt glow from within (+ a global flash)
  for (int i = 0; i < 4; i++) {
    vec4 b = uBolt[i];
    if (b.w <= 0.0) continue;
    vec3 dl = b.xyz - p; float dist = length(dl);
    // a local glow in the billows round the channel (its reach scales with the view so a near bolt lights a few
    // billows, not the whole frame), pale gold so it lifts the purple instead of browning it
    // a flash on the wall face: a wider, brighter bloom of light through the billows round the channel
    float reach = 30.0 + 0.06 * tHit;
    col += mix(uBoltCol, vec3(1.0, 0.95, 0.8), 0.45) * b.w * 0.34 * exp(-dist / reach) * (0.35 + 0.65 * clamp(dot(nL, dl / max(dist, 1.0)) * 0.5 + 0.5, 0.0, 1.0)) * (0.4 + 0.6 * ao);
  }
  col += mix(uBoltCol, vec3(0.9, 0.85, 1.0), 0.5) * uFlash * 0.09 * (1.0 - deck) * (0.5 + 0.5 * lit);
  float wrapD = lit;

  // ---- the deck from the air: a rolling charcoal-blue cumulus field (#2a313b … #2e3a47), crowns lit a
  // cool grey, creases dark but never black
  if (deck > 0.01) {
    // lit at the scale of the cumulus HEADS (the 540 + 220 m forms): big soft domes with lit tops and dark valleys between
    // them, the 85 m billows only as texture — no crease speckle (never grey mud with black craters)
    float hd = max(40.0, px * 10.0), hb = max(110.0, px * 22.0);
    vec3 nD = normalize(kk.xyy * stormSdf(p + kk.xyy * hd, 1) + kk.yyx * stormSdf(p + kk.yyx * hd, 1) +
                        kk.yxy * stormSdf(p + kk.yxy * hd, 1) + kk.xxx * stormSdf(p + kk.xxx * hd, 1));
    vec3 nB = normalize(kk.xyy * stormSdf(p + kk.xyy * hb, 0) + kk.yyx * stormSdf(p + kk.yyx * hb, 0) +
                        kk.yxy * stormSdf(p + kk.yxy * hb, 0) + kk.xxx * stormSdf(p + kk.xxx * hb, 0));
    // a low key from the sun's side: heads lit on one flank, the other flank and the valleys in shade
    vec3 Ld = normalize(vec3(0.0, 0.45, 0.0) + uSunDir);
    // the big heads carry the light (whole regions lit or in shade), the 220 m domes a softer modulation, no speckle
    float litB = smoothstep(-0.2, 0.95, dot(nB, Ld)), litD = smoothstep(-0.7, 1.0, dot(normalize(nD * 0.8 + nC * 0.2), Ld));
    // the 40 m dimples only tint the big heads — no black pits
    // no soft-shadow / crease terms from the air: they printed round dark spots on the heads
    // + the 85 m billows sampled at 60 m (lod 2): lumpy heads, never dimple dots
    float hm = max(60.0, px * 14.0);
    vec3 nM = normalize(kk.xyy * stormSdf(p + kk.xyy * hm, 2) + kk.yyx * stormSdf(p + kk.yyx * hm, 2) +
                        kk.yxy * stormSdf(p + kk.yxy * hm, 2) + kk.xxx * stormSdf(p + kk.xxx * hm, 2));
    float litM = smoothstep(0.05, 0.95, dot(nM, Ld));
    // near the camera (the wall top under a glider) the lobe normal adds the smaller billows
    float litC = smoothstep(0.05, 0.95, dot(nC, Ld)), nearD = 1.0 - smoothstep(900.0, 2200.0, tHit);
    float dLit = mix(0.4 * litB + 0.15 * litD + 0.45 * litM, 0.3 * litB + 0.3 * litM + 0.4 * litC, nearD);
    float aoD = 1.0;
    // target colours: valleys #2a313b, lit heads #50586a — near-black blue-grey, never mud
    // (the post's aerial haze lifts the far deck to mid grey — author it darker so it lands on navy)
    // charcoal billows with grey-lit heads: valleys #1c2028, heads #6a707c
    vec3 dcol = mix(vec3(0.006, 0.0068, 0.0095), vec3(0.018, 0.02, 0.027), smoothstep(0.25, 0.62, dLit));
    dcol = mix(dcol, vec3(0.09, 0.096, 0.115), smoothstep(0.66, 0.92, dLit) * 0.9);
    dcol *= mix(0.82, 1.0, aoD);
    col = mix(col, dcol, deck);
    if (uDebug > 3.5) { oCol = vec4(vec3(deck, dLit, aoD), 1.0); oDep = vec4((uView * vec4(p, 1.0)).z, 0.0, 0.0, 1.0); return; }
  }
  // the deck's faint radial motion streaks (the storm spinning inward)
  if (uLipK > 0.0) {
    vec2 rel = p.xz - uCenter; float ang = atan(rel.y, rel.x);
    float sk = sin(ang * 380.0 + sin(ang * 23.0) * 4.0) * 0.5 + 0.5;
    float sk2 = sin(ang * 131.0 + 1.7) * 0.5 + 0.5;
    col += vec3(0.03, 0.035, 0.045) * pow(sk * sk2, 12.0) * uLipK * smoothstep(150.0, 600.0, r - uR) * max(nL.y, 0.0);
  }
  // ---- the banana-yellow LIP lit from inside the ring: an EMISSIVE glow added on top of the lit deck
  // (no painted sponge, no black holes): strongest on the inward-facing slopes at the inner edge, fading smoothly
  // outward over ~300 m and up the crowns, modulated only gently by the creases
  if (uLipK > 0.0) {
    // distance behind the inner face (0 on the face, bulges negative): the glow hugs the inner edge (~120 m)
    float radial = exp(-max(behind + 12.0, 0.0) / 26.0);   // (a thin lip, not a thick sponge band)
    float facing = smoothstep(-0.4, 0.75, dot(nL.xz, inward));
    // a thin glowing golden lip: the glow gathers on the CREST of the inner face, the lower face falls off into the
    // dark wall; lit by the billow normal only (no soft-shadow blotches = no sponge)
    float crest = smoothstep(0.45, 0.9, hgt);   // (no glow floor on the lower face)
    float litR = smoothstep(-0.35, 0.9, dot(nC, normalize(vec3(inward.x, 0.9, inward.y))));
    float e = clamp(uLipK * radial * (0.25 + 0.75 * facing) * crest, 0.0, 1.0);
    // saturated banana gold on the lit inner faces, deeper amber in the folds; a little HDR on the hottest faces for bloom
    // (the post's haze dulls a plainer ramp to mustard, so it is authored saturated and bright)
    vec3 yel = mix(vec3(0.85, 0.38, 0.02), vec3(1.0, 0.8, 0.12), facing * litR) * 1.15;
    // billow definition inside the glow: lit crowns hot gold, the undersides deep amber (never brown pits)
    col = mix(col, yel * (0.22 + 0.78 * litR), e) + yel * e * e * (0.15 + 0.7 * litR * litR);
  }
  // aerial haze (the far wall sits in the island's air)
  vec3 dv = p - ro; float dl = length(dv);
  float hzf = 1.0 - smoothstep(0.08, 0.45, abs(dv.y) / max(dl, 1.0));
  col = mix(col, uHazeCol, clamp(1.0 - exp(-dl * uHazeK), 0.0, 0.62) * hzf);
  // close up the wall turns into the murk you are about to walk into (never a clipped polygon); once the camera is
  // in the storm (uNearFade → 0) the near murk fades away and the storm interior (fog, grade, sky) takes over
  // …and up close (< ~80 m) the billows sit behind a soft veil of their own vapour: depth and softness instead of a hard
  // marbled surface (no flat mottled wallpaper at 4-60 m)
  col = mix(col, cBody * 0.9 + vec3(0.02, 0.015, 0.035), (1.0 - smoothstep(8.0, 90.0, tHit)) * 0.22 * (1.0 - deck));
  col = mix(MURK * 1.6, col, smoothstep(1.5, 12.0, tHit));
  float a = mix(uNearFade, 1.0, smoothstep(30.0, 110.0, tHit)) * edgeA;
  // a translucent wall: the lowest ~20 m of the face are thin vapour — the world behind shows through, more the
  // closer you stand — over a golden glow where the storm meets the ground
  float hAb = p.y - groundAt(p.xz);
  float wisp = sphG(vec3(p.x, p.y * 1.6 - uTime * 2.4, p.z) * (1.0 / 26.0));
  float thin = (1.0 - smoothstep(3.0, 26.0, hAb + wisp * 9.0)) * (1.0 - deck);
  float nearT = (1.0 - smoothstep(6.0, 70.0, tHit)) * (1.0 - deck) * uNearFade;
  a *= 1.0 - max(thin * 0.34, nearT * 0.3);
  // the thin base keeps the storm's violet (never a pink wash of the sky behind it)
  col = mix(col, cBody * 1.05 + vec3(0.02, 0.01, 0.03), thin * 0.45);
  // the golden foot: sand and spray whipped up where the wall meets the ground — a bright band hugging the contact
  // line under a fainter gold haze a little higher (HDR so it blooms)
  float band = exp(-max(hAb, 0.0) / 4.0) * (1.0 - deck) * smoothstep(-8.0, 0.0, hAb);
  float haze = exp(-max(hAb, 0.0) / 16.0) * (1.0 - deck) * (0.6 + 0.4 * wisp);
  col = mix(col, vec3(0.75, 0.52, 0.30), haze * 0.35);
  col = mix(col, vec3(1.7, 1.2, 0.62) * (0.8 + 0.35 * wisp), band * 0.8);
  a = max(a, band * 0.9 * edgeA);
  emit(col, a, (uView * vec4(p, 1.0)).z, murk, zMurk);
}
`;

const COMP_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const COMP_FRAG = /* glsl */ `
uniform mat4 projectionMatrix;
uniform sampler2D uCol, uDep;
uniform vec2 uSize;
varying vec2 vUv;
// Catmull-Rom upsample of the traced colour (5 bilinear taps). Bilinear magnification of a 0.2-0.33x trace turned every
// silhouette into a visible staircase at 4K; the cubic keeps edges crisp and round.
vec4 sampleCR(vec2 uv, vec2 size) {
  vec2 sp = uv * size, tp = floor(sp - 0.5) + 0.5, f = sp - tp;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f)), w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f)), w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2, o12 = w2 / w12;
  vec2 t0 = (tp - 1.0) / size, t3 = (tp + 2.0) / size, t12 = (tp + o12) / size;
  vec4 r = texture2D(uCol, vec2(t12.x, t0.y)) * (w12.x * w0.y) + texture2D(uCol, vec2(t0.x, t12.y)) * (w0.x * w12.y)
         + texture2D(uCol, t12) * (w12.x * w12.y) + texture2D(uCol, vec2(t3.x, t12.y)) * (w3.x * w12.y)
         + texture2D(uCol, vec2(t12.x, t3.y)) * (w12.x * w3.y);
  float ws = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  r /= ws;
  r.a = clamp(r.a, 0.0, 1.0);
  return vec4(clamp(r.rgb, vec3(0.0), vec3(max(r.a, 0.0) * 64.0)), r.a);
}
void main() {
  vec4 c = sampleCR(vUv, uSize);
  if (c.a < 0.004) discard;
  // edge-directed smoothing (FXAA-style, in trace space): the trace is aliased where a near billow crosses a far one; blend
  // two extra cubic taps along the edge tangent so the upsampled outline is a smooth curve, not 3-5 px steps at 4K
  {
    vec2 px = 1.0 / uSize;
    vec3 W3 = vec3(0.3, 0.55, 0.15);
    float lN = dot(texture2D(uCol, vUv + vec2(0.0, px.y)).rgb, W3), lS = dot(texture2D(uCol, vUv - vec2(0.0, px.y)).rgb, W3);
    float lE = dot(texture2D(uCol, vUv + vec2(px.x, 0.0)).rgb, W3), lW = dot(texture2D(uCol, vUv - vec2(px.x, 0.0)).rgb, W3);
    vec2 gr = vec2(lE - lW, lN - lS);
    float gl = length(gr), lc = max(dot(c.rgb, W3), 0.02);
    if (gl > 0.08 * lc) {
      vec2 tn = normalize(vec2(-gr.y, gr.x)) * px * 1.25;
      vec4 a = sampleCR(vUv + tn, uSize), b = sampleCR(vUv - tn, uSize);
      c = mix(c, (a + b) * 0.5, clamp(gl / (0.25 * lc), 0.0, 0.66));
    }
  }
  // dither ≥ 1 quantum of the R11G11B10F scene buffer: smooth violet gradients band otherwise
  vec3 p3 = fract(vec3(gl_FragCoord.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33);
  c.rgb *= 1.0 + (fract((p3.x + p3.y) * p3.z) - 0.5) * 0.04;
  // nearest depth (never average the wall with the sky); the full-res depth test does the rest (palms in front)
  // the closest depth of the 2×2 texels under this pixel: soft silhouettes keep the wall's depth (no staircase against
  // the sky), while anything nearer (a palm) still wins the full-res depth test
  vec2 fp = vUv * uSize - 0.5;
  ivec2 i0 = ivec2(floor(fp)), mx = ivec2(uSize) - 1;
  float z = max(max(texelFetch(uDep, clamp(i0, ivec2(0), mx), 0).r, texelFetch(uDep, clamp(i0 + ivec2(1, 0), ivec2(0), mx), 0).r),
                max(texelFetch(uDep, clamp(i0 + ivec2(0, 1), ivec2(0), mx), 0).r, texelFetch(uDep, clamp(i0 + ivec2(1, 1), ivec2(0), mx), 0).r));
  vec4 clip = projectionMatrix * vec4(0.0, 0.0, min(z, -0.2), 1.0);
  gl_FragDepthEXT = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  gl_FragColor = c;
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface StormVolume {
  /** the full-res composite (add to the scene; renderOrder after the atmos clouds) */
  readonly mesh: THREE.Mesh;
  readonly u: {
    uSph: { value: THREE.Texture };
    uCenter: { value: THREE.Vector2 }; uR: { value: number }; uH: { value: number }; uOv: { value: number }; uTime: { value: number }; uFaceOut: { value: number };
    uSunDir: { value: THREE.Vector3 }; uSunCol: { value: THREE.Color }; uHazeCol: { value: THREE.Color }; uHazeK: { value: number }; uLipK: { value: number }; uFlash: { value: number };
    uBolt: { value: THREE.Vector4[] }; uBoltCol: { value: THREE.Color }; uNearFade: { value: number };
  };
  /** trace the storm for this frame (call after the camera is final, before the frame renders) */
  trace(renderer: THREE.WebGLRenderer, cam: THREE.PerspectiveCamera): void;
  compile(renderer: THREE.WebGLRenderer): Promise<unknown>;
  /** dev: the trace target (a bench reads a pixel back to sync the GPU) */
  readonly target: THREE.WebGLRenderTarget | null;
  /** CPU copy of the storm SDF (bolt placement): world point → signed distance (m), octaves 1..5 */
  sdf(x: number, y: number, z: number, lod?: number): number;
  dispose(): void;
}

/** traced pixels per quality tier (the composite is always full res) */
const PIXELS: Record<string, number> = { ultra: 0.36e6, high: 0.30e6, medium: 0.23e6, low: 0.16e6 };

export function createStormVolume(o: { boltCol: THREE.Color; hazeCol: THREE.Color; bolts: THREE.Vector4[]; quality?: string; ground?: (x: number, z: number) => number; half?: number }): StormVolume {
  const budget = PIXELS[o.quality ?? "high"] ?? PIXELS.high;
  const grid = bakeSphereGrid(7);
  // the ground under the wall (its foot glow / translucent base): a 256² float height grid over the world square
  // (half float: linear filtering is core in WebGL2 — float32 linear needs an extension some Macs lack)
  const half = o.half ?? 2048, GN = 256, gh = new Uint16Array(GN * GN);
  if (o.ground) for (let i = 0; i < GN; i++) for (let j = 0; j < GN; j++) gh[i * GN + j] = THREE.DataUtils.toHalfFloat(Math.max(0, o.ground(-half + (j + 0.5) / GN * 2 * half, -half + (i + 0.5) / GN * 2 * half)));
  const groundTex = new THREE.DataTexture(gh, GN, GN, THREE.RedFormat, THREE.HalfFloatType);
  groundTex.minFilter = groundTex.magFilter = THREE.LinearFilter; groundTex.wrapS = groundTex.wrapT = THREE.ClampToEdgeWrapping; groundTex.needsUpdate = true;
  const u = {
    uSph: { value: grid.tex as THREE.Texture },
    uCenter: { value: new THREE.Vector2() }, uR: { value: 900 }, uH: { value: 470 }, uOv: { value: 90 }, uTime: { value: 0 }, uFaceOut: { value: 60 },
    uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uView: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0.4, 0.62, 0.55).normalize() }, uSunCol: { value: new THREE.Color(4.8, 4.5, 4.1) }, uHazeCol: { value: o.hazeCol }, uHazeK: { value: 1 / 2600 }, uLipK: { value: 0 }, uFlash: { value: 0 },
    uBolt: { value: o.bolts }, uBoltCol: { value: o.boltCol }, uPixAng: { value: 0.001 }, uNearFade: { value: 1 },
    uGround: { value: groundTex as THREE.Texture }, uHalf: { value: half },
    uDebug: { value: flag("stormdebug") },
  };
  const traceMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: TRACE_VERT, fragmentShader: TRACE_FRAG, uniforms: u, depthTest: false, depthWrite: false });
  const tri = new THREE.BufferGeometry();
  tri.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const traceMesh = new THREE.Mesh(tri, traceMat); traceMesh.frustumCulled = false;
  const traceScene = new THREE.Scene(); traceScene.add(traceMesh);
  const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const TRACE_TARGET: THREE.RenderTargetOptions = { count: 2, type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false };
  let rt: THREE.WebGLRenderTarget | null = null;
  let tqEpoch = contextEpoch();
  const cu = { uCol: { value: null as THREE.Texture | null }, uDep: { value: null as THREE.Texture | null }, uSize: { value: new THREE.Vector2(1, 1) } };
  const compMat = new THREE.ShaderMaterial({
    vertexShader: COMP_VERT, fragmentShader: COMP_FRAG, uniforms: cu, transparent: true, depthWrite: false, depthTest: true, fog: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const mesh = new THREE.Mesh(tri, compMat); mesh.frustumCulled = false; mesh.name = "storm-volume"; mesh.renderOrder = 0.7;
  const size = new THREE.Vector2();

  // ---- CPU SDF (same maths as the GLSL, trilinear on the baked grid)
  const g = grid.data;
  const sampleG = (x: number, y: number, z: number) => {
    // q in cell units → texel space (texel centres at (i + 0.5) / N * CELLS)
    const fx = (x / CELLS) * N - 0.5, fy = (y / CELLS) * N - 0.5, fz = (z / CELLS) * N - 0.5;
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz), tx = fx - ix, ty = fy - iy, tz = fz - iz;
    const w = (i: number) => ((i % N) + N) % N;
    const at = (a: number, b: number, c: number) => g[(w(c) * N + w(b)) * N + w(a)];
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(l(l(at(ix, iy, iz), at(ix + 1, iy, iz), tx), l(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), tx), ty),
      l(l(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), tx), l(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), tx), ty), tz);
  };
  const smin = (a: number, b: number, k: number) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
  const smax = (a: number, b: number, k: number) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; };
  // GLSL mat3(...) is column-major: ROTO * v = col0 * v.x + col1 * v.y + col2 * v.z
  const R = [0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64];
  const Q = [0, 0, 0];
  const rot = (x: number, y: number, z: number) => { Q[0] = R[0] * x + R[3] * y + R[6] * z; Q[1] = R[1] * x + R[4] * y + R[7] * z; Q[2] = R[2] * x + R[5] * y + R[8] * z; };
  const oct = (d: number, qx: number, qy: number, qz: number, c: number, a: number) => { const n = (c * (Math.max(-1, Math.min(1.5, sampleG(qx / c, qy / c, qz / c))) + a) + 1.6 * d) / 2.6; return smin(n, d, 0.38 * c); };
  const faceR = (y: number) => u.uR.value + u.uFaceOut.value - u.uOv.value * Math.pow(Math.min(1.5, Math.max(0, y / u.uH.value)), 1.3);
  const topY = (r: number) => { const o = Math.max(r - u.uR.value, 0); const s = Math.min(1, Math.max(0, (o - 80) / 820)); return u.uH.value * (1 - 0.22 * s * s * (3 - 2 * s)) - 0.012 * Math.max(o - 900, 0); };
  const sdf = (x: number, y: number, z: number, lod = 5) => {
    const r = Math.hypot(x - u.uCenter.value.x, z - u.uCenter.value.y);
    let d = smax(faceR(y) - r, y - topY(r) - 235 * Math.min(1, Math.max(0, 0.25 - Math.max(-1, Math.min(1.5, sampleG(x / 400, 11 / 400, z / 400))))), 90);
    const oy = y - u.uTime.value * 0.9;
    rot(x, oy, z); let qx = Q[0], qy = Q[1], qz = Q[2];
    { const o = r - u.uR.value, k = Math.min(1, Math.max(0, (o - 250) / 500)), wD = k * k * (3 - 2 * k); if (wD > 0) d = d + (oct(d, qx + 31, qy, qz + 7, 540, -0.12) - d) * wD; }
    d = oct(d, qx, qy * 1.15, qz, 220, 0); if (lod < 2) return d;
    const steps: Array<[number, number, number, number, number]> = [[17, 3, 11, 85, -0.05], [5, 13, 2, 32, -0.04], [3, 1, 7, 12, -0.02], [1, 9, 4, 4.8, 0.02]];
    for (let i = 0; i < steps.length && i + 2 <= lod; i++) {
      const s = steps[i]; rot(qx, qy, qz); qx = Q[0] + s[0]; qy = Q[1] + s[1]; qz = Q[2] + s[2]; d = oct(d, qx, qy, qz, s[3], s[4]);
      if (i === 0) d = smax(d, u.uR.value - 20 - u.uOv.value * Math.pow(Math.min(1.5, Math.max(0, y / u.uH.value)), 1.3) - r, 40);
    }
    return d;
  };

  return {
    mesh, u,
    get target() { return rt; },
    trace(renderer, cam) {
      renderer.getDrawingBufferSize(size);
      // a fixed pixel budget per quality tier (≈ 0.46 of 1440p at high), never above half res
      // big outputs keep ≥ 0.3 of linear res (4K: 0.75 MP instead of 0.36 — a 5x magnification staircased)
      const npx = Math.max(1, size.x * size.y);
      const k = Math.min(0.5, Math.max(Math.sqrt(budget / npx), Math.min(0.3, Math.sqrt(1.0e6 / npx))));
      const w = Math.max(64, Math.round(size.x * k)), h = Math.max(64, Math.round(size.y * k));
      if (!rt || rt.width !== w || rt.height !== h) {
        rt?.dispose();
        rt = new THREE.WebGLRenderTarget(w, h, TRACE_TARGET);
        rt.textures[1].minFilter = rt.textures[1].magFilter = THREE.NearestFilter;
        cu.uCol.value = rt.textures[0]; cu.uDep.value = rt.textures[1]; cu.uSize.value.set(w, h);
      }
      cam.updateMatrixWorld();
      u.uInvProj.value.copy(cam.projectionMatrixInverse); u.uCamWorld.value.copy(cam.matrixWorld); u.uView.value.copy(cam.matrixWorldInverse);
      u.uCam.value.setFromMatrixPosition(cam.matrixWorld);
      u.uPixAng.value = (cam.fov * Math.PI / 180) / h;
      const prev = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
      renderer.setRenderTarget(rt); renderer.autoClear = false;
      const tq = (globalThis as { __stormTimer?: { q: WebGLQuery[]; ms: number[] } }).__stormTimer;
      if (tqEpoch !== contextEpoch()) { tqEpoch = contextEpoch(); if (tq) tq.q.length = 0; }
      const gl = renderer.getContext() as WebGL2RenderingContext, ext = tq ? gl.getExtension("EXT_disjoint_timer_query_webgl2") : null;
      let q: WebGLQuery | null = null;
      if (tq && ext) { q = gl.createQuery(); if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
      renderer.render(traceScene, orthoCam);
      if (tq && ext && q) {
        gl.endQuery(ext.TIME_ELAPSED_EXT); tq.q.push(q);
        // GPU timer (dev): resolve finished queries → ms
        while (tq.q.length && gl.getQueryParameter(tq.q[0], gl.QUERY_RESULT_AVAILABLE)) { const r = tq.q.shift()!; tq.ms.push(gl.getQueryParameter(r, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(r); }
      }
      renderer.setRenderTarget(prev); renderer.autoClear = prevAuto;
    },
    compile(renderer) {
      const t = new THREE.WebGLRenderTarget(4, 4, TRACE_TARGET), prev = renderer.getRenderTarget();
      renderer.setRenderTarget(t);
      let p: Promise<unknown> = Promise.resolve();
      try { p = renderer.compileAsync(traceScene, orthoCam); } catch (e) { console.warn("[storm] compile", e); }
      renderer.setRenderTarget(prev);
      return p.catch(() => undefined).finally(() => t.dispose());
    },
    sdf,
    dispose() { rt?.dispose(); grid.tex.dispose(); groundTex.dispose(); traceMat.dispose(); compMat.dispose(); tri.dispose(); },
  };
}
