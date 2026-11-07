// poi-coast layout kit — PURE MATH (no three.js) so the server and the client derive colliders and visuals from the
// SAME data. A POI layout is a list of `Piece`s (oriented boxes with a visual `k`ind). The client turns pieces into
// meshes (materials keyed by `k`), the server/prediction turns them into `Box` colliders.
//
// Conventions (match shared/world/colliders.ts): metres, +Y up, yaw = three.js rotation.y (radians), pitch = rotation
// about the box's local X applied after yaw (Euler order "YXZ"). Positive pitch tips the box's local +Z end DOWN.
import type { Box, Surface } from "../world/colliders";
// trunk shapes come from the vegetation's ONE source of truth (shared/world/veg-scatter.ts vegTrunkColliders). That module
// imports shared/pois/index (→ every POI), so this kit never imports it at runtime: a POI module imports it itself and
// hands the function to floraColliders() inside a lazyBoxes() callback (called long after every module evaluated)
import type { VegInstance, VegKind } from "../world/veg-scatter";
import type { InteriorRoom, LootSlots } from "./interior-kit";
import * as dmath from "../sim/dmath";

export type V3 = [number, number, number];

/**
 * A collider array whose tail is computed on first access (any read: length, index, iteration, flatMap). Used for
 * boxes that need another module's functions (veg trunk shapes) which may not be evaluated yet while the POI module
 * itself evaluates (import cycle pois/index ↔ veg-scatter). Every consumer reads `colliders` long after the imports.
 */
export function lazyBoxes(base: Box[], more: () => Box[]): Box[] {
  let done = false;
  const init = () => { if (done) return; done = true; for (const b of more()) base.push(b); };
  return new Proxy(base, {
    get(t, p, r) { init(); return Reflect.get(t, p, r); },
    has(t, p) { init(); return Reflect.has(t, p); },
    ownKeys(t) { init(); return Reflect.ownKeys(t); },
    getOwnPropertyDescriptor(t, p) { init(); return Reflect.getOwnPropertyDescriptor(t, p); },
  });
}

// ------------------------------------------------------------------------------------------------ POI flora
/** plants a coast POI places itself (client: VegApi.plant; the veg scatter stays out of the POI pads). Collidable kinds
 *  get the SAME trunk boxes the veg scatter gives its own trees (vegTrunkColliders), so a palm in a POI is as solid as a
 *  palm in the jungle. [kind, x, groundY, z, yaw (three.js), scale] */
export type FloraKind = "palm" | "palm-leaning" | "jungle-tree" | "bush" | "fern" | "monstera" | "banana-plant" | "flowers" | "grass" | "log" | "groundcover";
export type Flora = [FloraKind, number, number, number, number, number];
export const FLORA_SOLID: ReadonlySet<FloraKind> = new Set<FloraKind>(["palm", "palm-leaning", "jungle-tree", "log"]);
/** = client/src/world/veg/detail-gen.ts hash01 (the variant the client's VegApi.plant picks for a plant at x, z) */
const hash01 = (x: number, z: number) => { const s = dmath.sin(x * 12.9898 + z * 78.233) * 43758.5453; return s - Math.floor(s); };
/** variant counts of the collidable kinds (= veg-scatter VARIANTS; asserted in floraColliders — kept local so this kit
 *  needs no runtime import of veg-scatter) */
const NV: Record<string, number> = { palm: 3, "palm-leaning": 3, "jungle-tree": 5, log: 2 };
export function floraVariant(k: FloraKind, x: number, z: number): number {
  return Math.floor(hash01(x + 3.1, z + 1.7) * (NV[k] ?? 1));
}
/** nudge a collidable plant's x until its variant is unambiguous: never the highlands-only orange palm (variant 2 of
 *  "palm", swapped by biome on the client) and never within 1e-4 of a variant boundary */
export function settleFlora(k: FloraKind, x: number, z: number): number {
  if (!FLORA_SOLID.has(k)) return x;
  const n = NV[k];
  for (let i = 0; i < 200; i++, x += 0.037) {
    const h = hash01(x + 3.1, z + 1.7) * n, v = Math.floor(h);
    if (h - v < 1e-4 || v + 1 - h < 1e-4) continue;
    if (k === "palm" && v === 2) continue;
    return x;
  }
  return x;
}
/** trunk colliders of the collidable flora — `trunk` = veg-scatter's vegTrunkColliders, `variants` = its VARIANTS
 *  (call lazily, see lazyBoxes) */
