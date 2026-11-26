// Centre-screen combat layer (one canvas, 800×800 u-space around the crosshair):
// crosshair with spread bloom, hit markers (predicted → confirmed), kill skull pop, damage-direction arcs and the
// reload / consumable progress ring. Redraws only while something is changing or animating.
import type { HudState } from "./api";
import { preferences } from "../settings/preferences";
import { drawGlyph } from "./icons";
import { TOON } from "./toon";
import type { WeaponId } from "../../../shared/world/map";

const SZ = 800, CX = 400, CY = 400;
/** static crosshair gap (u px) per weapon when the game does not feed `spread` */
const STATIC_GAP: Record<WeaponId, number> = { pistol: 10, smg: 14, ar: 12, shotgun: 44, sniper: 0, rocket: 20, bow: 10, minigun: 24 };
const HIT_COL = { body: "255,255,255", head: "255,184,0", shield: "94,206,255", break: "94,206,255", kill: "255,59,48" } as const;
/** confirmed head / shield / shield-break hits draw a ring around the marker for this long (s) */
const RING_LIFE = 0.5;
/** a damage-direction arc's life (s) */
const DIR_LIFE = 1.4;
const DIAG: Array<[number, number]> = [[-0.7071, -0.7071], [0.7071, -0.7071], [0.7071, 0.7071], [-0.7071, 0.7071]];
/** the guns whose iron sights put their aim point (the front blade's bright tip) on the screen centre when
 *  aimed: no crosshair in ADS. The shotgun (bead + its spread ring) and the rocket keep a small aimed reticle */
const ADS_SIGHTED = new Set<WeaponId>(["ar", "smg", "pistol"]);

export class CenterLayer {
  readonly canvas = document.createElement("canvas");
  private g = this.canvas.getContext("2d")!;
  private gap = 12;
  private hit: { kind: keyof typeof HIT_COL; predicted: boolean; start: number; confirmAt: number } | null = null;
  private hitKey = NaN;
  private skullStart = -1e9;
  private dirs: Array<{ key: number; angle: number; start: number; dmg: number; src: number }> = [];
  /** the newest damage-direction event already taken in (its `at`) */
  private dirSeen = -Infinity;
  private idle = false;
  private lastSig = "";

  /** a door gun's reticle: heat (−1 = not behind one), overheated, belt empty */
  private gunHeat = -1; private gunLock = false; private gunEmpty = false;
  /** at a tuk-tuk's bars or a helicopter's stick (seat 0): nothing to aim — no crosshair (the bench, the
   *  passenger seat and the door gun keep theirs; freefall / glide keep it as the ping's aim point) */
  private atWheel = false;

  resize(pxSize: number) { if (this.canvas.width !== pxSize) { this.canvas.width = this.canvas.height = pxSize; this.idle = false; this.lastSig = ""; } }

