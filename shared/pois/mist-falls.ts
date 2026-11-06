// POI mist-falls — shared layout + collision (read by client visuals AND the authoritative server).
// Layout: ./jungle-falls.ts (FALLS). Cliff blocks, boulders, river rocks, bridges and levels are resolved ONCE against
// island.bin by an offline bake into ./jungle-baked.json; these colliders and the client's visuals are
// both built from that same baked data (the bake's `--check` verifies it still matches island.bin).
import type { Box } from "../world/colliders";
import baked from "./jungle-baked.json";
import type { JungleBaked } from "./jungle-layout";
import { fallsColliders, fallsClearings, FALLS, type Clearing } from "./jungle-falls";
import * as dmath from "../sim/dmath";

export const layout = (baked as unknown as JungleBaked).falls;
export const colliders: Box[] = fallsColliders(layout);

/** areas vegetation / random scatter must leave clear (the POI dresses them itself). Circles or yaw-rotated rects. */
export const clearings: Clearing[] = fallsClearings(layout);

/** designed loot (LOOT_SPOTS): chests [x, y, z, yaw] + floor [x, y, z], world metres, y = the walk floor — generated
 *  from the layout (jungle-layout / jungle-falls *LootCandidates) and settled + capsule-checked by the bake */
export const LOOT_SPOTS: { chests: Array<[number, number, number, number]>; floor: Array<[number, number, number]>; hero?: number[] } = (() => {
  const L = layout.loot ?? { chests: [], floor: [] };
  // the payoff: the chest on the rock pillar BETWEEN the two falls (beside the hoist, reached over the high rope
  // bridge, exposed from every ledge) — always on, a Rare Chest (shared/sim/loot-spots.ts LOOT_SPOTS.hero)
  let best = -1, bd = 6; L.chests.forEach((c, i) => { const d = dmath.hypot(c[0] - FALLS.pillar.x, c[2] - FALLS.pillar.z); if (d < bd) { bd = d; best = i; } });
  return { ...L, hero: best >= 0 ? [best] : [] };
})();
