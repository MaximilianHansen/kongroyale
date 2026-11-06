// Deterministic loot: chests and floor loot are placed from the match seed on both sides; only "opened / taken /
// spawned" travel over the wire. Rarity tables, chest contents, spawn scatter.
import { CONSUMABLES, POIS, WEAPONS, type ConsumableId, type PoiId } from "../world/map";
import { CONSUMABLE_DEFS, ECON, LOOT_PER_CHEST, PLAYER_H, PLAYER_R, SLOPE_LIMIT, WATER_LEVEL, WEAPON_DEFS, AMMO_PICKUP } from "./const";
import { AMMO_TYPES } from "./player";
import { Rng } from "./rng";
import { makeHit, type StaticWorld } from "./world";
import { lootSpotsById, type LootSpots } from "../pois/index";
import { ACTIVATE, COVER_S, lootReachable, lootSpots, navCellAt, pathSpots, poiTier, SpotKind, Src, validateSpot } from "./loot-spots";
export { ACTIVATE, lootReachable };
import { hash32 } from "./rng";
import { MYTHIC_POI_SHARE, MYTHIC_R, MYTHICS, mythicIndexOfPoi } from "./mythic";
import { bananaStands } from "./economy";
import type { StormState } from "./storm";
import * as dmath from "./dmath";

export const enum IK { Weapon = 0, Consumable = 1, Ammo = 2,
  /** a stack of Banana Bucks: count × $10 */ Cash = 3 }
export interface Chest { id: number; x: number; y: number; z: number; yaw: number; rarity: number; opened: boolean; poi: number;
  /** 1 = an ammo box (ammo + sometimes a heal, never a gun; drawn as an olive ammo crate), else a weapon chest */
  box?: number;
  /** server only (not sent): where a kong stands to open it (the loot generator's validated stand place) — bots walk there */
  sx?: number; sy?: number; sz?: number;
  /** server only (end-game regen): match time it was last opened, restocks so far, when it restocks
   * (Infinity = its coin said no) */
  openedAt?: number; regens?: number; regenAt?: number }
export interface Item { id: number; kind: IK; sub: number; rarity: number; count: number; x: number; y: number; z: number; taken: boolean; bornAt: number;
  /** server: the player who just dropped / swapped it out. Their auto-pickup skips it until they walk away once. */
  dropper?: number;
  /** a placed or chest gun grants useful reserve; elimination spills carry their exact loaded magazine separately */
  full?: number;
  /** Authoritative magazine on an elimination spill; pickup preserves it and grants no synthetic reserve. */
  loaded?: number }

// Chests never drop commons; a Rare Chest replaces 8 % of
// active chests (epic 75 / legendary 25).
// Rarity BY POI TIER — the risk / reward of a hot drop is visible in the glow of its chests and the colour
// of its floor guns: wilderness 0 · named POI 1 · hot drop 2
const CHEST_RARITY = [[0, 62, 26, 10, 2], [0, 55, 30, 12, 3], [0, 40, 34, 19, 7]];
const FLOOR_RARITY = [[48, 30, 15, 6, 1], [40, 32, 18, 8, 2], [28, 32, 24, 12, 4]];
/** a VAULT: a POI's hero chests (designed landmarks, always on — the temple's vault dais, the lab's dish platform, the
 * harbor's crane cab…) never roll below rare; at a hot drop they lean epic / legendary — the payoff worth the climb */
const VAULT_RARITY = [[0, 0, 60, 32, 8], [0, 0, 60, 32, 8], [0, 0, 45, 40, 15]];
const WEAPON_WEIGHTS: Record<string, number> = { pistol: 14, smg: 18, ar: 30, shotgun: 20, sniper: 10, rocket: 8 };
const CONSUMABLE_WEIGHTS: Record<ConsumableId, number> = { "leaf-bundle": 55, smoothie: 40, "golden-banana": 5, "red-banana": 8,
  // --- throwables and placeables --- (bombs are common-ish on the floor and in chests; the crate wall is rare)
  "banana-bomb": 20, "crate-wall": 5 };
const CONSUMABLE_RARITY: Record<ConsumableId, number> = { "leaf-bundle": 0, smoothie: 1, "golden-banana": 4, "red-banana": 3,
  // --- throwables and placeables ---
  "banana-bomb": 1, "crate-wall": 2 };

function rollWeighted(rng: Rng, weights: number[]): number {
  let total = 0; for (const w of weights) total += w;
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
  return weights.length - 1;
}
export const rollRarity = (rng: Rng, chest: boolean, tier = 1) => rollWeighted(rng, (chest ? CHEST_RARITY : FLOOR_RARITY)[Math.max(0, Math.min(2, tier))]);
export const rollVaultRarity = (rng: Rng, tier = 1) => rollWeighted(rng, VAULT_RARITY[Math.max(0, Math.min(2, tier))]);
export const rollWeapon = (rng: Rng) => rollWeighted(rng, WEAPONS.map((w) => WEAPON_WEIGHTS[w]));
export const rollConsumable = (rng: Rng) => rollWeighted(rng, CONSUMABLES.map((c) => CONSUMABLE_WEIGHTS[c]));

/** a point on land, not inside a collider, inside `r` of (cx, cz) */
function findSpot(rng: Rng, world: StaticWorld, cx: number, cz: number, r: number, used: Array<[number, number]>, minGap: number): [number, number, number] | null {
  for (let tries = 0; tries < 40; tries++) {
    const a = rng.next() * Math.PI * 2, d = Math.sqrt(rng.next()) * r;
    const x = cx + dmath.cos(a) * d, z = cz + dmath.sin(a) * d;
    const h = world.ground(x, z);
    if (h < 0.9) continue;
    const n = world.terrain.normal(x, z); if (n[1] < 0.8) continue;
    let ok = true;
    for (const u of used) if (dmath.pow(u[0] - x, 2) + dmath.pow(u[1] - z, 2) < minGap * minGap) { ok = false; break; }
    if (!ok) continue;
    world.velY = 0; world.resolveCapsule(x, h + 0.02, z, PLAYER_R, PLAYER_H, false);
    // stand on top of a box if there is one; reject if pushed sideways
    if (dmath.hypot(world.P[0] - x, world.P[2] - z) > 0.05) continue;
    const y = world.P[1];
    used.push([x, z]);
    return [x, y, z];
  }
  return null;
}

