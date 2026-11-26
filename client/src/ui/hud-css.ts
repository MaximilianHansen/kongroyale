// Toon HUD skin: everything in the
// in-match HUD except the hotbar, ammo, gun, interact / loot and use / reload readouts (ui/hotbar*.ts own those).
// Sizes are design px on the 1920×1080 canvas through T() → `--tu`, which inside `.kr-root` follows the HUD unit, so
// SETTINGS → ACCESSIBILITY → HUD size scales every part here. Runtime animation is transform / opacity only.
import { T, TOON_LOGO } from "./toon";
import { addCss } from "./styles";

/** a Lilita number / title with the Toon outline behind the fill */
const lilita = (size: number, outline = 4) => `font-family: var(--kong-font-display); font-weight: 400; font-size: ${T(size)}; line-height: 1;
  -webkit-text-stroke: ${T(outline)} var(--kong-outline); paint-order: stroke fill; letter-spacing: .01em;`;
/** a Nunito label */
const nunito = (size: number, weight = 900, track = ".1em") => `font-family: var(--kong-font-ui); font-weight: ${weight}; font-size: ${T(size)}; letter-spacing: ${track};`;
/** the see-through pill every HUD chip uses: a flat dark tint, no
 *  outline, no drop, no blur; the numbers and labels on it carry their own dark outline */
const chip = `background: var(--tn-hud-chip); border-radius: 999px;`;

