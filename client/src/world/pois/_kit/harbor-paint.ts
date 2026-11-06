// poi-harbor kit — canvas painting helpers. Everything with text/logos/wear in the harbor + wreck is painted in code
// with these (no baked text). All functions draw into a 2D context in CSS pixels; textures come out via `tex()`.
import * as THREE from "three";
import { capped } from "../../../engine/tex-cap";

export type Rng = () => number;

/** deterministic mulberry32 */
export function rng(seed: number): Rng {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  // (the harbor's texture painters also run in a worker — harbor-tex.worker.ts — on an OffscreenCanvas)
  if (typeof document === "undefined") { const oc = new OffscreenCanvas(w, h); return [oc as unknown as HTMLCanvasElement, oc.getContext("2d") as unknown as CanvasRenderingContext2D]; }
  const el = document.createElement("canvas");
  el.width = w; el.height = h;
  const c = el.getContext("2d", { willReadFrequently: false })!;
  return [el, c];
}

const noiseCache = new Map<string, HTMLCanvasElement>();
/** tileable grey fbm value-noise tile (mid grey = 128) */
export function noiseTile(size = 256, seed = 1, octaves = 4, persistence = 0.55): HTMLCanvasElement {
  const key = `${size}:${seed}:${octaves}:${persistence}`;
  const hit = noiseCache.get(key);
  if (hit) return hit;
  const [el, c] = canvas(size, size);
  const img = c.createImageData(size, size);
  const r = rng(seed * 7919 + 17);
  const acc = new Float32Array(size * size);
  let amp = 1, total = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 4 << o; // lattice cells per tile
    const lat = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) lat[i] = r();
    const cell = size / n;
    for (let y = 0; y < size; y++) {
      const fy = y / cell, iy = Math.floor(fy), ty = fy - iy, sy = ty * ty * (3 - 2 * ty);
      const y0 = iy % n, y1 = (iy + 1) % n;
      for (let x = 0; x < size; x++) {
        const fx = x / cell, ix = Math.floor(fx), tx = fx - ix, sx = tx * tx * (3 - 2 * tx);
        const x0 = ix % n, x1 = (ix + 1) % n;
        const a = lat[y0 * n + x0], b = lat[y0 * n + x1], cc = lat[y1 * n + x0], d = lat[y1 * n + x1];
        const v = (a + (b - a) * sx) * (1 - sy) + (cc + (d - cc) * sx) * sy;
        acc[y * size + x] += (v - 0.5) * amp;
      }
    }
    total += amp; amp *= persistence;
  }
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(255, Math.round(128 + (acc[i] / total) * 2 * 127)));
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  noiseCache.set(key, el);
  return el;
}

export interface NoiseOpts { seed?: number; scale?: number; alpha?: number; blend?: GlobalCompositeOperation; octaves?: number; offset?: number }
/** paint tileable noise over a rect. scale = px per tile. blend defaults to overlay (adds tonal variation). */
export function paintNoise(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, o: NoiseOpts = {}) {
  const { seed = 1, scale = 256, alpha = 0.3, blend = "overlay", octaves = 4, offset = 0 } = o;
  const tile = noiseTile(256, seed, octaves);
  const pat = c.createPattern(tile, "repeat")!;
  pat.setTransform(new DOMMatrix().translate(offset, offset * 0.37).scale(scale / 256));
  c.save();
  c.globalAlpha = alpha; c.globalCompositeOperation = blend; c.fillStyle = pat;
  c.fillRect(x, y, w, h);
  c.restore();
}

export interface SplotchOpts { n: number; rMin: number; rMax: number; color: string; alpha?: number; seed?: number; soft?: number; blend?: GlobalCompositeOperation }
/** soft radial splotches (dirt, rust bloom, moss) */
export function splotches(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, o: SplotchOpts) {
  const r = rng(o.seed ?? 3), soft = o.soft ?? 0.35;
  c.save(); c.globalCompositeOperation = o.blend ?? "source-over";
  for (let i = 0; i < o.n; i++) {
    const rad = o.rMin + (o.rMax - o.rMin) * r() ** 2, px = x + r() * w, py = y + r() * h;
    const g = c.createRadialGradient(px, py, rad * soft, px, py, rad);
    g.addColorStop(0, o.color); g.addColorStop(1, "rgba(0,0,0,0)");
    c.globalAlpha = (o.alpha ?? 0.5) * (0.5 + 0.5 * r());
    c.fillStyle = g; c.beginPath(); c.ellipse(px, py, rad * (0.7 + 0.6 * r()), rad, r() * Math.PI, 0, Math.PI * 2); c.fill();
  }
  c.restore();
}

