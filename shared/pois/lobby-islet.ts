// POI lobby-islet — shared layout + collision (read by client visuals AND the authoritative server).
// ONE layout table (LOBBY) drives both the client meshes (client/src/world/pois/lobby-islet/**) and the colliders
// below, so what you see is what you collide with.
//
// Coordinates: every item is placed in the LOBBY FRAME — origin = the char-02-lobby-island camera, hovering over the
// shallows off the islet's NORTH beach, looking SSW across the beach + plaza toward the runway (the midday sun,
// az −34° / elev 58°, then sits behind the camera's right shoulder like the target art's key light).
//   lx = metres to the right of the frame axis, d = metres forward (away from the camera / the sea),
//   a  = local yaw (radians, 0 = the item's front (+Z of the client group) faces back toward the camera).
//   gy = ground height (m above sea). The terrain pad is flat at 2.5 m only within 60 m of (0, 1020); the beach in
//   front of it slopes ~6° down to the sea, so most plaza items stand on the slope. Their ground heights are BAKED
//   into the GY block below from the live terrain (the client grounds visuals on the live terrain anyway).
//   Re-bake after the terrain reshapes the islet:
//     node --import tsx client/src/world/pois/lobby-islet/bake.mts      (rewrites the GY block in place)
// The pad centre (0, 1020) (frame lx≈-27, d≈90) is kept clear: loot / gear / the parked plane are staged there.
import type { Box, Surface } from "../world/colliders";
import * as dmath from "../sim/dmath";

/** frame origin (world x/z) and heading: yaw rotates +X (frame right) about +Y, like Object3D.rotation.y */
export const FRAME = { x: -6.96, z: 924.1, yaw: (168 * Math.PI) / 180 };
export const PAD_Y = 2.5;
/** char-05-third-person set anchor (kong feet world xz + camera heading), shared by the set and its veg clearings */
export const TP_SET = { kong: [42.63, 1043.2] as [number, number], heading: -12 * Math.PI / 180 };
/** the char-02-lobby-island camera in the frame: position (lx, d), height (absolute), pitch down (rad), vertical fov (deg) */
export const CAM = { lx: 0, d: -3, y: 3.4, pitch: (3.5 * Math.PI) / 180, fov: 58 };

const cy = dmath.cos(FRAME.yaw), sy = dmath.sin(FRAME.yaw);
/** lobby frame → world [x, z] */
export function toWorld(lx: number, d: number): [number, number] {
  return [FRAME.x + lx * cy - d * sy, FRAME.z - lx * sy - d * cy];
}
/** world → lobby frame [lx, d] */
export function toFrame(x: number, z: number): [number, number] {
  const dx = x - FRAME.x, dz = z - FRAME.z;
  return [dx * cy - dz * sy, -dx * sy - dz * cy];
}
/** local yaw → world yaw (Object3D.rotation.y) */
export const worldYaw = (a = 0) => FRAME.yaw + a;

export type LobbyKind =
  | "tiki" | "stool" | "chair" | "tramp" | "gallows" | "dummy" | "net" | "crate" | "barrel" | "banana-barrel"
  | "dock" | "post" | "plane" | "rock" | "palm" | "banana-plant" | "runway" | "windsock" | "pallet";

export interface LobbyItem {
  kind: LobbyKind;
  lx: number;
  d: number;
  /** local yaw (radians) */
  a?: number;
  /** ground height override (default: baked GY[id], else PAD_Y) */
  gy?: number;
  /** kind-specific size / variant parameters */
  w?: number; l?: number; h?: number; s?: number; v?: number;
  /** deck / top height (absolute, m above sea) for docks and posts */
  top?: number;
  id: string;
}

const A = (deg: number) => (deg * Math.PI) / 180;

/** frame position of an item-local point (x = item right, z = item FRONT = client +Z, toward the camera at a=0) */
export function itemLocal(it: { lx: number; d: number; a?: number }, x: number, z: number): [number, number] {
  const a = it.a ?? 0, ca = dmath.cos(a), sa = dmath.sin(a);
  return [it.lx + x * ca + z * sa, it.d + x * sa - z * ca];
}

