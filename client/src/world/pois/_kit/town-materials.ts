// poi-town material set: one PBR material per surface family, all vertex-colour tinted, so a whole POI merges into
// ~a dozen draw calls. `TownBins` = the GeoBins a POI fills, then `buildBins` adds the merged meshes to a group.
import { Coplanar } from "./coplanar";
import type { CoStats } from "./coplanar-solve";
import { ctxPace, PACE_CHECK_MS, type Pace } from "./pace";
import * as THREE from "three";
import { GeoBin } from "./town-geo";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { WorldCtx } from "../../../engine/engine";
import { townTex, TOWN_TEX_SETS as S, blobTexture, netTexture, canvasTexture, signCanvas, type TownTex } from "./town-tex";
import { flag } from "../../../flags";
import { releaseBatchAfterUpload } from "../../../engine/geometry-release";
import { isGlassMat } from "../../glass-fx";
export { preloadTownTex } from "./town-tex";

export interface TownMats {
  tex: TownTex;
  plaster: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  tin: THREE.MeshStandardMaterial;
  clapboard: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  woodDark: THREE.MeshStandardMaterial;
  stairBase: THREE.MeshStandardMaterial;
  stairWood: THREE.MeshStandardMaterial;
  stairRail: THREE.MeshStandardMaterial;
  paving: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  thatch: THREE.MeshStandardMaterial;
  sand: THREE.MeshStandardMaterial;
  stripes: THREE.MeshStandardMaterial;
  louvre: THREE.MeshStandardMaterial;
  plastic: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  fabric: THREE.MeshStandardMaterial;
  leaf: THREE.MeshStandardMaterial;
  fruit: THREE.MeshStandardMaterial;
  bronze: THREE.MeshStandardMaterial;
  bulb: THREE.MeshStandardMaterial;
  net: THREE.MeshStandardMaterial;
  rope: THREE.MeshStandardMaterial;
  /** clean interior paint (walls, ceilings) */
  inner: THREE.MeshStandardMaterial;
  /** natural rock (boulders, barnacle sleeves) — no block pattern */
  rock: THREE.MeshStandardMaterial;
  /** textured alpha-cut banana leaf (hero banana plants) */
  bleaf: THREE.MeshStandardMaterial;
  /** painted window / door / shop decals (FACADE atlas, alpha = where the vertex colour tints) for LOD1 shells */
  facade: THREE.MeshStandardMaterial;
  /** soft dark contact-shadow decals under props (transparent, no depth write) */
  blob: THREE.MeshBasicMaterial;
  /** painted fruit-heap mounds (mango / banana), metre UVs — the heap from afar when the fruit instances are hidden */
  heapM: THREE.MeshStandardMaterial;
  heapB: THREE.MeshStandardMaterial;
  sign(text: string, bg: string, fg: string): THREE.MeshStandardMaterial;
}

let cached: TownMats | null = null;
export function townMats(renderer: THREE.WebGLRenderer): TownMats {
  if (cached) return cached;
  const tex = townTex(renderer);
  const plaster = tex.material("plaster", S.plaster, { normalScale: 0.7 });
  // chipped paint reveals the cream under-plaster (texture alpha = paint coverage), not a darker blotch of the tint
  // the chip density varies across town (a slow world-space noise, 0.3–1 ×, so no two walls match), a
  // warm dirt band hugs the ground and faint warm drip streaks run down from each storey line
  plaster.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vTownPW;").replace("#include <begin_vertex>", "#include <begin_vertex>\nvTownPW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vTownPW;
float townH2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float townVN(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(townH2(i), townH2(i + vec2(1.0, 0.0)), f.x), mix(townH2(i + vec2(0.0, 1.0)), townH2(i + vec2(1.0, 1.0)), f.x), f.y); }`).replace("#include <color_fragment>", `#if defined( USE_COLOR ) && defined( USE_MAP )
  float chipK = mix(0.3, 1.0, townVN(vTownPW.xz * 0.07 + 3.1));
  float cover = clamp(1.0 - (1.0 - sampledDiffuseColor.a) * chipK, 0.0, 1.0);
  diffuseColor.rgb *= mix( vec3( 0.93, 0.88, 0.8 ), vColor.rgb, cover );
  // drips: thin vertical streaks hanging below each ~3.1 m storey line, stronger just under it
  float storey = fract(vTownPW.y / 3.1 + 0.03);
  float col = townVN(vec2((vTownPW.x + vTownPW.z) * 3.1, 0.5));
  float drip = smoothstep(0.62, 0.9, col) * (1.0 - smoothstep(0.0, 0.55, 1.0 - storey)) * 0.0 + smoothstep(0.66, 0.92, col) * smoothstep(0.35, 0.98, storey) * 0.22;
  diffuseColor.rgb *= 1.0 - drip * vec3(0.55, 0.6, 0.75);
  diffuseColor.a = opacity;
#else
  #include <color_fragment>
#endif`);
  };
  plaster.customProgramCacheKey = () => "town-plaster-chips-r4";
  const trim = tex.material("plaster", S.plaster, { normalScale: 0.4, envMapIntensity: 1.0 });
  trim.roughness = 0.85;
  // double-sided: roofs + awnings are single sheets and players see them from BELOW
  const tin = tex.material("tin", S.tin, { normalScale: 1.0, envMapIntensity: 1.1, side: THREE.DoubleSide });
  tin.shadowSide = THREE.DoubleSide;
  const facade = tex.material("facade", S.facade, { normalScale: 0.9, envMapIntensity: 1.0 });
  facade.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <color_fragment>", `#if defined( USE_COLOR ) && defined( USE_MAP )
  diffuseColor.rgb *= mix( vec3( 1.0 ), vColor.rgb, sampledDiffuseColor.a );
  diffuseColor.a = opacity;
#else
  #include <color_fragment>
