// The BANANA STAND buy menu: your wallet, the offers as cards (icon,
// name, what it does, price), each one either ready (yellow price tag), too dear (red tag: how many Bucks short) or not
// available right now (the reason in place of the description). Mouse click, keys 1-7, controller stick / d-pad / LB-RB
// + A to buy, B / interact / Esc to leave. DOM only, rebuilt only when a value changes; the server decides every
// purchase (the game sends INV.Buy).
// Dressed as the kiosk itself: the striped awning
// with its scallops, a coconut-wood board, the stand's little monkey shopkeeper (the same one behind the 3D counter) with
// his line in the free slot, fruit-crate cards with price tags, and the BANANA BUCKS coin wherever money shows (ui/bucks.ts).
import { itemIconUrl, svgGlyph } from "./icons";
import { injectStyles, UI } from "./styles";
import { bucksHtml, coinHtml, injectBucksCss, moneyHtml } from "./bucks";
import { backText, bindingText, glyphFamily, onLabelsChange, padText } from "../settings/labels";
import { device } from "../settings/device";
import { glyph, PB, stickGlyph } from "../settings/pad";
import type { PadOwner } from "./padnav";

export interface ShopOffer { id: number; name: string; desc: string; price: number; icon: string; ok: boolean; why?: string }
export interface ShopView { cash: number; title: string; sub: string; offers: ShopOffer[] }
export interface ShopScreen {
  el: HTMLElement; readonly open: boolean; readonly stand: number;
  setOpen(open: boolean, stand?: number): void;
  update(v: ShopView): void;
  /** a purchase was asked for (the menu flashes the card; the wallet updates when the server says so) */
  onBuy: (offer: number) => void;
  /** a locked or unaffordable card was pressed (subtle denied cue) */
  onDeny: () => void;
  padMove(dx: number, dy: number): void; padSelect(): void;
  /** keyboard: the n-th card (1-based) */
  key(n: number): void;
}

/** the stand's shopkeeper (front view, banana-yellow vendor cap) — the 3D monkey behind the counter wears the same */
export const MONKEY_SVG = `<svg viewBox="0 0 100 100" aria-hidden="true">
<circle cx="17" cy="55" r="13" fill="#6a3a1a"/><circle cx="17" cy="55" r="7.5" fill="#e3a979"/>
<circle cx="83" cy="55" r="13" fill="#6a3a1a"/><circle cx="83" cy="55" r="7.5" fill="#e3a979"/>
<circle cx="50" cy="54" r="33" fill="#7b4520"/>
<path d="M37 47c-9 0-14 8-12 17 2 12 13 20 25 20s23-8 25-20c2-9-3-17-12-17-5 0-9 3-13 3s-8-3-13-3z" fill="#f2c99a"/>
<ellipse cx="50" cy="45.5" rx="24" ry="4" fill="#5a2f12" opacity=".28"/>
<g class="eyes"><ellipse cx="40" cy="54" rx="5.2" ry="6.6" fill="#2a1607"/><ellipse cx="60" cy="54" rx="5.2" ry="6.6" fill="#2a1607"/>
<circle cx="41.8" cy="51.6" r="1.9" fill="#fff"/><circle cx="61.8" cy="51.6" r="1.9" fill="#fff"/></g>
<ellipse cx="46.5" cy="65" rx="1.8" ry="1.3" fill="#6a3a1a"/><ellipse cx="53.5" cy="65" rx="1.8" ry="1.3" fill="#6a3a1a"/>
<path d="M40 71q10 8 20 0" stroke="#5a2f12" stroke-width="2.6" fill="none" stroke-linecap="round"/>
<path d="M22 39c1-15 13-25 28-25s27 10 28 25z" fill="#ffd400"/><path d="M50 14v25" stroke="#e0a800" stroke-width="1.6"/>
<path d="M20 40q30-9 60 0q-2 6-30 6t-30-6z" fill="#e0a800"/>
<path d="M57.5 23.5c1.7 5-1.9 10.2-8.1 9.6-.9-.1-1.5-.8-1-1.3 4.3-.6 7.3-4 7.4-8z" fill="#6b3d06"/>
<path d="M30 27q3-7 10-10" stroke="#fff3a8" stroke-width="3" fill="none" stroke-linecap="round"/></svg>`;

