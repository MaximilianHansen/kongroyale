// SETTINGS (Toon) · the contextual help panel's illustrations, drawn from the real values: the mouse diagram (current
// sensitivity / invert), the speaker (master volume), the field-of-view wedge (the game's vertical FOV shown as its
// horizontal angle at 16:9, against a dashed 90°), the graphics levels, the binding keycaps, the hardware details (real
// detected values only) and the HUD preview (the live HUD's own health / shield and slot components at the chosen HUD
// size, plus a specimen line at the chosen text size). The controller diagram, the stick tester and the response curve
// are settings/controller-panel.ts.
import type { Engine } from "../engine/engine";
import type { Display, Level } from "../engine/display";
import { preferences } from "../settings/preferences";
import { hfov } from "./settings-model";

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const caption = (t: string) => `<div class="tn-set-cap tn-eyebrow">${esc(t)}</div>`;

/** a mouse between two turn arcs; the dashed arc is the current sensitivity's sweep (line art) */
export function mouseViz(): string {
  const p = preferences.value, sweep = Math.min(1, p.sensitivity / 3);
  const a = 30 + sweep * 60, r = 96, cx = 150, cy = 132;
  const pt = (deg: number) => `${(cx + Math.sin(deg * Math.PI / 180) * r).toFixed(1)} ${(cy - Math.cos(deg * Math.PI / 180) * r).toFixed(1)}`;
  return `<div class="tn-set-fig"><svg class="tn-set-mouse" viewBox="0 0 300 210" aria-hidden="true">
    <path class="arc" d="M${pt(-a)}A${r} ${r} 0 0 1 ${pt(a)}"/>
    <path class="side" d="M52 168a110 100 0 0 1 22-84M248 168a110 100 0 0 0-22-84"/><path class="side" d="M64 92l10-10 4 13M236 92l-10-10-4 13"/>
    <path class="tick" d="M150 26v20"/>
    <rect class="body" x="120" y="68" width="60" height="120" rx="30"/>
    <path class="split" d="M150 68v40M120 108h60"/>
    <rect class="wheel" x="145" y="80" width="10" height="18" rx="5"/>
  </svg>${caption(`${p.sensitivity.toFixed(2)}x · ${p.invertY ? "inverted" : "standard"}`)}</div>`;
}

/** a speaker whose three waves light up with the master volume (a cross when muted) */
export function speakerViz(): string {
  const m = Math.round(preferences.value.master * 100), n = m === 0 ? 0 : m < 34 ? 1 : m < 67 ? 2 : 3;
  const waves = [0, 1, 2].map((i) => `<path class="${i < n ? "on" : "off"}" d="M${130 + i * 26} ${50 - i * 14}a${40 + i * 26} ${40 + i * 26} 0 0 1 0 ${60 + i * 28}"/>`).join("");
  return `<svg class="tn-set-speaker" viewBox="0 0 280 160" aria-hidden="true"><path class="body" d="M40 60h30l40-32v104L70 100H40z"/>
    ${waves}${m === 0 ? '<path class="mute" d="M140 55l50 50M190 55l-50 50"/>' : ""}</svg>${caption(`Master ${m}%`)}`;
}

