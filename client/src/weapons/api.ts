// WEAPON / FX / LOOT VISUAL CONTRACT between the weapons area (look, feel, animation, effects) and the gameplay
// area (rules, timing, hit truth). Gameplay decides WHAT happens; these objects make it look and feel incredible.
// Placeholder implementations live in ./index.ts — the weapons area replaces them keeping these signatures.
import type * as THREE from "three";
import type { ConsumableId, Rarity, WeaponId } from "../../../shared/world/map";
import type { Surface } from "../../../shared/world/colliders";

export interface ViewModelMotion { speed: number; grounded: boolean; sprint: boolean; crouch: boolean; lookDX: number; lookDY: number }

/** first-person arms + held weapon. Its object is parented to the camera by gameplay. */
export interface ViewModel {
  object: THREE.Object3D;
  /** `skin`: a mythic's signature colour — the gun wears its finish (null / omitted = stock) */
  equip(id: WeaponId | ConsumableId | null, rarity?: Rarity, skin?: string | null): void;
  /** a shot left the barrel (recoil kick, muzzle flash, shell) */
  fire(): void;
  /** a sim reload started: play the reload over `seconds`, already `elapsed` s into it (the ticks simulated this frame) */
  reload(seconds: number, elapsed?: number): void;
  /** the sim cancelled the reload (swap, shotgun fire-interrupt, death): blend the reload pose out */
  cancelReload?(): void;
  /** every frame while the sim reload runs: `elapsed` s into it (keeps the animation on the sim's clock) */
  syncReload?(elapsed: number, total?: number): void;
  /** tests / tools: the viewmodel's animation state (reload progress 0..1 or -1, the equipped id, ADS amount) */
  debugState?(): { reloadU: number; reloadDur: number; equip: string | null; ads: number; cancelling: boolean };
  /** hip ↔ aim-down-sights for every gun (the sniper's scope keeps setScoped) */
  setAds?(on: boolean): void;
  /** consumable use animation (drink smoothie etc.) */
  use(seconds: number): void;
  /** sniper → scope overlay state is gameplay/HUD; this lowers/raises the model */
  setScoped(on: boolean): void;
  /** rotary barrel spin 0..1 for the Banana Shredder minigun */
  setSpin?(spin: number): void;
  update(dt: number, m: ViewModelMotion): void;
  /** world-space muzzle point for 1P tracers */
  muzzle(out: THREE.Vector3): THREE.Vector3;
}

export interface Fx {
  tracer(from: THREE.Vector3, to: THREE.Vector3, weapon: WeaponId): void;
  impact(pos: THREE.Vector3, normal: THREE.Vector3, surface: Surface | "flesh"): void;
  /** bounded blue shards, only on an authoritative shield break */
  shieldBreak?(pos: THREE.Vector3): void;
  explosion(pos: THREE.Vector3, radius: number): void;
  /** landing dust, sand kick, water splash */
  puff(pos: THREE.Vector3, kind: "dust" | "sand" | "splash"): void;
  update(dt: number): void;
}

export interface ChestView {
  object: THREE.Object3D;
  /** play the burst-open animation (light, sparkles, lid) */
  open(): void;
  readonly opened: boolean;
  /** (end-game regen) shut it again: the closed crate, its seam glow / halo / aura back, no burst */
  close?(): void;
  /** the closed crate's geometry in the view's local space (the interact highlight outlines it) */
  readonly hull?: THREE.BufferGeometry;
}

export interface LootView {
  object: THREE.Object3D;
  /** floating bob / spin / rarity beam handled internally in update */
  update(dt: number, t: number): void;
  dispose(): void;
}

export interface WeaponsKit {
  createViewModel(): Promise<ViewModel>;
  createFx(): Fx;
  createChest(rarity: Rarity): Promise<ChestView>;
  /** `skin`: a mythic gun's signature colour */
  createLoot(item: WeaponId | ConsumableId | "ammo" | "cash", rarity: Rarity, skin?: string | null): Promise<LootView>;
  /** third-person held weapon mesh for kongs */
  createHeldWeapon(id: WeaponId, rarity: Rarity): Promise<THREE.Object3D>;
  /** a kong (its actor root) holds a mythic: its held gun wears the mythic camo — cheap to
   *  call every frame (it only walks the hand socket when the gun or the state changed) */
  setHeldMythic?(actorRoot: THREE.Object3D, on: boolean): void;
}