// ------------------------------------------------------------------------------------------------ dimensions
// Shared dimensions (the client builders read the same numbers).
export const DIM = {
  tramp: { top: 0.86, pad: 0.28 },
  gallows: { postH: 3.55, beam: 1.45, bagY: 0.4, bagH: 1.55, bagR: 0.28 },
  dummy: { r: 0.42, len: 0.72, cy: 0.64 },
  net: { postH: 2.55, top: 2.43, band: 1.0 },
  /** floor = deck thickness above the deck base (gy); porch = extra deck in front of the counter (stools stand on it) */
  tiki: { counterH: 1.12, counterD: 0.62, postH: 2.7, floor: 0.12, porch: 1.1 },
  plane: { len: 28, fuseR: 2.1, fuseY: 3.3 },
  chair: { w: 0.72, l: 1.45 },
  dock: { thick: 0.4 },
  rock: { w: 34, d: 22, h: 24 },
};

// ------------------------------------------------------------------------------------------------ layout
const TIKI: LobbyItem = { kind: "tiki", id: "tiki", lx: -14.6, d: 19.6, a: A(24), w: 9.6, l: 5.6 };
const PLATFORM: LobbyItem = { kind: "dock", id: "platform", lx: 6.8, d: 6.6, a: A(13), w: 12.8, l: 7.4, top: 0.95 };
// the parked plane is turned 28° on the runway (side-on, both prop discs would be edge-on) so the camera sees it three-quarter from the front-left, nose toward the camera-left, props showing
const PLANE: LobbyItem = { kind: "plane", id: "plane", lx: 12.5, d: 33.5, a: A(14) }; // nose along item -X (left)
/** the runway centre line runs through the parked plane (at the runway's own heading, −14°) */
const RUNWAY: LobbyItem = (() => {
  const a = A(-14), t = (-8 - PLANE.lx) / dmath.cos(a);
  return { kind: "runway", id: "runway", lx: -8, d: PLANE.d + t * dmath.sin(a) + 1.0, a, l: 66, w: 16 };
})();

/** stools stand on the tiki porch, in front of the counter */
const stools: LobbyItem[] = [-3.3, -1.55, 0.25, 2.05].map((x, i) => {
  const [lx, d] = itemLocal(TIKI, x, (TIKI.l ?? 5.6) / 2 + 0.55);
  return { kind: "stool", id: `stool-${i}`, lx, d, a: TIKI.a, v: i };
});
/** dock posts around the platform (platform-local x, z-front) + tops */
const posts: LobbyItem[] = ([
  [-6.35, -3.65, 2.0], [-2.2, -3.65, 1.6], [2.3, -3.65, 1.9], [6.35, -3.65, 2.05],
  [-6.35, 0.0, 1.7], [-6.35, 3.65, 1.95], [6.35, 3.65, 1.6], [6.35, 0.0, 1.75],
] as Array<[number, number, number]>).map(([x, z, top], i) => {
  const [lx, d] = itemLocal(PLATFORM, x, z);
  return { kind: "post", id: `post-${i}`, lx, d, top };
});
const onPlatform = (x: number, z: number): [number, number] => itemLocal(PLATFORM, x, z);
const onPlane = (x: number, z: number): [number, number] => itemLocal(PLANE, x, z);

