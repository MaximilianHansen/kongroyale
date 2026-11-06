// The storm: a DESIGNED random storm. `planStorm` picks the whole match at start (every circle + the phase clock) from
// the seed; `stormAt(plan, t)` is stateless, so the client draws the identical ring the server damages with, and
// rewinds never disagree. The plan travels in the match JSON.
//
// Phase table (PHASE_REF, a genre-typical phase table scaled to our island): radii are ratios of the zone-0 ring, which
// is derived from the island (it circumscribes the land around its centroid); wait / shrink come from PHASE_REF and are
// stretched per seed, phase by phase, until a player at the WORST land point of the current circle who sprints when
// the next circle is shown (swimming the water on the way) arrives with ≥ 20 % of the time left.
//
// Circles (built BACKWARDS): the final point is picked first — a region (a named POI or a wilderness cell; coastal
// regions at half weight) → a flat, dry, open, walkable spot there whose final circles are all land — then each earlier
// centre is a random point within (r_i − r_i+1) of the next one, weighted to land, kept inside the reachable disc of
// the zone-1 rule (zone-1 centre ≤ 300 m from the land centroid).
import { SPRINT, PLAYER_H, PLAYER_R } from "./const";
/** the storm planner plans with a 3.2 m/s swim: the faster swim (const SWIM) is a buff for swimmers, not a
 * reason for the planner to shorten every hold */
const SWIM_PLAN = 3.2;
import type { Terrain } from "../world/terrain";
import type { StaticWorld } from "./world";
import { POIS } from "../world/map";
import { Rng } from "./rng";
import * as dmath from "./dmath";

export interface StormPlan {
  cx: number[]; cz: number[]; r: number[];
  /** phase start times (s since the plane doors open): at[0] = the first circle shown, at[i] = phase i done */
  at: number[];
  /** per phase (index 0 = phase 1): holding time, shrinking time, damage per second, resurgence still on */
  wait: number[]; close: number[]; dps: number[]; res: boolean[];
  /** where the final circle landed (a POI id or "wild:<cell>") — tools / the map read it */
  region: string;
}
export interface StormState { cx: number; cz: number; r: number; tx: number; tz: number; tr: number; phase: number; shrinking: boolean; timer: number; dps: number; resurgence: boolean; done: boolean }

/** first circle shown this long after the doors open (plane bay 34 s + a ~25 s drop: most players have landed) */
export const STORM_T0 = 60;
/** the base phase table (for a zone-0 ring of 1100 m): end radius ratio, wait, shrink, damage / s, resurgence.
 * Damage ramps zone by zone: the first two zones are a nudge (1 HP/s, 100 s to drain a full bar, a leaf bundle
 * out-heals it), then ×≈1.4 a zone — 2 · 3 · 5 · 7 · 10 · 14 · 20 — so the last circles kill (zone 8: 7 s, zone 9: 5 s;
 * faster than a leaf bundle heals, 12.5 HP/s).
 * The storm hits HEALTH only (shield never soaks it) and lands as one tick a second (STORM_TICK_S). */
export const PHASE_REF: ReadonlyArray<{ ratio: number; wait: number; close: number; dps: number; res: boolean }> = [
  { ratio: 700 / 1100, wait: 80, close: 75, dps: 1, res: true },
  { ratio: 470 / 1100, wait: 55, close: 70, dps: 1, res: true },
  { ratio: 310 / 1100, wait: 50, close: 65, dps: 2, res: true },
  { ratio: 200 / 1100, wait: 45, close: 60, dps: 3, res: true },
  { ratio: 120 / 1100, wait: 40, close: 55, dps: 5, res: false },
  { ratio: 65 / 1100, wait: 35, close: 50, dps: 7, res: false },
  { ratio: 35 / 1100, wait: 30, close: 45, dps: 10, res: false },
  { ratio: 15 / 1100, wait: 20, close: 40, dps: 14, res: false },
  { ratio: 0, wait: 10, close: 45, dps: 20, res: false },
];
/** the storm bites once a second, on the match clock, for the zone's whole damage/s — the HP number
 * drops by 1 · 2 · 3 … 20 in one visible tick (with the client's storm-hit sound + shake, render.ts ~1/s), instead of
 * draining 1 HP at a time ever faster. Global, not per kong: stepping in and out of the wall can't dodge it. */
