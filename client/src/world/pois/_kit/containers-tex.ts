// poi-harbor kit — container textures, painted in code.
//
// ONE shared 2048² atlas for every container colour (was: one 2048² atlas per colour = 5 × 21 MB):
//   map        RGB = paint DETAIL. Painted steel is near-white (the colour comes from the per-instance tint), rust,
//              dust, rubber, castings, floor boards… are painted in their real colours.
//   roughMask  R = TINT MASK (1 = painted steel → multiplied by the instance colour, 0 = keep the painted RGB),
//              G = roughness (three.js reads .g). NoColorSpace, 1024².
// A decal STAMP atlas (2048×1024) carries "BANANA CO." + the banana logos; the container shader stamps them onto the
// side walls from a per-instance decal id (containers.ts), so decals cost no extra draws and follow the LOD box.
// Regions are in canvas pixels (y down). containers-geo.ts maps geometry into them.
import * as THREE from "three";
import type { ContainerColor } from "../../../../../shared/pois/harbor-kit";
import { workerPool } from "../../../engine/worker-pool";
import { capped } from "../../../engine/tex-cap";
import { canvas, drawBanana, drawBananaBunch, drawFruitBanana, edgeShade, noiseTile, normalFromHeight, paintNoise, rng, scratches, splotches, stencilText, tex, cappedBitmap } from "./harbor-paint";

export interface Region { x: number; y: number; w: number; h: number }

/** the trapezoid corrugation profile, as fractions of one period: crest [0, C1], flank down to the valley at F1, valley
 *  to V1, flank back up to 1 (narrow period, deep, 16 % flanks = crisp ribs; the geometry, this
 *  atlas and the container shader — cavity shading, crest highlights, decal fix-up — all read these numbers) */
export const PROFILE = { C1: 0.32, F1: 0.48, V1: 0.84 } as const;
/** corrugation periods along a 40 ft side (the 20 ft box: half) — 0.237 m ribs */
export const SIDE_PERIODS = 50;

export const ATLAS = {
  size: 2048,
  sideA: { x: 0, y: 0, w: 2048, h: 440 } as Region,
  sideB: { x: 0, y: 440, w: 2048, h: 440 } as Region,
  roof: { x: 0, y: 880, w: 2048, h: 410 } as Region,
  endF: { x: 0, y: 1290, w: 410, h: 440 } as Region,
  endD: { x: 420, y: 1290, w: 410, h: 440 } as Region,
  post: { x: 840, y: 1290, w: 60, h: 440 } as Region,
  railTop: { x: 910, y: 1290, w: 1130, h: 70 } as Region,
  railBot: { x: 910, y: 1370, w: 1130, h: 100 } as Region,
  casting: { x: 910, y: 1480, w: 100, h: 100 } as Region,
  hardware: { x: 1020, y: 1480, w: 100, h: 100 } as Region,
  cross: { x: 1130, y: 1480, w: 100, h: 100 } as Region,
  /** inner face of the door leaves (painted, gasket border) */
  doorIn: { x: 1240, y: 1480, w: 410, h: 245 } as Region,
  /** container interior walls/ceiling seen through open doors (dim, painted) */
  inside: { x: 1660, y: 1480, w: 380, h: 245 } as Region,
  /** banana cartons stacked inside open containers (kraft brown, printed band) */
  carton: { x: 910, y: 1590, w: 320, h: 130 } as Region,
  floor: { x: 0, y: 1730, w: 1024, h: 318 } as Region,
  under: { x: 1024, y: 1730, w: 1024, h: 318 } as Region,
};

export interface Scheme { base: string; text: string; logo: string; rail: string }
/** base = the (sRGB) paint colour the tint reproduces on lit steel; text/logo = decal colours */
export const SCHEMES: Record<ContainerColor, Scheme> = {
  // yellow: a lemon-shifted, bright paint (target lit ≈ #e3a51c S 0.82–0.91, shade ≈ #9a6512; a plain ripe yellow
  // renders lit #9c6e29 H 36 S 0.74, mustard cardboard: the sun + ACES bleach it, and the
  // fill + tone curve + grade pull a yellow ~10° toward orange) + lighter weathering; the shader keeps the sky sheen off
  yellow: { base: "#f2ca00", text: "#3e3514", logo: "#3e3514", rail: "#d9a010" },
  green: { base: "#3d8a3a", text: "#f3cf3a", logo: "#f3cf3a", rail: "#2f6f2d" },
  red: { base: "#c4452b", text: "#f3cf3a", logo: "#f3cf3a", rail: "#9a3521" },
  blue: { base: "#2d5e9e", text: "#f3cf3a", logo: "#f3cf3a", rail: "#224a7d" },
  teal: { base: "#2f8f86", text: "#f3cf3a", logo: "#f3cf3a", rail: "#25716a" },
  /** refrigerated boxes (the reefer row): off-white, dark-blue print */
  white: { base: "#e4e2da", text: "#1f3f78", logo: "#1f3f78", rail: "#bdbab0" },
};

/** the stencil font stack (condensed heavy sans; falls back cleanly off macOS) */
export const CONTAINER_FONT = '"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", Impact, sans-serif';

// ------------------------------------------------------------------------------------------------ painters
/** a paint pass that writes the same shape into the colour canvas and the tint-mask canvas */
interface Pair { c: CanvasRenderingContext2D; m: CanvasRenderingContext2D }

/** vertical corrugation: AO at the valley folds, lit ridge edge (the geometry's flat facets do the rest) */
function folds(c: CanvasRenderingContext2D, r: Region, periods: number, strength = 1, vertical = true) {
  const P = (vertical ? r.w : r.h) / periods;
  c.save();
  for (let i = 0; i < periods; i++) {
    const s = (vertical ? r.x : r.y) + i * P;
    const line = (at: number, wpx: number, col: string) => {
      c.fillStyle = col;
      if (vertical) c.fillRect(s + at * P - wpx / 2, r.y, wpx, r.h); else c.fillRect(r.x, s + at * P - wpx / 2, r.w, wpx);
    };
    // valley slightly darker (AO), fold lines crisp
    const { C1, F1, V1 } = PROFILE;
    c.fillStyle = `rgba(0,0,0,${0.05 * strength})`;
    if (vertical) c.fillRect(s + F1 * P, r.y, (V1 - F1) * P, r.h); else c.fillRect(r.x, s + F1 * P, r.w, (V1 - F1) * P);
    line(F1, 1.6, `rgba(0,0,0,${0.22 * strength})`);
    line(V1, 1.6, `rgba(0,0,0,${0.16 * strength})`);
    line(C1, 1.2, `rgba(255,255,255,${0.35 * strength})`);
    line(0.0, 1.2, `rgba(255,255,255,${0.2 * strength})`);
  }
  c.restore();
}

