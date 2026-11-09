// The water surface in THREE draws of the same clipmap (no framebuffer copy between them — on a tile-based GPU a
// mid-pass scene grab breaks the render pass, ~0.5 ms by itself, measured on an M5-class GPU):
//
//   0. PRE-PASS (depth only)  — the nearest water surface per pixel (so the two blended passes below touch each pixel
//                               once, even where a swell crest hides the trough behind it)
//   1. MULTIPLY  (dst *= M)   — what the water does to the scene behind it: per-channel transmission down to the floor
//                               and up to the eye (red dies first → cream sand turns glowing turquoise), the crisp
//                               caustic net, the reef's coral heads, the wet-sand tint of the swash film, × (1 − fresnel)
//   2. ADD / OVER (premultiplied: dst = src + dst·(1 − foam))  — MeshPhysicalMaterial-based: in-scatter (depth-keyed
//                               ramp × actual sun/sky light, shadowed), fresnel sky reflection, layered foam (swash edge,
//                               uprush bore, run-up lace, backwash streaks, a second broken breaker line, surf crests,
//                               rock/cliff fringe, waterline rings at hulls/walls/piles/rocks/containers, splashes), sun
//                               glitter + HDR sparkles, crest translucency, atmos haze on the water's own light only
//
// PERF (≤ 0.8 ms budget): expensive groups run behind coherent branches — caustics within ~95 m, fine ripple layers
// within ~140 m, the foam stack only where foam is possible. Fetches inside branches use textureGrad/textureLod with
// gradients taken in uniform control flow. Every tuning knob is a `wtr*` uniform (see material.ts).
import { WAVES, wavesGLSL } from "./waves";
import { TILE, TILE_SLOPE_RANGE } from "./wavetile";

const T = TILE.toFixed(3);
const SR = TILE_SLOPE_RANGE.toFixed(3);
/** the primary swell's travel direction (the rings' windward side faces -WD0) */
const WD0 = WAVES[0].dir.map((v) => v.toFixed(4)).join(", ");

/** shared by every stage of every pass: fields, swell damping, max run-up, swash + surf timing */
const COMMON = /* glsl */ `
uniform float wtrTime;
uniform sampler2D wtrField;
uniform sampler2D wtrField2;
uniform sampler2D wtrField3;      // RGBA: shore-smoothed height, its slope, the smooth shore normal xz
uniform vec2 wtrFieldST;
uniform float wtrWaveAmp;
uniform float wtrRunupH;
uniform float wtrRunupDist;
uniform float wtrPeriod;
uniform float wtrSurfLen;
uniform float wtrBreakDepth;
uniform float wtrSurf;
uniform float wtrBreakH;          // breaker crest height (m) in the surf zone
uniform float wtrWetW;            // the wet-sand band landward of the highest recent run-up (m of sand)
uniform float wtrDryTau;          // wet sand dries with this e-folding time (s) once the swash leaves it
uniform sampler2D wtrSim;         // interactive ripples (h, h_prev, foam)
uniform sampler2D wtrObstacle;    // auto-baked waterline proximity + registered foam shapes
uniform float wtrObstacleScale;
uniform vec3 wtrSimST;            // window min corner xz, 1/size
uniform float wtrSimOn;
uniform vec3 wtrMurkP;                   // THE MURK: x, z, radius
uniform vec4 wtrHarborP;                 // peel-harbor basin ellipse: cx, cz, 1/rx, 1/rz
uniform vec3 wtrLagoonP;                 // THE WRECK's emerald lagoon: x, z, radius
uniform vec4 wtrLagoon2P;                // WRECK BAY's cove: x, z, radius, strength
varying vec3 vMask;                      // (murk × calm, harbor, wreck lagoon) — smooth analytic masks, per vertex

// field2.b packs calm (lagoon water, < 0.5) and coral heads (> 0.5) — see fields.ts
float wtrCalm(float b) { return clamp(1.0 - 2.0 * b, 0.0, 1.0); }
float wtrCoralF(float b) { return clamp(2.0 * b - 1.0, 0.0, 1.0); }
float wtrSwellAmp(float depth, float calm) { return mix(0.05, 1.0, smoothstep(-0.2, 12.0, depth)) * mix(1.0, 0.12, calm); }
// the highest the swash reaches (m above sea level) at a point: an envelope around the static waterline, bounded so
// the run-up DISTANCE stays ≤ wtrRunupDist on any slope (flat tidal flats must not flood)
float wtrMaxLift(float shoreD, float slope, float calm) {
  float near = exp(-abs(shoreD) / 7.0);
  return min(wtrRunupH * near * (1.0 - calm * 0.85), 0.006 + max(slope, 0.0) * wtrRunupDist);
}
// coast-varying phase so the swash is never in lock-step along a beach
float wtrCoastPhase(vec2 xz) { return sin(xz.x * 0.013 + xz.y * 0.009) * 0.35 + sin(xz.x * 0.0051 - xz.y * 0.0077) * 0.55 + sin(xz.y * 0.021 + 1.3) * 0.12; }
// ψ: position in the wave cycle at the waterline (0 = a bore arrives)
float wtrPsi(vec2 xz, float t) { return fract(t / wtrPeriod + wtrCoastPhase(xz)); }
// run-up level 0..1: quick rise as the bore arrives, slow drain (peaks at 80 % of the max lift: the top of the run-up
// zone is always a band of wet, glossy sand)
// (starts from the drained level 0.08 — continuous across the cycle wrap)
float wtrRunCurve(float psi) { return (psi < 0.18 ? mix(0.08, 1.0, smoothstep(0.0, 0.18, psi)) : 1.0 - smoothstep(0.18, 0.92, psi) * 0.92) * 0.8; }
// surf crest phase u in [0,1): crests travel shoreward; u≈0 just behind a crest, u→1 just before the next
float wtrSurfU(float shoreD, float psi) { return fract(psi + shoreD / wtrSurfLen); }
// breaker profile over the surf phase u (0..1, 1 ≡ 0 = the crest), its slope d/du, and each wave's own height
float wtrRidge(float u) { return smoothstep(0.88, 0.995, u) + 1.0 - smoothstep(0.0, 0.32, u); }
float wtrRidgeDu(float u) {
  float a = clamp((u - 0.88) / 0.115, 0.0, 1.0), b = clamp(u / 0.32, 0.0, 1.0);
  return 6.0 * a * (1.0 - a) / 0.115 - 6.0 * b * (1.0 - b) / 0.32;
}
// (sin-free 1D hash — perf: the surf zone ran ~7 sin-hashes per pixel)
float wtrH1(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float wtrSetAmp(float crestId) { return 0.45 + 0.55 * wtrH1(crestId + 4.1); }
// the DRAWN terrain height at xz: field.r holds the terrain's 2 m samples at texel centres; interpolated with
// Terrain.height()'s own diagonal rule (even global cell parity: (i,j)–(i+1,j+1), odd: (i,j+1)–(i+1,j)) it is the
// triangle the terrain draws within ~80 m (terrain lod.ts NEAR_FULL) — the bilinear field sat up to ~10 cm off it
float wtrTerrH(vec2 xz) {
  vec2 f = (xz * wtrFieldST.x + wtrFieldST.y) * vec2(textureSize(wtrField, 0)) - 0.5;
  vec2 c = floor(f); vec2 t = f - c; ivec2 ci = ivec2(c);
  float h00 = texelFetch(wtrField, ci, 0).r, h01 = texelFetch(wtrField, ci + ivec2(1, 0), 0).r;
  float h10 = texelFetch(wtrField, ci + ivec2(0, 1), 0).r, h11 = texelFetch(wtrField, ci + ivec2(1, 1), 0).r;
  if (((ci.x + ci.y) & 1) == 0) return t.x >= t.y ? h00 + (h01 - h00) * t.x + (h11 - h01) * t.y : h00 + (h10 - h00) * t.y + (h11 - h10) * t.x;
  return t.x + t.y <= 1.0 ? h00 + (h01 - h00) * t.x + (h10 - h00) * t.y : h11 + (h10 - h11) * (1.0 - t.x) + (h01 - h11) * (1.0 - t.y);
}

// ---- THE WATER COLUMN (both stages: per VERTEX on the near clipmap levels, per pixel elsewhere — see wtrColumn)
uniform vec3 wtrAbsorb;
uniform vec3 wtrMurkAbsorb;
uniform float wtrHarborAbsorb;
uniform float wtrLagoonAmt;
uniform float wtrClarity;
uniform float wtrFresnelMax;
uniform float wtrFresnelFar;
uniform float wtrFresnelGraze;
uniform float wtrFresMidDip;
uniform float wtrScatterK;
uniform float wtrScatHide;
uniform float wtrGrazeCap;
uniform float wtrPathCol;
uniform vec3 wtrRamp0;   // in-scatter albedo at 0.5 m
uniform vec3 wtrRamp1;   // 2 m
uniform vec3 wtrRamp2;   // 5 m
uniform vec3 wtrRamp3;   // 12 m
uniform vec3 wtrRamp4;   // 30 m +
uniform vec3 wtrEyeDeep; // the deep blue at the end of a long path across the water (eye level)
uniform vec3 wtrCoastTq; // the bright cyan off steep coasts
uniform float wtrCoastAmt;
uniform vec3 wtrReefTq;  // the reef flat seen from ABOVE: the aerial target art's wide bright turquoise-cyan band (2-14 m)
uniform vec3 wtrMurkCol;
uniform vec3 wtrHarborCol;
uniform float wtrHarborAmt;
uniform vec3 wtrLagoonCol;
uniform vec3 wtrCalmCol;
uniform float wtrCalmAmt;
vec3 wtrRampAt(float d) {
  vec3 c = mix(wtrRamp0, wtrRamp1, smoothstep(0.5, 2.0, d));
  c = mix(c, wtrRamp2, smoothstep(2.0, 5.0, d));
  c = mix(c, wtrRamp3, smoothstep(5.0, 12.0, d));
  return mix(c, wtrRamp4, smoothstep(12.0, 30.0, d));
}
// the fresnel cap (stylised: the far sea keeps its deep blue body instead of mirroring the pale horizon; only the
// shallows right at the camera's feet stay see-through). Looking ACROSS the water (a swimmer, the eye-level mid distance)
// the cap opens toward a real grazing fresnel: the sky covers the floor instead of the seabed showing through as glass.
// (a grazing cap of 0.8 mirrored the pale horizon over the whole mid/far sea — pale aqua #7cc3dd instead of the
// target art's saturated blue. The swimmer's glare stays for the first ~30 m; beyond, the sea keeps its body colour and
// reflects at most wtrFresnelFar of the saturated upper sky)
float wtrFresCap(float dCol, float dist, float farMix, float Vy, float hb) {
  // (the sand shallows keep a low cap out to ~100 m at eye level — the target art's 1-3 m shelf glows turquoise with
  // its white net all the way out; the pale sky sheen turned it blue-grey and streaky)
  float shallowNear = (1.0 - smoothstep(2.0, 6.0, dCol)) * (1.0 - smoothstep(35.0, 110.0, dist));
  float graze = (1.0 - smoothstep(0.02, 0.1, Vy)) * smoothstep(3.0, 9.0, dist) * (1.0 - smoothstep(25.0, 60.0, dist));
  float farK = max(farMix, smoothstep(20.0, 90.0, dist) * (1.0 - smoothstep(0.1, 0.4, Vy)));
  // (at eye level the MID sea — 10-150 m out — reads as the target art's darker deep blue under a weaker sheen, the
  // horizon band lighter: without this dip the cap flattened the fresnel gradient into one bright cyan-blue plane)
  float midK = smoothstep(8.0, 25.0, dist) * (1.0 - smoothstep(70.0, 220.0, dist)) * (1.0 - smoothstep(0.15, 0.4, Vy)) * (1.0 - farMix) * (1.0 - hb);
  return mix(mix(wtrFresnelMax, wtrFresnelFar, farK), wtrFresnelGraze, graze) * mix(1.0, 0.45, shallowNear) * (1.0 - wtrFresMidDip * midK);
}
// THE WATER COLUMN. Stylised clarity (the target art's glass-clear shallows): looking DOWN into the water the path is
// capped at ~2× the depth (physically ~4-10×), opening up to ~7× by 12 m. Looking ACROSS it (eye level, > ~10 m away)
// the cap opens to wtrGrazeCap × the depth: the sea closes into a solid turquoise → blue body with the sky on it — the
// seabed relief (reef ledges, shelf cliffs) never shows through 30-150 m of water as glass jelly.
//   dF = water depth under the surface, feat = the ~12 m-feathered depth / 40 (field2.a), dT = terrain depth below sea
//   level, msk = (murk, harbor basin, wreck lagoon), obst = the waterline proximity of objects piercing the surface.
//   Out: floor transmission (down + up, × the in-scatter's cover), in-scatter build-up, in-scatter albedo (ramp), the
//   view path, the colour depth, the path-colour depth, the fresnel cap.
// PERF: evaluated per VERTEX on clipmap levels 0-1 (1-2 m cells ≥ the field's 2 m texels: hundreds of pixels per
// vertex at eye level); per pixel on the far levels, the aerial and next to objects
void wtrColumn(float dF, float feat, float dT, vec3 V, float dist, float farMix, vec3 msk, float calm, float obst,
               out vec3 Tfloor, out float scat, out vec3 ramp, out float thick, out float dCol, out float pathD, out float fCap) {
  float murk = msk.x, harbor = msk.y, lagoon = msk.z;
  // the column the colour sees: never shallower than ~85 % of the ~12 m-feathered depth, so a reef top next to a deep
  // drop-off (or a dredged channel) darkens gradually over ~10 m instead of a hard, LOD-jagged step (never at the
  // waterline: its soft edge stays)
  float dFs = max(dF, feat * 34.0 * smoothstep(1.2, 3.5, dF));
  float grazeK = (1.0 - smoothstep(0.08, 0.36, V.y)) * smoothstep(6.0, 34.0, dist);
  float capK = mix(mix(2.0, 7.0, smoothstep(3.0, 12.0, dFs)), wtrGrazeCap, grazeK) * wtrClarity;
  thick = min(dFs / max(V.y, 0.02), dFs * capK);
  // the submerged part of an object standing in deep water (a sea stack's shaft, a hull, a quay wall) sits right under
  // the surface: the terrain depth says "8 m of water", the eye sees the object through a few centimetres → a pale, lit
  // column printed through the sea as a white outline from the air. Near such objects the column reads as deep water
  // (containers on the sand shallows keep their tinted, visible halves: only where the floor is > ~1.5 m down)
  // (only in deep water — in the 1-3 m shallows it printed a dark-blue square around every palm trunk, post and
  // floating crate)
  thick = max(thick, 9.0 * smoothstep(0.3, 0.85, obst) * smoothstep(3.0, 6.0, dF));
  // per-channel transmission; glass-clear to ~3 m, then the water "closes" (the target art's bright ring is narrow, the
  // reef flat and the harbor basin read rich teal/blue, not lit sand) — less near the camera, where the target art's
  // shallows stay see-through. Right at hulls / walls / containers the water is shaded by the object (the dark water
  // under the ship's hull; submerged container halves read tinted + darker)
  float closeK = smoothstep(2.5, 7.0, dFs) * mix(0.5, 1.0, smoothstep(35.0, 220.0, dist));
  // far water seen at a grazing angle (eye level) shows its colour, not the (coarse-LOD, faceted) seabed
  float grazeFar = smoothstep(16.0, 160.0, dist) * (1.0 - smoothstep(0.08, 0.3, V.y));
  // THE MURK's tea-green only where the water has some depth; tidal puddles on the calm flats stay clear, glossy water
  // (only the first ~0.3 m — otherwise the NE lagoon's shallow rim glowed cyan over its pale sand)
  float puddle = calm * (1.0 - smoothstep(0.06, 0.3, feat * 40.0));
  float murkD = murk * smoothstep(0.0, 0.1, dF);
  // calm lagoon / mangrove water (the NE lagoon, stilt town): tannin-stained, murkier dark teal — otherwise it read as a
  // bleached-mint pool with a glowing cyan rim (glass-clear shallows over pale sand); target art: #42757b, hue 185
  float calmD = calm * wtrCalmAmt * smoothstep(0.03, 0.4, dF) * (1.0 - puddle) * (1.0 - murkD);
  // (THE WRECK's lagoon: BLUE dies fastest after red — cream sand turns emerald-green (hue ~145), not turquoise; without it
  // the lagoon read mint #hue 165 V .93 vs the target art's emerald-teal hue 142 V .66. Objects standing in the
  // shallows shade the water next to them: their submerged halves read tinted + darker, never pale smears)
  // (only over the lagoon's sand shallows: over deeper water the boost read as a dark olive halo from the air)
  float lagS = lagoon * wtrLagoonAmt * (1.0 - smoothstep(2.5, 6.0, dF));
  vec3 sig = (mix(wtrAbsorb, wtrMurkAbsorb, murkD) + calmD * vec3(0.9, 0.5, 0.42)) * (1.0 + harbor * wtrHarborAbsorb) * (1.0 + lagS * vec3(2.4, 2.2, 7.0))
           * (1.0 + 0.8 * closeK) * (1.0 + mix(0.35, 0.8, smoothstep(1.2, 3.5, dF)) * smoothstep(0.35, 0.8, obst)) * (1.0 + 2.5 * grazeFar);
  // in-scatter build-up along the path: the water's own turquoise glow covers the floor as it builds
  // (the fast build-up (wtrScatterK 1.0) is for the first ~2 m of depth — the cyan shallows; deeper (Stilt Town's
  //  3-6 m lagoon, the reef flat) it slows to ~0.25 so the seabed still reads through instead of a flat opaque cyan)
  float kS = wtrScatterK * mix(1.0, 0.25, smoothstep(1.5, 4.0, dFs)) * mix(1.0, 0.4, calm);
  // (THE MURK's build-up is an absolute 1.8 /m, not a multiple of wtrScatterK: with wtrScatterK 1.0 a 14× multiple
  //  closes the tea into an opaque mud-brown slab within centimetres)
  scat = (1.0 - exp(-mix(kS * (1.0 + 2.5 * grazeFar + 3.0 * calmD), 1.8, murkD) * thick)) * (1.0 - 0.8 * puddle * (1.0 - murkD));
  // Physical depth controls shallow onset: a long grazing view path cannot paint ankle water opaque.
  // The deliberately tannin-rich Murk keeps its own scattering profile.
  scat *= mix(smoothstep(0.04,1.5,max(dT,0.0)),1.0,murkD);
  Tfloor = exp(-sig * (1.0 - 0.8 * puddle * (1.0 - murkD)) * (thick + dFs * 0.6)) * (1.0 - wtrScatHide * scat);
  // colour depth: the (feathered) terrain depth; the harbor basin feathers fully (its dredged edges never draw rectangles
  // from the air)
  dCol = mix(dFs, feat * 40.0, max(mix(0.45, 0.9, harbor), 0.85 * smoothstep(250.0, 900.0, dist)) * smoothstep(3.0, 8.0, dFs));
  // colour by PATH across the water: looking across it (eye level) the light the eye gets has travelled far through the
  // water, whatever the depth — the sea turns from the glowing turquoise at the feet to aqua-blue at ~25 m and deep blue
  // beyond ~60 m (the beach target art), smoothly, never by the seabed's steps; looking down (the aerial) it is the depth
  float gkC = (1.0 - smoothstep(0.1, 0.5, V.y)) * smoothstep(4.0, 18.0, dist);
  // (not in THE WRECK's lagoon — 0-4 m of sand shallows sheltered by the reef: the target art's lagoon glows emerald-
  // turquoise all the way to the hulls; the eye-level path colour turned its far half dark teal-blue)
  pathD = min(thick * wtrPathCol, 40.0) * gkC * (1.0 - 0.85 * lagoon);
  // (the path colour is BOUNDED by the depth — a long path across a 1-3 m sand shelf stays glowing turquoise-cyan (the
  // target art's mid shallows #52c5c4, 50-150 m out); only deep water turns sapphire. Sending every grazing path > 20 m
  // to the eye-level deep blue made the whole shelf read dark azure)
  dCol = max(dCol, min(pathD, 0.3 + dFs * 1.05));
  // in-scatter colour by depth; a long path across the water ends in the eye-level deep blue (darker + bluer than the
  // open ocean seen from the air, which is the depth ramp's cyan-blue); murk / harbor / lagoon tints
  ramp = wtrRampAt(dCol);
  // (from above — the aerial, a glider — the reef flat keeps a bright turquoise-cyan over 2-14 m of water, the
  // target art's wide band around the island; at eye level the ramp alone, never a neon stripe along the shelf)
  ramp = mix(ramp, wtrReefTq, smoothstep(0.3, 0.6, V.y) * smoothstep(1.5, 4.0, dCol) * (1.0 - smoothstep(12.0, 24.0, dCol)) * (1.0 - harbor) * (1.0 - calm));
  ramp = mix(ramp, wtrEyeDeep, smoothstep(5.0, 24.0, pathD) * smoothstep(4.5, 11.0, dFs));
  ramp = mix(ramp, wtrMurkCol, murk);
  ramp = mix(ramp, wtrCalmCol, calmD);
  ramp = mix(ramp, wtrHarborCol, harbor * wtrHarborAmt * smoothstep(1.0, 3.0, dT));
  ramp = mix(ramp, wtrLagoonCol, lagoon * wtrLagoonAmt * smoothstep(0.3, 1.5, dT) * (1.0 - smoothstep(6.0, 14.0, dT)));
  fCap = wtrFresCap(dCol, dist, farMix, V.y, harbor) * (1.0 - 0.4 * lagoon * wtrLagoonAmt) * (1.0 - 0.35 * murkD);
}
uniform float wtrCaustics;
uniform float wtrRipHi;
uniform float wtrCrestNet;
uniform vec3 wtrSunDirW;
// the view- and depth-dependent fades of the pixel stage — smooth over any near clipmap cell: per VERTEX there (perf)
//   A = (fine-ripple distance fade, caustic amount by depth + distance, breaker-face zone, chop-facet weight)
//   B = (grazing mean-plane fresnel k, grazing horizon-mirror k, ripple-streak k, crest-net base)
//   C = (sun-glitter lobe width, glitter distance fade, crest-translucency base, backlit)
void wtrViewF(float dist, vec3 V, float dT, float dF, float calm, float harbor, float lagoon, float farMix,
              out vec4 A, out vec4 B, out vec4 C) {
  A = vec4(1.0 - smoothstep(70.0, 100.0, dist),
           wtrCaustics * smoothstep(0.03, 0.3, dF) * exp(-dF / 3.6) * (1.0 - smoothstep(25.0, 50.0, dist)) * mix(1.0, 0.4, smoothstep(5.0, 12.0, dist)),
           smoothstep(0.15, 0.5, dT) * (1.0 - smoothstep(wtrBreakDepth, wtrBreakDepth * 1.8, dT)) * (1.0 - calm) * wtrSurf * (1.0 - smoothstep(60.0, 160.0, dist)) * (1.0 - lagoon),
           smoothstep(1.5, 5.0, dT) * smoothstep(8.0, 40.0, dist) * (1.0 + 0.6 * harbor) * (1.0 - calm * 0.7));
  // (the swimmer's glare — the grazing mirror of the pale horizon — only across the first ~100 m: otherwise the far sea
  // at the beach mirrored the pale horizon band → aqua #7cc3dd instead of the target art's saturated blue)
  float nearCam = smoothstep(3.0, 9.0, dist) * (1.0 - smoothstep(45.0, 130.0, dist));
  B = vec4((1.0 - smoothstep(0.02, 0.09, V.y)) * nearCam,
           (1.0 - smoothstep(0.015, 0.06, V.y)) * nearCam,
           wtrRipHi * (1.0 - smoothstep(25.0, 110.0, dist)),
           wtrCrestNet * mix(0.55, 1.0, harbor) * smoothstep(1.2, 4.0, dT) * (1.0 - calm * 0.85));
  float bl = clamp(dot(-V, wtrSunDirW) * 0.5 + 0.5, 0.0, 1.0);
  C = vec4(mix(0.993, 0.975, smoothstep(10.0, 400.0, dist)),
           1.0 - smoothstep(150.0, 450.0, dist),
           bl * bl * bl * smoothstep(0.5, 4.0, dT) * (1.0 - calm) * (1.0 - smoothstep(25.0, 70.0, dist)),
           bl);
}
`;

