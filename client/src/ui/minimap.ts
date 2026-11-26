// Minimap: north-up window onto the painted island, centred on the player (top-left).
// With the "Rotate minimap" preference the map turns instead, so the way you look is always up, and an N rides the rim.
// Zooms out while flying/dropping. Redraws only when something it shows actually changed.
import { drawCoin } from "./coin";
import type { HudState } from "./api";
import type { PaintedMap } from "./mapimage";
import { drawGlyph } from "./icons";
import { TOON } from "./toon";
import { preferences } from "../settings/preferences";
import type { POIS } from "../../../shared/world/map";
import { AIRSTRIKE } from "../../../shared/sim/const";
const LABEL_BOXES: Array<[number, number, number]> = [];

const VIEW = 375;                          // u px (inner size)
export const SQUAD_COLOURS = ["#5ec8ff", "#7ee06a", "#ff9ad5", "#ffb347"];
const CREAM = "#f1ebc2";

export class Minimap {
  readonly canvas = document.createElement("canvas");
  private g = this.canvas.getContext("2d")!;
  private viewR = 300;
  private sig = "";

  constructor(private map: PaintedMap, private pois: typeof POIS) {}
  private bySize: typeof POIS | null = null;
  private poisBySize() { return (this.bySize ??= [...this.pois].sort((a, b) => b.r - a.r) as unknown as typeof POIS); }

  resize(px: number) { if (this.canvas.width !== px) { this.canvas.width = this.canvas.height = px; this.sig = ""; } }
  /** repaint on the next update (the Toon fonts arrived) */
  invalidate() { this.sig = ""; }
  /** (Toon) the frame shows the middle band of the square map, height / width of it: labels stay inside the band */
  band = 1;

  update(s: HudState, now: number) {
    const air = s.phase === "plane" || s.phase === "drop" || s.phase === "warmup";
    const target = air ? (s.phase === "plane" ? 900 : 560) : 300;
    this.viewR += (target - this.viewR) * 0.08;
    if (Math.abs(target - this.viewR) < 0.5) this.viewR = target;
    const planeOn = !!s.plane;
    const rot = preferences.value.minimapRotate;
    const sig = `${rot ? "r" : "n"}|${this.map.version}|${s.me.x.toFixed(1)}|${s.me.z.toFixed(1)}|${s.yaw.toFixed(3)}|${this.viewR.toFixed(1)}|${s.safe.cx},${s.safe.cz},${s.safe.r.toFixed(1)}|${s.next ? `${s.next.cx},${s.next.cz},${s.next.r}` : ""}|${s.dropMarker ? `${s.dropMarker.x},${s.dropMarker.z}` : ""}|${s.squadMarks?.length ? s.squadMarks.map((q) => `${q.x},${q.z}`).join(";") : ""}|${planeOn ? Math.floor(now * 30) : 0}|${sqSig(s)}|${s.stormPhase}|${shotSig(s)}|${tukSig(s)}|${econSig(s, now)}`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.draw(s, now);
  }