/** rust runs: dark core + orange halo from `y0` downward (both canvases: mask goes to 0 where the rust is) */
function rustRuns(p: Pair, r: Region, n: number, seed: number, o: { lenMin: number; lenMax: number; width: number; alpha?: number; fromY?: number }) {
  const R = rng(seed);
  for (let i = 0; i < n; i++) {
    const x = r.x + R() * r.w, y0 = o.fromY ?? r.y, len = o.lenMin + (o.lenMax - o.lenMin) * R() ** 1.7, w = o.width * (0.5 + R());
    const a = (o.alpha ?? 0.8) * (0.5 + 0.5 * R());
    for (const [ctx, col, k] of [[p.c, "rgba(122,62,26,1)", 1], [p.m, "rgba(0,0,0,1)", 0.85]] as Array<[CanvasRenderingContext2D, string, number]>) {
      const g = ctx.createLinearGradient(0, y0, 0, y0 + len);
      g.addColorStop(0, col); g.addColorStop(0.25, col); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.save(); ctx.globalAlpha = a * k; ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(x - w / 2, y0); ctx.lineTo(x + w / 2, y0);
      ctx.quadraticCurveTo(x + w * 0.3, y0 + len * 0.6, x + (R() - 0.5) * w, y0 + len); ctx.quadraticCurveTo(x - w * 0.3, y0 + len * 0.6, x - w / 2, y0);
      ctx.fill(); ctx.restore();
    }
    // the seam crack it bleeds from (a thin horizontal line, not a round chip)
    for (const [ctx, col] of [[p.c, "#4a2410"], [p.m, "#000"]] as Array<[CanvasRenderingContext2D, string]>) {
      ctx.save(); ctx.globalAlpha = a * 0.9; ctx.fillStyle = col; ctx.fillRect(x - w * 0.9, y0, w * 1.8, 1.5 + R()); ctx.restore();
    }
  }
}

/** ragged rust band along an edge (bottom rail seam, corner post edges): a continuous chipped band whose depth wanders
 *  (not dots), a darker core right at the seam, and short creep streaks running away from it */
function rustEdge(p: Pair, r: Region, side: "top" | "bottom" | "left" | "right", depth: number, seed: number, alpha = 0.85) {
  const R = rng(seed);
  const horiz = side === "top" || side === "bottom";
  const along = horiz ? r.w : r.h, n = Math.max(8, Math.round(along / 6));
  // smooth random depth profile (sum of a few sines + jitter), with bare stretches where the paint is still sound
  const ph = [R() * 6.28, R() * 6.28, R() * 6.28], fq = [2 + R() * 3, 7 + R() * 6, 19 + R() * 14];
  const dAt = (t: number) => {
    const v = 0.55 + 0.3 * Math.sin(t * fq[0] + ph[0]) + 0.2 * Math.sin(t * fq[1] + ph[1]) + 0.12 * Math.sin(t * fq[2] + ph[2]);
    return Math.max(0, v - 0.25) * depth * 1.4;
  };
  const P = (t: number, d: number): [number, number] => {
    const a = t * along;
    if (side === "bottom") return [r.x + a, r.y + r.h - d];
    if (side === "top") return [r.x + a, r.y + d];
    if (side === "left") return [r.x + d, r.y + a];
    return [r.x + r.w - d, r.y + a];
  };
  const band = (k: number, col: string, ctx: CanvasRenderingContext2D, a: number) => {
    ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = col; ctx.beginPath();
    let q = P(0, 0); ctx.moveTo(q[0], q[1]);
    for (let i = 0; i <= n; i++) { const t = i / n; q = P(t, dAt(t) * k * (0.85 + R() * 0.3)); ctx.lineTo(q[0], q[1]); }
    q = P(1, 0); ctx.lineTo(q[0], q[1]); ctx.closePath(); ctx.fill(); ctx.restore();
  };
  band(1, "#9a5528", p.c, alpha * 0.8); band(1, "#000", p.m, alpha * 0.85);
  band(0.55, "#6e3417", p.c, alpha * 0.9);
  band(0.2, "#3f1e0e", p.c, alpha * 0.8);
  // creep streaks: thin runs leaving the band (downward for top edges, upward-fading for bottom seams)
  if (horiz) for (let i = 0; i < along / 26; i++) {
    const t = R(), d = dAt(t), [x, y] = P(t, d), len = depth * (0.6 + R() * 2.4) * (side === "top" ? 2.2 : 0.8), w = 1.5 + R() * 3;
    const dir = side === "top" ? 1 : -1;
    for (const [ctx, col, k] of [[p.c, "rgba(122,62,26,1)", 1], [p.m, "rgba(0,0,0,1)", 0.7]] as Array<[CanvasRenderingContext2D, string, number]>) {
      const g = ctx.createLinearGradient(0, y, 0, y + dir * len);
      g.addColorStop(0, col); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.save(); ctx.globalAlpha = alpha * 0.6 * k * (0.4 + 0.6 * R()); ctx.fillStyle = g; ctx.fillRect(x - w / 2, Math.min(y, y + dir * len), w, len); ctx.restore();
    }
  }
}

/** dust/grime rising from the bottom edge: colour goes warm grey-brown, tint fades to half; kicked-up dust in
 *  vertical wisps (no round blobs) */
function dust(p: Pair, r: Region, frac: number, alpha: number) {
  for (const [ctx, col, k] of [[p.c, "rgba(150,132,104,1)", 1], [p.m, "rgba(0,0,0,1)", 0.32]] as Array<[CanvasRenderingContext2D, string, number]>) {
    const g = ctx.createLinearGradient(0, r.y + r.h, 0, r.y + r.h * (1 - frac));
    g.addColorStop(0, col); g.addColorStop(0.35, col.replace(",1)", ",0.45)")); g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.save(); ctx.globalAlpha = alpha * k; ctx.fillStyle = g; ctx.fillRect(r.x, r.y + r.h * (1 - frac), r.w, r.h * frac); ctx.restore();
  }
  const R = rng(Math.round(r.x + r.y) + 5);
  p.c.save();
  for (let i = 0; i < r.w / 9; i++) {
    const x = r.x + R() * r.w, h = r.h * frac * (0.3 + R() * 0.9), w = 2 + R() * 7;
    const g = p.c.createLinearGradient(0, r.y + r.h, 0, r.y + r.h - h);
    g.addColorStop(0, "rgba(118,100,76,1)"); g.addColorStop(1, "rgba(118,100,76,0)");
    p.c.globalAlpha = alpha * 0.35 * R(); p.c.fillStyle = g; p.c.fillRect(x, r.y + r.h - h, w, h);
  }
  p.c.restore();
}

