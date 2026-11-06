// POI banana-temple — shared layout + collision (read by client visuals AND the authoritative server).
// The layout itself lives in ./jungle-layout.ts (TEMPLE): the pyramid is tiers + portal − the dungeon (vault, offering
// halls, galleries, shrine, doors, windows, stairwells) carved on one grid, the 4 towers are shells − storeys; the client
// draws the exposed faces of the SAME carved cells. The temple stands on its flat pad so nothing here depends on terrain.
// Rooms (halls, galleries, shrine, every tower storey) are furnished by the shared interiors kit (style "temple").
import type { Box } from "../world/colliders";
import { templeColliders, templeClearings, templeLootSpots, templeInteriorRooms, outskirtColliders, outskirtClearings, type Clearing, type JungleBaked, type Outskirt } from "./jungle-layout";
import baked from "./jungle-baked.json";
import { furnishRoom, type InteriorRoom, type LootSlots } from "./interior-kit";
import * as dmath from "../sim/dmath";

/** the furnished rooms (interiors kit) — the client builds them with buildInteriors, the match generator reads their loot */
export const INTERIOR_ROOMS: InteriorRoom[] = templeInteriorRooms();
const LAYOUTS = INTERIOR_ROOMS.map((r) => furnishRoom(r));
/** every interior loot candidate (world): chests + floor slots of the furnished rooms */
const ALL_BOXES = LAYOUTS.flatMap((l) => l.colliders);
/** a slot inside (or within 0.5 m of) a furniture collider is dropped (loot never on / in a piece) */
const clearOf = (p: number[]) => !ALL_BOXES.some((b) => { const c = dmath.cos(b.yaw ?? 0), s = dmath.sin(b.yaw ?? 0), dx = p[0] - b.c[0], dz = p[2] - b.c[2]; return Math.abs(dx * c + dz * s) < b.h[0] + 0.5 && Math.abs(-dx * s + dz * c) < b.h[2] + 0.5 && b.c[1] + b.h[1] > p[1] + 0.05 && b.c[1] - b.h[1] < p[1] + 1.8; });
export const INTERIOR_LOOT: LootSlots = { chests: LAYOUTS.flatMap((l) => l.loot.chests), floor: LAYOUTS.flatMap((l) => l.loot.floor).filter(clearOf) };

/** the outskirts (r 92–136, seated on the terrain): resolved against island.bin by the offline bake */
export const OUTSKIRTS: Outskirt[] = (baked as unknown as JungleBaked).temple?.outskirts ?? [];
export const colliders: Box[] = [...templeColliders(), ...outskirtColliders(OUTSKIRTS), ...LAYOUTS.flatMap((l) => l.colliders)];

/** areas vegetation / random scatter must leave clear (the POI dresses them itself). Circles or yaw-rotated rects. */
export const clearings: Clearing[] = [...templeClearings(), ...outskirtClearings(OUTSKIRTS)];

/** designed loot (LOOT_SPOTS): chests [x, y, z, yaw] + floor [x, y, z], world metres, y = the floor. The designed
 *  spots (vault dais, halls, galleries, shrine, tower roofs, ledges, plaza cover) + the kit's room slots not within 1.5 m of
 *  one of them. */
export const LOOT_SPOTS: { chests: Array<[number, number, number, number]>; floor: Array<[number, number, number]>; hero?: number[] } = (() => {
  const d0 = templeLootSpots(), d = { chests: d0.chests.filter(clearOf), floor: d0.floor.filter(clearOf) }, all = [...d.chests.map((c) => [c[0], c[1], c[2]]), ...d.floor];
  const free = (p: number[]) => { const ok = !all.some((q) => Math.abs(q[1] - p[1]) < 1.5 && dmath.hypot(q[0] - p[0], q[2] - p[2]) < 1.5); if (ok) all.push(p); return ok; };
  // the vault's dais chest is the hot drop's PAYOFF: always on, a Rare Chest (left to the generator, its 14 m chest
  // spacing would give every chest to outdoor coverage spots)
  const [vx, vy, vz] = d0.chests[0], hero = d.chests.findIndex((c) => c[0] === vx && c[1] === vy && c[2] === vz);
  return { chests: [...d.chests, ...INTERIOR_LOOT.chests.filter((c) => free(c))], floor: [...d.floor, ...INTERIOR_LOOT.floor.filter((f) => free(f))], hero: hero >= 0 ? [hero] : [] };
})();