export const HUD_TOON_CSS = `
/* ---------- local tokens (hoist candidates: colours the Toon token set does not carry yet) ---------- */
.kr-root, .tn-hud-practice {
  --tn-hud-chip: color-mix(in srgb, var(--kong-outline) 46%, transparent);
  --tn-hud-chip-squad: linear-gradient(180deg, #1C4B6A, #12344B);
  --tn-hud-ivory-85: color-mix(in srgb, var(--kong-text) 85%, transparent);
  /* labels drawn straight over the world (the Toon design: a soft shadow) get a tight dark halo too, for sand and cloud */
  --tn-hud-soft: 0 0 ${T(2)} rgba(4, 16, 26, .9), 0 ${T(1)} ${T(6)} rgba(4, 16, 26, .85);
  /* the storm is the game's violet (map, minimap and the storm wall use it) */
  --tn-hud-storm: #B98CFF; --tn-hud-storm-text: #E9D6FF;
  /* feedback: damage is always red, blue only means healing */
  --tn-hud-dmg-glow: rgba(255, 50, 40, .75);
  --tn-hud-hurt: rgba(255, 90, 80, .55);
  --tn-hud-low: rgba(255, 60, 50, .6);
  --tn-hud-heal-glow: rgba(88, 188, 235, .7);
  --tn-hud-num-shadow: 0 ${T(2)} ${T(6)} rgba(0, 0, 0, .8);
  --tn-hud-storm-vig: radial-gradient(ellipse 80% 78% at 50% 50%, rgba(90, 40, 160, .1) 30%, rgba(96, 40, 170, .42) 78%, rgba(50, 14, 100, .8) 100%);
}
@keyframes kr-eq { from { transform: scaleY(.25); } to { transform: scaleY(1); } }
@keyframes kr-tune { 50% { opacity: .35; } }
@keyframes kr-chip-warn { 50% { opacity: .5; } }

/* ---------- full-screen feedback layers (opacity only) ---------- */
.kr-vig { position: absolute; inset: 0; opacity: 0; will-change: opacity; pointer-events: none; }
.kr-vig.storm { background: var(--tn-hud-storm-vig); }
/* damage with no shooter to point at (storm, a fall, a blast): all edges, red */
.kr-vig.dmg { box-shadow: inset 0 0 ${T(180)} var(--tn-hud-hurt); }
/* your own shield breaking is damage too: a stronger red edge */
.kr-vig.shield { box-shadow: inset 0 0 ${T(200)} ${T(12)} var(--tn-hud-dmg-glow); }
/* under 30 health: a slow red vignette */
/* (a touch stronger than the Toon design's low-health vignette: it has to read over bright sand and sky) */
.kr-vig.low { box-shadow: inset 0 0 ${T(220)} ${T(30)} var(--tn-hud-low); transition: opacity 400ms ease; }
.kr-vig.low.on { opacity: .8; animation: tn-hud-low 1.6s ease-in-out infinite; }
@keyframes tn-hud-low { 50% { opacity: .45; } }
/* healing: a blue glow around all screen edges while health / shield refill (was yellow) */
.kr-vig.heal { box-shadow: inset 0 0 ${T(160)} ${T(20)} var(--tn-hud-heal-glow), inset 0 0 ${T(36)} ${T(4)} var(--tn-hud-heal-glow); transition: opacity 300ms ease; }
.kr-vig.heal.on { opacity: 1; animation: tn-hud-heal 1.2s ease-in-out infinite; }
@keyframes tn-hud-heal { 50% { opacity: .6; } }
/* the screen edge facing the shooter (hud-feedback.ts sets the gradient per hit) */
.tn-hud-edge { position: absolute; inset: 0; opacity: 0; pointer-events: none; mix-blend-mode: screen; will-change: opacity; }
html.kr-calm .kr-vig.low.on, html.kr-calm .kr-vig.heal.on { animation: none; opacity: .6; }
@media (prefers-reduced-motion: reduce) { .kr-vig.low.on, .kr-vig.heal.on { animation: none; opacity: .6; } }

/* ---------- minimap: rounded, outlined, hard drop ---------- */
.kr-minimap { position: absolute; left: ${T(40)}; top: ${T(36)}; width: ${T(262)}; height: ${T(214)}; overflow: hidden;
  border-radius: ${T(26)}; border: var(--kong-outline-md) solid var(--kong-outline); box-shadow: 0 ${T(6)} 0 var(--kong-outline);
  background: var(--kong-surface); }
/* the minimap is painted square around the player: the frame shows its middle band */
.kr-minimap canvas { position: absolute; left: 0; top: 50%; width: 100%; height: auto; aspect-ratio: 1; transform: translateY(-50%); }

/* ---------- the left column under the minimap: mode / place label, storm clock + warnings, squad ---------- */
.tn-hud-left { position: absolute; left: ${T(40)}; top: ${T(264)}; width: ${T(300)}; display: flex; flex-direction: column; align-items: flex-start; gap: ${T(8)}; pointer-events: none; }
.tn-hud-left > .kr-where + .kr-pill { margin-top: ${T(2)}; }
.tn-hud-left > .kr-squad { margin-top: ${T(6)}; order: 2; }
.tn-hud-left > .kr-bountycard { order: 1; }

/* ---------- mode label under the minimap: eyebrow + rule, then where you are ---------- */
.kr-where { position: relative; max-width: ${T(300)}; text-shadow: var(--tn-hud-soft); pointer-events: none; }
.kr-where .eb { display: flex; align-items: center; gap: ${T(12)}; ${nunito(16, 900, ".14em")} line-height: ${T(22)}; text-transform: uppercase; color: var(--kong-text); }
.kr-where .eb::after { content: ""; width: ${T(22)}; height: ${T(2)}; border-radius: 999px; background: currentColor; box-shadow: var(--tn-hud-soft); }
.kr-where .plate { display: flex; align-items: center; gap: ${T(6)}; ${nunito(16, 700, ".06em")} line-height: ${T(22)}; color: var(--tn-hud-ivory-85);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kr-where .plate:empty { display: none; }

/* ---------- compass: Lilita cardinals with an outline, Nunito degrees, a centre mark ---------- */
.kr-compass { position: absolute; left: 50%; top: ${T(20)}; width: min(${T(760)}, calc(100vw - ${T(780)})); height: ${T(60)}; transform: translateX(-50%); overflow: hidden;
  -webkit-mask-image: linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent); mask-image: linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent); }
.kr-compass canvas { position: absolute; left: 50%; top: 0; width: ${T(760)}; height: ${T(60)}; transform: translateX(-50%); }

/* ---------- storm clock: a compact pill in the left column (the players-left count is in the match stats) ---------- */
.kr-pill { position: relative; display: flex; align-items: center; gap: ${T(8)};
  height: ${T(34)}; padding: 0 ${T(14)} 0 ${T(10)}; ${chip} overflow: hidden; white-space: nowrap; }
.kr-pill .grp { display: flex; align-items: center; }
.kr-pill .grp.a { display: none; }
.kr-pill .grp.b { gap: ${T(6)}; }
.kr-pill .ic { flex: none; }
.kr-pill .ic.clock { width: ${T(18)}; height: ${T(18)}; color: var(--kong-text); }
.kr-pill .v.t { ${lilita(22)} color: var(--kong-text); font-variant-numeric: tabular-nums; min-width: ${T(44)}; }
.kr-pill .clock-label { ${nunito(12, 900, ".16em")} text-transform: uppercase; color: var(--kong-text); text-shadow: var(--tn-hud-soft); }
.kr-pill.shrink .v.t, .kr-pill.shrink .ic.clock { color: var(--tn-hud-storm-text); }
.kr-pill.urgent .v.t { color: var(--kong-warning); }

/* ---------- status line under the compass: spaced uppercase Nunito — the only thing in the top
   centre besides the compass ---------- */
.kr-substat { position: absolute; left: 50%; top: ${T(80)}; transform: translateX(-50%); max-width: calc(100vw - ${T(800)}); text-align: center;
  ${nunito(15, 900, ".26em")} line-height: ${T(22)}; text-transform: uppercase; color: var(--kong-text); text-shadow: var(--tn-hud-soft); }
.kr-substat { transition: opacity 600ms var(--kong-ease-out); }
.kr-substat.faded { opacity: 0; }
/* the warnings under the storm clock (left column): small spaced labels in their colour on a see-through pill
   (status colours always carry a label) */
.tn-hud-warn { width: max-content; max-width: ${T(340)}; padding: ${T(5)} ${T(12)}; ${chip} border-radius: ${T(14)}; ${nunito(12, 900, ".1em")} line-height: ${T(16)};
  text-transform: uppercase; color: var(--kong-text); text-shadow: var(--tn-hud-soft); }
.tn-hud-warn.storm { color: var(--tn-hud-storm-text); }
.tn-hud-warn.final { color: var(--kong-warning); }
/* active tactical & match event pills (UAV Radar Pulse, Banana Stand Fire Sale) in the left column */
.tn-hud-events { display: flex; flex-direction: column; align-items: flex-start; gap: ${T(6)}; }
.tn-hud-ev { display: inline-flex; align-items: center; gap: ${T(8)}; padding: ${T(5)} ${T(13)}; border-radius: 999px;
  ${nunito(13, 900, ".11em")} text-transform: uppercase; color: var(--kong-text); text-shadow: var(--tn-hud-soft);
  background: var(--tn-hud-chip); border: ${T(2)} solid var(--ev-c, var(--kong-accent)); box-shadow: 0 0 ${T(12)} color-mix(in srgb, var(--ev-c, var(--kong-accent)) 45%, transparent); }
.tn-hud-ev svg { width: ${T(16)}; height: ${T(16)}; flex: none; color: var(--ev-c, var(--kong-accent)); }
.tn-hud-ev.uav { --ev-c: #5cf2ff; color: #dcfaff; }
.tn-hud-ev.sale { --ev-c: #ff9f1a; color: #fff1cc; }

/* ---------- top-right column: match stats, diagnostics, kill feed ---------- */
.tn-hud-tr { position: absolute; right: ${T(44)}; top: ${T(36)}; display: flex; flex-direction: column; align-items: flex-end; gap: ${T(10)}; }
.tn-hud-ms { order: 0; display: flex; flex-direction: column; align-items: flex-end; gap: ${T(8)}; }
.tn-hud-ms:empty { display: none; }
.tn-hud-ms .row { display: flex; gap: ${T(8)}; align-items: center; }
.tn-hud-chip { display: inline-flex; align-items: center; gap: ${T(18)}; height: ${T(42)}; padding: 0 ${T(16)}; ${chip} color: var(--kong-text); white-space: nowrap; }
.tn-hud-chip.squad { background: var(--tn-hud-chip-squad); box-shadow: var(--kong-drop-pill), inset 0 0 0 ${T(2)} var(--kong-accent); }
.tn-hud-chip .st { display: inline-flex; align-items: center; gap: ${T(8)}; }
.tn-hud-chip .ic { display: inline-grid; width: ${T(22)}; height: ${T(22)}; color: var(--kong-text);
  filter: drop-shadow(0 0 ${T(1.2)} var(--kong-outline)) drop-shadow(0 0 ${T(1)} var(--kong-outline)); }
.tn-hud-chip .ic svg { width: 100%; height: 100%; }
.tn-hud-chip b { display: inline-block; ${lilita(26)} font-variant-numeric: tabular-nums; }
.tn-hud-chip .lbl { ${nunito(15, 900, ".16em")} text-transform: uppercase; margin-left: ${T(10)}; }
/* the damage chip's unit: the star alone did not say what it counts */
.tn-hud-chip .u { ${nunito(12, 900, ".12em")} color: var(--tn-hud-ivory-85); margin-left: ${T(-2)}; align-self: center; }
/* the ping / fps line keeps a clear band under it: the kill feed's first row (outlined text) no longer
   sits right against it (at 720p they read as one line) */
.kr-net { order: 1; ${nunito(13, 700, ".2em")} color: color-mix(in srgb, var(--kong-text) 75%, transparent); text-shadow: var(--tn-hud-soft); margin-bottom: ${T(10)}; }
.kr-feed { order: 2; display: flex; flex-direction: column; align-items: flex-end; gap: ${T(8)}; }
/* the kill feed is plain white Nunito with the dark outline behind it: no card, no border. Your
   side going down is red, your side's kills green (the weapon silhouette between the names wears the outline too) */
.kr-feed .row { display: flex; align-items: center; gap: ${T(10)}; height: ${T(30)};
  ${nunito(18, 900, ".01em")} line-height: 1; color: var(--kong-text); white-space: nowrap; -webkit-text-stroke: ${T(4)} var(--kong-outline); paint-order: stroke fill; }
.kr-feed .row .wi { width: ${T(44)}; height: ${T(22)};
  filter: drop-shadow(${T(1.5)} 0 0 var(--kong-outline)) drop-shadow(${T(-1.5)} 0 0 var(--kong-outline)) drop-shadow(0 ${T(1.5)} 0 var(--kong-outline)) drop-shadow(0 ${T(-1.5)} 0 var(--kong-outline)); }
.kr-feed .row .hs { width: ${T(18)}; height: ${T(18)}; margin-left: ${T(-4)}; filter: drop-shadow(0 0 ${T(1.5)} var(--kong-outline)) drop-shadow(0 0 ${T(1)} var(--kong-outline)); }
.kr-feed .row .myth { font-style: normal; ${nunito(11, 900, ".08em")} color: var(--kong-text); padding: ${T(2)} ${T(8)}; border-radius: 999px;
  background: var(--m, var(--kong-danger)); -webkit-text-stroke: 0; }
.kr-feed .row b { font-weight: 900; color: var(--kong-text); }
.kr-feed .row b.ours { color: var(--kong-success); }
.kr-feed .row .vic.ours { color: var(--kong-danger); }
.kr-feed .row .vic.knock { opacity: .85; }

/* ---------- health + shield: thick outlined capsules, Lilita numbers ----------
   one tight unit: 4 px between the rows, bigger icons with a dark outline; the empty part
   of each capsule is see-through. .glow: green around the health bar while healing, blue around the shield
   bar while charging (an outer glow only — it never tints the fill) */
.kr-vitals { position: absolute; left: ${T(44)}; bottom: ${T(40)}; display: grid; gap: ${T(4)}; }
.kr-vitals .row { position: relative; display: grid; grid-template-columns: ${T(32)} ${T(280)} auto; gap: ${T(14)}; align-items: center; height: ${T(34)}; }
.kr-vitals .ic { width: ${T(28)}; height: ${T(28)}; justify-self: center; overflow: visible; }
.kr-vitals .ic path:first-child { stroke: var(--kong-outline); stroke-width: 18; stroke-linejoin: round; paint-order: stroke fill; }
.kr-vitals .bar { position: relative; height: ${T(20)}; border-radius: 999px; background: color-mix(in srgb, var(--kong-outline) 55%, transparent);
  border: var(--kong-outline-sm) solid var(--kong-outline); box-shadow: var(--kong-drop-pill); overflow: hidden; }
/* each layer is a full-width capsule slid left (translateX): the fill keeps its round end at any value */
.kr-vitals .bar > i { position: absolute; inset: 0; border-radius: 999px; transform: translateX(-100%); will-change: transform; }
.kr-vitals .bar > i.chip { background: var(--kong-danger); }
.kr-vitals .bar > i.gain { background: color-mix(in srgb, var(--kong-text) 45%, transparent); }
.kr-vitals .row.hp .bar > i.fill { background: var(--kong-gradient-health); }
.kr-vitals .row.sh .bar > i.fill { background: var(--kong-gradient-shield); }
.kr-vitals .num { ${lilita(36)} line-height: ${T(34)}; min-width: ${T(70)}; color: var(--kong-text); font-variant-numeric: tabular-nums; }
.kr-vitals .row.low .num { color: var(--kong-danger); }
.kr-vitals .glow { position: absolute; left: ${T(46)}; width: ${T(280)}; top: ${T(7)}; height: ${T(20)}; border-radius: 999px; pointer-events: none; opacity: 0;
  box-shadow: 0 0 0 ${T(3)} var(--gr), 0 0 ${T(10)} ${T(5)} var(--g), 0 0 ${T(26)} ${T(10)} var(--g); will-change: opacity; }
.kr-vitals .row.hp { --gr: #8DFFA8; --g: rgba(91, 227, 125, .8); }
.kr-vitals .row.sh { --gr: #A8EBFF; --g: rgba(62, 196, 255, .85); }
.kr-vitals .row.glowing .glow { opacity: 1; animation: tn-hud-barglow .9s ease-in-out infinite; }
.kr-vitals .row.hp.glowing .num { color: var(--kong-success); }
.kr-vitals .row.sh.glowing .num { color: #9BE3FF; }
@keyframes tn-hud-barglow { 50% { opacity: .6; } }
html.kr-calm .kr-vitals .row.glowing .glow { animation: none; opacity: .8; }
@media (prefers-reduced-motion: reduce) { .kr-vitals .row.glowing .glow { animation: none; opacity: .8; } }
/* your shield breaking: a red sweep over the shield bar */
.kr-vitals .crack { position: absolute; left: ${T(46)}; width: ${T(280)}; top: ${T(7)}; height: ${T(20)}; border-radius: 999px; opacity: 0; pointer-events: none;
  background: linear-gradient(90deg, transparent 0%, var(--kong-danger) 45%, var(--kong-text) 50%, var(--kong-danger) 55%, transparent 100%); }
/* "Healing…" under the bars while a heal is on its way in */
.tn-hud-heal { position: absolute; left: ${T(46)}; top: calc(100% + ${T(8)}); ${nunito(15, 700, ".2em")} color: var(--kong-success); text-shadow: var(--tn-hud-soft); white-space: nowrap; opacity: 0; transition: opacity 180ms ease; }
.tn-hud-heal.on { opacity: 1; }
/* (economy) the wallet chip sits over the health bar */
.kr-root .kr-cash { left: ${T(44)}; bottom: ${T(128)}; height: ${T(42)}; gap: ${T(8)}; padding: 0 ${T(16)} 0 ${T(8)}; ${chip} border: 0; box-shadow: none; }
.kr-root .kr-cash::before { width: ${T(28)}; height: ${T(28)}; filter: none; }
.kr-root .kr-cash .v { ${lilita(24)} color: var(--kong-text); }
.kr-root .kr-cash .g { ${lilita(22)} color: var(--kong-success); text-shadow: none; }
/* in the left column: a see-through tile with a red edge, left-aligned */
.kr-root .kr-bountycard { position: relative; left: auto; top: auto; transform: none; min-width: 0; max-width: ${T(300)}; text-align: left; padding: ${T(7)} ${T(14)};
  border-radius: ${T(14)}; background: var(--tn-hud-chip); border: 0; box-shadow: inset ${T(5)} 0 0 var(--kong-danger); }
.kr-root .kr-bountycard .t { ${lilita(20)} color: var(--kong-text); }
.kr-root .kr-bountycard .s { ${nunito(11, 800, ".06em")} color: var(--tn-hud-ivory-85); margin-top: ${T(4)}; text-transform: uppercase; white-space: normal; text-shadow: var(--tn-hud-soft); }
.kr-root .kr-hunted { top: ${T(256)}; padding: ${T(8)} ${T(24)}; border-radius: 999px; ${lilita(26)} color: var(--kong-text); letter-spacing: .04em;
  background: var(--kong-gradient-danger); border: var(--kong-outline-md) solid var(--kong-outline); box-shadow: var(--kong-drop-button); animation: none; }

/* ---------- squad (trios): outlined navy tiles under the mode label ---------- */
.kr-squad { position: relative; width: ${T(260)}; display: flex; flex-direction: column; gap: ${T(10)}; }
.kr-squad .m { position: relative; height: ${T(52)}; padding: ${T(7)} ${T(12)} 0 ${T(18)}; border-radius: ${T(14)}; background: var(--tn-hud-chip);
  box-shadow: inset ${T(5)} 0 0 var(--c); }
.kr-squad .nm { ${nunito(17, 900, ".01em")} -webkit-text-stroke: ${T(3)} var(--kong-outline); paint-order: stroke fill; line-height: 1.1; color: var(--kong-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: ${T(140)}; }
.kr-squad .st { position: absolute; right: ${T(12)}; top: ${T(9)}; ${nunito(12, 900, ".12em")} line-height: 1; text-transform: uppercase; }
.kr-squad .bars { position: absolute; left: ${T(18)}; right: ${T(12)}; bottom: ${T(8)}; height: ${T(10)}; display: flex; gap: ${T(5)}; }
.kr-squad .bars b { position: relative; flex: 1; border-radius: 999px; background: color-mix(in srgb, var(--kong-outline) 70%, transparent); overflow: hidden; }
.kr-squad .bars b i { position: absolute; inset: 0; border-radius: 999px; transform: translateX(-100%); }
.kr-squad .bars b.h i { background: var(--kong-gradient-health); }
.kr-squad .bars b.s i { background: var(--kong-gradient-shield); }
.kr-squad .m.down { box-shadow: inset ${T(5)} 0 0 var(--c), inset 0 0 0 ${T(2)} var(--kong-danger); }
.kr-squad .m.down .st { color: var(--kong-danger); }
.kr-squad .m.down .bars b.h i { background: var(--kong-danger); }
.kr-squad .m.redeploy .st { color: var(--kong-warning); }
.kr-squad .m.dead { opacity: .6; }
.kr-squad .m.dead .nm { text-decoration: line-through; text-decoration-thickness: ${T(2)}; }

/* ---------- squadmate world tags (trios) ---------- */
.kr-mtags { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.kr-mtag { position: absolute; left: 0; top: 0; width: 0; height: 0; will-change: transform; }
.kr-mtag .pin { position: absolute; left: ${T(-8)}; top: ${T(-20)}; width: ${T(16)}; height: ${T(16)}; transform: rotate(45deg); background: var(--c);
  border: var(--kong-outline-sm) solid var(--kong-outline); border-radius: ${T(3)} ${T(3)} ${T(3)} 0; box-shadow: ${T(2)} ${T(2)} 0 var(--kong-outline); }
.kr-mtag .lab { position: absolute; left: 50%; bottom: ${T(26)}; transform: translateX(-50%); white-space: nowrap; text-align: center;
  ${nunito(17, 900, ".04em")} line-height: 1.1; color: var(--kong-text); -webkit-text-stroke: ${T(4)} var(--kong-outline); paint-order: stroke fill; }
.kr-mtag .nm { display: block; color: var(--c); }
.kr-mtag .d { display: block; font-size: ${T(14)}; }
.kr-mtag .st { display: block; font-size: ${T(12)}; letter-spacing: .12em; color: var(--kong-warning); }
.kr-mtag .st:empty { display: none; }
.kr-mtag .arr { display: none; position: absolute; left: ${T(-7)}; top: ${T(-17)}; width: ${T(14)}; height: ${T(14)}; transform-origin: 50% 50%; }
.kr-mtag.edge .arr { display: block; }
.kr-mtag .arr::after { content: ""; position: absolute; left: ${T(20)}; top: ${T(1)}; border: ${T(6)} solid transparent; border-left: ${T(11)} solid var(--c);
  filter: drop-shadow(${T(1.5)} 0 0 var(--kong-outline)) drop-shadow(${T(-1.5)} 0 0 var(--kong-outline)) drop-shadow(0 ${T(1.5)} 0 var(--kong-outline)) drop-shadow(0 ${T(-1.5)} 0 var(--kong-outline)); }
.kr-mtag.redeploy .pin { background: var(--kong-warning); }
.kr-mtag.redeploy .nm { color: var(--kong-warning); }
.kr-mtag.air .pin { border-radius: 50%; }

/* ---------- announcements: an outlined pill ribbon with a Lilita title ---------- */
.kr-announce { position: absolute; left: 50%; top: ${T(196)}; transform: translateX(-50%); width: max-content; max-width: calc(100vw - ${T(120)});
  display: flex; flex-direction: column; align-items: center; text-align: center; pointer-events: none; }
.kr-announce .band { position: absolute; left: 0; right: 0; top: 0; height: ${T(84)}; border-radius: 999px; background: var(--kong-gradient-panel);
  border: var(--kong-outline-md) solid var(--kong-outline); box-shadow: var(--kong-drop-card), inset 0 0 0 ${T(3)} var(--ac); }
.kr-announce .t { position: relative; display: flex; align-items: center; height: ${T(84)}; padding: 0 ${T(44)}; ${lilita(52, 5)} font-size: min(${T(52)}, 4.4vw); color: var(--tc);
  text-shadow: 0 ${T(5)} 0 var(--kong-outline); white-space: nowrap; }
/* the line under it: centred under the ribbon, wrapping inside the space between the side columns (it never widens the
   ribbon; \`translate\` centres it so the WAAPI entrance can own \`transform\`) */
.kr-announce .s { position: absolute; top: calc(100% + ${T(18)}); left: 50%; translate: -50% 0; width: max-content; max-width: calc(100vw - ${T(760)});
  ${nunito(17, 900, ".16em")} line-height: 1.35; color: var(--kong-text); text-transform: uppercase; text-shadow: var(--tn-hud-soft); white-space: normal; }
.kr-announce { --ac: var(--kong-accent); --tc: var(--kong-text); }
.kr-announce.warn { --ac: var(--kong-warning); --tc: var(--kong-warning); }
.kr-announce.storm { --ac: var(--tn-hud-storm); --tc: var(--tn-hud-storm-text); }
.kr-announce.victory { --ac: var(--kong-accent); --tc: var(--kong-accent); }
.kr-announce.kill { --ac: var(--kong-danger); --tc: var(--kong-text); }

/* ---------- location banner: a Lilita title between two outlined banana capsules ---------- */
.kr-place { position: absolute; left: 50%; top: ${T(196)}; transform: translateX(-50%); width: max-content; max-width: ${T(1000)};
  display: flex; flex-direction: column; align-items: center; text-align: center; pointer-events: none; }
.kr-place .row { display: flex; align-items: center; justify-content: center; gap: ${T(18)}; width: 100%; }
.kr-place .rule { flex: 0 0 ${T(64)}; height: ${T(10)}; border-radius: 999px; background: var(--kong-gradient-primary);
  border: var(--kong-outline-xs) solid var(--kong-outline); box-shadow: 0 ${T(3)} 0 var(--kong-outline); }
.kr-place .rule.l { transform-origin: right center; }
.kr-place .rule.r { transform-origin: left center; }
.kr-place .t { ${lilita(48, 5)} letter-spacing: .04em; white-space: nowrap; color: var(--kong-text); text-shadow: 0 ${T(6)} 0 var(--kong-outline); }
.kr-place .s { margin-top: ${T(14)}; ${nunito(16, 900, ".2em")} text-transform: uppercase; white-space: nowrap; color: var(--kong-accent); text-shadow: var(--tn-hud-soft); }

/* ---------- the tuk-tuk radio's station banner ---------- */
.kr-radio { position: absolute; left: 50%; top: ${T(214)}; transform: translateX(-50%); width: max-content; max-width: ${T(900)};
  display: flex; flex-direction: column; align-items: center; text-align: center; pointer-events: none; }
.kr-radio .st { ${lilita(46, 5)} letter-spacing: .03em; white-space: nowrap; color: var(--kong-accent); text-shadow: 0 ${T(6)} 0 var(--kong-outline); }
.kr-radio.small .st { font-size: ${T(24)}; -webkit-text-stroke-width: ${T(4)}; text-shadow: 0 ${T(3)} 0 var(--kong-outline); }
.kr-radio.off .st { color: var(--kong-text); }
.kr-radio .np { display: flex; align-items: center; gap: ${T(10)}; margin-top: ${T(12)}; height: ${T(36)}; padding: 0 ${T(16)}; ${chip}
  ${nunito(16, 900, ".08em")} line-height: 1; white-space: nowrap; color: var(--kong-text); }
.kr-radio.small .np { margin-top: ${T(8)}; }
.kr-radio .np .eq { display: flex; align-items: flex-end; gap: ${T(2)}; width: ${T(14)}; height: ${T(13)}; }
.kr-radio .np .eq i { flex: 1; height: 100%; background: var(--kong-accent); border-radius: ${T(1)}; transform-origin: bottom; transform: scaleY(.35); animation: kr-eq .9s ease-in-out infinite alternate; }
.kr-radio .np .eq i:nth-child(2) { animation-duration: .6s; animation-delay: -.3s; }
.kr-radio .np .eq i:nth-child(3) { animation-duration: .75s; animation-delay: -.5s; }
.kr-radio:not(.song) .np .eq { display: none; }
.kr-radio.ad .np { color: var(--kong-accent); }
.kr-calm .kr-radio .np .eq i { animation: none; transform: scaleY(.7); }

/* ---------- confirmations under the crosshair: Shield broken / Eliminated ---------- */
.tn-hud-confirm, .kr-elim .l1 { ${nunito(18, 900, ".3em")} line-height: 1; text-transform: uppercase; color: var(--kong-accent);
  -webkit-text-stroke: ${T(4)} var(--kong-outline); paint-order: stroke fill; white-space: nowrap; }
.tn-hud-confirm { position: absolute; left: 50%; top: calc(50% + ${T(46)}); padding-left: .3em; opacity: 0; pointer-events: none; will-change: transform, opacity; }
/* the elimination: ELIMINATED, then the name and the kill count */
.kr-elim { position: absolute; left: 50%; top: calc(50% + ${T(46)}); transform: translateX(-50%); display: grid; grid-template-columns: auto auto auto;
  grid-template-areas: "l1 l1 l1" "sk nm kc"; justify-content: center; align-items: center; column-gap: ${T(10)}; row-gap: ${T(10)}; white-space: nowrap; pointer-events: none; }
.kr-elim .tx { display: contents; }
.kr-elim .l1 { grid-area: l1; justify-self: center; padding-left: .3em; }
.kr-elim .sk { grid-area: sk; width: ${T(30)}; height: ${T(30)};
  filter: drop-shadow(${T(2)} 0 0 var(--kong-outline)) drop-shadow(${T(-2)} 0 0 var(--kong-outline)) drop-shadow(0 ${T(2)} 0 var(--kong-outline)) drop-shadow(0 ${T(-2)} 0 var(--kong-outline)); }
.kr-elim .l2 { grid-area: nm; ${lilita(32, 5)} color: var(--kong-text); text-shadow: 0 ${T(4)} 0 var(--kong-outline); }
.kr-elim .kc { grid-area: kc; display: flex; align-items: center; gap: ${T(8)}; height: ${T(38)}; padding: 0 ${T(14)}; ${chip} }
.kr-elim .kc span { ${lilita(24)} color: var(--kong-accent); }
.kr-elim .kc span:empty { display: none; }
.kr-elim .kc small { ${nunito(13, 900, ".14em")} color: var(--kong-text); text-transform: uppercase; }
/* the use / reload label is up under the crosshair: the confirmations sit under it */
.tn-hud-confirm.low, .kr-elim.low { top: calc(50% + ${T(92)}); }

/* ---------- freefall / glide: altimeter, flight keys ---------- */
/* (anchored over the hotbar's corner, which is empty in the air: clear of the kill feed at any HUD size) */
.kr-air { position: absolute; right: ${T(112)}; bottom: ${T(150)}; width: ${T(190)}; height: ${T(270)}; }
.kr-air .scale { position: absolute; right: 0; top: 0; bottom: 0; width: ${T(18)}; border-radius: 999px; background: var(--kong-outline);
  border: var(--kong-outline-sm) solid var(--kong-outline); box-shadow: var(--kong-drop-pill); overflow: hidden; }
.kr-air .scale i { position: absolute; inset: 0; transform-origin: bottom center; border-radius: 999px; background: var(--kong-gradient-primary); }
.kr-air .tk { position: absolute; right: ${T(24)}; width: ${T(10)}; height: ${T(3)}; border-radius: 999px; background: var(--kong-text); box-shadow: 0 ${T(1.5)} 0 var(--kong-outline); }
.kr-air .mk { position: absolute; right: ${T(22)}; top: 0; display: flex; align-items: center; gap: ${T(8)}; will-change: transform; }
.kr-air .mk .alt { ${lilita(40)} color: var(--kong-text); text-shadow: 0 ${T(4)} 0 var(--kong-outline); font-variant-numeric: tabular-nums; }
.kr-air .mk .alt small { ${lilita(20)} margin-left: ${T(3)}; color: var(--kong-text); }
.kr-air .mk .tri { width: 0; height: 0; border-top: ${T(10)} solid transparent; border-bottom: ${T(10)} solid transparent; border-left: ${T(14)} solid var(--kong-accent);
  filter: drop-shadow(${T(2)} 0 0 var(--kong-outline)) drop-shadow(0 ${T(2)} 0 var(--kong-outline)) drop-shadow(0 ${T(-2)} 0 var(--kong-outline)); }
.kr-air .info { position: absolute; right: ${T(22)}; bottom: ${T(-58)}; text-align: right; white-space: nowrap; }
.kr-air .mode { ${nunito(20, 900, ".2em")} line-height: 1; text-transform: uppercase; color: var(--kong-accent); -webkit-text-stroke: ${T(4)} var(--kong-outline); paint-order: stroke fill; }
.kr-air .spd { margin-top: ${T(6)}; ${nunito(16, 800, ".08em")} color: var(--kong-text); text-shadow: var(--tn-hud-soft); }
/* key rows (plane, freefall, glide, a banana bomb): keycaps + spaced labels, like the practice hints */
.kr-hint { position: absolute; left: 50%; bottom: ${T(188)}; transform: translateX(-50%); display: flex; gap: ${T(24)}; white-space: nowrap; }
.kr-hint span, .kr-veh .hints span, .tn-hud-row { display: flex; align-items: center; gap: ${T(10)}; ${nunito(15, 900, ".1em")} text-transform: uppercase;
  color: var(--kong-text); text-shadow: var(--tn-hud-soft); }
.kr-hint kbd, .kr-veh .hints kbd { text-shadow: none; }

/* ---------- swimming: the air meter: bottom third, centred above the
   key-hint row: an outlined bubble, a slim outlined capsule in shield blue (drains right to left), an AIR label ---------- */
.kr-swimair { position: absolute; left: 50%; bottom: ${T(262)}; transform: translateX(-50%); display: flex; align-items: center; gap: ${T(10)};
  white-space: nowrap; pointer-events: none; transition: opacity 0.4s; }
.kr-swimair .bub { width: ${T(24)}; height: ${T(24)}; border-radius: 50%; box-sizing: border-box; border: var(--kong-outline-sm) solid var(--kong-outline);
  background: radial-gradient(circle at 35% 30%, #ffffff 0 16%, #8FE0FF 30%, var(--kong-shield) 64%, #1E9BE0); box-shadow: 0 ${T(3)} 0 var(--kong-outline); }
.kr-swimair .bar { position: relative; width: ${T(240)}; height: ${T(18)}; border-radius: 999px; overflow: hidden;
  background: color-mix(in srgb, var(--kong-outline) 55%, transparent); border: var(--kong-outline-sm) solid var(--kong-outline); box-shadow: var(--kong-drop-pill); }
.kr-swimair .bar i { position: absolute; inset: 0; border-radius: 999px; transform: translateX(-100%); background: var(--kong-gradient-shield); transition: transform 0.15s linear; }
.kr-swimair .lb { ${nunito(15, 900, ".16em")} line-height: 1; color: var(--kong-shield); -webkit-text-stroke: ${T(4)} var(--kong-outline); paint-order: stroke fill; }
.kr-swimair.up { opacity: 0.75; }
.kr-swimair.low .bar i { background: var(--kong-gradient-danger); }
.kr-swimair.low .bub { background: radial-gradient(circle at 35% 30%, #ffffff 0 16%, #FF7A86 34%, var(--kong-danger) 75%); animation: kr-swimair-pulse 0.9s ease-in-out infinite; }
.kr-swimair.low .lb { color: var(--kong-danger); }
@keyframes kr-swimair-pulse { 50% { opacity: 0.45; } }
html.kr-calm .kr-swimair.low .bub { animation: none; }
@media (prefers-reduced-motion: reduce) { .kr-swimair.low .bub { animation: none; } }

/* ---------- chute: pull prompt + hold-to-cut bar ---------- */
.kr-chute { position: absolute; left: 50%; top: calc(50% + ${T(88)}); transform: translateX(-50%); display: flex; align-items: center; gap: ${T(12)};
  height: ${T(52)}; padding: 0 ${T(22)} 0 ${T(8)}; ${chip} white-space: nowrap; }
.kr-chute .key { display: inline-flex; align-items: center; justify-content: center; height: ${T(34)}; min-width: ${T(34)}; padding: 0 ${T(10)};
  border-radius: var(--kong-radius-key); border: var(--kong-outline-sm) solid var(--kong-outline); box-shadow: var(--kong-drop-pill);
  background: var(--kong-accent); color: var(--kong-on-accent); ${nunito(17, 900, ".02em")} text-transform: uppercase; }
.kr-chute .lb { ${nunito(17, 900, ".12em")} text-transform: uppercase; color: var(--kong-text); }
.kr-cut { position: absolute; left: 50%; top: calc(50% + ${T(88)}); transform: translateX(-50%); width: ${T(240)}; text-align: center; }
.kr-cut .lb { ${nunito(17, 900, ".2em")} line-height: 1; text-transform: uppercase; color: var(--kong-accent); -webkit-text-stroke: ${T(4)} var(--kong-outline); paint-order: stroke fill; }
.kr-cut .bar { position: relative; margin-top: ${T(10)}; height: ${T(16)}; border-radius: 999px; overflow: hidden; background: var(--kong-outline);
  border: var(--kong-outline-sm) solid var(--kong-outline); box-shadow: var(--kong-drop-pill); }
.kr-cut .bar i { position: absolute; inset: 0; transform-origin: left center; transform: scaleX(0); background: var(--kong-gradient-primary); }

/* ---------- redeploy / spectate ---------- */
.kr-redeploy { position: absolute; left: 50%; top: ${T(350)}; transform: translateX(-50%); text-align: center; white-space: nowrap; }
.kr-redeploy .l { ${nunito(22, 900, ".3em")} text-transform: uppercase; color: var(--kong-text); text-shadow: var(--tn-hud-soft); padding-left: .3em; }
.kr-redeploy .n { margin-top: ${T(6)}; ${lilita(120, 6)} color: var(--kong-accent); text-shadow: 0 ${T(8)} 0 var(--kong-outline); font-variant-numeric: tabular-nums; }
.kr-redeploy .s { margin-top: ${T(14)}; ${nunito(16, 900, ".12em")} text-transform: uppercase; color: var(--kong-text); text-shadow: var(--tn-hud-soft); }
.kr-spectate { position: absolute; left: 50%; bottom: ${T(180)}; transform: translateX(-50%); display: flex; align-items: center; gap: ${T(14)}; height: ${T(52)};
  padding: 0 ${T(24)} 0 ${T(18)}; ${chip} white-space: nowrap; }
.kr-spectate .eye { width: ${T(28)}; height: ${T(20)}; }
.kr-spectate .l { ${nunito(15, 900, ".2em")} text-transform: uppercase; color: var(--kong-text-muted); }
.kr-spectate b { ${lilita(26)} color: var(--kong-accent); }

/* ---------- enemy hit numbers: Lilita, outlined; shield icon on shield hits, cracked shield on the break ---------- */
.kr-dmg { position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: ${T(6)}; white-space: nowrap; will-change: transform, opacity;
  ${lilita(34, 5)} color: var(--kong-text); text-shadow: var(--tn-hud-num-shadow); }
.kr-dmg .ic { display: none; flex: none; width: ${T(28)}; height: ${T(28)}; background: url('${TOON_LOGO.shieldHit}') center / contain no-repeat;
  filter: drop-shadow(${T(2)} ${T(2)} 0 var(--kong-outline)) drop-shadow(${T(-2)} ${T(-2)} 0 var(--kong-outline)); }
.kr-dmg.shield .ic { display: block; }
.kr-dmg.break .ic { display: block; width: ${T(46)}; height: ${T(46)}; background-image: url('${TOON_LOGO.shieldBreak}'); }
.kr-dmg.head { color: var(--kong-accent); font-size: ${T(42)}; }
.kr-dmg.kill { font-size: ${T(42)}; }
.kr-dmg.pred { color: var(--kong-text-muted); }

/* ---------- centre fx canvas ---------- */
.kr-center { position: absolute; left: 50%; top: 50%; width: ${T(600)}; height: ${T(600)}; transform: translate(-50%,-50%); }
.kr-center canvas { width: 100%; height: 100%; }

/* ---------- aboard a tuk-tuk / KONG AIR: a Toon panel (speed · the cab and its seats · hull · radio), keys above ---------- */
.kr-veh { position: absolute; left: 50%; bottom: ${T(40)}; transform: translateX(-50%); }
.kr-veh .pnl { position: relative; display: flex; align-items: stretch; height: ${T(104)}; background: var(--kong-gradient-panel);
  border: var(--kong-outline-md) solid var(--kong-outline); border-radius: var(--kong-radius-panel); box-shadow: var(--kong-drop-card); }
.kr-veh .spd { width: ${T(112)}; display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1; border-right: ${T(3)} solid var(--kong-rule); }
.kr-veh .spd b { ${lilita(50)} color: var(--kong-text); font-variant-numeric: tabular-nums; }
.kr-veh .spd small { ${nunito(12, 900, ".2em")} color: var(--kong-text-muted); margin-top: ${T(4)}; }
.kr-veh .spd .gear { margin-top: ${T(5)}; padding: ${T(2)} ${T(8)}; border-radius: 999px; border: var(--kong-outline-xs) solid var(--kong-outline);
  background: var(--kong-warning); color: var(--kong-on-accent); ${nunito(11, 900, ".12em")} visibility: hidden; }
.kr-veh.rev .spd .gear { visibility: visible; }
.kr-veh .car { position: relative; width: ${T(128)}; flex: none; }
.kr-veh .car svg { position: absolute; left: 50%; top: ${T(6)}; width: ${T(63)}; height: ${T(88)}; transform: translateX(-50%); overflow: visible; }
.kr-veh .car .s { fill: var(--kong-outline); stroke: var(--kong-text-muted); stroke-width: 2; transition: fill .15s; }
.kr-veh .car .s.on { fill: var(--kong-text); stroke: var(--kong-outline); }
.kr-veh .car .s.me { fill: var(--kong-accent); stroke: var(--kong-outline); }
.kr-veh .car kbd { position: absolute; transform: translate(-50%, -50%); }
/* small keycaps inside the panel */
.kr-veh .car kbd.tn-key, .kr-veh .swap kbd.tn-key, .kr-veh .radio kbd.tn-key { height: ${T(22)}; min-width: ${T(22)}; padding: 0 ${T(5)}; font-size: ${T(12)};
  border-width: var(--kong-outline-xs); border-radius: ${T(6)}; box-shadow: 0 ${T(2)} 0 var(--kong-outline); }
.kr-veh .car kbd.me { visibility: hidden; }
.kr-veh .car kbd.full { opacity: .4; }
.kr-veh .car .swap { position: absolute; left: 50%; bottom: ${T(-16)}; transform: translateX(-50%); white-space: nowrap; display: flex; align-items: center; gap: ${T(6)};
  height: ${T(28)}; padding: 0 ${T(10)} 0 ${T(4)}; ${chip} ${nunito(12, 900, ".1em")} color: var(--kong-text); }
.kr-veh .car .swap kbd { position: static; transform: none; }
.kr-veh .info { width: ${T(250)}; padding: ${T(10)} ${T(18)} ${T(10)} ${T(6)}; display: flex; flex-direction: column; justify-content: center; gap: ${T(10)}; }
.kr-veh .nm { display: flex; align-items: baseline; justify-content: space-between; ${nunito(17, 900, ".12em")} line-height: 1; color: var(--kong-text); }
.kr-veh .nm em { font-style: normal; ${lilita(20)} color: var(--kong-text); }
.kr-veh .hull { display: flex; gap: ${T(5)}; height: ${T(16)}; }
.kr-veh .hull i { position: relative; flex: 1; border-radius: 999px; background: var(--kong-outline); border: var(--kong-outline-xs) solid var(--kong-outline); overflow: hidden; }
.kr-veh .hull i b { position: absolute; inset: 0; transform-origin: left center; background: var(--kong-gradient-health); transition: transform .15s linear; }
.kr-veh.mid .hull i b { background: var(--kong-warning); }
.kr-veh.low .hull i b, .kr-veh.fire .hull i b { background: var(--kong-gradient-danger); }
.kr-veh .radio { display: flex; align-items: center; gap: ${T(8)}; height: ${T(22)}; ${nunito(14, 800, ".06em")} color: var(--kong-text); line-height: 1; white-space: nowrap; }
.kr-veh .radio .st { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.kr-veh .radio.off .st { color: var(--kong-text-muted); }
.kr-veh .eq { display: flex; align-items: flex-end; gap: ${T(2)}; width: ${T(15)}; height: ${T(14)}; }
.kr-veh .eq i { flex: 1; height: 100%; background: var(--kong-accent); border-radius: ${T(1)}; transform-origin: bottom; transform: scaleY(.3); }
.kr-veh .radio.on .eq i { animation: kr-eq .9s ease-in-out infinite alternate; }
.kr-veh .radio.on .eq i:nth-child(2) { animation-duration: .6s; animation-delay: -.3s; }
.kr-veh .radio.on .eq i:nth-child(3) { animation-duration: .75s; animation-delay: -.5s; }
.kr-veh .radio.off .eq i { background: var(--kong-text-muted); }
.kr-veh .radio.tune .st { animation: kr-tune .12s steps(2) infinite; }
.kr-veh .hints { position: absolute; left: 50%; bottom: calc(100% + ${T(16)}); transform: translateX(-50%); display: flex; gap: ${T(18)}; white-space: nowrap;
  transition: opacity .7s ease, transform .7s ease; }
.kr-veh .hints.fade:not(.keeps) { opacity: 0; transform: translate(-50%, ${T(6)}); }
.kr-veh .hints.keeps { gap: 0; }
.kr-veh .hints.keeps span { margin: 0 ${T(9)}; max-width: ${T(320)}; transition: opacity .6s ease, max-width .6s ease .25s, margin .6s ease .25s; }
.kr-veh .hints.fade.keeps span:not(.keep) { opacity: 0; max-width: 0; margin: 0; overflow: hidden; }
.kr-veh .hints span.hot { color: var(--kong-accent); }
.kr-veh .hints span.hot kbd { background: var(--kong-accent); animation: tn-hud-hot 1.1s ease-in-out infinite; }
@keyframes tn-hud-hot { 50% { transform: scale(1.14); } }
.kr-veh .hints span.fill kbd { background: linear-gradient(90deg, var(--kong-accent) calc(var(--p, 0) * 100%), var(--kong-text) calc(var(--p, 0) * 100%)); }
.kr-veh .hints span.fill.on { color: var(--kong-accent); }
.kr-veh .hints span.warn { color: var(--kong-warning); }
.kr-veh .hints span.warn kbd { background: var(--kong-warning); animation: kr-chip-warn .5s steps(2) infinite; }
.kr-veh.fire .pnl { box-shadow: var(--kong-drop-card), inset 0 0 0 ${T(3)} var(--kong-danger); animation: tn-hud-fire .32s steps(2) infinite; }
.kr-veh.fire .nm { color: var(--kong-danger); }
@keyframes tn-hud-fire { 50% { opacity: .82; } }
.kr-veh .alt small { color: var(--kong-accent); }
html.kr-calm .kr-veh .hints span.hot kbd, html.kr-calm .kr-veh.fire .pnl { animation: none; }
@media (max-aspect-ratio: 3/2) { .kr-veh { bottom: ${T(170)}; } }

/* ---------- scope: hold-breath bar + zoom ---------- */
.kr-scope { position: absolute; inset: 0; }
.kr-scope canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.kr-scope .breath { position: absolute; left: 50%; top: calc(50% + 34vh); transform: translateX(-50%); display: flex; align-items: center; gap: ${T(12)};
  ${nunito(15, 900, ".12em")} text-transform: uppercase; color: var(--kong-text); white-space: nowrap; }
.kr-scope .breath .b { position: relative; width: ${T(150)}; height: ${T(14)}; border-radius: 999px; background: var(--kong-outline);
  border: var(--kong-outline-xs) solid var(--kong-outline); overflow: hidden; }
.kr-scope .breath .b i { position: absolute; inset: 0; transform-origin: left center; background: var(--kong-gradient-primary); }
.kr-scope .zoom { position: absolute; left: calc(50% + 32vh); top: 50%; transform: translateY(-50%); ${lilita(22)} color: var(--kong-text); white-space: nowrap; }

/* ---------- practice panel (game/range.ts): the mode label + keycap hint rows under the minimap ---------- */
.tn-hud-practice { position: fixed; left: ${T(40)}; top: ${T(264)}; width: ${T(360)}; max-height: calc(100vh - ${T(286)}); overflow: auto; z-index: 6;
  pointer-events: none; color: var(--kong-text); font-family: var(--kong-font-ui); scrollbar-width: none; }
.tn-hud-practice .eb { display: flex; align-items: center; gap: ${T(12)}; ${nunito(16, 900, ".14em")} line-height: ${T(22)}; text-transform: uppercase; text-shadow: var(--tn-hud-soft); }
.tn-hud-practice .eb::after { content: ""; width: ${T(22)}; height: ${T(2)}; border-radius: 999px; background: currentColor; box-shadow: var(--tn-hud-soft); }
.tn-hud-practice .sub { ${nunito(16, 700, ".06em")} line-height: ${T(22)}; color: var(--tn-hud-ivory-85); text-shadow: var(--tn-hud-soft); }
.tn-hud-practice .range-details .gun { ${nunito(15, 900, ".1em")} text-transform: uppercase; color: var(--kong-text); }
.tn-hud-practice .rows { display: grid; gap: ${T(12)}; margin-top: ${T(38)}; transition: opacity 800ms var(--kong-ease-out); }
.tn-hud-practice .tn-hud-row { transition: opacity 400ms ease; }
.tn-hud-practice .tn-hud-row.done { opacity: .35; text-decoration: line-through; text-decoration-thickness: ${T(2)}; }
.tn-hud-practice .rows.all-done { opacity: 0; }
.tn-hud-practice .range-details { margin-top: ${T(16)}; padding: ${T(14)} ${T(16)}; border-radius: var(--kong-radius-tile); background: var(--tn-hud-chip); ${nunito(14, 700, ".01em")} line-height: 1.4; color: var(--kong-text-muted); }
.tn-hud-practice .range-details[hidden] { display: none; }
.tn-hud-practice .range-details > div + div { margin-top: ${T(8)}; }
.tn-hud-practice .range-details b { color: var(--kong-text); font-weight: 900; }
.tn-hud-practice .range-details small { display: block; margin-top: ${T(10)}; ${nunito(12, 800, ".04em")} color: var(--kong-text-faint); }
`;

/** inject the Toon HUD skin once (after the base HUD sheet so it wins on equal specificity) */
export function injectHudToon(): void { addCss("kr-ui-hud-toon", HUD_TOON_CSS); }
