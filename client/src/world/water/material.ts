// The water materials — three draws of the one clipmap (see shader.ts):
//   prepass  ShaderMaterial, depth only (the nearest water surface per pixel)
//   mul      ShaderMaterial, blended dst *= M: per-channel transmission × caustics × reef × wet sand × (1 − fresnel) —
//            what turns the cream sand behind the water into glowing turquoise, no framebuffer copy needed
//   material MeshPhysicalMaterial + the water shader (sun specular = glitter, cascaded shadows, sky irradiance, tone
//            mapping), premultiplied over: dst = src + dst·(1 − foam)
// All `wtr*` uniforms are shared + live-tunable: window.__krWater.uniforms.wtrRipple.value = 1.2
import * as THREE from "three";
import type { WaterFields } from "./fields";
import type { WaterTextures } from "./textures";
import type { WaveTile } from "./wavetile";
import { DUAL_DST_SENTINEL } from "./dualsrc";
import { FRAG_COLOR, FRAG_DEPTH_ONLY, FRAG_FOAM, FRAG_FOG, FRAG_LATE_PARS, FRAG_LIGHTS_INDIRECT, FRAG_MUL, FRAG_NORMAL, FRAG_NORMAL_FOAM, FRAG_OPAQUE, FRAG_OPAQUE_FOAM, FRAG_PARS, FRAG_ROUGH, FRAG_ROUGH_FOAM, VERT_BEGIN, VERT_BEGINNORMAL, VERT_SIMPLE, vertParsMain } from "./shader";
import { flag } from "../../flags";

export interface WaterMaterial {
  material: THREE.MeshStandardMaterial;
  materialMid: THREE.MeshStandardMaterial;
  materialFar: THREE.MeshStandardMaterial;
  foam: THREE.MeshStandardMaterial;
  foamFar: THREE.MeshStandardMaterial;
  mul: THREE.ShaderMaterial;
  prepass: THREE.ShaderMaterial;
  uniforms: Record<string, THREE.IUniform>;
}
/** the atmos area's GLSL + shared uniforms (ctx.shared "atmos"), for the multiply pass's cloud-shadowed caustics */
export interface AtmosGlsl { glsl: string; uniforms: object }

/** the sun is the only direct light the water takes: POI point / spot lights (chest glows, torches…) are compiled out —
 *  each one was a full GGX evaluation on every water pixel of the screen */
const LIGHTS_SUN_ONLY = "#ifndef WTR_SUN_SHADOW\n#define WTR_SUN_SHADOW( a, b, c ) getSunShadow( a, b, c )\n#endif\n" + THREE.ShaderChunk.lights_fragment_begin
  .replace("#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )", "#if 0")
  .replace("#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )", "#if 0")
  .replace("#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )", "#if 0")
  .replace("#if ( NUM_SUN_LIGHTS > 0 ) && defined( RE_Direct )", "#if ( NUM_SUN_LIGHTS > 0 ) && defined( RE_Direct ) && !defined( WTR_X_NOLIGHT )")
  .replace("#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )", "#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct ) && !defined( WTR_X_NOLIGHT )")
  // the water's own lighter sun-shadow lookup (shader.ts wtrSunShadow)
  .replace("getSunShadow( sunShadowMap[ i ], sunLightShadow, UNROLLED_LOOP_INDEX )", "WTR_SUN_SHADOW( sunShadowMap[ i ], sunLightShadow, UNROLLED_LOOP_INDEX )");
if (!LIGHTS_SUN_ONLY.includes("WTR_SUN_SHADOW")) console.warn("[water] three's lights chunk changed — the water's sun-shadow override is not applied");
/** the sun (SunLight or DirectionalLight) without three's GGX / Lambert evaluation: only its shadowed colour is kept
 *  (wSunLit) — the water shades itself in FRAG_OPAQUE (a white Lambert + its own cheap GGX lobe for the glitter).
 *  Perf: three's BRDF_GGX + RE_Direct_Physical per water pixel was ~10 % of the pass at eye level */
const RE_CALL = "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";
const LIGHTS_WATER = (() => {
  const parts = LIGHTS_SUN_ONLY.split(RE_CALL);
  if (parts.length !== 5) { console.warn("[water] three's lights chunk changed — the water keeps three's own sun BRDF"); return LIGHTS_SUN_ONLY; }
  const own = "\n#ifdef WTR_OWNL\n\t\twSunLit += directLight.visible ? directLight.color : vec3( 0.0 );\n#else\n\t\t" + RE_CALL + "\n#endif\n";
  return parts[0] + RE_CALL + parts[1] + RE_CALL + parts[2] + own + parts[3] + own + parts[4];
})();

