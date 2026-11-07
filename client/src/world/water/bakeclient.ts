// Main-thread side of the water bake worker (bake.worker.ts): allocates the field + texture objects EMPTY right away (the
// materials compile against them), posts the jobs, and fills the textures when the results arrive. Falls back to the
// main-thread bake when workers are unavailable.
import type { Terrain } from "../../../../shared/world/terrain";
import type { CamSpec } from "../../engine/views";
import { createFields, type WaterFields } from "./fields";
import { makeWaterTextures, type WaterTextures } from "./textures";
import { bakeFieldData, type FieldData } from "./fieldbake";
import { waterTexData } from "./texbake";
import { assetUrl } from "../../engine/assets";

export interface WaterBake {
  fields: WaterFields;
  tex: WaterTextures;
  /** resolves when the fields AND the textures hold their baked data */
  done: Promise<void>;
  /** the solved biome-01-beach camera (cached per terrain hash in public/assets/water/beach-view.json, else solved in the
   *  worker) — only call it on the ?view=biome-01-beach page */
  beach(): Promise<CamSpec | null>;
  timings: { tex?: number; fields?: number; beach?: number; wall?: number };
}

let seq = 0;

export function startBake(T: Terrain, texSize: number): WaterBake {
  const t0 = performance.now();
  const fields = createFields(T);
  const tex = makeWaterTextures(texSize, true);
  const timings: WaterBake["timings"] = {};
  // TWO workers: the texture layers (Worley-heavy, ~1-2 s) and the fields + beach camera run in parallel
  const mk = () => {
    const pending = new Map<number, (m: Record<string, unknown>) => void>();
    let w: Worker | null = null;
    try {
      w = new Worker(new URL("./bake.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<Record<string, unknown>>) => { const r = pending.get(e.data.id as number); pending.delete(e.data.id as number); r?.(e.data); };
      w.onerror = (e) => { console.warn("[water] bake worker failed — main-thread fallback", e.message); for (const r of pending.values()) r({ error: "worker" }); pending.clear(); w = null; };
    } catch (e) { console.warn("[water] no bake worker — main-thread fallback", e); w = null; }
    const job = (msg: Record<string, unknown>, transfer: Transferable[] = []) => new Promise<Record<string, unknown>>((res) => {
      if (!w) { res({ error: "no worker" }); return; }
      const id = ++seq; pending.set(id, res);
      w.postMessage({ ...msg, id }, transfer);
    });
    return { job, close: () => { w?.terminate(); w = null; } };
  };
  const wTex = mk(), wFld = mk();
  // (the heights are copied, not transferred: the terrain keeps its own arrays)
  const texP = wTex.job({ kind: "tex", size: texSize }).then((r) => {
    tex.fill(r.error ? waterTexData(texSize) : (r.data as Uint8Array));
    timings.tex = Math.round((r.ms as number) ?? -1);
  });
  const fieldsP = wFld.job({ kind: "fields", heights: T.heights, biome: T.biome, res: T.res, cell: T.cell, half: T.half }).then((r) => {
    const fd = r.error ? bakeFieldData(T.heights, T.biome, T.res, T.cell, T.half) : (r.fd as FieldData);
    fields.fill(fd);
    timings.fields = Math.round(fd.ms);
  });
  texP.then(() => wTex.close());
  fieldsP.then(() => wFld.close());
  const done = Promise.all([texP, fieldsP]).then(() => { timings.wall = Math.round(performance.now() - t0); });
  const beach = async (): Promise<CamSpec | null> => {
    const tb = performance.now();
    // 1. the cache for THIS terrain (written offline)
    try {
      const { terrainData } = await import("../terrain/load");
      const hash = terrainData().hash;
      const r = await fetch(assetUrl("assets/water/beach-view.json"), { cache: "no-cache" });
      if (r.ok && hash) {
        const j = await r.json() as { hash?: number; view?: CamSpec };
        if (j.hash === hash && j.view) { timings.beach = Math.round(performance.now() - tb); return { ...j.view, note: (j.view.note ?? "") + " [cached]" }; }
      }
      console.info(`[water] beach-view cache miss (terrain hash ${hash}, status ${r.status})`);
    } catch (e) { console.info("[water] beach-view cache unavailable", String(e)); }
    // 2. solve it in the worker (never on the main thread: ~3-7 s with the veg scatter replay)
    const wBeach = mk();
    const r = await wBeach.job({ kind: "beach", heights: T.heights, biome: T.biome });
    wBeach.close();
    timings.beach = Math.round(performance.now() - tb);
    if (r.error) {
      const { solveBeachView } = await import("./beachcam");
      return solveBeachView(T);
    }
    return (r.view as CamSpec | null) ?? null;
  };
  return { fields, tex, done, beach, timings };
}
