// The lobby's two 2K texture atlases (+ two small tiling sheets), painted procedurally at build time.
//   A = WOOD & HARD GOODS: dock planks, weathered + dark timber, rope, bamboo, end grain, metals, crate/barrel
//       panels with the BANANA CO. stencil, target spiral, banana peel.
//   B = SOFT & CUTOUT: thatch strips, volleyball net, palm frond, banana leaf, grass, punching-bag leather,
//       trampoline mat/pad, deck-chair canvas, palm trunk, sign, windsock, bottles, lantern paper, bulbs, paint.
//   TARMAC / ROCK = small tiling sheets (repeat wrap).
// Every region is painted in metres (see paint.ts) so geometry maps real sizes without stretching.
import * as THREE from "three";
import type { Assets } from "../../../engine/assets";
import { Sheet, type Region, type UVRect, type Px, fbm, vnoise, cell, clamp01, sstep, mix, hex, rng } from "./paint";

const R = (x: number, y: number, w: number, h: number, mu: number, mv: number): Region => ({ x, y, w, h, mu, mv });

// ------------------------------------------------------------------------------------------------ region tables
export const A_REG = {
  plank: Array.from({ length: 8 }, (_, k) => R(0, 64 * k, 2048, 64, 4.0, 0.25)),
  grainWarm: R(0, 512, 2048, 512, 4, 1),
  grainDark: R(0, 1024, 2048, 512, 4, 1),
  rope: R(0, 1536, 1024, 128, 1.0, 0.125),
  bamboo: R(0, 1664, 1024, 128, 2.0, 0.25),
  endgrain: R(1024, 1536, 256, 256, 0.5, 0.5),
  metal: R(1280, 1536, 256, 128, 0.5, 0.25),
  paintMetal: R(1280, 1664, 256, 128, 0.5, 0.25),
  crate: R(1536, 1536, 512, 512, 1, 1),
  barrel: R(0, 1792, 1024, 256, 2.0, 1.0),
  target: R(1024, 1792, 256, 256, 0.5, 0.5),
  banana: R(1280, 1792, 256, 256, 0.25, 0.125),
};
export const B_REG = {
  thatch: R(0, 0, 2048, 512, 4, 1),
  net: R(0, 512, 1024, 512, 2, 1),
  frond: R(1024, 512, 1024, 512, 4.4, 2.2),
  bleaf: R(0, 1024, 1024, 512, 2.4, 1.2),
  leather: R(1024, 1024, 512, 512, 1.35, 1.3),
  trunk: R(1536, 1024, 512, 512, 1.2, 1.2),
  mat: R(0, 1536, 512, 512, 3.4, 3.4),
  canvas: R(512, 1536, 256, 512, 0.6, 1.2),
  pad: R(768, 1536, 256, 256, 1.0, 1.0),
  grass: R(768, 1792, 256, 256, 0.5, 0.5),
  sign: R(1024, 1536, 512, 128, 2.0, 0.5),
  windsock: R(1024, 1664, 256, 128, 1.2, 0.6),
  bottle: R(1280, 1664, 256, 128, 0.3, 0.3),
  lantern: R(1024, 1792, 128, 128, 0.25, 0.25),
  bulb: R(1152, 1792, 64, 64, 0.1, 0.1),
  lens: R(1216, 1792, 64, 64, 0.1, 0.1),
  paint: R(1536, 1536, 512, 128, 4, 1),
  sand: R(1536, 1664, 512, 128, 4, 1),
  shell: R(1280, 1792, 256, 256, 0.3, 0.3),
  sock: R(1536, 1792, 256, 256, 1, 1),
  fabric: R(1792, 1792, 256, 256, 0.5, 0.5),
};

export type AKey = keyof typeof A_REG;
export type BKey = keyof typeof B_REG;

type AtlasTex = { map: THREE.Texture; normalMap: THREE.Texture; ormMap: THREE.Texture };
export interface AtlasSet {
  A: { tex: AtlasTex; uv: (k: AKey | `plank${number}`) => UVRect };
  B: { tex: AtlasTex; uv: (k: BKey) => UVRect };
  tarmac: AtlasTex;
  rock: AtlasTex;
  /** tiling 3-strand rope: u = 1 unit per 8 lays along the rope, v = 0..1 once around (repeat wrap) */
  rope: AtlasTex;
  ms: number;
}

// ------------------------------------------------------------------------------------------------ painters
type RGB = [number, number, number];
const put = (p: Px, c: RGB) => { p.r = c[0]; p.g = c[1]; p.b = c[2]; };
const lerpC = (a: RGB, b: RGB, t: number): RGB => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

interface WoodOpt { seed: number; base: RGB; dark: RGB; light: RGB; grey?: number; lines?: number; knots?: Array<[number, number, number]> }
/** stylized hand-painted timber: long wandering grain lines, soft value blotches, sparse cracks + knots. Grain runs along a. */
function wood(a: number, b: number, p: Px, o: WoodOpt) {
  const s = o.seed;
  let bend = (fbm(a * 0.7 + s, b * 2.5 + s, 3) - 0.5) * 0.16;
  // knots bend the grain around them
  let knot = 0;
  if (o.knots) for (const [ka, kb, kr] of o.knots) {
    const da = (a - ka) / (kr * 2.2), db = (b - kb) / kr, d2 = da * da + db * db;
    if (d2 < 9) { bend += (b - kb) * 0.9 * Math.exp(-d2 * 0.9); knot = Math.max(knot, Math.exp(-d2 * 2.2)); }
  }
  const gb = b + bend;
  const L = o.lines ?? 46;
  const t = gb * L + fbm(a * 0.45 + s * 3, gb * 5, 3) * 5;
  const f = t - Math.floor(t);
  const line = Math.pow(1 - Math.min(f, 1 - f) * 2, 7);                         // thin dark grain line
  const fib = fbm(a * 2.2 + s, b * 160, 2);                                       // fine fibres
  const blot = fbm(a * 0.9 + s * 7, b * 1.4 + s, 3);                              // painterly value blotches
  const crackN = Math.abs(fbm(a * 0.8 + s * 11, b * 14, 3) - 0.5);
  const crack = crackN < 0.011 && vnoise(a * 1.7 + s, b * 3) > 0.62 ? 1 - crackN / 0.011 : 0;
  let c = lerpC(o.base, o.light, sstep(0.35, 0.8, blot) * 0.75);
  c = lerpC(c, o.dark, line * 0.55 + (1 - fib) * 0.18);
  if (o.grey) c = lerpC(c, [0.55, 0.52, 0.48], sstep(0.45, 0.8, fbm(a * 0.5 + s * 5, b * 1.2, 3)) * o.grey);
  if (knot > 0.05) { const kk = sstep(0.1, 0.8, knot); c = lerpC(c, o.dark, kk * 0.85); }
  c = lerpC(c, [o.dark[0] * 0.5, o.dark[1] * 0.45, o.dark[2] * 0.4], crack * 0.9);
  put(p, c);
  p.h = 0.5 + (blot - 0.5) * 0.12 - line * 0.07 - (1 - fib) * 0.03 - crack * 0.35 + knot * 0.05;
  p.ro = 0.7 + line * 0.12 + crack * 0.15 - sstep(0.6, 0.9, blot) * 0.1;
  p.ao = 1 - crack * 0.55 - line * 0.08;
}

