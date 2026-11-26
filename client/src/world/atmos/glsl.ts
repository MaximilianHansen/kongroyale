// Shared GLSL for the atmos area. The sky colour function is used by the sky dome, the env-map bake, the clouds, the
// water's reflections and the aerial-perspective patch injected into every material — so distance haze always matches
// the sky behind it. Uniforms here are SHARED OBJECTS (see AtmosUniforms): update once per frame, every shader sees it.
//
// CONTRACT (other areas call these — keep the signatures):
//   vec3  atmosSky(vec3 dirWorld)            sky radiance (linear, no sun disc) toward a world direction
//   vec3  atmosAerial(vec3 col, vec3 pWorld) colour after haze + height fog for a surface at pWorld seen from the camera
//   float atmosCloudShadow(vec3 pWorld)      1 = lit, <1 under a cloud
import * as THREE from "three";

/** uniforms shared by all atmos shaders; the SAME uniform objects are handed to every patched material */
export interface AtmosUniforms {
  uAtmSunDir: THREE.IUniform<THREE.Vector3>;
  uAtmSunColor: THREE.IUniform<THREE.Color>;
  /** sky gradient table (linear radiance over u = sqrt(elevation / 90°), 128×1 half float) — built from the preset's
   *  DISPLAY stops through the inverse grade (grade.ts skyTable): the sky lands on the target art's measured colours */
  uAtmSkyLUT: THREE.IUniform<THREE.Texture | null>;
  uAtmZenith: THREE.IUniform<THREE.Color>;
  uAtmMid: THREE.IUniform<THREE.Color>;
  uAtmLow: THREE.IUniform<THREE.Color>;
  uAtmHorizon: THREE.IUniform<THREE.Color>;
  uAtmGlowColor: THREE.IUniform<THREE.Color>;
  uAtmGlow: THREE.IUniform<number>;
  /** gaussian radius (radians) of the wide pale sun halo */
  uAtmGlowSize: THREE.IUniform<number>;
  uAtmRays: THREE.IUniform<number>;
  /** how far the sky desaturates inside the sun halo before it whitens */
  uAtmGlowDesat: THREE.IUniform<number>;
  /** warm horizon band toward the sun (dawn) */
  uAtmSunHorizon: THREE.IUniform<THREE.Color>;
  uAtmSunHorizonAmt: THREE.IUniform<number>;
  uAtmGroundHorizon: THREE.IUniform<THREE.Color>;
  uAtmGroundNadir: THREE.IUniform<THREE.Color>;
  uAtmHazeColor: THREE.IUniform<THREE.Color>;
  uAtmHazeDensity: THREE.IUniform<number>;
  /** scale height (m) of the haze: aerial cameras look through thin air, ground cameras through thick */
  uAtmHazeHeight: THREE.IUniform<number>;
  /** extra in-scatter toward the sun (Mie-ish): the backlit distance glows */
  uAtmHazeSun: THREE.IUniform<number>;
  uAtmFogColor: THREE.IUniform<THREE.Color>;
  uAtmFogDensity: THREE.IUniform<number>;
  uAtmFogHeight: THREE.IUniform<number>;
  uAtmCloudShadowMap: THREE.IUniform<THREE.Texture | null>;
  /** xy = world origin of the map (min corner), z = 1/size, w = strength */
  uAtmCloudShadowParams: THREE.IUniform<THREE.Vector4>;
  uAtmCloudDrift: THREE.IUniform<THREE.Vector2>;
  uAtmCamPos: THREE.IUniform<THREE.Vector3>;
  /** low-sun rim / backlight on lit materials (silhouettes glow when looking toward the sun) */
  uAtmRimLight: THREE.IUniform<number>;
  /** sun cascades (shadows.ts): depth bias c0, c1 (NDC, negative = toward the sun); normal offset c0, c1 (m) */
  uAtmSunBias: THREE.IUniform<THREE.Vector4>;
  /** PCF radius (texels) per cascade */
  uAtmSunRadius: THREE.IUniform<THREE.Vector2>;
  /** x = 1 when the TAA resolves the frame (stochastic 2-tap cascade-0 PCF instead of 4 taps), y = frame index */
  uAtmTemporal: THREE.IUniform<THREE.Vector2>;
  /** static far shadow map (whole island, baked once): compare-mode depth texture + world→map matrix */
  uAtmFarMap: THREE.IUniform<THREE.Texture | null>;
  uAtmFarMatrix: THREE.IUniform<THREE.Matrix4>;
  /** x = depth bias (NDC), y = normal offset (m), z = PCF radius (texels), w = 1 once baked */
  uAtmFarParams: THREE.IUniform<THREE.Vector4>;
  uAtmFarSize: THREE.IUniform<THREE.Vector2>;
  /** screen-space AO (post.ts AtmosAOPass), applied INSIDE every patched lit material (a post-multiply
   *  darkened translucent FX with the AO of what is behind them — the "ghost box"): RG = ao, linear view depth of the
   *  frame it was computed from; sampled through that frame's (jittered) view-projection + a depth-aware bilateral */
  uAtmAO: THREE.IUniform<THREE.Texture | null>;
  uAtmAOVP: THREE.IUniform<THREE.Matrix4>;
  /** x, y = AO texture size; z = sample offset (AO texels); w = 0 */
  uAtmAOSize: THREE.IUniform<THREE.Vector4>;
  /** x = on, y = share on DIRECT light (indirect always takes it fully), z = near cut (m, the viewmodel), w = depth tolerance / m */
  uAtmAOParams: THREE.IUniform<THREE.Vector4>;
  /** multi-bounce colour bleeding on WARM albedos (sand, cream, wood, red paint): the shade's fill is tinted by the
   *  surface's own chroma (the sunlit sand around it is what lights it) — neutral concrete and green foliage unchanged */
  uAtmBounce: THREE.IUniform<number>;
  /** canopy sky visibility (shadows.ts bakeCanopy, read by the AO pass): top-down compare-depth map of the vegetation
   *  crowns + world→map matrix; params x = baked, y = fill kept under a closed canopy, z = tap offset (map uv), w = clearance (m) */
  uAtmCanopyMap: THREE.IUniform<THREE.Texture | null>;
  uAtmCanopyMatrix: THREE.IUniform<THREE.Matrix4>;
  uAtmCanopyParams: THREE.IUniform<THREE.Vector4>;
  /** x = strength of the canopy sky visibility on lit materials' fill (0 = off) */
  uAtmSkyVis: THREE.IUniform<number>;
  /** the sun cascade atlas (compare depth) + cascade 1's world→atlas matrix (post.ts light shafts) */
  uAtmCascMap: THREE.IUniform<THREE.Texture | null>;
  uAtmCascMatrix: THREE.IUniform<THREE.Matrix4>;
  /** cascade 0's world→atlas matrix (the shafts' near air: leaf gaps → shafts) */
  uAtmCascMatrix0: THREE.IUniform<THREE.Matrix4>;
  /** sun intensity (the light's scalar; uAtmSunColor is its colour) */
  uAtmSunI: THREE.IUniform<number>;
  /** interior occupancy grid (interior.ts): R8 coverage volume, xyz = world min corner + w = valid, 1 / extent */
  /** the first-person viewmodel's own pass (post.ts renderVM) has no screen-space AO / GI of its
   *  own: x = 1 while it draws → its lit materials take y = AO, z = cloud-shadow transmission, w = interior sky
   *  visibility, all evaluated at the CAMERA (atmos/index.ts vmEnv) — so the gun and hands dim indoors and under a
   *  cloud like the world they are in. x = 0 everywhere else (no effect). */
  uAtmVMEnv: THREE.IUniform<THREE.Vector4>;
  uAtmIntVol: THREE.IUniform<THREE.Texture | null>;
  uAtmIntO: THREE.IUniform<THREE.Vector4>;
  uAtmIntInv: THREE.IUniform<THREE.Vector3>;
  /** 2D top-of-roof heightmap (interior.ts / roof-grid.ts) for rain occlusion: R32F max solid Y per 0.5 m cell;
   *  uAtmRoofO = (minX, minZ, 1 / cellSize, valid) */
  uAtmRoofMap: THREE.IUniform<THREE.Texture | null>;
  uAtmRoofO: THREE.IUniform<THREE.Vector4>;
  /** screen-space GI (the AO pass's 2nd target): rgb = one-bounce irradiance gathered from the last frame, a = the
   *  interior sky visibility; params x = on, y = bounce strength, z = interior fill loss (0..1), w = 0 */
  uAtmGI: THREE.IUniform<THREE.Texture | null>;
  uAtmGIParams: THREE.IUniform<THREE.Vector4>;
  /** rain: material wetness 0..1 (albedo darker, roughness down — more on up-facing surfaces) */
  uAtmWet: THREE.IUniform<number>;
  /** thin wires: drawing-buffer size (px) and x = minimum wire RADIUS in pixels, y = the wires' real radius (m) */
  uAtmRes: THREE.IUniform<THREE.Vector2>;
  uAtmThin: THREE.IUniform<THREE.Vector2>;
  /** the TAA's sub-pixel jitter UNDONE for the first-person viewmodel. xy = the NDC offset the post
   *  adds to the projection this frame, z = near cut (m; vertices closer than this — the viewmodel glued to the lens — are
   *  drawn unjittered, so the resolve can show them without history: no smear / ghost while running), 0 = off */
  uAtmJitter: THREE.IUniform<THREE.Vector4>;
  /** tint on the vegetation's own fill light (veg shaders use their own hemisphere ambient, not the env — dawn / night
   *  grade it through this; midday = white) */
  uAtmVegFill: THREE.IUniform<THREE.Color>;
  /** the vegetation's LIT result graded per preset (meshes + impostors): rgb = multiply (linear), w = saturation.
   *  Night: moonlit blue-teal foliage instead of noon lime; dawn: peach; midday: identity */
  uAtmVegGrade: THREE.IUniform<THREE.Vector4>;
}