export function floraColliders(list: Flora[], trunk: (inst: VegInstance[]) => Box[], variants?: Record<string, number>): Box[] {
  if (variants) for (const k of Object.keys(NV)) if (variants[k] !== NV[k]) console.warn(`coast flora: veg VARIANTS.${k} = ${variants[k]} ≠ ${NV[k]} — plant variants (and trunk colliders) may not match`);
  const out: Box[] = [];
  for (const [k, x, y, z, yaw, s] of list) {
    if (!FLORA_SOLID.has(k)) continue;
    const bs = trunk([{ kind: k as VegKind, variant: floraVariant(k, x, z), x, y: y - 0.05, z, yaw, scale: s }]);
    out.push(...bs);
    // + one box = the union of the trunk's segments in its lowest 2 m (the veg trunk is a chain of ~0.5 m boxes; the
    // union adds no new volume where the trunk is near-vertical, and hit tests / cover queries see one solid trunk)
    if (k === "log") continue;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const b of bs) {
      if (b.c[1] - b.h[1] > y + 2.0 || b.yaw) continue;
      x0 = Math.min(x0, b.c[0] - b.h[0]); x1 = Math.max(x1, b.c[0] + b.h[0]); z0 = Math.min(z0, b.c[2] - b.h[2]); z1 = Math.max(z1, b.c[2] + b.h[2]);
      y0 = Math.min(y0, b.c[1] - b.h[1]); y1 = Math.max(y1, Math.min(b.c[1] + b.h[1], y + 2.1));
    }
    // only a straight base (a leaning trunk's union would be a fat box round empty air)
    if (x1 > x0 && y1 - y0 > 1.2 && x1 - x0 < 1.1 && z1 - z0 < 1.1) out.push({ c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], h: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], surf: "wood" });
  }
  return out;
}

/** designed loot (LOOT_SPOTS contract): world metres, y = the floor the loot stands on */
export interface LootSpots { chests: Array<[number, number, number, number]>; floor: Array<[number, number, number]> }

/** a shared-interiors-kit room in a coast building frame: (lx, ly, lz) = the room's floor centre in the frame,
 *  ly = floor top; the room turns with the frame (both use three's rotation.y) */
export function kitRoom(f: Frame, lx: number, ly: number, lz: number, o: Omit<InteriorRoom, "x" | "y" | "z" | "yaw">): InteriorRoom {
  const p = toWorld(f, lx, ly, lz);
  return { x: p[0], y: p[1], z: p[2], yaw: f.yaw, ...o };
}
/** the kit's loot per room merged into designed spots: its first chest slot (every `chestEvery`-th room) + its last
 *  floor slot (the harbor pattern — the match generator activates a seeded subset) */
export function addKitLoot(spots: LootSpots, rooms: InteriorRoom[], loot: (r: InteriorRoom[]) => LootSlots, chestEvery = 1): void {
  rooms.forEach((r, i) => {
    const l = loot([r]);
    if (l.chests.length && i % chestEvery === 0) spots.chests.push(l.chests[0]);
    if (l.floor.length) spots.floor.push(l.floor[l.floor.length - 1]);
    if (l.floor.length > 2 && r.w * r.d > 45) spots.floor.push(l.floor[0]);
  });
}

/** is (x, z) inside the frame-local rectangle [x0, x1] × [z0, z1] (+ margin m)? */
export function inFrameRect(f: Frame, x: number, z: number, x0: number, x1: number, z0: number, z1: number, m = 0): boolean {
  const dx = x - f.x, dz = z - f.z, c = dmath.cos(f.yaw), s = dmath.sin(f.yaw);
  const lx = dx * c - dz * s, lz = dx * s + dz * c;
  return lx > x0 - m && lx < x1 + m && lz > z0 - m && lz < z1 + m;
}