function plank(a: number, b: number, p: Px, k: number) {
  const mv = 0.25;
  const tones: RGB[] = [hex("#8f6040"), hex("#8a5a3a"), hex("#9a6a45"), hex("#7e5335"), hex("#936544"), hex("#86603f"), hex("#7a5a45"), hex("#957050")];
  const r = rng(1000 + k * 77);
  const knots: Array<[number, number, number]> = [];
  for (let i = 0; i < 4; i++) knots.push([0.3 + r() * 3.4, 0.05 + r() * 0.15, 0.012 + r() * 0.012]);
  const base = tones[k];
  wood(a, b, p, { seed: k * 13.1 + 3, base, dark: [base[0] * 0.45, base[1] * 0.42, base[2] * 0.4], light: [Math.min(1, base[0] * 1.3), Math.min(1, base[1] * 1.28), Math.min(1, base[2] * 1.22)], grey: k >= 6 ? 0.55 : 0.28, lines: 52, knots });
  // rounded, worn long edges: bright wear just inside, dark crevice at the very edge
  const e = Math.min(b, mv - b);
  if (e < 0.02) {
    const t = e / 0.02;
    p.h -= (1 - t) * (1 - t) * 0.45;
    const wear = sstep(0.15, 0.55, t) * (1 - sstep(0.6, 1, t));
    p.r = mix(p.r, Math.min(1, p.r * 1.35 + 0.05), wear * 0.8); p.g = mix(p.g, Math.min(1, p.g * 1.33 + 0.04), wear * 0.8); p.b = mix(p.b, Math.min(1, p.b * 1.25 + 0.03), wear * 0.8);
    const dk = 1 - sstep(0, 0.35, t);
    p.r *= 1 - dk * 0.55; p.g *= 1 - dk * 0.55; p.b *= 1 - dk * 0.55; p.ao *= 1 - dk * 0.5;
  }
  // nails over each joist (every 1.0 m), two per plank
  if (k < 6) {
    const na = a - Math.round(a - 0.5) - 0.5; // distance to x.5
    for (const nb of [0.07, 0.18]) {
      const d = Math.hypot(na * 1, b - nb);
      if (d < 0.0125) {
        const t = d / 0.0125;
        put(p, lerpC(hex("#2a2622"), hex("#5a4636"), t)); p.h = 0.5 + 0.08 * (1 - t) - (t > 0.8 ? 0.06 : 0); p.ro = 0.45; p.me = t < 0.7 ? 0.7 : 0; p.ao = t > 0.8 ? 0.7 : 1;
      } else if (d < 0.03 && b < nb + 0.002) {
        // rust streak running down-grain
        const s = (1 - d / 0.03) * 0.35; p.r = mix(p.r, 0.42, s); p.g = mix(p.g, 0.24, s); p.b = mix(p.b, 0.14, s);
      }
    }
  }
}

function rope(a: number, b: number, p: Px) {
  const mv = 0.125, lay = 0.13;
  const ph = (a / lay - b / mv) * 3;
  const sp = ph - Math.floor(ph);
  const prof = Math.pow(Math.sin(Math.PI * sp), 0.55);
  // fibres run along the strand (rotated coords)
  const u = a * 0.8 + b * 0.6, fib = fbm(u * 220, ph * 3, 2);
  const base = hex("#cfad72"), dark = hex("#6b5030"), hi = hex("#ead29c");
  let c = lerpC(dark, base, prof);
  c = lerpC(c, hi, sstep(0.55, 0.9, fib) * prof * 0.6);
  c = lerpC(c, dark, (1 - fib) * 0.25);
  const dirt = fbm(a * 3, b * 8, 3); c = lerpC(c, hex("#8a7250"), sstep(0.55, 0.85, dirt) * 0.45);
  put(p, c);
  p.h = 0.25 + prof * 0.5 + (fib - 0.5) * 0.08; p.ro = 0.88; p.ao = 0.55 + prof * 0.45;
}

function bamboo(a: number, b: number, p: Px) {
  const seg = 0.42, t = a / seg, k = Math.floor(t), f = (t - k) * seg; // metres from the node
  const dn = Math.min(f, seg - f);
  const base = lerpC(hex("#d6b56c"), hex("#b9b25e"), clamp01(vnoise(k * 3.1, 0.5) * 0.9));
  const streak = fbm(a * 1.5, b * 140, 3);
  let c = lerpC(base, hex("#f0d995"), sstep(0.55, 0.85, streak) * 0.5);
  c = lerpC(c, hex("#9b7a3c"), (1 - streak) * 0.25);
  const ring = Math.exp(-(dn * dn) / (2 * 0.004 * 0.004)), band = Math.exp(-(dn * dn) / (2 * 0.014 * 0.014));
  c = lerpC(c, hex("#7f8a3a"), band * 0.55); c = lerpC(c, hex("#5e4a22"), ring * 0.6);
  const spot = cell(a * 60, b * 60); if (spot < 0.08 && vnoise(a * 7, b * 7) > 0.6) c = lerpC(c, hex("#6a4a24"), 0.6);
  put(p, c);
  p.h = 0.5 + ring * 0.3 + band * 0.08 + (streak - 0.5) * 0.05 + sstep(0, 0.2, dn) * 0.04; p.ro = 0.42 + (1 - streak) * 0.12; p.ao = 1 - ring * 0.25;
}

