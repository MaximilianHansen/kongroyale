// CLIFF EXITS — a way out of every low ground a kong can slide into by accident: without one, a player trapped below a
// tall slope cannot outrun the storm.
//
// Each exit is a timber switch-free CLIFF STAIR: flights of plank treads on stringers that climb ALONG a cliff / gorge
// wall (hugging it — every flight sits as close to the face as the ground allows), timber landings between the flights,
// rope rails on posts on both sides, struts down to the rock. ONE layout (this file, from the terrain) feeds BOTH the
// server's colliders (shared/sim/static-world.ts → exitColliders) and the drawn stairs (client/src/world/exits) — what
// you see is what you walk on. Sites were chosen by an escape audit of the terrain.
//
// Frame: world metres, +Y up, −Z north. A flight's `u` axis = its climbing direction along the face (horizontal unit),
// `n` = the face's outward normal (horizontal, downhill / seaward). Sim box yaw: box +X → world (cos yaw, 0, sin yaw).
import type { Box } from "./colliders";
import { EXIT_LAYOUTS } from "./exits-layout";
import * as dmath from "../sim/dmath";

/** a terrain the layout reads (shared/world/terrain.ts Terrain satisfies it) */
export interface ExitGround { height(x: number, z: number): number }

/** a hand-picked site: the stair's foot on the low ground, the direction it climbs along the face (±1 = which way along
 *  the face; 0 = try both, keep the better), optional face-normal override (bearing of the outward normal, degrees,
 *  0 = +x, 90 = +z) and how far the low ground is from the rim. */
export interface ExitSite { id: string; x: number; z: number; side: 1 | -1 | 0; normalDeg?: number; note: string;
  /** width override (m), default 1.6 */ w?: number }

export interface ExitFlight {
  /** bottom of the flight: centre of the first tread's front edge (x, z), the ground / landing it starts from (y) */
  x: number; z: number; y: number;
  /** climbing direction (horizontal unit) and the face's outward normal (horizontal unit) */
  ux: number; uz: number; nx: number; nz: number;
  steps: number; rise: number; run: number; w: number;
}
export interface ExitLanding {
  /** centre (x, z), deck top (y); half extents along u (hu) and along n (hn); u / n as the flights */
  x: number; z: number; y: number; hu: number; hn: number; ux: number; uz: number; nx: number; nz: number;
  /** rails: which edges get one: [−u, +u, −n (inner), +n (outer)] as [from, to] spans along that edge in local
   *  coordinates (metres from the centre) — the gaps are where flights / the rim connect */
  rails: Array<{ edge: 0 | 1 | 2 | 3; a: number; b: number }>;
  /** the top landing (it runs into the rim on its inner side) */
  top?: boolean;
}
export interface ExitLayout {
  id: string; ok: boolean; why?: string;
  foot: [number, number, number]; top: [number, number, number];
  /** the site as picked (where the audit found kongs stuck: the stair's foot is the toe of the slope near it) */
  from?: [number, number, number];
  flights: ExitFlight[]; landings: ExitLanding[];
  /** total climb (m) and walking length (m) */
  climb: number; length: number;
}

// ---- tunables
const RISE = 0.25, RUN = 0.37, PER_FLIGHT = 9, LAND = 1.5, W = 1.6, CLR = 0.45, EPS = 0.12;
const RIM_SLOPE = 37;
const MAX_JOG = 3.2;   // a flight may step at most this far in / out from the previous one (a deeper landing = a bulge: pick another site)   // degrees: the lip = the first ground this flat after the steep band

function slopeDeg(t: ExitGround, x: number, z: number) {
  const e = 1, dx = (t.height(x + e, z) - t.height(x - e, z)) / (2 * e), dz = (t.height(x, z + e) - t.height(x, z - e)) / (2 * e);
  return dmath.atan(dmath.hypot(dx, dz)) * 180 / Math.PI;
}

/** the face's outward normal above (x, z): the mean downhill direction of the steep ground within 14 m uphill */
function faceNormal(t: ExitGround, x: number, z: number): [number, number] {
  let gx = 0, gz = 0;
  for (let r = 2; r <= 16; r += 2) for (let a = 0; a < 16; a++) {
    const px = x + dmath.cos(a * Math.PI / 8) * r, pz = z + dmath.sin(a * Math.PI / 8) * r;
    const dx = (t.height(px + 1, pz) - t.height(px - 1, pz)) / 2, dz = (t.height(px, pz + 1) - t.height(px, pz - 1)) / 2;
    const s = dmath.hypot(dx, dz); if (s < 0.7) continue;   // only the steep ground (> 35°)
    gx -= dx / s; gz -= dz / s;
  }
  const l = dmath.hypot(gx, gz) || 1; return [gx / l, gz / l];
}

