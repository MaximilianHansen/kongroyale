import { TAU, ZN, Z_UP, Z_RAMP, Z_OPEN, ZCAP, WING_HALF, WING_TIP_BROWN, STAB_HALF, FIN_Y0, FIN_Y1, FIN_ZMIN, FIN_ZMAX, YEL, BROWN, BROWN_TIP, CREAM, LEAF_D, LEAF_L, LEAF_RIB, clamp01, lerp, rng, aOfY, BAND_Y0, BAND_Y1, CREAM_W, WIN_Y, PORTHOLES, finLE, finTE } from "./plane-dims";

// ============================================================================ canvas painting kit
export type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export interface Layers<T> { map: T; normal: T; rough: T }
export const isLayers = <T>(v: T | Layers<T>): v is Layers<T> => typeof v === "object" && v !== null && "rough" in v;
function mkCanvas(w: number, h: number): Canvas { if (typeof document === "undefined") return new OffscreenCanvas(w, h); const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
const g2d = (c: Canvas): Ctx => ("transferControlToOffscreen" in c ? c.getContext("2d", { willReadFrequently: true }) : c.getContext("2d", { willReadFrequently: true }))!;
const gray = (v: number) => { const c = Math.round(clamp01(v) * 255); return `rgb(${c},${c},${c})`; };
class Paint {
  readonly cc: Canvas; readonly hc: Canvas; readonly rc: Canvas;
  readonly c: Ctx; readonly h: Ctx; readonly r: Ctx;
  constructor(readonly w: number, readonly H: number, base: string, rough: number) {
    this.cc = mkCanvas(w, H); this.hc = mkCanvas(w, H); this.rc = mkCanvas(w, H);
    this.c = g2d(this.cc); this.h = g2d(this.hc); this.r = g2d(this.rc);
    this.c.fillStyle = base; this.c.fillRect(0, 0, w, H);
    this.h.fillStyle = gray(0.5); this.h.fillRect(0, 0, w, H);
    this.r.fillStyle = gray(rough); this.r.fillRect(0, 0, w, H);
  }
  /** soft tonal blotches — the hand-painted look */
  blotch(n: number, seed: number, rMin: number, rMax: number, a: number, cols = ["255,244,205", "150,86,0"], yMin = 0, yMax = this.H) {
    const R = rng(seed), g = this.c;
    for (let i = 0; i < n; i++) {
      const x = R() * this.w, y = yMin + R() * (yMax - yMin), rr = rMin + R() * (rMax - rMin), col = cols[i % cols.length];
      const gr = g.createRadialGradient(x, y, 0, x, y, rr);
      gr.addColorStop(0, `rgba(${col},${a * (0.4 + R() * 0.6)})`); gr.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, rr, rr * (0.5 + R() * 0.6), R() * 3, 0, TAU); g.fill();
    }
  }
  /** fine speckle noise on colour + roughness */
  grain(n: number, seed: number, a = 0.05) {
    const R = rng(seed);
    for (let i = 0; i < n; i++) {
      const x = R() * this.w, y = R() * this.H, s = 1 + R() * 2.5, l = R() > 0.5;
      this.c.fillStyle = l ? `rgba(255,248,220,${a})` : `rgba(80,45,0,${a})`; this.c.fillRect(x, y, s, s);
      this.r.fillStyle = l ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.06)"; this.r.fillRect(x, y, s, s);
    }
  }
  /** engraved panel line: height groove + dark ink + a thin highlight */
  line(x0: number, y0: number, x1: number, y1: number, depth = 1, ink = 0.32) {
    const h = this.h, c = this.c;
    h.strokeStyle = gray(0.5 - 0.3 * depth); h.lineWidth = 2.2; h.beginPath(); h.moveTo(x0, y0); h.lineTo(x1, y1); h.stroke();
    c.strokeStyle = `rgba(92,52,6,${ink})`; c.lineWidth = 1.6; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    const nx = y1 - y0, ny = x0 - x1, l = Math.hypot(nx, ny) || 1;
    c.strokeStyle = `rgba(255,248,215,${ink * 0.5})`; c.lineWidth = 1;
    c.beginPath(); c.moveTo(x0 + (nx / l) * 1.6, y0 + (ny / l) * 1.6); c.lineTo(x1 + (nx / l) * 1.6, y1 + (ny / l) * 1.6); c.stroke();
    this.r.strokeStyle = "rgba(255,255,255,0.25)"; this.r.lineWidth = 2; this.r.beginPath(); this.r.moveTo(x0, y0); this.r.lineTo(x1, y1); this.r.stroke();
  }
  /** rivet row along a segment */
  rivets(x0: number, y0: number, x1: number, y1: number, step = 9, off = 5, rows = 1, ink = 0.22) {
    const len = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.floor(len / step));
    const nx = (y1 - y0) / (len || 1), ny = (x0 - x1) / (len || 1);
    for (let row = 0; row < rows; row++) {
      const o = rows === 1 ? off : row === 0 ? off : -off;
      for (let i = 0; i <= n; i++) {
        const t = i / n, x = x0 + (x1 - x0) * t + nx * o, y = y0 + (y1 - y0) * t + ny * o;
        this.h.fillStyle = gray(0.78); this.h.beginPath(); this.h.arc(x, y, 1.5, 0, TAU); this.h.fill();
        this.c.fillStyle = `rgba(110,64,8,${ink})`; this.c.beginPath(); this.c.arc(x + 0.4, y + 0.4, 1.1, 0, TAU); this.c.fill();
        this.c.fillStyle = `rgba(255,250,225,${ink * 1.2})`; this.c.fillRect(x - 0.8, y - 0.8, 0.9, 0.9);
      }
    }
  }
  /** rounded-rect hatch outline (engraved) */
  hatch(x: number, y: number, w: number, h: number, r: number, rivet = true) {
    for (const [g, style, lw] of [[this.h, gray(0.22), 2.4], [this.c, "rgba(92,52,6,0.4)", 1.7]] as const) {
      g.strokeStyle = style; g.lineWidth = lw; g.beginPath(); g.roundRect(x, y, w, h, r); g.stroke();
    }
    this.c.strokeStyle = "rgba(255,248,215,0.2)"; this.c.lineWidth = 1; this.c.beginPath(); this.c.roundRect(x + 1.6, y + 1.6, w, h, r); this.c.stroke();
    if (rivet) { this.rivets(x - 5, y - 5, x + w + 5, y - 5, 9, 0); this.rivets(x - 5, y + h + 5, x + w + 5, y + h + 5, 9, 0); this.rivets(x - 5, y - 5, x - 5, y + h + 5, 9, 0); this.rivets(x + w + 5, y - 5, x + w + 5, y + h + 5, 9, 0); }
  }
  /** paint chips / scuffs (lighter primer showing through) in a region */
  chips(x: number, y: number, w: number, h: number, n: number, seed: number, col = "235,222,190") {
    const R = rng(seed);
    for (let i = 0; i < n; i++) {
      const cx = x + R() * w, cy = y + R() * h, s = 0.8 + R() * 2.6;
      this.c.fillStyle = `rgba(${col},${0.35 + R() * 0.4})`; this.c.beginPath(); this.c.ellipse(cx, cy, s, s * (0.4 + R() * 0.6), R() * 3, 0, TAU); this.c.fill();
      this.h.fillStyle = gray(0.42); this.h.beginPath(); this.h.ellipse(cx, cy, s, s * 0.6, 0, 0, TAU); this.h.fill();
      this.r.fillStyle = gray(0.6); this.r.beginPath(); this.r.ellipse(cx, cy, s, s * 0.6, 0, 0, TAU); this.r.fill();
    }
  }
  tex(normalStrength: number): Layers<Canvas> {
    return { map: this.cc, normal: heightToNormal(this.hc, normalStrength), rough: this.rc };
  }
}
function heightToNormal(src: Canvas, strength: number): Canvas {
  const w = src.width, h = src.height;
  const d = g2d(src).getImageData(0, 0, w, h).data;
  const out = mkCanvas(w, h), g = g2d(out), img = g.createImageData(w, h), o = img.data;
  const H = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) H[i] = d[i * 4] / 255;
  for (let y = 0; y < h; y++) {
    const ym = ((y - 1 + h) % h) * w, yp = ((y + 1) % h) * w, yc = y * w;
    for (let x = 0; x < w; x++) {
      const xm = (x - 1 + w) % w, xp = (x + 1) % w;
      const dx = (H[yc + xp] - H[yc + xm]) * strength, dy = (H[yp + x] - H[ym + x]) * strength;
      const l = 1 / Math.hypot(dx, dy, 1), k = (yc + x) * 4;
      o[k] = (-dx * l * 0.5 + 0.5) * 255; o[k + 1] = (dy * l * 0.5 + 0.5) * 255; o[k + 2] = (l * 0.5 + 0.5) * 255; o[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return out;
}
const FONT = (px: number) => `900 ${px}px "Avenir Next", "Futura", "Arial Black", "Helvetica Neue", sans-serif`;
/** draw centred text at (x,y) with cap height `cap` px, max width `maxW`, with an optional transform flip */
function stencil(g: Ctx, txt: string, x: number, y: number, capPx: number, sx: number, sy: number, fill: string, maxW = 1e9, track = 0.06) {
  g.save(); g.translate(x, y); g.scale(sx, sy);
  const px = capPx / 0.72; g.font = FONT(px); g.textAlign = "left"; g.textBaseline = "middle";
  const chars = [...txt]; const widths = chars.map((ch) => g.measureText(ch).width); const tr = px * track;
  const total = widths.reduce((a, b) => a + b, 0) + tr * (chars.length - 1);
  const k = Math.min(1, maxW / total);
  g.scale(k, 1);
  let cx = -total / 2;
  g.fillStyle = fill;
  chars.forEach((ch, i) => { g.fillText(ch, cx, capPx * 0.04); cx += widths[i] + tr; });
  g.restore();
}

// ============================================================================ textures
const X_F = (z: number, W: number) => ((z - ZN) / (ZCAP - ZN)) * W; // fuselage canvas x for z
const Y_F = (a: number, H: number) => (1 - a / TAU) * H;             // fuselage canvas y for angle a

function paintFuselage(): Layers<Canvas> {
  const W = 2048, H = 1024, P = new Paint(W, H, YEL, 0.26), c = P.c;
  const X = (z: number) => X_F(z, W), Y = (a: number) => Y_F(a, H);
  const side = (a: number, s: number) => (s > 0 ? a : TAU - a);
  P.blotch(320, 3, 30, 150, 0.07, ["255,236,170", "170,96,0", "255,214,90"], 40, H - 40);
  P.grain(9000, 5, 0.035);
  // top sun-bleach, belly grime (the belly is the canvas top + bottom rows: a = 0 / 2π)
  let gr = c.createLinearGradient(0, H * 0.36, 0, H * 0.64);
  gr.addColorStop(0, "rgba(255,238,170,0)"); gr.addColorStop(0.5, "rgba(255,238,170,0.12)"); gr.addColorStop(1, "rgba(255,238,170,0)");
  c.fillStyle = gr; c.fillRect(0, 0, W, H);
  for (const [y0, y1] of [[0, H * 0.13], [H, H * 0.87]]) {
    gr = c.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, "rgba(96,58,14,0.34)"); gr.addColorStop(1, "rgba(96,58,14,0)");
    c.fillStyle = gr; c.fillRect(0, Math.min(y0, y1), W, Math.abs(y1 - y0));
    P.r.fillStyle = "rgba(255,255,255,0.12)"; P.r.fillRect(0, Math.min(y0, y1), W, Math.abs(y1 - y0) * 0.6);
  }
  // oil / exhaust streaks along the belly behind the sponsons
  const R = rng(17);
  for (let i = 0; i < 26; i++) {
    const s = R() > 0.5 ? 1 : -1, a = side(0.25 + R() * 0.55, s), z0 = 1.2 + R() * 2.5, len = 2 + R() * 5;
    const y = Y(a), x0 = X(z0), x1 = X(z0 + len);
    gr = c.createLinearGradient(x0, 0, x1, 0); gr.addColorStop(0, "rgba(70,44,16,0.22)"); gr.addColorStop(1, "rgba(70,44,16,0)");
    c.fillStyle = gr; c.fillRect(x0, y - 1.5 - R() * 3, x1 - x0, 2 + R() * 4);
  }
  // cheat line: cream | brown | cream at window height, full length, both sides
  const a0 = aOfY(BAND_Y0), a1 = aOfY(BAND_Y1), ac0 = aOfY(BAND_Y0 - CREAM_W), ac1 = aOfY(BAND_Y1 + CREAM_W);
  for (const s of [1, -1]) {
    const ys = [ac0, a0, a1, ac1].map((a) => Y(side(a, s)));
    const top = (i: number, j: number) => [Math.min(ys[i], ys[j]), Math.abs(ys[j] - ys[i])] as const;
    const x0 = X(ZN + 0.25), x1 = W;
    let [yy, hh] = top(0, 3); c.fillStyle = CREAM; c.fillRect(x0, yy, x1 - x0, hh);
    [yy, hh] = top(1, 2); c.fillStyle = BROWN; c.fillRect(x0, yy, x1 - x0, hh);
    // painted-edge gloss + subtle hand-painted shading on the brown band
    gr = c.createLinearGradient(0, yy, 0, yy + hh);
    gr.addColorStop(0, "rgba(120,72,40,0.35)"); gr.addColorStop(0.5, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(20,8,0,0.25)");
    c.fillStyle = gr; c.fillRect(x0, yy, x1 - x0, hh);
    P.r.fillStyle = gray(0.3); P.r.fillRect(x0, yy, x1 - x0, hh);
    P.h.fillStyle = gray(0.53); P.h.fillRect(x0, Math.min(ys[0], ys[3]), x1 - x0, Math.abs(ys[3] - ys[0])); // slightly raised decal edge
  }
  // porthole gaskets painted under the geometric frames
  for (const s of [1, -1]) for (const z of PORTHOLES) {
    const x = X(z), y = Y(side(aOfY(WIN_Y), s));
    c.fillStyle = "rgba(20,10,4,0.55)"; c.beginPath(); c.arc(x, y, 23, 0, TAU); c.fill();
    P.h.fillStyle = gray(0.35); P.h.beginPath(); P.h.arc(x, y, 23, 0, TAU); P.h.fill();
  }
  // circumferential panel joints + rivet rows
  const frames = [-12.6, -10.1, -8.6, -7.5, -6.1, -4.7, -3.3, -1.9, -0.5, 0.9, 2.3, 4.4, 5.9, 7.5, 9.4, 10.8, 12.0, 13.2];
  for (const z of frames) {
    const x = X(z), strong = z === Z_UP || z === Z_RAMP || z === Z_OPEN;
    P.line(x, 0, x, H, strong ? 1.4 : 1, strong ? 0.45 : 0.3);
    P.rivets(x, 0, x, H, 9, 5, 2);
  }
  // longitudinal seams (both sides) + top centre seam
  for (const a of [0.42, 1.08, 2.08, 2.62]) for (const s of [1, -1]) {
    const y = Y(side(a, s)); P.line(X(-12.6), y, X(13.2), y, 0.9, 0.26); P.rivets(X(-12.6), y, X(13.2), y, 9, 5, 2, 0.18);
  }
  { const y = Y(Math.PI); P.line(X(-10.1), y, X(13.2), y, 0.8, 0.22); P.rivets(X(-10.1), y, X(13.2), y, 9, 4, 1, 0.16); }
  // doors + hatches (rounded rects in (z, world-y) → canvas); paratroop doors both sides, crew door port side
  const rectZY = (z0: number, z1: number, y0: number, y1: number, s: number) => {
    const ya = Y(side(aOfY(y0), s)), yb = Y(side(aOfY(y1), s));
    return [X(z0), Math.min(ya, yb), X(z1) - X(z0), Math.abs(yb - ya)] as const;
  };
  for (const s of [1, -1]) {
    const [x, y, w, h] = rectZY(2.62, 3.82, 1.92, 3.12, s);
    P.hatch(x, y, w, h, 7);
    const [wx, wy, ww, wh] = rectZY(2.95, 3.49, 2.66, 2.98, s);
    c.fillStyle = "#16202a"; c.beginPath(); c.roundRect(wx, wy, ww, wh, 5); c.fill();
    c.fillStyle = "rgba(150,190,220,0.35)"; c.fillRect(wx + 3, wy + 2, ww * 0.35, wh * 0.4);
    P.r.fillStyle = gray(0.06); P.r.fillRect(wx, wy, ww, wh);
    P.h.fillStyle = gray(0.3); P.h.fillRect(wx, wy, ww, wh);
    const [hx, hy] = rectZY(3.52, 3.66, 2.3, 2.42, s);
    c.fillStyle = "#6b6258"; c.fillRect(hx, hy, 10, 5); P.h.fillStyle = gray(0.8); P.h.fillRect(hx, hy, 10, 5);
    // little square service hatch + lower cargo windows (target art: row of small dark windows under the band)
    const [sx, sy, sw, sh] = rectZY(1.9, 2.35, 2.72, 3.08, s); P.hatch(sx, sy, sw, sh, 3, false);
    for (const z of [-9.3, -7.9, -6.5, -5.1, 0.95]) {
      const [lx, ly, lw, lh] = rectZY(z, z + 0.26, 2.48, 2.86, s);
      c.fillStyle = "#1a2129"; c.beginPath(); c.roundRect(lx, ly, lw, lh, 4); c.fill();
      c.fillStyle = "rgba(170,205,230,0.3)"; c.fillRect(lx + 2, ly + 2, lw * 0.4, lh * 0.35);
      c.strokeStyle = "rgba(60,36,10,0.5)"; c.lineWidth = 2; c.strokeRect(lx - 1, ly - 1, lw + 2, lh + 2);
      P.r.fillStyle = gray(0.06); P.r.fillRect(lx, ly, lw, lh); P.h.fillStyle = gray(0.32); P.h.fillRect(lx, ly, lw, lh);
    }
  }
  { const [x, y, w, h] = rectZY(-8.75, -7.75, 1.95, 3.15, -1); P.hatch(x, y, w, h, 8); }
  // top escape hatches
  for (const z of [-6.8, 1.4]) { const x = X(z), y = Y(Math.PI); P.hatch(x - 22, y - 22, 44, 44, 5, false); }
  // nose gear well (belly, wraps the canvas seam)
  for (const [yy, hh] of [[Y(0.24), H - Y(0.24)], [0, Y(TAU - 0.24)]]) {
    c.fillStyle = "#17110d"; c.fillRect(X(-11.95), yy, X(-10.35) - X(-11.95), hh);
    P.r.fillStyle = gray(0.8); P.r.fillRect(X(-11.95), yy, X(-10.35) - X(-11.95), hh);
  }
  // ramp + upper door seams are the strong frames above; hinge line rivets
  // cockpit glazing: wrap-around panes (dark tinted glass, glossy), yellow frames between them
  const pane = (z0: number, z1: number, aa0: number, aa1: number, s: number, skew = 0) => {
    const pts: [number, number][] = [[z0 + skew, aa0], [z1, aa0], [z1, aa1], [z0, aa1]];
    const q = pts.map(([z, a]) => [X(z), Y(side(a, s))] as [number, number]);
    for (const [g, style] of [[c, "#101920"], [P.r, gray(0.05)], [P.h, gray(0.28)]] as const) {
      g.fillStyle = style; g.beginPath(); q.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill();
    }
    // sky reflection gradient on the glass
    const ys = q.map((p) => p[1]), yMin = Math.min(...ys), yMax = Math.max(...ys);
    const rg = c.createLinearGradient(0, yMin, 0, yMax);
    rg.addColorStop(0, "rgba(120,170,210,0.28)"); rg.addColorStop(0.55, "rgba(40,70,95,0.08)"); rg.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = rg; c.beginPath(); q.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.closePath(); c.fill();
    c.strokeStyle = "rgba(30,18,6,0.8)"; c.lineWidth = 2.5; c.stroke();
  };
  for (const s of [1, -1]) {
    pane(-12.92, -12.02, 2.66, 3.09, s, 0.12);      // windscreen (centre post at a = π)
    pane(-12.52, -11.42, 2.2, 2.6, s, 0.1);         // side pane 1
    pane(-11.28, -10.36, 2.12, 2.52, s);            // side pane 2
    pane(-12.1, -11.5, 2.7, 3.05, s);               // eyebrow window
  }
  // radome: dark glossy nose cap
  { const x1 = X(-13.18); c.fillStyle = "#2a1c15"; c.fillRect(0, 0, x1, H);
    gr = c.createLinearGradient(0, 0, x1, 0); gr.addColorStop(0, "rgba(0,0,0,0.3)"); gr.addColorStop(1, "rgba(90,60,40,0.25)"); c.fillStyle = gr; c.fillRect(0, 0, x1, H);
    P.r.fillStyle = gray(0.26); P.r.fillRect(0, 0, x1, H);
    P.line(x1, 0, x1, H, 1.2, 0.5); c.fillStyle = "rgba(244,230,190,0.5)"; c.fillRect(x1 + 3, 0, 3, H); }
  // BANANA CO. above the cheat line between cockpit and wing, both sides reading nose-ward/aft correctly
  for (const s of [1, -1]) {
    const zc = -6.95, yc = 4.72, a = side(aOfY(yc), s);
    const pxPerM = W / (ZCAP - ZN);
    stencil(c, "BANANA CO.", X(zc), Y(a), 0.5 * pxPerM, s > 0 ? -1 : 1, s > 0 ? 1 : -1, BROWN, 3.7 * pxPerM);
    P.r.globalAlpha = 1;
  }
  // wear: chips around doors, ramp hinge + edges, nose; scuffs near the belly
  for (const s of [1, -1]) {
    const [x, y, w, h] = rectZY(2.5, 3.95, 1.85, 3.2, s); P.chips(x, y, w, h, 40, 30 + s);
    P.chips(X(Z_UP) - 30, 0, 60, H, 90, 40 + s);
  }
  P.chips(X(-13.2), 0, X(-12) - X(-13.2), H, 70, 51);
  P.chips(0, H * 0.9, W, H * 0.1, 160, 52, "90,60,30"); P.chips(0, 0, W, H * 0.1, 160, 53, "90,60,30");
  return P.tex(5.5);
}

// lifting surfaces (wing / stabiliser). Canvas x = span (port tip → starboard tip), y = chord around:
// top row = trailing edge upper, middle = leading edge, bottom row = trailing edge lower.
interface LiftSpec { half: number; tipBrown: number; seams: number[]; hingeXc: number; hingeFrom: number; hingeTo: number; ribs: number; soot?: number[]; stripe?: boolean; seed: number }
function paintLift(W: number, H: number, L: LiftSpec): Layers<Canvas> {
  const P = new Paint(W, H, YEL, 0.26), c = P.c;
  const X = (x: number) => ((x + L.half) / (2 * L.half)) * W;
  const Yu = (xc: number) => (0.5 - xc / 2) * H, Yl = (xc: number) => (0.5 + xc / 2) * H;
  P.blotch(160, L.seed, 20, 90, 0.07); P.grain(4000, L.seed + 1, 0.035);
  // upper surface slightly bleached, lower a touch dirtier
  let gr = c.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, "rgba(255,236,170,0.1)"); gr.addColorStop(0.5, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(110,64,10,0.14)");
  c.fillStyle = gr; c.fillRect(0, 0, W, H);
  // spar lines + ribs + control surface hinge + separators
  for (const xc of [0.14, 0.62]) for (const Yf of [Yu, Yl]) { P.line(0, Yf(xc), W, Yf(xc), 0.8, 0.22); P.rivets(0, Yf(xc), W, Yf(xc), 8, 4, 2, 0.16); }
  for (const s of [1, -1]) for (const Yf of [Yu, Yl]) {
    const x0 = X(s * L.hingeFrom), x1 = X(s * L.hingeTo);
    P.line(Math.min(x0, x1), Yf(L.hingeXc), Math.max(x0, x1), Yf(L.hingeXc), 1.3, 0.42);
    for (const sx of L.seams) P.line(X(s * sx), Yf(L.hingeXc), X(s * sx), Yf(1), 1.3, 0.42);
    // control-surface ribs (fine)
    for (let x = L.hingeFrom + 0.3; x < L.hingeTo; x += 0.3) P.line(X(s * x), Yf(L.hingeXc + 0.02), X(s * x), Yf(0.99), 0.35, 0.1);
  }
  for (let x = -L.half + 0.6; x < L.half; x += L.ribs) {
    for (const Yf of [Yu, Yl]) { P.line(X(x), Yf(0.02), X(x), Yf(L.hingeXc), 0.5, 0.14); P.rivets(X(x), Yf(0.02), X(x), Yf(L.hingeXc), 8, 0, 1, 0.14); }
  }
  // thin brown leading-edge stripe on the upper surface (target art: de-icer style line)
  if (L.stripe) for (const s of [1, -1]) {
    const xa = X(s * 2.3), xb = X(s * (L.tipBrown - 0.1));
    c.fillStyle = "rgba(74,42,23,0.9)"; c.fillRect(Math.min(xa, xb), Yu(0.085), Math.abs(xb - xa), 5);
  }
  // leading-edge wear: lighter scuffs + chips around the nose of the airfoil
  gr = c.createLinearGradient(0, Yu(0.05), 0, Yl(0.05));
  gr.addColorStop(0, "rgba(255,244,210,0)"); gr.addColorStop(0.5, "rgba(255,244,210,0.22)"); gr.addColorStop(1, "rgba(255,244,210,0)");
  c.fillStyle = gr; c.fillRect(0, Yu(0.05), W, Yl(0.05) - Yu(0.05));
  P.chips(0, Yu(0.03), W, Yl(0.03) - Yu(0.03), Math.round(W * 0.35), L.seed + 7);
  // engine soot streaks behind the exhausts (upper + lower)
  for (const sx of L.soot ?? []) for (const Yf of [Yu, Yl]) {
    const R = rng(L.seed + Math.round(sx * 10));
    for (let i = 0; i < 18; i++) {
      const x = X(sx + (R() - 0.5) * 1.3), y0 = Yf(0.35 + R() * 0.2), y1 = Yf(1);
      gr = c.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, "rgba(40,30,22,0.0)"); gr.addColorStop(0.3, "rgba(40,30,22,0.16)"); gr.addColorStop(1, "rgba(40,30,22,0.05)");
      c.fillStyle = gr; c.fillRect(x, Math.min(y0, y1), 3 + R() * 9, Math.abs(y1 - y0));
    }
    P.r.fillStyle = "rgba(255,255,255,0.15)"; P.r.fillRect(X(sx - 0.7), Math.min(Yf(0.4), Yf(1)), X(0.7) - X(-0.7), Math.abs(Yf(1) - Yf(0.4)));
  }
  // brown tips (painted last), with a crisp masking edge
  for (const s of [1, -1]) {
    const xe = X(s * L.tipBrown), x0 = s > 0 ? xe : 0, x1 = s > 0 ? W : xe;
    c.fillStyle = BROWN_TIP; c.fillRect(x0, 0, x1 - x0, H);
    gr = c.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, "rgba(120,80,56,0.3)"); gr.addColorStop(0.5, "rgba(255,230,200,0.12)"); gr.addColorStop(1, "rgba(0,0,0,0.2)");
    c.fillStyle = gr; c.fillRect(x0, 0, x1 - x0, H);
    P.r.fillStyle = gray(0.3); P.r.fillRect(x0, 0, x1 - x0, H);
    P.line(xe, 0, xe, H, 0.8, 0.3); c.fillStyle = "rgba(255,240,200,0.4)"; c.fillRect(xe + (s > 0 ? 2 : -4), 0, 2, H);
    P.chips(s > 0 ? xe : 0, H * 0.46, Math.abs(x1 - x0), H * 0.08, 60, L.seed + 9 + s, "200,160,120");
  }
  return P.tex(5);
}

