// interiors — the shared ROOM-FURNISHING kit. Pure TS (no three.js): the client visuals
// (client/src/world/pois/_kit/interior*.ts) and the server colliders derive from the SAME deterministic layout, so the
// sofa you hide behind is exactly the box that stops the bullet.
//
//   const room: InteriorRoom = { x, y, z, yaw, w: 6, d: 5, h: 3, style: "house", role: "living", seed: 7,
//     openings: [{ side: 0, at: 0, w: 1.3, kind: "door" }, { side: 1, at: 0.5, w: 1.4, kind: "window" }] };
//   colliders.push(...interiorColliders([room]));        // shared/pois/<id>.ts (sim yaw convention, ready to use)
//   buildInteriors(ctx, [room], group);                  // client: client/src/world/pois/_kit/interior.ts
//
// Room frame: centre of the floor at (x, y, z) world (y = floor TOP), local +x right, +z "front"; `w` / `d` are the
// INNER extents (wall inner faces) along local x / z; `h` = floor top → ceiling. `yaw` is the three.js convention used
// by town-kit (world = R_y(yaw)·local: x' = x·cos + z·sin, z' = −x·sin + z·cos). Sides: 0 = +z wall, 1 = +x, 2 = −z,
// 3 = −x. An opening's `at` is its centre along the wall in local coords (local x on sides 0 / 2, local z on 1 / 3).
// Guarantees (checked by an audit): nothing is placed in a door corridor or a keep-out rect; every door,
// every `walk` keep-out and every loot slot is reachable by the kong capsule (PLAYER_R + 6 cm on a 0.2 m grid); no piece
// sits in front of a window above its sill; every collider stays inside the room.
import type { Box, Surface } from "../world/colliders";
import * as dmath from "../sim/dmath";

export type InteriorStyle = "house" | "shop" | "warehouse" | "lab" | "hut" | "cabin" | "temple";
export type RoomRole =
  | "living" | "kitchen" | "bedroom" | "studio" | "dining"      // house
  | "grocer" | "general"                                        // shop
  | "storage" | "workshop"                                      // warehouse
  | "server" | "office" | "bench" | "dock"                       // lab (dock = harbour / yard office)
  | "fisher" | "bunk"                                           // hut
  | "captain" | "crew"                                          // ship cabin
  | "shrine" | "ruin";                                          // temple
export type Side = 0 | 1 | 2 | 3;

export interface RoomOpening {
  side: Side;
  /** centre along the wall (local x on sides 0 / 2, local z on sides 1 / 3) */
  at: number;
  w: number;
  /** "gap" = an open archway / passage (kept clear like a door) */
  kind: "door" | "window" | "gap";
  /** bottom above the floor (default door 0, window 1.0) */
  y0?: number;
  /** height (default door 2.3, window 1.3) */
  h?: number;
}

/** what the client draws as architectural finish (defaults per style — see FINISH) */
export interface RoomFinish {
  floor: "planks" | "boards" | "tiles" | "checker" | "concrete" | "stone" | "deck" | "none";
  /** wall colour on the inner faces (null = leave the POI's walls as they are) */
  wall: string | null;
  /** what the inner wall skin is: painted plaster, horizontal timber panelling, or dressed stone blocks */
  wallMat: "plaster" | "panel" | "stone";
  /** lower wall band (wainscot) colour, or null */
  dado: string | null;
  baseboard: boolean;
  /** "grid" = drop ceiling: acoustic tiles on T-bars with flush light panels + vents (shops, labs, offices) */
  ceiling: "plaster" | "beams" | "planks" | "grid" | "none";
  /** frames / casings around the openings (inner face) */
  frames: boolean;
  /** lit shell (client): a closed shop / lab / house / hut room whose POI passes `ceiling: "none"` still gets the kit's
   *  ceiling LINER hung just under the POI's ceiling (shop / lab: drop ceiling + light panels; house: plaster; hut: boards
   *  + beams) and shops / labs whose POI passes `wall: null` get the kit's wall paint + dado — so a POI never ships a black
   *  box by accident. `shell: false` = the POI really draws its own finished ceiling / walls. Default true. */
  shell?: boolean;
  /** glass panes in the windows (set false if the POI already glazes them) */
  glass: boolean;
  /** curtains beside the windows (house / cabin) */
  curtains: boolean;
}

export interface InteriorRoom {
  id?: string;
  x: number; y: number; z: number; yaw: number;
  w: number; d: number; h: number;
  style: InteriorStyle;
  role?: RoomRole;
  seed: number;
  openings: RoomOpening[];
  /** local rects [x0, z0, x1, z1] kept free of furniture (stairs, landings, hatches, columns). walk = must stay reachable;
   *  solid = the POI has something there the kong cannot walk through (a stair side, a column, a counter): the kit's
   *  reachability grid treats it as a wall */
  keepOut?: Array<[number, number, number, number] | { r: [number, number, number, number]; walk?: boolean; solid?: boolean }>;
  /** 0..1 amount of optional furniture / clutter (default 1) */
  density?: number;
  /** override parts of the style's finish */
  finish?: Partial<RoomFinish>;
  /** wall thickness the frames should wrap (default 0.25) */
  wallT?: number;
  /** no ceiling finish / pendants (open to a roof, or the ceiling is drawn by the POI) — default false */
  openTop?: boolean;
  /** room-local rects [x0, z0, x1, z1] where the ceiling is OPEN (stair wells, hatches): the
   *  kit's ceiling / lit-shell liner / drop-ceiling tiles / beams / light panels skip them (client only — no colliders) */
  ceilHoles?: Array<[number, number, number, number]>;
  /** Actual floor openings: light pools and floor finishes must not bridge a stair well. */
  floorHoles?: Array<[number, number, number, number]>;
  /** underground / under a vault: no window sun patches, a dimmer fill (client only) */
  dark?: boolean;
}

export type ItemKind =
  // house
  | "bed" | "nightstand" | "dresser" | "wardrobe" | "bookshelf" | "sofa" | "armchair" | "coffee-table" | "table" | "chair"
  | "counter" | "sink" | "stove" | "fridge" | "upper-cab" | "rug" | "picture" | "plant" | "floor-lamp" | "table-lamp"
  | "pendant" | "tv-stand" | "mirror" | "clock" | "wall-shelf"
  // shop
  | "shop-counter" | "register" | "shelf-goods" | "fruit-display" | "cooler" | "sacks" | "shop-sign"
  // warehouse
  | "rack" | "crate" | "crate-stack" | "barrel" | "pallet" | "workbench" | "forklift" | "toolboard"
  // lab
  | "server-rack" | "desk" | "monitor" | "office-chair" | "lab-bench" | "locker" | "whiteboard" | "cable-tray"
  // hut / cabin
  | "hammock" | "net" | "wood-stove" | "stool" | "mat" | "lantern" | "captain-desk" | "map-table" | "sea-chest" | "chart"
  // temple
  | "brazier" | "altar" | "urn" | "rubble" | "idol" | "pillar" | "banner"
  // any style: small floor dressing (≤ 0.5 m, steppable), a side table, a water cooler, a statue
  | "clutter" | "side-table" | "water-cooler" | "statue"
  // hero / theme pieces: house focal wall, captain's plunder, lab neon, warehouse floor marking, temple columns
  | "fireplace" | "tv" | "treasure" | "chandelier" | "runner" | "neon" | "hazard" | "column"
  // wall-hung / sill dressing (small rooms), dock office
  | "wall-cab" | "coat-rack" | "sill-pot" | "filing" | "radio" | "life-ring";

export interface InteriorItem {
  kind: ItemKind;
  /** room-local position of the footprint centre (x, z) and the base height above the floor top (y) */
  x: number; y: number; z: number;
  /** room-local yaw (three.js); the item's FRONT is its local +z */
  yaw: number;
  /** size: w along item-local x, h up, d along item-local z */
  w: number; h: number; d: number;
  /** 0..1 variation seed for the visual */
  v: number;
  /** palette slot (style palette index) */
  c: number;
  /** collision class: 0 = none (visual), 1 = blocks movement / bullets */
  col: 0 | 1;
}

export interface LootSlots {
  /** [x, y, z, yaw] world; yaw (three.js) turns the chest's +z front into the room */
  chests: Array<[number, number, number, number]>;
  floor: Array<[number, number, number]>;
}

export interface InteriorLayout {
  room: InteriorRoom;
  role: RoomRole;
  finish: RoomFinish;
  items: InteriorItem[];
  /** sim-convention boxes (yaw already negated) — hand straight to the server's collider list */
  colliders: Box[];
  loot: LootSlots;
  /** reachable free area (m²) and whether every door / walk keep-out / loot slot is connected */
  stats: { free: number; reachable: number; connected: boolean; tries: number; why?: Record<string, number> };
}

// ------------------------------------------------------------------------------------------------ constants
/** capsule radius + margin used for the reachability grid (shared/sim/const PLAYER_R = 0.42 → passages ≥ 1.1 m) */
const CLEAR_R = 0.55;   // every passage ≥ 1.1 m wide (capsule 0.84 + ~13 cm each side): no tight squeezes
const CELL = 0.2;
const WALL_GAP = 0.03;

export const STYLE_ROLES: Record<InteriorStyle, RoomRole[]> = {
  house: ["living", "kitchen", "bedroom", "studio", "dining"],
  shop: ["grocer", "general"],
  warehouse: ["storage", "workshop"],
  lab: ["server", "office", "bench", "dock"],
  hut: ["fisher", "bunk"],
  cabin: ["captain", "crew"],
  temple: ["shrine", "ruin"],
};

export const FINISH: Record<InteriorStyle, RoomFinish> = {
  house: { floor: "planks", wallMat: "plaster", wall: "#e6d4b0", dado: null, baseboard: true, ceiling: "plaster", frames: true, glass: true, curtains: true },
  shop: { floor: "checker", wallMat: "plaster", wall: "#f3e7c9", dado: "#5fa39a", baseboard: true, ceiling: "grid", frames: true, glass: true, curtains: false },
  warehouse: { floor: "concrete", wallMat: "plaster", wall: null, dado: "#c9b27a", baseboard: false, ceiling: "beams", frames: true, glass: true, curtains: false },
  lab: { floor: "tiles", wallMat: "plaster", wall: "#e9eef0", dado: "#3f5f6b", baseboard: true, ceiling: "grid", frames: true, glass: true, curtains: false },
  hut: { floor: "boards", wallMat: "panel", wall: "#c9a877", dado: null, baseboard: false, ceiling: "beams", frames: true, glass: false, curtains: false },
  cabin: { floor: "deck", wallMat: "panel", wall: "#d9b48a", dado: null, baseboard: true, ceiling: "beams", frames: true, glass: true, curtains: true },
  temple: { floor: "stone", wallMat: "stone", wall: "#cbbf9f", dado: null, baseboard: false, ceiling: "none", frames: false, glass: false, curtains: false },
};

/** wall-mounted (flat) or hanging: never collide */
const DECOR: ReadonlySet<ItemKind> = new Set(["picture", "mirror", "clock", "wall-shelf", "toolboard", "whiteboard", "net", "chart", "banner", "shop-sign", "pendant", "lantern", "cable-tray", "rug", "mat", "table-lamp", "monitor", "register",
  "tv", "chandelier", "runner", "neon", "hazard", "wall-cab", "coat-rack", "sill-pot", "radio", "life-ring"]);
/** flat on the floor (no footprint that blocks anything, never counted as floor clutter) */
export const FLAT: ReadonlySet<ItemKind> = new Set(["rug", "mat", "runner", "hazard"]);

export function itemSurface(k: ItemKind, style: InteriorStyle): Surface {
  switch (k) {
    case "fridge": case "stove": case "cooler": case "rack": case "forklift": case "server-rack": case "locker": case "wood-stove": case "brazier": case "barrel": case "filing":
      return k === "barrel" && (style === "hut" || style === "cabin") ? "wood" : "metal";
    case "bed": case "sofa": case "armchair": case "hammock": case "sacks": return "fabric";
    case "altar": case "urn": case "rubble": case "idol": case "pillar": case "statue": case "fireplace": return "stone";
    case "column": return style === "temple" ? "stone" : "wood";
    case "fruit-display": return "wood";
    default: return "wood";
  }
}

