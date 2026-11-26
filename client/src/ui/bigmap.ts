// Full-screen map (M): painted island, bold POI labels, white safe circle, dark purple
// storm with crawling energy veins outside it, dotted yellow flight path with a moving plane, player / squad /
// drop markers, cream frame with yellow accents, phase + timer legend. Click = drop marker, right-click = remove,
// wheel = zoom, drag = pan.
import type { HudState } from "./api";
import type { PaintedMap } from "./mapimage";
import type { POIS } from "../../../shared/world/map";
import { drawGlyph, svgGlyph } from "./icons";
import { drawPoiIcon } from "./poiicons";
import { UI, U, addCss } from "./styles";
import { airstrikeOverlay, bountyRing, drawPin, heliDot, hotDropHalo, mateMarker, planeAt, playerArrow, shotDot, standDot, tukDot, tukMe, uavEnemyDot, uavOverlay, SQUAD_COLOURS } from "./minimap";
import { AIRSTRIKE } from "../../../shared/sim/const";
import { preferences } from "../settings/preferences";
import { backText, bindingText, glyphFamily, onLabelsChange } from "../settings/labels";
import { device } from "../settings/device";
import { glyph, PB } from "../settings/pad";

/** what the controller asks of the open map this frame (game/index.ts reads the pad) */
export interface MapPad { mx: number; my: number; px: number; py: number; zoom: number; place: boolean; clear: boolean }

