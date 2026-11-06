// Builds the GPU-side terrain data textures from the baked TerrainData: per-sample normal/path/cavity, per-sample info
// (coast distance, badlands, cone, lava streaks) and the 12 splat-layer weights. The splat RULES live here — tune the
// look of the whole island from this one function.
//   • categorical biome edges never show: grass ↔ jungle cross-fade over 20–40 m through a noise-warped blur, POI
//     grounds are trampled grass with dirt + worn paving patches and a noisy 20–40 m edge, the harbor apron frays out
//   • sea floor: bright sand, dark coral patches (the same reefPatch field that raised them), rock on steep drops
//   • basalt only on the cone and in the badlands (no dark apron on the flats at the volcano's foot)
import * as THREE from "three";
import { releaseAfterUpload } from "../../engine/texture-release";
import { onRestore } from "../../engine/res/restore";
import { Biome, POIS, WORLD } from "../../../../shared/world/map";
import { Simplex2, smoothstep } from "../../../../shared/world/noise";
import { HARBOR_APRON, MURK, RIVER, VOLCANO, cliffSkins, poiGroundAt, badlandsAt, kipukaAt, groundWarp, lagoonShoreAt, lavaChannels, padWeight, pathLines, plantationAt, reefPatch, type LavaLine, type TerrainData } from "../../../../shared/world/terrain-gen";
import type { TerrainGpuData } from "./material";
import { layerIndex } from "./layers";
import { TERRAIN_LODV } from "./lod";

const SAND = layerIndex("sand"), GRASS = layerIndex("grass"), JUNGLE = layerIndex("jungle"), PATH = layerIndex("path"),
  CLIFF = layerIndex("cliff"), ROCK = layerIndex("rock"), CINDER = layerIndex("cinder"), FARM = layerIndex("farm"),
  LAVA = layerIndex("lava"), MUD = layerIndex("mud"), REEF = layerIndex("reef"), BASALT = layerIndex("basalt");

/** separable box blur of a res² field (edge-clamped) */
function blur(src: Float32Array, res: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length), n = 2 * r + 1;
  for (let i = 0; i < res; i++) { let acc = 0; for (let j = -r; j <= r; j++) acc += src[i * res + Math.min(res - 1, Math.max(0, j))];
    for (let j = 0; j < res; j++) { tmp[i * res + j] = acc / n; acc += src[i * res + Math.min(res - 1, j + r + 1)] - src[i * res + Math.max(0, j - r)]; } }
  // vertical pass with one running sum per column, walked row by row (the column-major walk was ~25 ms per
  // call at 1201², cache misses; same additions in the same order per column → identical result)
  const acc = new Float64Array(res);
  for (let i = -r; i <= r; i++) { const o = Math.min(res - 1, Math.max(0, i)) * res; for (let j = 0; j < res; j++) acc[j] += tmp[o + j]; }
  for (let i = 0; i < res; i++) {
    const o = i * res, ad = Math.min(res - 1, i + r + 1) * res, sb = Math.max(0, i - r) * res;
    for (let j = 0; j < res; j++) { out[o + j] = acc[j] / n; acc[j] += tmp[ad + j] - tmp[sb + j]; }
  }
  return out;
}

function inPoly(poly: Array<[number, number]>, x: number, z: number): boolean {
  let c = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const za = poly[a][1], zb = poly[b][1];
    if ((za > z) !== (zb > z) && x < poly[a][0] + (z - za) / (zb - za) * (poly[b][0] - poly[a][0])) c = !c;
  }
  return c;
}
/** distance to an open polyline */
function lineDist(pts: Array<[number, number]>, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const ax = pts[i][0], az = pts[i][1], dx = pts[i + 1][0] - ax, dz = pts[i + 1][1] - az, L2 = dx * dx + dz * dz;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
    best = Math.min(best, Math.hypot(x - ax - dx * u, z - az - dz * u));
  }
  return best;
}
function polyEdge(poly: Array<[number, number]>, x: number, z: number): number {
  let best = Infinity;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const ax = poly[b][0], az = poly[b][1], dx = poly[a][0] - ax, dz = poly[a][1] - az, L2 = dx * dx + dz * dz;
    const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2));
    best = Math.min(best, Math.hypot(x - ax - dx * u, z - az - dz * u));
  }
  return inPoly(poly, x, z) ? -best : best;
}