// ------------------------------------------------------------------------------------------------ rng / math
export function interiorRng(seed: number) {
  let a = (seed * 2654435761) >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
type Rng = () => number;
const pick = <T>(r: Rng, a: readonly T[]): T => a[Math.floor(r() * a.length) % a.length];
const HALF_PI = Math.PI / 2;


// ------------------------------------------------------------------------------------------------ groups
/** a furniture group in its own frame: x along the wall (centred), z out from the wall (0 = against it), y up */
interface Part { kind: ItemKind; x: number; z: number; y?: number; yaw?: number; w: number; h: number; d: number; c?: number; col?: 0 | 1; /** dropped (not the whole group) when it would cover a window */ opt?: boolean }
interface Group { w: number; d: number; parts: Part[]; /** extra free depth in front that must stay walkable */ front?: number; /** height of the group near the wall (window test) */ tall?: number; tag?: string }

const P = (kind: ItemKind, x: number, z: number, w: number, h: number, d: number, o: Partial<Part> = {}): Part => ({ kind, x, z, w, h, d, ...o });

// house
const gBed = (r: Rng, dbl: boolean): Group => {
  const w = dbl ? 1.75 : 1.15, d = 2.15;
  const parts: Part[] = [P("bed", 0, d / 2, w, 1.05, d, { c: Math.floor(r() * 4) })];
  const side = r() < 0.5 ? -1 : 1;
  parts.push(P("nightstand", side * (w / 2 + 0.3), 0.24, 0.52, 0.58, 0.46, { c: 0 }));
  parts.push(P("table-lamp", side * (w / 2 + 0.3), 0.24, 0.3, 0.45, 0.3, { y: 0.58, col: 0, opt: true }));
  if (dbl && r() < 0.6) { parts.push(P("nightstand", -side * (w / 2 + 0.3), 0.24, 0.52, 0.58, 0.46, { c: 0 })); }
  const gw = w + (parts.length > 3 ? 1.24 : 0.62) ;
  // re-centre when only one nightstand
  if (parts.length === 3) for (const p of parts) p.x -= side * 0.31;
  return { w: gw, d, parts, front: 0.7, tall: 1.05, tag: "bed" };
};
const gSolo = (kind: ItemKind, w: number, h: number, d: number, o: Partial<Group> & { c?: number } = {}): Group =>
  ({ w, d, parts: [P(kind, 0, d / 2, w, h, d, { c: o.c ?? 0 })], front: o.front ?? 0.7, tall: h, tag: kind });
const gDresser = (r: Rng): Group => {
  const g = gSolo("dresser", 1.25, 0.92, 0.52, { c: Math.floor(r() * 3) });
  if (r() < 0.6) g.parts.push(P("table-lamp", 0.35, 0.26, 0.28, 0.42, 0.28, { y: 0.95, col: 0, opt: true }));
  return g;
};
const gSofa = (r: Rng, lamp = true, rug = true): Group => {
  // sofa against the wall, rug + coffee table in front, a floor lamp at one end
  const w = 2.15 + r() * 0.3, e = r() < 0.5 ? -1 : 1;
  const parts: Part[] = [P("sofa", 0, 0.47, w, 0.84, 0.94, { c: Math.floor(r() * 4) }),
    ...(rug ? [P("rug", 0, 1.35, Math.min(2.8, w + 0.5), 0.02, 1.9, { c: Math.floor(r() * 4), col: 0 }),
      P("coffee-table", (r() - 0.5) * 0.2, 1.6, 1.1, 0.42, 0.6, { c: Math.floor(r() * 3) })] : [])];
  if (lamp) parts.push(P("floor-lamp", e * (w / 2 + 0.3), 0.3, 0.42, 1.75, 0.42, { opt: true }));
  const gw = w + (lamp ? 0.62 : 0) + 0.1;
  if (lamp) for (const q of parts) q.x -= e * 0.31;
  return { w: rug ? Math.max(gw, Math.min(2.8, w + 0.5)) : gw, d: rug ? 2.3 : 0.95, parts, front: rug ? 0.5 : 1.0, tall: 1.75, tag: "sofa" };
};
const gKitchen = (r: Rng, len: number): Group => {
  // counter run along the wall: fridge | counters with a sink | stove | counters; upper cabinets above
  const n = Math.max(2, Math.min(5, Math.floor((len - 0.9) / 0.8)));
  const parts: Part[] = [];
  const total = 0.9 + n * 0.8;
  let x = -total / 2;
  const fridgeLeft = r() < 0.5;
  const mods: ItemKind[] = [];
  for (let i = 0; i < n; i++) mods.push(i === Math.floor(n / 2) ? "stove" : i === (fridgeLeft ? n - 1 : 0) ? "sink" : "counter");
  if (fridgeLeft) { parts.push(P("fridge", x + 0.45, 0.39, 0.86, 1.95, 0.76)); x += 0.9; }
  for (const k of mods) { parts.push(P(k, x + 0.4, 0.33, 0.8, 0.95, 0.64)); if (k !== "stove" || r() < 0.5) parts.push(P("upper-cab", x + 0.4, 0.18, 0.8, 0.72, 0.36, { y: 1.52, col: 0, opt: true })); x += 0.8; }
  if (!fridgeLeft) parts.push(P("fridge", x + 0.45, 0.39, 0.86, 1.95, 0.76));
  return { w: total, d: 0.78, parts, front: 1.0, tall: 2.24, tag: "kitchen" };
};
const gTableSet = (r: Rng, big: boolean): Group => {
  const tw = big ? 1.7 : 1.15, td = big ? 0.95 : 0.9;
  const parts: Part[] = [P("table", 0, 0, tw, 0.78, td, { c: Math.floor(r() * 3) })];
  const cx = big ? [-0.42, 0.42] : [0];
  for (const x of cx) {
    parts.push(P("chair", x + (r() - 0.5) * 0.08, td / 2 + 0.3, 0.5, 0.98, 0.5, { yaw: Math.PI + (r() - 0.5) * 0.3 }));
    parts.push(P("chair", x + (r() - 0.5) * 0.08, -td / 2 - 0.3, 0.5, 0.98, 0.5, { yaw: (r() - 0.5) * 0.3 }));
  }
  if (big && r() < 0.5) parts.push(P("chair", tw / 2 + 0.32, 0, 0.5, 0.98, 0.5, { yaw: -HALF_PI + (r() - 0.5) * 0.3 }));
  // centre groups: frame centred on the table (d counts the chairs)
  const d = td + 1.25;
  for (const p of parts) p.z += d / 2;
  return { w: tw + (parts.length > 5 ? 0.9 : 0.2), d, parts, tag: "table" };
};
const gLounge = (r: Rng): Group => {
  // rug + coffee table + an armchair (centre group)
  const parts: Part[] = [P("rug", 0, 1.0, 2.6, 0.02, 1.9, { c: Math.floor(r() * 4), col: 0 }), P("coffee-table", 0, 0.95, 1.1, 0.42, 0.62)];
  if (r() < 0.75) parts.push(P("armchair", (r() < 0.5 ? -1 : 1) * 1.05, 1.1, 0.92, 0.88, 0.88, { yaw: (r() < 0.5 ? 1 : -1) * HALF_PI * 0.8, c: Math.floor(r() * 4) }));
  return { w: 3.0, d: 2.0, parts, tag: "lounge" };
};

/** small floor dressing against a wall; v picks the variant (books, basket, box, bucket, bottles, boots, pot, rolls) */
const gClutter = (r: Rng, style: InteriorStyle): Group => {
  const w = 0.45 + r() * 0.2, d = 0.4 + r() * 0.1;
  return { w: w + 0.05, d: d + 0.04, parts: [P("clutter", 0, d / 2 + 0.02, w, 0.3 + r() * 0.18, d, { yaw: (r() - 0.5) * 0.5, c: STYLE_IDX[style] })], front: 0.3, tall: 0.5, tag: "clutter" };
};
const STYLE_IDX: Record<InteriorStyle, number> = { house: 0, shop: 1, warehouse: 2, lab: 3, hut: 4, cabin: 5, temple: 6 };
const gFireplace = (r: Rng): Group => ({ w: 1.8, d: 0.6, parts: [P("fireplace", 0, 0.29, 1.6, 1.3, 0.56, { c: Math.floor(r() * 3) })], front: 1.2, tall: 1.3, tag: "fireplace" });
const gTvWall = (r: Rng): Group => ({ w: 1.8, d: 0.5, parts: [P("tv-stand", 0, 0.24, 1.7, 0.62, 0.48, { c: Math.floor(r() * 2) }), P("tv", 0, 0.22, 1.1, 0.72, 0.12, { y: 0.62, col: 0 })], front: 1.4, tall: 1.34, tag: "tv" });
const gFiling = (r: Rng, n = 2): Group => ({ w: n * 0.5 + 0.04, d: 0.66, parts: Array.from({ length: n }, (_, i) => P("filing", (i - (n - 1) / 2) * 0.5, 0.32, 0.48, 1.32, 0.62, { c: Math.floor(r() * 3) })), front: 0.9, tall: 1.32, tag: "filing" });
const gSideTable = (r: Rng): Group => ({ w: 0.6, d: 0.55, parts: [P("side-table", 0, 0.27, 0.52, 0.6, 0.5, { c: Math.floor(r() * 4) }), P("table-lamp", 0.05, 0.25, 0.28, 0.44, 0.28, { y: 0.6, col: 0, opt: true, c: Math.floor(r() * 6) })], front: 0.4, tall: 1.04, tag: "side" });

// shop
const gShopCounter = (r: Rng, len: number): Group => {
  // back shelf against the wall, a 1.15 m aisle for the shopkeeper, the counter in front; one end open (reachable)
  const w = Math.min(3.0, Math.max(1.8, len * 0.45)), gw = w + 1.15, e = r() < 0.5 ? -1 : 1, cx = -e * 1.15 / 2;
  return { w: gw, d: 2.35, parts: [
    P("shelf-goods", 0, 0.23, Math.min(gw - 0.2, 2.6), 1.95, 0.45, { c: Math.floor(r() * 4) }),
    P("shop-counter", cx, 1.97, w, 1.05, 0.74, { c: Math.floor(r() * 3), yaw: 0 }),
    P("register", cx - e * (w / 2 - 0.45), 1.95, 0.42, 0.34, 0.4, { y: 1.05, col: 0, yaw: Math.PI }),
  ], front: 1.2, tall: 1.95, tag: "counter" };
};
const gShelfGoods = (r: Rng): Group => gSolo("shelf-goods", 1.8, 1.95, 0.5, { c: Math.floor(r() * 4), front: 0.9 });
const gFruit = (r: Rng): Group => ({ w: 1.5, d: 1.0, parts: [P("fruit-display", 0, 0.5, 1.45, 0.95, 0.98, { c: Math.floor(r() * 4) })], front: 0.8, tall: 0.95, tag: "fruit" });

// warehouse
const gRack = (r: Rng, len: number): Group => ({ w: len, d: 1.05, parts: [P("rack", 0, 0.52, len, 2.7, 1.02, { c: Math.floor(r() * 3) })], front: 1.8, tall: 2.7, tag: "rack" });
const gCrates = (r: Rng): Group => {
  const parts: Part[] = [];
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const s = 0.8 + r() * 0.3, stack = r() < 0.45;
    parts.push(P(stack ? "crate-stack" : "crate", (i - (n - 1) / 2) * 1.1 + (r() - 0.5) * 0.1, 0.55, s, stack ? s * 2 : s, s, { yaw: (r() - 0.5) * 0.25, c: Math.floor(r() * 4) }));
  }
  return { w: n * 1.1 + 0.1, d: 1.15, parts, front: 0.5, tall: 1.8, tag: "crates" };
};
const gBarrels = (r: Rng, stack = false): Group => {
  const n = 2 + Math.floor(r() * 3), parts: Part[] = [];
  for (let i = 0; i < n; i++) parts.push(P("barrel", (i % 2 === 0 ? -0.36 : 0.36) + Math.floor(i / 2) * 0.04, i < 2 ? 0.36 : 1.04, 0.64, 0.95, 0.64, { c: Math.floor(r() * 4), yaw: r() * 6 }));
  // a second tier on the back pair (warehouse hero stack: cover at head height)
  if (stack) parts.push(P("barrel", -0.36, 0.36, 0.62, 0.92, 0.62, { y: 0.95, c: Math.floor(r() * 4), yaw: r() * 6 }), P("barrel", 0.36, 0.36, 0.62, 0.92, 0.62, { y: 0.95, c: Math.floor(r() * 4), yaw: r() * 6 }));
  return { w: 1.4, d: n > 2 ? 1.42 : 0.74, parts, front: 0.5, tall: stack ? 1.9 : 0.95, tag: "barrels" };
};
const gWorkbench = (r: Rng): Group => ({ w: 1.95, d: 0.8, parts: [P("workbench", 0, 0.4, 1.9, 0.95, 0.78, { c: Math.floor(r() * 2) }), P("toolboard", 0, 0.03, 1.6, 0.95, 0.05, { y: 1.25, col: 0, opt: true })], front: 1.0, tall: 2.2, tag: "workbench" });
const gForklift = (r: Rng): Group => { const g = { w: 1.3, d: 2.9, parts: [P("forklift", 0, 1.45, 1.22, 2.15, 2.85, { yaw: 0, c: Math.floor(r() * 2) })], tag: "forklift" }; return g; };
const gPallet = (r: Rng): Group => ({ w: 1.25, d: 1.05, parts: [P("pallet", 0, 0.52, 1.2, 0.16, 1.0, { yaw: (r() - 0.5) * 0.3, col: 0 }), ...(r() < 0.7 ? [P("sacks", 0, 0.52, 1.1, 0.38, 0.9, { y: 0.16, c: Math.floor(r() * 3) })] : [])], front: 0.4, tall: 0.6, tag: "pallet" });

// lab
const gServers = (r: Rng, n: number): Group => {
  const parts: Part[] = [];
  for (let i = 0; i < n; i++) parts.push(P("server-rack", (i - (n - 1) / 2) * 0.72, 0.5, 0.7, 2.1, 1.0, { c: Math.floor(r() * 2) }));
  return { w: n * 0.72 + 0.04, d: 1.02, parts, front: 1.4, tall: 2.1, tag: "servers" };
};
const gDesk = (r: Rng): Group => ({ w: 1.6, d: 1.45, parts: [P("desk", 0, 0.38, 1.55, 0.76, 0.76, { c: Math.floor(r() * 2) }), P("monitor", (r() - 0.5) * 0.3, 0.22, 0.62, 0.48, 0.2, { y: 0.76, col: 0 }), P("office-chair", (r() - 0.5) * 0.3, 1.05, 0.62, 1.05, 0.62, { yaw: Math.PI + (r() - 0.5) * 0.6, c: Math.floor(r() * 2) })], front: 0.5, tall: 1.25, tag: "desk" });
const gLabBench = (r: Rng): Group => ({ w: 2.45, d: 0.82, parts: [P("lab-bench", 0, 0.41, 2.4, 0.95, 0.8, { c: Math.floor(r() * 2) })], front: 1.0, tall: 0.95, tag: "bench" });
const gLockers = (r: Rng): Group => { const n = 3 + Math.floor(r() * 2); return { w: n * 0.46 + 0.04, d: 0.52, parts: Array.from({ length: n }, (_, i) => P("locker", (i - (n - 1) / 2) * 0.46, 0.26, 0.45, 1.95, 0.5, { c: Math.floor(r() * 3) })), front: 0.9, tall: 1.95, tag: "lockers" }; };