export const VERT_PARS = /* glsl */ `
invariant gl_Position;
${COMMON}
varying vec3 vWPos;
varying float vCrest;
varying float vLift;              // drawn surface − the level the colour sees (film hug, far-LOD lifts, − the live swash's drop)
varying vec2 vSwellSl;
varying float vPhase;             // the coast-varying swash phase (smooth over km: per vertex)
varying vec4 vFld2;               // field2 per vertex (the main pass: calm, feathered depth, shore normal — all smooth)
varying vec2 vSlick;              // x: calm wind slicks (140 m noise), y: broad deep-water tone zones (~700 m)
varying vec4 vNzS;                // along-shore variation noise (13 m), per vertex (the foam stack's widths, gaps, sections)
uniform highp sampler2DArray wtrTex2;
// the swash cycles' run-up heights, per vertex (= the fragment's wtrCycA, SURF_PARS)
float wtrCycA(vec2 xz, float n) {
  vec4 z = textureLod(wtrTex2, vec3(xz / 83.0 + vec2(n * 0.3183, n * 0.1931), 1.0), 0.0);
  return 0.52 + 0.48 * smoothstep(0.3, 0.7, z.g * 0.7 + z.b * 0.3);
}
#ifdef WTR_VCORE
attribute float wlevel;           // clipmap level of the vertex (clipmap.ts)
varying vec4 vCT;                 // per-vertex water column (near levels): floor transmission, in-scatter build-up
varying vec4 vCR;                 //   in-scatter albedo, fresnel cap
varying vec4 vCX;                 //   view path, colour depth, path-colour depth, 1 = this vertex path is valid
varying vec4 vCF;                 //   the field (height, shore distance, shore steepness, slope)
varying vec4 vVA;                 // per-vertex view fades (wtrViewF)
varying vec4 vVB;
varying vec4 vVC;
#endif
#ifdef WTR_VALL
varying vec2 vReefV;              // per-vertex reef (coral heads, sand channels)
#endif
${wavesGLSL()}
`;

// replaces <beginnormal_vertex> (runs before begin_vertex) — identical in all three passes
export const VERT_BEGINNORMAL = /* glsl */ `
vec3 objectNormal = vec3(0.0, 1.0, 0.0);
#ifdef WTR_X_VTRIV
float ridgeY = 0.0; vec3 waterPos = position; vFld2 = vec4(0.5); vPhase = 0.0; vMask = vec3(0.0); vSlick = vec2(0.0, 0.5); vCrest = 0.5; vLift = 0.0; vSwellSl = vec2(0.0); vNzS = vec4(0.5);
#else
vec2 wxz0 = (modelMatrix * vec4(position, 1.0)).xz;
vec4 fld0 = texture2D(wtrField, wxz0 * wtrFieldST.x + wtrFieldST.y);
vFld2 = texture2D(wtrField2, wxz0 * wtrFieldST.x + wtrFieldST.y);
float depth0 = -fld0.r, shoreD0 = fld0.g, calm0 = wtrCalm(vFld2.b), slope0 = fld0.a;
vPhase = wtrCoastPhase(wxz0);
{ // analytic masks: THE MURK (a disc, × calm) and the peel-harbor basin (an ellipse) — smooth over tens of metres
  // (THE MURK's tea water is a disc over the swamp — not × calm (the shelter rays left the swamp's west lobe
  // clear aqua) — and only in its shallow water: the deep NE lagoon beyond stays turquoise)
  float mk = 1.0 - clamp((length(wxz0 - wtrMurkP.xy) - wtrMurkP.z) / 30.0, 0.0, 1.0);
  float hb = 1.0 - clamp((length((wxz0 - wtrHarborP.xy) * wtrHarborP.zw) - 0.97) * 2.4, 0.0, 1.0);
  float lg = 1.0 - clamp((length(wxz0 - wtrLagoonP.xy) - wtrLagoonP.z) / 50.0, 0.0, 1.0);
  float lg2 = (1.0 - clamp((length(wxz0 - wtrLagoon2P.xy) - wtrLagoon2P.z) / 45.0, 0.0, 1.0)) * wtrLagoon2P.w;
  lg = max(lg * lg * (3.0 - 2.0 * lg), lg2 * lg2 * (3.0 - 2.0 * lg2));
  // (the swamp's pools are 2-3 m deep — a 0.9-2.2 m depth cut left the pool in front of the view camera
  // clear aqua. The tea water covers the swamp at any depth below ~3 m and hands over to the NE lagoon north of the
  // swamp's boardwalk edge, z ≈ −250…−280: the NE lagoon lies north of z −255)
  mk *= smoothstep(wtrMurkP.y - 64.0, wtrMurkP.y - 34.0, wxz0.y);
  vMask = vec3(mk * mk * (3.0 - 2.0 * mk) * (1.0 - smoothstep(3.0, 4.5, depth0)), hb * hb * (3.0 - 2.0 * hb), lg);
}
{ vec4 nzV = textureLod(wtrTex2, vec3(wxz0 / 140.0, 1.0), 0.0); vec4 nzB = textureLod(wtrTex2, vec3(wxz0 / 760.0 + vec2(0.43, 0.19), 1.0), 0.0);
  vSlick = vec2(smoothstep(0.35, 0.65, nzV.a * 0.7 + nzV.b * 0.3), smoothstep(0.25, 0.75, nzB.g * 0.65 + nzV.r * 0.35)); }
vNzS = textureLod(wtrTex2, vec3(wxz0 / 13.0 + vec2(0.21, 0.77), 1.0), 0.0);
float camD0 = length(cameraPosition.xz - wxz0);
vec3 wDisp; float wCrest; vec2 wSl;
gerstner(wxz0, wtrWaveAmp * wtrSwellAmp(depth0, calm0), wtrTime, camD0, camD0 / 48.0, wDisp, wCrest, wSl);
// the maximum run-up here (the envelope the live swash moves in)
float liftMax = wtrMaxLift(shoreD0, slope0, calm0);
// breaking crest: a low ridge on each surf line in the surf zone (silhouette + shading at ground level)
float surfZ0 = smoothstep(0.15, 0.5, depth0) * (1.0 - smoothstep(wtrBreakDepth, wtrBreakDepth * 1.8, depth0)) * (1.0 - calm0) * wtrSurf * (1.0 - vMask.z);
float u0 = wtrSurfU(shoreD0, wtrPsi(wxz0, wtrTime));
// a breaker: steep shoreward FRONT face (u 0.88 → 1), long gentle back (u 0 → 0.32), each wave of a set its own height
float ridge = wtrRidge(u0) * wtrSetAmp(floor(wtrPsi(wxz0, wtrTime) + shoreD0 / wtrSurfLen + 0.1));
// (only where the clipmap cells still resolve the ~2 m front face — the 1 m cells of level 0, within ~28 m. On 2-4 m
// cells the ridge printed tilted polygon slabs with straight edges that faced the camera — lit by the crest translucency:
// a neon-cyan stripe with hard edges. Beyond, the breaker is its per-pixel slope, lip glow and foam)
float ridgeY = ridge * surfZ0 * wtrBreakH * (1.0 - smoothstep(16.0, 28.0, camD0));
// the surface stands at the LIVE swash level — the
// same run curve × this wave's height the fragment stage draws the waterline with (wtrRunCurve, wtrCycA, the smooth mean
// slope of field3) — so the drawn water meets the sand where its edge is shaded. It used to stand at the STATIC maximum
// run-up (up to 0.3 m) while the live edge moved inside it: between waves the visible edge of the water was a 15-30 cm
// raised sheet over the sand, a dark slab seen edge-on from eye level
float liftNowV;
{
  float cycV = wtrTime / wtrPeriod + vPhase, nCycV = floor(cycV);
  float slopeEV = slope0;
  if (abs(shoreD0) < 26.0) {
    float tHs0 = textureLod(wtrField3, wxz0 * wtrFieldST.x + wtrFieldST.y, 0.0).r;
    slopeEV = mix(slope0, clamp(abs(tHs0) / max(abs(shoreD0), 1.0), 0.004, 0.6), smoothstep(0.5, 3.0, abs(shoreD0)));
  }
  liftNowV = wtrMaxLift(shoreD0, slopeEV, calm0) * wtrRunCurve(cycV - nCycV) * wtrCycA(wxz0, nCycV);
}
// the COLOUR keeps seeing the water at the run-up envelope (the established turquoise right up to the swash's foam line):
// colY is that level; the drawn surface only moved down to the live one
float colY = wDisp.y + liftMax + ridgeY;
wDisp.y += liftNowV + ridgeY;
// the swash + WET-SAND film HUGS the sand over its whole reach (run-up + the wet band + a
// margin), just above the terrain: wetness (fragment, wtrWetness) fades it to exactly the sand behind well before its end
// (10 cm → 2 cm near the camera, growing with the clipmap cell — the drawn sand is the exact 2 m triangles
// within ~80 m (terrain lod.ts NEAR_FULL), the film is linear over 1 / 2 / 4 / 8 m cells (levels at 32 / 64 / 128 m):
// measured on the sandy coast the sand stands above such a triangle by p90 0.6 / 1 / 9.5 / 17 cm.
// 10 cm everywhere stood the swash edge visibly off the sand at eye level)
float reachL = wtrRunupDist + wtrWetW + 1.5;
float hugM = 0.02 + 0.0009 * camD0;
// (… and over the whole sea — flat shelves and sandbars a hand under the surface: wherever the live level or a
//  swell trough drops under the sand the surface hugs it (deeper water is never touched), so the drawn surface never dips
//  below the sand short of the waterline the fragment stage draws — no bare-sand triangles inside the water)
// (the hug is measured from the EXACT drawn triangle at the vertex: the clipmap's 1 m cells nest in the terrain's 2 m
//  triangles — origin snapped to 2 m, 2×2 fans with both diagonals — so near the camera the film lies flush on the sand)
//  On the coarser levels (2-8 m cells, beyond 32 m) the highest drawn sand within the vertex's half cell: a chord across a
//  convex sandbar crest — or a far terrain node standing above the 2 m samples — otherwise let dry-sand triangles poke
//  through the wet swash film. (A convexity-only bulge was tried: the shards came back on the distant bars.)
float hE0 = fld0.r;
if (shoreD0 > -(reachL + 3.0) && shoreD0 < 40.0) {
  hE0 = wtrTerrH(wxz0);
  float chebV = max(abs(position.x), abs(position.z));
  float cellV = exp2(max(0.0, ceil(log2(max(chebV, 1.0) / 32.0))));
  if (cellV > 1.5) {
    float hc = 0.5 * cellV;
    hE0 = max(max(hE0, max(wtrTerrH(wxz0 + vec2(hc, 0.0)), wtrTerrH(wxz0 - vec2(hc, 0.0)))), max(wtrTerrH(wxz0 + vec2(0.0, hc)), wtrTerrH(wxz0 - vec2(0.0, hc))));
  }
}
if (shoreD0 > -(reachL + 3.0)) wDisp.y = max(wDisp.y, hE0 + hugM);
// (… and the colour keeps seeing at least 12 cm of water at the edge: the
//  swash shallows read turquoise right up to the foam line instead of popping back to bare peach sand)
if (shoreD0 > -(reachL + 3.0)) colY = max(colY, fld0.r + 0.12);
// landward of the waterline the (invisible, see 'dry') film rises over the terrain's coarse far LOD, so the visible water
// edge is always the smooth live swash line of the field — never the polygonal cut of a distant terrain LOD mesh through
// the water plane (the stair-stepped waterline)
// (only where the terrain CAN be coarse — beyond the raw 2 m ring (lod.ts NEAR_FULL 80 m from the node box,
// so ≥ ~60 m from the eye) — and sized to it: a far node's grid step is ~4 % of its distance (TOL_PX 50), whose
// deviation from the 2 m samples on the sandy coast is p90 ~10 cm at 4 m, ~17 cm at 8 m. Within the ring the drawn sand
// IS the field's triangles: a 0.02 + 0.4 % × distance lift there (0.5 m at 120 m, 1.2 m from 300 m) would stand the
// near water 10-60 cm above the sand with a hard polygon rim — a floating plateau round sandbars and spits)
float lodErr = min(0.02 + camD0 * 0.001, 0.8) * smoothstep(55.0, 110.0, camD0);
wDisp.y += lodErr * (1.0 - smoothstep(-1.5, 0.5, shoreD0));
// …and in the shallowest sliver of sea the surface stays above it too (a coarse node's seabed never pokes through as a
// sand step in the water); only where the water is shallower than that LOD error, so nothing moves near the camera
if (shoreD0 > -1.5 && lodErr > 0.0) wDisp.y = max(wDisp.y, fld0.r + lodErr);
wDisp.xz *= 1.0 - exp(-max(shoreD0, 0.0) / 6.0) * 0.9;
{ vec2 suv0 = (wxz0 - wtrSimST.xy) * wtrSimST.z;
  if (wtrSimOn > 0.5 && suv0.x > 0.0 && suv0.y > 0.0 && suv0.x < 1.0 && suv0.y < 1.0) { float simH = textureLod(wtrSim, suv0, 0.0).r; wDisp.y += simH; colY += simH; } }
// the drawn surface minus the level the colour sees (signed): the fragment stage shades the water column by
// vWPos.y − vLift − terrain, so the film hug and the far-LOD lifts never read as a thick dark slab seen edge-on
float wLift = wDisp.y - colY;
vec3 waterPos = vec3(position.x + wDisp.x, wDisp.y, position.z + wDisp.z);
// vertices well inland (> ~2 clipmap cells from the shore) sink under the terrain: the surface never pokes through
// low land at a distance (depth precision + polygon offset), and no water fragment is shaded under the island
if (shoreD0 < -(reachL + 3.0 + camD0 * 0.1)) waterPos.y = min(waterPos.y, fld0.r - 2.0);
#if defined(WTR_FOAMPASS) && !defined(WTR_X_NOCULL)
// the foam pass only rasterises where foam can be: the shore band (surf lines reach ~40 m out), anything piercing the
// surface (the proximity bake) and the interactive-ripple window. Everything else sinks far below the sea (its triangles
// fail the depth test before shading: no fragment work over the open sea). Dilated by ~2 clipmap cells, so every
// triangle that can hold foam keeps all three vertices.
{
  float cheb = max(abs(position.x), abs(position.z));
  float cellEst = max(1.0, cheb / 16.0);
  float obV = textureLod(wtrObstacle, vec2(wxz0.x * wtrObstacleScale + 0.5, 0.5 - wxz0.y * wtrObstacleScale), 0.0).r;
  vec2 suvV = (wxz0 - wtrSimST.xy) * wtrSimST.z;
  bool simV = wtrSimOn > 0.5 && suvV.x > -0.05 && suvV.y > -0.05 && suvV.x < 1.05 && suvV.y < 1.05;
  // (the far surf lines live 3-40 m out but only beyond ~220 m from the camera; nearer, foam never reaches past ~10 m)
  float reach = mix(12.0, 48.0, smoothstep(150.0, 210.0, camD0));
  if (!(shoreD0 < reach + 2.0 * cellEst || obV > 0.0 || simV)) waterPos.y = -5000.0;
}
#endif
vCrest = wCrest;
vLift = wLift;
// long-swell slopes per vertex (footprint ≈ the clipmap cell there: dist / 48)
vSwellSl = wSl;
#endif
`;

export const VERT_BEGIN = /* glsl */ `
vec3 transformed = waterPos;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
#if !defined(WTR_X_VTRIV) && !defined(WTR_UNDER)
// DEPTH-PRECISION BIAS for far water: from the aerial (~2 km) one depth-buffer step is ~3 m, so a 2-3 m deep
// lagoon z-fights its own seabed — smeared cream dashes over the Stilt Town lagoon. Far, deep, offshore
// water slides TOWARD the camera along its own view ray (same pixel, nearer depth) by < its depth: it never covers
// land, which is above it, and the shading keeps the true position (vWPos is taken before)
{
  float zb = min(0.7 * max(-fld0.r, 0.0), 5.0) * smoothstep(250.0, 700.0, camD0) * smoothstep(6.0, 20.0, fld0.g);
  transformed += normalize(cameraPosition - vWPos) * zb;
  // the shallowest strip of sea (0-10 m off the waterline) RASTERISES a terrain-LOD error higher than it is
  // shaded (vWPos is taken above): a coarse terrain node's triangles stand a few cm-dm above the 2 m field there and cut
  // rectangular notches out of the waterline from 20 m up / the glider. Land is lifted the same way above
  if (shoreD0 > -0.5) transformed.y += lodErr * (1.0 - smoothstep(4.0, 10.0, shoreD0));
}
#endif
#ifdef WTR_VCORE
// the water column per VERTEX on clipmap levels 0-1 (wtrColumn: 1-2 m cells, hundreds of pixels per vertex near the
// camera); the fragment stage falls back to per pixel on the other levels and next to objects.
// WTR_VALL (the eye-level program, camera < ~12 m): per vertex on EVERY level — beyond level 1 the view is grazing and
// the path colour rules — and the per-pixel column is not compiled in at all
#ifdef WTR_VALL
{
  // the reef's noise heads + sand channels per vertex (31 m noise: smooth over any near cell)
  vec4 nzR = textureLod(wtrTex2, vec3(wxz0 / 31.0 + vec2(0.37, 0.11), 1.0), 0.0);
  float coralV = max(wtrCoralF(vFld2.b), smoothstep(0.58, 0.70, nzR.g * 0.7 + nzR.a * 0.3));
  vReefV = vec2(coralV, smoothstep(0.40, 0.28, nzR.r * 0.6 + nzR.b * 0.4) * (1.0 - coralV));
}
if (true) {
#else
if (wlevel < 1.5) {
#endif
  vec3 toCv = cameraPosition - vWPos;
  float dCv = length(toCv);
  vec3 Tfv, rpv; float scv, thv, dcv, pdv, fcv;
  // (the column sees the water depth WITHOUT the breaker ridge: the ridge's +0.36 m over 0.5 m of water changed the colour
  // per vertex — faceted cyan slabs on every crest)
  // (on the coarse cells — beyond level 0's 1 m cells — the colour column sees the ~12 m-FEATHERED depth: the true
  // depth sampled every 2-8 m interpolated shelf edges and sandbars into flat polygons with straight edges (the neon
  // stripe along the reef shelf at eye level). A function of the vertex position only: coincident vertices of two
  // levels agree, no seam)
  float dFv = max(vWPos.y - wLift - ridgeY - fld0.r, 0.0);
  dFv = mix(dFv, vFld2.a * 40.0, smoothstep(24.0, 44.0, dCv) * smoothstep(0.6, 2.0, vFld2.a * 40.0));
  wtrColumn(dFv, vFld2.a, -fld0.r, toCv / max(dCv, 1e-3), dCv, smoothstep(150.0, 900.0, dCv), vMask, wtrCalm(vFld2.b), 0.0,
            Tfv, scv, rpv, thv, dcv, pdv, fcv);
  vCT = vec4(Tfv, scv); vCR = vec4(rpv, fcv); vCX = vec4(thv, dcv, pdv, 1.0); vCF = fld0;
  wtrViewF(dCv, toCv / max(dCv, 1e-3), -fld0.r, max(vWPos.y - wLift - ridgeY - fld0.r, 0.0), wtrCalm(vFld2.b), vMask.y, vMask.z, smoothstep(150.0, 900.0, dCv), vVA, vVB, vVC);
} else { vCT = vec4(0.0); vCR = vec4(0.0); vCX = vec4(0.0); vCF = fld0; vVA = vec4(0.0); vVB = vec4(0.0); vVC = vec4(0.0); }
#endif
#ifdef WTR_VSHADOW
// the sun-shadow coordinates per VERTEX: the cascades and the far map are orthographic (affine), so interpolating them
// across a planar triangle is exact — two mat4 × vec4 per pixel less; the water's normal offset is "up"
{
  vec3 wpS = vWPos;
  vWtrSh0 = (sunShadowMatrix[ 0 ] * vec4(wpS + vec3(0.0, uAtmSunBias.z, 0.0), 1.0)).xyz;
  vWtrSh1 = (sunShadowMatrix[ 1 ] * vec4(wpS + vec3(0.0, uAtmSunBias.w, 0.0), 1.0)).xyz;
  vWtrShF = (uAtmFarMatrix * vec4(wpS + vec3(0.0, uAtmFarParams.y, 0.0), 1.0)).xyz;
}
#endif
#if defined(ATMOS) && defined(WTR_VATM)
// aerial perspective per VERTEX (it is affine in the colour: aerial(c) = A·c + B, smooth over any clipmap cell)
#ifdef WTR_X_NOVATM
vAtmB = vec3(0.0); vAtmA = vec3(1.0);
#else
vAtmB = atmosAerial(vec3(0.0), vWPos);
vAtmA = atmosAerial(vec3(1.0), vWPos) - vAtmB;
#endif
vCloudSh = atmosCloudShadow(vWPos);        // (the cloud shadow is smooth over any clipmap cell: per vertex, one fetch less per pixel)
#endif
`;

/** main-pass vertex declarations: + the atmos functions for the per-vertex aerial perspective (when atmos exists) */
export const vertParsMain = (atmosGlsl?: string) => /* glsl */ `
${VERT_PARS}
#if defined(WTR_VSHADOW) && defined(USE_SHADOWMAP) && NUM_SUN_LIGHT_SHADOWS == 1
uniform mat4 sunShadowMatrix[ 2 ];
// (on a material atmos patched with its uniform buffer these three are members of it: atmos/glsl.ts ATMOS_UBO)
#ifndef KR_ATMOS_UBO
uniform vec4 uAtmSunBias;
uniform mat4 uAtmFarMatrix;
uniform vec4 uAtmFarParams;
#endif
varying vec3 vWtrSh0;
varying vec3 vWtrSh1;
varying vec3 vWtrShF;
#else
#undef WTR_VSHADOW
#endif
#if defined(ATMOS) && defined(WTR_VATM)
${atmosGlsl ?? ""}
varying vec3 vAtmA;
varying vec3 vAtmB;
varying float vCloudSh;
#endif
`;

/** vertex shader of the depth pre-pass and the multiply pass (ShaderMaterial) — the same chain as three's */
export const VERT_SIMPLE = /* glsl */ `
${VERT_PARS}
void main() {
  ${VERT_BEGINNORMAL}
  ${VERT_BEGIN}
  vec4 mvPosition = vec4(transformed, 1.0);
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;
}
`;
export const FRAG_DEPTH_ONLY = /* glsl */ `void main() { gl_FragColor = vec4(0.0); }`;