#endif`);
  };
  facade.customProgramCacheKey = () => "town-facade-mask";
  const rock = tex.material("rock", S.rock, { normalScale: 1.0, envMapIntensity: 0.8 });
  const bleaf = tex.material("bananaLeaf", S.bananaLeaf, { normalScale: 0.8, side: THREE.DoubleSide, alphaTest: 0.5, envMapIntensity: 0.9 });
  bleaf.metalness = 0; bleaf.metalnessMap = null;
  for (const t of [bleaf.map, bleaf.normalMap, bleaf.roughnessMap]) if (t) { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; }
  bleaf.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * vec3(0.12, 0.16, 0.05);");
  };
  bleaf.customProgramCacheKey = () => "town-bleaf-sss";
  const clapboard = tex.material("clapboard", S.clapboard, { normalScale: 0.9 });
  const wood = tex.material("planks", S.planks, { normalScale: 0.8 });
  const woodDark = tex.material("planksDark", S.planksDark, { normalScale: 0.9 });
  const paving = tex.material("paving", S.paving, { normalScale: 1.0 });
  const stone = tex.material("stone", S.stone, { normalScale: 0.8 });
  const thatch = tex.material("thatch", S.thatch, { normalScale: 1.0, side: THREE.DoubleSide });
  const sand = tex.material("sand", S.sand, { normalScale: 0.6 });
  const stripes = tex.material("stripes", S.stripes, { normalScale: 0.3, side: THREE.DoubleSide, vertexColors: true });
  const louvre = tex.material("louvre", S.louvre, { normalScale: 1.0 });
  const plasticSet = tex.get("plaster", S.plaster);
  const plastic = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.0, normalMap: plasticSet.normalMap, envMapIntensity: 0.9, name: "town:plastic" });
  plastic.normalScale.setScalar(0.25);
  const metal = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.85, normalMap: plasticSet.normalMap, envMapIntensity: 1.0, name: "town:metal" });
  metal.normalScale.setScalar(0.35);
  // (real glass — see-through at 50 % with a strong sky reflection; an opaque metallic blue-grey reads as a
  //  painted panel from both sides. 0.5 exactly: the parity tool still counts the pane as drawn (its collider is glass))
  const glass = new THREE.MeshStandardMaterial({ color: "#b8d6df", roughness: 0.04, metalness: 0.1, envMapIntensity: 2.2, side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthWrite: false, name: "town:glass" });
  const fabric = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, name: "town:fabric" });
  const leaf = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, side: THREE.DoubleSide, name: "town:leaf" });
  // foliage never goes black in shade: a little light through the leaves (fake translucency) + back faces lit like fronts
  leaf.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * vec3(0.16, 0.2, 0.08);");
  };
  leaf.customProgramCacheKey = () => "town-leaf-sss";
  const fruit = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0, envMapIntensity: 0.75, name: "town:fruit" });
  const bronze = new THREE.MeshStandardMaterial({ color: "#5a4a34", roughness: 0.5, metalness: 0.75, envMapIntensity: 1.0, name: "town:bronze" });
  const bulb = new THREE.MeshStandardMaterial({ color: "#fff2c0", emissive: "#ffcf6a", emissiveIntensity: 2.6, roughness: 0.3, name: "town:bulb" });
  // fine fishing net: alpha-BLENDED (not alpha-tested) so the mesh fades into a cream veil in the mips instead of vanishing
  // (brighter cream + a little self-light so a net in the porch shade still reads as cream twine, not a tinted veil)
  const net = new THREE.MeshStandardMaterial({ map: netTexture(), transparent: true, depthWrite: false, alphaTest: 0.02, side: THREE.DoubleSide, roughness: 0.9, color: "#fff8e8", emissive: "#6a5c44", name: "town:net" });
  const rope = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, name: "town:rope" });
  const inner = tex.material("interior", S.interior, { normalScale: 0.5 });
  inner.aoMapIntensity = 0.5;
  // Architectural stairs do not pass through the kit's baked room-light builder.
  // Match its 0.06 albedo-scaled bounce locally, keeping outdoor materials intact.
  const stairMaterial = (source: THREE.MeshStandardMaterial, name: string) => {
    const material = source.clone(); material.name = `town:${name}`;
    material.onBeforeCompile = (shader, renderer) => {
      source.onBeforeCompile.call(material, shader, renderer);
      shader.fragmentShader = shader.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * 0.06;");
    };
    material.customProgramCacheKey = () => `${source.customProgramCacheKey()}|interior-stair-bounce-0.06`;
    return material;
  };
  const stairBase = stairMaterial(inner, "stair-base"), stairWood = stairMaterial(wood, "stair-wood"), stairRail = stairMaterial(woodDark, "stair-rail");
  const blob = new THREE.MeshBasicMaterial({ color: "#1c140c", alphaMap: blobTexture(), transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, vertexColors: true, name: "town:blob" });
  const heapM = tex.material("heapMango", S.heapMango, { normalScale: 1.0, envMapIntensity: 0.9 });
  const heapB = tex.material("heapBanana", S.heapBanana, { normalScale: 1.0, envMapIntensity: 0.9 });
  heapM.metalness = heapB.metalness = 0; heapM.metalnessMap = heapB.metalnessMap = null;
  const signs = new Map<string, THREE.MeshStandardMaterial>();
  const sign = (text: string, bg: string, fg: string) => {
    const k = text + bg + fg; let m = signs.get(k);
    if (!m) { m = new THREE.MeshStandardMaterial({ map: canvasTexture(signCanvas(text, bg, fg)), roughness: 0.7, name: "town:sign" }); signs.set(k, m); }
    return m;
  };
  cached = { tex, heapM, heapB, rock, bleaf, facade, plaster, trim, tin, clapboard, wood, woodDark, stairBase, stairWood, stairRail, paving, stone, thatch, sand, stripes, louvre, plastic, metal, glass, fabric, leaf, fruit, bronze, bulb, net, rope, inner, blob, sign };
  return cached;
}

export type BinName = "plaster" | "trim" | "tin" | "clapboard" | "wood" | "woodDark" | "paving" | "stone" | "thatch" | "sand" | "stripes" | "louvre" | "plastic" | "metal" | "glass" | "fabric" | "leaf" | "fruit" | "bronze" | "bulb" | "net" | "rope" | "inner" | "blob" | "facade" | "bleaf" | "rock" | "heapM" | "heapB" | "stairBase" | "stairWood" | "stairRail";
export type TownBins = Record<BinName, GeoBin>;

export function makeBins(m: TownMats, prefix: string): TownBins {
  const names: BinName[] = ["plaster", "trim", "tin", "clapboard", "wood", "woodDark", "paving", "stone", "thatch", "sand", "stripes", "louvre", "plastic", "metal", "glass", "fabric", "leaf", "fruit", "bronze", "bulb", "net", "rope", "inner", "blob", "facade", "bleaf", "rock", "heapM", "heapB", "stairBase", "stairWood", "stairRail"];
  const out = {} as TownBins;
  for (const n of names) out[n] = new GeoBin(`${prefix}:${n}`, m[n]);
  out.bulb.keepTiny = true;
  out.glass.castShadow = false; out.bulb.castShadow = false; out.net.castShadow = false; out.blob.castShadow = false; out.blob.receiveShadow = false;
  return out;
}
export function buildBins(bins: TownBins, group: THREE.Group): number {
  let n = 0;
  for (const b of Object.values(bins)) { const mesh = b.build(); if (mesh) { group.add(mesh); n++; } }
  return n;
}

/** bins whose content never casts a sun shadow (small / thin / flat / emissive stuff — invisible in the shadow maps but
 *  the most expensive casters per pixel of shadow they produce) */
export const NO_CAST: BinName[] = ["fruit", "bulb", "rope", "net", "glass", "leaf", "fabric", "paving", "sand", "louvre", "inner", "blob", "metal", "facade", "heapM", "heapB", "stairBase"];

// ================================================================================================ distance LOD
type Tier = "fine" | "near" | "main" | "lod1" | "lo" | "shadow" | "mid" | "far" | "med";
const TIERS: Tier[] = ["fine", "near", "main", "lod1", "lo", "shadow", "mid", "far", "med"];
/** coplanar-resolver tags: tiers drawn at the same time compare their boxes (fine + near + main = up close) */
const CO_TAG: Record<Tier, number> = { fine: 1, near: 1, main: 1, lod1: 2, lo: 3, shadow: 9, mid: 4, far: 5, med: 6 };
/** (perf) the TownLod switch tests as plain functions: no per-frame closures (two per LOD
 * unit, thousands at Mango Market) and no Math.hypot (slow in V8); same maths, same hysteresis */