/** the GPU data as plain arrays (worker-safe): dat = 4 RGBA layers (data, info, path, skin), w = 3 RGBA weight layers */
export interface TerrainGpuArrays { dat: Uint8Array; w: Uint8Array; res: number }
export function gpuDataFromArrays(a: TerrainGpuArrays, again: () => TerrainGpuArrays): TerrainGpuData {
  let fresh: TerrainGpuArrays | null = null;
  onRestore("bake", () => { fresh = null; });
  const mk = (a: { res: number }, arr: Uint8Array, layers: number, pick: (g: TerrainGpuArrays) => Uint8Array) => {
    const tex = new THREE.DataArrayTexture(arr, a.res, a.res, layers);
    tex.format = THREE.RGBAFormat; tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    // MIPMAPPED: without mips the 2 m normal / weight / info texels alias wherever a
    // pixel covers more than one of them — from the plane every pixel does, and the lit relief shimmered frame to frame
    if (TERRAIN_LODV) { tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true; tex.anisotropy = 8; }
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.needsUpdate = true;
    return releaseAfterUpload(tex, () => { fresh ??= again(); return { data: pick(fresh), width: a.res, height: a.res, depth: layers }; });
  };
  const size = { res: a.res };
  return { dat: mk(size, a.dat, 4, (g) => g.dat), w: mk(size, a.w, 3, (g) => g.w), res: a.res };
}
export function stepSplatFrom(a: TerrainGpuArrays): { w: Uint8Array; path: Uint8Array; res: number } {
  const N = a.res * a.res, L2 = 2 * N * 4, path = new Uint8Array(N * 3);
  for (let k = 0; k < N; k++) { path[k * 3] = a.dat[k * 4 + 2]; path[k * 3 + 1] = a.dat[L2 + k * 4]; path[k * 3 + 2] = a.dat[L2 + k * 4 + 1]; }
  return { w: a.w, path, res: a.res };
}
/** the CPU half of buildTerrainGpuData — split so terrain.worker.ts can run the per-sample splat rules on
 * row bands in parallel (computeGpuRows) and finish once (finishGpuArrays); in-thread it is both in a row */
