// poi-town textures: procedural, tileable, generated on typed arrays (no DOM needed except for painted signs), then
// wrapped as DataTextures. Albedo maps for plaster / tin / clapboard / stone / louvre are NEUTRAL light (~0.85–0.95,
// wear = darker detail) so one merged mesh can be tinted per building through vertex colours (the tint multiplies).
// Planks / paving / thatch / sand / stripes are coloured, but kept light so the callers' vertex tints still read.
// Every set ships albedo + normal + ORM (R = ao, G = roughness, B = metalness).
//
// How it is built: whole-tile noise FIELDS (tileable gradient noise summed into Float32Arrays row by row with cached
// lattice weights, low-frequency fields computed small and upsampled), domain warps, wrap-around blurs and a periodic
// Voronoi — composed into a height field (→ normalFrom) + albedo + ORM. Surfaces are laid out from explicit shapes
// (boards, slabs, ribs, courses, bundles) so they read as designed, then layered macro mottle → mid wear → fine grain.
// Orientation: image row y ↔ v = y / n. On walls (box sides, v up) row 0 is the BOTTOM, so drips run toward row 0.
import * as THREE from "three";
import { releaseAfterUpload } from "../../../engine/texture-release";

export interface TexSet { map: THREE.Texture; normalMap: THREE.Texture; orm: THREE.Texture }

type F = Float32Array;
const TAU = Math.PI * 2;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const fract = (x: number) => x - Math.floor(x);
const sstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
/** wrapped distance on a unit torus axis (0..0.5) */
const wd = (a: number) => { const f = a - Math.floor(a); return f > 0.5 ? 1 - f : f; };
/** signed wrapped offset (-0.5..0.5) */
const ws = (a: number) => a - Math.round(a);

// ---------- deterministic PRNG + tileable noise fields
function prng(seed: number): () => number {
  let a = (Math.imul(seed | 0, 2654435761) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** add amp × tileable gradient noise (px cells across u, py cells across v, both integers) into out (n×n) */
function addGrad(out: F, n: number, px: number, py: number, seed: number, amp: number) {
  const r = prng(seed), cells = px * py, gx = new Float32Array(cells), gy = new Float32Array(cells);
  for (let i = 0; i < cells; i++) { const a = r() * TAU; gx[i] = Math.cos(a); gy[i] = Math.sin(a); }
  const c0 = new Int32Array(n), c1 = new Int32Array(n), fa = new Float32Array(n), wa = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    const t = (x + 0.5) / n * px, i = Math.floor(t), f = t - i;
    c0[x] = i % px; c1[x] = (i + 1) % px; fa[x] = f; wa[x] = f * f * f * (f * (f * 6 - 15) + 10);
  }
  for (let y = 0; y < n; y++) {
    const t = (y + 0.5) / n * py, j = Math.floor(t), fy = t - j, wy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const r0 = (j % py) * px, r1 = ((j + 1) % py) * px, o = y * n, fy1 = fy - 1;
    for (let x = 0; x < n; x++) {
      const fx = fa[x], a = r0 + c0[x], b = r0 + c1[x], c = r1 + c0[x], d = r1 + c1[x];
      const na = gx[a] * fx + gy[a] * fy, nb = gx[b] * (fx - 1) + gy[b] * fy;
      const nc = gx[c] * fx + gy[c] * fy1, nd = gx[d] * (fx - 1) + gy[d] * fy1;
      const w = wa[x], top = na + (nb - na) * w, bot = nc + (nd - nc) * w;
      out[o + x] += amp * (top + (bot - top) * wy);
    }
  }
}
/** z-score a field into ~0..1 (mean 0.5, ±2.5σ → 0..1), so thresholds mean the same thing for every field */
function normZ(f: F): F {
  let s = 0, s2 = 0, c = 0; const N = f.length;
  for (let i = 0; i < N; i += 7) { s += f[i]; s2 += f[i] * f[i]; c++; }
  const m = s / c, sd = Math.sqrt(Math.max(1e-12, s2 / c - m * m)), k = 0.2 / sd;
  for (let i = 0; i < N; i++) f[i] = clamp01(0.5 + (f[i] - m) * k);
  return f;
}
/** bilinear, wrapped upsample of an m×m tileable field to n×n */
function upsample(src: F, m: number, n: number): F {
  if (m === n) return src;
  const out = new Float32Array(n * n), k = m / n, x0 = new Int32Array(n), x1 = new Int32Array(n), fx = new Float32Array(n);
  for (let x = 0; x < n; x++) { const t = (x + 0.5) * k - 0.5, i = Math.floor(t); fx[x] = t - i; x0[x] = (i + m) % m; x1[x] = (i + 1 + m) % m; }
  for (let y = 0; y < n; y++) {
    const t = (y + 0.5) * k - 0.5, j = Math.floor(t), fy = t - j, r0 = ((j + m) % m) * m, r1 = ((j + 1 + m) % m) * m, o = y * n;
    for (let x = 0; x < n; x++) {
      const a = src[r0 + x0[x]], b = src[r0 + x1[x]], c = src[r1 + x0[x]], d = src[r1 + x1[x]], f = fx[x], top = a + (b - a) * f;
      out[o + x] = top + (c + (d - c) * f - top) * fy;
    }
  }
  return out;
}
/**
 * tileable fbm field (~0..1). p = cells across u at the base octave, py = cells across v (streaky when ≠ p).
 * Computed at the smallest power-of-two resolution that keeps ≥ 8 px per cell of the finest octave, then upsampled.
 */
function fbmF(n: number, p: number, oct: number, seed: number, gain = 0.5, py = p): F {
  const qmax = Math.max(p, py) * 2 ** (oct - 1);
  let m = 32; while (m < n && m < qmax * 8) m *= 2; m = Math.min(m, n);
  const out = new Float32Array(m * m);
  let a = 1, qx = p, qy = py;
  for (let i = 0; i < oct && qx <= m / 2 && qy <= m / 2; i++) { addGrad(out, m, qx, qy, seed * 97 + i * 13, a); a *= gain; qx *= 2; qy *= 2; }
  return upsample(normZ(out), m, n);
}
/** approximate q-quantile of a field (coverage control: `f > quant(f, 0.85)` ≈ 15% of the tile) */
function quant(f: F, q: number): number {
  const s: number[] = [];
  for (let i = 0; i < f.length; i += 61) s.push(f[i]);
  s.sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
function samp(f: F, n: number, X: number, Y: number): number {
  const x0 = Math.floor(X), y0 = Math.floor(Y), fx = X - x0, fy = Y - y0;
  const xa = ((x0 % n) + n) % n, ya = ((y0 % n) + n) % n, xb = xa + 1 === n ? 0 : xa + 1, yb = ya + 1 === n ? 0 : ya + 1;
  const a = f[ya * n + xa], b = f[ya * n + xb], c = f[yb * n + xa], d = f[yb * n + xb], top = a + (b - a) * fx;
  return top + (c + (d - c) * fx - top) * fy;
}
/** resample src at (x + (wx-0.5)·2·amt, y + (wy-0.5)·2·amt) pixels, bilinear, wrapped */
function warpF(src: F, n: number, wx: F, wy: F, amt: number): F {
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    out[i] = samp(src, n, x + (wx[i] - 0.5) * 2 * amt, y + (wy[i] - 0.5) * 2 * amt);
  }
  return out;
}
/** wrap-around separable box blur (2 passes ≈ gaussian); rows only touched sequentially */
function blurF(src: F, n: number, r: number, passes = 2): F {
  const a = Float32Array.from(src), b = new Float32Array(n * n), add = new Int32Array(n), sub = new Int32Array(n), S = new Float32Array(n);
  for (let x = 0; x < n; x++) { add[x] = (x + r + 1) % n; sub[x] = (x - r + n * 8) % n; }
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < n; y++) {
      const o = y * n; let s = 0;
      for (let k = -r; k <= r; k++) s += a[o + (k + n * 8) % n];
      for (let x = 0; x < n; x++) { b[o + x] = s * inv; s += a[o + add[x]] - a[o + sub[x]]; }
    }
    S.fill(0);
    for (let k = -r; k <= r; k++) { const o = ((k + n * 8) % n) * n; for (let x = 0; x < n; x++) S[x] += b[o + x]; }
    for (let y = 0; y < n; y++) {
      const o = y * n, oa = add[y] * n, os = sub[y] * n;
      for (let x = 0; x < n; x++) { a[o + x] = S[x] * inv; S[x] += b[oa + x] - b[os + x]; }
    }
  }
  return a;
}
/** cavity AO from a height field: darkens where the surface sits below its blurred neighbourhood */
function cavityAO(h: F, n: number, r: number, k: number, floor = 0.35): F {
  const b = blurF(h, n, r, 2), ao = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) ao[i] = Math.max(floor, 1 - Math.max(0, b[i] - h[i]) * k);
  return ao;
}

/** periodic jittered cell points (Voronoi / Worley), stored with a 1-cell wrapped border so lookups need no modulo */
class Cells {
  P: number; x: F; y: F; id: Int32Array; r: F;
  constructor(public p: number, seed: number, jitter = 0.9) {
    const rnd = prng(seed), N = p * p, jx = new Float32Array(N), jy = new Float32Array(N), P = p + 2;
    this.r = new Float32Array(N);
    for (let i = 0; i < N; i++) { jx[i] = 0.5 + (rnd() - 0.5) * jitter; jy[i] = 0.5 + (rnd() - 0.5) * jitter; this.r[i] = rnd(); }
    this.P = P; this.x = new Float32Array(P * P); this.y = new Float32Array(P * P); this.id = new Int32Array(P * P);
    for (let cy = -1; cy <= p; cy++) for (let cx = -1; cx <= p; cx++) {
      const k = ((cy + p) % p) * p + ((cx + p) % p), q = (cy + 1) * P + cx + 1;
      this.x[q] = cx + jx[k]; this.y[q] = cy + jy[k]; this.id[q] = k;
    }
  }
}
// scratch results of vor(): nearest / second distance (cell units), nearest id, offset to the nearest point
let W1 = 0, WID = 0;
function vor(c: Cells, u: number, v: number) {
  const p = c.p, P = c.P, X = (u - Math.floor(u)) * p, Y = (v - Math.floor(v)) * p;
  let xi = X | 0, yi = Y | 0; if (xi >= p) xi = p - 1; if (yi >= p) yi = p - 1;
  let d1 = 1e9, d2 = 1e9, q1 = 0;
  const cx = c.x, cy = c.y;
  for (let j = 0; j < 3; j++) {
    const row = (yi + j) * P + xi;
    for (let i = 0; i < 3; i++) {
      const q = row + i, dx = cx[q] - X, dy = cy[q] - Y, d = dx * dx + dy * dy;
      if (d < d1) { d2 = d1; d1 = d; q1 = q; } else if (d < d2) d2 = d;
    }
  }
  W1 = Math.sqrt(d1); WID = c.id[q1];
}
/** rounded-corner inside distance from two edge distances (rc = corner radius) */
function rmin(a: number, b: number, rc: number): number {
  if (a < rc && b < rc) return rc - Math.hypot(rc - a, rc - b);
  return a < b ? a : b;
}
/** random partition of [offset, offset+1) into k pieces with relative sizes in [lo,hi] → cumulative edges (length k+1) */
function partition(k: number, lo: number, hi: number, rnd: () => number, offset = 0): number[] {
  const w: number[] = []; let s = 0;
  for (let i = 0; i < k; i++) { const x = lo + (hi - lo) * rnd(); w.push(x); s += x; }
  const e = [offset]; for (let i = 0; i < k; i++) e.push(e[i] + w[i] / s);
  return e;
}
/** index of the piece containing t (edges from partition(), t wrapped into [e0, e0+1)) */
function pieceOf(e: number[], t: number): number {
  const k = e.length - 1; let tt = t - e[0]; tt -= Math.floor(tt); tt += e[0];
  for (let i = 0; i < k; i++) if (tt < e[i + 1]) return i;
  return k - 1;
}
/** per-column piece lookup for a partition of U: id, metres to the left/right edge, 0..1 position inside */
function columns(e: number[], n: number, M: number) {
  const id = new Int32Array(n), dl = new Float32Array(n), dr = new Float32Array(n), pos = new Float32Array(n);
  for (let x = 0; x < n; x++) {
    const u = (x + 0.5) / n, k = pieceOf(e, u), e0 = e[k], e1 = e[k + 1];
    let t = u - e0; t -= Math.floor(t); t += e0;
    id[x] = k; dl[x] = (t - e0) * M; dr[x] = (e1 - t) * M; pos[x] = (t - e0) / (e1 - e0);
  }
  return { id, dl, dr, pos };
}