const dist2 = (x: number, z: number) => Math.sqrt(x * x + z * z);
const dist3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);
/** within `lim` (with hysteresis `h` once on) */
const hyst = (force: boolean, dc: number, on: boolean, lim: number, h: number) => force ? dc < lim : on ? dc < lim + h : dc < lim;
/** beyond `lim` (with hysteresis) */
const past = (force: boolean, dc: number, on: boolean, lim: number, h: number) => force ? dc > lim : on ? dc > lim - h : dc > lim;
const tierRec = <T>(v: () => T): Record<Tier, T> => ({ fine: v(), near: v(), main: v(), lod1: v(), lo: v(), shadow: v(), mid: v(), far: v(), med: v() });
/** one LOD unit: a grid cell (props, ground) or a single building. Its tiers switch on camera distance. */
interface LodItem {
  /** hierarchy: `pdist` = a prop DISTRICT (its props' low / far copies, replacing its child prop cells when the
   *  whole district is beyond `propMid`); `igroup` = a building-group PARENT (its buildings' LOD1 merged, replacing the
   *  child items when all of them would draw LOD1 anyway) */
  k: string; kind: "cell" | "fine" | "item" | "prop" | "pdist" | "igroup";
  parent?: LodItem;
  /** igroup: the largest `mid` among its children (it replaces them beyond it) */
  maxMid: number;
  /** item: world y of its roof — the furniture (fine) tier is only drawn with the camera below it (+1 m) */
  top: number;
  bins: Partial<Record<Tier, TownBins>>;
  ids: Record<Tier, Array<[THREE.BatchedMesh, number, boolean, number]>>;
  tris: Record<Tier, number>;
  on: Record<Tier, boolean>;
  cx: number; cz: number; r: number;
  /** 3D bounding sphere of the content (frustum test) */
  sy: number; sr: number;
  mid: number; near: number; fine: number;
  /** the (tier on-mask, in-view, in-cast-pad) state last applied to the batches — unchanged → no per-id work */
  applied: number;
  /** drawn coverage per tier 0..1: a tier switch is a TOWN_FADE_T s dithered crossfade (both tiers
   *  drawn through complementary masks), never a one-frame swap; `fading` = some tier is between 0 and 1 */
  f: Record<Tier, number>;
  fading: boolean;
}
/** props (stalls, crates, scooters, carts…) cast from their big solid parts in both their full and low copies */
const PROP_CAST: BinName[] = ["stripes", "tin", "wood", "woodDark", "plastic", "stone"];
/** which merged batches a tier's bin goes to — casting is decided per (item kind, tier, bin).
 *  SHADOW PROXIES — a building's full shell (item `main`) and a prop's full kit (prop `fine`) never cast: their
 *  cheap twins (the building's LOD1 box, the prop's low-detail copy) cast instead through an invisible "shadow" tier
 *  that is on whenever the full tier is (5–9 k → 0.3–0.5 k shadow tris a building, ~4 k → ~0.6 k a stall). */
function casts(tier: Tier, name: BinName, kind: LodItem["kind"]): boolean {
  // props never cast from their visible tiers — their low copy casts through the shadow tier (within `castProp`)
  if (kind === "prop" || kind === "pdist" || kind === "igroup") return false;
  if (tier === "mid" || tier === "far" || tier === "med") return false;
  // an item's LOD1 casts through the shadow tier too (within `castItem`); beyond, the far map carries the proxy town
  if (kind === "item" && tier === "lod1") return false;
  if (tier === "fine" || tier === "lo") return false;
  if (tier === "near") return name === "stripes" || name === "tin";
  if (tier === "lod1") return name !== "facade" && !NO_CAST.includes(name);
  if (kind === "item" && tier === "main") return false;
  return !NO_CAST.includes(name);
}
/** (sub-draw budget) the cheap tiers draw through FEWER materials — each alias shares one GeoBin (and batch), so a
 *  LOD1 building is ~5 sub-draws instead of ~10, a prop cell's low copy ~5 instead of ~9. The shared material is the
 *  closest look (trim / stone → plaster, wood → dark planks, metal / rope → plastic). */
function aliasBins(b: TownBins, t: Tier) {
  const A = b as Record<BinName, GeoBin>;
  if (t === "lod1" || t === "med") {
    A.trim = A.plaster; A.stone = A.plaster; A.wood = A.woodDark; A.metal = A.plastic; A.louvre = A.woodDark; A.rope = A.plastic;
    A.fabric = A.plastic; A.bleaf = A.leaf; A.heapB = A.heapM; A.inner = A.plaster; A.clapboard = A.clapboard;
  } else {
    A.metal = A.plastic; A.rope = A.plastic; A.bronze = A.plastic; A.louvre = A.wood; A.woodDark = A.wood; A.fabric = A.plastic;
  }
  // Cheap exterior tiers retain their existing material families and batching.
  A.stairBase = A.inner; A.stairWood = A.wood; A.stairRail = A.woodDark;
}
// ================================================================================================ town crossfade
// Every TownLod
// switch (far proxy town ↔ detailed town, building groups' LOD1 ↔ medium ↔ full shells, prop districts / cells, floors,
// furniture) would be a one-frame BatchedMesh visibility flip — and the batches / proxy group toggling `visible` would be
// picked up by the engine's vis-fade, which SCALES a whole object about its centre over 0.3 s (the whole town growing
// out of its middle when the drop crosses 240 m). Instead: a per-instance coverage in the batch colour's alpha (rgb stays
// white) drives a dithered crossfade like the vegetation's (interleaved gradient noise, moving every frame under TAA so
// the history blends the two tiers); the incoming tier keeps the pixels where d < f, the outgoing where d > 1 − f.
// The batches and the proxy are `noCull` (no engine scale fades). ?townxfade=0 = the old swaps (A/B).
export const TOWN_XFADE = flag("townxfade");
/** crossfade duration (s) — like the vegetation's tier crossfade */
export const TOWN_FADE_T = 0.45;
/** x = TAA on (mirrors atmos' uAtmTemporal), y = frame number — the dither moves per frame under TAA */
const TOWN_FADE_U = { value: new THREE.Vector2(0, 0) };
const TOWN_DITHER_GLSL = `uniform vec2 uTownFadeT;
float townDither() {
  vec2 p = gl_FragCoord.xy + ( uTownFadeT.x > 0.5 ? 5.588238 * mod( uTownFadeT.y, 64.0 ) : 0.0 );
  return fract( 52.9829189 * fract( 0.06711056 * p.x + 0.00583715 * p.y ) );
}`;
/** a batch material: the coverage test on the instance colour's alpha (only in the BatchedMesh colour variant — the same
 *  material on a plain mesh compiles unchanged), the alpha never reaches diffuseColor */
