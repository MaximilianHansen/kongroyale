// CANOPY LINE — materials + merge bins + geometry helpers.
// Surfaces come from the poi-town material set (planks, thatch, rope, metal… one vertex-tinted PBR material per family,
// merged per cluster into a handful of draws) plus the island's own jungle bark + canopy leaf atlases (veg textures /
// foliage material) so the hero trees read as the same species as every other tree on the island, just gigantic.
import * as THREE from "three";
import { townMats, preloadTownTex, type TownMats } from "../_kit/town-materials";
import { GeoBin, M, col } from "../_kit/town-geo";
import { vegTex } from "../../veg/tex";
import { foliageMaterial, type FoliageMaterials } from "../../veg/foliage-material";
import { pbr, stoneMaterial, bindJungleCtx } from "../_kit/jungle-mat";
import type { WorldCtx } from "../../../engine/engine";

export { M, col };
export type V3 = [number, number, number];
export type Rng = () => number;

export interface CanopyMats {
  town: TownMats;
  bark: THREE.MeshStandardMaterial;
  label: THREE.MeshStandardMaterial;
  leaves: FoliageMaterials[];
  cable: THREE.MeshStandardMaterial;
  /** chiselled rock props: the jungle kit's triplanar boulder stone with moss on the crowns */
  stone: THREE.Material;
}
let cached: CanopyMats | null = null;
/** cable cut radius around the camera (m); index.ts drives it every frame */
export const ZIP_HIDE = { value: 0 };

/** painted stencil label (BANANA CO.) for crates / signs — canvas, alpha where the paint is */
function labelTexture(): THREE.CanvasTexture {
  // 1024 × 640, heavy condensed stencil with the bridge gaps of a real stencil,
  // a stencilled frame line, light wear only (a few scuffs) — reads at 15 m
  const W = 1024, H = 640, c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, W, H);
  g.fillStyle = "rgba(38,24,10,0.95)";
  g.strokeStyle = "rgba(38,24,10,0.9)"; g.lineWidth = 16; g.strokeRect(36, 36, W - 72, H - 72);
  g.textAlign = "center"; g.textBaseline = "middle";
  g.font = "900 236px Impact, 'Arial Black', sans-serif";
  g.save(); g.translate(W / 2, 220); g.scale(1, 1.05); g.fillText("BANANA", 0, 0); g.restore();
  g.font = "900 200px Impact, 'Arial Black', sans-serif";
  g.save(); g.translate(W / 2, 455); g.fillText("CO.", 0, 0); g.restore();
  // stencil bridges: thin vertical gaps through the letters
  g.globalCompositeOperation = "destination-out";
  for (let x = 120; x < W - 100; x += 118) { g.fillRect(x, 120, 7, 180); }
  for (let x = 400; x < 640; x += 104) g.fillRect(x, 375, 7, 160);
  // light wear: a few scuffs
  let s = 7;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 0; i < 260; i++) { g.globalAlpha = 0.3 + r() * 0.5; g.beginPath(); g.arc(r() * W, r() * H, 2 + r() * 7, 0, Math.PI * 2); g.fill(); }
  g.globalAlpha = 1; g.globalCompositeOperation = "source-over";
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export async function canopyMats(renderer: THREE.WebGLRenderer, ctx?: WorldCtx): Promise<CanopyMats> {
  if (cached) return cached;
  await preloadTownTex(renderer, ctx && (() => ctx.yield()));
  const town = townMats(renderer);
  // giant-tree bark: the island's jungle bark (veg), vertex-tinted (moss foot, AO under decks), metre UVs (1.6 m tile)
  const barkMap = vegTex("bark-jungle", { repeat: true }), barkN = vegTex("bark-jungle-n", { data: true, repeat: true });
  const bark = new THREE.MeshStandardMaterial({ map: barkMap, normalMap: barkN, vertexColors: true, roughness: 0.88, metalness: 0, envMapIntensity: 0.55, name: "canopy:bark" });
  bark.normalScale.setScalar(1.35);
  // a touch of bounce in the bark's shade (the trunks never go black under the canopy)
  bark.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * vec3(0.07, 0.065, 0.05);");
  };
  bark.customProgramCacheKey = () => "canopy-bark-r1";
  const label = new THREE.MeshStandardMaterial({ map: labelTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, roughness: 0.8, name: "canopy:label" });
  // crowns: veg's VOLUMETRIC crown material — the stylised crown-leaves atlas on
  // clump hulls + fixed 3D leaf-spray cards (species/crown.ts), bent clump normals kept on both faces (noFlip), hull
  // silhouettes dissolved (hullFade); nothing turns toward the camera. Same shading as every jungle tree on the island.
  const leaf = (color: number) => foliageMaterial({
    map: vegTex("crown-leaves"), color, roughness: 0.55, translucency: 0.6, transColor: 0xb2ff48, height: 60, sway: 0.16,
    bob: 0.06, flutter: 0.035, envMapIntensity: 0.35, fill: 0.42, wrap: 0.42, billboard: 0, puff: 0, alphaTest: 0.45, atlas2: true,
    shadowLift: 0.3, noFlip: true, hullFade: true,
  });
  const leaves = [leaf(0xffffff), leaf(0xf4ffe0), leaf(0xfff6d8)];
  const cable = new THREE.MeshStandardMaterial({ color: "#3b3a37", roughness: 0.38, metalness: 0.85, envMapIntensity: 1.1, name: "canopy:cable" });
  // (riding in first person the cable would be a ~100 px black wedge through the crosshair) — the
  // cable fragments within `uZipHide` m of the camera are cut, with a dithered 1.2 m fade; index.ts sets the radius
  // while the camera hangs under a cable (riding), 0 otherwise
  cable.onBeforeCompile = (sh) => {
    sh.uniforms.uZipHide = ZIP_HIDE;
    sh.vertexShader = sh.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vZipW;").replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvZipW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vZipW;\nuniform float uZipHide;").replace("#include <clipping_planes_fragment>", "#include <clipping_planes_fragment>\nif (uZipHide > 0.0) { float zd = distance(vZipW, cameraPosition); float zk = clamp((zd - uZipHide) / 1.2, 0.0, 1.0); if (zk < fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453)) discard; }");
  };
  cable.customProgramCacheKey = () => "canopy-cable-w2";
  let stone: THREE.Material = town.rock;
  if (ctx) {
    bindJungleCtx(ctx);
    stone = stoneMaterial(pbr(ctx, "boulder"), { triplanar: true, scale: 2.2, moss: 0.75, mossColor: "#5f9a2e", mossCover: 0.55, variation: 0.4, lift: 0.28, color: "#d6cdbf", vertexColors: true }, pbr(ctx, "moss"));
    stone.name = "canopy:stone";
  }
  cached = { town, bark, label, leaves, cable, stone };
  return cached;
}