const u = (n: number) => `calc(${n} * var(--u))`;
// awning: 56 u stripes (yellow / cream) and a scallop under each, in its own colour
const AW = 56;
const CSS = `
.kr-shop { position: absolute; inset: 0; --u: min(calc(100vh / 1080 * var(--hud-scale, 1)), calc(100vw / 1200)); pointer-events: auto; user-select: none; -webkit-user-select: none;
  background: radial-gradient(ellipse at center, rgba(40,26,4,0.35), rgba(6,10,16,0.8)); font-family: ${UI.sans}; color: ${UI.creamText}; display: none; place-items: center; z-index: 15; }
.kr-shop.on { display: grid; }
.kr-shop * { box-sizing: border-box; }
.kr-shop .panel { position: relative; width: ${u(1120)}; padding-top: ${u(30)}; filter: drop-shadow(0 ${u(26)} ${u(40)} rgba(0,0,0,0.55)); animation: krShopIn .18s cubic-bezier(.2,.8,.2,1); }
@keyframes krShopIn { from { transform: translateY(${u(14)}) scale(.985); opacity: 0; } to { transform: none; opacity: 1; } }
/* the awning: stripes + scallops, over the board */
.kr-shop .awning { position: absolute; left: ${u(-18)}; right: ${u(-18)}; top: 0; height: ${u(58)}; z-index: 2; border-radius: ${u(10)} ${u(10)} 0 0;
  background: repeating-linear-gradient(90deg, #ffd21f 0 ${u(AW)}, #fff3cc ${u(AW)} ${u(AW * 2)}); box-shadow: inset 0 ${u(-4)} 0 rgba(150,90,0,0.25), inset 0 ${u(3)} 0 rgba(255,255,255,0.5); }
.kr-shop .awning::after { content: ""; position: absolute; left: 0; right: 0; top: 100%; height: ${u(AW / 2)};
  background: radial-gradient(circle at ${u(AW / 2)} 0, #ffd21f ${u(AW / 2 - 1)}, transparent ${u(AW / 2)}) 0 0 / ${u(AW * 2)} ${u(AW / 2)} repeat-x,
              radial-gradient(circle at ${u(AW * 1.5)} 0, #fff3cc ${u(AW / 2 - 1)}, transparent ${u(AW / 2)}) 0 0 / ${u(AW * 2)} ${u(AW / 2)} repeat-x;
  filter: drop-shadow(0 ${u(4)} ${u(3)} rgba(40,20,0,0.35)); }
/* the board: coconut-wood planks, a gold rim */
.kr-shop .board { position: relative; border-radius: ${u(12)}; overflow: hidden; border: ${u(3)} solid ${UI.yellow};
  background: repeating-linear-gradient(90deg, rgba(0,0,0,0.22) 0 ${u(2)}, transparent ${u(2)} ${u(140)}), linear-gradient(180deg, #4b2c15, #331d0d 60%, #2a170a); }
.kr-shop .head { display: flex; align-items: center; gap: ${u(20)}; padding: ${u(48)} ${u(34)} ${u(18)}; }
.kr-shop .badge { width: ${u(104)}; height: ${u(104)}; flex: none; border-radius: 50%; background: radial-gradient(circle at 50% 40%, #fff1c9, #f2c879);
  box-shadow: 0 0 0 ${u(4)} ${UI.yellow}, 0 0 0 ${u(8)} rgba(20,10,0,0.55), 0 ${u(8)} ${u(16)} rgba(0,0,0,0.45); display: grid; place-items: center; overflow: hidden; }
.kr-shop .badge svg { width: 92%; height: 92%; transform: translateY(6%); }
.kr-shop .ttl { font: 900 ${u(64)} ${UI.cond}; letter-spacing: .04em; line-height: .95; color: ${UI.yellow};
  text-shadow: 0 ${u(3)} 0 #8a4f00, 0 ${u(6)} ${u(10)} rgba(0,0,0,0.5); }
.kr-shop .sub { font: 700 ${u(19)} ${UI.cond}; letter-spacing: .14em; color: rgba(251,243,201,0.78); margin-top: ${u(6)}; }
.kr-shop .wallet { margin-left: auto; text-align: right; padding: ${u(10)} ${u(22)} ${u(12)}; border-radius: ${u(12)};
  background: linear-gradient(180deg, rgba(14,8,2,0.75), rgba(24,14,4,0.9)); box-shadow: inset 0 0 0 ${u(2)} rgba(255,212,0,0.55), 0 ${u(4)} ${u(10)} rgba(0,0,0,0.35); }
.kr-shop .wallet small { display: block; font: 800 ${u(16)} ${UI.cond}; letter-spacing: .18em; color: rgba(251,243,201,0.7); }
.kr-shop .wallet .cash { display: flex; align-items: center; justify-content: flex-end; font: 900 ${u(48)} ${UI.cond}; color: ${UI.yellow}; letter-spacing: .02em; line-height: 1.05; }
.kr-shop .wallet .kr-bb { width: ${u(40)}; height: ${u(40)}; margin-right: ${u(8)}; vertical-align: 0; filter: drop-shadow(0 ${u(2)} ${u(2)} rgba(0,0,0,0.5)); }
.kr-shop .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: ${u(18)}; padding: ${u(8)} ${u(32)} ${u(18)}; }
/* a card = the front of a fruit crate: planks, a dark frame, a stencilled number, a price tag */
.kr-shop .card { position: relative; height: ${u(268)}; border-radius: ${u(8)}; padding: ${u(12)} ${u(14)} 0; cursor: pointer; text-align: center;
  background: repeating-linear-gradient(180deg, transparent 0 ${u(64)}, rgba(45,22,6,0.5) ${u(64)} ${u(67)}), linear-gradient(180deg, #a06a36, #7c4c23);
  box-shadow: inset 0 0 0 ${u(4)} #5b3415, inset 0 0 0 ${u(6)} rgba(255,220,160,0.18), 0 ${u(6)} ${u(12)} rgba(0,0,0,0.35);
  transition: transform .09s ease-out, box-shadow .12s; }
html:not(.kr-pad) .kr-shop .card:hover, .kr-shop .card.sel { transform: translateY(${u(-4)}); box-shadow: inset 0 0 0 ${u(4)} ${UI.yellow}, inset 0 0 0 ${u(7)} rgba(255,240,170,0.35), 0 0 ${u(22)} rgba(255,212,0,0.55), 0 ${u(12)} ${u(20)} rgba(0,0,0,0.45); }
.kr-shop .card.off { cursor: default; filter: saturate(.25) brightness(.8); }
.kr-shop .card.flash { animation: krShopFlash .5s ease-out; }
.kr-shop .card.deny { animation: krShopDeny .26s ease-out; }
@keyframes krShopFlash { 0% { box-shadow: inset 0 0 0 ${u(6)} #fff, 0 0 ${u(44)} ${UI.yellow}; transform: translateY(${u(-4)}) scale(1.03); } 100% { transform: translateY(${u(-4)}); } }
@keyframes krShopDeny { 0%, 100% { transform: translateY(${u(-4)}); } 25% { transform: translateY(${u(-4)}) translateX(${u(-7)}); } 65% { transform: translateY(${u(-4)}) translateX(${u(6)}); } }
.kr-shop .card .k { position: absolute; left: ${u(12)}; top: ${u(10)}; min-width: ${u(32)}; height: ${u(32)}; padding: 0 ${u(6)}; border-radius: ${u(7)}; display: grid; place-items: center;
  font: 900 ${u(20)} ${UI.cond}; color: #2a1606; background: rgba(255,236,190,0.85); box-shadow: 0 ${u(2)} 0 rgba(60,30,8,0.6); }
html.kr-pad .kr-shop .card .k { opacity: 0; transform: scale(.85); transition: opacity .1s, transform .1s; padding: 0 ${u(9)}; }
html.kr-pad .kr-shop .card.sel .k { opacity: 1; transform: none; background: ${UI.yellow}; color: #2a1606; box-shadow: 0 ${u(2)} 0 #8a4f00, 0 0 ${u(12)} rgba(255,212,0,0.5); }
html.kr-pad .kr-shop .card.sel.off .k, html.kr-pad .kr-shop .card.sel.poor .k { background: rgba(255,236,190,0.45); box-shadow: 0 ${u(2)} 0 rgba(60,30,8,0.4); }
.kr-shop .card .ic { height: ${u(100)}; display: grid; place-items: center; margin-top: ${u(2)}; background: radial-gradient(closest-side, rgba(255,236,180,0.55), rgba(255,236,180,0) 85%); }
.kr-shop .card .ic img { width: ${u(98)}; height: ${u(98)}; object-fit: contain; filter: drop-shadow(0 ${u(5)} ${u(4)} rgba(30,12,0,0.55)); }
.kr-shop .card .ic svg { width: ${u(66)}; height: ${u(66)}; color: #fff1c4; filter: drop-shadow(0 ${u(3)} ${u(2)} rgba(30,12,0,0.6)); }
.kr-shop .card .nm { font: 900 ${u(25)} ${UI.cond}; letter-spacing: .03em; margin-top: ${u(4)}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff6d8; text-shadow: 0 ${u(2)} ${u(2)} rgba(40,16,0,0.75); }
.kr-shop .card .ds { font: 600 ${u(15)} ${UI.sans}; line-height: 1.25; height: ${u(40)}; margin-top: ${u(2)}; color: rgba(255,244,214,0.9); text-shadow: 0 ${u(1)} ${u(2)} rgba(40,16,0,0.7); }
.kr-shop .card .ds .kr-bb { width: 1em; height: 1em; }
.kr-shop .card.off .ds { color: #ffcf9a; }
/* the price tag, hung on the crate by its corner */
.kr-shop .card .tag { position: absolute; left: 50%; bottom: ${u(14)}; transform: translateX(-50%) rotate(-2deg); display: flex; align-items: center; gap: ${u(4)};
  padding: ${u(5)} ${u(18)} ${u(5)} ${u(26)}; font: 900 ${u(31)} ${UI.cond}; letter-spacing: .02em; color: #2a1606; background: #ffd21f; white-space: nowrap;
  clip-path: polygon(${u(14)} 0, 100% 0, 100% 100%, ${u(14)} 100%, 0 50%); box-shadow: inset 0 ${u(-3)} 0 rgba(140,80,0,0.35); }
.kr-shop .card .tag::before { content: ""; position: absolute; left: ${u(12)}; top: 50%; width: ${u(7)}; height: ${u(7)}; margin-top: ${u(-3.5)}; border-radius: 50%; background: #7c4c23; }
.kr-shop .card .tag .kr-bb { width: ${u(28)}; height: ${u(28)}; vertical-align: 0; }
/* "NEED x" stays readable: ≥ 11 px caps at 900p */
.kr-shop .card .tag small { font: 800 ${u(20)} ${UI.cond}; letter-spacing: .03em; margin-left: ${u(7)}; }
.kr-shop .card.poor .tag { background: #ff6a52; color: #fff4ea; }
.kr-shop .card.off .tag { background: #c9b98f; }
/* the shopkeeper's line, in the free slot */
.kr-shop .talk { position: relative; height: ${u(268)}; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; padding-bottom: ${u(10)}; }
.kr-shop .talk .bubble { position: relative; margin-bottom: ${u(16)}; padding: ${u(12)} ${u(16)}; border-radius: ${u(14)}; background: #fff3cf; color: #3a1e08;
  font: 900 ${u(22)} ${UI.cond}; letter-spacing: .03em; line-height: 1.1; text-align: center; box-shadow: 0 ${u(5)} ${u(10)} rgba(0,0,0,0.35); }
.kr-shop .talk .bubble::after { content: ""; position: absolute; left: 50%; bottom: ${u(-12)}; margin-left: ${u(-10)}; border: ${u(10)} solid transparent; border-top: ${u(12)} solid #fff3cf; border-bottom: 0; }
.kr-shop .talk .bubble .kr-bb { width: 1em; height: 1em; }
.kr-shop .talk .face { width: ${u(118)}; height: ${u(118)}; animation: krMonkeyBob 2.4s ease-in-out infinite; transform-origin: 50% 90%; }
.kr-shop .talk .face.wave { animation: krMonkeyHop .6s ease-out 2; }
@keyframes krMonkeyBob { 0%, 100% { transform: rotate(-3deg); } 50% { transform: rotate(3deg) translateY(${u(-2)}); } }
@keyframes krMonkeyHop { 0%, 100% { transform: none; } 40% { transform: translateY(${u(-14)}) rotate(-6deg); } }
.kr-shop .talk .face .eyes { animation: krMonkeyBlink 4.2s infinite; transform-origin: 50% 54%; }
@keyframes krMonkeyBlink { 0%, 94%, 100% { transform: none; } 96% { transform: scaleY(0.1); } }
.kr-shop .foot { display: flex; align-items: center; gap: ${u(20)}; padding: ${u(12)} ${u(32)} ${u(16)}; background: rgba(10,5,0,0.45); border-top: ${u(2)} solid rgba(255,212,0,0.25);
  font: 800 ${u(18)} ${UI.cond}; letter-spacing: .1em; color: rgba(251,243,201,0.82); }
.kr-shop .foot kbd { display: inline-grid; place-items: center; min-width: ${u(30)}; height: ${u(30)}; padding: 0 ${u(7)}; margin-right: ${u(6)}; border-radius: ${u(6)};
  font: 900 ${u(18)} ${UI.cond}; color: #2a1606; background: #fff1c9; box-shadow: 0 ${u(3)} 0 #a07a45; }
.kr-shop .foot .sp { flex: 1; }
.kr-shop .foot .sep { opacity: .45; margin: 0 ${u(8)}; }
.kr-shop .foot .warn { color: #ffb08a; }
`;
let styled = false;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]!));
const GLYPH: Record<string, "person" | "skull" | "bullet"> = { buyback: "person", bounty: "skull", ammo: "bullet" };
/** what the shopkeeper says: welcome / short of Bucks / thanks (after a purchase) */
const LINES = { hi: "WHAT'LL IT BE, KONG?", broke: "NO BUCKS, NO BANANAS! LOOT SOME CASH.", thanks: "PLEASURE DOING BUSINESS!" };