  update(s: HudState, now: number, vh: number) {
    // ---- ingest events
    const hm = s.hitMarker;
    if (hm && hm.at !== this.hitKey) {
      this.hitKey = hm.at;
      const prev = this.hit;
      const pred = !!hm.predicted;
      if (prev && prev.predicted && !pred && now - prev.start < 0.7) {
        // server confirmed the predicted hit: upgrade in place (with a small confirm pulse)
        prev.predicted = false; prev.kind = hm.kind; prev.confirmAt = now;
      } else this.hit = { kind: hm.kind, predicted: pred, start: now, confirmAt: pred ? -1 : now };
      if (hm.kind === "kill" && !pred) this.skullStart = now;
    } else if (hm && !hm.predicted && this.hit && this.hit.predicted && hm.at === this.hitKey) {
      this.hit.predicted = false; this.hit.confirmAt = now;
      if (hm.kind === "kill") this.skullStart = now;
    }
    // an arc follows its source while you turn (the game re-aims `angle` every frame); another hit
    // from the same source refreshes that arc (full again, a little bigger) instead of stacking a second one
    for (let i = 0; i < s.damageDirs.length; i++) {
      const d = s.damageDirs[i], dmg = d.dmg ?? 20, src = d.src ?? -1;
      const same = this.dirs.find((q) => q.key === d.at);
      if (same) { same.angle = d.angle; continue; }
      if (d.at <= this.dirSeen) continue;                            // already folded into a refreshed arc (or expired)
      this.dirSeen = d.at;
      const mate = src >= 0 ? this.dirs.find((q) => q.src === src) : undefined;
      if (mate) { mate.key = d.at; mate.angle = d.angle; mate.start = now; mate.dmg = Math.min(100, mate.dmg * 0.6 + dmg); }
      else this.dirs.push({ key: d.at, angle: d.angle, start: now, dmg, src });
    }
    for (let i = this.dirs.length - 1; i >= 0; i--) if (now - this.dirs[i].start > DIR_LIFE) this.dirs.splice(i, 1);

    // ---- crosshair target gap
    const slot = s.hotbar[s.activeSlot];
    // (behind a helicopter's door gun the hands are holstered: the minigun's own reticle, sized by its spread)
    const gun = s.gun ?? null;
    const wid = gun ? null : slot && slot.kind === "weapon" ? (slot.id as WeaponId) : null;
    let target = wid ? STATIC_GAP[wid] : 6;
    if (gun && s.spread !== undefined) {
      const fov = ((s.fov ?? 75) * Math.PI) / 180;
      target = Math.max(10, (Math.tan((s.spread * Math.PI) / 180) / Math.tan(fov / 2)) * 720);
    } else if (s.spread !== undefined && wid && wid !== "shotgun") {
      const fov = ((s.fov ?? 75) * Math.PI) / 180;
      target = Math.max(wid === "sniper" ? 0 : 7, (Math.tan((s.spread * Math.PI) / 180) / Math.tan(fov / 2)) * 720);
    } else if (s.spread !== undefined && wid === "shotgun") {
      const fov = ((s.fov ?? 75) * Math.PI) / 180;
      target = Math.max(26, (Math.tan((s.spread * Math.PI) / 180) / Math.tan(fov / 2)) * 720);
    }
    this.gap += (target - this.gap) * Math.min(1, 0.4 + 0.6 * Math.min(1, Math.abs(target - this.gap) / 20));
    if (Math.abs(target - this.gap) < 0.05) this.gap = target;

    // ---- decide whether to redraw
    const prog = s.reload ?? s.using;
    const hitAge = this.hit ? now - this.hit.start : 99;
    const hitLife = this.hit ? (this.hit.kind === "kill" ? 0.6 : this.hit.kind === "break" ? 0.5 : 0.36) : 0;
    const ringLife = this.hit && !this.hit.predicted && (this.hit.kind === "head" || this.hit.kind === "shield" || this.hit.kind === "break") ? RING_LIFE : 0;
    const animating = hitAge < Math.max(hitLife, ringLife) + 0.02 || now - this.skullStart < 1.1 || this.dirs.length > 0 || !!prog;
    this.gunHeat = gun ? Math.round(gun.heat * 20) / 20 : -1; this.gunLock = !!gun && gun.lock; this.gunEmpty = !!gun && gun.belt <= 0;
    this.atWheel = !!s.vehicle && s.vehicle.seat === 0;
    const sig = `${s.scoped}|${!!s.ads}|${wid}|${this.gap.toFixed(2)}|${s.hp > 0}|${vh}|${this.gunHeat}|${this.gunLock}|${this.gunEmpty}|${this.atWheel}`;
    if (!animating && this.idle && sig === this.lastSig) return;
    this.lastSig = sig;
    this.idle = !animating;
    this.draw(s, now, wid, prog);
  }