/** fragment declarations + helpers shared by the multiply pass and the main pass */
const SURF_PARS = /* glsl */ `
${COMMON}
uniform sampler2D wtrTile;
// (wtrTex2: layer 0 = foam, layer 1 = noise, layer 2 = caustic net — declared with the shared vertex/fragment pars)
uniform highp sampler2DArray wtrTex2;
uniform float wtrRipple;
varying vec3 vWPos;
varying float vCrest;
varying float vLift;
varying vec2 vSwellSl;
varying float vPhase;
varying vec4 vFld2;
varying vec2 vSlick;
varying vec4 vNzS;
#ifdef WTR_VCORE
varying vec4 vCT;
varying vec4 vCR;
varying vec4 vCX;
varying vec4 vCF;
varying vec4 vVA;
varying vec4 vVB;
varying vec4 vVC;
#endif
#ifdef WTR_VALL
varying vec2 vReefV;
#endif
${wavesGLSL()}

vec4 wtrNoiseT(vec2 uv) { return texture(wtrTex2, vec3(uv, 1.0)); }
// fetches inside branches: explicit gradients (anisotropic). WTR_X_TLOD = one isotropic trilinear sample at the LOD of
// the footprint's geometric mean instead (measured on an M5-class GPU: no faster — kept as a profiling switch)
#ifndef WTR_X_TLOD
#define WTR_TG(s, uv, dx, dy) textureGrad(s, uv, dx, dy)
#else
float wtrLodT(vec2 dx, vec2 dy, float sz) { return 0.25 * log2(max(dot(dx, dx) * dot(dy, dy), 1e-30)) + log2(sz); }
#define WTR_TG(s, uv, dx, dy) textureLod(s, uv, wtrLodT(dx, dy, float(textureSize(s, 0).x)))
#endif
mat2 wtrRot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
// SWASH CYCLES: every wave runs up its own height (sets, smooth along the shore over ~80 m, new each cycle)
float wtrCycA(vec2 xz, float n) {
  vec4 z = textureLod(wtrTex2, vec3(xz / 83.0 + vec2(n * 0.3183, n * 0.1931), 1.0), 0.0);
  return 0.52 + 0.48 * smoothstep(0.3, 0.7, z.g * 0.7 + z.b * 0.3);
}
// inverse smoothstep(0, 1): x with 3x² − 2x³ = y
float wtrInvS(float y) { return 0.5 - sin(asin(1.0 - 2.0 * clamp(y, 0.0, 1.0)) / 3.0); }
// WET SAND with memory: 1 under the swash, then exp(−seconds since the swash left / wtrDryTau). The run-up of wave k
// (current k = 0, the two before) is wtrRunCurve × its own height; a level f (of the wave's peak lift / 0.8) is covered
// from ψ_up = 0.18·S⁻¹(f/0.8) to ψ_dn (the drain branch inverted) — analytic, no history buffer. The top edge of each
// wave's reach is soft (a capillary fringe) and wobbles along the shore (jit, in units of the peak)
float wtrWetK(float tH, float liftMax, float a, float psiK, float jit) {
  float pk = max(liftMax * a, 1e-3);
  float f = tH / pk + jit;
  float reach = smoothstep(0.8 + 0.07, 0.8 - 0.07, f);           // inside this wave's reach (soft top edge)
  if (reach <= 0.0) return 0.0;
  float fc = clamp(f, 0.0, 0.8);
  float pUp = 0.18 * wtrInvS((fc / 0.8 - 0.08) / 0.92);
  float pDn = fc < 0.065 ? 1.0 : 0.18 + 0.74 * wtrInvS((1.0 - fc / 0.8) / 0.92);
  if (psiK < pUp) return 0.0;                                     // (k = 0 only: this wave has not got here yet)
  float dt = max(psiK - pDn, 0.0) * wtrPeriod;
  return reach * exp(-dt / wtrDryTau);
}
// Schlick fresnel (× the cap wtrFresCap, COMMON)
float wtrSchlick(vec3 n, vec3 V) { float m = 1.0 - clamp(dot(n, V), 0.0, 1.0), m2 = m * m; return 0.02 + 0.98 * m2 * m2 * m; }
// (the swash film over wet sand reflects a little sky — mostly the sand reads darker and wet under it)
// (the wet film is glossy — it mirrors a sheen of sky right behind the live line, fading toward the dry sand)
float wtrFresK(float wEdge, float wetZone, float dry) { return wEdge * mix(1.0, 0.2 * (1.0 - smoothstep(0.0, 0.8, dry)), wetZone); }
float wtrFresnel(vec3 n, vec3 V, float dCol, float dist, float farMix, float wEdge, float wetZone, float dry) {
  return min(wtrSchlick(n, V), wtrFresCap(dCol, dist, farMix, V.y, vMask.y)) * wtrFresK(wEdge, wetZone, dry);
}
`;

/** the base quantities both passes derive the same way (field lookups, swash, coarse normal, water column) */
const SURF_CORE = /* glsl */ `
  vec2 xz = vWPos.xz;
  vec2 fuv = xz * wtrFieldST.x + wtrFieldST.y;
  #if defined(WTR_VALL)
  const bool vcoreP = true;
  // (the field per PIXEL — interpolated from 2-8 m clipmap cells the shore distance / depth drew the surf zone, the
  // swash and the breaker glow as polygons with straight edges beyond ~30 m: hard-edged cyan stripes)
  vec4 fld = textureLod(wtrField, fuv, 0.0);
  #elif defined(WTR_VCORE)
  bool vcoreP = vCX.w > 0.5;                                   // (a near clipmap level: the per-vertex core)
  vec4 fld = vcoreP ? vCF : textureLod(wtrField, fuv, 0.0);
  // the swash zone reads the field PER PIXEL: the per-vertex copy, interpolated over 2-4 m clipmap cells,
  // drew the live waterline + the wet film's edge as a notched polyline from 10-30 m up
  if (vcoreP && vCF.g < 14.0 && vCF.g > -14.0) fld = textureLod(wtrField, fuv, 0.0);
  #else
  vec4 fld = texture2D(wtrField, fuv);
  #endif
  #if defined(WTR_MUL) || defined(WTR_FOAMPASS)
  vec4 fld2 = texture2D(wtrField2, fuv);                        // (coral heads + the shore normal: per pixel)
  #else
  vec4 fld2 = vFld2;                                            // (calm + the feathered depth: smooth, per vertex)
  #endif
  float tH = fld.r, shoreD = fld.g, shoreSteep = fld.b, slope = max(fld.a, 0.003);
  // near the shore the swash geometry is the SMOOTHED height + slope (fieldbake d3): the terrain's 10-20 cm beach
  // terraces notched the waterline in 2 m steps
  vec2 shoreNP = fld2.rg * 2.0 - 1.0;                          // (toward open water; precise near the shore, below)
  // (tH stays the TRUE height — the water depth / the scene-depth object tests need it; tHs is the swash's smooth one)
  float tHs = tH;
  if (abs(shoreD) < 26.0) { vec4 f3 = textureLod(wtrField3, fuv, 0.0); tHs = f3.r; slope = max(f3.g, 0.003); shoreNP = f3.ba; }
  shoreNP /= max(length(shoreNP), 1e-3);
  float calm = wtrCalm(fld2.b);
  // analytic masks (per vertex): THE MURK (a disc, × calm) and the peel-harbor basin (an ellipse)
  float murk = vMask.x, harbor = vMask.y, lagoon = vMask.z;
  float dT = -tHs;                                             // terrain depth below sea level (+ in water; smooth at the shore)
  vec3 toCam = cameraPosition - vWPos;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-3);
  // pixel footprint (uniform control flow): gradients for every fetch made inside a branch below
  vec2 gx = dFdx(xz), gy = dFdy(xz);
  float fp = max(max(length(gx), length(gy)), 1e-4);          // major axis (m / px) — anisotropic at grazing angles
  float fpMin = max(min(length(gx), length(gy)), 1e-4);
  float fpT = max(fpMin, fp * 0.2);                            // what anisotropic filtering still resolves
  float nearF = 1.0 - smoothstep(40.0, 400.0, dist);
  float farMix = smoothstep(150.0, 900.0, dist);

  // ---------- live swash: where is the water's edge right now?
  float cyc = wtrTime / wtrPeriod + vPhase;                     // (= wtrPsi, the coast phase interpolated per vertex)
  float nCyc = floor(cyc), psi = cyc - nCyc;
  // each wave runs up its own height: sets of bigger / smaller swashes, varying along the shore
  float a0 = wtrCycA(xz, nCyc);
  // the run-up envelope PER PIXEL from the per-pixel field: per vertex it followed the 2 m slope texels and the
  // clipmap grid — the live waterline came out notched in 4-6 m steps from a glider / 20 m up
  // (… and from a SMOOTH slope: the baked |grad h| varies texel to texel, and on a gentle beach the envelope is bounded by
  // slope × run-up distance — the live line jumped with it. The mean slope from the waterline to here is smooth)
  float slopeE = mix(slope, clamp(abs(tHs) / max(abs(shoreD), 1.0), 0.004, 0.6), smoothstep(0.5, 3.0, abs(shoreD)));
  float liftMaxP = wtrMaxLift(shoreD, slopeE, calm);
  float run = wtrRunCurve(psi);
  float liftNow = liftMaxP * run * a0;                         // the swash level (m above sea level) right now
  float slopeL = max(slope, 0.012);
  float toLine = (liftNow - tHs) / slopeL;                      // metres to the live waterline (+ water side)
  float toMax = (liftMaxP * 0.8 * a0 - tHs) / slopeL;          // metres to THIS wave's highest reach
  // wet film: landward of the live waterline, inside the lifted shore band of the mesh
  float wetZone = 1.0 - smoothstep(-0.10, 0.06, toLine);
  // WET SAND WITH MEMORY: the sand the last three swashes covered, drying over wtrDryTau seconds since each
  // left it (wtrWetK) + a narrow damp fringe (wtrWetW m) above the highest of them. 0 wetness = the film is EXACTLY the
  // scene behind (no tint, no sheen): the wet band is 1-3 m of darker glossy sand that breathes with the waves, never
  // a static 5-12 m grey-brown strip
  float wetH = 0.0;
  if (tHs > -0.4 && tHs < liftMaxP + 0.25) {
    float jit = (vNzS.g - 0.5) * 0.22 + (vNzS.b - 0.5) * 0.1;
    float a1 = wtrCycA(xz, nCyc - 1.0), a2 = wtrCycA(xz, nCyc - 2.0);
    // (the oldest wave fades out over its last cycle: no discontinuity where the cycle count ticks over along the beach)
    wetH = max(wtrWetK(tHs, liftMaxP, a0, psi, jit), max(wtrWetK(tHs, liftMaxP, a1, psi + 1.0, jit), wtrWetK(tHs, liftMaxP, a2, psi + 2.0, jit) * (1.0 - psi)));
    // the damp fringe: a narrow band (wtrWetW m) above the highest recent reach stays slightly damp
    // highest reach of the recent waves — continuous in time (the new wave counts as it runs up, the oldest fades out)
    float topL = liftMaxP * 0.8 * max(a0 * min(psi / 0.18, 1.0), max(a1, a2 * (1.0 - psi)));
    // (below the highest reach the sand is at least this damp too: the swash zone never dries between two waves)
    float aboveTop = (tHs - topL) / slopeL + jit * 2.0;
    // (a moist floor, not a saturated one: the sand a bigger wave of the set wetted DRIES visibly — exp(−t / wtrDryTau)
    //  from wtrWetK — down to this damp level while the smaller waves fall short of it)
    wetH = max(wetH, 0.5 * (1.0 - smoothstep(0.45 * wtrWetW, wtrWetW, aboveTop)));
  }
  wetH *= 1.0 - calm * 0.5;
  float dry = (1.0 - wetH) * wetZone;

  #if defined(WTR_MUL)
  // the multiply pass: the coarse (per-vertex) swell normal is enough for its fresnel
  vec2 sl = vSwellSl;
  #elif !defined(WTR_FOAMPASS)
  // ---------- coarse normal: band-limited swell + the ripple tile at two broad scales
  float ampS = wtrWaveAmp * wtrSwellAmp(dT, calm);
  // (perf: not in the eye-level program — the one per-pixel component is a 1 cm, 3.1 m wave: its slope is lost under the
  // ripple tile; measured −0.06 ms per draw at the eye-level beach)
  #if defined(WTR_X_NOSWELL) || defined(WTR_FAR) || defined(WTR_VALL)
  vec2 sl = vSwellSl;
  #else
  vec2 sl = vSwellSl + gerstnerSlopeShort(xz, ampS, wtrTime, fp);
  #endif
  const mat2 rC = mat2(${Math.cos(-0.61).toFixed(6)}, ${Math.sin(-0.61).toFixed(6)}, ${(-Math.sin(-0.61)).toFixed(6)}, ${Math.cos(-0.61).toFixed(6)});
  float slick = vSlick.x;                                                                 // calm wind slicks (aerial)
  float rip = wtrRipple * mix(1.0, 0.3, calm) * mix(1.0, 1.55, harbor) * mix(0.25, 1.0, smoothstep(0.0, 0.7, dT - liftNow + 0.05));
  float bC = 1.0 - smoothstep(1.2, 5.0, fpT), bD = 1.0 - smoothstep(6.0, 24.0, fpT);
  #ifdef WTR_X_NOTILE
  bC = 0.0; bD = 0.0;
  #endif
  vec4 tC = texture2D(wtrTile, (rC * xz) / (${T} * 4.3) + vec2(0.61, 0.83));
  vec2 ripS = (transpose(rC) * ((tC.rg - 0.5) * ${SR})) * 0.74 * mix(1.0, 0.55, slick) * bC;
  // broad ripples from the air: calmer (they are what catches the sun as "tinsel" over the whole ocean). In the harbor
  // basin they are the 3-20 m CHOP (at 60-300 m the fine tile alone read as grain — the target art's harbor has soft
  // multi-metre undulations with lighter crests): from 15 m out at any camera height, stronger
  float kD4 = max(smoothstep(40.0, 300.0, dist) * smoothstep(12.0, 35.0, cameraPosition.y), harbor * smoothstep(12.0, 45.0, dist)) * bD;
  vec2 ripD = vec2(0.0);                                        // (the broad layer alone: the chop shading uses it)
  if (kD4 > 0.001) {
    float sD = 1.0 / (${T} * 19.0);
    // (anisotropic: compressed along the swell's travel, stretched along its crests — long wave-like undulations, never
    // round blotches of "camo")
    const vec2 WDn = vec2(${WD0});
    mat2 toW = mat2(WDn.x * 1.6, -WDn.y * 0.8, WDn.y * 1.6, WDn.x * 0.8);
    vec4 tD = WTR_TG(wtrTile, (toW * xz) * sD + vec2(0.13, 0.47), (toW * gx) * sD, (toW * gy) * sD);
    // (the harbor does not boost this broad layer — its 20-40 m light / dark blotches read as matte "camo")
    ripD = (transpose(toW) * ((tD.rg - 0.5) * ${SR})) * kD4 * (0.8 + 0.1 * harbor);
    ripS += ripD * 0.4 * (0.6 + 0.8 * slick);
  }
  // HARBOR CHOP: crisp 1-6 m wind chop reflected off the quays — the target art's harbor is a fine network of lighter
  // crests around darker cobalt troughs with sun glints, resolved at every camera distance (the fine ripple layers fade
  // out beyond ~70 m)
  // + OPEN-WATER CHOP: the same crisp 1-6 m wind chop over deep open water (without it the deep sea at eye /
  // swimmer height read soft, blurry and uniform)
  float openK = smoothstep(3.0, 9.0, dT) * (1.0 - lagoon) * (1.0 - murk) * (1.0 - calm);
  float fpC = max(fpMin, fp * 0.125);                          // (8× anisotropic tile: the chop stays crisp at grazing angles)
  float kHc = max(harbor, openK) * (1.0 - calm) * (1.0 - smoothstep(0.6, 2.4, mix(fpT, fpC, openK))) * smoothstep(0.3, 1.5, dT);
  if (kHc > 0.01) {
    const mat2 rH = mat2(-0.351529, 0.936177, -0.936177, -0.351529);
    float sH = 1.0 / (${T} * 1.7);
    vec4 tHc = WTR_TG(wtrTile, (rH * xz) * sH + vec2(0.71, 0.29), (rH * gx) * sH, (rH * gy) * sH);
    ripS += (transpose(rH) * ((tHc.rg - 0.5) * ${SR})) * kHc * mix(0.85, 1.3, openK * (1.0 - harbor));
  }
  #endif

  // ---------- the water column (wtrColumn, COMMON): per vertex on the near clipmap levels (the varyings vC*), per pixel
  //            on the far levels, the aerial and next to objects piercing the surface
  // the water depth the colour sees: the run-up envelope over the field (vLift takes the film hug, the far-LOD
  // lifts and the live swash's drop back out of the drawn height) — never the lifted film's 3-40 cm read as a thick slab
  float dF = max(vWPos.y - vLift - tH, 0.0);
  float dFg = max(vWPos.y - tH, 0.0);                            // (the DRAWN surface's height over the field: scene-depth tests)
  // waterline proximity of anything piercing the surface (hulls, quay walls, piles, rocks, containers): ≈ 1 at the
  // object → 0 at ~4 m, plus the shapes other areas registered
  // (+ G: the WIDE proximity, ≈ 1 at a hull / wall / sea stack → 0 at ~16 m: the foam churn seen from the air)
  vec2 obs2 = texture2D(wtrObstacle, vec2(xz.x * wtrObstacleScale + 0.5, 0.5 - xz.y * wtrObstacleScale)).rg;
  float obst = obs2.r, obW = obs2.g;
  vec3 Tfloor, ramp; float scat, thick, dCol, pathD, fCap;
  #if defined(WTR_VALL)
  {
    // per vertex everywhere; next to objects the pixel adds what wtrColumn does with obst: the water right at a hull /
    // wall / container is shaded by it (darker, less floor) — deep water only thickens the column
    Tfloor = vCT.rgb; scat = vCT.a; ramp = vCR.rgb; fCap = vCR.a; thick = vCX.x; dCol = vCX.y; pathD = vCX.z;
    float ob = smoothstep(0.35, 0.8, obst);
    #ifdef WTR_SCENE
    ob *= 1.0 - wtrGrab.z;          // (the scene depth shades objects exactly: no proximity halo / dark disc)
    #endif
    if (ob > 0.001) {
      float deepO = smoothstep(3.0, 6.0, dF);
      Tfloor *= mix(1.0, mix(0.55, 0.12, deepO), ob);
      scat = max(scat, 0.75 * ob * deepO);
      thick = max(thick, 9.0 * ob * deepO);
    }
  }
  #else
  #ifdef WTR_VCORE
  if (vcoreP && obst < 0.3) { Tfloor = vCT.rgb; scat = vCT.a; ramp = vCR.rgb; fCap = vCR.a; thick = vCX.x; dCol = vCX.y; pathD = vCX.z; }
  else
  #endif
  #ifdef WTR_SCENE
  wtrColumn(dF, fld2.a, dT, V, dist, farMix, vMask, calm, obst * (1.0 - wtrGrab.z), Tfloor, scat, ramp, thick, dCol, pathD, fCap);
  #else
  wtrColumn(dF, fld2.a, dT, V, dist, farMix, vMask, calm, obst, Tfloor, scat, ramp, thick, dCol, pathD, fCap);
  #endif
  #endif
  // the soft waterline: ~5 cm on the open coast, ~40 cm in calm lagoon / mangrove water (its tidal puddles fade in
  // instead of printing the terrain's jagged edge)
  // COASTAL CYAN: the deep water right off a steep coast / cliff / stack line glows bright cyan (the sea-cliffs
  // target art's #4ad3ed, the aerial's wide turquoise ring) before it turns sapphire further out
  {
    float coastK = (1.0 - smoothstep(18.0, 75.0, shoreD)) * smoothstep(0.5, 3.0, shoreD) * smoothstep(3.0, 8.0, dCol)
                 * (1.0 - smoothstep(26.0, 45.0, dCol)) * (1.0 - harbor) * (1.0 - lagoon) * (1.0 - murk) * (1.0 - calm) * wtrCoastAmt;
    // (+ round the sea stacks / big rocks standing in open water — the wide proximity, ~16 m: a bright
    //  cyan collar round every stack before the sapphire)
    coastK = max(coastK, smoothstep(0.08, 0.7, obW) * smoothstep(3.0, 8.0, dCol) * (1.0 - smoothstep(30.0, 60.0, dCol))
                 * (1.0 - harbor) * (1.0 - lagoon) * (1.0 - murk) * (1.0 - calm) * wtrCoastAmt * 0.9);
    ramp = mix(ramp, wtrCoastTq, coastK);
  }
  float wEdgeL = smoothstep(0.0, mix(0.05, 0.4, max(calm, murk)), thick);
  // the foam keeps the DRAWN surface's edge: the contact line / swash lace sit right AT the waterline, where the
  // physical depth (wEdgeL) fades the water body out
  float wEdgeF = smoothstep(0.0, mix(0.025, 0.2, max(calm, murk)), dFg);
`;

/** what the water does to the scene behind it (needs SURF_CORE + a fresnel `F`; leaves `vec3 M`): per-channel
 *  transmission × the reef's coral heads / sand channels × the wet-sand tint under the swash film × (1 − F).
 *  (the caustic net is ADDED by the main pass — white-cyan light on the floor, not a tint of the sand) */
const MUL_BODY = /* glsl */ `
  vec3 M;
  {
    // reef: coral heads (dark blue-green) + pale sand channels in the 1.2..16 m band. field2.b = the terrain's own raised
    // coral heads (baked height anomaly, per pixel), plus small noise heads between them
    float band = smoothstep(1.0, 2.6, dF) * (1.0 - smoothstep(12.0, 18.0, dF)) * (1.0 - smoothstep(0.3, 0.7, obst)) * (1.0 - calm) * (1.0 - murk)
               * smoothstep(0.01, 0.05, dot(Tfloor, vec3(0.3333)));                        // (a hidden floor needs no reef)
    #ifdef WTR_X_NOREEF
    band = 0.0;
    #endif
    vec3 reefMul = vec3(1.0);
    #ifdef WTR_VALL
    reefMul = mix(vec3(1.0), vec3(0.12, 0.24, 0.40), vReefV.x * band * wtrReef * wtrCoral) * mix(1.0, 1.06, vReefV.y * band * wtrReef);
    #else
    if (band > 0.001) {
      vec4 nz2 = WTR_TG(wtrTex2, vec3(xz / 31.0 + vec2(0.37, 0.11), 1.0), gx / 31.0, gy / 31.0);
      #ifdef WTR_MULFLD2
      float coralB = textureGrad(wtrField2, fuv, gx * wtrFieldST.x, gy * wtrFieldST.x).b;   // (fld2 is per vertex here)
      #else
      float coralB = fld2.b;
      #endif
      float coral = max(wtrCoralF(coralB), smoothstep(0.58, 0.70, nz2.g * 0.7 + nz2.a * 0.3));
      // (dark BLUE coral heads, the aerial target art's)
      reefMul = mix(vec3(1.0), vec3(0.12, 0.24, 0.40), coral * band * wtrReef * wtrCoral);
      float sandCh = smoothstep(0.40, 0.28, nz2.r * 0.6 + nz2.b * 0.4) * (1.0 - coral);
      reefMul *= mix(1.0, 1.06, sandCh * band * wtrReef);
    }
    #endif
    // wet sand under the swash film: darker + warmer at the live line, EXACTLY the dry sand further up
    // (the target art's 1-2 m of darker, glossy sand above the edge: dark over most of the
    // film, fading only at its landward end)
    // (tinted by the wetness with memory — fresh wet sand ×wtrWetDark, warmer; drying back to exactly 1)
    vec3 wetMul = mix(vec3(1.0), vec3(0.97, 0.94, 0.88) * wtrWetDark, clamp(1.0 - dry, 0.0, 1.0));
    M = mix(Tfloor * reefMul * wtrFloorGain, wetMul, wetZone) * (1.0 - F);
  }
`;

// ======================================================================================================================
// PASS 1 — MULTIPLY (ShaderMaterial): gl_FragColor = M, blended dst *= M. FALLBACK ONLY: with WEBGL_blend_func_extended
// the main pass writes M as its second (dual-source) output and this pass is never drawn
// ======================================================================================================================
export const FRAG_MUL = /* glsl */ `
${SURF_PARS}
uniform float wtrReef;
uniform float wtrCoral;
uniform float wtrFloorGain;
uniform float wtrWetDark;
uniform float wtrDebug;
#ifdef WTR_ATMOS
ATMOS_GLSL_HERE
#endif
void main() {
  ${SURF_CORE}
  // fresnel from the coarse normal (the main pass adds the matching sky reflection)
  float F = wtrFresnel(normalize(vec3(-sl.x, 1.0, -sl.y)), V, dCol, dist, farMix, wEdgeL, wetZone, dry);
  ${MUL_BODY}
  if (wtrDebug > 0.5) M = vec3(1.0);
  #ifdef WTR_CANVAS
  M = pow(max(M, 0.0), vec3(1.0 / 2.2));                             // the canvas holds tone-mapped sRGB (no-post tier)
  #endif
  gl_FragColor = vec4(M, 1.0);
}
`;

