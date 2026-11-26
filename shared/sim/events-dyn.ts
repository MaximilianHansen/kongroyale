// Dynamic Match Events — deterministic per match seed (shared by server Match, Economy, Loot, and Client HUD/Maps).
//   1. Hot Drop (Zona Caliente): 1 named POI per match gets boosted loot rarity (tier 2), 2× cash stacks, and +$200 kill bonus.
//   2. Fire Sale (Liquidación): mid-match 45 s window cutting all Banana Stand prices by 50%.
//   3. Supply Drop Frenzy (Lluvia de Suministros): mid-match burst dropping 3 golden parachuting crates at once.
import { POIS } from "../world/map";
import { hash32 } from "./rng";
import * as dmath from "./dmath";

export const HOT_DROP_KILL_BONUS = 200;
export const FIRE_SALE_MUL = 0.5;
export const FIRE_SALE_DUR_S = 45;
export const FRENZY_DROP_COUNT = 3;

const NAMED_POI_INDICES: number[] = [];
for (let i = 0; i < POIS.length; i++) if (POIS[i].id !== "lobby-islet") NAMED_POI_INDICES.push(i);

/** deterministic Hot Drop POI index (into POIS) for a match seed */
export function hotDropPoi(seed: number): number {
  const n = NAMED_POI_INDICES.length;
  if (n === 0) return -1;
  return NAMED_POI_INDICES[hash32(seed ^ 0x407d09, 1) % n];
}

/** true when world (x, z) lies inside this match's Hot Drop POI radius */
export function inHotDrop(seed: number, x: number, z: number): boolean {
  const pi = hotDropPoi(seed);
  if (pi < 0) return false;
  const p = POIS[pi];
  return dmath.hypot(x - p.x, z - p.z) <= p.r;
}

export interface MatchEventPlan {
  hotDrop: number;
  fireSaleAt: number;
  fireSaleDur: number;
  frenzyAt: number;
  frenzyCount: number;
}

/** deterministic mid-match dynamic event schedule (match Play time in seconds) */
export function matchEventPlan(seed: number): MatchEventPlan {
  return {
    hotDrop: hotDropPoi(seed),
    fireSaleAt: 75 + (hash32(seed ^ 0x5a1e, 1) % 36),
    fireSaleDur: FIRE_SALE_DUR_S,
    frenzyAt: 165 + (hash32(seed ^ 0xf4e2, 2) % 41),
    frenzyCount: FRENZY_DROP_COUNT,
  };
}

/** apply Fire Sale 50% discount cleanly rounded to a multiple of $10 */
export function salePrice(base: number, onSale: boolean): number {
  return onSale ? Math.max(10, Math.round((base * FIRE_SALE_MUL) / 10) * 10) : base;
}