// ---------- buffers
export interface Img { w: number; h: number; data: Uint8ClampedArray }
const img = (w: number, h: number): Img => ({ w, h, data: new Uint8ClampedArray(w * h * 4) });
function put(im: Img, i: number, r: number, g: number, b: number, a = 255) { const k = i * 4; im.data[k] = r * 255; im.data[k + 1] = g * 255; im.data[k + 2] = b * 255; im.data[k + 3] = a; }

/** normal map from a height field (tileable, central differences). strength in "height units per texel". */
function normalFrom(h: Float32Array, w: number, hh: number, strength: number): Img {
  const out = img(w, hh), xl = new Int32Array(w), xr = new Int32Array(w);
  for (let x = 0; x < w; x++) { xl[x] = (x + w - 1) % w; xr[x] = (x + 1) % w; }
  for (let y = 0; y < hh; y++) {
    const o = y * w, ou = ((y + hh - 1) % hh) * w, od = ((y + 1) % hh) * w;
    for (let x = 0; x < w; x++) {
      const dx = (h[o + xr[x]] - h[o + xl[x]]) * strength, dy = (h[od + x] - h[ou + x]) * strength;
      const l = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      put(out, o + x, 0.5 - dx * l * 0.5, 0.5 - dy * l * 0.5, 0.5 + 0.5 * l); // OpenGL convention: +G = +V (DataTexture, flipY=false)
    }
  }
  return out;
}

function tex(im: Img, srgb: boolean, aniso: number, repeat: boolean, again: () => Img): THREE.DataTexture {
  const t = new THREE.DataTexture(im.data, im.w, im.h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.anisotropy = aniso; t.flipY = false; t.needsUpdate = true;
  return releaseAfterUpload(t, () => { const n = again(); return { data: n.data, width: n.w, height: n.h }; });
}
function ormImg(w: number, h: number, ao: Float32Array | number, rough: Float32Array | number, metal: Float32Array | number = 0): Img {
  const out = img(w, h);
  for (let i = 0; i < w * h; i++) put(out, i, typeof ao === "number" ? ao : clamp01(ao[i]), typeof rough === "number" ? rough : clamp01(rough[i]), typeof metal === "number" ? metal : clamp01(metal[i]));
  return out;
}

// ---------- generators (each returns albedo/normal/orm images; tile = 1 world unit = `metres` metres)
export interface GenOut { albedo: Img; normal: Img; orm: Img; metres: number }

/**
 * Painted render/plaster walls (+ trims; its normal map is also reused by town plastic/metal). NEUTRAL. tile = 3 m.
 * Layers: 1.5 m paint mottle + sponge-painted blotches + faint horizontal brush strokes → grime washes hanging from
 * ledge-like lines with drips (v up, so they run toward v = 0) → clustered paint flakes with a dark rim → stucco grain.
 */
export function genPlaster(n = 1024): GenOut {
  const N = n * n, M = 3.0, alb = img(n, n), h = new Float32Array(N), ro = new Float32Array(N);
  const macro = fbmF(n, 2, 3, 101, 0.55);
  const wx = fbmF(n, 4, 2, 102), wy = fbmF(n, 4, 2, 103);
  const mott = warpF(fbmF(n, 5, 5, 104, 0.62), n, wx, wy, n * 0.05);
  const brush = fbmF(n, 6, 2, 105, 0.5, 48), trowel = fbmF(n, 7, 3, 106, 0.5), grain = fbmF(n, 160, 2, 107, 0.6);
  const drip = fbmF(n, 64, 2, 108, 0.55, 2), wash = fbmF(n, 12, 2, 109, 0.5, 2), top = fbmF(n, 24, 2, 110, 0.5);
  const cluster = fbmF(n, 3, 3, 112, 0.5), flake = warpF(fbmF(n, 28, 3, 115, 0.62), n, wy, wx, n * 0.012);
  const cm = new Float32Array(N);
  for (let i = 0; i < N; i++) cm[i] = 0.55 * flake[i] + 0.45 * cluster[i];
  const qMd = quant(mott, 0.8), qMl = quant(mott, 0.15), qWash = quant(wash, 0.82), qC = quant(cm, 0.972);
  // ledges the grime hangs from: v, u0, width, length (tile units), strength
  const rl = prng(113), L = 6, win = new Float32Array(L * n), lv = new Float32Array(L), len = new Float32Array(L), lk = new Float32Array(L);
  for (let l = 0; l < L; l++) {
    lv[l] = rl(); const u0 = rl(), w = 0.1 + 0.25 * rl(); len[l] = 0.07 + 0.2 * rl(); lk[l] = 0.6 + 0.4 * rl();
    for (let x = 0; x < n; x++) { const du = fract(x / n - u0); win[l * n + x] = du < w ? sstep(0, 0.06, du) * sstep(0, 0.06, w - du) : 0; }
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x, v = y / n;
    let env = 0;
    for (let l = 0; l < L; l++) {
      const wv = win[l * n + x]; if (wv === 0) continue;
      const dv = fract(lv[l] + (top[i] - 0.5) * 0.03 - v);          // ragged top edge, then decays downward
      env += wv * lk[l] * Math.exp(-dv / len[l]) * sstep(0, 0.015, dv);
    }
    const dr = sstep(0.4, 0.72, drip[i]);
    const s = 0.38 * clamp01(env * (0.3 + 0.7 * dr) * (0.75 + 0.5 * (wash[i] - 0.5)) + 0.3 * sstep(qWash - 0.04, qWash + 0.12, wash[i]) * (0.4 + 0.6 * dr));
    const chip = sstep(qC, qC + 0.003, cm[i]), rim = sstep(qC - 0.012, qC, cm[i]) * (1 - chip);
    const md = sstep(qMd - 0.04, qMd + 0.06, mott[i]), ml = sstep(qMl + 0.04, qMl - 0.06, mott[i]);
    let l = 0.91 - 0.11 * (macro[i] - 0.5) - 0.09 * (mott[i] - 0.5) - 0.035 * md + 0.03 * ml + 0.02 * (brush[i] - 0.5) + 0.025 * (grain[i] - 0.5);
    l -= 0.2 * s + 0.05 * rim;
    l = mix(l, 0.9 + 0.06 * (grain[i] - 0.5), chip);
    // alpha = paint coverage: chips (alpha → 0) show the cream under-plaster (town:plaster mixes the tint out there)
    put(alb, i, clamp01(l + 0.004 * s), clamp01(l - 0.008 * s - 0.004 * md), clamp01(l - 0.04 * s - 0.012 * md), Math.round(255 * (1 - chip * 0.92)));
    h[i] = 0.8 * trowel[i] + 0.1 * grain[i] + 0.05 * brush[i] - 0.5 * chip;
    ro[i] = 0.85 + 0.1 * (grain[i] - 0.5) - 0.06 * s + 0.06 * chip;
  }
  const ao = cavityAO(h, n, 4, 2.4, 0.55);
  return { albedo: alb, normal: normalFrom(h, n, n, 3.2), orm: ormImg(n, n, ao, ro), metres: M };
}

/**
 * Corrugated tin (roofs + awnings): 28 sine ribs per 2 m tile (7.1 cm pitch) running along V, two 1 m sheets across U
 * with a proud side-lap rib + cut edge, staggered end-laps, screw rows. NEUTRAL light paint with crest wear + valley
 * grime; rust (the one warm wear tone, kept low-chroma) as long soft streaks down the valleys inside rusting regions,
 * ragged bands along laps / sheet edges, halos round screws and a few flaky patches. tile = 2 m. Roof sheets run V
 * up-slope on one side and down-slope on the other, so nothing here is directional along V.
 */
export function genTin(n = 512): GenOut {
  const N = n * n, M = 2.0, ribs = 28, alb = img(n, n), h = new Float32Array(N), ro = new Float32Array(N), me = new Float32Array(N), ao = new Float32Array(N);
  const wob = fbmF(n, 2, 2, 201), dent = fbmF(n, 3, 3, 202, 0.5);
  const rw1 = fbmF(n, 6, 2, 203), rw2 = fbmF(n, 6, 2, 204), region = fbmF(n, 3, 3, 205, 0.5);
  const flakeR = warpF(fbmF(n, 12, 4, 210, 0.6, 5), n, rw1, rw2, n * 0.02);
  const fineR = fbmF(n, 64, 2, 206, 0.6), vS = fbmF(n, ribs, 2, 207, 0.5, 3), wear = fbmF(n, 56, 2, 208, 0.5, 10), grime = fbmF(n, 3, 3, 209, 0.5, 6);
  const pm = new Float32Array(N);
  for (let i = 0; i < N; i++) pm[i] = 0.6 * flakeR[i] + 0.4 * region[i];
  const qP = quant(pm, 0.94), qV = quant(vS, 0.62), qW = quant(wear, 0.82), qR = quant(region, 0.45);
  const lapV = [0.16, 0.64], sheetTone = [0.02, -0.035];
  const screwV = lapV.map((l) => [fract(l + 0.02), fract(l + 0.5)]);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x, u = x / n, v = y / n;
    const ur = u * ribs + (wob[i] - 0.5) * 0.1, ph = fract(ur), rib = Math.floor(ur);
    const prof = 0.5 + 0.5 * Math.cos(ph * TAU), valley = 1 - prof;
    const s = Math.floor(fract(u) * 2) % 2;
    const du = wd(u * 2) / 2 * M;                              // metres to the nearest sheet side
    const sideLap = sstep(0.05, 0.0, du), cutEdge = sstep(0.004, 0.0, Math.abs(du - 0.036));
    const dv = ws(v - lapV[s]) * M;                            // signed metres from the end-lap line
    const band = sstep(-0.002, 0.004, dv) * sstep(0.045, 0.038, dv), lapLine = sstep(0.006, 0.0, Math.abs(dv)), lapHi = sstep(0.004, 0.0, Math.abs(dv - 0.045));
    const nearLap = Math.exp(-Math.abs(dv - 0.02) / 0.05);
    let screw = 0, halo = 0;
    if ((rib & 1) === 0) for (let k = 0; k < 2; k++) {
      const ddu = ws(ur - Math.round(ur)) / ribs * M, ddv = ws(v - screwV[s][k]) * M, d = Math.hypot(ddu, ddv);
      screw = Math.max(screw, sstep(0.0085, 0.0055, d)); halo = Math.max(halo, Math.exp(-Math.hypot(ddu * 1.8, ddv * 0.5) / 0.02));
    }
    const xq = Math.floor((Math.floor(ur) + 0.5) / ribs * n + n) % n;
    const reg = sstep(qR - 0.05, qR + 0.15, region[i]);
    const streak = sstep(qV, qV + 0.2, vS[y * n + xq]) * Math.pow(valley, 0.5) * (0.25 + 0.75 * reg) * (0.7 + 0.3 * fineR[i]);
    const edgeB = Math.max(nearLap, sideLap * 0.7) * sstep(0.35, 0.6, fineR[i] * 0.6 + reg * 0.4);
    const Rl = clamp01(0.7 * streak + sstep(qP - 0.04, qP + 0.03, pm[i]) + 0.8 * edgeB + 0.7 * halo);
    const Rh = clamp01(sstep(qP + 0.015, qP + 0.05, pm[i]) * (0.7 + 0.3 * fineR[i]) + 0.55 * halo * sstep(0.4, 0.6, fineR[i]) + edgeB * sstep(0.62, 0.75, fineR[i]) * nearLap);
    const cw = sstep(0.8, 0.97, prof) * sstep(qW, qW + 0.08, wear[i]) * (1 - Rl);
    let l = 0.9 + sheetTone[s] - 0.07 * valley - 0.06 * (grime[i] - 0.5) * (0.5 + valley) - 0.03 * dent[i] + 0.06 * cw - 0.04 * sideLap * valley;
    l -= 0.22 * lapLine + 0.12 * cutEdge; l += 0.05 * lapHi;
    let r = l, g = l, b = l;
    r = mix(r, 0.8 * l + 0.06, Rl * 0.8); g = mix(g, 0.6 * l + 0.04, Rl * 0.8); b = mix(b, 0.46 * l + 0.03, Rl * 0.8);
    r = mix(r, 0.52, Rh); g = mix(g, 0.35, Rh); b = mix(b, 0.25, Rh);
    if (screw > 0) { r = mix(r, 0.45, screw); g = mix(g, 0.44, screw); b = mix(b, 0.43, screw); }
    put(alb, i, clamp01(r), clamp01(g), clamp01(b));
    h[i] = prof + 0.18 * band + 0.25 * sideLap * prof + 0.3 * dent[i] - 0.12 * Rh * fineR[i] + 0.22 * screw - 0.12 * lapLine;
    ro[i] = 0.4 + 0.1 * grime[i] + 0.3 * Rl + 0.2 * Rh - 0.12 * cw;
    me[i] = 0.14 * (1 - Rl) + 0.2 * cw;   // 0.14, not 0.3 (higher reads dark slate on painted / galvanised sheet under the sky IBL)
    ao[i] = (0.8 + 0.2 * prof) * (1 - 0.35 * lapLine) * (1 - 0.2 * cutEdge);
  }
  return { albedo: alb, normal: normalFrom(h, n, n, 3.6), orm: ormImg(n, n, ao, ro, me), metres: M };
}