  private draw(s: HudState, now: number) {
    const g = this.g, W = this.canvas.width, k0 = W / VIEW;
    g.setTransform(k0, 0, 0, k0, 0, 0);
    g.fillStyle = this.map.seaCss;
    g.fillRect(0, 0, VIEW, VIEW);
    const viewR = this.viewR;
    const mpp = this.map.sizePx / (this.map.half * 2);
    const half = viewR * mpp;
    const c = this.map.toPx(s.me.x, s.me.z);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    // rotating: turn the world by the view yaw about the player so your heading points up (the square's corners need
    // √2 more of the map under them); north-up: rot = 0, the classic window
    const rot = preferences.value.minimapRotate ? s.yaw : 0, cr = Math.cos(rot), sr0 = Math.sin(rot);
    if (rot) {
      const ext = half * Math.SQRT2, v2 = (VIEW / 2) * Math.SQRT2;
      g.save(); g.translate(VIEW / 2, VIEW / 2); g.rotate(rot);
      g.drawImage(this.map.canvas, c[0] - ext, c[1] - ext, ext * 2, ext * 2, -v2, -v2, v2 * 2, v2 * 2);
      g.restore();
    } else g.drawImage(this.map.canvas, c[0] - half, c[1] - half, half * 2, half * 2, 0, 0, VIEW, VIEW);

    const k = VIEW / 2 / viewR;
    /** world (x, z) → minimap px (rotated about the player when the map turns); icons and labels stay upright */
    const P = (wx: number, wz: number): [number, number] => {
      const dx = (wx - s.me.x) * k, dy = (wz - s.me.z) * k;
      return [dx * cr - dy * sr0 + VIEW / 2, dx * sr0 + dy * cr + VIEW / 2];
    };

    // storm: tint outside the current wall, glowing violet edge
    const [scx, scy] = P(s.safe.cx, s.safe.cz), sr = s.safe.r * k;
    const stormVisible = s.stormPhase > 0 || !!s.next;
    if (stormVisible && sr < VIEW * 2.2) {
      g.save();
      g.beginPath(); g.rect(-2, -2, VIEW + 4, VIEW + 4); g.arc(scx, scy, sr, 0, Math.PI * 2, true);
      g.fillStyle = "rgba(78,28,150,0.3)";
      g.fill();
      g.restore();
      g.strokeStyle = "rgba(196,150,255,0.95)";
      g.lineWidth = 2.2;
      g.shadowColor = "rgba(170,110,255,0.9)"; g.shadowBlur = 6;
      g.beginPath(); g.arc(scx, scy, sr, 0, Math.PI * 2); g.stroke();
      g.shadowBlur = 0;
    }
    // next safe zone: crisp white ring
    const nz = s.next ?? s.safe;
    const [ncx, ncy] = P(nz.cx, nz.cz), nr = nz.r * k;
    g.strokeStyle = "rgba(0,0,0,0.18)";
    g.lineWidth = 5.2;
    g.beginPath(); g.arc(ncx, ncy, nr, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = "#ffffff";
    g.lineWidth = 3.4;
    g.beginPath(); g.arc(ncx, ncy, nr, 0, Math.PI * 2); g.stroke();
    // outside the next zone: dashed guide line to its edge
    const dx = s.me.x - nz.cx, dz = s.me.z - nz.cz, dist = Math.hypot(dx, dz);
    if (s.me.alive && dist > nz.r && s.phase === "play") {
      const ex = nz.cx + (dx / dist) * nz.r, ez = nz.cz + (dz / dist) * nz.r;
      g.setLineDash([7, 7]);
      g.strokeStyle = "rgba(255,255,255,0.9)";
      g.lineWidth = 2.4;
      g.beginPath(); g.moveTo(VIEW / 2, VIEW / 2); g.lineTo(...P(ex, ez)); g.stroke();
      g.setLineDash([]);
    }

    // Hot Drop (Zona Caliente): pulsing golden halo over the featured POI
    if (s.hotDrop) {
      const [hx, hy] = P(s.hotDrop.x, s.hotDrop.z), hr = s.hotDrop.r * k;
      if (hx + hr > -20 && hx - hr < VIEW + 20 && hy + hr > -20 && hy - hr < VIEW + 20) hotDropHalo(g, hx, hy, hr, now);
    }
    // POI names when zoomed out (plane / drop)
    if (viewR > 420) {
      g.font = `900 ${viewR > 700 ? 15 : 17}px ${TOON.ui}`;
      g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
      // labels never overlap (otherwise RIPE PEAK printed over MIST FALLS): each is placed at its POI, nudged down / up
      // by a line if it would collide with one already drawn, and skipped if it still does (bigger POIs go first)
      const placed = LABEL_BOXES; placed.length = 0;
      const lh = viewR > 700 ? 17 : 19, top = VIEW * (1 - this.band) / 2;
      for (const p of this.poisBySize()) {
        if (p.id === "lobby-islet") continue;
        const isHot = s.hotDrop?.id === p.id;
        const label = isHot ? `★ ${p.name}` : p.name;
        let [x, y0] = P(p.x, p.z);
        if (x < -20 || x > VIEW + 20 || y0 < top + 12 || y0 > VIEW - top - 12) continue;
        // never clip a label at the frame: slide it inside (it still sits over its POI's side of the map)
        const hw = g.measureText(label).width / 2 + 4;
        x = Math.max(hw, Math.min(VIEW - hw, x));
        let y = -1;
        for (const dy of [0, lh, -lh, lh * 2, -lh * 2]) {
          const yy = y0 + dy; if (yy < top + 10 || yy > VIEW - top - 10) continue;
          if (!placed.some((b) => Math.abs(b[0] - x) < b[2] + hw && Math.abs(b[1] - yy) < lh - 1)) { y = yy; break; }
        }
        if (y < 0) continue;
        placed.push([x, y, hw]);
        g.lineWidth = 4.5; g.strokeStyle = TOON.outline; g.strokeText(label, x, y);
        g.fillStyle = isHot ? "#ffd21f" : TOON.text; g.fillText(label, x, y);
      }
    }

    // flight path + plane
    if (s.plane) {
      const p = s.plane;
      g.lineCap = "round";
      g.setLineDash([2, 9]);
      g.strokeStyle = "rgba(20,14,0,0.5)"; g.lineWidth = 6.5;
      g.beginPath(); g.moveTo(...P(p.x0, p.z0)); g.lineTo(...P(p.x1, p.z1)); g.stroke();
      g.strokeStyle = "#ffd400"; g.lineWidth = 4.2;
      g.beginPath(); g.moveTo(...P(p.x0, p.z0)); g.lineTo(...P(p.x1, p.z1)); g.stroke();
      g.setLineDash([]);
      const pp = planeAt(s, now);
      const ang = Math.atan2(p.z1 - p.z0, p.x1 - p.x0) + Math.PI / 2 + rot;
      g.save(); g.translate(...P(pp.x, pp.z)); g.rotate(ang);
      g.shadowColor = "rgba(0,0,0,0.6)"; g.shadowBlur = 4;
      drawGlyph(g, "plane", -15, -15, 30, 30, "#ffd400");
      g.shadowBlur = 0;
      g.restore();
    }
    // tuk-tuks (BANANA CO.'s taxis: a ride worth a detour) and helicopters — the one I ride is drawn as me (below)
    let myTuk: (typeof s.vehicles extends Array<infer T> | undefined ? T : never) | null = null;
    if (s.vehicles) for (const q of s.vehicles) { if (q.mine) { myTuk = q; continue; } const [x, y] = P(q.x, q.z); if (x > -12 && x < VIEW + 12 && y > -12 && y < VIEW + 12) { if (q.kind === 1) heliDot(g, x, y, 10, false, q.wreck); else tukDot(g, x, y, 10, false, q.wreck); } }
    // enemy gunfire
    if (s.shots) for (const q of s.shots) shotDot(g, ...P(q.x, q.z), q.a, 6);
    // drop marker
    if (s.squadMarks) for (const q of s.squadMarks) drawPin(g, ...P(q.x, q.z), 11, q.color);
    if (s.dropMarker) drawPin(g, ...P(s.dropMarker.x, s.dropMarker.z), 13);
    // (economy) Banana Stands + the bounty circle
    if (s.econ) {
      for (const q of s.econ.stands) { const [x, y] = P(q.x, q.z); if (x > -12 && x < VIEW + 12 && y > -12 && y < VIEW + 12) standDot(g, x, y, 8); }
      const B = s.econ.bounty; if (B) bountyRing(g, ...P(B.x, B.z), Math.max(10, B.r * k), now);
    }
    // Banana Airstrike: pulsing crimson 6-blast danger corridor
    if (s.airstrikes) for (const a of s.airstrikes) {
      const [ax, ay] = P(a.x, a.z);
      airstrikeOverlay(g, ax, ay, rot - a.yaw, AIRSTRIKE.span * k, Math.max(5, AIRSTRIKE.radius * k), now);
    }
    // Radar Pulse (UAV): cyan sonar sweep ring + pulsing enemy diamonds
    if (s.uav && s.me.alive) {
      uavOverlay(g, VIEW / 2, VIEW / 2, s.uav.radius * k, now);
      for (const e of s.uav.enemies) { const [ex, ey] = P(e.x, e.z); if (ex > -14 && ex < VIEW + 14 && ey > -14 && ey < VIEW + 14) uavEnemyDot(g, ex, ey, 6.5, now); }
    }
    // squad mates
    let si = 0;
    for (const q of s.squad) {
      if (q.me) continue;
      const col = SQUAD_COLOURS[si++ % SQUAD_COLOURS.length];
      const [qx, qy] = P(q.x, q.z), x = Math.max(8, Math.min(VIEW - 8, qx)), y = Math.max(8, Math.min(VIEW - 8, qy));
      mateMarker(g, x, y, q.yaw === undefined ? undefined : q.yaw - rot, col, q.alive && !q.downed ? 1 : 0.55, 9);
    }
    // player arrow (rotates; the map stays north-up — or, rotating, the arrow points straight up and the map turns) —
    // aboard a tuk-tuk: the tuk-tuk itself, a chevron for its heading
    if (s.me.alive && myTuk) tukMe(g, VIEW / 2, VIEW / 2, 12.5, (myTuk.yaw ?? s.yaw) - rot, myTuk.kind);
    else if (s.me.alive) playerArrow(g, VIEW / 2, VIEW / 2, s.yaw - rot, 1.15, TOON.accent);   // (Toon) you: the banana arrow
    if (rot) northTag(g, sr0, -cr, this.band);
  }
}

/** the rotating minimap's north: a dark disc with a cream N on the frame's inner edge, toward north (nx, ny = screen
 *  direction of world north) */
function northTag(g: CanvasRenderingContext2D, nx: number, ny: number, band = 1) {
  // (Toon) the frame shows only the middle band of the square: keep the tag inside it
  const mx = VIEW / 2 - 17, my = VIEW * band / 2 - 17, t = Math.min(mx / Math.max(1e-6, Math.abs(nx)), my / Math.max(1e-6, Math.abs(ny)));
  const x = VIEW / 2 + nx * t, y = VIEW / 2 + ny * t;
  g.save();
  g.shadowColor = "rgba(0,0,0,0.5)"; g.shadowBlur = 4;
  g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.fillStyle = "rgba(14,20,28,0.9)"; g.fill();
  g.shadowBlur = 0; g.lineWidth = 2; g.strokeStyle = CREAM; g.stroke();
  g.font = "800 17px 'Barlow Condensed', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = CREAM; g.fillText("N", x, y + 1);
  g.restore();
}

// (economy) the Banana Stands (a banana-coin badge) and the bounty circle (a pulsing red ring, a skull)
function econSig(s: HudState, now: number) {
  const e = s.econ;
  const uav = s.uav ? `|uav${s.uav.enemies.length}:${Math.floor(now * 12)}` : "";
  const hd = s.hotDrop ? `|hd${s.hotDrop.id}:${Math.floor(now * 3)}` : "";
  const as = s.airstrikes?.length ? `|as${s.airstrikes.length}:${Math.floor(now * 10)}` : "";
  if (!e) return uav + hd + as;
  return `${e.stands.length}|${e.bounty ? `${e.bounty.x | 0},${e.bounty.z | 0},${Math.floor(now * 8)}` : ""}${uav}${hd}${as}`;
}
/** Banana Airstrike crimson danger corridor (rotated pill + 6 pulsing blast markers) */
export function airstrikeOverlay(g: CanvasRenderingContext2D, x: number, y: number, ang: number, span: number, r: number, now: number) {
  const pulse = 0.5 + 0.5 * Math.sin(now * 11);
  const half = span * 0.5;
  g.save();
  g.translate(x, y);
  g.rotate(ang);
  g.fillStyle = `rgba(255, 59, 48, ${0.22 + 0.14 * pulse})`;
  g.strokeStyle = `rgba(255, 72, 56, ${0.85 + 0.15 * pulse})`;
  g.lineWidth = Math.max(2, r * 0.22);
  g.beginPath();
  g.roundRect(-r * 1.15, -half - r * 1.15, r * 2.3, span + r * 2.3, r * 1.15);
  g.fill();
  g.setLineDash([Math.max(4, r * 0.6), Math.max(3, r * 0.45)]);
  g.stroke();
  g.setLineDash([]);
  g.fillStyle = `rgba(255, 224, 96, ${0.75 + 0.25 * pulse})`;
  for (let k = 0; k < AIRSTRIKE.bombs; k++) {
    const frac = AIRSTRIKE.bombs > 1 ? k / (AIRSTRIKE.bombs - 1) - 0.5 : 0;
    const py = -frac * span;
    g.beginPath(); g.arc(0, py, Math.max(2, r * 0.32), 0, Math.PI * 2); g.fill();
  }
  g.restore();
}
/** Hot Drop POI golden zone halo */
export function hotDropHalo(g: CanvasRenderingContext2D, x: number, y: number, r: number, now: number) {
  const pulse = 0.5 + 0.5 * Math.sin(now * 3.2);
  g.save();
  const gr = g.createRadialGradient(x, y, r * 0.1, x, y, r);
  gr.addColorStop(0, `rgba(255, 210, 31, ${0.18 + 0.08 * pulse})`);
  gr.addColorStop(0.75, `rgba(255, 168, 24, ${0.10 + 0.05 * pulse})`);
  gr.addColorStop(1, "rgba(255, 168, 24, 0)");
  g.fillStyle = gr;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.setLineDash([Math.max(5, r * 0.12), Math.max(4, r * 0.08)]);
  g.lineWidth = Math.max(2, Math.min(4, r * 0.04));
  g.strokeStyle = `rgba(255, 214, 40, ${0.72 + 0.25 * pulse})`;
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke();
  g.setLineDash([]);
  g.restore();
}
/** Radar Pulse (UAV) sonar ring + rotating cyan sweep wedge centered on the player */
export function uavOverlay(g: CanvasRenderingContext2D, cx: number, cy: number, r: number, now: number) {
  g.save();
  const ang = (now * 2.2) % (Math.PI * 2);
  g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, r, ang - 0.65, ang); g.closePath();
  g.fillStyle = "rgba(64, 234, 255, 0.16)"; g.fill();
  g.strokeStyle = "rgba(120, 246, 255, 0.85)"; g.lineWidth = 2;
  g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r); g.stroke();
  const pr = (now * 0.55) % 1;
  g.strokeStyle = `rgba(92, 242, 255, ${0.55 * (1 - pr)})`; g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, r * pr, 0, Math.PI * 2); g.stroke();
  g.setLineDash([8, 6]);
  g.strokeStyle = "rgba(92, 242, 255, 0.72)"; g.lineWidth = 2;
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
  g.setLineDash([]);
  g.restore();
}
/** UAV-revealed enemy diamond blip */
export function uavEnemyDot(g: CanvasRenderingContext2D, x: number, y: number, r: number, now: number) {
  const pulse = 0.5 + 0.5 * Math.sin(now * 8);
  g.save();
  g.translate(x, y);
  g.strokeStyle = `rgba(92, 242, 255, ${0.75 * (1 - pulse * 0.6)})`;
  g.lineWidth = Math.max(1.5, r * 0.25);
  g.beginPath(); g.arc(0, 0, r * (1.2 + pulse * 0.7), 0, Math.PI * 2); g.stroke();
  g.beginPath();
  g.moveTo(0, -r * 1.15); g.lineTo(r * 1.05, 0); g.lineTo(0, r * 1.15); g.lineTo(-r * 1.05, 0); g.closePath();
  g.fillStyle = "#ff3b30"; g.fill();
  g.lineWidth = Math.max(1.5, r * 0.28); g.strokeStyle = "#fff8e7"; g.stroke();
  g.restore();
}
export function standDot(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.save(); g.translate(x, y);
  g.beginPath(); g.arc(0, 0, r * 1.25, 0, Math.PI * 2); g.fillStyle = "rgba(10,14,20,0.85)"; g.fill();
  // the Banana Bucks coin, not a "$" (ui/coin.ts)
  drawCoin(g, 0, 0, r * 1.08);
  g.restore();
}
export function bountyRing(g: CanvasRenderingContext2D, x: number, y: number, r: number, now: number) {
  g.save();
  const p = 0.5 + 0.5 * Math.sin(now * 5);
  g.fillStyle = `rgba(255,59,48,${0.12 + 0.08 * p})`; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.setLineDash([r * 0.18, r * 0.1]); g.lineWidth = Math.max(2, r * 0.06); g.strokeStyle = "#ff3b30"; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
  g.strokeStyle = `rgba(255,120,100,${0.6 * (1 - p)})`; g.lineWidth = 2; g.beginPath(); g.arc(x, y, r * (1 + 0.25 * p), 0, Math.PI * 2); g.stroke();
  g.restore();
}
function tukSig(s: HudState) { let o = ""; if (s.vehicles) for (const q of s.vehicles) o += `${q.x | 0},${q.z | 0},${q.mine ? `m${((q.yaw ?? 0) * 20) | 0}` : ""}${q.wreck ? "w" : ""}${q.kind};`; return o; }
/** a helicopter on the maps: a rotor cross over a little cabin with a tail, on a dark badge (ringed white = the one I ride) */
export function heliDot(g: CanvasRenderingContext2D, x: number, y: number, r: number, mine: boolean, wreck: boolean) {
  g.save(); g.translate(x, y);
  g.beginPath(); g.arc(0, 0, r * 1.3, 0, Math.PI * 2); g.fillStyle = "rgba(10,14,20,0.82)"; g.fill();
  if (mine) { g.lineWidth = r * 0.28; g.strokeStyle = "#ffffff"; g.stroke(); }
  const c = wreck ? "#8b8f96" : "#ffd400", k = r / 8;
  g.strokeStyle = wreck ? "#5b5f66" : "#7a4a22"; g.lineWidth = 1.4 * k; g.lineCap = "round";
  g.beginPath(); g.moveTo(-7 * k, -7 * k); g.lineTo(7 * k, 7 * k); g.moveTo(7 * k, -7 * k); g.lineTo(-7 * k, 7 * k); g.stroke();   // the rotor
  g.fillStyle = c; g.beginPath(); g.ellipse(-1 * k, 0.6 * k, 4.2 * k, 3.1 * k, 0, 0, Math.PI * 2); g.fill();                         // the cabin
  g.fillRect(2.5 * k, -0.4 * k, 6 * k, 1.6 * k); g.fillRect(7.5 * k, -3.2 * k, 1.4 * k, 4 * k);                                        // the tail + fin
  g.fillStyle = "#15110a"; g.beginPath(); g.arc(-2.2 * k, 0 * k, 1.1 * k, 0, Math.PI * 2); g.fill();                                     // the canopy
  g.restore();
}
/** a tuk-tuk on the maps (readable at a glance, never mistaken for a POI's round yellow badge): a dark rounded
 * tile with a BANANA CO. yellow rim and a yellow three-wheeler on it (grey = a wreck; a white rim = the one I ride) */
