// Baked per-world fields the water shader samples per pixel (one texel per heightfield sample, 2 m):
//   field  (RGBA16F) R = terrain height (m)          → depth = surfaceY − R (colour, caustics, shore foam, damping)
//                    G = signed shore distance (m)   → surf lines parallel to the beach, swash phase, far effects
//                    B = shore steepness: the slope AT the nearest waterline (max over ~10 m) → rock / cliff /
//                        sea-stack surf fringe + contact foam only where the coast itself is steep (never at an
//                        underwater drop-off a few metres out, e.g. the ledge along a quay)
//                    A = slope |∇h| (m/m)            → metres-to-the-waterline = height / slope (swash)
//   field2 (RGBA8)   RG = unit shore normal (toward open water) → oriented foam lines / backwash streaks
//                    B = 0.5 − 0.5·calm (lagoon / mangrove water: damped swell, no surf, glassy) or 0.5 + 0.5·coral
//                        (the terrain's own raised reef heads — none in calm water); decode: wtrCalm() / wtrCoral()
//                    A = feathered depth / 40 m (~12 m blur) → the colour ramp softens hard-edged basins/channels
//   THE MURK (tea-green) and the peel-harbor basin (deeper teal, choppier) are analytic masks in the shader
//   (wtrMurkP / wtrHarborP, see `masks` below) — one texture fetch less per pixel.
// Plus the FOAM MASK: a 2048² R8 canvas other areas paint into through the WaterApi (piers, rocks, hulls…).
import * as THREE from "three";
import { POIS } from "../../../../shared/world/map";
import type { FieldData } from "./fieldbake";
import type { Terrain } from "../../../../shared/world/terrain";
import type { Scope } from "../../engine/res/scope";
import { releaseAfterUpload } from "../../engine/texture-release";

export interface WaterFields {
  texture: THREE.DataTexture;
  texture2: THREE.DataTexture;
  /** RGBA16F: the shore-smoothed height, its slope, the smooth shore normal (the swash + shore foam read these) */
  texture3: THREE.DataTexture;
  /** analytic masks: murk = (x, z, r) of THE MURK; harbor = ellipse (cx, cz, 1/rx, 1/rz) of the peel-harbor basin;
   *  lagoon = THE WRECK's emerald lagoon disc; lagoon2 = WRECK BAY's cove disc (x, z, r) */
  masks: { murk: [number, number, number]; harbor: [number, number, number, number]; lagoon: [number, number, number]; lagoon2: [number, number, number] };
  res: number;
  /** uv = xz * scale + offset */
  scale: number;
  offset: number;
  height(x: number, z: number): number;
  shore(x: number, z: number): number;
  /** true once the baked data is in the textures (the bake runs in a worker: bake.worker.ts) */
  ready: boolean;
  /** spray spawn candidates from the bake ([x, z, nx, nz]…), empty until it landed */
  spray: Float32Array;
  /** upload a finished bake (worker or main-thread fallback) */
  fill(fd: FieldData): void;
}

/** the field textures, allocated EMPTY (the bake fills them from the worker — no main-thread bake, no program change:
 *  same size + format, only the data is uploaded) */
