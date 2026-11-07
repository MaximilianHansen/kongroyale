// Terrain texture layers → two DataArrayTextures. Stylized, painterly AI-generated layers steered by crops
// of the target art, made seamless + normal/AO/roughness/height derived offline
// (public/assets/terrain/tex3/<id>/{diff,nor,arm}.webp). Order here == layer index in the shader and data.ts.
//   tAlb: rgb = albedo (sRGB, AO pre-multiplied a little), a = height (0..1, for height-based blending)
//   tNrm: rgb = tangent normal (GL, +Y up), a = roughness
import * as THREE from "three";
import { assetUrl } from "../../engine/assets";
import { releaseAfterUpload } from "../../engine/texture-release";
import { contextEpoch } from "../../engine/res/restore";

import { LAYERS } from "./layers";
export { LAYERS, LAYER_COUNT, layerIndex, type Layer } from "./layers";
const SIZE = 1024;

export interface LayerArrays { albedo: THREE.DataArrayTexture; normal: THREE.DataArrayTexture }

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = () => rej(new Error("image " + url)); im.src = url; });
}

export async function loadLayerArrays(maxAniso: number): Promise<LayerArrays> {
  const { alb, nor } = await composeLayers();
  return layerArraysFrom(alb, nor, maxAniso);
}

let composed: { epoch: number; job: Promise<{ alb: Uint8Array; nor: Uint8Array }> } | null = null;
function composedFor(epoch: number) {
  if (composed?.epoch !== epoch) composed = { epoch, job: composeLayers() };
  return composed.job;
}

async function composeLayers(): Promise<{ alb: Uint8Array; nor: Uint8Array }> {
  const n = LAYERS.length, px = SIZE * SIZE * 4;
  const alb = new Uint8Array(px * n), nor = new Uint8Array(px * n);
  const cv = document.createElement("canvas"); cv.width = SIZE; cv.height = SIZE;
  const g = cv.getContext("2d", { willReadFrequently: true })!;
  const read = (im: HTMLImageElement) => { g.clearRect(0, 0, SIZE, SIZE); g.drawImage(im, 0, 0, SIZE, SIZE); return g.getImageData(0, 0, SIZE, SIZE).data; };
  const images = await Promise.all(LAYERS.map(async (L) => {
    const base = assetUrl(`assets/terrain/tex3/${L.id}/`);
    return Promise.all([loadImage(base + "diff.webp"), loadImage(base + "nor.webp"), loadImage(base + "arm.webp")]);
  }));
  images.forEach(([d, nm, arm], li) => {
    const dd = read(d); const oa = alb.subarray(li * px, (li + 1) * px);
    const ad = read(arm), aoK = LAYERS[li].ao;
    for (let i = 0; i < px; i += 4) {
      const ao = 1 - aoK + aoK * (ad[i] / 255);
      oa[i] = dd[i] * ao; oa[i + 1] = dd[i + 1] * ao; oa[i + 2] = dd[i + 2] * ao; oa[i + 3] = ad[i + 2];   // a = height
    }
    const nd = read(nm); const on = nor.subarray(li * px, (li + 1) * px);
    for (let i = 0; i < px; i += 4) { on[i] = nd[i]; on[i + 1] = nd[i + 1]; on[i + 2] = nd[i + 2]; on[i + 3] = ad[i + 1]; } // a = roughness
  });
  return { alb, nor };
}
/** layer URLs [diff, nor, arm] + AO weights (the worker composes the same arrays off the main thread) */
export function layerSources(): { urls: string[][]; ao: number[]; size: number } {
  return { urls: LAYERS.map((L) => { const base = new URL(assetUrl(`assets/terrain/tex3/${L.id}/`), location.href).href; return [base + "diff.webp", base + "nor.webp", base + "arm.webp"]; }), ao: LAYERS.map((L) => L.ao), size: SIZE };
}
/** the two array textures from composed RGBA arrays (albedo·AO + height, normal + roughness) */
export function layerArraysFrom(alb: Uint8Array | null, nor: Uint8Array | null, maxAniso: number): LayerArrays {
  const n = LAYERS.length;
  const mk = (data: Uint8Array | null, srgb: boolean, key: "alb" | "nor") => {
    const t = new THREE.DataArrayTexture(data, SIZE, SIZE, n);
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    // (perf: 4, not 8 — measured −0.1 ms at the volcanic view; beyond ~280 m the baked far albedo takes over anyway)
    t.generateMipmaps = true; t.anisotropy = Math.min(4, maxAniso);
    if (data) t.needsUpdate = true;
    return releaseAfterUpload(t, async () => {
      const data = (await composedFor(contextEpoch()))[key];
      if (key === "nor") composed = null;
      return { data, width: SIZE, height: SIZE, depth: n };
    });
  };
  return { albedo: mk(alb, true, "alb"), normal: mk(nor, false, "nor") };
}
/** hand the composed layers to textures made before they arrived (the rock materials already hold them) */
export function fillLayerArrays(a: LayerArrays, alb: Uint8Array, nor: Uint8Array) {
  (a.albedo.image as { data: Uint8Array }).data = alb; a.albedo.needsUpdate = true;
  (a.normal.image as { data: Uint8Array }).data = nor; a.normal.needsUpdate = true;
}