// ======================================================================================================================
// PASS 2 — MAIN (MeshPhysicalMaterial + onBeforeCompile), premultiplied over: dst = src + dst·(1 − foam)
// ======================================================================================================================
export const FRAG_PARS = /* glsl */ `
${SURF_PARS}
uniform float wtrScatterGain;
uniform vec3 wtrFoamCol;
uniform vec3 wtrSssCol;
uniform float wtrRoughNear;
uniform float wtrRoughFar;
uniform float wtrFoamAmount;
uniform float wtrContact;
uniform float wtrContactW;
uniform float wtrWhitecaps;
uniform float wtrFacet;
uniform float wtrCrestHi;
uniform float wtrSkyReflect;
uniform float wtrShadeMin;
uniform float wtrGlitter;
uniform float wtrSparkle;
uniform float wtrDebug;
uniform float wtrHaze;
uniform float wtrHaloRefl;
uniform float wtrReflLift;
uniform float wtrReef;
uniform float wtrCoral;
uniform float wtrFloorGain;
uniform float wtrWetDark;
uniform vec3 wtrSkyIrr;
// ---- THE OPAQUE SCENE BEHIND THE WATER: a colour + depth copy of the finished opaque frame taken right before
//      the water draws (grab.ts — one blit, ~0.03 ms on an RTX 4080-class GPU). Gives (1) the exact water thickness to
//      whatever stands in the water (piles, ladders, hulls, rocks, roots, crates, kongs) → contact foam + lapping rings
//      at every object crossing the surface and clear shallow water over submerged parts; (2) screen-space reflections
//      of the huts, boats, treeline and cliffs at grazing angles.
uniform sampler2D wtrSceneDepth;
uniform sampler2D wtrSceneCol;
uniform vec4 wtrGrab;             // 1/width, 1/height, depth valid, colour valid
uniform vec2 wtrCamNF;            // camera near, far
uniform mat4 wtrProj;             // the camera's projection (as drawn: TAA jitter included)
uniform float wtrRefract;         // screen-space refraction: metres of lateral shift per unit slope per metre of water
uniform float wtrSSR;             // screen-space reflection strength (0 = sky only)
uniform float wtrContactD;        // depth-contact foam (0..1)
uniform float wtrChop;            // crisp open-water chop
uniform float wtrCapOpen;         // how far the grazing fresnel cap opens over open water (facets show sky / body)
uniform float wtrChopBL;          // the chop's band-limit scale (1 = cut at ~2 rad / px; < 1 lets more through, TAA settles it)
uniform float wtrSandCool;        // the seabed seen through the water reads as cool white carbonate sand (0 = as drawn)
float wScRay = 1e3;   // metres along the view ray from the water surface to the opaque scene behind it
float wScObj = 0.0;   // 1 = the scene point behind is an OBJECT standing in the water (shallower than the seabed)
float wSwB = 0.0;     // 1 = the sandy swash band (the fragment's live line owns the waterline there)
float wScC = 0.0;     // depth-contact collar coverage (0..1)
float wScLap = 0.0;   // lapping ring coverage (0..1)
// 1 = a thin film (< ~25 cm of water) lying over an OBJECT — a boulder on the beach whose footprint dips under the
// waterline: no water drawn there
float wFilmObj = 0.0;
float wLeaf = 0.0; vec3 wLeafCol = vec3(0.0); float wMurk = 0.0; float wLag = 0.0;   // THE MURK: floating leaves / litter on the tea water
float wtrViewZ(float d) { float n = wtrCamNF.x, f = wtrCamNF.y; return (2.0 * n * f) / ((f + n) - (d * 2.0 - 1.0) * (f - n)); }
#if defined(ATMOS) && defined(WTR_VATM)
varying vec3 vAtmA;
varying vec3 vAtmB;
varying float vCloudSh;
#endif

#if defined(WTR_OWNLIGHT) && !defined(WTR_X_THREELIGHT)
#define WTR_OWNL 1
#endif
vec3 wSunLit = vec3(0.0);  // (WTR_OWNL) the sun's shadowed colour — the water shades itself, no three BRDF (material.ts)
vec3 wMul = vec3(1.0);   // the dual-source multiply factor (what the water does to the scene behind it)
float wFacetK = 0.0;     // where the chop's facet lighting applies (deeper water, not at the camera's feet)
float wDbgThick = 0.0; float wDbgDF = 0.0;
float wColThk = 0.0;  // the column's view path (m) — what the refraction's sand cooling keys on
float wFoam = 0.0; float wDist = 0.0; vec3 wN = vec3(0.0, 1.0, 0.0); float wWet = 0.0; float wEdge = 1.0;
float wSss = 0.0; vec3 wRamp = vec3(0.0); float wScat = 0.0; vec3 wRefl = vec3(0.0);
float wF = 0.0; float wNdL = 1.0; float wSpark = 0.0;
float wCausL = 0.0; vec3 wTfl = vec3(0.0);
vec3 wDbgV = vec3(0.0); vec3 wDbgFT = vec3(0.0);
float wNetHi = 0.0; float wNetDark = 0.0; vec3 wNetSky = vec3(0.0); float wGlintK = 0.0;
vec3 wDbgW = vec3(0.0); float wFloorVis = 0.0; float wDry = 1.0; float wHarbor = 0.0; vec3 wDbgFoam = vec3(0.0); vec3 wDbgSurf = vec3(0.0);

// threshold-dissolve foam: coverage 0 → nothing, 1 → solid; the lace network fills in from its strands outward.
// aa widens the transition with the pixel footprint (no dot grids / flecks at grazing angles)
float wtrFoamCov(float cov, float lace, float dens, float aa) {
  float thr = 1.0 - clamp(cov, 0.0, 1.0);
  return smoothstep(thr - 0.06 - aa, thr + 0.10 + aa, lace * 0.78 + dens * 0.22 + cov * 0.12);
}
// dense foam that opens into lace at its edges (contact foam at objects): coverage drives it directly, the lace and the
// density field only break its edge up — wtrFoamCov's threshold-dissolve leaves little more than strands below ~0.8
float wtrFoamFill(float cov, float lace, float dens, float aa) {
  return smoothstep(0.38 - aa, 0.62 + aa, cov + (lace - 0.45) * 0.5 + (dens - 0.5) * 0.35);
}
// foam / noise layers with explicit gradients (safe inside branches; ×1.6 mip bias against sparkle aliasing)
// (the footprint's anisotropy is clamped to 3:1 — at a grazing angle the full major axis picked a mip where the lace was
// averaged into a flat grey that the threshold-dissolve then erased: no foam at eye level beyond ~15 m. TAA settles
// the little aliasing this lets through along the view direction)
vec4 wtrFoamG(vec2 uv, vec2 dx, vec2 dy) {
  float lx = length(dx), ly = length(dy), mn = min(lx, ly) * 3.0;
  return WTR_TG(wtrTex2, vec3(uv, 0.0), dx * (1.2 * min(1.0, mn / max(lx, 1e-9))), dy * (1.2 * min(1.0, mn / max(ly, 1e-9))));
}
vec4 wtrNoiseG(vec2 uv, vec2 dx, vec2 dy) { return WTR_TG(wtrTex2, vec3(uv, 1.0), dx, dy); }
// BUBBLY foam (contact collars, rock / cliff surge): soft filled patches whose coverage follows cov, round
// bubble holes punched by the bubble channel (B), edges frayed by the density field and a little lace. Never the thin
// strand network the threshold-dissolve leaves at low coverage ("cracked glass / lightning lines")
float wtrBubbly(float cov, vec4 f, float aa) {
  float v = cov + (f.g - 0.5) * 0.5 + (f.r - 0.5) * 0.18 - f.b * 0.32;
  return smoothstep(0.45 - aa - 0.06, 0.62 + aa, v);
}
// 1D value noise in [0,1] (cheap: two hashes, no fetch)
float wtrVN1(float x) { float i = floor(x), f = fract(x); return mix(wtrH1(i + 1.7), wtrH1(i + 2.7), f * f * (3.0 - 2.0 * f)); }
float wtrHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// glitter cells: one sparkle in ~30 % of the cells, twinkling; cell size follows the pixel footprint (≈ 3 px)
float wtrSparkCell(vec2 p, float t) {
  vec2 c = floor(p), f = fract(p);
  float h = wtrHash(c), h2 = wtrHash(c + 17.31);
  vec2 ctr = vec2(0.2 + 0.6 * h2, 0.2 + 0.6 * fract(h * 7.31));
  float d = length(f - ctr);
  // (twinkle: a triangle wave per cell, no sin — perf)
  float ph = fract(t * (0.4 + 0.64 * h) + h * 6.37);
  float blink = max(0.0, 1.0 - abs(ph * 2.0 - 1.0) * 1.6);
  return smoothstep(0.3, 0.0, d) * step(0.7, h) * blink * blink;
}
// (one octave of cells at the footprint's power-of-two size — perf: the 2-octave blend doubled the hashing; a sparkle
// that pops between octaves at a distance step is just another twinkle)
float wtrSparkleAt(vec2 xz, float fp, float t) {
  return wtrSparkCell(xz / exp2(floor(log2(max(fp * 3.0, 0.04)) + 0.5)), t);
}
`;

// appended after <clipping_planes_pars_fragment> (right before main — after the atmos declarations)
export const FRAG_LATE_PARS = /* glsl */ `
// the water's sun shadow: the atmos cascades at ONE hardware-PCF tap each (the contact kernel's 4 taps are for crisp
// contact shadows on solid ground; on water a crane / hull shadow only tints the body — softer is better) + the far
// map + the cloud shadow. Falls back to the atmos getSunShadow when that layout is not present
#ifdef WTR_X_NOSHADOW
#define WTR_SUN_SHADOW( a, b, c ) 1.0
#elif defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0 && defined( SHADOWMAP_TYPE_PCF ) && defined( getSunShadow )
#ifdef WTR_VSHADOW
varying vec3 vWtrSh0;
varying vec3 vWtrSh1;
varying vec3 vWtrShF;
#define WTR_SH0 vec4( vWtrSh0, 1.0 )
#define WTR_SH1 vec4( vWtrSh1, 1.0 )
#define WTR_SHF vec4( vWtrShF, 1.0 )
#define WTR_SHDEPTH ( -vViewPosition.z )
#else
#define WTR_SH0 ( sunShadowMatrix[ 0 ] * vec4( vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * uAtmSunBias.z, 1.0 ) )
#define WTR_SH1 ( sunShadowMatrix[ 1 ] * vec4( vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * uAtmSunBias.w, 1.0 ) )
#define WTR_SHF ( uAtmFarMatrix * vec4( vSunShadowWorldPosition.xyz + vSunShadowWorldNormal * uAtmFarParams.y, 1.0 ) )
#define WTR_SHDEPTH vSunShadowWorldPosition.w
#endif
float wtrSunShadow( sampler2DShadow shadowMap, SunLightShadow s ) {
  float viewDepth = WTR_SHDEPTH, shadow = 1.0;
  vec4 c0 = sunShadowCascade[ 0 ], c1 = sunShadowCascade[ 1 ];
  if ( viewDepth < c0.y ) {
    shadow = atmPcf1( shadowMap, WTR_SH0, uAtmSunBias.x );
  } else if ( viewDepth < c1.y ) {
    shadow = mix( atmPcf1( shadowMap, WTR_SH1, uAtmSunBias.y ), 1.0, smoothstep( c1.z, c1.y, viewDepth ) );
  }
  float farFrom = c0.y * 1.2;
  if ( uAtmFarParams.w > 0.5 && viewDepth > farFrom ) {
    float fs = atmPcf1( uAtmFarMap, WTR_SHF, uAtmFarParams.x );
    shadow = min( shadow, mix( 1.0, fs, smoothstep( farFrom, farFrom * 1.8, viewDepth ) ) );
  }
  #if defined( ATMOS ) && defined( WTR_VATM )
  return mix( 1.0, shadow, s.shadowIntensity ) * vCloudSh;
  #else
  return mix( 1.0, shadow, s.shadowIntensity ) * atmosCloudShadow( vSunShadowWorldPosition.xyz );
  #endif
}
#define WTR_SUN_SHADOW( a, b, c ) wtrSunShadow( a, b )
#elif defined( USE_SHADOWMAP ) && NUM_SUN_LIGHT_SHADOWS > 0
#define WTR_SUN_SHADOW( a, b, c ) getSunShadow( a, b, c )
#endif
#ifdef ATMOS
// the sky as the sea reflects it: the atmos gradient with its huge sun halo scaled down (the halo's own reflection is
// the sun glitter; mirrored at full strength it greys the whole sea whenever the camera faces the sun)
vec3 wtrReflSky(vec3 d, float lift) {
  // stylised: the sea mirrors the saturated blue of the sky above the pale horizon band (the target art's water never
  // turns grey-lavender at grazing angles) — the elevation is lifted by lift before the gradient lookup
  float t = lift + (1.0 - lift) * clamp(d.y, 0.0, 1.0);
  vec3 c = mix(uAtmHorizon, uAtmMid, smoothstep(0.015, 0.42, t));
  c = mix(c, uAtmZenith, smoothstep(0.30, 0.90, t));
  float mu = max(dot(d, uAtmSunDir), 0.0);
  float m2 = mu * mu, m4 = m2 * m2, m12 = m4 * m4 * m4, m24 = m12 * m12;
  float halo = m12 * 0.30 + m24 * m24 * 0.70;
  return c + uAtmGlowColor * halo * uAtmGlow * wtrHaloRefl;
}
#endif
// the sky a steep ripple crest mirrors (no sun halo): the mid sky above the horizon band
vec3 wtrReflSkyHi(vec3 d) {
#ifdef ATMOS
  return mix(uAtmHorizon, uAtmMid, 0.55);
#else
  return vec3(0.55, 0.8, 1.0);
#endif
}
#ifdef WTR_SCENE
// SCREEN-SPACE REFLECTION: march the reflected ray through the opaque scene's depth copy (the huts, piles,
// boats, treeline and cliffs mirrored in the water at grazing angles). 20 steps growing ×1.3 (≈ 0.3 m → 400 m) + a
// 3-step binary refine; misses (sky, off-screen) keep the analytic sky reflection. rgb = scene radiance, a = weight
// (the Medium / Low tier — WTR_LITE — marches 9 growing steps + 3 refines instead of 20 + 3)
#ifdef WTR_LITE
#define WTR_SSR_N 9
#define WTR_SSR_G 1.65
#define WTR_SSR_R 3
#else
#define WTR_SSR_N 20
#define WTR_SSR_G 1.3
#define WTR_SSR_R 3
#endif
vec4 wtrSSRTrace(vec3 P, vec3 R, float dist) {
  if (wtrGrab.w < 0.5 || R.y < 0.002) return vec4(0.0);
  vec3 p = P;
  float st = 0.2 + dist * 0.012;
  vec2 huv = vec2(0.0);
  float hit = 0.0;
  for (int i = 0; i < WTR_SSR_N; i++) {
    vec3 q = p + R * st;
    vec4 c = wtrProj * (viewMatrix * vec4(q, 1.0));
    if (c.w <= 0.0) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
    float dz = c.w - wtrViewZ(texture2D(wtrSceneDepth, uv).r);
    if (dz > 0.0 && dz < st * 2.0 + 0.4) {
      vec3 a = p, b = q;
      for (int k = 0; k < WTR_SSR_R; k++) {
        vec3 m = (a + b) * 0.5;
        vec4 cm = wtrProj * (viewMatrix * vec4(m, 1.0));
        vec2 um = cm.xy / cm.w * 0.5 + 0.5;
        if (cm.w > wtrViewZ(texture2D(wtrSceneDepth, um).r)) b = m; else a = m;
      }
      vec4 cb = wtrProj * (viewMatrix * vec4(b, 1.0));
      huv = cb.xy / cb.w * 0.5 + 0.5;
      hit = 1.0;
      break;
    }
    p = q; st *= WTR_SSR_G;
  }
  if (hit < 0.5) return vec4(0.0);
  vec2 e = smoothstep(vec2(0.0), vec2(0.07), huv) * (1.0 - smoothstep(vec2(0.93), vec2(1.0), huv));
  return vec4(texture2D(wtrSceneCol, huv).rgb, e.x * e.y);
}
#endif
`;

/** the foam stack (swash, bore, run-up lace, backwash, breakers, surf crests, rock fringe, waterline rings, splashes):
 *  needs SURF_CORE + simFoam; leaves `foam` (0..1) and wFoam.
 *  PERF (measured 1.37 ms at eye level vs the 0.8 ms budget): every feature first computes its ENVELOPE from the fields alone (no
 *  texture work); the lace fetches run only where some envelope is non-zero — otherwise a flat beach would fetch 6-7
 *  textures over the whole 15 m surf band although a crest breaks in a few percent of it at any moment */