/** THE lobby layout. Visuals and colliders both come from this list. */
export const LOBBY: LobbyItem[] = [
  // ---- training toys (upper beach, packed close like the target art)
  { kind: "tramp", id: "tramp", lx: -2.9, d: 13.6, s: 1.75 },
  { kind: "gallows", id: "bag", lx: 0.7, d: 10.6, a: A(-10) },
  { kind: "dummy", id: "dummy-a", lx: 4.2, d: 12.6, a: A(-16) },
  { kind: "dummy", id: "dummy-b", lx: 4.0, d: 18.0, a: A(-4) },
  { kind: "dummy", id: "dummy-c", lx: 8.4, d: 16.4, a: A(-30) },
  { kind: "net", id: "net", lx: 13.8, d: 18.6, a: A(12), l: 7.4 },

  // ---- tiki bar (left) + its stools + barrels
  TIKI,
  ...stools,
  { kind: "barrel", id: "tiki-barrel-a", lx: -8.8, d: 22.6, v: 0 },
  { kind: "barrel", id: "tiki-barrel-b", lx: -8.1, d: 23.6, v: 1 },
  { kind: "crate", id: "tiki-crate", lx: -9.7, d: 24.0, a: A(20), s: 0.75 },

  // ---- beach front (sand slope)
  { kind: "chair", id: "chair", lx: -10.2, d: 11.6, a: A(38) },
  { kind: "banana-barrel", id: "beach-bbarrel", lx: -9.0, d: 8.9 },
  { kind: "crate", id: "beach-crate", lx: -11.6, d: 9.2, a: A(12), s: 0.7 },
  { kind: "banana-barrel", id: "tramp-bbarrel", lx: -6.6, d: 16.2 },

  // ---- dock (right foreground): a plank platform over the shallows + a gangway up to the sand
  PLATFORM,
  { kind: "dock", id: "gangway", ...xy(onPlatform(4.3, -(7.4 / 2 + 1.8))), a: A(13), w: 2.3, l: 3.6, top: 0.95 },
  ...posts,
  { kind: "crate", id: "dock-crate-a", ...xy(onPlatform(-2.9, -2.75)), a: A(18), s: 0.78, gy: 0.95 },
  { kind: "crate", id: "dock-crate-b", ...xy(onPlatform(-1.8, -3.0)), a: A(-8), s: 0.62, gy: 0.95 },
  { kind: "barrel", id: "dock-barrel", ...xy(onPlatform(-5.5, 2.5)), v: 2, gy: 0.95 },

  // ---- runway + parked plane + cargo
  RUNWAY,
  PLANE,
  { kind: "windsock", id: "windsock", lx: -27, d: 38 },
  { kind: "pallet", id: "cargo-pallet", ...xy(onPlane(8.5, 6.4)), a: A(-10) },
  { kind: "crate", id: "cargo-crate-a", ...xy(onPlane(7.9, 6.5)), a: A(-8), s: 1.0 },
  { kind: "crate", id: "cargo-crate-b", ...xy(onPlane(9.1, 6.3)), a: A(-14), s: 1.0 },
  { kind: "barrel", id: "cargo-barrel-a", ...xy(onPlane(10.8, 5.3)), v: 2 },
  { kind: "barrel", id: "cargo-barrel-b", ...xy(onPlane(11.4, 6.3)), v: 3 },
  { kind: "banana-barrel", id: "cargo-bbarrel", ...xy(onPlane(6.2, 6.1)) },
  // cargo-crate stair up the plane's flank to its roof: ground 2.5 → A 4.0 (mantle) → B 5.5 (mantle, stacked on B0) →
  // C 6.5 (pressed against the hull) → a 0.45 m auto-step onto the roof. Every crate has a ≥ 0.65 m landing strip.
  { kind: "crate", id: "stair-crate-a", ...xy(onPlane(-7.2, 3.0)), a: A(-4), s: 1.5 },
  { kind: "crate", id: "stair-crate-b0", ...xy(onPlane(-5.6, 3.0)), a: A(3), s: 1.5 },
  { kind: "crate", id: "stair-crate-b", ...xy(onPlane(-5.6, 3.0)), a: A(-5), s: 1.5, gy: 2.5 + 1.5 },
  { kind: "crate", id: "stair-crate-c", ...xy(onPlane(-5.2, 2.5)), a: A(2), s: 1.0, gy: 2.5 + 3.0 },
  { kind: "crate", id: "runway-crate", lx: -10.5, d: 33.4, a: A(-15), s: 0.8 },
  { kind: "barrel", id: "runway-barrel", lx: -9.3, d: 34.0, v: 1 },

  // ---- backdrop: rock outcrop + palms + banana plants (planted through the VegApi)
  { kind: "rock", id: "rock", lx: -55, d: 125, a: A(12), s: 1.5 },
  { kind: "palm", id: "palm-0", lx: -16.8, d: 11.2, a: A(-40), h: 12, v: 0 },
  { kind: "palm", id: "palm-1", lx: -24.5, d: 24.5, a: A(20), h: 10.5, v: 1 },
  { kind: "palm", id: "palm-2", lx: -9.5, d: 56, a: A(-10), h: 12, v: 2 },
  { kind: "palm", id: "palm-3", lx: -1, d: 62, a: A(35), h: 10, v: 3 },
  { kind: "palm", id: "palm-4", lx: 28, d: 30, a: A(-25), h: 11, v: 4 },
  { kind: "palm", id: "palm-5", lx: 34, d: 50, a: A(15), h: 10.5, v: 5 },
  { kind: "palm", id: "palm-6", lx: 22, d: 58, a: A(-5), h: 12.5, v: 6 },
  // clear of the runway edge (its trunk must not grow out of the asphalt)
  { kind: "palm", id: "palm-7", lx: -32, d: 56.5, a: A(40), h: 11, v: 7 },
  { kind: "palm", id: "palm-8", lx: -24, d: 92, a: A(-20), h: 12, v: 8 },
  { kind: "palm", id: "palm-9", lx: -62, d: 104, a: A(30), h: 11.5, v: 9 },
  { kind: "palm", id: "palm-10", lx: 8, d: 64, a: A(-30), h: 13, v: 10 },
  { kind: "palm", id: "palm-11", lx: 40, d: 44, a: A(-45), h: 11, v: 11 },
  { kind: "banana-plant", id: "bp-0", lx: -13.6, d: 8.6, a: A(10), s: 1.3 },
  { kind: "banana-plant", id: "bp-1", lx: -15.8, d: 13.2, a: A(80), s: 1.15 },
  { kind: "banana-plant", id: "bp-2", lx: -21.5, d: 16.5, a: A(40), s: 1.2 },
  { kind: "banana-plant", id: "bp-3", lx: -29, d: 56, a: A(0), s: 1.4 },
  { kind: "banana-plant", id: "bp-4", lx: -36, d: 100, a: A(60), s: 1.5 },
  { kind: "banana-plant", id: "bp-5", lx: 25, d: 29, a: A(-30), s: 1.0 },
  { kind: "banana-plant", id: "bp-6", lx: -19.5, d: 29.5, a: A(15), s: 1.15 },
];
function xy(p: [number, number]) { return { lx: p[0], d: p[1] }; }