// hut / cabin
const gStove = (): Group => ({ w: 0.9, d: 0.8, parts: [P("wood-stove", 0, 0.42, 0.66, 0.92, 0.62)], front: 0.6, tall: 0.95, tag: "stove" });
const gHutTable = (r: Rng): Group => {
  const parts: Part[] = [P("table", 0, 0, 1.1, 0.74, 0.8, { c: 3 })];
  parts.push(P("stool", -0.35 + r() * 0.1, 0.72, 0.42, 0.46, 0.42, { yaw: r() }));
  parts.push(P("stool", 0.35 - r() * 0.1, -0.72, 0.42, 0.46, 0.42, { yaw: r() }));
  const d = 2.0; for (const p of parts) p.z += d / 2;
  return { w: 1.4, d, parts, tag: "table" };
};
const gHammock = (len: number, r: Rng): Group => ({ w: len, d: 0.9, parts: [P("hammock", 0, 0.45, len, 1.3, 0.85, { c: Math.floor(r() * 3) })], front: 0.5, tall: 1.3, tag: "hammock" });
const gCaptainDesk = (r: Rng): Group => ({ w: 1.9, d: 1.6, parts: [P("captain-desk", 0, 0.45, 1.75, 0.82, 0.9), P("lantern", 0.6, 0.35, 0.26, 0.42, 0.26, { y: 0.82, col: 0, opt: true }), P("chair", (r() - 0.5) * 0.3, 1.3, 0.52, 1.05, 0.52, { yaw: Math.PI + (r() - 0.5) * 0.4, c: 3 })], front: 0.4, tall: 1.2, tag: "desk" });
const gMapTable = (r: Rng): Group => { const d = 2.2; return { w: 2.4, d, parts: [P("map-table", 0, d / 2, 1.6, 0.9, 1.05, { yaw: (r() - 0.5) * 0.1 })], tag: "maptable" }; };
const gChest = (r: Rng): Group => gSolo("sea-chest", 1.0, 0.6, 0.56, { c: Math.floor(r() * 3), front: 0.6 });

// temple
const gAltar = (r: Rng): Group => ({ w: 2.2, d: 1.3, parts: [P("altar", 0, 0.62, 2.1, 1.05, 1.15, { c: 0 }), P("idol", 0, 0.5, 0.75, 1.25, 0.5, { y: 1.05, c: Math.floor(r() * 2) })], front: 1.2, tall: 2.3, tag: "altar" });
const gStatue = (c = 1): Group => ({ w: 1.0, d: 1.0, parts: [P("statue", 0, 0.5, 0.85, 2.1, 0.8, { c })], tall: 2.1, front: 0.4, tag: "statue" });
const gUrn = (r: Rng): Group => ({ w: 0.6, d: 0.6, parts: [P("urn", 0, 0.3, 0.5, 0.75 + r() * 0.3, 0.5, { c: Math.floor(r() * 2) })], tall: 1.05, tag: "urn" });
const gRubble = (r: Rng): Group => ({ w: 1.6, d: 1.2, parts: [P("rubble", 0, 0.6, 1.5, 0.42, 1.1, { yaw: (r() - 0.5) * 0.8, c: Math.floor(r() * 3) })], front: 0.3, tall: 0.45, tag: "rubble" });
const gPillar = (r: Rng): Group => ({ w: 0.85, d: 0.85, parts: [P("pillar", 0, 0.42, 0.8, 1.2 + r() * 1.2, 0.8, { c: Math.floor(r() * 2) })], tall: 2.4, tag: "pillar" });

// ------------------------------------------------------------------------------------------------ the placer
interface Rect { x0: number; z0: number; x1: number; z1: number }
interface Placed { rect: Rect; items: InteriorItem[]; side: Side | -1 }

class Placer {
  items: InteriorItem[] = [];
  used: Placed[] = [];
  keep: Rect[] = [];
  /** the strip in front of each wall group (access space) — later footprints keep out of it */
  fronts: Rect[] = [];
  walkPts: Array<[number, number]> = [];
  doorPts: Array<[number, number]> = [];
  /** loot-chest fronts (0.9 m in front of each reserved chest): must stay reachable like the doors */
  chestPts: Array<[number, number]> = [];
  /** POI keep-outs the kong cannot walk through (`solid: true`) */
  solids: Rect[] = [];
  tries = 0;
  gridW: number; gridD: number;
  curtains: boolean;
  constructor(public room: InteriorRoom, public r: Rng) {
    this.curtains = room.finish?.curtains ?? FINISH[room.style].curtains;
    const { w, d } = room;
    this.gridW = Math.max(1, Math.round(w / CELL)); this.gridD = Math.max(1, Math.round(d / CELL));
    for (const o of room.openings) {
      if (o.kind === "window") continue;
      // corridor from the door into the room (the BFS guarantees the rest of the path): 1.25 m deep, ≥ 1.1 m wide
      // temples: a door / passage keeps a clear aisle straight across the room (halls and galleries are thoroughfares)
      const across = o.side % 2 === 0 ? d : w;
      const half = Math.max(o.w, 1.0) / 2 + 0.06, thorough = room.style === "temple" && Math.max(w, d) >= 9 && Math.max(w, d) / Math.min(w, d) > 1.35 && across === Math.min(w, d);
      const deep = thorough ? across - 0.05 : Math.min(1.25, across * 0.4);
      const [ax, az] = wallPoint(room, o.side, o.at, 0), [nx, nz] = inward(o.side);
      // (e.g. the hotel lobby: bays open to each other along a 12 m side) a WIDE open side is not a door: a
      // 1.25 m strip along all of it would leave a 2.9 m bay 0.4 m to furnish. It keeps a 1.2 m crossing every ~3.2 m instead
      // (each must stay reachable, like a door) and furniture may stand between them
      if (o.kind === "gap" && o.w >= 3.2 && room.style !== "temple") {
        const n = Math.max(2, Math.round(o.w / 3.2)), dd = Math.min(1.0, across * 0.35);
        for (let k = 0; k < n; k++) {
          const at = o.at - o.w / 2 + (k + 0.5) * (o.w / n), [px, pz] = wallPoint(room, o.side, at, 0);
          const tx = o.side % 2 === 0 ? 0.66 : 0, tz = o.side % 2 === 0 ? 0 : 0.66;
          this.keep.push(norm({ x0: px - tx, z0: pz - tz, x1: px + nx * dd + tx, z1: pz + nz * dd + tz }));
          this.doorPts.push([px + nx * 0.62, pz + nz * 0.62]);
        }
        continue;
      }
      const ex = ax + nx * deep, ez = az + nz * deep;
      const tx = o.side % 2 === 0 ? half : 0, tz = o.side % 2 === 0 ? 0 : half;
      this.keep.push(norm({ x0: ax - tx, z0: az - tz, x1: ex + tx, z1: ez + tz }));
      this.doorPts.push([ax + nx * 0.62, az + nz * 0.62]);
    }
    for (const k of room.keepOut ?? []) {
      const kk = Array.isArray(k) ? { r: k, walk: false, solid: false } : k;
      const rc = norm({ x0: kk.r[0], z0: kk.r[1], x1: kk.r[2], z1: kk.r[3] });
      this.keep.push({ x0: rc.x0 - 0.15, z0: rc.z0 - 0.15, x1: rc.x1 + 0.15, z1: rc.z1 + 0.15 });
      if (kk.walk) this.walkPts.push([(rc.x0 + rc.x1) / 2, (rc.z0 + rc.z1) / 2]);
      else if (kk.solid) this.solids.push(rc);
    }
  }
  wallLen(s: Side) { return s % 2 === 0 ? this.room.w : this.room.d; }
  /** openings on side s as intervals along the wall */
  openings(s: Side) { return this.room.openings.filter((o) => o.side === s); }

  /** transform group parts to room-local items at a wall (side, along) or at a free point (side -1, x, z, yaw) */
  materialise(g: Group, side: Side | -1, a: number, cz = 0, yawC = 0): { rect: Rect; items: InteriorItem[] } {
    let ox: number, oz: number, yaw: number;
    if (side >= 0) { [ox, oz] = wallPoint(this.room, side as Side, a, WALL_GAP); yaw = sideYaw(side as Side); }
    else { yaw = yawC; const c = dmath.cos(yaw), s = dmath.sin(yaw); ox = a - (g.d / 2) * s; oz = cz - (g.d / 2) * c; }
    const c = dmath.cos(yaw), s = dmath.sin(yaw);
    const T = (x: number, z: number): [number, number] => [ox + x * c + z * s, oz - x * s + z * c];
    const pts = [T(-g.w / 2, 0), T(g.w / 2, 0), T(-g.w / 2, g.d), T(g.w / 2, g.d)];
    const rect = { x0: Math.min(...pts.map((p) => p[0])), z0: Math.min(...pts.map((p) => p[1])), x1: Math.max(...pts.map((p) => p[0])), z1: Math.max(...pts.map((p) => p[1])) };
    const items = g.parts.map((p) => {
      const [x, z] = T(p.x, p.z);
      return { kind: p.kind, x, y: p.y ?? 0, z, yaw: yaw + (p.yaw ?? 0), w: p.w, h: p.h, d: p.d, v: this.r(), c: p.c ?? 0, col: (p.col ?? (DECOR.has(p.kind) ? 0 : 1)) as 0 | 1, opt: !!p.opt };
    }).filter((it) => !(it.opt && this.coversWindow(it))).map(({ opt: _o, ...it }) => it as InteriorItem);
    // the footprint covers every part (a chair pushed out, a rug wider than the sofa)
    for (const it of items) { const q = itemRect(it); rect.x0 = Math.min(rect.x0, q.x0); rect.z0 = Math.min(rect.z0, q.z0); rect.x1 = Math.max(rect.x1, q.x1); rect.z1 = Math.max(rect.z1, q.z1); }
    return { rect, items };
  }

  /** why the last candidate was rejected (debug counters) */
  why: Record<string, number> = {};
  private no(k: string) { this.why[k] = (this.why[k] ?? 0) + 1; return false; }
  fits(rect: Rect, side: Side | -1, g: Group, a: number, items: InteriorItem[] = []): boolean {
    const { w, d } = this.room;
    const m = 0.02;
    if (rect.x0 < -w / 2 - m || rect.x1 > w / 2 + m || rect.z0 < -d / 2 - m || rect.z1 > d / 2 + m) return this.no("bounds");
    for (const k of this.keep) if (overlap(rect, k, 0.02)) return this.no("keep");
    for (const u of this.used) if (overlap(rect, u.rect, 0.04)) return this.no("used");
    // no furniture across a door / gap on its own wall
    if (side >= 0) for (const o of this.openings(side as Side)) {
      const lo = a - g.w / 2, hi = a + g.w / 2;
      if (hi > o.at - o.w / 2 - 0.05 && lo < o.at + o.w / 2 + 0.05 && o.kind !== "window") return this.no("door");
    }
    // nothing above a window's sill stands in front of it (own wall or a corner window on the perpendicular wall)
    for (const it of items) if (this.coversWindow(it)) return this.no("window");
    for (const f of this.fronts) if (overlap(rect, f, 0)) return this.no("front");
    return true;
  }