/** designed spots, resolved once (the POI modules compute them at import) */
let SPOTS: Record<string, LootSpots> | null = null;
export function designedLoot(): Record<string, LootSpots> { return SPOTS ??= lootSpotsById(); }

/** a live weapon source must be this close (sprint-time estimate) to every coverage probe; the probes sit ≤ 8 m from any
 * landing point, so the 10 s promise keeps ~2.5 s of slack for detours (a tighter 8.6 s cover lit a chest or a floor
 * gun beside every house that already held its gun: 10.6 weapons per player, and chests lose their value) */
const COVER_WAKE_S = COVER_S;
/** an open POI's promise (the 10 s promise: tried 12 s — Ripe Peak 30 → 22 chests, but its far slopes broke 10 s) */
const COVER_OPEN_S = COVER_S;
/** THIS MATCH's activation — ACTIVATE (loot-spots.ts) still sizes the canonical spot set; these decide how
 * much of it is live. The pattern: every enterable house holds its gun AND a supply (a heal, a shield or an ammo stack on
 * the floor); chests are the step up (fewer, so a glow means something); at most one ammo crate per house. */
const ACT = { chest: 0.15, hotChest: 0.5, hotTownChest: 0.22, openChest: 0.1, wildChest: 0.32, floor: 0.1, wildFloor: 0.4,
  /** share of the random (non-cover, non-house) floor spots that roll a gun */
  floorGun: 0.04,
  /** a building lights at most `boxesOf(storeys)` of its ammo boxes, each with this chance; outdoor boxes (docks, yards) */
  boxBld: 0.25, boxOut: 0.22 };
const boxesOf = (B: { storeys: number; hot?: boolean }) => B.hot ? 3 : B.storeys >= 3 ? 2 : 1;
/** the cover's seeded jitter on each spot's gain (±): more = more variety between matches, less = fewer weapons needed */
const COVER_JIT = 0.1;
/** activation of a hot building's storey / roof chests */
const HOT_ACT = 0.5;
/** a seeded per-spot coin: independent of every other spot and of iteration order (client / server / tools agree) */
const coin = (seed: number, id: number) => hash32(seed ^ 0x51ed1007, id) / 4294967296;

/** the canonical spots (loot-spots.ts, derived from the static world, cached) → this match's chests and floor loot.
 * Per POI: (1) COVERAGE — a seeded greedy set cover gives every landing point a weapon within COVER_WAKE_S (chests, or
 * floor spots made guns); (2) more spots in a seeded random order up to the activation rates, the floor mostly ammo /
 * heals. (The other order — a random chest subset first, then the gaps — needs MORE weapons: random chests
 * overlap.) Hero chests are always on; ammo boxes flip their own coins (a building with little
 * else flips them more often); every enterable building keeps ≥ 1 live spot, and holds a floor gun (HOUSE GUNS, first). */