export function makeAtmosUniforms(): AtmosUniforms {
  return {
    uAtmSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uAtmSunColor: { value: new THREE.Color(1, 1, 1) },
    uAtmSkyLUT: { value: null },
    uAtmZenith: { value: new THREE.Color() },
    uAtmMid: { value: new THREE.Color() },
    uAtmLow: { value: new THREE.Color() },
    uAtmHorizon: { value: new THREE.Color() },
    uAtmGlowColor: { value: new THREE.Color() },
    uAtmGlow: { value: 1 },
    uAtmGlowSize: { value: 0.25 },
    uAtmRays: { value: 0 },
    uAtmGlowDesat: { value: 0 },
    uAtmSunHorizon: { value: new THREE.Color() },
    uAtmSunHorizonAmt: { value: 0 },
    uAtmGroundHorizon: { value: new THREE.Color() },
    uAtmGroundNadir: { value: new THREE.Color() },
    uAtmHazeColor: { value: new THREE.Color() },
    uAtmHazeDensity: { value: 0 },
    uAtmHazeHeight: { value: 700 },
    uAtmHazeSun: { value: 1 },
    uAtmFogColor: { value: new THREE.Color() },
    uAtmFogDensity: { value: 0 },
    uAtmFogHeight: { value: 50 },
    uAtmCloudShadowMap: { value: null },
    uAtmCloudShadowParams: { value: new THREE.Vector4(-3200, -3200, 1 / 6400, 0) },
    uAtmCloudDrift: { value: new THREE.Vector2() },
    uAtmCamPos: { value: new THREE.Vector3() },
    uAtmRimLight: { value: 0 },
    uAtmSunBias: { value: new THREE.Vector4(-1e-4, -2e-4, 0.05, 0.2) },
    uAtmSunRadius: { value: new THREE.Vector2(1.5, 1.2) },
    uAtmTemporal: { value: new THREE.Vector2(0, 0) },
    uAtmFarMap: { value: null },
    uAtmFarMatrix: { value: new THREE.Matrix4() },
    uAtmFarParams: { value: new THREE.Vector4(-1e-4, 1, 1, 0) },
    uAtmFarSize: { value: new THREE.Vector2(4096, 4096) },
    uAtmAO: { value: null },
    uAtmAOVP: { value: new THREE.Matrix4() },
    uAtmAOSize: { value: new THREE.Vector4(1, 1, 0.25, 0) },
    uAtmAOParams: { value: new THREE.Vector4(0, 0.75, 0.3, 0.025) },
    uAtmBounce: { value: 0 },
    uAtmCanopyMap: { value: null },
    uAtmCanopyMatrix: { value: new THREE.Matrix4() },
    uAtmCanopyParams: { value: new THREE.Vector4(0, 0.5, 0.002, 2.5) },
    uAtmSkyVis: { value: 1 },
    uAtmCascMap: { value: null },
    uAtmCascMatrix: { value: new THREE.Matrix4() },
    uAtmCascMatrix0: { value: new THREE.Matrix4() },
    uAtmSunI: { value: 1 },
    uAtmVMEnv: { value: new THREE.Vector4(0, 1, 1, 1) },
    uAtmIntVol: { value: null },
    uAtmIntO: { value: new THREE.Vector4(0, 0, 0, 0) },
    uAtmIntInv: { value: new THREE.Vector3(1, 1, 1) },
    uAtmRoofMap: { value: null },
    uAtmRoofO: { value: new THREE.Vector4(0, 0, 0, 0) },
    uAtmGI: { value: null },
    uAtmGIParams: { value: new THREE.Vector4(0, 0, 0, 0) },
    uAtmWet: { value: 0 },
    uAtmRes: { value: new THREE.Vector2(2560, 1440) },
    uAtmThin: { value: new THREE.Vector2(0.85, 0.05) },
    uAtmJitter: { value: new THREE.Vector4(0, 0, 0, 0) },
    uAtmVegFill: { value: new THREE.Color(1, 1, 1) },
    uAtmVegGrade: { value: new THREE.Vector4(1, 1, 1, 1) },
  };
}