export function createFields(terrain: Terrain, scope: Scope, rebuildFields: () => Promise<FieldData>): WaterFields {
  const res = terrain.res, cell = terrain.cell, half = terrain.half;
  const murkPoi = POIS.find((p) => p.id === "the-murk");
  const harborPoi = POIS.find((p) => p.id === "peel-harbor");
  const wreckPoi = POIS.find((p) => p.id === "the-wreck");
  const bayPoi = POIS.find((p) => p.id === "wreck-bay");
  // THE MURK: a disc around the POI (fades over 60 m, × calm). The berth faces world +Z at z ≈ 560: the basin/inlet is
  // SOUTH of the pad, x ≈ 400–740, z ≈ 560–780 — an ellipse, fading over ~90 m
  const masks: WaterFields["masks"] = {
    // (the swamp's core, centred on poi-murk's own tea surface: x 468-684, z −292…−134 — its NW lobe hands over to the sea
    // water here; fades over 45 m, only in shallow water: shader VERT_BEGINNORMAL)
    murk: murkPoi ? [murkPoi.x + 12, murkPoi.z + 4, 82] : [0, 0, -1e6],
    harbor: harborPoi ? [harborPoi.x - 30, harborPoi.z + 300, 1 / 190, 1 / 150] : [0, 0, 1e-6, 1e-6],
    // THE WRECK's emerald lagoon: a disc over the wreck's shallows (fades over 50 m)
    lagoon: wreckPoi ? [wreckPoi.x - 60, wreckPoi.z + 10, 110] : [0, 0, -1e6],
    // WRECK BAY's cove (poi-wreckbay: the POI sits at (40, −700), r 110; the cove's sand shallows fill the POI disc and
    // the beach along z ≈ −650) — emerald-turquoise, sheltered
    lagoon2: bayPoi ? [bayPoi.x, bayPoi.z + 10, 95] : [0, 0, -1e6],
  };
  const fieldScope = scope.child("fields");
  // Allocate 1×1 placeholders until the bake worker finishes (avoids ~29 MiB dummy CPU allocs + throwaway GPU uploads)
  const mkTex = (data: Uint16Array | Uint8Array, type: THREE.TextureDataType) => {
    const t = fieldScope.texture("tex.world", new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, type));
    t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = t.flipY = false;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true;
    return t;
  };
  const texture = mkTex(new Uint16Array(4), THREE.HalfFloatType);
  const texture2 = mkTex(new Uint8Array(4).fill(128), THREE.UnsignedByteType);
  const texture3 = mkTex(new Uint16Array(4), THREE.HalfFloatType);
  const scale = 1 / (cell * res), offset = (half / cell + 0.5) / res;
  let shoreArr: Float32Array | null = null;
  const sample = (arr: Float32Array, x: number, z: number) => {
    const fx = (x + half) / cell, fz = (z + half) / cell;
    let j = Math.floor(fx), i = Math.floor(fz);
    if (j < 0) j = 0; else if (j > res - 2) j = res - 2;
    if (i < 0) i = 0; else if (i > res - 2) i = res - 2;
    const tx = Math.min(1, Math.max(0, fx - j)), tz = Math.min(1, Math.max(0, fz - i)), k = i * res + j;
    const a = arr[k] + (arr[k + 1] - arr[k]) * tx, b = arr[k + res] + (arr[k + res + 1] - arr[k + res]) * tx;
    return a + (b - a) * tz;
  };
  let rebuilt: Promise<FieldData> | null = null;
  const again = () => (rebuilt ??= rebuildFields());
  const f: WaterFields = {
    texture, texture2, texture3, masks, res, scale, offset, ready: false, spray: new Float32Array(0),
    height: (x, z) => terrain.height(x, z),
    // (before the bake lands: a rough signed distance from the height — only the run-up lift of flotsam uses it)
    shore: (x, z) => (shoreArr ? sample(shoreArr, x, z) : -terrain.height(x, z) * 8),
    fill(fd) {
      texture.image = { data: fd.data, width: res, height: res };
      texture2.image = { data: fd.d2, width: res, height: res };
      texture3.image = { data: fd.d3, width: res, height: res };
      releaseAfterUpload(texture, async () => ({ data: (await again()).data, width: res, height: res }));
      releaseAfterUpload(texture2, async () => ({ data: (await again()).d2, width: res, height: res }));
      releaseAfterUpload(texture3, async () => { const d = (await again()).d3; rebuilt = null; return { data: d, width: res, height: res }; });
      texture.needsUpdate = texture2.needsUpdate = texture3.needsUpdate = true;
      shoreArr = fd.shore; f.spray = fd.spray; f.ready = true;
    },
  };
  fieldScope.defer(() => { shoreArr = null; rebuilt = null; f.spray = new Float32Array(0); });
  return f;
}


const rgba = (a: number) => `rgba(255,255,255,${a})`;

/** 2048² foam mask painted by other areas (piers, hulls, rocks). R8 texture, uv = xz * scale + offset. */
export class FoamMask {
  readonly size = 2048;
  readonly texture: THREE.DataTexture;
  readonly scale: number;
  readonly offset: number;
  #canvas: HTMLCanvasElement;
  #c2d: CanvasRenderingContext2D;
  #data: Uint8Array;
  #dirty = false;
  #count = 0;
  #half: number;

