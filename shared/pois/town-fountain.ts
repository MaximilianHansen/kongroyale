// poi-town: Mango Market fountain — ONE layout (dimensions) shared by the client visuals (client/src/world/pois/_kit/
// town-fountain.ts) and the server/client-prediction colliders below, so what you see is what you collide with.
// Pure TS (the game server runs it). All heights are metres above the plaza floor at the fountain centre; the
// decoration (square pedestal, front planter pier, rim planters, statue) is rotated by `statueYaw` (statue faces +z
// at yaw 0, like everything else in the town kit).
import type { Box } from "../world/colliders";
import * as dmath from "../sim/dmath";

export interface FountainDims {
  R: number; statueHeight: number; statueYaw: number;
  /** outer step ring */ stepR: number; stepH: number;
  /** basin wall: outer radius R, inner radius */ innerR: number; wallTop: number;
  /** rounded coping: radial extent + height range */ copIn: number; copOut: number; copY0: number; copY1: number;
  floorY: number; waterY: number;
  /** pedestal scale (∝ statue height) and its tiers: half sizes + y ranges */ ps: number;
  plinth: { h: number; y0: number; y1: number };
  collar: { h: number; y0: number; y1: number };
  shaft: { h: number; y0: number; y1: number; courses: number };
  cap1: { h: number; y0: number; y1: number };
  cap2: { h: number; y0: number; y1: number };
  top: { h: number; y0: number; y1: number };
  /** front planter pier (in the statue's facing direction) */ pier: { w: number; d: number; y1: number; r: number };
  /** small stone planters sitting on the coping: angle (radians, relative to the facing direction) */ rimPlanters: Array<{ a: number; w: number; h: number }>;
}

export function fountainDims(o: { R?: number; statueHeight?: number; statueYaw?: number } = {}): FountainDims {
  const R = o.R ?? 4.2, statueHeight = o.statueHeight ?? 3.4, statueYaw = o.statueYaw ?? 0;
  const k = R / 4.2;
  const ps = Math.min(statueHeight / 3.4, (R - 1.2) / 3.0) || 1;
  const stepH = 0.19, copY1 = 0.84, copY0 = 0.69;
  const innerR = R - 0.36;
  const floorY = 0.03, waterY = 0.64;
  const plinth = { h: 1.3 * ps, y0: 0, y1: 0.8 };
  const collar = { h: 1.4 * ps, y0: 0.8, y1: 0.95 };
  const shH = 1.3 * ps;
  const shaft = { h: 0.94 * ps, y0: 0.95, y1: 0.95 + shH, courses: 3 };
  const cap1 = { h: 1.08 * ps, y0: shaft.y1, y1: shaft.y1 + 0.12 };
  const cap2 = { h: 1.2 * ps, y0: cap1.y1, y1: cap1.y1 + 0.16 };
  const top = { h: 1.0 * ps, y0: cap2.y1, y1: cap2.y1 + 0.22 };
  return {
    R, statueHeight, statueYaw,
    stepR: R + 0.5 * k, stepH,
    innerR, wallTop: copY1,
    copIn: innerR - 0.06, copOut: R + 0.07, copY0, copY1,
    floorY, waterY, ps,
    plinth, collar, shaft, cap1, cap2, top,
    pier: { w: 1.1 * k, d: 1.0 * k, y1: 1.12, r: R - 0.12 },
    rimPlanters: [{ a: Math.PI * 0.44, w: 0.7, h: 0.42 }, { a: -Math.PI * 0.44, w: 0.7, h: 0.42 }, { a: Math.PI * 0.86, w: 0.6, h: 0.38 }],
  };
}

/** collision boxes matching the visuals: step ring + basin wall ring (segments), pier + rim planters, pedestal tiers,
 *  statue body (+ raised arm). (x, y, z) = plaza floor at the fountain centre. `statueYaw` (optional) must match the
 *  visuals' FountainOpts.statueYaw. */
export function fountainColliders(x: number, y: number, z: number, o: { R?: number; statueHeight?: number; statueYaw?: number } = {}): Box[] {
  const d = fountainDims(o);
  const out: Box[] = [];
  const yaw = d.statueYaw;
  // local (rotated by statueYaw) → world
  const W = (lx: number, lz: number): [number, number] => [x + lx * dmath.cos(yaw) + lz * dmath.sin(yaw), z - lx * dmath.sin(yaw) + lz * dmath.cos(yaw)];
  const ring = (r0: number, r1: number, y0: number, y1: number, n: number) => {
    const rm = (r0 + r1) / 2, half = Math.PI / n;
    for (let i = 0; i < n; i++) {
      const a = (i + 0.5) * 2 * Math.PI / n;
      out.push({ c: [x + dmath.cos(a) * rm, y + (y0 + y1) / 2, z + dmath.sin(a) * rm], h: [dmath.tan(half) * r1 + 0.02, (y1 - y0) / 2, (r1 - r0) / 2], yaw: -a + Math.PI / 2, surf: "stone" });
    }
  };
  ring(d.R - 0.05, d.stepR, 0, d.stepH, 20);        // walkable step
  ring(d.copIn, d.copOut, 0, d.copY1, 20);          // basin wall + coping
  // front planter pier + rim planters
  { const [px, pz] = W(0, d.pier.r); out.push({ c: [px, y + d.pier.y1 / 2, pz], h: [d.pier.w / 2, d.pier.y1 / 2, d.pier.d / 2], yaw, surf: "stone" }); }
  for (const p of d.rimPlanters) {
    const [px, pz] = W(dmath.sin(p.a) * (d.R - 0.17), dmath.cos(p.a) * (d.R - 0.17));
    out.push({ c: [px, y + (d.copY1 + p.h) / 2, pz], h: [p.w / 2, (d.copY1 + p.h) / 2, p.w / 2], yaw: yaw + p.a, surf: "stone" });
  }
  // pedestal tiers
  const tier = (t: { h: number; y0: number; y1: number }) => out.push({ c: [x, y + (t.y0 + t.y1) / 2, z], h: [t.h, (t.y1 - t.y0) / 2, t.h], yaw, surf: "stone" });
  tier(d.plinth); tier(d.collar); tier(d.shaft); tier(d.cap2); tier(d.top);
  // statue: body block + raised arm (statue's right = local −x) — proportions of town-statue.ts at statueHeight
  const s = d.statueHeight / 3.4, sy = y + d.top.y1;
  out.push({ c: [x, sy + 1.25 * s, z], h: [0.78 * s, 1.25 * s, 0.5 * s], yaw, surf: "metal" });
  { const [ax, az] = W(-1.05 * s, 0.05 * s); out.push({ c: [ax, sy + 2.6 * s, az], h: [0.32 * s, 0.75 * s, 0.35 * s], yaw, surf: "metal" }); }
  return out;
}