/**
 * Vertical clapboard / board-and-batten for the stilt huts: 16 boards of 10–15 cm per 2 m tile, deep V grooves,
 * rounded edges, per-board tilt/cup + tone, tight butt joints, knots, nail rows with rust drips (v up), faint vertical
 * grime, and paint flaking along the grain in clusters (exposed weathered wood is darker + warmer). NEUTRAL paint.
 * tile = 2 m.
 */
export function genClapboard(n = 512): GenOut {
  const N = n * n, M = 2.0, B = 16, alb = img(n, n), h = new Float32Array(N), ro = new Float32Array(N), ao = new Float32Array(N);
  const rnd = prng(301), edges = partition(B, 0.75, 1.3, rnd, 0), col = columns(edges, n, M);
  const tone = new Float32Array(B), tilt = new Float32Array(B), cup = new Float32Array(B), goff = new Int32Array(B), peelB = new Float32Array(B), bj = new Float32Array(B);
  for (let k = 0; k < B; k++) { tone[k] = (rnd() - 0.5) * 0.09; tilt[k] = (rnd() - 0.5) * 0.7; cup[k] = 0.1 + 0.25 * rnd(); goff[k] = Math.floor(rnd() * n); peelB[k] = (rnd() - 0.45) * 0.08; bj[k] = rnd() < 0.4 ? rnd() : -1; }
  const K = 9, ku = new Float32Array(K), kv = new Float32Array(K), kr = new Float32Array(K);
  for (let k = 0; k < K; k++) { const b = Math.floor(rnd() * B); ku[k] = fract(edges[b] + (edges[b + 1] - edges[b]) * (0.3 + 0.4 * rnd())); kv[k] = rnd(); kr[k] = 0.006 + 0.01 * rnd(); }
  const grain = fbmF(n, 64, 3, 302, 0.55, 3), fine = fbmF(n, 128, 1, 303, 0.5, 6);
  const pw1 = fbmF(n, 10, 2, 304), pw2 = fbmF(n, 10, 2, 305);
  const flake = warpF(fbmF(n, 28, 3, 306, 0.6, 4), n, pw1, pw2, n * 0.01), jag = fbmF(n, 96, 1, 309, 0.5, 24);
  const cluster = fbmF(n, 3, 3, 307, 0.5, 2), grime = fbmF(n, 3, 3, 308, 0.5, 2), vg = fbmF(n, 40, 2, 310, 0.5, 2);
  const pf = new Float32Array(N);
  for (let i = 0; i < N; i++) pf[i] = 0.45 * flake[i] + 0.4 * cluster[i] + 0.15 * jag[i];
  const qP = quant(pf, 0.93), nailV = [0.22, 0.72];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x, u = x / n, v = y / n, k = col.id[x];
    const e = Math.min(col.dl[x], col.dr[x]), ev = bj[k] >= 0 ? wd(v - bj[k]) * M : 1;
    const gap = sstep(0.0045, 0.002, e), bev = sstep(0.002, 0.014, rmin(e, ev + 0.002, 0.006)), butt = sstep(0.0022, 0.0008, ev);
    const p = col.pos[x], hc = cup[k] * (1 - (2 * p - 1) * (2 * p - 1)) + tilt[k] * (p - 0.5);
    const gy = ((y + goff[k]) % n) * n + x, gr = grain[gy], fi = fine[gy];
    let kn = 0, ring = 0;
    for (let q = 0; q < K; q++) {
      const dx = wd(u - ku[q]) * M; if (dx > 0.05) continue;
      const dd = Math.hypot(dx, wd(v - kv[q]) * M / 1.7), r0 = kr[q];
      if (dd < r0 * 2.4) { kn = Math.max(kn, sstep(r0, r0 * 0.55, dd)); ring = Math.max(ring, sstep(r0 * 2.4, r0, dd) * (1 - sstep(r0, r0 * 0.55, dd))); }
    }
    let nail = 0, drip = 0;
    const dxn = wd(u - fract((edges[k] + edges[k + 1]) * 0.5)) * M;
    if (dxn < 0.02) for (let q = 0; q < 2; q++) {
      const dy = ws(v - nailV[q]) * M;
      nail = Math.max(nail, sstep(0.006, 0.0038, Math.hypot(dxn, dy)));
      if (dy < 0 && dy > -0.25) drip = Math.max(drip, sstep(0.005, 0.0012, dxn) * Math.exp(dy / 0.07) * (0.4 + 0.6 * hash2(k, q + 3)));
    }
    const pv = pf[i] + peelB[k] + 0.05 * (1 - sstep(0.004, 0.025, Math.min(e, ev))) + 0.04 * ring;
    const peel = sstep(qP - 0.003, qP + 0.006, pv), lip = sstep(qP - 0.025, qP - 0.003, pv) * (1 - peel);
    const streak = sstep(0.55, 0.8, vg[i]) * (0.5 + 0.5 * grime[i]);
    let l = 0.915 + tone[k] - 0.05 * (gr - 0.5) - 0.025 * (fi - 0.5) - 0.05 * (grime[i] - 0.5) - 0.035 * lip - 0.05 * streak;
    let r = l, g = l, b = l;
    const w = 0.56 + 0.12 * (gr - 0.5) + 0.06 * (fi - 0.5);
    r = mix(r, w + 0.035, peel); g = mix(g, w, peel); b = mix(b, w - 0.05, peel);
    const kd = kn * 0.4 + ring * 0.1;
    r -= kd; g -= kd * 1.05; b -= kd * 1.12;
    r = mix(r, 0.64, drip * 0.5); g = mix(g, 0.52, drip * 0.5); b = mix(b, 0.44, drip * 0.5);
    r = mix(r, 0.32, nail); g = mix(g, 0.31, nail); b = mix(b, 0.3, nail);
    const gd = 1 - 0.74 * gap - 0.35 * butt - 0.08 * (1 - bev);
    put(alb, i, clamp01(r * gd), clamp01(g * gd), clamp01(b * gd));
    h[i] = 0.8 * bev + 0.4 * hc * bev + 0.07 * (1 - peel) + 0.07 * gr * (0.4 + 0.6 * peel) + 0.03 * fi + 0.08 * kn - 0.2 * gap + 0.05 * nail;
    ro[i] = 0.64 + 0.22 * peel + 0.06 * (gr - 0.5) + 0.1 * gap;
    ao[i] = 1 - 0.55 * gap - 0.2 * butt - 0.12 * (1 - bev);
  }
  return { albedo: alb, normal: normalFrom(h, n, n, 2.4), orm: ormImg(n, n, ao, ro), metres: M };
}

/**
 * Deck planks: 10 planks (~20 cm) per 2 m tile running along U, 8 mm gaps, butt joints on 40 cm joist lines with nail
 * pairs, flowing grain lines + long streaks and the odd drying check, per-plank tone/hue + grey weathering along the
 * grain, worn edges, dark end grain + nail stains. Coloured but LIGHT (callers tint with their final wood colour, e.g.
 * #b98b58 / #5b3c1e); `dark` = older, greyer boards. tile = 2 m.
 */
export function genPlanks(n = 512, dark = false): GenOut {
  const N = n * n, M = 2.0, R = 10, J = 5, alb = img(n, n), h = new Float32Array(N), ro = new Float32Array(N), ao = new Float32Array(N);
  const rnd = prng(dark ? 411 : 401), rows = partition(R, 0.88, 1.12, rnd, 0);
  const tone = new Float32Array(R), grey = new Float32Array(R), goff = new Int32Array(R), cup = new Float32Array(R), hue = new Float32Array(R), lph = new Float32Array(R);
  const jA = new Float32Array(R), jB = new Float32Array(R);
  for (let k = 0; k < R; k++) {
    tone[k] = (rnd() - 0.5) * 0.16; grey[k] = rnd() * rnd(); goff[k] = Math.floor(rnd() * n); cup[k] = (rnd() - 0.3) * 0.5; hue[k] = rnd() - 0.5; lph[k] = rnd();
    jA[k] = (Math.floor(rnd() * J) + 0.5) / J; jB[k] = rnd() < 0.4 ? fract(jA[k] + (Math.floor(rnd() * 2) + 2) / J) : -1;
  }
  const rid = new Int32Array(n), dT = new Float32Array(n), dB = new Float32Array(n), rpos = new Float32Array(n);
  for (let y = 0; y < n; y++) {
    const v = (y + 0.5) / n, k = pieceOf(rows, v), e0 = rows[k], e1 = rows[k + 1];
    let t = v - e0; t -= Math.floor(t); t += e0;
    rid[y] = k; dB[y] = (t - e0) * M; dT[y] = (e1 - t) * M; rpos[y] = (t - e0) / (e1 - e0);
  }
  const streak = fbmF(n, 3, 3, 402, 0.6, 96), flow = fbmF(n, 4, 3, 403, 0.5, 4), weather = fbmF(n, 4, 3, 404, 0.55, 20);
  const fine = fbmF(n, 8, 2, 405, 0.5, 192), check = fbmF(n, 2, 2, 406, 0.5, 160);
  const qW = quant(weather, 0.62), qC = quant(check, 0.985);
  const base = dark ? [0.68, 0.61, 0.54] : [0.86, 0.75, 0.62], greyC = dark ? [0.62, 0.61, 0.6] : [0.8, 0.78, 0.74];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x, u = x / n, k = rid[y];
    let du = wd(u - jA[k]) * M; if (jB[k] >= 0) du = Math.min(du, wd(u - jB[k]) * M);
    const e = Math.min(dT[y], dB[y]), d = rmin(e, du, 0.004), H = dT[y] + dB[y];
    const gap = sstep(0.0042, 0.0025, d), bev = sstep(0.0025, 0.012, d);
    const p = rpos[y], hc = cup[k] * (1 - (2 * p - 1) * (2 * p - 1));
    const gi = ((y + goff[k]) % n) * n + x, g = streak[gi], fi = fine[gi];
    // flowing grain lines: ~8 per plank, bent by a slow field along the board
    const gl = Math.abs(2 * fract(p * 8 + (flow[gi] - 0.5) * 5 + lph[k] * 3) - 1), lines = Math.pow(1 - gl, 8);
    const chk = sstep(qC, qC + 0.004, check[gi]) * sstep(0.2, 0.3, p) * sstep(0.8, 0.7, p);
    const ju = (Math.round(u * J - 0.5) + 0.5) / J, dj = ws(u - ju) * M;
    let nail = 0;
    for (const off of [-0.025, 0.025]) {
      const ddx = dj - off; if (Math.abs(ddx) > 0.012) continue;
      for (const pp of [0.27, 0.73]) nail = Math.max(nail, sstep(0.005, 0.003, Math.hypot(ddx, (p - pp) * H)));
    }
    const endG = Math.exp(-du / 0.012) * (1 - gap), nearNail = Math.exp(-Math.abs(dj) / 0.03) * 0.5;
    const wth = clamp01(grey[k] * 0.7 + sstep(qW - 0.12, qW + 0.12, weather[gi]) * 0.55);
    const st = endG * 0.6 + nearNail * 0.25;
    const edgeWear = sstep(0.0025, 0.0055, d) * (1 - sstep(0.007, 0.016, d));
    const lum = 1 + tone[k] - 0.08 * (g - 0.5) - 0.07 * lines - 0.04 * (fi - 0.5) + 0.07 * edgeWear - 0.35 * chk;
    const hr = 1 + 0.05 * hue[k], hb = 1 - 0.06 * hue[k];
    let r = mix(base[0] * hr, greyC[0], wth) * lum, gg = mix(base[1], greyC[1], wth) * lum, b = mix(base[2] * hb, greyC[2], wth) * lum;
    const sd = 1 - 0.25 * st; r *= sd; gg *= sd * 0.98; b *= sd * 0.95;
    r = mix(r, 0.26, nail); gg = mix(gg, 0.24, nail); b = mix(b, 0.22, nail);
    const gd = 1 - 0.78 * gap;
    put(alb, i, clamp01(r * gd), clamp01(gg * gd), clamp01(b * gd * 0.95));
    h[i] = 0.8 * bev + 0.25 * hc * bev + 0.08 * g - 0.04 * lines + 0.03 * fi - 0.15 * gap - 0.03 * nail - 0.15 * chk;
    ro[i] = 0.7 + 0.1 * wth + 0.06 * (g - 0.5) - 0.05 * st + 0.1 * gap;
    ao[i] = 1 - 0.6 * gap - 0.12 * (1 - bev) - 0.3 * chk;
  }
  return { albedo: alb, normal: normalFrom(h, n, n, 2.2), orm: ormImg(n, n, ao, ro), metres: M };
}

