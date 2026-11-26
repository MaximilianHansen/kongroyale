// The inventory screen (Tab) in Toon: a compact centred panel over the dimmed game.
// Five equal cards — index chip,
// rarity pill, the art on its rarity tile, the name in outlined Lilita, one real stat, a yellow EQUIPPED badge — then an
// action row (Equip / Move / Drop with the real keys) under the selected card, then the four ammo pools.
//
// Selected = ivory outline + a soft yellow glow (the keyboard / mouse selection and the controller's cursor are the same
// thing); Move picks the item up (the other cards light up as destinations; Esc / B puts it back) and a slot, Enter or
// Move again sets it down. Drag still works: drag a card onto another to reorder (the same consumable stacks), drag it
// off the panel to drop it. DOM only, touched when a value changes; the game owns the rules (shared/sim/player.ts
// invMove / invDrop; equipping is the slot the hands want, game/input.ts) and just gets callbacks.
import { type ConsumableId, type WeaponId } from "../../../shared/world/map";
import { AIRSTRIKE, AMMO_CAP, BOMB, CONSUMABLE_DEFS, GRAPPLE, RARITY_MUL, SMOKE, WEAPON_DEFS } from "../../../shared/sim/const";
import { COVER } from "../../../shared/sim/cover";
import type { HotbarSlot } from "./api";
import { itemIconUrl } from "./icons";
import { injectStyles } from "./styles";
import { T } from "./toon";
import { fitArt, injectWeaponTokens } from "./weapon-tokens";
import { backText, bindingText, glyphFamily, onLabelsChange, padText } from "../settings/labels";
import type { BindAction } from "../settings/bindings";
import { preferences } from "../settings/preferences";
import { glyph, PB } from "../settings/pad";
import { device } from "../settings/device";
import { slotName } from "./hotbar";

const OUTLINED = (w: string) => `font-family: var(--kong-font-display); font-weight: 400; letter-spacing: .01em; color: var(--kong-text);
  -webkit-text-stroke: ${w} var(--kong-outline); paint-order: stroke fill;`;
