// Main-thread side of the water bake worker (bake.worker.ts): allocates the field + texture objects EMPTY right away (the
// materials compile against them), posts the jobs, and fills the textures when the results arrive.
import type { Terrain } from "../../../../shared/world/terrain";
import type { CamSpec } from "../../engine/views";
import type { Scope } from "../../engine/res/scope";
import { createFields, type WaterFields } from "./fields";
import { makeWaterTextures, type WaterTextures } from "./textures";
import type { FieldData } from "./fieldbake";
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

export function startBake(T: Terrain, texSize: number, scope: Scope): WaterBake {
  const workerScope = scope.child("bake-workers");
  const t0 = performance.now();
  const timings: WaterBake["timings"] = {};
  const runJob = async (msg: Record<string, unknown>) => {
    if (scope.isDisposed) throw new Error("water bake cancelled");
    const id = ++seq;
    const jobScope = workerScope.child(`job-${id}`);
    const w = jobScope.worker(new Worker(new URL("./bake.worker.ts", import.meta.url), { type: "module" }));
    try {
      const r = await new Promise<Record<string, unknown>>((res, rej) => {
        w.onmessage = (e: MessageEvent<Record<string, unknown>>) => { if (e.data.id === id) res(e.data); };
        w.onerror = (e) => rej(new Error(e.message || "worker error"));
        w.postMessage({ ...msg, id });
      });
      if (r.error) throw new Error(String(r.error));
      return r;
    } finally {
      jobScope.dispose();
    }
  };
  const bakeTex = () => runJob({ kind: "tex", size: texSize });
  const bakeFields = async () => (await runJob({ kind: "fields", heights: T.heights, biome: T.biome, res: T.res, cell: T.cell, half: T.half })).fd as FieldData;
  const fields = createFields(T, scope, bakeFields);
  const tex = makeWaterTextures(texSize, scope, bakeTex);
  const texP = bakeTex().then((r) => {
    tex.fill(r.data as Uint8Array);
    timings.tex = Math.round((r.ms as number) ?? -1);
  });
  const fieldsP = bakeFields().then((fd) => {
    fields.fill(fd);
    timings.fields = Math.round(fd.ms);
  });
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
    try {
      const r = await runJob({ kind: "beach", heights: T.heights, biome: T.biome });
      timings.beach = Math.round(performance.now() - tb);
      return (r.view as CamSpec | null) ?? null;
    } catch { /* fallback below */ }
    const { solveBeachView } = await import("./beachcam");
    return solveBeachView(T);
  };
  return { fields, tex, done, beach, timings };
}