const fmt = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s)) % 60).padStart(2, "0")}`;
/** world rect the default view frames (the island + a sea margin) */
const VIEW_CX = -10, VIEW_CZ = -60, VIEW_SPAN = 1880;

addCss("kr-ui-map", `
.kr-mapv { position: absolute; inset: 0; pointer-events: auto; background: #140a26; overflow: hidden; cursor: crosshair; font-family: ${UI.sans}; }
.kr-mapv canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.kr-mapv svg.frame { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.kr-mapv .legend { position: absolute; right: ${U(62)}; top: ${U(54)}; width: ${U(360)}; padding: ${U(18)} ${U(22)} ${U(16)};
  background: rgba(12,10,22,0.78); border: ${U(2)} solid rgba(255,212,0,0.85); border-radius: ${U(8)}; pointer-events: none;
  box-shadow: 0 ${U(6)} ${U(18)} rgba(0,0,0,0.35); }
.kr-mapv .legend .ph { font-family: ${UI.cond}; font-weight: 800; font-size: ${U(34)}; letter-spacing: ${U(3)}; color: ${UI.yellow}; line-height: 1; }
.kr-mapv .legend .tm { display: flex; align-items: center; gap: ${U(12)}; margin-top: ${U(10)}; font-size: ${U(40)}; font-weight: 800; color: ${UI.creamText}; line-height: 1; }
.kr-mapv .legend .tm svg { width: ${U(34)}; height: ${U(34)}; color: ${UI.creamText}; }
.kr-mapv .legend .tm small { font-size: ${U(19)}; font-weight: 700; letter-spacing: ${U(1.5)}; color: ${UI.creamDim}; margin-left: ${U(4)}; }
.kr-mapv .legend .rows { margin-top: ${U(14)}; padding-top: ${U(12)}; border-top: ${U(1.5)} solid rgba(246,239,198,0.18); display: grid; gap: ${U(9)}; }
.kr-mapv .legend .r { display: flex; align-items: center; gap: ${U(14)}; font-size: ${U(19)}; font-weight: 700; letter-spacing: ${U(1.4)}; color: ${UI.creamText}; }
.kr-mapv .legend .sw { width: ${U(40)}; height: ${U(22)}; flex: none; position: relative; }
.kr-mapv .legend .sw.ring { border: ${U(3)} solid #fff; border-radius: 50%; width: ${U(22)}; height: ${U(22)}; margin: 0 ${U(9)}; }
.kr-mapv .legend .sw.storm { background: linear-gradient(135deg, #2a1150, #6d3ad0 50%, #2a1150); border-radius: ${U(4)}; box-shadow: inset 0 0 0 ${U(1.5)} #c9a4ff; }
.kr-mapv .legend .sw.path { background: radial-gradient(circle, #ffd21f 45%, transparent 50%) 0 50% / ${U(13)} ${U(13)} repeat-x; }
.kr-mapv .legend .sw svg { width: 100%; height: 100%; }
.kr-mapv .alive { position: absolute; left: 50%; top: ${U(34)}; transform: translateX(-50%); display: flex; align-items: center; gap: ${U(14)};
  height: ${U(62)}; padding: 0 ${U(24)}; background: rgba(12,10,22,0.78); border: ${U(2)} solid rgba(255,212,0,0.85); border-radius: ${U(6)};
  font-size: ${U(34)}; font-weight: 800; color: ${UI.creamText}; pointer-events: none; white-space: nowrap; }
.kr-mapv .alive svg { width: ${U(26)}; height: ${U(32)}; color: ${UI.creamText}; }
.kr-mapv .alive i { width: ${U(2)}; height: ${U(30)}; background: rgba(246,239,198,0.3); margin: 0 ${U(6)}; }
.kr-mapv .alive small { font-family: ${UI.cond}; font-size: ${U(22)}; letter-spacing: ${U(2)}; color: ${UI.creamDim}; font-weight: 800; }
.kr-mapv .keys { position: absolute; left: 50%; bottom: ${U(38)}; transform: translateX(-50%); display: flex; gap: ${U(26)}; pointer-events: none; white-space: nowrap;
  padding: ${U(10)} ${U(22)}; background: rgba(12,10,22,0.7); border-radius: ${U(8)}; }
.kr-mapv .keys span { display: flex; align-items: center; gap: ${U(10)}; font-size: ${U(19)}; font-weight: 700; letter-spacing: ${U(1.5)}; color: ${UI.creamText}; }
.kr-mapv .padcur { position: absolute; left: 0; top: 0; width: ${U(84)}; height: ${U(84)}; margin: ${U(-42)} 0 0 ${U(-42)}; pointer-events: none; display: none; }
html.kr-pad .kr-mapv .padcur.on { display: block; }
.kr-mapv .padcur::before { content: ""; position: absolute; inset: ${U(14)}; border: ${U(4)} solid ${UI.yellow}; border-radius: 50%; box-shadow: 0 0 ${U(10)} rgba(0,0,0,0.6), inset 0 0 ${U(6)} rgba(0,0,0,0.4); }
.kr-mapv .padcur::after { content: ""; position: absolute; left: 50%; top: 50%; width: ${U(10)}; height: ${U(10)}; margin: ${U(-5)} 0 0 ${U(-5)}; border-radius: 50%; background: ${UI.cream}; box-shadow: 0 0 ${U(4)} rgba(0,0,0,0.7); }
.kr-mapv .padcur i { position: absolute; background: ${UI.cream}; box-shadow: 0 0 ${U(3)} rgba(0,0,0,0.7); }
.kr-mapv .padcur i:nth-child(1), .kr-mapv .padcur i:nth-child(2) { left: 50%; width: ${U(4)}; height: ${U(16)}; margin-left: ${U(-2)}; }
.kr-mapv .padcur i:nth-child(1) { top: 0; } .kr-mapv .padcur i:nth-child(2) { bottom: 0; }
.kr-mapv .padcur i:nth-child(3), .kr-mapv .padcur i:nth-child(4) { top: 50%; height: ${U(4)}; width: ${U(16)}; margin-top: ${U(-2)}; }
.kr-mapv .padcur i:nth-child(3) { left: 0; } .kr-mapv .padcur i:nth-child(4) { right: 0; }
.kr-mapv .keys kbd { font-family: ${UI.sans}; font-size: ${U(16)}; font-weight: 900; color: ${UI.inkDark}; background: ${UI.cream};
  border-radius: ${U(4)}; padding: ${U(4)} ${U(8)}; box-shadow: 0 ${U(2)} 0 rgba(0,0,0,0.5); }
`);

/** label candidates in units of (half label width + gap, half label height + gap): centre, below, above, right, left, diagonals */
const LBL_CANDS: Array<[number, number]> = [[0, 0]];
for (const k of [1, 1.9, 2.8, 3.8]) for (const [ox, oy] of [[0, 1.25], [0, -1.25], [1, 0], [-1, 0], [0.85, 1.2], [-0.85, 1.2], [0.85, -1.2], [-0.85, -1.2]]) LBL_CANDS.push([ox * k, oy * k]);
const LBL_OBST: number[][] = [], LBL_PLACED: number[][] = [];
export class BigMap {
  readonly el = document.createElement("div");
  private base = document.createElement("canvas");
  private fx = document.createElement("canvas");
  private bg = this.base.getContext("2d")!;
  private g = this.fx.getContext("2d")!;
  private frame: SVGSVGElement;
  private phEl: HTMLElement; private tmEl: HTMLElement; private tmSub: HTMLElement; private aliveEl: HTMLElement; private squadsEl: HTMLElement;
  private W = 0; private H = 0; private dpr = 1; private u = 1;
  private zoom = 1; private cx = VIEW_CX; private cz = VIEW_CZ;
  private baseSig = "";
  private veins: HTMLCanvasElement[] = [];
  private vLayer: HTMLCanvasElement | null = null;
  private veinLayer(W: number, H: number, d: number): HTMLCanvasElement {
    const w = Math.round(W * d), h = Math.round(H * d);
    if (!this.vLayer) this.vLayer = document.createElement("canvas");
    if (this.vLayer.width !== w || this.vLayer.height !== h) { this.vLayer.width = w; this.vLayer.height = h; }
    return this.vLayer;
  }
  private pending: { x: number; z: number } | null = null;
  private lastTxt = "";
  private poiOrder: typeof POIS[number][] | null = null;
  private textW = new Map<string, number>();
  onClick: ((x: number, z: number) => void) | null = null;
  onClear: (() => void) | null = null;
  private cleared = false;
  /** the controller's reticle (screen px; -1 = centre it on the next pad frame) */
  private cur = document.createElement("div"); private curX = -1; private curY = -1;

  constructor(private map: PaintedMap, private pois: typeof POIS) {
    this.el.className = "kr-mapv kr-hide";
    this.el.append(this.base, this.fx);
    this.frame = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.frame.setAttribute("class", "frame");
    this.el.appendChild(this.frame);
    // top-centre: alive + squads
    this.aliveEl = document.createElement("div");
    this.aliveEl.className = "alive";
    this.aliveEl.appendChild(svgGlyph("person"));
    const av = document.createElement("span"); this.aliveEl.appendChild(av);
    const sep = document.createElement("i"); this.aliveEl.appendChild(sep);
    this.squadsEl = document.createElement("small"); this.aliveEl.appendChild(this.squadsEl);
    this.aliveEl.dataset.v = "";
    (this.aliveEl as HTMLElement & { _v: HTMLElement })._v = av;
    this.el.appendChild(this.aliveEl);
    // legend: phase + timer + keys to the symbols
    const lg = document.createElement("div"); lg.className = "legend";
    this.phEl = document.createElement("div"); this.phEl.className = "ph";
    const tm = document.createElement("div"); tm.className = "tm";
    tm.appendChild(svgGlyph("clock"));
    this.tmEl = document.createElement("span"); tm.appendChild(this.tmEl);
    this.tmSub = document.createElement("small"); tm.appendChild(this.tmSub);
    const rows = document.createElement("div"); rows.className = "rows";
    const row = (sw: HTMLElement, label: string) => { const r = document.createElement("div"); r.className = "r"; r.append(sw, label); rows.appendChild(r); };
    const sw = (cls: string) => { const d = document.createElement("div"); d.className = `sw ${cls}`; return d; };
    row(sw("ring"), "NEXT SAFE ZONE");
    row(sw("storm"), "STORM");
    row(sw("path"), "FLIGHT PATH");
    const pinSw = sw(""); const pc = document.createElement("canvas"); pc.width = 80; pc.height = 44; pc.style.cssText = "width:100%;height:100%";
    pinSw.appendChild(pc); row(pinSw, "YOUR DROP MARKER");
    const pg = pc.getContext("2d")!; drawPin(pg, 40, 42, 15);
    const gunSw = sw(""); const gc = document.createElement("canvas"); gc.width = 80; gc.height = 44; gc.style.cssText = "width:100%;height:100%";
    gunSw.appendChild(gc); row(gunSw, "GUNFIRE"); shotDot(gc.getContext("2d")!, 40, 22, 0.7, 14);
    // (economy) the Banana Stands and a bounty's circle
    const stSw = sw(""); const sc = document.createElement("canvas"); sc.width = 80; sc.height = 44; sc.style.cssText = "width:100%;height:100%";
    stSw.appendChild(sc); row(stSw, "BANANA STAND (BUY)"); standDot(sc.getContext("2d")!, 40, 22, 14);
    const bSw = sw(""); const bc = document.createElement("canvas"); bc.width = 80; bc.height = 44; bc.style.cssText = "width:100%;height:100%";
    bSw.appendChild(bc); row(bSw, "BOUNTY TARGET AREA"); bountyRing(bc.getContext("2d")!, 40, 22, 17, 0.4);
    const hdSw = sw(""); const hdc = document.createElement("canvas"); hdc.width = 80; hdc.height = 44; hdc.style.cssText = "width:100%;height:100%";
    hdSw.appendChild(hdc); row(hdSw, "HOT DROP (2× CASH)"); hotDropHalo(hdc.getContext("2d")!, 40, 22, 17, 0.5);
    lg.append(this.phEl, tm, rows);
    this.el.appendChild(lg);
    const keys = document.createElement("div"); keys.className = "keys";
    // the key strip names the device in hand: mouse + the map key, or the controller's buttons
    onLabelsChange(() => {
      const f = glyphFamily();
      const list: Array<[string, string]> = device.pad
        ? [[glyph(PB.A, f), "PLACE MARKER"], [glyph(PB.X, f), "REMOVE"], [`${glyph(PB.LT, f)} ${glyph(PB.RT, f)}`, "ZOOM"], [f === "playstation" ? "R-STICK" : "RS", "PAN"], [backText(), "CLOSE"]]
        : [["CLICK", "PLACE MARKER"], ["RIGHT-CLICK", "REMOVE"], ["WHEEL", "ZOOM"], [bindingText("map", 0).toUpperCase(), "CLOSE"]];
      keys.replaceChildren(...list.map(([k, l]) => { const s = document.createElement("span"); const kb = document.createElement("kbd"); kb.textContent = k; s.append(kb, l); return s; }));
    });
    this.el.appendChild(keys);
    this.cur.className = "padcur"; this.cur.innerHTML = "<i></i><i></i><i></i><i></i>"; this.el.appendChild(this.cur);
    this.bindInput();
  }

  // ------------------------------------------------------------ geometry
  private get ppm() { return (this.H * 0.93 / VIEW_SPAN) * this.zoom; }
  private toScreen(x: number, z: number): [number, number] { const k = this.ppm; return [this.W / 2 + (x - this.cx) * k, this.H / 2 + (z - this.cz) * k]; }
  private toWorld(sx: number, sy: number): [number, number] { const k = this.ppm; return [this.cx + (sx - this.W / 2) / k, this.cz + (sy - this.H / 2) / k]; }

  private resize() {
    const w = window.innerWidth, h = window.innerHeight, d = Math.min(2, window.devicePixelRatio || 1);
    if (w === this.W && h === this.H && d === this.dpr) return;
    this.W = w; this.H = h; this.dpr = d; this.u = h / 1440;
    for (const c of [this.base, this.fx]) { c.width = Math.round(w * d); c.height = Math.round(h * d); }
    this.baseSig = "";
    this.buildFrame();
  }

  private bindInput() {
    let down: { x: number; y: number; cx: number; cz: number; moved: boolean } | null = null;
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
    this.el.addEventListener("pointerdown", (e) => {
      if (e.button === 2) { this.pending = null; this.cleared = true; this.onClear?.(); return; }
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, cx: this.cx, cz: this.cz, moved: false };
      this.el.setPointerCapture(e.pointerId);
    });
    this.el.addEventListener("pointermove", (e) => {
      if (!down) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) < 6) return;
      down.moved = true;
      this.cx = down.cx - dx / this.ppm; this.cz = down.cz - dy / this.ppm;
      this.clampView();
    });
    this.el.addEventListener("pointerup", (e) => {
      if (!down) return;
      const wasDrag = down.moved;
      down = null;
      if (wasDrag) return;
      const [x, z] = this.toWorld(e.clientX, e.clientY);
      if (Math.abs(x) > this.map.half || Math.abs(z) > this.map.half) return;
      this.pending = { x, z }; this.cleared = false;
      this.onClick?.(x, z);
    });
    this.el.addEventListener("wheel", (e) => {
      e.preventDefault();
      const [wx, wz] = this.toWorld(e.clientX, e.clientY);
      this.zoom = Math.max(1, Math.min(4, this.zoom * Math.exp(-e.deltaY * 0.0015)));
      // keep the point under the cursor fixed
      const k = this.ppm;
      this.cx = wx - (e.clientX - this.W / 2) / k; this.cz = wz - (e.clientY - this.H / 2) / k;
      this.clampView();
    }, { passive: false });
  }
  private clampView() {
    const lim = this.map.half - (this.W / 2) / this.ppm * 0.3;
    this.cx = Math.max(-lim, Math.min(lim, this.cx)); this.cz = Math.max(-lim, Math.min(lim, this.cz));
    if (this.zoom === 1) { this.cx = VIEW_CX; this.cz = VIEW_CZ; }
  }
  open() { this.el.classList.remove("kr-hide"); this.zoom = 1; this.cx = VIEW_CX; this.cz = VIEW_CZ; this.curX = this.curY = -1; this.cur.classList.remove("on"); }
  close() { this.el.classList.add("kr-hide"); }

  /** one frame of controller input on the open map: the left stick moves the reticle (pushing it into the edge pans
   *  when zoomed in), the right stick pans, the triggers zoom around the reticle, A marks, X removes */
  pad(dt: number, c: MapPad) {
    if (this.W === 0) return;
    if (this.curX < 0) { this.curX = this.W / 2; this.curY = this.H / 2; }
    this.cur.classList.add("on");
    const speed = this.H * 0.75, m = Math.min(this.W, this.H) * 0.06;
    this.curX += c.mx * speed * dt; this.curY += c.my * speed * dt;
    // pushed past the edge: the map scrolls under the reticle
    const ox = this.curX < m ? this.curX - m : this.curX > this.W - m ? this.curX - (this.W - m) : 0;
    const oy = this.curY < m ? this.curY - m : this.curY > this.H - m ? this.curY - (this.H - m) : 0;
    this.curX = Math.max(m, Math.min(this.W - m, this.curX)); this.curY = Math.max(m, Math.min(this.H - m, this.curY));
    let px = c.px * speed * dt + ox, py = c.py * speed * dt + oy;
    if (this.zoom <= 1) px = py = 0;
    if (px || py) { this.cx += px / this.ppm; this.cz += py / this.ppm; this.clampView(); }
    if (c.zoom) {
      const [wx, wz] = this.toWorld(this.curX, this.curY);
      this.zoom = Math.max(1, Math.min(4, this.zoom * Math.exp(c.zoom * dt * 2.4)));
      const k = this.ppm;
      this.cx = wx - (this.curX - this.W / 2) / k; this.cz = wz - (this.curY - this.H / 2) / k;
      this.clampView();
    }
    if (c.place) {
      const [x, z] = this.toWorld(this.curX, this.curY);
      if (Math.abs(x) <= this.map.half && Math.abs(z) <= this.map.half) { this.pending = { x, z }; this.cleared = false; this.onClick?.(x, z); }
    }
    if (c.clear) { this.pending = null; this.cleared = true; this.onClear?.(); }
    this.cur.style.transform = `translate(${this.curX.toFixed(1)}px, ${this.curY.toFixed(1)}px)`;
  }

  // ------------------------------------------------------------ frame (SVG, rebuilt on resize)
  private buildFrame() {
    const H = 1440, W = Math.round(this.W / this.u);
    const t = 16, b = 16, l = 26, r = 26;
    // inner window polygon (clockwise), with the frame's notches and side bumps
    const inner: Array<[number, number]> = [
      [l, 104], [l + 146, 104], [l + 222, t], [W - r - 34, t], [W - r, t + 34],
      [W - r, 470], [W - r - 20, 490], [W - r - 20, 760], [W - r, 780],
      [W - r, H - 150], [W - r - 62, H - 88], [W - 262, H - 88], [W - 334, H - b], [l + 34, H - b], [l, H - b - 34],
      [l, 760], [l + 20, 740], [l + 20, 450], [l, 430],
    ];
    const poly = "M" + inner.map((p) => p.join(",")).join("L") + "Z";
    const R = 30;
    const outer = `M${R},0H${W - R}Q${W},0 ${W},${R}V${H - R}Q${W},${H} ${W - R},${H}H${R}Q0,${H} 0,${H - R}V${R}Q0,0 ${R},0Z`;
    const stripes = (x0: number, y0: number, n: number, w: number, h: number, gap: number, col: string, skew: number) =>
      Array.from({ length: n }, (_, i) => { const x = x0 + i * (w + gap); return `<path d="M${x + skew},${y0}H${x + skew + w}L${x + w},${y0 + h}H${x}Z" fill="${col}"/>`; }).join("");
    this.frame.setAttribute("viewBox", `0 0 ${W} ${H}`);
    this.frame.setAttribute("preserveAspectRatio", "none");
    this.frame.innerHTML = `
      <defs>
        <clipPath id="krmf-in"><path d="${poly}"/></clipPath>
        <clipPath id="krmf-out"><path d="${outer} ${poly}" clip-rule="evenodd"/></clipPath>
        <linearGradient id="krmf-cream" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbf5d8"/><stop offset="1" stop-color="#eee3b8"/></linearGradient>
        <radialGradient id="krmf-vig" cx="50%" cy="50%" r="75%"><stop offset="0.62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#05020c" stop-opacity="0.55"/></radialGradient>
      </defs>
      <rect x="0" y="0" width="${W}" height="${H}" fill="url(#krmf-vig)" clip-path="url(#krmf-in)"/>
      <path d="${outer} ${poly}" fill="url(#krmf-cream)" fill-rule="evenodd"/>
      <path d="${poly}" fill="none" stroke="#f2bf14" stroke-width="12" stroke-linejoin="round" clip-path="url(#krmf-out)"/>
      <path d="${poly}" fill="none" stroke="#17120a" stroke-width="11" stroke-linejoin="round" clip-path="url(#krmf-in)"/>
      ${stripes(40, 24, 3, 30, 50, 22, "#23201a", 20)}
      ${stripes(W - 250, H - 62, 1, 118, 22, 0, "#f2bf14", 14)}${stripes(W - 116, H - 62, 1, 84, 22, 0, "#23201a", 14)}
      ${stripes(W - 300, H - 34, 1, 150, 18, 0, "#23201a", 12)}${stripes(W - 140, H - 34, 1, 104, 18, 0, "#f2bf14", 12)}
      ${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${W - r - 13}" y="${520 + i * 38}" width="6" height="22" rx="2" fill="#f2bf14"/>`).join("")}
      ${[0, 1, 2, 3, 4, 5].map((i) => `<rect x="${l + 7}" y="${480 + i * 38}" width="6" height="22" rx="2" fill="#f2bf14"/>`).join("")}
      <g transform="translate(118 ${H - 120})">
        <circle r="92" fill="#f6efcb"/>
        <circle r="80" fill="#15110a" stroke="#f2bf14" stroke-width="9"/>
        <g transform="translate(-52 -54) scale(1.05)"><path d="${"M17 20C10 50 24 82 58 88C73 91 88 86 95 78C80 82 62 79 49 70C35 60 27 43 27 22Z"}" fill="#ffd400"/><path d="M15 22L14 11L24 8L27 21Z" fill="#8a5a1c"/></g>
      </g>`;
  }

  // ------------------------------------------------------------ storm vein tiles (built lazily on first open)
  private buildVeins() {
    const P = 384;
    const lat = (x: number, y: number, seed: number, period: number) => {
      x = ((x % period) + period) % period; y = ((y % period) + period) % period;
      const n = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453; return n - Math.floor(n);
    };
    const vn = (x: number, y: number, seed: number, cells: number) => {
      const fx = (x / P) * cells, fy = (y / P) * cells, xi = Math.floor(fx), yi = Math.floor(fy), tx = fx - xi, ty = fy - yi;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = lat(xi, yi, seed, cells), b = lat(xi + 1, yi, seed, cells), c = lat(xi, yi + 1, seed, cells), d = lat(xi + 1, yi + 1, seed, cells);
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    };
    for (let n = 0; n < 2; n++) {
      const t = document.createElement("canvas"); t.width = t.height = P;
      const g = t.getContext("2d")!; const img = g.createImageData(P, P);
      for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
        const f = vn(x, y, n, 3) * 0.5 + vn(x, y, n + 3, 6) * 0.28 + vn(x, y, n + 7, 12) * 0.14 + vn(x, y, n + 11, 24) * 0.08;
        const ridge = 1 - Math.abs(2 * f - 1);
        const v = Math.max(0, ridge - 0.8) / 0.2, vein = v * v;
        const glow = Math.max(0, ridge - 0.6) / 0.4;
        const k = (y * P + x) * 4;
        img.data[k] = 120 + vein * 120; img.data[k + 1] = 70 + vein * 150; img.data[k + 2] = 230 + vein * 25;
        img.data[k + 3] = Math.min(255, glow * glow * 70 + vein * 200);
      }
      g.putImageData(img, 0, 0);
      this.veins.push(t);
    }
  }

  // ------------------------------------------------------------ per frame (only while open)
  update(s: HudState, now: number) {
    this.resize();
    if (!this.veins.length) this.buildVeins();
    const d = this.dpr;
    // ---- static island layer
    const sig = `${this.map.version}|${this.W}x${this.H}|${this.zoom.toFixed(3)}|${this.cx.toFixed(1)},${this.cz.toFixed(1)}`;
    if (sig !== this.baseSig) {
      this.baseSig = sig;
      const g = this.bg;
      g.setTransform(d, 0, 0, d, 0, 0);
      g.fillStyle = this.map.seaCss;
      g.fillRect(0, 0, this.W, this.H);
      const [x0, y0] = this.toScreen(-this.map.half, -this.map.half);
      const side = this.map.half * 2 * this.ppm;
      g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
      g.drawImage(this.map.canvas, x0, y0, side, side);
    }
    // ---- storm + overlays
    const g = this.g, W = this.W, H = this.H, u = this.u;
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, W, H);
    const k = this.ppm;
    const [sx, sy] = this.toScreen(s.safe.cx, s.safe.cz);
    const sr = s.safe.r * k;
    const stormOn = s.stormPhase > 0 || !!s.next || s.safe.r < this.map.half * 1.4;
    if (stormOn) {
      g.save();
      g.beginPath(); g.rect(0, 0, W, H); g.arc(sx, sy, sr, 0, Math.PI * 2, true); g.clip("evenodd");
      // a translucent violet veil (≤ 35 %) — the island stays readable under the storm; energy concentrates at the edge
      g.fillStyle = "rgba(52,20,110,0.32)";
      g.fillRect(0, 0, W, H);
      const deep = g.createRadialGradient(sx, sy, sr, sx, sy, sr + 260 * u);
      deep.addColorStop(0, "rgba(150,90,255,0.34)"); deep.addColorStop(0.3, "rgba(96,46,190,0.14)"); deep.addColorStop(1, "rgba(18,8,40,0)");
      g.fillStyle = deep; g.fillRect(0, 0, W, H);
      // energy veins: drawn on their own layer, then masked so they crowd the wall and fade out over the storm
      // (the whole storm under loud veins hid the island)
      const S0 = 620 * u, S1 = 900 * u;
      const t0 = (now * 14 * u) % S0, t1 = (now * -9 * u) % S1;
      const vl = this.veinLayer(W, H, d), vg = vl.getContext("2d")!;
      vg.setTransform(d, 0, 0, d, 0, 0); vg.globalCompositeOperation = "source-over"; vg.clearRect(0, 0, W, H);
      vg.globalAlpha = 0.9;
      for (let ty = -1; ty < H / S0 + 1; ty++) for (let tx = -1; tx < W / S0 + 1; tx++) vg.drawImage(this.veins[0], tx * S0 + t0, ty * S0 + t0 * 0.6, S0, S0);
      vg.globalAlpha = 0.55 + 0.2 * Math.sin(now * 2.3);
      for (let ty = -1; ty < H / S1 + 1; ty++) for (let tx = -1; tx < W / S1 + 1; tx++) vg.drawImage(this.veins[1], tx * S1 + t1, ty * S1 - t1 * 0.7, S1, S1);
      vg.globalAlpha = 1; vg.globalCompositeOperation = "destination-in";
      const mask = vg.createRadialGradient(sx, sy, sr, sx, sy, sr + 520 * u);
      mask.addColorStop(0, "rgba(0,0,0,0.42)"); mask.addColorStop(0.35, "rgba(0,0,0,0.2)"); mask.addColorStop(1, "rgba(0,0,0,0.06)");
      vg.fillStyle = mask; vg.fillRect(0, 0, W, H);
      vg.globalCompositeOperation = "source-over";
      g.globalCompositeOperation = "lighter";
      g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(vl, 0, 0); g.setTransform(d, 0, 0, d, 0, 0);
      g.globalCompositeOperation = "source-over";
      g.restore();
      // bright energy edge
      g.shadowColor = "rgba(190,140,255,0.95)"; g.shadowBlur = 16 * u;
      g.strokeStyle = "rgba(236,222,255,0.95)"; g.lineWidth = 3 * u;
      g.beginPath(); g.arc(sx, sy, sr, 0, Math.PI * 2); g.stroke();
      g.shadowBlur = 0;
    }
    // next safe zone: white ring
    const nz = s.next ?? (stormOn ? null : s.safe);
    if (nz) {
      const [nx, ny] = this.toScreen(nz.cx, nz.cz);
      g.strokeStyle = "rgba(0,0,0,0.22)"; g.lineWidth = 6 * u;
      g.beginPath(); g.arc(nx, ny, nz.r * k, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = "#ffffff"; g.lineWidth = 3.4 * u;
      g.beginPath(); g.arc(nx, ny, nz.r * k, 0, Math.PI * 2); g.stroke();
    }
    // Hot Drop POI golden zone halo
    if (s.hotDrop) {
      const [hx, hy] = this.toScreen(s.hotDrop.x, s.hotDrop.z);
      hotDropHalo(g, hx, hy, s.hotDrop.r * k, now);
    }
    // flight path: rounded yellow dashes + arrowheads, plane riding it
    if (s.plane) {
      const p = s.plane;
      const [ax, ay] = this.toScreen(p.x0, p.z0), [bx, by] = this.toScreen(p.x1, p.z1);
      const ang = Math.atan2(by - ay, bx - ax);
      const inset = 34 * u;
      const a2x = ax + Math.cos(ang) * inset, a2y = ay + Math.sin(ang) * inset, b2x = bx - Math.cos(ang) * inset, b2y = by - Math.sin(ang) * inset;
      g.lineCap = "round";
      g.setLineDash([9 * u, 21 * u]);
      g.lineDashOffset = -now * 40 * u;
      g.strokeStyle = "rgba(40,26,0,0.45)"; g.lineWidth = 14 * u;
      g.beginPath(); g.moveTo(a2x, a2y + 2 * u); g.lineTo(b2x, b2y + 2 * u); g.stroke();
      g.strokeStyle = "#ffd21f"; g.lineWidth = 11 * u;
      g.beginPath(); g.moveTo(a2x, a2y); g.lineTo(b2x, b2y); g.stroke();
      g.setLineDash([]); g.lineDashOffset = 0;
      const head = (x: number, y: number, a: number) => {
        g.save(); g.translate(x, y); g.rotate(a);
        g.beginPath(); g.moveTo(24 * u, 0); g.lineTo(-12 * u, -19 * u); g.lineTo(-12 * u, 19 * u); g.closePath();
        g.fillStyle = "#ffd21f"; g.shadowColor = "rgba(0,0,0,0.4)"; g.shadowBlur = 5 * u; g.fill(); g.shadowBlur = 0;
        g.restore();
      };
      head(ax + Math.cos(ang) * 10 * u, ay + Math.sin(ang) * 10 * u, ang + Math.PI);
      head(bx - Math.cos(ang) * 10 * u, by - Math.sin(ang) * 10 * u, ang);
      const pp = planeAt(s, now);
      const [px, py] = this.toScreen(pp.x, pp.z);
      g.save(); g.translate(px, py); g.rotate(ang + Math.PI / 2);
      g.shadowColor = "rgba(0,0,0,0.55)"; g.shadowBlur = 8 * u; g.shadowOffsetY = 3 * u;
      drawGlyph(g, "plane", -30 * u, -30 * u, 60 * u, 60 * u, "#17120a");
      g.shadowBlur = 0; g.shadowOffsetY = 0;
      drawGlyph(g, "plane", -25 * u, -25 * u, 50 * u, 50 * u, "#ffd400");
      g.restore();
    }
    // POI labels — placed AFTER the markers they must avoid are known (otherwise CANOPY LINE sat under the
    // player arrow + drop pin, RIPE PEAK touched MIST FALLS): greedy placement, biggest POIs first, each label tries its
    // centre then 8 offsets; a displaced label gets a leader line to a dot on the POI.
    const mk0 = this.cleared ? null : (s.dropMarker ?? this.pending);
    const obst = LBL_OBST; obst.length = 0;
    if (s.me.alive) { const [x, y] = this.toScreen(s.me.x, s.me.z); obst.push([x - 46 * u, y - 46 * u, x + 46 * u, y + 46 * u]); }
    if (mk0) { const [x, y] = this.toScreen(mk0.x, mk0.z); obst.push([x - 26 * u, y - 70 * u, x + 26 * u, y + 8 * u]); }
    for (const q of s.squad) { if (q.me) continue; const [x, y] = this.toScreen(q.x, q.z); obst.push([x - 60 * u, y - 46 * u, x + 60 * u, y + 20 * u]); }
    const fs = 40 * u;
    g.font = `800 ${fs}px 'Barlow Condensed', 'Arial Narrow', sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
    const placed = LBL_PLACED; placed.length = 0;
    const area = (a: number[], b: number[]) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const order = this.poiOrder ??= this.pois.filter((p) => p.id !== "lobby-islet").sort((a, b) => b.r - a.r);
    for (const p of order) {
      const [x, y] = this.toScreen(p.x, p.z);
      if (x < -200 || x > W + 200 || y < -50 || y > H + 50) continue;
      // the label carries the POI's landmark badge on its left (inside the box the placement avoids)
      const ir = fs * 0.62, iw = ir * 2 + 8 * u;
      const tw = (this.textW.get(p.name + fs) ?? (this.textW.set(p.name + fs, g.measureText(p.name).width), this.textW.get(p.name + fs)!)) + 14 * u + iw, th = Math.max(fs * 0.95, ir * 2 + 4 * u);
      // score every candidate: overlap with markers (×8) + with placed labels + a distance cost; the first clean one wins
      let best: number[] | null = null, bx = x, by = y, bestS = 1e18;
      for (const [ox, oy] of LBL_CANDS) {
        const cx = x + ox * (tw * 0.5 + 18 * u), cy = y + oy * (th * 0.5 + 22 * u);
        const r = [cx - tw / 2, cy - th / 2, cx + tw / 2, cy + th / 2];
        if (r[0] < 30 * u || r[2] > W - 30 * u || r[1] < 20 * u || r[3] > H - 20 * u) continue;
        let sc = Math.hypot(cx - x, cy - y) * 0.5;
        for (const o of obst) sc += 8 * area(r, o);
        for (const o of placed) sc += area(r, o);
        if (sc < bestS) { bestS = sc; best = r; bx = cx; by = cy; }
        if (sc <= Math.hypot(cx - x, cy - y) * 0.5 + 1e-6) break;
      }
      if (!best) { best = [x - tw / 2, y - th / 2, x + tw / 2, y + th / 2]; bx = x; by = y; }
      placed.push([best[0] - 10 * u, best[1] - 7 * u, best[2] + 10 * u, best[3] + 7 * u]);   // + a gap: labels never touch
      const moved = Math.hypot(bx - x, by - y) > 4 * u;
      if (moved) {
        // leader: from the label's nearest edge to a dot on the POI
        const ex = Math.max(best[0], Math.min(best[2], x)), ey = Math.max(best[1], Math.min(best[3], y));
        g.strokeStyle = "rgba(12,10,6,0.85)"; g.lineWidth = 5 * u; g.beginPath(); g.moveTo(ex, ey); g.lineTo(x, y); g.stroke();
        g.strokeStyle = "#fff"; g.lineWidth = 2.2 * u; g.beginPath(); g.moveTo(ex, ey); g.lineTo(x, y); g.stroke();
        g.fillStyle = "rgba(12,10,6,0.9)"; g.beginPath(); g.arc(x, y, 7 * u, 0, Math.PI * 2); g.fill();
        g.fillStyle = "#ffd400"; g.beginPath(); g.arc(x, y, 4.5 * u, 0, Math.PI * 2); g.fill();
      }
      const isHot = s.hotDrop?.id === p.id;
      g.lineWidth = 9 * u; g.strokeStyle = isHot ? "rgba(38,20,0,0.95)" : "rgba(12,10,6,0.92)";
      g.shadowColor = isHot ? "rgba(255,204,0,0.75)" : "rgba(0,0,0,0.5)"; g.shadowBlur = (isHot ? 14 : 6) * u; g.shadowOffsetY = 3 * u;
      g.strokeText(p.name, bx + iw / 2, by);
      g.shadowBlur = 0; g.shadowOffsetY = 0;
      g.fillStyle = isHot ? "#ffd21f" : "#ffffff";
      g.fillText(p.name, bx + iw / 2, by);
      drawPoiIcon(g, p.id, best[0] + 7 * u + ir, by, ir);
      if (isHot) {
        g.save();
        g.font = `900 ${19 * u}px 'Barlow Condensed', sans-serif`;
        const tag = "★ HOT DROP · 2× CASH";
        const tagW = g.measureText(tag).width + 18 * u, tagH = 26 * u, ty = by + fs * 0.68;
        g.fillStyle = "#ffd21f"; g.strokeStyle = "#17120a"; g.lineWidth = 3 * u;
        g.beginPath(); g.roundRect(bx + iw / 2 - tagW / 2, ty - tagH / 2, tagW, tagH, 13 * u); g.fill(); g.stroke();
        g.fillStyle = "#17120a"; g.fillText(tag, bx + iw / 2, ty + 1 * u);
        g.restore();
        g.font = `800 ${fs}px 'Barlow Condensed', 'Arial Narrow', sans-serif`;
      }
    }
    // (economy) Banana Stands + the bounty circle
    if (s.econ) {
      for (const q of s.econ.stands) { const [x, y] = this.toScreen(q.x, q.z); standDot(g, x, y, 12 * u); }
      const B = s.econ.bounty; if (B) { const [x, y] = this.toScreen(B.x, B.z); bountyRing(g, x, y, Math.max(14 * u, B.r * this.ppm), performance.now() / 1000); }
    }
    if (s.airstrikes) {
      const nowS = performance.now() / 1000;
      for (const a of s.airstrikes) {
        const [ax, ay] = this.toScreen(a.x, a.z);
        airstrikeOverlay(g, ax, ay, -a.yaw, AIRSTRIKE.span * k, Math.max(8 * u, AIRSTRIKE.radius * k), nowS);
      }
    }
    // Radar Pulse (UAV): sonar ring + enemy diamonds
    if (s.uav && s.me.alive) {
      const [ux, uy] = this.toScreen(s.me.x, s.me.z);
      uavOverlay(g, ux, uy, s.uav.radius * k, now);
      for (const e of s.uav.enemies) { const [ex, ey] = this.toScreen(e.x, e.z); uavEnemyDot(g, ex, ey, 11 * u, now); }
    }
    // tuk-tuks (the taxi ranks this client has heard of)
    // (the one I ride is drawn as me, below)
    let myTuk: { yaw?: number; kind: number } | null = null;
    if (s.vehicles) for (const q of s.vehicles) { if (q.mine) { myTuk = q; continue; } const [x, y] = this.toScreen(q.x, q.z); if (q.kind === 1) heliDot(g, x, y, 13 * u, false, q.wreck); else tukDot(g, x, y, 13 * u, false, q.wreck); }
    // enemy gunfire
    if (s.shots) for (const q of s.shots) { const [x, y] = this.toScreen(q.x, q.z); shotDot(g, x, y, q.a, 10 * u); }
    // squad, drop marker, me
    let si = 0;
    for (const q of s.squad) {
      if (q.me) continue;
      const [x, y] = this.toScreen(q.x, q.z);
      mateMarker(g, x, y, q.yaw, SQUAD_COLOURS[si++ % SQUAD_COLOURS.length], q.alive && !q.downed ? 1 : 0.55, 13 * u);
      g.font = `800 ${22 * u}px 'Barlow Condensed', sans-serif`;
      g.lineWidth = 5 * u; g.strokeStyle = "rgba(12,10,6,0.9)"; g.strokeText(q.name, x, y - 30 * u);
      g.fillStyle = "#fff"; g.fillText(q.name, x, y - 30 * u);
    }
    // the game's marker wins; the local echo covers the frame(s) before it round-trips
    const mk = mk0;
    if (s.squadMarks) for (const q of s.squadMarks) { const [x, y] = this.toScreen(q.x, q.z); drawPin(g, x, y, 21 * u, q.color); }
    if (mk) { const [x, y] = this.toScreen(mk.x, mk.z); drawPin(g, x, y, 25 * u); }
    if (s.me.alive) {
      const [x, y] = this.toScreen(s.me.x, s.me.z);
      const pr = (now % 1.4) / 1.4;
      g.strokeStyle = `rgba(255,248,220,${0.7 * (1 - pr)})`; g.lineWidth = 3 * u;
      g.beginPath(); g.arc(x, y, (18 + pr * 34) * u, 0, Math.PI * 2); g.stroke();
      if (myTuk) tukMe(g, x, y, 15 * u, myTuk.yaw ?? s.yaw, myTuk.kind); else playerArrow(g, x, y, s.yaw, 1.45 * u);
    }
    // ---- legend text
    const phase = s.phase === "warmup" ? "WARM-UP" : s.phase === "plane" ? "FLIGHT" : s.stormPhase > 0 ? `STORM PHASE ${s.stormPhase}` : "STORM FORMING";
    const tsub = s.stormShrinking ? "CLOSING" : s.phase === "plane" || s.phase === "warmup" ? "" : "UNTIL IT MOVES";
    const alive = `${s.alive}`, squads = s.mode === "trios" ? `${s.squadsAlive} SQUADS` : "ALIVE";
    const txt = `${phase}|${fmt(s.stormTimer)}|${tsub}|${alive}|${squads}`;
    if (txt !== this.lastTxt) {
      this.lastTxt = txt;
      this.phEl.textContent = phase;
      this.tmEl.textContent = fmt(s.stormTimer);
      this.tmSub.textContent = tsub;
      (this.aliveEl as HTMLElement & { _v: HTMLElement })._v.textContent = alive;
      this.squadsEl.textContent = squads;
    }
  }
}