function endgrain(a: number, b: number, p: Px) {
  const cx = 0.25, cy = 0.25, dx = a - cx, dy = b - cy, r = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
  const rr = r + (fbm(th * 2 + 5, r * 8, 3) - 0.5) * 0.02;
  const t = rr / 0.0065, f = t - Math.floor(t);
  const ring = Math.pow(1 - Math.min(f, 1 - f) * 2, 4);
  let c = lerpC(hex("#c49a68"), hex("#8a6038"), ring * 0.6 + sstep(0.12, 0.24, r) * 0.3);
  c = lerpC(c, hex("#d8b584"), (1 - sstep(0, 0.05, r)) * 0.3);
  const crackTh = [0.4, 2.3, 4.4];
  let crack = 0;
  for (const ct of crackTh) { let d = Math.abs(((th - ct + Math.PI * 3) % (Math.PI * 2)) - Math.PI); d *= r; if (d < 0.0035 && r > 0.06 + ct * 0.01) crack = Math.max(crack, 1 - d / 0.0035); }
  const bark = sstep(0.225, 0.24, r);
  c = lerpC(c, hex("#4a3322"), bark * 0.9);
  c = lerpC(c, hex("#3a2616"), crack * 0.9);
  const weather = fbm(a * 9, b * 9, 3); c = lerpC(c, hex("#8d8378"), sstep(0.5, 0.8, weather) * 0.45);
  put(p, c);
  p.h = 0.5 - ring * 0.05 - crack * 0.4 - bark * 0.05; p.ro = 0.82; p.ao = 1 - crack * 0.6;
}

function metal(a: number, b: number, p: Px, painted: boolean) {
  const n = fbm(a * 14, b * 14, 4), sc = Math.abs(vnoise(a * 3 + b * 90, b * 2) - 0.5) < 0.012 ? 1 : 0;
  if (!painted) {
    const v = 0.72 + (n - 0.5) * 0.25 + sc * 0.15;
    put(p, [v, v, v * 0.98]); p.me = 1; p.ro = 0.34 + (1 - n) * 0.25 - sc * 0.1; p.h = 0.5 + (n - 0.5) * 0.04;
    const rust = fbm(a * 6 + 9, b * 6, 4); if (rust > 0.62) { const t = sstep(0.62, 0.75, rust); put(p, lerpC([v, v, v], hex("#7a4524"), t)); p.me = 1 - t; p.ro = mix(p.ro, 0.9, t); }
  } else {
    const chip = fbm(a * 20 + 3, b * 20, 4);
    const v = 0.9 + (n - 0.5) * 0.08;
    put(p, [v, v, v]); p.ro = 0.42 + (1 - n) * 0.12; p.me = 0; p.h = 0.52;
    if (chip > 0.68) { const t = sstep(0.68, 0.72, chip); put(p, lerpC([v, v, v], [0.35, 0.34, 0.33], t)); p.me = t * 0.9; p.ro = mix(p.ro, 0.4, t); p.h = 0.5 - 0.05 * t; }
    if (sc) { p.r = p.g = p.b = 0.55; p.me = 0.8; }
  }
}

function crate(a: number, b: number, p: Px) {
  // vertical slats, 5 per metre, with dark gaps
  const w = 0.2, k = Math.floor(a / w), f = a - k * w, e = Math.min(f, w - f);
  const r = rng(k * 31 + 7);
  const base = lerpC(hex("#8c5f3a"), hex("#6f4a2c"), r());
  wood(b, a, p, { seed: 40 + k * 3.3, base, dark: [base[0] * 0.45, base[1] * 0.42, base[2] * 0.4], light: [base[0] * 1.3, base[1] * 1.26, base[2] * 1.2], grey: 0.3, lines: 50 });
  if (e < 0.014) { const t = e / 0.014; const dk = 1 - sstep(0, 0.5, t); p.r *= 1 - dk * 0.7; p.g *= 1 - dk * 0.7; p.b *= 1 - dk * 0.7; p.h -= (1 - t) * (1 - t) * 0.4; p.ao *= 1 - dk * 0.6; }
}

function barrel(a: number, b: number, p: Px) {
  const w = 0.1, k = Math.floor(a / w), f = a - k * w, e = Math.min(f, w - f);
  const r = rng(k * 17 + 3);
  const base = lerpC(hex("#9a683e"), hex("#7a4e2e"), r());
  wood(b, a, p, { seed: 70 + k * 2.1, base, dark: [base[0] * 0.45, base[1] * 0.42, base[2] * 0.4], light: [base[0] * 1.28, base[1] * 1.25, base[2] * 1.2], grey: 0.2, lines: 60 });
  if (e < 0.006) { const t = e / 0.006; p.r *= 0.45 + 0.55 * t; p.g *= 0.45 + 0.55 * t; p.b *= 0.45 + 0.55 * t; p.h -= (1 - t) * 0.3; p.ao *= 0.6 + 0.4 * t; }
  // grime near top + bottom rims
  const rim = Math.max(1 - sstep(0, 0.12, b), sstep(0.88, 1, b));
  p.r *= 1 - rim * 0.35; p.g *= 1 - rim * 0.35; p.b *= 1 - rim * 0.33;
}

function target(a: number, b: number, p: Px) {
  const dx = a - 0.25, dy = b - 0.25, r = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
  // painted over end-grain wood
  endgrain(a, b, p);
  const wobble = (fbm(th * 1.5 + 3, r * 20, 2) - 0.5) * 0.006;
  const sp = ((r + wobble) / 0.042 - th / (Math.PI * 2)) % 1;
  const f = (sp + 1) % 1;
  const onRed = f < 0.5;
  const outer = r > 0.195 && r < 0.232, inner = r < 0.026;
  let paint: RGB = onRed || outer || inner ? hex("#c9352b") : hex("#f1e2c2");
  if (r > 0.232) paint = hex("#5a3a22");
  const edge = Math.min(Math.abs(f - 0.5), f, 1 - f) * 0.042; // metres to the stripe edge
  const chip = fbm(a * 30, b * 30, 3) > 0.72 && edge < 0.008 ? 1 : 0;
  const worn = sstep(0.6, 0.85, fbm(a * 8 + 5, b * 8, 3)) * 0.35;
  const t = (1 - chip) * (1 - worn * 0.5);
  if (r < 0.235) { p.r = mix(p.r, paint[0], t); p.g = mix(p.g, paint[1], t); p.b = mix(p.b, paint[2], t); p.ro = mix(p.ro, 0.55, t); p.h = mix(p.h, 0.53, t); }
}

function banana(a: number, b: number, p: Px) {
  const L = 0.25, t = a / L;
  const ridge = Math.pow(Math.abs(Math.cos((b / 0.125) * Math.PI * 5)), 3);
  let c = lerpC(hex("#f7cf38"), hex("#e7ab1c"), ridge * 0.5 + fbm(a * 20, b * 30, 2) * 0.2);
  c = lerpC(c, hex("#a9b43a"), sstep(0.72, 0.95, t) * 0.8);
  c = lerpC(c, hex("#6b5a2a"), sstep(0.955, 0.99, t));
  c = lerpC(c, hex("#2d2012"), 1 - sstep(0.015, 0.05, t));
  const sp = cell(a * 90, b * 90); if (sp < 0.16 && vnoise(a * 25, b * 25) > 0.45) c = lerpC(c, hex("#6a3f16"), (1 - sp / 0.16) * 0.85);
  const bruise = fbm(a * 12 + 4, b * 12, 3); c = lerpC(c, hex("#b07a26"), sstep(0.66, 0.8, bruise) * 0.5);
  put(p, c);
  p.h = 0.5 + ridge * 0.08; p.ro = 0.42; p.ao = 0.9 + ridge * 0.1;
}