/** painted steel wall: near-white detail layer (tint does the colour) + weathering */
function paintWall(p: Pair, r: Region, seed: number, periods: number, o: { dust?: number; rust?: number; patches?: number } = {}) {
  const { c, m } = p;
  c.fillStyle = "#eeeeec"; c.fillRect(r.x, r.y, r.w, r.h);
  m.fillStyle = "#fff"; m.fillRect(r.x, r.y, r.w, r.h);
  paintNoise(c, r.x, r.y, r.w, r.h, { seed, scale: 1400, alpha: 0.12, blend: "overlay" });
  paintNoise(c, r.x, r.y, r.w, r.h, { seed: seed + 1, scale: 260, alpha: 0.07, blend: "overlay" });
  // touch-up / replaced panels: slightly different paint (a few rib-aligned rectangles)
  const R = rng(seed + 9), P = r.w / periods;
  for (let i = 0; i < (o.patches ?? 3); i++) {
    const i0 = Math.floor(R() * periods), n = 2 + Math.floor(R() * 7), f = 0.9 + R() * 0.16;
    const v = Math.round(238 * f);
    c.fillStyle = `rgba(${v},${v},${Math.round(v * 0.985)},0.9)`;
    c.fillRect(r.x + i0 * P, r.y + (R() < 0.5 ? 0 : r.h * R() * 0.3), n * P, r.h * (0.5 + R() * 0.5));
  }
  folds(c, r, periods, 1);
  // sun-bleach at the top
  edgeShade(c, r.x, r.y, r.w, r.h, { size: r.h * 0.3, color: "rgba(255,255,250,1)", alpha: 0.18, sides: ["top"], blend: "screen" });
  // (light dust + few rust runs — more, together with the shader's grime runs, read as cardboard / wood grain)
  dust(p, r, 0.26, (o.dust ?? 0.5) * 0.6);
  // rust runs from the top rail seam (heaviest at both ends, under the corner castings) + a couple of weld spots
  rustRuns(p, r, Math.round(8 * (o.rust ?? 1)), seed + 3, { lenMin: r.h * 0.08, lenMax: r.h * 0.45, width: 2.6, alpha: 0.55 });
  for (const end of [0, 1]) rustRuns(p, { x: r.x + (end ? r.w - r.w * 0.035 : 0), y: r.y, w: r.w * 0.035, h: r.h }, Math.round(2 * (o.rust ?? 1)), seed + 11 + end, { lenMin: r.h * 0.2, lenMax: r.h * 0.6, width: 6, alpha: 0.7 });
  rustRuns(p, r, Math.round(2 * (o.rust ?? 1)), seed + 4, { lenMin: r.h * 0.08, lenMax: r.h * 0.25, width: 3, alpha: 0.5, fromY: r.y + r.h * 0.45 });
  rustEdge(p, r, "bottom", 10, seed + 5);
  rustEdge(p, r, "top", 5, seed + 6, 0.6);
  // handling scrapes (primer / bare steel showing through) concentrated where things actually hit a box: near the
  // corner posts (spreader + twist-lock knocks), along the bottom (forklift tines, chassis) and under the top rail
  const S = rng(seed + 7);
  const scrape = (x: number, y: number, len: number, a: number, wdt: number, al: number) => {
    for (const [ctx, col, k] of [[c, "rgba(146,140,130,1)", 0.6], [m, "rgba(0,0,0,1)", 0.65]] as Array<[CanvasRenderingContext2D, string, number]>) {
      ctx.save(); ctx.globalAlpha = al * k; ctx.strokeStyle = col; ctx.lineWidth = wdt; ctx.lineCap = "butt";
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); ctx.stroke(); ctx.restore();
    }
    // a dark rust core in the deeper scrapes
    if (wdt > 2.2) { c.save(); c.globalAlpha = al * 0.55; c.strokeStyle = "#6a3418"; c.lineWidth = wdt * 0.35; c.beginPath(); c.moveTo(x + Math.cos(a) * len * 0.2, y + Math.sin(a) * len * 0.2); c.lineTo(x + Math.cos(a) * len * 0.75, y + Math.sin(a) * len * 0.75); c.stroke(); c.restore(); }
  };
  for (let i = 0; i < 26; i++) {
    const end = S() < 0.5, zone = S();
    let x: number, y: number;
    if (zone < 0.45) { x = end ? r.x + S() * r.w * 0.1 : r.x + r.w * (0.9 + S() * 0.1); y = r.y + r.h * (0.05 + S() * 0.9); }        // by the posts
    else if (zone < 0.8) { x = r.x + S() * r.w; y = r.y + r.h * (0.78 + S() * 0.2); }                                                // along the bottom
    else { x = r.x + S() * r.w; y = r.y + r.h * (0.02 + S() * 0.1); }                                                                // under the top rail
    scrape(x, y, 12 + S() * 70, (S() - 0.5) * 0.35 + (S() < 0.15 ? Math.PI / 2 : 0), 1.2 + S() * 2.8, 0.45 + 0.5 * S());
  }
  scratches(c, r.x, r.y, r.w, r.h, { n: 70, color: "rgba(255,255,255,1)", alpha: 0.2, seed: seed + 8, lenMin: 6, lenMax: 40, width: 1 });
  scratches(c, r.x, r.y, r.w, r.h, { n: 40, color: "rgba(40,30,20,1)", alpha: 0.22, seed: seed + 10, lenMin: 5, lenMax: 26, width: 1 });
}

function paintRail(p: Pair, r: Region, seed: number, pockets: boolean) {
  const { c, m } = p;
  c.fillStyle = "#d2d2d0"; c.fillRect(r.x, r.y, r.w, r.h);
  m.fillStyle = "#fff"; m.fillRect(r.x, r.y, r.w, r.h);
  paintNoise(c, r.x, r.y, r.w, r.h, { seed, scale: 300, alpha: 0.2, blend: "overlay" });
  edgeShade(c, r.x, r.y, r.w, r.h, { size: r.h * 0.5, color: "rgba(0,0,0,1)", alpha: 0.25, sides: ["bottom"], blend: "multiply" });
  edgeShade(c, r.x, r.y, r.w, r.h, { size: r.h * 0.35, color: "rgba(255,255,255,1)", alpha: 0.3, sides: ["top"], blend: "screen" });
  rustEdge(p, r, "bottom", r.h * 0.25, seed + 1);
  rustEdge(p, r, "top", r.h * 0.15, seed + 2, 0.6);
  // tine / twist-lock nicks along the rail: short dark rusty chips (light-grey bare-metal dashes read as UI
  // lines on every top rail)
  const R = rng(seed + 3);
  for (let i = 0; i < 9; i++) {
    const x = r.x + R() * r.w, y = r.y + r.h * (0.25 + R() * 0.5), w = 4 + R() * 18, h = 1 + R() * 2;
    c.save(); c.globalAlpha = 0.55 + R() * 0.3; c.fillStyle = R() < 0.5 ? "#6a3a1c" : "#4d2a14"; c.fillRect(x, y, w, h); c.restore();
    m.save(); m.globalAlpha = 0.7; m.fillStyle = "#000"; m.fillRect(x, y, w, h); m.restore();
  }
  if (pockets) { // fork pockets: dark openings with a lit lip
    for (const fx of [0.36, 0.62]) {
      const x = r.x + r.w * fx - 34, y = r.y + r.h * 0.28, w = 68, h = r.h * 0.46;
      c.fillStyle = "#141311"; c.fillRect(x, y, w, h); m.fillStyle = "#000"; m.fillRect(x, y, w, h);
      c.fillStyle = "rgba(255,255,255,0.35)"; c.fillRect(x, y - 2, w, 2);
    }
  }
}

function paintPost(p: Pair, r: Region, seed: number) {
  const { c, m } = p;
  c.fillStyle = "#d6d6d4"; c.fillRect(r.x, r.y, r.w, r.h);
  m.fillStyle = "#fff"; m.fillRect(r.x, r.y, r.w, r.h);
  paintNoise(c, r.x, r.y, r.w, r.h, { seed, scale: 200, alpha: 0.25, blend: "overlay" });
  edgeShade(c, r.x, r.y, r.w, r.h, { size: r.w * 0.35, color: "rgba(0,0,0,1)", alpha: 0.25, sides: ["left", "right"], blend: "multiply" });
  rustEdge(p, r, "bottom", r.h * 0.1, seed + 1);
  rustEdge(p, r, "left", 4, seed + 2, 0.5);
  rustEdge(p, r, "right", 4, seed + 3, 0.5);
  dust(p, r, 0.3, 0.5);
}