export interface StreakOpts { n: number; color: string; alpha?: number; seed?: number; lenMin: number; lenMax: number; width?: number; blend?: GlobalCompositeOperation }
/** vertical drip streaks starting on the top edge of the rect (rust under rivets, dirt under rails) */
export function streaks(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, o: StreakOpts) {
  const r = rng(o.seed ?? 5);
  c.save(); c.globalCompositeOperation = o.blend ?? "source-over";
  for (let i = 0; i < o.n; i++) {
    const px = x + r() * w, len = Math.min(h, o.lenMin + (o.lenMax - o.lenMin) * r() ** 1.5), wd = (o.width ?? 6) * (0.5 + r());
    const g = c.createLinearGradient(px, y, px, y + len);
    g.addColorStop(0, o.color); g.addColorStop(0.15, o.color); g.addColorStop(1, "rgba(0,0,0,0)");
    c.globalAlpha = (o.alpha ?? 0.6) * (0.4 + 0.6 * r());
    c.fillStyle = g;
    c.beginPath(); c.moveTo(px - wd / 2, y); c.lineTo(px + wd / 2, y); c.lineTo(px + wd * 0.2, y + len); c.lineTo(px - wd * 0.2, y + len); c.closePath(); c.fill();
  }
  c.restore();
}

/** gradient shading from the rect edges (ambient dirt at the bottom, sun-bleach at the top...) */
export function edgeShade(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  o: { size: number; color: string; alpha?: number; sides?: Array<"top" | "bottom" | "left" | "right">; blend?: GlobalCompositeOperation }) {
  c.save(); c.globalAlpha = o.alpha ?? 0.5; c.globalCompositeOperation = o.blend ?? "source-over";
  for (const s of o.sides ?? ["bottom"]) {
    let g: CanvasGradient;
    if (s === "top") g = c.createLinearGradient(0, y, 0, y + o.size);
    else if (s === "bottom") g = c.createLinearGradient(0, y + h, 0, y + h - o.size);
    else if (s === "left") g = c.createLinearGradient(x, 0, x + o.size, 0);
    else g = c.createLinearGradient(x + w, 0, x + w - o.size, 0);
    g.addColorStop(0, o.color); g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g; c.fillRect(x, y, w, h);
  }
  c.restore();
}

/** thin scratch lines */
export function scratches(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  o: { n: number; color: string; alpha?: number; seed?: number; lenMin?: number; lenMax?: number; width?: number }) {
  const r = rng(o.seed ?? 9);
  c.save(); c.strokeStyle = o.color; c.lineWidth = o.width ?? 1.2; c.lineCap = "round";
  for (let i = 0; i < o.n; i++) {
    const px = x + r() * w, py = y + r() * h, a = (r() - 0.5) * 0.9 + (r() < 0.5 ? 0 : Math.PI / 2), len = (o.lenMin ?? 10) + ((o.lenMax ?? 60) - (o.lenMin ?? 10)) * r();
    c.globalAlpha = (o.alpha ?? 0.4) * r();
    c.beginPath(); c.moveTo(px, py); c.lineTo(px + Math.cos(a) * len, py + Math.sin(a) * len); c.stroke();
  }
  c.restore();
}

export const STENCIL_FONT = '"Arial Black", "Avenir Next Condensed", Impact, "Helvetica Neue", sans-serif';

export interface TextOpts { size: number; color: string; font?: string; align?: CanvasTextAlign; wear?: number; seed?: number; letterSpacing?: number; weight?: number | string; baseline?: CanvasTextBaseline; italic?: boolean }
const wearCache = new Map<string, HTMLCanvasElement>();
/**
 * Tileable WEAR MASK: opaque where paint is eaten, transparent elsewhere. `amount` 0..1 = fraction of the area eaten
 * (roughly). Built from the fbm noise tile by thresholding its luminance (using the opaque noise tile
 * directly with destination-out fades EVERYTHING uniformly — decals fall under their alphaTest and vanish).
 */