const FOAM_STACK = /* glsl */ `
  float foam = 0.0;
  // open water far from any shore, object or splash: nothing below can contribute — one test, then the whole stack
  // (its masks included) is skipped
  // (the shore band that can hold foam: ~16 m near the camera — swash, bore, breakers, rock fringe — and the 40 m band
  // of the far surf lines only where those exist, > ~220 m from the camera)
  // (churnK: coarse pixels — the harbor view, the aerial — see the wide churn around hulls, walls and sea stacks)
  float churnK = smoothstep(0.1, 0.5, sqrt(fp * fpMin));
  #ifdef WTR_NEAR
  bool anyFoam = shoreD < 16.0 || obst > 0.02 || obW > 0.45 || simFoam > 0.002 || wScC + wScLap > 0.002;
  #else
  bool anyFoam = shoreD < mix(16.0, 45.0, smoothstep(190.0, 220.0, dist)) || obst > 0.02 || obW * churnK > 0.02 || obW > 0.45 || simFoam > 0.002 || wScC + wScLap > 0.002;
  #endif
  #ifdef WTR_X_FOAMGATE
  anyFoam = anyFoam && wtrFoamAmount > 100.0;          // (profiling: the stack compiled in, never executed)
  #endif
  #ifdef WTR_FOAMPASS
  if (!anyFoam) discard;
  #endif
  if (anyFoam) {
    float quiet = 1.0 - calm * 0.9;
    // along-shore variation, 5-20 m (edge widths, coverage, gaps): per vertex near the camera, per pixel from the air
    // (per PIXEL everywhere — per vertex, thresholded into gaps / band widths, it cut the swash lace into pills
    //  with straight oblique ends along the clipmap triangles)
    vec4 nS = wtrNoiseG(xz / 13.0 + vec2(0.21, 0.77), gx / 13.0, gy / 13.0);
    float vary = smoothstep(0.3, 0.72, nS.r), vary2 = smoothstep(0.3, 0.7, nS.b);
    float steep = smoothstep(0.3, 0.8, shoreSteep) * (1.0 - calm);

    // ---------- ENVELOPES (fields + noise only)
    // swash edge, bore, run-up lace, backwash, second lace line — near the real shore only (on a mm-flat tidal shelf toLine
    // stays small for tens of metres: toMax keeps the stack off it)
    bool mSwash = toLine < 4.6 && toMax > -1.5 && quiet > 0.2 && shoreD < 8.0 && farMix < 0.99;
    // near surf: each crest breaks where the water is shallower than wtrBreakDepth, in 10-30 m sections with gaps; only
    // the crest window (lip u > 0.9, whitewater + trail u < 0.36) holds foam
    float surfNear = smoothstep(0.04, 0.18, dT) * (1.0 - smoothstep(wtrBreakDepth * 1.1, wtrBreakDepth * 1.45, dT)) * (1.0 - smoothstep(11.0, 15.0, shoreD));
    float sph = psi + shoreD / wtrSurfLen, u = fract(sph);
    float crestId = floor(sph + 0.1);                                          // lip (u > 0.9) + its whitewater share one id
    // (THE WRECK's lagoon is sheltered by the reef and the hulls: calm, clear water with foam only at the shore and the
    // objects — otherwise a white sandbar smear crossed the lagoon at wade height)
    float brkK = smoothstep(wtrBreakDepth * 1.15, wtrBreakDepth * 0.6, dT) * surfNear * (1.0 - farMix) * quiet * wtrSurf * (1.0 - lagoon);
    bool mSurfN = brkK > 0.002 && (u > 0.9 || u < 0.23);
    float setAmp = 0.5;
    vec2 shoreN = shoreNP;                                                      // toward open water (16-bit, smooth)
    vec2 shoreT = vec2(-shoreN.y, shoreN.x);
    float along = dot(xz, shoreT);
    if (mSurfN) {
      setAmp = wtrSetAmp(crestId);
      // breaking sections along the crest (a 1D value noise hashed per crest — no fetch): 10-30 m long, ~55 % of the crest
      float sectN = wtrVN1(along / 21.0 + crestId * 7.31) * 0.65 + wtrVN1(along / 7.0 - crestId * 3.7) * 0.35;
      brkK *= smoothstep(0.36, 0.52, sectN * 0.8 + setAmp * 0.25 + vary2 * 0.1);
      mSurfN = brkK > 0.002;
    }
    // from the air: 2-3 broken crest lines in the 3-40 m band off every sloping beach (never along quays / cliffs / the
    // dredged harbor)
    float surfFar = smoothstep(3.0, 7.0, shoreD) * (1.0 - smoothstep(26.0, 40.0, shoreD)) * smoothstep(220.0, 520.0, dist)
                  * (1.0 - smoothstep(5.0, 9.0, dT)) * (1.0 - harbor) * (1.0 - smoothstep(0.3, 0.6, slope)) * quiet * wtrSurf * farMix;
    bool mSurfF = surfFar > 0.001 && (u > 0.9 || u < 0.34);
    if (mSurfF) setAmp = wtrSetAmp(crestId);
    bool mBandA = farMix > 0.01 && shoreD < 18.0 && shoreD > -0.3;
    #ifdef WTR_NEAR
    mSurfF = false; mBandA = false;                           // (the near program — camera < ~40 m — has no air-only code)
    #endif
    bool mFr = steep > 0.04 && shoreD < 7.5 && shoreD > -0.8;
    #ifndef WTR_UNDER
    bool mRing = obst > 0.02 && wtrContact > 0.0;             // waterline rings (hulls, walls, piles, rocks, containers)
    #ifdef WTR_NEAR
    bool mChurn = false;
    #else
    bool mChurn = obW * churnK > 0.02 && wtrContact > 0.0;    // from the air: the white water around them
    #endif
    #else
    bool mRing = false, mChurn = false;
    #endif
    // SURGE on big exposed objects in open water (sea stacks, big rocks): the wide proximity (≥ ~5 m objects)
    // (from 0.3 m — the cliff feet stand in < 1.2 m of water where the terrain rises under the rock face, and got no
    // surge at all at eye level)
    float surgeX = (1.0 - calm) * (1.0 - lagoon) * (1.0 - 0.75 * harbor) * smoothstep(0.3, 1.5, dT) * wtrContact;
    #ifdef WTR_UNDER
    surgeX = 0.0;
    #endif
    bool mSurge = surgeX > 0.01 && obW > 0.45;
    #ifdef WTR_X_NOSWASH
    mSwash = false;
    #endif
    #ifdef WTR_X_NOSURF
    mSurfN = false; mSurfF = false; mBandA = false;
    #endif
    #ifdef WTR_X_NOFR
    mFr = false;
    #endif
    #ifdef WTR_X_NORING
    mRing = false;
    #endif
    bool mShore = mSwash || mSurfN || mSurfF || mBandA || mFr;
#ifdef WTR_DEBUG
    wDbgSurf = vec3(surfNear, surfFar, dT / 4.0);
    if (wtrDebug > 17.5) wDbgSurf = vec3(mSwash ? 1.0 : 0.0, (mSurfN || mSurfF) ? 1.0 : 0.0, (mRing ? 1.0 : 0.0) + (simFoam > 0.002 ? 0.5 : 0.0)) * 0.8 + 0.2;
    if (wtrDebug > 18.5) wDbgSurf = vec3(clamp(shoreD / 20.0, 0.0, 1.0), mBandA ? 1.0 : 0.0, mFr ? 1.0 : 0.0);
    if (wtrDebug > 19.5) wDbgSurf = vec3(clamp(shoreD / 20.0, 0.0, 1.0), clamp(dT / 4.0, 0.0, 1.0), steep);
    if (wtrDebug > 20.5) wDbgSurf = vec3(shoreD < 9.5 ? 0.0 : 1.0, shoreD < 9.5 ? 1.0 : 0.0, dT > 1.0 ? 1.0 : 0.0);
    if (wtrDebug > 21.5) wDbgSurf = vec3(u, clamp(shoreD / 20.0, 0.0, 1.0), brkK);
#endif
    bool foamPossible = mShore || mRing || mChurn || mSurge || simFoam > 0.002 || wScC + wScLap > 0.002;
  #ifdef WTR_FOAMPASS
  if (!foamPossible) discard;                                   // no foam feature here: nothing more to do in this pass
  #endif
    #ifdef WTR_X_NOFOAM
    foamPossible = false;
    #endif
    if (foamPossible) {
      // (screen derivatives from the xz footprint — no dFdx inside this branch: shoreD is a distance field, its gradient
      // is the unit shore normal)
      vec2 gAl = vec2(dot(gx, shoreT), dot(gy, shoreT)), gSh = vec2(dot(gx, shoreN), dot(gy, shoreN));
      float pxSh = max(length(gSh), 1e-4);                         // metres of shore distance per pixel (line widths)
      float drift = wtrTime;
      float fpG = sqrt(fp * fpMin);                                  // geometric-mean footprint (m / px)
      // ---- the isotropic lace network AT THE SCALE THE PIXEL RESOLVES (3.4 m near, 13.6 m once its ~0.5 m cells shrink
      //      under ~8 px, 26 m from the air) — only for the features that use it (rings, rock fringe, breakers, splashes,
      //      the aerial surf); the swash has its own shore-aligned lace
      vec4 fL = vec4(0.5);
      float aa = 0.3;
      if (mRing || mChurn || mSurge || mFr || mSurfN || mSurfF || mBandA || simFoam > 0.002 || wScC + wScLap > 0.002) {
        float laceMix = smoothstep(220.0, 380.0, dist);
        float midMix = smoothstep(0.05, 0.12, fpG) * (1.0 - laceMix);
        float wA = (1.0 - midMix) * (1.0 - laceMix);
        vec4 fA = vec4(0.5), fC = vec4(0.5);
        // (from the air — ≥ ~0.5 m per pixel — the 26 m layer's 1-4 m cells average into flat grey under the mip
        // filter, and the threshold-dissolve then filled every ring / churn into an opaque white "fried egg". The aerial
        // gets a 46 m layer whose 3-6 m cells resolve as crisp 1-2 px strands with open holes: the target art's lace)
        float kAer = smoothstep(0.42, 0.85, fpG) * laceMix;
        if (wA > 0.001) fA = wtrFoamG(xz / 3.4 + drift * vec2(0.010, 0.006), gx / 3.4, gy / 3.4);
        if (midMix > 0.001) fC = wtrFoamG(xz / 13.6 + vec2(0.37, 0.61) + drift * vec2(0.004, 0.0025), gx / 13.6, gy / 13.6);
        else if (laceMix > 0.001) {
          if (kAer < 0.999) fC = wtrFoamG(xz / 26.0 + drift * vec2(0.002, -0.0015), gx / 26.0, gy / 26.0);
          if (kAer > 0.001) fC = mix(fC, wtrFoamG(xz / 46.0 + vec2(0.29, 0.53) + drift * vec2(0.0012, -0.0008), gx / 46.0, gy / 46.0), kAer);
        }
        float kC = midMix + laceMix;                                   // (the C slot holds the 13.6 m, 26 m or 84 m layer)
        fL = mix(fA, fC, kC);
        aa = min(0.3, 2.5 * fpG / mix(3.4, mix(13.6, mix(26.0, 46.0, kAer), laceMix), kC));
      }
      float lace = fL.r, dens = fL.g;
      if (mShore) {
        // shore-aligned lace (strands along the beach): 2.6 × 0.9 m near, ×4 once that no longer resolves
        float sK = smoothstep(0.05, 0.12, fpG);
        // (+ a slow along-shore phase warp from the 13 m noise — the 2.6 m lace tile repeated visibly)
        vec2 sUV = vec2(along / 2.6 + nS.r * 2.3 + nS.g * 1.1, shoreD / 0.9) + vec2(0.0, -drift * 0.02);
        vec4 fS = vec4(0.5);
        if (sK < 0.999) fS = wtrFoamG(sUV, vec2(gAl.x / 2.6, gSh.x / 0.9), vec2(gAl.y / 2.6, gSh.y / 0.9));
        if (sK > 0.001) fS = mix(fS, wtrFoamG(sUV * 0.25 + vec2(0.43, 0.17), vec2(gAl.x / 10.4, gSh.x / 3.6), vec2(gAl.y / 10.4, gSh.y / 3.6)), sK);
        float aaS = clamp(2.5 * fpG / mix(2.6, 10.4, sK), 0.06, 0.3);   // (≥ 0.06 — no stair-stepped pixel speckle)
        if (mSwash) {
          // metres seaward of the live waterline, wobbled (the edge wanders with the along-shore noise + the lace)
          float jit = ((nS.g - 0.45) * 0.55 + (fS.b - 0.5) * 0.2) * (1.0 - farMix);
          float tl = toLine - jit;
          // (both CONTINUOUS across the cycle wrap ψ 1 → 0 — the wrap is a line across the beach where the next bore
          //  arrives; upr(0) = 1 vs upr(1) = 0 switched the bore + lace on in a straight-edged block)
          float upr = smoothstep(0.0, 0.06, psi) * (1.0 - smoothstep(0.06, 0.4, psi));   // the uprush (a fresh bore arrives)
          float drain = smoothstep(0.3, 0.9, psi) * (1.0 - smoothstep(0.93, 1.0, psi));
          // (a) CONTACT LINE right at the live edge, in EVERY phase of the swash: the target art's bright white line —
          //     dense, 0.12-0.35 m (never under ~2.5 px), broken by holes and short gaps, never a clean stroke
          // (2-4 px, BROKEN: a continuous line reads as a solid 10 px white stroke along the whole beach at 4K, a thinner
          //  one as a hairline)
          float cW = max(mix(0.12, 0.3, vary) * (1.0 + 0.5 * upr), 2.4 * pxSh);
          float cL = (1.0 - smoothstep(cW * 0.5, cW, abs(tl - cW * 0.3))) * quiet;
          float gapC = smoothstep(0.2, 0.42, nS.a * 0.6 + fS.g * 0.55);             // ~20 % short gaps along the line
          // real holes: 0.5-3 m pieces missing along the shore (a 1D noise along it, two scales)
          // (thinner spots, not holes: a continuous lip)
          cL *= mix(0.55, 1.0, smoothstep(0.22, 0.36, nS.a * 0.45 + fS.g * 0.35 + fS.a * 0.3));
          // (+ COARSE gaps, 5-15 m, at every distance — from a POI camera 150-200 m out the small holes averaged away
          //  and the shore read as one continuous stroke, e.g. at the WRECK BAY cove)
          float bigGap = smoothstep(0.24, 0.5, wtrVN1(along / 11.0 + 3.7) * 0.7 + wtrVN1(along / 4.3 + 1.1) * 0.3);
          // (the coarse gaps are for the far POI views — near the eye they chopped the swash into pills)
          bigGap = mix(1.0, bigGap, smoothstep(35.0, 110.0, dist) * 0.85 + 0.15);
          cL *= mix(0.12, 1.0, bigGap);
          // (near the camera a bubbly line with holes, a dense white line from further away)
          foam += wtrFoamCov(cL * (mix(0.56, 0.8, gapC) + 0.16 * smoothstep(8.0, 35.0, dist)), max(fS.r, fS.b), fS.g, aaS * 0.7) * cL;
          // (a2) LACE BAND behind it: 0.6-2.2 m of stringy lace with holes (strands parallel to the shore), thinning
          //      seaward — wider while the uprush arrives, never gone while it drains. Threshold-dissolve only: no filled
          //      pale strip
          // (the 10-px floor is capped at 3 m — looking ALONG a beach pxSh is metres, and the band spread the shore-
          //  aligned lace over 10+ m of shallows as a stair-stepped white "brick lattice")
          // (0.6-1.8 m — with the longer run-up a 1-2.8 m band lay as a 2-4 m cream sheet over the wet sand)
          float lW = max(mix(0.6, 1.8, vary) * (0.85 + 0.45 * upr), min(10.0 * pxSh, 3.0));
          float lq = clamp((tl - cW * 0.5) / lW, 0.0, 1.0);
          float lz = smoothstep(-0.05, cW * 0.5, tl) * (1.0 - lq * lq) * quiet * (1.0 - farMix) * mix(0.4, 1.0, bigGap)
                   // (on a flat shelf toLine stays small for many metres — the band also ends in real shore distance)
                   * (1.0 - smoothstep(1.5 + lW, 3.0 + lW, shoreD))
                   // (… and in real water depth: toLine = depth / a clamped slope, so on a flat shelf a few cm deep the band
                   //  covered 10+ m — the crate view's white brick lattice)
                   * (1.0 - smoothstep(0.14, 0.32, liftNow - tHs));
          // (threshold-dissolve: ~0.5 leaves stringy strands with holes near the camera; far away the strands average
          //  out, so the coverage climbs with distance to keep the band reading white — denser near the camera reads as
          //  a cream smear)
          // (the target art's swash band is a bright web of strands: 0.52 left scattered specks)
          // (but at 12-45 m only +0.07: +0.18 filled the band into opaque cream "pills")
          float lCov = mix(mix(0.56, 0.7, vary2), mix(0.3, 0.42, vary), lq) + 0.08 * upr + 0.07 * smoothstep(12.0, 45.0, dist);
          // (the shore lace alone — 'lace' is a flat 0.5 unless a ring / surf feature fetched it, and mixing it in
          //  flattened the strands into milky blobs)
          foam += wtrFoamCov(lz * lCov, max(fS.r, fS.b * 0.75), fS.g, max(aaS, 0.06)) * lz;
          // (a3) a SECOND lace line 1.2-3 m out: the last uprush's foam drifting back (the target art's double shoreline)
          float l2d = mix(1.1, 2.8, vary2) * (0.75 + 0.45 * drain);
          float l2W = max(0.14 + 0.18 * vary, 2.0 * pxSh);
          // (broken into 2-8 m pieces along the shore: unbroken, the line reads as a drawn stroke along the whole beach)
          float l2 = exp(-pow((tl - l2d) / l2W, 2.0)) * quiet * smoothstep(0.3, 0.55, nS.r * 0.55 + fS.g * 0.5) * (1.0 - farMix)
                   * smoothstep(0.34, 0.56, nS.b * 0.6 + fS.a * 0.4);
          foam += wtrFoamCov(l2 * 0.72, max(fS.r, fS.b * 0.8), fS.g, aaS) * l2;
#ifdef WTR_DEBUG
          if (wtrDebug > 28.5) wDbgFT = vec3(cL, lz, l2);
          else wDbgFT.r = foam;
#endif
          // (b) the uprush bore: fizzing lace behind the arriving wave, 0..4 m seaward of the live line, early in the cycle
          float bore = (1.0 - smoothstep(0.0, 1.0 + 3.0 * (1.0 - psi * 3.0), toLine)) * upr * step(0.0, toLine) * quiet * (0.45 + 0.55 * vary2);
          foam += wtrFoamCov(bore * 0.62, max(fS.r, fS.b * 0.7), fS.g, aaS) * bore;
          // (c) the run-up lace: a thin lacy line left at the highest reach, fading as the swash drains
          float lineMax = exp(-pow((toMax - 0.15 - jit * 0.5) / 0.26, 2.0)) * wetZone * quiet * (0.35 + 0.65 * (1.0 - smoothstep(0.3, 0.95, psi))) * smoothstep(0.0, 0.12, psi) * (0.4 + 0.6 * vary);
          foam += wtrFoamCov(lineMax * 0.58, fS.r, fS.g, aaS) * lineMax * nearF;
          // (d) backwash streaks: stringy foam dragged seaward across the swash zone while it drains (one gated fetch)
          float swashZone = smoothstep(-0.2, 0.3, toLine) * (1.0 - smoothstep(1.0, 4.0, toLine)) * quiet * (1.0 - smoothstep(30.0, 45.0, dist));
          float streaks = swashZone * smoothstep(0.25, 0.55, psi) * (1.0 - smoothstep(0.75, 1.0, psi));
          if (streaks > 0.01) {
            vec4 fK = wtrFoamG(vec2(shoreD / 3.2, along / 0.45) + vec2(drift * 0.03, 0.0), vec2(gSh.x / 3.2, gAl.x / 0.45), vec2(gSh.y / 3.2, gAl.y / 0.45));
            foam += wtrFoamCov(streaks * 0.5, fK.a * 0.7 + fK.r * 0.3, fK.g, aaS) * streaks;
          }
#ifdef WTR_DEBUG
          if (wtrDebug < 28.5) wDbgFT.g = foam - wDbgFT.r;
#endif
        }
        // (a2) from the air: the surf zone's whitewater as a broad lacy band along every sandy beach (7-18 m wide, dense at
        //      the sand, thinning seaward, broken into sections) — never a 1-px line
#ifndef WTR_NEAR
        if (mBandA) {
          float beachK = (1.0 - harbor) * (1.0 - steep) * (1.0 - smoothstep(0.3, 0.6, slope)) * quiet * wtrSurf;
          float wB = mix(7.0, 18.0, vary) * farMix;
          float bandA = (1.0 - smoothstep(wB * 0.25, wB, shoreD)) * smoothstep(-0.3, 0.4, shoreD) * beachK * farMix;
          float covA = mix(0.4, 0.78, vary2) * (1.0 - 0.55 * clamp(shoreD / wB, 0.0, 1.0));
          foam += wtrFoamCov(bandA * covA, mix(lace, fS.r, 0.35), dens, aa) * bandA;
        }
#endif
        // (e) breaking waves: crests run shoreward parallel to the beach; each wave of a set has its own height and breaks
        //     in sections that peel along the crest
        float laceS = mix(fS.r, lace, 0.4);
        if (mSurfN) {
          // NEAR (eye level): a bright white lip spilling down the front face, a turbulent whitewater BORE 1.5–3 m wide
          // behind it that rides all the way in and becomes the uprush, a lacy trail after. Crisp threshold-dissolve lace
          // (never a soft cream ribbon at 30-60 m)
          float lipW = max(0.035, 2.2 * pxSh / wtrSurfLen);
          float lip = smoothstep(1.0 - lipW, 0.992, u) + 1.0 - smoothstep(0.0, 0.012 + 0.5 * pxSh / wtrSurfLen, u);
          float ww = (1.4 + 1.6 * setAmp) / wtrSurfLen;                                      // whitewater band (m → u)
          float wu = clamp(u / ww, 0.0, 1.0);
          // (the seaward edge of the bore is ragged: its width wanders with the lace + along-shore noise)
          float rag = (fS.g - 0.5) * 0.5 + (vary - 0.5) * 0.35;
          float whiteR = (1.0 - smoothstep(0.45, 1.0, wu + rag * 0.6)) * step(u, 0.5);
          float aaB = aaS * 0.9;
          foam += wtrFoamCov(brkK * (0.62 + 0.2 * smoothstep(15.0, 50.0, dist)), max(laceS, fS.b * 0.7), fS.g, aaB) * brkK * min(lip, 1.0);
          // (the bore's BODY is bubbly whitewater — soft patches opening into holes as it thins — not the strand network
          //  the threshold-dissolve leaves below ~0.5 coverage, which read as a stair-stepped white "brick lattice" over
          //  10+ m of the shallows. A faint lacy trail stays at its thin end)
          float boreC = brkK * (mix(0.85, 0.2, wu) + 0.15 * smoothstep(15.0, 50.0, dist));
          foam += wtrBubbly(boreC, fL, min(0.35, aaB + 0.08)) * brkK * whiteR;
          foam += wtrFoamCov(boreC * 0.35, mix(laceS, lace, 0.5), fS.g, aaB) * brkK * whiteR * 0.35 * smoothstep(0.4, 0.9, wu);
        }
#ifndef WTR_NEAR
        if (mSurfF) {
          // FROM THE AIR: 2–3 parallel broken crest lines in the 3–40 m band, each a lip + a broad lacy whitewater band
          float peel = textureLod(wtrTex2, vec3(vec2(along / 95.0 + crestId * 0.371 + u * 0.05, crestId * 0.137), 1.0), 0.0).g;
          float lipW = max(0.045, 2.5 * pxSh / wtrSurfLen);
          float lip = smoothstep(1.0 - lipW, 0.99, u) * (1.0 - smoothstep(0.995, 1.0, u) * 0.3);
          float wWide = max(0.06, lipW) + 0.3 * farMix;
          float white = 1.0 - smoothstep(0.0, wWide, u);
          float whiteCov = 0.78 * (1.0 - 0.6 * clamp(u / wWide, 0.0, 1.0));
          float peak = smoothstep(0.36, 0.7, peel * 0.75 + setAmp * 0.4);
          // gaps along each crest line (from the air the lines must read broken, never as strokes)
          float gaps = mix(1.0, smoothstep(0.32, 0.6, vary2 * 0.5 + nS.a * 0.5 + peel * 0.3), 0.85);
          float brk = surfFar * peak * setAmp * gaps;
          foam += wtrFoamCov(brk * 0.74, laceS, fS.g, aaS) * brk * lip;
          foam += wtrFoamCov(brk * whiteCov, mix(laceS, lace, 0.6), fS.g, aaS) * brk * white;
        }
#endif
        // (f) steep shores (rocks, headlands, cliff feet, sea stacks): surf breaking on rock — a dense white line at the
        //     rock with a pulsing lace fringe 2–7 m wide
        if (mFr) {
          // SURGE on rock: every swell that reaches a steep shore — a cliff foot, a sea stack, a headland, a
          // rock in the surf — piles up against it and bursts into a thick white wash 2-6 m wide on the faces turned to
          // the swell, then drains back as bubbly patches. Soft BUBBLY foam (filled patches, round holes, frayed edges),
          // never the lace network's thin strands ("white cracked-glass / lightning lines" at every rock)
          // (the lee faces keep a real wash too — white water at EVERY cliff foot;
          // a 0.25 floor left a 1-3 px line along the leeward cliff base at eye level)
          float windF = mix(0.55, 1.0, smoothstep(-0.3, 0.6, dot(shoreN, -vec2(${WD0}))));
          // the swell's arrival here: a fast surge up, a slow drain (per coast position, not in lock-step)
          float psiR = fract(wtrTime / (wtrPeriod * 1.2) + vPhase * 1.7 + dot(xz, vec2(-0.004, 0.011)));   // (= the surge + the spray bursts: spray.ts)
          float surgeT = psiR < 0.16 ? smoothstep(0.0, 0.16, psiR) : 1.0 - smoothstep(0.16, 0.95, psiR);
          float frW = (1.6 + 4.4 * windF * (0.55 + 0.45 * vary)) * (0.55 + 0.6 * surgeT);
          float farF = smoothstep(0.4, 2.0, fp);
          float gapF = smoothstep(0.25, 0.6, nS.g * 0.6 + fS.g * 0.4);
          float dR = max(shoreD, 0.0) + (nS.b - 0.5) * 0.8;                  // (the wash edge wanders along the rock)
          // right at the rock: a dense churning band (0.4-1.6 m), wider windward
          float fIn = steep * (1.0 - smoothstep(0.0, max(mix(0.4, 1.6, windF), 1.5 * pxSh), dR)) * smoothstep(-0.6, 0.1, shoreD)
                    * mix(mix(0.7, 1.0, windF), windF * (0.35 + 0.65 * gapF), farF);
          // the surge wash: dense at the rock, bubbly patches opening outward, pulsing with each swell
          float tq = clamp(dR / max(frW, 0.3), 0.0, 1.0);
          float fringe = steep * (1.0 - smoothstep(0.55, 1.0, tq)) * smoothstep(-0.6, 0.1, shoreD) * mix(0.6, 1.0, windF) * (0.45 + 0.55 * gapF);
          float bAq = min(0.35, 2.0 * fpG);
          foam += wtrBubbly(fIn * 0.92, fL, bAq) * fIn;
          foam += wtrBubbly(fringe * mix(0.88, 0.3, tq) * (0.6 + 0.4 * surgeT), fL, bAq) * fringe;
          // + a thin lacy trail drifting off the wash (draining foam), only near the camera
          float trail = steep * windF * smoothstep(0.7, 1.0, tq) * (1.0 - smoothstep(1.0, 1.6, dR / max(frW, 0.3))) * (1.0 - farF) * (1.0 - surgeT * 0.5);
          foam += wtrFoamCov(trail * 0.5, lace, dens, aa) * trail * 0.7;
        }
      }
      #ifndef WTR_UNDER
#ifdef WTR_DEBUG
      if (mShore && wtrDebug < 28.5) wDbgFT.b = foam - wDbgFT.r - wDbgFT.g;
#endif
      // (g) WATERLINE RINGS at anything piercing the surface — hulls, quay walls, piles, rocks, containers (the baked
      //     proximity, every distance) + shapes other areas registered. Like the target art's quay / hull / rock foam:
      //     a broken bubbly contact line, WISPS OF LAPPING FOAM parallel to the object that drift outward (reflected
      //     wavelets), a broad white wash at convex points (a bow, rock points, container corners) and on the windward
      //     face; patchy from the air — never a uniform stroke, a white disc or a square
      if (mRing) {
        vec4 nR = wtrNoiseG(xz / 5.0 + vec2(0.13, 0.71), gx / 5.0, gy / 5.0);   // along-object variation (~2-5 m)
        vec4 nR2 = wtrNoiseG(xz / 1.7 + vec2(0.61, 0.27) + wtrTime * vec2(0.02, -0.013), gx / 1.7, gy / 1.7);  // finer breakup
        // "from the air": coarse pixels, or simply far away (the 4K aerial resolves ~0.6 m/px from 1.5 km)
        float farK = max(smoothstep(0.5, 3.0, fp), smoothstep(250.0, 800.0, dist));
        float calmR = (1.0 - 0.2 * calm) * (1.0 - 0.8 * murk) * min(wtrContact, 1.0);                   // (lagoon piles keep their collar)
        // (THE WRECK's sheltered lagoon: lapping lace only — no surf wash at container corners, which made filled white
        // "fried eggs" around the half-sunk containers)
        float shelter = 1.0 - 0.75 * lagoon;
        // the gradient (which way is away from the object; the swell arrives from -W_D[0], so the windward face gets the
        // surf, the lee side a thin line) …
        // (central differences over ±1.2 m: a smooth direction, no texel-scale spokes)
        #define WTR_OB(p) texture2D(wtrObstacle, vec2((p).x * wtrObstacleScale + 0.5, 0.5 - (p).y * wtrObstacleScale)).r
        float oE = WTR_OB(xz + vec2(1.2, 0.0)), oW = WTR_OB(xz - vec2(1.2, 0.0));
        float oS = WTR_OB(xz + vec2(0.0, 1.2)), oN = WTR_OB(xz - vec2(0.0, 1.2));
        vec2 gO = vec2(oE - oW, oS - oN);
        float gl = length(gO);
        vec2 away = gl > 1e-4 ? -gO / gl : vec2(1.0, 0.0);
        vec2 perp = vec2(-away.y, away.x);
        // … and the curvature of the ring = the second derivative of the distance ALONG the ring (±1.5 m): ~1/(r + d) at a
        // bow, a rock point or a container corner, 0 along a straight quay wall or hull side (tangent samples keep their
        // distance, so the object's saturated interior never fakes a tip)
        float oA = WTR_OB(xz + perp * 1.5), oB = WTR_OB(xz - perp * 1.5);
        // … and the object's SIZE: 2 m further toward it, a wall / hull / big rock is still solid; a pile, a post or a
        // small rock is already behind us (small objects get a broken lace collar of 0.2-0.6 m, never a flat white pad or
        // the dense tip wash)
        float big = smoothstep(0.8, 0.97, WTR_OB(xz - away * 2.0));
        #undef WTR_OB
        // (… or LONG: a quay wall or a hull side bakes as a thin sheared strip (its deck is above the waterline slab), so
        // 2 m "into" it is empty again and the depth test above called every wall small — the quay and the ship got no
        // foam. Along the object (±1.5 m tangentially) a wall keeps its proximity, a pile or a post loses it)
        big = max(big, smoothstep(0.74, 0.95, max(oA, oB) / max(obst, 0.05)) * smoothstep(0.25, 0.5, obst));
        float kappa = -(oA + oB - 2.0 * obst) * 4.7 / 2.25;
        float tip = smoothstep(0.3, 0.75, kappa) * step(1e-4, gl) * big;
        float wind = mix(0.3, 1.0, smoothstep(-0.35, 0.55, dot(away, -vec2(${WD0})))) * step(1e-4, gl);
        float along2 = dot(xz, perp);
        // metres from the object — wobbled by up to ±0.5 m from the air, so a ring never prints a clean offset copy of a
      // square rock or a sea stack's silhouette
      float dObj = max((1.0 - obst) * 4.7 + (nR.r - 0.5) * mix(0.25, 0.6, farK), 0.0);
        float fpR = sqrt(fp * fpMin);
        // along-object patches: 20-60 % coverage with holes and gaps — never a drawn stroke along a quay or a hull
        float patchN = nR.a * 0.5 + nR.g * 0.25 + nR2.g * 0.25;
        float gapsR = smoothstep(0.42, 0.6, patchN + 0.25 * tip);
        float hv = smoothstep(0.25, 0.75, nR.b * 0.6 + nR2.r * 0.4);
        // INSIDE an object's footprint (covered bake texels, obst ≈ 1): the water there shows between the parts of a low,
        // bumpy object — a banana heap, a rock pile, a half-sunk container's rim — and must not fill with foam (no
        // filled white "fried eggs" in the wreck lagoon). The ring peaks at the footprint's EDGE
        // (+ a SATURATED region — obst high with a flat gradient over ±1.2 m — is a footprint too: a heap of partly covered
        //  texels never reaches exactly 1)
        float inside = max(smoothstep(0.962, 0.995, obst), smoothstep(0.84, 0.93, obst) * (1.0 - smoothstep(0.06, 0.2, gl)));
        float touch = smoothstep(0.1, 0.35, obst) * (1.0 - 0.85 * inside);
        // (1) contact: a thin, broken bubbly line right at the object (0.1-0.45 m, wider at tips)
        // (metres of object distance per pixel, across the ring: at eye level a 0.3 m line is < 1 px tall — keep ≥ ~1.6 px)
        float pxD = max(abs(dot(gx, away)), abs(dot(gy, away)));
        // (never wider than ~0.6 m — at a grazing 8 m-high view a ≥ 1.6 px rule widened it to 1.2 m of solid
        // white: flat "pads" in front of objects. A line thinner than a pixel fades instead)
        // (piles, posts, ladders, roots — small objects — wear a 0.2-0.45 m bubbly collar; walls / hulls stay thin)
        float lineWr = mix(mix(0.2, 0.45, hv), mix(0.1, 0.28, hv), big) * mix(1.0, 1.5, tip) + 0.25 * fpR;
        // (long walls and hulls — big — keep a band of ≥ ~2.5 px of broken lace from any distance: at the harbor view's
        // distance the 0.6 m cap made it sub-pixel and it faded out, the quay and the ship had no foam at all. Small objects
        // stay thin and fade, never a pad)
        // (the ≥ 2.6 px band only once the pixels are coarse — the harbor view's distance, the air — never up close)
        float bigFar = big * smoothstep(0.12, 0.35, pxD);
        float lineW = min(max(lineWr, mix(1.1, 2.6, bigFar) * pxD), mix(0.6, 1.8, bigFar));
        float lineFade = mix(min(1.0, 1.3 * lineWr / max(pxD, 1e-4)), 1.0, bigFar);
        float gapsL = smoothstep(0.42, 0.56, patchN * 0.7 + dens * 0.3 + 0.2 * tip);  // the contact line has holes too
        // (the bake's 0.59 m texels + its shear put the object's edge up to ~0.2 m off: the line starts there)
        float dC = max(dObj - 0.2, 0.0);
        float rLine = (1.0 - smoothstep(lineW * 0.4, lineW, dC)) * touch * gapsL * calmR * lineFade;
        // from the air the contact line survives on the windward face only, in patches (a full outline printed every
        // square sea stack / rock as a white "□")
        rLine *= mix(1.0, (0.55 + 0.45 * smoothstep(0.4, 0.95, wind)) * smoothstep(0.3, 0.52, patchN + 0.15 * tip), farK);
        // (a dense, bubbly fill right at the object — the lace alone is mostly holes)
        // (a bubbly line with holes up close, denser from afar where the lace no longer resolves)
        // (the LACE drives the dissolve — max(lace, noise) filled every hole with the smooth noise: solid pads)
        foam += wtrBubbly(rLine * (mix(0.58, 0.78, hv) * mix(1.0, 0.85, big) * mix(0.75, 1.0, shelter) + 0.1 * farK), fL, min(0.35, aa)) * rLine * (1.0 - 0.65 * farK);
        // (2) lapping wisps: wall-aligned streaky lace (u along the object, v across it) drifting outward as the reflected
        //     wavelets leave the wall; 0.9-2.6 m reach (windward / tips wider), thinning outward, gapped along the object
        float reach = min(max(mix(0.9, 2.6, max(wind * (0.4 + 0.6 * hv), tip)) * wtrContactW / 0.9 * mix(0.45, 1.0, big), 4.0 * pxD), 3.6);
        float lapPh = dObj / 1.3 - wtrTime * 0.3 + nR.r * 1.7;
        vec2 wUV = vec2(along2 / 5.5, lapPh * 0.5);
        vec2 wdx = vec2(dot(gx, perp) / 5.5, dot(gx, away) / 2.6), wdy = vec2(dot(gy, perp) / 5.5, dot(gy, away) / 2.6);
        vec4 fW = wtrFoamG(wUV, wdx, wdy);
        // (calm lagoon water seen from the air — rows of stilt piles bake into lines, and their wisps / wall wash
        // printed smeared white dashes over the Stilt Town lagoon: none there, the contact collar only)
        float calmAir = 1.0 - 0.95 * calm * farK;
        float wEnv = (1.0 - smoothstep(reach * 0.25, reach, dObj)) * touch * calmR * smoothstep(0.3, 1.2, reach / fp) * calmAir;
        float wisp = fW.a * 0.6 + fW.r * 0.4;                                         // streaks + lace
        float aaW = min(0.4, 4.0 * fpR / 2.6);
        foam += wtrFoamCov(wEnv * mix(0.25, 0.6, hv) * (0.35 + 0.65 * gapsR) * mix(1.0, 1.25, big), wisp, fW.g, aaW) * wEnv * mix(1.0, 0.35 + 0.5 * smoothstep(0.3, 0.9, wind), farK);
        // (2b) WALL WASH: along long walls and hulls — quays, the ship, the wreck's halves — a 1.2-2.8 m band of broken
        //      lace where the chop slaps the wall (the target art's harbor: white lace all along the quay base and the
        //      hull), dense at the wall, thinning outward, in patches along it (never one continuous band)
        {
          float bandW = mix(1.2, 2.8, hv) * mix(0.8, 1.2, wind);
          float bandP = smoothstep(0.3, 0.62, patchN + 0.12 * wind + 0.1 * tip);
          float band = (1.0 - smoothstep(bandW * 0.25, bandW, dC)) * touch * calmR * big * shelter * bandP * smoothstep(0.2, 0.8, bandW / fp) * calmAir * (1.0 - 0.6 * calm);
          if (band > 0.002) {
            float covB = mix(0.72, 0.26, clamp(dC / bandW, 0.0, 1.0));
            foam += wtrBubbly(band * covB, fL, min(0.35, aa)) * band * mix(1.0, 0.6, farK);
          }
        }
        // (3) tips + windward face: a broader, denser white wash (the bow's foam, surf on a rock point)
        // (dense right at the object, opening into lace outward — never a solid disc around a rock)
        float wR = mix(1.0, 2.2, tip) * mix(0.8, 1.2, hv);
        // (straight walls: churn in patches along the windward face — never one continuous band along a quay)
        float wash = max(tip, wind * (0.45 + 0.55 * hv) * 0.6 * gapsR) * big * shelter * (1.0 - smoothstep(0.2, wR, dC)) * touch * calmR * smoothstep(0.25, 1.0, 1.2 / fp) * calmAir * (1.0 - 0.6 * calm)
                   * mix(1.0, (0.35 + 0.65 * smoothstep(0.35, 0.9, wind)) * (0.3 + 0.7 * gapsR), farK);
        float wIn = 1.0 - smoothstep(0.1, 0.45, dC);
        foam += wtrBubbly(wash * mix(0.48, 0.66, tip) * wIn * mix(1.0, 0.72, farK), fL, min(0.35, aa)) * wash;
        foam += wtrBubbly(wash * mix(0.3, 0.45, tip) * (1.0 - wIn), fL, min(0.35, aa)) * wash * gapsR;
#ifdef WTR_DEBUG
        wDbgFoam = wtrDebug > 15.2 ? vec3(rLine, wash, clamp(foam, 0.0, 1.0)) : vec3(obst, tip, gapsR);   // (15.3: the terms)
        if (wtrDebug > 15.36) wDbgFoam = vec3(step(0.5, lineW), step(1.0, lineW), step(0.5, rLine)) * 0.8;       // (15.38: widths)
        if (wtrDebug > 15.42) wDbgFoam = vec3(step(0.3, pxD), step(0.6, pxD), step(0.3, lineFade)) * 0.8;       // (15.44: footprint)
#endif
      }
      // (h) CHURN from the air: a broad band of broken white water around hulls, quay walls, sea stacks and big rocks —
      //     5-15 m, wider on the windward face, dense at the object and opening into lace outward, in patches (the
      //     aerial render's harbor: white water all along the quay's rock base and the ship's hull)
#ifndef WTR_NEAR
      if (mChurn) {
        vec2 ouv = vec2(xz.x * wtrObstacleScale + 0.5, 0.5 - xz.y * wtrObstacleScale);
        float gE = texture2D(wtrObstacle, ouv + vec2(3.0 * wtrObstacleScale, 0.0)).g - obW;
        float gS = texture2D(wtrObstacle, ouv - vec2(0.0, 3.0 * wtrObstacleScale)).g - obW;
        vec2 gW = vec2(gE, gS);
        vec2 awayW = dot(gW, gW) > 1e-8 ? -normalize(gW) : vec2(0.0);
        // (hulls and quays churn on every side — the lee side less; the reflected chop never lets a quay go glassy)
        float windW = mix(0.55, 1.0, smoothstep(-0.3, 0.6, dot(awayW, -vec2(${WD0}))));
        float dW = (1.0 - obW) * 16.4;                                  // metres to the object (2.34 m cells: coarse)
        float reachW = mix(4.0, 13.5, windW * (0.4 + 0.6 * vary));
        float calmW = 1.0 - 0.8 * calm;
        float churn = (1.0 - smoothstep(reachW * 0.3, reachW, dW)) * churnK * calmW * wtrContact
                    * smoothstep(0.22, 0.5, nS.a * 0.6 + vary2 * 0.4 + 0.25 * windW);    // (patches along the object)
        // (stringy lace with open holes, thinning outward — 0.94 coverage at the object filled every sea stack,
        // rock and quay corner with an opaque white disc from the air: "fried eggs")
        float tW = clamp(dW / reachW, 0.0, 1.0);
        float covW = mix(0.66, 0.2, tW) * mix(0.75, 1.0, windW);
        foam += wtrFoamCov(churn * covW, mix(lace, dens, 0.3 * (1.0 - tW)), dens, aa) * churn * 0.9;
      }
#endif
      #endif
      // (h2) SURGE: every swell bursts against the windward face of a sea stack / big rock and washes round
      //      it — a thick bubbly white band 2-6 m wide, pulsing, draining into patches
      if (mSurge) {
        vec2 ouvS = vec2(xz.x * wtrObstacleScale + 0.5, 0.5 - xz.y * wtrObstacleScale);
        float gxS = texture2D(wtrObstacle, ouvS + vec2(3.0 * wtrObstacleScale, 0.0)).g - texture2D(wtrObstacle, ouvS - vec2(3.0 * wtrObstacleScale, 0.0)).g;
        float gzS = texture2D(wtrObstacle, ouvS - vec2(0.0, 3.0 * wtrObstacleScale)).g - texture2D(wtrObstacle, ouvS + vec2(0.0, 3.0 * wtrObstacleScale)).g;
        vec2 gS = vec2(gxS, gzS);
        vec2 awayS = dot(gS, gS) > 1e-8 ? -normalize(gS) : vec2(0.0);
        float windS = smoothstep(-0.45, 0.6, dot(awayS, -vec2(${WD0})));
        float psiS = fract(wtrTime / (wtrPeriod * 1.2) + vPhase * 1.7 + dot(xz, vec2(-0.004, 0.011)));
        float surgeS = psiS < 0.14 ? smoothstep(0.0, 0.14, psiS) : 1.0 - smoothstep(0.14, 0.95, psiS);
        // metres to the object: the fine proximity near it, the wide one beyond
        float dWs = mix((1.0 - obW) * 16.4, (1.0 - obst) * 4.7, step(0.02, obst));
        dWs = max(dWs + (nS.b - 0.5) * 1.4 + (dens - 0.5) * 0.8, 0.0);
        float wS = mix(1.2, 6.0, windS) * (0.55 + 0.55 * surgeS);
        float tS = clamp(dWs / max(wS, 0.5), 0.0, 1.0);
        float band = (1.0 - smoothstep(0.55, 1.0, tS)) * surgeX * mix(0.45, 1.0, windS);
        float bAs = min(0.35, 2.0 * sqrt(fp * fpMin));
        foam += wtrBubbly(band * mix(0.95, 0.35, tS) * (0.65 + 0.35 * surgeS), fL, bAs) * band;
        // draining lace beyond it (the last surge spreading out), only while it drains
        float drainS = surgeX * windS * smoothstep(0.8, 1.0, tS) * (1.0 - smoothstep(1.0, 1.9, dWs / max(wS, 0.5))) * smoothstep(0.2, 0.6, psiS);
        foam += wtrFoamCov(drainS * 0.5, lace, dens, aa) * drainS * 0.8;
      }
      // (i) DEPTH CONTACT: the bubbly collar + lapping rings at everything crossing the surface (see FRAG_COLOR)
      if (wScC + wScLap > 0.002) {
        // (at 0.85 the collar filled solid white round rocks — a broken bubbly ring: patches + holes, a thin bright
        // line right at the object, gaps where the along-object noise dips)
        float gapC = smoothstep(0.25, 0.55, fL.g * 0.6 + vNzS.b * 0.4);
        foam += wtrBubbly(wScC * mix(0.64, 0.92, gapC) * (1.0 - 0.8 * murk), fL, aa) * wScC;
        foam += (1.0 - smoothstep(0.02, 0.07 + fp, wScRay)) * wScC * 0.55 * (1.0 - 0.8 * murk);
        foam += wtrFoamCov(wScLap * 0.7, max(lace, fL.b), dens, aa) * wScLap * 0.85;
      }
      // interactive: splash / wake foam
      if (simFoam > 0.002) foam += wtrFoamCov(min(simFoam, 1.0) * 0.85, lace, dens, aa) * min(simFoam * 1.5, 1.0);
    }
  }
  #if !defined(WTR_UNDER) && !defined(WTR_FOAMPASS)
  // WHITECAPS in the harbor basin: the chop reflected off the quays breaks into small white caps scattered over the
  // crests (the target art's harbor: cobalt chop with white-capped crests) — each cap lives a few seconds and drifts
  // (not right under the camera: a cap is a ~1 m patch — at a few metres it read as scattered paper cut-outs)
  float capZ = max(harbor, 0.45 * smoothstep(8.0, 20.0, dT) * (1.0 - lagoon) * (1.0 - murk)) * (1.0 - calm) * wtrWhitecaps * smoothstep(1.5, 4.0, dT) * (1.0 - smoothstep(0.25, 0.7, obst)) * (1.0 - smoothstep(350.0, 700.0, dist))
             * smoothstep(12.0, 40.0, dist);
  if (capZ > 0.01) {
    vec2 cuv = xz / 5.5 + wtrTime * vec2(0.021, 0.013);
    vec4 fCap = wtrFoamG(cuv, gx / 5.5, gy / 5.5);
    vec4 nCap = wtrNoiseG(xz / 17.0 + wtrTime * vec2(-0.004, 0.006), gx / 17.0, gy / 17.0);
    // life: each patch of the noise field blinks on and off at its own phase
    float life = smoothstep(0.1, 0.6, 0.5 + 0.5 * sin(wtrTime * 0.8 + nCap.b * 18.0));
    float crestK = smoothstep(0.5, 0.95, vCrest) * 0.3 + smoothstep(0.1, 0.35, length(ripS)) * 0.2;
    float capM = smoothstep(0.66, 0.8, nCap.g * 0.45 + fCap.g * 0.35 + crestK) * life * capZ;
    float aaC = min(0.4, 4.0 * sqrt(fp * fpMin) / 5.5);
    foam += wtrFoamCov(capM * 0.62, fCap.r * 0.7 + fCap.b * 0.3, fCap.g, aaC) * capM * 0.9;
  }
  #endif
  foam = clamp(foam * wtrFoamAmount, 0.0, 1.0) * wEdgeF * (1.0 - dry);
  wFoam = foam;
`;