export function placeLoot(seed: number, world: StaticWorld): { chests: Chest[]; items: Item[] } {
  const rng = new Rng(seed ^ 0x100c);
  const chests: Chest[] = [], items: Item[] = [];
  const set = lootSpots(world);
  const N = set.spots.length;
  const on = new Uint8Array(N), gun = new Uint8Array(N);
  // a wilderness floor spot is a weapon half the time: it is the loot pocket on a rotation, the gun a glider
  // that landed between POIs runs to
  for (const s of set.spots) if (s.kind === SpotKind.Floor) gun[s.id] = coin(seed ^ 0x6a11, s.id) < (s.src === Src.Wild ? 0.5 : ACT.floorGun) ? 1 : 0;
  // spot → the probes it serves (a chest or a floor gun within COVER_WAKE_S)
  const serves: number[][] = Array.from({ length: N }, () => []);
  // an OPEN POI — a mountain, a falls, a beached wreck: ≤ 1 enterable building — keeps the 10 s promise
  // (COVER_S), not the towns' 8 s: the 8 s cover lit ~46 chests on Ripe Peak's bare slopes (more than any town), one
  // beside every boulder. Its chests sit where the designed / canonical spots put them, 10 s apart at most.
  const entIn = new Map<number, number>(); for (const B of set.buildings) if (B.enterable) entIn.set(B.poi, (entIn.get(B.poi) ?? 0) + 1);
  const wake = (poi: number) => poi >= 0 && (entIn.get(poi) ?? 0) <= 1 ? COVER_OPEN_S : COVER_WAKE_S;
  // (landing points only: a room centre is not where a glider comes down — the promise is about landing)
  set.probes.forEach((P, pi) => { if (P.room) return; const W = wake(P.poi); for (let q = 0; q < P.near.length && P.t[q] <= W; q++) serves[P.near[q]].push(pi); });
  const covered = new Uint8Array(set.probes.length);
  /** turn a spot on; a chest or a floor gun is a weapon source for the probes it serves */
  const light = (k: number) => { on[k] = 1; if (set.spots[k].kind === SpotKind.Chest || gun[k]) for (const q of serves[k]) covered[q] = 1; };
  const groups = new Map<number, { c: number[]; f: number[] }>();
  for (const s of set.spots) {
    if (s.kind === SpotKind.Ammo || s.fb || s.house !== undefined) continue;
    if (s.src === Src.Hero) { light(s.id); continue; }
    let g = groups.get(s.poi); if (!g) groups.set(s.poi, g = { c: [], f: [] });
    (s.kind === SpotKind.Chest ? g.c : g.f).push(s.id);
  }
  // HOUSE GUNS: every enterable building holds a floor gun every match — the seeded pick among its floor spots (its
  // house-gun spots + its canonical floor spots; loot-spots.ts roomUnits). Lit FIRST, so the landing cover below counts
  // them as the weapon sources they are (no extra chest next to a house that already has its gun). On top of the POI's
  // floor activation: its ammo / heal floor items stay as they were.
  const houseAlt = new Map<number, number[]>(), houseFb = new Map<number, number[]>(), houseChest = new Map<number, number[]>();
  const houseOn = new Uint8Array(N);
  for (const s of set.spots) {
    if (s.bld < 0 || !set.buildings[s.bld].enterable) continue;
    const m = s.kind === SpotKind.Floor ? (s.fb ? houseFb : houseAlt) : s.kind === SpotKind.Chest && !s.fb ? houseChest : null; if (!m) continue;
    let l = m.get(s.bld); if (!l) m.set(s.bld, l = []); l.push(s.id);
  }
  // (a hut too small for its own house spot — a 2-cell stilt hut — has only its room fallback: that is its gun spot)
  for (const [b, ids] of houseFb) if (!houseAlt.has(b)) houseAlt.set(b, ids);
  /** house guns per POI: they COUNT toward the POI's floor-gun quota (a town of 78 houses already holds 78
   * floor guns — extra floor guns on top would mean 9.7 weapons per player, a gun on every doorstep) */
  const houseG = new Map<number, number>();
  const pickOf = (ids: number[], salt: number) => { let k = ids[0]; for (const q of ids) if (coin(seed ^ salt, q) < coin(seed ^ salt, k)) k = q; return k; };
  for (const ids of houseAlt.values()) {
    // (a spot the bots' walk graph reaches first: every candidate is player-reachable, the bots only see known doors)
    const r = Math.min(...ids.map((q) => set.spots[q].navIn ?? 2));
    const k = pickOf(ids.filter((q) => (set.spots[q].navIn ?? 2) === r), 0x4a5e); gun[k] = 1; light(k); houseOn[k] = 1;
    houseG.set(set.spots[k].poi, (houseG.get(set.spots[k].poi) ?? 0) + 1);
  }
  for (const [poi, g] of groups) {
    const order = (a: number, b: number) => coin(seed, a) - coin(seed, b);
    g.c.sort(order); g.f.sort(order);
    const wild = poi < 0;
    // (hot 11 / named 6 — the 8 s cover's extra weapons come from chests, not floor items)
    const cap = wild ? 99 : poiTier(poi) === 2 ? 11 : 6;
    const hg = houseG.get(poi) ?? 0;
    // (1) COVERAGE first: a randomised greedy set cover — the spot that brings a weapon to the most landing points still
    // without one (each gain jittered ±COVER_JIT by the seed, so equal layouts differ between matches); a floor spot
    // that carries a point's weapon becomes a gun; floor guns stop a little under the POI's cap (hot 25, named 15)
    if (!wild) {
      const pool = [...g.c, ...g.f];
      let guns = 0;
      for (;;) {
        let best = -1, bs = 0;
        for (const k of pool) {
          const isC = set.spots[k].kind === SpotKind.Chest;
          if (on[k] || (!isC && guns >= cap)) continue;
          let n = 0; for (const q of serves[k]) if (!covered[q]) n++;
          if (!n) continue;
          // (the 8 s promise needs ~35 % more weapon sources; chests carry them, not floor items)
          const v = n * (isC ? 1 : gun[k] ? 0.65 : 0.6) * (1 - COVER_JIT + 2 * COVER_JIT * coin(seed ^ 0x2b, k));
          if (v > bs) { bs = v; best = k; }
        }
        if (best < 0) break;
        if (set.spots[best].kind === SpotKind.Floor) { gun[best] = 1; guns++; }
        light(best);
      }
    }
    // (2) then more in the seeded order up to the activation rates (floor: mostly ammo / heals; a spot that rolled a
    // gun stays one only while the POI is under its floor-gun cap)
    // the house guns do not fill the floor quota: a town's floor is its guns + supplies, not guns only
    const fFree = g.f.filter((k) => !houseOn[k]);
    const wantC = Math.round(g.c.length * (wild ? ACT.wildChest : poiTier(poi) === 2 ? ((entIn.get(poi) ?? 0) >= 15 ? ACT.hotTownChest : ACT.hotChest) : (entIn.get(poi) ?? 0) <= 1 ? ACT.openChest : ACT.chest)), wantF = Math.round(fFree.length * (wild ? ACT.wildFloor : ACT.floor));
    let nC = g.c.filter((k) => on[k]).length;
    for (const k of g.c) { if (nC >= wantC) break; if (!on[k]) { light(k); nC++; } }
    let nF = fFree.filter((k) => on[k]).length, nG = hg + g.f.filter((k) => on[k] && gun[k] && !houseOn[k]).length;
    for (const k of fFree) { if (nF >= wantF) break; if (!on[k]) { if (gun[k]) { if (nG >= cap) gun[k] = 0; else nG++; } light(k); nF++; } }
  }
  // a building with no floor spot at all: a live chest is its weapon
  for (const [b, ids] of houseChest) if (!houseAlt.has(b) && !ids.some((k) => on[k])) light(pickOf(ids, 0x4a5f));
  // AMMO BOXES: a building lights at most boxesOf() of its boxes (a seeded pick, each with ACT.boxBld) —
  // the canonical set holds one per storey of every house (436 in Mango: 148 live olive crates against its 18 chests);
  // outdoor boxes (docks, yards, camps) flip ACT.boxOut. The house's second item is its floor supply (below), not a crate.
  const boxRank = new Map<number, number[]>();
  for (const s of set.spots) { if (s.kind !== SpotKind.Ammo || s.fb || s.bld < 0) continue; let l = boxRank.get(s.bld); if (!l) boxRank.set(s.bld, l = []); l.push(s.id); }
  for (const [b, ids] of boxRank) { ids.sort((x, y) => coin(seed ^ 0xb0c, x) - coin(seed ^ 0xb0c, y)); ids.length = Math.min(ids.length, boxesOf(set.buildings[b])); }
  const boxLive = new Set<number>(); for (const ids of boxRank.values()) for (const k of ids) boxLive.add(k);
  for (const s of set.spots) {
    if (s.kind !== SpotKind.Ammo || s.fb) continue;
    on[s.id] = s.bld >= 0 ? (boxLive.has(s.id) && coin(seed, s.id) < ACT.boxBld ? 1 : 0) : coin(seed, s.id) < ACT.boxOut ? 1 : 0;
  }
  // an enterable building never comes up empty: its first spot (by coin) stays on
  const bestOf = new Map<number, number>(), anyOn = new Set<number>();
  for (const s of set.spots) {
    if (s.bld < 0 || !set.buildings[s.bld].enterable) continue;
    if (on[s.id]) anyOn.add(s.bld);
    if (s.fb) continue;
    const cur = bestOf.get(s.bld); if (cur === undefined || coin(seed ^ 7, s.id) < coin(seed ^ 7, cur)) bestOf.set(s.bld, s.id);
  }
  for (const [b, id] of bestOf) if (!anyOn.has(b)) on[id] = 1;
  // every ROOM UNIT holds loot: a unit with nothing live lights its fallback (never a gun); a hot
  // building keeps ≥ 1 live chest on every storey and its roof (the seeded first of each key when the coins left none)
  const unitLive = new Uint8Array(set.units.length), hotLive = new Set<number>(), hotFirst = new Map<number, number>();
  for (const s of set.spots) {
    if (on[s.id] && s.unit !== undefined && s.unit >= 0 && (!s.fb || houseOn[s.id])) unitLive[s.unit] = 1;
    if (s.hot !== undefined) { if (on[s.id]) hotLive.add(s.hot); const f = hotFirst.get(s.hot); if (f === undefined || coin(seed ^ 0x40b, s.id) < coin(seed ^ 0x40b, f)) hotFirst.set(s.hot, s.id); }
  }
  // a hot building's chests come up more often than the POI's (the hotel IS the hot drop: ~70 %)
  for (const s of set.spots) if (s.hot !== undefined && !on[s.id] && coin(seed ^ 0x7b1, s.id) < HOT_ACT) { on[s.id] = 1; hotLive.add(s.hot); if (s.unit !== undefined && s.unit >= 0) unitLive[s.unit] = 1; }
  for (const [k, id] of hotFirst) if (!hotLive.has(k)) { on[id] = 1; const u = set.spots[id].unit; if (u !== undefined && u >= 0) unitLive[u] = 1; }
  // a room unit with nothing live gets a FLOOR SUPPLY first — one of its own floor spots (a house-gun
  // spot the gun did not take, or a canonical one) as a heal / shield / ammo stack — and only then its fallback, which in
  // a house is an olive ammo crate (Mango: 199 of its 201 room units fall back to a crate: 137 live crates a match)
  const unitSupply = new Map<number, number>();
  for (const s of set.spots) {
    if (on[s.id] || s.fb || s.kind !== SpotKind.Floor || s.unit === undefined || s.unit < 0 || unitLive[s.unit]) continue;
    const f = unitSupply.get(s.unit); if (f === undefined || coin(seed ^ 0x5b1, s.id) < coin(seed ^ 0x5b1, f)) unitSupply.set(s.unit, s.id);
  }
  for (const [u, id] of unitSupply) { on[id] = 1; gun[id] = 0; unitLive[u] = 1; }
  // a fallback CRATE past its building's crate allowance (boxesOf) comes up as a floor supply on the same
  // spot instead (a heal / shield / ammo stack on the floor by the wall): one item on every storey, not one crate
  const boxN = new Map<number, number>(), asItem = new Uint8Array(N);
  for (const s of set.spots) if (on[s.id] && s.kind === SpotKind.Ammo && s.bld >= 0) boxN.set(s.bld, (boxN.get(s.bld) ?? 0) + 1);
  for (const s of set.spots) if (s.fb && !houseOn[s.id]) {
    if (s.unit !== undefined && s.unit >= 0 && !unitLive[s.unit]) {
      on[s.id] = 1; gun[s.id] = 0; unitLive[s.unit] = 1;
      if (s.kind === SpotKind.Ammo && s.bld >= 0) { const n = boxN.get(s.bld) ?? 0; if (n >= boxesOf(set.buildings[s.bld]) || coin(seed ^ 0xfb, s.id) >= ACT.boxBld) asItem[s.id] = 1; else boxN.set(s.bld, n + 1); }
    } else on[s.id] = 0;
  }
  // a unit with no fallback of its own (its only candidates are canonical spots): the seeded first of them stays on
  const firstOf = new Map<number, number>();
  // (a floor supply before an ammo box before a chest — a room's guaranteed item is a heal / shield / ammo
  // stack on the floor, not one more olive crate or one more gun)
  const pref = (k: number) => set.spots[k].kind === SpotKind.Floor ? 0 : set.spots[k].kind === SpotKind.Ammo ? 1 : 2;
  for (const s of set.spots) { if (s.unit === undefined || s.unit < 0 || unitLive[s.unit] || s.fb) continue; const f = firstOf.get(s.unit); if (f === undefined || pref(s.id) < pref(f) || (pref(s.id) === pref(f) && coin(seed ^ 0x3d, s.id) < coin(seed ^ 0x3d, f))) firstOf.set(s.unit, s.id); }
  for (const [u, id] of firstOf) { on[id] = 1; if (set.spots[id].kind === SpotKind.Floor) gun[id] = 0; unitLive[u] = 1; }
  // HOUSE SUPPLY: a house holds its gun AND something to go with it — a building whose only live spot is
  // its house gun lights a floor supply (never a gun: a heal, a shield or an ammo stack), else one of its ammo boxes
  const bldLiveN = new Map<number, number>();
  for (const s of set.spots) if (on[s.id] && s.bld >= 0 && !houseOn[s.id]) bldLiveN.set(s.bld, (bldLiveN.get(s.bld) ?? 0) + 1);
  const supply = new Map<number, number>();
  for (const s of set.spots) {
    if (on[s.id] || s.bld < 0 || !set.buildings[s.bld].enterable || bldLiveN.get(s.bld) || (s.kind !== SpotKind.Floor && s.kind !== SpotKind.Ammo)) continue;
    const f = supply.get(s.bld), r = (k: number) => (set.spots[k].kind === SpotKind.Floor ? 0 : 2) + (set.spots[k].fb ? 1 : 0);
    if (f === undefined || r(s.id) < r(f) || (r(s.id) === r(f) && coin(seed ^ 0x5a9, s.id) < coin(seed ^ 0x5a9, f))) supply.set(s.bld, s.id);
  }
  for (const id of supply.values()) { on[id] = 1; gun[id] = 0; }
  // a house whose live CHEST already holds its gun keeps no floor gun on top: its house-gun spot carries
  // a supply (heal / shield / ammo) instead — the house still has its gun, in the chest that glows behind the door
  // (a chest on the same storey, in a room of that house: a deck or roof chest above a hut does not count)
  const chestIn = new Map<number, number[]>();
  // ...and the chest must stand on a walk cell OF that house: some room chests (a CNVS Lab annex, two Wreck Bay cabins,
  // one Coconut Cove room) sit off every walk cell, and a house must not lose its floor gun to a chest that is not in it
  const inHouse = (k: number, b: number) => { const q = set.spots[k], c = navCellAt(set.nav, q.x, q.y + 0.05, q.z); return c >= 0 && set.nav.bld[c] === b; };
  for (const s of set.spots) if (on[s.id] && s.kind === SpotKind.Chest && s.bld >= 0 && s.unit !== undefined && s.unit >= 0 && set.buildings[s.bld].enterable && inHouse(s.id, s.bld)) { let l = chestIn.get(s.bld); if (!l) chestIn.set(s.bld, l = []); l.push(s.id); }
  for (const s of set.spots) if (houseOn[s.id] && chestIn.get(s.bld)?.some((k) => Math.abs(set.spots[k].y - s.y) < 1.6 && dmath.hypot(set.spots[k].x - s.x, set.spots[k].z - s.z) < 14)) gun[s.id] = 0;
  const sig = new Map<number, [number, number]>();
  // nothing spawns inside a Banana Stand's counter
  const stands = bananaStands(world), atStand = (s: { x: number; y: number; z: number }) => stands.some((q) => Math.abs(q.x - s.x) < 2.6 && Math.abs(q.z - s.z) < 2.6 && Math.abs(q.y - s.y) < 2.5);
  for (const s of set.spots) {
    if (!on[s.id] || atStand(s)) continue;
    // a hot building pays better: the hot-POI rarity shift
    const tier = s.bld >= 0 && set.buildings[s.bld]?.hot ? 2 : poiTier(s.poi);
    if (s.kind === SpotKind.Ammo && asItem[s.id]) {
      items.push(rollFloorItem(rng, items.length, s.x, s.y, s.z, tier, 0));
    } else if (s.kind === SpotKind.Ammo) {
      chests.push({ id: chests.length, x: s.x, y: s.y, z: s.z, yaw: s.yaw, rarity: 0, opened: false, poi: s.poi, box: 1, sx: s.sx, sy: s.sy, sz: s.sz });
    } else if (s.kind === SpotKind.Chest) {
      const rare = rng.next() < ACTIVATE.rareChest || s.pay === 1;   // a POI's payoff chest is always a Rare Chest
      const rarity = rare ? (rng.next() < 0.75 ? 3 : 4) : s.src === Src.Hero ? rollVaultRarity(rng, tier) : rollRarity(rng, true, tier);
      // the POI's signature chest: its payoff chest, else a hero chest, else its best other chest
      if (s.poi >= 0) { const sc = (s.pay === 1 ? 3e6 : s.src === Src.Hero ? 2e6 : 0) + rarity * 1e5 + coin(seed ^ 0x3171c, s.id) * 1e4; const b = sig.get(s.poi); if (!b || sc > b[1]) sig.set(s.poi, [chests.length, sc]); }
      chests.push({ id: chests.length, x: s.x, y: s.y, z: s.z, yaw: s.yaw, rarity, opened: false, poi: s.poi, sx: s.sx, sy: s.sy, sz: s.sz });
    } else {
      // a floor gun carries its ammo stack (taking it gives the full stack, see Match.takeItem) — one
      // pickup per floor spot instead of a gun + a stack beside it; the ammo boxes carry the rest of the ammo
      const it = rollFloorItem(rng, items.length, s.x, s.y, s.z, tier, gun[s.id] ? 1 : 0); if (it.kind === IK.Weapon) it.full = 1; items.push(it);
    }
  }
  // a named POI's signature chest is a MYTHIC chest: its POI's mythic gun is inside (rollChestContents)
  // …at about HALF the POIs a match: the POIs are ranked by a coin of the match seed (no rng
  // draw: the rest of the loot is untouched) and the first MYTHIC_POI_SHARE of them carry their mythic — a different
  // half every match; the other POIs' signature chests stay the chest they rolled
  const mythPois = [...sig.keys()].filter((poi) => mythicIndexOfPoi(poi) >= 0).sort((a, b) => coin(seed ^ 0x6d7c, a) - coin(seed ^ 0x6d7c, b));
  const mythOn = new Set(mythPois.slice(0, Math.round(mythPois.length * MYTHIC_POI_SHARE)));
  for (const [poi, [ci]] of sig) if (mythOn.has(poi)) chests[ci].rarity = MYTHIC_R;
  // the lobby islet (warm-up only): a fixed, generous scatter
  const used: Array<[number, number]> = [];
  POIS.forEach((poi, pi) => {
    if (poi.id !== ("lobby-islet" as PoiId)) return;
    for (let i = 0; i < 10; i++) { const s = findSpot(rng, world, poi.x, poi.z, poi.r * 0.9, used, 7); if (!s) continue; const v = validateSpot(world, SpotKind.Chest, s[0], s[1] + 0.05, s[2], rng.next() * Math.PI * 2, true); if (!v.why) chests.push({ id: chests.length, x: v.x, y: s[1], z: v.z, yaw: v.yaw, rarity: rollRarity(rng, true), opened: false, poi: pi }); }
    for (let i = 0; i < 14; i++) { const s = findSpot(rng, world, poi.x, poi.z, poi.r * 0.95, used, 3); if (!s) continue; const v = validateSpot(world, SpotKind.Floor, s[0], s[1] + 0.05, s[2]); if (!v.why) items.push(rollFloorItem(rng, items.length, s[0], v.y, s[2])); }
  });
  extraHeals(seed, world, set, on, items, chests, atStand);
  return { chests, items };
}