export function wearMask(seed = 11, amount = 0.3, size = 256, octaves = 5): HTMLCanvasElement {
  const key = `${seed}:${amount.toFixed(3)}:${size}:${octaves}`;
  const hit = wearCache.get(key);
  if (hit) return hit;
  const src = noiseTile(size, seed, octaves, 0.62);
  const d = src.getContext("2d")!.getImageData(0, 0, size, size).data;
  // threshold at the (1 - amount) quantile of the tile
  const hist = new Uint32Array(256);
  for (let i = 0; i < size * size; i++) hist[d[i * 4]]++;
  let acc = 0, thr = 255;
  const target = size * size * (1 - Math.max(0, Math.min(1, amount)));
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) { thr = v; break; } }
  const [el, c] = canvas(size, size);
  const img = c.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const a = Math.max(0, Math.min(1, (d[i * 4] - thr) / 6 + 0.5));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 0; img.data[i * 4 + 3] = Math.round(a * 255);
  }
  c.putImageData(img, 0, 0);
  wearCache.set(key, el);
  return el;
}

/** eat holes into whatever is already drawn inside (x, y, w, h): big chips + fine speckle (destination-out) */
export function wearOut(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, amount: number, seed = 11, scale = 0.5) {
  if (amount <= 0) return;
  c.save();
  c.globalCompositeOperation = "destination-out";
  const big = c.createPattern(wearMask(seed, amount * 0.32), "repeat")!;
  big.setTransform(new DOMMatrix().translate(x, y).rotate(17).scale(scale));
  c.fillStyle = big; c.fillRect(x, y, w, h);
  const fine = c.createPattern(wearMask(seed + 7, amount * 0.22, 256, 3), "repeat")!;
  fine.setTransform(new DOMMatrix().translate(x + 37, y + 91).rotate(-31).scale(scale * 0.33));
  c.fillStyle = fine; c.fillRect(x, y, w, h);
  c.restore();
}

/** heavy stencil text with optional wear (chips + speckle eaten out of the letters; the rest stays fully opaque) */
export function stencilText(c: CanvasRenderingContext2D, text: string, x: number, y: number, o: TextOpts) {
  c.save();
  c.font = `${o.italic ? "italic " : ""}${o.weight ?? 900} ${o.size}px ${o.font ?? STENCIL_FONT}`;
  c.textAlign = o.align ?? "left"; c.textBaseline = o.baseline ?? "alphabetic";
  (c as unknown as { letterSpacing: string }).letterSpacing = `${o.letterSpacing ?? Math.round(o.size * 0.04)}px`;
  c.fillStyle = o.color;
  if (o.wear && o.wear > 0) {
    // draw text into a scratch canvas, eat holes with a thresholded wear mask, then composite
    const m = c.measureText(text);
    const w = Math.ceil(m.width + o.size * 0.6), h = Math.ceil(o.size * 1.5);
    const [el, s] = canvas(w, h);
    s.font = c.font; s.textAlign = "left"; s.textBaseline = "alphabetic";
    (s as unknown as { letterSpacing: string }).letterSpacing = (c as unknown as { letterSpacing: string }).letterSpacing;
    s.fillStyle = o.color; s.fillText(text, o.size * 0.3, o.size * 1.05);
    // chip size scales gently with the type size (big chips ate whole letter bowls: 'BANANA' read 'IAIANA')
    wearOut(s, 0, 0, w, h, o.wear, o.seed ?? 11, Math.max(0.3, o.size / 560));
    let dx = x - o.size * 0.3;
    if ((o.align ?? "left") === "center") dx -= m.width / 2; else if (o.align === "right") dx -= m.width;
    c.drawImage(el, dx, y - o.size * 1.05);
  } else c.fillText(text, x, y);
  c.restore();
}

/**
 * Banana crescent (the BANANA CO. logo shape): a thick circular arc (~120°) whose width swells in the middle and
 * tapers to both ends, a short stem at the start end, a blunt tip at the other. Centred at (cx, cy); `len` = chord
 * stem→tip in px; `rot` rotates; the crescent bulges DOWN (a smile) before rotation. Outer contour only (fill it).
 */