// ------------------------------------------------------------------------------------------------ ground
/** frame sample points that decide an item's ground height, and how they combine */
export function footprint(it: LobbyItem): { pts: Array<[number, number]>; mode: "centre" | "max" | "min" | "mean" } {
  switch (it.kind) {
    case "tiki": {
      const W = (it.w ?? 9.6) + 0.6, D = (it.l ?? 5.6) + 0.6, P = DIM.tiki.porch, pts: Array<[number, number]> = [];
      for (let i = 0; i <= 4; i++) for (let j = 0; j <= 3; j++) pts.push(itemLocal(it, -W / 2 + (i / 4) * W, -D / 2 + (j / 3) * (D + P)));
      return { pts, mode: "max" };
    }
    case "tramp": {
      const r = (it.s ?? 1.8) * 0.95, pts: Array<[number, number]> = [[it.lx, it.d]];
      for (let i = 0; i < 6; i++) { const t = (i / 6) * Math.PI * 2; pts.push([it.lx + dmath.cos(t) * r, it.d + dmath.sin(t) * r]); }
      return { pts, mode: "mean" };
    }
    case "gallows": return { pts: [[it.lx, it.d], itemLocal(it, DIM.gallows.beam, 0)], mode: "mean" };
    case "plane": {
      const pts: Array<[number, number]> = [];
      for (const x of [-11.2, 1.0]) for (const z of [-1.9, 0, 1.9]) pts.push(itemLocal(it, x, z));
      return { pts, mode: "max" };
    }
    case "rock": {
      const s = it.s ?? 1, pts: Array<[number, number]> = [];
      for (const x of [-0.5, 0, 0.5]) for (const z of [-0.5, 0, 0.5]) pts.push(itemLocal(it, x * DIM.rock.w * s, z * DIM.rock.d * s));
      return { pts, mode: "min" };
    }
    case "chair": return { pts: [itemLocal(it, 0, 0.5), itemLocal(it, 0, -0.5)], mode: "mean" };
    default: return { pts: [[it.lx, it.d]], mode: "centre" };
  }
}
export function reduceGround(it: LobbyItem, h: (x: number, z: number) => number): number {
  const f = footprint(it), v = f.pts.map(([lx, d]) => { const [x, z] = toWorld(lx, d); return h(x, z); });
  if (f.mode === "max") return Math.max(...v);
  if (f.mode === "min") return Math.min(...v);
  if (f.mode === "mean") return v.reduce((s, x) => s + x, 0) / v.length;
  return v[0];
}

