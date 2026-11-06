// CLIMBING: ladders on the buildings / hulls / decks and rope-wrapped giant jungle trunks up to a
// sniper perch. A climb is a vertical line on a face: walk into it (facing it) to grab on, W / S (or the stick) climbs
// — looking up / down or facing away flips which way W goes, like every FPS ladder — jump kicks off, the top pulls you
// over onto the floor (the mantle), the bottom lets you step off. Server-authoritative + predicted (shared/sim/player.ts
// PS.Climb). Pure data + math; the static world carries the list (StaticWorld.climbs, built by buildStaticWorld).
import * as dmath from "./dmath";

/** one climbable line */
export interface Climb {
  /** where the line meets the face (the rungs' centre line), world x / z */
  x: number; z: number;
  /** the climber's feet run from y0 (the bottom: ground, deck or water) to y1 (the top floor it steps onto) */
  y0: number; y1: number;
  /** horizontal unit normal OUT of the face (toward the climber) */
  nx: number; nz: number;
  /** half width along the face (m) */
  hw: number;
  /** the step-off direction at the top (horizontal unit): (−nx, −nz) for a ladder onto a roof / deck, sideways for a
   *  tree perch whose deck surrounds the trunk */
  ex: number; ez: number;
  /** 0 = ladder (rope / bamboo / wood), 1 = tree trunk (rope wraps + notches) */
  kind: number;
  /** how far the climber's axis hangs off the face (m) */
  off: number;
  /** kind 1 (a tree): the trunk axis at the perch (x, z) and the trunk's radius there — the perch is built from them
   *  (shared/pois/climb-trees.ts perchFor) */
  ax?: number; az?: number; ar?: number;
}

export const CLIMB = {
  /** climb speed (m/s), with sprint held */
  v: 3.4, vFast: 4.6,
  /** speed to slide onto the line after grabbing (m/s) */
  snap: 6,
  /** jump off: away from the face (m/s) and up (m/s) */
  kickOut: 4.2, kickUp: 5.5,
  /** the pull-over starts when the feet are this far under the top floor (hands on the lip) */
  topReach: 1.05,
  /** grab from the top: hang this far under the top floor */
  topGrab: 1.15,
  /** no grab within this long of leaving a climb (s, the kick-off flight) */
  regrab: 0.35,
};

/** a ladder against a face (the usual case): exit = into the face */
export function ladder(x: number, z: number, y0: number, y1: number, nx: number, nz: number, hw = 0.42, off = 0.56): Climb {
  const l = dmath.hypot(nx, nz) || 1;
  return { x, z, y0, y1, nx: nx / l, nz: nz / l, hw, ex: -nx / l, ez: -nz / l, kind: 0, off };
}