function fadeMaterial(m: THREE.Material) {
  if (!TOWN_XFADE || (m as THREE.ShaderMaterial).isShaderMaterial || m.userData.townFade) return;
  m.userData.townFade = true;
  const prev = m.onBeforeCompile, k0 = m.customProgramCacheKey();
  m.onBeforeCompile = function (sh, r) {
    prev.call(this, sh, r);
    sh.uniforms.uTownFadeT = TOWN_FADE_U;
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\n#ifdef USE_BATCHING_COLOR\n${TOWN_DITHER_GLSL}\n#endif`)
      .replace("#include <color_fragment>", "#ifdef USE_BATCHING_COLOR\n  diffuseColor.rgb *= vColor.rgb;\n#else\n  #include <color_fragment>\n#endif")
      .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
#ifdef USE_BATCHING_COLOR
  { float tfA = abs( vColor.a ); if ( tfA < 0.999 ) { float tfD = townDither(); if ( vColor.a < 0.0 ) tfD = 1.0 - tfD; if ( tfA <= tfD ) discard; } }
#endif`);
  };
  m.customProgramCacheKey = () => `${k0}|town-xfade1`;
}
/** the far proxy town's own coverage (signed like an instance's: < 0 = fading out) */
function fadeProxyMaterial(m: THREE.Material, u: { value: number }) {
  const prev = m.onBeforeCompile, k0 = m.customProgramCacheKey();
  m.onBeforeCompile = function (sh, r) {
    prev.call(this, sh, r);
    sh.uniforms.uTownFadeT = TOWN_FADE_U; sh.uniforms.uTownProxyF = u;
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\nuniform float uTownProxyF;\n${TOWN_DITHER_GLSL}`)
      .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
  { float tfA = abs( uTownProxyF ); if ( tfA < 0.999 ) { float tfD = townDither(); if ( uTownProxyF < 0.0 ) tfD = 1.0 - tfD; if ( tfA <= tfD ) discard; } }`);
  };
  m.customProgramCacheKey = () => `${k0}|town-proxy-xfade1`;
}
const _c4 = new THREE.Vector4(1, 1, 1, 1);
const _bb = new THREE.Box3(), _bs = new THREE.Sphere();

let shadowOnly: THREE.ShaderMaterial | null = null;
/** the invisible material of the shadow-proxy batches: in the MAIN pass every vertex is thrown outside the clip volume
 *  (nothing rasterises); the shadow passes draw them with three's own depth material (double-sided: LOD1 walls are
 *  open boxes and its roof / awning sheets single quads) */
export function shadowOnlyMaterial(): THREE.ShaderMaterial {
  return (shadowOnly ??= Object.assign(new THREE.ShaderMaterial({
    vertexShader: "void main() { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); }",
    fragmentShader: "void main() { gl_FragColor = vec4( 0.0 ); }",
    colorWrite: false, depthWrite: false, depthTest: false, shadowSide: THREE.DoubleSide,
  }), { name: "town:shadow-proxy" }));
}

/**
 * Distance LOD for a whole POI, drawn through BatchedMesh: every (material, casts) pair is ONE multi-draw batch
 * for the whole POI, and each cell / building tier is an instance in it that is shown or hidden per camera distance
 * (+ culled per instance against each camera / shadow cascade). So draws do not scale with the number of cells.
 *  - cells (`cell`-metre squares in an optional frame): ground, props, lights. Tiers fine / near / main.
 *  - fine cells (own `fineCell` grid): furniture, room dressing, individual fruit, drawn within `fine` metres.
 *  - items (`item()`): one building each — main (full shell) within its `mid`, LOD1 (textured facade box) beyond it,
 *    near (floors, flower boxes…) within `near`, fine (furniture) within `fine`.
 *  - PROXY: one merged box town, the only thing drawn beyond `far` from the POI's bounds (atmos' far shadow map).
 */
