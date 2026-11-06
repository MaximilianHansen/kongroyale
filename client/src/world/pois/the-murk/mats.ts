// THE MURK materials: Poly Haven CC0 PBR sets (public/assets/pois/murk — sources
// in tex.json) aliased INTO the poi-town bin names so the POI reuses TownLod batching / LOD and the town prop kits:
//   clapboard → weathered shack boards (worn_planks, vertical)      woodDark → deck planks (weathered_brown_planks)
//   tin       → roof board courses (weathered_plank_siding)          wood     → dark timber (weathered_planks)
//   thatch    → mangrove bark (bark_brown_02)
// Everything stays vertex-colour tinted (the kits tint per piece), metre UVs (the kits' box UVs are in metres; each set
// is scaled to its real tile size here).
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import { townMats, preloadTownTex, type TownMats } from "../_kit/town-materials";

type SetKey = "wall" | "deck" | "roof" | "bark" | "dark";
/** real tile size (m) of each set (Poly Haven dimensions) — UVs in metres are divided by this */
const TILE: Record<SetKey, number> = { wall: 1.4, deck: 1.8, roof: 1.57, bark: 1.0, dark: 2.0 };

export interface MurkMats {
  town: TownMats;
  wall: THREE.MeshStandardMaterial;
  deck: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  bark: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
}

let cached: Promise<MurkMats> | null = null;
export function murkMats(ctx: WorldCtx): Promise<MurkMats> {
  return (cached ??= (async () => {
    await preloadTownTex(ctx.renderer, () => ctx.yield());
    const town = townMats(ctx.renderer);
    const load = (k: SetKey) => Promise.all([
      ctx.assets.texture(`assets/pois/murk/${k}-d.webp`),
      ctx.assets.texture(`assets/pois/murk/${k}-n.webp`, { srgb: false }),
      ctx.assets.texture(`assets/pois/murk/${k}-arm.webp`, { srgb: false }),
    ]);
    const sets = await Promise.all((["wall", "deck", "roof", "bark", "dark"] as SetKey[]).map(load));
    const mk = (k: SetKey, i: number, o: { normalScale?: number; side?: THREE.Side; env?: number; rough?: number } = {}) => {
      const [map, normalMap, arm] = sets[i];
      const s = 1 / TILE[k];
      // (each texture belongs to this one material: set its repeat in place — a clone would upload it twice)
      const tex = [map, normalMap, arm].map((t) => { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(s, s); return t; });
      const m = new THREE.MeshStandardMaterial({
        name: `murk:${k}`, vertexColors: true, map: tex[0], normalMap: tex[1], roughnessMap: tex[2], metalnessMap: tex[2], aoMap: tex[2],
        roughness: o.rough ?? 1, metalness: 0, aoMapIntensity: 0.9, envMapIntensity: o.env ?? 0.75, side: o.side ?? THREE.FrontSide,
      });
      m.normalScale.setScalar(o.normalScale ?? 1);
      // weathered wood is never metallic: the ARM blue channel is ~0 anyway; keep metalness 0 by the uniform
      m.metalnessMap = null;
      return m;
    };
    const wall = mk("wall", 0, { normalScale: 1.1 });
    const deck = mk("deck", 1, { normalScale: 1.0 });
    const roof = mk("roof", 2, { normalScale: 1.2, side: THREE.DoubleSide });
    roof.shadowSide = THREE.DoubleSide;
    const bark = mk("bark", 3, { normalScale: 1.35, env: 0.6 });
    const dark = mk("dark", 4, { normalScale: 1.0 });
    // stylized albedo lift: the photo sets are measured-real (dark); the art direction's toy-like wood reads ~35 % brighter
    wall.color.setScalar(1.4); deck.color.setScalar(1.3); roof.color.setScalar(1.3); bark.color.setScalar(1.35); dark.color.setScalar(1.45);
    return { town, wall, deck, roof, bark, dark };
  })());
}

/** the town material set with the murk sets swapped in (fed to TownLod / the town kits) */
export function aliasTown(m: MurkMats): TownMats {
  return { ...m.town, clapboard: m.wall, woodDark: m.deck, tin: m.roof, wood: m.dark, thatch: m.bark };
}