function paintCasting(p: Pair, r: Region) {
  const { c, m } = p;
  // corner castings are painted with the box (yellow castings with dark oval holes), chipped to bare steel on
  // the edges that take the twist-lock knocks
  c.fillStyle = "#c9c8c4"; c.fillRect(r.x, r.y, r.w, r.h); m.fillStyle = "#fff"; m.fillRect(r.x, r.y, r.w, r.h);
  paintNoise(c, r.x, r.y, r.w, r.h, { seed: 9, scale: 100, alpha: 0.3, blend: "overlay" });
  edgeShade(c, r.x, r.y, r.w, r.h, { size: 12, color: "rgba(255,255,255,1)", alpha: 0.35, sides: ["top", "left"], blend: "screen" });
  edgeShade(c, r.x, r.y, r.w, r.h, { size: 14, color: "rgba(0,0,0,1)", alpha: 0.3, sides: ["bottom", "right"], blend: "multiply" });
  for (const [ctx, col] of [[c, "#0b0a09"], [m, "#000"]] as Array<[CanvasRenderingContext2D, string]>) { ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w * 0.3, r.h * 0.19, 0, 0, Math.PI * 2); ctx.fill(); }
  c.strokeStyle = "rgba(255,255,255,0.35)"; c.lineWidth = 2; c.beginPath(); c.ellipse(r.x + r.w / 2, r.y + r.h / 2 + 1.5, r.w * 0.3, r.h * 0.19, 0, 0.2, Math.PI - 0.2); c.stroke();
  const R = rng(10);
  for (let i = 0; i < 7; i++) {
    const edge = Math.floor(R() * 4), t = R(), l = 6 + R() * 16, x = edge < 2 ? r.x + t * r.w : edge === 2 ? r.x : r.x + r.w - 4, y = edge === 0 ? r.y : edge === 1 ? r.y + r.h - 4 : r.y + t * r.h;
    for (const [ctx, col] of [[c, "#7c7066"], [m, "#000"]] as Array<[CanvasRenderingContext2D, string]>) { ctx.fillStyle = col; ctx.fillRect(x, y, edge < 2 ? l : 4, edge < 2 ? 4 : l); }
  }
}

function paintDark(p: Pair, r: Region, color: string, seed: number) {
  p.c.fillStyle = color; p.c.fillRect(r.x, r.y, r.w, r.h); p.m.fillStyle = "#000"; p.m.fillRect(r.x, r.y, r.w, r.h);
  paintNoise(p.c, r.x, r.y, r.w, r.h, { seed, scale: 100, alpha: 0.3, blend: "overlay" });
  splotches(p.c, r.x, r.y, r.w, r.h, { n: 10, rMin: 5, rMax: 30, color: "rgba(140,70,30,1)", alpha: 0.5, seed: seed + 1, blend: "multiply" });
}

function paintDoors(p: Pair, r: Region, seed: number) {
  const { c, m } = p;
  paintWall(p, r, seed, 8, { dust: 0.55, rust: 0.4, patches: 1 });
  // gaskets: dark edges + centre seam (rubber, not tinted)
  for (const [x, y, w, h] of [[r.x + r.w / 2 - 3, r.y, 6, r.h], [r.x, r.y, r.w, 5], [r.x, r.y + r.h - 5, r.w, 5], [r.x, r.y, 5, r.h], [r.x + r.w - 5, r.y, 5, r.h]]) {
    c.fillStyle = "#151311"; c.fillRect(x, y, w, h); m.fillStyle = "#000"; m.fillRect(x, y, w, h);
  }
  // rust runs under the lock-rod brackets (both leaves)
  rustRuns(p, { x: r.x, y: r.y, w: r.w, h: r.h }, 8, seed + 20, { lenMin: 20, lenMax: 110, width: 5, alpha: 0.55, fromY: r.y + r.h * 0.18 });
  // the door HARDWARE painted in (the LOD box beyond 18 m shows only this texture — its door ends read as blank
  // panels): 4 lock rods with brackets, cam keepers top + bottom, handles, 4 hinge blocks per leaf at the outer edges,
  // the leaf split. Positions = the full model's (containers-geo doorLeaf: leaf B at s 0…0.5 from its hinge, leaf A at
  // s 0.5…1 from ITS hinge; rods at 36 % / 72 % of a leaf), so the geometry rods cover the painted ones up close.
  {
    const sOf = (leafA: boolean, f: number) => r.x + r.w * ((leafA ? 0.5 : 0) + 0.5 * f), yOf = (t: number) => r.y + r.h * (1 - t);
    const bar = (x: number, y0: number, y1: number, w: number, col: string) => { c.fillStyle = col; c.fillRect(x - w / 2, y0, w, y1 - y0); m.fillStyle = "#000"; m.fillRect(x - w / 2, y0, w, y1 - y0); };
    for (const leafA of [false, true]) {
      for (const f of [0.36, 0.72]) {
        const x = sOf(leafA, f);
        c.fillStyle = "rgba(0,0,0,0.35)"; c.fillRect(x + 3, yOf(0.98), 4, r.h * 0.96);          // the rod's shadow on the panel
        bar(x, yOf(0.985), yOf(0.015), 6, "#3a3c3f");
        c.fillStyle = "rgba(255,255,255,0.35)"; c.fillRect(x - 2, yOf(0.985), 1.5, r.h * 0.97);   // lit edge
        for (const t of [0.16, 0.5, 0.84]) bar(x, yOf(t) - 6, yOf(t) + 6, 11, "#2e3033");         // brackets
        for (const t of [0.02, 0.95]) bar(x, yOf(t) - 9, yOf(t) + 6, 13, "#2a2c2e");               // cam keepers
        // handle: a bar toward the free edge at 44 % height + its catch
        const hx0 = x, hx1 = sOf(leafA, f + 0.26 > 0.98 ? 0.98 : f + 0.26), hy = yOf(0.44);
        c.fillStyle = "#2b2d30"; c.fillRect(Math.min(hx0, hx1), hy - 3, Math.abs(hx1 - hx0), 6); m.fillStyle = "#000"; m.fillRect(Math.min(hx0, hx1), hy - 3, Math.abs(hx1 - hx0), 6);
      }
      // hinges at the hinge (outer) edge
      for (const t of [0.12, 0.4, 0.68, 0.93]) bar(sOf(leafA, 0.012), yOf(t) - 8, yOf(t) + 8, 12, "#303234");
    }
    // the leaf split (centre seam) is already a gasket; add a dark shadow line either side
    c.fillStyle = "rgba(0,0,0,0.25)"; c.fillRect(r.x + r.w * 0.5 - 8, r.y, 3, r.h); c.fillRect(r.x + r.w * 0.5 + 5, r.y, 3, r.h);
  }
  // CSC plate, customs seal plate, a sticker (not tinted)
  const plate = (x: number, y: number, w: number, h: number, col: string) => { c.fillStyle = col; c.fillRect(x, y, w, h); m.fillStyle = "#000"; m.fillRect(x, y, w, h); };
  plate(r.x + r.w * 0.6, r.y + r.h * 0.55, 46, 30, "#c9c6bd");
  c.fillStyle = "rgba(0,0,0,0.5)"; for (let i = 0; i < 4; i++) c.fillRect(r.x + r.w * 0.6 + 6, r.y + r.h * 0.55 + 6 + i * 6, 34, 2);
  plate(r.x + r.w * 0.18, r.y + r.h * 0.6, 22, 22, "#e6e0d0");
  plate(r.x + r.w * 0.62, r.y + r.h * 0.3, 30, 14, "#d8d3c6");
  // (no owner codes: the signage rule allows only BANANA CO.)
}