// ---- atlas B painters
function thatch(a: number, b: number, p: Px) {
  const W = 0.0075;
  const col = Math.floor(a / W), r = rng(col * 7919 + 13);
  const slant = (r() - 0.5) * 0.25 * (1 - b);
  const aa = a + slant;
  const k = Math.floor(aa / W), f = (aa - k * W) / W, rr = rng(k * 104729 + 7);
  const tipLen = 0.03 + rr() * 0.22 + (vnoise(k * 0.05, 3) - 0.5) * 0.12;
  const v = rr();
  let c = lerpC(hex("#b98c4a"), hex("#e3c07a"), v);
  if (rr() < 0.18) c = lerpC(c, hex("#8a6a3a"), 0.6);
  c = lerpC(c, hex("#6e5230"), sstep(0.45, 1, b) * 0.45);                   // overlapped upper part sits in shade
  c = lerpC(c, hex("#f0d9a0"), (1 - sstep(tipLen, tipLen + 0.2, b)) * 0.3);  // sun-bleached tips
  const fib = fbm(a * 300, b * 6, 2); c = lerpC(c, [c[0] * 0.7, c[1] * 0.66, c[2] * 0.6], (1 - fib) * 0.4);
  put(p, c);
  const prof = Math.sin(Math.PI * f);
  p.h = 0.3 + prof * 0.5; p.ro = 0.9; p.ao = 0.55 + prof * 0.45 - sstep(0.5, 1, b) * 0.25;
  p.a = b > tipLen ? (prof > 0.12 || b > 0.45 ? 1 : 0) : 0;
}

function net(a: number, b: number, p: Px) {
  const top = 0.9, bot = 0.06;
  if (b > top) {
    const weave = fbm(a * 200, b * 200, 2);
    put(p, lerpC(hex("#f4f1e6"), hex("#d8d2bf"), weave * 0.5 + sstep(0.97, 1, b) * 0.3));
    p.ro = 0.8; p.h = 0.5 + weave * 0.04;
    const st = Math.abs(b - top - 0.01) < 0.002 || Math.abs(b - 0.985) < 0.002;
    if (st && (a * 100) % 1 < 0.6) { put(p, hex("#8a8578")); p.h = 0.45; }
    return;
  }
  if (b < bot) { put(p, hex("#ece6d4")); p.ro = 0.8; p.h = 0.5 + fbm(a * 150, b * 150, 2) * 0.04; return; }
  const cellS = 0.1, fa = (a / cellS) % 1, fb = ((b - bot) / cellS) % 1;
  const da = Math.min(fa, 1 - fa) * cellS, db = Math.min(fb, 1 - fb) * cellS;
  const cord = 0.0045, knot = Math.hypot(da, db) < 0.008;
  const on = da < cord || db < cord || knot;
  p.a = on ? 1 : 0;
  put(p, lerpC(hex("#1d1d1f"), hex("#3a3a3c"), fbm(a * 80, b * 80, 2)));
  p.h = 0.5 + (on ? 0.2 * (1 - Math.min(da, db) / cord) : 0); p.ro = 0.7;
}

function frond(a: number, b: number, p: Px) {
  const L = 4.4, mid = 1.1, t = a / L;
  const y = b - mid, ay = Math.abs(y);
  const rw = 0.028 * (1 - t) + 0.006;                          // rachis half-width
  if (ay < rw && t < 1) {
    put(p, lerpC(hex("#b6c35a"), hex("#7f9a36"), ay / rw)); p.h = 0.6 - (ay / rw) * 0.2; p.ro = 0.5; p.a = 1; return;
  }
  const phi = 0.62 + t * 0.25;                                  // leaflet angle from the rachis (rad)
  const a0 = a - ay / Math.tan(phi);                            // where this pixel's leaflet leaves the rachis
  const S = 0.075;
  const k = Math.round(a0 / S), off = (a0 - k * S) * Math.sin(phi);
  const t0 = (k * S) / L;
  const lenProf = Math.sin(Math.PI * Math.min(1, Math.max(0, t0 * 0.92 + 0.05))) ** 0.6 * 1.05 + 0.08;
  const rk = rng(k * 131 + (y > 0 ? 7 : 3));
  const len = lenProf * (0.85 + rk() * 0.3);
  const along = ay / Math.sin(phi);                             // distance along the leaflet
  const u = along / len;
  const hw = 0.034 * Math.sin(Math.PI * Math.min(1, u) ** 0.8) * (u < 1 ? 1 : 0) + 0.004;
  const missing = rk() < 0.05 || t0 > 0.99 || t0 < 0.02;
  if (u < 1 && Math.abs(off) < hw && !missing) {
    const e = Math.abs(off) / hw;
    let c = lerpC(hex("#3d8a2a"), hex("#6fae34"), u * 0.8 + (fbm(a * 20, b * 20, 2) - 0.5) * 0.4);
    c = lerpC(c, hex("#2a6a1e"), sstep(0.2, 0, u) * 0.6);
    c = lerpC(c, hex("#c3d66a"), sstep(0.75, 1, u) * 0.5 + sstep(0.7, 1, e) * 0.25);
    if (e < 0.12) c = lerpC(c, hex("#a8c85a"), 0.45);           // midrib
    if (rk() < 0.12 && u > 0.6) c = lerpC(c, hex("#b89a48"), sstep(0.6, 1, u) * 0.8); // dry tip
    put(p, c);
    p.h = 0.5 + (1 - e) * 0.18; p.ro = 0.48; p.ao = 0.75 + u * 0.25; p.a = 1;
  } else { p.a = 0; put(p, hex("#4f8f2e")); }
}

