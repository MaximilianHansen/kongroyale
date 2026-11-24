// Full-screen feedback: damage is always red — a glow on the screen edge facing the
// shooter (the arc around the crosshair is drawn by center.ts), all edges when nothing points at a shooter (storm, a
// fall, a blast), a stronger red edge when your shield breaks, and a slow red vignette under 30 health. Blue only means
// healing: a blue glow around all the screen edges while health or shield refill, with "Healing…" under the bars.
// Plus the confirmations under the crosshair (Shield broken / Eliminated; the elimination banner takes over on a kill).
// Opacity-only runtime animation (WAAPI / CSS), DOM writes only on change.
import type { HudState } from "./api";
import { CONSUMABLES, type ConsumableId } from "../../../shared/world/map";
import { CONSUMABLE_DEFS } from "../../../shared/sim/const";

const EDGES = 4;
const tog = (e: Element, cls: string, on: boolean) => { if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on); };

export interface FeedbackLayers { dmg: HTMLElement; shield: HTMLElement; low: HTMLElement; heal: HTMLElement; crack: HTMLElement }

export class HudFeedback {
  private readonly edges: HTMLElement[] = [];
  private edgeI = 0;
  private readonly seenDirs = new Set<number>();
  readonly confirm: HTMLElement;
  readonly healLbl: HTMLElement;
  private hp = -1; private sh = -1;
  private flash = 0; private shieldFlash = 0; private healUntil = -1;
  private lossAt = -1; private lossAmt = 0; private lastDir = -9; private recentLoss = 0;
  private hitAt = NaN; private confirmTxt = ""; private confirmOn = false; private wasAlive = false; private healKind: "hp" | "sh" = "hp";
  private st = { flash: -1, shield: -1, low: false, heal: false, healTxt: "", low2: false };

  /** `edgeParent` gets the directional glows (inserted before `before`, under the HUD panels) */
  constructor(private readonly L: FeedbackLayers, edgeParent: HTMLElement, before: Element, confirmParent: HTMLElement, healParent: HTMLElement) {
    for (let i = 0; i < EDGES; i++) { const e = document.createElement("div"); e.className = "tn-hud-edge"; edgeParent.insertBefore(e, before); this.edges.push(e); }
    this.confirm = document.createElement("div"); this.confirm.className = "tn-hud-confirm"; confirmParent.appendChild(this.confirm);
    this.healLbl = document.createElement("div"); this.healLbl.className = "tn-hud-heal"; healParent.appendChild(this.healLbl);
  }

  /** a glow on the screen edge facing the shooter; `angle` = relative bearing (rad, 0 ahead, + to the left) */
  private edge(angle: number, calm: boolean) {
    const th = -Math.PI / 2 - angle, x = Math.cos(th), y = Math.sin(th);
    const e = this.edges[this.edgeI++ % EDGES];
    e.style.background = `radial-gradient(ellipse 60% 70% at ${(50 + x * 58).toFixed(1)}% ${(50 + y * 62).toFixed(1)}%, var(--tn-hud-dmg-glow) 0%, transparent 70%)`;
    const a = Math.min(1, 0.45 + Math.max(this.recentLoss, 15) / 60) * (calm ? 0.6 : 1);
    e.getAnimations().forEach((q) => q.cancel());
    e.animate([{ opacity: a }, { opacity: a * 0.85, offset: 0.6 }, { opacity: 0 }], { duration: 1200, easing: "ease-out", fill: "forwards" });
  }