// BAKED GROUND — generated by client/src/world/pois/lobby-islet/bake.mts from the live terrain. Do not hand-edit.
// <GY>
const GY: Record<string, number> = {
  "tramp": 0.751,
  "bag": 0.292,
  "dummy-a": 0.353,
  "dummy-b": 0.882,
  "dummy-c": 0.453,
  "net": 0.642,
  "tiki": 2.281,
  "tiki-barrel-a": 2.068,
  "tiki-barrel-b": 2.143,
  "tiki-crate": 2.219,
  "chair": 0.661,
  "beach-bbarrel": 0.354,
  "beach-crate": 0.393,
  "tramp-bbarrel": 1.242,
  "plane": 2.500,
  "windsock": 2.500,
  "cargo-pallet": 1.113,
  "cargo-crate-a": 1.174,
  "cargo-crate-b": 1.051,
  "cargo-barrel-a": 0.968,
  "cargo-barrel-b": 0.826,
  "cargo-bbarrel": 1.375,
  "runway-crate": 2.500,
  "runway-barrel": 2.500,
  "rock": 1.160,
  "palm-0": 0.613,
  "palm-1": 2.354,
  "palm-2": 2.500,
  "palm-3": 2.500,
  "palm-4": 0.578,
  "palm-5": 1.799,
  "palm-6": 2.500,
  "palm-7": 2.500,
  "palm-8": 2.500,
  "palm-9": 2.500,
  "palm-10": 2.500,
  "palm-11": 0.745,
  "bp-0": 0.351,
  "bp-1": 0.829,
  "bp-2": 1.463,
  "bp-3": 2.500,
  "bp-4": 2.500,
  "bp-5": 0.903,
  "bp-6": 2.485,
};
// </GY>

/** ground height of an item (explicit gy > baked > pad) */
export function groundY(it: LobbyItem): number {
  if (it.gy !== undefined) return it.gy;
  if (it.kind === "stool") return (GY["tiki"] ?? PAD_Y) + DIM.tiki.floor;
  return GY[it.id] ?? PAD_Y;
}

// ------------------------------------------------------------------------------------------------ colliders
const box = (x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number, surf: Surface, extra: Partial<Box> = {}): Box =>
  ({ c: [x, y, z], h: [hx, hy, hz], yaw, surf, ...extra });

/** a box given in the item's local space (ox right, oz toward the item's FRONT / the camera), oy above its ground */
function localBox(it: LobbyItem, ox: number, oy: number, oz: number, hx: number, hy: number, hz: number, surf: Surface, extra: Partial<Box> = {}): Box {
  const [lx, d] = itemLocal(it, ox, oz);
  const [x, z] = toWorld(lx, d);
  return box(x, groundY(it) + oy, z, hx, hy, hz, worldYaw(it.a), surf, extra);
}