export const STORM_TICK_S = 1;
/** the storm clock (first circle shown → last circle closed) is shaved back to this when stretched: 14:40 + T0 = 15:40 */
export const CLOCK_MAX = 880;
/** share of a circle that is walkable land (not sea, not a > 45° cliff), sampled on a sunflower of 64 points */
export function walkShare(terrain: Terrain, x: number, z: number, r: number): number {
  let ok = 0;
  for (let k = 0; k < 64; k++) { const a = k * 2.39996, d = Math.sqrt((k + 0.5) / 64) * r; const px = x + dmath.cos(a) * d, pz = z + dmath.sin(a) * d; if (terrain.height(px, pz) >= 0.8 && terrain.normal(px, pz)[1] >= 0.707) ok++; }
  return ok / 64;
}
/** the promise the planner keeps (the target is ≥ 15 %; the planner keeps 22 % so a finer check still passes) */
export const RUN_MARGIN = 0.22;
/** detour factor of a run over land (paths bend round rocks, buildings, ridges) */
export const LAND_DETOUR = 1.3;

export const makeStormState = (): StormState => ({ cx: 0, cz: 0, r: 1100, tx: 0, tz: 0, tr: 1100, phase: 0, shrinking: false, timer: STORM_T0, dps: 0, resurgence: true, done: false });

// ---------------------------------------------------------------------------------------------------- the island
export interface Island { cx: number; cz: number; far: number; R0: number; regions: Array<{ id: string; x: number; z: number; r: number; w: number }> }
const ISLANDS = new WeakMap<Terrain, Island>();
const LOBBY = "lobby-islet";
/** land centroid, farthest land point, zone-0 ring and the final-circle regions (named POIs + 300 m wilderness cells) */
export function islandOf(terrain: Terrain): Island {
  const got = ISLANDS.get(terrain); if (got) return got;
  const half = terrain.half, N = 96, step = (2 * half) / N;
  const lobby = POIS.find((p) => p.id === LOBBY)!;
  const land: Array<[number, number]> = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const x = -half + (i + 0.5) * step, z = -half + (j + 0.5) * step;
    if (dmath.hypot(x - lobby.x, z - lobby.z) < lobby.r + 60) continue;
    if (terrain.height(x, z) > 0.5) land.push([x, z]);
  }
  let cx = 0, cz = 0; for (const [x, z] of land) { cx += x; cz += z; } cx /= land.length; cz /= land.length;
  let far = 0; for (const [x, z] of land) far = Math.max(far, dmath.hypot(x - cx, z - cz));
  const R0 = Math.round(far * 1.07);
  // regions: every named POI + wilderness cells (300 m) with enough land that no POI covers
  const regions: Island["regions"] = [];
  for (const p of POIS) if (p.id !== LOBBY) regions.push({ id: p.id, x: p.x, z: p.z, r: p.r, w: 1 });
  const C = 300;
  for (let gx = -half; gx < half; gx += C) for (let gz = -half; gz < half; gz += C) {
    const mx = gx + C / 2, mz = gz + C / 2;
    let n = 0; for (const [x, z] of land) if (x >= gx && x < gx + C && z >= gz && z < gz + C && !POIS.some((p) => dmath.hypot(p.x - x, p.z - z) < p.r)) n++;
    if (n * step * step < 0.25 * C * C) continue;
    regions.push({ id: `wild:${Math.round(mx)},${Math.round(mz)}`, x: mx, z: mz, r: C * 0.5, w: 1 });
  }
  // fewer edge circles: regions whose centre is in the outer 25 % of the island count half
  for (const g of regions) if (dmath.hypot(g.x - cx, g.z - cz) > far * 0.75) g.w = 0.5;
  const isl = { cx, cz, far, R0, regions };
  ISLANDS.set(terrain, isl);
  return isl;
}

