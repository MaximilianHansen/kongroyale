// The island's climbs: the POI ladders (shared/pois/ladders.ts) + the climbable giant trees
// (shared/pois/climb-trees.ts). Deterministic from the terrain + the drawn plants + the static boxes; the server, the
// client's worker / in-thread build and the tools all call this through buildStaticWorld, so every copy of the static
// world has the same list in the same order (and the same perch boxes in its hash).
import type { Terrain } from "../world/terrain";
import type { Box } from "../world/colliders";
import type { VegInstance } from "../world/veg-scatter";
import type { Climb } from "./climb";
import { poiLadders, landingBoxes } from "../pois/ladders";
import { pickClimbTrees, treeClimb, perchFor, perchBoxes } from "../pois/climb-trees";
import { StaticWorld } from "./world";
import { PLAYER_H, PLAYER_R } from "./const";
import * as dmath from "./dmath";

export function buildClimbs(terrain: Terrain, plants: VegInstance[] = [], boxes: Box[] = []): { climbs: Climb[]; boxes: Box[] } {
  // the cliff landings between ladders (Mist Falls) collide like the perches: in the boxes and the hash
  const climbs: Climb[] = poiLadders(), out: Box[] = landingBoxes();
  const picks = pickClimbTrees(plants, terrain);
  if (picks.length === 0) return { climbs, boxes: out };
  // the boxes round the picks (a 14 m disc each) in ONE small world, to test each climb against what stands there
  const CELL = 32, cellOf = (x: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  const byCell = new Map<string, number[]>();
  picks.forEach((q, i) => { for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const k = cellOf(q.x + dx * CELL, q.z + dz * CELL); let l = byCell.get(k); if (!l) byCell.set(k, l = []); if (!l.includes(i)) l.push(i); } });
  const near: Box[] = [];
  for (const b of boxes) {
    const l = byCell.get(cellOf(b.c[0], b.c[2])); if (!l) continue;
    for (const i of l) { const dx = b.c[0] - picks[i].x, dz = b.c[2] - picks[i].z, r = 14 + Math.max(b.h[0], b.h[2]); if (dx * dx + dz * dz < r * r) { near.push(b); break; } }
  }
  const w = new StaticWorld(terrain, near);
  for (let i = 0; i < picks.length; i++) {
    const c = treeClimb(picks[i], terrain);
    if (c === null || c.y0 < 0.6) continue;
    if (!treeClimbClear(w, terrain, c)) continue;
    climbs.push(c);
    for (const b of perchBoxes(perchFor(c))) out.push(b);
  }
  return { climbs, boxes: out };
}

/** a kong can walk up to the trunk between the roots, hang on the line all the way up, and stand anywhere on the perch */
function treeClimbClear(w: StaticWorld, t: Terrain, c: Climb): boolean {
  const hx = c.x + c.nx * c.off, hz = c.z + c.nz * c.off;
  const free = (x: number, y: number, z: number, maxPush: number) => {
    w.velY = 0; w.headBump = false; w.wallHit = false;
    w.resolveCapsule(x, y, z, PLAYER_R, PLAYER_H, false);
    return dmath.hypot(w.P[0] - x, w.P[2] - z) <= maxPush && w.P[1] - y < 0.6 && !w.headBump;
  };
  // the approach (on the ground in front of the line) and the foot of the line
  for (const k of [0.3, 0.9]) { const x = hx + c.nx * k, z = hz + c.nz * k; if (!free(x, t.height(x, z) + 0.05, z, 0.15)) return false; }
  // the line itself
  for (let y = c.y0 + 0.6; y < c.y1 - 1; y += 0.5) if (!free(hx, y, hz, 0.12)) return false;
  // the deck: nothing else (another tree's trunk, a rock) stands where the perch goes
  const vx = -c.nz, vz = c.nx, ax = c.ax ?? c.x, az = c.az ?? c.z;
  for (const [u, v] of [[-1.5, -1.5], [-1.5, 1.5], [1.5, 1.5], [1.5, -1.5], [1.5, 0], [-1.5, 0]]) {
    const x = ax + c.nx * u + vx * v, z = az + c.nz * u + vz * v;
    if (dmath.hypot(x - ax, z - az) < (c.ar ?? 0.8) + PLAYER_R + 0.1) continue;
    if (!free(x, c.y1 + 0.02, z, 0.05)) return false;
  }
  return true;
}