/**
 * Flagstone paving: irregular "random ashlar" slabs 0.45–1.3 m in wavy rows with skewed joints, some slabs split into
 * irregular pieces; pale warm beige / pink / grey per slab (callers tint ~#d8c9ad), soft rounded arrises with a worn
 * catch-light, slab height steps + tilt, pitted surface, dark sand-filled joints with moss in corners, water stains.
 * tile = 6 m.
 */
export function genPaving(n = 1024): GenOut {
  const N = n * n, M = 6.0, alb = img(n, n), h = new Float32Array(N), ro = new Float32Array(N);
  const rnd = prng(521), RN = 8, rows = partition(RN, 0.62, 1.35, rnd, 0);
  // rows: joints (cumulative, with per-joint skew; the wrapped last joint shares the first joint's skew)
  const JMAX = 10, jE = new Float32Array(RN * (JMAX + 1)), jS = new Float32Array(RN * (JMAX + 1)), jK = new Int32Array(RN);
  const SL = RN * JMAX, sTone = new Float32Array(SL), sPal = new Float32Array(SL), sStep = new Float32Array(SL), sTx = new Float32Array(SL), sTy = new Float32Array(SL);
  const sSplit = new Int32Array(SL), sA = new Float32Array(SL), sB = new Float32Array(SL);
  for (let r = 0; r < RN; r++) {
    const k = 5 + Math.floor(rnd() * 4), e = partition(k, 0.5, 1.5, rnd, rnd());
    jK[r] = k;
    for (let j = 0; j <= k; j++) { jE[r * (JMAX + 1) + j] = e[j]; jS[r * (JMAX + 1) + j] = j === k ? jS[r * (JMAX + 1)] : (rnd() - 0.5) * 0.3; }
    for (let s = 0; s < k; s++) {
      const q = r * JMAX + s;
      sTone[q] = rnd(); sPal[q] = rnd(); sStep[q] = rnd() - 0.5; sTx[q] = rnd() - 0.5; sTy[q] = rnd() - 0.5;
      sSplit[q] = rnd() < 0.4 ? 1 + Math.floor(rnd() * 2) : 0; sA[q] = 0.3 + 0.4 * rnd(); sB[q] = mix(sA[q], 0.3 + 0.4 * rnd(), 0.6);
    }
  }
  const waveF = new Float32Array(RN * n);  // wavy row boundaries, tile units
  for (let r = 0; r < RN; r++) {
    const a1 = rnd() * TAU, a2 = rnd() * TAU, a3 = rnd() * TAU;
    for (let x = 0; x < n; x++) { const t = x / n * TAU; waveF[r * n + x] = (0.045 * Math.sin(t * 3 + a1) + 0.028 * Math.sin(t * 7 + a2) + 0.014 * Math.sin(t * 13 + a3)) / M; }
  }
  const jw1 = fbmF(n, 40, 2, 502, 0.5), jw2 = fbmF(n, 40, 2, 503, 0.5);
  const grain = fbmF(n, 192, 1, 504, 0.55), mid = fbmF(n, 24, 3, 505, 0.55), big = fbmF(n, 3, 3, 506, 0.5);
  const mossF = fbmF(n, 10, 3, 507, 0.55), stainF = fbmF(n, 5, 4, 508, 0.6), sandF = fbmF(n, 96, 2, 509, 0.5);
  const pits = new Cells(80, 510, 1);
  const qM = quant(mossF, 0.86), qSt = quant(stainF, 0.84);
  // near-neutral limestone / granite greys with a few warm and rosy slabs (a warmer palette goes candy-orange under
  // the warm plaza tint + ACES); the POI's vertex tint sets the overall warmth (cove: cream sandstone, mango: grey-beige)
  const PAL = [[0.9, 0.88, 0.84], [0.93, 0.87, 0.82], [0.84, 0.84, 0.83], [0.92, 0.9, 0.85], [0.88, 0.83, 0.77], [0.8, 0.79, 0.78]];
  const bnd = new Float32Array(RN + 1);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x;
    const u = x / n + (jw1[i] - 0.5) * 0.0035, v = y / n + (jw2[i] - 0.5) * 0.0035;
    const xi = Math.min(n - 1, Math.max(0, Math.floor(fract(u) * n)));
    for (let r = 0; r < RN; r++) bnd[r] = rows[r] + waveF[r * n + xi];
    bnd[RN] = bnd[0] + 1;
    let vt = v - bnd[0]; vt -= Math.floor(vt); vt += bnd[0];
    let r = 0; while (r < RN - 1 && vt >= bnd[r + 1]) r++;
    const b0 = bnd[r], b1 = bnd[r + 1], rh = b1 - b0, dBot = (vt - b0) * M, dTop = (b1 - vt) * M, vloc = (vt - b0) / rh;
    const jo = r * (JMAX + 1), k = jK[r], e0 = jE[jo];
    let ut = u - e0; ut -= Math.floor(ut); ut += e0;
    let s = -1, xa = 0, xb = 0;
    for (let j = 0; j < k; j++) {
      const a = jE[jo + j] + jS[jo + j] * (vloc - 0.5) * rh, b = jE[jo + j + 1] + jS[jo + j + 1] * (vloc - 0.5) * rh;
      if (ut >= a && ut < b) { s = j; xa = a; xb = b; break; }
    }
    if (s < 0) { // skew pushed us past the first/last joint: wrap to the neighbour slab
      const sh = jS[jo] * (vloc - 0.5) * rh;
      if (ut < e0 + sh) { s = k - 1; ut += 1; } else { s = 0; ut -= 1; }
      xa = jE[jo + s] + jS[jo + s] * (vloc - 0.5) * rh; xb = jE[jo + s + 1] + jS[jo + s + 1] * (vloc - 0.5) * rh;
    }
    const dL = (ut - xa) * M, dR = (xb - ut) * M;
    let d = rmin(Math.min(dL, dR), Math.min(dBot, dTop), 0.05);
    const q = r * JMAX + s; let alt = 0;
    if (sSplit[q] === 1) {        // roughly vertical split line
      const w = (xb - xa) * M, lx = dL / w, px = mix(sA[q], sB[q], vloc), ds = (lx - px) * w / Math.hypot(1, (sB[q] - sA[q]) * w / (rh * M));
      if (ds > 0) alt = 1; d = rmin(d, Math.abs(ds), 0.04);
    } else if (sSplit[q] === 2 && rh * M > 0.6) { // split across the row
      const ly = mix(sA[q], sB[q], dL / ((xb - xa) * M)), ds = (vloc - ly) * rh * M;
      if (ds > 0) alt = 1; d = rmin(d, Math.abs(ds), 0.04);
    }
    const corner = sstep(0.16, 0.03, Math.min(dL, dR) + Math.min(dBot, dTop));
    // ---- shading
    const t = fract(sTone[q] + alt * 0.37), pal = PAL[Math.floor(fract(sPal[q] + alt * 0.41) * PAL.length)];
    const jw = 0.0055 + 0.002 * (jw1[i] - 0.5);  // ~3 cm joints (6 cm reads cartoon-outline heavy at kong eye)
    const joint = sstep(jw + 0.003, jw, d), bev = sstep(jw, jw + 0.03, d);
    vor(pits, x / n, y / n);
    const pit = pits.r[WID] < 0.3 ? sstep(0.2 * pits.r[WID] + 0.08, 0.05, W1) : 0;
    const st = sstep(qSt - 0.04, qSt + 0.1, stainF[i]);
    let lum = 0.92 + 0.16 * (t - 0.5) - 0.05 * (big[i] - 0.5) - 0.06 * (mid[i] - 0.5) - 0.05 * (grain[i] - 0.5) - 0.1 * pit - 0.07 * st;
    lum += 0.045 * sstep(jw + 0.004, jw + 0.012, d) * (1 - sstep(jw + 0.014, jw + 0.03, d));
    let rr = pal[0] * lum, g = pal[1] * lum, b = pal[2] * lum;
    const sd = 0.56 + 0.1 * sandF[i];            // warm mid-grey sand joints (not near-black)
    const moss = clamp01(joint * (sstep(qM - 0.06, qM + 0.05, mossF[i]) + 0.8 * corner * sstep(0.45, 0.62, mossF[i])) + (1 - joint) * sstep(jw + 0.012, jw, d) * sstep(qM - 0.02, qM + 0.08, mossF[i]) * 0.5);
    rr = mix(rr, sd, joint); g = mix(g, sd * 0.95, joint); b = mix(b, sd * 0.88, joint);
    rr = mix(rr, 0.36, moss * 0.8); g = mix(g, 0.45, moss * 0.8); b = mix(b, 0.22, moss * 0.8);
    put(alb, i, clamp01(rr), clamp01(g), clamp01(b));
    const step = 0.14 * sStep[q] + 0.3 * (sTx[q] * (u - 0.5) + sTy[q] * (v - 0.5)) + 0.08 * alt;
    h[i] = bev * (0.85 + step) + 0.1 * mid[i] + 0.05 * grain[i] - 0.18 * pit - 0.08 * joint * sandF[i];
    ro[i] = 0.8 + 0.08 * (grain[i] - 0.5) + 0.12 * joint - 0.06 * st - 0.05 * sstep(jw + 0.004, jw + 0.012, d);
  }
  const ao = cavityAO(h, n, 3, 2.4, 0.45);
  return { albedo: alb, normal: normalFrom(h, n, n, 4.2), orm: ormImg(n, n, ao, ro), metres: M };
}

/**
 * Cream limestone blocks (hotel pilasters, fountain, pool coping, plinths): 4 courses of 50 cm per 2 m tile, blocks
 * 0.55–1.2 m in broken bond, thin recessed mortar, soft rounded arrises that are worn back irregularly, pitted porous
 * face (denser in patches), soft weathering + rain darkening down from each bed joint, per-block tone.
 * NEUTRAL cream. tile = 2 m.
 */
export function genStone(n = 512): GenOut {
  const N = n * n, M = 2.0, C = 4, alb = img(n, n), h = new Float32Array(N), ro = new Float32Array(N);
  const rnd = prng(601), rowE: number[][] = [], tone: number[][] = [];
  for (let r = 0; r < C; r++) { const k = 2 + Math.floor(rnd() * 2); rowE.push(partition(k, 0.7, 1.3, rnd, rnd())); tone.push(Array.from({ length: k }, () => rnd())); }
  const w1 = fbmF(n, 6, 2, 609), w2 = fbmF(n, 6, 2, 610);
  const grain = fbmF(n, 96, 2, 602, 0.55), mid = fbmF(n, 10, 3, 603, 0.55), weather = warpF(fbmF(n, 4, 4, 604, 0.6, 3), n, w1, w2, n * 0.03);
  const streak = fbmF(n, 36, 2, 606, 0.5, 2), pitD = fbmF(n, 4, 2, 605, 0.5), ero = warpF(fbmF(n, 14, 3, 608, 0.6), n, w2, w1, n * 0.01);
  const pits = new Cells(36, 607, 1);
  const qW = quant(weather, 0.72), qE = quant(ero, 0.7);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x, u = x / n, v = y / n;
    const r = Math.floor(v * C) % C, vl = fract(v * C), dV = Math.min(vl, 1 - vl) * M / C;
    const e = rowE[r], k = pieceOf(e, u);
    let ut = u - e[0]; ut -= Math.floor(ut); ut += e[0];
    const dU = Math.min(ut - e[k], e[k + 1] - ut) * M;
    const d = rmin(dU, dV, 0.018);
    const er = 0.022 * sstep(qE, qE + 0.18, ero[i]);                 // metres of arris worn away here
    const mortar = sstep(0.0055, 0.0035, d), bev = sstep(0.004, 0.02 + er * 1.6, d), worn = er > 0 ? sstep(0.02 + er * 1.6, 0.012, d) * sstep(0.004, 0.008, d) * er / 0.022 : 0;
    const dens = sstep(0.35, 0.7, pitD[i]);
    vor(pits, u, v);
    const pit = pits.r[WID] < 0.2 + 0.4 * dens ? sstep(0.1 + 0.14 * pits.r[WID], 0.04, W1) : 0;
    const t = tone[r][k];
    const rain = sstep(0.45, 0.8, streak[i]) * Math.exp(-(1 - vl) / 0.5) * 0.8;
    const wt = sstep(qW - 0.1, qW + 0.12, weather[i]);
    let l = 0.915 + 0.09 * (t - 0.5) - 0.05 * (mid[i] - 0.5) - 0.04 * (grain[i] - 0.5) - 0.08 * wt - 0.07 * rain - 0.14 * pit - 0.06 * worn;
    l = mix(l, 0.72, mortar);
    put(alb, i, clamp01(l), clamp01(l - 0.012 - 0.008 * wt), clamp01(l - 0.042 - 0.012 * wt));
    h[i] = 0.9 * bev + 0.12 * mid[i] + 0.06 * grain[i] - 0.2 * pit - 0.06 * worn * grain[i];
    ro[i] = 0.78 + 0.1 * (grain[i] - 0.5) + 0.1 * mortar + 0.05 * wt + 0.05 * worn;
  }
  const ao = cavityAO(h, n, 3, 2.2, 0.45);
  return { albedo: alb, normal: normalFrom(h, n, n, 3.4), orm: ormImg(n, n, ao, ro), metres: M };
}

