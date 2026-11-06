// Terrain-rock keep-outs = the POI clearings, taken LIVE from shared/pois. island.bin v5 stores a snapshot of them
// (written by the terrain bake) that goes stale whenever a POI edits a clearing, so every consumer applies the current
// clearings right after decoding the file: the server + the client prediction worker in shared/sim/static-world.ts buildStaticWorld, the client renderer in
// client/src/world/terrain/load.ts, tools/play/world.mts — so rocks you see == rock colliders == the POIs' clearings.
// terrain-gen.ts cannot import the POIs (import cycle) — this file sits between them.
// Rules (unchanged from the bake): only clearings whose centre lies within r + 20 m of a POI (a POI's far "vista"
// clearing must not strip open-world cover); LOOKOUT POINT's own area is left out (its bake lays columns round the
// rocks); values at the file's stored precision (cm, mrad) so the result equals a fresh bake bit for bit.
import { POIS } from "./map";
import { allClearings } from "../pois/index";
import type { RockKeep, TerrainData } from "./terrain-gen";
import * as dmath from "../sim/dmath";

const q2 = (v: number) => Math.round(v * 100) / 100;

export function poiRockKeeps(): RockKeep[] {
  const out: RockKeep[] = [];
  const lookout = POIS.find((p) => p.id === "lookout-point");
  for (const c of allClearings() as Array<{ x: number; z: number; r?: number; hx?: number; hz?: number; yaw?: number }>) {
    if (lookout && dmath.hypot(c.x - lookout.x, c.z - lookout.z) <= lookout.r + 20) continue;
    if (!POIS.some((p) => p.id !== "lookout-point" && dmath.hypot(c.x - p.x, c.z - p.z) <= p.r + 20)) continue;
    out.push(c.r !== undefined ? { x: q2(c.x), z: q2(c.z), r: q2(c.r), hx: 0, hz: 0, yaw: 0 }
      : { x: q2(c.x), z: q2(c.z), r: 0, hx: q2(c.hx!), hz: q2(c.hz!), yaw: Math.round((c.yaw ?? 0) * 1000) / 1000 });
  }
  return out;
}

/** replace the file's keep-out snapshot with the live POI clearings (call once, right after decodeTerrainFile) */
export function applyPoiRockKeeps(td: TerrainData): TerrainData { td.keep = poiRockKeeps(); return td; }
