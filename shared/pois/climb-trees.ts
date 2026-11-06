// ===================================================================================================================
// CLIMBABLE GIANT TREES. A handful of the island's buttress giants (the jungle scatter's emergent silhouette,
// veg-scatter variant 2) near each POI and a few out in the wilds get a rope ladder up the trunk (between two buttress roots) to a plank sniper perch
// under the canopy: deck round the trunk with a slot where the ladder comes up, a rope rail, braces to the trunk.
// Deterministic from the drawn plants (veg-scatter vegStaticPlants); the server, the worker and the tools pick the same
// trees. The perch boxes collide (and join the world hash).
// ===================================================================================================================
import type { Box } from "../world/colliders";
import type { Terrain } from "../world/terrain";
import { POIS } from "../world/map";
import type { Climb } from "../sim/climb";
import type { VegInstance } from "../world/veg-scatter";
import { jungleTreeShape, treeRadius, ridgeAt, flangeAt, type TreeShape } from "../world/veg-scatter";
import * as dmath from "../sim/dmath";

/** perch look + collision, derived from its climb (kind 1) */
export interface PerchDef {
  x: number; z: number; y: number; trunkR: number;
  /** the direction the ladder faces (rad, atan2(nz, nx)) */
  yaw: number; half: number;
  /** sim boxes (Box yaw convention: box +X = world (cos yaw, 0, sin yaw)) */
  planks: Array<{ x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number; dark?: boolean }>;
  /** rail runs [x0, z0, x1, z1] on the deck edge */
  rails: Array<[number, number, number, number]>;
}

const SLOT = 0.75, DECK_T = 0.2;
/** the perch of a tree climb: a square plank deck round the trunk (its edge where the rope ladder hangs), a rail with a
 *  gap over the ladder */
export function perchFor(c: Climb): PerchDef {
  const ax = c.ax ?? c.x, az = c.az ?? c.z, rf = c.ar ?? 0.8, ux = c.nx, uz = c.nz, vx = -c.nz, vz = c.nx, y = c.y1;
  const half = dmath.hypot(c.x - ax, c.z - az);
  const yaw = dmath.atan2(uz, ux);
  const planks: PerchDef["planks"] = [];
  // four boards round the trunk (a hole for the trunk in the middle), drawn as their colliders
  const add = (u0: number, u1: number, v0: number, v1: number, dark = false) => {
    const u = (u0 + u1) / 2, v = (v0 + v1) / 2;
    planks.push({ x: ax + ux * u + vx * v, y: y - DECK_T / 2, z: az + uz * u + vz * v, hx: (u1 - u0) / 2, hy: DECK_T / 2, hz: (v1 - v0) / 2, yaw, dark });
  };
  const t = rf * 0.9;
  add(t, half, -half, half); add(-half, -t, -half, half, true); add(-t, t, t, half, true); add(-t, t, -half, -t);
  const P = (u: number, v: number): [number, number] => [ax + ux * u + vx * v, az + uz * u + vz * v];
  const rails: PerchDef["rails"] = [];
  const run = (a: [number, number], b: [number, number]) => rails.push([a[0], a[1], b[0], b[1]]);
  const e = half - 0.06;
  run(P(-e, -e), P(-e, e)); run(P(-e, e), P(e, e)); run(P(e, -e), P(-e, -e));
  // the ladder side: a gap over the ladder
  run(P(e, e), P(e, SLOT)); run(P(e, -SLOT), P(e, -e));
  return { x: ax, z: az, y, trunkR: rf, yaw, half, planks, rails };
}
/** the perch's colliders: the deck pieces + rail boxes (1.05 m) */
export function perchBoxes(p: PerchDef): Box[] {
  const out: Box[] = p.planks.map((b) => ({ c: [b.x, b.y, b.z], h: [b.hx, b.hy, b.hz], yaw: b.yaw, surf: "wood" }));
  for (const [x0, z0, x1, z1] of p.rails) {
    const L = dmath.hypot(x1 - x0, z1 - z0);
    out.push({ c: [(x0 + x1) / 2, p.y + 0.52, (z0 + z1) / 2], h: [L / 2 + 0.04, 0.52, 0.05], yaw: dmath.atan2(z1 - z0, x1 - x0), surf: "wood" });
  }
  return out;
}