  private draw(s: HudState, now: number, wid: WeaponId | null, prog: { t: number; total: number } | null) {
    const g = this.g, k = this.canvas.width / SZ;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.clearRect(0, 0, SZ, SZ);
    g.lineCap = "round";

    // ---- damage direction arcs (behind everything; through the scope too). (Toon)
    // Always red: a crescent toward the shooter — the top edge of a 60 design-px circle whose apex sits 110 px
    // out, 12 px thick tapering to nothing at its ends — with a hard 3 px dark drop on its inner side; full for 60 % of
    // its 1.4 s, then fading out. Drawn 1.3× (a bigger hit up to 1.75×) with a soft red glow, so it reads at a
    // glance mid-fight; the first 90 ms pop in from 1.2× (not with reduced motion)
    for (const d of this.dirs) {
      const age = now - d.start;
      const a = age < DIR_LIFE * 0.6 ? 1 - 0.15 * age / (DIR_LIFE * 0.6) : Math.max(0, 0.85 * (1 - (age - DIR_LIFE * 0.6) / (DIR_LIFE * 0.4)));
      if (a <= 0) continue;
      const th = -Math.PI / 2 - d.angle;
      const big = Math.min(1, d.dmg / 60), pop = preferences.value.reducedMotion || age > 0.09 ? 1 : 1.2 - 0.2 * (age / 0.09);
      const sc = (1.3 + 0.45 * big) * pop;
      g.save(); g.translate(CX, CY); g.rotate(th + Math.PI / 2); g.scale(sc, sc); g.globalAlpha = a * (0.85 + 0.15 * big);
      const R = 80, C = -66.7, RY = 64;                              // u (1 design px = 4/3 u): r 60, centre 50 out, inner 48
      const crescent = (dy: number) => { g.beginPath(); g.arc(0, C + dy, R, Math.PI, Math.PI * 2); g.ellipse(0, C + dy, R, RY, 0, Math.PI * 2, Math.PI, true); g.closePath(); g.fill(); };
      g.fillStyle = TOON.outline; crescent(4);
      g.shadowColor = "rgba(255,40,30,0.85)"; g.shadowBlur = 14 * sc * k;   // (shadowBlur ignores the transform: canvas px)
      g.fillStyle = TOON.danger; crescent(0);
      g.restore();
    }
    if (s.scoped) return;

    // ---- crosshair
    // (no crosshair aiming down sights — the sights are the aim; the door gunner has no sights: its reticle stays)
    // (only on guns whose sights truly line up — the others keep a small aimed reticle)
    if ((s.hp > 0 || s.me.alive) && (!s.ads || !!s.gun || !wid || !ADS_SIGHTED.has(wid))) this.crosshair(g, wid, !!s.ads && !s.gun);

    // ---- hit marker
    const h = this.hit;
    if (h) {
      const age = now - h.start;
      const life = h.kind === "kill" ? 0.6 : h.kind === "break" ? 0.5 : 0.36;
      if (age < life) {
        const pop = preferences.value.reducedMotion ? 1 : age < 0.05 ? 1.35 - 0.35 * (age / 0.05) : 1;
        const cAge = h.confirmAt >= 0 ? now - h.confirmAt : 99;
        const pulse = preferences.value.reducedMotion ? 1 : cAge < 0.08 ? 1 + 0.18 * (1 - cAge / 0.08) : 1;
        const fade = age < life - 0.16 ? 1 : Math.max(0, (life - age) / 0.16);
        const big = h.kind === "head" || h.kind === "kill";
        // predicted (instant, same frame as the muzzle flash) is a crisp white marker; the server's confirm recolours it
        // (head / shield / kill) with a small pulse
        const r0 = (big ? 13 : 11) * pop * pulse, len = (h.predicted ? 14 : big ? 19 : 15) * pop * pulse;
        const w = h.predicted ? 3.2 : big ? 4.6 : 3.6;
        const col = h.predicted ? "250,250,246" : HIT_COL[h.kind];
        const alpha = (h.predicted ? 0.92 : 1) * fade;
        // dark underlay for contrast on bright sand/sky
        g.strokeStyle = `rgba(0,0,0,${0.45 * alpha})`;
        g.lineWidth = w + 2.6;
        g.beginPath();
        for (const q of DIAG) { g.moveTo(CX + q[0] * r0, CY + q[1] * r0); g.lineTo(CX + q[0] * (r0 + len), CY + q[1] * (r0 + len)); }
        g.stroke();
        g.strokeStyle = `rgba(${col},${alpha})`;
        g.lineWidth = w;
        g.beginPath();
        for (const q of DIAG) { g.moveTo(CX + q[0] * r0, CY + q[1] * r0); g.lineTo(CX + q[0] * (r0 + len), CY + q[1] * (r0 + len)); }
        g.stroke();
        if (h.kind === "head" && !h.predicted) {
          // headshot: bright inner tips
          g.strokeStyle = `rgba(255,244,200,${alpha})`;
          g.lineWidth = 2;
          g.beginPath();
          for (const q of DIAG) { g.moveTo(CX + q[0] * r0, CY + q[1] * r0); g.lineTo(CX + q[0] * (r0 + 6), CY + q[1] * (r0 + 6)); }
          g.stroke();
        }
      }
    }
    // ---- confirmed-hit rings: a thin circle on a headshot, a segmented ring on a shield hit, cracked (+ spikes) and
    // expanding when the shield broke
    if (h && !h.predicted && now - h.start < RING_LIFE) {
      const age = now - h.start;
      g.strokeStyle = `rgba(${HIT_COL[h.kind]},${Math.max(0, 1 - age / RING_LIFE)})`; g.lineWidth = 2.5;
      if (h.kind === "head") { g.beginPath(); g.arc(CX, CY, 11, 0, Math.PI * 2); g.stroke(); }
      if (h.kind === "shield" || h.kind === "break") {
        const r = preferences.value.reducedMotion ? 26 : 22 + age * (h.kind === "break" ? 55 : 12);
        g.beginPath(); for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; g.moveTo(CX + Math.cos(a + 0.15) * r, CY + Math.sin(a + 0.15) * r); g.arc(CX, CY, r, a + 0.15, a + 1.25); } g.stroke();
        if (h.kind === "break") { g.beginPath(); for (const q of DIAG) { g.moveTo(CX + q[0] * r, CY + q[1] * r); g.lineTo(CX + q[0] * (r + 9), CY + q[1] * (r + 9)); } g.stroke(); }
      }
    }
    // ---- kill skull pop
    const sAge = now - this.skullStart;
    if (sAge < 1.1) {
      const sc = sAge < 0.08 ? 0.55 + (sAge / 0.08) * 0.65 : sAge < 0.16 ? 1.2 - ((sAge - 0.08) / 0.08) * 0.2 : 1;
      const a = sAge < 0.8 ? 1 : Math.max(0, 1 - (sAge - 0.8) / 0.3);
      const S = 40 * sc, y = CY - 78 - Math.min(12, sAge * 16);
      g.globalAlpha = a;
      g.shadowColor = "rgba(255,40,20,0.7)"; g.shadowBlur = 14;
      drawGlyph(g, "skull", CX - S / 2, y - S / 2, S, S, "#ff3b30");
      g.shadowBlur = 0;
      drawGlyph(g, "skull", CX - S * 0.39, y - S * 0.39, S * 0.78, S * 0.78, "#fff4e8");
      g.globalAlpha = 1;
    }

