// THE MAP CONTRACT. World units are metres. +Y up, +X east, -Z north (three.js default: camera looks down -Z = north).
// Sea level is y = 0. The island is centred on the origin. Every POI owns a circle; its pad height is a promise the
// terrain keeps (the terrain generator flattens toward `padY` inside `pad` metres and blends out over `blend`).
// Changing a POI centre / padY moves the ground under that POI's buildings.

export const WORLD = {
  /** terrain grid covers [-HALF, HALF] on X and Z */
  HALF: 1200,
  /** metres between heightfield samples */
  CELL: 2,
  SEA_LEVEL: 0,
  /** ocean plane / fog / far plane reach (the horizon) */
  HORIZON: 9000,
  SEED: 1337,
} as const;

export type PoiId =
  | "peel-harbor" | "the-wreck" | "ripe-peak" | "banana-temple" | "coconut-cove" | "stilt-town"
  | "the-plantation" | "cnvs-lab" | "mist-falls" | "peel-strip" | "lookout-point" | "mango-market"
  | "the-murk" | "coco-caves" | "canopy-line" | "wreck-bay" | "lobby-islet";

export interface Poi {
  id: PoiId;
  name: string;
  /** centre, metres */
  x: number;
  z: number;
  /** gameplay radius — loot, names on the map, landing targets */
  r: number;
  /** flattened pad: height (m above sea), flat radius, blend distance. null = the terrain shapes this area freely */
  padY: number | null;
  pad: number;
  blend: number;
  /** file names of the target art this POI is modelled on (not in this repository) */
  refs: string[];
}

export const POIS: Poi[] = [
  { id: "peel-harbor",    name: "PEEL HARBOR",    x:  600, z:  360, r: 190, padY: 3.2, pad: 190, blend: 70, refs: ["poi-01-peel-harbor.png"] },
  { id: "mango-market",   name: "MANGO MARKET",   x:  430, z:   20, r: 150, padY: 9,   pad: 140, blend: 80, refs: ["poi-12-mango-market.png"] },
  { id: "coconut-cove",   name: "COCONUT COVE",   x:   90, z:  400, r: 150, padY: 4,   pad: 110, blend: 70, refs: ["poi-05-coconut-cove.png"] },
  { id: "stilt-town",     name: "STILT TOWN",     x:  330, z: -330, r: 130, padY: null, pad: 0, blend: 0,   refs: ["poi-06-stilt-town.png"] },
  { id: "the-murk",       name: "THE MURK",       x:  560, z: -220, r: 110, padY: null, pad: 0, blend: 0,   refs: ["poi-13-the-murk.png"] },
  { id: "banana-temple",  name: "BANANA TEMPLE",  x:  -40, z: -130, r: 140, padY: 28,  pad: 95,  blend: 80, refs: ["poi-04-banana-temple.png", "loot-06-golden-vault.png"] },
  { id: "ripe-peak",      name: "RIPE PEAK",      x: -380, z: -430, r: 200, padY: null, pad: 0, blend: 0,   refs: ["poi-03-ripe-peak.png", "biome-04-volcanic.png", "char-04-victory.png"] },
  { id: "mist-falls",     name: "MIST FALLS",     x: -140, z: -400, r: 100, padY: null, pad: 0, blend: 0,   refs: ["poi-09-mist-falls.png", "biome-06-river.png"] },
  { id: "cnvs-lab",       name: "CNVS LAB",       x:  150, z: -480, r: 100, padY: 34,  pad: 70,  blend: 60, refs: ["poi-08-cnvs-lab.png"] },
  { id: "canopy-line",    name: "CANOPY LINE",    x:  160, z: -230, r: 110, padY: null, pad: 0, blend: 0,   refs: ["poi-15-canopy-line.png"] },
  { id: "peel-strip",     name: "PEEL STRIP",     x: -470, z:  -40, r: 190, padY: 14,  pad: 170, blend: 90, refs: ["poi-10-peel-strip.png"] },
  { id: "the-plantation", name: "THE PLANTATION", x: -230, z:  240, r: 170, padY: 10,  pad: 150, blend: 90, refs: ["poi-07-the-plantation.png"] },
  { id: "lookout-point",  name: "LOOKOUT POINT",  x: -590, z:  470, r: 100, padY: 46,  pad: 45,  blend: 70, refs: ["poi-11-lookout-point.png", "biome-05-sea-cliffs.png"] },
  { id: "the-wreck",      name: "THE WRECK",      x: -800, z:   90, r: 150, padY: null, pad: 0, blend: 0,   refs: ["poi-02-the-wreck.png"] },
  { id: "coco-caves",     name: "COCO CAVES",     x: -720, z: -290, r: 100, padY: null, pad: 0, blend: 0,   refs: ["poi-14-coco-caves.png"] },
  { id: "wreck-bay",      name: "WRECK BAY",      x:   40, z: -700, r: 110, padY: null, pad: 0, blend: 0,   refs: ["poi-16-wreck-bay.png"] },
  { id: "lobby-islet",    name: "LOBBY ISLET",    x:    0, z: 1020, r:  90, padY: 2.5, pad: 60,  blend: 40, refs: ["char-02-lobby-island.png"] },
];

export const poiById = (id: PoiId): Poi => {
  const p = POIS.find((q) => q.id === id);
  if (!p) throw new Error(`unknown POI ${id}`);
  return p;
};

/** surface / biome ids stored per heightfield sample (Terrain.biome). Materials, footsteps, loot and bots key off these. */
export enum Biome {
  DeepOcean = 0,
  Reef = 1,
  Beach = 2,
  Grass = 3,
  Jungle = 4,
  Rock = 5,
  Cinder = 6,
  Path = 7,
  Farmland = 8,
  Paved = 9,
  Lagoon = 10,
}

/** item & rarity vocabulary shared by loot, HUD, weapons, audio */
// a 6th tier: MYTHIC — one named signature gun per POI (shared/sim/mythic.ts)
export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary", "mythic"] as const;
export type Rarity = (typeof RARITIES)[number];
export const RARITY_COLOR: Record<Rarity, string> = {
  common: "#b8bec6", uncommon: "#46d160", rare: "#3b9dff", epic: "#b45cff", legendary: "#ffbf2e", mythic: "#ff2f6d",
};
export const WEAPONS = ["pistol", "smg", "ar", "shotgun", "sniper", "rocket", "bow", "minigun"] as const;
export type WeaponId = (typeof WEAPONS)[number];
// two heals: leaf bundle = health (red cross), banana smoothie = shield (blue shield); the golden banana is the rare jackpot
// the RED BANANA: a short burst of ~1.85× speed and a much higher, longer jump — wire index 3
export const CONSUMABLES = ["leaf-bundle", "smoothie", "golden-banana", "red-banana",
  // the Banana Bomb frag grenade, the Coconut Crate Wall portable cover, the Smoke Banana tactical canister,
  // the Vine Grapple traversal hook, and the Banana Airstrike designator
  "banana-bomb", "crate-wall", "smoke-bomb", "vine-grapple", "airstrike",
] as const;
export type ConsumableId = (typeof CONSUMABLES)[number];