/**
 * Palm thatch (tiki roofs; lathe UVs so V runs DOWN the slope from the apex): 5 overlapping courses per 1.5 m tile
 * with wavy edges, each made of soft fibre bundles (~6 cm) whose strands end in a ragged, tapering fringe that
 * shadows the course below; straw / grey / dark bundles blended. Coloured light straw (callers tint #d9b56a).
 * tile = 1.5 m.
 */
export function genThatch(n = 512): GenOut {
  const N = n * n, M = 1.5, C = 5, BU = 26, alb = img(n, n), h = new Float32Array(N), ro = new Float32Array(N), ao = new Float32Array(N);
  const rnd = prng(701), cE = partition(C, 0.85, 1.15, rnd, 0), boff = Array.from({ length: C }, () => rnd());
  const cw = new Float32Array(C * n);
  for (let c = 0; c < C; c++) { const a1 = rnd() * TAU, a2 = rnd() * TAU; for (let x = 0; x < n; x++) { const t = x / n * TAU; cw[c * n + x] = 0.012 * Math.sin(t * 3 + a1) + 0.007 * Math.sin(t * 8 + a2); } }
  const fib = fbmF(n, 128, 2, 702, 0.6, 3), fine = fbmF(n, 256, 1, 703, 0.5, 6), lenF = fbmF(n, 160, 1, 704, 0.5, 5), lenG = fbmF(n, 40, 2, 707, 0.5, 5);
  const bw = fbmF(n, 6, 2, 705, 0.5, 2), patch = fbmF(n, 3, 3, 706, 0.5);
  const bnd = new Float32Array(C + 1);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x, u = x / n, v = y / n;
    for (let k = 0; k < C; k++) bnd[k] = cE[k] + cw[k * n + x]; // wavy course bands
    bnd[C] = bnd[0] + 1;
    let vt = v - bnd[0]; vt -= Math.floor(vt); vt += bnd[0];
    let c = 0; while (c < C - 1 && vt >= bnd[c + 1]) c++;
    const t0 = clamp01((vt - bnd[c]) / (bnd[c + 1] - bnd[c]));
    const bu = (u + boff[c]) * BU + (bw[i] - 0.5) * 0.6, bid = Math.floor(bu), bp = fract(bu), bk = ((bid % BU) + BU) % BU;
    const hb = Math.sqrt(Math.max(0, 1 - (2 * bp - 1) * (2 * bp - 1)));
    const bh = hash2(bk + c * 131, 17), kind = hash2(bk + c * 131, 29);
    const fringe = 0.64 + 0.16 * bh + 0.2 * (lenF[i] - 0.5) + 0.12 * (lenG[i] - 0.5) - 0.04 * (1 - hb);
    const onTop = t0 < fringe;
    const t = onTop ? t0 / fringe : (t0 - fringe) / Math.max(0.02, 1 - fringe);
    const f = fib[i], fl = fine[i];
    const gk = sstep(0.7, 0.9, kind), dk = sstep(0.2, 0.05, kind);
    const r = mix(mix(0.9, 0.78, gk), 0.66, dk), g = mix(mix(0.85, 0.76, gk), 0.58, dk), b = mix(mix(0.74, 0.7, gk), 0.46, dk);
    const lum = 0.8 + 0.32 * (f - 0.5) + 0.12 * (fl - 0.5) - 0.06 * (patch[i] - 0.5) - 0.08 * (1 - hb);
    const shade = onTop ? 0.56 + 0.44 * sstep(0, 0.5, t) : 0.36 + 0.14 * (1 - t);
    const tip = onTop ? 0.05 * sstep(0.8, 1, t) : 0;
    put(alb, i, clamp01(r * lum * shade + tip), clamp01(g * lum * shade + tip * 0.9), clamp01(b * lum * shade + tip * 0.6));
    h[i] = onTop ? 0.05 + 0.7 * t + (0.25 * hb + 0.35 * f + 0.1 * fl) * sstep(0, 0.2, t) : 0.02 + 0.12 * (1 - t) * f;
    ro[i] = 0.84 + 0.1 * (1 - f);
    ao[i] = onTop ? (0.5 + 0.5 * sstep(0, 0.5, t)) * (0.85 + 0.15 * hb) : 0.42;
  }
  return { albedo: alb, normal: normalFrom(h, n, n, 2.4), orm: ormImg(n, n, ao, ro), metres: M };
}

/**
 * Cream beach sand (resort grounds): fine grain + sparkle, faint wind ripples, damp/dry mottle, soft speckled
 * yellow-green dry-grass patches, a few small radiating grass tufts, shell bits and dark pebbles. Coloured. tile = 3 m.
 */
export function genSand(n = 512): GenOut {
  const N = n * n, M = 3.0, alb = img(n, n), h = new Float32Array(N), ro = new Float32Array(N), ao = new Float32Array(N);
  const grain = fbmF(n, 200, 1, 801, 0.5), mottle = fbmF(n, 3, 4, 802, 0.55), rw = fbmF(n, 4, 3, 803, 0.5), ripA = fbmF(n, 5, 2, 804, 0.5);
  const stainF = fbmF(n, 4, 4, 805, 0.55), speck = fbmF(n, 128, 1, 806, 0.5);
  const bits = new Cells(56, 807, 1);
  const qS = quant(stainF, 0.8);
  const rnd = prng(808), T = 5, tx = new Float32Array(T), ty = new Float32Array(T), tr = new Float32Array(T), tph = new Float32Array(T);
  for (let k = 0; k < T; k++) { tx[k] = rnd(); ty[k] = rnd(); tr[k] = (0.09 + 0.07 * rnd()) / M; tph[k] = rnd() * TAU; }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x, u = x / n, v = y / n;
    const hs = hash2(x * 7 + 13, y * 11 + 5);
    const ph = (u * 4 + v * 11) + (rw[i] - 0.5) * 2.2;
    const saw = fract(ph), rip = (saw < 0.7 ? saw / 0.7 : (1 - saw) / 0.3) * (0.3 + 0.7 * ripA[i]);
    vor(bits, u, v);
    const bitR = bits.r[WID], bit = bitR < 0.2 ? sstep(0.11, 0.05, W1) : 0, shell = bitR < 0.07;
    let tuft = 0, tsh = 0;
    for (let k = 0; k < T; k++) {
      const dx = ws(u - tx[k]), dy = ws(v - ty[k]), rr = Math.hypot(dx, dy) / tr[k];
      if (rr > 1.3) continue;
      const a = Math.atan2(dy, dx), bi = Math.floor(((a / TAU + 1) * 11 + tph[k]) % 11), bl = 0.55 + 0.45 * hash2(bi, k);
      const blades = Math.pow(Math.abs(Math.cos(a * 5.5 + tph[k] * 11)), 3) * sstep(bl, bl * 0.4, rr);
      tuft = Math.max(tuft, blades + sstep(0.25, 0.05, rr));
      tsh = Math.max(tsh, sstep(1.25, 0.35, rr));
    }
    tuft = clamp01(tuft);
    const reg = sstep(qS - 0.1, qS + 0.12, stainF[i]), stain = reg * sstep(0.45, 0.62, speck[i] + 0.15 * reg);
    let l = 0.935 - 0.06 * (mottle[i] - 0.5) + 0.025 * (grain[i] - 0.5) + 0.03 * (hs - 0.5) + 0.02 * (rip - 0.5) - 0.06 * tsh * (1 - tuft);
    let r = l + 0.02, g = l - 0.035, b = l - 0.15;
    r = mix(r, 0.9, reg * 0.2); g = mix(g, 0.86, reg * 0.2); b = mix(b, 0.62, reg * 0.2);
    r = mix(r, 0.8, stain * 0.55); g = mix(g, 0.8, stain * 0.55); b = mix(b, 0.46, stain * 0.55);
    if (bit) { const c = shell ? 0.98 : 0.52 + 0.25 * bitR; r = mix(r, c + 0.02, bit * 0.75); g = mix(g, c, bit * 0.75); b = mix(b, c - 0.05, bit * 0.75); }
    r = mix(r, 0.64, tuft); g = mix(g, 0.66, tuft); b = mix(b, 0.34, tuft);
    put(alb, i, clamp01(r), clamp01(g), clamp01(b));
    h[i] = 0.16 * grain[i] + 0.35 * rip + 0.4 * mottle[i] + 0.22 * bit + 0.35 * tuft + 0.06 * hs + 0.05 * stain;
    ro[i] = 0.9 - 0.04 * stain; ao[i] = 1 - 0.25 * tsh * (1 - tuft);
  }
  return { albedo: alb, normal: normalFrom(h, n, n, 1.8), orm: ormImg(n, n, ao, ro), metres: M };
}

export const STRIPE_ROWS: Array<[string, string]> = [
  ["#d9483b", "#f5ecd8"], ["#f1c232", "#f7f0dc"], ["#2fb3a8", "#f4efe1"], ["#ea8a2c", "#f7f0dc"], ["#e88c7a", "#f6e7d6"], ["#3a86c8", "#f4efe1"],
];
/**
 * Striped awning canvas atlas: 6 rows (STRIPE_ROWS; geometry pins v inside a row), 8 stripes per metre along U.
 * Plain-weave canvas with slubs, stitched seams at the stripe edges, broad sun-fading (colour toward cream), soft
 * grime. tile = 1 m (fixed: the atlas rows depend on it).
 */
export function genStripes(n = 512): GenOut {
  const N = n * n, alb = img(n, n), h = new Float32Array(N), ro = new Float32Array(N);
  const cols = STRIPE_ROWS.map(([a, b]) => [new THREE.Color(a), new THREE.Color(b)]);
  const fade = fbmF(n, 2, 3, 901, 0.5), grime = fbmF(n, 5, 3, 902, 0.55), slub = fbmF(n, 8, 2, 903, 0.5, 128), fold = fbmF(n, 5, 2, 904, 0.5, 1);
  const qG = quant(grime, 0.8), threads = n / 4;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x, u = x / n, v = y / n, row = Math.min(5, Math.floor(v * 6));
    const su = u * 8, s = Math.floor(su) % 2, c = cols[row][s], cream = cols[row][1];
    const se = Math.min(fract(su), 1 - fract(su)) / 8;
    const seam = sstep(0.004, 0.0015, se), stitch = sstep(0.0078, 0.0064, se) * (1 - sstep(0.009, 0.0078, se)) * ((Math.floor(y / 3) & 1));
    const weave = Math.sin(u * threads * TAU) * Math.sin(v * threads * TAU);
    const fd = s ? 0 : 0.2 * sstep(0.35, 0.75, fade[i]);
    const k = 0.955 + 0.03 * weave + 0.03 * (slub[i] - 0.5) - 0.06 * sstep(qG - 0.05, qG + 0.12, grime[i]) - 0.08 * seam - 0.06 * stitch;
    put(alb, i, clamp01(mix(c.r, cream.r, fd) * k), clamp01(mix(c.g, cream.g, fd) * k), clamp01(mix(c.b, cream.b, fd) * k));
    h[i] = 0.25 * weave + 0.3 * slub[i] + 0.6 * seam + 0.8 * fold[i];
    ro[i] = 0.86 + 0.06 * grime[i];
  }
  return { albedo: alb, normal: normalFrom(h, n, n, 1.2), orm: ormImg(n, n, 1, ro), metres: 1.0 };
}

/** fishing net: alpha diamond grid of twisted twine with knots at the crossings. */
export function genNet(n = 512): Img {
  const im = img(n, n), tw = fbmF(n, 24, 2, 951, 0.5);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / n, v = y / n, i = y * n + x;
    const a = fract((u + v) * 10), b = fract((u - v) * 10);
    const la = Math.min(a, 1 - a), lb = Math.min(b, 1 - b), line = Math.min(la, lb);
    const knot = Math.hypot(la, lb) < 0.14;
    const twist = 0.5 + 0.5 * Math.sin((la < lb ? b : a) * TAU * 9);
    // thick cream twine (~60 % coverage): a hair-thin mesh vanishes into a faint tinted veil beyond 10 m; this reads
    // as dense cream mesh from the water
    const on = line < 0.14 + 0.03 * tw[i] || Math.hypot(la, lb) < 0.18;
    const k = (0.8 + 0.12 * twist + 0.08 * tw[i]) * (knot ? 1.04 : 1);
    put(im, i, clamp01(0.93 * k), clamp01(0.88 * k), clamp01(0.76 * k), on ? 255 : 0);
  }
  return im;
}