/** the rim above a site: the first ground ≥ 2 m above it, inland along the face's normal, flatter than RIM_SLOPE for 3 m */
export function rimHeight(site: { x: number; z: number }, t: ExitGround): number {
  const [nx, nz] = faceNormal(t, site.x, site.z), y0 = t.height(site.x, site.z);
  for (let d = -4; d < 140; d += 0.5) {
    const px = site.x - nx * d, pz = site.z - nz * d, h = t.height(px, pz);
    if (h < y0 + 2) continue;
    let flat = true; for (let k = 0; k <= 3 && flat; k++) if (slopeDeg(t, px - nx * k, pz - nz * k) > RIM_SLOPE) flat = false;
    if (flat) return h;
  }
  return NaN;
}

/** build one exit's layout from its site (pure, deterministic) */
export function buildExit(site: ExitSite, t: ExitGround): ExitLayout {
  if (site.side === 0) {
    const a = buildExit({ ...site, side: 1 }, t), b = buildExit({ ...site, side: -1 }, t);
    if (a.ok !== b.ok) return a.ok ? a : b;
    return a.length <= b.length ? a : b;
  }
  const w = site.w ?? W, hw = w / 2;
  const from: [number, number, number] = [site.x, t.height(site.x, site.z), site.z];
  const fixedN = site.normalDeg !== undefined ? [dmath.cos(site.normalDeg * Math.PI / 180), dmath.sin(site.normalDeg * Math.PI / 180)] as [number, number] : null;
  const normalAt = (x: number, z: number) => fixedN ?? faceNormal(t, x, z);
  // the foot stands at the TOE of the slope, on gentle ground the low area walks onto: the site itself when it is ≤ 25°,
  // else the first such spot out from the face (+n) within 15 m
  if (slopeDeg(t, site.x, site.z) > 25) {
    const [qx, qz] = normalAt(site.x, site.z);
    for (let d = 0.5; d <= 15; d += 0.5) { const px = site.x + qx * d, pz = site.z + qz * d; if (slopeDeg(t, px, pz) <= 25) { site = { ...site, x: px, z: pz }; break; } }
  }
  const y0 = t.height(site.x, site.z);
  const fail = (why: string): ExitLayout => ({ id: site.id, ok: false, why, foot: [site.x, y0, site.z], top: [site.x, y0, site.z], flights: [], landings: [], climb: 0, length: 0 });
  /** the lip inland of (x, z) along −n: the first ground ≥ yMin that stays flatter than RIM_SLOPE for 3 m */
  const lip = (x: number, z: number, nx: number, nz: number, yMin: number) => {
    for (let d = -4; d < 140; d += 0.5) {
      const px = x - nx * d, pz = z - nz * d, h = t.height(px, pz);
      if (h < yMin) continue;
      let flat = true; for (let k = 0; k <= 3 && flat; k++) if (slopeDeg(t, px - nx * k, pz - nz * k) > RIM_SLOPE) flat = false;
      if (flat) return h;
    }
    return NaN;
  };
  const n0 = normalAt(site.x, site.z);
  let yR = lip(site.x, site.z, n0[0], n0[1], y0 + 2);
  if (!Number.isFinite(yR)) return fail("no rim within 140 m");
  // the stair tops out ~its own length along the face from the foot: build, read the rim inland of the top, rebuild
  let out: ExitLayout = fail("no attempt");
  for (let it = 0; it < 6; it++) {
    const r = attempt(yR);
    out = r.layout;
    if (!Number.isFinite(r.rimHere) || Math.abs(r.rimHere - yR) < 0.3 || r.rimHere < y0 + 2) break;
    yR = r.rimHere;
  }
  return out;

  function attempt(yTop: number): { layout: ExitLayout; rimHere: number } {
    const climb = yTop - y0, N = Math.max(2, Math.ceil(climb / RISE)), rise = climb / N;
    const flights: ExitFlight[] = [], landings: ExitLanding[] = [];
    let cx = site.x, cz = site.z, yb = y0, done = 0;
    let [nx, nz] = n0; let ux = -nz * site.side, uz = nx * site.side;
    let pnx = nx, pnz = nz, pux = ux, puz = uz;
    const bad = (why: string) => ({ layout: fail(why), rimHere: NaN });
    void bad;
    while (done < N) {
      const k = flights.length;
      if (k) {
        // the face turns: follow its local normal, at most 30° per flight
        const [qx, qz] = normalAt(cx, cz); let vx = -qz * site.side, vz = qx * site.side;
        const dot = vx * pux + vz * puz, crs = pux * vz - puz * vx, ang = dmath.atan2(crs, dot), lim = Math.PI / 6;
        const a = Math.max(-lim, Math.min(lim, ang)), ca = dmath.cos(a), sa = dmath.sin(a);
        vx = pux * ca - puz * sa; vz = pux * sa + puz * ca;
        ux = vx; uz = vz; nx = uz * site.side; nz = -ux * site.side;
      }
      const n = Math.min(PER_FLIGHT, N - done), L = n * RUN, start = k ? LAND : 0;
      const P = (sAl: number, wo: number) => [cx + ux * sAl + nx * wo, cz + uz * sAl + nz * wo] as const;
      const yAt = (q: number) => q < start ? yb : yb + rise * Math.min(n, Math.floor((q - start) / RUN) + 1);
      // (frame of this flight: the previous lane's end corners, for the landing between)
      const cs = [hw * (pnx * ux + pnz * uz), -hw * (pnx * ux + pnz * uz)], cw = [hw * (pnx * nx + pnz * nz), -hw * (pnx * nx + pnz * nz)];
      const clear = (wo: number) => {
        for (let q = 0; q <= start + L + 1e-6; q += 0.5) {
          const qq = Math.min(q, start + L), y = yAt(qq);
          for (const kk of [-hw - CLR, -hw, -hw / 2, 0, hw / 2, hw, hw + 0.25]) { const [x, z] = P(qq, wo + kk); if (t.height(x, z) > y - EPS) return false; }
        }
        if (k) {
          // the way across the landing (the previous lane's end → this flight's foot, a capsule wide): no ground ABOVE the
          // deck on it — the deck itself may tuck into the rock at an inner corner, the kong's path never meets the face
          const dl = dmath.hypot(start, wo), ex = start / (dl || 1), ez = wo / (dl || 1);
          for (let q = 0; q <= dl + 0.4; q += 0.3) for (const off of [-0.45, 0, 0.45]) { const [x, z] = P(ex * q - ez * off, ez * q + ex * off); if (t.height(x, z) > yb + 0.05) return false; }
        }
        return true;
      };
      let best = NaN;
      for (let wo = 25; wo >= -30; wo -= 0.1) { if (clear(wo)) best = wo; else if (Number.isFinite(best)) break; }
      if (!Number.isFinite(best)) return bad(`flight ${k} finds no clear line`);
      // the face recedes faster than the stair climbs (a gentler band / a ledge): stand off it a little rather than a deep
      // landing; a jog OUT (a bulge in the face) means another site
      if (k && best < -MAX_JOG && clear(-MAX_JOG)) best = -MAX_JOG;
      if (k && Math.abs(best) > MAX_JOG) return bad(`flight ${k} jogs ${best.toFixed(1)} m off the line (a bulge in the face)`);
      if (k) {
        // the landing (frame of this flight, origin = the previous flight's end centre): from the previous lane's end to
        // this flight's start, across both lanes
        const sA = Math.min(0, ...cs), wa = Math.min(best - hw, ...cw), wb = Math.max(best + hw, ...cw);
        const [lx, lz] = P((sA + start) / 2, (wa + wb) / 2), wc = (wa + wb) / 2;
        landings.push({ x: lx, z: lz, y: yb, hu: (start - sA) / 2, hn: (wb - wa) / 2, ux, uz, nx, nz,
          rails: [
            ...spanGaps(wa, wb, [[Math.min(...cw), Math.max(...cw)]]).map(([a, b]) => ({ edge: 0 as const, a: a - wc, b: b - wc })),
            ...spanGaps(wa, wb, [[best - hw, best + hw]]).map(([a, b]) => ({ edge: 1 as const, a: a - wc, b: b - wc })),
            { edge: 2, a: -(start - sA) / 2, b: (start - sA) / 2 }, { edge: 3, a: -(start - sA) / 2, b: (start - sA) / 2 },
          ] });
      }
      const [fx, fz] = P(start, best);
      flights.push({ x: fx, z: fz, y: yb, ux, uz, nx, nz, steps: n, rise, run: RUN, w });
      cx = fx + ux * L; cz = fz + uz * L; yb += n * rise; done += n;
      pnx = nx; pnz = nz; pux = ux; puz = uz;
    }
    // the top landing: beyond the last flight's end, a deck that runs inland onto the rim (until the ground meets it)
    const P = (sAl: number, wo: number) => [cx + ux * sAl + nx * wo, cz + uz * sAl + nz * wo] as const;
    let wIn = NaN;
    for (let d = 0; d < 25; d += 0.1) { const [x, z] = P(LAND / 2, -hw - d); if (t.height(x, z) >= yb - 0.05) { wIn = -hw - d - 0.3; break; } }
    const [ex, ez] = P(LAND / 2, -hw);
    const rimHere = lip(ex, ez, nx, nz, yb - 6);
    if (!Number.isFinite(wIn)) return { layout: fail("top landing never meets the rim"), rimHere };
    const wOut = hw, wc = (wIn + wOut) / 2, [lx, lz] = P(LAND / 2, wc);
    landings.push({ x: lx, z: lz, y: yb, hu: LAND / 2, hn: (wOut - wIn) / 2, ux, uz, nx, nz, top: true,
      rails: [
        ...spanGaps(wIn, wOut, [[-hw, hw]]).map(([a, b]) => ({ edge: 0 as const, a: a - wc, b: b - wc })),
        { edge: 1, a: wIn - wc, b: wOut - wc }, { edge: 3, a: -LAND / 2, b: LAND / 2 },
      ] });
    // the ground just inland of the top must be walkable (or the stair tops out under a slide)
    { const [x, z] = P(LAND / 2, wIn - 1.2); if (slopeDeg(t, x, z) > 42) return { layout: fail("rim behind the top landing is a slide slope"), rimHere }; }
    const [tx, tz] = P(LAND / 2, wIn - 0.8);
    const len = flights.reduce((a, f) => a + dmath.hypot(f.steps * f.run, f.steps * f.rise), 0) + landings.reduce((a, l) => a + 2 * l.hu, 0) + (wOut - wIn);
    return { layout: { id: site.id, ok: true, foot: [site.x, y0, site.z], top: [tx, yb, tz], from, flights, landings, climb, length: len }, rimHere };
  }
}