  constructor(half: number, scope: Scope) {
    this.#half = half;
    const cv = this.#canvas = document.createElement("canvas");
    cv.width = cv.height = this.size;
    this.#c2d = cv.getContext("2d", { willReadFrequently: true })!;
    this.#data = new Uint8Array(this.size * this.size);
    this.texture = scope.texture("tex.world", new THREE.DataTexture(this.#data, this.size, this.size, THREE.RedFormat, THREE.UnsignedByteType));
    this.texture.minFilter = THREE.LinearFilter; this.texture.magFilter = THREE.LinearFilter; this.texture.generateMipmaps = false;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping; this.texture.flipY = false; this.texture.needsUpdate = true;
    this.scale = 1 / (2 * half); this.offset = 0.5;
    scope.defer(() => { cv.width = cv.height = 1; });
  }
  /** metres → canvas px */
  #px(v: number) { return ((v + this.#half) / (2 * this.#half)) * this.size; }
  #pxr(r: number) { return (r / (2 * this.#half)) * this.size; }

  // Shapes are soft coverage, never solid: the shader lace-breaks them and caps them with distance (a registered piling
  // is a small lacy ring, not a white dot from the air).
  circle(x: number, z: number, r: number, strength = 1) {
    const c = this.#c2d, cx = this.#px(x), cz = this.#px(z), pr = Math.max(1.2, this.#pxr(r + 0.6));
    const g = c.createRadialGradient(cx, cz, 0, cx, cz, pr);
    const s = Math.min(1, strength) * 0.7;
    g.addColorStop(0, rgba(s)); g.addColorStop(0.45, rgba(s * 0.8)); g.addColorStop(1, rgba(0));
    c.fillStyle = g; c.beginPath(); c.arc(cx, cz, pr, 0, Math.PI * 2); c.fill();
    this.#touch();
  }
  capsule(x1: number, z1: number, x2: number, z2: number, r: number, strength = 1) {
    const c = this.#c2d;
    c.lineCap = "round"; c.lineJoin = "round";
    for (const [k, a] of [[1.0, 0.25], [0.55, 0.45]] as const) {
      c.strokeStyle = rgba(a * strength); c.lineWidth = Math.max(1.2, this.#pxr((r + 0.5) * 2 * k));
      c.beginPath(); c.moveTo(this.#px(x1), this.#px(z1)); c.lineTo(this.#px(x2), this.#px(z2)); c.stroke();
    }
    this.#touch();
  }
  /** a ROUNDED ring hugging the footprint (hulls get stadium ends, containers soft corners — never a drawn box) */
  rect(x: number, z: number, hx: number, hz: number, yaw: number, ring = 1.5, strength = 1) {
    const c = this.#c2d;
    c.save(); c.translate(this.#px(x), this.#px(z)); c.rotate(-yaw);
    const w = this.#pxr(hx * 2), h = this.#pxr(hz * 2), rr = Math.min(w, h) * 0.5 * 0.92;
    for (const [k, a] of [[1.0, 0.22], [0.5, 0.42]] as const) {
      c.strokeStyle = rgba(a * Math.min(1, strength)); c.lineWidth = Math.max(1.2, this.#pxr(ring * 2 * k));
      c.beginPath(); c.roundRect(-w / 2, -h / 2, w, h, rr); c.stroke();
    }
    c.restore();
    this.#touch();
  }
  clear() { this.#c2d.clearRect(0, 0, this.size, this.size); this.#count = 0; this.#touch(); }
  #touch() { this.#dirty = true; this.#count++; }
  /** call once per frame: uploads the canvas when something was painted */
  flush(): boolean {
    if (!this.#dirty) return false;
    this.#dirty = false;
    const img = this.#c2d.getImageData(0, 0, this.size, this.size).data;
    for (let i = 0, n = this.size * this.size; i < n; i++) this.#data[i] = img[i * 4 + 3]; // alpha = coverage
    this.texture.needsUpdate = true;
    return true;
  }
  get shapes() { return this.#count; }
}