function itemColliders(it: LobbyItem): Box[] {
  const g = groundY(it);
  switch (it.kind) {
    case "tramp": {
      const r = it.s ?? 1.8, t = DIM.tramp.top;
      return [localBox(it, 0, t / 2, 0, r * 0.92, t / 2, r * 0.38, "fabric"), localBox(it, 0, t / 2, 0, r * 0.38, t / 2, r * 0.92, "fabric"),
        { ...localBox(it, 0, t / 2, 0, r * 0.7, t / 2, r * 0.7, "fabric"), yaw: worldYaw((it.a ?? 0) + Math.PI / 4) }];
    }
    case "gallows": {
      const G = DIM.gallows;
      return [localBox(it, 0, G.postH / 2, 0, 0.16, G.postH / 2, 0.16, "wood"),
        localBox(it, G.beam, G.bagY + G.bagH / 2, 0, G.bagR, G.bagH / 2, G.bagR, "fabric"),
        localBox(it, G.beam * 0.55, 0.05, 0, 0.95, 0.05, 0.55, "metal")];
    }
    case "dummy":
      return [localBox(it, 0, 0.6, 0, 0.42, 0.6, 0.42, "wood")];
    case "net": {
      const L = it.l ?? 9.6, N = DIM.net;
      return [localBox(it, -L / 2, N.postH / 2, 0, 0.1, N.postH / 2, 0.1, "wood"), localBox(it, L / 2, N.postH / 2, 0, 0.1, N.postH / 2, 0.1, "wood"),
        localBox(it, 0, N.top - N.band / 2, 0, L / 2, N.band / 2, 0.03, "fabric", { noShoot: true })];
    }
    case "tiki": {
      const W = it.w ?? 9.6, D = it.l ?? 5.6, T = DIM.tiki, P = T.porch;
      // solid deck block from below the lowest sand up to the floor top (the deck stands on piles over the slope)
      const out: Box[] = [
        localBox(it, 0, (T.floor - 1.2) / 2, P / 2, W / 2 + 0.3, (T.floor + 1.2) / 2, (D + P) / 2 + 0.3, "wood"),
        localBox(it, 0, T.floor + T.counterH / 2, D / 2 - 0.55, W / 2 - 0.35, T.counterH / 2, T.counterD / 2, "wood"),
        localBox(it, 0, T.floor + 1.1, -D / 2 + 0.35, W / 2 - 0.35, 1.1, 0.25, "wood"), // back shelving
      ];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(localBox(it, sx * (W / 2 - 0.15), T.floor + T.postH / 2, sz * (D / 2 - 0.15), 0.14, T.postH / 2, 0.14, "wood"));
      return out;
    }
    case "stool": return [localBox(it, 0, 0.37, 0, 0.21, 0.37, 0.21, "wood")];
    case "chair": return [localBox(it, 0, 0.3, 0, DIM.chair.w / 2, 0.3, DIM.chair.l / 2, "fabric")];
    case "crate": { const s = it.s ?? 0.8; return [localBox(it, 0, s / 2, 0, s / 2, s / 2, s / 2, "wood")]; }
    case "barrel": case "banana-barrel": return [localBox(it, 0, 0.47, 0, 0.32, 0.47, 0.32, "wood")];
    case "pallet": return [localBox(it, 0, 0.07, 0, 1.2, 0.07, 0.6, "wood")];
    case "dock": {
      const t = it.top ?? 1.25, w = it.w ?? 4, l = it.l ?? 10, T = DIM.dock.thick;
      const [x, z] = toWorld(it.lx, it.d);
      return [box(x, t - T / 2, z, w / 2, T / 2, l / 2, worldYaw(it.a), "wood")];
    }
    case "post": {
      const t = it.top ?? 1.6, [x, z] = toWorld(it.lx, it.d);
      return [box(x, (t - 1.5) / 2, z, 0.2, (t + 1.5) / 2, 0.2, worldYaw(), "wood")];
    }
    case "plane": {
      const P = DIM.plane;
      // the round fuselage as three stacked slabs (±0.15 m of the hull, no invisible corners) — its roof strip is
      // reached by the cargo-crate stair on its flank (playability: no deck reachable only from the air)
      const R = P.fuseR;
      // everything else the parked plane draws (so bullets don't pass through it), fitted to the model (actors/plane.ts,
      // measured in this item's frame): the wing in four spans a side (its dihedral), both engine nacelles + spinners,
      // the tailplane, the swept fin in four steps, the sponsons, the main + nose gear, the lowered ramp. The wing lies on
      // the roof: from the crate stair you climb onto it.
      const span = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => localBox(it, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2, "metal");
      const out: Box[] = [localBox(it, 0, P.fuseY - 0.2 * R, 0, P.len / 2, 0.75 * R, 0.95 * R, "metal"),
        localBox(it, 0, P.fuseY + 0.7 * R, 0, P.len / 2 - 0.6, 0.15 * R, 0.72 * R, "metal"),
        localBox(it, 0, P.fuseY + 0.925 * R, 0, P.len / 2 - 1.2, 0.075 * R, 0.4 * R, "metal")];
      out.push(span(-4.4, -0.4, 5.55, 6.34, -4.25, 4.25));
      for (const sd of [1, -1]) {
        const z = (a: number, b: number): [number, number] => sd > 0 ? [a, b] : [-b, -a];
        out.push(span(-4.4, -0.4, 5.66, 6.47, ...z(4.25, 8.5)), span(-4.3, -0.71, 5.9, 6.57, ...z(8.5, 12.75)), span(-4.13, -1.28, 6.18, 6.66, ...z(12.75, 17)));
        out.push(span(-7.0, 2.95, 4.12, 5.98, ...z(4.9, 6.7)), span(-8.3, -7.0, 4.6, 5.45, ...z(5.35, 6.25)));
        out.push(span(-4.47, 0.08, 0, 0.95, ...z(1.61, 2.17)));
      }
      out.push(span(11.0, 14.2, 5.1, 5.5, -6.3, 6.3));
      out.push(span(6.9, 9.0, 4.9, 6.4, -0.5, 0.5), span(9.0, 10.1, 4.9, 8.6, -0.5, 0.5), span(10.1, 11.2, 4.9, 11.0, -0.45, 0.45), span(11.2, 14.4, 4.9, 12.35, -0.36, 0.36));
      out.push(span(-5.25, 1.75, 0.88, 2.36, -2.68, 2.68));
      out.push(span(-11.56, -10.84, 0, 1.3, -0.32, 0.32));
      out.push(span(4.3, 6.2, 0, 0.62, -1.4, 1.4), span(6.2, 8.1, 0.45, 1.3, -1.4, 1.4), span(8.1, 10.1, 1.1, 1.9, -1.4, 1.4));
      return out;
    }
    case "rock": {
      const s = it.s ?? 1, R = DIM.rock;
      return [localBox(it, 0, R.h * 0.42 * s, 0, R.w * 0.36 * s, R.h * 0.42 * s, R.d * 0.34 * s, "stone"),
        localBox(it, -R.w * 0.3 * s, R.h * 0.22 * s, R.d * 0.1 * s, R.w * 0.22 * s, R.h * 0.22 * s, R.d * 0.3 * s, "stone"),
        localBox(it, R.w * 0.32 * s, R.h * 0.18 * s, -R.d * 0.05 * s, R.w * 0.18 * s, R.h * 0.18 * s, R.d * 0.3 * s, "stone")];
    }
    case "palm": { const [x, z] = toWorld(it.lx, it.d); return [box(x, g + 1.6, z, 0.24, 1.6, 0.24, 0, "wood")]; }
    case "windsock": { const [x, z] = toWorld(it.lx, it.d); return [box(x, g + 2.6, z, 0.08, 2.6, 0.08, 0, "metal")]; }
    default: return [];
  }
}