function paintDoorInner(p: Pair, r: Region, seed: number) {
  const { c, m } = p;
  // the inner face is the same painted sheet (tinted), a touch duller; each leaf's corrugation comes from geometry
  c.fillStyle = "#dedcd6"; c.fillRect(r.x, r.y, r.w, r.h); m.fillStyle = "#f2f2f2"; m.fillRect(r.x, r.y, r.w, r.h);
  paintNoise(c, r.x, r.y, r.w, r.h, { seed, scale: 300, alpha: 0.18, blend: "overlay" });
  for (const lx of [0, 0.5]) folds(c, { x: r.x + r.w * lx + 14, y: r.y, w: r.w / 2 - 28, h: r.h }, 4, 0.7);
  // gasket border + centre seam (rubber, not tinted)
  for (const [x, y, w, h] of [[r.x, r.y, r.w, 8], [r.x, r.y + r.h - 8, r.w, 8], [r.x, r.y, 8, r.h], [r.x + r.w - 8, r.y, 8, r.h], [r.x + r.w / 2 - 5, r.y, 10, r.h]]) {
    c.fillStyle = "#1a1917"; c.fillRect(x, y, w, h); m.fillStyle = "#000"; m.fillRect(x, y, w, h);
  }
  dust(p, r, 0.35, 0.45);
  rustEdge(p, r, "bottom", 7, seed + 2, 0.7);
  rustRuns(p, r, 5, seed + 4, { lenMin: 14, lenMax: 60, width: 3, alpha: 0.45, fromY: r.y + 10 });
}

/** cardboard banana cartons: kraft brown sides with a printed yellow band + small banana, taped lids */
function paintCarton(p: Pair, r: Region, seed: number) {
  const { c, m } = p;
  c.fillStyle = "#b8905c"; c.fillRect(r.x, r.y, r.w, r.h); m.fillStyle = "#000"; m.fillRect(r.x, r.y, r.w, r.h);
  paintNoise(c, r.x, r.y, r.w, r.h, { seed, scale: 90, alpha: 0.3, blend: "overlay" });
  c.fillStyle = "#e9b722"; c.fillRect(r.x, r.y + r.h * 0.38, r.w, r.h * 0.24);
  for (let i = 0; i < 3; i++) drawBanana(c, r.x + r.w * (0.18 + i * 0.32), r.y + r.h * 0.5, r.h * 0.34, -0.25, { color: "#fff2c0", outline: "#6b4a1a" });
  c.strokeStyle = "rgba(70,45,20,0.6)"; c.lineWidth = 3; c.strokeRect(r.x + 2, r.y + 2, r.w - 4, r.h - 4);
  c.fillStyle = "rgba(230,215,180,0.55)"; c.fillRect(r.x, r.y + 4, r.w, 7);
  scratches(c, r.x, r.y, r.w, r.h, { n: 30, color: "rgba(60,40,20,1)", alpha: 0.35, seed: seed + 1, lenMin: 4, lenMax: 20 });
}

function paintInside(p: Pair, r: Region, seed: number) {
  const { c, m } = p;
  // the open box seen through its doors (the LOD box's door plane): the body colour on the inner walls, darkening into
  // the depth, stacked cartons in the lower half
  c.fillStyle = "#b8b6b0"; c.fillRect(r.x, r.y, r.w, r.h); m.fillStyle = "#e0e0e0"; m.fillRect(r.x, r.y, r.w, r.h);
  paintNoise(c, r.x, r.y, r.w, r.h, { seed, scale: 200, alpha: 0.3, blend: "overlay" });
  folds(c, r, 10, 1);
  const g = c.createRadialGradient(r.x + r.w / 2, r.y + r.h * 0.45, 8, r.x + r.w / 2, r.y + r.h * 0.45, r.w * 0.6);
  g.addColorStop(0, "rgba(12,10,8,0.92)"); g.addColorStop(0.55, "rgba(20,16,12,0.7)"); g.addColorStop(1, "rgba(30,24,18,0.15)");
  c.fillStyle = g; c.fillRect(r.x, r.y, r.w, r.h);
  // cartons in the lower part (kraft + yellow band), not tinted
  const R = rng(seed + 5);
  for (let row = 0; row < 3; row++) for (let k = 0; k < 6; k++) {
    if (R() < 0.2) continue;
    const w = r.w / 6.4, h = r.h * 0.13, x = r.x + 6 + k * (w + 2) + (R() - 0.5) * 4, y = r.y + r.h - 8 - (row + 1) * (h + 2);
    for (const [ctx, col] of [[c, "#8a6a42"], [m, "#000"]] as Array<[CanvasRenderingContext2D, string]>) { ctx.fillStyle = col; ctx.fillRect(x, y, w, h); }
    c.fillStyle = "#b8901c"; c.fillRect(x, y + h * 0.35, w, h * 0.3); c.fillStyle = "rgba(0,0,0,0.35)"; c.fillRect(x, y + h - 2, w, 2);
  }
  splotches(c, r.x, r.y, r.w, r.h, { n: 20, rMin: 8, rMax: 40, color: "rgba(70,55,40,1)", alpha: 0.25, seed: seed + 1, blend: "multiply" });
}

function paintRoof(p: Pair, r: Region, seed: number, periods: number) {
  const { c, m } = p;
  c.fillStyle = "#e4e4e2"; c.fillRect(r.x, r.y, r.w, r.h); m.fillStyle = "#fff"; m.fillRect(r.x, r.y, r.w, r.h);
  paintNoise(c, r.x, r.y, r.w, r.h, { seed, scale: 700, alpha: 0.2, blend: "overlay" });
  folds(c, r, periods, 0.8);
  // grime pooled along the roof ribs (long thin stains following the corrugation, not round blobs), rust at the edges
  const R = rng(seed + 1);
  for (let i = 0; i < 70; i++) {
    const x = r.x + R() * r.w, y = r.y + r.h * (0.15 + R() * 0.7), w = 30 + R() * 220, h = 3 + R() * 10;
    for (const [ctx, col, a] of [[c, "rgba(92,80,62,1)", 0.22], [m, "rgba(0,0,0,1)", 0.1]] as Array<[CanvasRenderingContext2D, string, number]>) {
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(0.3, col); g.addColorStop(0.7, col); g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.save(); ctx.globalAlpha = a * (0.4 + 0.6 * R()); ctx.fillStyle = g; ctx.fillRect(x, y, w, h); ctx.restore();
    }
  }
  rustRuns(p, { x: r.x, y: r.y, w: r.w, h: r.h }, 8, seed + 3, { lenMin: 16, lenMax: 70, width: 5, alpha: 0.45, fromY: r.y + r.h * 0.3 });
  rustEdge(p, r, "top", 8, seed + 4, 0.7); rustEdge(p, r, "bottom", 8, seed + 5, 0.7);
}