const PARITY = flag("nocull");
export class TownLod {
  private items = new Map<string, LodItem>();
  private batches: THREE.BatchedMesh[] = [];
  readonly proxy: { wall: GeoBin; plain: GeoBin; ground: GeoBin };
  private gProxy = new THREE.Group();
  private minX = Infinity; private maxX = -Infinity; private minZ = Infinity; private maxZ = -Infinity;
  private farOn = false;
  private tick = 0;
  constructor(private mats: TownMats, private prefix: string, readonly o: {
    cell?: number; fineCell?: number; fine?: number; near?: number; mid?: number; cellMid?: number; far?: number; frame?: (x: number, z: number) => [number, number];
    /** prop cells (`prop()`): cell size, full-detail distance, low-detail distance (default `near`) */
    propCell?: number; propHi?: number; propLo?: number; propMid?: number;
    /** prop district size (m) — see `prop()`; 0 = no districts */
    propDistrict?: number;
    /** buildings (`item()`): distance of their near tier (floors, flower boxes, lamps) and fine tier (furniture) */
    itemNear?: number; itemFine?: number;
    /** shadow distances — an item's (building's) LOD1 twin casts only within `castItem` m, a prop cell's low copy
     *  within `castProp` m (the atmos far map carries the proxy town's shadows beyond) */
    castItem?: number; castProp?: number;
    /** prop FAR tier (`prop().far`: canopy / bunting / light-strip cards) drawn from `propLo` out to `propFar` m */
    propFar?: number;
    /** item MEDIUM tier (`item().med`, a cheaper shell) drawn from `itemMed` m out to the item's `mid` */
    itemMed?: number;
  } = {}) {
    this.proxy = { wall: new GeoBin(`${prefix}:proxy-wall`, proxyMats().wall), plain: new GeoBin(`${prefix}:proxy-plain`, proxyMats().plain), ground: new GeoBin(`${prefix}:proxy-ground`, proxyMats().ground) };
    // the collider ≡ visual parity tool (?nocull) measures the FULL-detail tier everywhere it looks — the
    // colliders are exact to the geometry a kong sees up close, not to the 25–110 m medium copies (painted facades)
    if (PARITY) Object.assign(this.o, { fine: 80, itemFine: 80, itemNear: 80, propHi: 80, propMid: 80, propLo: 120, itemMed: 80 });
  }
  private grow(x: number, z: number) { this.minX = Math.min(this.minX, x); this.maxX = Math.max(this.maxX, x); this.minZ = Math.min(this.minZ, z); this.maxZ = Math.max(this.maxZ, z); }
  private get(k: string, kind: LodItem["kind"], o: { mid?: number; near?: number; fine?: number } = {}): LodItem {
    let it = this.items.get(k);
    if (!it) {
      it = { k, kind, bins: {}, ids: tierRec(() => []), tris: tierRec(() => 0), on: tierRec(() => false), f: tierRec(() => 0), fading: false, cx: 0, cz: 0, r: 0, sy: 0, sr: 0, applied: -1, maxMid: 0, top: 1e9,
        mid: Math.max(PARITY ? 80 : 0, o.mid ?? (kind === "item" ? this.o.mid ?? 1e9 : this.o.cellMid ?? 1e9)),
        near: o.near ?? (kind === "prop" ? this.o.propLo ?? this.o.near ?? 95 : kind === "item" ? this.o.itemNear ?? this.o.near ?? 95 : this.o.near ?? 95),
        fine: o.fine ?? (kind === "prop" ? this.o.propHi ?? 22 : kind === "item" ? this.o.itemFine ?? this.o.fine ?? 45 : this.o.fine ?? 45) };
      this.items.set(k, it);
    }
    return it;
  }
  private tier(it: LodItem, t: Tier): TownBins {
    let b = it.bins[t];
    if (!b) {
      b = it.bins[t] = makeBins(this.mats, `${this.prefix}:${t}:${it.k}`); if (t === "lod1" || t === "lo" || t === "far" || t === "med") aliasBins(b, t);
      // every box of a drawn tier registers with the POI's coplanar resolver; tiers that draw together share a tag
      if (t !== "shadow") for (const g of Object.values(b) as GeoBin[]) { g.co = this.co; g.coTag = CO_TAG[t]; }
    }
    return b;
  }
  /** z-fight resolver over every box this POI's tiers collect (runs once, before the batches are built) */
  readonly co = new Coplanar();
  private cellOf(x: number, z: number) {
    const cs = this.o.cell ?? 64, [u, v] = this.o.frame ? this.o.frame(x, z) : [x, z];
    this.grow(x, z);
    return this.get(`c${Math.floor(u / cs)},${Math.floor(v / cs)}`, "cell");
  }
  /** finest bins (furniture, individual fruit, room dressing) — drawn within `fine` metres */
  fine(x: number, z: number): TownBins {
    const cs = this.o.fineCell ?? 32;
    this.grow(x, z);
    return this.tier(this.get(`f${Math.floor(x / cs)},${Math.floor(z / cs)}`, "fine"), "fine");
  }
  /** a PROP cell (`propCell` m): `hi` = the full kit, drawn within `propHi` m of the cell's content; `lo` = the SAME props
   *  built again inside `lowDetail()` (plain boxes, fewer segments, no tiny parts, no fruit), drawn from `propHi` to
   *  `propLo` — exclusive, so a stall costs ~4 k tris up close and ~0.6 k across the plaza */
  prop(x: number, z: number, key?: string): { hi: TownBins; lo: TownBins; mid: TownBins; far: TownBins; plo: TownBins | null; sh: TownBins; psh: TownBins | null } {
    const cs = this.o.propCell ?? 12;
    this.grow(x, z);
    // `key`: a prop unit of its own (long string lights / bunting — their span would bloat a cell's bounds)
    const it = this.get(key ?? `p${Math.floor(x / cs)},${Math.floor(z / cs)}`, "prop");
    // every prop cell belongs to a DISTRICT (`propDistrict` m) that draws the district's low copies as one unit
    // once the whole district is beyond `propMid` (and its far cards beyond `propLo`) — fewer, bigger sub-draws from
    // across the plaza / the drop. `plo` = the district's low bins: build the low copy into BOTH `lo` and `plo`.
    let plo: TownBins | null = null, psh: TownBins | null = null, far: TownBins;
    const ds = this.o.propDistrict ?? 0;
    if (ds > 0 && !key) {
      const d = this.get(`d${Math.floor(x / ds)},${Math.floor(z / ds)}`, "pdist");
      it.parent = d; plo = this.tier(d, "lo"); far = this.tier(d, "far"); psh = this.tier(d, "shadow");
    } else far = this.tier(it, "far");
    // `mid` (optional): the same props in MEDIUM detail (plain boxes, ~60 % segments), drawn from `propHi` to
    // `propMid` when the POI sets `propMid` — the full kit then only within a few metres of a kong
    // `sh` / `psh` : explicit shadow-caster proxies (cheap boxes / cards) for the cell / its district — when a unit
    // has any, they replace the low copy as its caster
    return { hi: this.tier(it, "fine"), lo: this.tier(it, "lo"), mid: this.tier(it, "mid"), far, plo, sh: this.tier(it, "shadow"), psh };
  }
  /** detail bins (small props, interiors, fruit, lights…) for world point (x, z) */
  near(x: number, z: number): TownBins { return this.tier(this.cellOf(x, z), "near"); }
  /** shell bins (walls, roofs, awnings, big props) for world point (x, z) */
  main(x: number, z: number): TownBins { return this.tier(this.cellOf(x, z), "main"); }
  /** a single LOD unit (a building): full detail within `mid` metres of its bounds, its `lod1` bins beyond */
  item(key: string, x: number, z: number, o: { mid?: number; near?: number; fine?: number; parent?: string; top?: number } = {}): { main: TownBins; near: TownBins; fine: TownBins; lod1: TownBins; med: TownBins; plod1: TownBins | null } {
    this.grow(x, z);
    const it = this.get(`i${key}`, "item", o);
    if (o.top !== undefined) it.top = it.top === 1e9 ? o.top : Math.max(it.top, o.top);
    // `parent` = a group key whose merged LOD1 replaces this item (and its siblings) once all of them are beyond
    // their `mid` — build the LOD1 into BOTH `lod1` and `plod1`
    let plod1: TownBins | null = null;
    if (o.parent) { const g = this.get(`G${o.parent}`, "igroup"); it.parent = g; g.maxMid = Math.max(g.maxMid, it.mid); plod1 = this.tier(g, "lod1"); }
    return { main: this.tier(it, "main"), near: this.tier(it, "near"), fine: this.tier(it, "fine"), lod1: this.tier(it, "lod1"), med: this.tier(it, "med"), plod1 };
  }
  /** a coloured box into the far proxy (local frame at `m`, base at y = 0): wall faces get the window texture */
  proxyBox(m: THREE.Matrix4, w: number, h: number, d: number, wall: THREE.Color | string, roof: THREE.Color | string, windows = true) {
    const g = new THREE.BoxGeometry(w, h, d); g.translate(0, h / 2, 0);
    const pos = g.attributes.position as THREE.BufferAttribute, nor = g.attributes.normal as THREE.BufferAttribute;
    // metre UVs on the sides (u along the face, v = height), tops/bottoms go to the plain bin
    const sides = new THREE.BufferGeometry(), top = new THREE.BufferGeometry();
    const sp: number[] = [], su: number[] = [], sn: number[] = [], tp: number[] = [], tn: number[] = [];
    const idx = g.getIndex()!;
    for (let i = 0; i < idx.count; i++) {
      const k = idx.getX(i), ny = nor.getY(k);
      if (Math.abs(ny) > 0.5) { tp.push(pos.getX(k), pos.getY(k), pos.getZ(k)); tn.push(0, ny, 0); continue; }
      sp.push(pos.getX(k), pos.getY(k), pos.getZ(k)); sn.push(nor.getX(k), 0, nor.getZ(k));
      const along = Math.abs(nor.getX(k)) > 0.5 ? pos.getZ(k) * -Math.sign(nor.getX(k)) : pos.getX(k) * Math.sign(nor.getZ(k));
      su.push(along + 50, windows ? pos.getY(k) : 0.45);
    }
    sides.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3)); sides.setAttribute("normal", new THREE.Float32BufferAttribute(sn, 3)); sides.setAttribute("uv", new THREE.Float32BufferAttribute(su, 2));
    top.setAttribute("position", new THREE.Float32BufferAttribute(tp, 3)); top.setAttribute("normal", new THREE.Float32BufferAttribute(tn, 3));
    this.proxy.wall.add(sides, m, wall);
    this.proxy.plain.add(top, m, roof);
    this.grow(m.elements[12], m.elements[14]);
  }
  /** any geometry straight into the plain (untextured) far proxy bin */
  proxyGeo(g: THREE.BufferGeometry, m: THREE.Matrix4 | null, c: THREE.Color | string) {
    this.proxy.plain.add(g, m, c);
  }
  /** flat GROUND into the far proxy (streets, squares, paving): its own polygon-offset material (it lies a few
   *  cm over the terrain — at 300–1000 m the depth buffer resolves 5–60 cm, a plain offset would flicker), no shadow */
  proxyGround(g: THREE.BufferGeometry, m: THREE.Matrix4 | null, c: THREE.Color | string) {
    this.proxy.ground.add(g, m, c);
  }

  build(ctx: WorldCtx, group: THREE.Group): number { const o = { n: 0 }; for (const _ of this.steps(ctx, group, o)) void _; return o.n; }
  /** the same build, time-sliced (ctx.yield between LOD units / batches — no main-thread task > 50 ms) */
  async buildAsync(ctx: WorldCtx, group: THREE.Group, pace: Pace = ctxPace(ctx)): Promise<number> {
    if (this.co.boxes.length) { this.logCo(await this.co.resolveAsync(pace, PACE_CHECK_MS)); await pace.pause(); }
    const o = { n: 0 };
    for (const _ of this.steps(ctx, group, o)) { void _; await pace.pause(); }
    return o.n;
  }
  private logCo(r: CoStats) { if (r.moved && flag("codebug")) console.info(`[${this.prefix}] coplanar: ${r.boxes} boxes, ${r.pairs} coplanar pairs, ${r.moved} faces moved (${r.ms} ms, longest pass ${r.maxPass} ms)`); }
  private *steps(ctx: WorldCtx, group: THREE.Group, out: { n: number }): Generator<void> {
    // 1. every non-empty (item, tier, bin) → one geometry, grouped by (material, casts)
    type Entry = { it: LodItem; tier: Tier; g: THREE.BufferGeometry };
    const groups = new Map<string, { mat: THREE.Material; name: BinName; cast: boolean; list: Entry[]; verts: number; idx: number }>();
    const box = new THREE.Box3(), gb = new THREE.Box3();
    const posOnly = (g: THREE.BufferGeometry) => { const o = new THREE.BufferGeometry(); o.setAttribute("position", g.attributes.position); o.setIndex(g.index); return o; };
    // the coplanar resolver first: it moves box faces inside the bins' buffers, before they become geometries
    if (this.co.boxes.length) {
      const it = this.co.steps(PACE_CHECK_MS); let st = it.next(); while (!st.done) { yield; st = it.next(); }
      this.logCo(st.value);
      yield;
    }
    for (const it of this.items.values()) {
      box.makeEmpty();
      const shadowParts: THREE.BufferGeometry[] = [];
      // a unit may carry EXPLICIT shadow-caster bins (tier "shadow", e.g. a stall's canopy card + table block) — then
      // those cast instead of its low copy
      const explicitSh = !!it.bins.shadow;
      for (const tier of TIERS) {
        const bins = it.bins[tier]; if (!bins) continue;
        for (const [name, b] of Object.entries(bins) as Array<[BinName, GeoBin]>) {
          yield;
          const g = b.buildGeometry(); if (!g) continue;
          if (tier === "shadow") { g.computeBoundingBox(); box.union(g.boundingBox!); shadowParts.push(posOnly(g)); continue; }
          const n = g.attributes.position.count, ni = g.index!.count;
          it.tris[tier] += ni / 3;
          g.computeBoundingBox(); gb.copy(g.boundingBox!); box.union(gb);
          const cast = casts(tier, name, it.kind) && b.castShadow;
          // batches are keyed by MATERIAL (a tier may alias several bin names onto one bin — see `aliasBins`)
          const bn = (b.name.split(":").pop() ?? name) as BinName;
          const key = `${(b.material as THREE.Material).uuid}|${cast ? 1 : 0}`;
          let grp = groups.get(key);
          if (!grp) groups.set(key, (grp = { mat: b.material, name: bn, cast, list: [], verts: 0, idx: 0 }));
          grp.list.push({ it, tier, g }); grp.verts += n; grp.idx += ni;
          // the shadow proxy: the same (cheap) geometry again in ONE invisible casting batch, on while the unit is drawn
          // within its cast distance (an item's LOD1 / a prop's low copy only ever cast through this batch)
          const proxyOf = ((it.kind === "item" || it.kind === "igroup") && tier === "lod1" && bn !== "facade" && !NO_CAST.includes(bn)) || ((it.kind === "prop" || it.kind === "pdist") && tier === "lo" && PROP_CAST.includes(bn));
          if (proxyOf && b.castShadow && !explicitSh) shadowParts.push(posOnly(g));
        }
        it.bins[tier] = undefined;
      }
      // a unit's shadow proxy is ONE geometry (one sub-draw per unit in the shadow batch, not one per bin)
      if (shadowParts.length) {
        const g = shadowParts.length === 1 ? shadowParts[0] : mergeGeometries(shadowParts, false);
        if (g) {
          let sg = groups.get("shadow");
          if (!sg) groups.set("shadow", (sg = { mat: shadowOnlyMaterial(), name: "shadow" as BinName, cast: true, list: [], verts: 0, idx: 0 }));
          sg.list.push({ it, tier: "shadow", g }); sg.verts += g.attributes.position.count; sg.idx += g.index!.count;
          it.tris.shadow += g.index!.count / 3;
        }
      }
      if (!box.isEmpty()) {
        it.cx = (box.min.x + box.max.x) / 2; it.cz = (box.min.z + box.max.z) / 2;
        it.r = Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z) / 2;
        it.sy = (box.min.y + box.max.y) / 2; it.sr = Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) / 2;
      }
      yield;
    }
    // 2. one BatchedMesh per group; each entry = one geometry + one instance (identity matrix: geometry is in world space)
    let n = 0;
    for (const grp of groups.values()) {
      const bm = new THREE.BatchedMesh(grp.list.length, grp.verts, grp.idx, grp.mat);
      bm.name = `${this.prefix}:${grp.name}${grp.cast ? "" : ":nc"}`;
      bm.castShadow = grp.cast; bm.receiveShadow = grp.name !== "blob" && (grp.name as string) !== "shadow";
      bm.userData.castShadow = grp.cast; bm.userData.farShadow = false;
      // perf: NO per-pass per-instance culling / sorting (1.8 ms of JS at poi-12 over main + shadow passes) — TownLod
      // culls each LOD unit ONCE per frame against the camera frustum (casting batches with a pad so off-screen casters
      // still shadow the view) and BatchedMesh only rebuilds its draw list when a visibility changed
      bm.sortObjects = false; bm.perObjectFrustumCulled = false;
      // the engine never scale-fades a town batch (its `visible` follows "any instance drawn")
      bm.userData.noCull = true;
      if (TOWN_XFADE && grp.name !== ("shadow" as BinName)) fadeMaterial(grp.mat);
      for (const e of grp.list) {
        // (a time slice inside a big batch too — the plaster batch alone is a 60 ms task)
        yield;
        const gid = bm.addGeometry(e.g);
        const iid = bm.addInstance(gid);
        bm.getBoundingBoxAt(gid, _bb); bm.getBoundingSphereAt(gid, _bs);
        bm.setVisibleAt(iid, false);
        e.it.ids[e.tier].push([bm, iid, grp.cast, e.g.index!.count / 3]);
      }
      // (town-xfade) the colour texture exists from the start: the batch compiles its fade variant at load, not mid-drop
      if (TOWN_XFADE && grp.name !== ("shadow" as BinName) && grp.list.length) bm.setColorAt(0, _c4.set(1, 1, 1, 1));
      bm.computeBoundingSphere(); bm.computeBoundingBox();
      if (!isGlassMat(grp.mat)) releaseBatchAfterUpload(bm);
      bm.matrixAutoUpdate = false;
      group.add(bm); this.batches.push(bm); n++;
      yield;
    }
    this.gProxy.name = `${this.prefix}:proxy`;
    this.gProxy.userData.noCull = true;
    for (const b of [this.proxy.wall, this.proxy.plain, this.proxy.ground]) {
      const m = b.build();
      if (m) {
        // (town-xfade) this POI's own proxy material copy: its coverage uniform crossfades with the detailed town
        if (TOWN_XFADE) { const pm = (m.material as THREE.Material).clone(); fadeProxyMaterial(pm, this.proxyU); m.material = pm; }
        if (b === this.proxy.ground) { m.castShadow = false; m.userData.castShadow = false; m.userData.farShadow = false; m.receiveShadow = true; }
        else { m.userData.farShadow = "force"; m.castShadow = true; m.userData.castShadow = true; }
        this.gProxy.add(m); n++;
      }
    }
    group.add(this.gProxy);
    this.cam = ctx.camera; this.ctx = ctx;
    const reg = ((globalThis as unknown as { __town?: Record<string, TownLod> }).__town ??= {});
    reg[this.prefix] = this;
    this.update(ctx.camera.position, true);
    ctx.onUpdate(() => { this.tick++; this.update(ctx.camera.position); });
    out.n = n;
  }
  private cam: THREE.Camera | null = null;
  private ctx: WorldCtx | null = null;
  /** update order: parents first */
  private order: LodItem[] | null = null;
  private noCullUntil = 0;
  private frustum = new THREE.Frustum();
  private _pm = new THREE.Matrix4();
  private _sph = new THREE.Sphere();
  /** distance from the camera to the POI's bounding rectangle (0 inside) */
  private poiDist(p: THREE.Vector3) {
    const dx = Math.max(this.minX - p.x, 0, p.x - this.maxX), dz = Math.max(this.minZ - p.z, 0, p.z - this.maxZ);
    return Math.hypot(dx, dz);
  }
  private setTier(it: LodItem, t: Tier, on: boolean) { it.on[t] = on; }
  /** (town-xfade) the far proxy's coverage (signed) and its fade state */
  private proxyU = { value: 1 };
  private proxyF = 0;
  private lastT = -1;
  private lastCam = new THREE.Vector3(1e9, 0, 0);
  /** Every detailed tier finished fading out; only the far proxy remains. */
  private dormant = false;
  update(p: THREE.Vector3, force = false) {
    const far = this.o.far ?? 260;
    const d = this.poiDist(p);
    const farOn = force ? d > far : this.farOn ? d > far - 15 : d > far + 15;
    // the water's waterline-foam bake ACCUMULATES whatever is visible when it runs (at load, then every 8–60 frames):
    // right after build / after the POI comes back into range, skip frustum culling for 90 frames so it sees every pile
    if (force || (this.farOn && !farOn)) this.noCullUntil = this.tick + 90;
    this.farOn = farOn;
    // (town-xfade) fade step this frame; a camera cut (> 40 m in one frame: respawn, spectate, screenshot cameras) is instant
    const now = performance.now() / 1000, dt = this.lastT < 0 ? 0 : Math.min(0.1, now - this.lastT);
    this.lastT = now;
    const cut = this.lastCam.distanceToSquared(p) > 40 * 40;
    this.lastCam.copy(p);
    const instant = force || cut || !TOWN_XFADE;
    const step = instant ? 1 : dt / ((globalThis as { __townFadeT?: number }).__townFadeT ?? TOWN_FADE_T);   // (__townFadeT: tools slow a fade down to inspect it)
    if (TOWN_XFADE) {
      const at = (this.ctx?.shared.get("atmos") as { uniforms?: { uAtmTemporal?: { value: THREE.Vector2 } } } | undefined)?.uniforms?.uAtmTemporal?.value;
      if (at) TOWN_FADE_U.value.copy(at);
    }
    this.proxyF = instant ? (farOn ? 1 : 0) : farOn ? Math.min(1, this.proxyF + step) : Math.max(0, this.proxyF - step);
    this.proxyU.value = this.proxyF >= 1 ? 1 : farOn ? this.proxyF : -this.proxyF;
    this.gProxy.visible = this.proxyF > 0;
    // Distance/hysteresis and the proxy uniform still update above. The thousands of hidden detailed items have
    // nothing left to change until the camera re-enters the POI. Their exact LOD/fade state is retained.
    if (farOn && this.dormant && !force) return;
    let detailActive = false;
    // camera frustum (once per frame for every pass)
    const cam = this.cam as THREE.PerspectiveCamera | null;
    let fr: THREE.Frustum | null = null;
    if (cam && this.tick > this.noCullUntil) { cam.updateMatrixWorld(); this._pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); this.frustum.setFromProjectionMatrix(this._pm); fr = this.frustum; }
    const PAD = 2, CAST_PAD = 8;
    // parents (prop districts, building-group LOD1s) first — their state decides whether the children draw at all
    if (!this.order) { const all = [...this.items.values()]; this.order = [...all.filter((i) => i.kind === "pdist" || i.kind === "igroup"), ...all.filter((i) => i.kind !== "pdist" && i.kind !== "igroup")]; }
    for (const it of this.order) {
      // props + fine cells: 3D distance to their bounding sphere (a rooftop camera 11 m up sees them smaller)
      const dc = it.kind === "prop" || it.kind === "fine" || it.kind === "pdist" ? dist3(p.x - it.cx, p.y - it.sy, p.z - it.cz) - it.sr : dist2(p.x - it.cx, p.z - it.cz) - it.r;
      const par = it.parent;
      const covered = !!par && (par.on.lo || par.on.far || par.on.lod1);
      if (it.kind === "pdist") {
        const lo = !farOn && past(force, dc, it.on.lo || it.on.far, this.o.propMid ?? 0, 4);
        const far = lo && past(force, dc, it.on.far, this.o.propLo ?? 1e9, 10);
        this.setTier(it, "lo", lo && !far);
        this.setTier(it, "far", far && hyst(force, dc, it.on.far, this.o.propFar ?? 0, 15));
        this.setTier(it, "shadow", lo && !far && hyst(force, dc, it.on.shadow, this.o.castProp ?? 1e9, 4));
      } else if (it.kind === "igroup") {
        const on = !farOn && past(force, dc, it.on.lod1, it.maxMid, 10);
        this.setTier(it, "lod1", on);
        this.setTier(it, "shadow", on && hyst(force, dc, it.on.shadow, this.o.castItem ?? 1e9, 6));
      } else if (it.kind === "fine") this.setTier(it, "fine", !farOn && hyst(force, dc, it.on.fine, it.fine, 6));
      else if (it.kind === "prop") {
        const vis = !farOn && !covered;
        const hi = vis && hyst(force, dc, it.on.fine, it.fine, 3);
        const hasMid = it.ids.mid.length > 0;
        const mid = hasMid && vis && !hi && hyst(force, dc, it.on.mid, this.o.propMid ?? 0, 4);
        // a cell inside an un-covered district shows its own low copy at any distance (the district covers it beyond)
        const lo = vis && !hi && !mid && (par ? true : hyst(force, dc, it.on.lo, it.near, 10));
        this.setTier(it, "fine", hi);
        this.setTier(it, "mid", mid);
        this.setTier(it, "lo", lo);
        this.setTier(it, "far", vis && !par && !hi && !mid && !lo && hyst(force, dc, it.on.far, this.o.propFar ?? 0, 15));
        this.setTier(it, "shadow", (hi || mid || lo) && hyst(force, dc, it.on.shadow, this.o.castProp ?? 1e9, 4));
      } else if (it.kind === "item") {
        const vis = !farOn && !covered;
        const hasMed = it.ids.med.length > 0;
        const mainOn = vis && hyst(force, dc, it.on.main, hasMed ? Math.min(this.o.itemMed ?? it.mid, it.mid) : it.mid, 8);
        const medOn = hasMed && vis && !mainOn && hyst(force, dc, it.on.med, it.mid, 12);
        const lod1On = vis && !mainOn && !medOn;
        this.setTier(it, "main", mainOn);
        this.setTier(it, "med", medOn);
        this.setTier(it, "shadow", vis && hyst(force, dc, it.on.shadow, this.o.castItem ?? 1e9, 6));
        this.setTier(it, "lod1", lod1On);
        this.setTier(it, "near", mainOn && hyst(force, dc, it.on.near, it.near, 10));
        // furniture only with the camera below the roof (it is only ever seen through a window or a door)
        this.setTier(it, "fine", mainOn && p.y < it.top + 1 && hyst(force, dc, it.on.fine, it.fine, 6));
      } else {
        // grid cells: main (+ near within `near`)
        const mainOn = !farOn && hyst(force, dc, it.on.main, it.mid, 12);
        this.setTier(it, "main", mainOn);
        this.setTier(it, "near", mainOn && hyst(force, dc, it.on.near, it.near, 10));
        this.setTier(it, "fine", mainOn && hyst(force, dc, it.on.fine, it.fine, 6));
      }
      // (town-xfade) every tier's coverage eases toward its switch (the invisible shadow tier switches at once)
      let fading = false;
      for (const t of TIERS) {
        const want = it.on[t] ? 1 : 0;
        let f = it.f[t];
        if (f !== want) { f = instant || t === "shadow" ? want : want > f ? Math.min(1, f + step) : Math.max(0, f - step); it.f[t] = f; }
        if (f !== want) fading = true;
        if (f > 0 || want > 0) detailActive = true;
      }
      let inT = true, inC = true;
      if (fr) {
        this._sph.center.set(it.cx, it.sy, it.cz); this._sph.radius = it.sr + PAD; inT = fr.intersectsSphere(this._sph);
        if (!inT) { this._sph.radius = it.sr + CAST_PAD; inC = fr.intersectsSphere(this._sph); }
      }
      // CPU: only touch the batches when this unit's state changed (not ~5 k instance flags every frame)
      let state = (inT ? 1 : 0) | (inC ? 2 : 0);
      for (let ti = 0; ti < TIERS.length; ti++) if (it.f[TIERS[ti]] > 0) state |= 4 << ti;
      if (state === it.applied && !force && !fading && !it.fading) continue;
      it.applied = state;
      const wasFading = it.fading;
      it.fading = fading;
      for (const t of TIERS) {
        const f = it.f[t], on = f > 0;
        // coverage in the instance colour's alpha: 1 at rest, +f fading in, −f fading out (complementary masks)
        const a = f >= 1 ? 1 : it.on[t] ? f : -f;
        for (const [bm, id, cast] of it.ids[t]) {
          const v = on && (cast ? inC : inT);
          if (TOWN_XFADE && v && t !== "shadow" && (fading || wasFading || force)) bm.setColorAt(id, _c4.set(1, 1, 1, a));
          if (bm.getVisibleAt(id) === v) continue;
          if (TOWN_XFADE && v && t !== "shadow") bm.setColorAt(id, _c4.set(1, 1, 1, a));
          bm.setVisibleAt(id, v);
          const n = (this.visCount.get(bm) ?? 0) + (v ? 1 : -1);
          this.visCount.set(bm, n);
        }
      }
    }
    // a batch with no visible instance is hidden outright (the water's waterline bake re-runs when it shows again)
    for (const bm of this.batches) {
      if (this.hidden && this.hidden.test(bm.name)) { bm.visible = false; continue; }
      bm.visible = (this.visCount.get(bm) ?? 0) > 0;
    }
    this.dormant = farOn && this.proxyF === 1 && !detailActive;
  }
  /** visible-instance count per batch (kept incrementally by update) */
  private visCount = new Map<THREE.BatchedMesh, number>();
  /** debug (A/B tools): hide every batch whose name matches (null = none) */
  hidden: RegExp | null = null;
  debugHide(re: RegExp | null) { this.hidden = re; for (const it of this.items.values()) it.applied = -1; this.update(this.cam?.position ?? new THREE.Vector3()); }
  /** debug: tris of the instances currently visible (after LOD + culling), per tier/bin — `__town.drawn()` in the page */
  drawn(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const it of this.items.values()) for (const t of TIERS) for (const [bm, id, cast, n] of it.ids[t]) {
      if (!bm.visible || !bm.getVisibleAt(id)) continue;
      if (cast) { const kc = `cast/${bm.name.split(":")[1]}`; out[kc] = (out[kc] ?? 0) + n; out.castTotal = (out.castTotal ?? 0) + n; }
      const k = `${t}/${bm.name.split(":").slice(1).join(":")}`; out[k] = (out[k] ?? 0) + n; out[t] = (out[t] ?? 0) + n; out.total = (out.total ?? 0) + n;
      const kk = `${it.kind}:${t}`; out[kk] = (out[kk] ?? 0) + n;
    }
    return out;
  }
  /** tris per tier for the console / docs */
  stats(): string {
    const tot: Record<Tier, number> = tierRec(() => 0);
    let nItems = 0, nCells = 0, nFine = 0;
    for (const it of this.items.values()) { for (const t of TIERS) tot[t] += it.tris[t]; if (it.kind === "item") nItems++; else if (it.kind === "cell") nCells++; else nFine++; }
    const bat = this.batches.map((b) => `${b.name.split(":").slice(1).join(":")}:${Math.round((b.geometry.index?.count ?? b.geometry.attributes.position.count) / 3000)}k`).join(" ");
    return `fine ${Math.round(tot.fine / 1000)}k · lo ${Math.round(tot.lo / 1000)}k · near ${Math.round(tot.near / 1000)}k · main ${Math.round(tot.main / 1000)}k · lod1 ${Math.round(tot.lod1 / 1000)}k tris; ${this.batches.length} batches [${bat}]; ${nItems} items + ${nCells} cells + ${nFine} fine cells`;
  }
}