// ---------------------------------------------------------------------------------------------------- run time
let STEP_M = 8;
/** tools: the sampling step of runTime (m) — a checker can sample the planner at a finer step */
export const setRunStep = (m: number) => { STEP_M = m; };
/** seconds to sprint (swim on water) from (x, z) in a straight line until inside the circle (tx, tz, tr) by 2 m */
export function runTime(terrain: Terrain, x: number, z: number, tx: number, tz: number, tr: number): number {
  const d = dmath.hypot(tx - x, tz - z), need = d - Math.max(0, tr - 2);
  if (need <= 0) return 0;
  const ux = (tx - x) / d, uz = (tz - z) / d;
  let t = 0, h0 = terrain.height(x, z);
  for (let s = 0; s < need; s += STEP_M) {
    const seg = Math.min(STEP_M, need - s), ex = x + ux * (s + seg), ez = z + uz * (s + seg), h1 = terrain.height(ex, ez);
    const mid = terrain.height(x + ux * (s + seg / 2), z + uz * (s + seg / 2));
    if (mid <= -0.6) t += seg / SWIM_PLAN;                           // deep enough to swim
    else {
      // uphill steeper than 35° is walked at half speed, steeper than 45° is a cliff to go round (×3)
      const up = (Math.max(0, h1, 0) - Math.max(0, h0)) / seg;
      const slow = up > 1.0 ? 3 : up > 0.7 ? 2 : 1;
      t += seg * LAND_DETOUR * slow / SPRINT;
    }
    h0 = h1;
  }
  return t;
}
/** the worst run from a land point of circle (cx, cz, r) into circle (tx, tz, tr): sampled on rings + the rim */
export function worstRun(terrain: Terrain, cx: number, cz: number, r: number, tx: number, tz: number, tr: number, rings = 4, per = 24): number {
  let worst = 0;
  // the worst point is on the far rim in the direction away from the new centre — sample densely there, coarse elsewhere
  const away = dmath.atan2(cz - tz, cx - tx);
  for (let k = 1; k <= rings; k++) {
    const rr = r * k / rings, n = Math.max(6, Math.round(per * k / rings));
    for (let a = 0; a < n; a++) {
      const ang = k === rings ? away + ((a / n) - 0.5) * Math.PI * 1.6 : (a / n) * Math.PI * 2;
      const x = cx + dmath.cos(ang) * rr, z = cz + dmath.sin(ang) * rr;
      if (terrain.height(x, z) <= 0.3) continue;              // nobody stands in the sea
      worst = Math.max(worst, runTime(terrain, x, z, tx, tz, tr));
    }
  }
  return worst;
}