/** declarations: sky + haze + cloud-shadow uniforms and functions (fragment stage) */
export const ATMOS_PARS = /* glsl */ `
uniform vec3 uAtmSunDir;
uniform vec3 uAtmSunColor;
uniform sampler2D uAtmSkyLUT;
uniform vec3 uAtmZenith, uAtmMid, uAtmLow, uAtmHorizon, uAtmGlowColor, uAtmSunHorizon;
uniform float uAtmGlow, uAtmGlowSize, uAtmRays, uAtmSunHorizonAmt, uAtmGlowDesat;
uniform vec3 uAtmGroundHorizon, uAtmGroundNadir;
uniform vec3 uAtmHazeColor;
uniform float uAtmHazeDensity, uAtmHazeHeight, uAtmHazeSun;
uniform vec3 uAtmFogColor;
uniform float uAtmFogDensity, uAtmFogHeight;
uniform sampler2D uAtmCloudShadowMap;
uniform vec4 uAtmCloudShadowParams;
uniform vec2 uAtmCloudDrift;
uniform vec3 uAtmCamPos;
uniform float uAtmRimLight;
uniform vec4 uAtmVegGrade;
uniform float uAtmWet;

// sun shafts: 3 soft, uneven, BROAD beams at fixed irregular angles around the sun (the beach target art's crepuscular
// streaks) — no thin symmetric spokes (they read as a clip-art starburst / a lens streak at dawn)
float atmosRays(vec3 d, float ang) {
  if (ang > 0.9) return 0.0; // nothing beyond ~50° from the sun (the sky there keeps its measured stops)
  vec3 T = normalize(cross(uAtmSunDir, vec3(0.0, 1.0, 0.0001)));
  vec3 B = cross(T, uAtmSunDir);
  float phi = atan(dot(d, B), dot(d, T));
  float r = 0.0;
  // (angle, width, strength): one dominant shaft down-left, two fainter ones
  vec3 sh[3] = vec3[3](vec3(-2.25, 0.16, 1.0), vec3(-1.35, 0.09, 0.45), vec3(0.95, 0.12, 0.3));
  for (int i = 0; i < 3; i++) {
    float dp = abs(mod(phi - sh[i].x + 3.14159265, 6.2831853) - 3.14159265);
    float w = sh[i].y * (1.0 + ang * 1.2);            // shafts widen with distance from the sun (soft, not lines)
    r += sh[i].z * exp(-dp * dp / (w * w));
  }
  return r * exp(-ang / 0.3) * smoothstep(0.015, 0.09, ang) * smoothstep(0.9, 0.6, ang);
}

// the sky gradient alone (no sun): the elevation table + the warm band toward the sun (dawn)
vec3 atmosSkyGradient(vec3 d) {
  float y = clamp(d.y, 0.0, 1.0);
  float e = asin(y) * 0.63661977; // 0..1 over 0..90°
  vec3 c = texture2D(uAtmSkyLUT, vec2(sqrt(e) * (127.0 / 128.0) + 0.5 / 128.0, 0.5)).rgb;
  vec2 hz = normalize(d.xz + 1e-5), sz = normalize(uAtmSunDir.xz + 1e-5);
  float toward = max(dot(hz, sz), 0.0);
  c = mix(c, uAtmSunHorizon, uAtmSunHorizonAmt * pow(toward, 3.0) * (1.0 - smoothstep(0.0, 0.35, y)));
  return c;
}

// the sky just above the horizon toward d (uniforms only — no table fetch: every patched material calls this through
// atmosAerial, and some already use most of their texture units)
vec3 atmosHorizonSky(vec3 d) {
  vec2 hz = normalize(d.xz + 1e-5), sz = normalize(uAtmSunDir.xz + 1e-5);
  vec3 c = mix(uAtmHorizon, uAtmSunHorizon, uAtmSunHorizonAmt * pow(max(dot(hz, sz), 0.0), 3.0));
  // haze in-scatter never brighter than ~white (a bright horizon stop must not wash distant land to cream)
  return c / max(1.0, max(c.r, max(c.g, c.b)));
}

// sky radiance (no sun disc) for a world direction d
vec3 atmosSky(vec3 d) {
  vec3 c = atmosSkyGradient(d);
  float mu = clamp(dot(d, uAtmSunDir), -1.0, 1.0);
  float ang = acos(mu);
  // around the sun the sky WHITENS toward a cyan-white (never violet) — a Gaussian of the angle, σ = uAtmGlowSize: the beach
  // target art's profile is white-hot to ~4°, L* .75 at 8°, .61 at 12°, back to the base blue by ~16° (σ ≈ 7.7°) — then
  // a hot HDR core that blooms. (A ~30° plateau turned the whole sun side of the sky milky.)
  float an = ang / max(uAtmGlowSize, 1e-3);
  float wide = exp(-0.5 * an * an);
  float wg = clamp(wide * uAtmGlow * 0.92, 0.0, 1.0);
  // the sky desaturates toward the sun before it whitens (a linear mix of the deep blue with white kept the blue
  // channel hot → a periwinkle halo #7ca8ee vs the target art's grey-cyan #87b1d5)
  c = mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), wg * uAtmGlowDesat);
  c = mix(c, uAtmGlowColor * (1.0 + 0.5 * exp(-ang / 0.1)), wg);
  c += uAtmGlowColor * (exp(-ang / 0.05) * 0.8 + exp(-ang / 0.016) * 2.4) * uAtmGlow;
  c += uAtmGlowColor * atmosRays(d, ang) * uAtmRays * smoothstep(-0.05, 0.02, d.y);
  // below the horizon (env map only): warm ground bounce
  float g = smoothstep(0.0, -0.3, d.y);
  vec3 ground = mix(uAtmGroundHorizon, uAtmGroundNadir, smoothstep(-0.05, -0.8, d.y));
  return mix(c, ground, g);
}

// aerial perspective: colour after haze + height fog for a surface at world p seen from uAtmCamPos (linear space)
vec3 atmosAerial(vec3 col, vec3 p) {
  vec3 dv = p - uAtmCamPos;
  float dist = length(dv);
  vec3 dir = dv / max(dist, 1e-3);
  // haze: an exponential-height atmosphere integrated along the ray (thin looking down from a plane, thick along
  // the ground), in-scatter = the sky's horizon colour in that direction, stronger toward the sun
  float H = max(uAtmHazeHeight, 1.0);
  float e0 = exp(-max(uAtmCamPos.y, 0.0) / H);
  float od = abs(dv.y) < 0.5 ? dist * e0 : dist * H * (e0 - exp(-max(p.y, 0.0) / H)) / dv.y;
  // no haze over gameplay distances (the target art is razor clear to ~500 m), then a ramp: the first ~250 m of optical
  // depth are free (the volcano at ~1 km should shift 20–30 % toward the horizon colour)
  od = max(od - 250.0 * e0, 0.0);
  // looking steeply DOWN (the aerial master shot, 45° and more) the view is crisp like the target art's island shot;
  // (without haze the harbor at ~1 km seen from a 400 m drop has the foreground's saturation — no depth cue): shallow
  // downward rays (the drop, a hilltop looking out) keep their haze
  od *= 1.0 - smoothstep(0.35, 0.65, -dir.y);
  float sunward = pow(max(dot(dir, uAtmSunDir), 0.0), 6.0);
  float haze = 1.0 - exp(-od * uAtmHazeDensity * (1.0 + uAtmHazeSun * sunward));
  vec3 hazeCol = mix(atmosHorizonSky(dir), uAtmHazeColor, 0.15) + uAtmGlowColor * sunward * 0.35 * uAtmGlow;
  // height fog hugging the water: analytic integral of exp(-h/Hf) along the ray, broken into drifting mist BANKS
  // (dawn; fog density is 0 at midday)
  float Hf = max(uAtmFogHeight, 1.0);
  float fogInt = abs(dv.y) < 0.05 ? dist * exp(-uAtmCamPos.y / Hf) : dist * Hf * (exp(-uAtmCamPos.y / Hf) - exp(-p.y / Hf)) / dv.y;
  fogInt = max(fogInt - 180.0 * exp(-max(uAtmCamPos.y, 0.0) / Hf), 0.0); // the foreground stays crisp; mist lies further out
  float bands = 0.35 + 0.65 * smoothstep(-0.3, 0.7, sin(p.x * 0.0105 + 1.3 * sin(p.z * 0.0071)) * sin(p.z * 0.0093 + 0.8 * sin(p.x * 0.0057) + 1.7));
  float fog = 1.0 - exp(-max(fogInt, 0.0) * uAtmFogDensity * bands);
  vec3 fogCol = mix(uAtmFogColor, uAtmGlowColor, sunward * 0.6);
  col = mix(col, hazeCol, clamp(haze, 0.0, 1.0));
  col = mix(col, fogCol, clamp(fog, 0.0, 1.0));
  return col;
}

// cloud shadow transmission (1 = lit) at world position p. The tile holds the shadows projected onto y = 0, so a
// point at height h looks up where the sun ray through it meets y = 0 (hills get their shadow in the right place);
// nothing above the cloud layer is shadowed (the jump plane, skydivers).
float atmosCloudShadow(vec3 p) {
  if (uAtmCloudShadowParams.w <= 0.0) return 1.0; // no casting puffs in view (camera below the puff layer)
  vec2 q = p.xz - uAtmSunDir.xz / max(uAtmSunDir.y, 0.05) * p.y;
  vec2 uv = (q - uAtmCloudDrift - uAtmCloudShadowParams.xy) * uAtmCloudShadowParams.z;
  float t = texture2D(uAtmCloudShadowMap, uv).r;
  return mix(1.0, t, uAtmCloudShadowParams.w * (1.0 - smoothstep(380.0, 520.0, p.y)));
}
`;