let proxyCache: { wall: THREE.MeshStandardMaterial; plain: THREE.MeshStandardMaterial; ground: THREE.MeshStandardMaterial } | null = null;
/** far-proxy materials: vertex-tinted, a baked window/shutter grid on the walls (1 tile = 2.9 m × 3.3 m) */
export function proxyMats() {
  if (proxyCache) return proxyCache;
  const W = 64, H = 64, data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    // window 1.1 m wide × 1.4 m tall centred, sill at 1.0 m (tile 2.9 × 3.3 m); cream frame; dark glass / shutter
    const u = (x + 0.5) / W * 2.9, v = (y + 0.5) / H * 3.3;
    const inW = Math.abs(u - 1.45) < 0.55 && v > 1.0 && v < 2.4, inF = Math.abs(u - 1.45) < 0.68 && v > 0.9 && v < 2.52;
    const base = 232, l = inW ? (x & 4 ? 70 : 58) : inF ? 250 : base;
    data[i] = l; data[i + 1] = l; data[i + 2] = inW ? l + 8 : l; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / 2.9, 1 / 3.3);
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
  // v < 0 (roof / plain faces routed with v = -1) samples a plain wall texel row via clamp-free repeat: keep them in the plain bin instead
  const wall = new THREE.MeshStandardMaterial({ map: t, vertexColors: true, roughness: 0.92, metalness: 0, name: "town:proxy-wall" });
  const plain = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, name: "town:proxy-plain" });
  // the proxy's street plan: pulled toward the camera in depth (polygon offset), so it never fights the terrain
  const ground = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8, name: "town:proxy-ground" });
  proxyCache = { wall, plain, ground };
  return proxyCache;
}