/** EXTRA HEALS (about 20 % more heals and shields: inside POI buildings, along paths of travel, a little more in
 * chests), on top of everything else (no other loot moves: the extras use spots the match left off and their own rng,
 * after every other roll — every gun, ammo stack, chest and coin of a seed is exactly what it was). */
export const HEALS = {
  /** an enterable building's floor spot the match left off (designed LOOT_SPOTS + scan spots) holds an extra heal with
   * this chance — at most one extra per building */
  inBld: 0.1,
  /** a rotation-path spot (loot-spots.ts pathSpots: road / trail shoulders between POIs, bridges, zipline decks) is live
   * with this chance */
  path: 0.3,
  /** of the extras: a SMOOTHIE (shield) with this chance, else a LEAF BUNDLE (hp) */
  shield: 0.45,
  /** units per extra floor stack (the floor's heal stacks are 2) */
  count: 2,
  /** no extra within this (m) of a live floor item / chest on the same floor */
  gap: 5,
  /** a weapon chest adds one more heal / shield (1 unit) with this chance (the chest's heal ratio, a bump) */
  chestExtra: 0.2,
  /** an ammo box's heal (a leaf bundle) chance */
  box: 0.25,
};
/** (tools) the item ids the last placeLoot added as extra heals, by where */
export const lastExtraHeals = { bld: [] as number[], path: [] as number[] };
function extraHeals(seed: number, world: StaticWorld, set: ReturnType<typeof lootSpots>, on: Uint8Array, items: Item[], chests: Chest[], atStand: (s: { x: number; y: number; z: number }) => boolean) {
  lastExtraHeals.bld = []; lastExtraHeals.path = [];
  const rng = new Rng(seed ^ 0x4ea15);
  const leaf = CONSUMABLES.indexOf("leaf-bundle"), smoo = CONSUMABLES.indexOf("smoothie");
  // a coarse 8 m hash of everything already lying about (floor items + containers)
  const grid = new Map<number, Array<[number, number, number]>>();
  const key = (x: number, z: number) => (Math.floor(x / 8) + 512) * 1024 + Math.floor(z / 8) + 512;
  const add = (x: number, y: number, z: number) => { const k = key(x, z); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push([x, y, z]); };
  const clear = (x: number, y: number, z: number) => {
    const g2 = HEALS.gap * HEALS.gap, cx = Math.floor(x / 8), cz = Math.floor(z / 8);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const q of grid.get((cx + i + 512) * 1024 + cz + j + 512) ?? []) if (Math.abs(q[1] - y) < 2 && dmath.pow(q[0] - x, 2) + dmath.pow(q[2] - z, 2) < g2) return false;
    return true;
  };
  for (const it of items) add(it.x, it.y, it.z);
  for (const c of chests) add(c.x, c.y, c.z);
  const drop = (x: number, y: number, z: number, tag: number[]) => {
    const c = rng.next() < HEALS.shield ? smoo : leaf, id = items.length;
    items.push({ id, kind: IK.Consumable, sub: c, rarity: consumableRarity(c), count: Math.min(HEALS.count, CONSUMABLE_DEFS[CONSUMABLES[c]].stack), x, y, z, taken: false, bornAt: 0 });
    add(x, y, z); tag.push(id);
  };
  // (1) inside POI buildings: the match's unused floor spots, a seeded coin each, one extra per building
  const bldDone = new Set<number>();
  const order = set.spots.filter((s) => s.kind === SpotKind.Floor && !on[s.id] && s.bld >= 0 && s.poi >= 0 && set.buildings[s.bld]?.enterable)
    .sort((a, b) => coin(seed ^ 0x4ea1, a.id) - coin(seed ^ 0x4ea1, b.id));
  for (const s of order) {
    if (bldDone.has(s.bld) || coin(seed ^ 0x4ea2, s.id) >= HEALS.inBld || atStand(s) || !clear(s.x, s.y, s.z)) continue;
    bldDone.add(s.bld); drop(s.x, s.y, s.z, lastExtraHeals.bld);
  }
  // (2) along the rotation routes between POIs (a seeded coin per spot, not by index: stable when the route set changes)
  pathSpots(world).forEach((p) => {
    if (hash32(seed ^ 0x9a7b, Math.round(p.x * 8) * 7919 + Math.round(p.z * 8)) / 4294967296 >= HEALS.path || !clear(p.x, p.y, p.z)) return;
    drop(p.x, p.y, p.z, lastExtraHeals.path);
  });
}