function bleaf(a: number, b: number, p: Px) {
  const L = 2.4, mid = 0.6, t = a / L;
  const y = b - mid, ay = Math.abs(y);
  const hw = 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t))), 0.65) * (1 - 0.15 * t);
  if (ay > hw || t > 1) { p.a = 0; put(p, hex("#4a9a2e")); return; }
  // tears along the vein direction
  const veinPh = (a - ay * 0.45) / 0.035;
  const tearK = Math.floor((a - ay * 0.45) / 0.16);
  const rk = rng(tearK * 37 + (y > 0 ? 1 : 2));
  const tearOn = rk() < 0.35 && ay > hw * (0.35 + rk() * 0.4);
  const tearD = Math.abs(((a - ay * 0.45) / 0.16) % 1 - 0.5) * 0.16;
  if (tearOn && tearD < 0.004 + 0.004 * (ay / hw)) { p.a = 0; put(p, hex("#4a9a2e")); return; }
  const vein = Math.pow(Math.abs(Math.cos(veinPh * Math.PI)), 12);
  const e = ay / hw;
  let c = lerpC(hex("#3f9a33"), hex("#6cbf3e"), (fbm(a * 3, b * 6, 3) - 0.3) * 0.9);
  c = lerpC(c, hex("#2b7426"), vein * 0.25 + sstep(0.8, 1, e) * 0.3);
  if (ay < 0.018 * (1 - t) + 0.005) c = lerpC(hex("#d7e48c"), hex("#a8c85a"), ay / 0.023);
  c = lerpC(c, hex("#a6a444"), sstep(0.9, 1, e) * sstep(0.5, 0.9, fbm(a * 4, b * 4, 2)) * 0.8);
  put(p, c);
  p.h = 0.5 - vein * 0.06 + (1 - e) * 0.05; p.ro = 0.42; p.ao = 0.85 + (1 - e) * 0.15; p.a = 1;
}

function grass(a: number, b: number, p: Px) {
  p.a = 0; put(p, hex("#6a9a38"));
  for (let i = 0; i < 9; i++) {
    const r = rng(i * 97 + 5), ang = (r() - 0.5) * 1.3, len = 0.22 + r() * 0.25, bx = 0.25 + (r() - 0.5) * 0.08, curve = (r() - 0.5) * 0.25;
    const tt = b / len; if (tt > 1) continue;
    const cx = bx + Math.sin(ang) * b + curve * tt * tt * len;
    const w = 0.012 * (1 - tt) + 0.0015;
    const d = Math.abs(a - cx);
    if (d < w) { put(p, lerpC(lerpC(hex("#5e8f2e"), hex("#9cc04a"), tt), hex("#c8c26a"), sstep(0.8, 1, tt) * 0.6)); p.a = 1; p.h = 0.5 + (1 - d / w) * 0.1; p.ro = 0.6; p.ao = 0.6 + tt * 0.4; }
  }
}

function leather(a: number, b: number, p: Px) {
  const H = 1.3;
  const f = b / H;
  const red = f < 0.2 || (f > 0.74 && f < 0.95);
  const base: RGB = red ? hex("#b5261f") : hex("#1d1c20");
  const gr = cell(a * 260, b * 260), crease = Math.abs(fbm(a * 3, b * 22, 3) - 0.5);
  let c = lerpC(base, red ? hex("#7a1712") : hex("#0e0d10"), sstep(0.3, 0.9, gr) * 0.4);
  c = lerpC(c, red ? hex("#d9443a") : hex("#3c3b44"), sstep(0.5, 0.8, fbm(a * 4, b * 4, 3)) * 0.35);
  const scuff = fbm(a * 10 + 3, b * 10, 4); c = lerpC(c, red ? hex("#c9786a") : hex("#55535c"), sstep(0.7, 0.85, scuff) * 0.35);
  // stitched seams at band edges + one vertical seam
  let seam = 0;
  for (const s of [0.2, 0.74, 0.95]) { const d = Math.abs(f - s) * H; if (d < 0.006) seam = Math.max(seam, 1 - d / 0.006); }
  const vs = Math.min(a, 1.35 - a); if (vs < 0.006) seam = Math.max(seam, 1 - vs / 0.006);
  let stitch = 0;
  for (const s of [0.2, 0.74, 0.95]) { const d = Math.abs(f * H - s * H - 0.012); if (d < 0.0022 && (a * 90) % 1 < 0.55) stitch = 1; const d2 = Math.abs(f * H - s * H + 0.012); if (d2 < 0.0022 && (a * 90) % 1 < 0.55) stitch = 1; }
  c = lerpC(c, [c[0] * 0.4, c[1] * 0.4, c[2] * 0.4], seam * 0.9);
  if (stitch) c = red ? hex("#e8d7c0") : hex("#8e8a86");
  put(p, c);
  p.h = 0.5 - gr * 0.04 - (crease < 0.02 ? (1 - crease / 0.02) * 0.08 : 0) - seam * 0.3 + stitch * 0.08;
  p.ro = (red ? 0.38 : 0.34) + gr * 0.12 + sstep(0.7, 0.85, scuff) * 0.2; p.ao = 1 - seam * 0.4;
}

function trunk(a: number, b: number, p: Px) {
  // ring scars every ~0.14 m with a raised lower lip, fibrous vertical grain between
  const wob = (fbm(a * 3, b * 2, 2) - 0.5) * 0.04;
  const t = (b + wob) / 0.14, k = Math.floor(t), f = t - k;
  const r = rng(k * 71 + 9);
  const base = lerpC(hex("#7d6650"), hex("#6a5442"), r());
  const fib = fbm(a * 90, b * 6, 3);
  let c = lerpC(base, hex("#a58a6a"), sstep(0.55, 0.9, fib) * 0.5);
  c = lerpC(c, hex("#4a3a2c"), (1 - fib) * 0.3);
  const lip = sstep(0.0, 0.12, f) * (1 - sstep(0.12, 0.35, f));
  const groove = 1 - sstep(0.0, 0.06, f);
  c = lerpC(c, hex("#b89c78"), lip * 0.55);
  c = lerpC(c, hex("#2e241c"), groove * 0.8);
  const moss = fbm(a * 5 + 7, b * 5, 3); c = lerpC(c, hex("#6f7a4a"), sstep(0.68, 0.8, moss) * 0.35);
  put(p, c);
  p.h = 0.4 + lip * 0.3 - groove * 0.25 + (f * 0.15) + (fib - 0.5) * 0.06; p.ro = 0.86; p.ao = 0.7 + lip * 0.3 - groove * 0.3;
}

function mat(a: number, b: number, p: Px) {
  const dx = a - 1.7, dy = b - 1.7, r = Math.hypot(dx, dy);
  const wv = (Math.sin(a * 900) * Math.sin(b * 900)) * 0.5 + 0.5;
  let c = lerpC(hex("#141416"), hex("#26262a"), wv * 0.4 + fbm(a * 3, b * 3, 3) * 0.3);
  const ring = Math.abs(r - 1.56) < 0.012 ? 1 : 0;
  if (ring && (Math.atan2(dy, dx) * 60) % 1 < 0.6) c = hex("#8a8a8e");
  const dust = fbm(a * 5 + 11, b * 5, 4); c = lerpC(c, hex("#6a6258"), sstep(0.58, 0.85, dust) * 0.35);
  put(p, c);
  p.h = 0.5 + wv * 0.04; p.ro = 0.62 - wv * 0.1; p.ao = 1;
}

