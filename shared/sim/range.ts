// FIRING RANGE layout (shared: the authoritative Match places the targets + weapon rack from it, the client draws the
// distance boards, rack labels, heal pad and target health bars from the SAME numbers).
// It lives on the PEEL STRIP runway (flat pad y = 14, clear line of sight for 210 m): the firing line stands in the
// overrun 58 m behind the threshold, looking down the runway (strip +X); the rack is behind the firing line.
// Distances are measured along the runway from the firing line (the lateral offset of a lane adds < 0.1 %).
import { sw } from "../pois/peel-strip";
import { CONSUMABLES, RARITIES, WEAPONS } from "../world/map";
import { AMMO_PICKUP, CONSUMABLE_DEFS } from "./const";
import { consumableRarity } from "./loot";
import { MYTHIC_R, MYTHICS } from "./mythic";
import * as dmath from "./dmath";

/** strip-local x of the firing line */
export const RANGE_LINE_X = -58;
/** strip → world yaw: a kong facing strip +X (downrange). Player forward = (−sin yaw, −cos yaw). */
const DOWN = (() => { const a = sw(0, 0), b = sw(1, 0); return dmath.atan2(-(b[0] - a[0]), -(b[2] - a[2])); })();
export const RANGE_YAW_DOWNRANGE = DOWN;
export const RANGE_YAW_UPRANGE = DOWN + Math.PI;

export interface RangeTarget {
  /** distance from the firing line (m) */
  d: number;
  /** strip-local lateral offset (m, +Z = right of the runway seen from the firing line... strip +Z is SW) */
  lz: number;
  shield: number;
  /** strafe half-width (m) along strip Z; 0 = stationary */
  strafe: number;
  name: string;
}
/** stationary pairs fan out with distance so every target has a clear line from the middle of the firing line
 * (the nearer target's hitbox never covers a farther one: gap 3.6·(1 − dᵢ/dⱼ) ≥ 0.9 m > the 0.72 m half-width of the
 * kong hitbox across its arms) */
export const RANGE_DISTANCES = [10, 25, 50, 75, 100, 150, 205];
const fan = (d: number) => 3.6 + 0.025 * d;
export const RANGE_TARGETS: RangeTarget[] = [
  ...RANGE_DISTANCES.flatMap((d) => [
    { d, lz: fan(d), shield: 0, strafe: 0, name: `${d}M` },
    { d, lz: -fan(d), shield: 100, strafe: 0, name: `${d}M SHIELD` },
  ]),
  // movers on the right shoulder, strafing across the lane at walk speed
  { d: 20, lz: 10.5, shield: 0, strafe: 2.2, name: "20M MOVING" },
  { d: 40, lz: 10.5, shield: 0, strafe: 2.2, name: "40M MOVING" },
];
export const targetPos = (t: RangeTarget) => sw(RANGE_LINE_X + t.d, t.lz);

/** where the shooter (re)spawns: the middle of the firing line */
export const RANGE_SPAWN = sw(RANGE_LINE_X - 1, 0);

/** rack: rows of weapons (one row per gun, one column per rarity), then heals, then ammo — behind the firing line */
export interface RackSlot { kind: 0 | 1 | 2; sub: number; rarity: number; count: number; lx: number; lz: number }
const COL = 1.7, ROW = 2.1, RACK0 = RANGE_LINE_X - 4.5;
/** the rack's MYTHIC column (under its label): one named mythic per gun — the camo can be
 *  tried in the range */
const RACK_MYTHIC: Record<string, string> = { pistol: "CANOPY STINGER", smg: "AFTERBURNER", ar: "THE GOLDEN IDOL", shotgun: "THE HARBORMASTER", sniper: "THE STILTWALKER", rocket: "MAGMA BUNCH" };
export const RANGE_RACK: RackSlot[] = [
  ...WEAPONS.flatMap((_, w) => RARITIES.slice(0, 5).map((_, r) => ({ kind: 0 as const, sub: w, rarity: r, count: 1, lx: RACK0 - w * ROW, lz: (r - 2) * COL }))),
  ...WEAPONS.map((wid, w) => ({ kind: 0 as const, sub: w, rarity: MYTHIC_R + Math.max(0, MYTHICS.findIndex((m) => m.name === RACK_MYTHIC[wid])), count: 1, lx: RACK0 - w * ROW, lz: 3 * COL })),
  ...CONSUMABLES.map((c, i) => ({ kind: 1 as const, sub: i, rarity: consumableRarity(i), count: CONSUMABLE_DEFS[c].stack, lx: RACK0 - WEAPONS.length * ROW, lz: (i - (CONSUMABLES.length - 1) / 2) * COL })),
  ...(["light", "heavy", "shells", "rockets"] as const).map((a, i) => ({ kind: 2 as const, sub: i, rarity: 0, count: AMMO_PICKUP[a], lx: RACK0 - (WEAPONS.length + 1) * ROW, lz: (i - 1.5) * COL })),
];
/** strip-local rack row x for labels: weapons 0..5, heals 6, ammo 7 */
export const rackRowX = (row: number) => RACK0 - row * ROW;
export const RACK_COL = COL;

/** heal test pad: standing on it drains shield, then health, down to 1 hp (so heals + shields can be tried) */
export const HEAL_PAD = { lx: RANGE_LINE_X - 2, lz: 7.5, r: 1.6, dps: 30 };
export const healPadPos = () => sw(HEAL_PAD.lx, HEAL_PAD.lz);

/** dummy respawn delay after a kill (s) */
export const TARGET_RESPAWN_S = 1.5;
export const SHOOTER_RESPAWN_S = 2.5;
/** a rack item that was taken is back after this long (s) */
export const RACK_RESTOCK_S = 0.5;