export function computeTerrainGpuArrays(t: TerrainData, lava: LavaLine[] = lavaChannels(t)): TerrainGpuArrays {
  const r = computeGpuRows(t, lava, 0, t.res);
  return finishGpuArrays(t, r.data, r.info, r.W);
}
/** rows [i0, i1) of the per-sample pass: full-size arrays, only those rows written */
export interface GpuRows { data: Uint8Array; info: Uint8Array; W: Float32Array[] }
export function computeGpuRows(t: TerrainData, lava: LavaLine[], i0: number, i1: number): GpuRows {
  const res = t.res, N = res * res, C = WORLD.CELL, H = WORLD.HALF;
  const nE = new Simplex2(WORLD.SEED + 88), nPad = new Simplex2(WORLD.SEED + 7), nW = new Simplex2(WORLD.SEED + 19);
  // cavity / ridge term: (blurred − height) at two scales → −1 (ridge) .. +1 (gully)
  const b1 = blur(t.heights, res, 2), b2 = blur(t.heights, res, 7);
  const cav = new Float32Array(N);
  for (let k = 0; k < N; k++) { const c = (b1[k] - t.heights[k]) / 1.6 + (b2[k] - t.heights[k]) / 7; cav[k] = Math.max(-1, Math.min(1, c)); }
  // jungle-ness: the categorical Grass/Jungle split, blurred over ~24 m; a noise warp below turns the blur band into an
  // irregular 20–40 m transition (tongues of jungle into the meadow and back)
  const jung = new Float32Array(N);
  for (let k = 0; k < N; k++) jung[k] = t.biome[k] === Biome.Jungle ? 1 : t.biome[k] === Biome.Grass ? 0 : 0.5;
  const jungB = blur(blur(jung, res, 6), res, 6);
  // lava rivers: signed distance (m) to the nearest traced channel's bank, −4..28 (info.a) — the shader draws the melt,
  // the black levees and the glowing crack fields around them from this one field
  const lavaSd = new Float32Array(N).fill(28);
  for (const L of lava) {
    for (let q = 0; q < L.pts.length; q++) {
      const [px, pz] = L.pts[q], hw = L.hw[q], R = hw + 28;
      const j0 = Math.max(0, Math.floor((px - R + H) / C)), j1 = Math.min(res - 1, Math.ceil((px + R + H) / C));
      const i0 = Math.max(0, Math.floor((pz - R + H) / C)), i1 = Math.min(res - 1, Math.ceil((pz + R + H) / C));
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k = i * res + j, d = Math.hypot(-H + j * C - px, -H + i * C - pz) - hw;
        if (d < lavaSd[k]) lavaSd[k] = d;
      }
    }
  }
  // band-sized outputs (row i0 → 0): a worker holds only its band
  const NB = (i1 - i0) * res, o0 = i0 * res;
  const data = new Uint8Array(NB * 4), info = new Uint8Array(NB * 4);
  const W = Array.from({ length: 12 }, () => new Float32Array(NB));
  const hs = t.heights, w = new Float32Array(12);
  const pads = POIS.filter((p) => p.padY !== null && p.id !== "peel-harbor" && p.id !== "the-plantation" && p.id !== "lobby-islet");
  const V = VOLCANO;
  for (let i = i0; i < i1; i++) {
    const z = -H + i * C, iz = Math.min(res - 2, Math.max(1, i));
    for (let j = 0; j < res; j++) {
      const x = -H + j * C, k = i * res + j, jx = Math.min(res - 2, Math.max(1, j)), kc = iz * res + jx;
      const h = hs[k];
      const dx = (hs[kc + 1] - hs[kc - 1]) / (2 * C), dz = (hs[kc + res] - hs[kc - res]) / (2 * C);
      let nx = -dx, ny = 1, nz = -dz; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const slope = Math.hypot(dx, dz);
      const coast = t.coast[k], path = t.path[k] / 255, b = t.biome[k];
      data[(k - o0) * 4] = Math.round((nx * 0.5 + 0.5) * 255); data[(k - o0) * 4 + 1] = Math.round((nz * 0.5 + 0.5) * 255);
      data[(k - o0) * 4 + 2] = t.path[k]; data[(k - o0) * 4 + 3] = Math.round((cav[k] * 0.5 + 0.5) * 255);

      const vr = Math.hypot(x - V.x, z - V.z);
      // kipukas: the vegetated islands in the lava field (biome Grass / Jungle there) are not badlands ground
      const bad = badlandsAt(x, z) * (b === Biome.Grass || b === Biome.Jungle ? 1 - kipukaAt(x, z) : 1);
      const cone = (1 - smoothstep(V.cone - 10, V.cone + 30, vr)) * smoothstep(70, 110, h);
      info[(k - o0) * 4] = Math.round((Math.max(-127, Math.min(127, coast)) + 127) / 254 * 255);
      info[(k - o0) * 4 + 1] = Math.round(bad * 255);
      info[(k - o0) * 4 + 2] = Math.round(cone * 255);
      info[(k - o0) * 4 + 3] = Math.round(Math.max(0, Math.min(1, (lavaSd[k] + 4) / 32)) * 255);

      w.fill(0);
      if (h < 0) {
        // lagoon bed: light sand with a little silt + sea grass (~(170,160,120)) so the shallow water reads TEAL
        if (b === Biome.Lagoon) {
          // THE MURK's swamp pools: a dark peaty bed (light sand reads as pale-blue snow patches from the air)
          const murk = 1 - smoothstep(MURK.r * 0.8, MURK.r * 1.3, Math.hypot(x - MURK.x, (z - MURK.z) * 1.1));
          // (the shallow margin along the shores is dark sea-grass / silt, not a tan sand band round the pool)
          const shallow = smoothstep(-1.4, -0.5, h);
          w[SAND] = (0.6 - 0.35 * shallow) * (1 - murk); w[MUD] = 0.25 + 0.2 * shallow + 0.5 * murk; w[REEF] = 0.15 + 0.15 * shallow; w[JUNGLE] = 0.25 * murk;
        }
        else {
          // bright sand floor with dark coral patches; patches fade out in the deep (the water hides them anyway)
          const reef = reefPatch(x, z) * smoothstep(-0.8, -2.5, h) * (1 - smoothstep(-16, -28, h));
          w[REEF] = reef; w[SAND] = 1 - reef;
        }
        w[ROCK] += smoothstep(0.8, 1.4, slope) * 1.5;
      } else {
        switch (b) {
          // (dirt paths are NOT a splat layer: the shader draws them as a crisp overlay from the unblurred 2 m
          // path mask (data.b) — the blurred splat weights turned a 2.5 m trail into a 6 m ochre smear)
          case Biome.Grass: case Biome.Jungle: case Biome.Path: {
            const jj = Math.min(1, Math.max(0, (jungB[k] - 0.5) * 1.7 + 0.5 + 0.55 * nE.fbm(x / 34, z / 34, 3)));
            const js = smoothstep(0.3, 0.7, jj);
            w[JUNGLE] = 0.85 * js; w[GRASS] = 1 - 0.85 * js; break;
          }
          case Biome.Beach: w[SAND] = 1; break;
          case Biome.Cinder: w[CINDER] = 1; break;
          case Biome.Farmland: w[FARM] = 1; break;
          // (Paved on a lava channel = the molten river cells, tagged so nothing grows there: black cinder under the melt)
          case Biome.Paved: if (lavaSd[k] < 3) w[CINDER] = 1; else { w[PATH] = 0.55; w[ROCK] = 0.45; } break;
          case Biome.Rock: w[ROCK] = 1; break;
          // (greener mangrove shore: 60 % jungle / 40 % mud reads as a bare brown band round the STILT TOWN pool)
          case Biome.Lagoon: w[JUNGLE] = 0.55; w[GRASS] = 0.3; w[MUD] = 0.15; break;
          default: w[GRASS] = 1;
        }
        // soft beach edge: low ground near the open sea fades to sand (unless cliff foot / lagoon shore)
        if (b !== Biome.Lagoon) {
          const sandW = Math.max(b === Biome.Beach ? 1 : 0, (1 - smoothstep(2.4 + 0.8 * nE.fbm(x / 25, z / 25, 2), 3.8, h)) * (coast < 80 ? 1 : 0) * (1 - smoothstep(0.6, 1.1, slope)) * (1 - lagoonShoreAt(x, z)));
          if (sandW > 0 && b !== Biome.Farmland) { for (let q = 0; q < 12; q++) w[q] *= 1 - sandW; w[SAND] += sandW; }
        }
        // POI grounds (never pale-lime discs from the air): the pad weight is read through the same 40–80 m
        // domain warp as the biome pass (irregular lobes, never a disc), the ground is the surrounding mix of grass AND
        // jungle floor (patches, so its mean colour matches the jungle around it), trampled dirt only on FLAT ground
        // (< 15°) inside pad + 0.3 × blend, a little worn paving near the centre
        if (pads.length) {
          const [wx, wz] = groundWarp(nW, x, z);
          for (const p of pads) {
            const pd = Math.hypot(x - p.x, z - p.z);
            if (pd > p.pad + p.blend + 45) continue;
            const pw = smoothstep(0.2, 0.8, padWeight(nPad, p.x, p.z, p.pad, p.blend, wx, wz) + 0.35 * nE.fbm(x / 45 + 5, z / 45, 3));
            if (pw <= 0 || b === Biome.Rock) continue;
            const core = 1 - smoothstep(p.pad * 0.2, p.pad * 0.8, pd);
            const flat = 1 - smoothstep(0.2, 0.27, slope), inner = 1 - smoothstep(p.pad, p.pad + 0.3 * p.blend, pd);
            const dirt = smoothstep(0.25, 0.65, nE.fbm(x / 70 + 11, z / 70, 3) + 0.2 * core) * 0.3 * flat * inner;
            const pave = core * 0.25 * smoothstep(0.35, 0.6, nE.fbm(x / 24 + 2, z / 24 + 7, 2)) * flat;
            const jf = 0.55 * smoothstep(0.0, 0.35, nE.fbm(x / 38 + 17, z / 38 - 4, 3)) * (1 - 0.6 * core);   // jungle-floor patches
            for (let q = 0; q < 12; q++) w[q] *= 1 - pw;
            const g = pw * (1 - dirt) * (1 - pave);
            w[GRASS] += g * (1 - jf); w[JUNGLE] += g * jf; w[PATH] += pw * dirt * (1 - pave); w[ROCK] += pw * pave;
          }
        }
        // harbor apron: the paving frays into gravel + grass over ~15 m instead of a polygon edge
        if (x > 400 && x < 920 && z > 150 && z < 580) {
          const e = polyEdge(HARBOR_APRON, x, z) + 7 * nE.fbm(x / 18, z / 18, 2);
          const pv = 1 - smoothstep(-8, 8, e);
          if (pv > 0 && b !== Biome.Beach) { for (let q = 0; q < 12; q++) w[q] *= 1 - pv; w[PATH] += pv * 0.6; w[ROCK] += pv * 0.4; }
        }
        // the cone: cinder (tinted chocolate in the shader) with jungle creeping up the lower flank
        if (cone > 0) { for (let q = 0; q < 12; q++) w[q] *= 1 - cone; w[CINDER] += cone; }
        // badlands: ONE layer (black cinder) — the shader draws the cracked crust plates procedurally over it (blending
        // cinder + crust-texture + basalt on every flat pixel costs 3 layer fetch sets for one black ground)
        if (bad > 0.05 && h > 1) {
          const bw = smoothstep(0.1, 0.6, bad);
          for (let q = 0; q < 12; q++) w[q] *= 1 - bw;
          w[CINDER] += bw;
        }
        // slope rock: tan layered sandstone near the coast / low hills, grey granite inland, basalt only on the cone
        // proper and in the badlands (never on the flats at the volcano's foot)
        // (grass holds on steep hillsides up to ~42°; bare rock only on real walls. Tan sandstone on the sea cliffs,
        // grey granite inland — tan inland slopes read as landslide scars from the air)
        const cone2 = vr < V.cone + 15 && h > 80;
        // bare rock only on real walls (> ~45°); 38–50° ground is a grass / rock MOTTLE (outcrops poking through turf)
        // instead of a flat grey smear — the target art's hillsides are green with rock patches
        // (on the sea-cliff coast bare rock starts at ~50° — the carved rock tiers ARE the walls; the terrace
        // benches and lips between them are turf, not beige cliff-texture shelves)
        // (inland rock starts at ~43° — > 45° is a slide in the sim (shared/sim/player.ts), so the ground
        // you cannot walk up reads as rock outcrop, not turf)
        let rockAmt = cone2 || bad > 0.3 ? smoothstep(0.75, 1.25, slope) : coast < 90 ? smoothstep(1.2, 1.7, slope) : smoothstep(0.93, 1.3, slope);
        // (no grey dice on bald grey slopes): inland the Rock-biome mottle is sparser (outcrops in turf /
        // jungle floor), the sea-cliff coast keeps its bare rock
        if (b === Biome.Rock && !cone2 && bad <= 0.3) rockAmt = Math.max(rockAmt, smoothstep(0.78, 1.0, slope) * smoothstep(0.1, 0.45, nE.fbm(x / 9 + 31, z / 9, 3)) * (coast < 90 ? 0.45 : 0.5));
        else if (b === Biome.Rock) rockAmt = Math.max(rockAmt, 0.8);
        if (rockAmt > 0) {
          for (let q = 0; q < 12; q++) w[q] *= 1 - rockAmt;
          if (cone2) { w[BASALT] += rockAmt * 0.75; w[CINDER] += rockAmt * 0.25; }
          else if (bad > 0.3) { w[BASALT] += rockAmt * 0.7; w[CINDER] += rockAmt * 0.3; }   // (no grey granite in the lava field)
          else if (coast < 90) { w[CLIFF] += rockAmt * 0.75; w[ROCK] += rockAmt * 0.25; }
          // inland: mossy grey rock faces with jungle floor + turf between them (70 % bare grey reads from the air as bald grey
          // skirts round the cone foot, gorge and cove backslope)
          else { const m = smoothstep(0.2, 0.55, nE.fbm(x / 14 - 7, z / 14, 3)); w[ROCK] += rockAmt * (0.3 + 0.35 * m); w[JUNGLE] += rockAmt * (0.5 - 0.25 * m); w[GRASS] += rockAmt * (0.2 - 0.1 * m); }
        }
        // MIST FALLS river bed (pool → lagoon): wet teal-brown silt with pebbles, so the channel reads as a river bed
        // (under poi-jungle's water, and from the air) instead of a dry grey ditch
        if (x > -180 && x < 310 && z > -450 && z < -290) {
          const rd = lineDist(RIVER, x, z), rw = 1 - smoothstep(9, 15, rd + 2 * nE.fbm(x / 14, z / 14, 2));
          if (rw > 0) { for (let q = 0; q < 12; q++) w[q] *= 1 - rw; w[MUD] += rw * 0.55; w[REEF] += rw * 0.25; w[ROCK] += rw * 0.2; }
        }
        // plantation field: the POI's planted disc keeps its rows even where the biome says grass
        const pf = plantationAt(x, z);
        if (pf > 0.02) { const f = pf * (1 - rockAmt); for (let q = 0; q < 12; q++) w[q] *= 1 - f; w[FARM] += f; }
      }
      let s = 0; for (let q = 0; q < 12; q++) s += w[q];
      const f = s > 0 ? 1 / s : 0;
      for (let q = 0; q < 12; q++) W[q][k - o0] = w[q] * f;
    }
  }
  return { data, info, W };
}
/** the global passes after the per-sample splat: soften + pack the weights, single-layer flags, path ribbons, POI
 * rings, cliff-skin layer */