  /** the group's footprint without materialising its parts (cheap pre-check) */
  groupRect(g: Group, side: Side | -1, a: number, cz: number, yawC: number): Rect {
    let ox: number, oz: number, yaw: number;
    if (side >= 0) { [ox, oz] = wallPoint(this.room, side as Side, a, WALL_GAP); yaw = sideYaw(side as Side); }
    else { yaw = yawC; ox = a - (g.d / 2) * dmath.sin(yaw); oz = cz - (g.d / 2) * dmath.cos(yaw); }
    const c = dmath.cos(yaw), s = dmath.sin(yaw);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of [[-g.w / 2, 0], [g.w / 2, 0], [-g.w / 2, g.d], [g.w / 2, g.d]]) {
      const px = ox + x * c + z * s, pz = oz - x * s + z * c;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (pz < z0) z0 = pz; if (pz > z1) z1 = pz;
    }
    return { x0, z0, x1, z1 };
  }
  place(g: Group, side: Side | -1, a: number, cz = 0, yawC = 0, reach = true): boolean {
    this.tries++;
    {
      const pre = this.groupRect(g, side, a, cz, yawC), { w, d } = this.room;
      if (pre.x0 < -w / 2 - 0.02 || pre.x1 > w / 2 + 0.02 || pre.z0 < -d / 2 - 0.02 || pre.z1 > d / 2 + 0.02) return this.no("bounds");
      for (const k of this.keep) if (overlap(pre, k, 0.02)) return this.no("keep");
      for (const u of this.used) if (overlap(pre, u.rect, 0.04)) return this.no("used");
      for (const f of this.fronts) if (overlap(pre, f, 0)) return this.no("front");
    }
    const { rect, items } = this.materialise(g, side, a, cz, yawC);
    if (!this.fits(rect, side, g, a, items)) return false;
    // front clearance: the strip in front of a wall group must not be taken by another footprint
    if (side >= 0 && g.front) {
      const fr = this.frontRect(side as Side, a, g.w, g.d, g.front);
      for (const u of this.used) if (overlap(fr, u.rect, 0)) return this.no("frontclear");
    }
    const entry: Placed = { rect, items, side };
    this.used.push(entry);
    if (reach && !this.connected()) { this.used.pop(); return this.no("reach"); }
    if (side >= 0 && g.front) this.fronts.push(this.frontRect(side as Side, a, g.w, g.d, Math.min(g.front, 0.7)));
    return true;
  }
  frontRect(s: Side, a: number, gw: number, gd: number, f: number): Rect {
    const [ax, az] = wallPoint(this.room, s, a, WALL_GAP + gd), [nx, nz] = inward(s);
    const tx = s % 2 === 0 ? gw / 2 : 0, tz = s % 2 === 0 ? 0 : gw / 2;
    return norm({ x0: ax - tx, z0: az - tz, x1: ax + nx * f + tx, z1: az + nz * f + tz });
  }

  /** try a wall group on the given sides; slides along each wall from a random start. */
  wall(g: Group, sides: Side[] = this.sidesByPreference(), o: { centred?: boolean } = {}): boolean {
    for (const s of sides) {
      const L = this.wallLen(s), lo = -L / 2 + g.w / 2 + WALL_GAP, hi = L / 2 - g.w / 2 - WALL_GAP;
      if (hi < lo) continue;
      const cand: number[] = [];
      if (o.centred) cand.push(0);
      const n = Math.max(1, Math.floor((hi - lo) / 0.15));
      const start = Math.floor(this.r() * (n + 1));
      for (let i = 0; i <= n; i++) cand.push(lo + ((start + i) % (n + 1)) * ((hi - lo) / n || 0));
      if (hi - lo < 1e-3) cand.push(lo);
      for (const a of cand) if (this.place(g, s, a)) return true;
    }
    return false;
  }
  /** reserve a loot-chest slot against a wall (1.0 × 0.62, front reachable). Recipes call it after their core pieces */
  chests: Array<[number, number, number]> = [];
  reserveChest(atLeast = 99): boolean {
    if (this.chests.length >= atLeast) return true;
    const g: Group = { w: 1.05, d: 0.66, parts: [P("sea-chest", 0, 0.33, 1.0, 0.6, 0.62, { col: 1 })], front: 0.8, tall: 0.62 };
    for (const s of this.sidesByPreference()) {
      const L = this.wallLen(s);
      for (const a of [L * 0.3, -L * 0.3, 0, L * 0.42, -L * 0.42, L * 0.15, -L * 0.15].map((v) => v * (this.r() < 0.5 ? 1 : -1))) {
        if (Math.abs(a) > L / 2 - 0.56) continue;
        const before = this.used.length, nf = this.fronts.length;
        if (this.place(g, s, a)) {
          if (this.acceptChest(before)) return true;
          this.used.splice(before, 1); this.fronts.length = nf;
        }
      }
    }
    return false;
  }
  /** the chest just placed at used[before] (still drawn as a blocker until the end: a gameplay object stands there) —
   *  its front (0.9 m ahead, where the kong opens it) must be reachable now and after every later placement */
  acceptChest(before: number): boolean {
    const it = this.used[before].items[0];
    (it as InteriorItem & { chest?: boolean }).chest = true;
    this.chestPts.push([it.x + dmath.sin(it.yaw) * 0.9, it.z + dmath.cos(it.yaw) * 0.9]);
    if (!this.connected()) { this.chestPts.pop(); return false; }
    this.chests.push([it.x, it.z, it.yaw]);
    return true;
  }
  coversWindow(it: InteriorItem): boolean {
    for (const o of this.room.openings) {
      if (o.kind !== "window") continue;
      const y0 = o.y0 ?? 1.0;
      if (it.y + it.h <= y0 - 0.03 || it.y >= y0 + (o.h ?? 1.3)) continue;
      const [ax, az] = wallPoint(this.room, o.side, o.at, 0), [nx, nz] = inward(o.side);
      // curtains hang up to 0.45 m beside the window (house / cabin finish): keep tall pieces clear of them too
      const m = this.curtains ? 0.47 : 0.04;
      const tx = o.side % 2 === 0 ? o.w / 2 + m : 0, tz = o.side % 2 === 0 ? 0 : o.w / 2 + m;
      if (overlap(itemRect(it), norm({ x0: ax - tx, z0: az - tz, x1: ax + nx * 0.4 + tx, z1: az + nz * 0.4 + tz }), 0)) return true;
    }
    return false;
  }
  /** corner-hugging variant: try both ends of each wall first */
  corner(g: Group, sides: Side[] = this.sidesByPreference()): boolean {
    for (const s of sides) {
      const L = this.wallLen(s), e = L / 2 - g.w / 2 - WALL_GAP;
      if (e < 0) continue;
      for (const a of this.r() < 0.5 ? [e, -e] : [-e, e]) if (this.place(g, s, a)) return true;
    }
    return false;
  }
  /** free-standing group: tries a lattice from the room centre outward (yaw 0 or 90°) */
  centre(g: Group, o: { yaws?: number[]; jitter?: number } = {}): boolean {
    const { w, d } = this.room;
    const j = o.jitter ?? 0.4;
    const ox = (this.r() - 0.5) * j, oz = (this.r() - 0.5) * j;
    const pts: Array<[number, number, number]> = [];
    for (let z = -d / 2; z <= d / 2; z += 0.25) for (let x = -w / 2; x <= w / 2; x += 0.25) pts.push([x, z, (x - ox) * (x - ox) + (z - oz) * (z - oz)]);
    pts.sort((p, q) => p[2] - q[2]);
    const yaws = o.yaws ?? (w >= d ? [0, HALF_PI] : [HALF_PI, 0]);
    for (let i = 0; i < Math.min(260, pts.length); i++) for (const y of yaws) if (this.place(g, -1, pts[i][0], pts[i][1], y)) return true;
    return false;
  }
  /** wall decor (no footprint): on side s at height y0, width ww; avoids openings and tall pieces on that wall */
  decor(kind: ItemKind, ww: number, hh: number, y0: number, sides: Side[] = this.sidesByPreference(), c = 0): boolean {
    for (const s of sides) {
      const L = this.wallLen(s), lim = L / 2 - ww / 2 - 0.25;
      if (lim < 0) continue;
      const cands = [0, lim * 0.5, -lim * 0.5, lim, -lim, lim * 0.25, -lim * 0.25].map((v) => v + (this.r() - 0.5) * 0.2);
      for (const a of cands) if (this.decorAt(kind, s, a, ww, hh, y0, c)) return true;
    }
    return false;
  }
  /** can wall decor go on side s at `along` a (ww wide, y0..y0+hh)? */
  decorFree(s: Side, a: number, ww: number, hh: number, y0: number, depth = 0.8): boolean {
    const L = this.wallLen(s);
    if (Math.abs(a) > L / 2 - ww / 2 - 0.12) return false;
    for (const o of this.openings(s)) if (a + ww / 2 > o.at - o.w / 2 - 0.2 && a - ww / 2 < o.at + o.w / 2 + 0.2) return false;
    const [px, pz] = wallPoint(this.room, s, a, 0);
    const probe = s % 2 === 0 ? { x0: a - ww / 2, z0: pz - depth, x1: a + ww / 2, z1: pz + depth } : { x0: px - depth, z0: a - ww / 2, x1: px + depth, z1: a + ww / 2 };
    // Floor furniture keep-outs also protect the player above a rising flight.
    // A shelf or life ring at chest height cannot occupy its wall-side lane.
    for (const k of this.room.keepOut ?? []) {
      if (Array.isArray(k) || !k.walk) continue;
      const r = { x0: k.r[0], z0: k.r[1], x1: k.r[2], z1: k.r[3] };
      if (overlap(r, probe, 0.05)) return false;
    }
    for (const u of this.used) for (const it of u.items) {
      if (FLAT.has(it.kind)) continue;
      // anything reaching up into the decor band (floor pieces by their top, decor by its own band)
      if (it.y + it.h <= y0 - 0.02 || it.y >= y0 + hh + 0.05) continue;
      if (overlap(itemRect(it), probe, 0.05)) return false;
    }
    return true;
  }
  decorAt(kind: ItemKind, s: Side, a: number, ww: number, hh: number, y0: number, c = 0, force = false): boolean {
    if (!force && !this.decorFree(s, a, ww, hh, y0)) return false;
    const [x, z] = wallPoint(this.room, s, a, 0.035);
    const it: InteriorItem = { kind, x, y: y0, z, yaw: sideYaw(s), w: ww, h: hh, d: 0.06, v: this.r(), c, col: 0 };
    // decor footprints never block floor pieces
    this.used.push({ rect: { x0: 1e9, z0: 1e9, x1: 1e9, z1: 1e9 }, items: [it], side: s });
    return true;
  }
  /** a flat floor piece (runner, hazard marking): no footprint, drawn under whatever stands on it */
  flat(kind: ItemKind, x: number, z: number, yaw: number, w: number, d: number, c = 0) {
    this.used.push({ rect: { x0: 1e9, z0: 1e9, x1: 1e9, z1: 1e9 }, items: [{ kind, x, y: 0, z, yaw, w, h: 0.02, d, v: this.r(), c, col: 0 }], side: -1 });
  }
  /** a pot / bottle / book stack on a window sill (frames on: the kit's sill; the sill board is 0.13 m deep) */
  sill(o: RoomOpening, c = 0): boolean {
    if (o.kind !== "window" || (o.y0 ?? 1.0) < 0.6 || (o.y0 ?? 1.0) > 1.6 || o.w < 0.8) return false;
    const frames = this.room.finish?.frames ?? FINISH[this.room.style].frames;
    if (!frames) return false;
    const a = o.at + (this.r() < 0.5 ? -1 : 1) * (o.w / 2 - 0.2);
    for (const u of this.used) for (const it of u.items) if (it.kind === "sill-pot" && dmath.hypot(it.x - wallPoint(this.room, o.side, a, 0.06)[0], it.z - wallPoint(this.room, o.side, a, 0.06)[1]) < 0.4) return false;
    const [x, z] = wallPoint(this.room, o.side, a, 0.065);
    this.used.push({ rect: { x0: 1e9, z0: 1e9, x1: 1e9, z1: 1e9 }, items: [{ kind: "sill-pot", x, y: o.y0 ?? 1.0, z, yaw: sideYaw(o.side), w: 0.22, h: 0.3, d: 0.12, v: this.r(), c, col: 0 }], side: o.side });
    return true;
  }
  /** the along-wall coordinate + side of the item placed last (for decor centred above it) */
  lastAt(): { s: Side; a: number } | null {
    const u = this.used[this.used.length - 1];
    if (!u || u.side < 0 || !u.items.length) return null;
    const it = u.items[0], s = u.side as Side;
    return { s, a: s % 2 === 0 ? it.x : it.z };
  }
  count(): number { let n = 0; for (const u of this.used) for (const it of u.items) if (!(it as InteriorItem & { chest?: boolean }).chest) n++; return n; }
  /** pieces a player reads as furniture: no rugs / runners / mats / hazard marks (the density rule counts these) */
  pieces(): number { let n = 0; for (const u of this.used) for (const it of u.items) if (!(it as InteriorItem & { chest?: boolean }).chest && !FLAT.has(it.kind)) n++; return n; }
  /** ceiling-hung item at a free spot (no footprint) */
  hang(kind: ItemKind, x: number, z: number, h: number, ww = 0.4) {
    const top = this.room.h, { w, d } = this.room;
    // keep ≥ 0.4 m (+ half the fixture) clear of a stove pipe and of anything reaching up to the fixture
    const clear = (px: number, pz: number) => {
      for (const u of this.used) for (const it of u.items) {
        if (it.kind !== "wood-stove" && it.y + it.h < top - h - 0.05) continue;
        if (it.kind === "pendant" || it.kind === "lantern" || it.kind === "chandelier" || it.kind === "cable-tray") continue;
        const r = itemRect(it), m = 0.4 + ww / 2;
        if (px > r.x0 - m && px < r.x1 + m && pz > r.z0 - m && pz < r.z1 + m) return false;
      }
      return Math.abs(px) < w / 2 - ww / 2 - 0.1 && Math.abs(pz) < d / 2 - ww / 2 - 0.1;
    };
    let bx = x, bz = z;
    if (!clear(x, z)) {
      let found = false;
      for (let rr = 0.3; rr < Math.max(w, d) && !found; rr += 0.3) for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2, px = x + dmath.cos(a) * rr, pz = z + dmath.sin(a) * rr;
        if (clear(px, pz)) { bx = px; bz = pz; found = true; break; }
      }
      if (!found) return false;
    }
    this.used.push({ rect: { x0: 1e9, z0: 1e9, x1: 1e9, z1: 1e9 }, items: [{ kind, x: bx, y: top - h, z: bz, yaw: 0, w: ww, h, d: ww, v: this.r(), c: 0, col: 0 }], side: -1 });
    return true;
  }
  sidesByPreference(): Side[] {
    const s: Side[] = [0, 1, 2, 3];
    const doors = (x: Side) => this.room.openings.filter((o) => o.side === x && o.kind !== "window").length * 2 + this.room.openings.filter((o) => o.side === x && o.kind === "window").length;
    const key = s.map((x) => doors(x) + this.r() * 0.9);
    return s.sort((a, b) => key[a] - key[b]);
  }

  // ---------------------------------------------------------------- reachability
  private wallMask: Uint8Array | null = null;
  blocked(): Uint8Array {
    const { w, d } = this.room;
    const W = this.gridW, D = this.gridD, cw = w / W, cd = d / D;
    if (!this.wallMask) {
      const m = new Uint8Array(W * D);
      for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
        const x = -w / 2 + (i + 0.5) * cw, z = -d / 2 + (j + 0.5) * cd;
        let wall = Math.abs(x) > w / 2 - CLEAR_R || Math.abs(z) > d / 2 - CLEAR_R;
        // walls (except in front of doors: the capsule stands in the doorway)
        if (wall) for (const o of this.room.openings) {
          if (o.kind === "window") continue;
          const along = o.side % 2 === 0 ? x : z, across = o.side % 2 === 0 ? z : x;
          const edge = o.side === 0 ? d / 2 : o.side === 1 ? w / 2 : o.side === 2 ? -d / 2 : -w / 2;
          if (Math.abs(along - o.at) < o.w / 2 - CLEAR_R + 0.08 && Math.abs(across - edge) < CLEAR_R + 0.1) wall = false;
        }
        if (!wall) for (const r of this.solids) {
          const dx = Math.max(r.x0 - x, 0, x - r.x1), dz = Math.max(r.z0 - z, 0, z - r.z1);
          if (dx * dx + dz * dz < CLEAR_R * CLEAR_R) { wall = true; break; }
        }
        if (wall) m[j * W + i] = 1;
      }
      this.wallMask = m;
    }
    const g = this.wallMask.slice();
    const R2 = CLEAR_R * CLEAR_R;
    for (const u of this.used) for (const it of u.items) {
      if (it.col === 0) continue;
      if (it.y + it.h <= 0.5 || it.y > 1.85) continue;   // ≤ 0.5 m = the capsule steps over it (STEP_H 0.55)
      const r = itemRect(it);
      const i0 = Math.max(0, Math.floor((r.x0 - CLEAR_R + w / 2) / cw)), i1 = Math.min(W - 1, Math.floor((r.x1 + CLEAR_R + w / 2) / cw));
      const j0 = Math.max(0, Math.floor((r.z0 - CLEAR_R + d / 2) / cd)), j1 = Math.min(D - 1, Math.floor((r.z1 + CLEAR_R + d / 2) / cd));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const c = j * W + i;
        if (g[c]) continue;
        const x = -w / 2 + (i + 0.5) * cw, z = -d / 2 + (j + 0.5) * cd;
        // rounded corners: the capsule is round
        const dx = Math.max(r.x0 - x, 0, x - r.x1), dz = Math.max(r.z0 - z, 0, z - r.z1);
        if (dx * dx + dz * dz < R2) g[c] = 1;
      }
    }
    return g;
  }
  cellOf(x: number, z: number): number {
    const { w, d } = this.room;
    const i = Math.max(0, Math.min(this.gridW - 1, Math.floor((x + w / 2) / (w / this.gridW))));
    const j = Math.max(0, Math.min(this.gridD - 1, Math.floor((z + d / 2) / (d / this.gridD))));
    return j * this.gridW + i;
  }
  /** flood fill from every door (or the walk points / the room centre); returns the reach mask + blocked grid.
   *  every seed floods — a room its POI splits into bays with solid keep-outs (temple halls / galleries)
   *  is reachable from each of its doors, not only from the first */
  reach(): { reach: Uint8Array; blocked: Uint8Array; seedOk: boolean } {
    const b = this.blocked();
    const lab = this.label(b, this.seeds());
    const reach = new Uint8Array(b.length);
    for (let c = 0; c < b.length; c++) if (lab.cell[c] > 0) reach[c] = 1;
    return { reach, blocked: b, seedOk: lab.pt.some((l) => l > 0) };
  }
  private seeds(): Array<[number, number]> { return this.doorPts.length ? this.doorPts : this.walkPts.length ? this.walkPts : [[0, 0]]; }
  /** components of the free cells reached from `pts` (label per cell, 0 = not reached) + each point's label (0 = blocked) */
  private label(b: Uint8Array, pts: Array<[number, number]>): { cell: Int32Array; pt: number[] } {
    const W = this.gridW, D = this.gridD, cell = new Int32Array(W * D), pt: number[] = [];
    let next = 0;
    for (const p of pts) {
      const st = this.nearestFree(b, p[0], p[1]);
      if (st < 0) { pt.push(0); continue; }
      if (cell[st]) { pt.push(cell[st]); continue; }
      const L = ++next, q = [st]; cell[st] = L; pt.push(L);
      while (q.length) {
        const c = q.pop()!, i = c % W, j = (c / W) | 0;
        if (i > 0 && !cell[c - 1] && !b[c - 1]) { cell[c - 1] = L; q.push(c - 1); }
        if (i < W - 1 && !cell[c + 1] && !b[c + 1]) { cell[c + 1] = L; q.push(c + 1); }
        if (j > 0 && !cell[c - W] && !b[c - W]) { cell[c - W] = L; q.push(c - W); }
        if (j < D - 1 && !cell[c + W] && !b[c + W]) { cell[c + W] = L; q.push(c + W); }
      }
    }
    return { cell, pt };
  }
  nearestFree(b: Uint8Array, x: number, z: number): number {
    const W = this.gridW, D = this.gridD, { w, d } = this.room, cw = w / W, cd = d / D;
    const ci = Math.floor((x + w / 2) / cw), cj = Math.floor((z + d / 2) / cd), k = Math.ceil(0.5 / Math.min(cw, cd));
    let best = -1, bd = 0.5;   // within 0.5 m
    for (let j = Math.max(0, cj - k); j <= Math.min(D - 1, cj + k); j++) for (let i = Math.max(0, ci - k); i <= Math.min(W - 1, ci + k); i++) {
      const c = j * W + i;
      if (b[c]) continue;
      const dd = dmath.hypot(-w / 2 + (i + 0.5) * cw - x, -d / 2 + (j + 0.5) * cd - z);
      if (dd < bd) { bd = dd; best = c; }
    }
    return best;
  }
  /** the empty room's structure (before any furniture): which door / walk points share a component, and how
   *  many free cells no seed reaches (a bay its POI walled off) — furniture must not change either */
  private base: { pt: number[]; pockets: number } | null = null;
  private pockets(b: Uint8Array, cell: Int32Array): number { let n = 0; for (let c = 0; c < b.length; c++) if (!b[c] && !cell[c]) n++; return n; }
  connected(): boolean {
    const pts = [...this.seeds(), ...(this.doorPts.length ? this.walkPts : [])];
    if (!this.base) {
      const keep = this.used; this.used = [];
      const b0 = this.blocked(), l0 = this.label(b0, pts);
      this.base = { pt: l0.pt, pockets: this.pockets(b0, l0.cell) };
      this.used = keep;
    }
    const b = this.blocked(), lab = this.label(b, pts);
    if (!lab.pt.some((l) => l > 0)) return this.doorPts.length === 0;
    // every point that was free stays free, and points that shared a component still do
    for (let i = 0; i < pts.length; i++) {
      if (this.base.pt[i] && !lab.pt[i]) return false;
      for (let j = 0; j < i; j++) if (this.base.pt[i] && this.base.pt[i] === this.base.pt[j] && lab.pt[i] !== lab.pt[j]) return false;
    }
    // a loot chest's front lies in a component a door reaches
    for (const p of this.chestPts) { const c = this.nearestFree(b, p[0], p[1]); if (c < 0 || !lab.cell[c]) return false; }
    // no sealed pockets bigger than a cell or two (loot / players must not end up behind a sofa wall)
    return this.pockets(b, lab.cell) <= this.base.pockets + 3;
  }
}