/**
 * Louvred shutter panel (UV 0..1 spans the panel, v up): stile/rail frame with a bevelled inner edge + 11 angled
 * blades — lower lip proud with a catch-light, face darkening as it tucks back under the blade above, dark slot
 * under each lip — paint chipped on lips/edges, grime toward the bottom. NEUTRAL. tile = 1 (panel).
 */
export function genLouvre(n = 256): GenOut {
  const N = n * n, alb = img(n, n), h = new Float32Array(N), ro = new Float32Array(N), ao = new Float32Array(N);
  const grain = fbmF(n, 32, 2, 961, 0.5, 4), chipF = fbmF(n, 28, 3, 962, 0.6), grime = fbmF(n, 4, 2, 963, 0.5);
  const qC = quant(chipF, 0.95), S = 11, fx = 0.085, fy = 0.07;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = y * n + x, u = x / n, v = y / n;
    const df = Math.min(u - fx, 1 - fx - u, v - fy, 1 - fy - v), de = Math.min(u, 1 - u, v, 1 - v);
    let hh: number, l: number, a = 1, edge: number;
    if (df < 0) {
      hh = 1 - 0.3 * sstep(-0.014, 0, df) - 0.2 * sstep(0.014, 0, de);
      l = 0.93 - 0.06 * sstep(-0.012, 0, df);
      edge = Math.max(sstep(0.016, 0, de), sstep(-0.016, 0, df));
    } else {
      const sv = fract((v - fy) / (1 - 2 * fy) * S);           // 0 = lower lip of a blade (proud), 1 = its top (tucked back)
      const slot = sstep(0.72, 0.9, sv), lipL = sstep(0.0, 0.05, sv) * sstep(0.16, 0.08, sv);
      hh = 0.9 - 0.7 * sv;
      l = 0.93 - 0.12 * sv - 0.5 * slot + 0.05 * lipL;
      a = 1 - 0.55 * slot - 0.3 * sstep(0.03, 0, df);
      edge = lipL;
    }
    const chip = sstep(qC, qC + 0.04, chipF[i] + 0.06 * edge) * (0.3 + 0.7 * edge);
    l += 0.03 * (grain[i] - 0.5) - 0.07 * sstep(0.45, 0, v) * grime[i];
    l = mix(l, 0.6 + 0.1 * grain[i], chip);
    put(alb, i, clamp01(l), clamp01(l), clamp01(l - 0.01));
    h[i] = hh - 0.08 * chip + 0.04 * grain[i];
    ro[i] = 0.6 + 0.22 * chip; ao[i] = a;
  }
  return { albedo: alb, normal: normalFrom(h, n, n, 3), orm: ormImg(n, n, ao, ro), metres: 1.0 };
}

/**
 * Clean interior paint (walls + ceilings inside the buildings): a faint roller stipple + soft large mottle, no chips,
 * no grime washes. NEUTRAL light. tile = 2 m.
 */
export function genInterior(n = 256): GenOut {
  const N = n * n, alb = img(n, n), h = new Float32Array(N), ro = new Float32Array(N);
  const big = fbmF(n, 2, 3, 1301, 0.5), stip = fbmF(n, 64, 2, 1302, 0.6), roll = fbmF(n, 3, 2, 1303, 0.5, 24);
  for (let i = 0; i < N; i++) {
    const l = 0.93 - 0.035 * (big[i] - 0.5) - 0.02 * (stip[i] - 0.5) - 0.012 * (roll[i] - 0.5);
    put(alb, i, clamp01(l), clamp01(l - 0.005), clamp01(l - 0.012));
    h[i] = 0.6 * stip[i] + 0.2 * roll[i];
    ro[i] = 0.82 + 0.06 * (stip[i] - 0.5);
  }
  return { albedo: alb, normal: normalFrom(h, n, n, 0.8), orm: ormImg(n, n, 1, ro), metres: 2.0 };
}
/** FACADE ATLAS: painted window / door / shop-front decals for the LOD1 building shells (and any building seen from
 *  beyond ~45 m) — one quad per opening instead of ~20 bevelled boxes. 4 × 2 cells of 256 px (atlas 1024 × 512):
 *   0 closed louvred shutters · 1 open window + shutters folded out (wide quad: leaves in the outer quarters)
 *   2 glass window + curtain · 3 french door (glass leaves) · 4 planked door · 5 shop front (roll-up + dark interior)
 *   6 one leaf open · 7 french door + shutters folded out (wide)
 *  Alpha = TINT MASK: 1 = painted with the vertex colour (shutters, door leaves), 0 = untinted (cream architrave, sill,
 *  glass, interior). Window cells: opening = u ∈ [FU, 1 − FU], v ∈ [FS, 1 − FL] (wide cells: inside u ∈ [0.25, 0.75]). */
export const FACADE = { FU: 0.13, FS: 0.1, FL: 0.14, cols: 4, rows: 2 } as const;
export function genFacade(): GenOut & { w: number; h: number } {
  const C = 256, W = C * 4, H = C * 2, N = W * H;
  const alb = img(W, H), h = new Float32Array(N), ro = new Float32Array(N), ao = new Float32Array(N);
  const nz = fbmF(C, 8, 3, 1501, 0.55), grain = fbmF(C, 48, 2, 1502, 0.6), chipF = fbmF(C, 20, 3, 1503, 0.6);
  const qC = quant(chipF, 0.93);
  const { FU, FS, FL } = FACADE;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const cell = Math.floor(x / C) + 4 * Math.floor(y / C), px = x % C, py = y % C, u = (px + 0.5) / C, v = (py + 0.5) / C, ni = py * C + px;
    const wide = cell === 1 || cell === 7;
    // sub-frame for the architrave + opening (wide cells: the middle half)
    const fu = wide ? (u - 0.25) / 0.5 : u;
    const tall = cell === 3 || cell === 4 || cell === 5 || cell === 7;
    const fs = tall ? 0.03 : FS;
    let r = 0.94, g = 0.9, b = 0.82, a = 0, hh = 0.75, rr = 0.72, oc = 1;
    const inOpen = fu > FU && fu < 1 - FU && v > fs && v < 1 - FL;
    const inFrame = fu >= 0 && fu <= 1;
    const n0 = nz[ni] - 0.5, gr = grain[ni] - 0.5;
    if (!inFrame) {
      // folded-out shutter leaf (wide cells): louvred, tinted
      const lu = u < 0.25 ? u / 0.25 : (u - 0.75) / 0.25, lv = (v - fs) / (1 - fs - FL);
      if (lv < 0 || lv > 1 || lu < 0.04 || lu > 0.96) { r = g = b = 0.3; a = 0; hh = 0.2; oc = 0.5; }
      else {
        const st = Math.min(lu - 0.04, 0.96 - lu, lv, 1 - lv);
        if (st < 0.07) { r = g = b = 0.92; a = 1; hh = 0.95; }
        else { const sv = ((lv - 0.07) / 0.86 * (cell === 7 ? 16 : 11)) % 1; const slot = sstep(0.72, 0.9, sv); r = g = b = 0.9 - 0.12 * sv - 0.45 * slot; a = 1; hh = 0.85 - 0.5 * sv; oc = 1 - 0.4 * slot; }
        rr = 0.6;
      }
    } else if (!inOpen) {
      // cream architrave: raised, bevelled; deeper lintel with a shadow line, projecting sill (light top + shadow under)
      const dIn = Math.min(Math.abs(fu - FU), Math.abs(fu - (1 - FU)), Math.abs(v - fs), Math.abs(v - (1 - FL)));
      const dOut = Math.min(fu, 1 - fu, v, 1 - v);
      hh = 0.85 + 0.15 * sstep(0, 0.03, dOut) - 0.25 * sstep(0.02, 0, dIn);
      const l = 0.95 + 0.03 * n0 + 0.02 * gr - 0.06 * sstep(0.03, 0, dOut);
      r = l; g = l * 0.965; b = l * 0.89;
      if (!tall && v < fs) { const t = v / fs; hh = 0.95; const k = t > 0.7 ? 1.05 : t < 0.25 ? 0.72 : 0.94; r *= k; g *= k; b *= k; }
      if (v > 1 - FL && v < 1 - FL + 0.025) { r *= 0.8; g *= 0.8; b *= 0.8; }
      const chip = sstep(qC, qC + 0.03, chipF[ni]) * 0.8;
      r = mix(r, 0.72, chip); g = mix(g, 0.68, chip); b = mix(b, 0.62, chip);
      rr = 0.78; a = 0;
    } else {
      const ou = (fu - FU) / (1 - 2 * FU), ov = (v - fs) / (1 - fs - FL);       // 0..1 inside the opening
      const recess = sstep(0.1, 0, Math.min(ou, 1 - ou)) * 0.35 + sstep(0.86, 1, ov) * 0.4; // reveal shadow (top + sides)
      oc = 1 - recess;
      const glass = () => {
        const refl = 0.07 * sstep(0.35, 0.65, ou * 0.6 + ov * 0.7) - 0.04 * sstep(0.6, 0.95, ov);
        r = 0.13 + 0.04 * ov + refl; g = 0.17 + 0.05 * ov + refl; b = 0.22 + 0.07 * ov + refl; hh = 0.2; rr = 0.08; a = 0;
      };
      const mull = (bars: number[], hbar: number) => {
        const m = Math.min(...bars.map((bu) => Math.abs(ou - bu))), mh = Math.abs(ov - hbar), rim = Math.min(ou, 1 - ou, ov, 1 - ov);
        if (m < 0.025 || mh < 0.02 || rim < 0.035) { r = 0.95; g = 0.93; b = 0.87; hh = 0.55; rr = 0.6; a = 0; return true; }
        return false;
      };
      const louvre = (lu: number, lv: number, blades: number) => {
        const st = Math.min(lu, 1 - lu, lv, 1 - lv);
        if (st < 0.06) { r = g = b = 0.93 - 0.05 * sstep(0.02, 0, st); hh = 0.9; }
        else { const sv = ((lv - 0.06) / 0.88 * blades) % 1; const slot = sstep(0.72, 0.9, sv), lip = sstep(0, 0.05, sv) * sstep(0.16, 0.08, sv); r = g = b = 0.9 - 0.12 * sv - 0.45 * slot + 0.05 * lip; hh = 0.8 - 0.55 * sv; oc *= 1 - 0.35 * slot; }
        a = 1; rr = 0.62;
        const chip = sstep(qC, qC + 0.03, chipF[ni]) * 0.7; r = mix(r, 0.62, chip); g = mix(g, 0.6, chip); b = mix(b, 0.55, chip); a = 1 - chip;
      };
      if (cell === 0 || cell === 6) {
        const leaf = ou < 0.5 ? 0 : 1, lu = leaf ? (ou - 0.5) / 0.5 : ou / 0.5;
        if (Math.abs(ou - 0.5) < 0.012) { r = g = b = 0.12; hh = 0.1; a = 0; }
        // no cross mullion in the painted glass: the full shell's windows are one breakable pane (a vault),
        // and a cross would vanish on approach — only the thin glazing bead stays
        else if (cell === 6 && leaf === 1) { glass(); mull([], -9); }
        else louvre(lu, ov, 12);
      } else if (cell === 1 || cell === 2) {
        glass();
        if (!mull([], -9)) {
          // curtain: soft warm fabric in one or both upper corners
          const cu = cell === 2 ? Math.min(ou, 1 - ou) : ou;
          const cur = cell === 2 ? sstep(0.24, 0.16, cu) * sstep(0.1, 0.3, ov) : sstep(0.2, 0.12, ou) * sstep(0.2, 0.4, ov);
          if (cur > 0) { const fold = 0.85 + 0.15 * Math.sin(ou * 90); r = mix(r, 0.9 * fold, cur); g = mix(g, 0.84 * fold, cur); b = mix(b, 0.72 * fold, cur); rr = mix(rr, 0.9, cur); hh = mix(hh, 0.4, cur); }
        }
      } else if (cell === 3 || cell === 7) {
        // two glazed door leaves, tinted frames, dark room behind the glass
        const leaf = ou < 0.5 ? ou / 0.5 : (ou - 0.5) / 0.5, st = Math.min(leaf, 1 - leaf, ov, 1 - ov);
        if (st < 0.09 || Math.abs(ov - 0.32) < 0.03) { r = g = b = 0.9; a = 1; hh = 0.7; rr = 0.6; if (Math.abs(ou - 0.5) < 0.008) { r = g = b = 0.15; a = 0; } }
        else { glass(); r *= 0.8; g *= 0.8; b *= 0.8; if (ov < 0.32) { r = g = b = 0.86; a = 1; hh = 0.6 + 0.2 * sstep(0.1, 0.12, Math.min(leaf, 1 - leaf, ov, 0.32 - ov)); } }
      } else if (cell === 4) {
        // planked door: vertical boards, two recessed panels, a brass knob
        const bd = (ou * 6) % 1, joint = sstep(0.06, 0, Math.min(bd, 1 - bd));
        r = g = b = 0.88 - 0.25 * joint + 0.05 * gr; a = 1; hh = 0.7 - 0.4 * joint; rr = 0.66;
        for (const [v0, v1] of [[0.1, 0.42], [0.52, 0.9]]) { const inP = ou > 0.15 && ou < 0.85 && ov > v0 && ov < v1; if (inP) { const e = Math.min(ou - 0.15, 0.85 - ou, ov - v0, v1 - ov); hh -= 0.25 * sstep(0.03, 0, e); r *= 0.93; g *= 0.93; b *= 0.93; } }
        if (Math.hypot((ou - 0.82) * 1.6, ov - 0.47) < 0.03) { r = 0.78; g = 0.62; b = 0.28; a = 0; hh = 1; rr = 0.3; }
        const chip = sstep(qC, qC + 0.03, chipF[ni]) * 0.8; r = mix(r, 0.55, chip); g = mix(g, 0.45, chip); b = mix(b, 0.33, chip); a *= 1 - chip;
      } else if (cell === 5) {
        // shop front: roll-up shutter drum + slats in the top third, dark interior with a counter + produce below
        if (ov > 0.66) { const sv = (ov * 28) % 1; r = g = b = 0.64 + 0.1 * Math.sin(sv * TAU) + 0.03 * gr; hh = 0.5 + 0.2 * Math.sin(sv * TAU); rr = 0.5; a = 0; if (ov > 0.94) { r = g = b = 0.5; } }
        else {
          r = 0.07; g = 0.06; b = 0.05; rr = 0.95; hh = 0.1; a = 0; oc = 0.5;
          if (ov < 0.3) { r = 0.36; g = 0.24; b = 0.14; hh = 0.4; const pl = (ou * 5) % 1; if (pl < 0.05) { r *= 0.7; g *= 0.7; b *= 0.7; } }
          if (ov > 0.3 && ov < 0.42) {
            const cx = (ou * 13) % 1, cy = (ov - 0.3) / 0.12, d = Math.hypot(cx - 0.5, (cy - 0.45) * 1.2), k = Math.floor(ou * 13) % 3;
            if (d < 0.42) { const sh = 1 - d * 0.9; r = (k === 1 ? 0.97 : 0.95) * sh; g = (k === 1 ? 0.8 : k === 0 ? 0.55 : 0.36) * sh; b = 0.12 * sh; hh = 0.6; rr = 0.4; oc = 1; }
          }
          if (ov > 0.52 && ov < 0.54) { r = 0.3; g = 0.21; b = 0.13; }
        }
      }
    }
    put(alb, y * W + x, clamp01(r), clamp01(g), clamp01(b), Math.round(255 * clamp01(a)));
    h[y * W + x] = hh; ro[y * W + x] = rr; ao[y * W + x] = oc;
  }
  return { albedo: alb, normal: normalFrom(h, W, H, 4), orm: ormImg(W, H, ao, ro), metres: 1, w: W, h: H };
}
/** BANANA LEAF card (hero foliage): 256 × 1024, alpha-cut outline with wind TEARS along the lateral veins, pale
 *  raised midrib, fine slanted lateral vein striping, deep green at the rib → yellow-green toward the rim + a thin yellow
 *  edge. u = across (0.5 = midrib), v = base (0) → tip (1). Height (→ normal) = midrib ridge + vein corrugation. */