/** the card's art box (card 202 wide less outline + 8 a side; the tile's visible height under the chips) */
const ART = 178 / 84;
const CSS = `
.kr-inv { position: absolute; inset: 0; z-index: 15; display: grid; place-items: center; pointer-events: auto; cursor: default;
  --tu: min(calc(100vh / 1080 * var(--hud-scale, 1)), calc(100vw / 1240));
  user-select: none; -webkit-user-select: none; -webkit-font-smoothing: antialiased; font-family: var(--kong-font-ui); color: var(--kong-text);
  background: color-mix(in srgb, var(--kong-outline) 55%, transparent); }
.kr-inv * { box-sizing: border-box; }
/* the panel: 1160 wide, padding 32 40 30, navy gradient, 4 outline, 30 radius, a hard 10 drop; it pops in */
.kr-inv .panel { position: relative; width: ${T(1160)}; padding: ${T(32)} ${T(40)} ${T(30)};
  background: linear-gradient(180deg, var(--kong-surface), var(--kong-bg)); border: var(--kong-outline-md) solid var(--kong-outline);
  border-radius: ${T(30)}; box-shadow: var(--kong-drop-dialog); animation: tn-pop var(--kong-motion-slow) var(--kong-ease-spring) both; }
/* header: INVENTORY · 2 / 5 · a rule · TAB ESC CLOSE */
.kr-inv .hdr { display: flex; align-items: baseline; gap: ${T(30)}; }
.kr-inv .ttl { margin: 0; font-size: ${T(64)}; line-height: .9; text-transform: uppercase; ${OUTLINED("var(--kong-text-outline-md)")} text-shadow: 0 ${T(7)} 0 var(--kong-outline); }
.kr-inv .cnt { font-size: ${T(36)}; line-height: 1.55; ${OUTLINED("var(--kong-text-outline-md)")} color: var(--kong-text-muted); font-variant-numeric: tabular-nums; }
.kr-inv .cnt b { font-weight: 400; color: var(--kong-accent); }
.kr-inv .rule { flex: 1; align-self: center; height: ${T(3)}; border-radius: ${T(3)}; background: var(--kong-rule); }
.kr-inv .close { appearance: none; margin-left: ${T(8)}; display: inline-flex; align-items: center; gap: ${T(8)}; padding: 0; border: 0; background: none; cursor: pointer;
  font: 900 ${T(16)} / 1 var(--kong-font-ui); letter-spacing: .1em; text-transform: uppercase; color: var(--kong-text); }
.kr-inv .close:hover { color: var(--kong-accent); }
.kr-inv .close .keys { display: inline-flex; gap: ${T(8)}; }
.kr-inv .close .lbl { margin-left: ${T(2)}; }
/* the keycaps (toon.ts .tn-key): accent = an action you can take now */
.kr-inv .tn-key { font-size: ${T(16)}; }
/* ---------- the five cards: 202 × 270, gap 16 ---------- */
.kr-inv .row { margin-top: ${T(22)}; display: grid; grid-template-columns: repeat(5, 1fr); gap: ${T(16)}; height: ${T(270)}; }
.kr-inv .card { position: relative; display: grid; grid-template-rows: auto minmax(0, 1fr) auto auto; padding: ${T(14)} ${T(16)}; min-width: 0; overflow: hidden; cursor: grab;
  border: var(--kong-outline-md) solid var(--kong-outline); border-radius: var(--kong-radius-card); box-shadow: var(--kong-drop-card);
  background: linear-gradient(180deg, var(--kong-surface-2), color-mix(in srgb, var(--kong-surface) 70%, var(--kong-bg)));
  transition: transform var(--kong-motion-fast) var(--kong-ease-spring), box-shadow var(--kong-motion-fast), border-color var(--kong-motion-fast), opacity var(--kong-motion-fast); }
/* the art on its rarity tile (ellipse 70% × 80% at 50% 45%), bleeding to the card's edges, a 4 outline under it */
.kr-inv .card .art { grid-row: 1 / 3; grid-column: 1; position: relative; margin: ${T(-14)} ${T(-16)} ${T(10)}; min-height: 0; overflow: hidden;
  border-bottom: var(--kong-outline-md) solid var(--kong-outline);
  background: radial-gradient(ellipse 70% 80% at 50% 45%, var(--r-hi) 0%, var(--r-mid) 45%, var(--r-lo) 100%); }
.kr-inv .card .art img { position: absolute; left: ${T(8)}; right: ${T(8)}; bottom: ${T(6)}; width: calc(100% - ${T(16)}); height: ${T(84)}; object-fit: contain;
  filter: drop-shadow(0 ${T(5)} 0 var(--tn-weapons-art-drop)); pointer-events: none; }
.kr-inv .card .art .ct { position: absolute; right: ${T(10)}; bottom: ${T(4)}; font-size: ${T(24)}; line-height: 1; ${OUTLINED("var(--kong-outline-md)")} }
.kr-inv .card .art .ct:empty { display: none; }
.kr-inv .card .art .gem { display: none; position: absolute; left: ${T(14)}; bottom: ${T(12)}; width: ${T(13)}; height: ${T(13)}; transform: rotate(45deg);
  background: var(--sig, var(--kong-text)); border: ${T(2)} solid var(--kong-text); border-radius: ${T(2)}; box-shadow: 0 0 0 ${T(2)} var(--kong-outline), 0 0 ${T(8)} var(--sig, var(--kong-text)); }
.kr-inv .card.myth .art .gem { display: block; }
/* index chip (the slot's key) and the rarity pill */
.kr-inv .card .idx { position: relative; z-index: 1; grid-row: 1; grid-column: 1; align-self: start; justify-self: start; display: grid; place-items: center;
  min-width: ${T(28)}; height: ${T(28)}; padding: 0 ${T(6)}; border-radius: ${T(10)}; background: var(--kong-outline); color: var(--kong-text);
  font: 700 ${T(15)} / 1 var(--kong-font-ui); white-space: nowrap; }
.kr-inv .card .rar { position: absolute; z-index: 1; top: ${T(10)}; right: ${T(10)}; padding: ${T(3)} ${T(8)}; font-size: ${T(11)}; }
.kr-inv .card .nm { grid-column: 1; padding-bottom: ${T(8)}; font-size: ${T(26)}; line-height: 1.55; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  ${OUTLINED("var(--kong-text-outline-sm)")} }
.kr-inv .card .nm.fit1 { font-size: ${T(22)}; }
.kr-inv .card .nm.fit2 { font-size: ${T(19)}; }
.kr-inv .card .nm.fit3 { font-size: ${T(16)}; }
.kr-inv .card.myth .nm { color: color-mix(in srgb, var(--sig, var(--kong-text)) 40%, var(--kong-text)); }
.kr-inv .card .stat { grid-column: 1; display: flex; justify-content: space-between; align-items: flex-end; gap: ${T(6)}; padding-top: ${T(8)}; min-width: 0; }
.kr-inv .card .stat small { display: block; font: 600 ${T(14)} / 1.55 var(--kong-font-ui); letter-spacing: .14em; text-transform: uppercase; color: var(--kong-text-muted); white-space: nowrap; }
.kr-inv .card .stat b { display: block; font-size: ${T(30)}; line-height: 1; ${OUTLINED("var(--kong-text-outline-md)")} font-variant-numeric: tabular-nums; white-space: nowrap; }
.kr-inv .card .eq { display: none; flex: none; padding: ${T(4)} ${T(8)}; border-radius: 999px; border: var(--kong-outline-sm) solid var(--kong-outline);
  background: var(--kong-accent); color: var(--kong-on-accent); font: 900 ${T(12)} / 1.55 var(--kong-font-ui); letter-spacing: .14em; text-transform: uppercase; }
.kr-inv .card.equipped .eq { display: block; }
.kr-inv .card .plus { display: none; }
/* empty: dashed and quiet, "+ EMPTY" */
.kr-inv .card.empty { cursor: default; grid-template-rows: auto 1fr auto; background: var(--tn-weapons-hollow); border-style: dashed; border-color: var(--kong-rule-strong); box-shadow: none; }
.kr-inv .card.empty .art, .kr-inv .card.empty .rar, .kr-inv .card.empty .stat { display: none; }
.kr-inv .card.empty .plus { display: grid; place-items: center; font: 200 ${T(44)} / 1 var(--kong-font-ui); color: var(--kong-text-muted); }
.kr-inv .card.empty .nm { padding: 0; font: 400 ${T(26)} / 1.55 var(--kong-font-ui); -webkit-text-stroke: 0; color: var(--kong-text-muted); }
/* hover (pointer): a small lift */
.kr-inv .card:not(.empty):not(.sel):hover { transform: translateY(${T(-3)}); box-shadow: var(--kong-drop-hover); }
.kr-inv .card.empty:not(.sel):hover { border-color: var(--kong-text-faint); }
/* selected: ivory outline + a soft yellow glow (empty ones too) */
.kr-inv .card.sel { border-color: var(--kong-text); box-shadow: var(--kong-drop-card), 0 0 0 var(--kong-outline-md) var(--kong-outline), 0 0 ${T(28)} var(--tn-weapons-glow-soft); }
/* moving: the item lifted out fades; every other card is a destination (yellow); the selected destination keeps its ivory
   outline + glow so you see where it lands */
.kr-inv .card.moving { opacity: .45; }
.kr-inv .card.target { border-color: var(--kong-accent); background: color-mix(in srgb, var(--kong-accent) 12%, var(--kong-surface)); }
.kr-inv .card.target.empty { background: color-mix(in srgb, var(--kong-accent) 12%, var(--tn-weapons-hollow)); }
.kr-inv .card.target.sel, .kr-inv .card.target:hover { border-color: var(--kong-text); border-style: solid; }
/* dragging: the card it came from fades, the one under the pointer lights up */
.kr-inv .card.src { opacity: .35; }
.kr-inv .card.over { border-color: var(--kong-accent); border-style: solid; background: color-mix(in srgb, var(--kong-accent) 14%, var(--kong-surface)); }
/* ---------- actions under the selected card ---------- */
.kr-inv .acts { margin-top: ${T(26)}; height: ${T(34)}; padding-left: ${T(4)}; }
.kr-inv .acts .strip { display: inline-flex; gap: ${T(24)}; align-items: center; height: 100%; white-space: nowrap;
  transition: transform calc(var(--kong-motion-slow) + 20ms) var(--kong-ease-spring); }
.kr-inv .acts button { appearance: none; display: inline-flex; align-items: center; gap: ${T(12)}; padding: 0; border: 0; background: none; cursor: pointer;
  font: 900 ${T(15)} / 1 var(--kong-font-ui); letter-spacing: .14em; text-transform: uppercase; color: var(--kong-text); }
.kr-inv .acts button .tn-key { transition: transform var(--kong-motion-fast) var(--kong-ease-spring), box-shadow var(--kong-motion-fast); }
.kr-inv .acts button:hover:not([disabled]) .tn-key { transform: translateY(${T(-2)}); box-shadow: 0 ${T(6)} 0 var(--kong-outline); }
.kr-inv .acts button:active:not([disabled]) .tn-key { transform: translateY(${T(3)}); box-shadow: var(--kong-drop-pressed); }
.kr-inv .acts button[disabled] { cursor: default; color: var(--kong-disabled-text); }
.kr-inv .acts button[disabled] .tn-key { background: var(--kong-disabled); color: var(--kong-disabled-text); }
.kr-inv .acts .sep { width: ${T(1)}; height: ${T(26)}; background: var(--kong-rule-strong); }
.kr-inv .acts .moving, .kr-inv .acts .note { font: 900 ${T(15)} / 1 var(--kong-font-ui); letter-spacing: .14em; text-transform: uppercase; }
.kr-inv .acts .moving { color: var(--kong-accent); }
.kr-inv .acts .note { color: var(--kong-text-muted); }
/* ---------- the four ammo pools ---------- */
.kr-inv .ammo { margin-top: ${T(18)}; padding-top: ${T(16)}; border-top: ${T(3)} solid var(--kong-rule); display: grid; grid-template-columns: repeat(4, 1fr); }
.kr-inv .am { display: grid; grid-template-columns: ${T(30)} 1fr auto; gap: ${T(6)} ${T(16)}; align-items: center; margin-right: ${T(8)}; padding: ${T(6)} ${T(12)};
  background: var(--kong-surface); border: var(--kong-outline-sm) solid var(--kong-outline); border-radius: ${T(16)}; box-shadow: var(--kong-drop-pill); }
.kr-inv .am svg { grid-row: 1 / span 2; width: ${T(18)}; height: ${T(34)}; color: var(--a); }
.kr-inv .am span { font: 600 ${T(15)} / 1.55 var(--kong-font-ui); letter-spacing: .14em; text-transform: uppercase; color: var(--kong-text); }
.kr-inv .am b { font: 700 ${T(15)} / 1.55 var(--kong-font-ui); color: var(--kong-text); font-variant-numeric: tabular-nums; white-space: nowrap; }
.kr-inv .am b em { font-style: normal; font-weight: 500; color: var(--kong-text-muted); }
.kr-inv .am i { grid-column: 2 / 4; position: relative; height: ${T(10)}; overflow: hidden; border-radius: ${T(3)}; border: ${T(2)} solid var(--kong-outline);
  background: color-mix(in srgb, var(--kong-text-muted) 18%, var(--kong-outline)); }
.kr-inv .am i::after { content: ""; position: absolute; inset: 0; transform-origin: left center; transform: scaleX(var(--v, 0)); background: var(--a); }
.kr-inv .am.none span, .kr-inv .am.none b { color: var(--kong-text-faint); }
/* ---------- dragging off the panel drops: a red pill says so ---------- */
.kr-inv .drop { position: absolute; left: 50%; bottom: ${T(70)}; transform: translateX(-50%); padding: ${T(8)} ${T(22)}; border-radius: 999px;
  background: var(--kong-danger); border: var(--kong-outline-sm) solid var(--kong-outline); box-shadow: var(--kong-drop-pill);
  font: 900 ${T(17)} / 1.3 var(--kong-font-ui); letter-spacing: .12em; color: var(--kong-text); opacity: 0; transition: opacity var(--kong-motion-fast); pointer-events: none; }
.kr-inv.dropping .drop { opacity: 1; }
.kr-inv .ghost { position: fixed; left: 0; top: 0; width: ${T(150)}; height: ${T(110)}; object-fit: contain; pointer-events: none; opacity: .92;
  filter: drop-shadow(0 ${T(6)} 0 var(--tn-weapons-art-drop)); }
html.kr-calm .kr-inv .card, html.kr-calm .kr-inv .acts .strip { transition: none; }
@media (prefers-reduced-motion: reduce) { .kr-inv .card, .kr-inv .acts .strip { transition: none; } }
`;
let styled = false;