/** `gun`: 1 = a weapon, 0 = ammo / a consumable (26 : 34), -1 = roll it (40 / 26 / 34) */
function rollFloorItem(rng: Rng, id: number, x: number, y: number, z: number, tier = 1, gun: -1 | 0 | 1 = -1): Item {
  const k = gun < 0 ? rng.next() : gun ? 0 : 0.4 + rng.next() * 0.6;
  if (k < 0.4) { const w = rollWeapon(rng); return { id, kind: IK.Weapon, sub: w, rarity: rollRarity(rng, false, tier), count: 1, x, y, z, taken: false, bornAt: 0 }; }
  if (k < 0.66) { const a = rng.int(4); return { id, kind: IK.Ammo, sub: a, rarity: 0, count: AMMO_PICKUP[AMMO_TYPES[a]], x, y, z, taken: false, bornAt: 0 }; }
  // about 1 floor supply in 9 is a stack of Banana Bucks
  if (k < 0.73) return { id, kind: IK.Cash, sub: 0, rarity: 0, count: Math.round((ECON.floorMin + rng.next() * (ECON.floorMax - ECON.floorMin)) / 10), x, y, z, taken: false, bornAt: 0 };
  const c = rollConsumable(rng); return { id, kind: IK.Consumable, sub: c, rarity: consumableRarity(c), count: CONSUMABLES[c] === "golden-banana" || CONSUMABLES[c] === "red-banana" ? 1 : Math.min(2, CONSUMABLE_DEFS[CONSUMABLES[c]].stack), x, y, z, taken: false, bornAt: 0 };
}
export const consumableRarity = (c: number) => CONSUMABLE_RARITY[CONSUMABLES[c]] ?? 0;

