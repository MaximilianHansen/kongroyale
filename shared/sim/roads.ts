// PAVED GROUND THE TERRAIN DOES NOT KNOW ABOUT. The airstrip's runway and aprons, the town's streets and squares and
// the plantation's farm roads are drawn by their POIs over grass / farmland terrain; the terrain's biome map calls them
// grass. For wheels they are road — grip, top speed, the dust they raise, where a taxi rank parks — so the static world
// carries one byte per terrain sample: 0 = whatever the terrain says, else the Biome it drives like (Paved / Path).
// Built once per world from the POIs' own layout data (server and client: same code, same bytes).
import { Biome } from "../world/map";
import type { Terrain } from "../world/terrain";
import { toWorld } from "../pois/coast-kit";
import { APRON, HGR, RWY, STRIP, TAXI } from "../pois/peel-strip";
import { PLACES, STREETS } from "../pois/mango-market";
import { ROADS } from "../pois/the-plantation";
import * as dmath from "./dmath";

type P2 = readonly [number, number];
export function buildRoads(t: Terrain): Uint8Array {
  const r = t.res, g = new Uint8Array(r * r), cell = t.cell, half = t.half;
  const col = (x: number) => Math.min(r - 1, Math.max(0, Math.round((x + half) / cell)));
  /** every sample inside `poly` (world x, z) */
  const fill = (poly: ReadonlyArray<P2>, b: Biome) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of poly) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
    for (let i = col(z0); i <= col(z1); i++) for (let j = col(x0); j <= col(x1); j++) {
      const x = t.sampleX(j), z = t.sampleZ(i);
      let inside = false;
      for (let a = 0, c = poly.length - 1; a < poly.length; c = a++) {
        const [ax, az] = poly[a], [cx, cz] = poly[c];
        if ((az > z) !== (cz > z) && x < ((cx - ax) * (z - az)) / (cz - az) + ax) inside = !inside;
      }
      if (inside) g[i * r + j] = b;
    }
  };
  /** every sample within `hw` of the polyline */
  const stroke = (pts: ReadonlyArray<P2>, hw: number, b: Biome) => {
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, az] = pts[k], [bx, bz] = pts[k + 1], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      for (let i = col(Math.min(az, bz) - hw); i <= col(Math.max(az, bz) + hw); i++) for (let j = col(Math.min(ax, bx) - hw); j <= col(Math.max(ax, bx) + hw); j++) {
        const x = t.sampleX(j), z = t.sampleZ(i), u = Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2));
        if (dmath.pow(x - ax - dx * u, 2) + dmath.pow(z - az - dz * u, 2) <= hw * hw) g[i * r + j] = b;
      }
    }
  };
  const rect = (f: typeof STRIP, x0: number, x1: number, z0: number, z1: number): P2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => { const p = toWorld(f, x, 0, z); return [p[0], p[2]] as const; });
  // the airstrip: the runway, the threshold apron, the taxiway out of the hangar
  fill(rect(STRIP, 0, RWY.len, -RWY.half, RWY.half), Biome.Paved);
  fill(rect(STRIP, APRON.x0, APRON.x1, APRON.z0, APRON.z1), Biome.Paved);
  fill(rect(HGR.frame, TAXI.x0, TAXI.x1, TAXI.z0, TAXI.z1), Biome.Paved);
  // the town: every street, the two squares, the school court (cobbles and paving)
  for (const s of STREETS) stroke(s.pts, s.w / 2, Biome.Paved);
  for (const p of PLACES) if (p.poly && (p.kind === "plaza" || p.kind === "court")) fill(p.poly, Biome.Paved);
  // the plantation: its dirt roads
  for (const rd of ROADS) stroke(rd.pts, rd.hw, Biome.Path);
  return g;
}