export interface Piece {
  /** visual kind, e.g. "wall:plaster", "floor:planks", "step:stone". The client maps it to a material. */
  k: string;
  c: V3;
  h: V3;
  yaw?: number;
  pitch?: number;
  surf?: Surface;
  /** visual only (no collider) */
  vis?: boolean;
  /** collider only (no visual) */
  col?: boolean;
  noShoot?: boolean;
  /** a fence that guards a sheer drop (a cliff-lip railing): it stops a tuk-tuk like a wall */
  driveStop?: boolean;
}

/** a local frame: origin + yaw */
export interface Frame { x: number; y: number; z: number; yaw: number }

export const F = (x: number, y: number, z: number, yaw = 0): Frame => ({ x, y, z, yaw });

/** local → world point */
export function toWorld(f: Frame, lx: number, ly: number, lz: number): V3 {
  const c = dmath.cos(f.yaw), s = dmath.sin(f.yaw);
  return [f.x + lx * c + lz * s, f.y + ly, f.z - lx * s + lz * c];
}

/** compose frames: `inner` is expressed in `outer`'s local space */
export function sub(outer: Frame, inner: Frame): Frame {
  const p = toWorld(outer, inner.x, inner.y, inner.z);
  return { x: p[0], y: p[1], z: p[2], yaw: outer.yaw + inner.yaw };
}

/** transform local pieces into the frame */
export function place(f: Frame, pieces: Piece[]): Piece[] {
  return pieces.map((p) => ({ ...p, c: toWorld(f, p.c[0], p.c[1], p.c[2]), yaw: (p.yaw ?? 0) + f.yaw }));
}

/**
 * Pieces → sim colliders. Piece.yaw is three.js rotation.y (box +X → world (cos, 0, −sin)); the SIM's Box.yaw turns
 * the other way (shared/sim/world.ts: box +X → world (cos, 0, +sin); see harbor-kit / jungle-layout simYaw), so the
 * collider gets −yaw (otherwise every diagonal coast wall is mirrored).
 * The sim has no pitched boxes: it grows a pitched box to its whole vertical extent (a 7 m stair ramp became a 7 m
 * wall, a roof slab a phantom block inside the attic). So a pitched piece is emitted as a STAIRCASE of yaw-only boxes
 * along its length, each rising ≤ 0.35 m.
 */
export function toBoxes(pieces: Piece[]): Box[] {
  const out: Box[] = [];
  const push = (p: Piece, c: V3, h: V3) => {
    const b: Box = { c, h };
    if (p.yaw) b.yaw = -p.yaw;
    if (p.surf) b.surf = p.surf;
    if (p.noShoot) b.noShoot = true;
    if ((p.k === "fence" || p.k.startsWith("fence:") || p.k === "hedge") && !p.driveStop) b.noDrive = true;   // (a tuk-tuk drives through — not a cliff railing)
    out.push(b);
  };
  for (const p of pieces) {
    if (p.vis) continue;
    const pitch = p.pitch ?? 0;
    if (!pitch) { push(p, [...p.c] as V3, [...p.h] as V3); continue; }
    const sp = dmath.sin(pitch), cp = dmath.cos(pitch), fy = dmath.sin(p.yaw ?? 0), fz = dmath.cos(p.yaw ?? 0);
    // ≤ 0.25 m per step and each step CENTRED on the drawn slope (on top of it, a kong on a roof would float up to
    // 0.25 m over the drawn sheet)
    const n = Math.max(1, Math.ceil((Math.abs(sp) * 2 * p.h[2]) / 0.25)), seg = (2 * p.h[2]) / n, half = Math.abs(sp) * seg / 2;
    for (let i = 0; i < n; i++) {
      const t = -p.h[2] + seg * (i + 0.5);             // along the piece's local Z
      const dy = -sp * t, dh = cp * t;                  // Rx(pitch)·(0,0,t) → (0, −sin·t, cos·t)
      push(p, [p.c[0] + fy * dh, p.c[1] + dy - half / 2, p.c[2] + fz * dh], [p.h[0], half / 2 + Math.abs(cp) * p.h[1], Math.abs(cp) * seg / 2 + Math.abs(sp) * p.h[1]]);
    }
  }
  return out;
}

/** axis-aligned (in local space) box from min/max corners */
export function bx(k: string, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, o: Partial<Piece> = {}): Piece {
  return { k, c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], h: [Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, Math.abs(z1 - z0) / 2], ...o };
}