// DROPPED LOOT FALLS TO THE FLOOR. A death drop, a chest spill or a swap is not just pushed out of colliders where it
// appears (a kong shot off its glider would leave its guns hanging in the air): every spawned item comes to rest on the
// first surface below it (box top, terrain, or the sea's surface), never inside a wall, preferring a flat floor.
const SH = makeHit();
/** where an item spawned at (x, y, z) comes to rest: straight down from `lift` m above it onto the first walk surface,
 * pushed out of anything it landed in (a wall, a crate) and settled again; a steep face (a roof slope, a rock flank)
 * hands it on to the nearest flat floor within 1.6 m that is no higher than the face. Over water it floats at the
 * surface. Writes [x, y, z] into `out`. Deterministic (the server's world only). */
export function settleLoot(world: StaticWorld, x: number, y: number, z: number, out: Float64Array | number[], lift = 0.6): void {
  let fx = x, fz = z, top = y + lift, fy = y, ny = 1;
  for (let k = 0; k < 3; k++) {
    world.raycast(fx, top, fz, 0, -1, 0, top - WATER_LEVEL + 40, SH, false);
    // a rail, a net, a post top or a cable is no shelf: the item falls past it (≤ 3 thin tops)
    for (let q = 0; q < 3 && SH.hit && SH.box >= 0 && Math.min(world.hx[SH.box], world.hz[SH.box]) < 0.16; q++) world.raycast(fx, SH.y - 0.01, fz, 0, -1, 0, SH.y - WATER_LEVEL + 40, SH, false);
    fy = SH.hit ? SH.y : -1e9; ny = SH.hit ? SH.ny : 1;
    if (fy < WATER_LEVEL - 0.15) { fy = WATER_LEVEL - 0.15; ny = 1; break; }
    world.velY = 0; world.headBump = false;
    world.resolveCapsule(fx, fy + 0.02, fz, 0.2, 0.4, false);
    const px = world.P[0], py = world.P[1], pz = world.P[2];
    if (dmath.hypot(px - fx, pz - fz) < 0.02 && py - (fy + 0.02) < 0.05) break;
    fx = px; fz = pz; top = py + 0.3;
  }
  if (ny < SLOPE_LIMIT) {
    let bd = Infinity, bx = fx, by = fy, bz = fz;
    for (const r of [0.5, 1.0, 1.6]) {
      for (let a = 0; a < 8; a++) {
        const qx = fx + dmath.cos(a * Math.PI / 4) * r, qz = fz + dmath.sin(a * Math.PI / 4) * r;
        world.raycast(qx, fy + 0.4, qz, 0, -1, 0, 60, SH, false);
        if (!SH.hit || SH.ny < SLOPE_LIMIT || SH.y > fy + 0.1) continue;
        const d = r + (fy - SH.y) * 0.25; if (d < bd) { bd = d; bx = qx; by = SH.y; bz = qz; }
      }
      if (bd < Infinity) break;
    }
    fx = bx; fy = Math.max(by, WATER_LEVEL - 0.15); fz = bz;
  }
  out[0] = fx; out[1] = fy; out[2] = fz;
}
/** the part of a toss from (ax, ay, az) to (bx, *, bz) at height ay that is clear of walls: the item lands on this side
 * of a wall / door / railing between its source and where it was thrown (a chest against a wall spills into the room) */