/** [a, b] minus the gap intervals → the remaining spans (each ≥ 0.2 m) */
function spanGaps(a: number, b: number, gaps: Array<[number, number]>): Array<[number, number]> {
  let spans: Array<[number, number]> = [[a, b]];
  for (const [g0, g1] of gaps) spans = spans.flatMap(([p, q]): Array<[number, number]> => (g1 <= p || g0 >= q ? [[p, q] as [number, number]] : [[p, g0], [g1, q]] as Array<[number, number]>).filter(([x, y]) => y - x >= 0.2));
  return spans;
}

const yawOf = (dx: number, dz: number) => dmath.atan2(dz, dx);   // sim box yaw whose +X points along (dx, dz)

/** colliders of one exit: one thin box per tread, one per landing deck, rail boxes (per tread, both sides; per landing
 *  edge span) — the sim has no pitched boxes, so every rail is a staircase of short boxes like the treads */
export function exitBoxes(L: ExitLayout): Box[] {
  const out: Box[] = [];
  if (!L.ok) return out;
  for (const f of L.flights) {
    const yaw = yawOf(f.ux, f.uz), hw = f.w / 2;
    for (let i = 0; i < f.steps; i++) {
      const top = f.y + f.rise * (i + 1), d = f.run * (i + 0.5);
      const cx = f.x + f.ux * d, cz = f.z + f.uz * d;
      out.push({ c: [cx, top - 0.15, cz], h: [f.run / 2 + 0.01, 0.15, hw], yaw, surf: "wood" });
      // (each rail piece reaches DOWN to the tread's underside: a piece starting at its tread's top would sit 0.25 m above the
      // tread below and the solver's step-up headroom test would read it as a ceiling — a kong hugging the rail froze)
      // (no rail on a flight's first tread: the way onto the flight from its landing is the lane's full width, no post end to
      // snag a kong coming off the landing at an angle)
      if (i > 0) for (const sd of [-1, 1]) out.push({ c: [cx + f.nx * sd * (hw - 0.05), top + 0.4, cz + f.nz * sd * (hw - 0.05)], h: [f.run / 2 + 0.01, 0.7, 0.05], yaw, surf: "wood", noShoot: true });
    }
  }
  for (const l of L.landings) {
    const yaw = yawOf(l.ux, l.uz);
    out.push({ c: [l.x, l.y - 0.15, l.z], h: [l.hu, 0.15, l.hn], yaw, surf: "wood" });
    for (const r of l.rails) {
      const m = (r.a + r.b) / 2, half = (r.b - r.a) / 2;
      if (r.edge <= 1) { const su = (r.edge === 0 ? -1 : 1) * (l.hu - 0.05); out.push({ c: [l.x + l.ux * su + l.nx * m, l.y + 0.55, l.z + l.uz * su + l.nz * m], h: [0.05, 0.55, half], yaw, surf: "wood", noShoot: true }); }
      else { const sn = (r.edge === 2 ? -1 : 1) * (l.hn - 0.05); out.push({ c: [l.x + l.nx * sn + l.ux * m, l.y + 0.55, l.z + l.nz * sn + l.uz * m], h: [half, 0.55, 0.05], yaw, surf: "wood", noShoot: true }); }
    }
  }
  return out;
}