export interface Opening { u: number; w: number; y0: number; h: number; kind?: "door" | "window" | "gap" }

/**
 * A straight wall from (x0,z0) to (x1,z1) (local), bottom y0, height h, thickness t, with rectangular openings
 * (u = distance of the opening centre from (x0,z0) along the wall). Returns the solid pieces around the openings.
 */
export function wall(k: string, x0: number, z0: number, x1: number, z1: number, y0: number, h: number, t: number,
  openings: Opening[] = [], o: Partial<Piece> = {}): Piece[] {
  const dx = x1 - x0, dz = z1 - z0, L = dmath.hypot(dx, dz), ux = dx / L, uz = dz / L;
  const yaw = dmath.atan2(-uz, ux);
  const out: Piece[] = [];
  const seg = (a: number, b: number, ya: number, yb: number) => {
    if (b - a < 0.02 || yb - ya < 0.02) return;
    const m = (a + b) / 2;
    out.push({ k, c: [x0 + ux * m, (ya + yb) / 2, z0 + uz * m], h: [(b - a) / 2, (yb - ya) / 2, t / 2], yaw, ...o });
  };
  const ops = [...openings].sort((a, b) => a.u - b.u);
  let cur = 0;
  for (const op of ops) {
    const a = op.u - op.w / 2, b = op.u + op.w / 2;
    seg(cur, a, y0, y0 + h);
    seg(a, b, y0, y0 + op.y0);                    // below the sill
    seg(a, b, y0 + op.y0 + op.h, y0 + h);         // above the lintel
    cur = b;
  }
  seg(cur, L, y0, y0 + h);
  return out;
}

/**
 * A karst rock massif (mountains / cliffs behind a POI, not only a jungle wall) — a cluster of limestone
 * towers, each a stack of tapering, slightly offset courses. Every course is a collider box the client draws as a
 * faceted rock block that fills it (peel-strip/hero-props.ts rockBlock). pillars: [dx, dz, w, d, h].
 */
export const MASSIF_INSET = 0.1;
export function massif(k: string, x: number, y: number, z: number, seed: number, pillars: Array<[number, number, number, number, number]>): Piece[] {
  // each course is an OCTAGONAL prism (circumradius R): 4 strip boxes at 0/45/90/135° whose union is exactly the
  // octagon the client draws (the drawn facets are jittered INWARD ≤ 0.3 m only)
  const out: Piece[] = [], r = rng(seed);
  for (const [dx, dz, w, d, h] of pillars) {
    const n = Math.max(2, Math.ceil(h / 7)), ch = h / n;
    let cx = x + dx, cz = z + dz, R = (w + d) / 4;
    for (let i = 0; i < n; i++) {
      // (the collider octagon is 0.2 m inside the drawn one, whose facets jitter inward ≤ 0.15: drawn ⊇ collider)
      const yaw = (r() - 0.5) * 0.8, Rc = R - MASSIF_INSET, ri = Rc * dmath.cos(Math.PI / 8), aa = Rc * dmath.sin(Math.PI / 8);
      for (let q = 0; q < 4; q++) out.push({ k, c: [cx, y + ch * (i + 0.5), cz], h: [ri, ch / 2 + 0.02, aa], yaw: yaw + (q * Math.PI) / 4, col: true, surf: "stone" });
      R *= 0.86 + r() * 0.07; cx += (r() - 0.5) * R * 0.22; cz += (r() - 0.5) * R * 0.22;
    }
  }
  return out;
}

/**
 * The collider of every open door
 * leaf the client's dressOpenings() draws for the same wall line + opening list + swing. Door = an opening from the
 * floor (y0 ≤ 0.05). The leaf hinges at the opening's start edge on the wall's +z face (t/2 + 0.02 out) and is turned
 * by `swing` (three.js yaw); drawn lw = w − 0.06, lh = min(h − 0.04, maxH), 0.05 thick — the collider is 0.08 thick.
 */