function norm(r: Rect): Rect { return { x0: Math.min(r.x0, r.x1), z0: Math.min(r.z0, r.z1), x1: Math.max(r.x0, r.x1), z1: Math.max(r.z0, r.z1) }; }
function overlap(a: Rect, b: Rect, m: number) { return a.x0 < b.x1 + m && a.x1 > b.x0 - m && a.z0 < b.z1 + m && a.z1 > b.z0 - m; }
/** point on the inner face of side s at `along`, pushed `off` metres into the room */
function wallPoint(room: { w: number; d: number }, s: Side, along: number, off: number): [number, number] {
  switch (s) {
    case 0: return [along, room.d / 2 - off];
    case 1: return [room.w / 2 - off, along];
    case 2: return [along, -room.d / 2 + off];
    default: return [-room.w / 2 + off, along];
  }
}
function inward(s: Side): [number, number] { return s === 0 ? [0, -1] : s === 1 ? [-1, 0] : s === 2 ? [0, 1] : [1, 0]; }
/** yaw (three.js) that turns a group's +z (away from the wall) into the room */
function sideYaw(s: Side): number { return s === 0 ? Math.PI : s === 1 ? -HALF_PI : s === 2 ? 0 : HALF_PI; }
/** room-local AABB of an item's footprint */
export function itemRect(it: { x: number; z: number; yaw: number; w: number; d: number }): Rect {
  const c = Math.abs(dmath.cos(it.yaw)), s = Math.abs(dmath.sin(it.yaw));
  const hx = (it.w * c + it.d * s) / 2, hz = (it.w * s + it.d * c) / 2;
  return { x0: it.x - hx, z0: it.z - hz, x1: it.x + hx, z1: it.z + hz };
}

// ------------------------------------------------------------------------------------------------ recipes
function autoRole(room: InteriorRoom, r: Rng): RoomRole {
  const area = room.w * room.d;
  switch (room.style) {
    case "house": return area < 14 ? "studio" : pick(r, ["living", "kitchen", "bedroom", "living", "bedroom"] as RoomRole[]);
    case "shop": return pick(r, ["grocer", "general"] as RoomRole[]);
    case "warehouse": return area < 30 ? "workshop" : "storage";
    case "lab": return pick(r, ["server", "office", "bench"] as RoomRole[]);
    case "hut": return pick(r, ["fisher", "bunk"] as RoomRole[]);
    case "cabin": return area > 16 ? "captain" : "crew";
    default: return area > 30 ? "shrine" : pick(r, ["shrine", "ruin"] as RoomRole[]);
  }
}

/** the longest kitchen run that fits (fridge + 2..5 modules), longest walls first */
function kitchenRun(p: Placer, maxLen: number): boolean {
  for (let len = maxLen; len >= 2.5; len -= 0.8) for (const s of p.sidesByPreference()) {
    if (p.wallLen(s) < len + 0.1) continue;
    if (p.wall(gKitchen(p.r, len), [s])) return true;
  }
  return false;
}