export function tossClear(world: StaticWorld, ax: number, ay: number, az: number, bx: number, bz: number, out: Float64Array | number[]): void {
  const dx = bx - ax, dz = bz - az, l = dmath.hypot(dx, dz);
  out[0] = bx; out[1] = ay; out[2] = bz;
  if (l < 1e-4) return;
  world.raycast(ax, ay, az, dx, 0, dz, 1, SH, false);
  if (!SH.hit) return;
  const k = Math.max(0, SH.t - 0.25 / l);
  out[0] = ax + dx * k; out[2] = az + dz * k;
}

const AMMO_BOX_W = [36, 22, 30, 12];   // light / heavy / shells / rockets
/** what an ammo box spawns: two ammo stacks (two kinds when it can) and, one time in five, a leaf bundle */
export function rollAmmoBox(rng: Rng): Array<{ kind: IK; sub: number; rarity: number; count: number }> {
  const a = rollWeighted(rng, AMMO_BOX_W); let b = rollWeighted(rng, AMMO_BOX_W); if (b === a) b = rollWeighted(rng, AMMO_BOX_W);
  const out = [a, b].map((t) => ({ kind: IK.Ammo, sub: t, rarity: 0, count: AMMO_PICKUP[AMMO_TYPES[t]] }));
  if (rng.next() < HEALS.box) { const c = CONSUMABLES.indexOf("leaf-bundle"); out.push({ kind: IK.Consumable, sub: c, rarity: consumableRarity(c), count: 1 }); }
  if (rng.next() < ECON.boxChance) out.push({ kind: IK.Cash, sub: 0, rarity: 0, count: ECON.box / 10 });
  return out;
}
/** what a chest spawns: [weapon, matching ammo, consumable] + a bonus at higher chest rarity. A MYTHIC chest (rarity
 * MYTHIC_R, one per POI) holds its POI's (`poi`) mythic gun, double ammo, a heal and a shield */