export function tukDot(g: CanvasRenderingContext2D, x: number, y: number, r: number, mine: boolean, wreck: boolean) {
  g.save(); g.translate(x, y);
  const R = r * 1.2, c = wreck ? "#9a9ea5" : "#ffd400";
  g.shadowColor = "rgba(0,0,0,0.6)"; g.shadowBlur = r * 0.5; g.shadowOffsetY = r * 0.12;
  g.beginPath(); g.roundRect(-R, -R, 2 * R, 2 * R, R * 0.38); g.fillStyle = "rgba(14,20,28,0.94)"; g.fill();
  g.shadowColor = "transparent"; g.shadowBlur = 0; g.shadowOffsetY = 0;
  g.lineWidth = r * 0.22; g.strokeStyle = mine ? "#ffffff" : c; g.stroke();
  const k = r / 9;
  g.fillStyle = c; g.fillRect(-6.5 * k, -5.8 * k, 12 * k, 1.9 * k);                                                       // canopy
  g.fillRect(-5.6 * k, -4.2 * k, 1.3 * k, 4.2 * k); g.fillRect(3.4 * k, -4.2 * k, 1.3 * k, 4.2 * k);                       // posts
  g.beginPath(); g.moveTo(-6.5 * k, -0.8 * k); g.lineTo(3 * k, -0.8 * k); g.lineTo(7 * k, 1.3 * k); g.lineTo(7 * k, 3.1 * k); g.lineTo(-6.5 * k, 3.1 * k); g.closePath(); g.fill();
  g.beginPath(); g.arc(-3.6 * k, 4.6 * k, 2.3 * k, 0, Math.PI * 2); g.arc(4.6 * k, 4.6 * k, 2.1 * k, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#15110a"; g.beginPath(); g.arc(-3.6 * k, 4.6 * k, 0.9 * k, 0, Math.PI * 2); g.arc(4.6 * k, 4.6 * k, 0.8 * k, 0, Math.PI * 2); g.fill();
  g.restore();
}
/** me, aboard a tuk-tuk (or a helicopter: `kind` 1): its badge (white-ringed) with a cream chevron on the rim pointing
 * where it is heading */
export function tukMe(g: CanvasRenderingContext2D, x: number, y: number, r: number, yaw: number, kind = 0) {
  if (kind === 1) heliDot(g, x, y, r, true, false); else tukDot(g, x, y, r, true, false);
  g.save(); g.translate(x, y); g.rotate(-yaw);
  // (the chevron rides the tile's circumcircle so it clears the corners as it turns)
  const R = r * 1.7;
  g.beginPath(); g.moveTo(0, -R - r * 0.85); g.lineTo(r * 0.7, -R + r * 0.1); g.lineTo(-r * 0.7, -R + r * 0.1); g.closePath();
  g.shadowColor = "rgba(0,0,0,0.6)"; g.shadowBlur = 3; g.fillStyle = CREAM; g.fill();
  g.shadowColor = "transparent"; g.shadowBlur = 0; g.lineWidth = 1.2; g.strokeStyle = "rgba(21,17,10,0.8)"; g.stroke();
  g.restore();
}
function shotSig(s: HudState) { let o = ""; if (s.shots) for (const q of s.shots) o += `${q.x | 0},${q.z | 0},${(q.a * 30) | 0};`; return o; }

/** enemy gunfire: a red dot with a dark rim; a ring pulses out of it while the shot is fresh; fades with a (1 → 0) */
export function shotDot(g: CanvasRenderingContext2D, x: number, y: number, a: number, r: number) {
  g.save();
  const fresh = Math.max(0, (a - 0.75) / 0.25);   // first ~0.75 s
  if (fresh > 0) { g.globalAlpha = fresh * 0.8; g.strokeStyle = "#ff3b30"; g.lineWidth = r * 0.35; g.beginPath(); g.arc(x, y, r * (1 + (1 - fresh) * 1.6), 0, Math.PI * 2); g.stroke(); }
  g.globalAlpha = Math.min(1, a * 1.6);
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = "#ff3b30"; g.fill();
  g.lineWidth = r * 0.3; g.strokeStyle = "rgba(10,14,20,0.85)"; g.stroke();
  g.restore();
}

function sqSig(s: HudState) { let o = ""; for (const q of s.squad) if (!q.me) o += `${q.x | 0},${q.z | 0},${q.alive ? 1 : 0}${q.downed ? "d" : ""};`; return o; }

/** where the plane is now (world xz): the game's live position, else progress along the path, else a loop by time */
export function planeAt(s: HudState, now: number): { x: number; z: number } {
  if (s.planePos) return s.planePos;
  const p = s.plane!;
  const t = s.planeT ?? ((now * 0.035) % 1);
  return { x: p.x0 + (p.x1 - p.x0) * t, z: p.z0 + (p.z1 - p.z0) * t };
}

/** cream arrowhead with a notch (≈30×40 u px at scale 1) */
export function playerArrow(g: CanvasRenderingContext2D, x: number, y: number, yaw: number, sc: number, col = CREAM) {
  g.save();
  g.translate(x, y); g.rotate(-yaw); g.scale(sc, sc);
  g.beginPath();
  g.moveTo(0, -21); g.lineTo(15.5, 18); g.lineTo(0, 9.5); g.lineTo(-15.5, 18); g.closePath();
  g.shadowColor = "rgba(0,0,0,0.45)"; g.shadowBlur = 5; g.shadowOffsetY = 1.5;
  g.fillStyle = col; g.fill();
  g.shadowColor = "transparent"; g.shadowBlur = 0; g.shadowOffsetY = 0;
  g.lineJoin = "round"; g.lineWidth = 1.4; g.strokeStyle = "rgba(60,48,14,0.55)"; g.stroke();
  // soft bevel: lit left facet
  g.beginPath(); g.moveTo(0, -21); g.lineTo(0, 9.5); g.lineTo(-15.5, 18); g.closePath();
  g.fillStyle = "rgba(255,255,255,0.22)"; g.fill();
  g.restore();
}

export function mateMarker(g: CanvasRenderingContext2D, x: number, y: number, yaw: number | undefined, col: string, alpha: number, r: number) {
  g.save();
  g.globalAlpha = alpha;
  g.translate(x, y);
  if (yaw !== undefined) {
    g.rotate(-yaw);
    g.beginPath(); g.moveTo(0, -r * 1.5); g.lineTo(r * 1.05, r); g.lineTo(0, r * 0.45); g.lineTo(-r * 1.05, r); g.closePath();
  } else { g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); }
  g.fillStyle = col; g.fill();
  g.lineWidth = 2; g.strokeStyle = "rgba(10,14,20,0.85)"; g.stroke();
  g.restore();
}