// ---------------------------------------------------------------------------------------------------- final spot
/** a place the fight can end: dry, flat (< 30°), not under a roof or inside a building, and its last circles on land */
export function finalOk(terrain: Terrain, world: StaticWorld | null, x: number, z: number, r: number): boolean {
  const y = terrain.height(x, z);
  if (y < 2 || terrain.normal(x, z)[1] < 0.866) return false;
  let bad = 0;
  for (let k = 0; k < 16; k++) {
    const a = k / 16 * Math.PI * 2;
    for (const f of [0.5, 1]) {
      const px = x + dmath.cos(a) * r * f, pz = z + dmath.sin(a) * r * f;
      if (terrain.height(px, pz) < 0.8 || terrain.normal(px, pz)[1] < 0.707) bad++;       // sea or cliff (> 45°)
    }
  }
  if (bad > 2 || walkShare(terrain, x, z, r) < 0.94) return false;   // ≥ 90 % of the last circle is walkable land
  if (world) {
    world.velY = 0; world.headBump = false;
    world.resolveCapsule(x, y + 0.02, z, PLAYER_R, PLAYER_H, false);
    if (dmath.hypot(world.P[0] - x, world.P[2] - z) > 0.3 || world.P[1] - y > 1.5) return false;   // inside a box / on a rock stack
    if (!world.clear(x, world.P[1] + 1.6, z, x, world.P[1] + 40, z)) return false;              // under a roof / canopy
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------- the plan
export function planStorm(seed: number, terrain: Terrain, world: StaticWorld | null = null): StormPlan {
  const rng = new Rng(seed ^ 0x5707);
  const isl = islandOf(terrain);
  const n = PHASE_REF.length, R0 = isl.R0;
  const r = [R0, ...PHASE_REF.map((p) => Math.round(p.ratio * R0))];
  const c0: [number, number] = [isl.cx, isl.cz];
  const reach1 = Math.min(300, R0 - r[1]);                        // zone-1 centre ≤ 300 m from the land centroid
  // feasible disc of centre i (so the chain can still reach zone 1): |c_i − c0| ≤ reach1 + r1 − r_i
  const feas = (i: number) => reach1 + r[1] - r[i];

  const cx = new Array<number>(n + 1), cz = new Array<number>(n + 1);
  cx[0] = c0[0]; cz[0] = c0[1];
  let region = "centre";
  // one backward step: centre i within (r_i − r_i+1) of centre i+1, inside its feasible disc, land-weighted; the last
  // three circles must be ≥ 95 % walkable land (false = no such centre was found)
  const step = (i: number): boolean => {
    const span = r[i] - r[i + 1], F = feas(i), last = i >= n - 3;
    let bx = NaN, bz = NaN, best = -1e9;
    for (let k = 0, K = last ? 48 : 28; k < K; k++) {
      const a = rng.next() * Math.PI * 2, d = k === 0 && last ? 0 : Math.sqrt(rng.next()) * span;
      const x = cx[i + 1] + dmath.cos(a) * d, z = cz[i + 1] + dmath.sin(a) * d;
      if (dmath.hypot(x - c0[0], z - c0[1]) > F) continue;
      if (last && walkShare(terrain, x, z, r[i]) < 0.95) continue;
      // land share of the circle (centre + two rings)
      let land = terrain.height(x, z) > 0.8 ? 2 : 0;
      for (let s2 = 0; s2 < 12; s2++) { const aa = s2 / 12 * Math.PI * 2; for (const f of [0.45, 0.85]) if (terrain.height(x + dmath.cos(aa) * r[i] * f, z + dmath.sin(aa) * r[i] * f) > 0.8) land++; }
      const share = land / 26;
      const score = (share >= 0.6 ? 1 : 0) + share + rng.next() * 0.35;
      if (score > best) { best = score; bx = x; bz = z; }
    }
    if (bx !== bx) {
      if (last) return false;
      const dx = c0[0] - cx[i + 1], dz = c0[1] - cz[i + 1], dl = dmath.hypot(dx, dz) || 1, st = Math.min(span, dl);   // step toward zone 0
      bx = cx[i + 1] + dx / dl * st; bz = cz[i + 1] + dz / dl * st;
    }
    cx[i] = bx; cz[i] = bz;
    return true;
  };
  // 1. the final point: a region by weight → a good spot in it → its last three circles; retried until they all hold
  let ok = false;
  for (let tries = 0; tries < 60 && !ok; tries++) {
    let tot = 0; for (const g of isl.regions) tot += g.w;
    let pick = rng.next() * tot, g = isl.regions[0];
    for (const q of isl.regions) { pick -= q.w; if (pick <= 0) { g = q; break; } }
    for (let k = 0; k < 24 && !ok; k++) {
      const a = rng.next() * Math.PI * 2, d = Math.sqrt(rng.next()) * g.r * 0.85;
      const x = g.x + dmath.cos(a) * d, z = g.z + dmath.sin(a) * d;
      if (dmath.hypot(x - c0[0], z - c0[1]) > feas(n)) continue;
      if (!finalOk(terrain, world, x, z, r[n - 1])) continue;
      cx[n] = x; cz[n] = z; region = g.id;
      ok = step(n - 1) && step(n - 2) && step(n - 3);
    }
  }
  if (!ok) { cx[n] = c0[0]; cz[n] = c0[1]; region = "centre"; for (let i = n - 1; i >= n - 3; i--) { cx[i] = c0[0]; cz[i] = c0[1]; } }
  // 2. backwards to zone 1
  for (let i = n - 4; i >= 1; i--) step(i);

  // 3. the clock: the PHASE_REF times, each phase stretched until its worst run keeps the margin; a stretched match
  // gives the time back from phases with slack (never below their need, never below 60 % of the PHASE_REF hold)
  const wait: number[] = [], close: number[] = [], dps: number[] = [], res: boolean[] = [], at: number[] = [STORM_T0];
  const need: number[] = [];
  for (let i = 0; i < n; i++) {
    const ph = PHASE_REF[i];
    let w = ph.wait, c = ph.close;
    const nd = worstRun(terrain, cx[i], cz[i], r[i], cx[i + 1], cz[i + 1], r[i + 1], i < 3 ? 10 : 6, i < 3 ? 72 : 40) / (1 - RUN_MARGIN);
    need.push(nd);
    if (w + c < nd) { const extra = Math.ceil(nd - (w + c)); w += Math.ceil(extra * 0.6); c += extra - Math.ceil(extra * 0.6); }
    wait.push(w); close.push(c); dps.push(ph.dps); res.push(ph.res);
  }
  let total = wait.reduce((a, b) => a + b, 0) + close.reduce((a, b) => a + b, 0);
  for (let guard = 0; guard < 200 && total > CLOCK_MAX; guard++) {
    let bi = -1, bs = 0;
    for (let i = 0; i < n; i++) { const slack = wait[i] + close[i] - need[i]; if (slack > bs && wait[i] > PHASE_REF[i].wait * 0.6) { bs = slack; bi = i; } }
    if (bi < 0 || bs < 1) break;
    const cut = Math.min(Math.floor(bs), wait[bi] - Math.ceil(PHASE_REF[bi].wait * 0.6), Math.ceil(total - CLOCK_MAX));
    if (cut <= 0) break;
    wait[bi] -= cut; total -= cut;
  }
  let t = STORM_T0;
  for (let i = 0; i < n; i++) {
    const w = wait[i], c = close[i];
    // (a runner who arrives before the wall's end time is never caught on the way: the wall starts later, at the rim, and
    // both move linearly — so the time budget alone is the rule)
    t += w + c; at.push(t);
  }
  return { cx: cx.map((v) => +v.toFixed(2)), cz: cz.map((v) => +v.toFixed(2)), r, at, wait, close, dps, res, region };
}

export function stormAt(plan: StormPlan, t: number, out: StormState): StormState {
  const T0 = plan.at[0], n = plan.wait.length;
  if (t < T0) {
    out.cx = out.tx = plan.cx[0]; out.cz = out.tz = plan.cz[0]; out.r = out.tr = plan.r[0]; out.phase = 0; out.shrinking = false; out.timer = T0 - t; out.dps = 0; out.resurgence = true; out.done = false;
    return out;
  }
  let acc = T0;
  for (let i = 0; i < n; i++) {
    const waitEnd = acc + plan.wait[i], closeEnd = waitEnd + plan.close[i];
    out.tx = plan.cx[i + 1]; out.tz = plan.cz[i + 1]; out.tr = plan.r[i + 1];
    out.phase = i + 1; out.dps = plan.dps[i]; out.resurgence = plan.res[i]; out.done = false;
    if (t < waitEnd) {
      out.cx = plan.cx[i]; out.cz = plan.cz[i]; out.r = plan.r[i]; out.shrinking = false; out.timer = waitEnd - t;
      return out;
    }
    if (t < closeEnd) {
      const f = (t - waitEnd) / plan.close[i], e = f * f * (3 - 2 * f);
      out.cx = plan.cx[i] + (plan.cx[i + 1] - plan.cx[i]) * e; out.cz = plan.cz[i] + (plan.cz[i + 1] - plan.cz[i]) * e; out.r = plan.r[i] + (plan.r[i + 1] - plan.r[i]) * e;
      out.shrinking = true; out.timer = closeEnd - t;
      return out;
    }
    acc = closeEnd;
  }
  out.cx = out.tx = plan.cx[n]; out.cz = out.tz = plan.cz[n]; out.r = out.tr = 0; out.phase = n; out.shrinking = false; out.timer = 0; out.dps = plan.dps[n - 1]; out.resurgence = false; out.done = true;
  return out;
}
/** the length of the current stage (hold or shrink) — the HUD's timer bar */
export function stageLength(plan: StormPlan, s: StormState): number {
  if (s.phase <= 0) return plan.at[0];
  const i = s.phase - 1;
  return s.shrinking ? plan.close[i] : plan.wait[i];
}

export const inStorm = (s: StormState, x: number, z: number) => dmath.hypot(x - s.cx, z - s.cz) > s.r;