// fin: two halves (left half = starboard skin, right half = port skin), planar (z,y) mapping so the livery reads
// correctly from both sides. Banana-leaf fan + BANANA CO.
function paintFin(): Layers<Canvas> {
  const W = 2048, H = 1024, P = new Paint(W, H, YEL, 0.26), c = P.c;
  const sx = 1024 / (FIN_ZMAX - FIN_ZMIN), sy = H / (FIN_Y1 - FIN_Y0);
  P.blotch(160, 21, 20, 110, 0.07); P.grain(5000, 22, 0.035);
  for (let half = 0; half < 2; half++) {
    const X = (z: number) => (half === 0 ? (FIN_ZMAX - z) * sx : 1024 + (z - FIN_ZMIN) * sx);
    const Y = (y: number) => (FIN_Y1 - y) * sy;
    c.save(); c.beginPath(); c.rect(half * 1024, 0, 1024, H); c.clip();
    P.h.save(); P.h.beginPath(); P.h.rect(half * 1024, 0, 1024, H); P.h.clip();
    P.r.save(); P.r.beginPath(); P.r.rect(half * 1024, 0, 1024, H); P.r.clip();
    // rudder hinge line + rib seams + hinge plates
    const hinge = (y: number) => finTE(y) - 0.3 * (finTE(y) - finLE(y));
    for (let y = FIN_Y0 + 0.2; y < FIN_Y1 - 0.2; y += 0.1) P.line(X(hinge(y)), Y(y), X(hinge(y + 0.1)), Y(y + 0.1), 1.2, 0.4);
    for (const y of [6.3, 7.6, 8.9, 10.2, 11.4]) { P.line(X(finLE(y)), Y(y), X(finTE(y)), Y(y), 0.6, 0.16); P.rivets(X(finLE(y)), Y(y), X(hinge(y)), Y(y), 9, 4, 2, 0.14); }
    for (const f of [0.18, 0.5]) for (let y = FIN_Y0 + 0.4; y < FIN_Y1 - 0.6; y += 0.1) {
      const z0 = lerp(finLE(y), finTE(y), f), z1 = lerp(finLE(y + 0.1), finTE(y + 0.1), f);
      P.line(X(z0), Y(y), X(z1), Y(y + 0.1), 0.6, 0.14);
    }
    for (const y of [7.1, 9.1, 11.0]) {
      const z = hinge(y); c.fillStyle = "#b9a98a"; c.fillRect(X(z) - 9, Y(y) - 5, 18, 10); P.h.fillStyle = gray(0.75); P.h.fillRect(X(z) - 9, Y(y) - 5, 18, 10);
      c.strokeStyle = "rgba(60,40,20,0.6)"; c.lineWidth = 1.5; c.strokeRect(X(z) - 9, Y(y) - 5, 18, 10);
    }
    // banana-leaf fan (drawn in world (z,y) so the two sides mirror correctly)
    const L = (bz: number, by: number, tz: number, ty: number, w: number, bend: number, seed: number) =>
      drawLeaf(c, P.h, X(bz), Y(by), X(tz), Y(ty), w * sy, half === 0 ? bend : -bend, seed);
    L(12.4, 7.3, 13.95, 11.6, 0.8, -0.12, 1);      // big leaf sweeping up-aft
    L(12.2, 7.3, 11.05, 10.9, 0.66, 0.14, 2);      // leaf sweeping up-forward
    L(12.5, 7.27, 14.05, 9.0, 0.48, -0.1, 3);      // low leaf aft
    // BANANA CO. — brown, heavy, reads left→right from each side
    // lettering sits clear above the stabiliser root so it reads whole from below (target art)
    stencil(c, "BANANA CO.", X(11.75), Y(6.72), 0.52 * sy, 1, 1, BROWN, 3.4 * sx);
    c.restore(); P.h.restore(); P.r.restore();
  }
  // leading-edge wear along both halves
  for (let half = 0; half < 2; half++) for (let y = FIN_Y0 + 0.5; y < FIN_Y1 - 0.2; y += 0.12) {
    const x = half === 0 ? (FIN_ZMAX - finLE(y)) * sx : 1024 + (finLE(y) - FIN_ZMIN) * sx;
    P.chips(x - (half === 0 ? 14 : 0), (FIN_Y1 - y) * sy, 14, 10, 2, Math.round(y * 100) + half);
  }
  return P.tex(5);
}
function drawLeaf(g: Ctx, hg: Ctx, bx: number, by: number, tx: number, ty: number, w: number, bend: number, seed: number) {
  const R = rng(seed * 97 + 13);
  const dx = tx - bx, dy = ty - by, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, px = -uy, py = ux;
  const cxp = bx + dx * 0.5 + px * bend * len, cyp = by + dy * 0.5 + py * bend * len;
  const spine = (t: number) => { const a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, d = t * t; return [a * bx + b * cxp + d * tx, a * by + b * cyp + d * ty]; };
  const tang = (t: number) => { const x = 2 * (1 - t) * (cxp - bx) + 2 * t * (tx - cxp), y = 2 * (1 - t) * (cyp - by) + 2 * t * (ty - cyp); const l = Math.hypot(x, y); return [x / l, y / l]; };
  const half = (t: number) => w * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.75) * (1 - 0.2 * t);
  const N = 44, left: [number, number][] = [], right: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, [sx, sy] = spine(t), [tx2, ty2] = tang(t), nx = -ty2, ny = tx2, hw = half(t);
    // smooth broad outline (target art); the leaf's splits are painted as thin slits afterwards
    left.push([sx + nx * hw, sy + ny * hw]);
    right.push([sx - nx * hw, sy - ny * hw]);
  }
  const path = (ctx: Ctx, a: [number, number][], b: [number, number][]) => {
    ctx.beginPath(); a.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); for (let i = b.length - 1; i >= 0; i--) ctx.lineTo(b[i][0], b[i][1]); ctx.closePath();
  };
  const mid: [number, number][] = Array.from({ length: N + 1 }, (_, i) => spine(i / N) as [number, number]);
  // soft drop shadow under the decal for depth
  g.save(); g.shadowColor = "rgba(40,30,0,0.25)"; g.shadowBlur = 6; g.shadowOffsetY = 2;
  g.fillStyle = LEAF_D; path(g, left, right); g.fill(); g.restore();
  g.fillStyle = LEAF_L; path(g, left, mid); g.fill();
  // shading gradient across the light half
  const [mx, my] = spine(0.5);
  const gr = g.createLinearGradient(bx, by, mx, my); gr.addColorStop(0, "rgba(20,50,10,0.35)"); gr.addColorStop(1, "rgba(20,50,10,0)");
  g.fillStyle = gr; path(g, left, right); g.fill();
  // veins
  g.strokeStyle = "rgba(190,225,120,0.35)"; g.lineWidth = 1.4;
  for (let i = 4; i < N - 2; i += 3) {
    const t = i / N, [sx, sy] = spine(t), [tx2, ty2] = tang(t), hw = half(t) * 0.85;
    for (const s of [1, -1]) { g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + (-ty2 * s) * hw + tx2 * hw * 0.5, sy + (tx2 * s) * hw + ty2 * hw * 0.5); g.stroke(); }
  }
  // 2–3 clean splits per edge: thin paint-coloured slits running from the edge in along the veins, toward the tip
  g.strokeStyle = YEL; g.lineCap = "round";
  for (const sd of [1, -1]) for (const t of [0.34, 0.55, 0.74].map((q) => q + (R() - 0.5) * 0.06)) {
    if (sd < 0 && t > 0.7 && R() < 0.5) continue;
    const [sx, sy] = spine(t), [tx2, ty2] = tang(t), hw = half(t), vx = -ty2 * sd + tx2 * 0.55, vy = tx2 * sd + ty2 * 0.55, vl = Math.hypot(vx, vy);
    const ex = sx + (-ty2 * sd) * hw + tx2 * hw * 0.5, ey = sy + (tx2 * sd) * hw + ty2 * hw * 0.5, k = hw * (0.45 + R() * 0.2);
    g.lineWidth = Math.max(1.5, w * 0.035); g.beginPath(); g.moveTo(ex + (vx / vl) * 2, ey + (vy / vl) * 2); g.lineTo(ex - (vx / vl) * k, ey - (vy / vl) * k); g.stroke();
  }
  g.strokeStyle = LEAF_RIB; g.lineWidth = Math.max(2, w * 0.1); g.lineCap = "round";
  g.beginPath(); mid.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  // decal edge in the height map
  hg.fillStyle = gray(0.54); path(hg, left, right); hg.fill();
}