// ---- the sites (proposed by the escape audit, tuned by hand)
export const EXIT_SITES: ExitSite[] = [
  // the W coast: the beach under the Coco Caves headland cliffs and the beach N of The Wreck
  { id: "coco-caves-beach", x: -889.5, z: -187.5, side: 1, note: "W coast beach below Coco Caves: 15 m sandstone cliff" },
  { id: "wreck-beach", x: -848.5, z: -127.5, side: 1, note: "W coast beach N of The Wreck: 20 m cliff" },
  // the NW coast (the volcano's sea foot): the cove under the 24 m cliff
  { id: "nw-cove-high", x: -763.5, z: -679.5, side: -1, note: "NW cove: 24 m cliff up to the volcano's sea plateau" },
  // the N coast beach under the 35-40 m cliffs N of Ripe Peak (≈ 500 m of beach: two stairs climbing away from each other)
  { id: "n-coast-west", x: -377.5, z: -878.5, side: -1, note: "N coast beach: 37 m cliff, climbs west" },
  { id: "n-coast-mid", x: -334.5, z: -858.5, side: 1, note: "N coast beach: 36 m cliff, climbs east toward Wreck Bay" },
  // the SW Lookout Point peninsula: the beach ring under its 38-41 m cliffs (three stairs)
  { id: "lookout-west", x: -664.5, z: 567.5, side: -1, note: "Lookout Point W beach: 41 m cliff" },
  { id: "lookout-south", x: -640.5, z: 722.5, side: 1, note: "Lookout Point S beach: 38 m cliff" },
  { id: "lookout-east", x: -554.5, z: 660.5, side: 1, note: "Lookout Point SE beach: 39 m cliff" },
  // the S coast peninsula below Peel Harbor's SW bluff
  { id: "harbor-south-west", x: 341.5, z: 646.5, side: -1, note: "S coast beach below the harbor bluff: 30 m cliff" },
  // the river valley below CNVS Lab: its south bank under the 25 m north wall
  { id: "lab-river", x: 51.5, z: -419.5, side: -1, note: "river bank below CNVS Lab: 25 m valley wall" },
];

/** the BAKED layouts (shared/world/exits-layout.ts, written by an offline bake from EXIT_SITES against the
 *  full static world — rocks, trunks and POI boxes are obstacles the stairs route around — and checked there with the
 *  real mover). Baked numbers, not a runtime solve, so the server and every client build bit-identical colliders. */
export function exitLayouts(_t?: ExitGround): ExitLayout[] { return EXIT_OPTS.off ? [] : EXIT_LAYOUTS; }
/** tools only: build a world WITHOUT the exits (the bake measures the ground the stairs must avoid) */
export const EXIT_OPTS = { off: false };
/** every exit's colliders, in layout order — shared/sim/static-world.ts adds them to the static world (server + client) */
export function exitColliders(_t?: ExitGround): Box[] {
  return exitLayouts().flatMap(exitBoxes);
}