function recipe(p: Placer, role: RoomRole, dens: number) {
  const r = p.r, room = p.room;
  const opt = (q: number) => r() < q * dens;
  const longSides = (room.w >= room.d ? [0, 2] : [1, 3]) as Side[];
  const ceilingOf = (st: InteriorStyle) => room.finish?.ceiling ?? FINISH[st].ceiling;
  const hang = (kind: ItemKind, h: number) => { if (!room.openTop && room.h > 2.6) p.hang(kind, (r() - 0.5) * room.w * 0.2, (r() - 0.5) * room.d * 0.2, Math.min(h, room.h - 2.3)); };
  const pics = (n: number, kinds: ItemKind[] = ["picture"]) => {
    const seen = new Set<ItemKind>();
    for (let i = 0; i < n; i++) {
      const k = pick(r, kinds);
      if (k !== "picture" && seen.has(k)) continue;
      seen.add(k);
      const big = k === "picture" && r() < 0.4, sz: [number, number] = k === "clock" ? [0.42, 0.42] : k === "mirror" ? [0.55, 0.8] : k === "wall-shelf" ? [1.0, 0.3] : big ? [1.0, 0.7] : [0.6, 0.5];
      p.decor(k, sz[0], sz[1], k === "wall-shelf" ? 1.55 : 1.4 + r() * 0.15, undefined, Math.floor(r() * 6));
    }
  };
  const clutter = (n: number) => { for (let i = 0; i < n; i++) (r() < 0.5 ? p.corner(gClutter(r, room.style)) : false) || p.wall(gClutter(r, room.style)); };
  const plant = () => p.corner({ w: 0.6, d: 0.6, parts: [P("plant", 0, 0.3, 0.5, 1.2 + r() * 0.4, 0.5, { c: Math.floor(r() * 3) })], tall: 1.6, tag: "plant" });
  /** decor centred above the piece placed last (a mirror over the fireplace, a chart over the desk) */
  const above = (kind: ItemKind, ww: number, hh: number, y0: number, c = 0) => { const q = p.lastAt(); return q ? p.decorAt(kind, q.s, q.a, ww, hh, y0, c) : false; };
  const neonRow = room.style === "lab" ? 0 : room.style === "shop" ? 1 : 2;
  const neon = () => p.decor("neon", 1.5, 0.52, 1.85, undefined, neonRow) || p.decor("neon", 1.1, 0.42, 1.8, undefined, neonRow);
  switch (role) {
    case "living": {
      p.wall(gSofa(r), longSides) || p.wall(gSofa(r)) || p.wall(gSofa(r, true, false)) || p.wall(gSofa(r, false, false));
      if (!p.used.some((u) => u.items.some((i) => i.kind === "coffee-table"))) p.centre(gLounge(r), { jitter: 0.8 }) || p.centre({ w: 1.2, d: 0.7, parts: [P("coffee-table", 0, 0.35, 1.1, 0.42, 0.6)], tag: "ct" });
      p.reserveChest(1);
      // focal wall: a fireplace with a mirror / painting over it, else a TV wall
      if (p.wall(gFireplace(r), undefined, { centred: true })) above(r() < 0.5 ? "mirror" : "picture", 0.9, 0.7, 1.5, Math.floor(r() * 6));
      else p.wall(gTvWall(r));
      // a low sideboard (≤ sill height: it may stand under a window) + an armchair
      p.wall(gSolo("tv-stand", 1.5, 0.62, 0.48, { c: Math.floor(r() * 2), front: 1.0 }));
      p.wall(gSolo("armchair", 0.92, 0.88, 0.88, { c: Math.floor(r() * 4) }));
      if (opt(0.9)) p.wall(gSolo("bookshelf", 1.1, 2.0, 0.4, { c: Math.floor(r() * 3) }));
      p.wall(gSideTable(r));
      if (opt(0.6)) p.wall(gDresser(r));
      plant(); if (opt(0.7)) plant();
      clutter(2 + Math.floor(r() * 2));
      pics(2 + Math.floor(r() * 2), ["picture", "picture", "clock"]);
      if (opt(0.6)) p.decor("wall-shelf", 1.0, 0.3, 1.55);
      hang("pendant", 0.55);
      break;
    }
    case "kitchen": case "dining": {
      const k = role === "kitchen";
      if (k) kitchenRun(p, 4.6);
      p.centre(gTableSet(r, room.w * room.d > 16), { jitter: 0.5 });
      p.reserveChest(1);
      if (opt(0.8)) p.wall(gDresser(r));
      if (!k && opt(0.8)) p.wall(gSolo("bookshelf", 1.1, 2.0, 0.4, { c: Math.floor(r() * 3) }));
      if (!k) p.wall(gFireplace(r)) && above("picture", 0.9, 0.65, 1.5, Math.floor(r() * 6));
      if (opt(0.6)) p.wall(gCrates(r));
      if (k) p.decor("wall-shelf", 1.0, 0.3, 1.6);
      plant();
      clutter(2 + Math.floor(r() * 2));
      pics(1 + Math.floor(r() * 2), ["picture", "clock", "wall-shelf"]);
      hang("pendant", 0.7);
      break;
    }
    case "bedroom": {
      const dbl = room.w * room.d > 12;
      if (p.wall(gBed(r, dbl), p.sidesByPreference()) || p.wall(gBed(r, false))) above("picture", 1.0, 0.6, 1.45, Math.floor(r() * 6));
      p.reserveChest(1);
      p.wall(gSolo("wardrobe", 1.3, 2.1, 0.66, { c: Math.floor(r() * 3) }));
      p.wall(gDresser(r)) && above("mirror", 0.55, 0.8, 1.45);
      p.centre({ w: 2.2, d: 1.5, parts: [P("rug", 0, 0.75, 2.1, 0.02, 1.4, { c: Math.floor(r() * 4), col: 0 })], tag: "rug" }, { jitter: 0.8 });
      if (opt(0.8)) p.wall(gSideTable(r));
      if (opt(0.6)) p.wall(gSolo("armchair", 0.92, 0.88, 0.88, { c: Math.floor(r() * 4) }));
      if (opt(0.7)) p.wall({ w: 1.45, d: 1.35, parts: [P("desk", 0, 0.38, 1.3, 0.76, 0.72, { c: 0 }), P("chair", 0.1, 1.0, 0.5, 0.98, 0.5, { yaw: Math.PI + (r() - 0.5) * 0.4 }), P("table-lamp", -0.45, 0.2, 0.26, 0.42, 0.26, { y: 0.76, col: 0, opt: true })], front: 0.3, tall: 1.2, tag: "desk" });
      plant();
      clutter(2);
      pics(2, ["picture", "picture", "clock"]);
      hang("pendant", 0.5);
      break;
    }
    case "studio": {
      p.corner(gBed(r, false)) || p.wall(gBed(r, false));
      p.reserveChest(1);
      kitchenRun(p, 3.2);
      p.centre(gTableSet(r, false));
      if (opt(0.7)) p.wall(gDresser(r));
      p.wall(gSideTable(r));
      plant();
      clutter(2);
      pics(2);
      hang("pendant", 0.5);
      break;
    }
    case "grocer": case "general": {
      const back = p.sidesByPreference();
      p.wall(gShopCounter(r, p.wallLen(back[0])), back.slice(0, 2), { centred: true }) || p.wall(gShopCounter(r, 3));
      p.reserveChest(1);
      // hero: a glass-door drinks cooler (a second one when the wall allows)
      p.wall(gSolo("cooler", 1.3, 2.0, 0.72, { c: Math.floor(r() * 2) })) || p.corner(gSolo("cooler", 1.3, 2.0, 0.72, { c: 0 }));
      for (let i = 0; i < 6; i++) p.wall(gShelfGoods(r));
      if (opt(0.6)) p.wall(gSolo("cooler", 1.3, 2.0, 0.72, { c: 1 }));
      // low display shelving under the windows
      for (let i = 0; i < 3; i++) p.wall(gSolo("shelf-goods", 1.5, 0.95, 0.5, { c: Math.floor(r() * 4), front: 0.9 }));
      if (role === "grocer") { for (let i = 0; i < 3; i++) p.centre(gFruit(r), { jitter: 2 }); } else { p.centre({ w: 2.0, d: 1.1, parts: [P("shelf-goods", 0, 0.55, 1.9, 1.5, 1.0, { c: Math.floor(r() * 4) })], tag: "gondola" }, { jitter: 1.2 }); }
      if (opt(0.8)) p.corner(gCrates(r));
      if (opt(0.6)) p.corner(gPallet(r));
      p.decor("shop-sign", 1.8, 0.5, 2.0, back.slice(0, 1)) || p.decor("shop-sign", 1.4, 0.4, 2.0);
      if (opt(0.75)) neon();
      clutter(3);
      pics(1, ["clock", "wall-shelf"]);
      if (!room.openTop && room.h > 2.6 && ceilingOf("shop") !== "grid" && ceilingOf("shop") !== "none") { p.hang("pendant", -room.w * 0.2, 0, 0.6); p.hang("pendant", room.w * 0.2, 0, 0.6); }
      break;
    }
    case "storage": case "workshop": {
      const big = room.w * room.d > 40;
      // tall racks only under a real ceiling ≥ 2.9 m (open-top bays under a high roof: a 2.7 m rack top is a covered floor
      // only a jump reaches)
      const racksOk = !room.openTop && room.h >= 2.9;
      if ((role === "storage" || big) && racksOk) {
        // racks along the long walls, then free-standing rows with ≥ 2.4 m aisles
        let racks = 0;
        for (const s of longSides) if (p.wall(gRack(r, Math.min(p.wallLen(s) * 0.45, 4.8)), [s]) || p.wall(gRack(r, 2.4), [s])) racks++;
        if (!racks && !big) { const L = Math.min(Math.max(room.w, room.d) * 0.45, 4.2); p.centre({ w: L, d: 3.4, parts: [P("rack", 0, 1.7, L, 2.7, 1.02, { c: Math.floor(r() * 3) })], tag: "rack" }, { yaws: room.w >= room.d ? [0] : [HALF_PI], jitter: 1.5 }); }
        if (big) for (let i = 0; i < 3; i++) {
          // free-standing row: the footprint reserves a 1.3 m aisle on both faces
          const L = Math.min(Math.max(room.w, room.d) * 0.35, 4.8);
          p.centre({ w: L, d: 3.65, parts: [P("rack", 0, 1.825, L, 2.7, 1.02, { c: Math.floor(r() * 3) })], tag: "rack" }, { yaws: room.w >= room.d ? [0] : [HALF_PI], jitter: 3 });
        }
        // hero: yellow / black hazard marking along every rack face
        for (const u of [...p.used]) for (const it of u.items) if (it.kind === "rack") {
          const fx = dmath.sin(it.yaw), fz = dmath.cos(it.yaw);
          for (const sgn of u.side >= 0 ? [1] : [1, -1]) p.flat("hazard", it.x + fx * sgn * (it.d / 2 + 0.2), it.z + fz * sgn * (it.d / 2 + 0.2), it.yaw, it.w, 0.14);
        }
      }
      p.reserveChest(1);
      if (role === "workshop" || opt(0.7)) p.wall(gWorkbench(r));
      p.corner(gBarrels(r, room.h >= 2.5)) || p.wall(gBarrels(r, room.h >= 2.5));
      for (let i = 0; i < (big ? 5 : 4); i++) p.corner(r() < 0.5 ? gCrates(r) : gBarrels(r)) || p.wall(r() < 0.5 ? gCrates(r) : gPallet(r));
      if (big && opt(0.9)) p.centre(gForklift(r), { jitter: 3 });
      for (let i = 0; i < (big ? 3 : 1); i++) if (opt(0.8)) p.centre(gPallet(r), { jitter: 3 });
      if (opt(0.6)) p.wall(gLockers(r));
      for (let i = 0; i < (big ? 6 : 0); i++) p.corner(gCrates(r)) || p.wall(r() < 0.5 ? gBarrels(r) : gPallet(r)) || p.centre(gPallet(r), { jitter: 4 });
      clutter(big ? 4 : 2);
      if (!room.openTop && room.h > 2.8) for (const x of big ? [-0.3, 0, 0.3] : [-0.25, 0.25]) for (const z of big ? [-0.22, 0.22] : [0]) p.hang("pendant", x * room.w, z * room.d, 0.8);
      break;
    }
    case "server": {
      for (const s of longSides) p.wall(gServers(r, Math.max(2, Math.min(6, Math.floor(p.wallLen(s) * 0.5 / 0.72)))), [s]);
      if (room.w * room.d > 24) p.centre(gServers(r, 3), { jitter: 1 });
      p.reserveChest(1);
      p.wall(gDesk(r));
      if (room.w * room.d > 30) p.centre(gDesk(r), { jitter: 2 });
      if (opt(0.7)) p.wall(gLockers(r));
      p.wall(gSolo("water-cooler", 0.45, 1.3, 0.45, { front: 0.5 }));
      clutter(2);
      neon();
      p.decor("whiteboard", 1.6, 0.9, 1.2);
      if (!room.openTop) p.hang("cable-tray", 0, 0, 0.15, Math.min(room.w, room.d) * 0.6);
      break;
    }
    case "office": case "bench": {
      const n = Math.max(1, Math.floor((room.w * room.d) / 9));
      p.reserveChest(1);
      for (let i = 0; i < n; i++) (role === "office" ? p.wall(gDesk(r)) : p.wall(gLabBench(r)));
      if (role === "bench") p.centre(gLabBench(r), { jitter: 1 }); else p.centre(gDesk(r), { jitter: 1 });
      p.wall(gLockers(r));
      if (opt(0.7)) p.wall(gServers(r, 2));
      p.wall(gSolo("water-cooler", 0.45, 1.3, 0.45, { front: 0.5 }));
      plant();
      clutter(2);
      neon();
      p.decor("whiteboard", 1.6, 0.9, 1.2);
      pics(1, ["clock", "picture"]);
      if (!room.openTop && room.h > 2.6 && ceilingOf("lab") !== "grid" && ceilingOf("lab") !== "none") p.hang("pendant", 0, 0, 0.3, 1.2);
      break;
    }
    case "dock": {
      // harbour / yard office: a timber desk with the VHF radio + lamp, filing cabinets, a sea chart, life rings, lockers,
      // a notice board, crates + a drum by the door
      const dk: Group = { w: 1.7, d: 1.45, parts: [P("desk", 0, 0.38, 1.6, 0.76, 0.76, { c: 0 }), P("radio", 0.4, 0.22, 0.42, 0.26, 0.28, { y: 0.76, col: 0 }), P("table-lamp", -0.55, 0.2, 0.26, 0.42, 0.26, { y: 0.76, col: 0, opt: true }), P("office-chair", (r() - 0.5) * 0.3, 1.05, 0.62, 1.05, 0.62, { yaw: Math.PI + (r() - 0.5) * 0.6, c: 1 })], front: 0.5, tall: 1.25, tag: "desk" };
      if (p.wall(dk, undefined, { centred: true })) above("chart", 1.2, 0.8, 1.35);
      p.reserveChest(1);
      p.wall(gFiling(r, 2)) || p.wall(gFiling(r, 1));
      if (room.w * room.d > 16) p.wall(gFiling(r, 1));
      p.wall(gLockers(r));
      p.corner(gCrates(r)) || p.wall(gCrates(r));
      if (opt(0.8)) p.corner(gBarrels(r)) || p.wall(gBarrels(r));
      p.wall(gSolo("water-cooler", 0.45, 1.3, 0.45, { front: 0.5 }));
      p.decor("life-ring", 0.62, 0.62, 1.45, undefined, 0); p.decor("life-ring", 0.62, 0.62, 1.45, undefined, 1);
      p.decor("whiteboard", 1.3, 0.85, 1.25, undefined, 1);
      p.decor("chart", 1.2, 0.8, 1.35);
      clutter(2);
      pics(1, ["clock"]);
      if (!room.openTop && room.h > 2.6 && ceilingOf("lab") !== "grid" && ceilingOf("lab") !== "none") p.hang("pendant", 0, 0, 0.5);
      break;
    }
    case "fisher": case "bunk": {
      p.corner(gStove()) || p.wall(gStove());
      p.reserveChest(1);
      if (role === "bunk" || opt(0.6)) p.wall(gHammock(Math.min(2.6, Math.max(room.w, room.d) - 1.2), r), longSides);
      if (role === "bunk") p.wall({ w: 1.0, d: 2.05, parts: [P("mat", 0, 1.0, 0.95, 0.12, 2.0, { c: Math.floor(r() * 3), col: 0 })], tall: 0.15, tag: "mat" });
      p.centre(gHutTable(r), { jitter: 0.6 }) || p.wall({ w: 1.0, d: 0.5, parts: [P("stool", -0.25, 0.25, 0.42, 0.46, 0.42), P("crate", 0.25, 0.25, 0.5, 0.5, 0.5, { c: 1 })], tall: 0.5, tag: "stool" });
      p.corner(gBarrels(r)) || p.wall(gBarrels(r));
      if (opt(0.8)) p.wall(gCrates(r));
      if (opt(0.6)) p.wall(gChest(r));
      p.wall(gCrates(r)) || p.corner(gBarrels(r));
      clutter(3);
      p.decor("net", 1.6, 1.1, 1.0); p.decor("wall-shelf", 1.0, 0.3, 1.5); if (opt(0.6)) p.decor("picture", 0.5, 0.4, 1.5, undefined, 3);
      p.decor("life-ring", 0.6, 0.6, 1.5, undefined, 0);
      // big huts (stilt town, murk): a second work corner — net-mending table, barrels, crates, a second hammock
      if (room.w * room.d > 36) {
        p.wall(gWorkbench(r)) || p.corner(gCrates(r));
        p.corner(gBarrels(r)) || p.wall(gBarrels(r));
        p.wall(gCrates(r));
        if (role === "fisher") p.wall(gHammock(Math.min(2.6, Math.max(room.w, room.d) - 1.2), r), longSides);
        p.decor("net", 1.6, 1.1, 1.0);
        p.centre(gCrates(r), { jitter: 2 }) || p.centre(gPallet(r), { jitter: 2 });
      }
      if (!room.openTop && room.h > 2.4) p.hang("lantern", 0, 0, 0.6);
      break;
    }
    case "captain": case "crew": {
      if (role === "captain") {
        if (p.wall(gCaptainDesk(r), p.sidesByPreference(), { centred: true })) above("chart", 1.2, 0.8, 1.35);
        // hero: a heap of plunder spilling from an open chest (≤ 0.5 m: stepped over), under a candle chandelier, on a runner
        const heap = (): Group => ({ w: 1.35, d: 1.15, parts: [P("treasure", 0, 0.56, 1.25, 0.5, 1.05, { c: Math.floor(r() * 2) })], front: 0.3, tall: 0.5, tag: "treasure" });
        p.corner(heap()) || p.wall(heap()) || p.centre(heap(), { jitter: 2 });
        p.centre(gMapTable(r), { jitter: 0.5 });
        p.wall(gSolo("bookshelf", 1.1, 2.0, 0.4, { c: 3 }));
        const lx = room.w >= room.d;
        p.flat("runner", 0, 0, lx ? HALF_PI : 0, Math.min(1.0, Math.min(room.w, room.d) * 0.3), Math.max(room.w, room.d) - 1.3);
      } else { p.wall(gHammock(Math.min(2.6, Math.max(room.w, room.d) - 1.2), r), longSides); p.wall(gHammock(Math.min(2.4, Math.max(room.w, room.d) - 1.4), r), longSides); p.centre(gHutTable(r)); }
      p.reserveChest(1);
      for (let i = 0; i < 2; i++) p.wall(gChest(r));
      p.corner(gBarrels(r));
      p.wall(gCrates(r));
      clutter(3);
      p.decor("chart", 1.2, 0.8, 1.3); p.decor("wall-shelf", 1.0, 0.3, 1.55); if (opt(0.7)) p.decor("picture", 0.6, 0.5, 1.5, undefined, 3);
      if (!room.openTop && room.h > 2.3) {
        if (role === "captain" && room.h > 2.45) p.hang("chandelier", 0, 0, Math.min(0.75, room.h - 2.2), 0.95) || p.hang("lantern", 0, 0, 0.55);
        else p.hang("lantern", 0, 0, 0.55);
      }
      break;
    }
    case "shrine": case "ruin": temple(p, role, r); break;
  }
}

/** temple: altar centred on a (short) end wall, braziers flanking it with a walkable gap, statues beyond; long halls get
 *  columns every ~4 m down both sides of the nave (cover bays), urns / braziers / rubble in the bays, banners in
 *  mirrored pairs */