function canvas(a: number, b: number, p: Px) {
  const s = a / 0.6;
  const white = (s > 0.12 && s < 0.16) || (s > 0.84 && s < 0.88) || (s > 0.47 && s < 0.53);
  const weave = (Math.sin(a * 1500) * 0.5 + 0.5) * (Math.sin(b * 1500) * 0.5 + 0.5);
  let c = white ? hex("#e9e4d6") : lerpC(hex("#1f3f94"), hex("#2c56b8"), fbm(a * 4, b * 4, 3));
  c = lerpC(c, [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8], weave * 0.25);
  const fade = fbm(a * 3 + 5, b * 3, 3); c = lerpC(c, hex("#7b8fb8"), sstep(0.6, 0.85, fade) * (white ? 0 : 0.3));
  put(p, c); p.h = 0.5 + weave * 0.05; p.ro = 0.85;
}

function pad(a: number, b: number, p: Px) {
  const seam = Math.abs(((a / 0.5) % 1) - 0.5) > 0.49 ? 1 : 0;
  const wr = fbm(a * 6, b * 14, 3);
  let c = lerpC(hex("#1d55d0"), hex("#2f6cf0"), wr * 0.6);
  c = lerpC(c, hex("#0e2f86"), seam * 0.7);
  const scuff = fbm(a * 12 + 3, b * 12, 4); c = lerpC(c, hex("#6f8fd0"), sstep(0.72, 0.85, scuff) * 0.35);
  put(p, c); p.h = 0.5 + (wr - 0.5) * 0.1 - seam * 0.25; p.ro = 0.3 + (1 - wr) * 0.12;
}

function sign(a: number, b: number, p: Px) {
  wood(a, b, p, { seed: 91, base: hex("#5a3a24"), dark: hex("#2e1d12"), light: hex("#7a5436"), grey: 0.15, lines: 40 });
  const e = Math.min(a, 2 - a, b, 0.5 - b);
  if (e < 0.03) { const t = e / 0.03; p.r *= 0.6 + 0.4 * t; p.g *= 0.6 + 0.4 * t; p.b *= 0.6 + 0.4 * t; }
}

function windsock(a: number, b: number, p: Px) {
  const band = Math.floor((b / 0.6) * 5);
  const wv = fbm(a * 200, b * 200, 2);
  let c = band % 2 === 0 ? hex("#ff6a1c") : hex("#f3eee4");
  c = lerpC(c, [c[0] * 0.75, c[1] * 0.75, c[2] * 0.75], wv * 0.3 + sstep(0.6, 0.85, fbm(a * 3, b * 3, 3)) * 0.2);
  put(p, c); p.ro = 0.85; p.h = 0.5 + wv * 0.04;
}

function bottle(a: number, b: number, p: Px) {
  const col = Math.floor((a / 0.3) * 4);
  const tones = [hex("#2f8a4a"), hex("#b8691e"), hex("#6fb6c9"), hex("#8a2f3a")];
  let c = tones[col] ?? tones[0];
  const hl = Math.abs(((a / 0.3) * 4) % 1 - 0.3) < 0.05 ? 1 : 0;
  c = lerpC(c, [1, 1, 1], hl * 0.6);
  const label = b > 0.08 && b < 0.16 && col !== 2;
  if (label) c = col === 1 ? hex("#f1d36a") : hex("#efe6cf");
  put(p, c); p.ro = label ? 0.7 : 0.12; p.h = 0.5;
}

function lantern(a: number, b: number, p: Px) {
  const rib = Math.pow(Math.abs(Math.cos((b / 0.02) * Math.PI)), 10);
  const glow = 1 - Math.abs(b / 0.25 - 0.5) * 1.1;
  const v = 0.55 + glow * 0.45 - rib * 0.3;
  put(p, [v, v * 0.97, v * 0.92]); p.ro = 0.8;
}
function bulb(a: number, b: number, p: Px) {
  const r = Math.hypot(a - 0.05, b - 0.05) / 0.05;
  const v = 1 - r * 0.35;
  put(p, [v, v * 0.95, v * 0.85]); p.ro = 0.2;
}

function paintMark(a: number, b: number, p: Px) {
  const w = fbm(a * 6, b * 6, 4), g = fbm(a * 40, b * 40, 2);
  put(p, lerpC(hex("#f2efe6"), hex("#cfcac0"), g * 0.5 + sstep(0.5, 0.8, w) * 0.3));
  p.a = w + g * 0.2 > 0.42 ? 1 : 0; p.ro = 0.62; p.h = 0.52;
}
function sandDecal(a: number, b: number, p: Px) {
  const n = fbm(a * 1.6, b * 3, 4), g = fbm(a * 60, b * 60, 2);
  // a long drift: dense in the middle row of the region, ragged edges
  const cy = 0.5 + (fbm(a * 0.8, 3, 2) - 0.5) * 0.3, dist = Math.abs(b - cy) / 0.5;
  put(p, lerpC(hex("#e6d2a2"), hex("#cdb584"), g * 0.6 + n * 0.3));
  // soft feathered edge (a binary alpha reads as a jagged paper-cut with a dark fringe) — the decal material
  // blends it over the tarmac
  p.a = sstep(0.62, 0.98, n * 0.9 + (1 - dist) * 0.6); p.ro = 0.95; p.h = 0.5 + g * 0.08;
}
function shell(a: number, b: number, p: Px) {
  const col = Math.floor((a / 0.3) * 3);
  const tones = [hex("#f1d6c4"), hex("#e8a58a"), hex("#f4ead8")];
  const rib = Math.abs(Math.sin(a * 400)) ** 4;
  put(p, lerpC(tones[col] ?? tones[0], hex("#b8826a"), rib * 0.35 + (1 - b / 0.3) * 0.15)); p.ro = 0.4; p.h = 0.5 + rib * 0.1;
}
function fabric(a: number, b: number, p: Px) {
  const wv = (Math.sin(a * 1600) * 0.5 + 0.5) * (Math.sin(b * 1600) * 0.5 + 0.5);
  const v = 0.86 + wv * 0.08 + (fbm(a * 5, b * 5, 3) - 0.5) * 0.1;
  put(p, [v, v, v]); p.ro = 0.88; p.h = 0.5 + wv * 0.05;
}