export function doorLeaves(k: string, x0: number, z0: number, x1: number, z1: number, y0: number, ops: ReadonlyArray<{ u: number; w: number; y0: number; h: number }>, t: number, swing: number, o: { maxH?: number; surf?: Surface } = {}): Piece[] {
  const dx = x1 - x0, dz = z1 - z0, L = dmath.hypot(dx, dz), ux = dx / L, uz = dz / L, yaw = dmath.atan2(-uz, ux);
  const out: Piece[] = [], c = dmath.cos(yaw), s = dmath.sin(yaw), a2 = yaw + swing, ca = dmath.cos(a2), sa = dmath.sin(a2);
  for (const op of ops) {
    if (op.y0 > 0.05) continue;
    const cx = x0 + ux * op.u, cz = z0 + uz * op.u, a = -op.w / 2 + 0.03, b = t / 2 + 0.02;
    const hx = cx + a * c + b * s, hz = cz - a * s + b * c, lw = op.w - 0.06, lh = Math.min(op.h - 0.04, o.maxH ?? 2.3);
    out.push({ k, c: [hx + ca * lw / 2, y0 + op.y0 + lh / 2, hz - sa * lw / 2], h: [lw / 2, lh / 2, 0.04], yaw: a2, col: true, surf: o.surf ?? "wood" });
  }
  return out;
}

/**
 * Straight stair flight. Starts at local (x,z) at height y0, climbs `n` steps of `rise` toward direction `yaw`
 * (local +Z rotated by yaw), each `run` deep, `w` wide. Visual steps are solid blocks down to `base` (default y0,
 * visual only); the colliders are one thin box PER TREAD (≥ 0.3 m thick): the sim auto-steps ≤ 0.55 m and treats a
 * pitched box as its whole vertical bounding box (shared/sim/world.ts), so a pitched "ramp" collider would be a wall.
 * `ramp: false` = the visual blocks are the colliders too (short solid steps, e.g. porch steps).
 */
export function stairs(k: string, x: number, z: number, y0: number, yaw: number, w: number, rise: number, run: number, n: number,
  o: { base?: number; surf?: Surface; ramp?: boolean } = {}): Piece[] {
  const out: Piece[] = [];
  const fx = dmath.sin(yaw), fz = dmath.cos(yaw);
  const base = o.base ?? y0;
  for (let i = 0; i < n; i++) {
    const top = y0 + rise * (i + 1), d = run * (i + 0.5);
    out.push({ k, c: [x + fx * d, (top + base) / 2, z + fz * d], h: [w / 2, (top - base) / 2, run / 2], yaw, vis: o.ramp !== false, surf: o.surf });
    if (o.ramp !== false) {
      const th = Math.min(Math.max(0.3, rise * 2), top - base + 0.3);
      out.push({ k: "step:col", c: [x + fx * d, top - th / 2, z + fz * d], h: [w / 2, th / 2, run / 2 + 0.01], yaw, col: true, surf: o.surf });
    }
  }
  return out;
}

/** spiral stair steps around (cx,cz): from angle a0, `n` steps, each `da` radians and `rise` metres, radii r0..r1 */
export function spiral(k: string, cx: number, cz: number, y0: number, a0: number, da: number, rise: number, n: number,
  r0: number, r1: number, o: { surf?: Surface; thick?: number } = {}): Piece[] {
  const out: Piece[] = [];
  const rm = (r0 + r1) / 2, thick = o.thick ?? 0.3;
  for (let i = 0; i < n; i++) {
    const a = a0 + da * (i + 0.5), top = y0 + rise * (i + 1);
    // tread box: radial length (r1-r0), tangential width = arc at the outer radius (overlap a little)
    const tw = Math.abs(da) * r1 * 1.08;
    out.push({ k, c: [cx + dmath.cos(a) * rm, top - thick / 2, cz + dmath.sin(a) * rm],
      h: [(r1 - r0) / 2, thick / 2, tw / 2], yaw: -a, surf: o.surf });
  }
  return out;
}