export const colliders: Box[] = LOBBY.flatMap(itemColliders);

/** areas vegetation / random scatter must leave clear (the POI dresses them itself). Circles or yaw-rotated rects. */
const TP_CLEAR: Array<{ x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number; yaw?: number }> = [];
export const clearings: Array<{ x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number; yaw?: number }> = (() => {
  const out: Array<{ x: number; z: number; r: number } | { x: number; z: number; hx: number; hz: number; yaw?: number }> = [];
  const rect = (lx: number, d: number, hx: number, hz: number, a = 0) => { const [x, z] = toWorld(lx, d); out.push({ x, z, hx, hz, yaw: worldYaw(a) }); };
  rect(-2, 20, 30, 15);                                        // beach front + toys + tiki + dock
  rect(RUNWAY.lx, RUNWAY.d, (RUNWAY.l ?? 70) / 2 + 6, (RUNWAY.w ?? 16) / 2 + 8, RUNWAY.a); // runway + plane
  { const [px, pz] = toWorld(PLANE.lx, PLANE.d); out.push({ x: px, z: pz, r: 19 }); }          // the parked plane (turned)
  rect(10, 30, 20, 8);                                         // between the toys and the runway (kongs run here)
  const rock = LOBBY.find((i) => i.kind === "rock")!;
  const [kx, kz] = toWorld(rock.lx, rock.d);
  out.push({ x: kx, z: kz, r: 20 });
  // char-05-third-person view set on the islet's east end (client/src/actors/tp-set.ts plants its own framing
  // plants): keep the scatter off the kong, out of the camera → kong corridor and out of the sightline to the hamlet
  const nBefore = out.length;
  {
    const [kx0, kz0] = TP_SET.kong, h = TP_SET.heading, f = [dmath.cos(h), dmath.sin(h)], r = [-dmath.sin(h), dmath.cos(h)];
    const at = (fw: number, rt: number): [number, number] => [kx0 + f[0] * fw + r[0] * rt, kz0 + f[1] * fw + r[1] * rt];
    const rectF = (fw: number, rt: number, hx: number, hz: number, turn = 0) => { const [x, z] = at(fw, rt); out.push({ x, z, hx, hz, yaw: h + turn }); };
    rectF(-0.9, 1.0, 3.2, 3.5);                                  // kong footprint + the camera → kong corridor + the right edge
    rectF(12, 3.2, 10, 6.5, 0.2);                                // sightline to the hamlet (near)
    rectF(30, 8.5, 9, 10, 0.26);                                 // sightline to the hamlet (far, stops short of it)
    rectF(-3.9, -10.5, 11.5, 5, -1.91);                           // toward the sun (NW, atmos default): trees there shaded the kong
  }
  // char-03-firefight view set on the islet's WEST beach (client/src/actors/firefight-set.ts, shot origin (−75, 995)
  // looking south): the camera corridor + the container set stay free of scatter (the set plants its own palms)
  out.push({ x: -83, z: 1023, hx: 22, hz: 32 });
  TP_CLEAR.push(...out.slice(nBefore));
  return out;
})();
/** point-in-clearing test for the char-05 set's clearings (the lobby's own dressing honours them too) */
export function inTpClearing(x: number, z: number) {
  for (const c of TP_CLEAR) {
    if ("r" in c) { if (dmath.pow(x - c.x, 2) + dmath.pow(z - c.z, 2) < c.r * c.r) return true; continue; }
    const cy = dmath.cos(c.yaw ?? 0), sy = dmath.sin(c.yaw ?? 0), lx = (x - c.x) * cy + (z - c.z) * sy, lz = -(x - c.x) * sy + (z - c.z) * cy;
    if (Math.abs(lx) < c.hx && Math.abs(lz) < c.hz) return true;
  }
  return false;
}