/** black teardrop pin with a white rim and a yellow banana (the drop marker); tip at (x, y) */
export function drawPin(g: CanvasRenderingContext2D, x: number, y: number, r: number, col = "#ffd400") {
  const cy = y - r * 1.55;
  g.save();
  g.shadowColor = "rgba(0,0,0,0.45)"; g.shadowBlur = r * 0.5; g.shadowOffsetY = r * 0.12;
  g.beginPath();
  g.moveTo(x, y);
  g.bezierCurveTo(x - r * 0.35, cy + r * 0.95, x - r * 1.05, cy + r * 0.55, x - r * 1.05, cy);
  g.arc(x, cy, r * 1.05, Math.PI, 0);
  g.bezierCurveTo(x + r * 1.05, cy + r * 0.55, x + r * 0.35, cy + r * 0.95, x, y);
  g.closePath();
  g.fillStyle = "#ffffff"; g.fill();
  g.restore();
  g.beginPath();
  const k = 0.8;
  g.moveTo(x, y - r * 0.28);
  g.bezierCurveTo(x - r * 0.3 * k, cy + r * 0.85 * k, x - r * 1.05 * k, cy + r * 0.5 * k, x - r * 1.05 * k, cy);
  g.arc(x, cy, r * 1.05 * k, Math.PI, 0);
  g.bezierCurveTo(x + r * 1.05 * k, cy + r * 0.5 * k, x + r * 0.3 * k, cy + r * 0.85 * k, x, y - r * 0.28);
  g.closePath();
  g.fillStyle = "#15120c"; g.fill();
  drawGlyph(g, "banana", x - r * 0.62, cy - r * 0.62, r * 1.24, r * 1.24, col);
}
