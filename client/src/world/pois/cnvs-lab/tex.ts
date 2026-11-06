// CNVS LAB — texture loader. The painters (paint.ts) run in a Web Worker started when this module is IMPORTED (all
// world modules are imported at t = 0 and built much later), so by the time the lab builds its textures are usually
// done and cost the main thread only the GPU upload. Fallback: paint on the main thread.
import * as THREE from "three";
import { LAB_PAINT } from "./paint";
import { releaseAfterUpload } from "../../../engine/texture-release";

export interface TexSet { map: THREE.Texture; normalMap?: THREE.Texture; emissiveMap?: THREE.Texture; metres: [number, number] }
const NAMES = Object.keys(LAB_PAINT);
const LINEAR = new Set(["normalMap"]);
const NO_REPEAT = new Set(["heli", "sign", "scrCode", "scrMap", "scrGraph", "scrCam"]);

function wrap(name: string, k: string, img: ImageBitmap | HTMLCanvasElement | OffscreenCanvas, bitmap: boolean): THREE.Texture {
  const t = bitmap ? new THREE.Texture(img as ImageBitmap) : new THREE.CanvasTexture(img as HTMLCanvasElement);
  if (bitmap) t.flipY = false;
  t.colorSpace = LINEAR.has(k) ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (!NO_REPEAT.has(name)) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = name === "heli" || name === "sign" ? 16 : name === "chain" ? 4 : 8;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return releaseAfterUpload(t, () => {
    const c = LAB_PAINT[name]()[k as "map" | "normalMap" | "emissiveMap"] as HTMLCanvasElement;
    return bitmap ? createImageBitmap(c, { imageOrientation: "flipY", premultiplyAlpha: "none" }) : c;
  });
}
function paintHere(name: string): TexSet {
  const s = LAB_PAINT[name]();
  const out: TexSet = { map: wrap(name, "map", s.map, false), metres: s.metres };
  if (s.normalMap) out.normalMap = wrap(name, "normalMap", s.normalMap, false);
  if (s.emissiveMap) out.emissiveMap = wrap(name, "emissiveMap", s.emissiveMap, false);
  return out;
}

let job: Promise<Record<string, TexSet>> | null = null;
/** start painting (idempotent); resolves with every set */
export function labTextures(): Promise<Record<string, TexSet>> {
  if (job) return job;
  const t0 = performance.now();
  job = new Promise((resolve) => {
    const sets: Record<string, TexSet> = {};
    const finishHere = () => { let k = 0; for (const n of NAMES) if (!sets[n]) { sets[n] = paintHere(n); k++; } console.info(`[cnvs-lab] textures ready ${(performance.now() - t0).toFixed(0)} ms after start (${k} painted on the main thread)`); resolve(sets); };
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return finishHere();
    try {
      // two workers, names interleaved
      const lanes = [NAMES.filter((_, i) => i % 2 === 0), NAMES.filter((_, i) => i % 2 === 1)];
      let left = NAMES.length, dead = false;
      const workers = lanes.map((names) => {
        const w = new Worker(new URL("./paint.worker.ts", import.meta.url), { type: "module" });
        w.onmessage = (e: MessageEvent<{ name: string; set?: Record<string, ImageBitmap | [number, number]>; error?: string }>) => {
          const { name, set, error } = e.data;
          if (set && !error) {
            const o: TexSet = { map: wrap(name, "map", set.map as ImageBitmap, true), metres: set.metres as [number, number] };
            if (set.normalMap) o.normalMap = wrap(name, "normalMap", set.normalMap as ImageBitmap, true);
            if (set.emissiveMap) o.emissiveMap = wrap(name, "emissiveMap", set.emissiveMap as ImageBitmap, true);
            sets[name] = o;
          } else console.warn("[cnvs-lab] texture worker:", name, error);
          if (--left === 0) { for (const x of workers) x.terminate(); finishHere(); }
        };
        w.onerror = (ev) => { if (dead) return; dead = true; console.warn("[cnvs-lab] texture worker failed — painting on the main thread", ev.message); for (const x of workers) x.terminate(); finishHere(); };
        w.postMessage({ names });
        return w;
      });
    } catch (e) { console.warn("[cnvs-lab] no texture worker", e); finishHere(); }
  });
  return job;
}
// kick off at import (t = 0 of the page load)
if (typeof window !== "undefined") void labTextures();