/** three's SunLight shadow layout the water's per-vertex shadow coordinates assume (2 cascades per sun) */
const VSHADOW_OK = /#define SUN_LIGHT_CASCADES 2\b/.test(THREE.ShaderChunk.shadowmap_pars_fragment) && !flag("wnovshadow");
/** sRGB hex → linear colour (uniform colours are linear radiance / albedo) */
const lin = (hex: string) => new THREE.Color(hex).convertSRGBToLinear();

/** polygon offsets: the pre-pass writes the nearest surface; both colour passes sit a few units in front of it so they
 *  pass LEQUAL on exactly the pixels it won (and nothing behind), whatever tiny difference two programs make */
const OFS_PRE = -2, OFS_COLOUR = -6;

/** dual = WEBGL_blend_func_extended hooked (dualsrc.ts): the main pass also writes the multiply factor, no mul pass */
export function makeWaterMaterial(tex: WaterTextures, fields: WaterFields, obstacle: THREE.Texture, obstacleScale: number, tile: WaveTile, quality: string, atmos?: AtmosGlsl, dual = false): WaterMaterial {
  const uniforms: Record<string, THREE.IUniform> = {
    wtrTime: { value: 12 },
    wtrField: { value: fields.texture },
    wtrField2: { value: fields.texture2 },
    wtrField3: { value: fields.texture3 },
    wtrMurkP: { value: new THREE.Vector3(...fields.masks.murk) },
    wtrMurkOwned: { value: 0 },
    wtrHarborP: { value: new THREE.Vector4(...fields.masks.harbor) },
    wtrFieldST: { value: new THREE.Vector2(fields.scale, fields.offset) },
    wtrTile: { value: tile.tile.texture },
    wtrTex2: { value: tex.array },
    wtrObstacle: { value: obstacle },
    wtrObstacleScale: { value: obstacleScale },
    // ---- the water body. Absorption per metre of path, per channel (red dies first → turquoise over sand).
    // (stylised clarity: the path is capped at ~2× the depth in the shallows, see shader.ts)
    wtrAbsorb: { value: new THREE.Vector3(0.72, 0.12, 0.025) },   // red absorption preserves warm near-shore sand before the turquoise depth transition
    // THE MURK: tea-brown and nearly opaque below ~0.5 m (target #6a5534 → #3e2f16)
    wtrMurkAbsorb: { value: new THREE.Vector3(2.4, 3.0, 4.4) },
    // in-scatter albedo by depth (× the actual sun + sky light reaching the water). Shallow = the turquoise glow of
    // sunlit sand bouncing through the water; deep = open-ocean sapphire.
    // CALIBRATED (island-01-master-aerial + the eye-level beach): the aerial's deep ocean lands
    // near the target art's #0983b0-#0d93b7 (s ≥ 0.8), the eye-level 1-3 m shallows near #91d8cc / #5dcfcd.
    // (real-world reference: Grace Bay / Shoal Bay shallows): bright cyan-turquoise from the first
    // decimetres (hue ~175), aqua at 2 m, azure by 5 m — not green (hue ~150) at 0.5 m nor DARK at 2-5 m
    // (V 0.38-0.5 at eye level reads as a dark teal shelf)
    wtrRamp0: { value: new THREE.Color(0.04, 0.68, 0.66) },
    wtrRamp1: { value: new THREE.Color(0.0, 0.5, 0.56) },
    // (2-5 m less neon: brighter drew a cyan stripe along the reef shelf at eye level)
    wtrRamp2: { value: new THREE.Color(0.0, 0.4, 0.56) },
    // deeper sapphire off the shelf (turquoise fringe → navy drop-off contrast); azure-cyan — the aerial target art's
    // mid sea H193-197 V .66-.72
    wtrRamp3: { value: new THREE.Color(0.0, 0.2, 0.46) },
    // (the aerial deep must not read teal #2685b2 / #2c9a9a; the target art's open ocean is azure #2590c5 / #1274b1 /
    // #0c9fb9, hue 195-203 — the atmos grade's soft gamut caps its saturation at ~0.8 for this hue)
    // deeper sapphire off the shelf; the target art's open ocean #0279a7-#078db3, H193-197 ((0, .145, .37) read flat #2685b2)
    wtrRamp4: { value: new THREE.Color(0.0, 0.1, 0.34) },
    wtrReefTq: { value: new THREE.Color(0.0, 0.3, 0.5) },   // deeper sapphire off the shelf (turquoise fringe → navy drop-off contrast)
    wtrCoastTq: { value: new THREE.Color(0.0, 0.44, 0.62) },   // (the cliffs target art's near-coast #4ad3ed)
    wtrCoastAmt: { value: 0.65 },
    // deeper sapphire off the shelf; the target art's bright azure far sea #1f9ad2 V .82, S .85 under the sky sheen
    // ((0, .11, .2) read dark navy V .6)
    wtrEyeDeep: { value: new THREE.Color(0.0, 0.15, 0.38) },
    wtrScatterK: { value: 0.65 },     // bounded turquoise build-up; physical-depth onset is applied in shader.ts
    wtrScatterGain: { value: 1.25 },
    wtrScatHide: { value: 0.7 },     // share of the floor the in-scatter covers as it builds up (0 = additive glow)
    wtrGrazeCap: { value: 24.0 },
    wtrPathCol: { value: 1.0 },      // colour depth = this × the view path looking across the water (eye level: bluer with distance)    // path cap (× depth) looking ACROSS the water (eye level, > ~10 m): a solid body
    wtrMurkCol: { value: new THREE.Color(0.15, 0.095, 0.034) },   // THE MURK tea-brown (poi-murk's own swamp surface: 0.16, 0.105, 0.04)
    // calm lagoon / mangrove water (NE lagoon, stilt town): the target art's murky dark teal #42757b, not bleached mint
    wtrCalmCol: { value: new THREE.Color(0.035, 0.15, 0.16) },
    // (0 — Stilt Town's lagoon is the target art's glass-clear turquoise; calm water only loses its swell + surf)
    wtrCalmAmt: { value: 0.0 },
    // peel-harbor basin: the target art's saturated teal (#1FB0B8) with darker cobalt, less floor visible, choppier
    wtrHarborCol: { value: new THREE.Color(0.0, 0.3, 0.28) },
    wtrHarborAmt: { value: 0.85 },
    wtrHarborAbsorb: { value: 1.0 },
    // THE WRECK's lagoon: the target art's rich emerald turquoise (#28bb93) — red dies fast, less sky in it
    wtrLagoonP: { value: new THREE.Vector3(...fields.masks.lagoon) },
    // emerald, hue ~150 — the target art's lagoon over sand, not mint-turquoise; a touch more turquoise toward the
    // cove's #1fb39a (the disc spills over the W beaches: #149c7c read as a dark green slab at 3-7 m)
    wtrLagoonCol: { value: new THREE.Color(0.01, 0.45, 0.36) },
    wtrLagoonAmt: { value: 1.0 },
    // WRECK BAY's cove (poi-wreckbay): the same emerald lagoon look at 75 % — the cove reads emerald-turquoise
    wtrLagoon2P: { value: new THREE.Vector4(...fields.masks.lagoon2, 0.75) },
    // the opaque scene behind the water (grab.ts, per frame from index.ts): depth → contact collars + clear submerged
    // parts; colour → screen-space reflections
    wtrSceneDepth: { value: null },
    wtrSceneCol: { value: null },
    wtrGrab: { value: new THREE.Vector4(1, 1, 0, 0) },
    wtrGrabMaxV: { value: 1.0 },
    wtrCamNF: { value: new THREE.Vector2(0.1, 12000) },
    wtrProj: { value: new THREE.Matrix4() },
    wtrRefract: { value: 0.6 },
    wtrSandCool: { value: 0.42 },    // restrained carbonate cooling; matched sandy-shore captures retain visible seabed
    wtrSSR: { value: 0.95 },
    wtrContactD: { value: 1.0 },
    wtrChop: { value: 1.5 },
    wtrChopBL: { value: 0.6 },
    wtrCapOpen: { value: 0.6 },
    // (HDR, slightly cool: the target art's foam is brighter + whiter than the cream sand)
    wtrFoamCol: { value: new THREE.Color(1.08, 1.13, 1.18) },
    wtrSssCol: { value: lin("#3fe8c8") },
    wtrReef: { value: 1.0 },
    wtrCoral: { value: 0.45 },       // lighter coral heads (darker reef patches read as black holes in the turquoise)
    wtrRipple: { value: 1.0 },
    wtrRipHi: { value: 1.15 },        // ripple sky-streak exaggeration near the camera (0 = physical fresnel only)
    wtrRoughNear: { value: 0.05 },
    wtrRoughFar: { value: 0.35 },
    wtrCaustics: { value: quality === "low" ? 0 : 5.0 },
    wtrClarity: { value: 1.0 },      // × the capped view path through shallow water (lower = clearer)
    wtrFoamAmount: { value: 1.0 },
    wtrContact: { value: 1.0 },      // waterline ring foam at hulls / walls / piles / rocks / containers (0..1)
    wtrContactW: { value: 0.9 },
    wtrWhitecaps: { value: 1.0 },    // harbor-basin whitecaps (0 = off)
    wtrCrestNet: { value: 1.0 },     // the crest network: sky-bright ripple crests around darker troughs (harbor, open water)
    wtrCrestHi: { value: 0.28 },     // chop crests: sky sheen on the facets leaning away from the eye (× the mid sky)
    wtrFacet: { value: 0.3 },        // chop facet lighting of the body (wave texture from the air / across open water)     // its width scale (0.9 → a ~0.6–1.1 m wash hugging the object)
    wtrSkyReflect: { value: 1.0 },
    wtrFresnelMax: { value: 0.62 },
    wtrFresnelFar: { value: 0.45 },   // far sea keeps its deep blue body instead of mirroring the pale horizon
    wtrFresnelGraze: { value: 0.6 },
    wtrFresMidDip: { value: 0.2 },  // eye level: less sky sheen on the mid sea (10-150 m) — its deep blue body shows // …but looking ACROSS near water (a swimmer, eye-level mid distance) the sky covers the floor
    wtrShadeMin: { value: 0.65 },    // the water body in object shadow keeps this share of the sun (soft crane / hull shadows)
    wtrFloorGain: { value: 1.0 },
    // wet sand under the swash film (0.5 printed a dark brown stripe; the target art's wet band is ~10-25 % darker)
    wtrWetDark: { value: 0.73 },
    wtrGlitter: { value: flag("wphys") ? 1.0 : 0.5 },   // (× the sun's GGX lobe; F0 0.04 → 0.5)
    wtrSparkle: { value: 7.0 },      // HDR sun-glitter sparkles (× sun colour) — bloom catches them
    // ---- motion
    wtrWaveAmp: { value: 1.0 },
    wtrRunupH: { value: 0.3 },       // max swash lift (m) (run-up ≥ 1.5 m on every beach)
    wtrRunupDist: { value: 5.0 },    // max run-up distance up the beach (m)
    wtrPeriod: { value: 8.5 },       // wave period at the beach (s)
    wtrSurfLen: { value: 17 },       // spacing of the surf lines (m)
    wtrBreakDepth: { value: 0.85 },  // waves break in water shallower than this (m)
    wtrSurf: { value: 1.0 },
    wtrBreakH: { value: 0.36 },      // breaker crest height (m) in the surf zone
    wtrWetW: { value: 2.2 },         // damp fringe above the highest recent run-up (m of sand)
    wtrDryTau: { value: 9.0 },       // wet sand dries with this e-folding time (s) — real beaches: 5-20 s
    wtrSunDirW: { value: new THREE.Vector3(0, 1, 0) },
    wtrDebug: { value: 0 },
    wtrSim: { value: null },
    wtrSimST: { value: new THREE.Vector3(0, 0, 1 / 48) },
    wtrSimOn: { value: 0 },
    wtrSkyIrr: { value: new THREE.Color(0, 0, 0) },   // measured sky irradiance (skyirr.ts)
    wtrHaze: { value: 0.07 },        // share of the atmos aerial perspective applied to the water (target art: clean sea)
    wtrHaloRefl: { value: 0.2 },     // share of the sun halo in the sky reflection
    wtrReflLift: { value: 0.7 },     // reflected-sky elevation lift (0 = physical: grazing views mirror the pale horizon)
  };

  const defKey = (tag: string, mat: THREE.Material) => tag + Object.keys(mat.defines ?? {}).filter((k) => mat.defines![k]).sort().join("|");
  const patchHooks = (sh: THREE.WebGLProgramParametersWithUniforms, frag: Array<[string, string]>) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\n" + vertParsMain(atmos?.glsl))
      .replace("#include <beginnormal_vertex>", VERT_BEGINNORMAL)
      .replace("#include <begin_vertex>", VERT_BEGIN);
    let fs = sh.fragmentShader.replace("#include <common>", "#include <common>\n" + FRAG_PARS);
    for (const [a, b] of frag) fs = fs.replace(a, b);
    sh.fragmentShader = fs
      .replace("#include <fog_fragment>", FRAG_FOG)
      .replace("#include <lights_fragment_maps>", FRAG_LIGHTS_INDIRECT)
      .replace("#include <lights_fragment_end>", "");
  };

  /** mode: "near" (eye level, camera < ~12 m: the air-only foam — far surf lines, the aerial whitewater band, the churn —
   *  compiled out, and the water column + reef per VERTEX on every level: dead / per-pixel code still costs registers and
   *  instruction cache on every pixel, measured −9 % + ...), "mid" (12-120 m: everything), "far" (> 120 m: no near-only
   *  terms) */
  const makeMain = (mode: "near" | "mid" | "far") => {
    const far = mode === "far";
    // MeshStandardMaterial (not Physical: the same GGX sun lobe, without the ior / specular-colour / sheen plumbing).
    // Its F0 is 0.04 (water's is 0.02): wtrGlitter's default carries the ×0.5
    const phys = flag("wphys");
    // (the near program writes depth: it replaces the depth pre-pass — see index.ts; the far one stays depth-less)
    const m = phys ? new THREE.MeshPhysicalMaterial({
      color: 0xffffff, roughness: 0.05, metalness: 0, ior: 1.333, envMapIntensity: 1.0,
      transparent: true, depthWrite: !far, side: THREE.FrontSide, dithering: false,
    }) : new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.05, metalness: 0, envMapIntensity: 1.0,
      transparent: true, depthWrite: !far, side: THREE.FrontSide, dithering: false,
    });
    m.forceSinglePass = true;
    // premultiplied over the multiplied scene (NoBlending + depthWrite while the camera is under water: index.ts).
    // Dual-source: dst = src0 + dst·src1 (src1 = the multiply factor; the sentinel dst factor becomes SRC1_COLOR)
    m.blending = THREE.CustomBlending;
    m.blendEquation = THREE.AddEquation; m.blendSrc = THREE.OneFactor; m.blendDst = dual ? (DUAL_DST_SENTINEL as unknown as THREE.BlendingDstFactor) : THREE.OneMinusSrcAlphaFactor;
    if (dual) { m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor; }
    m.polygonOffset = true; m.polygonOffsetFactor = -1; m.polygonOffsetUnits = OFS_COLOUR;
    m.name = far ? "kr-water-far" : mode === "mid" ? "kr-water-mid" : "kr-water";
    m.defines = m.defines || {};
    if (mode === "near") { m.defines.WTR_NEAR = 1; m.defines.WTR_VALL = 1; }
    // Preset SSR tiers: Low = 6+2 steps, Medium (WTR_LITE) = 9+3 steps, High = 20+3, Ultra = 24+4
    if (quality === "low") m.defines.WTR_LOW = 1;
    if (quality === "medium" || quality === "low") m.defines.WTR_LITE = 1;
    if (quality === "ultra") m.defines.WTR_ULTRA = 1;
    if (!far && !flag("wnoscene")) m.defines.WTR_SCENE = 1;
    // (the coral heads: per pixel from the air — the far program — per vertex near the camera, where the clipmap cells
    // are finer than the field's 2 m texels)
    if (dual) { m.defines.WTR_DUAL_SRC = 1; if (far) m.defines.WTR_MULFLD2 = 1; }
    m.defines.WTR_SKYIRR = 1;
    // per-vertex sun-shadow coordinates: only while three's SunLight keeps 2 cascades (the vertex re-declares its matrices)
    if (VSHADOW_OK) m.defines.WTR_VSHADOW = 1;
    if (atmos) m.defines.WTR_VATM = 1;
    if (far) m.defines.WTR_FAR = 1;
    // the water column per vertex on the near clipmap levels (shader.ts wtrColumn): the near program only (the aerial
    // keeps its per-pixel reef edges)
    else m.defines.WTR_VCORE = 1;
    m.onBeforeCompile = (shader) => patchHooks(shader, [
      // (atmos patches every lit material after us: its screen-space AO / canopy sky visibility would fetch its AO
      // buffer on every water pixel and darken the sea's own in-scatter next to the shore — the water has its own
      // object shading. Taking these anchors away leaves the water out of both hooks)
      ["#include <aomap_fragment>", ""],
      ["vec3 totalDiffuse = reflectedLight.directDiffuse", "vec3 totalDiffuse = vec3( 0.0 ) + reflectedLight.directDiffuse"],
      ["#include <clipping_planes_pars_fragment>", "#include <clipping_planes_pars_fragment>\n" + FRAG_LATE_PARS],
      ["#include <color_fragment>", FRAG_COLOR],
      ["#include <roughnessmap_fragment>", FRAG_ROUGH],
      ["#include <normal_fragment_maps>", FRAG_NORMAL],
      ["#include <opaque_fragment>", FRAG_OPAQUE],
      ["#include <lights_fragment_begin>", LIGHTS_WATER],
    ]);
    m.defines.WTR_OWNLIGHT = 1;
    m.customProgramCacheKey = () => defKey("kr-water-v8", m);
    return m;
  };
  // near + far programs of the main pass (index.ts shows one): the far one (camera high above the sea: the aerial, the
  // drop) leaves out every near-only term
  const m = makeMain("near"), mMid = makeMain("mid"), mFar = makeMain("far");

  // ---- pass 1: multiply
  const mulUniforms: Record<string, THREE.IUniform> = { ...uniforms };
  let mulFrag = FRAG_MUL;
  const mulDefines: Record<string, number> = { WTR_MUL: 1 };
  if (atmos) {
    Object.assign(mulUniforms, atmos.uniforms as Record<string, THREE.IUniform>);
    mulFrag = mulFrag.replace("ATMOS_GLSL_HERE", atmos.glsl);
    mulDefines.WTR_ATMOS = 1;
  }
  const mul = new THREE.ShaderMaterial({
    name: "kr-water-mul", uniforms: mulUniforms, defines: mulDefines, vertexShader: VERT_SIMPLE, fragmentShader: mulFrag,
    transparent: true, depthWrite: false, depthTest: true, fog: false, lights: false, toneMapped: false,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: OFS_COLOUR,
  });
  // (alpha: keep the destination's)
  mul.blendSrcAlpha = THREE.ZeroFactor; mul.blendDstAlpha = THREE.OneFactor;
  mul.forceSinglePass = true;

  // ---- pass 0: depth pre-pass
  const prepass = new THREE.ShaderMaterial({
    name: "kr-water-depth", uniforms, vertexShader: VERT_SIMPLE, fragmentShader: FRAG_DEPTH_ONLY,
    transparent: true, depthWrite: true, depthTest: true, colorWrite: false, fog: false, lights: false, toneMapped: false,
    blending: THREE.NoBlending, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: OFS_PRE,
  });
  prepass.forceSinglePass = true;

  // ---- pass 3: foam (after the main pass; premultiplied over; discards open water early) — near + far programs
  const makeFoam = (far: boolean) => {
    const foam = new THREE.MeshStandardMaterial({
      color: 0xffffff, roughness: 0.9, metalness: 0, envMapIntensity: 1.0,
      transparent: true, depthWrite: false, side: THREE.FrontSide,
    });
    foam.forceSinglePass = true;
    foam.blending = THREE.CustomBlending;
    foam.blendEquation = THREE.AddEquation; foam.blendSrc = THREE.OneFactor; foam.blendDst = THREE.OneMinusSrcAlphaFactor;
    foam.polygonOffset = true; foam.polygonOffsetFactor = -1; foam.polygonOffsetUnits = OFS_COLOUR;
    foam.name = far ? "kr-water-foam-far" : "kr-water-foam";
    foam.defines = { WTR_FOAMPASS: 1, WTR_SKYIRR: 1 };
    if (atmos) foam.defines.WTR_VATM = 1;
    if (far) foam.defines.WTR_FAR = 1;
    if (!far && !flag("wnoscene")) foam.defines.WTR_SCENE = 1;
    foam.onBeforeCompile = (shader) => patchHooks(shader, [
      ["#include <color_fragment>", FRAG_FOAM],
      ["#include <roughnessmap_fragment>", FRAG_ROUGH_FOAM],
      ["#include <normal_fragment_maps>", FRAG_NORMAL_FOAM],
      ["#include <opaque_fragment>", FRAG_OPAQUE_FOAM],
      ["#include <lights_fragment_begin>", LIGHTS_SUN_ONLY],
    ]);
    foam.customProgramCacheKey = () => defKey("kr-water-foam-v4", foam);
    return foam;
  };
  const foam = makeFoam(false), foamFar = makeFoam(true);
  return { material: m, materialMid: mMid, materialFar: mFar, foam, foamFar, mul, prepass, uniforms };
}