/** live radial preview for Visualize sound effects (crosshair + footsteps, gunshots, chests, vehicles) */
export function soundViz(): string {
  const on = preferences.value.visualSound;
  const op = on ? "1" : "0.25";
  return `<div class="tn-set-fig"><svg viewBox="0 0 280 184" style="width:250px;height:auto" aria-hidden="true">
    <circle cx="140" cy="92" r="52" fill="none" stroke="var(--kong-rule)" stroke-width="2" stroke-dasharray="4 4"/>
    <path d="M140 80v8M140 96v8M128 92h8M144 92h8" stroke="var(--kong-text)" stroke-width="2.5" stroke-linecap="round"/>
    <g opacity="${op}">
      <!-- Top: Gunshot burst -->
      <path d="M120 44a52 52 0 0 1 40 0" fill="none" stroke="var(--kong-danger)" stroke-width="5" stroke-linecap="round"/>
      <circle cx="140" cy="20" r="14" fill="var(--kong-bg)" stroke="var(--kong-outline)" stroke-width="2"/>
      <path d="M140 10l2.4 5.8 6.1-.8-3.7 5 3.7 5-6.1-.8L140 30l-2.4-5.8-6.1.8 3.7-5-3.7-5 6.1.8z" fill="var(--kong-danger)"/>
      <!-- Right: Chest -->
      <path d="M188 72a52 52 0 0 1 0 40" fill="none" stroke="var(--kong-accent)" stroke-width="5" stroke-linecap="round"/>
      <circle cx="212" cy="92" r="14" fill="var(--kong-bg)" stroke="var(--kong-outline)" stroke-width="2"/>
      <path d="M204 89c0-3 3.5-5 8-5s8 2 8 5v9h-16v-9z" fill="var(--kong-accent)"/>
      <path d="M204 91h16" stroke="var(--kong-bg)" stroke-width="1.8"/>
      <rect x="210.5" y="90" width="3" height="4" rx="1" fill="var(--kong-bg)"/>
      <!-- Left: Footsteps -->
      <path d="M92 112a52 52 0 0 1 0-40" fill="none" stroke="var(--kong-text)" stroke-width="5" stroke-linecap="round"/>
      <circle cx="68" cy="92" r="14" fill="var(--kong-bg)" stroke="var(--kong-outline)" stroke-width="2"/>
      <ellipse cx="64" cy="90" rx="2.6" ry="4.6" transform="rotate(-10 64 90)" fill="var(--kong-text)"/>
      <ellipse cx="64.5" cy="97.5" rx="2.2" ry="2" fill="var(--kong-text)"/>
      <ellipse cx="72" cy="87" rx="2.6" ry="4.6" transform="rotate(10 72 87)" fill="var(--kong-text)"/>
      <ellipse cx="71.5" cy="94.5" rx="2.2" ry="2" fill="var(--kong-text)"/>
      <!-- Bottom: Vehicle steering wheel -->
      <path d="M160 140a52 52 0 0 1-40 0" fill="none" stroke="var(--kong-sky)" stroke-width="5" stroke-linecap="round"/>
      <circle cx="140" cy="164" r="14" fill="var(--kong-bg)" stroke="var(--kong-outline)" stroke-width="2"/>
      <circle cx="140" cy="164" r="8" fill="none" stroke="var(--kong-sky)" stroke-width="2.4"/>
      <circle cx="140" cy="164" r="2.2" fill="var(--kong-sky)"/>
      <path d="M132 164h16M140 164v8" stroke="var(--kong-sky)" stroke-width="2.2" stroke-linecap="round"/>
    </g>
  </svg>${caption(on ? "On · Shot (red) · Chest (gold) · Steps (white) · Vehicle (blue)" : "Off · Radial sound ring hidden")}</div>`;
}

/** the field of view: the game stores the vertical angle; the wedge is the horizontal one at 16:9, dashed = 90° */
export function fovViz(display: Display): string {
  const v = display.settings.fov, h = hfov(v);
  const at = (deg: number) => { const r = deg / 2 * Math.PI / 180; return [140 + Math.sin(r) * 150, 186 - Math.cos(r) * 150, 140 - Math.sin(r) * 150]; };
  const [x1, y1, x2] = at(h), [g1, k1, g2] = at(90);
  return `<div class="tn-set-fig"><svg class="tn-set-fov" viewBox="0 0 280 200" aria-hidden="true">
    <path class="ref" d="M140 186L${g1.toFixed(1)} ${k1.toFixed(1)}M140 186L${g2.toFixed(1)} ${k1.toFixed(1)}"/>
    <path class="wedge" d="M140 186L${x1.toFixed(1)} ${y1.toFixed(1)}A150 150 0 0 0 ${x2.toFixed(1)} ${y1.toFixed(1)}Z"/>
    <circle class="eye" cx="140" cy="186" r="9"/></svg>${caption(`${h}° horizontal at 16:9 · dashed 90°`)}</div>`;
}