// replaces <color_fragment>
export const FRAG_COLOR = /* glsl */ `
#ifdef WTR_X_MIN
diffuseColor = vec4(1.0); wRamp = vec3(0.0, 0.2, 0.3); wScat = 1.0; wEdge = 1.0;
#else
{
  ${SURF_CORE}
  wDbgW = vec3(liftNow * 5.0, tH * 5.0, wetH);
  wSwB = smoothstep(-0.6, -0.35, tHs) * (1.0 - smoothstep(liftMaxP + 0.2, liftMaxP + 0.45, tHs)) * (1.0 - smoothstep(0.15, 0.4, slopeE));
  wHarbor = harbor; wDist = dist; wWet = wetZone; wDry = dry; wEdge = wEdgeL; wMurk = murk; wLag = lagoon * smoothstep(0.3, 1.5, dT) * (1.0 - smoothstep(6.0, 12.0, dT));
  #if defined(WTR_SCENE) && !defined(WTR_UNDER)
  // (out to 600 m for the grazing-ray closure below — the dark wedge along distant waterlines; every object
  //  test keeps its own ≤ 150-220 m fade)
  if (wtrGrab.z > 0.5 && dist < 600.0) {
    vec2 suvS = gl_FragCoord.xy * wtrGrab.xy;
    float szS = wtrViewZ(texture2D(wtrSceneDepth, suvS).r);
    float wzS = max(vViewPosition.z, 1e-3);
    wScRay = max(szS - wzS, 0.0) * dist / wzS;                       // metres of water along the ray to the scene
    // how deep that scene point sits under the surface (the ray descends at V.y per metre)
    float dObj = wScRay * clamp(V.y, 0.0, 1.0);
    // a grazing ray that slips under thin edge water and runs on below the surface — past the local seabed
    // out to deep water, or to nothing at all (sea floor > 9 m deep is not drawn: the black below the horizon) — sees the
    // water's own body there, not what lies at its end: the dark navy wedge along every distant waterline (the capped
    // stylised column of the thin edge water let that black straight through)
    {
      float beyond = smoothstep(0.8, 3.0, dObj - dFg) * (1.0 - smoothstep(0.2, 0.55, dFg - dObj));
      if (beyond > 0.001) {
        float clo = beyond * (1.0 - exp(-0.25 * wScRay));
        Tfloor *= 1.0 - clo;
        scat = mix(scat, 1.0, clo);
        ramp = mix(ramp, wtrRampAt(clamp(dObj * 0.5, dCol, 6.0)), clo);
      }
    }
    // an OBJECT standing in the water (not the seabed): clearly shallower than the terrain floor here. Not at grazing
    // angles (a long ray across a beach slope meets the floor shallower than under the pixel) nor far away (terrain LOD)
    float isObj = smoothstep(0.2, 0.55, dFg - dObj) * (1.0 - smoothstep(70.0, 150.0, dist));
    wScObj = isObj * smoothstep(0.05, 0.14, V.y);
    // (WRECK BAY's beach boulders wore a grey translucent "slab" round their base: the terrain under
    // the rock's footprint dips a hand under the waterline, so a thin film covered the rock's flared foot on dry sand)
    // (an ABSOLUTE test — the swash / wet-sand film hugs the sand 10 cm up and the drawn sand differs from the
    //  2 m field by a few cm, so a ratio test (scene / film height < 0.55) called the sand itself an "object" and
    //  hid the wet film: no wet sand anywhere. An object stands ≥ ~12 cm above the field)
    wFilmObj = (1.0 - smoothstep(0.4, 0.6, dFg)) * smoothstep(0.1, 0.18, dFg - wScRay * max(V.y, 0.02));
    // (+ any object in the swash zone, < ~3 m from the shoreline: the film there is centimetres thick — a boulder whose
    //  footprint dips under the waterline must not wear a grey water "slab")
    wFilmObj = max(wFilmObj, isObj * (1.0 - smoothstep(1.0, 3.0, shoreD)));
    wFilmObj *= 1.0 - smoothstep(180.0, 220.0, dist);
    // (… and an isolated puddle UNDER an object: the terrain under a beach boulder dips below the swash level while the
    //  sand all round it is dry — 4 field taps ±2.5 m; ≥ 3 dry neighbours → no water drawn over the object)
    if (isObj > 0.01 && wFilmObj < 0.99) {
      float lvl = liftNow - 0.02, e = 2.5 * wtrFieldST.x;
      float nd = step(lvl, textureLod(wtrField, fuv + vec2(e, 0.0), 0.0).r) + step(lvl, textureLod(wtrField, fuv - vec2(e, 0.0), 0.0).r)
               + step(lvl, textureLod(wtrField, fuv + vec2(0.0, e), 0.0).r) + step(lvl, textureLod(wtrField, fuv - vec2(0.0, e), 0.0).r);
      wFilmObj = max(wFilmObj, isObj * smoothstep(2.5, 3.0, nd));
    }
    // submerged parts of objects sit under a thin column: they read clear, slightly tinted — never a dark slab (the
    // floating crate's hull, a rock dome under the surface, a boat's keel, pile feet)
    float okS = mix(1.0, clamp(dObj / max(dFg, 0.05), 0.35, 1.0), wScObj);
    Tfloor = pow(max(Tfloor, vec3(1e-4)), vec3(okS));
    scat *= mix(1.0, okS, wScObj);
    // (… but the deeper parts of a submerged object sink into the water's colour — the crate's bottom, a boat's
    // keel, the far side of a rock dome read water-tinted, never black: a veil growing with the object's depth)
    float veilO = wScObj * smoothstep(0.12, 1.0, dObj) * 0.55;
    Tfloor *= 1.0 - 0.6 * veilO;
    scat = mix(scat, max(scat, 0.75), veilO);
    // CONTACT COLLAR: a broken bubbly ring 0.2-0.5 m wide wherever an object crosses the surface (screen-space: every
    // pile, ladder, hull, rock, root, crate — whatever loaded when), + LAPPING rings drifting out from it. Not at the
    // shoreline (the swash stack owns it) and not where the "object" is the seabed itself
    float objC = smoothstep(0.12, 0.35, dFg - dObj) * step(0.22, dFg) * (1.0 - smoothstep(70.0, 110.0, dist)) * wtrContactD;
    if (objC > 0.001) {
      float wv = vNzS.g;                                                // along-object variation (13 m noise, per vertex)
      // (0.35-0.7 m + ≥ 3 px — at 0.3-0.55 m + 1.5 px a pile 30 m from a 4 m eye got a 2-3 px line)
      float cw = mix(0.35, 0.7, smoothstep(0.25, 0.75, wv)) + 3.0 * fp;
      wScC = (1.0 - smoothstep(cw * 0.45, cw, wScRay)) * objC;
      // two lapping rings drifting outward, fading as they go (0.35 → 1.4 m)
      float ph = fract(wtrTime * 0.32 + wv * 3.1);
      float ph2 = fract(ph + 0.5);
      float rw = 0.08 + 1.2 * fp;
      float lap = exp(-pow((wScRay - (cw + ph * 1.5)) / rw, 2.0)) * (1.0 - ph) + exp(-pow((wScRay - (cw + ph2 * 1.5)) / rw, 2.0)) * (1.0 - ph2);
      wScLap = lap * objC * (1.0 - smoothstep(35.0, 60.0, dist));
    }
  }
  #endif
  #ifdef WTR_X_CUTA
  wN = normalize(vec3(-sl.x, 1.0, -sl.y)); wRamp = ramp; wScat = scat; wF = 0.05; wMul = Tfloor * 0.95; wTfl = Tfloor; diffuseColor = vec4(1.0);
  #else
  vec4 vfA, vfB, vfC;
  #ifdef WTR_VCORE
  if (vcoreP) { vfA = vVA; vfB = vVB; vfC = vVC; } else
  #endif
  wtrViewF(dist, V, dT, dF, calm, harbor, lagoon, farMix, vfA, vfB, vfC);
  #ifdef WTR_VALL
  // (the depth-keyed fades with sharp edges per PIXEL: the caustics' 3-30 cm onset and the surf zone — per vertex on
  // 2-8 m cells they printed polygons)
  vfA.y = wtrCaustics * smoothstep(0.03, 0.3, dF) * exp(-dF / 3.6) * (1.0 - smoothstep(25.0, 50.0, dist)) * mix(1.0, 0.4, smoothstep(5.0, 12.0, dist));
  vfA.z = smoothstep(0.15, 0.5, dT) * (1.0 - smoothstep(wtrBreakDepth, wtrBreakDepth * 1.8, dT)) * (1.0 - calm) * wtrSurf * (1.0 - smoothstep(60.0, 160.0, dist)) * (1.0 - lagoon);
  #endif

  // ---------- fine normal: + the ripple tile at two fine scales (each only while the footprint still resolves it)
  float bA = (1.0 - smoothstep(0.12, 0.5, fpT)) * vfA.x;
  #if defined(WTR_X_NOFINE) || defined(WTR_FAR)
  bA = 0.0;
  #endif
  if (bA > 0.002) {
    vec4 tA = WTR_TG(wtrTile, xz / ${T}, gx / ${T}, gy / ${T});
    ripS += (tA.rg - 0.5) * ${SR} * bA;
    // ---------- the caustic net — the target art's crisp white net of ~1 m cells on the shallow floor, ADDED as light
    //            (white-cyan, HDR under the sun — never a cream tint of the sand): a sharp procedural net refracted by the
    //            live ripples (it wobbles, stretches and drifts with the surface), thinner + softer with depth
    // (only where the floor is still visible through the column — at a grazing distance it is hidden anyway)
    // (the wreck lagoon: softer caustics — otherwise the lagoon read bleached mint, V .93 vs the target art's .66)
    float causAmt = vfA.y * (1.0 - wetZone) * (1.0 - smoothstep(0.3, 0.7, obst)) * (1.0 - 0.6 * lagoon) * (1.0 - murk)
                  * smoothstep(0.02, 0.1, dot(Tfloor, vec3(0.3333)));
    #ifdef WTR_X_NOCAUS
    causAmt = 0.0;
    #endif
    if (causAmt > 0.002) {
      vec2 floorXZ = xz - V.xz * min(thick, 6.0) * 0.8;          // where the view ray meets the floor (approx.)
      float kD = smoothstep(1.0, 4.0, dF);
      // (~1.6 m cells — the target art's shallows show a crisp white net of 1.5-3 m cells out to ~50 m; 0.94 m cells
      // faded into a fine glittery noise beyond ~15 m at eye level)
      // (0.8 m cells like the beach target art's near shallows, the net tile at 1.3 cm/texel — the 13 m tile's
      //  2.5 cm texels printed stair-stepped "brick" lines once the lines got thinner than a texel — warped harder by the
      //  ripples, and a SECOND rotated net at 1.37× blended in by a noise so the pattern never reads as one vector grid)
      const float CN = 6.5, CELL = 6.5 / 8.0;
      vec2 nuv = floorXZ / CN + ripS * (0.5 + 0.25 * min(dF, 3.0)) + vec2(wtrTime * 0.0065, -wtrTime * 0.004);
      vec4 nt = WTR_TG(wtrTex2, vec3(nuv, 2.0), gx / CN, gy / CN);
      const mat2 rN = mat2(0.4536, 0.8912, -0.8912, 0.4536);
      const float CN2 = CN * 1.37;
      vec2 fr2 = rN * floorXZ;
      vec4 nt2 = WTR_TG(wtrTex2, vec3(fr2 / CN2 + ripS * (0.62 + 0.2 * min(dF, 3.0)) + vec2(0.31 - wtrTime * 0.005, 0.57 + wtrTime * 0.0071), 2.0), (rN * gx) / CN2, (rN * gy) / CN2);
      // lines from the distance channel: ~4.5 cm wide up close, never thinner than ~1.3 px (minor axis) further out,
      // thinner + softer with depth; once the ~1 m cells shrink below ~5 px (major axis) the net fades to a soft shimmer
      // (no sub-pixel lines at grazing angles: those alias into scattered white ticks)
      float dLine = nt.b * 0.25 * CELL;                                // metres from the line edge
      // (never uniform-width bright white/cyan cell outlines out to 40-60 m, a vector pattern: thinner
      //  lines whose width AND brightness wander over the floor (a 4 m noise), soft edges, fading faster with depth and
      //  distance (causAmt: ~50 % beyond 10 m, gone by ~45 m))
      vec4 nv = WTR_TG(wtrTex2, vec3(floorXZ / 4.3 + vec2(0.17, 0.63), 1.0), gx / 4.3, gy / 4.3);
      float varW = smoothstep(0.25, 0.75, nv.r * 0.7 + nv.b * 0.3), varB = smoothstep(0.2, 0.8, nv.g * 0.6 + nv.a * 0.4);
      // (6-9 px bright outlines at 5 m read wrong at eye level — a real caustic net is hair-thin filaments with
      //  brighter knots where lines meet: width 0.7-2.2 cm, a softer core, a weaker glow)
      float mixN = smoothstep(0.3, 0.7, nv.a * 0.6 + nv.r * 0.4);
      dLine = min(dLine + 0.006 * mixN, nt2.b * 0.25 * CELL * 1.37 + 0.006 * (1.0 - mixN));
      float lw = max(mix(0.011, 0.006, kD) * mix(0.5, 1.45, varW), 0.55 * fpMin);
      float net = 1.0 - smoothstep(lw * 0.05, lw * 1.25, dLine);
      net += 0.12 * (1.0 - smoothstep(lw, lw * 3.5, dLine)) * (1.0 - kD);   // + a soft glow around each line (shallow)
      float netFade = 1.0 - smoothstep(CELL * 0.12, CELL * 0.32, fp);
      wCausL = causAmt * mix(0.25, 1.0, varB * varB) * (net * mix(0.75, 0.45, kD) * netFade * mix(1.0, 0.6, smoothstep(0.015, 0.05, fpMin)) + mix(nt.r, nt.g, 0.5) * 0.15 * (1.0 - netFade));
    }
    float bB = (1.0 - smoothstep(0.035, 0.13, fpT)) * bA;
    if (bB > 0.002) {
      const mat2 rB = mat2(${Math.cos(0.93).toFixed(6)}, ${Math.sin(0.93).toFixed(6)}, ${(-Math.sin(0.93)).toFixed(6)}, ${Math.cos(0.93).toFixed(6)});
      float sB = 1.0 / (${T} * 0.43);
      vec4 tB = WTR_TG(wtrTile, (rB * xz) * sB + vec2(0.37, 0.19), (rB * gx) * sB, (rB * gy) * sB);
      ripS += (transpose(rB) * ((tB.rg - 0.5) * ${SR})) * 0.58 * bB;
    }
  }
  // CRISP OPEN-WATER CHOP: six short peaky wind waves (1.1-5.3 m, sharp crests), each band-limited by the
  // pixel footprint ALONG its own direction — at a grazing view the waves whose crests run toward the eye stay resolved and
  // crisp instead of the tile's mip-blurred mush (deep water at eye / swimmer height must not read blurry and uniform)
  #ifndef WTR_FAR
  {
    // (from 1.5 m of water — the swimmer's open water off the N beach is 5-6 m deep and got only ~40 % of it)
    float kCh = smoothstep(1.5, 5.0, dT) * (1.0 - lagoon) * (1.0 - murk) * (1.0 - calm) * (1.0 - smoothstep(90.0, 160.0, dist)) * (1.0 - harbor * 0.5);
    if (kCh > 0.01) {
      vec2 chop = vec2(0.0);
    { const vec2 D = vec2(0.87758, 0.47943);
      float dph = 1.69816 * max(abs(dot(gx, D)), abs(dot(gy, D)));             // phase per pixel along this wave
      float bl = 1.0 - smoothstep(0.7, 2.0, dph * wtrChopBL);
      float ph = 1.69816 * dot(D, xz) - 4.08154 * wtrTime;
      float sp = 0.5 + 0.5 * sin(ph);
      chop += D * (0.10000 * 3.0 * sp * sp * cos(ph) * bl); }
    { const vec2 D = vec2(0.62161, -0.78333);
      float dph = 2.73182 * max(abs(dot(gx, D)), abs(dot(gy, D)));             // phase per pixel along this wave
      float bl = 1.0 - smoothstep(0.7, 2.0, dph * wtrChopBL);
      float ph = 2.73182 * dot(D, xz) - 5.17679 * wtrTime;
      float sp = 0.5 + 0.5 * sin(ph);
      chop += D * (0.17500 * 3.0 * sp * sp * cos(ph) * bl); }
    { const vec2 D = vec2(-0.58850, 0.80850);
      float dph = 3.92699 * max(abs(dot(gx, D)), abs(dot(gy, D)));             // phase per pixel along this wave
      float bl = 1.0 - smoothstep(0.7, 2.0, dph * wtrChopBL);
      float ph = 3.92699 * dot(D, xz) - 6.20675 * wtrTime;
      float sp = 0.5 + 0.5 * sin(ph);
      chop += D * (0.08000 * 3.0 * sp * sp * cos(ph) * bl); }
    { const vec2 D = vec2(0.45360, 0.89121);
      float dph = 1.18551 * max(abs(dot(gx, D)), abs(dot(gy, D)));             // phase per pixel along this wave
      float bl = 1.0 - smoothstep(0.7, 2.0, dph * wtrChopBL);
      float ph = 1.18551 * dot(D, xz) - 3.41025 * wtrTime;
      float sp = 0.5 + 0.5 * sin(ph);
      chop += D * (0.12000 * 3.0 * sp * sp * cos(ph) * bl); }
    { const vec2 D = vec2(-0.85689, -0.51550);
      float dph = 5.46364 * max(abs(dot(gx, D)), abs(dot(gy, D)));             // phase per pixel along this wave
      float bl = 1.0 - smoothstep(0.7, 2.0, dph * wtrChopBL);
      float ph = 5.46364 * dot(D, xz) - 7.32109 * wtrTime;
      float sp = 0.5 + 0.5 * sin(ph);
      chop += D * (0.06000 * 3.0 * sp * sp * cos(ph) * bl); }
    { const vec2 D = vec2(-0.97096, 0.23925);
      float dph = 2.16662 * max(abs(dot(gx, D)), abs(dot(gy, D)));             // phase per pixel along this wave
      float bl = 1.0 - smoothstep(0.7, 2.0, dph * wtrChopBL);
      float ph = 2.16662 * dot(D, xz) - 4.61026 * wtrTime;
      float sp = 0.5 + 0.5 * sin(ph);
      chop += D * (0.09000 * 3.0 * sp * sp * cos(ph) * bl); }
    // + two short wavelets (0.77 m, 0.54 m): the crisp small facets a swimmer sees right in front of the face
    { const vec2 D = vec2(0.30902, -0.95106);
      float dph = 8.16814 * max(abs(dot(gx, D)), abs(dot(gy, D)));
      float bl = 1.0 - smoothstep(0.7, 2.0, dph * wtrChopBL);
      float ph = 8.16814 * dot(D, xz) - 8.94822 * wtrTime;
      float sp = 0.5 + 0.5 * sin(ph);
      chop += D * (0.05000 * 3.0 * sp * sp * cos(ph) * bl); }
    { const vec2 D = vec2(-0.74314, -0.66913);
      float dph = 11.6355 * max(abs(dot(gx, D)), abs(dot(gy, D)));
      float bl = 1.0 - smoothstep(0.7, 2.0, dph * wtrChopBL);
      float ph = 11.6355 * dot(D, xz) - 10.6799 * wtrTime;
      float sp = 0.5 + 0.5 * sin(ph);
      chop += D * (0.04000 * 3.0 * sp * sp * cos(ph) * bl); }
      ripS += chop * kCh * wtrChop;
    }
  }
  #endif
  // the breaker's own faces (the vertex ridge): its slope across the shore, and the backlit lip — the thin front face
  // near the crest glows translucent turquoise
  float lipGlow = 0.0;
  #ifndef WTR_FAR
  {
    float surfZf = vfA.z;
    if (surfZf > 0.001) {
      float sphB = psi + shoreD / wtrSurfLen, uB = fract(sphB);
      float ampB = wtrBreakH * wtrSetAmp(floor(sphB + 0.1)) * surfZf;
      vec2 shoreNB = shoreNP;
      // (softer beyond ~20 m: the steep front face tilted toward a low camera mirrored the dark lower sky as a hard line)
      sl += shoreNB * (ampB * wtrRidgeDu(uB) / wtrSurfLen) * mix(1.0, 0.45, smoothstep(12.0, 30.0, dist));
      // crest translucency: the thin steep front face just under the lip, only where this crest actually breaks (the same
      // sections as the foam stack) — never a continuous neon band along the whole surf zone
      float alongB = dot(xz, vec2(-shoreNB.y, shoreNB.x)), idB = floor(sphB + 0.1);
      float sectB = smoothstep(0.36, 0.52, (wtrVN1(alongB / 21.0 + idB * 7.31) * 0.65 + wtrVN1(alongB / 7.0 - idB * 3.7) * 0.35) * 0.8 + wtrSetAmp(idB) * 0.25);
      // (the whole steep front face under the lip glows — a 1.4 m sliver was invisible at eye level)
      // (brightest right under the lip, fading down the face, and only where the face turns toward the eye — seen
      // along the beach the whole 2 m face stretched into a flat glassy neon sheet with hard edges)
      float faceB = smoothstep(-0.15, 0.6, dot(-shoreNB, normalize(V.xz + 1e-4)));
      lipGlow = smoothstep(0.86, 0.985, uB) * (1.0 - smoothstep(0.985, 0.998, uB)) * ampB / max(wtrBreakH, 1e-3) * sectB * 0.5
              * smoothstep(wtrBreakDepth * 1.3, wtrBreakDepth * 0.8, dT) * mix(0.25, 1.0, faceB);
    }
  }
  #endif
  vec2 sl0 = sl;
#ifdef WTR_DEBUG
  float wDbgLip = lipGlow;
#endif
  sl += ripS * rip * (1.0 - wetZone * 0.9);
  // interactive ripples (wakes, splashes, impacts)
  float simFoam = 0.0;
  #ifndef WTR_FAR
  {
    vec2 suv1 = (xz - wtrSimST.xy) * wtrSimST.z;
    if (wtrSimOn > 0.5 && suv1.x > 0.0 && suv1.y > 0.0 && suv1.x < 1.0 && suv1.y < 1.0) {
      float st = 1.0 / 256.0, dxs = st / wtrSimST.z;
      vec4 s0 = textureLod(wtrSim, suv1, 0.0);
      float hE = textureLod(wtrSim, suv1 + vec2(st, 0.0), 0.0).r, hW = textureLod(wtrSim, suv1 - vec2(st, 0.0), 0.0).r;
      float hS = textureLod(wtrSim, suv1 + vec2(0.0, st), 0.0).r, hN = textureLod(wtrSim, suv1 - vec2(0.0, st), 0.0).r;
      sl += vec2(hE - hW, hS - hN) / (2.0 * dxs);
      simFoam = s0.b;
    }
  }
  #endif
  wN = normalize(vec3(-sl.x, 1.0, -sl.y));
#ifdef WTR_DEBUG
  wDbgThick = thick; wDbgDF = dF;
#endif
  wColThk = thick;
  wFloorVis = dot(Tfloor, vec3(0.3333));
  wTfl = Tfloor;

  // ---------- in-scatter colour by depth (+ path, murk, harbor, lagoon: wtrColumn); the open ocean in broad lighter
  //            azure / deeper sapphire zones (~300-700 m, the aerial target art's ocean is never one flat blue)
  wRamp = ramp * mix(1.0, mix(0.8, 1.14, vSlick.y), smoothstep(10.0, 28.0, dCol) * (1.0 - harbor) * (1.0 - calm));
  // (under a low sun the emerald coves show their glowing body, not the dim sunset-lit sand behind it)
  float lagLow = wLag * (1.0 - smoothstep(0.25, 0.7, wtrSunDirW.y));
  wScat = max(scat, 0.7 * lagLow);
  Tfloor *= 1.0 - 0.55 * lagLow;
#ifdef WTR_DEBUG
  wDbgV = wtrDebug > 26.8 && wtrDebug < 26.95 ? vec3(calm, murk, lagoon) : vec3(dCol / 30.0, farMix, pathD / 30.0);
  if (wtrDebug > 29.5) wDbgV = vec3(obst, obW, 0.0);
  if (wtrDebug > 30.5) wDbgV = vec3(wDbgLip, fract(psi + shoreD / wtrSurfLen), vfA.z);
#endif
  wFacetK = vfA.w;

  // ---------- fresnel + sky reflection (analytic atmos sky)
  float fK = wtrFresK(wEdge, wetZone, dry);
  // looking across the water the ripple facets mask each other: the surface reflects like its mean plane (a sheet of
  // sky glare over the floor), not like single steep facets
  float grazeF = vfB.x * (1.0 - 0.65 * smoothstep(3.0, 9.0, dT) * (1.0 - calm));   // (open water keeps its chop across the view)
  // (Schlick once per pixel: the flat-surface term is a function of V.y alone)
  float Fn = wtrSchlick(wN, V);
  float mU = 1.0 - clamp(V.y, 0.0, 1.0), mU2 = mU * mU, Fup = 0.02 + 0.98 * mU2 * mU2 * mU;
  // (open water at eye / swimmer height — the cap flattened every chop facet to the same sheen: the deep sea
  // read soft and uniform. There the cap opens, so facets turned to the eye show the dark body, the others the sky)
  // (from ~2 m — the swimmer's near water (4-12 m) still read the capped, uniform sheen: wtrCapOpen)
  float capOpen = wtrCapOpen * smoothstep(3.0, 9.0, dT) * (1.0 - lagoon) * (1.0 - murk) * (1.0 - calm) * (1.0 - smoothstep(0.06, 0.3, V.y)) * smoothstep(1.5, 5.0, dist);
  float F = min(mix(Fn, Fup, grazeF * 0.75), fCap + capOpen) * fK * (1.0 - 0.45 * lagLow);
  wF = F;
  #if defined(WTR_DUAL_SRC) && !defined(WTR_UNDER)
  // the multiply factor, written as the second (dual-source) output: dst = comp + dst·M — one pass instead of two
  ${MUL_BODY}
  wMul = M;
  #endif
  vec3 Rw = reflect(-V, wN);
  // a swimmer's view (< ~3° across the water, 3–150 m): the water mirrors the bright horizon sky itself — the glare
  // that hides the floor at a grazing angle — instead of the stylised lifted blue the rest of the sea reflects
  float grazeHi = vfB.y;
  Rw.y = max(Rw.y, mix(0.12, 0.03, grazeHi));
  float reflLift = wtrReflLift * (1.0 - 0.8 * grazeHi);
  // ripple streaks: the facets the ripples tilt away from the eye mirror more sky than the flat water around them —
  // exaggerated near the camera so the shallow surface reads glossy and rippled above the caustics (never optically flat)
  float Fr = F;
  #ifndef WTR_FAR
  float kHi = vfB.z * (1.0 - wetZone);
  // (the streak: how much more sky the rippled facet mirrors than the flat surface would)
  if (kHi > 0.001) Fr += max(F - min(Fup, fCap) * fK, 0.0) * kHi;
  #endif
  #if defined(WTR_X_NOSKY)
    wRefl = vec3(0.2, 0.4, 0.6) * Fr;
  #elif defined(ATMOS)
    wRefl = wtrReflSky(normalize(Rw), reflLift) * Fr * wtrSkyReflect;
    wRefl *= 1.0 - 0.55 * murk;                        // (THE MURK lies under the canopy: it mirrors leaves, not open sky)
  #else
    wRefl = vec3(0.3, 0.6, 0.9) * Fr * wtrSkyReflect;
  #endif
  #if defined(WTR_SCENE) && !defined(WTR_UNDER) && !defined(WTR_CANVAS)
  // mirrored scene (screen-space): the reflected ray off a half-flattened normal (the ripples wobble the image without
  // shredding it). Over the whole near + mid water; misses keep the sky
  if (wtrSSR > 0.0 && Fr > 0.012 && dist < 320.0) {
    vec3 nR = normalize(mix(vec3(0.0, 1.0, 0.0), wN, 0.45));
    vec4 sr = wtrSSRTrace(vWPos + vec3(0.0, 0.02, 0.0), reflect(-V, nR), dist);
    sr.a *= 1.0 - smoothstep(220.0, 320.0, dist);
    wRefl = mix(wRefl, sr.rgb * Fr * wtrSSR, sr.a);
  }
  #endif

  #if defined(WTR_X_CUTB)
  float foam = 0.0; diffuseColor = vec4(1.0);
  #else
  // ---------- foam: its own pass above water (FRAG_FOAM, early discard — the main pass stays lean); from below the
  //            rafts are part of this pass
  #if defined(WTR_UNDER) || defined(WTR_FOAMMAIN)
  ${FOAM_STACK}
  #else
  float foam = 0.0;
  #endif
  #if !defined(WTR_FAR) && !defined(WTR_UNDER)
  // THE MURK: floating leaves + litter drifting on the tea water (one jittered leaf per ~0.9 m cell in ~40 % of cells)
  if (murk > 0.05 && dist < 80.0 && dF > 0.03) {
    vec2 lp = xz / 0.9 + vec2(wtrTime * 0.012, wtrTime * 0.007);
    vec2 lc = floor(lp);
    float hl = wtrHash(lc);
    if (hl < 0.55 * murk) {
      vec2 f = fract(lp) - (0.3 + 0.4 * vec2(wtrHash(lc + 3.1), wtrHash(lc + 7.7)));
      float an = wtrHash(lc + 1.3) * 6.2832 + wtrTime * 0.05 * (wtrHash(lc + 9.2) - 0.5);
      f = mat2(cos(an), sin(an), -sin(an), cos(an)) * f;
      float pad = step(0.78, wtrHash(lc + 2.4));                             // 22 %: round lily pads with a notch
      float sz = mix(0.07 + 0.08 * wtrHash(lc + 5.1), 0.16 + 0.1 * wtrHash(lc + 5.1), pad);
      vec2 fe = f / vec2(sz, sz * mix(0.55, 0.96, pad));
      float e = length(fe) + (1.0 - pad) * 0.18 * fe.x;                       // (a slightly egg-shaped leaf)
      float notch = pad * step(0.0, f.x) * (1.0 - smoothstep(0.08, 0.16, abs(f.y) / max(f.x + 0.01, 0.01)));
      float edgeW = 0.12 + fp / (0.9 * sz);
      wLeaf = (1.0 - smoothstep(1.0 - edgeW, 1.0, e)) * (1.0 - notch) * (1.0 - smoothstep(40.0, 75.0, dist)) * mix(0.8, 0.95, pad);
      float vein = (1.0 - pad) * smoothstep(0.08, 0.0, abs(fe.y)) * 0.3 + pad * smoothstep(0.75, 1.0, e) * 0.25;   // (midrib / pad rim)
      vec3 lA = mix(vec3(0.16, 0.13, 0.03), vec3(0.2, 0.09, 0.025), wtrHash(lc + 4.4));                   // olive-yellow / russet
      wLeafCol = mix(lA, vec3(0.055, 0.13, 0.03), pad) * (1.0 + vein);
      foam *= 1.0 - wLeaf;
    }
  }
  #endif

  #ifndef WTR_X_CUTC
  // ---------- CHOP SHADING (harbor + open water, stylised): each ripple facet reflects its OWN patch of sky — the
  //            facets tilted away from the eye mirror the bright sky higher up (light, less saturated crests), the ones
  //            tilted toward it show the deep body (dark cobalt / teal troughs) — plus twinkling glints on the steepest
  //            crests. No texture work: the slopes are the ones the normal already has.
  //            (no procedural crest NET: a cellular web of bright lines read as pool caustics
  //            printed ON the surface; harbor saturation p10-p90 was 0.72-0.74 vs the target art's 0.70-0.96)
  {
    // (fades at grazing angles: across the water the facets' own sky reflection takes over — no dark blotches at eye level)
    float openC = smoothstep(3.0, 9.0, dT) * (1.0 - lagoon) * (1.0 - murk) * (1.0 - calm);
    float chopK = vfB.w * (1.0 - wetZone) * (1.0 - smoothstep(0.35, 0.8, obst)) * (1.0 - foam) * mix(mix(0.35, 0.9, openC), 1.0, smoothstep(0.05, 0.22, V.y));
    #ifdef WTR_FAR
    chopK *= 0.35;                                                   // (from the air: a soft wave texture only)
    #endif
    #ifdef WTR_X_NONET
    chopK = 0.0;
    #endif
    if (chopK > 0.01) {
      // the ripple slope along the view direction (+ = the facet leans away from the eye → it mirrors higher sky)
      vec2 vdir = normalize(-V.xz + 1e-5);
      vec2 rs = sl - vSwellSl;                                       // ripples + short swell (the chop), not the long swell
      // (the broad chop drives the sheen — soft multi-metre light / dark undulations; the fine ripples only a little)
      // (in the harbor the CHOP itself drives it — crisp crest / trough network, not the broad blotches)
      float hbC = max(harbor, 0.7 * smoothstep(3.0, 9.0, dT) * (1.0 - lagoon) * (1.0 - murk));   // (open water: the crisp chop network too)
      vec2 rc = mix(ripD + vSwellSl * 0.6 + rs * 0.25, rs * 1.1 + ripD * 0.25, hbC);
      // (grazing views: small slopes swing the reflection far — but at eye level in the harbor that turned the chop into
      // binary light / dark "camo" blotches: the harbor's gain is capped)
      float lean = dot(rc, vdir) / mix(0.1 + 0.55 * V.y, 0.32 + 0.4 * V.y, hbC);
      float lo = mix(-0.1, 0.04, hbC), hi = mix(1.0, 0.5, hbC);
      float up = smoothstep(lo, hi, lean), dn = smoothstep(lo, hi, -lean);
      wNetHi = up * chopK * (1.0 + 1.2 * openC * (1.0 - smoothstep(0.05, 0.3, V.y)));   // crest: sky sheen (open water at eye / swimmer height: crisper)
      wNetDark = dn * chopK;                                         // trough: less sky, darker + more saturated body
      wNetSky = wtrReflSkyHi(normalize(vec3(-V.x, max(0.35, V.y), -V.z)));
      #ifndef WTR_FAR
      // glints: HDR twinkles on the steepest crests (brighter facing the sun) — the harbor target art's scattered
      // specks (perf: its weight only — ONE sparkle-cell evaluation below serves the glints and the sun's glitter path)
      float gK = mix(0.35, 1.0, smoothstep(0.08, 0.25, length(rs))) * up * chopK * smoothstep(6.0, 25.0, dist) * smoothstep(0.008, 0.08, V.y);
      if (gK > 0.02) {
        float sunF = 0.3 + 0.7 * smoothstep(-0.2, 0.8, dot(reflect(-V, wN), wtrSunDirW));
        wGlintK = gK * sunF * 0.6;
      }
      #endif
    }
  }

  // ---------- sun glitter sparkles: HDR points inside the sun's (roughness-widened) reflection lobe, ≈ 3 px each. The
  //            lobe is stylised wide (a high sun still throws a sparkling path at eye level); sparse far from its core
  {
    vec3 Rs = reflect(-V, wN);
    float mu = dot(Rs, wtrSunDirW);
    // ONLY the sun's own reflection lobe (a glitter PATH toward the sun, never tinsel over the whole sea); from the air
    // nothing (a sheen at most, see the composite)
    float spread = vfC.x;                                                      // lobe widens with distance (glitter path)
    float lobe = smoothstep(spread, 1.0, mu) * wEdge * (1.0 - wetZone) * (1.0 - foam) * vfC.y;
    #if defined(WTR_X_NOSPARK) || defined(WTR_FAR)
    lobe = 0.0;
    #endif
    float spK = lobe + wGlintK;
    wSpark += spK > 0.001 ? spK * wtrSparkle * wtrSparkleAt(xz, sqrt(fp * fpMin) * 1.2, wtrTime) : 0.0;
  }

  // three's lighting runs with a WHITE albedo: directDiffuse / indirectDiffuse are then exactly the (shadowed) sun and
  // sky irradiance terms, which the composite uses for the foam, the in-scatter and as the shadow factor
  diffuseColor = vec4(1.0);
  wNdL = clamp(dot(wN, wtrSunDirW), 0.0, 1.0);
  // crest translucency: sunlight through the wave body toward the camera
  float backlit = vfC.w;
  // (swell crests: near only — beyond ~60 m the crests lined up into horizontal cyan streaks across the far sea
  // at a grazing angle; the face turned toward the eye glows, the back face does not)
  float faceEye = smoothstep(-0.02, 0.06, -dot(sl0, normalize(V.xz + 1e-4)));
  // (the swell's crest band only, soft — a wide glow keyed on the per-vertex crest printed hard-edged cyan wedges)
  wSss = vfC.z * smoothstep(0.72, 0.97, vCrest) * (1.0 - foam) * faceEye * 0.4
       + lipGlow * (0.45 + 0.55 * backlit) * 0.75;
  #else
  diffuseColor = vec4(1.0);
  #endif
  #endif
  #endif
}
#endif
`;