// ---- tiling sheets
/** periodic rope (a, b in [0,1)): 3 strands, 8 lays per u unit, fibres + dirt, tiles in both directions */
function ropeTile(a: number, b: number, p: Px) {
  const ph = (a * 8 + b) * 3;
  const sp = ph - Math.floor(ph);
  const prof = Math.pow(Math.sin(Math.PI * sp), 0.55);
  const fib = fbm(a * 256 + b * 16, sp * 8 + b * 32, 2, 64), dirt = fbm(a * 24, b * 24, 3, 24);
  const base = hex("#d4b278"), dark = hex("#6b5030"), hi = hex("#f0dca6");
  let c = lerpC(dark, base, prof);
  c = lerpC(c, hi, sstep(0.55, 0.9, fib) * prof * 0.55);
  c = lerpC(c, dark, (1 - fib) * 0.2);
  c = lerpC(c, hex("#9a8260"), sstep(0.55, 0.85, dirt) * 0.35);
  put(p, c);
  p.h = 0.25 + prof * 0.5 + (fib - 0.5) * 0.08; p.ro = 0.88; p.ao = 0.5 + prof * 0.5;
}
function tarmac(a: number, b: number, p: Px) {
  // 8 m tile, periodic noise; aggregate speckles + tar seams + patching
  const P = 8, n = fbm(a / 2, b / 2, 4, P / 2), ag = cell(a * 55, b * 55, 55 * P), fine = vnoise(a * 180, b * 180, 180 * P);
  let c = lerpC(hex("#45474b"), hex("#34363a"), n);
  c = lerpC(c, hex("#6a6a6c"), sstep(0.22, 0.05, ag) * 0.6);
  c = lerpC(c, hex("#2a2b2e"), (1 - fine) * 0.2);
  const patch = fbm(a / 3 + 7, b / 3, 3, P / 3); c = lerpC(c, hex("#2b2c30"), sstep(0.62, 0.66, patch) * 0.6);
  const crk = Math.abs(fbm(a / 1.3 + 3, b / 1.3, 4, P / 1.3) - 0.5); if (crk < 0.008) c = lerpC(c, hex("#1c1d20"), 0.8);
  const dust = fbm(a / 1.5 + 13, b / 1.5, 4, P / 1.5); c = lerpC(c, hex("#8b8173"), sstep(0.6, 0.8, dust) * 0.25);
  put(p, c);
  p.h = 0.5 + sstep(0.22, 0.05, ag) * 0.15 - (crk < 0.008 ? 0.3 : 0) + fine * 0.05; p.ro = 0.82 - sstep(0.62, 0.66, patch) * 0.1; p.ao = 1 - (crk < 0.008 ? 0.4 : 0);
}
function rock(a: number, b: number, p: Px) {
  // 6 m tile: limestone — soft value masses, horizontal strata, cracks and pits
  const P = 6, n = fbm(a / 1.4, b / 1.4, 5, P / 1.4), strata = Math.sin((b + (n - 0.5) * 0.5) * 9) * 0.5 + 0.5;
  const pit = cell(a * 9, b * 9, 9 * P), crk = Math.abs(fbm(a / 0.9 + 5, b / 0.9, 4, P / 0.9) - 0.5);
  let c = lerpC(hex("#9c978c"), hex("#c9c3b4"), sstep(0.35, 0.75, n));
  c = lerpC(c, hex("#7c776e"), strata * 0.25);
  c = lerpC(c, hex("#5a564f"), sstep(0.18, 0.05, pit) * 0.5);
  if (crk < 0.012) c = lerpC(c, hex("#3e3a35"), (1 - crk / 0.012) * 0.8);
  const stain = fbm(a / 2 + 9, b / 3, 3, P / 2); c = lerpC(c, hex("#8a7f6a"), sstep(0.55, 0.8, stain) * 0.3);
  put(p, c);
  p.h = 0.5 + (n - 0.5) * 0.5 + strata * 0.06 - sstep(0.18, 0.05, pit) * 0.2 - (crk < 0.012 ? 0.3 : 0); p.ro = 0.78 + (1 - n) * 0.1; p.ao = 1 - (crk < 0.012 ? 0.5 : 0) - sstep(0.18, 0.05, pit) * 0.3;
}