export function finishGpuArrays(t: TerrainData, data: Uint8Array, info: Uint8Array, W: Float32Array[]): TerrainGpuArrays {
  const res = t.res, N = res * res, C = WORLD.CELL, H = WORLD.HALF;
  const pads = POIS.filter((p) => p.padY !== null && p.id !== "peel-harbor" && p.id !== "the-plantation" && p.id !== "lobby-islet");
  // soften the categorical edges (1 cell) — the shader's (capped) height blend sharpens them back organically
  const pack = (a: number, bI: number, c: number, d: number) => {
    const A = blur(W[a], res, 1), B = blur(W[bI], res, 1), Cc = blur(W[c], res, 1), D = blur(W[d], res, 1);
    const arr = new Uint8Array(N * 4);
    for (let k = 0; k < N; k++) { arr[k * 4] = A[k] * 255; arr[k * 4 + 1] = B[k] * 255; arr[k * 4 + 2] = Cc[k] * 255; arr[k * 4 + 3] = D[k] * 255; }
    return arr;
  };
  const w0 = pack(0, 1, 2, 3), w1 = pack(4, 5, 6, 7), w2 = pack(8, 9, 10, 11);
  // single-layer flag (perf): where the (blurred) splat is ≥ 97 % one layer across the whole 5×5-sample (±4 m)
  // neighbourhood — open sand, the cinder field, sea floor, rock walls — the shader skips the warp-noise + 3 weight fetches
  // and uses that layer alone. Stored in path.b = 20·(layer + 1) (0 = mixed); read with texelFetch (no filtering).
  const dom = new Int8Array(N).fill(-1);
  for (let k = 0; k < N; k++) {
    const packs = [w0, w1, w2];
    for (let q = 0; q < 12; q++) if (packs[q >> 2][k * 4 + (q & 3)] >= 247) { dom[k] = q; break; }
  }
  const single = new Uint8Array(N);
  for (let i = 2; i < res - 2; i++) for (let j = 2; j < res - 2; j++) {
    const k = i * res + j, d = dom[k]; if (d < 0) continue;
    let ok = true;
    for (let a = -2; a <= 2 && ok; a++) for (let b2 = -2; b2 <= 2; b2++) if (dom[k + a * res + b2] !== d) { ok = false; break; }
    if (ok) single[k] = 20 * (d + 1);
  }
  // dirt-path ribbon geometry: per 2 m sample the SIGNED lateral offset from the nearest path centreline
  // (r = 128 + 20·offset, ±6.4 m) and that path's half-width (g = 40·hw). A signed offset is LINEAR across a path, so
  // bilinear filtering reproduces it exactly and the shader's |offset| < hw ribbon has smooth, constant-width edges (the
  // unsigned coverage mask is V-shaped across a 3 m trail = 1.5 cells, which stair-stepped). g = 0: no path here.
  const pth = new Uint8Array(N * 4), best = new Float32Array(N).fill(99);
  for (const P of pathLines()) {
    const pts = P.pts, R = P.w + 4;
    for (let q = 0; q + 1 < pts.length; q++) {
      const ax = pts[q][0], az = pts[q][1], bx = pts[q + 1][0], bz = pts[q + 1][1], dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz, L = Math.sqrt(L2) || 1;
      const j0 = Math.max(0, Math.floor((Math.min(ax, bx) - R + H) / C)), j1 = Math.min(res - 1, Math.ceil((Math.max(ax, bx) + R + H) / C));
      const i0 = Math.max(0, Math.floor((Math.min(az, bz) - R + H) / C)), i1 = Math.min(res - 1, Math.ceil((Math.max(az, bz) + R + H) / C));
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const x = -H + j * C, z = -H + i * C, k = i * res + j;
        const u = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (L2 || 1)));
        const ex = x - ax - dx * u, ez = z - az - dz * u, dist = Math.hypot(ex, ez);
        if (dist >= best[k] || dist > R) continue;
        best[k] = dist;
        // signed: + left of the travel direction; at the polyline's ends (u clamped) keep the lateral component's sign
        const off = (dx * (z - az) - dz * (x - ax)) / L >= 0 ? dist : -dist;
        pth[k * 4] = Math.max(0, Math.min(255, Math.round(128 + off * 20)));
        pth[k * 4 + 1] = Math.min(255, Math.round(P.w * 40));
      }
    }
  }
  for (let k = 0; k < N; k++) pth[k * 4 + 2] = single[k];
  // path.a = POI-ground RING weight (the warped POI ground outside its building core): the far bake shades it like the
  // canopy around it (scattered shrubs / copses) so from the air a POI never reads as a pale disc cut into the jungle
  for (const p of pads) {
    const R = p.pad + p.blend + 45;
    const j0 = Math.max(0, Math.floor((p.x - R + H) / C)), j1 = Math.min(res - 1, Math.ceil((p.x + R + H) / C));
    const i0 = Math.max(0, Math.floor((p.z - R + H) / C)), i1 = Math.min(res - 1, Math.ceil((p.z + R + H) / C));
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const x = -H + j * C, z = -H + i * C, k = i * res + j, d = Math.hypot(x - p.x, z - p.z);
      if (d > R) continue;
      const ring = poiGroundAt(x, z) * smoothstep(p.pad * 0.55, p.pad * 1.0, d);
      pth[k * 4 + 3] = Math.max(pth[k * 4 + 3], Math.round(ring * 255));
    }
  }
  // skin layer: r = how far (× 2 m) the terrain's own steep face is pushed back behind a sculpted cliff skin
  // (cliffskin.ts) — 1 on the wall between the skin's foot and lip, feathered toward both ends. Render only.
  const skinW = new Float32Array(N);
  for (const ch of cliffSkins(t)) for (let qi = 0; qi < ch.pts.length; qi++) {
    const q = ch.pts[qi], span = q.d1 - q.d0, endK = smoothstep(0, 8, qi) * smoothstep(0, 8, ch.pts.length - 1 - qi);
    for (let d = q.d0 - 1.5; d <= q.d1 + 0.5; d += 0.5) {
      const x = q.ox + q.nx * d, z = q.oz + q.nz * d, j = Math.round((x + H) / C), i = Math.round((z + H) / C);
      if (i < 0 || j < 0 || i >= res || j >= res) continue;
      const w = endK * smoothstep(q.d0 - 1.5, q.d0 + 0.5, d) * (1 - smoothstep(q.d0 + span * 0.85, q.d1 + 0.5, d));
      const k = i * res + j; if (w > skinW[k]) skinW[k] = w;
    }
  }
  const skinB = blur(skinW, res, 1);
  const skin = new Uint8Array(N * 4);
  for (let k = 0; k < N; k++) skin[k * 4] = Math.round(Math.min(1, Math.max(skinW[k], skinB[k])) * 255);
  // packed into two array textures — see TerrainGpuData
  const packL = (layers: Uint8Array[]) => {
    const arr = new Uint8Array(N * 4 * layers.length);
    layers.forEach((l, i) => arr.set(l, i * N * 4));
    return arr;
  };
  return { dat: packL([data, info, pth, skin]), w: packL([w0, w1, w2]), res };
}
