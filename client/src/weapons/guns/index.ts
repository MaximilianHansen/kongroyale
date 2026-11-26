// One entry point for the six banana weapons. Built geometry is cached per id and cloned for each use.
import * as THREE from "three";
import type { WeaponId } from "../../../../shared/world/map";
import type { GunSpec } from "./types";
import { buildPistol } from "./pistol";
import { buildSmg } from "./smg";
import { buildAr } from "./ar";
import { buildShotgun } from "./shotgun";
import { buildSniper } from "./sniper";
import { buildRocket } from "./rocket";
import { buildBow } from "./bow";
import { buildMinigun } from "./minigun";

const builders: Record<WeaponId, () => GunSpec> = { pistol: buildPistol, smg: buildSmg, ar: buildAr, shotgun: buildShotgun, sniper: buildSniper, rocket: buildRocket, bow: buildBow, minigun: buildMinigun };
const cache = new Map<WeaponId, GunSpec>();

/** the master (do not add it to a scene twice — use gunInstance) */
export function gunSpec(id: WeaponId): GunSpec {
  let s = cache.get(id);
  if (!s) { s = builders[id](); cache.set(id, s); }
  return s;
}

/** a fresh scene-graph instance sharing geometry + materials with the master; pivots re-resolved by name */
export function gunInstance(id: WeaponId): { root: THREE.Group; spec: GunSpec; pivots: Record<string, THREE.Object3D>; meshes: THREE.Mesh[] } {
  const spec = gunSpec(id);
  const root = spec.root.clone(true) as THREE.Group;
  const pivots: Record<string, THREE.Object3D> = {};
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Group).isGroup && o !== root) pivots[o.name.split("/").pop()!] = o;
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  return { root, spec, pivots, meshes };
}

export const GUN_ORDER: WeaponId[] = ["pistol", "smg", "ar", "shotgun", "sniper", "rocket", "bow", "minigun"];
