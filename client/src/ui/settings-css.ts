// SETTINGS (Toon) · styles. Authored on the 1920×1080 canvas (T(n) = n design px, ui/toon.ts) with the Toon tokens and
// tn- primitives; screen-local classes are tn-set-*. Geometry:
// 80 px margins, a 1040 px settings table and the help panel after a 113 px gutter, the footer on a 3 px rule.
// Menu text size (preferences.uiScale) scales every type token in here through --ts; the layout reflows (rows grow,
// labels wrap) instead of magnifying.
import { T } from "./toon";

/** a type size scaled by Menu text size */
const S = (n: number) => `calc(${n} * var(--tu) * var(--ts))`;

export const SETTINGS_CSS = `
/* ---------------- root: a full-screen layer over the live scene (title or match) ---------------- */
.kr-video.tn-set { position: fixed; inset: 0; z-index: 60; display: none; pointer-events: auto; user-select: none; -webkit-user-select: none;
  color: var(--kong-text); font-family: var(--kong-font-ui); font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; --ts: 1;
  --kong-fs-title: ${T(88)}; --kong-lh-title: ${T(92)}; --kong-fs-heading: ${S(32)}; --kong-lh-heading: ${S(36)};
  --kong-fs-label: ${S(21)}; --kong-lh-label: ${S(28)}; --kong-fs-body: ${S(19)}; --kong-lh-body: ${S(28)};
  --kong-fs-tab: ${S(17)}; --kong-lh-tab: ${S(22)}; --kong-fs-support: ${S(16)}; --kong-lh-support: ${S(22)};
  --kong-fs-key: ${S(17)}; --kong-lh-key: ${S(20)}; }
.kr-video.tn-set.on { display: block; }
.tn-set *, .tn-set *::before, .tn-set *::after { box-sizing: border-box; }
:where(.tn-set) :where(button) { font: inherit; color: inherit; margin: 0; }
/* rows take focus for screen readers and the controller; the ring is drawn by .is-kbd / html.kr-pad below */
.tn-set .tn-set-row.tn-tile:focus-visible { outline: none; }
.tn-set [hidden] { display: none !important; }
/* the scrim: deep navy over the left two thirds, the live scene showing through on the right (the Toon design's art at 32%) */
.tn-set-scrim { position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(ellipse 70% 60% at 20% 0%, color-mix(in srgb, var(--kong-surface-2) 72%, var(--kong-rule)) 0%, transparent 70%),
    linear-gradient(90deg, var(--kong-bg) 0%, var(--kong-bg) 53%, color-mix(in srgb, var(--kong-bg) 68%, transparent) 86%, color-mix(in srgb, var(--kong-bg) 68%, transparent) 100%); }
/* while Settings is up it is the one layer: the title's UI, the pause card and the HUD step out of the way */
html.kr-settings-open .kr-lobby, html.kr-settings-open .kr-pause, html.kr-settings-open .kr-root:not(.tn-set-hud),
html.kr-settings-open .kr-padhints { visibility: hidden !important; }

/* ---------------- the shell grid ---------------- */
.tn-set-in { position: absolute; top: ${T(40)}; bottom: ${T(40)}; left: max(${T(80)}, calc(50% - ${T(880)})); right: max(${T(80)}, calc(50% - ${T(880)}));
  display: grid; grid-template-rows: auto auto auto auto minmax(0, 1fr) auto; grid-template-columns: minmax(0, 1fr); }
.tn-set.on .tn-set-in { animation: tn-set-in var(--kong-motion-slow) var(--kong-ease-out) both; }
@keyframes tn-set-in { from { opacity: 0; transform: scale(1.02); } }
.tn-set-top { display: flex; justify-content: space-between; align-items: flex-start; min-height: ${T(59.5)}; }
.tn-set-logo { width: ${T(160)}; }
.tn-set-back { appearance: none; display: inline-flex; align-items: center; gap: ${T(14)}; padding: ${T(10)} ${T(18)}; border-radius: ${T(14)};
  border: var(--kong-outline-sm) solid var(--kong-outline); background: var(--kong-surface-2); box-shadow: var(--kong-drop-pill); cursor: pointer;
  color: var(--kong-text); font-family: var(--kong-font-ui); font-weight: 600; font-size: ${S(17)}; line-height: ${S(26.35)}; letter-spacing: .2em; text-transform: uppercase;
  transition: transform var(--kong-motion-fast) var(--kong-ease-spring); }
.tn-set-back b { font-weight: 900; }
.tn-set-back:hover { background: var(--kong-surface-raised); transform: translateY(${T(-2)}); }
.tn-set-back:active { transform: translateY(${T(3)}); box-shadow: var(--kong-drop-pressed); }
.tn-set-title { margin: ${T(22)} 0 ${T(14)}; }
.tn-set-cats { display: flex; align-items: flex-start; gap: ${T(10)}; min-height: ${T(58)}; }
.tn-set-qe { margin-left: auto; align-self: center; display: flex; gap: ${T(10)}; padding-left: ${T(24)}; }
.tn-set-sub { margin-top: ${T(24)}; margin-bottom: ${T(21)}; display: flex; align-items: center; gap: ${T(8)}; min-height: ${T(44)}; }
.tn-set .tn-subtab { letter-spacing: .2em; }
.tn-set-sub .tn-key { margin-left: ${T(20)}; }
.tn-set-body { display: grid; grid-template-columns: ${T(1040)} minmax(0, 1fr); column-gap: ${T(113)}; min-height: 0; }

/* ---------------- rows: outlined tiles, the selected one yellow ---------------- */
.tn-set-table { min-height: 0; overflow-y: auto; scrollbar-width: none; display: grid; gap: ${T(10)}; align-content: stretch;
  margin: ${T(-2)} ${T(-2)} ${T(-2)} ${T(-4)}; padding: ${T(8)} ${T(10)} ${T(16)} ${T(8)}; overscroll-behavior: contain; }
.tn-set-table::-webkit-scrollbar { display: none; }
.tn-set-table.tn-set-swap, .tn-set-help.tn-set-swap { animation: tn-set-swap var(--kong-motion-slow) var(--kong-ease-spring) backwards; }
@keyframes tn-set-swap { from { opacity: 0; transform: translateY(${T(10)}); } }
.tn-set-row { position: relative; display: flex; flex-wrap: wrap; align-items: center; column-gap: ${T(24)}; row-gap: ${T(10)}; min-height: ${T(84)};
  padding: ${T(12)} ${T(24)} ${T(12)} ${T(40)}; outline: none; }
.tn-set-row[data-id^="slotPref-"] { min-height: ${T(54)}; padding-top: ${T(6)}; padding-bottom: ${T(6)}; }
.tn-set-table:has([data-id^="autoSort"]) { align-content: start; }
.tn-set-row .lbl { flex: 1 1 ${T(220)}; min-width: 0; }
.tn-set-row .lbl small { display: block; margin-top: ${T(2)}; font-family: var(--kong-font-ui); font-weight: 800; font-size: var(--kong-fs-support); line-height: var(--kong-lh-support); color: var(--kong-text-muted); }
.tn-set-err { flex: 1 0 100%; order: 3; margin-top: ${T(-4)}; font-family: var(--kong-font-ui); font-weight: 800; font-size: var(--kong-fs-support); line-height: var(--kong-lh-support); color: var(--kong-danger); }
.tn-set-row .ctl { flex: 0 1 auto; min-width: min(${T(560)}, 100%); margin-left: auto; display: flex; align-items: center; justify-content: flex-end; gap: ${T(20)}; flex-wrap: wrap; }
.tn-set-row.is-off .tn-switch .sw { background: var(--kong-disabled); }
.tn-set-row.is-off .tn-switch, .tn-set-row.is-off .lbl { color: var(--kong-disabled-text); }
.tn-set-msg { padding: ${T(10)} ${T(40)}; font-family: var(--kong-font-ui); font-weight: 800; font-size: var(--kong-fs-support); line-height: var(--kong-lh-support); color: var(--kong-text-muted); }
.tn-set-msg.is-error { color: var(--kong-danger); }
/* keyboard / controller focus: the 4 px white ring outside the selected tile */
.tn-set.is-kbd .tn-set-row.is-sel, html.kr-pad .tn-set .tn-set-row.is-sel { outline: var(--kong-focus-width) solid var(--kong-focus); outline-offset: var(--kong-focus-offset); }
/* (padnav's own yellow ring gives way to the Toon focus ring inside Settings) */
html.kr-pad .tn-set .tn-set-row.kr-padfocus { outline: var(--kong-focus-width) solid var(--kong-focus) !important; outline-offset: var(--kong-focus-offset) !important;
  box-shadow: var(--kong-drop-tile), 0 0 0 var(--kong-outline-sm) var(--kong-outline) !important; }
html.kr-pad .tn-set .tn-btn.kr-padfocus { outline: var(--kong-focus-width) solid var(--kong-focus) !important; outline-offset: var(--kong-focus-offset) !important; box-shadow: var(--kong-drop-button) !important; }
.tn-set-row.is-sel.is-error, .tn-set-row.is-error { border-color: var(--kong-danger); }

/* ---------------- controls ---------------- */
.tn-set-sl { display: flex; align-items: center; gap: ${T(28)}; }
.tn-set-sl .tn-slider { width: ${T(360)}; height: ${T(32)}; }
.tn-set-sl .tn-slider.is-drag .thumb { transform: scale(1.12); }
.tn-set-val { min-width: ${T(96)}; text-align: right; font-weight: 900; font-size: var(--kong-fs-label); line-height: var(--kong-lh-label); font-variant-numeric: tabular-nums; }
.tn-set .tn-cycle { gap: 0; }
.tn-set .tn-cycle .v { min-width: ${T(160)}; font-size: var(--kong-fs-label); line-height: var(--kong-lh-label); padding: 0 ${T(8)}; }
.tn-set .tn-cycle button { font-size: ${S(22)}; line-height: 1; display: grid; place-items: center; padding: 0 0 ${T(3)}; transition: transform var(--kong-motion-fast) var(--kong-ease-spring); }
.tn-set .tn-cycle button:active { transform: scale(.9); }
.tn-set .tn-switch { gap: ${T(16)}; font-size: var(--kong-fs-label); line-height: var(--kong-lh-label); }
.tn-set .tn-switch .t { min-width: ${T(40)}; text-align: right; }
.tn-set .tn-switch[aria-disabled="true"] { cursor: default; }
.tn-set .tn-seg button { font-size: ${S(17)}; line-height: ${S(26)}; }
.tn-set .tn-seg button:active { transform: scale(.94); }
.tn-set-bind { display: flex; gap: ${T(12)}; flex-wrap: wrap; justify-content: flex-end; }
.tn-set-slot { appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: ${T(8)}; min-width: ${T(150)}; min-height: ${T(44)};
  padding: ${T(4)} ${T(14)}; border-radius: ${T(12)}; border: var(--kong-outline-sm) solid var(--kong-outline); background: var(--kong-text); color: var(--kong-outline);
  box-shadow: var(--kong-drop-pill); cursor: pointer; font-family: var(--kong-font-ui); font-weight: 900; font-size: var(--kong-fs-key); line-height: var(--kong-lh-key);
  letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; transition: transform var(--kong-motion-fast) var(--kong-ease-spring); }
.tn-set-slot:hover { transform: translateY(${T(-2)}); }
.tn-set-slot:active { transform: translateY(${T(3)}); box-shadow: var(--kong-drop-pressed); }
.tn-set-slot.is-empty { background: transparent; color: var(--kong-text-faint); border-style: dashed; border-color: var(--kong-rule-strong); box-shadow: none; }
.tn-set-slot.is-unbound { background: var(--kong-danger); color: var(--kong-text); }
.tn-set-slot.is-capture { background: var(--kong-accent); color: var(--kong-on-accent); border-style: solid; border-color: var(--kong-outline); box-shadow: var(--kong-drop-pill);
  animation: tn-set-pulse 1.2s ease-in-out infinite; }
@keyframes tn-set-pulse { 50% { box-shadow: var(--kong-drop-pill), 0 0 0 ${T(6)} color-mix(in srgb, var(--kong-accent) 35%, transparent); } }
html.kr-calm .tn-set-slot.is-capture { animation: none; }
.tn-set.is-kbd .tn-set-row.is-sel .tn-set-slot.is-target, html.kr-pad .tn-set .tn-set-row.is-sel .tn-set-slot.is-target { outline: var(--kong-focus-width) solid var(--kong-focus); outline-offset: var(--kong-focus-offset); }
.tn-set-glyph { display: inline-grid; place-items: center; min-width: ${T(28)}; height: ${T(28)}; padding: 0 ${T(6)}; border-radius: 999px; background: var(--kong-outline);
  color: var(--c, var(--kong-text)); font-family: var(--kong-font-ui); font-weight: 900; font-size: ${S(15)}; letter-spacing: 0; }
.tn-set-glyph.w { border-radius: ${T(8)}; font-size: ${S(12)}; }
.tn-set-act { min-height: ${T(44)}; padding: 0 ${T(22)}; }

/* ---------------- contextual help panel ---------------- */
.tn-set-help { align-self: start; max-height: 100%; overflow-y: auto; scrollbar-width: none; display: grid; gap: ${T(10)}; align-content: start;
  padding: ${T(22)} ${T(26)}; border-radius: var(--kong-radius-panel); border: var(--kong-outline-md) solid var(--kong-outline);
  background: color-mix(in srgb, var(--kong-surface) 88%, transparent); box-shadow: var(--kong-drop-card); }
.tn-set-help::-webkit-scrollbar { display: none; }
.tn-set-help h3 { margin: 0; }
.tn-set-help p { margin: 0; max-width: ${T(470)}; font-family: var(--kong-font-ui); font-weight: 600; font-size: var(--kong-fs-body); line-height: var(--kong-lh-body);
  color: color-mix(in srgb, var(--kong-text) 84%, var(--kong-text-muted)); }
.tn-set-viz { margin-top: ${T(6)}; display: grid; gap: ${T(10)}; justify-items: start; }
.tn-set-viz svg { display: block; overflow: visible; }
.tn-set-cap { color: var(--kong-text-muted); }
.tn-set-fig { display: grid; justify-items: center; gap: ${T(6)}; width: ${T(300)}; text-align: center; }
/* mouse (line art) */
.tn-set-mouse { width: ${T(300)}; height: auto; }
.tn-set-mouse .arc { fill: none; stroke: var(--kong-accent); stroke-width: 2.5; stroke-dasharray: 4 6; stroke-linecap: round; }
.tn-set-mouse .side { fill: none; stroke: var(--kong-text-muted); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
.tn-set-mouse .tick { stroke: var(--kong-accent); stroke-width: 3; stroke-linecap: round; }
.tn-set-mouse .body, .tn-set-mouse .split, .tn-set-mouse .wheel { fill: none; stroke: var(--kong-text); stroke-width: 3; }
.tn-set-mouse .wheel { stroke-width: 2.5; }
/* speaker (line art) */
.tn-set-speaker { width: ${T(280)}; height: auto; margin-bottom: ${T(-18)}; }
.tn-set-speaker .body { fill: none; stroke: var(--kong-text); stroke-width: 3; stroke-linejoin: miter; }
.tn-set-speaker path.on, .tn-set-speaker path.off { fill: none; stroke-width: 3; }
.tn-set-speaker path.on { stroke: var(--kong-accent); }
.tn-set-speaker path.off { stroke: var(--kong-rule-strong); }
.tn-set-speaker .mute { fill: none; stroke: var(--kong-danger); stroke-width: 3; stroke-linecap: round; }
.tn-set-speaker + .tn-set-cap { padding-left: ${T(20)}; }
/* field of view */
.tn-set-fov { width: ${T(300)}; height: auto; }
.tn-set-fov .ref { fill: none; stroke: var(--kong-text-muted); stroke-width: 3; stroke-dasharray: 5 7; stroke-linecap: round; }
.tn-set-fov .wedge { fill: color-mix(in srgb, var(--kong-accent) 18%, transparent); stroke: var(--kong-accent); stroke-width: 4; stroke-linejoin: round; }
.tn-set-fov .eye { fill: var(--kong-text); stroke: var(--kong-outline); stroke-width: 4; }
/* graphics levels */
.tn-set-gfx { display: grid; gap: ${T(10)}; width: 100%; max-width: ${T(440)}; }
.tn-set-gfx > div { display: grid; grid-template-columns: ${T(190)} 1fr; gap: ${T(16)}; align-items: center; }
.tn-set-gfx b { font-weight: 900; font-size: var(--kong-fs-support); }
.tn-set-gfx .pips { display: flex; gap: ${T(5)}; }
.tn-set-gfx .pips i { flex: 1; height: ${T(12)}; border-radius: 999px; background: var(--kong-outline); box-shadow: inset 0 0 0 ${T(2)} var(--kong-rule); }
.tn-set-gfx .pips i.on { background: linear-gradient(180deg, var(--kong-accent-light), var(--kong-accent-shade)); box-shadow: inset 0 0 0 ${T(2)} var(--kong-outline); }
/* binding keycaps */
.tn-set-bindviz { display: flex; flex-wrap: wrap; gap: ${T(12)} ${T(18)}; align-items: center; margin-top: ${T(4)}; }
.tn-set-bindviz .keys { display: flex; gap: ${T(10)}; }
.tn-set-bindviz .tn-key { height: auto; min-height: ${S(30)}; padding: ${T(3)} ${T(10)}; font-size: ${S(14)}; }
.tn-set-bindviz .tn-support { color: var(--kong-text-muted); }
/* hardware details */
.tn-set-disc { margin-top: ${T(8)}; padding-top: ${T(14)}; border-top: ${T(2)} solid var(--kong-rule); width: 100%; }
.tn-set-disc summary { display: flex; align-items: center; gap: ${T(10)}; cursor: pointer; list-style: none; color: var(--kong-text-muted); }
.tn-set-disc summary::-webkit-details-marker { display: none; }
.tn-set-disc summary:hover { color: var(--kong-text); }
.tn-set-disc summary .tri { display: inline-block; font-size: ${S(11)}; transition: transform var(--kong-motion-fast) var(--kong-ease-spring); }
.tn-set-disc[open] summary .tri { transform: rotate(90deg); }
.tn-set-disc summary .tn-key { height: ${S(28)}; min-width: ${S(28)}; font-size: ${S(13)}; margin-left: auto; }
.tn-set-hw { display: grid; grid-template-columns: auto 1fr; gap: ${T(6)} ${T(16)}; margin: ${T(12)} 0 0; font-weight: 700; font-size: var(--kong-fs-support); line-height: var(--kong-lh-support); }
.tn-set-hw dt { color: var(--kong-text-muted); }
.tn-set-hw dd { margin: 0; color: var(--kong-text); overflow-wrap: anywhere; }
/* controller diagram + legend + live line */
.tn-set-padsvg { width: 100%; max-width: ${T(340)}; height: auto; }
.tn-set-padsvg .g0 { stop-color: var(--kong-rule-strong); } .tn-set-padsvg .g1 { stop-color: var(--kong-rule); } .tn-set-padsvg .g2 { stop-color: var(--kong-surface-2); }
.tn-set-padsvg .body { fill: url(#tnSetPadBody); stroke: var(--kong-outline); stroke-width: 6; stroke-linejoin: round; }
.tn-set-padsvg .drop { fill: var(--kong-outline); }
.tn-set-padsvg .shine { fill: none; stroke: var(--kong-text); stroke-opacity: .18; stroke-width: 8; stroke-linecap: round; }
.tn-set-padsvg .btn rect, .tn-set-padsvg .btn circle, .tn-set-padsvg .hub { fill: var(--kong-surface); stroke: var(--kong-outline); stroke-width: 4; }
.tn-set-padsvg .hub { stroke: none; fill: var(--kong-rule-strong); }
.tn-set-padsvg rect.btn { fill: var(--kong-rule-strong); stroke: var(--kong-outline); stroke-width: 3; }
.tn-set-padsvg circle.btn.stick { fill: var(--kong-surface-2); stroke: var(--kong-outline); stroke-width: 4; }
.tn-set-padsvg rect.btn.hl, .tn-set-padsvg rect.btn.on, .tn-set-padsvg circle.btn.stick.on { fill: var(--kong-accent); }
.tn-set-padsvg .well { fill: var(--kong-outline); }
.tn-set-padsvg .cap { fill: var(--kong-rule-strong); stroke: var(--kong-outline); stroke-width: 3; pointer-events: none; }
.tn-set-padsvg .face circle { fill: var(--kong-surface); }
.tn-set-padsvg .face text { fill: var(--c); }
.tn-set-padsvg .face.fill circle { fill: var(--c); }
.tn-set-padsvg .face.fill text { fill: var(--kong-text); }
.tn-set-padsvg .face.fill.light text { fill: var(--kong-outline); }
.tn-set-padsvg .home circle { fill: var(--kong-accent); }
.tn-set-padsvg text { fill: var(--kong-text); font: 900 17px ${"'Nunito', sans-serif"}; text-anchor: middle; pointer-events: none; }
.tn-set-padsvg text.small { font-size: 13px; } .tn-set-padsvg text.tiny { font-size: 12px; letter-spacing: 1.5px; fill: var(--kong-text-muted); }
.tn-set-padsvg .ring { fill: none; stroke: var(--kong-accent); stroke-width: 5; }
.tn-set-padsvg .ring2 { fill: none; stroke: var(--kong-accent); stroke-width: 2.5; opacity: .4; }
.tn-set-padsvg .btn.hl rect, .tn-set-padsvg .btn.hl circle { fill: var(--kong-accent); }
.tn-set-padsvg .btn.hl text { fill: var(--kong-outline); }
.tn-set-padsvg .btn.on rect, .tn-set-padsvg .btn.on circle, .tn-set-padsvg .face.on circle { fill: var(--kong-accent) !important; }
.tn-set-padsvg .btn.on text { fill: var(--kong-outline) !important; }
.tn-set-padsvg .tfill { fill: var(--kong-accent) !important; stroke: none !important; }
.tn-set-legend { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: ${T(6)} ${T(18)}; width: 100%; }
.tn-set-legend > div { display: flex; gap: ${T(10)}; align-items: center; font-weight: 800; font-size: ${S(15)}; line-height: ${S(19)}; color: var(--kong-text); }
.tn-set-legend > div.is-hl { color: var(--kong-accent); }
.tn-set-legend .tn-key { height: ${S(28)}; min-width: ${S(30)}; padding: 0 ${T(6)}; font-size: ${S(13)}; flex: none; }
.tn-set-padline { display: flex; align-items: center; gap: ${T(10)}; }
.tn-set-padline .dot { width: ${T(10)}; height: ${T(10)}; border-radius: 50%; background: var(--kong-rule-strong); box-shadow: 0 0 0 ${T(2)} var(--kong-outline); flex: none; }
.tn-set-padline .dot.on { background: var(--kong-success); }
.tn-set-padlast { display: flex; align-items: center; gap: ${T(10)}; min-height: ${T(28)}; font-weight: 800; font-size: var(--kong-fs-support); color: var(--kong-text); }
.tn-set-padlast:empty { display: none; }
.tn-set-sticks { width: 100%; height: auto; display: block; }
.tn-set-curve { width: ${T(260)}; height: auto; }
.tn-set-curve .axis { fill: none; stroke: var(--kong-rule-strong); stroke-width: 4; stroke-linecap: round; }
.tn-set-curve .ref { fill: none; stroke: var(--kong-text-muted); stroke-width: 2.5; stroke-dasharray: 5 7; }
.tn-set-curve .line { fill: none; stroke: var(--kong-accent); stroke-width: 6; stroke-linecap: round; stroke-linejoin: round; }
/* HUD preview */
.tn-set-prev { display: grid; gap: ${T(18)}; width: 100%; padding: ${T(22)} ${T(24)}; border-radius: var(--kong-radius-tile); border: var(--kong-outline-sm) solid var(--kong-outline);
  background: color-mix(in srgb, var(--kong-outline) 45%, transparent); }
.tn-set-hud.kr-root { position: relative !important; inset: auto !important; contain: none !important; overflow: visible !important; width: 100%; height: auto;
  display: flex; flex-direction: column; align-items: flex-start; gap: calc(16 * var(--u)); pointer-events: none; }
.tn-set-hud.kr-root > * { position: relative !important; left: auto !important; right: auto !important; top: auto !important; bottom: auto !important; transform: none !important; margin: 0 !important; }
.tn-set-specimen { margin: 0; font-family: var(--kong-font-ui); font-weight: 700; font-size: var(--kong-fs-body); line-height: var(--kong-lh-body); color: var(--kong-text); }

/* ---------------- footer ---------------- */
.tn-set-foot { margin-top: ${T(16)}; padding-top: ${T(24)}; border-top: ${T(3)} solid var(--kong-rule); display: flex; align-items: center; justify-content: space-between; gap: ${T(24)}; flex-wrap: wrap; }
.tn-set-hint { appearance: none; background: none; border: 0; padding: 0; display: inline-flex; align-items: center; gap: ${T(12)}; font-family: var(--kong-font-ui); font-weight: 900;
  font-size: var(--kong-fs-support); line-height: ${S(24.8)}; letter-spacing: .1em; text-transform: uppercase; color: var(--kong-text-muted); white-space: nowrap; }
.tn-set-restore { color: var(--kong-text); cursor: pointer; border-radius: ${T(10)}; }
.tn-set-restore:hover .tn-key { transform: translateY(${T(-2)}); }
.tn-set-restore:active .tn-key { transform: translateY(${T(3)}); box-shadow: var(--kong-drop-pressed); }
.tn-set-restore .tn-key { transition: transform var(--kong-motion-fast) var(--kong-ease-spring); }
.tn-set-hints { display: flex; gap: ${T(28)}; }
.tn-set-clear { color: var(--kong-text); cursor: pointer; border-radius: ${T(10)}; }
.tn-set .tn-key { height: ${S(34)}; min-width: ${S(34)}; }
.tn-set-status { display: inline-flex; align-items: center; gap: ${T(12)}; font-family: var(--kong-font-ui); font-weight: 900; font-size: var(--kong-fs-support); line-height: ${S(24.8)};
  letter-spacing: .1em; text-transform: uppercase; color: var(--kong-text-muted); transition: color var(--kong-motion-standard); }
.tn-set-status svg { width: ${T(22)}; height: ${T(22)}; color: var(--kong-success); flex: none; }
.tn-set-status.is-flash { color: var(--kong-text); }
.tn-set-status.is-error svg { color: var(--kong-danger); }

/* ---------------- focus on the chrome (pointer + keyboard) ---------------- */
.tn-set-back:focus-visible, .tn-set-restore:focus-visible, .tn-set .tn-pill:focus-visible, .tn-set .tn-subtab:focus-visible, .tn-set-disc summary:focus-visible,
.tn-set-dlg .tn-btn.is-focus { outline: var(--kong-focus-width) solid var(--kong-focus); outline-offset: var(--kong-focus-offset); }
.tn-set button:focus:not(:focus-visible) { outline: none; }

/* ---------------- confirm dialog + toast ---------------- */
.tn-set-dlg { position: absolute; inset: 0; z-index: 5; display: grid; place-items: center; background: var(--kong-scrim);
  animation: tn-set-fade var(--kong-motion-standard) ease-out both; }
@keyframes tn-set-fade { from { opacity: 0; } }
.tn-set-dlg .tn-dialog { width: min(${T(680)}, calc(100vw - ${T(64)})); padding: ${T(40)}; display: grid; gap: ${T(20)}; }
.tn-set-dlg h2 { margin: 0; font-family: var(--kong-font-display); font-weight: 400; font-size: ${S(44)}; line-height: 1.05; letter-spacing: .01em;
  -webkit-text-stroke: var(--kong-text-outline-md) var(--kong-outline); paint-order: stroke fill; color: var(--kong-text); text-transform: uppercase; }
.tn-set-dlg p { margin: 0; }
.tn-set-dlg .acts { display: flex; justify-content: flex-end; gap: ${T(16)}; margin-top: ${T(12)}; flex-wrap: wrap; }
.tn-set-dlg .tn-btn { min-height: ${T(56)}; min-width: ${T(160)}; font-size: ${S(18)}; }
.tn-set-toast { position: absolute; left: 50%; top: ${T(96)}; z-index: 6; transform: translateX(-50%); pointer-events: none; font-size: var(--kong-fs-body); padding: ${T(14)} ${T(24)} ${T(14)} ${T(20)}; }
.tn-set-toast svg { width: ${T(22)}; height: ${T(22)}; color: var(--kong-success); }
.tn-set-toast.is-in { animation: tn-set-toast var(--kong-motion-slow) var(--kong-ease-spring) both; }
@keyframes tn-set-toast { from { opacity: 0; transform: translate(-50%, ${T(-14)}); } }

/* ---------------- narrow windows and enlarged text: one column, the help panel opens under the active row ---------------- */
@media (max-aspect-ratio: 13/10) {
  .kr-video.tn-set { --tu: min(calc(100vh / 1080), calc(100vw / 1180)); }
  .tn-set-in { left: ${T(40)}; right: ${T(40)}; }
  .tn-set-cats { overflow-x: auto; scrollbar-width: none; padding: ${T(8)} ${T(8)} ${T(12)}; margin: ${T(-8)} ${T(-8)} ${T(-12)}; }
  .tn-set-cats .tn-pill { flex: none; }
}
.tn-set.is-stack .tn-set-body { grid-template-columns: minmax(0, 1fr); }
.tn-set.is-stack .tn-set-table > .tn-set-help { margin: ${T(-2)} ${T(6)} ${T(6)}; max-height: none; overflow: visible;
  grid-template-columns: minmax(0, 1fr) minmax(0, ${T(560)}); column-gap: ${T(40)}; }
.tn-set.is-stack .tn-set-table > .tn-set-help > * { grid-column: 1; }
.tn-set.is-stack .tn-set-table > .tn-set-help > .tn-set-viz { grid-column: 2; grid-row: 1 / span 12; margin-top: 0; align-self: start; }
`;