function temple(p: Placer, role: RoomRole, r: Rng) {
  const room = p.room, { w, d } = room;
  const longX = w >= d, L = Math.max(w, d), S = Math.min(w, d);
  const hall = L >= 9 && L / S > 1.35;
  const isShort = (s: Side) => (longX ? s % 2 === 1 : s % 2 === 0);
  const pref = p.sidesByPreference();
  let altarSide: Side | -1 = -1;
  for (const s of (hall ? pref.filter(isShort) : pref).slice(0, 2)) if (p.wall(gAltar(r), [s], { centred: true })) { altarSide = s; break; }
  if (altarSide < 0) for (const s of pref) if (p.wall(gAltar(r), [s])) { altarSide = s; break; }
  const brazier = (): Group => ({ w: 0.95, d: 1.0, parts: [P("brazier", 0, 0.5, 0.8, 1.05, 0.8)], front: 0.4, tall: 1.05, tag: "brazier" });
  if (altarSide >= 0) {
    const Lw = p.wallLen(altarSide as Side);
    // altar half 1.05 + a 1.0 m walkable gap + brazier half 0.4 → no covered platform only a jump reaches
    const sa = Math.min(Lw / 2 - 0.62, 3.85);
    if (sa > 3.3) {
      for (const e of [-1, 1]) p.place(brazier(), altarSide as Side, e * 2.45);
      for (const e of [-1, 1]) p.place(gStatue(1), altarSide as Side, e * sa);
    } else if (Lw >= 6.4) {
      // a narrow end wall: the guardian statues flank the altar (1.05 m walkable gap), the braziers go to the bays
      for (const e of [-1, 1]) p.place(gStatue(1), altarSide as Side, e * 2.6);
    } else for (const e of [-1, 1]) p.place(brazier(), altarSide as Side, e * 2.45);
    if (Lw >= 5.2) { for (const e of [-1, 1]) p.decorAt("banner", altarSide as Side, e * 1.62, 0.8, 1.5, 1.85, 0); }
  }
  p.reserveChest(1);
  // nave columns (halls ≥ 9 m) or 4 free-standing broken pillars (big square rooms)
  const naveX = altarSide === 1 || altarSide === 3 ? true : altarSide === 0 || altarSide === 2 ? false : longX;
  const nLen = naveX ? w : d, span = naveX ? d : w;
  const colH = Math.min(room.h, room.openTop ? 7 : room.h);
  const bays: number[] = [];
  if (nLen >= 9 && span >= 6) {   // (narrow galleries < 6 m keep a clear nave: one aisle, bays along the walls only)
    const off = span / 2 - (span >= 6.5 ? 1.25 : 0.95);
    const a0 = -nLen / 2 + 2.2, a1 = nLen / 2 - 3.0, n = Math.max(1, Math.round((a1 - a0) / 4));
    // the altar end is +/- depending on the altar side: keep the columns out of the altar's front
    const altarAt = altarSide === 1 || altarSide === 0 ? 1 : -1;
    for (let i = 0; i <= n; i++) {
      const t = a0 + (i * (a1 - a0)) / Math.max(1, n), a = altarAt > 0 ? t : -t;
      let ok = 0;
      for (const e of [-1, 1]) {
        const g: Group = { w: 0.76, d: 0.76, parts: [P("column", 0, 0.38, 0.72, colH, 0.72, { c: Math.floor(r() * 2) })], tall: colH, tag: "column" };
        if (p.place(g, -1, naveX ? a : e * off, naveX ? e * off : a, 0)) ok++;
      }
      if (ok) bays.push(a);
    }
  } else if (w * d > 30 && span >= 6) {
    for (const f of [-0.18, 0.18]) for (const e of [-1, 1]) {
      const a = f * nLen, b = e * span * 0.3;
      p.place(gPillar(r), -1, naveX ? a : b, naveX ? b : a, 0);
    }
  }
  // the bays / side walls: urns, braziers, rubble, a statue
  const sideWalls = (naveX ? [0, 2] : [1, 3]) as Side[];
  // a side wall with a door / passage stays clear (the entry path hugs it); otherwise alternate the two side walls so
  // both halves of the nave get dressed
  const hasDoor = (s: Side) => room.openings.some((o) => o.side === s && o.kind !== "window");
  const dressWalls = sideWalls.filter((s) => !hasDoor(s));
  const sw = (i: number) => (dressWalls.length === 1 ? dressWalls : dressWalls.length ? (i % 2 ? [sideWalls[1], sideWalls[0]] : sideWalls) : []) as Side[];
  const quiet = pref.filter((s) => !hasDoor(s));
  for (let i = 0; i < (role === "ruin" ? 4 : 2); i++) p.corner(gRubble(r), quiet) || p.wall(gRubble(r), sw(i)) || p.wall(gRubble(r), quiet);
  const nb = hall ? Math.min(6, Math.round(nLen / 4.5)) : role === "shrine" ? 2 : 3;
  // (fire is the room's light: when both side walls have doors the braziers still go there, between the openings)
  for (let i = 0; i < nb; i++) p.wall(brazier(), dressWalls.length ? sw(i + 1) : (i % 2 ? [sideWalls[1], sideWalls[0]] : sideWalls)) || p.corner(brazier(), quiet);
  for (let i = 0; i < (hall ? 6 : 4); i++) p.wall(gUrn(r), sw(i)) || p.wall(gUrn(r), quiet);
  if (hall) for (let i = 0; i < 2; i++) p.wall(gStatue(0), sw(i));
  clutter4(p, r);
  // banners: mirrored pairs on the side walls (between the columns, else at fixed stations)
  const stations = bays.length >= 2 ? bays.slice(0, -1).map((a, i) => (a + bays[i + 1]) / 2) : [-nLen * 0.2, nLen * 0.2];
  for (const a of stations) {
    if (sideWalls.every((s) => p.decorFree(s, a, 0.9, 1.6, 1.7))) for (const s of sideWalls) p.decorAt("banner", s, a, 0.9, 1.6, 1.7, 0, true);
  }
  // small rooms (tower storeys): a symmetric pair on one wall, else one centred banner
  if (!p.used.some((u) => u.items.some((i) => i.kind === "banner"))) {
    let done = false;
    for (const s of p.sidesByPreference()) {
      const a = p.wallLen(s) * 0.25;
      if (a > 0.8 && p.decorFree(s, a, 0.8, 1.5, 1.7) && p.decorFree(s, -a, 0.8, 1.5, 1.7)) { p.decorAt("banner", s, a, 0.8, 1.5, 1.7, 0, true); p.decorAt("banner", s, -a, 0.8, 1.5, 1.7, 0, true); done = true; break; }
    }
    if (!done) p.decor("banner", 0.8, 1.5, 1.7);
  }
  if (role === "ruin") p.wall(gAltar(r), sideWalls);
}
function clutter4(p: Placer, r: Rng) {
  const quiet = p.sidesByPreference().filter((s) => !p.room.openings.some((o) => o.side === s && o.kind !== "window"));
  for (let i = 0; i < 4; i++) (r() < 0.5 ? p.corner(gClutter(r, "temple"), quiet) : false) || p.wall(gClutter(r, "temple"), quiet);
}

/** small rooms: fill the walls (never the floor) until the room shows ≥ 6 pieces — window-sill pots, a wall shelf, a coat
 *  rack by the door, a wall cabinet, pictures */
function dress(p: Placer, min = 6) {
  const r = p.r, room = p.room;
  if (room.style === "temple") { templeDress(p); return; }
  const wins = room.openings.filter((o) => o.kind === "window");
  for (const o of wins) { if (p.count() >= min + 2) break; p.sill(o, Math.floor(r() * 6)); }
  const tries: Array<() => boolean> = [
    () => p.decor("wall-shelf", 1.0, 0.3, 1.6),
    () => { for (const o of room.openings) if (o.kind === "door") for (const e of [-1, 1]) if (p.decorAt("coat-rack", o.side, o.at + e * (o.w / 2 + 0.45), 0.6, 0.55, 1.5, Math.floor(r() * 6))) return true; return false; },
    () => p.decor("wall-cab", 0.9, 0.6, 1.62, undefined, Math.floor(r() * 6)),
    () => p.decor("picture", 0.6, 0.5, 1.45, undefined, Math.floor(r() * 6)),
    () => p.decor(room.style === "lab" || room.style === "shop" ? "clock" : "picture", 0.42, 0.42, 1.7, undefined, Math.floor(r() * 6)),
    () => p.decor("wall-shelf", 0.8, 0.3, 1.75),
  ];
  for (const t of tries) { if (p.count() >= min) break; t(); }
  // (density: ≥ 1 piece per 6 m²) a big room keeps dressing its walls and
  // corners with floor pieces (a plant, a side table with a lamp, style clutter: crates / sacks / stools) and wall pieces
  // until it holds one piece per 5.5 m²; rounds stop when a whole round places nothing (the walls are full)
  const want = Math.ceil(room.w * room.d / 5.2);
  const more: Array<() => boolean> = [
    () => p.corner({ w: 0.6, d: 0.6, parts: [P("plant", 0, 0.3, 0.5, 1.2 + r() * 0.4, 0.5, { c: Math.floor(r() * 3) })], tall: 1.6, tag: "plant" }),
    () => p.wall(gClutter(r, room.style)),
    () => room.style === "warehouse" || room.style === "hut" || room.style === "cabin" ? p.corner(gClutter(r, room.style)) : p.wall(gSideTable(r)),
    () => p.decor("picture", 0.6 + r() * 0.3, 0.5, 1.45, undefined, Math.floor(r() * 6)),
    () => p.wall(gClutter(r, room.style)),
    () => p.decor("wall-shelf", 0.9, 0.3, 1.6),
  ];
  for (let round = 0; round < 6 && p.pieces() < want; round++) {
    const n0 = p.pieces();
    for (const t of more) { if (p.pieces() >= want) break; t(); }
    if (p.pieces() === n0) break;
  }
  // (e.g. the hotel lobby bays: open on three sides, their walls arches) the
  // walls are full or open: free-standing ISLANDS spread over the floor, farthest from what stands already — lounge
  // sets, planters, armchair pairs, a table set (house); crates / barrels / pallets (warehouse, hut, cabin); gondolas
  // and fruit stands (shop); desks and benches (lab). Each must keep every door / crossing reachable (Placer.place).
  const st = room.style;
  const planter = (): Group => ({ w: 0.75, d: 0.75, parts: [P("plant", 0, 0.37, 0.62, 1.5 + r() * 0.5, 0.62, { c: Math.floor(r() * 3) })], tall: 2.0, tag: "plant" });
  const chairs = (): Group => ({ w: 2.3, d: 0.95, parts: [P("armchair", -0.78, 0.47, 0.92, 0.88, 0.88, { c: Math.floor(r() * 4) }), P("side-table", 0, 0.3, 0.52, 0.6, 0.5, { c: Math.floor(r() * 4) }), P("table-lamp", 0, 0.3, 0.28, 0.44, 0.28, { y: 0.6, col: 0, c: Math.floor(r() * 6) }), P("armchair", 0.78, 0.47, 0.92, 0.88, 0.88, { c: Math.floor(r() * 4) })], tall: 1.04, tag: "chairs" });
  const islands: Array<() => Group> =
    st === "house" ? [() => gLounge(r), planter, chairs, () => gSofa(r, true, false), () => gTableSet(r, false), planter, () => gSideTable(r)]
    : st === "shop" ? [() => gShelfGoods(r), () => gFruit(r), planter, () => gCrates(r)]
    : st === "lab" ? [() => gDesk(r), () => gLabBench(r), planter]
    : [() => gCrates(r), () => gBarrels(r), () => gPallet(r), () => gCrates(r)];
  for (let round = 0; round < 4 && islands.length && p.pieces() < want; round++) {
    const n0 = p.pieces();
    for (const g of islands) { if (p.pieces() >= want) break; island(p, g()); }
    if (p.pieces() === n0) break;
  }
  // narrow bays (2.6–3 m between the crossings): the small pieces — a planter, a side table + lamp, floor clutter
  const small: Array<() => Group> = [planter, () => gSideTable(r), () => gClutter(r, st)];
  for (let round = 0; round < 6 && p.pieces() < want; round++) {
    const n0 = p.pieces();
    for (const g of small) { if (p.pieces() >= want) break; island(p, g()); }
    if (p.pieces() === n0) break;
  }
}
/** a free-standing group at the free floor point farthest from every placed piece (± a seeded jitter), any of 4 yaws */
function island(p: Placer, g: Group): boolean {
  const { w, d } = p.room, r = p.r, m = Math.max(g.w, g.d) / 2 + 0.1;
  if (w < 2 * m + 0.4 || d < 2 * m + 0.4) return false;
  const cs: Array<[number, number]> = [];
  for (const u of p.used) for (const it of u.items) if (it.y < 0.3 && it.col) cs.push([it.x, it.z]);
  const pts: Array<[number, number, number]> = [];
  for (let z = -d / 2 + m; z <= d / 2 - m; z += 0.4) for (let x = -w / 2 + m; x <= w / 2 - m; x += 0.4) {
    // (the squared test skips the exact hypot only where it surely cannot lower q: the same q, without most of the hypots)
    let q = 5; for (const [cx, cz] of cs) { const dx = cx - x, dz = cz - z; if (dx * dx + dz * dz < q * q * 1.000001) q = Math.min(q, dmath.hypot(dx, dz)); }
    pts.push([x, z, q + r() * 0.8]);
  }
  pts.sort((a, b) => b[2] - a[2]);
  const k0 = Math.floor(r() * 4);
  for (let i = 0; i < Math.min(48, pts.length); i++) for (let k = 0; k < 4; k++) if (p.place(g, -1, pts[i][0], pts[i][1], ((k0 + k) % 4) * HALF_PI)) return true;
  return false;
}

/** temple halls: ≥ 1 piece per 6 m² of ruin dressing along the walls — urns, fallen rubble, stone
 * clutter, braziers in the corners — the hall centre stays open (columns / altar / statues come from the recipe) */