/** a ring of wall segments (cylinder approximation) — for round towers. Gaps: angular windows [a0,a1] left open. */
export function ringWall(k: string, cx: number, cz: number, y0: number, h: number, r: number, t: number, segs: number,
  gaps: Array<[number, number]> = [], o: Partial<Piece> = {}): Piece[] {
  const out: Piece[] = [];
  const da = (Math.PI * 2) / segs;
  const inGap = (a: number) => gaps.some(([g0, g1]) => {
    const n = (x: number) => ((x % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const A = n(a), G0 = n(g0), G1 = n(g1);
    return G0 <= G1 ? A >= G0 && A <= G1 : A >= G0 || A <= G1;
  });
  for (let i = 0; i < segs; i++) {
    const a = da * (i + 0.5);
    if (inGap(a)) continue;
    const rm = r - t / 2, w = 2 * r * dmath.tan(da / 2) + 0.05;
    out.push({ k, c: [cx + dmath.cos(a) * rm, y0 + h / 2, cz + dmath.sin(a) * rm], h: [t / 2, h / 2, w / 2], yaw: -a, ...o });
  }
  return out;
}

export type Clearing = { x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number; yaw?: number };

/** deterministic PRNG (mulberry32) — same scatter on client and server */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------------------------------------ loot settle
/**
 * Loot spots against the POI's OWN colliders (sim yaw convention — the exported `colliders`): a spot whose disc (floor
 * 0.36 m, chest 0.46 m) overlaps a solid box between 0.08 and 0.9 m above its floor slides to the nearest clear point
 * ≤ 0.9 m away on the same floor; a spot with no floor box within ±`snap` m under it (when `needFloor` says it should
 * stand on one) snaps onto the nearest box top in that band. Spots that cannot be fixed are dropped. Keeps order, so the
 * seeded per-match activation stays deterministic.
 */
export function settleLoot<T extends number[]>(spots: T[], boxes: Box[], o: { chest?: boolean; needFloor?: (s: T) => boolean; snap?: number } = {}): T[] {
  const r = o.chest ? 0.46 : 0.36, snap = o.snap ?? 0.15;
  type B = { b: Box; c: number; s: number; x0: number; x1: number; z0: number; z1: number };
  const bs: B[] = boxes.map((b) => { const y = b.yaw ?? 0, c = dmath.cos(y), s = dmath.sin(y), ex = Math.abs(c) * b.h[0] + Math.abs(s) * b.h[2], ez = Math.abs(s) * b.h[0] + Math.abs(c) * b.h[2]; return { b, c, s, x0: b.c[0] - ex, x1: b.c[0] + ex, z0: b.c[2] - ez, z1: b.c[2] + ez }; });
  const local = (q: B, x: number, z: number) => { const dx = x - q.b.c[0], dz = z - q.b.c[2]; return [dx * q.c + dz * q.s, -dx * q.s + dz * q.c]; };
  const out: T[] = [];
  for (const sp of spots) {
    const [x, y0, z] = sp;
    const near = bs.filter((q) => x > q.x0 - 2 && x < q.x1 + 2 && z > q.z0 - 2 && z < q.z1 + 2);
    const floorAt = (px: number, pz: number, y: number) => { let best: number | null = null; for (const q of near) { if (q.b.noWalk) continue; const top = q.b.c[1] + q.b.h[1]; if (Math.abs(top - y) > snap) continue; const [lx, lz] = local(q, px, pz); if (Math.abs(lx) < q.b.h[0] && Math.abs(lz) < q.b.h[2] && (best === null || Math.abs(top - y) < Math.abs(best - y))) best = top; } return best; };
    const clear = (px: number, pz: number, y: number) => near.every((q) => { const lo = q.b.c[1] - q.b.h[1], hi = q.b.c[1] + q.b.h[1]; if (hi < y + 0.08 || lo > y + 0.9) return true; const [lx, lz] = local(q, px, pz); return Math.abs(lx) >= q.b.h[0] + r || Math.abs(lz) >= q.b.h[2] + r; });
    const want = o.needFloor?.(sp) ?? false;
    let done: T | null = null;
    outer: for (const d of [0, 0.3, 0.6, 0.9]) for (let k = 0; k < (d ? 12 : 1); k++) {
      const px = x + dmath.cos(k * Math.PI / 6) * d, pz = z + dmath.sin(k * Math.PI / 6) * d;
      const f = floorAt(px, pz, y0), y = f ?? y0;
      if (want && f === null) continue;
      if (!clear(px, pz, y)) continue;
      const n = sp.slice() as T; n[0] = +px.toFixed(2); n[1] = +y.toFixed(2); n[2] = +pz.toFixed(2); done = n; break outer;
    }
    if (done) out.push(done);
  }
  return out;
}