/** screen-space terms for lit materials (fragment), from the AO pass (post.ts): R = AO, G = linear view depth of the
 *  frame they were computed in, B = CLOUD-SHADOW transmission of that pixel (evaluated in the AO pass from its world
 *  position — the cloud-shadow tile costs the materials no sampler: the terrain sits at the 16-unit limit), A = SKY
 *  VISIBILITY under the vegetation canopy. Reprojected through that frame's view-projection; the AO takes a 4-tap
 *  bilinear weighted by depth agreement — no matching tap (silhouettes, disocclusion, translucent layers, the viewmodel)
 *  → 1.0, never a halo borrowed from the surface behind (no 4x4 stair-step halos); the smooth cloud / sky terms
 *  take the plain bilinear. Evaluated once per fragment. atmosSS3() = (ao, cloud, sky); atmosSS() = (ao, cloud) (compat).
 *  Alpha-tested double-sided cards (foliage): no AO (perf: the 4-tap fallback fired on every leaf edge × overdraw) —
 *  one bilinear fetch for the cloud / sky terms. */
export const ATMOS_AO_PARS = /* glsl */ `
uniform highp sampler2D uAtmAO;
uniform mat4 uAtmAOVP;
uniform vec4 uAtmAOSize;
uniform vec4 uAtmAOParams;
uniform highp sampler2D uAtmGI;
uniform vec4 uAtmGIParams;
uniform vec4 uAtmVMEnv;
vec3 atmSSv = vec3( -1.0 );
// rgb = one-bounce GI irradiance, a = interior sky visibility (the AO pass's 2nd target, same texel as the AO)
vec4 atmGIv = vec4( 0.0, 0.0, 0.0, 1.0 );
vec3 atmosSS3( vec3 wp ) {
  if ( atmSSv.x >= 0.0 ) return atmSSv;
  atmSSv = vec3( 1.0 );
  if ( uAtmAOParams.x < 0.5 ) {
    // the viewmodel's own pass: the camera's environment (uniforms only — no extra sampler)
    if ( uAtmVMEnv.x > 0.5 ) { atmSSv = vec3( uAtmVMEnv.y, uAtmVMEnv.z, 1.0 ); if ( uAtmGIParams.x > 0.5 ) atmGIv = vec4( 0.0, 0.0, 0.0, uAtmVMEnv.w ); }
    return atmSSv;
  }
  vec4 pc = uAtmAOVP * vec4( wp, 1.0 );
  float z = pc.w;
  if ( z < uAtmAOParams.z ) return atmSSv;
  vec2 uv = pc.xy / z * 0.5 + 0.5;
  if ( any( lessThan( uv, vec2( 0.0 ) ) ) || any( greaterThan( uv, vec2( 1.0 ) ) ) ) return atmSSv;
  float tol = uAtmAOParams.w * z + 0.03;
  vec2 hp = uv * uAtmAOSize.xy + uAtmAOSize.z;
  // interior pixels (the common case): one bilinear fetch whose depth agrees
  vec4 q = texture2D( uAtmAO, hp / uAtmAOSize.xy );
  atmSSv.yz = q.zw;
  if ( uAtmGIParams.x > 0.5 ) atmGIv = texture2D( uAtmGI, hp / uAtmAOSize.xy );
#if defined( DOUBLE_SIDED ) && defined( USE_ALPHATEST )
  return atmSSv;
#else
  if ( abs( q.y - z ) < tol * 0.35 ) { atmSSv.x = q.x; return atmSSv; }
  vec2 b = floor( hp - 0.5 ), f = hp - 0.5 - b;
  ivec2 i0 = ivec2( b ), mx = ivec2( uAtmAOSize.xy ) - 1;
  vec2 s00 = texelFetch( uAtmAO, clamp( i0, ivec2( 0 ), mx ), 0 ).rg;
  vec2 s10 = texelFetch( uAtmAO, clamp( i0 + ivec2( 1, 0 ), ivec2( 0 ), mx ), 0 ).rg;
  vec2 s01 = texelFetch( uAtmAO, clamp( i0 + ivec2( 0, 1 ), ivec2( 0 ), mx ), 0 ).rg;
  vec2 s11 = texelFetch( uAtmAO, clamp( i0 + ivec2( 1, 1 ), ivec2( 0 ), mx ), 0 ).rg;
  vec4 w = vec4( ( 1.0 - f.x ) * ( 1.0 - f.y ), f.x * ( 1.0 - f.y ), ( 1.0 - f.x ) * f.y, f.x * f.y ) + 0.02;
  w *= max( vec4( 0.0 ), 1.0 - abs( vec4( s00.y, s10.y, s01.y, s11.y ) - z ) / tol );
  float ws = dot( w, vec4( 1.0 ) );
  atmSSv.x = ws < 1e-3 ? 1.0 : dot( w, vec4( s00.x, s10.x, s01.x, s11.x ) ) / ws;
  if ( uAtmGIParams.x > 0.5 ) {
    // the GI / interior terms of the taps whose depth agrees (a silhouette never borrows the other surface's bounce)
    atmGIv = ws < 1e-3 ? vec4( 0.0, 0.0, 0.0, atmGIv.a ) : ( w.x * texelFetch( uAtmGI, clamp( i0, ivec2( 0 ), mx ), 0 ) + w.y * texelFetch( uAtmGI, clamp( i0 + ivec2( 1, 0 ), ivec2( 0 ), mx ), 0 )
      + w.z * texelFetch( uAtmGI, clamp( i0 + ivec2( 0, 1 ), ivec2( 0 ), mx ), 0 ) + w.w * texelFetch( uAtmGI, clamp( i0 + ivec2( 1, 1 ), ivec2( 0 ), mx ), 0 ) ) / ws;
  }
  return atmSSv;
#endif
}
vec2 atmosSS( vec3 wp ) { return atmosSS3( wp ).xy; }
`;