export function bananaPath(c: CanvasRenderingContext2D, cx: number, cy: number, len: number, rot: number) {
  const P = bananaOutline(len);
  c.save(); c.translate(cx, cy); c.rotate(rot);
  c.beginPath();
  P.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
  c.restore();
}

const SPAN = THREE.MathUtils.degToRad(122);
/** crescent geometry helpers (px, before translate/rotate): centre of curvature, radius, width at t∈[0,1] */
function crescent(len: number) {
  const R = len / (2 * Math.sin(SPAN / 2));
  const sag = R * (1 - Math.cos(SPAN / 2));                 // depth of the arc below the chord
  const oy = -R + sag * 0.5;                                  // centre of curvature above so the arc is centred on 0
  const wMax = len * 0.2;
  const width = (t: number) => wMax * Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t))), 0.62) * (t < 0.5 ? 0.9 + 0.1 * t * 2 : 1);
  const at = (t: number, off: number): [number, number] => {
    const a = Math.PI / 2 + SPAN / 2 - SPAN * t;             // from the stem (left) to the tip (right) along the bottom
    return [Math.cos(a) * (R + off), oy + Math.sin(a) * (R + off)];
  };
  return { R, oy, width, at };
}
function bananaOutline(len: number): Array<[number, number]> {
  const { width, at } = crescent(len);
  const n = 40, out: Array<[number, number]> = [];
  const t0 = 0.035, t1 = 0.985;
  for (let i = 0; i <= n; i++) { const t = t0 + (t1 - t0) * (i / n); out.push(at(t, width(t) * 0.55)); }       // outer (lower) edge
  // blunt tip cap
  const tipA = at(t1, width(t1) * 0.55), tipB = at(t1, -width(t1) * 0.45);
  out.push([tipA[0] + len * 0.012, tipA[1]], [tipB[0] + len * 0.012, tipB[1]]);
  for (let i = n; i >= 0; i--) { const t = t0 + (t1 - t0) * (i / n); out.push(at(t, -width(t) * 0.45)); }    // inner (upper) edge
  // stem: a short tapered stalk continuing past the start, bent upward
  const s0 = at(t0, -width(t0) * 0.45), s1 = at(t0, width(t0) * 0.55);
  const dx = -len * 0.07, dy = -len * 0.045;
  out.push([s0[0] + dx, s0[1] + dy], [s0[0] + dx - len * 0.012, s0[1] + dy + len * 0.03], [s1[0] + dx * 0.4, s1[1] + dy * 0.2]);
  return out;
}