function paintFloor(p: Pair, r: Region, seed: number) {
  const { c, m } = p;
  c.fillStyle = "#a88a5c"; c.fillRect(r.x, r.y, r.w, r.h); m.fillStyle = "#000"; m.fillRect(r.x, r.y, r.w, r.h);
  paintNoise(c, r.x, r.y, r.w, r.h, { seed, scale: 400, alpha: 0.35, blend: "overlay" });
  const R = rng(seed + 3);
  for (let i = 0; i < 7; i++) { const y = r.y + (r.h * i) / 7; c.fillStyle = `rgba(${150 + R() * 40},${110 + R() * 30},${70 + R() * 20},0.35)`; c.fillRect(r.x, y, r.w, r.h / 7); }
  c.fillStyle = "rgba(40,25,10,0.7)";
  for (let i = 1; i < 7; i++) c.fillRect(r.x, r.y + (r.h * i) / 7 - 1, r.w, 3);
  for (let i = 1; i < 12; i++) c.fillRect(r.x + (r.w * i) / 12 + (R() - 0.5) * 30, r.y, 3, r.h);
  splotches(c, r.x, r.y, r.w, r.h, { n: 40, rMin: 10, rMax: 80, color: "rgba(50,35,20,1)", alpha: 0.35, seed: seed + 1, blend: "multiply" });
  scratches(c, r.x, r.y, r.w, r.h, { n: 80, color: "rgba(0,0,0,1)", alpha: 0.3, seed: seed + 2, lenMin: 5, lenMax: 80 });
}

// ------------------------------------------------------------------------------------------------ atlas
let atlasCache: { map: THREE.Texture; roughMask: THREE.Texture } | null = null;
/** the shared container atlas (colour detail + roughness/tint-mask) — built once */
export function containerSharedAtlas(): { map: THREE.Texture; roughMask: THREE.Texture } {
  if (atlasCache) return atlasCache;
  const cv = ctCanvases("atlas");
  atlasCache = { map: ctTex(cv["atlas.map"], { aniso: 8 }), roughMask: ctTex(cv["atlas.rough"], { srgb: false, aniso: 4 }) };
  return atlasCache;
}
function paintAtlas(): Record<string, HTMLCanvasElement> {
  const S = ATLAS.size;
  const [el, c] = canvas(S, S);
  const [mel, m] = canvas(S, S);
  c.fillStyle = "#e8e8e6"; c.fillRect(0, 0, S, S);
  m.fillStyle = "#fff"; m.fillRect(0, 0, S, S);
  const p: Pair = { c, m };
  paintWall(p, ATLAS.sideA, 101, SIDE_PERIODS, { patches: 3 });
  paintWall(p, ATLAS.sideB, 111, SIDE_PERIODS, { rust: 1.4, patches: 4 });
  paintRoof(p, ATLAS.roof, 121, SIDE_PERIODS);
  paintWall(p, ATLAS.endF, 131, 7, { dust: 0.6, patches: 0 });
  paintDoors(p, ATLAS.endD, 141);
  paintPost(p, ATLAS.post, 151);
  paintRail(p, ATLAS.railTop, 161, false);
  paintRail(p, ATLAS.railBot, 171, true);
  paintCasting(p, ATLAS.casting);
  paintDark(p, ATLAS.hardware, "#3b3d40", 181);
  paintDark(p, ATLAS.cross, "#2a2624", 191);
  paintDoorInner(p, ATLAS.doorIn, 195);
  paintCarton(p, ATLAS.carton, 199);
  paintInside(p, ATLAS.inside, 197);
  paintFloor(p, ATLAS.floor, 201);
  paintDark(p, ATLAS.under, "#5b5046", 211);
  { const r = ATLAS.under; for (let i = 1; i < 10; i++) { c.fillStyle = "rgba(30,24,20,0.55)"; c.fillRect(r.x + (r.w * i) / 10 - 6, r.y, 12, r.h); } edgeShade(c, r.x, r.y, r.w, r.h, { size: r.h * 0.3, color: "rgba(150,90,50,1)", alpha: 0.35, sides: ["top", "bottom"], blend: "source-over" }); }
  // roughness (G) + tint mask (R) at 1024²
  const H = S / 2;
  const [rel, rc] = canvas(H, H);
  // painted steel roughness ≈ 0.66 (at 0.54 the sky sheen washes the yellow to S 0.66 vs a target of 0.82+)
  rc.fillStyle = "#a8a8a8"; rc.fillRect(0, 0, H, H);
  paintNoise(rc, 0, 0, H, H, { seed: 221, scale: 400, alpha: 0.4, blend: "overlay" });
  paintNoise(rc, 0, 0, H, H, { seed: 222, scale: 60, alpha: 0.22, blend: "overlay" });
  for (const r of [ATLAS.sideA, ATLAS.sideB, ATLAS.endF, ATLAS.endD]) edgeShade(rc, r.x / 2, r.y / 2, r.w / 2, r.h / 2, { size: r.h * 0.17, color: "#ffffff", alpha: 0.45, sides: ["bottom"], blend: "screen" });
  for (const r of [ATLAS.floor, ATLAS.under, ATLAS.cross, ATLAS.inside, ATLAS.carton]) { rc.fillStyle = "#e0e0e0"; rc.fillRect(r.x / 2, r.y / 2, r.w / 2, r.h / 2); }
  const rough = rc.getImageData(0, 0, H, H);
  const [sm, smc] = canvas(H, H);
  smc.drawImage(mel, 0, 0, H, H);
  const mask = smc.getImageData(0, 0, H, H);
  // rusty / untinted areas are rougher
  for (let i = 0; i < H * H; i++) {
    const k = mask.data[i * 4] / 255;
    rough.data[i * 4 + 1] = Math.min(255, Math.round(rough.data[i * 4 + 1] * (0.78 + 0.22 * k) + (1 - k) * 60));
    rough.data[i * 4] = mask.data[i * 4];
    rough.data[i * 4 + 2] = 0; rough.data[i * 4 + 3] = 255;
  }
  rc.putImageData(rough, 0, 0);
  void sm;
  return { "atlas.map": el, "atlas.rough": rel };
}


// ------------------------------------------------------------------------------------------------ decal stamps
/**
 * Stamp atlas 2048×1024 (sRGB, straight alpha):
 *   text   (0,0)–(2048,300): "BANANA CO." white mask (tinted per decal type)
 *   bananaMask   (0,320) 512²: banana silhouette, white mask (tinted: dark on yellow containers)
 *   bananaColor  (520,320) 512²: yellow banana logo with outline, shade, highlight, stem + tip (not tinted)
 *   bananaWhite  (1040,320) 512²: faded white banana logo with ridge line (the wreck's containers)
 */
