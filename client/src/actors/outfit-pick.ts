// Kong variety: which hat / top / shorts
// a kong wears this match. Pure and deterministic for bots/remotes; the local player can customize their look
// in the Lobby Wardrobe (saved in localStorage, with the Victory Crown unlocked on #1 Victory).
import type { KongOutfit } from "./api";

const SET_SHORTS = ["#1c9c9a", "#e3b21c", "#3d4a2a"];        // the char-01 squad's sets: teal / work yellow / olive
const MORE_SHORTS = ["#2b4f8c", "#6b4a2e", "#1c9c9a", "#3d4a2a"];

export const OUTFIT_KEY = "kr-kong-outfit-v1";
export const CROWN_UNLOCK_KEY = "kr-victory-crown-v1";
export const CROWN_HAT_INDEX = 5;

export interface ShortsOption { id: string; label: string; color: string | null; swatch: string }
export const SHORTS_PALETTE: readonly ShortsOption[] = [
  { id: "classic", label: "Brick Red", color: null, swatch: "#b5382a" },
  { id: "teal", label: "Lagoon Teal", color: "#1c9c9a", swatch: "#1c9c9a" },
  { id: "gold", label: "Banana Gold", color: "#e3b21c", swatch: "#e3b21c" },
  { id: "olive", label: "Jungle Olive", color: "#3d4a2a", swatch: "#3d4a2a" },
  { id: "navy", label: "Ocean Navy", color: "#2b4f8c", swatch: "#2b4f8c" },
  { id: "plum", label: "Sunset Plum", color: "#8e2a6b", swatch: "#8e2a6b" },
  { id: "charcoal", label: "Midnight", color: "#262b36", swatch: "#262b36" },
];

export const HAT_OPTIONS = [
  { idx: -1, label: "None" },
  { idx: 0, label: "Straw Hat" },
  { idx: 1, label: "Hard Hat" },
  { idx: 2, label: "Pirate" },
  { idx: 3, label: "Shades" },
  { idx: 4, label: "Bandana" },
  { idx: 5, label: "Crown", locked: true },
] as const;

export const TOP_OPTIONS = [
  { idx: -1, label: "Classic" },
  { idx: 0, label: "Hawaiian" },
  { idx: 1, label: "Banana Vest" },
  { idx: 2, label: "Pirate Coat" },
] as const;

export interface PlayerOutfitPref extends KongOutfit {
  /** "custom" uses the chosen hat/top/shorts; "random" rolls per match */
  mode: "custom" | "random";
}

const VALID_SHORTS = new Set<string | null>(SHORTS_PALETTE.map((s) => s.color));

export function hasVictoryCrown(): boolean {
  try {
    if (localStorage.getItem(CROWN_UNLOCK_KEY) === "1") return true;
    // also honor any #1 victory already recorded in personal bests
    const raw = localStorage.getItem("kr-personal-bests-v1");
    if (raw) {
      const parsed = JSON.parse(raw) as { records?: Record<string, { placements?: Record<string, number> }> };
      for (const row of Object.values(parsed?.records ?? {})) {
        for (const p of Object.values(row?.placements ?? {})) if (p === 1) return true;
      }
    }
  } catch { /* private mode */ }
  return false;
}

/** unlock the Victory Crown; returns true only on the very first unlock */
export function markVictoryUnlocked(): boolean {
  const had = hasVictoryCrown();
  try { localStorage.setItem(CROWN_UNLOCK_KEY, "1"); } catch { /* private mode */ }
  return !had;
}

export function loadPlayerOutfit(): PlayerOutfitPref {
  const def: PlayerOutfitPref = { mode: "custom", hat: -1, top: -1, shorts: null };
  try {
    const raw = localStorage.getItem(OUTFIT_KEY);
    if (!raw) return def;
    const p = JSON.parse(raw) as Partial<PlayerOutfitPref>;
    const crownOk = hasVictoryCrown();
    let hat = typeof p.hat === "number" && Number.isInteger(p.hat) && p.hat >= -1 && p.hat <= 5 ? p.hat : -1;
    if (hat === CROWN_HAT_INDEX && !crownOk) hat = -1;
    const top = typeof p.top === "number" && Number.isInteger(p.top) && p.top >= -1 && p.top <= 2 ? p.top : -1;
    const shorts = (typeof p.shorts === "string" || p.shorts === null) && VALID_SHORTS.has(p.shorts) ? p.shorts : null;
    const mode = p.mode === "random" ? "random" : "custom";
    return { mode, hat, top, shorts };
  } catch {
    return def;
  }
}

export function savePlayerOutfit(pref: PlayerOutfitPref) {
  try { localStorage.setItem(OUTFIT_KEY, JSON.stringify(pref)); } catch { /* private mode */ }
}

/** deterministic per (player id, match seed) — the same look for a player on every client for the whole match: ~65 %
 *  wear a hat (including shades/bandana, never the Victory Crown), ~55 % a top; the shorts follow the top's set (or
 *  stay brick red); bare kongs sometimes swap shorts */
export function outfitFor(id: number, seed: number): KongOutfit {
  let h = Math.imul((id + 1) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((seed | 0) + 0x6d2b79f5, 0xc2b2ae35);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  const r = (k: number) => ((h >>> (k * 8)) & 255) / 256;
  const hat = r(0) < 0.35 ? -1 : Math.min(4, Math.floor(r(1) * 5));
  const top = r(2) < 0.45 ? -1 : Math.min(2, Math.floor(r(3) * 3));
  let h2 = Math.imul(h ^ 0x27d4eb2d, 0x165667b1); h2 ^= h2 >>> 15;
  const r2 = ((h2 >>> 4) & 255) / 256, r3 = ((h2 >>> 12) & 255) / 256;
  const shorts = top >= 0 ? (r2 < 0.7 ? SET_SHORTS[top] : null) : r2 < 0.25 ? MORE_SHORTS[Math.min(3, Math.floor(r3 * 4))] : null;
  return { hat, top, shorts };
}

/** local player respects their saved Wardrobe look (unless set to Random); everyone else keeps deterministic variety */
export function outfitForPlayer(id: number, seed: number, isLocal: boolean): KongOutfit {
  if (isLocal) {
    const pref = loadPlayerOutfit();
    if (pref.mode === "custom") return { hat: pref.hat, top: pref.top, shorts: pref.shorts };
  }
  return outfitFor(id, seed);
}