export interface BananaOpts {
  color: string;
  /** darker stem + blunt tip colour (drawn inside the silhouette) */
  tip?: string;
  alpha?: number; wear?: number; seed?: number;
  /** dark outline colour (stroked 2.4 % of len) */
  outline?: string;
  /** light highlight band along the outer curve */
  highlight?: string;
  /** thin ridge line along the fruit (logo detail) */
  ridge?: string;
  /** shade band along the inner curve */
  shade?: string;
}
/** the BANANA CO. banana: filled crescent + optional shade / highlight / ridge / tip / outline, optional wear */
export function drawBanana(c: CanvasRenderingContext2D, cx: number, cy: number, len: number, rot: number, o: BananaOpts) {
  if (o.wear) {
    // worn: paint on a scratch canvas, eat chips out of the banana only, composite
    const S = Math.ceil(len * 1.3), [el, sc] = canvas(S, S);
    drawBanana(sc, S / 2, S / 2, len, rot, { ...o, wear: 0, alpha: 1 });
    wearOut(sc, 0, 0, S, S, o.wear, o.seed ?? 21, Math.max(0.35, len / 500));
    c.save(); c.globalAlpha = o.alpha ?? 1; c.drawImage(el, cx - S / 2, cy - S / 2); c.restore();
    return;
  }
  const { width, at } = crescent(len);
  const band = (a: number, b: number, t0: number, t1: number): Path2D => {
    const p = new Path2D(), n = 30;
    for (let i = 0; i <= n; i++) { const t = t0 + (t1 - t0) * (i / n), q = at(t, width(t) * a); i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1]); }
    for (let i = n; i >= 0; i--) { const t = t0 + (t1 - t0) * (i / n), q = at(t, width(t) * b); p.lineTo(q[0], q[1]); }
    p.closePath();
    return p;
  };
  c.save(); c.globalAlpha = o.alpha ?? 1;
  bananaPath(c, cx, cy, len, rot);
  c.fillStyle = o.color; c.fill();
  c.save();
  bananaPath(c, cx, cy, len, rot); c.clip();
  c.translate(cx, cy); c.rotate(rot);
  if (o.shade) { c.fillStyle = o.shade; c.fill(band(-0.45, -0.12, 0.08, 0.93)); }
  if (o.highlight) { c.fillStyle = o.highlight; c.fill(band(0.14, 0.34, 0.14, 0.84)); }
  if (o.ridge) { c.strokeStyle = o.ridge; c.lineWidth = Math.max(1, len * 0.012); c.lineCap = "round"; const p = new Path2D(); for (let i = 0; i <= 30; i++) { const t = 0.1 + 0.8 * (i / 30), q = at(t, width(t) * 0.02); i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1]); } c.stroke(p); }
  if (o.tip) {
    c.fillStyle = o.tip;
    // stem (everything before t≈0.06) + the blunt tip cap
    const st = at(0.035, 0), tp = at(0.985, 0);
    c.beginPath(); c.ellipse(st[0] - len * 0.045, st[1] - len * 0.03, len * 0.075, len * 0.05, -0.6, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(tp[0] + len * 0.008, tp[1], len * 0.028, len * 0.04, 0.35, 0, Math.PI * 2); c.fill();
  }
  c.restore();
  if (o.outline) { bananaPath(c, cx, cy, len, rot); c.lineWidth = Math.max(1.5, len * 0.024); c.lineJoin = "round"; c.strokeStyle = o.outline; c.stroke(); }
  c.restore();
}

/** diagonal or straight hazard stripes */
export function hazardStripes(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  o: { period: number; colors: [string, string]; angle?: number }) {
  c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
  c.fillStyle = o.colors[1]; c.fillRect(x, y, w, h);
  c.fillStyle = o.colors[0];
  const a = o.angle ?? 0;
  c.translate(x + w / 2, y + h / 2); c.rotate(a);
  const L = Math.hypot(w, h);
  for (let s = -L; s < L; s += o.period * 2) c.fillRect(s, -L, o.period, 2 * L);
  c.restore();
}

/** normal map (OpenGL / three.js convention) from a greyscale height canvas; strength in "pixels of slope" */
export function normalFromHeight(src: HTMLCanvasElement, strength = 2, wrap = true): HTMLCanvasElement {
  const w = src.width, h = src.height;
  const sc = src.getContext("2d")!;
  const id = sc.getImageData(0, 0, w, h).data;
  const H = (x: number, y: number) => {
    if (wrap) { x = (x + w) % w; y = (y + h) % h; } else { x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y)); }
    return id[(y * w + x) * 4] / 255;
  };
  const [el, c] = canvas(w, h);
  const out = c.createImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength, dy = (H(x, y + 1) - H(x, y - 1)) * strength;
    let nx = -dx, ny = dy, nz = 1;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * w + x) * 4;
    out.data[i] = Math.round(128 + nx * 127); out.data[i + 1] = Math.round(128 + ny * 127); out.data[i + 2] = Math.round(128 + nz * 127); out.data[i + 3] = 255;
  }
  c.putImageData(out, 0, 0);
  return el;
}

