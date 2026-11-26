// Toon lobby styles (the Play screen). Every size is a design px on the 1920×1080 canvas through T(); colours, outlines,
// drops, radii and motion are the Toon tokens (ui/toon.ts). The layout is measured at 1920×1080.
// Screen-local classes are `tn-play-*`.
// Some lobby buttons also carry `.kr-btn` (the controller's first-focus hook in game/index.ts): the rules here restate
// every property menu-styles.ts's `.kr-btn` sets, at a higher specificity.
import { addCss } from "./styles";
import { T } from "./toon";

export function injectLobbyStyles(): void { addCss("kr-ui-lobby-toon", CSS); }

/** a colour token at an opacity (no raw hex in screen code) */
const a = (token: string, pct: number) => `color-mix(in srgb, var(${token}) ${pct}%, transparent)`;
const hair = `max(1px, ${T(1)})`;

const CSS = `
.kr-lobby.tn-play { position: fixed; inset: 0; z-index: 10; overflow: hidden; font-family: var(--kong-font-ui); color: var(--kong-text);
  font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
/* the art leads: the live title scene (game/title.ts) shows through; a deep-navy fade carries the left column */
.tn-play-shade { position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(90deg, ${a("--kong-bg", 95)} 0%, ${a("--kong-bg", 85)} 28%, ${a("--kong-bg", 30)} 42%, transparent 55%),
              linear-gradient(180deg, ${a("--kong-bg", 50)}, transparent 18%, transparent 80%, ${a("--kong-bg", 60)}); }
/* ui/settings.ts mounts its gear into the lobby: the Settings pill is its face here (Esc and the controller's MENU click it) */
.kr-lobby.tn-play > .kr-video-gear { display: none !important; }

/* ---------------- brand + nav */
.tn-play-brand { position: absolute; left: ${T(84)}; top: ${T(44)}; width: ${T(400)}; }
.tn-play-nav { position: absolute; left: ${T(640)}; top: ${T(46)}; display: flex; gap: ${T(10)}; }
.tn-play-nav .tn-pill { font-size: ${T(18)}; line-height: ${T(27)}; padding: ${T(10)} ${T(22)}; }
.tn-play .tn-pill { --tn-play-drop: var(--kong-drop-pill); }

/* ---------------- identity (top right) */
.tn-play-id { position: absolute; right: ${T(65)}; top: ${T(44)}; display: flex; align-items: center; gap: ${T(28)}; z-index: 3; }
.tn-play-id > .tn-play-pop + .tn-play-pop { margin-left: ${T(-16)}; }
.tn-play-cs { text-align: right; }
.tn-play-cs small { display: block; font-weight: 700; font-size: ${T(14)}; line-height: ${T(21)}; letter-spacing: .2em; color: var(--kong-text-muted); }
.tn-play-cs b { display: block; font-family: var(--kong-font-display); font-weight: 400; font-size: ${T(44)}; line-height: ${T(44)}; letter-spacing: .01em;
  color: var(--kong-text); white-space: nowrap; -webkit-text-stroke: var(--kong-text-outline-md) var(--kong-outline); paint-order: stroke fill; }
.tn-play-div { width: ${hair}; height: ${T(52)}; background: ${a("--kong-text", 35)}; }

/* ---------------- secondary link pills (Firing range, Learn controls, Edit callsign, Friends, Copy link, Leave) */
.kr-lobby .tn-play-link { position: relative; top: 0; display: inline-flex; align-items: center; justify-content: center; gap: ${T(16)};
  width: auto; height: auto; padding: ${T(10)} ${T(18)}; box-sizing: border-box; cursor: pointer; list-style: none; user-select: none;
  background: var(--kong-surface-2); color: var(--kong-text); border: var(--kong-outline-sm) solid var(--kong-outline); border-radius: ${T(14)};
  box-shadow: var(--kong-drop-pill); --tn-play-drop: var(--kong-drop-pill); filter: none; opacity: 1;
  font-family: var(--kong-font-ui); font-weight: 900; font-size: ${T(16)}; line-height: ${T(26)}; letter-spacing: .18em; text-transform: uppercase; white-space: nowrap;
  transition: transform var(--kong-motion-fast) var(--kong-ease-spring), box-shadow var(--kong-motion-fast), color var(--kong-motion-fast), background var(--kong-motion-fast); }
.kr-lobby .tn-play-link::-webkit-details-marker { display: none; }
.kr-lobby .tn-play-link:hover { color: var(--kong-accent); transform: translateY(${T(-2)}); box-shadow: 0 ${T(6)} 0 var(--kong-outline); filter: none; }
.kr-lobby .tn-play-link:active { transform: translateY(${T(3)}); box-shadow: var(--kong-drop-pressed); transition-duration: 60ms; top: 0; }
.kr-lobby .tn-play-link:disabled { background: var(--kong-disabled); color: var(--kong-disabled-text); transform: none; box-shadow: var(--kong-drop-pill); cursor: default; opacity: 1; filter: none; }
.kr-lobby .tn-play-link--sm { font-size: ${T(15)}; line-height: ${T(23)}; letter-spacing: .16em; gap: ${T(10)}; }
.kr-lobby details[open] > .tn-play-link { background: var(--kong-surface-raised); color: var(--kong-accent); }
.tn-play-link:focus-visible, .tn-play-cta:focus-visible, .tn-play-tile:focus-visible, .tn-play-input:focus-visible, .tn-play-foot .kr-fs-btn:focus-visible {
  outline: var(--kong-focus-width) solid var(--kong-focus); outline-offset: var(--kong-focus-offset); }
.tn-play-ico { flex: none; width: ${T(26)}; height: ${T(26)}; }
.tn-play-ico.wide { width: ${T(30)}; }
.tn-play-link--sm .tn-play-ico { width: ${T(16)}; height: ${T(16)}; }
.tn-play-link--sm .tn-play-ico.wide { width: ${T(22)}; height: ${T(19)}; }
.tn-play-link[hidden], .tn-play-hint[hidden], .tn-play-err[hidden] { display: none; }

/* ---------------- popovers (inline callsign edit, friends) */
.tn-play-pop { position: static; }
.tn-play-panel { position: absolute; right: 0; top: calc(100% + ${T(10)}); width: ${T(420)}; box-sizing: border-box; padding: ${T(28)}; display: grid; gap: ${T(14)};
  background: var(--kong-surface); border: var(--kong-outline-md) solid var(--kong-outline); border-radius: var(--kong-radius-card);
  box-shadow: 0 ${T(8)} 0 var(--kong-outline); transform-origin: 90% 0; animation: tn-pop var(--kong-motion-slow) var(--kong-ease-spring) both; }
.tn-play-plabel { font-weight: 800; font-size: ${T(14)}; line-height: ${T(21)}; letter-spacing: .2em; text-transform: uppercase; color: var(--kong-text-muted); }
.tn-play-help { margin: 0; font-weight: 700; font-size: var(--kong-fs-support); line-height: var(--kong-lh-support); color: var(--kong-text-muted); }
.tn-play-help.is-error, .tn-play-ferr { display: flex; gap: ${T(10)}; align-items: flex-start; color: var(--kong-danger); font-weight: 800; }
.tn-play-help.is-error .tn-play-ico { width: ${T(22)}; height: ${T(22)}; }
.tn-play-ferr:empty { display: none; }
.tn-play-input { width: 100%; height: ${T(56)}; box-sizing: border-box; padding: 0 ${T(16)}; outline: none;
  background: var(--kong-bg); color: var(--kong-text); border: var(--kong-outline-sm) solid var(--kong-outline); border-radius: ${T(12)};
  box-shadow: inset 0 ${T(3)} 0 ${a("--kong-outline", 70)}; caret-color: var(--kong-accent);
  font-family: var(--kong-font-ui); font-weight: 800; font-size: ${T(26)}; letter-spacing: .12em; text-transform: uppercase; user-select: text; }
.tn-play-input::placeholder { color: var(--kong-text-faint); opacity: 1; }
.tn-play-input::selection { background: var(--kong-accent); color: var(--kong-on-accent); }
.tn-play-input[aria-invalid="true"] { border-color: var(--kong-danger); }
.tn-play-prow { display: flex; gap: ${T(12)}; justify-content: flex-end; align-items: center; margin-top: ${T(4)}; }
.tn-play-panel .tn-btn { min-height: ${T(56)}; }
.tn-play-panel .tn-btn--primary { min-width: ${T(120)}; --tn-play-drop: var(--kong-drop-button); }
.tn-play-panel .tn-btn--tertiary { min-height: ${T(48)}; padding: 0 ${T(4)}; }
.tn-play-wide { width: 100%; }
.tn-play-or { display: flex; align-items: center; gap: ${T(12)}; font-weight: 800; font-size: ${T(14)}; letter-spacing: .14em; text-transform: uppercase; color: var(--kong-text-faint); }
.tn-play-or::before, .tn-play-or::after { content: ""; flex: 1; height: ${T(2)}; border-radius: 999px; background: var(--kong-rule); }
.tn-play-joinrow { display: grid; grid-template-columns: 1fr ${T(120)}; gap: ${T(12)}; }
.tn-play-code { text-align: center; letter-spacing: .3em; }
.tn-play-toast { position: absolute; right: ${T(65)}; top: ${T(130)}; z-index: 4; opacity: 0; pointer-events: none; transform: translateY(${T(-6)});
  transition: opacity var(--kong-motion-standard), transform var(--kong-motion-standard) var(--kong-ease-spring); }
.tn-play-toast.on { opacity: 1; transform: none; }

/* ---------------- left column */
.tn-play-main { position: absolute; left: ${T(84)}; top: ${T(228)}; width: ${T(560)}; z-index: 2; }
.tn-play-sec-training, .tn-play-sec-wardrobe { display: none; }
.tn-play[data-tab="training"] .tn-play-sec-play { display: none; }
.tn-play[data-tab="training"] .tn-play-sec-training { display: block; }
.tn-play[data-tab="wardrobe"] .tn-play-sec-play { display: none; }
.tn-play[data-tab="wardrobe"] .tn-play-sec-wardrobe { display: block; }
/* non-color-only active tab indicator (WCAG 1.4.1 & forced-colors safe) */
.tn-play-nav .tn-pill { position: relative; }
.tn-play-nav .tn-pill.is-on::after { content: ""; position: absolute; left: ${T(16)}; right: ${T(16)}; bottom: ${T(4)}; border-block-end: ${T(3)} solid currentColor; border-radius: 999px; }
.tn-play-eyebrow { display: flex; align-items: center; gap: ${T(20)}; margin-bottom: ${T(20)}; font-size: ${T(16)}; line-height: ${T(24)}; letter-spacing: .1em; }
.tn-play-eyebrow::before { content: ""; flex: none; width: ${T(44)}; height: ${hair}; background: currentColor; }
.tn-play-display { margin: 0; text-transform: uppercase; white-space: nowrap; }
/* the Toon design's headline: 136 / 117, not the generic 110 lobby display */
.tn-play-sec-play .tn-play-display { font-size: ${T(136)}; line-height: ${T(117)}; letter-spacing: .01em; }
.tn-play-modeline { margin: ${T(26)} 0 0; font-weight: 700; font-size: ${T(18)}; line-height: ${T(27)}; letter-spacing: .22em; text-transform: uppercase; color: var(--kong-text-muted); white-space: nowrap; }
.tn-play-modeline b { font-weight: inherit; color: inherit; }
.tn-play[data-ui="room"] .tn-play-modeline b { font-weight: 800; color: var(--kong-text); }
.tn-play-choices { display: flex; align-items: center; gap: ${T(24)}; margin-top: ${T(36)}; min-height: ${T(60)}; }
.tn-play-modes { display: flex; gap: ${T(10)}; }
.tn-play-modes .tn-pill { font-size: ${T(22)}; line-height: ${T(33)}; padding: ${T(10)} ${T(26)}; letter-spacing: .12em; text-transform: none; }
.tn-play-bots { display: flex; align-items: center; gap: ${T(10)}; }
.tn-play-botslbl { font-weight: 900; font-size: ${T(15)}; letter-spacing: .1em; text-transform: uppercase; color: var(--kong-text-muted); }
/* the difficulty segment shares the Trios / Solo pills' 60 px
   height and drop: one row, one height */
.tn-play-bots .tn-seg { box-sizing: border-box; height: ${T(60)}; align-items: stretch; padding: ${T(5)}; box-shadow: var(--kong-drop-pill); }
.tn-play-bots .tn-seg button { display: inline-flex; align-items: center; padding: 0 ${T(16)}; line-height: ${T(22)}; font-size: ${T(17)}; }
.tn-play-bots .tn-seg button[disabled] { color: var(--kong-disabled-text); cursor: default; }
/* locked while connecting: the chosen pill keeps ivory text on the flat disabled fill, the others stay muted */
.tn-play-bots .tn-seg button.is-on[disabled] { background: var(--kong-disabled); color: var(--kong-text); }
.tn-play .tn-pill.is-on[disabled] { color: var(--kong-text); }
.tn-play-cta { margin-top: ${T(28)}; }
.tn-play-err { display: flex; align-items: flex-start; gap: ${T(10)}; margin-top: ${T(18)}; max-width: ${T(560)};
  font-weight: 800; font-size: var(--kong-fs-support); line-height: var(--kong-lh-support); color: var(--kong-danger); }
.tn-play-err .tn-play-ico { width: ${T(22)}; height: ${T(22)}; }
.tn-play-live { display: flex; align-items: center; gap: ${T(12)}; margin-top: ${T(22)}; white-space: nowrap;
  font-weight: 700; font-size: ${T(15)}; line-height: ${T(23)}; letter-spacing: .2em; text-transform: uppercase; color: var(--kong-text-muted); }
.tn-play-live i { flex: none; width: ${T(10)}; height: ${T(10)}; border-radius: 50%; background: var(--kong-success); }
.tn-play-live.is-off i { background: var(--kong-text-faint); }
.tn-play-live b { font-weight: 800; color: var(--kong-text); }
.tn-play-live .sep { letter-spacing: 0; }
.tn-play-links { display: flex; gap: ${T(12)}; margin-top: ${T(58)}; }

/* the one primary: the big yellow Play (512×80, Lilita 38 with the 5px dark outline) */
.kr-lobby .tn-play-cta { position: relative; top: 0; display: flex; align-items: center; justify-content: space-between; gap: ${T(24)};
  width: ${T(512)}; height: ${T(80)}; padding: 0 ${T(32)}; box-sizing: border-box; cursor: pointer; filter: none; opacity: 1;
  background: var(--kong-gradient-primary); color: var(--kong-on-accent);
  border: var(--kong-outline-md) solid var(--kong-outline); border-radius: var(--kong-radius-button); box-shadow: var(--kong-drop-button); --tn-play-drop: var(--kong-drop-button);
  font-family: var(--kong-font-display); font-weight: 400; font-size: ${T(38)}; line-height: 1; letter-spacing: .03em; text-transform: uppercase; white-space: nowrap;
  -webkit-text-stroke: var(--kong-text-outline-xs) var(--kong-outline); paint-order: stroke fill;
  transition: transform var(--kong-motion-fast) var(--kong-ease-spring), box-shadow var(--kong-motion-fast), background var(--kong-motion-fast); }
.kr-lobby .tn-play-cta:hover { transform: translateY(${T(-3)}); box-shadow: var(--kong-drop-hover); background: var(--kong-gradient-primary-hover); filter: none; }
.kr-lobby .tn-play-cta:active { transform: translateY(${T(5)}); box-shadow: var(--kong-drop-pressed); transition-duration: 60ms; top: 0; }
.kr-lobby .tn-play-cta:disabled { background: var(--kong-disabled); color: var(--kong-disabled-text); -webkit-text-stroke-width: 0; transform: none;
  box-shadow: var(--kong-drop-button); cursor: default; opacity: 1; filter: none; }
.tn-play-cta .lbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; padding: ${T(3)} 0; }
/* the action's detail (vs bots, the lobby code), quiet beside the arrow: the Toon design's searching-state side label */
.tn-play-cta .sub { margin-left: auto; font-family: var(--kong-font-ui); font-weight: 900; font-size: ${T(16)}; letter-spacing: .16em; -webkit-text-stroke-width: 0; }
.tn-play-cta .sub:empty { display: none; }
.tn-play-cta .tn-play-ico.arrow { width: ${T(30)}; height: ${T(22)}; margin-right: ${T(-4)}; }
.tn-play-cta:disabled .tn-play-ico.arrow { display: none; }
.tn-play-spin { display: none; flex: none; width: ${T(26)}; height: ${T(26)}; border-radius: 50%; box-sizing: border-box;
  border: ${T(4)} solid currentColor; border-right-color: transparent; animation: tn-play-spin .8s linear infinite; }
.tn-play-cta.is-spin .tn-play-spin { display: block; order: 2; }
@keyframes tn-play-spin { to { transform: rotate(360deg); } }
html.kr-calm .tn-play-spin { animation: none; }
@media (prefers-reduced-motion: reduce) { .tn-play-spin { animation: none; } }

/* ---------------- the playtest title (ui/title-flags.ts → data-playtest): one Play, room to breathe —
   no Trios / Solo, no bot difficulty, no Friends popover (an invite link / private room still shows its own controls) */
.tn-play[data-playtest][data-ui="home"] .tn-play-choices { display: none; }
.tn-play[data-playtest][data-ui="home"] .tn-play-cta { margin-top: ${T(48)}; }
.tn-play[data-playtest] .tn-play-pop[hidden] { display: none; }
.tn-play[data-playtest] .tn-play-id > .tn-play-pop + .tn-play-pop { margin-left: 0; }

/* ---------------- private lobby room */
.tn-play-coderow, .tn-play-roster, .tn-play-leavebar { display: none; }
.tn-play[data-ui="room"] .tn-play-display, .tn-play[data-ui="room"] .tn-play-links > :not(.tn-play-leavebar) { display: none; }
.tn-play[data-ui="room"] .tn-play-coderow { display: flex; align-items: center; gap: ${T(24)}; }
.tn-play[data-ui="room"] .tn-play-leavebar { display: flex; }
.tn-play[data-ui="room"] .tn-play-roster { display: grid; }
.tn-play[data-ui="room"] .tn-play-modeline { margin-top: ${T(18)}; }
.tn-play[data-ui="room"] .tn-play-choices { margin-top: ${T(24)}; }
.tn-play[data-ui="room"].guest .tn-play-choices { display: none; }
.tn-play[data-ui="room"] .tn-play-links { margin-top: ${T(32)}; }
.tn-play[data-ui="room"] .tn-play-bots, .tn-play[data-ui="invite"] .tn-play-bots, .tn-play[data-ui="invite"] .tn-play-modes { display: none; }
.tn-play-roomcode { letter-spacing: .12em; }
.tn-play-roster { gap: ${T(8)}; margin-top: ${T(24)}; max-height: ${T(300)}; overflow-y: auto; scrollbar-width: none; }
.tn-play-roster.solo { grid-template-columns: 1fr 1fr; }
.tn-play-squad { display: grid; grid-template-columns: ${T(84)} 1fr 1fr 1fr; gap: ${T(8)}; align-items: center; }
.tn-play-squad .sq { font-weight: 900; font-size: ${T(14)}; letter-spacing: .12em; text-transform: uppercase; color: var(--kong-text-muted); }
.tn-play-squad.is-mine .sq { color: var(--kong-text); }
.tn-play-chip { position: relative; display: flex; align-items: center; gap: ${T(6)}; min-width: 0; height: ${T(40)}; padding: 0 ${T(12)}; box-sizing: border-box;
  background: var(--kong-surface); border: var(--kong-outline-sm) solid var(--kong-outline); border-radius: 999px; box-shadow: 0 ${T(3)} 0 var(--kong-outline);
  font-weight: 900; font-size: ${T(14)}; letter-spacing: .03em; text-transform: uppercase; color: var(--kong-text); }
.tn-play-chip.is-long { font-size: ${T(12)}; letter-spacing: 0; padding: 0 ${T(10)}; }
.tn-play-chip .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tn-play-chip .tn-play-ico.wide { width: ${T(20)}; height: ${T(17)}; color: var(--kong-accent); }
/* me: the ivory pill (like the active sub-tab), not yellow (yellow = the primary, the selection, health) */
.tn-play-chip.is-me { background: var(--kong-text); color: var(--kong-outline); }
.tn-play-chip.is-me .tn-play-ico.wide { color: var(--kong-accent-shade); }
.tn-play-chip.is-bot { background: transparent; border-style: dashed; border-color: var(--kong-rule-strong); box-shadow: none; color: var(--kong-text-faint); font-weight: 800; }

/* ---------------- Training tab */
.tn-play-tiles { display: grid; gap: ${T(12)}; margin-top: ${T(40)}; width: ${T(560)}; }
.tn-play-tile { display: grid; grid-template-columns: 1fr auto; column-gap: ${T(16)}; row-gap: ${T(6)}; align-items: center; text-align: left; cursor: pointer;
  padding: ${T(22)} ${T(24)}; background: var(--kong-surface); color: var(--kong-text); --tn-play-drop: var(--kong-drop-tile);
  border: var(--kong-outline-sm) solid var(--kong-outline); border-radius: var(--kong-radius-tile); box-shadow: var(--kong-drop-tile);
  transition: transform var(--kong-motion-fast) var(--kong-ease-spring), box-shadow var(--kong-motion-fast), background var(--kong-motion-fast); }
.tn-play-tile b { font-family: var(--kong-font-display); font-weight: 400; font-size: ${T(40)}; line-height: 1; letter-spacing: .01em; text-transform: uppercase; transition: color var(--kong-motion-fast); }
.tn-play-tile span { grid-column: 1; font-weight: 600; font-size: ${T(18)}; line-height: ${T(27)}; color: var(--kong-text-muted); }
.tn-play-tile .tn-play-ico.chev { grid-column: 2; grid-row: 1 / span 2; width: ${T(26)}; height: ${T(16)}; color: var(--kong-text-muted); transition: color var(--kong-motion-fast); }
.tn-play-tile:hover { background: var(--kong-surface-2); transform: translateY(${T(-2)}); box-shadow: 0 ${T(7)} 0 var(--kong-outline); }
.tn-play-tile:hover b, .tn-play-tile:hover .chev { color: var(--kong-accent); }
.tn-play-tile:active { transform: translateY(${T(3)}); box-shadow: var(--kong-drop-pressed); transition-duration: 60ms; }
.tn-play-tile:disabled { background: var(--kong-disabled); color: var(--kong-disabled-text); transform: none; box-shadow: var(--kong-drop-tile); cursor: default; }
.tn-play-tile:disabled b, .tn-play-tile:disabled span, .tn-play-tile:disabled .chev { color: var(--kong-disabled-text); }
.tn-play-keyshead { margin: ${T(36)} 0 ${T(14)}; }
.tn-play-keyshead::before { display: none; }
/* (the controls strip, current bindings: two rows, a little wider than the column) */
.tn-play-keys { display: flex; flex-wrap: wrap; gap: ${T(14)} ${T(26)}; width: ${T(700)}; }
.tn-play-keys .tn-play-hint { color: var(--kong-text); }

/* ---------------- Wardrobe tab */
.tn-play-sec-wardrobe .tn-play-display { font-size: ${T(92)}; line-height: ${T(84)}; }
.tn-wd-groups { display: grid; gap: ${T(20)}; margin-top: ${T(24)}; width: ${T(580)}; }
.tn-wd-group { display: grid; gap: ${T(10)}; }
.tn-wd-head { margin: 0; font-family: var(--kong-font-ui); font-weight: 900; font-size: ${T(14)}; line-height: ${T(20)}; letter-spacing: .2em; text-transform: uppercase; color: var(--kong-text-muted); display: flex; align-items: center; justify-content: space-between; }
.tn-wd-head small { font-weight: 700; letter-spacing: .12em; color: var(--kong-accent); }
.tn-wd-grid { display: flex; flex-wrap: wrap; gap: ${T(9)}; }
.tn-wd-chip { position: relative; display: inline-flex; align-items: center; gap: ${T(7)}; min-block-size: ${T(44)}; min-inline-size: ${T(44)}; padding: ${T(8)} ${T(16)}; box-sizing: border-box; cursor: pointer;
  background: var(--kong-surface); color: var(--kong-text); border: var(--kong-outline-sm) solid var(--kong-outline); border-radius: ${T(12)}; box-shadow: var(--kong-drop-pill); --tn-play-drop: var(--kong-drop-pill);
  font-family: var(--kong-font-ui); font-weight: 800; font-size: ${T(15)}; line-height: ${T(22)}; letter-spacing: .08em; text-transform: uppercase;
  transition: transform var(--kong-motion-fast) var(--kong-ease-spring), background var(--kong-motion-fast), color var(--kong-motion-fast); }
.tn-wd-chip:hover { background: var(--kong-surface-2); transform: translateY(${T(-2)}); }
.tn-wd-chip:active { transform: translateY(${T(2)}); }
.tn-wd-chip[aria-checked="true"] { background: var(--kong-accent); color: var(--kong-on-accent); border-color: var(--kong-outline); }
.tn-wd-chip[aria-checked="true"]::before { content: ""; width: ${T(8)}; height: ${T(8)}; border-radius: 50%; background: currentColor; flex: none; }
.tn-wd-chip[aria-disabled="true"] { background: var(--kong-disabled); color: var(--kong-disabled-text); cursor: not-allowed; opacity: .82; }
.tn-wd-chip[aria-disabled="true"]:hover { transform: none; }
.tn-wd-chip .tn-play-ico { width: ${T(16)}; height: ${T(18)}; }
.tn-wd-chip:focus-visible, .tn-wd-swatch:focus-visible { outline: var(--kong-focus-width) solid var(--kong-focus); outline-offset: var(--kong-focus-offset); }
.tn-wd-swatches { display: flex; flex-wrap: wrap; gap: ${T(12)}; align-items: center; }
.tn-wd-swatch { position: relative; min-inline-size: ${T(44)}; min-block-size: ${T(44)}; padding: 0; border-radius: 50%; cursor: pointer;
  background: var(--sw); border: var(--kong-outline-sm) solid var(--kong-outline); box-shadow: var(--kong-drop-pill); --tn-play-drop: var(--kong-drop-pill);
  display: grid; place-items: center; transition: transform var(--kong-motion-fast) var(--kong-ease-spring); }
.tn-wd-swatch:hover { transform: translateY(${T(-2)}) scale(1.06); }
.tn-wd-swatch[aria-checked="true"] { border-color: var(--kong-text); box-shadow: 0 0 0 ${T(3)} var(--kong-accent), var(--kong-drop-pill); }
.tn-wd-swatch[aria-checked="true"]::after { content: ""; width: ${T(14)}; height: ${T(8)}; border-left: ${T(3.5)} solid #fff; border-bottom: ${T(3.5)} solid #fff; transform: rotate(-45deg) translateY(${T(-1)}); filter: drop-shadow(0 1px 2px rgba(0,0,0,0.85)); }
.tn-wd-actions { display: flex; flex-wrap: wrap; gap: ${T(10)}; margin-top: ${T(6)}; }
.tn-wd-stage { position: absolute; left: 42%; right: 0; top: ${T(130)}; bottom: ${T(120)}; z-index: 1; display: none; cursor: grab; touch-action: pan-y; }
.tn-wd-stage.is-drag { cursor: grabbing; }
.tn-play[data-tab="wardrobe"] .tn-wd-stage { display: block; }
.tn-wd-draghint { position: absolute; right: ${T(76)}; bottom: ${T(12)}; padding: ${T(8)} ${T(16)}; border-radius: 999px; pointer-events: none;
  background: ${a("--kong-bg", 72)}; border: var(--kong-outline-sm) solid ${a("--kong-text", 28)};
  font-weight: 800; font-size: ${T(14)}; letter-spacing: .16em; text-transform: uppercase; color: var(--kong-text-muted); }

/* ---------------- footer: keycap hints */
.tn-play-foot { position: absolute; left: ${T(84)}; bottom: ${T(52)}; z-index: 2; display: flex; align-items: center; gap: ${T(36)}; }
.tn-play-hint { display: inline-flex; align-items: center; gap: ${T(12)}; white-space: nowrap;
  font-weight: 900; font-size: ${T(16)}; line-height: ${T(24)}; letter-spacing: .1em; text-transform: uppercase; color: var(--kong-text-muted); }
.tn-play-hint .tn-key { font-size: ${T(16)}; }
.tn-play-foot { gap: ${T(36)}; }
/* ui/fullscreen.ts's toggle, adopted into the footer: a keycap hint you can click */
.kr-lobby .tn-play-foot .kr-fs-btn { position: static !important; right: auto !important; top: auto !important; height: auto !important; z-index: auto;
  display: inline-flex; align-items: center; gap: ${T(12)}; padding: 0; margin: 0; background: none; border: 0; border-radius: ${T(4)}; box-shadow: none; cursor: pointer;
  font-family: var(--kong-font-ui); font-weight: 900; font-size: ${T(16)}; line-height: ${T(24)}; letter-spacing: .1em; text-transform: uppercase; color: var(--kong-text-muted);
  transition: color var(--kong-motion-fast); }
.kr-lobby .tn-play-foot .kr-fs-btn:hover, .kr-lobby .tn-play-foot .kr-fs-btn:focus-visible { background: none; color: var(--kong-text); }
.kr-lobby .tn-play-foot .kr-fs-btn svg { display: none; }
.kr-lobby .tn-play-foot .kr-fs-btn small { order: -1; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
  height: ${T(34)}; min-width: ${T(34)}; padding: 0 ${T(8)}; opacity: 1; border-radius: var(--kong-radius-key);
  border: var(--kong-outline-sm) solid var(--kong-outline); box-shadow: var(--kong-drop-pill); background: var(--kong-accent); color: var(--kong-on-accent);
  font-family: var(--kong-font-ui); font-weight: 900; font-size: ${T(16)}; line-height: ${T(20)}; letter-spacing: .06em; transition: transform var(--kong-motion-fast) var(--kong-ease-spring); }
.kr-lobby .tn-play-foot .kr-fs-btn:active small { transform: translateY(${T(3)}); box-shadow: var(--kong-drop-pressed); }

/* ---------------- controller focus inside the lobby: the Toon ring (4px white, 3px offset), the element keeps its drop */
html.kr-pad .kr-lobby .kr-padfocus { outline: var(--kong-focus-width) solid var(--kong-focus) !important; outline-offset: var(--kong-focus-offset) !important;
  box-shadow: var(--tn-play-drop, none) !important; }

/* ---------------- motion: content swaps (tabs, home ↔ room) and pops; the motion tokens are 0 under reduced motion */
.tn-play-swap { animation: tn-play-swap var(--kong-motion-slow) var(--kong-ease-out) backwards; }
@keyframes tn-play-swap { from { opacity: 0; transform: translateY(${T(10)}); } }
.tn-play-popin { animation: tn-pop var(--kong-motion-standard) var(--kong-ease-spring) both; }
html.kr-calm .tn-play-panel, html.kr-calm .tn-play-popin, html.kr-calm .tn-play-swap { animation: none; }
`;
