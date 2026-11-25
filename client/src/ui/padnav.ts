// Controller navigation for every menu (title, room, pause, results, settings, the controls guide): the d-pad or the
// left stick moves focus spatially to the nearest control in that direction (auto-repeat when held), A activates it,
// B goes back, the bumpers switch tabs, the right stick scrolls. Sliders and ◀ value ▶ selectors take left / right
// as their own adjustment. The focused control gets a bold ring (.kr-padfocus) and a hint bar names the buttons.
import type { Gamepads } from "../game/gamepad";
import { PB, glyph } from "../settings/pad";
import { glyphFamily } from "../settings/labels";
import { device } from "../settings/device";
import { addCss } from "./styles";

export interface PadLayer {
  /** where focus may go */
  root: HTMLElement;
  /** B: default = an Escape key press (every screen already closes on Escape) */
  back?: () => void;
  /** LB / RB */
  tab?: (dir: -1 | 1) => void;
  /** the control to focus when nothing in the layer has focus yet */
  first?: () => HTMLElement | null;
  /** extra hints for the bar, e.g. [["Y", "RESET"]] (button index, label) */
  hints?: Array<[number, string]>;
  /** a button the layer handles itself this frame (true = consumed) */
  button?: (b: number) => boolean;
  /** B does nothing here (the hint bar leaves BACK out) */
  noBack?: boolean;
  /** this screen draws its own controller footer hints (hide the floating corner bar) */
  hideHints?: boolean;
}

const FOCUSABLE = "button, [href], input, select, summary, [tabindex]:not([tabindex='-1'])";
/** a screen that drives the controller itself (SETTINGS: rows, adjust, bumpers = sections, triggers = categories) sets
 *  `krPad` on its layer root; each hook returns true when it took the input */
export interface PadOwner { move?(dir: "up" | "down" | "left" | "right"): boolean; button?(b: number): boolean }
const ownerOf = (layer: PadLayer) => (layer.root as HTMLElement & { krPad?: PadOwner }).krPad;
const REPEAT_DELAY = 0.36, REPEAT_EVERY = 0.085;

addCss("kr-padnav", `
html.kr-pad, html.kr-pad * { cursor: none !important; }
html.kr-pad .kr-padfocus { outline: 3px solid #ffd400 !important; outline-offset: 3px !important; box-shadow: 0 0 0 7px rgba(255,212,0,0.22) !important; position: relative; z-index: 1; }
.kr-padhints { position: fixed; right: 24px; bottom: 18px; z-index: 90; display: none; gap: 18px; align-items: center;
  padding: 8px 16px; border-radius: 999px; background: rgba(6,18,28,0.88); border: 1px solid rgba(255,212,0,0.45);
  font: 700 15px 'Barlow Condensed', 'Arial Narrow', sans-serif; letter-spacing: 1.5px; color: #f6efc6; pointer-events: none; white-space: nowrap; }
html.kr-pad .kr-padhints.on { display: flex; }
.kr-padtoast { position: fixed; left: 50%; bottom: 110px; transform: translate(-50%, 12px); z-index: 95; opacity: 0; transition: opacity .2s, transform .2s;
  padding: 10px 18px; border-radius: 10px; background: rgba(6,18,28,0.92); border: 2px solid #ffd400; pointer-events: none; white-space: nowrap;
  font: 700 18px 'Barlow Condensed', 'Arial Narrow', sans-serif; letter-spacing: 1.5px; color: #f6efc6; }
.kr-padtoast.on { opacity: 1; transform: translate(-50%, 0); }
.kr-padtoast b { color: #ffd400; }
.kr-padhints span { display: inline-flex; gap: 7px; align-items: center; }
.kr-padhints b { display: inline-grid; place-items: center; min-width: 24px; height: 24px; padding: 0 6px; box-sizing: border-box; border-radius: 12px;
  background: #f6efc6; color: #10202c; font-size: 13px; letter-spacing: 0; }
.kr-padhints b.w { border-radius: 6px; font-size: 11px; letter-spacing: .5px; }
`);

