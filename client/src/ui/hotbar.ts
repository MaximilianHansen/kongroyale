// The weapons HUD (Toon): the ammo readout + weapon name, TOP BANANA (a helicopter's door gun),
// the five hotbar slots with the controller's cycle hints, and the lethal chip beside them. Sized in
// design px through T() so Accessibility → HUD size scales it. DOM built once; update() touches the DOM only when a value
// changes; animation is transform / opacity only and stands still under reduced motion.
import { CONSUMABLES, type ConsumableId, type Rarity, type WeaponId } from "../../../shared/world/map";
import { CONSUMABLE_DEFS, WEAPON_DEFS } from "../../../shared/sim/const";
import type { HotbarSlot, HudState, IconRenderer } from "./api";
import { addCss } from "./styles";
import { T, TOON } from "./toon";
import { itemIconUrl, svgGlyph } from "./icons";
import { fitArt, injectWeaponTokens } from "./weapon-tokens";
import { bindingText, onLabelsChange, padText } from "../settings/labels";
import { device } from "../settings/device";
import { preferences } from "../settings/preferences";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent.appendChild(e);
  return e;
}
export const txt = (e: HTMLElement, s: string) => { if (e.textContent !== s) e.textContent = s; };
export const tog = (e: Element, cls: string, on: boolean) => { if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on); };
/** reduced motion: the game's Accessibility setting or the OS preference — pops and springs stand still */
export const still = () => preferences.value.reducedMotion || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
/** a Toon pop: overshoot from `from` back to rest on the spring curve (--kong-motion-slow) */
export function pop(e: HTMLElement, from: string) {
  if (still()) return;
  e.animate([{ transform: from }, { transform: "none" }], { duration: 240, easing: TOON.spring });
}
/** the item a slot holds, by name (a mythic's own name first) */
export const slotName = (d: HotbarSlot | undefined) => !d || d.kind === "empty" || !d.id ? ""
  : d.name ? d.name : d.kind === "weapon" ? WEAPON_DEFS[d.id as WeaponId]?.name ?? "" : CONSUMABLE_DEFS[d.id as ConsumableId]?.name ?? "";

/** the slot art's box: 96 × 84 less the outline, 6 at the sides, 8 over and 16 under */
const SLOT_ART = 76 / 52;
/** what the HUD hands the weapons parts each frame */
export interface WeaponHudFrame { now: number; u: number; vw: number; vh: number; alive: boolean; handsVisible: boolean }

const OUTLINED = `font-family: var(--kong-font-display); font-weight: 400; letter-spacing: .01em; color: var(--kong-text);
  -webkit-text-stroke: var(--kong-text-outline-md) var(--kong-outline); paint-order: stroke fill; font-variant-numeric: tabular-nums;`;
/** a soft lift under the HUD readouts (text-shadow: 0 2px 10px at 60%) */
const SOFT = `0 ${T(2)} ${T(10)} color-mix(in srgb, var(--kong-outline) 60%, transparent)`;

