// POI ripe-peak — shared layout + collision (read by client visuals AND the authoritative server).
// Layout: ./jungle-layout.ts (PEAK). The terrain-adaptive layout is resolved ONCE against island.bin by
// an offline bake into ./jungle-baked.json; these colliders and the client's visuals are both built from
// that same baked data (the bake's `--check` verifies it still matches island.bin).
import type { Box } from "../world/colliders";
import baked from "./jungle-baked.json";
import { peakColliders, peakClearings, PEAK, PEAK_C, type Clearing, type JungleBaked } from "./jungle-layout";
import * as dmath from "../sim/dmath";

export const layout = (baked as unknown as JungleBaked).peak;
export const colliders: Box[] = peakColliders(layout);

/** areas vegetation / random scatter must leave clear (the POI dresses them itself). Circles or yaw-rotated rects. */
export const clearings: Clearing[] = peakClearings(layout);

/** designed loot (LOOT_SPOTS): chests [x, y, z, yaw] + floor [x, y, z], world metres, y = the walk floor — generated
 *  from the layout (jungle-layout / jungle-falls *LootCandidates) and settled + capsule-checked by the bake */
export const LOOT_SPOTS: { chests: Array<[number, number, number, number]>; floor: Array<[number, number, number]>; hero?: number[] } = (() => {
  const L = layout.loot ?? { chests: [], floor: [] };
  // loot worth the climb: the chest at the STAIR HEAD (the fan's top landing on the rim, between the two gate
  // totems — where the zig-zag climb arrives) is the peak's payoff chest — always on, a Rare Chest (shared/sim/loot-spots.ts
  // LOOT_SPOTS.hero).
  let top = -1, best = Infinity;
  L.chests.forEach((c, i) => { const dx = c[0] - PEAK_C.x, dz = c[2] - PEAK_C.z, r = dmath.hypot(dx, dz); if (r < 50 || r > 80) return;
    const d = Math.abs(dmath.atan2(dmath.sin(dmath.atan2(dz, dx) - PEAK.fan.c), dmath.cos(dmath.atan2(dz, dx) - PEAK.fan.c))); if (d < best) { best = d; top = i; } });
  return { ...L, hero: top >= 0 ? [top] : [] };
})();