export interface InventoryScreen {
  el: HTMLElement;
  readonly open: boolean;
  setOpen(open: boolean): void;
  /** refresh from the HUD state (cheap when nothing changed) */
  update(hotbar: HotbarSlot[], active: number, reserves: ArrayLike<number>): void;
  /** drag slot a onto slot b */
  onMove: (a: number, b: number) => void;
  /** drag slot a off the panel */
  onDrop: (a: number) => void;
  /** take slot i in hand (the slot the hands want) */
  onEquip: (i: number) => void;
  /** the close button (the game closes the screen as its inventory key does) */
  onClose: () => void;
  /** a key while the inventory is open (slot keys select / place, the interact key equips, reload moves, throw drops,
   *  Enter places); true = handled */
  key(code: string): boolean;
  /** Esc / B: put a picked-up item back; false = nothing to cancel (the caller closes the screen) */
  cancel(): boolean;
  /** controller: move the slot cursor, pick up / place (a move), drop the slot under the cursor, equip it; cancel → true
   *  when a picked-up item was put back (false: nothing to cancel, the caller closes the screen) */
  padMove(dir: -1 | 1): void;
  padSelect(): void;
  padDrop(): void;
  padEquip(): void;
  padCancel(): boolean;
}

const AMMO = [["Light", "light", "var(--kong-text)"], ["Heavy", "heavy", "var(--kong-warning)"], ["Shells", "shells", "var(--kong-danger)"], ["Rockets", "rockets", "var(--kong-sky)"]] as const;
const BULLET = `<svg viewBox="0 0 30 100"><path d="M15 2C8 10 5 22 5 36V62H25V36C25 22 22 10 15 2Z" fill="currentColor"/><path d="M4 67H26V96Q26 99 23 99H7Q4 99 4 96Z" fill="currentColor"/></svg>`;
type Stat = [label: string, value: string];