// ------------------------------------------------------------------------------------------------ stencil text
function stencilText(sh: Sheet, r: Region, text: string, opts: { cx: number; cy: number; size: number; color: RGB; rot?: number; wear?: number; font?: string }) {
  sh.stamp(r, (g, w, h) => {
    g.save();
    g.translate(opts.cx * w, (1 - opts.cy) * h);
    if (opts.rot) g.rotate(opts.rot);
    g.fillStyle = "#fff";
    g.font = opts.font ?? `900 ${Math.round(opts.size * h)}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(text, 0, 0);
    g.restore();
  }, (m, a, b, i) => {
    const wear = opts.wear ?? 0.3;
    const n = fbm(a * 40, b * 40, 3);
    const t = m * (n > wear + 0.25 ? 1 : sstep(wear, wear + 0.25, n));
    sh.setCol(i, opts.color, t * 0.92);
    sh.hgt[i] += t * 0.02;
    sh.orm[i * 4 + 1] = mix(sh.orm[i * 4 + 1], 150, t);
  });
}

// ------------------------------------------------------------------------------------------------ build
/** baked atlas files (public/assets/actors/lobby/): bump when a painter changes, then re-run
 *  `node client/src/world/pois/lobby-islet/bake-atlas.mjs` (needs the dev server + basisu). */
export const ATLAS_BAKE = "v2";
export const ATLAS_SHEETS = ["A", "B", "tarmac", "rock", "rope"] as const;
type SheetId = (typeof ATLAS_SHEETS)[number];
const NORMAL_STRENGTH: Record<SheetId, number> = { A: 5, B: 5, tarmac: 3, rock: 4, rope: 4 };

/** paint every sheet on the CPU (the slow path: ~3.4 s) */
export function paintSheets(): Record<SheetId, Sheet> {
  // ---- A
  const A = new Sheet(2048);
  A_REG.plank.forEach((r, k) => A.paint(r, (a, b, p) => plank(a, b, p, k), 0));
  {
    const kn = (seed: number) => { const r = rng(seed); return Array.from({ length: 10 }, () => [r() * 4, r(), 0.012 + r() * 0.02] as [number, number, number]); };
    const k1 = kn(5), k2 = kn(9);
    A.paint(A_REG.grainWarm, (a, b, p) => wood(a, b, p, { seed: 21, base: hex("#8a5c3a"), dark: hex("#3e2616"), light: hex("#b5845a"), grey: 0.2, lines: 44, knots: k1 }));
    A.paint(A_REG.grainDark, (a, b, p) => wood(a, b, p, { seed: 33, base: hex("#5e3e28"), dark: hex("#2a1a10"), light: hex("#86603f"), grey: 0.35, lines: 40, knots: k2 }));
  }
  A.paint(A_REG.rope, rope);
  A.paint(A_REG.bamboo, bamboo);
  A.paint(A_REG.endgrain, endgrain);
  A.paint(A_REG.metal, (a, b, p) => metal(a, b, p, false));
  A.paint(A_REG.paintMetal, (a, b, p) => metal(a, b, p, true));
  A.paint(A_REG.crate, crate);
  A.paint(A_REG.barrel, barrel);
  A.paint(A_REG.target, target);
  A.paint(A_REG.banana, banana);
  stencilText(A, A_REG.crate, "BANANA", { cx: 0.5, cy: 0.56, size: 0.15, color: hex("#2a1a0f"), wear: 0.28 });
  stencilText(A, A_REG.crate, "CO.", { cx: 0.5, cy: 0.4, size: 0.15, color: hex("#2a1a0f"), wear: 0.28 });
  stencilText(A, A_REG.barrel, "BANANA CO.", { cx: 0.25, cy: 0.52, size: 0.13, color: hex("#2a1a0f"), wear: 0.3 });
  stencilText(A, A_REG.barrel, "BANANA CO.", { cx: 0.75, cy: 0.52, size: 0.13, color: hex("#f2d25a"), wear: 0.35 });

  // ---- B
  const B = new Sheet(2048);
  B.paint(B_REG.thatch, thatch, 0);
  B.paint(B_REG.net, net);
  B.paint(B_REG.frond, frond);
  B.paint(B_REG.bleaf, bleaf);
  B.paint(B_REG.leather, leather);
  B.paint(B_REG.trunk, trunk);
  B.paint(B_REG.mat, mat);
  B.paint(B_REG.canvas, canvas);
  B.paint(B_REG.pad, pad);
  B.paint(B_REG.grass, grass);
  B.paint(B_REG.sign, sign);
  B.paint(B_REG.windsock, windsock);
  B.paint(B_REG.bottle, bottle);
  B.paint(B_REG.lantern, lantern);
  B.paint(B_REG.bulb, bulb);
  B.paint(B_REG.lens, bulb);
  B.paint(B_REG.paint, paintMark);
  B.paint(B_REG.sand, sandDecal);
  B.paint(B_REG.shell, shell);
  B.paint(B_REG.sock, (a, b, p) => windsock(b, a * 0.6, p));          // bands along u (the sock tube runs along u)
  B.paint(B_REG.fabric, fabric);
  stencilText(B, B_REG.sign, "BANANA CO.", { cx: 0.5, cy: 0.5, size: 0.62, color: hex("#f6d45a"), wear: 0.22 });

  // ---- tiling sheets
  const T = new Sheet(1024);
  T.paint({ x: 0, y: 0, w: 1024, h: 1024, mu: 8, mv: 8 }, tarmac, 0);
  const K = new Sheet(1024);
  K.paint({ x: 0, y: 0, w: 1024, h: 1024, mu: 6, mv: 6 }, rock, 0);
  const Rp = new Sheet(256);
  Rp.paint({ x: 0, y: 0, w: 256, h: 256, mu: 1, mv: 1 }, ropeTile, 0);
  return { A, B, tarmac: T, rock: K, rope: Rp };
}

type TexSet = { map: THREE.Texture; normalMap: THREE.Texture; ormMap: THREE.Texture };
function assemble(t: Record<SheetId, TexSet>, ms: number): AtlasSet {
  for (const id of ["tarmac", "rock", "rope"] as const) for (const m of Object.values(t[id])) { m.wrapS = m.wrapT = THREE.RepeatWrapping; m.needsUpdate = true; }
  const uvS = (size: number) => (r: Region) => Sheet.uvOf(size, r);
  const ua = uvS(2048), ub = uvS(2048);
  const uvA = (k: AKey | `plank${number}`) => (k.startsWith("plank") && k !== "plank" ? ua(A_REG.plank[Number(k.slice(5))]) : ua(A_REG[k as Exclude<AKey, "plank">] as Region));
  const uvB = (k: BKey) => ub(B_REG[k]);
  return { A: { tex: t.A, uv: uvA }, B: { tex: t.B, uv: uvB }, tarmac: t.tarmac, rock: t.rock, rope: t.rope, ms };
}

/** the CPU path: paint + upload canvases (fallback when the baked files are missing / fail) */
export function buildAtlases(aniso: number): AtlasSet {
  const t0 = performance.now();
  const sh = paintSheets();
  const tex = Object.fromEntries(ATLAS_SHEETS.map((id) => [id, sh[id].textures(NORMAL_STRENGTH[id], aniso)])) as unknown as Record<SheetId, TexSet>;
  return assemble(tex, Math.round(performance.now() - t0));
}

/** bake helper (bake-atlas.mjs): every sheet's colour / normal / orm as PNG data URLs (canvas orientation) */
export function bakeSheetPNGs(): Record<string, string> {
  const sh = paintSheets(), out: Record<string, string> = {};
  for (const id of ATLAS_SHEETS) {
    const t = sh[id].textures(NORMAL_STRENGTH[id], 1);
    for (const [k, tx] of Object.entries(t)) out[`${id}-${k === "map" ? "color" : k === "normalMap" ? "normal" : "orm"}`] = (tx.image as HTMLCanvasElement).toDataURL("image/png");
    for (const tx of Object.values(t)) tx.dispose();
  }
  return out;
}

/** load the baked KTX2 atlases (≈0.1–0.3 s, GPU-compressed); falls back to painting them (≈3.4 s) */
export async function loadAtlases(assets: Assets, aniso: number): Promise<AtlasSet> {
  const t0 = performance.now();
  try {
    const one = async (id: SheetId, kind: "color" | "normal" | "orm") => {
      const t = await assets.compressedTexture(`assets/actors/lobby/lobby-${ATLAS_BAKE}-${id}-${kind}.ktx2`);
      t.colorSpace = kind === "color" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = aniso; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
      return t;
    };
    const entries = await Promise.all(ATLAS_SHEETS.map(async (id) => {
      const [map, normalMap, ormMap] = await Promise.all([one(id, "color"), one(id, "normal"), one(id, "orm")]);
      return [id, { map, normalMap, ormMap }] as const;
    }));
    return assemble(Object.fromEntries(entries) as unknown as Record<SheetId, TexSet>, Math.round(performance.now() - t0));
  } catch (e) {
    console.warn("[lobby-islet] baked atlases unavailable — painting them (slow path)", e);
    return buildAtlases(aniso);
  }
}