export function genBananaLeaf(): GenOut {
  const W = 256, Hh = 1024, N = W * Hh, alb = img(W, Hh), h = new Float32Array(N), ro = new Float32Array(N), ao = new Float32Array(N);
  const r = prng(4242), K = 0.55;
  const tears: Array<[number, number, number]> = [];
  for (let s2 = -1; s2 <= 1; s2 += 2) for (let i = 0; i < 6; i++) tears.push([s2, 0.14 + r() * 0.78, 0.004 + r() * 0.006]);
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, u = ((x + 0.5) / W) * 2 - 1, v = (y + 0.5) / Hh, au = Math.abs(u);
    const hw = 0.94 * Math.pow(Math.sin(Math.PI * clamp01((v - 0.015) / 0.975)), 0.62) * (v < 0.06 ? 0.3 + 0.7 * v / 0.06 : 1);
    let a = au < hw ? 1 : 0;
    const vv = v - au * K * 0.25;                                  // lateral vein coordinate (veins slant toward the tip)
    const rel = au / Math.max(1e-3, hw);
    for (const [sd, tv, tw] of tears) if (Math.sign(u) === sd && rel > 0.22 && Math.abs(vv - tv) < tw * (0.3 + 1.2 * rel)) a = 0;
    const rib = sstep(0.05, 0.02, au), vein = 0.5 + 0.5 * Math.sin(vv * 520), vein2 = 0.5 + 0.5 * Math.sin(vv * 130 + 1.3);
    let R = mix(0.2, 0.46, rel ** 1.3), G = mix(0.44, 0.7, rel ** 1.3), B = mix(0.1, 0.16, rel);
    const k = 0.93 + 0.05 * vein + 0.04 * vein2;
    R *= k; G *= k; B *= k;
    const edge = sstep(0.9, 0.99, rel); R = mix(R, 0.72, edge * 0.6); G = mix(G, 0.8, edge * 0.5); B = mix(B, 0.22, edge * 0.4);
    R = mix(R, 0.72, rib); G = mix(G, 0.82, rib); B = mix(B, 0.4, rib);
    // base of the blade a touch darker, tip lighter
    const bt = 0.88 + 0.12 * sstep(0.0, 0.3, v); R *= bt; G *= bt; B *= bt;
    put(alb, i, clamp01(R), clamp01(G), clamp01(B), a ? 255 : 0);
    h[i] = 0.6 * rib + 0.06 * vein + 0.05 * vein2 - 0.1 * rel;
    ro[i] = 0.42 + 0.1 * (1 - vein) + 0.1 * edge; ao[i] = 0.8 + 0.2 * (1 - sstep(0.15, 0, v));
  }
  return { albedo: alb, normal: normalFrom(h, W, Hh, 3), orm: ormImg(W, Hh, ao, ro), metres: 1 };
}
/** natural ROCK (boulders, islet stones, barnacle sleeves on piles): no block pattern — layered craggy relief (warped
 *  ridged fbm) + fine grain, pale mineral flecks / barnacle specks, dark crevices; NEUTRAL light (~0.8) so the vertex
 *  colour carries moss / damp / tide tints. tile = 2 m. */
export function genRock(n = 512): GenOut {
  const N = n * n, alb = img(n, n), h = new Float32Array(N), ro = new Float32Array(N);
  const w1 = fbmF(n, 3, 2, 1601), w2 = fbmF(n, 3, 2, 1602);
  const big = warpF(fbmF(n, 3, 4, 1603, 0.55), n, w1, w2, n * 0.08), mid = fbmF(n, 9, 3, 1604, 0.55), grain = fbmF(n, 64, 2, 1605, 0.6);
  const fleck = fbmF(n, 96, 1, 1606, 0.5), crack = warpF(fbmF(n, 7, 3, 1607, 0.6), n, w2, w1, n * 0.02);
  const qF = quant(fleck, 0.9);
  for (let i = 0; i < N; i++) {
    const ridge = 1 - Math.abs(2 * crack[i] - 1), cr = sstep(0.9, 0.97, ridge);
    const f = sstep(qF, qF + 0.02, fleck[i]);
    let l = 0.8 - 0.1 * (big[i] - 0.5) - 0.07 * (mid[i] - 0.5) - 0.06 * (grain[i] - 0.5) - 0.28 * cr;
    l = mix(l, 0.96, f * 0.8);
    put(alb, i, clamp01(l), clamp01(l - 0.01), clamp01(l - 0.03));
    h[i] = 0.55 * big[i] + 0.25 * mid[i] + 0.1 * grain[i] - 0.35 * cr + 0.08 * f;
    ro[i] = 0.82 + 0.08 * (grain[i] - 0.5) - 0.12 * f;
  }
  const ao = cavityAO(h, n, 4, 2.4, 0.5);
  return { albedo: alb, normal: normalFrom(h, n, n, 4.2), orm: ormImg(n, n, ao, ro), metres: 2.0 };
}
/**
 * FRUIT HEAP: a tileable top-down painting of piled fruit for the heap mounds under the individual (instanced)
 * fruit — beyond ~24 m the instances are hidden and the mound alone must read as "a crate of mangoes / bananas", never
 * as a coloured cake. Mangoes: two overlapping layers of plump ellipses (green shoulder → yellow → orange → red blush on
 * the lit side, lenticel freckles, a stem dot), dark gaps between them. Bananas: hands of 4–6 curved fingers (yellow,
 * green neck, dark tip) in two layers. Height = domed fruit (→ normal + cavity AO), glossy fruit / matte gaps. tile 0.8 m.
 */