function paintCowl(): Layers<Canvas> {
  // x = profile (0 inner lip → 1 rear edge), y = around
  const W = 1024, H = 512, P = new Paint(W, H, YEL, 0.26), c = P.c;
  P.blotch(60, 31, 10, 60, 0.07); P.grain(2500, 32, 0.035);
  const band = (u0: number, u1: number, col: string, rough = 0.3) => {
    c.fillStyle = col; c.fillRect(u0 * W, 0, (u1 - u0) * W, H); P.r.fillStyle = gray(rough); P.r.fillRect(u0 * W, 0, (u1 - u0) * W, H);
    P.line(u0 * W, 0, u0 * W, H, 0.6, 0.25); P.line(u1 * W, 0, u1 * W, H, 0.6, 0.25);
  };
  band(0, 0.17, BROWN); band(0.36, 0.4, BROWN); band(0.46, 0.475, BROWN); band(0.94, 1, "#3b2a1c", 0.45);
  for (let k = 0; k < 4; k++) { const y = ((k + 0.5) / 4) * H; P.line(0.17 * W, y, 0.94 * W, y, 0.9, 0.3); P.rivets(0.17 * W, y, 0.94 * W, y, 8, 5, 2, 0.16);
    for (const u of [0.28, 0.6, 0.8]) { c.fillStyle = "#6a5a44"; c.fillRect(u * W - 7, y - 4, 14, 8); P.h.fillStyle = gray(0.78); P.h.fillRect(u * W - 7, y - 4, 14, 8); } }
  P.chips(0, 0, 0.2 * W, H, 120, 34, "200,170,130");
  return P.tex(4);
}
function paintNacelle(): Layers<Canvas> {
  // x = along the nacelle (front → rear), y = around (0 bottom → 0.5 top → 1 bottom)
  const W = 1024, H = 512, P = new Paint(W, H, YEL, 0.26), c = P.c;
  P.blotch(80, 41, 10, 60, 0.07); P.grain(3000, 42, 0.035);
  for (const x of [0.02, 0.3, 0.58, 0.85]) { P.line(x * W, 0, x * W, H, 1, 0.3); P.rivets(x * W, 0, x * W, H, 8, 4, 2, 0.15); }
  for (const y of [0.25, 0.75]) { P.line(0, y * H, W, y * H, 0.8, 0.25); }
  // (no exhaust soot — the target art's nacelles are clean lemon enamel; the streaks read as smudges)
  P.r.fillStyle = "rgba(255,255,255,0.15)"; P.r.fillRect(0, 0.2 * H, W * 0.6, 0.2 * H); P.r.fillRect(0, 0.6 * H, W * 0.6, 0.2 * H);
  // oil cooler intake on the belly
  c.fillStyle = "#1b1511"; c.beginPath(); c.roundRect(0.05 * W, H - 30, 0.14 * W, 30, 8); c.fill(); c.beginPath(); c.roundRect(0.05 * W, 0, 0.14 * W, 30, 8); c.fill();
  return P.tex(4);
}
function paintSponson(): Layers<Canvas> {
  // x = along (front → rear), y = around the sponson section (0 = bottom)
  const W = 1024, H = 256, P = new Paint(W, H, YEL, 0.26), c = P.c;
  P.blotch(60, 51, 10, 50, 0.07); P.grain(1500, 52, 0.035);
  for (const x of [0.12, 0.3, 0.5, 0.7, 0.86]) { P.line(x * W, 0, x * W, H, 1, 0.3); P.rivets(x * W, 0, x * W, H, 8, 4, 2, 0.15); }
  P.line(0, H * 0.25, W, H * 0.25, 0.8, 0.25); P.line(0, H * 0.75, W, H * 0.75, 0.8, 0.25);
  // wheel-well slot (both canvas edges = bottom)
  for (const [y, h] of [[0, 20], [H - 20, 20]]) { c.fillStyle = "#15100c"; c.fillRect(0.1 * W, y, 0.63 * W, h); P.r.fillStyle = gray(0.85); P.r.fillRect(0.1 * W, y, 0.63 * W, h); }
  const gr = c.createLinearGradient(0, 0, 0, H * 0.3); gr.addColorStop(0, "rgba(80,50,15,0.4)"); gr.addColorStop(1, "rgba(80,50,15,0)"); c.fillStyle = gr; c.fillRect(0, 0, W, H * 0.3);
  const gr2 = c.createLinearGradient(0, H, 0, H * 0.7); gr2.addColorStop(0, "rgba(80,50,15,0.4)"); gr2.addColorStop(1, "rgba(80,50,15,0)"); c.fillStyle = gr2; c.fillRect(0, H * 0.7, W, H * 0.3);
  P.chips(0, 0, W * 0.15, H, 80, 53, "220,200,160");
  return P.tex(4);
}
function paintTyre(): Layers<Canvas> {
  // x = profile (0 → 1 across: inner rim, sidewall, tread, sidewall, outer rim), y = around
  const W = 256, H = 1024, P = new Paint(W, H, "#262422", 0.86), c = P.c;
  P.blotch(40, 61, 6, 30, 0.08, ["120,110,95", "0,0,0"]);
  // sidewall rings
  for (const u of [0.1, 0.16, 0.84, 0.9]) { c.fillStyle = "rgba(90,85,78,0.5)"; c.fillRect(u * W, 0, 2, H); P.h.fillStyle = gray(0.62); P.h.fillRect(u * W, 0, 2, H); }
  // chevron tread blocks
  const n = 36;
  for (let i = 0; i < n; i++) {
    const y = (i / n) * H;
    for (const s of [1, -1]) {
      P.h.fillStyle = gray(0.2); P.h.beginPath();
      const x0 = W * 0.5, x1 = W * (0.5 + s * 0.2);
      P.h.moveTo(x0, y); P.h.lineTo(x1, y + H / n * 0.55); P.h.lineTo(x1, y + H / n * 0.75); P.h.lineTo(x0, y + H / n * 0.2); P.h.closePath(); P.h.fill();
      c.fillStyle = "rgba(10,10,10,0.55)"; c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y + H / n * 0.55); c.lineTo(x1, y + H / n * 0.75); c.lineTo(x0, y + H / n * 0.2); c.closePath(); c.fill();
    }
  }
  c.fillStyle = "rgba(180,160,120,0.12)"; c.fillRect(W * 0.3, 0, W * 0.4, H); // dust on the tread
  return P.tex(6);
}
function paintTreadplate(): Layers<Canvas> {
  const W = 512, H = 512, P = new Paint(W, H, "#8d9093", 0.42), c = P.c;
  P.blotch(90, 71, 10, 60, 0.12, ["60,55,48", "200,200,205"]);
  const s = 32;
  for (let y = 0; y < H + s; y += s) for (let x = 0; x < W + s; x += s) {
    const odd = ((y / s) | 0) % 2, cx = x + (odd ? s / 2 : 0), cy = y, ang = odd ? 0.8 : -0.8;
    for (const [g, st] of [[P.h, gray(0.85)], [c, "rgba(230,232,236,0.45)"]] as const) {
      g.save(); g.translate(cx, cy); g.rotate(ang); g.fillStyle = st; g.beginPath(); g.ellipse(0, 0, 11, 3, 0, 0, TAU); g.fill(); g.restore();
    }
  }
  // dirt in the recesses
  const R = rng(72);
  for (let i = 0; i < 400; i++) { c.fillStyle = `rgba(50,40,30,${0.05 + R() * 0.1})`; c.fillRect(R() * W, R() * H, 2 + R() * 10, 2 + R() * 10); }
  return P.tex(6);
}
function paintCrate(): Layers<Canvas> {
  const W = 512, H = 512, P = new Paint(W, H, "#b88a4e", 0.8), c = P.c;
  const R = rng(91);
  for (let i = 0; i < 5; i++) {
    const y = (i / 5) * H, tone = 0.85 + R() * 0.3;
    c.fillStyle = `rgba(${Math.round(184 * tone)},${Math.round(138 * tone)},${Math.round(78 * tone)},1)`; c.fillRect(0, y, W, H / 5);
    for (let k = 0; k < 40; k++) { c.fillStyle = `rgba(90,55,20,${0.08 + R() * 0.12})`; c.fillRect(0, y + R() * H / 5, W, 1 + R() * 2); }
    P.line(0, y, W, y, 1.6, 0.6);
  }
  // frame battens + nails
  for (const [x, y, w, h] of [[0, 0, W, 34], [0, H - 34, W, 34], [0, 0, 34, H], [W - 34, 0, 34, H]] as const) {
    c.fillStyle = "#9c6d36"; c.fillRect(x, y, w, h); P.h.fillStyle = gray(0.7); P.h.fillRect(x, y, w, h);
  }
  for (const [x, y] of [[17, 17], [W - 17, 17], [17, H - 17], [W - 17, H - 17]]) { c.fillStyle = "#3a3632"; c.beginPath(); c.arc(x, y, 5, 0, TAU); c.fill(); }
  stencil(c, "BANANA CO.", W / 2, H / 2, 58, 1, 1, "rgba(60,32,12,0.88)", W * 0.8);
  P.chips(0, 0, W, H, 120, 92, "230,200,150");
  return P.tex(4);
}
function paintPropDisc(): Canvas {
  // a spinning 4-blade prop as the eye (and the target art) sees it: each blade a dark paddle with a yellow tip, smeared
  // backwards over ~40° (strong at the leading edge, fading trail), over a faint full-disc haze and a yellow tip ring
  const S = 1024, cv = mkCanvas(S, S), g = g2d(cv), C = S / 2, R0 = C * 0.98;
  g.clearRect(0, 0, S, S);
  const gr = g.createRadialGradient(C, C, R0 * 0.2, C, C, R0);
  gr.addColorStop(0, "rgba(40,32,24,0.0)"); gr.addColorStop(0.28, "rgba(40,32,24,0.24)"); gr.addColorStop(0.9, "rgba(40,32,24,0.3)"); gr.addColorStop(1, "rgba(40,32,24,0.12)");
  g.fillStyle = gr; g.beginPath(); g.arc(C, C, R0, 0, TAU); g.fill();
  const blade = (ang: number, alpha: number, tip: boolean) => {
    g.save(); g.translate(C, C); g.rotate(ang);
    const r0 = R0 * 0.2, r1 = R0 * 0.985;
    g.fillStyle = `rgba(30,23,18,${alpha})`;
    g.beginPath(); g.moveTo(r0, -R0 * 0.045); g.quadraticCurveTo(R0 * 0.55, -R0 * 0.1, r1 * 0.95, -R0 * 0.065); g.quadraticCurveTo(r1, 0, r1 * 0.95, R0 * 0.06);
    g.quadraticCurveTo(R0 * 0.55, R0 * 0.08, r0, R0 * 0.045); g.closePath(); g.fill();
    if (tip) {
      g.fillStyle = `rgba(246,192,34,${Math.min(1, alpha * 1.15)})`;
      g.beginPath(); g.moveTo(r1 * 0.86, -R0 * 0.07); g.quadraticCurveTo(r1, -R0 * 0.03, r1, 0); g.quadraticCurveTo(r1, R0 * 0.03, r1 * 0.86, R0 * 0.066); g.closePath(); g.fill();
    }
    g.restore();
  };
  for (let k = 0; k < 4; k++) {
    for (let s = 34; s >= 1; s--) blade((k * Math.PI) / 2 - s * 0.021, 0.24 * Math.pow(1 - s / 35, 2.0), true);
    blade((k * Math.PI) / 2, 0.8, true);
  }
  g.strokeStyle = "rgba(245,190,30,0.38)"; g.lineWidth = R0 * 0.07; g.beginPath(); g.arc(C, C, R0 * 0.94, 0, TAU); g.stroke();
  return cv;
}
/** yellow painted cabin wall tile (1.6 × 1.6 m, repeat): panels between the frame seams, rivet rows, stencils, wear */
function paintCabinWall(): Layers<Canvas> {
  const W = 1024, H = 1024, P = new Paint(W, H, "#efc21a", 0.62), c = P.c;
  P.blotch(90, 301, 30, 160, 0.14, ["255,236,150", "150,96,0"]);
  // vertical seams (under the frames) at u = 0, .5 and horizontal panel seams every 0.4 m
  for (const x of [0, W / 2]) { P.line(x + 1, 0, x + 1, H, 1.4, 0.4); P.rivets(x + 14, 0, x + 14, H, 16, 0, 1, 0.3); P.rivets(x - 14 + (x ? 0 : W), 0, x - 14 + (x ? 0 : W), H, 16, 0, 1, 0.3); }
  for (let y = 0; y < H; y += H / 4) { P.line(0, y + 1, W, y + 1, 1, 0.34); P.rivets(0, y + 10, W, y + 10, 18, 0, 1, 0.24); }
  // access hatches + a few stencils
  P.hatch(W * 0.12, H * 0.58, W * 0.24, H * 0.12, 8);
  P.hatch(W * 0.64, H * 0.08, W * 0.2, H * 0.1, 8);
  // scuffs + grime runs down from the rivet rows
  P.chips(0, 0, W, H, 70, 303, "210,180,110");
  const R = rng(305);
  for (let i = 0; i < 40; i++) { const x = R() * W, y = R() * H, l = 20 + R() * 80; const g = c.createLinearGradient(x, y, x, y + l); g.addColorStop(0, "rgba(110,70,10,0.22)"); g.addColorStop(1, "rgba(110,70,10,0)"); c.fillStyle = g; c.fillRect(x, y, 2 + R() * 3, l); }
  P.grain(9000, 307, 0.05);
  return P.tex(3);
}
/** red seat webbing (repeat): woven strap basket weave with stitched borders */
function paintWebbing(): Layers<Canvas> {
  // red padded seat vinyl: 5 rolled vertical channels (lit crowns, dark stitched seams), a piped border, wear on the crowns
  const W = 256, H = 256, P = new Paint(W, H, "#b0291b", 0.72), c = P.c;
  const n = 5, s = W / n;
  for (let i = 0; i < n; i++) {
    const g = c.createLinearGradient(i * s, 0, (i + 1) * s, 0);
    g.addColorStop(0, "rgba(40,0,0,0.42)"); g.addColorStop(0.18, "rgba(255,120,90,0.05)"); g.addColorStop(0.5, "rgba(255,150,120,0.16)"); g.addColorStop(0.82, "rgba(255,120,90,0.02)"); g.addColorStop(1, "rgba(40,0,0,0.42)");
    c.fillStyle = g; c.fillRect(i * s, 0, s, H);
    const hg = P.h.createLinearGradient(i * s, 0, (i + 1) * s, 0); hg.addColorStop(0, gray(0.15)); hg.addColorStop(0.5, gray(0.8)); hg.addColorStop(1, gray(0.15));
    P.h.fillStyle = hg; P.h.fillRect(i * s, 0, s, H);
    c.strokeStyle = "rgba(255,220,200,0.18)"; c.setLineDash([4, 4]); c.lineWidth = 1; c.beginPath(); c.moveTo(i * s + 3, 0); c.lineTo(i * s + 3, H); c.stroke(); c.setLineDash([]);
  }
  c.strokeStyle = "rgba(50,5,0,0.6)"; c.lineWidth = 6; c.strokeRect(3, 3, W - 6, H - 6);
  P.chips(0, 0, W, H, 30, 311, "220,120,100");
  P.grain(2500, 309, 0.05);
  return P.tex(2);
}
/** diagonal yellow / black hazard stripes (repeat along u) */
function paintHazard(): Canvas {
  const c = mkCanvas(64, 32), g = g2d(c);
  g.fillStyle = "#e9b50f"; g.fillRect(0, 0, 64, 32);
  g.fillStyle = "#1c1a17"; for (let x = -32; x < 96; x += 32) { g.beginPath(); g.moveTo(x, 32); g.lineTo(x + 16, 32); g.lineTo(x + 32, 0); g.lineTo(x + 16, 0); g.closePath(); g.fill(); }
  return c;
}
/** porthole view: bright sky → sea gradient (unlit — the glass shows the daylight outside) */
function paintPortholeGlass(): Canvas {
  const c = mkCanvas(64, 64), g = g2d(c);
  const gr = g.createLinearGradient(0, 0, 0, 64); gr.addColorStop(0, "#bfe6ff"); gr.addColorStop(0.55, "#8fd0ff"); gr.addColorStop(0.62, "#3fb7d8"); gr.addColorStop(1, "#1f86b8");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  const hl = g.createRadialGradient(22, 20, 0, 22, 20, 30); hl.addColorStop(0, "rgba(255,255,255,0.55)"); hl.addColorStop(1, "rgba(255,255,255,0)"); g.fillStyle = hl; g.fillRect(0, 0, 64, 64);
  return c;
}