  /** `refilling`: a vitals bar is animating up; `elimUp`: the elimination banner owns the confirmation slot */
  update(s: HudState, dt: number, now: number, calm: boolean, refilling: boolean, elimUp: boolean) {
    const alive = s.me.alive && s.hp > 0;
    // ---- losses and gains
    this.recentLoss = Math.max(0, this.recentLoss - dt * 60);
    if (this.hp >= 0) {
      const lost = this.hp + this.sh - (s.hp + s.shield);
      if (lost > 0.5) { this.recentLoss += lost; this.lossAt = now; this.lossAmt = Math.max(this.lossAmt, lost); this.healUntil = -1; }
      if (this.sh > 0 && s.shield <= 0 && lost > 0) {
        this.shieldFlash = calm ? 0.4 : 1;
        if (!calm) this.L.crack.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 520, easing: "ease-out" });
      }
      // a gain while alive is a heal (a respawn / redeploy refills you too, but that is not healing)
      if (this.wasAlive && alive && (s.hp > this.hp + 0.5 || s.shield > this.sh + 0.5)) { this.healUntil = now + 0.9; this.healKind = s.hp > this.hp + 0.5 ? "hp" : "sh"; }
    }
    this.hp = s.hp; this.sh = s.shield; this.wasAlive = alive;
    // ---- directional glows (throttled to avoid full-screen radial-gradient repaints on every SMG bullet)
    for (const d of s.damageDirs) if (!this.seenDirs.has(d.at)) {
      this.seenDirs.add(d.at);
      if (now - this.lastDir >= 0.12) { this.lastDir = now; this.edge(d.angle, calm); }
    }
    if (this.seenDirs.size > 32) { const keep = new Set(s.damageDirs.map((d) => d.at)); for (const k of this.seenDirs) if (!keep.has(k)) this.seenDirs.delete(k); }
    // a loss with no shooter to point at (no direction within a moment of it): all edges flash red
    if (this.lossAt >= 0 && now - this.lossAt > 0.12) {
      if (now - this.lastDir > 0.35) this.flash = Math.max(this.flash, Math.min(1, 0.45 + this.lossAmt / 60));
      this.lossAt = -1; this.lossAmt = 0;
    }
    this.flash = Math.max(0, this.flash - dt * 2.2);
    this.shieldFlash = Math.max(0, this.shieldFlash - dt * 2);
    this.op(this.L.dmg, "flash", this.flash * (calm ? 0.4 : 0.9));
    this.op(this.L.shield, "shield", this.shieldFlash * 0.9);
    // ---- under 30 health: the slow red vignette (CSS pulse; still under reduced motion)
    const low = alive && s.hp <= 30;
    if (low !== this.st.low) { this.st.low = low; tog(this.L.low, "on", low); }
    // ---- healing: blue edges while a bar refills, "Healing…" while a heal is being used or is coming in
    const heal = alive && this.healUntil > 0 && (refilling || now < this.healUntil);
    if (heal !== this.st.heal) { this.st.heal = heal; tog(this.L.heal, "on", heal); }
    const slot = s.hotbar[s.activeSlot];
    const def = s.using && slot && slot.kind === "consumable" && CONSUMABLES.includes(slot.id as ConsumableId) ? CONSUMABLE_DEFS[slot.id as ConsumableId] : null;
    const kind = def ? (def.hp > 0 ? "hp" : def.shield > 0 ? "sh" : "") : heal ? this.healKind : "";
    const healTxt = !alive || !kind ? "" : kind === "hp" ? "Healing…" : "Charging shield…";
    if (healTxt !== this.st.healTxt) { if (healTxt) this.healLbl.textContent = healTxt; this.st.healTxt = healTxt; tog(this.healLbl, "on", !!healTxt); }
    // ---- confirmations under the crosshair (1.3 s, in 12 %, out from 75 %)
    const hm = s.hitMarker;
    if (hm && !hm.predicted && hm.at !== this.hitAt && (hm.kind === "break" || hm.kind === "kill")) {
      this.hitAt = hm.at;
      this.show(hm.kind === "break" ? "Shield broken" : "Eliminated", calm);
    }
    if (elimUp) this.clearConfirm();
    // the use / reload label sits under the crosshair: the confirmations go under it
    const hands = alive && !s.spectating && (s.handsVisible ?? (s.phase !== "plane" && s.phase !== "drop"));
    const low2 = hands && !s.scoped && (!!s.using || !!s.reload || (!!s.ammo && s.ammo.mag === 0));
    if (low2 !== this.st.low2) { this.st.low2 = low2; tog(this.confirm, "low", low2); }
    return low2;
  }

  private show(text: string, calm: boolean) {
    if (text !== this.confirmTxt) { this.confirmTxt = text; this.confirm.textContent = text; }
    this.confirmOn = true;
    this.confirm.getAnimations().forEach((q) => q.cancel());
    const T = (y: number) => `translate(-50%, ${y}px)`;
    this.confirm.animate(calm
      ? [{ opacity: 1, transform: T(0) }, { opacity: 1, transform: T(0), offset: 0.75 }, { opacity: 0, transform: T(0) }]
      : [{ opacity: 0, transform: T(8) }, { opacity: 1, transform: T(0), offset: 0.12 }, { opacity: 1, transform: T(0), offset: 0.75 }, { opacity: 0, transform: T(0) }],
    { duration: 1300, easing: "ease", fill: "forwards" });
  }
  clearConfirm() { if (!this.confirmOn) return; this.confirmOn = false; this.confirm.getAnimations().forEach((q) => q.cancel()); }

  private op(e: HTMLElement, k: "flash" | "shield", v: number) {
    const q = Math.round(v * 100) / 100;
    if (q === this.st[k]) return;
    this.st[k] = q; e.style.opacity = String(q);
  }
}