export function genFruitHeap(kind: "mango" | "banana", n = 512): GenOut {
  const N = n * n, M = 0.8, alb = img(n, n), h = new Float32Array(N).fill(-1), ro = new Float32Array(N).fill(0.9);
  const cr = new Float32Array(N), cg = new Float32Array(N), cb = new Float32Array(N);
  const rnd = prng(kind === "mango" ? 7101 : 7102), grain = fbmF(n, 90, 2, 7103, 0.6);
  const ramp: Array<[number, number, number, number]> = [[0, 0.44, 0.62, 0.2], [0.24, 0.72, 0.77, 0.23], [0.44, 0.97, 0.78, 0.18], [0.64, 0.97, 0.6, 0.13], [0.82, 0.94, 0.42, 0.14], [1, 0.85, 0.26, 0.16]];
  const rampC = (v: number): [number, number, number] => {
    v = clamp01(v);
    for (let i = 1; i < ramp.length; i++) if (v <= ramp[i][0]) { const a = ramp[i - 1], b = ramp[i], t = (v - a[0]) / (b[0] - a[0]); return [mix(a[1], b[1], t), mix(a[2], b[2], t), mix(a[3], b[3], t)]; }
    return [ramp[ramp.length - 1][1], ramp[ramp.length - 1][2], ramp[ramp.length - 1][3]];
  };
  /** stamp a shape: `f(px, py)` → [height 0..1 or <0 outside, r, g, b] over a pixel box (wrapped); keeps the highest */
  const stamp = (cx: number, cy: number, R: number, z0: number, f: (dx: number, dy: number) => [number, number, number, number] | null) => {
    const r = Math.ceil(R);
    for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
      const q = f(ox + (cx - Math.round(cx)), oy + (cy - Math.round(cy)));
      if (!q) continue;
      const hh = z0 + q[0];
      const x = ((Math.round(cx) + ox) % n + n) % n, y = ((Math.round(cy) + oy) % n + n) % n, i = y * n + x;
      if (hh <= h[i]) continue;
      h[i] = hh; cr[i] = q[1]; cg[i] = q[2]; cb[i] = q[3]; ro[i] = 0.34;
    }
  };
  const Lx = -0.45, Ly = 0.55, Lz = 0.7; // paint light (upper-left) for the ripeness blush + soft top shading
  if (kind === "mango") {
    const g = 8, cell = n / g;
    for (let layer = 0; layer < 2; layer++) for (let j = 0; j < g + (layer ? 0 : 1); j++) for (let k = 0; k < g; k++) {
      if (layer && rnd() < 0.25) continue;
      const cx = (k + 0.5 + (layer ? 0.5 : 0) + (rnd() - 0.5) * 0.5) * cell, cy = (j + 0.5 + (layer ? 0.5 : 0) + (rnd() - 0.5) * 0.5) * cell * (g / (g + (layer ? 0 : 1))) * ((g + (layer ? 0 : 1)) / g);
      const a = cell * (0.58 + rnd() * 0.08), b = cell * (0.43 + rnd() * 0.06), th = rnd() * TAU, c = Math.cos(th), s2 = Math.sin(th);
      const ripe = 0.3 + rnd() * 0.65, freck = rnd() * 100;
      stamp(cx, cy, a + 1, layer * 0.35 + rnd() * 0.08, (dx, dy) => {
        const u = (dx * c + dy * s2) / a, v = (-dx * s2 + dy * c) / b;
        // kidney: a little flatter on one side, beak toward +u
        const d2 = u * u + v * v * (v < 0 ? 1.12 : 0.95) - 0.08 * u * Math.max(0, v);
        if (d2 >= 1) return null;
        const hz = Math.sqrt(1 - d2), nx = u * 0.8, ny = v * 0.8, nl = Math.hypot(nx, ny, hz) || 1;
        const lit = (nx * Lx + ny * Ly + hz * Lz) / nl;
        let [R, G, B] = rampC(ripe + 0.28 * lit - 0.25 * sstep(-0.35, -0.95, u) + 0.05 * (grain[0] - 0.5));
        const fr = hash2(Math.floor((u + 2) * 14 + freck), Math.floor((v + 2) * 14)) > 0.9 ? 0.9 : 1;
        const stem = sstep(0.07, 0.02, Math.hypot(u + 0.88, v)) * 0.8;
        R = mix(R * fr, 0.35, stem); G = mix(G * fr, 0.3, stem); B = mix(B * fr, 0.12, stem);
        const k = 0.75 + 0.25 * hz;
        return [hz * 0.55, R * k, G * k, B * k];
      });
    }
  } else {
    const gx = 4, gy = 5, cw = n / gx, ch = n / gy;
    for (let layer = 0; layer < 3; layer++) for (let j = 0; j < gy; j++) for (let k = 0; k < gx; k++) {
      if (layer && rnd() < 0.3) continue;
      const hx = (k + 0.5 + [0, 0.5, 0.25][layer] + (rnd() - 0.5) * 0.4) * cw, hy = (j + 0.5 + [0, 0.5, 0.7][layer] + (rnd() - 0.5) * 0.4) * ch;
      const th = rnd() * TAU, nF = 5 + Math.floor(rnd() * 2), green = rnd() * 0.35;
      const L = cw * (0.8 + rnd() * 0.14), W = L * 0.21, Rc = L * 1.25;
      for (let f = 0; f < nF; f++) {
        // finger f: an arc of radius Rc, offset across the hand, fanning slightly
        const off = (f - (nF - 1) / 2) * W * 0.95, fan = (f - (nF - 1) / 2) * 0.05;
        const cf = Math.cos(th + fan), sf = Math.sin(th + fan);
        stamp(hx + -sf * off, hy + cf * off, L * 0.7 + W, layer * 0.3 + f * 0.012, (dx, dy) => {
          // local: x along the finger (0 = crown end), y across; arc bends toward +y
          const x = dx * cf + dy * sf + L * 0.45, y = -dx * sf + dy * cf;
          const yc = Rc - Math.sqrt(Math.max(0, Rc * Rc - (x - L / 2) ** 2)) - (Rc - Math.sqrt(Rc * Rc - (L / 2) ** 2));
          const t = x / L;
          if (t < 0 || t > 1) return null;
          const hw = W * 0.5 * (0.45 + 0.55 * sstep(0.02, 0.2, t)) * (1 - 0.6 * sstep(0.82, 1.0, t));
          const e = (y - yc) / hw;
          if (Math.abs(e) >= 1) return null;
          const hz = Math.sqrt(1 - e * e), lit = (-e * 0.7 * Ly + hz * Lz);
          let R = 0.99, G = 0.84, B = 0.2;
          const gr = clamp01(green + 0.9 * sstep(0.14, 0.0, t));
          R = mix(R, 0.62, gr); G = mix(G, 0.74, gr); B = mix(B, 0.2, gr);
          const tip = sstep(0.93, 0.99, t); R = mix(R, 0.22, tip); G = mix(G, 0.16, tip); B = mix(B, 0.08, tip);
          const ridge = Math.abs(Math.cos(e * 2.4)) > 0.96 ? 1.04 : 1, k = (0.72 + 0.28 * hz) * (0.9 + 0.12 * lit) * ridge;
          return [hz * 0.35, R * k, G * k, B * k];
        });
      }
    }
  }
  const gapR = kind === "mango" ? 0.2 : 0.24, gapG = kind === "mango" ? 0.13 : 0.17, gapB = kind === "mango" ? 0.06 : 0.07;
  for (let i = 0; i < N; i++) if (h[i] < 0) { h[i] = -0.2; cr[i] = gapR; cg[i] = gapG; cb[i] = gapB; }
  const ao = cavityAO(h, n, 6, 1.6, 0.4);
  for (let i = 0; i < N; i++) { const a = 0.55 + 0.45 * ao[i], gk = 0.96 + 0.08 * (grain[i] - 0.5); put(alb, i, clamp01(cr[i] * a * gk), clamp01(cg[i] * a * gk), clamp01(cb[i] * a * gk)); }
  return { albedo: alb, normal: normalFrom(h, n, n, 6), orm: ormImg(n, n, ao, ro), metres: M };
}
/** soft contact-shadow blob (radial alpha), for the "blob" decal bin under props */
export function blobTexture(n = 64): THREE.DataTexture {
  return tex(blobImg(n), false, 1, false, () => blobImg(n));
}
function blobImg(n: number): Img {
  const im = img(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = (x + 0.5) / n * 2 - 1, dy = (y + 0.5) / n * 2 - 1, r = Math.hypot(dx, dy);
    const a = clamp01(1 - r) ** 1.6;
    put(im, y * n + x, 0, 0, 0, Math.round(a * 255));
  }
  return im;
}

/** painted sign board — canvas text, chunky rounded font, drop shadow, worn paint */
export function signCanvas(text: string, bg: string, fg: string, w = 1024, h = 256): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = bg; g.fillRect(0, 0, w, h);
  // board planks
  g.globalAlpha = 0.12; g.fillStyle = "#000";
  for (let i = 1; i < 4; i++) g.fillRect(0, (h / 4) * i - 2, w, 4);
  g.globalAlpha = 1;
  g.strokeStyle = fg; g.lineWidth = 10; g.strokeRect(14, 14, w - 28, h - 28);
  g.font = `900 ${Math.round(h * 0.56)}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "rgba(0,0,0,0.35)"; g.fillText(text, w / 2 + 6, h / 2 + 8);
  g.fillStyle = fg; g.fillText(text, w / 2, h / 2);
  // wear speckles
  g.globalAlpha = 0.25; g.fillStyle = bg;
  for (let i = 0; i < 260; i++) { const x = Math.random() * w, y = Math.random() * h, r = 1 + Math.random() * 5; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); }
  g.globalAlpha = 1;
  return c;
}

/** every tileable town texture set by name (town-materials + the preload worker use the same table) */
export const TOWN_TEX_SETS: Record<string, () => GenOut> = {
  plaster: () => genPlaster(1024), paving: () => genPaving(1024), facade: () => genFacade(), tin: () => genTin(512),
  rock: () => genRock(512), bananaLeaf: () => genBananaLeaf(), clapboard: () => genClapboard(512), planks: () => genPlanks(512),
  planksDark: () => genPlanks(512, true), stone: () => genStone(512), thatch: () => genThatch(512), sand: () => genSand(512),
  stripes: () => genStripes(512), louvre: () => genLouvre(256), interior: () => genInterior(256),
  heapMango: () => genFruitHeap("mango"), heapBanana: () => genFruitHeap("banana"),
};

// ---------- cache + material factory
export class TownTex {
  private sets = new Map<string, TexSet>();
  constructor(private aniso: number) {}
  has(name: string) { return this.sets.has(name); }
  /** a set generated elsewhere (the preload workers) */
  put(name: string, g: GenOut) { if (!this.sets.has(name)) this.get(name, () => g); }
  get(name: string, gen: () => GenOut): TexSet {
    let s = this.sets.get(name);
    if (!s) {
      const g = gen(), regen = TOWN_TEX_SETS[name] ?? gen;
      let fresh: GenOut | null = null;
      const again = (k: "albedo" | "normal" | "orm") => () => { const out = (fresh ??= regen())[k]; if (k === "orm") fresh = null; return out; };
      s = { map: tex(g.albedo, true, this.aniso, true, again("albedo")), normalMap: tex(g.normal, false, this.aniso, true, again("normal")), orm: tex(g.orm, false, this.aniso, true, again("orm")) };
      (s.map as THREE.Texture & { metres?: number }).metres = g.metres;
      // geometry UVs are in metres everywhere; the tile size lives here
      for (const t of [s.map, s.normalMap, s.orm]) t.repeat.set(1 / g.metres, 1 / g.metres);
      this.sets.set(name, s);
    }
    return s;
  }
  /** vertex-colour tinted PBR material sharing one texture set; uv is in metres (see town-geo boxUV) */
  material(name: string, gen: () => GenOut, o: { roughness?: number; metalness?: number; normalScale?: number; side?: THREE.Side; vertexColors?: boolean; envMapIntensity?: number; transparent?: boolean; alphaTest?: number; color?: string; emissive?: string } = {}): THREE.MeshStandardMaterial {
    const s = this.get(name, gen);
    const m = new THREE.MeshStandardMaterial({
      map: s.map, normalMap: s.normalMap, roughnessMap: s.orm, metalnessMap: s.orm, aoMap: s.orm,
      roughness: o.roughness ?? 1, metalness: o.metalness ?? 1, vertexColors: o.vertexColors ?? true,
      side: o.side ?? THREE.FrontSide, envMapIntensity: o.envMapIntensity ?? 0.9, transparent: o.transparent ?? false, alphaTest: o.alphaTest ?? 0,
      color: o.color ?? "#ffffff", emissive: o.emissive ?? "#000000",
    });
    m.normalScale.setScalar(o.normalScale ?? 1);
    m.aoMap!.channel = 0; m.aoMapIntensity = 0.85;
    m.name = "town:" + name;
    return m;
  }
  metres(name: string): number { return (this.sets.get(name)?.map as (THREE.Texture & { metres?: number }) | undefined)?.metres ?? 1; }
}

let shared: TownTex | null = null;
export function townTex(renderer: THREE.WebGLRenderer): TownTex {
  if (!shared) shared = new TownTex(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  return shared;
}
export function netTexture(): THREE.DataTexture {
  const t = tex(genNet(), true, 4, true, genNet); t.flipY = false; return t;
}
export function canvasTexture(c: HTMLCanvasElement, aniso = 8): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = aniso; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t;
}

/** animated-looking ripple normal map for pools / fountains (tile = 2 m) */
export function genRipples(n = 256): Img {
  const h = new Float32Array(n * n), f = fbmF(n, 6, 3, 971, 0.5), w = fbmF(n, 3, 2, 972, 0.5);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = x / n, v = y / n, i = y * n + x;
    h[i] = 0.5 * f[i] + 0.25 * Math.sin((u * 3 + v * 2) * TAU + w[i] * 4) + 0.25 * Math.sin((u * -2 + v * 4) * TAU);
  }
  return normalFrom(h, n, n, 2.2);
}
export function rippleTexture(aniso = 4): THREE.DataTexture { return tex(genRipples(), false, aniso, true, () => genRipples()); }

let preload: Promise<void> | null = null;
const TOWN_TEX_STALL_MS = 20000;
/**
 * Load time: generate every town texture set in parallel WEB WORKERS (the procedural generators are pure typed-array
 * code; ~1.1 s on the main thread otherwise) and drop the results into the shared TownTex cache, so the synchronous
 * `townMats()` finds them ready. Slow workers are waited for; only when they fail (or go silent) does the main thread
 * generate what is still missing, one set per `pause()` slice.
 */
export function preloadTownTex(renderer: THREE.WebGLRenderer, pause = () => new Promise<void>((r) => setTimeout(r, 0))): Promise<void> {
  if (preload) return preload;
  const tt = townTex(renderer);
  const names = Object.keys(TOWN_TEX_SETS).filter((n) => !tt.has(n));
  preload = viaWorkers(tt, names).then(async () => {
    for (const name of names) {
      if (tt.has(name)) continue;
      await pause();
      tt.put(name, TOWN_TEX_SETS[name]());
    }
  });
  return preload;
}
function viaWorkers(tt: TownTex, names: string[]): Promise<void> {
  if (typeof Worker === "undefined" || !names.length) return Promise.resolve();
  const nW = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1, names.length));
  return new Promise<void>((resolve) => {
    let left = names.length, next = 0, stall: ReturnType<typeof setTimeout> | undefined;
    const workers: Worker[] = [];
    const finish = () => { clearTimeout(stall); for (const w of workers) w.terminate(); resolve(); };
    const watch = () => { clearTimeout(stall); stall = setTimeout(() => { console.warn("town-tex workers stalled — generating the rest on the main thread"); finish(); }, TOWN_TEX_STALL_MS); };
    const feed = (w: Worker) => { if (next < names.length) w.postMessage({ name: names[next++] }); };
    try {
      for (let i = 0; i < nW; i++) {
        const w = new Worker(new URL("./town-tex.worker.ts", import.meta.url), { type: "module" });
        w.onmessage = (e: MessageEvent<{ name: string; g: GenOut | null }>) => {
          if (e.data.g) tt.put(e.data.name, e.data.g);
          if (--left <= 0) finish(); else { watch(); feed(w); }
        };
        w.onerror = (e) => { console.warn("town-tex worker failed — generating the rest on the main thread", e.message); finish(); };
        workers.push(w);
      }
      for (const w of workers) feed(w);
      watch();
    } catch (e) { console.warn("town-tex: no workers", e); finish(); }
  });
}