function visible(el: HTMLElement) {
  if (el.closest("[hidden], .kr-hide, [inert]")) return false;
  if ((el as HTMLButtonElement).disabled) return false;
  if (el instanceof HTMLInputElement && (el.type === "hidden" || el.type === "text" || el.type === "search" || el.type === "" )) return false;
  if (el.getClientRects().length === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
}
/** a ◀ value ▶ selector (the VIDEO rows) or a segmented choice: left / right acts on it instead of moving away */
function adjuster(el: HTMLElement): HTMLElement | null { return el.closest<HTMLElement>(".sel, [data-pad-adjust]"); }

export function createPadNav(pads: Gamepads) {
  const hintBar = document.createElement("div"); hintBar.className = "kr-padhints"; document.body.appendChild(hintBar);
  const toastEl = document.createElement("div"); toastEl.className = "kr-padtoast"; toastEl.setAttribute("role", "status"); document.body.appendChild(toastEl);
  let toastTimer = 0;
  let held: string | null = null, heldT = 0, nextRepeat = 0, hintSig = "", lastRoot: HTMLElement | null = null;
  let current: HTMLElement | null = null;

  const setFocus = (el: HTMLElement | null) => {
    if (current && current !== el) current.classList.remove("kr-padfocus");
    current = el;
    if (!el) return;
    el.classList.add("kr-padfocus");
    if (document.activeElement !== el) el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  const items = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);

  function move(layer: PadLayer, dir: "up" | "down" | "left" | "right") {
    if (ownerOf(layer)?.move?.(dir)) return;
    const list = items(layer.root);
    const cur = current && layer.root.contains(current) && visible(current) ? current : null;
    if (!cur) { setFocus(layer.first?.() ?? list[0] ?? null); return; }
    const horizontal = dir === "left" || dir === "right", sign = dir === "left" || dir === "up" ? -1 : 1;
    // sliders / selects / ◀ ▶ selectors / segmented choices adjust instead of moving
    if (horizontal) {
      if (cur instanceof HTMLInputElement && cur.type === "range") { stepRange(cur, sign); return; }
      if (cur instanceof HTMLSelectElement) { cur.selectedIndex = (cur.selectedIndex + sign + cur.options.length) % cur.options.length; cur.dispatchEvent(new Event("change", { bubbles: true })); return; }
      const adj = adjuster(cur);
      if (adj?.classList.contains("sel")) { adj.querySelector<HTMLButtonElement>(`button[data-d="${sign}"]`)?.click(); return; }
    }
    const a = cur.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    let best: HTMLElement | null = null, bestScore = Infinity;
    for (const el of list) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // distance along the direction (edge to edge) and across it (0 when the two overlap on that axis)
      const along = horizontal ? (sign > 0 ? r.left - a.right : a.left - r.right) : (sign > 0 ? r.top - a.bottom : a.top - r.bottom);
      const centre = horizontal ? (cx - ax) * sign : (cy - ay) * sign;
      if (centre <= 2 || along < -Math.min(a.width, a.height, horizontal ? r.width : r.height) * 0.5) continue;
      const gap = horizontal ? Math.max(0, r.top - a.bottom, a.top - r.bottom) : Math.max(0, r.left - a.right, a.left - r.right);
      const score = Math.max(0, along) + gap * 3 + (horizontal ? Math.abs(cy - ay) : Math.abs(cx - ax)) * 0.15;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    if (best) setFocus(best);
    else if (!horizontal) scrollOf(cur)?.scrollBy({ top: sign * 160 });
  }
  function stepRange(inp: HTMLInputElement, sign: number) {
    const step = Number(inp.step) || 1, min = Number(inp.min), max = Number(inp.max);
    // a held direction speeds up: 1 step, then 2 after a second of repeat
    const n = held && heldT > 1.2 ? 3 : 1;
    const v = Math.max(min, Math.min(max, Number(inp.value) + sign * step * n));
    if (String(v) === inp.value) return;
    inp.value = String(+v.toFixed(4));
    inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function scrollOf(el: HTMLElement | null): HTMLElement | null {
    for (let e = el?.parentElement ?? null; e; e = e.parentElement) { const cs = getComputedStyle(e); if (/(auto|scroll)/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 2) return e; }
    return null;
  }
  function activate(layer: PadLayer) {
    const cur = current && layer.root.contains(current) && visible(current) ? current : null;
    if (!cur) { setFocus(layer.first?.() ?? items(layer.root)[0] ?? null); return; }
    if (cur instanceof HTMLInputElement && cur.type === "range") return;
    if (cur instanceof HTMLSelectElement) { cur.selectedIndex = (cur.selectedIndex + 1) % cur.options.length; cur.dispatchEvent(new Event("change", { bubbles: true })); return; }
    cur.click();
  }
  const escape = () => { const t = document.activeElement ?? document.body; t.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", key: "Escape", bubbles: true, cancelable: true })); };

  /** the direction the d-pad / left stick asks for (dominant axis, past 0.6 on the stick) */
  function direction(): "up" | "down" | "left" | "right" | null {
    const g = pads;
    if (g.down[PB.UP]) return "up"; if (g.down[PB.DOWN]) return "down"; if (g.down[PB.LEFT]) return "left"; if (g.down[PB.RIGHT]) return "right";
    const x = g.raw.lx, y = g.raw.ly;
    if (Math.max(Math.abs(x), Math.abs(y)) < 0.6) return null;
    return Math.abs(x) > Math.abs(y) ? (x > 0 ? "right" : "left") : (y > 0 ? "down" : "up");
  }

  function paintHints(layer: PadLayer | null) {
    const f = glyphFamily();
    const list: Array<[number, string]> = layer ? [[PB.A, "SELECT"], ...(layer.noBack ? [] : [[PB.B, "BACK"]] as Array<[number, string]>), ...(layer.tab ? [[PB.LB, "◀ TAB"], [PB.RB, "TAB ▶"]] as Array<[number, string]> : []), ...(layer.hints ?? [])] : [];
    const sig = list.map((h) => h.join(":")).join("|") + f;
    if (sig === hintSig) return;
    hintSig = sig;
    hintBar.replaceChildren(...list.map(([b, label]) => { const s = document.createElement("span"); const k = document.createElement("b"); k.textContent = glyph(b, f); if (k.textContent.length > 2) k.className = "w"; s.append(k, label); return s; }));
  }

  return {
    /** once per frame after gamepads.poll(): drive `layer` (null = no menu is up: the game has the pad) */
    update(layer: PadLayer | null, dt: number) {
      hintBar.classList.toggle("on", !!layer && !layer.hideHints && device.pad);
      // (the game builds its layer object every frame: the root says whether it is the same screen)
      if ((layer?.root ?? null) !== lastRoot) { lastRoot = layer?.root ?? null; held = direction(); heldT = 0; nextRepeat = REPEAT_DELAY; if (!layer) setFocus(null); }
      if (!layer) { hintSig = ""; return; }
      paintHints(layer);
      if (!pads.connected) return;
      const g = pads;
      // someone else focused something (a click, the menu opening): follow it
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== current && layer.root.contains(active) && active !== document.body && visible(active)) { current?.classList.remove("kr-padfocus"); current = active; if (device.pad) active.classList.add("kr-padfocus"); }
      for (let b = 0; b < g.pressed.length; b++) {
        if (!g.pressed[b]) continue;
        if (ownerOf(layer)?.button?.(b) || layer.button?.(b)) continue;
        if (b === PB.A) activate(layer);
        else if (b === PB.B) (layer.back ?? escape)();
        else if (b === PB.LB) layer.tab?.(-1);
        else if (b === PB.RB) layer.tab?.(1);
      }
      const dir = direction();
      if (dir !== held) { held = dir; heldT = 0; nextRepeat = REPEAT_DELAY; if (dir) move(layer, dir); }
      else if (dir) { heldT += dt; if (heldT >= nextRepeat) { nextRepeat += REPEAT_EVERY; move(layer, dir); } }
      // right stick scrolls the list under the focus
      if (Math.abs(g.right.y) > 0.05) (scrollOf(current) ?? layer.root).scrollBy({ top: g.right.y * 1100 * dt });
    },
    /** drop the ring (the mouse took over) */
    blur() { setFocus(null); },
    /** a short notice at the top of the screen (controller connected / disconnected) — trusted markup only */
    toast(html: string, ms = 3200) { toastEl.innerHTML = html; toastEl.classList.add("on"); clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toastEl.classList.remove("on"), ms); },
  };
}
export type PadNav = ReturnType<typeof createPadNav>;
