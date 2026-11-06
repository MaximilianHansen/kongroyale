// WHAT AN E PRESS PICKS UP: the item under your crosshair (not simply the NEAREST WEAPON in reach, which could offer a
// gun lying beside the item you look at; consumables count too, so a full backpack can take one).
//
// One rule for the server (Match.interact / Match.useClaimed) and the client (the E prompt + its outline,
// client/src/game/hud-state.ts): of the weapons and consumables in reach (PICKUP_DIST + 0.5 m from the feet, the old
// reach; the range's rack: anything) and inside a 43° cone round the crosshair, the one whose centre is nearest the look
// direction — a small distance term breaks near ties toward the nearer item, the item id breaks exact ones (the server's
// list and the client's map iterate in different orders: the pick must not depend on it). The cone opens up for items
// right in front of your feet (a gun lying a metre ahead would otherwise want a 20° look down): up to 69° within 0.6 m — so
// looking straight ahead picks it — except within a Banana Stand's shop reach, where something you are not looking at
// never claims E (a bomb at your feet leaves the stand's E alone until you look down at it). The reach test lets a kong
// reach over a Banana Stand's counter. Deterministic (no randomness, no allocation) — bots use the nearest-weapon rule
// (Match.manualItem).
import { ECON, PICKUP_DIST } from "./const";
import { IK, type Item } from "./loot";
import { lootReachable } from "./loot-spots";
import type { StaticWorld } from "./world";
import * as dmath from "./dmath";

/** rad of look angle one metre of distance is worth (≈1.1°): of two items nearly under the crosshair, the nearer wins */
const DIST_W = 0.02;
/** the cone round the crosshair an item must be in (rad, half-angle): an item 2 m ahead on the floor is in it looking
 *  straight ahead; one at your feet wants a look down */
export const PICK_CONE = 0.75;
/** …widened for items near the feet: + NEAR_EXTRA rad at ≤ NEAR_IN m (horizontal), easing back to PICK_CONE by NEAR_OUT m */
const NEAR_EXTRA = 0.45, NEAR_IN = 0.6, NEAR_OUT = 1.7;

/** a Banana Stand within its shop reach of (x, y, z) — the client's SHOP prompt rule (render.ts fillHud) */
export function standNear(stands: ReadonlyArray<{ x: number; y: number; z: number }>, x: number, y: number, z: number): boolean {
  for (const s of stands) if (dmath.hypot(s.x - x, s.z - z) < ECON.standReach + 0.65 && Math.abs(s.y - y) < 2.5) return true;
  return false;
}

/** the item an E press takes for a kong standing at (px, py, pz) with its eye at `eye` looking along (dx, dy, dz) (unit);
 *  `range` = the firing range's rack (every kind, no reach test — the server's old range rule); `near` = the near-field cone
 *  (false within a Banana Stand's shop reach: standNear) */
export function aimedItem(items: Iterable<Item>, px: number, py: number, pz: number, eye: number, dx: number, dy: number, dz: number, world: StaticWorld, range: boolean, near = true): Item | null {
  let best: Item | null = null, bestS = Infinity;
  for (const it of items) {
    if (it.taken || (!range && it.kind !== IK.Weapon && it.kind !== IK.Consumable)) continue;
    const d = dmath.hypot3(it.x - px, it.z - pz, (it.y - py) * 0.6);
    if (d >= PICKUP_DIST + 0.5) continue;
    // the look angle to the item's centre (it lies on the floor: ~15 cm up)
    const vx = it.x - px, vy = it.y + 0.15 - eye, vz = it.z - pz, l = dmath.hypot3(vx, vy, vz) || 1;
    const c = (vx * dx + vy * dy + vz * dz) / l, ang = dmath.acos(c > 1 ? 1 : c < -1 ? -1 : c);
    const hd = dmath.hypot(vx, vz), cone = near ? PICK_CONE + NEAR_EXTRA * Math.max(0, Math.min(1, (NEAR_OUT - hd) / (NEAR_OUT - NEAR_IN))) : PICK_CONE;
    if (ang > cone && !range) continue;
    const sc = ang + d * DIST_W;
    if (sc > bestS || (sc === bestS && best !== null && it.id > best.id)) continue;
    if (!range && !lootReachable(world, px, py, pz, it.x, it.y, it.z, true)) continue;
    best = it; bestS = sc;
  }
  return best;
}