/** a card's one stat: a gun's damage per shot (all pellets, its rarity); a consumable's effect */
function statOf(s: HotbarSlot): Stat | null {
  if (s.kind === "weapon") {
    const w = WEAPON_DEFS[s.id as WeaponId]; if (!w) return null;
    return ["Damage", String(Math.round(w.dmg * w.pellets * (RARITY_MUL[s.rarity] ?? 1)))];
  }
  const c = CONSUMABLE_DEFS[s.id as ConsumableId]; if (!c) return null;
  switch (c.id) {
    case "banana-bomb": return ["Damage", String(BOMB.dmg)];
    case "smoke-bomb": return ["Smoke", `${SMOKE.durationS} s`];
    case "crate-wall": return ["Health", String(COVER.hp)];
    case "vine-grapple": return ["Range", `${GRAPPLE.maxDist} m`];
    case "airstrike": return ["Bombs", `${AIRSTRIKE.bombs}×${AIRSTRIKE.dmg}`];
    case "red-banana": return ["Speed", `×${c.speedMul ?? 1}`];
    default: return c.hp && c.shield ? ["Heal + shield", `+${c.hp}`] : c.shield ? ["Shield", `+${c.shield}`] : ["Health", `+${c.hp}`];
  }
}

export function createInventory(): InventoryScreen {
  if (!styled) { injectStyles(); injectWeaponTokens(); const st = document.createElement("style"); st.id = "kr-ui-inventory"; st.textContent = CSS; document.head.appendChild(st); styled = true; }
  const root = document.createElement("div");
  root.className = "kr-inv kr-tu kr-hide";
  root.innerHTML = `<div class="panel" role="dialog" aria-label="Inventory">
      <div class="hdr"><h1 class="ttl">Inventory</h1><span class="cnt"><b>0</b> / 5</span><span class="rule"></span><button class="close" type="button"><span class="keys"></span><span class="lbl">Close</span></button></div>
      <div class="row"></div><div class="acts"><div class="strip"></div></div><div class="ammo"></div></div><div class="drop">RELEASE TO DROP</div>`;
  const panel = root.querySelector<HTMLElement>(".panel")!, row = root.querySelector<HTMLElement>(".row")!, ammoEl = root.querySelector<HTMLElement>(".ammo")!;
  const countEl = root.querySelector<HTMLElement>(".cnt b")!, actsRow = root.querySelector<HTMLElement>(".acts")!, acts = actsRow.querySelector<HTMLElement>(".strip")!;
  const closeBtn = root.querySelector<HTMLButtonElement>(".close")!, closeKeys = closeBtn.querySelector<HTMLElement>(".keys")!;
  interface Cell { box: HTMLElement; img: HTMLImageElement; ct: HTMLElement; idx: HTMLElement; rar: HTMLElement; nm: HTMLElement; sl: HTMLElement; sv: HTMLElement; key: string }
  const cells: Cell[] = [];
  for (let i = 0; i < 5; i++) {
    const box = document.createElement("div"); box.className = "card empty"; box.dataset.i = String(i);
    box.innerHTML = `<div class="art"><img alt="" draggable="false"><i class="gem"></i><b class="ct"></b></div><div class="idx"></div><div class="rar tn-weapons-rar"></div>
      <div class="plus">+</div><div class="nm">Empty</div><div class="stat"><div><small></small><b></b></div><span class="eq">Equipped</span></div>`;
    row.appendChild(box);
    cells.push({ box, img: box.querySelector("img")!, ct: box.querySelector(".ct")!, idx: box.querySelector(".idx")!, rar: box.querySelector(".rar")!, nm: box.querySelector(".nm")!,
      sl: box.querySelector(".stat small")!, sv: box.querySelector(".stat b")!, key: "" });
  }
  const ammoCells = AMMO.map(([n, , a]) => {
    const e = document.createElement("div"); e.className = "am"; e.style.setProperty("--a", a);
    e.innerHTML = `${BULLET}<span>${n}</span><b></b><i></i>`; ammoEl.appendChild(e);
    return { e, v: e.querySelector("b")! };
  });
  const ghost = document.createElement("img"); ghost.className = "ghost kr-hide"; ghost.draggable = false; root.appendChild(ghost);
  let open = false, fresh = false, last: HotbarSlot[] = [], ammoKey = "", active = -1;
  /** the selected card (keyboard, mouse and the controller's cursor alike) and the one picked up to move (−1: none) */
  let sel = 0, moving = -1;
  const filled = (i: number) => !!last[i] && last[i].kind !== "empty" && !!last[i].id;
  /** a long name steps down a size or three until it fits its card on one line (on change only: one layout read) */
  const fitName = (e: HTMLElement) => { for (let k = 0; k < 4; k++) { e.className = k ? `nm fit${k}` : "nm"; if (e.scrollWidth <= e.clientWidth + 1) return; } };

  // ---- selection + the action row
  const kc = (t: string, accent = true) => `<kbd class="tn-key${accent ? " tn-key--accent" : ""}">${esc(t)}</kbd>`;
  function keysFor() {
    if (device.pad) { const f = glyphFamily(); return { equip: glyph(PB.Y, f), move: glyph(PB.A, f), drop: glyph(PB.X, f), cancel: backText() }; }
    return { equip: bindingText("use", 0).toUpperCase(), move: bindingText("reload", 0).toUpperCase(), drop: bindingText("throw", 0).toUpperCase(), cancel: backText() };
  }
  let actsSig = "";
  function paint() {
    cells.forEach((c, i) => {
      c.box.classList.toggle("sel", i === sel);
      c.box.classList.toggle("moving", i === moving);
      c.box.classList.toggle("target", moving >= 0 && i !== moving);
    });
    const k = keysFor(), s = last[sel], name = filled(sel) ? slotName(s) : "";
    const sig = `${sel}|${moving}|${active}|${name}|${k.equip}|${k.move}|${k.drop}|${k.cancel}|${moving >= 0 ? slotName(last[moving]) : ""}`;
    if (sig === actsSig) return;
    actsSig = sig;
    if (moving >= 0) acts.innerHTML = `<span class="moving">Moving ${esc(slotName(last[moving]))} · choose a slot</span><span class="sep"></span><button type="button" data-a="cancel">${kc(k.cancel, false)} Cancel</button>`;
    else if (name) {
      const eq = sel === active;
      acts.innerHTML = `<button type="button" data-a="equip"${eq ? " disabled" : ""}>${kc(k.equip)} ${eq ? "Equipped" : "Equip"}</button><span class="sep"></span>`
        + `<button type="button" data-a="move">${kc(k.move)} Move</button><span class="sep"></span><button type="button" data-a="drop">${kc(k.drop)} Drop</button>`;
    } else acts.innerHTML = `<span class="note">Empty slot · pick up items in the world</span>`;
    // the row sits under the selected card (219 a card, at most 700) and never runs past the panel
    const tu = actsRow.clientWidth / 1072, x = Math.max(0, Math.min(sel * 219 * tu, 700 * tu, actsRow.clientWidth - acts.offsetWidth - 4 * tu));
    acts.style.transform = `translateX(${x.toFixed(1)}px)`;
  }
  function select(i: number) { i = Math.max(0, Math.min(4, i)); if (i === sel) return; sel = i; paint(); }
  function equip() { if (moving < 0 && filled(sel) && sel !== active) inv.onEquip(sel); }
  function startMove() { if (moving < 0 && filled(sel)) { moving = sel; paint(); } }
  function place(to: number) { const from = moving; moving = -1; sel = to; if (from >= 0 && from !== to) inv.onMove(from, to); paint(); }
  function drop() { const i = moving >= 0 ? moving : sel; moving = -1; if (filled(i)) inv.onDrop(i); paint(); }
  acts.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-a]"); if (!a || a.disabled) return;
    if (a.dataset.a === "equip") equip(); else if (a.dataset.a === "move") startMove(); else if (a.dataset.a === "drop") drop(); else if (a.dataset.a === "cancel") inv.cancel();
  });
  // the close button: the same as the inventory key (the game owns closing — it frees / takes the pointer)
  closeBtn.addEventListener("click", () => { inv.cancel(); inv.onClose(); });

  // ---- drag: pointer events with capture, so a release anywhere (even outside the window) resolves the drag; a press
  // that does not travel is a click (select / place)
  let press: { from: number; id: number; x: number; y: number; drag: boolean } | null = null, over = -1;
  const slotAt = (x: number, y: number) => { const e = document.elementFromPoint(x, y)?.closest<HTMLElement>(".kr-inv .card"); return e ? Number(e.dataset.i) : -1; };
  const inPanel = (x: number, y: number) => { const r = panel.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; };
  const setOver = (i: number) => { if (i === over) return; if (over >= 0) cells[over].box.classList.remove("over"); over = i; if (i >= 0) cells[i].box.classList.add("over"); };
  const moveGhost = (x: number, y: number) => { ghost.style.transform = `translate(${x - ghost.offsetWidth / 2}px, ${y - ghost.offsetHeight / 2}px)`; };
  const endDrag = () => {
    if (!press) return;
    cells[press.from].box.classList.remove("src"); setOver(-1); ghost.classList.add("kr-hide"); root.classList.remove("dropping");
    if (root.hasPointerCapture(press.id)) root.releasePointerCapture(press.id);
    press = null;
  };
  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || press) return;
    const i = slotAt(e.clientX, e.clientY); if (i < 0) return;
    e.preventDefault();
    if (moving >= 0) { place(i); return; }
    select(i);
    if (!filled(i)) return;
    press = { from: i, id: e.pointerId, x: e.clientX, y: e.clientY, drag: false };
    root.setPointerCapture(e.pointerId);
  });
  root.addEventListener("pointermove", (e) => {
    if (!press || e.pointerId !== press.id) return;
    if (!press.drag) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
      press.drag = true; cells[press.from].box.classList.add("src"); ghost.src = cells[press.from].img.src; ghost.classList.remove("kr-hide");
    }
    moveGhost(e.clientX, e.clientY);
    const i = slotAt(e.clientX, e.clientY); setOver(i >= 0 && i !== press.from ? i : -1);
    root.classList.toggle("dropping", !inPanel(e.clientX, e.clientY));
  });
  root.addEventListener("pointerup", (e) => {
    if (!press || e.pointerId !== press.id) return;
    const { from, drag } = press, to = slotAt(e.clientX, e.clientY), off = !inPanel(e.clientX, e.clientY);
    endDrag();
    if (!drag) return;
    if (to >= 0 && to !== from) { sel = to; inv.onMove(from, to); paint(); }
    else if (off) inv.onDrop(from);
  });
  root.addEventListener("pointercancel", endDrag);
  root.addEventListener("contextmenu", (e) => e.preventDefault());

  // slot numbers, the close keys and the action keys follow the bindings (SETTINGS → CONTROLS) and the device in hand
  onLabelsChange(() => {
    cells.forEach((c, i) => { c.idx.textContent = device.pad ? String(i + 1) : bindingText("slots", i); });
    closeKeys.innerHTML = device.pad ? `${kc(padText("inventory", 0) || "—")}${kc(backText())}` : `${kc(bindingText("inventory", 0).toUpperCase())}${kc(backText())}`;
    actsSig = ""; paint();
  });
  const bound = (a: BindAction, code: string) => preferences.value.binds[a].includes(code);
  const moveKeys = ["fwd", "back", "left", "right"] as const;

  const inv: InventoryScreen = {
    el: root,
    get open() { return open; },
    setOpen(v: boolean) {
      if (v === open) return; open = v; root.classList.toggle("kr-hide", !v); if (!v) endDrag(); moving = -1;
      // opening selects what is in hand (or the first thing carried) — on the first update, from fresh state
      fresh = v; if (v) { actsSig = ""; paint(); }
    },
    update(hotbar, act, reserves) {
      last = hotbar;
      if (!open) return;
      let count = 0, changed = act !== active;
      active = act;
      if (fresh) { fresh = false; sel = filled(act) ? act : Math.max(0, hotbar.findIndex((_, i) => filled(i))); changed = true; }
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i], s = hotbar[i];
        const empty = !filled(i);
        if (!empty) count++;
        const key = s ? `${s.kind}:${s.id}:${s.rarity}:${s.count}:${s.name ?? ""}:${s.color ?? ""}:${i === act ? 1 : 0}` : "";
        if (key === c.key) continue;
        c.key = key; changed = true;
        c.box.classList.toggle("empty", empty); c.box.classList.toggle("equipped", !empty && i === act);
        c.box.classList.toggle("myth", !empty && s.rarity === "mythic");
        if (empty) { delete c.box.dataset.rarity; c.box.style.removeProperty("--sig"); c.nm.textContent = "Empty"; c.nm.className = "nm"; c.ct.textContent = ""; continue; }
        // the rarity tile + its text pill (a mythic: the mythic tier's tile, its own signature colour as the gem)
        c.box.dataset.rarity = s.rarity; c.rar.textContent = s.rarity;
        if (s.color) c.box.style.setProperty("--sig", s.color); else c.box.style.removeProperty("--sig");
        if (s.id) { const src = itemIconUrl(s.id); if (c.img.getAttribute("src") !== src) { c.img.src = src; fitArt(c.img, ART, 0.94); } }
        const name = slotName(s);
        c.nm.textContent = name;
        fitName(c.nm);
        const st = statOf(s);
        c.sl.textContent = st ? st[0] : ""; c.sv.textContent = st ? st[1] : "";
        // a consumable's stack on its tile
        c.ct.textContent = s.kind === "consumable" ? `×${s.count}` : "";
      }
      if (moving >= 0 && !filled(moving)) moving = -1;
      countEl.textContent = String(count);
      if (changed) paint();
      const ak = Array.from(reserves).join(",");
      if (ak !== ammoKey) {
        ammoKey = ak;
        AMMO.forEach(([, type], i) => {
          const v = reserves[i] ?? 0, cap = AMMO_CAP[type];
          ammoCells[i].v.innerHTML = `${v} <em>/ ${cap}</em>`;
          ammoCells[i].e.style.setProperty("--v", String(Math.min(1, v / cap)));
          ammoCells[i].e.classList.toggle("none", v <= 0);
        });
      }
    },
    onMove: () => {},
    onDrop: () => {},
    onEquip: () => {},
    onClose: () => {},
    key(code) {
      if (!open) return false;
      const slot = preferences.value.binds.slots.indexOf(code);
      if (slot >= 0) { if (moving >= 0) place(slot); else select(slot); return true; }
      if (code === "Enter" || code === "NumpadEnter") { if (moving >= 0) { place(sel); return true; } return false; }
      if (bound("use", code)) { equip(); return true; }
      if (bound("reload", code)) { if (moving >= 0) place(sel); else startMove(); return true; }
      if (bound("throw", code)) { drop(); return true; }
      // the arrows select — unless they move the kong (by default they do: you keep running with the inventory open)
      if ((code === "ArrowLeft" || code === "ArrowRight") && !moveKeys.some((a) => bound(a, code))) { select(sel + (code === "ArrowRight" ? 1 : -1)); return true; }
      return false;
    },
    cancel() { if (moving < 0) return false; moving = -1; paint(); return true; },
    padMove(dir) { sel = (sel + dir + 5) % 5; paint(); },
    padSelect() { if (moving < 0) startMove(); else place(sel); },
    padDrop() { drop(); },
    padEquip() { equip(); },
    padCancel() { return inv.cancel(); },
  };
  return inv;
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