export const PLANE_PAINT = {
  fT: paintFuselage,
  wT: () => paintLift(2048, 512, { half: WING_HALF, tipBrown: WING_TIP_BROWN, seams: [2.25, 5.0, 6.6, 11.0, 15.2], hingeXc: 0.72, hingeFrom: 2.25, hingeTo: 15.2, ribs: 1.15, stripe: true, seed: 101 }),
  sT: () => paintLift(1024, 256, { half: STAB_HALF, tipBrown: STAB_HALF - 0.85, seams: [0.7, 2.9, 5.4], hingeXc: 0.68, hingeFrom: 0.7, hingeTo: 5.4, ribs: 0.9, seed: 202 }),
  finT: paintFin, cT: paintCowl, nT: paintNacelle, spT: paintSponson, tyT: paintTyre,
  trT: paintTreadplate, inT: paintCabinWall, webT: paintWebbing,
  hazT: paintHazard, pgT: paintPortholeGlass, crT: paintCrate, discT: paintPropDisc,
};
export type PaintName = keyof typeof PLANE_PAINT;
export const PAINT_NAMES = Object.keys(PLANE_PAINT) as PaintName[];
export type PlanePainted<T> = { [K in PaintName]: ReturnType<(typeof PLANE_PAINT)[K]> extends Canvas ? T : Layers<T> };