function templeDress(p: Placer) {
  const r = p.r, room = p.room, want = Math.ceil(room.w * room.d / 5.5);
  const urn = (): Group => ({ w: 0.6, d: 0.6, parts: [P("urn", 0, 0.3, 0.46, 0.7 + r() * 0.3, 0.46, { c: Math.floor(r() * 3) })], tall: 1.0, tag: "urn" });
  const rubble = (): Group => { const w = 0.8 + r() * 0.6, d = 0.6 + r() * 0.3; return { w: w + 0.05, d: d + 0.05, parts: [P("rubble", 0, d / 2, w, 0.25 + r() * 0.25, d, { c: Math.floor(r() * 3) })], front: 0.3, tall: 0.5, tag: "rubble" }; };
  const tries: Array<() => boolean> = [() => p.wall(urn()), () => p.wall(rubble()), () => p.corner(urn()), () => p.wall(gClutter(r, "temple")), () => p.corner(rubble())];
  for (let round = 0; round < 8 && p.pieces() < want; round++) {
    const n0 = p.pieces();
    for (const t of tries) { if (p.pieces() >= want) break; t(); }
    if (p.pieces() === n0) break;
  }
  // the walls are full: fallen masonry, urn groups and braziers out on the hall floor
  const brazier = (): Group => ({ w: 0.7, d: 0.7, parts: [P("brazier", 0, 0.35, 0.6, 1.1, 0.6, { c: Math.floor(r() * 3) })], tall: 1.1, tag: "brazier" });
  const urns = (): Group => ({ w: 1.3, d: 0.7, parts: [P("urn", -0.33, 0.35, 0.5, 0.8 + r() * 0.3, 0.5, { c: Math.floor(r() * 3) }), P("urn", 0.33, 0.35, 0.42, 0.6 + r() * 0.3, 0.42, { c: Math.floor(r() * 3) })], tall: 1.1, tag: "urns" });
  const isl: Array<() => Group> = [rubble, urns, brazier, () => gClutter(r, "temple"), rubble];
  for (let round = 0; round < 6 && p.pieces() < want; round++) {
    const n0 = p.pieces();
    for (const g of isl) { if (p.pieces() >= want) break; island(p, g()); }
    if (p.pieces() === n0) break;
  }
}

// ------------------------------------------------------------------------------------------------ loot slots
function lootSlots(p: Placer): { chests: Array<[number, number, number]>; floor: Array<[number, number]> } {
  const room = p.room, r = p.r;
  // extra chest candidates if there is still wall space (the match generator activates a subset)
  const want = room.w * room.d > 30 ? 3 : 2;
  for (let i = 0; i < 4 && p.chests.length < want; i++) if (!p.reserveChest()) break;
  if (!p.chests.length) {
    // tiny rooms: a free-standing chest spot (the chest faces the nearest door / the room centre line)
    const before = p.used.length;
    if (p.centre({ w: 1.0, d: 0.62, parts: [P("sea-chest", 0, 0.31, 1.0, 0.6, 0.62)], tag: "chest" }, { jitter: 1.5, yaws: [0, Math.PI, HALF_PI, -HALF_PI] })) {
      if (!p.acceptChest(before)) p.used.splice(before, 1);
    }
  }
  const chests = p.chests;
  const { reach, blocked } = p.reach();
  const W = p.gridW, D = p.gridD;
  const cand: Array<[number, number]> = [];
  for (let c = 0; c < reach.length; c++) if (reach[c] && !blocked[c]) {
    const i = c % W, j = (c / W) | 0;
    // 1 cell (0.2 m) of clearance beyond the capsule margin
    let ok = true;
    for (let dj = -1; dj <= 1 && ok; dj++) for (let di = -1; di <= 1; di++) { const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= W || jj >= D || blocked[jj * W + ii]) { ok = false; break; } }
    if (ok) cand.push([-room.w / 2 + (i + 0.5) * (room.w / W), -room.d / 2 + (j + 0.5) * (room.d / D)]);
  }
  // not in a door corridor
  const free = cand.filter(([x, z]) => !p.keep.some((k) => x > k.x0 && x < k.x1 && z > k.z0 && z < k.z1));
  const all: Array<[number, number]> = [];
  for (let c = 0; c < reach.length; c++) if (reach[c] && !blocked[c]) all.push([-room.w / 2 + ((c % W) + 0.5) * (room.w / W), -room.d / 2 + (((c / W) | 0) + 0.5) * (room.d / D)]);
  const pool = free.length ? free : cand.length ? cand : all;
  const floor: Array<[number, number]> = [];
  const n = Math.min(pool.length, Math.max(1, Math.round(room.w * room.d / 14)), 4);
  // floor loot lies BESIDE furniture, the way a player finds it (at the foot of the bed, by the counter, in
  // front of a shelf): 0.3 m off a floor-standing piece's front or side, outside every footprint and door corridor, ≥ 0.3 m
  // off the walls, with a reachable standing cell within 0.95 m (the match generator re-validates every slot)
  {
    const pieces = p.used.flatMap((u) => u.items).filter((it) => it.col && it.y < 0.3 && !FLAT.has(it.kind) && !(it as InteriorItem & { chest?: boolean }).chest);
    const inside = (x: number, z: number, m: number) => pieces.some((it) => { const c = dmath.cos(it.yaw), s = dmath.sin(it.yaw), dx = x - it.x, dz = z - it.z; return Math.abs(dx * c - dz * s) < it.w / 2 + m && Math.abs(dx * s + dz * c) < it.d / 2 + m; });
    const reachNear = (x: number, z: number) => { for (const [cx, cz] of all) if (dmath.hypot(cx - x, cz - z) < 0.95) return true; return false; };
    const beside: Array<[number, number]> = [];
    for (const it of pieces) {
      const c = dmath.cos(it.yaw), s = dmath.sin(it.yaw);
      // item-local front +z, then the two sides
      for (const [lx, lz] of [[0, it.d / 2 + 0.32], [it.w / 2 + 0.32, 0], [-(it.w / 2 + 0.32), 0]] as Array<[number, number]>) {
        const x = it.x + lx * c + lz * s, z = it.z - lx * s + lz * c;
        if (Math.abs(x) > room.w / 2 - 0.3 || Math.abs(z) > room.d / 2 - 0.3 || inside(x, z, 0.12)) continue;
        if (p.keep.some((k) => x > k.x0 - 0.2 && x < k.x1 + 0.2 && z > k.z0 - 0.2 && z < k.z1 + 0.2)) continue;
        if (chests.some((q) => dmath.hypot(q[0] - x, q[1] - z) < 1.0) || !reachNear(x, z)) continue;
        beside.push([x, z]);
      }
    }
    for (let k = beside.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [beside[k], beside[j]] = [beside[j], beside[k]]; }
    for (const q of beside) { if (floor.length >= n) break; if (floor.every((f) => dmath.hypot(f[0] - q[0], f[1] - q[1]) >= 1.5)) floor.push(q); }
  }
  // the rest: free cells hugging a floor-standing piece (≤ 0.4 m off its
  // footprint) first — spread ≥ 1.2 m — then the open floor
  const pcs = p.used.flatMap((u) => u.items).filter((it) => it.col && it.y < 0.3 && !FLAT.has(it.kind) && !(it as InteriorItem & { chest?: boolean }).chest);
  const off = (x: number, z: number) => { let m = 9; for (const it of pcs) { const c = dmath.cos(it.yaw), s = dmath.sin(it.yaw), dx = x - it.x, dz = z - it.z; m = Math.min(m, dmath.hypot(Math.max(0, Math.abs(dx * c - dz * s) - it.w / 2), Math.max(0, Math.abs(dx * s + dz * c) - it.d / 2))); } return m; };
  const hug = pool.filter(([x, z]) => { const o = off(x, z); return o > 0.12 && o <= 0.4 && chests.every((q) => dmath.hypot(q[0] - x, q[1] - z) >= 1.0); });
  for (const src of [hug, pool]) {
    if (!floor.length && src.length) floor.push(src[Math.floor(r() * src.length)]);
    while (floor.length < n) {
      let best = -1, bd = -1;
      for (let i = 0; i < src.length; i++) { const dmin = Math.min(...floor.map((f) => dmath.hypot(f[0] - src[i][0], f[1] - src[i][1]))); if (dmin > bd) { bd = dmin; best = i; } }
      if (bd < 1.2) break;
      floor.push(src[best]);
    }
  }
  return { chests, floor };
}

// ------------------------------------------------------------------------------------------------ public API
const cache = new Map<string, InteriorLayout>();
const DEBUG = new WeakMap<InteriorLayout, Placer>();
/** tools only: the kit's own reachability grid of a furnished room ('#' blocked, '.' reachable, 'o' free but cut off) */
export function debugReachGrid(L: InteriorLayout): string {
  const p = DEBUG.get(L); if (!p) return "";
  const { reach, blocked } = p.reach(), rows: string[] = [];
  for (let j = 0; j < p.gridD; j++) { let row = ""; for (let i = 0; i < p.gridW; i++) { const c = j * p.gridW + i; row += blocked[c] ? "#" : reach[c] ? "." : "o"; } rows.push(row); }
  return rows.join("\n");
}
const roomKey = (r: InteriorRoom) => JSON.stringify(r);

/** deterministic furnishing of one room (memoised by the room's JSON) */
export function furnishRoom(room: InteriorRoom): InteriorLayout {
  const key = roomKey(room);
  const hit = cache.get(key);
  if (hit) return hit;
  const r = interiorRng(room.seed + 17);
  const role = room.role ?? autoRole(room, r);
  const p = new Placer(room, r);
  if (room.w * room.d < 30) p.reserveChest(1);    // small rooms: the loot spot first, then the furniture
  recipe(p, role, Math.max(0, Math.min(1, room.density ?? 1)));
  dress(p);
  const lootLocal = lootSlots(p);
  const items = p.used.flatMap((u) => u.items).filter((it) => !(it as InteriorItem & { chest?: boolean }).chest);
  const finish: RoomFinish = { ...FINISH[room.style], ...(room.finish ?? {}) };
  const colliders: Box[] = [];
  for (const it of items) if (it.col) colliders.push(...itemColliders(room, it));
  const c = dmath.cos(room.yaw), s = dmath.sin(room.yaw);
  const W = (lx: number, lz: number): [number, number] => [room.x + lx * c + lz * s, room.z - lx * s + lz * c];
  const loot: LootSlots = {
    chests: lootLocal.chests.map(([x, z, yaw]) => { const [wx, wz] = W(x, z); return [wx, room.y, wz, room.yaw + yaw]; }),
    floor: lootLocal.floor.map(([x, z]) => { const [wx, wz] = W(x, z); return [wx, room.y, wz]; }),
  };
  const { reach, blocked } = p.reach();
  let free = 0, got = 0;
  for (let i = 0; i < reach.length; i++) if (!blocked[i]) { free++; if (reach[i]) got++; }
  const cell = (room.w / p.gridW) * (room.d / p.gridD);
  const out: InteriorLayout = { room, role, finish, items, colliders, loot, stats: { free: free * cell, reachable: got * cell, connected: p.connected(), tries: p.tries, why: p.why } };
  cache.set(key, out);
  DEBUG.set(out, p);
  return out;
}

/** collider boxes (sim yaw convention) of one item: tables are their top slab (you can shoot under them), chairs a seat
 *  + back, everything else its bounding box. Local to the item: [x0, y0, z0, x1, y1, z1] */
export function itemLocalBoxes(it: InteriorItem): Array<[number, number, number, number, number, number]> {
  const { w, h, d } = it, X = w / 2, Z = d / 2;
  switch (it.kind) {
    case "table": case "coffee-table": case "desk": case "captain-desk": case "map-table":
      return [[-X, h - 0.1, -Z, X, h, Z]];
    case "chair": case "office-chair": return [[-X * 0.9, 0.0, -Z * 0.9, X * 0.9, 0.5, Z * 0.9], [-X * 0.9, 0.5, -Z, X * 0.9, h, -Z + 0.12]];
    case "bed": return [[-X, 0, -Z, X, 0.55, Z], [-X, 0.55, -Z, X, h, -Z + 0.12]];
    case "sofa": case "armchair": return [[-X, 0, -Z, X, 0.48, Z], [-X, 0.48, -Z, X, h, -Z + 0.3]];
    case "hammock": return [[-X * 0.8, 0.5, -Z * 0.7, X * 0.8, 0.85, Z * 0.7]];
    // body (counterweight → hood + seat), the overhead guard roof, the mast + carriage, the forks (≤ 0.4: stepped over)
    case "forklift": return [[-X, 0, -Z, X, 1.1, Z - 1.1], [-X * 0.92, h - 0.26, -Z + 0.42, X * 0.92, h - 0.12, Z - 1.1], [-0.43, 0, Z - 1.1, 0.43, h, Z - 0.8], [-0.34, 0, Z - 0.8, 0.34, 0.38, Z]];
    case "fireplace": return [[-X, 0, -Z, X, h, Z]];
    case "treasure": return [[-X * 0.8, 0, -Z * 0.8, X * 0.8, h, Z * 0.8]];
    case "workbench": case "lab-bench": case "shop-counter": case "altar":
    default: return [[-X, 0, -Z, X, h, Z]];
  }
}
export function itemColliders(room: InteriorRoom, it: InteriorItem): Box[] {
  const surf = itemSurface(it.kind, room.style);
  const out: Box[] = [];
  const yaw = room.yaw + it.yaw, ci = dmath.cos(it.yaw), si = dmath.sin(it.yaw);
  const c = dmath.cos(room.yaw), s = dmath.sin(room.yaw);
  for (const [x0, y0, z0, x1, y1, z1] of itemLocalBoxes(it)) {
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    const lx = it.x + mx * ci + mz * si, lz = it.z - mx * si + mz * ci;
    const wx = room.x + lx * c + lz * s, wz = room.z - lx * s + lz * c;
    const b: Box = { c: [wx, room.y + it.y + (y0 + y1) / 2, wz], h: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2], surf };
    const sy = -yaw;
    if (Math.abs(dmath.sin(sy)) > 1e-6 || dmath.cos(sy) < 0) b.yaw = sy;
    out.push(b);
  }
  return out;
}

/** every furniture collider of these rooms. Default: SIM yaw convention (add them to `colliders` directly). If your POI
 *  wraps its whole collider list in town-kit `simBoxes(...)` (three.js yaws), pass `{ threeYaw: true }`. */
export function interiorColliders(rooms: InteriorRoom[], o: { threeYaw?: boolean } = {}): Box[] {
  const out = rooms.flatMap((r) => furnishRoom(r).colliders);
  return o.threeYaw ? out.map((b) => (b.yaw ? { ...b, yaw: -b.yaw } : b)) : out;
}
/** loot slot candidates of these rooms (world); the match generator activates a seeded subset per match */
export function interiorLoot(rooms: InteriorRoom[]): LootSlots {
  const out: LootSlots = { chests: [], floor: [] };
  for (const r of rooms) { const l = furnishRoom(r).loot; out.chests.push(...l.chests); out.floor.push(...l.floor); }
  return out;
}

