// Two small shared helpers for the coast-kit POIs (The Plantation, Peel Strip) —
// breakable window panes for wall() openings and the designed-loot settle. Their own module: the-plantation.ts and
// peel-strip.ts sit in an import cycle (map / pois index), so neither may import the other at evaluation time.
import type { Box } from "../world/colliders";
import type { LootSpots, Piece, V3 } from "./coast-kit";
import * as dmath from "../sim/dmath";

/** A breakable pane (shared/sim/glass.ts: a ≤ 8 cm surf-"glass" box) in every
 *  WINDOW opening (y0 > 0.05) of a coast-kit wall() — same line, base and opening list, so it fills exactly the hole
 *  the client's dressOpenings glazes. Bullets break it and fly on, a sprint / slide / punch smashes it, the window
 *  vault jumps through. */
export function panes(k: string, x0: number, z0: number, x1: number, z1: number, y0: number, ops: ReadonlyArray<{ u: number; w: number; y0: number; h: number }>, off = 0): Piece[] {
  const dx = x1 - x0, dz = z1 - z0, L = dmath.hypot(dx, dz), ux = dx / L, uz = dz / L, yaw = dmath.atan2(-uz, ux);
  // (off: metres along the wall's +normal (−uz, ux) — the glass plane when it is not on the wall's centre line)
  return ops.filter((op) => op.y0 > 0.05).map((op) => ({ k, c: [x0 + ux * op.u - uz * off, y0 + op.y0 + op.h / 2, z0 + uz * op.u + ux * off] as V3, h: [op.w / 2, op.h / 2, 0.03] as V3, yaw, col: true, noShoot: true, surf: "glass" as const }));
}

/** Every designed spot is
 *  pushed clear of this POI's own colliders — the loot's 0.37 m disc, 0.6 m tall, resting on its floor
 *  (the loot checker's "clear" test) — typically an interiors-kit slot 3 cm into a wall or a cabinet; the generator
 *  drops an embedded spot, so a building would lose its designed loot to lattice fill. A spot that would have to move
 *  more than 0.6 m stays put (and the loot checker still reports it). */
export function settleLoot(spots: LootSpots, boxes: Box[], R = 0.37): void {
  const near = (x: number, y: number, z: number) => boxes.filter((b) => {
    const r = dmath.hypot(b.h[0], b.h[2]) + R + 0.7;
    return Math.abs(b.c[0] - x) < r && Math.abs(b.c[2] - z) < r && b.c[1] - b.h[1] < y + 0.6 && b.c[1] + b.h[1] > y + 0.05;
  });
  const settle = (p: number[]) => {
    const x0 = p[0], z0 = p[2], cand = near(p[0], p[1], p[2]);
    let x = x0, z = z0;
    for (let it = 0; it < 6; it++) {
      let moved = false;
      for (const b of cand) {
        const c = dmath.cos(b.yaw ?? 0), s = dmath.sin(b.yaw ?? 0), dx = x - b.c[0], dz = z - b.c[2];
        const lx = dx * c + dz * s, lz = -dx * s + dz * c, hx = b.h[0], hz = b.h[2];
        const qx = Math.max(-hx, Math.min(hx, lx)), qz = Math.max(-hz, Math.min(hz, lz));
        let ex = lx - qx, ez = lz - qz, d = dmath.hypot(ex, ez), push: number;
        if (d > 1e-4) { if (d >= R) continue; push = R - d + 0.01; ex /= d; ez /= d; }
        else { // centre inside the box: out through the nearest side
          const px = hx - Math.abs(lx), pz = hz - Math.abs(lz);
          if (px < pz) { ex = Math.sign(lx) || 1; ez = 0; push = px + R + 0.01; } else { ex = 0; ez = Math.sign(lz) || 1; push = pz + R + 0.01; }
        }
        x += (ex * c - ez * s) * push; z += (ex * s + ez * c) * push; moved = true;
      }
      if (!moved) break;
    }
    if (dmath.hypot(x - x0, z - z0) <= 0.6) { p[0] = +x.toFixed(2); p[2] = +z.toFixed(2); }
  };
  for (const c of spots.chests) settle(c);
  for (const f of spots.floor) settle(f);
}