const LEVEL_N: Record<Level, number> = { low: 1, medium: 2, high: 3, epic: 4 };
/** each graphics option as four level pips (anti-aliasing and ambient occlusion as text), from the live settings */
export function gfxViz(display: Display): string {
  const s = display.settings;
  const pips = (n: number) => `<span class="pips">${[1, 2, 3, 4].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;
  const row = (label: string, inner: string) => `<div><span class="k tn-eyebrow">${label}</span>${inner}</div>`;
  const preset = s.preset === "auto" ? `Auto · ${s.auto}` : s.preset;
  return `<div class="tn-set-gfx">
    ${row("Anti-aliasing", `<b>${s.aa === "off" ? "Off" : s.aa.toUpperCase()}</b>`)}
    ${row("View distance", pips(LEVEL_N[s.viewDist]))}${row("Shadows", pips(LEVEL_N[s.shadows]))}
    ${row("Ambient occlusion", `<b>${s.ao ? "On" : "Off"}</b>`)}
    ${row("Post processing", pips(LEVEL_N[s.post]))}${row("Foliage", pips(LEVEL_N[s.foliage]))}${row("Effects", pips(LEVEL_N[s.effects]))}
  </div>${caption(`Preset: ${preset}`)}`;
}

/** the real detected values (the video menu's old info box): GPU, the detected preset and the bench, the screen and 3D
 *  resolution, the refresh rate and the live frame rate */
export function hwRows(engine: Engine, display: Display): string {
  const s = display.settings, c = engine.renderer.domElement;
  const w = Math.round(c.width * engine.renderScale), h = Math.round(c.height * engine.renderScale);
  const b = display.bench;
  const row = (k: string, v: string) => `<dt>${k}</dt><dd>${v}</dd>`;
  return row("GPU", esc(display.gpu || "unknown"))
    + row("Detected preset", `${esc(display.gpuLevel.charAt(0).toUpperCase() + display.gpuLevel.slice(1))}${b ? ` · bench ${b.gpuMs ? `${b.gpuMs} ms GPU` : `${b.fps} fps`} → ${esc(b.to)}` : ""}`)
    + row("Screen", `${c.width} × ${c.height} · 3D ${w} × ${h}${s.dynres ? " (dynamic)" : ""}`)
    + row("Refresh", `${engine.refreshHz || "?"} Hz`)
    + row("Now", `${engine.liveFps()} fps${engine.gpuMs ? ` · GPU ${engine.gpuMs.toFixed(1)} ms` : ""}`);
}

/** HUD preview: clones of the live HUD's health / shield and slot components (whatever the HUD shows right now: the real
 *  loadout in a match), sized by the HUD size setting inside the panel, and the menu text specimen at the text size */
export function hudPreview(): HTMLElement {
  const box = document.createElement("div"); box.className = "tn-set-prev";
  const eb = document.createElement("div"); eb.className = "tn-eyebrow"; eb.textContent = "Preview";
  const hud = document.createElement("div"); hud.className = "kr-root tn-set-hud"; hud.setAttribute("aria-hidden", "true");
  const live = [...document.querySelectorAll<HTMLElement>(".kr-root")].find((r) => !r.classList.contains("tn-set-hud"));
  for (const sel of [".kr-vitals", ".kr-hotbar"]) {
    const src = live?.querySelector<HTMLElement>(`:scope > ${sel}`);
    if (src) hud.append(src.cloneNode(true));
  }
  // (on the title the HUD has never been fed a state: its bars sit full and its numbers are empty — label them as full)
  for (const n of hud.querySelectorAll<HTMLElement>(".kr-vitals .num")) if (!n.textContent) n.textContent = "100";
  const spec = document.createElement("p"); spec.className = "tn-set-specimen";
  spec.textContent = "The storm is closing in. Get inside the white circle.";
  box.append(eb, hud, spec);
  return box;
}
/** fit the preview's HUD into the panel: the HUD unit is the HUD size × a fixed share of the design unit `tu` (px), shrunk
 *  only if it would overflow. (Pixels, not var(--tu): inside .kr-root, --tu is derived from --u — toon.ts.) */
export function fitHudPreview(box: HTMLElement, tu: number) {
  const hud = box.querySelector<HTMLElement>(".tn-set-hud"); if (!hud || !hud.childElementCount) return;
  const hs = preferences.value.hudScale, u = 0.42 * hs * tu;
  hud.style.setProperty("--u", `${u.toFixed(4)}px`);
  const avail = hud.clientWidth, need = Math.max(...[...hud.children].map((c) => (c as HTMLElement).getBoundingClientRect().width));
  if (need > avail && avail > 0) hud.style.setProperty("--u", `${(u * avail / need).toFixed(4)}px`);
}

/** the binding's keycaps, big */
export function bindViz(caps: Array<{ text: string; html?: string; unbound: boolean; bound: boolean }>, capturing: boolean): string {
  const keys = caps.filter((c) => c.bound || c.unbound).map((c) => `<kbd class="tn-key${c.unbound ? " tn-key--unbound" : ""}">${c.html || esc(c.text)}</kbd>`).join("");
  return `<div class="tn-set-bindviz"><span class="keys">${keys}</span><span class="tn-support">${capturing ? "Press a key or mouse button · Esc cancels · Backspace clears" : "Enter or click a slot to rebind"}</span></div>`;
}