// ======================================================================================================================
// PASS 3 — FOAM (MeshStandardMaterial + onBeforeCompile, premultiplied over: dst = foamLit·f + dst·(1 − f)). Its own pass
// so the main pass does not carry the foam stack's code + registers over the whole sea: every pixel that cannot hold
// foam (open water) is discarded after two field fetches. Lit by three (sun with the atmos cascaded + cloud shadows, sky
// irradiance) with a matte white albedo.
// ======================================================================================================================
export const FRAG_FOAM = /* glsl */ `
{
  ${SURF_CORE}
  wDist = dist; wEdge = wEdgeL;
  float simFoam = 0.0;
  {
    vec2 suv1 = (xz - wtrSimST.xy) * wtrSimST.z;
    if (wtrSimOn > 0.5 && suv1.x > 0.0 && suv1.y > 0.0 && suv1.x < 1.0 && suv1.y < 1.0) simFoam = textureLod(wtrSim, suv1, 0.0).b;
  }
  ${FOAM_STACK}
  if (foam < 0.003 && wtrDebug < 0.5) discard;
  diffuseColor = vec4(wtrFoamCol, 1.0);
}
`;
// replaces <normal_fragment_maps> in the foam pass: the swell normal (foam rides the waves)
export const FRAG_NORMAL_FOAM = /* glsl */ `
normal = normalize((viewMatrix * vec4(normalize(vec3(-vSwellSl.x, 1.0, -vSwellSl.y)), 0.0)).xyz);
nonPerturbedNormal = normal;
`;
export const FRAG_ROUGH_FOAM = /* glsl */ `
float roughnessFactor = 0.9;
`;
// replaces <opaque_fragment> in the foam pass
export const FRAG_OPAQUE_FOAM = /* glsl */ `
{
  vec3 lit = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular * 0.3;
  #if defined(ATMOS) && defined(WTR_VATM)
  lit = mix(lit, vAtmA * lit + vAtmB, wtrHaze);
  #endif
  gl_FragColor = vec4(lit * wFoam, wFoam);
  if (wtrDebug > 0.5) {
    int dm = int(wtrDebug + 0.5);
    gl_FragColor = dm == 3 ? vec4(vec3(wFoam), 1.0) : dm == 15 ? vec4(wDbgFoam, 1.0) : dm == 16 ? vec4(wDbgSurf, 1.0) : dm >= 18 ? vec4(wDbgSurf, 1.0) : vec4(0.0);
  }
}
`;