export const STAMPS = {
  w: 2048, h: 1024,
  text: { x: 0, y: 0, w: 2048, h: 300 },
  bananaMask: { x: 0, y: 320, w: 512, h: 512 },
  bananaColor: { x: 520, y: 320, w: 512, h: 512 },
  bananaWhite: { x: 1040, y: 320, w: 512, h: 512 },
};
let stampCache: THREE.Texture | null = null;
export function decalStamps(): THREE.Texture {
  if (stampCache) return stampCache;
  const t = ctTex(ctCanvases("stamps")["stamps"], { repeat: false, aniso: 8 });
  t.premultiplyAlpha = false;
  stampCache = t;
  return t;
}
function paintStamps(): Record<string, HTMLCanvasElement> {
  const [el, c] = canvas(STAMPS.w, STAMPS.h);
  c.clearRect(0, 0, STAMPS.w, STAMPS.h);
  // "BANANA CO." fills the stamp: measure + scale to width
  const T = STAMPS.text;
  stencilText(c, "BANANA CO.", T.x + T.w / 2, T.y + 262, { size: 290, color: "#ffffff", align: "center", wear: 0.05, seed: 7, letterSpacing: 10, font: CONTAINER_FONT, weight: 800 });
  // edge wear instead of holes: a few thin horizontal scrapes through the print (brush / chassis rub), no camo blotches
  { const R = rng(71); c.save(); c.globalCompositeOperation = "destination-out"; for (let i = 0; i < 22; i++) { const y = T.y + 40 + R() * 230, x = T.x + R() * T.w, l = 30 + R() * 160; c.globalAlpha = 0.5 + R() * 0.5; c.fillRect(x, y, l, 1.5 + R() * 3); } c.restore(); }
  const B = STAMPS.bananaMask;
  // the small dark banana left of the text (a banana standing on its tip, stem up) — a fruit silhouette
  // (fattened 1.55× across its length — thinner, it reads as a "J" next to the text; it should be a chunky fruit)
  c.save(); c.translate(B.x + B.w / 2 + 6, B.y + B.h / 2 + 10); c.scale(1.55, 1);
  drawFruitBanana(c, 0, 0, 410, -1.25, { color: "#ffffff", stem: "#ffffff", flat: true });
  c.restore();
  scrapeOut(c, B.x, B.y, B.w, B.h, 40, 81);
  const C = STAMPS.bananaColor;
  // the big logo on green / red boxes: a fat ripe banana tilted ~25° (stem end up on the right), shade + highlight +
  // ridges, dark tip, olive stem, dark outline — reads as fruit (not a smile) from 150 m
  // (ripe yellow #f2c200 with a darker GOLD shade + outline — an orange shade reads #e08a30 on the boxes)
  drawFruitBanana(c, C.x + C.w / 2 + 6, C.y + C.h / 2 + 18, 452, -0.44, { color: "#f4c800", shade: "rgba(196,150,0,0.5)", highlight: "rgba(255,248,196,0.75)", ridge: "rgba(168,128,10,0.5)", tip: "#3b2a10", stem: "#6d6a22", outline: "#5a4406" });
  scrapeOut(c, C.x, C.y, C.w, C.h, 55, 91);
  const W = STAMPS.bananaWhite;
  // the wreck's faded logo: a white banana BUNCH (three fruits from one crown), grey shade on the bellies
  // (a light belly shade + a thin warm outline — grey shading reads as a dirty glove at 1–3 m)
  drawBananaBunch(c, W.x + W.w / 2 - 20, W.y + W.h / 2 + 10, 360, -0.18, { color: "#f6f2e8", shade: "rgba(206,198,178,0.35)", stem: "#ece6d6", outline: "rgba(150,138,118,0.55)" });
  scrapeOut(c, W.x, W.y, W.w, W.h, 60, 101);
  // the stamp ALPHA is a signed distance
  // field (the shader thresholds it at 0.5 with a screen-space AA ramp) — edges stay razor-sharp at any magnification;
  // the RGB is dilated past the edges so the bilinear fetch never pulls in the transparent black
  stampSdf(c, STAMPS.w, STAMPS.h, STAMP_SPREAD);
  return { stamps: el };
}

/** SDF ramp half-width of the stamp alpha, in stamp texels (alpha 0.5 = the edge, ±STAMP_SPREAD px → 0 / 1) */
export const STAMP_SPREAD = 10;
/** exact squared 1-D distance transform (Felzenszwalb–Huttenlocher) of f over n samples, in place into d */
function edt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let sx = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (sx <= z[k]) { k--; sx = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = sx; z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; d[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
}
/** squared euclidean distance of every pixel to the nearest `seed` pixel (w × h) */
function edt2(seed: Uint8Array, w: number, h: number): Float64Array {
  const INF = 1e20, out = new Float64Array(w * h), n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = seed[y * w + x] ? 0 : INF;
    edt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = out[y * w + x];
    edt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = d[x];
  }
  return out;
}
/** turn a canvas' alpha into a signed distance field (0.5 = edge, inside > 0.5) and dilate its RGB outward */
function stampSdf(c: CanvasRenderingContext2D, w: number, h: number, spread: number) {
  const img = c.getImageData(0, 0, w, h), px = img.data, N = w * h;
  const ins = new Uint8Array(N), outs = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const a = px[i * 4 + 3]; ins[i] = a >= 128 ? 1 : 0; outs[i] = 1 - ins[i]; }
  const dOut = edt2(outs, w, h), dIn = edt2(ins, w, h);
  // RGB dilation: straight alpha — outside pixels near an edge take the mean colour of their inside neighbours (a few
  // rings), so the thresholded edge never samples black
  const rgb = new Float32Array(N * 3), have = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (px[i * 4 + 3] > 24) { const a = px[i * 4 + 3] / 255; rgb[i * 3] = Math.min(255, px[i * 4] / a); rgb[i * 3 + 1] = Math.min(255, px[i * 4 + 1] / a); rgb[i * 3 + 2] = Math.min(255, px[i * 4 + 2] / a); have[i] = 1; }
  for (let ring = 0; ring < 6; ring++) {
    const add: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (have[i] || dIn[i] > 64) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx; if (!have[j]) continue;
        r += rgb[j * 3]; g += rgb[j * 3 + 1]; b += rgb[j * 3 + 2]; n++;
      }
      if (n) { rgb[i * 3] = r / n; rgb[i * 3 + 1] = g / n; rgb[i * 3 + 2] = b / n; add.push(i); }
    }
    for (const i of add) have[i] = 1;
  }
  for (let i = 0; i < N; i++) {
    // sub-pixel edge from the anti-aliased coverage: shift by (a − 0.5)
    const a = px[i * 4 + 3] / 255, sd = ins[i] ? Math.sqrt(dOut[i]) - 0.5 + (a - 0.5) : -(Math.sqrt(dIn[i]) - 0.5) + (a - 0.5);
    px[i * 4] = rgb[i * 3]; px[i * 4 + 1] = rgb[i * 3 + 1]; px[i * 4 + 2] = rgb[i * 3 + 2];
    px[i * 4 + 3] = Math.max(0, Math.min(255, Math.round((0.5 + sd / (2 * spread)) * 255)));
  }
  c.putImageData(img, 0, 0);
}

/** directional paint wear on a stamp: thin horizontal scrapes + a fine grit speckle (not round "camo" holes) */
function scrapeOut(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, n: number, seed: number) {
  const R = rng(seed);
  c.save(); c.globalCompositeOperation = "destination-out";
  for (let i = 0; i < n; i++) { c.globalAlpha = 0.45 + R() * 0.55; c.fillRect(x + R() * w, y + R() * h, 10 + R() ** 2 * w * 0.35, 1.2 + R() * 2.8); }
  for (let i = 0; i < n * 12; i++) { c.globalAlpha = 0.3 + R() * 0.6; c.fillRect(x + R() * w, y + R() * h, 1 + R() * 1.5, 1 + R() * 1.5); }
  c.restore();
}


/** subtle dent/rivet normal shared by all containers */
let dentCache: THREE.Texture | null = null;
export function containerDentNormal(): THREE.Texture {
  if (dentCache) return dentCache;
  dentCache = ctTex(ctCanvases("dent")["dent"], { srgb: false });
  dentCache.repeat.set(6, 6);
  return dentCache;
}
function paintDent(): Record<string, HTMLCanvasElement> {
  const size = 512;
  const [el, c] = canvas(size, size);
  c.fillStyle = "#808080"; c.fillRect(0, 0, size, size);
  paintNoise(c, 0, 0, size, size, { seed: 131, scale: size * 0.6, alpha: 0.4, blend: "source-over", octaves: 3 });
  paintNoise(c, 0, 0, size, size, { seed: 132, scale: size * 0.1, alpha: 0.16, blend: "overlay", octaves: 4 });
  const r = rng(133);
  for (let i = 0; i < 70; i++) { // small elongated dings (forklift tines, twist-lock knocks) — no big round craters
    const x = r() * size, y = r() * size, rad = size * (0.008 + 0.018 * r());
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, "rgba(90,90,90,0.55)"); g.addColorStop(1, "rgba(128,128,128,0)");
    c.fillStyle = g; c.beginPath(); c.ellipse(x, y, rad * (1.8 + 2.5 * r()), rad, (r() < 0.7 ? 0 : Math.PI / 2) + (r() - 0.5) * 0.3, 0, Math.PI * 2); c.fill();
  }
  return { dent: normalFromHeight(el, 1.0) };
}