export interface TexOpts { srgb?: boolean; repeat?: boolean; aniso?: number; flipY?: boolean; mipmaps?: boolean }
/** wrap a canvas as a texture. Colour canvases are sRGB; data (normal/roughness) pass { srgb: false } */
export function tex(el: HTMLCanvasElement, o: TexOpts = {}): THREE.CanvasTexture {
  el = capped(el);
  const t = new THREE.CanvasTexture(el);
  t.colorSpace = (o.srgb ?? true) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (o.repeat ?? true) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  else t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = o.aniso ?? 8;
  t.flipY = o.flipY ?? true;
  t.generateMipmaps = o.mipmaps ?? true;
  t.minFilter = (o.mipmaps ?? true) ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** darken/lighten a hex colour (f > 1 lighter) */
export function shade(hex: string, f: number): string {
  const c = new THREE.Color(hex);
  c.r = Math.min(1, c.r * f); c.g = Math.min(1, c.g * f); c.b = Math.min(1, c.b * f);
  return "#" + c.getHexString();
}
export function rgba(hex: string, a: number): string {
  const c = new THREE.Color(hex);
  return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
}

/**
 * The BANANA CO. logo banana as a FRUIT (not a symmetric crescent): a bowed body that is fattest just past its middle,
 * a blunt dark tip on the left, a narrowing neck and a squared olive stem angled up on the right. `len` = tip → stem end
 * (px); `rot` rotates about the centre (negative = the stem end rises). Draws fill, belly shade, top highlight, two
 * ridge lines, tip + stem colours and an outline.
 */
export function drawFruitBanana(c: CanvasRenderingContext2D, cx: number, cy: number, len: number, rot: number, o: { color: string; shade?: string; highlight?: string; ridge?: string; tip?: string; stem?: string; outline?: string; alpha?: number; flat?: boolean }) {
  const L = len;
  // spine (quadratic, bows downward = a smile) from the tip (t=0) to the neck (t=1), then a straight stem
  const T: [number, number] = [-0.5 * L, -0.02 * L], C: [number, number] = [-0.04 * L, 0.3 * L], S: [number, number] = [0.38 * L, -0.1 * L];
  const sp = (t: number): [number, number] => { const u = 1 - t; return [u * u * T[0] + 2 * u * t * C[0] + t * t * S[0], u * u * T[1] + 2 * u * t * C[1] + t * t * S[1]]; };
  const tg = (t: number): [number, number] => { const dx = 2 * (1 - t) * (C[0] - T[0]) + 2 * t * (S[0] - C[0]), dy = 2 * (1 - t) * (C[1] - T[1]) + 2 * t * (S[1] - C[1]); const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
  const w = (t: number) => L * 0.215 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 0.93 + 0.035)), 0.62) * (0.78 + 0.3 * t) * (t > 0.86 ? 1 - (t - 0.86) * 3.2 : 1);
  const edge = (t: number, k: number): [number, number] => { const p = sp(t), d = tg(t), n: [number, number] = [-d[1], d[0]]; return [p[0] + n[0] * w(t) * k, p[1] + n[1] * w(t) * k]; };
  const N = 48;
  const outline = new Path2D();
  // lower (outer, n points down-ish for a smile) edge tip → neck, then the upper edge back
  for (let i = 0; i <= N; i++) { const q = edge(i / N, 0.5); i ? outline.lineTo(q[0], q[1]) : outline.moveTo(q[0], q[1]); }
  for (let i = N; i >= 0; i--) { const q = edge(i / N, -0.5); outline.lineTo(q[0], q[1]); }
  outline.closePath();
  // stem: a squared stalk leaving the neck, angled up
  const nk = sp(1), dn = tg(1), up: [number, number] = [dn[0] * 0.8 + 0.2 * 0.6, dn[1] * 0.8 - 0.6 * 0.6];
  const ul = Math.hypot(up[0], up[1]); up[0] /= ul; up[1] /= ul;
  const sw = L * 0.052, sl = L * 0.13, pn: [number, number] = [-up[1], up[0]];
  const stem = new Path2D();
  stem.moveTo(nk[0] + pn[0] * sw * 1.3 - up[0] * sl * 0.15, nk[1] + pn[1] * sw * 1.3 - up[1] * sl * 0.15);
  stem.lineTo(nk[0] + up[0] * sl + pn[0] * sw * 0.8, nk[1] + up[1] * sl + pn[1] * sw * 0.8);
  stem.lineTo(nk[0] + up[0] * sl - pn[0] * sw * 0.8, nk[1] + up[1] * sl - pn[1] * sw * 0.8);
  stem.lineTo(nk[0] - pn[0] * sw * 1.3 - up[0] * sl * 0.15, nk[1] - pn[1] * sw * 1.3 - up[1] * sl * 0.15);
  stem.closePath();
  c.save();
  c.globalAlpha = o.alpha ?? 1;
  c.translate(cx, cy); c.rotate(rot);
  c.fillStyle = o.stem ?? o.color; c.fill(stem);
  c.fillStyle = o.color; c.fill(outline);
  if (!o.flat) {
    c.save(); c.clip(outline);
    const band = (k0: number, k1: number, t0: number, t1: number) => { const p = new Path2D(); for (let i = 0; i <= N; i++) { const t = t0 + (t1 - t0) * (i / N), q = edge(t, k0); i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1]); } for (let i = N; i >= 0; i--) { const t = t0 + (t1 - t0) * (i / N), q = edge(t, k1); p.lineTo(q[0], q[1]); } p.closePath(); return p; };
    if (o.shade) { c.fillStyle = o.shade; c.fill(band(0.5, 0.12, 0, 1)); }
    if (o.highlight) { c.fillStyle = o.highlight; c.fill(band(-0.36, -0.16, 0.12, 0.8)); }
    if (o.ridge) {
      c.strokeStyle = o.ridge; c.lineWidth = Math.max(1, L * 0.011); c.lineCap = "round";
      for (const k of [0.05, 0.3]) { const p = new Path2D(); for (let i = 0; i <= N; i++) { const t = 0.08 + 0.84 * (i / N), q = edge(t, k); i ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1]); } c.stroke(p); }
    }
    if (o.tip) { const q = sp(0.015), d = tg(0.015); c.fillStyle = o.tip; c.beginPath(); c.ellipse(q[0] + d[0] * L * 0.012, q[1] + d[1] * L * 0.012, L * 0.035, L * 0.03, Math.atan2(d[1], d[0]), 0, Math.PI * 2); c.fill(); }
    c.restore();
    if (o.stem) { c.fillStyle = "rgba(0,0,0,0.35)"; c.beginPath(); c.ellipse(nk[0] + up[0] * sl, nk[1] + up[1] * sl, sw * 0.85, sw * 0.4, Math.atan2(pn[1], pn[0]), 0, Math.PI * 2); c.fill(); }
  }
  if (o.outline) { c.lineJoin = "round"; c.lineWidth = Math.max(1.5, L * 0.02); c.strokeStyle = o.outline; c.stroke(outline); c.stroke(stem); }
  c.restore();
}