// ------------------------------------------------------------------------------------------------ bins
export type BinKey = "wood" | "woodDark" | "thatch" | "rope" | "metal" | "plastic" | "fabric" | "inner" | "rock" | "bulb" | "leaf" | "bark" | "label" | "cable" | "clapboard" | "stone" | "fringe" | "twig";
export type Bins = Record<BinKey, GeoBin>;
export function makeBins(m: CanopyMats, name: string): Bins {
  const t = m.town;
  const b: Bins = {
    wood: new GeoBin(`${name}:wood`, t.wood), woodDark: new GeoBin(`${name}:woodDark`, t.woodDark), thatch: new GeoBin(`${name}:thatch`, t.thatch),
    rope: new GeoBin(`${name}:rope`, t.rope), metal: new GeoBin(`${name}:metal`, t.metal), plastic: new GeoBin(`${name}:plastic`, t.plastic),
    fabric: new GeoBin(`${name}:fabric`, t.fabric), inner: new GeoBin(`${name}:inner`, t.inner), rock: new GeoBin(`${name}:rock`, m.stone),
    bulb: new GeoBin(`${name}:bulb`, t.bulb), leaf: new GeoBin(`${name}:leaf`, t.leaf), bark: new GeoBin(`${name}:bark`, m.bark),
    label: new GeoBin(`${name}:label`, m.label), cable: new GeoBin(`${name}:cable`, m.cable), clapboard: new GeoBin(`${name}:clapboard`, t.clapboard),
    stone: new GeoBin(`${name}:stone`, t.stone),
    // ragged thatch skirts hanging off the eaves (soft: above head height, the roof steps carry the collision)
    fringe: new GeoBin(`${name}:thatch-fringe`, t.thatch),
    // crown branchlets: the thin secondary / tertiary boughs that carry the leaf clumps — inside the foliage, soft
    // like the leaves (you glide through a crown), no colliders, no shadow casting
    twig: new GeoBin(`${name}:branchlets-foliage`, m.bark),
  };
  b.twig.castShadow = false;
  b.bulb.castShadow = false; b.label.castShadow = false; b.label.receiveShadow = true; b.bulb.keepTiny = true;
  return b;
}
/** build every non-empty bin into `group`; returns the triangle count */
export function flushBins(b: Bins, group: THREE.Object3D, o: { cast?: boolean } = {}): number {
  let tris = 0;
  for (const bin of Object.values(b)) {
    const n = bin.triCount;
    const mesh = bin.build();
    if (!mesh) continue;
    if (o.cast === false) mesh.castShadow = false;
    mesh.userData.castShadow = mesh.castShadow;
    group.add(mesh); tris += n;
  }
  return tris;
}

export { logGeo, beamM, ropeGeo, sagPts, lashing, geoFrom } from "./geo";