// replaces <lights_fragment_maps> + <lights_fragment_end>: three's own <lights_fragment_begin> stays (the sun — a SunLight
// or a DirectionalLight — with the atmos shadow override), then only the sky IRRADIANCE is added. No IBL radiance /
// indirect-specular evaluation: the sea reflects the analytic atmos sky itself (wtrReflSky), so that fetch was wasted.
export const FRAG_LIGHTS_INDIRECT = /* glsl */ `
#if defined( RE_IndirectDiffuse )
  #if defined( WTR_SKYIRR )
    // (the env's irradiance for an up normal, measured once per environment: skyirr.ts)
    reflectedLight.indirectDiffuse += wtrSkyIrr;
  #elif defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV ) && !defined( WTR_X_NOIBL )
    irradiance += getIBLIrradiance( geometryNormal );
  #endif
  reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( vec3( 1.0 ) );
#endif
`;

// replaces <roughnessmap_fragment>
export const FRAG_ROUGH = /* glsl */ `
float roughnessFactor = mix(wtrRoughNear, wtrRoughFar, smoothstep(15.0, 900.0, wDist));
roughnessFactor = mix(roughnessFactor, 0.85, max(wFoam, wWet * 0.6));
`;

// replaces <normal_fragment_maps>
export const FRAG_NORMAL = /* glsl */ `
normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
#ifdef DOUBLE_SIDED
  normal *= faceDirection;
#endif
nonPerturbedNormal = normal;
`;

// replaces <opaque_fragment>: the composition. Premultiplied over the multiplied scene: dst = comp + dst·(1 − foam)
export const FRAG_OPAQUE = /* glsl */ `
#if NUM_SUN_LIGHTS > 0
  #define WTR_SUN_COL sunLights[ 0 ].color
#elif NUM_DIR_LIGHTS > 0
  #define WTR_SUN_COL directionalLights[ 0 ].color
#endif
{
  // shadow factor 0..1 = shadowed sun irradiance / unshadowed (object + cloud shadows darken the water body; the atmos
  // sun shadow carries the cloud shadow)
  float shadow = 1.0;
  vec3 sunIrr = vec3(0.0);
  vec3 flatSun = vec3(0.0), sunCol = vec3(0.0);
  vec3 dirDiff = reflectedLight.directDiffuse, dirSpec = reflectedLight.directSpecular;
  #ifdef WTR_SUN_COL
    sunIrr = WTR_SUN_COL * wNdL * RECIPROCAL_PI;
    #ifdef WTR_OWNL
    {
      // the water's own sun terms: a white Lambert + the GGX lobe (small-roughness visibility 1/(4·NL·NV), Schlick F0 0.04)
      shadow = clamp(dot(wSunLit, vec3(0.3333)) / max(dot(WTR_SUN_COL, vec3(0.3333)), 1e-4), 0.0, 1.0);
      dirDiff = wSunLit * wNdL * RECIPROCAL_PI;
      vec3 Vw = normalize(cameraPosition - vWPos), Hh = normalize(wtrSunDirW + Vw);
      float ndh = max(dot(wN, Hh), 0.0), nv = max(dot(wN, Vw), 0.03);
      float al = material.roughness * material.roughness, a2 = al * al, dd = ndh * ndh * (a2 - 1.0) + 1.0;
      float vh = 1.0 - max(dot(Vw, Hh), 0.0), vh2 = vh * vh, fr = 0.04 + 0.96 * vh2 * vh2 * vh;
      dirSpec = wSunLit * (fr * RECIPROCAL_PI * a2 / (dd * dd) * 0.25 / nv);
    }
    #else
    shadow = clamp(dot(reflectedLight.directDiffuse, vec3(0.3333)) / max(dot(sunIrr, vec3(0.3333)), 1e-4), 0.0, 1.0);
    #endif
    // light reaching the water body: the sun (shadowed, not below wtrShadeMin — the body is lit through its volume) +
    // sky. The harbor keeps less (the dark water under the hull in the target art)
    sunCol = WTR_SUN_COL;
    // (the emerald lagoons glow even under a low sunset sun — the sand-bounced light
    // keeps the shallow cove vivid; stylised: the body is lit as if the sun stood ≥ ~33° up)
    flatSun = sunCol * max(wtrSunDirW.y, 0.55 * wLag) * RECIPROCAL_PI;
  #endif
  // the chop's facets: wave faces turned toward the sun catch more light into the body, the lee faces less — the wave
  // texture that reads from the air and across open water (a body modulation, never a specular sheet)
  float facet = mix(1.0, clamp(wNdL / max(wtrSunDirW.y, 0.2), 0.3, 1.8), wtrFacet * wFacetK);
  vec3 bodyLight = flatSun * facet * mix(wtrShadeMin * (1.0 - 0.2 * wHarbor), 1.0, shadow) + reflectedLight.indirectDiffuse;
  vec3 own = wRamp * bodyLight * wtrScatterGain * wScat;
  // (under a low sun the sheltered emerald coves still glow — the sand bounce; midday stays as calibrated)
  own *= 1.0 + 2.6 * wLag * (1.0 - smoothstep(0.25, 0.7, wtrSunDirW.y));
  // (cloud / object shadows also dim a share of the reflected sky: the target art's cloud shadows read ~15-20 % darker
  // on the open sea; shadowed water is never black, the in-scatter + wtrShadeMin keep it lit)
  // (the harbor's crest sheen is the teal-tinted sky the chop mirrors, its troughs deep cobalt — the target art's
  // harbor is S 0.7-0.96; a pale-sky sheen greyed it to 0.65-0.8)
  vec3 netSky = wNetSky * mix(vec3(1.0), vec3(0.8, 0.96, 1.0), wHarbor);
  vec3 water = own * (1.0 - wWet) * (1.0 - wF) * (1.0 - mix(0.42, 0.5, wHarbor) * wNetDark) * mix(vec3(1.0), vec3(0.55, 0.95, 1.12), wHarbor * wNetDark) + wRefl * mix(1.0, shadow, 0.3) * (1.0 - 0.3 * wNetDark) * mix(vec3(1.0), vec3(0.7, 0.96, 1.0), wHarbor)
             + netSky * wNetHi * wtrCrestHi * mix(1.0, 2.5, wHarbor) * mix(0.6, 1.0, shadow);
  // (from the air the sun's GGX lobe on the broad ripples would paint a white sheet over the sea: a sheen there)
  // (the aerial: the sun's lobe on every broad ripple turned the ocean steel-grey "tinsel" — a faint sheen only)
  // (the sun's broad GGX lobe on the mid / far water greyed the whole far sea toward the sun (the beach frame's pale
  // band under the horizon, S 0.59): the sheen stays near the camera, the glitter PATH beyond is the sparkles)
  vec3 glitter = dirSpec * wtrGlitter * wEdge * (1.0 - wDry) * shadow * (1.0 - 0.97 * smoothstep(40.0, 260.0, wDist));
  vec3 spark = sunCol * wSpark * shadow;
  vec3 foamLit = wtrFoamCol * mix(vec3(1.0), vec3(0.72, 0.62, 0.42), wMurk) * (dirDiff + reflectedLight.indirectDiffuse);   // (THE MURK: tea scum)
  vec3 sss = wtrSssCol * wSss * shadow * dot(flatSun, vec3(0.3333)) * 2.0;
  // caustic light on the floor, attenuated like the floor (down + back up) — half-whitened so the lines stay bright
  vec3 caus = mix(vec3(dot(wTfl, vec3(0.3333))), wTfl, 0.55) * vec3(0.9, 1.0, 0.97) * flatSun * shadow * wCausL * (1.0 - wF) * (1.0 - wWet);
  vec3 comp = water * (1.0 - wFoam) + foamLit * wFoam + (glitter + spark + caus) * (1.0 - wFoam) + sss + totalEmissiveRadiance;
  float alpha = wFoam;
  if (wLeaf > 0.001) {
    comp = mix(comp, wLeafCol * (dirDiff + reflectedLight.indirectDiffuse), wLeaf);
    alpha = max(alpha, wLeaf);
  }
  #if defined(ATMOS) && !defined(WTR_X_NOATM)
  {
    // haze only on the water's OWN light: the floor seen through it (the multiply pass) is already hazed by its own
    // material. mix(c, aerial(c), k) with ONE atmos call
    float floorShare = clamp(mix(wFloorVis, 1.0, wWet) * (1.0 - wF) * (1.0 - wFoam), 0.0, 1.0);
    #ifdef WTR_VATM
    comp = mix(comp, vAtmA * comp + vAtmB, wtrHaze * (1.0 - floorShare));
    #else
    comp = mix(comp, atmosAerial(comp, vAtmWorld), wtrHaze * (1.0 - floorShare));
    #endif
  }
  #endif
  #ifdef WTR_UNDER
  {
    // the surface seen from below: Snell's window (the whole sky squeezed into a ~97° cone, rippling) and total
    // internal reflection of the deep water outside it; foam reads as bright grey rafts from underneath. Distance fog
    // is the underwater pass (underwater.ts). Opaque.
    vec3 dUp = -normalize(cameraPosition - vWPos);            // camera → surface (pointing up)
    vec3 nD = -wN;                                             // the surface normal facing the camera
    vec3 tr = refract(dUp, nD, 1.333);
    float win = dot(tr, tr) > 1e-4 ? 1.0 : 0.0;
    float cosI = clamp(dot(-dUp, nD), 0.0, 1.0);
    float edgeF = win * smoothstep(0.64, 0.78, cosI);          // brightest straight up, Fresnel-dark near the rim
    vec3 skyIn = vec3(0.5, 0.8, 1.0);
    #ifdef ATMOS
      skyIn = atmosSky(normalize(tr + vec3(0.0, 1e-3, 0.0)));
    #endif
    vec3 tir = wtrRamp3 * bodyLight * wtrScatterGain * 0.5;
    comp = mix(tir, skyIn * 1.2 + tir * 0.2, edgeF);
    comp += sunCol * pow(max(dot(tr, wtrSunDirW), 0.0), 400.0) * 6.0 * win;   // the sun through the window
    comp = mix(comp, vec3(0.75, 0.88, 0.9) * dot(bodyLight, vec3(0.333)), wFoam * 0.8);
    alpha = 1.0;
  }
  #endif
#ifdef WTR_DEBUG
  if (wtrDebug > 17.5) { comp = wDbgSurf; alpha = 1.0; }
  if (wtrDebug > 22.5 && wtrDebug < 24.5) { comp = wtrRamp4 * (wtrDebug - 22.0); alpha = 1.0; }
  if (wtrDebug > 29.5) { comp = wDbgV; alpha = 1.0; }
  if (wtrDebug > 32.5) { comp = wDbgW; alpha = 1.0; }   // 33: swash level ×5, terrain height ×5, wetness
  else if (wtrDebug > 31.5) { comp = vec3(wFilmObj, wScObj, clamp(wScRay, 0.0, 1.0)); alpha = 1.0; }
  else if (wtrDebug > 24.5) { comp = wtrDebug > 27.5 ? wDbgFT * (wtrDebug > 28.5 ? 0.25 : 1.0) : wtrDebug > 26.5 ? wDbgV : wtrDebug > 25.5 ? water : wMul; alpha = 1.0; }
  // debug views (18-20: foam-pass masks): 2 scatter 3 foam 4 thick/10 5 depth/10 7 normal 8 body light 9 reflection
  // 10 wet 11 floorShare 12 shadow 14 harbor 15 obst/ring 16 surf
  if (wtrDebug > 0.5 && wtrDebug < 17.5) {
    int dm = int(wtrDebug + 0.5);
    if (dm == 2) comp = own; else if (dm == 3) comp = vec3(wFoam); else if (dm == 4) comp = vec3(wDbgThick / 10.0); else if (dm == 5) comp = vec3(wDbgDF / 10.0);
    else if (dm == 7) comp = wN * 0.5 + 0.5; else if (dm == 8) comp = bodyLight;
    else if (dm == 9) comp = wRefl; else if (dm == 10) comp = vec3(wWet, wDry, 0.0); else if (dm == 11) comp = vec3(wFloorVis);
    else if (dm == 12) comp = vec3(shadow); else if (dm == 13) comp = vec3(wF, wMul.g, wCausL); else if (dm == 14) comp = vec3(wHarbor, wDbgDF / 12.0, 0.0); else if (dm == 15) comp = wDbgFoam; else if (dm == 16) comp = wDbgSurf;
    else comp = vec3(1.0, 0.0, 1.0);
    alpha = 1.0;
  }
#endif
  gl_FragColor = vec4(comp, alpha);
  #ifdef WTR_DUAL_SRC
  {
    // second output = the blend's destination factor (premultiplied over the multiplied scene: dst = comp + dst·M·(1 − a))
    vec3 mulOut = wMul * (1.0 - alpha);
    #if defined(WTR_SCENE) && !defined(WTR_UNDER) && !defined(WTR_CANVAS)
    // REFRACTION: the floor and everything standing in the water seen through a rippling surface — sample the
    // opaque scene's colour copy at an offset from the surface slope × the water's thickness along the ray, instead of
    // multiplying the pixel straight behind. Submerged rock domes, crate hulls, pile feet and the seabed's edges wobble
    // and break up like real water (no hard dark disc / flat slab outlines). Never pulls in anything IN FRONT of
    // the surface (a pile, a hull, a kong): such a sample falls back to the pixel straight behind
    // (not over the swash / wet-sand film — there is no water to refract, and the scene copy is not bit-identical
    // to the frame behind: the film read paler than the sand around it, an outlined strip)
    if (wtrGrab.w > 0.5 && wtrGrab.z > 0.5 && wtrRefract > 0.0 && wDist < 160.0 && wWet < 0.5) {
      vec2 suvR = gl_FragCoord.xy * wtrGrab.xy;
      vec3 nV = (viewMatrix * vec4(wN.x, 0.0, wN.z, 0.0)).xyz;
      float vzR = max(vViewPosition.z, 0.5);
      float thkR = min(wScRay, 2.5) * (1.0 - smoothstep(90.0, 160.0, wDist));
      vec2 offR = vec2(nV.x * wtrProj[0][0], nV.y * wtrProj[1][1]) * (wtrRefract * thkR * 0.5 / vzR);
      offR = clamp(offR, vec2(-0.03), vec2(0.03));
      vec2 ruv = suvR + offR;
      if (wtrViewZ(texture2D(wtrSceneDepth, ruv).r) < vzR + 0.05) ruv = suvR;
      vec3 scR = texture2D(wtrSceneCol, ruv).rgb;
      // real tropical shallows are cool white carbonate sand seen through clear water (Grace Bay,
      // Shoal Bay): our beach albedo is warm peach, and peach × the red-first absorption reads mint-green (hue 140-160)
      // over the first metre. Under the water the seabed's colour is pulled toward its own luminance (slightly cool)
      // before the absorption tints it → pale aqua at the edge, turquoise by ~1 m, the sand's ripples intact. Not in
      // THE MURK (tea) or THE WRECK's emerald lagoon; nothing at the waterline itself (no outline where the water starts)
      // (keyed on the colour column's path as well as the ray to the scene — the drawn surface meets the
      //  sand at the live swash line, so the scene ray alone left the swash shallows warm peach, a yellow strip)
      float coolK = wtrSandCool * smoothstep(0.02, 0.45, max(wScRay, wColThk)) * (1.0 - wMurk) * (1.0 - 0.8 * wLag);
      scR = mix(scR, dot(scR, vec3(0.2126, 0.7152, 0.0722)) * vec3(0.88, 1.02, 1.12), coolK);
      gl_FragColor.rgb += scR * mulOut;
      mulOut = vec3(0.0);
    }
    #endif
    // (the exact waterline against objects: the last few cm of water fade out — no hard cut where a pile or hull enters)
    // (not in the sandy swash band — the drawn surface hugs the sand a few cm up there and the live swash line
    //  owns the edge; the 5 cm scene fade printed bare-sand patches inside the water)
    float softS = mix(smoothstep(0.0, 0.05, wScRay), 1.0, wSwB * (1.0 - wScObj)) * (1.0 - wFilmObj);
    gl_FragColor.rgb *= softS; mulOut = mix(vec3(1.0), mulOut, softS);
    #ifdef WTR_CANVAS
    mulOut = pow(max(mulOut, 0.0), vec3(1.0 / 2.2));                  // the canvas holds tone-mapped sRGB (no-post tier)
    #endif
    wtrSrc1 = vec4(mulOut, 1.0);
  }
  #endif
}
`;

// replaces <fog_fragment>: three's own fog (the atmos area keeps it at density 0)
export const FRAG_FOG = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;