export function createShop(): ShopScreen {
  if (!styled) { injectStyles(); injectBucksCss(); const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st); styled = true; }
  const el = document.createElement("div"); el.className = "kr-shop"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Banana Stand");
  el.innerHTML = `<div class="panel"><div class="awning"></div><div class="board">
    <div class="head"><div class="badge">${MONKEY_SVG}</div><div><div class="ttl">BANANA STAND</div><div class="sub"></div></div>
      <div class="wallet"><small>BANANA BUCKS</small><span class="cash">${bucksHtml(0)}</span></div></div>
    <div class="grid"></div>
    <div class="foot"><span class="buy-hint"></span><span class="sp"></span><span class="warn">TAKING DAMAGE CLOSES THE STAND</span><span class="leave"></span></div></div></div>`;
  const grid = el.querySelector<HTMLElement>(".grid")!, cashEl = el.querySelector<HTMLElement>(".cash")!, subEl = el.querySelector<HTMLElement>(".sub")!, buyHintEl = el.querySelector<HTMLElement>(".buy-hint")!, leaveEl = el.querySelector<HTMLElement>(".leave")!;
  let cards: Array<{ el: HTMLElement; k: HTMLElement; nm: HTMLElement; ds: HTMLElement; tag: HTMLElement; id: number; ok: boolean; icon: string }> = [];
  let talk: { bubble: HTMLElement; face: HTMLElement } | null = null;
  let open = false, stand = -1, sel = 0, fresh = false, lastSig = "", view: ShopView | null = null, thanksUntil = 0, denyUntil = 0, denyLine = "";
  const say = () => {
    if (!talk || !view) return;
    const now = performance.now();
    const avail = view.offers.filter((o) => !o.why).map((o) => o.price);
    const cheapest = avail.length ? Math.min(...avail) : Infinity;
    const line = now < thanksUntil ? LINES.thanks : now < denyUntil && denyLine ? denyLine : view.cash < cheapest ? LINES.broke : LINES.hi;
    if (talk.bubble.dataset.line !== line) { talk.bubble.dataset.line = line; talk.bubble.textContent = line; }
  };
  const paintHints = () => {
    if (device.pad) {
      const f = glyphFamily(), a = glyph(PB.A, f), st = stickGlyph("left", f), lb = glyph(PB.LB, f), rb = glyph(PB.RB, f);
      const inter = padText("interact", 0), b = backText();
      buyHintEl.innerHTML = `<kbd>${esc(st)}</kbd><kbd>D-PAD</kbd>MOVE<span class="sep">·</span><kbd>${esc(lb)}</kbd><kbd>${esc(rb)}</kbd>CYCLE<span class="sep">·</span><kbd>${esc(a)}</kbd>BUY`;
      leaveEl.innerHTML = `${inter && inter !== b ? `<kbd>${esc(inter)}</kbd>` : ""}<kbd>${esc(b)}</kbd>LEAVE`;
      cards.forEach((c) => { c.k.textContent = a; });
    } else {
      buyHintEl.innerHTML = `<kbd>1</kbd>–<kbd>${cards.length || 7}</kbd> OR CLICK TO BUY`;
      leaveEl.innerHTML = `<kbd>${esc(bindingText("use", 0).toUpperCase() || "E")}</kbd><kbd>ESC</kbd>LEAVE`;
      cards.forEach((c, i) => { c.k.textContent = String(i + 1); });
    }
  };
  const buy = (i: number) => {
    const c = cards[i], o = view?.offers[i]; if (!c || !o) return;
    if (!o.ok) {
      c.el.classList.remove("deny"); void c.el.offsetWidth; c.el.classList.add("deny");
      denyLine = o.why ?? (view ? `NEED ${(o.price - view.cash).toLocaleString("en-US")} MORE BUCKS!` : LINES.broke);
      denyUntil = performance.now() + 1800; say();
      setTimeout(say, 1900);
      scr.onDeny();
      return;
    }
    c.el.classList.remove("flash"); void c.el.offsetWidth; c.el.classList.add("flash");
    thanksUntil = performance.now() + 2200; denyUntil = 0; say();
    if (talk) { talk.face.classList.remove("wave"); void talk.face.getBoundingClientRect(); talk.face.classList.add("wave"); }
    setTimeout(say, 2300);
    scr.onBuy(o.id);
  };
  const select = (i: number) => {
    if (!cards.length) { sel = 0; return; }
    sel = Math.max(0, Math.min(cards.length - 1, i));
    cards.forEach((c, k) => c.el.classList.toggle("sel", k === sel));
  };
  const moveGrid = (dx: number, dy: number) => {
    const n = cards.length; if (!n) return;
    if (dx !== 0) select((sel + dx + n) % n);
    if (dy > 0) {
      if (sel + 4 < n) select(sel + 4);
      else if (Math.floor(sel / 4) < Math.floor((n - 1) / 4)) select(n - 1);
    } else if (dy < 0 && sel >= 4) select(sel - 4);
  };
  const build = (v: ShopView) => {
    grid.textContent = ""; cards = []; talk = null;
    v.offers.forEach((o, i) => {
      const card = document.createElement("div"); card.className = "card";
      card.innerHTML = `<div class="k">${i + 1}</div><div class="ic"></div><div class="nm"></div><div class="ds"></div><div class="tag"></div>`;
      const ic = card.querySelector<HTMLElement>(".ic")!;
      if (GLYPH[o.icon]) ic.appendChild(svgGlyph(GLYPH[o.icon])); else { const im = document.createElement("img"); im.src = itemIconUrl(o.icon); im.alt = ""; ic.appendChild(im); }
      card.addEventListener("click", () => { select(i); buy(i); });
      card.addEventListener("mouseenter", () => { if (!device.pad) select(i); });
      grid.appendChild(card);
      cards.push({ el: card, k: card.querySelector(".k")!, nm: card.querySelector(".nm")!, ds: card.querySelector(".ds")!, tag: card.querySelector(".tag")!, id: o.id, ok: o.ok, icon: o.icon });
    });
    // the free slot(s) of the last row: the shopkeeper
    if (v.offers.length % 4) {
      const t = document.createElement("div"); t.className = "talk"; t.style.gridColumn = `span ${4 - (v.offers.length % 4)}`;
      t.innerHTML = `<div class="bubble"></div><div class="face">${MONKEY_SVG}</div>`;
      grid.appendChild(t); talk = { bubble: t.querySelector(".bubble")!, face: t.querySelector(".face")! };
    }
    paintHints();
    select(sel);
  };
  onLabelsChange(paintHints);
  (el as HTMLElement & { krPad?: PadOwner }).krPad = {
    move(dir) {
      if (dir === "left") moveGrid(-1, 0);
      else if (dir === "right") moveGrid(1, 0);
      else if (dir === "up") moveGrid(0, -1);
      else moveGrid(0, 1);
      return true;
    },
    button(b) {
      if (b === PB.A) { buy(sel); return true; }
      if (b === PB.LB) { moveGrid(-1, 0); return true; }
      if (b === PB.RB) { moveGrid(1, 0); return true; }
      return false;
    },
  };
  const scr: ShopScreen = {
    el, get open() { return open; }, get stand() { return stand; },
    setOpen(o, s = -1) {
      open = o; stand = o ? s : -1; el.classList.toggle("on", o);
      if (o) { fresh = true; lastSig = ""; thanksUntil = 0; denyUntil = 0; denyLine = ""; select(0); paintHints(); }
    },
    update(v) {
      view = v;
      const shape = v.offers.map((o) => o.id + o.icon).join(",");
      if (shape !== (cards.map((c) => c.id + c.icon).join(","))) build(v);
      if (fresh) {
        fresh = false;
        let idx = v.offers.findIndex((o) => o.ok);
        if (idx < 0) idx = v.offers.findIndex((o) => !o.why);
        select(idx >= 0 ? idx : 0);
      }
      say();
      const sig = `${v.cash}|${v.sub}|` + v.offers.map((o) => `${o.name}${o.price}${o.ok ? 1 : 0}${o.why ?? ""}`).join("|");
      if (sig === lastSig) return; lastSig = sig;
      cashEl.innerHTML = bucksHtml(v.cash); subEl.textContent = v.sub;
      v.offers.forEach((o, i) => {
        const c = cards[i]; c.ok = o.ok;
        const poor = !o.ok && !o.why;
        c.nm.textContent = o.name; c.ds.innerHTML = moneyHtml(o.why ?? o.desc);
        c.tag.innerHTML = `${coinHtml()}${o.price.toLocaleString("en-US")}${poor ? `<small>NEED ${(o.price - v.cash).toLocaleString("en-US")}</small>` : ""}`;
        c.el.classList.toggle("off", !o.ok && !!o.why); c.el.classList.toggle("poor", poor);
      });
    },
    onBuy: () => {},
    onDeny: () => {},
    padMove(dx, dy) { moveGrid(dx, dy); },
    padSelect() { buy(sel); },
    key(n) { if (n >= 1 && n <= cards.length) { select(n - 1); buy(n - 1); } },
  };
  return scr;
}