    // ---- reload / use ring
    if (prog && prog.total > 0) {
      const t = Math.min(1, Math.max(0, prog.t / prog.total));
      const R = 50;
      g.lineCap = "butt";
      g.strokeStyle = "rgba(0,0,0,0.42)";
      g.lineWidth = 9;
      g.beginPath(); g.arc(CX, CY, R, 0, Math.PI * 2); g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.14)";
      g.lineWidth = 6;
      g.beginPath(); g.arc(CX, CY, R, 0, Math.PI * 2); g.stroke();
      const col = s.reload ? "#ffd400" : this.useColour(s);
      g.strokeStyle = col;
      g.lineWidth = 6;
      g.beginPath(); g.arc(CX, CY, R, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2); g.stroke();
      // leading bead
      const ea = -Math.PI / 2 + t * Math.PI * 2;
      g.fillStyle = "#fff8d8";
      g.beginPath(); g.arc(CX + Math.cos(ea) * R, CY + Math.sin(ea) * R, 4.2, 0, Math.PI * 2); g.fill();
      g.lineCap = "round";
    }
  }

  private useColour(s: HudState) {
    const slot = s.hotbar[s.activeSlot];
    const id = slot?.id;
    return id === "smoothie" ? "#6fd0ff" : id === "golden-banana" ? "#ffcf3a" : id === "red-banana" ? "#ff4a3a" : "#7fe06a";
  }

  private crosshair(g: CanvasRenderingContext2D, wid: WeaponId | null, ads = false) {
    if (this.atWheel) return;
    const G = this.gap;
    const white = "rgba(255,255,255,0.95)", dark = "rgba(0,0,0,0.5)";
    const dot = (r: number) => {
      g.fillStyle = dark; g.beginPath(); g.arc(CX, CY, r + 1.3, 0, Math.PI * 2); g.fill();
      g.fillStyle = white; g.beginPath(); g.arc(CX, CY, r, 0, Math.PI * 2); g.fill();
    };
    const ticks = (gap: number, L: number, w: number, skipTop = false) => {
      for (const pass of [0, 1]) {
        g.strokeStyle = pass === 0 ? dark : white;
        g.lineWidth = pass === 0 ? w + 2.4 : w;
        g.beginPath();
        if (!skipTop) { g.moveTo(CX, CY - gap); g.lineTo(CX, CY - gap - L); }
        g.moveTo(CX, CY + gap); g.lineTo(CX, CY + gap + L);
        g.moveTo(CX - gap, CY); g.lineTo(CX - gap - L, CY);
        g.moveTo(CX + gap, CY); g.lineTo(CX + gap + L, CY);
        g.stroke();
      }
    };
    if (this.gunHeat >= 0) {
      // TOP BANANA: a ring the size of its spread, four ticks, a dot — warming to orange with the heat; overheated or
      // out of rounds, a red cross over it
      const h = this.gunHeat, col = this.gunLock || this.gunEmpty ? "rgba(255,70,50,0.95)" : h > 0.5 ? `rgba(255,${Math.round(235 - (h - 0.5) * 260)},${Math.round(150 - (h - 0.5) * 260)},0.95)` : white;
      for (const pass of [0, 1]) {
        g.strokeStyle = pass === 0 ? dark : col;
        g.lineWidth = pass === 0 ? 4.4 : 2.2;
        g.beginPath(); g.arc(CX, CY, G, 0, Math.PI * 2); g.stroke();
        g.beginPath();
        for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) { g.moveTo(CX + dx * (G + 5), CY + dy * (G + 5)); g.lineTo(CX + dx * (G + 15), CY + dy * (G + 15)); }
        g.stroke();
      }
      if (this.gunLock || this.gunEmpty) {
        for (const pass of [0, 1]) {
          g.strokeStyle = pass === 0 ? dark : col; g.lineWidth = pass === 0 ? 5 : 2.8;
          g.beginPath(); for (const [dx, dy] of DIAG) { g.moveTo(CX + dx * 6, CY + dy * 6); g.lineTo(CX + dx * 16, CY + dy * 16); } g.stroke();
        }
      } else dot(2.4);
      return;
    }
    if (!wid) { dot(3); return; }
    if (ads) {
      // aimed without perfect sights: a small dot (the shotgun: a thin ring the size of its spread round its bead)
      if (wid === "shotgun") for (const pass of [0, 1]) { g.strokeStyle = pass === 0 ? dark : "rgba(255,255,255,0.85)"; g.lineWidth = pass === 0 ? 3.4 : 1.6; g.beginPath(); g.arc(CX, CY, Math.max(14, G * 0.85), 0, Math.PI * 2); g.stroke(); }
      else dot(2.2);
      return;
    }
    switch (wid) {
      case "shotgun": {
        for (const pass of [0, 1]) {
          g.strokeStyle = pass === 0 ? dark : white;
          g.lineWidth = pass === 0 ? 4.6 : 2.2;
          g.beginPath(); g.arc(CX, CY, G, 0, Math.PI * 2); g.stroke();
        }
        ticks(G + 5, 8, 3);
        dot(2.4);
        break;
      }
      case "rocket": {
        for (const pass of [0, 1]) {
          g.strokeStyle = pass === 0 ? dark : white;
          g.lineWidth = pass === 0 ? 4.6 : 2.4;
          g.beginPath(); g.arc(CX, CY, 9, 0, Math.PI * 2); g.stroke();
          g.beginPath();
          for (let i = 1; i <= 3; i++) { const y = CY + 9 + i * 13, w2 = 12 - i * 2.5; g.moveTo(CX - w2, y); g.lineTo(CX + w2, y); }
          g.stroke();
        }
        ticks(G + 6, 10, 3, true);
        break;
      }
      case "sniper": {
        dot(2.6);
        for (const pass of [0, 1]) {
          g.strokeStyle = pass === 0 ? dark : "rgba(255,255,255,0.7)";
          g.lineWidth = pass === 0 ? 3.6 : 1.6;
          g.beginPath(); g.arc(CX, CY, 14 + G * 0.6, 0, Math.PI * 2); g.stroke();
        }
        break;
      }
      case "bow": {
        dot(2.6);
        for (const pass of [0, 1]) {
          g.strokeStyle = pass === 0 ? dark : white;
          g.lineWidth = pass === 0 ? 4.4 : 2.2;
          g.beginPath();
          // hunting bow side brackets + ballistic elevation drops below center
          g.arc(CX, CY, 18 + G * 0.35, -0.55, 0.55);
          g.moveTo(CX - Math.cos(0.55) * (18 + G * 0.35), CY - Math.sin(0.55) * (18 + G * 0.35));
          g.arc(CX, CY, 18 + G * 0.35, Math.PI - 0.55, Math.PI + 0.55);
          for (let i = 1; i <= 3; i++) { const y = CY + 12 + i * 11, w2 = 10 - i * 2; g.moveTo(CX - w2, y); g.lineTo(CX + w2, y); }
          g.stroke();
        }
        break;
      }
      case "minigun": {
        for (const pass of [0, 1]) {
          g.strokeStyle = pass === 0 ? dark : white;
          g.lineWidth = pass === 0 ? 4.6 : 2.2;
          g.beginPath(); g.arc(CX, CY, Math.max(18, G), 0, Math.PI * 2); g.stroke();
        }
        ticks(Math.max(18, G) + 5, 10, 3);
        dot(2.4);
        break;
      }
      default: {
        ticks(G, wid === "pistol" ? 11 : 14, 3);
        dot(2.6);
      }
    }
  }
}