const CSS = `
/* ---------- ammo + weapon name (bottom-right, over the slots): right 44, the name's foot 22 over the slots; the stack
   grows upward (a reload line pushes the numbers up) ---------- */
.kr-loadout { position: absolute; right: ${T(44)}; bottom: ${T(146)}; display: flex; flex-direction: column; align-items: flex-end;
  text-align: right; transform-origin: 100% 100%; }
.kr-ammo { display: flex; align-items: baseline; line-height: 1; text-shadow: ${SOFT}; ${OUTLINED} }
.kr-ammo .mag { font-size: ${T(64)}; line-height: 1; transform-origin: 100% 80%; }
.kr-ammo .res { margin-left: ${T(4)}; font-size: ${T(34)}; line-height: 1; color: color-mix(in srgb, var(--kong-text) 85%, var(--kong-outline)); }
/* the last quarter of the magazine: orange; empty: red; the reserve amber when it would not refill the
   magazine, red when there is none; reloading: the count dims */
.kr-ammo.low .mag { color: var(--kong-warning); }
.kr-ammo.empty .mag { color: var(--kong-danger); }
.kr-ammo.reloading .mag { opacity: .45; }
.kr-ammo.res-low .res { color: var(--kong-warning); }
.kr-ammo.res-none .res { color: var(--kong-danger); }
.kr-wname { margin-top: ${T(8)}; font: 900 ${T(17)} / 1.55 var(--kong-font-ui); letter-spacing: .22em; text-transform: uppercase; color: var(--kong-text);
  white-space: nowrap; text-shadow: ${SOFT}; }
.kr-wname.myth { color: color-mix(in srgb, var(--sig, var(--kong-text)) 45%, var(--kong-text)); }
.kr-reloading { font: 900 ${T(16)} / 1.55 var(--kong-font-ui); letter-spacing: .22em; color: var(--kong-warning); white-space: nowrap; text-shadow: ${SOFT}; }

/* ---------- TOP BANANA, a helicopter's door gun: in place of the ammo + slots, the same type — the belt as the count,
   the name + state, a capsule heat bar where the slots sit ---------- */
.kr-gun { position: absolute; right: ${T(44)}; bottom: ${T(40)}; width: ${T(330)}; display: flex; flex-direction: column; align-items: flex-end; gap: ${T(6)}; }
.kr-gun .row { display: flex; align-items: baseline; line-height: 1; text-shadow: ${SOFT}; ${OUTLINED} }
.kr-gun .mag { font-size: ${T(64)}; line-height: 1; }
.kr-gun .max { margin-left: ${T(4)}; font-size: ${T(34)}; line-height: 1; color: color-mix(in srgb, var(--kong-text) 85%, var(--kong-outline)); }
.kr-gun .nm { display: flex; align-items: center; gap: ${T(10)}; white-space: nowrap; font: 900 ${T(17)} / 1.55 var(--kong-font-ui); letter-spacing: .22em;
  color: var(--kong-accent); text-shadow: ${SOFT}; }
.kr-gun .nm .tag:empty { display: none; }
.kr-gun .nm .tag { padding: ${T(3)} ${T(10)}; border-radius: 999px; border: var(--kong-outline-sm) solid var(--kong-outline); box-shadow: var(--kong-drop-pill);
  background: var(--kong-surface); color: var(--kong-text); font-size: ${T(12)}; line-height: 1.2; letter-spacing: .14em; text-shadow: none; }
.kr-gun .heat { position: relative; align-self: stretch; height: ${T(22)}; margin-top: ${T(6)}; border-radius: 999px; overflow: hidden;
  background: var(--kong-outline); border: var(--kong-outline-sm) solid var(--kong-outline); box-shadow: var(--kong-drop-pill), inset 0 0 0 ${T(2)} var(--kong-rule); }
/* the fill reveals the heat ramp (yellow → orange → red) left to right: a clip slid in from the left, the ramp slid back */
.kr-gun .heat i { position: absolute; inset: 0; overflow: hidden; border-radius: inherit; transform: translateX(-100%); }
.kr-gun .heat i s { position: absolute; inset: 0; transform: translateX(100%);
  background: linear-gradient(90deg, var(--kong-accent-light), var(--kong-accent) 45%, var(--kong-warning) 75%, var(--kong-danger)); }
.kr-gun .heat b { position: absolute; right: ${T(10)}; top: 50%; transform: translateY(-50%); font: 900 ${T(11)} var(--kong-font-ui); letter-spacing: .2em;
  color: var(--kong-text); -webkit-text-stroke: ${T(3)} var(--kong-outline); paint-order: stroke fill; }
.kr-gun.low .mag { color: var(--kong-warning); }
.kr-gun.hot .nm .tag { background: var(--kong-warning); color: var(--kong-outline); }
.kr-gun.lock .nm .tag { background: var(--kong-danger); color: var(--kong-text); animation: kr-gun-lock .4s steps(2) infinite; }
.kr-gun.lock .heat i s { background: linear-gradient(90deg, var(--kong-warning), var(--kong-danger)); }
.kr-gun.empty .mag { color: var(--kong-danger); }
.kr-gun.empty .nm .tag { background: var(--kong-danger); color: var(--kong-text); }
@keyframes kr-gun-lock { 50% { opacity: .35; } }
html.kr-calm .kr-gun.lock .nm .tag { animation: none; }
@media (prefers-reduced-motion: reduce) { .kr-gun.lock .nm .tag { animation: none; } }
/* where the barrels point while they are off the crosshair (swinging, or held at the edge of the door) */
.kr-gunpip { position: absolute; left: 0; top: 0; width: ${T(30)}; height: ${T(30)}; border-radius: 50%; pointer-events: none;
  box-shadow: 0 0 0 ${T(3)} var(--kong-accent), 0 0 0 ${T(6)} var(--kong-outline); }
.kr-gunpip::after { content: ""; position: absolute; left: 50%; top: 50%; width: ${T(7)}; height: ${T(7)}; margin: ${T(-3.5)} 0 0 ${T(-3.5)}; border-radius: 50%;
  background: var(--kong-accent); box-shadow: 0 0 0 ${T(2)} var(--kong-outline); }

/* ---------- the hotbar: five 96 × 84 outlined tiles, gap 10, right 44 / bottom 40 ---------- */
.kr-hotbar { position: absolute; right: ${T(44)}; bottom: ${T(40)}; }
.kr-slots { display: flex; align-items: center; gap: ${T(10)}; }
.kr-slot { position: relative; flex: none; width: ${T(96)}; height: ${T(84)}; overflow: hidden;
  border: var(--kong-outline-md) solid var(--kong-outline); border-radius: var(--kong-radius-button); box-shadow: var(--kong-drop-tile);
  background: var(--tn-weapons-quiet);
  transition: transform var(--tn-weapons-swap) var(--kong-ease-spring), box-shadow var(--tn-weapons-swap); }
/* every tier its rarity tile (weapon-tokens.ts: the Toon design's green and blue, the game's other four tiers alike) */
.kr-slot[data-rarity] { background: radial-gradient(ellipse 70% 80% at 50% 40%, var(--r-hi) 0%, var(--r-mid) 45%, var(--r-lo) 100%); }
.kr-slot .ico { position: absolute; left: ${T(6)}; top: ${T(8)}; width: calc(100% - ${T(12)}); height: calc(100% - ${T(24)}); object-fit: contain; z-index: 1;
  filter: drop-shadow(0 ${T(3)} 0 var(--tn-weapons-art-drop)); }
/* the slot's key, as bound: a dark chip bottom-left (yellow when equipped); an empty slot shows it quietly in the middle */
.kr-slot .key { position: absolute; left: ${T(6)}; bottom: ${T(4)}; z-index: 3; min-width: ${T(20)}; height: ${T(20)}; padding: 0 ${T(5)};
  border-radius: ${T(7)}; background: var(--kong-outline); color: var(--kong-text); font: 900 ${T(13)} / ${T(20)} var(--kong-font-ui); text-align: center; white-space: nowrap; }
.kr-slot.empty .key { left: 50%; bottom: 50%; transform: translate(-50%, 50%); background: transparent; color: var(--kong-text-faint); }
/* equipped: lifts 8, grows a little, ivory outline + a soft yellow glow; its key chip turns yellow */
.kr-slot.sel { z-index: 3; transform: translateY(${T(-8)}) scale(1.06); border-color: var(--kong-text);
  box-shadow: var(--kong-drop-tile), 0 0 0 var(--kong-outline-md) var(--kong-outline), 0 0 ${T(22)} var(--tn-weapons-glow); }
.kr-slot.sel .key, .kr-slot.empty.sel .key { background: var(--kong-accent); color: var(--kong-on-accent); }
/* the rounds in a gun's magazine / the stack of a consumable: an outlined number bottom-right */
.kr-slot .ct { position: absolute; right: ${T(7)}; bottom: ${T(2)}; z-index: 3; font: 400 ${T(20)} / 1 var(--kong-font-display); color: var(--kong-text);
  -webkit-text-stroke: var(--kong-outline-sm) var(--kong-outline); paint-order: stroke fill; font-variant-numeric: tabular-nums; }
/* what a consumable restores at a glance (the vitals' icons: yellow heart = health, blue shield = shield), outlined */
.kr-slot .badge { position: absolute; right: ${T(6)}; top: ${T(6)}; width: ${T(20)}; height: ${T(20)}; z-index: 3; }
/* using a consumable: the tile fills from the bottom */
.kr-slot .use { position: absolute; inset: 0; z-index: 2; background: color-mix(in srgb, var(--kong-text) 32%, transparent); transform-origin: bottom center; transform: scaleY(0); }
/* a mythic: a slow sheen sweeps its tile; its own signature colour as a small gem in the corner */
.kr-slot .sheen { display: none; position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 2; }
.kr-slot.myth .sheen { display: block; }
.kr-slot .sheen::before { content: ""; position: absolute; top: -20%; bottom: -20%; left: 0; width: 40%;
  background: linear-gradient(100deg, transparent 0%, color-mix(in srgb, var(--kong-text) 34%, transparent) 50%, transparent 100%);
  transform: translateX(-120%) skewX(-12deg); animation: kr-sheen 3.4s ease-in-out infinite; }
@keyframes kr-sheen { 0%, 55% { transform: translateX(-120%) skewX(-12deg); } 100% { transform: translateX(330%) skewX(-12deg); } }
.kr-slot .gem { display: none; position: absolute; right: ${T(9)}; top: ${T(9)}; width: ${T(12)}; height: ${T(12)}; z-index: 3; transform: rotate(45deg);
  background: var(--sig, var(--kong-text)); border: ${T(2)} solid var(--kong-text); border-radius: ${T(2)};
  box-shadow: 0 0 0 ${T(2)} var(--kong-outline), 0 0 ${T(8)} var(--sig, var(--kong-text)); }
.kr-slot.myth .gem { display: block; }
html.kr-calm .kr-slot { transition: none; }
html.kr-calm .kr-slot .sheen::before { animation: none; }
@media (prefers-reduced-motion: reduce) { .kr-slot { transition: none; } .kr-slot .sheen::before { animation: none; } }
/* on the controller: the slot-cycling buttons either side of the slots (LB ◀ … ▶ RB), as keycaps */
.kr-hotbar .padcyc { display: none; align-items: center; justify-content: center; height: ${T(34)}; min-width: ${T(34)}; padding: 0 ${T(8)};
  border-radius: var(--kong-radius-key); border: var(--kong-outline-sm) solid var(--kong-outline); box-shadow: var(--kong-drop-pill);
  background: var(--kong-text); color: var(--kong-outline); font: 900 var(--kong-fs-key) / var(--kong-lh-key) var(--kong-font-ui); letter-spacing: .02em; white-space: nowrap; }
html.kr-pad .kr-hotbar .padcyc:not(:empty) { display: inline-flex; }

/* ---------- the lethal chip: the banana bombs you carry + the key that throws one — a quiet outlined chip over
   the left end of the slots (beside the ammo readout), so the bottom row never grows toward the vitals ---------- */
.kr-lethal { position: absolute; left: 0; bottom: calc(100% + ${T(18)}); display: flex; align-items: center; gap: ${T(6)}; height: ${T(52)}; padding: 0 ${T(10)} 0 ${T(4)};
  border: var(--kong-outline-sm) solid var(--kong-outline); border-radius: var(--kong-radius-tile); box-shadow: var(--kong-drop-pill); background: var(--tn-weapons-quiet); }
.kr-lethal .ic { width: ${T(44)}; height: ${T(44)}; object-fit: contain; filter: drop-shadow(0 ${T(2)} 0 var(--tn-weapons-art-drop)); }
.kr-lethal .n { font: 400 ${T(24)} / 1 var(--kong-font-display); color: var(--kong-text); -webkit-text-stroke: var(--kong-outline-sm) var(--kong-outline); paint-order: stroke fill; }
.kr-lethal .k { display: inline-flex; align-items: center; justify-content: center; height: ${T(28)}; min-width: ${T(28)}; padding: 0 ${T(6)}; margin-left: ${T(2)}; font-style: normal;
  border-radius: var(--kong-radius-key); border: var(--kong-outline-sm) solid var(--kong-outline); box-shadow: var(--kong-drop-pill);
  background: var(--kong-text); color: var(--kong-outline); font: 900 ${T(15)} / 1 var(--kong-font-ui); }
.kr-lethal.cook { border-color: var(--kong-warning); box-shadow: var(--kong-drop-pill), 0 0 ${T(18)} color-mix(in srgb, var(--kong-warning) 70%, transparent); }
.kr-lethal.cook.smoke { border-color: #5cf2ff; box-shadow: var(--kong-drop-pill), 0 0 ${T(18)} rgba(92, 242, 255, 0.7); }
`;