/**
 * NEAR-FIELD DETAIL (the atlas alone is blurry at 1–3 m): a tileable 512² map sampled at ~0.45 m repeats on top of
 * the 5.8 mm/px atlas and faded out beyond ~12 m. R = albedo detail (0.5 neutral): orange-peel paint texture, fine
 * scratches, pits; G = roughness detail (scratches + pits rougher, the peel's crests glossier). Linear, mipmapped.
 */
let detailCache: THREE.Texture | null = null;
export function containerDetail(): THREE.Texture {
  if (detailCache) return detailCache;
  const t = ctTex(ctCanvases("detail")["detail"], { srgb: false, aniso: 8 });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  detailCache = t;
  return t;
}
function paintDetail(): Record<string, HTMLCanvasElement> {
  const S = 512;
  const [ael, a] = canvas(S, S), [gel, g] = canvas(S, S);
  for (const c of [a, g]) { c.fillStyle = "#808080"; c.fillRect(0, 0, S, S); }
  // orange peel: fine fbm (tileable) at low contrast + a broader mottle
  const fine = noiseTile(S, 902, 7, 0.72), broad = noiseTile(S, 903, 4, 0.55);
  a.save(); a.globalCompositeOperation = "overlay"; a.globalAlpha = 0.5; a.drawImage(fine, 0, 0); a.globalAlpha = 0.35; a.drawImage(broad, 0, 0); a.restore();
  g.save(); g.globalCompositeOperation = "overlay"; g.globalAlpha = 0.6; g.drawImage(fine, 0, 0); g.restore();
  // wrap-around drawing helper (keeps the tile seamless)
  const wrap = (fn: (ox: number, oy: number) => void) => { for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) fn(ox, oy); };
  const R = rng(904);
  // fine scratches (mostly horizontal: things slide along a box) — lighter albedo, rougher
  for (let i = 0; i < 90; i++) {
    const x = R() * S, y = R() * S, len = 8 + R() * 70, ang = (R() - 0.5) * 0.5 + (R() < 0.2 ? Math.PI / 2 : 0), w = 0.6 + R() * 1.1, al = 0.25 + R() * 0.45;
    wrap((ox, oy) => {
      for (const [c, col] of [[a, "rgba(255,255,255,1)"], [g, "rgba(255,255,255,1)"]] as Array<[CanvasRenderingContext2D, string]>) {
        c.save(); c.globalAlpha = al * (c === a ? 0.55 : 0.8); c.strokeStyle = col; c.lineWidth = w; c.beginPath(); c.moveTo(x + ox, y + oy); c.lineTo(x + ox + Math.cos(ang) * len, y + oy + Math.sin(ang) * len); c.stroke(); c.restore();
      }
      a.save(); a.globalAlpha = al * 0.35; a.strokeStyle = "#000"; a.lineWidth = w * 0.6; a.beginPath(); a.moveTo(x + ox, y + oy + w); a.lineTo(x + ox + Math.cos(ang) * len, y + oy + w + Math.sin(ang) * len); a.stroke(); a.restore();
    });
  }
  // pits + specks of grit
  for (let i = 0; i < 260; i++) {
    const x = R() * S, y = R() * S, rr = 0.6 + R() * 1.6, dark = R() < 0.7;
    wrap((ox, oy) => {
      a.fillStyle = dark ? `rgba(40,30,20,${0.35 + R() * 0.4})` : `rgba(255,255,255,${0.3 + R() * 0.3})`; a.beginPath(); a.arc(x + ox, y + oy, rr, 0, 6.283); a.fill();
      g.fillStyle = "rgba(255,255,255,0.6)"; g.beginPath(); g.arc(x + ox, y + oy, rr, 0, 6.283); g.fill();
    });
  }
  const ad = a.getImageData(0, 0, S, S), gd = g.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) { ad.data[i * 4 + 1] = gd.data[i * 4]; ad.data[i * 4 + 2] = 128; ad.data[i * 4 + 3] = 255; }
  a.putImageData(ad, 0, 0);
  return { detail: ael };
}

// ------------------------------------------------------------------------------------------------ off-thread
/** the container textures, painted in worker threads (harbor-tex.worker.ts) by `containerTexAsync()`; a missing one is
 *  painted live on first use */
export const CT_GROUPS: Record<string, () => Record<string, HTMLCanvasElement>> = { atlas: paintAtlas, stamps: paintStamps, dent: paintDent, detail: paintDetail };
const CT_PRE = new Map<string, ImageBitmap>(), CT_LIVE = new Map<string, Record<string, HTMLCanvasElement>>();
type CvOrBm = HTMLCanvasElement | ImageBitmap;
function ctCanvases(g: string): Record<string, CvOrBm> {
  const pre = [...CT_PRE].filter(([k]) => k === g || k.startsWith(g + "."));
  if (pre.length) return Object.fromEntries(pre);
  if (!CT_LIVE.has(g)) CT_LIVE.set(g, Object.fromEntries(Object.entries(CT_GROUPS[g]()).map(([k, c]) => [k, capped(c)])));
  return CT_LIVE.get(g)!;
}
function ctTex(c: CvOrBm, o: { srgb?: boolean; repeat?: boolean; aniso?: number } = {}): THREE.Texture {
  if (!(typeof ImageBitmap !== "undefined" && c instanceof ImageBitmap)) return tex(c as HTMLCanvasElement, o);
  const t = new THREE.Texture(c as unknown as HTMLImageElement);
  t.colorSpace = (o.srgb ?? true) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = (o.repeat ?? true) ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = o.aniso ?? 8; t.flipY = false; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true;
  return t;
}
export function paintCtGroups(groups: string[]): Record<string, HTMLCanvasElement> { const out: Record<string, HTMLCanvasElement> = {}; for (const g of groups) Object.assign(out, CT_GROUPS[g]()); return out; }
let ctPending: Promise<void> | null = null;
/** paint the container atlas / stamps / dent / detail textures in workers (call before ContainerKit builds) */
export function containerTexAsync(): Promise<void> {
  if (atlasCache || CT_PRE.size) return Promise.resolve();
  return (ctPending ??= (async () => {
    if (typeof Worker === "undefined" || typeof OffscreenCanvas === "undefined") return;
    try {
      const pool = workerPool(() => new Worker(new URL("./harbor-tex.worker.ts", import.meta.url), { type: "module" }), 3);
      const res = await Promise.all([["atlas"], ["stamps"], ["dent", "detail"]].map((g) => pool.run<Record<string, ImageBitmap>>("paintCt", g)));
      pool.close();
      const done = await Promise.all(res.flatMap((r) => Object.entries(r).map(async ([k, v]) => [k, await cappedBitmap(v)] as const)));
      for (const [k, v] of done) CT_PRE.set(k, v);
    } catch (e) { console.warn("[containers] texture worker failed — painting on the main thread", e); }
  })());
}
