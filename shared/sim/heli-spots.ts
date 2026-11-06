// WHERE THE HELICOPTERS WAIT. Every match has one on PEEL STRIP's apron and one or two more picked by the match seed
// from a pool of helipads round the island — the lab's hill, the harbour's yard, the lookout's clifftop, the market
// square, the temple's court, the cove's beach, the plantation's fields — far enough apart that a squad flies for one,
// not past three: two or three on the island, never in the same places every match. Each pad is an anchor (metres
// east / south of its POI's centre; the strip's in its own frame); the pad lands on the nearest
// level, open spot (shared/sim/heli.ts findHelipad: the rotor's reach clear all round, the open sky over it, ≥ 14 m from
// every taxi rank), so a POI whose layout moves keeps its pad. One more stands on the warm-up islet and one at the firing
// range. Built once per world, picked per seed (like the taxis: shared/sim/tuk-spots.ts fleetSpots); the client paints a
// pad decal on this match's spots (client/src/actors/helipad.ts).
import { POIS, type PoiId } from "../world/map";
import * as islet from "../pois/lobby-islet";
import { sw } from "../pois/peel-strip";
import { RANGE_LINE_X, RANGE_YAW_DOWNRANGE } from "./range";
import { findHelipad } from "./heli";
import { VKind } from "./vehicle";
import type { StaticWorld } from "./world";
import { allRanks, type TukSpot } from "./tuk-spots";
import * as dmath from "./dmath";

/** Peel Strip's pad: the concrete apron at the runway's threshold (strip-local metres along / right of the runway), the
 * nose down the runway */
export const STRIP_PAD: readonly [number, number] = [-10.5, 0];
/** the pool the other one or two come from: [POI, metres east, metres south, heading hint (rad)] */
export const HELIPADS: ReadonlyArray<readonly [PoiId, number, number, number]> = [
  ["cnvs-lab", -40, 30, 2.4],
  ["peel-harbor", 60, -90, -0.8],
  ["lookout-point", -20, 10, 1.2],
  ["mango-market", 0, 0, 0.4],
  ["banana-temple", 0, 0, 0.8],
  ["coconut-cove", 0, 0, 0],
  ["the-plantation", -40, 30, 0.4],
];
/** helicopters per match besides the strip's: one or two (the seed); and how far apart any two pads of a match are (m) */
export const HELI_EXTRA: readonly [number, number] = [1, 2];
export const HELI_SPREAD = 420;

const CACHE = new WeakMap<StaticWorld, { strip: TukSpot | null; pool: TukSpot[]; islet: TukSpot[]; range: TukSpot[] }>();
const OUT = new Float64Array(3);
function build(world: StaticWorld) {
  let c = CACHE.get(world);
  if (c) return c;
  // (a pad keeps 14 m from every taxi rank — any of them may hold a tuk-tuk this match — and from the other pads)
  const taken: Array<[number, number]> = allRanks(world).map((r) => [r.x, r.z]);
  const pad = (x: number, z: number, hint: number, poi: number, reach: number, into: TukSpot[]) => {
    if (!findHelipad(world, x, z, reach, hint, OUT, taken)) return;
    into.push({ x: OUT[0], z: OUT[1], yaw: OUT[2], poi, kind: VKind.Heli }); taken.push([OUT[0], OUT[1]]);
  };
  c = { strip: null, pool: [], islet: [], range: [] };
  const ps = POIS.findIndex((p) => p.id === "peel-strip");
  {
    const [x, , z] = sw(STRIP_PAD[0], STRIP_PAD[1]), [x1, , z1] = sw(STRIP_PAD[0] + 1, STRIP_PAD[1]);
    const into: TukSpot[] = []; pad(x, z, dmath.atan2(-(x1 - x), -(z1 - z)), ps, 14, into); c.strip = into[0] ?? null;
  }
  for (const [id, dx, dz, hint] of HELIPADS) { const i = POIS.findIndex((p) => p.id === id), P = POIS[i]; pad(P.x + dx, P.z + dz, hint, i, 90, c.pool); }
  const li = POIS.findIndex((p) => p.id === "lobby-islet");
  { const [x, z] = islet.toWorld(0, 46); pad(x, z, islet.worldYaw(Math.PI), li, 30, c.islet); }
  { const [x, , z] = sw(RANGE_LINE_X - 14, 34); pad(x, z, RANGE_YAW_DOWNRANGE, ps, 40, c.range); }
  CACHE.set(world, c);
  return c;
}
/** this match's helipads: Peel Strip's, then one or two from the pool picked by the seed, each ≥ HELI_SPREAD m from the
 * others (deterministic: the server parks them, every client paints the same ones from the same seed) */
export function heliPads(world: StaticWorld, seed: number): TukSpot[] {
  const c = build(world), out: TukSpot[] = c.strip ? [c.strip] : [];
  let h = (seed ^ 0x2545f491) >>> 0;
  const rnd = () => { h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d); h = Math.imul(h ^ (h >>> 12), 0x297a2d39); h ^= h >>> 15; return (h >>> 0) / 4294967296; };
  const want = HELI_EXTRA[0] + Math.floor(rnd() * (HELI_EXTRA[1] - HELI_EXTRA[0] + 1));
  const left = c.pool.slice();
  for (let n = 0; n < want && left.length; ) {
    const s = left.splice(Math.floor(rnd() * left.length), 1)[0];
    if (out.some((q) => dmath.hypot(q.x - s.x, q.z - s.z) < HELI_SPREAD)) continue;
    out.push(s); n++;
  }
  return out;
}
/** every pad a match may use (tools) */
export const allHelipads = (world: StaticWorld): TukSpot[] => { const c = build(world); return c.strip ? [c.strip, ...c.pool] : c.pool.slice(); };
export const heliIslet = (world: StaticWorld): TukSpot[] => build(world).islet;
export const heliRange = (world: StaticWorld): TukSpot[] => build(world).range;