export function rollChestContents(rng: Rng, chestRarity: number, poi = -1): Array<{ kind: IK; sub: number; rarity: number; count: number }> {
  const mk = chestRarity >= MYTHIC_R ? mythicIndexOfPoi(poi) : -1;
  if (mk >= 0) {
    const def = MYTHICS[mk], w = WEAPONS.indexOf(def.weapon), ammoType = WEAPON_DEFS[def.weapon].ammo;
    const c = rollConsumable(rng), sh = CONSUMABLES.indexOf("smoothie");
    return [
      { kind: IK.Weapon, sub: w, rarity: MYTHIC_R + mk, count: 1 },
      { kind: IK.Ammo, sub: AMMO_TYPES.indexOf(ammoType), rarity: 0, count: AMMO_PICKUP[ammoType] * 2 },
      { kind: IK.Consumable, sub: c, rarity: consumableRarity(c), count: Math.min(CONSUMABLE_DEFS[CONSUMABLES[c]].stack, 2) },
      { kind: IK.Consumable, sub: sh, rarity: consumableRarity(sh), count: 2 },
      { kind: IK.Cash, sub: 0, rarity: 0, count: ECON.chest[5] / 10 },
    ];
  }
  const w = rollWeapon(rng);
  let wr = rollRarity(rng, true); if (wr < chestRarity - 1) wr = chestRarity - 1;
  const ammoType = WEAPON_DEFS[WEAPONS[w]].ammo; const ai = AMMO_TYPES.indexOf(ammoType);
  const c = rollConsumable(rng);
  const out = [
    { kind: IK.Weapon, sub: w, rarity: Math.min(4, wr), count: 1 },
    { kind: IK.Ammo, sub: ai, rarity: 0, count: AMMO_PICKUP[ammoType] * 2 },
    { kind: IK.Consumable, sub: c, rarity: consumableRarity(c), count: Math.min(CONSUMABLE_DEFS[CONSUMABLES[c]].stack, 2) },
  ];
  if (chestRarity >= 3 && rng.next() < 0.6) { const c2 = rollConsumable(rng); out.push({ kind: IK.Consumable, sub: c2, rarity: consumableRarity(c2), count: 1 }); }
  const kept = out.slice(0, LOOT_PER_CHEST + 1);
  // every chest pays out a little Banana Bucks
  kept.push({ kind: IK.Cash, sub: 0, rarity: 0, count: ECON.chest[Math.max(0, Math.min(5, chestRarity))] / 10 });
  // the chest's heal bump: one more heal / shield now and then (its own draw, after every other one)
  if (rng.next() < HEALS.chestExtra) { const h = CONSUMABLES.indexOf(rng.next() < HEALS.shield ? "smoothie" : "leaf-bundle"); kept.push({ kind: IK.Consumable, sub: h, rarity: consumableRarity(h), count: 1 }); }
  return kept;
}

// ------------------------------------------------------------------------------------------------ end-game regen
/** DEEP END-GAME LOOT REGEN. Server-authoritative: from storm phase `fromPhase` on, an opened chest (and ammo box)
 * restocks — it closes again (glow + hum back on every client: EV.ChestReset, and a late joiner's chestsOpened no
 * longer lists it) and its next opening rolls fresh contents (the server always rolls at open time). Never earlier:
 * before the threshold this does nothing at all. */
export const REGEN = {
  /** kill switch */
  on: true,
  /** the storm phase (stormAt's `phase`: 1 = the first circle's hold … 9 = the last close) from which looted containers
   * restock. 5 = the hold after the fourth circle closed — the ring ~200/1100 of zone 0 (~200 m), about 10 min into a
   * 15.5 min clock, the phase resurgence is over: the final five circles. (6 was tried: its 120 m ring holds a median of 3
   * containers over 30 seeds, 0 in 3 of them — nothing left to restock; phase 5's ring holds a median of 11.) */
  fromPhase: 5,
  /** share of the opened containers that come back (a seeded coin per container and restock) */
  share: 0.75,
  /** seconds after it was looted before a container may restock (never the moment its opener walks off) */
  delayS: 45,
  /** containers looted before the threshold come back spread over this many seconds after it (not all in one tick) */
  spreadS: 40,
  /** 0 anywhere · 1 inside the current safe circle · 2 inside the next (target) circle — no point restocking the storm */
  zone: 1,
  /** metres inside the circle's edge */
  margin: 6,
  /** restocks per container a match */
  maxPerChest: 1,
  /** ammo boxes restock too (ammo is what runs dry in the final circles) */
  boxes: true,
  /** not while a kong stands within this (m): it never snaps shut under someone */
  clearR: 3.5,
  /** how often the server looks (ticks) */
  everyTicks: 20,
};
const regenCoin = (seed: number, salt: number, id: number, n: number) => hash32(seed ^ salt, id * 31 + n) / 4294967296;
/** one pass of the regen (Match.step, every REGEN.everyTicks in Play): re-closes the containers that are due and returns
 * their ids (the caller sends EV.ChestReset for each). `occupied(c)`: a kong is standing at it. */
export function chestRegen(chests: Chest[], storm: StormState, time: number, seed: number, occupied: (c: Chest) => boolean, R = REGEN): number[] {
  const out: number[] = [];
  if (!R.on || storm.phase < R.fromPhase) return out;
  const zx = R.zone === 2 ? storm.tx : storm.cx, zz = R.zone === 2 ? storm.tz : storm.cz, zr = (R.zone === 2 ? storm.tr : storm.r) - R.margin;
  for (const c of chests) {
    if (!c.opened || (c.box && !R.boxes)) continue;
    const n = c.regens ?? 0; if (n >= R.maxPerChest) continue;
    // decided once per opening: whether it comes back, and when (≥ delayS after its looting; the backlog spread out)
    c.regenAt ??= regenCoin(seed, 0x2e6e, c.id, n) < R.share ? Math.max((c.openedAt ?? 0) + R.delayS, time + regenCoin(seed, 0x2e6f, c.id, n) * R.spreadS) : Infinity;
    if (time < c.regenAt) continue;
    if (R.zone && dmath.pow(c.x - zx, 2) + dmath.pow(c.z - zz, 2) > dmath.pow(Math.max(0, zr), 2)) continue;
    if (occupied(c)) continue;
    c.opened = false; c.regens = n + 1; c.regenAt = undefined; c.openedAt = undefined;
    out.push(c.id);
  }
  return out;
}