export function createHotbar(root: HTMLElement) {
  injectWeaponTokens();
  addCss("kr-ui-hotbar", CSS);
  // the ammo + the weapon in hand (+ "Reloading…" under it)
  const loadout = el("div", "kr-loadout", root);
  const ammo = el("div", "kr-ammo", loadout);
  const ammoMag = el("span", "mag", ammo);
  const ammoRes = el("span", "res", ammo);
  const wname = el("div", "kr-wname", loadout);
  const reloading = el("div", "kr-reloading kr-hide", loadout); reloading.textContent = "Reloading…";
  // behind a helicopter's door gun (TOP BANANA): its belt, its heat, the pip where its barrels point
  const gunBox = el("div", "kr-gun kr-hide", root);
  const gunRow = el("div", "row", gunBox);
  const gunBelt = el("span", "mag", gunRow);
  const gunMax = el("span", "max", gunRow);
  const gunTop = el("div", "nm", gunBox);
  const gunTag = el("span", "tag", gunTop);
  const gunName = el("span", "", gunTop); gunName.textContent = "TOP BANANA";
  const gunHeat = el("div", "heat", gunBox);
  const gunHeatClip = el("i", "", gunHeat), gunHeatRamp = el("s", "", gunHeatClip);
  el("b", "", gunHeat).textContent = "HEAT";
  const gunPip = el("div", "kr-gunpip kr-hide", root);
  const hotbar = el("div", "kr-hotbar", root);
  // the lethal chip: banana bombs carried + the throw key, left of the slots
  const slotRow = el("div", "kr-slots", hotbar);
  const lethal = el("div", "kr-lethal kr-hide", hotbar);
  const lethalImg = el("img", "ic", lethal) as HTMLImageElement; lethalImg.src = itemIconUrl("banana-bomb"); lethalImg.alt = ""; fitArt(lethalImg, 1, 0.92);
  const lethalN = el("b", "n", lethal), lethalK = el("i", "k", lethal);
  let lethalSig = "";
  // on the controller: the slot-cycling buttons either side of the slots (LB ◀ … ▶ RB)
  const cycPrev = el("div", "padcyc", slotRow);
  interface Slot { box: HTMLElement; key: HTMLElement; img: HTMLImageElement; ct: HTMLElement; use: HTMLElement; hpB: SVGSVGElement; shB: SVGSVGElement; id: string; rarity: string; color: string; sel: boolean; ctV: number; cons: boolean; empty: boolean; useV: number }
  const slots: Slot[] = [];
  for (let i = 0; i < 5; i++) {
    const box = el("div", "kr-slot empty", slotRow);
    // the slot wears its rarity tile (weapon-tokens.ts); a mythic its sheen and gem
    el("div", "sheen", box);
    const img = el("img", "ico", box);
    img.alt = ""; img.decoding = "async"; img.style.visibility = "hidden";
    const use = el("div", "use", box);
    el("div", "gem", box);
    // what a consumable restores at a glance: yellow heart = health, blue shield = shield (the vitals' own icons)
    const hpB = svgGlyph("heart", "badge tn-weapons-icon-outline", TOON.accent), shB = svgGlyph("shield", "badge tn-weapons-icon-outline", TOON.shield);
    hpB.style.display = shB.style.display = "none"; box.append(hpB, shB);
    const ct = el("div", "ct", box);
    const key = el("div", "key", box); key.textContent = bindingText("slots", i);   // the slot's key as bound
    slots.push({ box, key, img, ct, use, hpB, shB, id: "", rarity: "", color: "", sel: false, ctV: -1, cons: false, empty: true, useV: 0 });
  }
  const cycNext = el("div", "padcyc", slotRow);

  let iconRenderer: IconRenderer | null = null;
  const customIcons = new Map<string, string>();
  const last = {
    mag: -1, res: -1, ammoOn: true, ammoCls: "", loadOn: true, held: "\0", name: "\0", myth: "", reload: false,
    gunOn: false, gunBelt: -1, gunMax: -1, gunHeat: -1, gunCls: "\0", gunTag: "\0", pipOn: false, pipX: -1, pipY: -1,
  };

  // a rebind (SETTINGS → CONTROLS) or picking up the other device shows at once on the slots
  onLabelsChange(() => {
    for (const [i, sl] of slots.entries()) sl.key.textContent = device.pad ? String(i + 1) : bindingText("slots", i);
    cycPrev.textContent = device.pad ? padText("prevSlot", 0) : ""; cycNext.textContent = device.pad ? padText("nextSlot", 0) : "";
  });

  // ---------------------------------------------------------------- hotbar icon source (custom renderer or sprite)
  function iconSrc(id: string, rarity: string): string {
    const key = `${id}/${rarity}`;
    const c = customIcons.get(key);
    if (c) return c;
    if (iconRenderer) {
      customIcons.set(key, itemIconUrl(id));
      Promise.resolve(iconRenderer(id as never, rarity as Rarity, 256)).then((r) => {
        if (!r) return;
        const url = r instanceof HTMLCanvasElement ? r.toDataURL("image/png") : r.src;
        customIcons.set(key, url);
        for (const sl of slots) if (sl.id === id && sl.rarity === rarity) { sl.img.src = url; fitArt(sl.img, SLOT_ART); }
      }).catch(() => {});
    }
    return itemIconUrl(id);
  }

  function update(s: HudState, f: WeaponHudFrame) {
    const { handsVisible, alive, u, vw, vh } = f;
    tog(hotbar, "kr-hide", !handsVisible);

    // ---- ammo + the weapon in hand: the readout pops (spring) when what is in hand changes
    const act = s.hotbar[s.activeSlot];
    const name = handsVisible ? slotName(act) : "";
    const loadOn = handsVisible && (!!s.ammo || !!name);
    if (loadOn !== last.loadOn) { last.loadOn = loadOn; tog(loadout, "kr-hide", !loadOn); }
    const held = act && act.kind !== "empty" ? `${s.activeSlot}|${act.id}|${act.rarity}|${act.name ?? ""}` : `${s.activeSlot}|`;
    const swapped = held !== last.held;
    if (swapped) { const first = last.held === "\0"; last.held = held; if (!first && loadOn) pop(loadout, "scale(1.12)"); }
    if (name !== last.name) { last.name = name; txt(wname, name); tog(wname, "kr-hide", !name); }
    const myth = act && act.kind === "weapon" && act.rarity === "mythic" ? act.color ?? "" : "";
    if (myth !== last.myth) { last.myth = myth; tog(wname, "myth", !!myth); if (myth) wname.style.setProperty("--sig", myth); else wname.style.removeProperty("--sig"); }
    const ammoOn = !!s.ammo && handsVisible;
    if (ammoOn !== last.ammoOn) { last.ammoOn = ammoOn; ammo.style.visibility = ammoOn ? "visible" : "hidden"; }
    const rl = handsVisible && !!s.reload;
    if (rl !== last.reload) { last.reload = rl; tog(reloading, "kr-hide", !rl); }
    if (s.ammo) {
      if (s.ammo.mag !== last.mag) {
        // a reload / refill landing pops the count (a shot never does)
        const up = last.mag >= 0 && s.ammo.mag > last.mag && !swapped;
        last.mag = s.ammo.mag; ammoMag.textContent = String(s.ammo.mag);
        if (up && ammoOn) pop(ammoMag, "scale(1.18)");
      }
      if (s.ammo.reserve !== last.res) { last.res = s.ammo.reserve; ammoRes.textContent = `/ ${s.ammo.reserve}`; }
      // low = the last quarter of THIS gun's magazine
      // (a full shotgun / sniper / rocket is never low), whether or not there is reserve; red at 0; the reserve number
      // warns too when it would not refill the magazine (amber) or is gone (red)
      const size = act && act.kind === "weapon" && act.id ? WEAPON_DEFS[act.id as WeaponId]?.mag ?? 0 : 0;
      const mag = s.ammo.mag, res = s.ammo.reserve;
      const cls = (s.reload ? "reloading" : mag === 0 ? "empty" : size > 1 && mag < size && mag <= Math.max(1, Math.round(size * 0.25)) ? "low" : "")
        + (res === 0 ? " res-none" : size > 0 && res < size ? " res-low" : "");
      if (cls !== last.ammoCls) { last.ammoCls = cls; ammo.className = `kr-ammo ${cls}`; }
    }

    // ---- TOP BANANA (a helicopter's door gun): the belt, the heat bar, overheated / empty / spinning; the barrels' pip
    const gunOn = !!s.gun && alive && !s.spectating;
    if (gunOn !== last.gunOn) { last.gunOn = gunOn; gunBox.classList.toggle("kr-hide", !gunOn); if (!gunOn) { gunPip.classList.add("kr-hide"); last.pipOn = false; } }
    if (s.gun && gunOn) {
      const G = s.gun;
      if (G.belt !== last.gunBelt) { last.gunBelt = G.belt; gunBelt.textContent = String(G.belt); }
      if (G.beltMax !== last.gunMax) { last.gunMax = G.beltMax; gunMax.textContent = `/ ${G.beltMax}`; }
      const hq = Math.round(Math.max(0, Math.min(1, G.heat)) * 200) / 200;
      if (hq !== last.gunHeat) { last.gunHeat = hq; gunHeatClip.style.transform = `translateX(${((hq - 1) * 100).toFixed(1)}%)`; gunHeatRamp.style.transform = `translateX(${((1 - hq) * 100).toFixed(1)}%)`; }
      const cls = G.belt <= 0 ? "empty" : G.lock ? "lock" : G.heat > 0.75 ? "hot" : G.belt <= 50 ? "low" : "";
      if (cls !== last.gunCls) { last.gunCls = cls; gunBox.className = `kr-gun${cls ? " " + cls : ""}`; }
      const tag = G.belt <= 0 ? "BELT EMPTY" : G.lock ? "OVERHEATED" : G.heat > 0.75 ? "HOT" : G.spin > 0.05 ? "SPINNING" : "";
      if (tag !== last.gunTag) { last.gunTag = tag; gunTag.textContent = tag; }
      // the pip: only when the barrels are off the crosshair (still swinging, or held at the edge of the door)
      const P = G.pip, off = P ? Math.hypot((P.sx - 0.5) * vw, (P.sy - 0.5) * vh) : 0, pipOn = !!P && off > 14 * u;
      if (pipOn !== last.pipOn) { last.pipOn = pipOn; gunPip.classList.toggle("kr-hide", !pipOn); }
      if (P && pipOn) {
        const x = Math.round(Math.max(0.02, Math.min(0.98, P.sx)) * vw), y = Math.round(Math.max(0.02, Math.min(0.98, P.sy)) * vh);
        if (x !== last.pipX || y !== last.pipY) { last.pipX = x; last.pipY = y; gunPip.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`; }
      }
    }

    // ---- hotbar
    for (let i = 0; i < 5; i++) {
      const sl = slots[i], d = s.hotbar[i];
      const empty = !d || d.kind === "empty" || !d.id;
      const id = empty ? "" : (d.id as string);
      const rarity = empty ? "" : d.rarity;
      const color = empty ? "" : d.color ?? "";
      if (id !== sl.id || rarity !== sl.rarity || color !== sl.color) {
        sl.id = id; sl.rarity = rarity; sl.color = color;
        if (id) { sl.img.src = iconSrc(id, rarity); sl.img.style.visibility = "visible"; fitArt(sl.img, SLOT_ART); } else sl.img.style.visibility = "hidden";
        // every tier its rarity tile (a mythic the mythic tier's tile, its own signature colour only on the gem)
        if (rarity) sl.box.dataset.rarity = rarity; else delete sl.box.dataset.rarity;
        if (color) sl.box.style.setProperty("--sig", color); else sl.box.style.removeProperty("--sig");
        tog(sl.box, "myth", rarity === "mythic");
        const c = CONSUMABLES.includes(id as ConsumableId) ? CONSUMABLE_DEFS[id as ConsumableId] : null;
        sl.hpB.style.display = c && c.hp > 0 && c.shield === 0 ? "" : "none";
        sl.shB.style.display = c && c.shield > 0 && c.hp === 0 ? "" : "none";
      }
      if (empty !== sl.empty) { sl.empty = empty; tog(sl.box, "empty", empty); }
      const cons = !empty && d.kind === "consumable";
      if (cons !== sl.cons) { sl.cons = cons; tog(sl.box, "cons", cons); }
      const sel = i === s.activeSlot;
      if (sel !== sl.sel) { sl.sel = sel; tog(sl.box, "sel", sel); }
      const ct = empty ? -1 : d.count;
      if (ct !== sl.ctV) { sl.ctV = ct; sl.ct.textContent = empty || (d.kind === "consumable" && ct <= 0) ? "" : String(ct); }
      const useV = sel && s.using && s.using.total > 0 ? Math.round(Math.min(1, s.using.t / s.using.total) * 200) / 200 : 0;
      if (useV !== sl.useV) { sl.useV = useV; sl.use.style.transform = `scaleY(${useV})`; }
    }
    { const L = s.lethal; const lid = L?.id ?? "banana-bomb"; const sig = L ? `${lid}|${L.count}|${L.key}|${L.cooking ? 1 : 0}` : "";
      if (sig !== lethalSig) { lethalSig = sig; tog(lethal, "kr-hide", !L); if (L) { const u2 = itemIconUrl(lid); if (lethalImg.src !== u2) { lethalImg.src = u2; fitArt(lethalImg, 1, 0.92); } lethalN.textContent = `×${L.count}`; lethalK.textContent = L.key; tog(lethal, "cook", L.cooking); tog(lethal, "smoke", lid === "smoke-bomb"); } } }
  }

  return {
    /** the readout block (the damage numbers keep out of it) and the slot row */
    ammo: loadout, hotbar, update,
    setIconRenderer(fn: IconRenderer | null) {
      iconRenderer = fn; customIcons.clear();
      for (const sl of slots) { sl.id = ""; sl.rarity = ""; }
    },
  };
}