/** model → world (three.js yaw: model +X → (cos, −sin)) */
const rotY = (x: number, z: number, yaw: number): [number, number] => { const c = dmath.cos(yaw), s = dmath.sin(yaw); return [x * c + z * s, -x * s + z * c]; };

/** a candidate climb on a drawn giant: the widest gap between its buttress roots, the ladder up the trunk there to the
 *  perch height. null = no gap a kong can stand in (the scatter fills narrow root pockets — see vegTrunkColliders) */
export function treeClimb(p: VegInstance, terrain: Terrain): Climb | null {
  const s: TreeShape = jungleTreeShape(p.variant % 5), S = p.scale;
  // the widest gap between the buttress roots: the rope ladder hangs from the perch edge over it, clear of the roots
  const fl = s.flanges.slice().sort((a, b) => ridgeAt(a, 0.3).a - ridgeAt(b, 0.3).a);
  let best = -1, bestGap = 0;
  for (let k = 0; k < fl.length; k++) {
    let a1 = ridgeAt(fl[(k + 1) % fl.length], 0.3).a; const a0 = ridgeAt(fl[k], 0.3).a; if (k === fl.length - 1) a1 += Math.PI * 2;
    if (a1 - a0 > bestGap) { bestGap = a1 - a0; best = k; }
  }
  if (best < 0 || bestGap < 0.9) return null;
  const phi = ridgeAt(fl[best], 0.3).a + bestGap / 2;
  // perch: ~55 % up the trunk (over the root tops, under the crown)
  const yl = s.trunkH * 0.55, rf = treeRadius(s, yl) * S;
  let ax = 0, az = 0;
  for (let i = 1; i < s.pts.length; i++) { const a = s.pts[i - 1], b = s.pts[i]; if (b[1] >= yl) { const t = (yl - a[1]) / (b[1] - a[1]); ax = a[0] + (b[0] - a[0]) * t; az = a[2] + (b[2] - a[2]) * t; break; } }
  const [wax, waz] = rotY(ax * S, az * S, p.yaw);
  const [nx, nz] = rotY(dmath.cos(phi), -dmath.sin(phi), p.yaw);
  const half = 1.9 + 0.35 * S, axw = p.x + wax, azw = p.z + waz;
  const x = axw + nx * half, z = azw + nz * half, off = 0.5;
  const y0 = terrain.height(x + nx * off, z + nz * off), y1 = p.y + yl * S;
  return { x, z, y0, y1, nx, nz, hw: 0.4, ex: -nx, ez: -nz, kind: 1, off, ax: axw, az: azw, ar: rf };
}
void flangeAt;

/** the giants near each POI (≤ 3, on its outskirts: perches to snipe into it) and a few out in the wilds */
export function pickClimbTrees(plants: VegInstance[], terrain: Terrain): VegInstance[] {
  void terrain;
  const giants = plants.filter((q) => q.kind === "jungle-tree" && q.variant % 5 === 2 && q.scale >= 0.95);
  const h = (q: VegInstance) => { let x = Math.imul(Math.round(q.x * 10) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(q.z * 10), 0xc2b2ae35); x ^= x >>> 13; return (x >>> 0) / 4294967296; };
  const out: VegInstance[] = [];
  const far = (q: VegInstance, d: number) => out.every((o) => dmath.hypot(o.x - q.x, o.z - q.z) >= d);
  for (const poi of POIS) {
    if (poi.id === "lobby-islet") continue;
    const ring = giants.filter((q) => { const d = dmath.hypot(q.x - poi.x, q.z - poi.z); return d > poi.r * 0.45 && d < poi.r * 1.3; }).sort((a, b) => h(a) - h(b));
    let n = 0;
    for (const q of ring) { if (n >= 2) break; if (far(q, 45)) { out.push(q); n++; } }
  }
  const wild = giants.filter((q) => POIS.every((poi) => dmath.hypot(q.x - poi.x, q.z - poi.z) > poi.r * 1.6)).sort((a, b) => h(a) - h(b));
  let n = 0;
  for (const q of wild) { if (n >= 7) break; if (far(q, 240)) { out.push(q); n++; } }
  return out;
}
