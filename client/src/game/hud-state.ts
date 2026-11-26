// HUD presentation derived from the real game rules (movement state, the CURRENT storm circle, ...). No network or
// simulation mutation.
import { AMMO_CAP, CONSUMABLE_DEFS, WEAPON_DEFS } from "../../../shared/sim/const";
import { CONSUMABLES, POIS, WEAPONS, type ConsumableId } from "../../../shared/world/map";
import { AMMO_TYPES, PS, SK, consumableId, eyeY, rarityOf, weaponId, type Player } from "../../../shared/sim/player";
import { mythicOf } from "../../../shared/sim/mythic";
import { IK, type Item } from "../../../shared/sim/loot";
import { aimedItem, standNear } from "../../../shared/sim/pickup";
import type { StaticWorld } from "../../../shared/sim/world";
import type { HudState } from "../ui/api";

/** what each gun is for, on the pickup card and the inventory cards */
export const WEAPON_ROLES = {
  pistol: "Sidearm", smg: "Close range", ar: "All round", shotgun: "Close range burst", sniper: "Long range · hitscan", rocket: "Explosive",
  bow: "Silent · explosive arrow", minigun: "Rotary · shreds vehicles",
} as const;
/** what each consumable does, on the pickup card and the inventory cards */
export const CONSUMABLE_ROLES: Record<ConsumableId, string> = {
  "leaf-bundle": "+25 Health", smoothie: "+25 Shield", "golden-banana": "+100 Health · +100 Shield", "red-banana": "Speed + jump boost · 8 s",
  "banana-bomb": "Frag grenade · cook, then throw", "crate-wall": "Portable cover · set it down",
  "smoke-bomb": "Smoke screen · blocks sight & bots",
  "vine-grapple": "Jungle hook · sling 38 m",
  airstrike: "Call 6-bomb air barrage",
};

/** the hotbar, ammo and reload / use prompts belong to a kong on its feet (or hanging off a zipline / a ledge) —
 *  not one riding the plane, falling, gliding or dead */
export const weaponHudEligible = (state: PS) => state === PS.Ground || state === PS.Zip || state === PS.Mantle || state === PS.Climb;

/** where the current safe circle's edge is from `me`: distance (m, 0 inside) and bearing relative to the view yaw
 *  (rad, -π..π; positive = to the left, three.js yaw convention: 0 = north / -Z, counter-clockwise) */
export function safeEdgeGuide(me: { x: number; z: number }, safe: { cx: number; cz: number; r: number }, yaw: number) {
  const dx = safe.cx - me.x, dz = safe.cz - me.z, d = Math.hypot(dx, dz), distance = Math.max(0, d - safe.r);
  let bearing = Math.atan2(-dx, -dz) - yaw;
  while (bearing > Math.PI) bearing -= Math.PI * 2;
  while (bearing < -Math.PI) bearing += Math.PI * 2;
  return { distance, bearing };
}

/** the item an interact press would take — the server's Match.manualItem for a human (shared/sim/pickup.ts):
 *  the weapon or consumable nearest the crosshair in reach (any kind on the firing range's rack, no reach test there); the
 *  near-field cone off within a Banana Stand's shop reach (`stands`: the match's stands, as the server has them) */
export function manualLootCandidate(items: Iterable<Item>, p: Player, world: StaticWorld, range: boolean, stands: ReadonlyArray<{ x: number; y: number; z: number }>): Item | null {
  const cp = Math.cos(p.pitch);
  return aimedItem(items, p.x, p.y, p.z, eyeY(p), -Math.sin(p.yaw) * cp, Math.sin(p.pitch), -Math.cos(p.yaw) * cp, world, range, !standNear(stands, p.x, p.y, p.z));
}

/** the pickup card for `it`: rarity · role, ammo type + reserve, which slot it takes or replaces (same slot rules as
 *  Match.takeItem), or why it cannot be taken */
export function lootCard(p: Player, it: Item, range: boolean): NonNullable<HudState["interact"]> {
  const rarity = rarityOf(it.rarity), empty = p.slots.findIndex((s) => s.kind === SK.Empty);
  let index = empty, name = "", role = "", ammo = "", reason = "";
  if (it.kind === IK.Weapon) {
    const id = WEAPONS[it.sub], w = WEAPON_DEFS[id], my = mythicOf(it.rarity); name = my ? my.name : w.name; role = my ? `${POIS.find((q) => q.id === my.poi)?.name ?? ""} SIGNATURE ${w.name}` : WEAPON_ROLES[id];
    ammo = `${w.ammo.toUpperCase()} AMMO · ${p.ammo[AMMO_TYPES.indexOf(w.ammo)]} RESERVE`;
    if (index < 0) index = p.active;
  } else if (it.kind === IK.Consumable) {
    const c = CONSUMABLE_DEFS[CONSUMABLES[it.sub]]; name = c.name;
    role = CONSUMABLE_ROLES[c.id];
    const stack = p.slots.findIndex((s) => s.kind === SK.Consumable && s.id === it.sub && s.count < c.stack);
    // a full backpack swaps it for what is in your hands (Match.takeItem) — not mid-use / mid-cook, not
    // for a full stack of the same
    const act = p.slots[p.active];
    if (stack >= 0) index = stack; else if (index < 0 && p.useT <= 0 && p.cookT <= 0 && !(act.kind === SK.Consumable && act.id === it.sub)) index = p.active;
    if (index < 0) reason = "BACKPACK FULL";
    else if (p.slots[index].kind === SK.Consumable && p.slots[index].id === it.sub && p.slots[index].count >= c.stack) reason = "STACK FULL";
    if (index >= 0) ammo = `×${it.count} · STACK LIMIT ${c.stack}`;
  } else {
    const type = AMMO_TYPES[it.sub]; name = `${type.toUpperCase()} AMMO`; role = "Reserve ammunition";
    ammo = `${p.ammo[it.sub]} / ${AMMO_CAP[type]}`; if (p.ammo[it.sub] >= AMMO_CAP[type]) reason = "AMMO FULL"; index = -1;
  }
  const previous = index >= 0 ? p.slots[index] : null;
  const replaced = !!previous && previous.kind !== SK.Empty && !(it.kind === IK.Consumable && previous.kind === SK.Consumable && previous.id === it.sub);
  const previousName = previous?.kind === SK.Weapon ? (mythicOf(previous.rarity)?.name ?? WEAPON_DEFS[weaponId(previous.id)].name) : previous?.kind === SK.Consumable ? CONSUMABLE_DEFS[consumableId(previous.id)].name : "";
  const change = reason || index < 0 ? "" : replaced ? `REPLACES SLOT ${index + 1} · ${previousName}` : previous?.kind === SK.Consumable ? `ADDS TO SLOT ${index + 1}` : `TAKES SLOT ${index + 1}`;
  return { label: `${replaced ? "SWAP FOR" : "TAKE"} ${name}`, key: "E", rarity, detail: `${rarity.toUpperCase()} · ${role}`, ammo, change, blocked: reason || undefined, candidateId: it.id };
}