/** a hand of fruit bananas (the wreck's white logo): n fruits NESTED in parallel — each a smile-curved
 *  banana, stacked a fifth of a length apart with a slight fan, stems gathered into one crown on the right; drawn back
 *  to front so the outlines separate the fingers. `len` = one fruit, tip → stem. */
export function drawBananaBunch(c: CanvasRenderingContext2D, cx: number, cy: number, len: number, rot: number, o: { color: string; shade?: string; outline?: string; stem?: string; n?: number }) {
  const n = o.n ?? 3;
  c.save(); c.translate(cx, cy); c.rotate(rot);
  for (let i = 0; i < n; i++) {
    const f = n === 1 ? 0 : i / (n - 1) - 0.5;               // −0.5 = the top (back) fruit … +0.5 = the front one
    const k = 1 - Math.abs(f) * 0.1;
    drawFruitBanana(c, -len * 0.02 * Math.abs(f), f * len * 0.4, len * k, -0.08 + f * 0.22, { color: o.color, shade: o.shade, outline: o.outline, stem: o.stem });
  }
  // the crown: a knot where the stems join (right)
  c.fillStyle = o.stem ?? o.color; c.beginPath(); c.ellipse(len * 0.47, -len * 0.08, len * 0.07, len * 0.1, 0.3, 0, Math.PI * 2); c.fill();
  if (o.outline) { c.lineWidth = Math.max(1.5, len * 0.02); c.strokeStyle = o.outline; c.stroke(); }
  c.restore();
}

/** a worker-painted bitmap downscaled to poicap; the original is closed */
export async function cappedBitmap(bm: ImageBitmap): Promise<ImageBitmap> {
  const c = capped(bm);
  if (c === bm) return bm;
  const out = await createImageBitmap(c, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  bm.close();
  return out;
}
