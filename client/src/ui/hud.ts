// The in-match HUD. DOM + a few 2D canvases, no frameworks. Designed at 2560×1440; every size
// derives from --u (styles.ts) so it scales with viewport height and stays crisp at 4K (canvases are DPR-aware).
// update() touches the DOM only when a value changes; animation is transform / opacity only. Events (`at` keys) are
// timed on the HUD's own clock (sum of dt), so the game may use any timestamp unit.
import { CONSUMABLES, POIS, RARITY_COLOR, type ConsumableId, type Rarity, type WeaponId } from "../../../shared/world/map";
import { CONSUMABLE_DEFS, WEAPON_DEFS } from "../../../shared/sim/const";
import type { Terrain } from "../../../shared/world/terrain";
import type { Hud, HudState, IconRenderer } from "./api";
import { hudUnit, injectStyles, RARITY_DEEP, UI } from "./styles";
import { createMapImage, type PaintedMap } from "./mapimage";
import { itemIconUrl, preloadItems, svgGlyph, weaponSilhouette, drawGlyph } from "./icons";
import { CenterLayer } from "./center";
import { Medals } from "./medals";
import { injectHudToon } from "./hud-css";
import { MatchStats } from "./hud-stats";
import { HudFeedback } from "./hud-feedback";
import { TOON, toonFontsReady } from "./toon";
import { SpectateUi } from "./spectate";
import { Minimap, SQUAD_COLOURS } from "./minimap";
import { BigMap } from "./bigmap";
import { paintScope } from "./scope";
import { createHotbar } from "./hotbar";
import { createWeaponPrompts } from "./weapon-prompts";
import { preferences } from "../settings/preferences";
import { bindingText, lookText, onLabelsChange, padText } from "../settings/labels";
import { device } from "../settings/device";
import type { BindAction } from "../settings/bindings";
import { safeEdgeGuide } from "../game/hud-state";
import { setMoney } from "./bucks";
import { flag } from "../flags";

const FEED_MAX = 6;
const DMG_POOL = 16;
const CARDS: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
const PXD = 5.4, CW = 760, CH = 60;       // compass: design px per degree (15° = 81 px), canvas size (design px)
/** the key the player has bound to `action` (primary unless `index`), as a prompt shows it */
const keyName = (action: BindAction, index = 0) => bindingText(action, index).toUpperCase();
/** SETTINGS → ACCESSIBILITY → reduced motion: no pops, slides, pulses or flashing (values still update) */
const calm = () => preferences.value.reducedMotion;
const fmtClock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s)) % 60).padStart(2, "0")}`;
const KIND_RANK = { body: 0, shield: 1, head: 2, break: 3, kill: 4 } as const;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent.appendChild(e);
  return e;
}
const txt = (e: HTMLElement, s: string) => { if (e.textContent !== s) e.textContent = s; };
const tog = (e: Element, cls: string, on: boolean) => { if (e.classList.contains(cls) !== on) e.classList.toggle(cls, on); };
const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

const EMPTY_MATES: NonNullable<HudState["mates"]> = [];
export function createHud(terrain: Terrain, pois: typeof POIS): Hud {
  injectStyles();
  void preloadItems();
  const map = createMapImage(terrain, 2560, pois) as PaintedMap;

  const root = document.createElement("div");
  root.className = "kr-root";

  // ---------------------------------------------------------------- layers (bottom → top)
  const scopeWrap = el("div", "kr-scope kr-hide", root);
  const scopeCanvas = el("canvas", "", scopeWrap);
  const breath = el("div", "breath", scopeWrap);
  const breathLbl = el("span", "", breath);
  breathLbl.textContent = `HOLD ${keyName("sprint")} · STEADY`;
  const breathBar = el("div", "b", breath);
  const breathFill = el("i", "", breathBar);
  const zoomLbl = el("div", "zoom", scopeWrap);

  // (Toon) the HUD skin: ui/hud-css.ts, on top of the base sheet
  injectHudToon();
  // feedback layers: storm, under-30 vignette, damage with no shooter, own shield break (red), healing (blue);
  // hud-feedback.ts drives them and adds the directional edge glows above them
  const vigStorm = el("div", "kr-vig storm", root);
  const vigLow = el("div", "kr-vig low", root);
  const vigDmg = el("div", "kr-vig dmg", root);
  const vigShield = el("div", "kr-vig shield", root);
  const vigHeal = el("div", "kr-vig heal", root);

  // minimap (Toon: rounded, outlined) and the mode label under it: eyebrow + rule (WARM-UP / TRIOS / SOLO), then the
  // named place you are in (it lights up on arrival). On the range the practice panel (game/range.ts) is
  // the label, with its keycap hints.
  const mmWrap = el("div", "kr-minimap", root);
  const minimap = new Minimap(map, pois);
  minimap.band = 206 / 254;                                   // the frame's inner height / width (hud-css.ts .kr-minimap, 262 × 214 less the outline)
  mmWrap.appendChild(minimap.canvas);
  // the left column under the minimap: the mode / place label, then the storm clock and the storm /
  // resurgence warnings (they left the top centre: only the compass and its status line stay there), then the squad
  const leftCol = el("div", "tn-hud-left", root);
  const whereEl = el("div", "kr-where kr-hide", leftCol);
  const whereEb = el("div", "eb", whereEl);
  const wherePlate = el("div", "plate", whereEl);
  const whereTx = wherePlate;
  let whereEbV = "\0", whereSubV = "\0", whereRange: boolean | null = null;

  // compass (Toon: Lilita cardinals with an outline, Nunito degrees; markers under the scale)
  const compWrap = el("div", "kr-compass", root);
  const compCanvas = el("canvas", "", compWrap);
  const compCtx = compCanvas.getContext("2d")!;

  // alive / storm pill (left column)
  const pill = el("div", "kr-pill", leftCol);
  const pa = el("div", "grp a", pill);
  pa.appendChild(svgGlyph("person", "ic person"));
  const pillAlive = el("span", "v", pa);
  const pb = el("div", "grp b", pill);
  const clockIc = svgGlyph("clock", "ic clock");
  const stormIc = svgGlyph("storm", "ic clock");
  stormIc.style.display = "none";
  pb.append(clockIc, stormIc);
  const pillTime = el("span", "v t", pb);
  const clockLabel = el("div", "clock-label", pill);
  // no progress bar in the pill: the countdown and its label only
  // the warnings under the storm clock (left column): the storm guide, RESURGENCE OFF, STORM CLOSING
  const warnEl = el("div", "tn-hud-warn kr-hide", leftCol);
  // live tactical & match event countdown pills (UAV Radar Pulse, Fire Sale)
  const evWrap = el("div", "tn-hud-events", leftCol);
  const uavPill = el("div", "tn-hud-ev uav kr-hide", evWrap);
  uavPill.appendChild(svgGlyph("radar"));
  const uavTx = el("span", "", uavPill);
  const salePill = el("div", "tn-hud-ev sale kr-hide", evWrap);
  salePill.appendChild(svgGlyph("banana"));
  const saleTx = el("span", "", salePill);
  let uavSig = "", saleSig = "";
  // the plain status line under the compass (FIRING RANGE · INFINITE AMMO, WARM-UP …): stays top centre
  const substat = el("div", "kr-substat kr-hide", root);

  // squad (trios)
  const squadWrap = el("div", "kr-squad", leftCol);
  interface MateRow { box: HTMLElement; nm: HTMLElement; st: HTMLElement; hp: HTMLElement; sh: HTMLElement; key: string }
  const mateRows: MateRow[] = [];
  for (let i = 0; i < 3; i++) {
    const box = el("div", "m kr-hide", squadWrap);
    box.style.setProperty("--c", SQUAD_COLOURS[i]);
    const nm = el("div", "nm", box), st = el("div", "st", box), bars = el("div", "bars", box);
    const hpB = el("b", "h", bars), shB = el("b", "s", bars);
    mateRows.push({ box, nm, st, hp: el("i", "", hpB), sh: el("i", "", shB), key: "" });
  }

  // vitals
  const vitals = el("div", "kr-vitals", root);
  const mkRow = (cls: string, glyph: "heart" | "shield", col: string) => {
    const row = el("div", `row ${cls}`, vitals);
    row.appendChild(svgGlyph(glyph, "ic", col));
    const bar = el("div", "bar", row);
    const gain = el("i", "gain", bar), chip = el("i", "chip", bar), fill = el("i", "fill", bar);
    const num = el("div", "num", row);
    // the glow around the bar while it is being healed / charged (hud-css.ts .kr-vitals .glow)
    el("i", "glow", row);
    return { row, bar, gain, chip, fill, num, v: -1, chipV: 1, fillV: 1, hold: 0, n: -1, glowUntil: -1, glow: false };
  };
  const hpR = mkRow("hp", "heart", TOON.accentShade);
  const shR = mkRow("sh", "shield", TOON.shield);
  const crack = el("div", "crack", shR.row);

  // (economy) the wallet chip over the health bars, the squad's bounty card under the minimap, the hunted banner
  const cashChip = el("div", "kr-cash kr-hide", root);
  const cashV = el("b", "v", cashChip), cashGain = el("i", "g", cashChip);
  // the bounty contract card lives in the left column under the storm clock, not the top centre
  const bountyCard = el("div", "kr-bountycard kr-hide", leftCol);
  const bountyT = el("div", "t", bountyCard), bountyS = el("div", "s", bountyCard);
  const huntedB = el("div", "kr-hunted kr-hide", root);
  let econSig = "", gainAt = 0;
  // ammo, TOP BANANA, the hotbar and the lethal chip: ui/hotbar.ts
  const hb = createHotbar(root), ammo = hb.ammo, hotbar = hb.hotbar;

  // kill feed
  // (Toon) top right is one column (nothing overlaps): the match stats chips, the ping / fps line, the kill feed
  const trCol = el("div", "tn-hud-tr", root);
  const stats = new MatchStats(trCol);
  const feed = el("div", "kr-feed", trCol);
  interface FeedRow { row: HTMLElement; killer: HTMLElement; wi: HTMLCanvasElement; hs: SVGSVGElement; myth: HTMLElement; victim: HTMLElement; key: string; weapon: string }
  const feedRows: FeedRow[] = [];
  for (let i = 0; i < FEED_MAX; i++) {
    const row = el("div", "row kr-hide", feed);
    const killer = el("b", "", row);
    const wi = el("canvas", "wi", row);
    const hs = svgGlyph("head", "hs", TOON.accent);
    row.appendChild(hs);
    const myth = el("i", "myth", row); myth.style.display = "none";
    const victim = el("b", "vic", row);
    feedRows.push({ row, killer, wi, hs, myth, victim, key: "", weapon: "" });
  }

  // announcements / elimination banner
  const announce = el("div", "kr-announce kr-hide", root);
  const annBand = el("div", "band", announce);
  const annTitle = el("div", "t", announce);
  const annSub = el("div", "s", announce);
  // the location banner: rules grow out from the title, the title settles from wide tracking
  const place = el("div", "kr-place kr-hide", root);
  const plRow = el("div", "row", place);
  const plRuleL = el("div", "rule l", plRow), plTitle = el("div", "t", plRow), plRuleR = el("div", "rule r", plRow);
  const plSub = el("div", "s", place);
  // the radio's station banner: the station name big, what is on air under it
  const radioB = el("div", "kr-radio kr-hide", root);
  const radioSt = el("div", "st", radioB);
  const radioNp = el("div", "np", radioB);
  const radioEq = el("span", "eq", radioNp); el("i", "", radioEq); el("i", "", radioEq); el("i", "", radioEq);
  const radioLn = el("span", "ln", radioNp);
  const elim = el("div", "kr-elim kr-hide", root);
  elim.appendChild(svgGlyph("skull", "sk", TOON.text));
  const elimTx = el("div", "tx", elim);
  const elimL1 = el("div", "l1", elimTx); elimL1.textContent = "ELIMINATED";
  const elimName = el("div", "l2", elimTx);
  const elimKc = el("div", "kc", elim);
  const elimKcN = el("span", "", elimKc);
  const elimKcL = el("small", "", elimKc);
  // a special kill's medals, in a row under the elimination banner (ui/medals.ts)
  const medals = new Medals(root);

  // squadmate world tags (trios): name + distance over each mate, clamped to the screen edge with an arrow
  const tagWrap = el("div", "kr-mtags", root);
  interface MTag { box: HTMLElement; lab: HTMLElement; nm: HTMLElement; d: HTMLElement; st: HTMLElement; arr: HTMLElement; key: string; on: boolean; lift: number }
  const tagPos = Array.from({ length: 3 }, () => ({ on: false, x: 0, y: 0, edge: false, ang: 0, lines: 2, lift: 0 }));
  const mtags: MTag[] = [];
  for (let i = 0; i < 3; i++) {
    const box = el("div", "kr-mtag kr-hide", tagWrap); box.style.setProperty("--c", SQUAD_COLOURS[i]);
    const arr = el("div", "arr", box); const pin = el("div", "pin", box); void pin;
    const lab = el("div", "lab", box);
    mtags.push({ box, lab, arr, nm: el("span", "nm", lab), d: el("span", "d", lab), st: el("span", "st", lab), key: "", on: false, lift: 0 });
  }

  // centre
  const centerWrap = el("div", "kr-center", root);
  const center = new CenterLayer();
  centerWrap.appendChild(center.canvas);
  const dmgEls: HTMLElement[] = [];
  for (let i = 0; i < DMG_POOL; i++) { const e = el("div", "kr-dmg kr-hide", root); dmgEls.push(e); }
  // the interact / loot card, the pickup chip, the use / reload label: ui/weapon-prompts.ts
  const prompts = createWeaponPrompts(root);

  // freefall / glide
  const air = el("div", "kr-air kr-hide", root);
  const airScale = el("div", "scale", air);
  const airFill = el("i", "", airScale);
  for (let i = 0; i <= 6; i++) { const t = el("div", "tk", air); t.style.top = `${(i / 6) * 100}%`; }
  const airMk = el("div", "mk", air);
  const airAlt = el("div", "alt", airMk);
  el("div", "tri", airMk);
  const airInfo = el("div", "info", air);
  const airMode = el("div", "mode", airInfo);
  const airSpd = el("div", "spd", airInfo);
  // aboard a tuk-tuk: speed · the cab from above with a dot + key per seat · hull in three tip-overs ·
  // the radio; the controls float above the panel for the first seconds in a seat (bottom centre)
  const veh = el("div", "kr-veh kr-hide", root);
  const vehHints = el("div", "hints", veh);
  /** the chip that fills while its key is held (the pilot's bail-out), or null */
  let vehFillEl: HTMLElement | null = null;
  const vehPnl = el("div", "pnl", veh);
  const vehSpd = el("div", "spd", vehPnl);
  const vehSpdN = el("b", "", vehSpd); vehSpdN.textContent = "0";
  el("small", "", vehSpd).textContent = "KM/H";
  el("span", "gear", vehSpd).textContent = "REVERSE";
  // a helicopter: height over the ground + climb arrow (beside the speed)
  const vehAlt = el("div", "spd alt kr-hide", vehPnl);
  const vehAltN = el("b", "", vehAlt);
  const vehAltL = el("small", "", vehAlt); vehAltL.textContent = "M";
  const vehCar = el("div", "car", vehPnl);
  // the cab from above, nose up — a tuk-tuk's tub, or KONG AIR's cabin under its rotor disc (pilot ahead, the door gun
  // on the left, the passenger on the right: the same three seat dots)
  const CAB_TUK = `<rect x="36" y="1" width="12" height="17" rx="4" fill="#15110a" stroke="rgba(251,243,201,.35)"/>
    <rect x="5" y="80" width="12" height="24" rx="4" fill="#15110a" stroke="rgba(251,243,201,.35)"/><rect x="67" y="80" width="12" height="24" rx="4" fill="#15110a" stroke="rgba(251,243,201,.35)"/>
    <path d="M42 9C57 9 63 24 63 38L66 92Q66 109 50 110H34Q18 109 18 92L21 38C21 24 27 9 42 9Z" fill="rgba(255,212,0,.13)" stroke="rgba(255,212,0,.75)" stroke-width="2.2"/>
    <path d="M26 58H58" stroke="rgba(251,243,201,.28)" stroke-width="2"/>`;
  const CAB_HELI = `<circle cx="42" cy="54" r="41" fill="none" stroke="rgba(251,243,201,.2)" stroke-width="1.5" stroke-dasharray="5 4"/>
    <rect x="39" y="100" width="6" height="18" rx="2" fill="rgba(255,212,0,.45)" stroke="rgba(255,212,0,.75)" stroke-width="1.2"/>
    <path d="M42 6C58 6 64 24 64 42L63 90Q62 104 50 106H34Q22 104 21 90L20 42C20 24 26 6 42 6Z" fill="rgba(255,212,0,.13)" stroke="rgba(255,212,0,.75)" stroke-width="2.2"/>
    <path d="M14 70h8M62 70h8" stroke="rgba(251,243,201,.35)" stroke-width="3" stroke-linecap="round"/>`;
  vehCar.innerHTML = `<svg viewBox="0 0 84 118"><g class="cab">${CAB_TUK}</g>
    <circle class="s" cx="42" cy="42" r="9"/><circle class="s" cx="31" cy="84" r="9"/><circle class="s" cx="53" cy="84" r="9"/></svg>`;
  const vehCab = vehCar.querySelector<SVGGElement>(".cab")!;
  const vehSeatEls = Array.from(vehCar.querySelectorAll<SVGCircleElement>(".s"));
  const vehKeys = [el("kbd", "", vehCar), el("kbd", "", vehCar), el("kbd", "", vehCar)];
  ([[24, 50], [24, 92], [146, 92]] as const).forEach(([x, y], i) => { vehKeys[i].style.left = `calc(${x} * var(--u))`; vehKeys[i].style.top = `calc(${y} * var(--u))`; });
  const vehSwap = el("div", "swap", vehCar);
  const vehSwapK = el("kbd", "tn-key", vehSwap); const vehSwapL = el("span", "", vehSwap); vehSwapL.textContent = "SWAP SEAT";
  const vehInfo = el("div", "info", vehPnl);
  const vehTop = el("div", "nm", vehInfo);
  const vehName = el("span", "", vehTop); vehName.textContent = "TUK-TUK";
  const vehPct = el("em", "", vehTop);
  const vehHull = el("div", "hull", vehInfo);
  const vehSegs = [0, 1, 2].map(() => el("b", "", el("i", "", vehHull)));
  const vehRadio = el("div", "radio off kr-hide", vehInfo);
  const vehEq = el("span", "eq", vehRadio); el("i", "", vehEq); el("i", "", vehEq); el("i", "", vehEq);
  const vehSt = el("span", "st", vehRadio);
  const vehRadioK = el("kbd", "tn-key", vehRadio);
  const hint = el("div", "kr-hint kr-hide", root);
  // swimming: the air meter: bottom third, centred, a slim outlined
  // Toon capsule in shield blue with an outlined bubble and an AIR label; it drains right to left as the breath runs out
  const swimAir = el("div", "kr-swimair kr-hide", root);
  el("i", "bub", swimAir);
  const swimFill = el("i", "fill", el("div", "bar", swimAir));
  el("span", "lb", swimAir).textContent = "AIR";
  // chute: SPACE prompt when a ledge fall would hurt; hold-to-cut bar while gliding (same slot under the crosshair)
  const chute = el("div", "kr-chute kr-hide", root);
  const chuteKey = el("div", "key", chute); chuteKey.textContent = keyName("jump");
  el("div", "lb", chute).textContent = "PULL CHUTE";
  const cut = el("div", "kr-cut kr-hide", root);
  el("div", "lb", cut).textContent = "CUTTING CHUTE";
  const cutFill = el("i", "", el("div", "bar", cut));

  // redeploy / spectate / net
  const redeploy = el("div", "kr-redeploy kr-hide", root);
  const rdL = el("div", "l", redeploy); rdL.textContent = "REDEPLOYING IN";
  const rdN = el("div", "n", redeploy);
  const rdS = el("div", "s", redeploy); rdS.textContent = "RESURGENCE · YOUR SQUAD KEEPS YOU IN THE FIGHT";
  const spectate = el("div", "kr-spectate kr-hide", root);
  spectate.appendChild(svgGlyph("eye", "eye", TOON.text));
  const specL = el("span", "l", spectate); specL.textContent = "SPECTATING";
  const specName = el("b", "", spectate);
  // the spectator bar + the player list (ui/spectate.ts); the plain pill above stays for a game that
  // sends no `spectate` view
  const specUi = new SpectateUi(root);
  const net = el("div", "kr-net", trCol);

  // (Toon) feedback: directional damage glows (under the panels), the confirmations under the crosshair, "Healing…"
  const feedback = new HudFeedback({ dmg: vigDmg, shield: vigShield, low: vigLow, heal: vigHeal, crack }, root, mmWrap, root, vitals);
  // enemy hit numbers: the shield / cracked-shield icon, then the number
  for (const e of dmgEls) { el("i", "ic", e); el("span", "n", e); }
  const dmgNum = (e: HTMLElement) => e.lastElementChild as HTMLElement;
  /** a hit number's kind: shield hits wear the shield icon, the breaking hit the cracked shield (it pops in) */
  const dmgKind = (e: HTMLElement, kind: DmgGroup["kind"], pred: boolean) => {
    const cls = `kr-dmg ${kind}${pred ? " pred" : ""}`;
    if (e.className === cls) return;
    const broke = kind === "break" && !e.classList.contains("break");
    e.className = cls;
    if (broke && !calm()) (e.firstElementChild as HTMLElement).animate([{ transform: "scale(0.4) rotate(-12deg)" }, { transform: "scale(1.25) rotate(6deg)", offset: 0.6 }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(.3,1.6,.5,1)" });
  };
  // canvases painted before the Toon fonts arrived repaint once they have
  void toonFontsReady().then(() => { last.heading = 1e9; minimap.invalidate(); });

  // full-screen map
  const big = new BigMap(map, pois);
  root.appendChild(big.el);

  // ---------------------------------------------------------------- state
  let u = 0, hudScale = 0, dpr = 1, vw = 0, vh = 0, now = 0, mapOpen = false, visible = true;
  const last = {
    alive: -1, timerS: -1, shrink: false, urgent: false, sub: "", warn: "", ping: -1, fps: -1,
    feedSig: "", scoped: false, scopeW: 0, scopeH: 0,
    airOn: false, airAlt: -1, airSpd: -1, airMode: "",
    hint: "", swimAir: -2, chuteOn: false, cutV: -1, specOn: false, spec: "", rdOn: false, rdN: "", heading: 1e9, compMarks: "", zoom: "", breath: -1,
    annAt: NaN as number, annStart: -99, annOn: false, placeAt: NaN as number, placeStart: -99, placeOn: false, radioAt: NaN as number, radioStart: -99, radioOn: false, radioLife: 4, elimStart: -99, elimOn: false, where: "",
    hp: -1, sh: -1, dmgFlash: 0, shieldFlash: 0, healFlash: 0, vigLow: -1, vigDmg: -1, vigStorm: -1, vigShield: -1, vigHeal: -1,
    vehOn: false, vehHull: -1, vehSpd: -1, vehSeat: -1, vehSeats: -1, vehCls: "", vehHint: "", vehRev: false, vehKeys: "", vehRadio: "", vehFade: false, vehKind: -1, vehAlt: "", vehFill: -1,
  };
  const feedSeen = new Set<number>();
  const trBox: [number, number] = [1e9, -1]; let trBoxAt = -9;
  let subSeen = "\0", subAt = 0;
  let myKills = 0;
  let vitAlive = false;
  interface DmgGroup { key: string; target: number | undefined; total: number; kind: keyof typeof KIND_RANK; start: number; lastAdd: number; sx: number; sy: number; el: HTMLElement; drift: number; amts: Map<number, number>; pred: boolean }
  const groups: DmgGroup[] = [];
  /** HUD panel rects (px) the damage numbers keep out of, and when they were read */
  const panels: Array<[number, number, number, number]> = []; let panelsAt = -9;
  const freeDmg = dmgEls.slice();

  function resize() {
    const h = window.innerHeight, w = window.innerWidth, d = Math.min(2, window.devicePixelRatio || 1);
    if (h === vh && w === vw && d === dpr && hudScale === preferences.value.hudScale) return;
    vh = h; vw = w; dpr = d; hudScale = preferences.value.hudScale; u = hudUnit(w, h, hudScale);   // = the CSS --u (styles.ts)
    const tu = u * 1440 / 1080;                                                                     // = the Toon --tu (design px)
    minimap.resize(Math.round(254 * tu * d));                                                       // the frame's inner width
    compCanvas.width = Math.round(CW * tu * d);
    compCanvas.height = Math.round(CH * tu * d);
    last.heading = 1e9;
    center.resize(Math.round(800 * u * d));
    for (const r of feedRows) { r.wi.width = Math.round(44 * tu * d); r.wi.height = Math.round(22 * tu * d); r.weapon = ""; }
    last.scopeW = 0;
  }

  // a rebind (SETTINGS → CONTROLS) or picking up the other device shows at once in every prompt
  onLabelsChange(() => {
    chuteKey.textContent = keyName("jump");
    last.hint = ""; last.breath = -2; last.sub = ""; last.warn = ""; last.swimAir = -2;
  });
  preferences.subscribe(() => resize());   // HUD size

  // ---------------------------------------------------------------- compass
  /** "85 m" / "1.2 km" from me to a map marker */
  function markDist(me: { x: number; z: number }, m: { x: number; z: number }) { const d = Math.hypot(m.x - me.x, m.z - me.z); return d < 995 ? `${Math.round(d / 5) * 5} m` : `${(d / 1000).toFixed(1)} km`; }
  function drawCompass(s: HudState) {
    const heading = ((360 - (s.yaw * 180) / Math.PI) % 360 + 360) % 360;
    // bearings of markers (drop marker, squad) — only rebuild the signature when there are any
    let marks = "";
    if (s.dropMarker) marks += `d${Math.round(bearing(s.me.x, s.me.z, s.dropMarker.x, s.dropMarker.z))}:${markDist(s.me, s.dropMarker)};`;
    if (s.econ?.bounty) marks += `b${Math.round(bearing(s.me.x, s.me.z, s.econ.bounty.x, s.econ.bounty.z))};`;
    for (const q of s.squad) if (!q.me) marks += `q${Math.round(bearing(s.me.x, s.me.z, q.x, q.z))};`;
    if (s.squadMarks) for (const q of s.squadMarks) marks += `m${Math.round(bearing(s.me.x, s.me.z, q.x, q.z))}${q.color};`;
    if (Math.abs(heading - last.heading) < 0.03 && marks === last.compMarks) return;
    last.heading = heading; last.compMarks = marks;
    // design px (760 wide, 5.4 px per degree, a label every 15°): the centre mark on top, the labels
    // on y 28, the markers under the scale (y 44..58)
    const g = compCtx, W = compCanvas.width, k = W / CW, CXc = CW / 2, LY = 28, EDGE = CW / 2 - 14;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.clearRect(0, 0, CW, CH);
    g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round";
    const base = Math.floor(heading / 15) * 15;
    for (let i = -6; i <= 7; i++) {
      const degRaw = base + i * 15;
      const x = CXc + (degRaw - heading) * PXD;
      if (Math.abs(x - CXc) > CXc + 20) continue;
      const deg = ((degRaw % 360) + 360) % 360;
      const card = CARDS[deg];
      if (card) {
        // Lilita with a 2 px outline (a 4 px stroke behind the fill) and a soft shadow
        g.font = `400 28px ${TOON.display}`;
        g.shadowColor = "rgba(4,16,26,0.6)"; g.shadowBlur = 4; g.shadowOffsetY = 1;
        g.lineWidth = 4; g.strokeStyle = TOON.outline; g.strokeText(card, x, LY + 1);
        g.shadowBlur = 0; g.shadowOffsetY = 0;
        g.fillStyle = TOON.text; g.fillText(card, x, LY + 1);
      } else {
        // (a thin dark edge as well as the soft shadow: the degrees stay legible over cloud and sand)
        g.font = `900 15px ${TOON.ui}`;
        g.lineWidth = 3; g.strokeStyle = "rgba(4,16,26,0.55)"; g.strokeText(String(deg), x, LY);
        g.shadowColor = "rgba(4,16,26,0.75)"; g.shadowBlur = 4; g.shadowOffsetY = 1;
        g.fillStyle = TOON.text; g.globalAlpha = 0.9; g.fillText(String(deg), x, LY);
        g.globalAlpha = 1; g.shadowBlur = 0; g.shadowOffsetY = 0;
      }
    }
    // markers under the scale: outlined triangles (pins) and dots (squadmates)
    const mark = (b: number, col: string, tri: boolean) => {
      let d = b - heading; d = ((d + 540) % 360) - 180;
      const x = CXc + Math.max(-EDGE, Math.min(EDGE, d * PXD));
      g.fillStyle = col; g.strokeStyle = TOON.outline; g.lineWidth = 2.5;
      g.beginPath();
      if (tri) { g.moveTo(x, 57); g.lineTo(x - 7, 45); g.lineTo(x + 7, 45); g.closePath(); }
      else g.arc(x, 51, 5, 0, Math.PI * 2);
      g.stroke(); g.fill();
    };
    if (s.squadMarks) for (const q of s.squadMarks) mark(bearing(s.me.x, s.me.z, q.x, q.z), q.color, true);
    if (s.dropMarker) {
      // the marker's distance beside its pin
      const b = bearing(s.me.x, s.me.z, s.dropMarker.x, s.dropMarker.z); mark(b, TOON.accent, true);
      let d = b - heading; d = ((d + 540) % 360) - 180;
      const x = CXc + Math.max(-EDGE, Math.min(EDGE, d * PXD)), right = d * PXD > EDGE - 60;
      g.font = `900 13px ${TOON.ui}`; g.textAlign = right ? "right" : "left";
      g.lineWidth = 4; g.strokeStyle = TOON.outline; g.strokeText(markDist(s.me, s.dropMarker), right ? x - 11 : x + 11, 51);
      g.fillStyle = TOON.accent; g.fillText(markDist(s.me, s.dropMarker), right ? x - 11 : x + 11, 51);
      g.textAlign = "center";
    }
    if (s.econ?.bounty) mark(bearing(s.me.x, s.me.z, s.econ.bounty.x, s.econ.bounty.z), TOON.danger, true);   // (economy) the bounty
    let si = 0;
    for (const q of s.squad) if (!q.me) mark(bearing(s.me.x, s.me.z, q.x, q.z), SQUAD_COLOURS[si++ % SQUAD_COLOURS.length], false);
    // centre mark (2 × 12 on top)
    g.fillStyle = TOON.text;
    g.shadowColor = "rgba(4,16,26,0.6)"; g.shadowBlur = 2;
    g.fillRect(CXc - 1, 0, 2, 12);
    g.shadowBlur = 0;
  }

  // ---------------------------------------------------------------- vitals bar animation (chip + heal fill)
  // (Toon) each layer is a full-width capsule slid left, so a part-filled bar keeps its round end (transform only)
  const bx = (v: number) => `translateX(${((v - 1) * 100).toFixed(2)}%)`;
  function barStep(r: typeof hpR, value: number, dt: number) {
    const v = Math.max(0, Math.min(1, value / 100));
    if (r.v < 0) { r.v = v; r.fillV = v; r.chipV = v; r.fill.style.transform = bx(v); r.chip.style.transform = bx(v); r.gain.style.transform = bx(0); return; }
    // a loss ends any refill in progress (its preview would stay behind the fill otherwise)
    if (v < r.v - 1e-4) { r.fillV = v; r.hold = 0.35; r.fill.style.transform = bx(v); r.gain.style.transform = bx(0); }
    else if (v > r.v + 1e-4) { r.hold = 0; r.gain.style.transform = bx(v); }
    r.v = v;
    let changed = false;
    if (r.fillV < v - 1e-4) { r.fillV = Math.min(v, r.fillV + dt * 0.9); changed = true; if (r.fillV >= v - 1e-4) r.gain.style.transform = bx(0); }
    if (r.hold > 0) r.hold -= dt;
    else if (r.chipV > r.fillV + 1e-4) { r.chipV = Math.max(r.fillV, r.chipV - dt * 0.9); r.chip.style.transform = bx(r.chipV); }
    if (r.chipV < r.fillV) { r.chipV = r.fillV; r.chip.style.transform = bx(r.chipV); }
    if (changed) r.fill.style.transform = bx(r.fillV);
    const n = Math.ceil(value);
    if (n !== r.n) { r.n = n; r.num.textContent = String(Math.max(0, n)); }
  }

  // ---------------------------------------------------------------- update
  function update(s: HudState, dt: number) {
    now += dt;
    if (!visible) return;
    resize();
    const alive = s.me.alive && s.hp > 0;

    // ---- hands: hotbar, ammo and reload / use prompts only on a live kong's own feet; no crosshair riding the plane,
    // dead or spectating
    const handsVisible = alive && !s.spectating && (s.handsVisible ?? (s.phase !== "plane" && s.phase !== "drop"));
    centerWrap.classList.toggle("kr-hide", s.phase === "plane" || !!s.spectating || !s.me.alive);

    // ---- pill
    if (s.alive !== last.alive) { last.alive = s.alive; pillAlive.textContent = String(s.alive); }
    const timerS = Math.floor(Math.max(0, s.stormTimer));
    if (timerS !== last.timerS) { last.timerS = timerS; pillTime.textContent = fmtClock(timerS); }
    if (s.stormShrinking !== last.shrink) {
      last.shrink = s.stormShrinking;
      tog(pill, "shrink", s.stormShrinking);
      clockIc.style.display = s.stormShrinking ? "none" : ""; stormIc.style.display = s.stormShrinking ? "" : "none";
    }
    const urgent = !s.stormShrinking && s.stormPhase > 0 && s.stormTimer < 10 && s.phase === "play";
    if (urgent !== last.urgent) { last.urgent = urgent; tog(pill, "urgent", urgent); }
    txt(clockLabel, s.clockLabel ?? (s.phase === "warmup" ? "PLANE DEPARTS" : s.stormShrinking ? "STORM SHRINKING" : "STORM CLOSES"));
    // the status line under the compass (and the storm clock); in the storm: which way and how far the safe edge is
    pill.classList.toggle("kr-hide", !!s.range);
    const guide = safeEdgeGuide(s.me, s.safe, s.yaw);
    const toward = Math.abs(guide.bearing) < Math.PI / 4 ? "↑ AHEAD" : Math.abs(guide.bearing) > Math.PI * 3 / 4 ? "↓ TURN BACK" : guide.bearing > 0 ? "← LEFT" : "→ RIGHT";
    // (Toon) the rack's key is a keycap row on the practice panel now (game/range.ts)
    // the plain status stays under the compass (it fades 5 s after it last changed); the storm and
    // resurgence warnings sit under the storm clock in the left column and stay
    const sub = s.range ? "FIRING RANGE · INFINITE AMMO"
      : s.phase === "warmup" ? (s.islandLoad !== undefined ? `WARM-UP · LOADING ISLAND ${Math.floor(s.islandLoad * 20) * 5} %` : "WARM-UP · NOTHING COUNTS YET") : "";
    const warn = s.range || s.phase === "warmup" ? ""
      : s.inStorm && alive ? `storm:${toward} · ${Math.ceil(guide.distance)} M TO SAFE EDGE`
      : s.resurgence.final && s.phase === "play" ? "final:RESURGENCE OFF · KILLS ARE FINAL"
      : s.stormShrinking && s.phase === "play" ? "storm:STORM CLOSING" : "";
    if (sub !== last.sub) { last.sub = sub; tog(substat, "kr-hide", !sub); if (sub) substat.textContent = sub; }
    if (warn !== last.warn) {
      last.warn = warn;
      if (warn) { const i = warn.indexOf(":"); warnEl.className = `tn-hud-warn ${warn.slice(0, i)}`; warnEl.textContent = warn.slice(i + 1); }
      else warnEl.className = "tn-hud-warn kr-hide";
    }
    // live event pills (UAV Radar Pulse, Fire Sale)
    { const ul = alive && s.uav && s.uav.left > 0.05 ? `UAV RADAR · ${Math.ceil(s.uav.left)}S · ${s.uav.enemies.length} NEAR` : "";
      if (ul !== uavSig) { uavSig = ul; tog(uavPill, "kr-hide", !ul); if (ul) uavTx.textContent = ul; }
      const sl = (s.fireSaleLeft ?? 0) > 0.05 ? `FIRE SALE · 50% OFF · ${fmtClock(Math.ceil(s.fireSaleLeft!))}` : "";
      if (sl !== saleSig) { saleSig = sl; tog(salePill, "kr-hide", !sl); if (sl) saleTx.textContent = sl; } }
    if (sub !== subSeen) { subSeen = sub; subAt = now; }
    tog(substat, "faded", !!sub && now - subAt > 5);
    stats.update(s, calm());

    // ---- vitals + full-screen feedback (ui/hud-feedback.ts: damage red, healing blue)
    const hpWas = hpR.v, shWas = shR.v;
    barStep(hpR, s.hp, dt);
    barStep(shR, s.shield, dt);
    // green glow on the health bar while health goes up, blue on the shield bar while shield does:
    // from a real gain while alive (not a respawn refill) and for the whole time a heal / shield item is being used
    {
      if (vitAlive && alive && hpWas >= 0 && hpR.v > hpWas + 1e-3) hpR.glowUntil = now + 1.1;
      if (vitAlive && alive && shWas >= 0 && shR.v > shWas + 1e-3) shR.glowUntil = now + 1.1;
      const slot = s.hotbar[s.activeSlot];
      const def = alive && s.using && slot && slot.kind === "consumable" && CONSUMABLES.includes(slot.id as ConsumableId) ? CONSUMABLE_DEFS[slot.id as ConsumableId] : null;
      const hg = alive && (now < hpR.glowUntil || (!!def && def.hp > 0 && s.hp < 100));
      const sg = alive && (now < shR.glowUntil || (!!def && def.shield > 0 && s.shield < 100));
      if (hg !== hpR.glow) { hpR.glow = hg; tog(hpR.row, "glowing", hg); }
      if (sg !== shR.glow) { shR.glow = sg; tog(shR.row, "glowing", sg); }
      vitAlive = alive;
    }
    tog(hpR.row, "low", s.hp > 0 && s.hp <= 30);
    tog(shR.row, "empty", s.shield <= 0);
    const refilling = hpR.fillV < hpR.v - 1e-4 || shR.fillV < shR.v - 1e-4;
    const confirmLow = feedback.update(s, dt, now, calm(), refilling, last.elimOn);
    setOp(vigStorm, "vigStorm", s.inStorm && alive ? (calm() ? 0.35 : 0.45 + 0.06 * Math.sin(now * 2.2)) : 0);

    // ---- squad (trios)
    let mi = 0;
    for (const q of s.squad) {
      if (q.me || mi >= 3) continue;
      const r = mateRows[mi++];
      const state = !q.alive ? (q.redeploy != null ? "redeploy" : "dead") : q.downed ? "down" : "ok";
      const key = `${q.name}|${state}|${Math.ceil(q.redeploy ?? 0)}|${Math.round(q.hp)}|${Math.round(q.shield)}`;
      if (key === r.key) continue;
      r.key = key;
      r.box.className = `m ${state}`;
      txt(r.nm, q.name);
      txt(r.st, state === "down" ? "DOWNED" : state === "redeploy" ? `REDEPLOY ${Math.ceil(q.redeploy ?? 0)}` : state === "dead" ? "ELIMINATED" : "");
      r.hp.style.transform = bx(Math.max(0, Math.min(1, q.hp / 100)));
      r.sh.style.transform = bx(Math.max(0, Math.min(1, q.shield / 100)));
    }
    for (let i = mi; i < 3; i++) if (mateRows[i].key !== "") { mateRows[i].key = ""; mateRows[i].box.className = "m kr-hide"; }

    // ---- squadmate world tags: through walls, clamped to an inset frame at the screen edge (arrow → where they are)
    const ms = s.mates ?? EMPTY_MATES;
    // the top-right column's left edge and bottom (px), read at most once a second while tags are up
    if (ms.length && now - trBoxAt > 1) { trBoxAt = now; const r = trCol.getBoundingClientRect(); trBox[0] = r.left - 16 * u; trBox[1] = r.bottom + 70 * u; }
    // positions first (screen, clamped to the inset frame at the edge), then de-overlap: two mates close together on
    // screen stack their labels instead of printing over each other
    for (let i = 0; i < 3; i++) {
      const t = mtags[i], m = ms[i], P = tagPos[i];
      P.on = !!m && !s.scoped && mapOpen === false; P.lift = 0;
      if (!P.on || !m) continue;
      let x = m.sx * vw, y = m.sy * vh, edge = m.edge;
      // (Toon) the left inset clears the minimap / squad column, the top one the compass / storm clock / status line,
      // and a tag that would land beside the top-right column (stats, kill feed) keeps clear of it too
      const tu = u * 1440 / 1080, mx = vw * 0.07, mxL = Math.max(mx, 330 * tu), myT = Math.max(vh * 0.2, 300 * tu), myB = vh * 0.25;
      if (!edge && (x < mxL || x > vw - mx || y < myT || y > vh - myB)) edge = true;
      let ang = 0;
      if (edge) {
        // walk from the screen centre toward the point until the inset frame
        const cx = vw / 2, cy = vh / 2, dx = x - cx, dy = y - cy, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
        const walk = (r: number) => { const kx = ux > 0 ? (vw - r - cx) / ux : ux < 0 ? (mxL - cx) / ux : 1e9, ky = uy > 0 ? (vh - myB - cy) / uy : uy < 0 ? (myT - cy) / uy : 1e9; return Math.min(kx, ky); };
        let k = walk(mx);
        if (ux > 0 && cx + ux * k > trBox[0] && cy + uy * k < trBox[1]) k = walk(vw - trBox[0]);
        x = cx + ux * k; y = cy + uy * k; ang = Math.atan2(uy, ux);
      }
      P.x = x; P.y = y; P.edge = edge; P.ang = ang; P.lines = m.state === "air" || m.state === "redeploy" ? 3 : 2;
      void t;
    }
    {
      const W = 250 * u, LH = 25 * u;                                    // label box ≈ 250 px wide, 25 px per line (1440p)
      for (let i = 0; i < 3; i++) for (let j = 0; j < i; j++) {
        const a = tagPos[j], b = tagPos[i];
        if (!a.on || !b.on) continue;
        const ay = a.y - a.lift, by = b.y - b.lift, need = (b.y <= a.y ? a.lines : b.lines) * LH + 6 * u;   // the LOWER tag's label height
        if (Math.abs(a.x - b.x) < W && Math.abs(ay - by) < need) {
          // lift whichever is higher on screen above the other's label
          if (b.y <= a.y) b.lift += need - (ay - by); else a.lift += need - (by - ay);
        }
      }
    }
    for (let i = 0; i < 3; i++) {
      const t = mtags[i], m = ms[i], P = tagPos[i];
      const on = P.on;
      if (on !== t.on) { t.on = on; t.box.classList.toggle("kr-hide", !on); }
      if (!on || !m) continue;
      const x = P.x, y = P.y, edge = P.edge, ang = P.ang;
      t.box.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      const lift = Math.round(P.lift);
      if (lift !== t.lift) { t.lift = lift; t.lab.style.marginBottom = lift ? `${lift}px` : ""; }
      const key = `${m.name}|${m.state}|${Math.round(m.dist)}|${edge ? Math.round(ang * 20) : "x"}`;
      if (key === t.key) continue;
      t.key = key;
      t.box.className = `kr-mtag ${m.state}${edge ? " edge" : ""}`;
      txt(t.nm, m.name); txt(t.d, `${Math.round(m.dist)} M`);
      txt(t.st, m.state === "redeploy" ? "REDEPLOYING" : m.state === "air" ? "IN THE AIR" : "");
      t.arr.style.transform = `rotate(${ang.toFixed(3)}rad)`;
    }

    // ---- the weapons parts: ammo, TOP BANANA, hotbar, lethal chip (ui/hotbar.ts) · the interact / loot card, the
    // pickup chip, the use / reload label (ui/weapon-prompts.ts)
    const wf = { now, u, vw, vh, alive, handsVisible };
    hb.update(s, wf); prompts.update(s, wf);

    // ---- kill feed (newest on top)
    let fsig = "";
    for (let i = 0; i < s.killfeed.length; i++) fsig += s.killfeed[i].at + ",";
    for (const k of s.killfeed) if (k.meKiller && !feedSeen.has(k.at)) { feedSeen.add(k.at); if (!k.meVictim) myKills++; }
    if (fsig !== last.feedSig) {
      last.feedSig = fsig;
      for (let i = 0; i < FEED_MAX; i++) {
        const fr = feedRows[i];
        const k = s.killfeed[s.killfeed.length - 1 - i];
        if (!k) { if (fr.key !== "") { fr.key = ""; fr.row.classList.add("kr-hide"); } continue; }
        const key = `${k.at}`;
        if (key === fr.key) continue;
        fr.key = key;
        // plain stroked text, no card: you or a squadmate going down → that name red; you or a
        // squadmate taking someone out → the killer's name green
        const ours = (name: string, me: boolean) => me || (!!name && s.squad.some((q) => !q.me && q.name === name));
        const vOurs = ours(k.victim, k.meVictim), kOurs = !!k.killer && ours(k.killer, k.meKiller) && !vOurs;
        fr.row.className = "row";
        fr.killer.textContent = k.killer || "";
        fr.killer.className = kOurs ? "ours" : "";
        fr.killer.style.display = k.killer ? "" : "none";
        fr.victim.textContent = k.victim;
        fr.victim.className = `vic${vOurs ? " ours" : ""}${k.final === false ? " knock" : ""}`;
        fr.hs.style.display = k.head ? "" : "none";
        if (k.mythic) { fr.myth.textContent = k.mythic.name; fr.myth.style.setProperty("--m", k.mythic.color); fr.myth.style.display = ""; } else fr.myth.style.display = "none";
        if (fr.weapon !== k.weapon) {
          const sil = weaponSilhouette(k.weapon, fr.wi.width, fr.wi.height);
          const g = fr.wi.getContext("2d")!;
          g.clearRect(0, 0, fr.wi.width, fr.wi.height);
          if (sil) { g.drawImage(sil, 0, 0); fr.weapon = k.weapon; }
          else fr.weapon = "";   // art still loading → retry on the next change
        }
        if (!calm()) fr.row.animate([{ transform: "translateX(24px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
    }

    // ---- announcements (kill-kind "ELIMINATED <name>" becomes the elimination banner)
    const an = s.announce;
    if (an && an.at !== last.annAt) {
      last.annAt = an.at;
      if (an.kind === "kill" && /^ELIMINATED\s+\S/.test(an.title)) {
        elimName.textContent = an.title.replace(/^ELIMINATED\s+/, "");
        // warm-up kills do not count: the banner says so instead of counting them up
        const kills = s.kills ?? Math.max(1, myKills);
        elimKcN.textContent = s.phase === "warmup" ? "" : String(kills);
        elimKcL.textContent = s.range ? "FIRING RANGE" : s.phase === "warmup" ? "WARM-UP" : kills === 1 ? "KILL" : "KILLS";
        last.elimStart = now;
        elim.classList.remove("kr-hide"); last.elimOn = true;
        if (!calm()) elim.animate([{ transform: "translate(-50%, 18px) scale(0.92)", opacity: 0 }, { transform: "translate(-50%, 0) scale(1.04)", opacity: 1, offset: 0.55 }, { transform: "translate(-50%, 0) scale(1)", opacity: 1 }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
      } else {
        annTitle.textContent = an.title;
        setMoney(annSub, an.sub ?? "");
        annSub.style.display = an.sub ? "" : "none";
        announce.className = `kr-announce ${an.kind}`;
        last.annStart = now; last.annOn = true;
        if (!calm()) annBand.animate([{ transform: "scaleX(0.2)", opacity: 0 }, { transform: "scaleX(1)", opacity: 1 }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
        if (!calm()) annTitle.animate([{ transform: "scale(0.6)", opacity: 0 }, { transform: "scale(1.08)", opacity: 1, offset: 0.6 }, { transform: "none", opacity: 1 }], { duration: 360, easing: TOON.spring });
        if (!calm()) annSub.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 0, offset: 0.4 }, { opacity: 1, transform: "none" }], { duration: 420, easing: "ease-out" });
      }
    }
    medals.update(s.accolades, now, calm());
    // ---- the place you are in, by the minimap: on every arrival it lights up; the first arrival in a match
    // hands over from the centre title (the plate comes in as the title fades)
    // (Toon) the mode label under the minimap: WARM-UP / TRIOS / SOLO, then where you are (the range: game/range.ts's)
    const wh = s.where ?? "";
    const whEb = s.phase === "warmup" ? "Warm-up" : s.mode === "trios" ? "Trios" : "Solo";
    const whSub = wh || (s.phase === "warmup" ? (s.mode === "trios" ? "Trios" : "Solo") : "");
    if (!!s.range !== whereRange) { whereRange = !!s.range; tog(whereEl, "kr-hide", whereRange); }
    if (whEb !== whereEbV) { whereEbV = whEb; whereEb.textContent = whEb; }
    if (whSub !== whereSubV) { whereSubV = whSub; whereTx.textContent = whSub; }
    if (wh !== last.where) last.where = wh;
    const pl = s.place;
    if (pl && pl.at !== last.placeAt && wh && !calm()) {
      const first = pl.first !== false;
      wherePlate.animate([{ transform: "translateY(-30%) scale(1.25)", opacity: 0 }, { transform: "scale(1.06)", opacity: 1, offset: 0.6 }, { transform: "none", opacity: 1 }],
        { duration: first ? 520 : 420, delay: first ? 2900 : 0, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
    }
    // ---- location banner (3.6 s: in 0.5 s, hold, out 0.6 s) — only the first arrival at a place this match
    if (pl && pl.at !== last.placeAt && pl.first === false) last.placeAt = pl.at;
    if (pl && pl.at !== last.placeAt) {
      last.placeAt = pl.at; last.placeStart = now; last.placeOn = true;
      plTitle.textContent = pl.name; plSub.textContent = pl.sub; plSub.style.display = pl.sub ? "" : "none";
      place.classList.remove("kr-hide"); place.style.opacity = "";
      if (!calm()) {
        const ez = "cubic-bezier(.16,.9,.24,1)";
        plTitle.animate([{ transform: "scale(0.6)", opacity: 0 }, { transform: "scale(1.08)", opacity: 1, offset: 0.6 }, { transform: "none", opacity: 1 }], { duration: 520, easing: TOON.spring });
        for (const r of [plRuleL, plRuleR]) r.animate([{ transform: "scaleX(0)", opacity: 0 }, { transform: "scaleX(0)", opacity: 0, offset: 0.35 }, { transform: "scaleX(1)", opacity: 1 }], { duration: 700, easing: ez });
        plSub.animate([{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 0, offset: 0.5 }, { opacity: 1, transform: "none" }], { duration: 800, easing: "ease-out" });
      }
    }
    if (last.placeOn) {
      const age = now - last.placeStart;
      // a storm / knock / elimination banner takes the stage: the location title gives way at once ((Toon) to any banner
      // on screen, also one that was already up when you arrived — they share the slot)
      if (!pl || age > 3.6 || last.annOn) { last.placeOn = false; place.classList.add("kr-hide"); place.style.opacity = ""; }
      else if (age > 3.0) place.style.opacity = String(1 - (age - 3.0) / 0.6);
    }
    // ---- the radio's station banner: in 0.3 s, hold, out over the last 0.6 s (4 s tuned in, 3 s a new song);
    // it gives way to the location title and any announcement, and leaves with the tuk-tuk
    const rb = s.radio;
    if (rb && rb.at !== last.radioAt) {
      last.radioAt = rb.at; last.radioStart = now; last.radioOn = true; last.radioLife = rb.big ? 4 : 3;
      radioSt.textContent = rb.station; radioLn.textContent = rb.line; tog(radioNp, "kr-hide", !rb.line);
      radioB.className = `kr-radio ${rb.big ? "big" : "small"} ${rb.kind}`; radioB.style.opacity = "";
      if (!calm()) {
        radioSt.animate([{ transform: "translateX(-14%) scale(0.8)", opacity: 0 }, { transform: "scale(1.06)", opacity: 1, offset: 0.6 }, { transform: "none", opacity: 1 }], { duration: 420, easing: TOON.spring });
        radioNp.animate([{ opacity: 0, transform: "translateY(-5px)" }, { opacity: 0, offset: 0.45 }, { opacity: 1, transform: "none" }], { duration: 650, easing: "ease-out" });
      }
    }
    if (last.radioOn) {
      const age = now - last.radioStart;
      if (!rb || !s.vehicle || age > last.radioLife || last.placeOn || (last.annOn && last.annStart > last.radioStart - 4)) { last.radioOn = false; radioB.classList.add("kr-hide"); radioB.style.opacity = ""; }
      else if (age > last.radioLife - 0.6) radioB.style.opacity = String((last.radioLife - age) / 0.6);
    }
    // the game cleared the banner (e.g. the results card opened): drop it now
    if (last.annOn && !an) { last.annOn = false; announce.classList.add("kr-hide"); announce.style.opacity = ""; }
    if (last.annOn) {
      const age = now - last.annStart;
      if (age > 3.9) { last.annOn = false; announce.classList.add("kr-hide"); announce.style.opacity = ""; }
      else if (age > 3.5) announce.style.opacity = String(1 - (age - 3.5) / 0.4);
      else if (announce.classList.contains("kr-hide") || announce.style.opacity !== "") { announce.classList.remove("kr-hide"); announce.style.opacity = ""; }
    }
    tog(elim, "low", confirmLow); tog(medals.el, "low", confirmLow);
    if (last.elimOn) {
      const age = now - last.elimStart;
      if (age > 3) { last.elimOn = false; elim.classList.add("kr-hide"); elim.style.opacity = ""; }
      else if (age > 2.6) elim.style.opacity = String(1 - (age - 2.6) / 0.4);
    }

    // ---- "PICKED UP · X" for 1.5 s (with the hands HUD)
    { const E = s.econ;
      const sig = E ? `${E.cash}|${E.bounty ? `${E.bounty.name}|${E.bounty.left}` : ""}|${E.hunted}` : "";
      if (sig !== econSig) {
        econSig = sig; tog(cashChip, "kr-hide", !E); tog(bountyCard, "kr-hide", !E?.bounty); tog(huntedB, "kr-hide", !E?.hunted);
        if (E) {
          // Banana Bucks wear the banana coin, never a "$" (ui/bucks.ts)
          cashV.textContent = E.cash.toLocaleString("en-US");
          if (E.bounty) { bountyT.textContent = `BOUNTY · ${E.bounty.name}`; setMoney(bountyS, `${E.bounty.left}s · RED CIRCLE ON YOUR MAP · $1,500 EACH`); }
          if (E.hunted) huntedB.textContent = `YOU HAVE A BOUNTY · ${E.hunted}s`;
        }
      }
      if (E?.gain && E.gain.at !== gainAt) { gainAt = E.gain.at; setMoney(cashGain, `+$${E.gain.amount.toLocaleString("en-US")}`); cashGain.classList.remove("pop"); void cashGain.offsetWidth; cashGain.classList.add("pop"); } }

    // ---- aboard a tuk-tuk
    const vehOn = !!s.vehicle;
    if (vehOn !== last.vehOn) { last.vehOn = vehOn; veh.classList.toggle("kr-hide", !vehOn); }
    if (s.vehicle) {
      const V = s.vehicle, hull = Math.max(0, Math.min(100, Math.round(V.hull * 100))), spd = Math.round(Math.abs(V.speed) * 3.6);
      if (hull !== last.vehHull) {
        last.vehHull = hull; vehPct.textContent = `${hull}%`;
        // three segments: each one is a tip-over's worth of hull (TUK.TIP_DMG 200 of 600)
        vehSegs.forEach((b, i) => { b.style.transform = `scaleX(${Math.max(0, Math.min(1, V.hull * 3 - i))})`; });
      }
      if (spd !== last.vehSpd) { last.vehSpd = spd; vehSpdN.textContent = String(spd); }
      const rev = V.speed < -0.5;
      if (rev !== last.vehRev) { last.vehRev = rev; veh.classList.toggle("rev", rev); }
      const cls = V.burning ? "fire" : hull < 34 ? "low" : hull < 67 ? "mid" : "";
      if (V.kind !== last.vehKind) { last.vehKind = V.kind; vehCab.innerHTML = V.kind === 1 ? CAB_HELI : CAB_TUK; vehAlt.classList.toggle("kr-hide", V.kind !== 1); last.vehCls = "\0"; }
      if (cls !== last.vehCls) { last.vehCls = cls; veh.classList.toggle("fire", cls === "fire"); veh.classList.toggle("low", cls === "low"); veh.classList.toggle("mid", cls === "mid"); vehName.textContent = cls === "fire" ? (V.kind === 1 ? "ENGINE FIRE — BAIL OUT" : "ON FIRE — BAIL OUT") : V.kind === 1 ? "KONG AIR" : "TUK-TUK"; }
      if (V.kind === 1) {
        const climb = V.climb ?? 0, altTxt = `${Math.round(V.alt ?? 0)}|${climb > 0.6 ? "▲" : climb < -0.6 ? "▼" : ""}${(V.spool ?? 1) < 0.8 ? " SPOOL" : ""}`;
        if (altTxt !== last.vehAlt) { last.vehAlt = altTxt; const [a, b] = altTxt.split("|"); vehAltN.textContent = a; vehAltL.textContent = `M ${b}`.trim(); }
      }
      const keys = V.keys, ksig = keys ? `${keys.seat.join(",")}|${keys.swap}|${keys.radio}` : "";
      if (V.seat !== last.vehSeat || V.seats !== last.vehSeats || ksig !== last.vehKeys) {
        last.vehSeat = V.seat; last.vehSeats = V.seats; last.vehKeys = ksig;
        vehSeatEls.forEach((d, i) => d.setAttribute("class", (V.seats >> i) & 1 ? (i === V.seat ? "s me" : "s on") : "s"));
        vehKeys.forEach((k, i) => { const t = keys?.seat[i] ?? ""; k.textContent = t; k.className = `tn-key ${!t || i === V.seat ? "me" : (V.seats >> i) & 1 ? "full" : ""}`; });
        vehSwapK.textContent = keys?.swap ?? ""; vehSwap.style.display = keys?.swap ? "" : "none";
        vehRadioK.textContent = keys?.radio ?? ""; vehRadioK.style.display = keys?.radio ? "" : "none";
      }
      const radio = V.radio === undefined ? "-" : `${V.radio ?? ""}|${V.tuning ? 1 : 0}`;
      if (radio !== last.vehRadio) {
        last.vehRadio = radio;
        vehRadio.classList.toggle("kr-hide", V.radio === undefined);
        vehRadio.classList.toggle("on", !!V.radio); vehRadio.classList.toggle("off", !V.radio); vehRadio.classList.toggle("tune", !!V.tuning);
        vehSt.textContent = V.radio || "RADIO OFF";
      }
      // the chips — or, while it lasts, one warning line in their place (a helicopter with nobody at the stick)
      const hs = V.hint ? `!${V.hint}` : V.hints ? V.hints.map((h) => h.join("\u0001")).join("\u0002") : "";
      if (hs !== last.vehHint) {
        last.vehHint = hs; vehHints.textContent = ""; vehFillEl = null; last.vehFill = -1;
        if (V.hint) el("span", "", vehHints).textContent = V.hint;
        // a chip may stay up after the others fade (keep), pulse (hot), fill while held (fill) or warn
        else for (const [k, l, f = 0] of V.hints ?? []) { const sp = el("span", `${f & 1 ? "keep " : ""}${f & 2 ? "hot " : ""}${f & 4 ? "fill " : ""}${f & 8 ? "warn" : ""}`.trim(), vehHints); el("kbd", "tn-key", sp).textContent = k; sp.append(l); if (f & 4) vehFillEl = sp; }
        vehHints.classList.toggle("keeps", !V.hint && !!V.hints?.some((h) => ((h[2] ?? 0) & 1) !== 0));
      }
      const fill = vehFillEl ? Math.round((V.fill ?? 0) * 40) / 40 : -1;
      if (vehFillEl && fill !== last.vehFill) { last.vehFill = fill; vehFillEl.style.setProperty("--p", String(fill)); vehFillEl.classList.toggle("on", fill > 0); }
      const fade = !V.hintsOn && !V.hint;
      if (fade !== last.vehFade) { last.vehFade = fade; vehHints.classList.toggle("fade", fade); }
    }

    // ---- altimeter + flight hints
    const airOn = !!s.air;
    if (airOn !== last.airOn) { last.airOn = airOn; air.classList.toggle("kr-hide", !airOn); }
    if (s.air) {
      const ceil = s.airCeiling ?? 600;
      const alt = Math.round(s.air.altitude);
      if (alt !== last.airAlt) {
        last.airAlt = alt;
        airAlt.innerHTML = `${alt}<small>M</small>`;
        const f = Math.max(0, Math.min(1, s.air.altitude / ceil));
        airFill.style.transform = `scaleY(${f})`;
        airMk.style.transform = `translateY(calc(${(1 - f) * 270} * var(--tu) - 50%))`;   // (Toon) the scale is 270 design px
      }
      const spd = Math.round(s.air.speed);
      if (spd !== last.airSpd) { last.airSpd = spd; airSpd.textContent = `${spd} M/S`; }
      if (s.air.mode !== last.airMode) { last.airMode = s.air.mode; airMode.textContent = s.air.mode === "glide" ? "GLIDING" : "FREEFALL"; }
    }
    // the bomb's key hints (cooking is not discoverable otherwise)
    const bombH = alive && !s.air && s.lethal?.hint ? s.lethal.hint : 0;
    const bombSmoke = s.lethal?.id === "smoke-bomb";
    const swimH = alive && !s.air && s.swim?.hint ? s.swim.hint : null;
    const hintKey = (s.phase === "plane" && alive ? "plane" : s.air?.mode === "freefall" ? "free" : s.air?.mode === "glide" ? "glide" : "") || (bombH ? `bomb${bombH}|${bombSmoke ? 1 : 0}|${s.lethal!.key}` : "") || (swimH ? `swim-${swimH}` : "");
    if (hintKey !== last.hint) {
      last.hint = hintKey;
      hint.classList.toggle("kr-hide", !hintKey);
      hint.textContent = "";
      const add = (k: string, l: string) => { const sp = document.createElement("span"); const kb = document.createElement("kbd"); kb.className = "tn-key"; kb.textContent = k; sp.append(kb, l); hint.appendChild(sp); };
      // the ping key: mark the spot you look at — your squad sees it
      const pk = keyName("ping");
      if (hintKey === "plane") { add(keyName("jump"), "JUMP"); add(keyName("map"), "MAP · MARK YOUR DROP"); if (pk) add(pk, "PING"); }
      // freefall flies only while the move keys / stick push (stepAir: along the look, ~15 m/s); the look
      // alone just turns. Say so, and that the dive is a HOLD of the sprint button (its glyph can read like the stick)
      else if (hintKey === "free") { add(keyName("jump"), "PULL CHUTE"); add(lookText(), "STEER"); add(keyName("fwd"), "FLY FORWARD"); add(`HOLD ${keyName("sprint")}`, "DIVE"); if (pk) add(pk, "PING"); }
      else if (hintKey === "glide") { add(`HOLD ${keyName("jump")}`, "CUT CHUTE"); add(lookText(), "STEER"); add(keyName("fwd"), "GLIDE FORWARD"); if (pk) add(pk, "PING"); }
      else if (bombH === 1 && bombSmoke) { add(`HOLD ${s.lethal!.key}`, "OR FIRE · AIM"); add("RELEASE", "THROW"); add("1.5 S", "SMOKE SCREEN — BLOCKS SIGHT & BOTS"); }
      else if (bombH === 2 && bombSmoke) { add(`HOLD ${s.lethal!.key}`, "THROW SMOKE BANANA"); add("RELEASE", "DEPLOY CLOUD"); }
      else if (bombH === 1) { add(`HOLD ${s.lethal!.key}`, "OR FIRE · COOK"); add("RELEASE", "THROW"); add("3 S", "FUSE — DON'T HOLD IT TOO LONG"); }
      else if (bombH === 2) { add(`HOLD ${s.lethal!.key}`, "COOK A BANANA BOMB"); add("RELEASE", "THROW"); }
      else if (hintKey === "swim-surface") { add(keyName("crouch"), "DIVE"); add(keyName("sprint"), "SWIM FASTER"); add(keyName("jump"), "AT AN EDGE · CLIMB OUT"); }
      else if (hintKey === "swim-under") { add(keyName("fwd"), "SWIM WHERE YOU LOOK"); add(keyName("jump"), "UP"); add(keyName("crouch"), "DOWN"); }
    }
    // ---- swimming: the air meter (a capsule that drains; red and pulsing when nearly out)
    { const sw = alive ? s.swim : null, show = !!sw && (sw.under || sw.air < 0.999);
      const q = show ? Math.ceil(sw!.air * 100) / 100 + (sw!.low ? 2 : 0) + (sw!.under ? 4 : 0) : -1;
      if (q !== last.swimAir) {
        if ((q < 0) !== (last.swimAir < 0)) swimAir.classList.toggle("kr-hide", q < 0);
        last.swimAir = q;
        if (sw && show) {
          swimAir.classList.toggle("low", sw.low); swimAir.classList.toggle("up", !sw.under);
          swimFill.style.transform = bx(Math.max(0, Math.min(1, sw.air)));
        }
      }
    }

    // ---- chute prompt + cut progress
    const chuteOn = !!s.chuteReady && alive;
    if (chuteOn !== last.chuteOn) {
      last.chuteOn = chuteOn; chute.classList.toggle("kr-hide", !chuteOn);
      if (chuteOn && !calm()) chute.animate([{ opacity: 0, transform: "translateX(-50%) translateY(6px)" }, { opacity: 1, transform: "translateX(-50%)" }], { duration: 140, easing: "ease-out" });
    }
    const cutV = alive && s.air && s.air.cut > 0 ? Math.round(s.air.cut * 200) / 200 : 0;
    if (cutV !== last.cutV) {
      if ((cutV > 0) !== (last.cutV > 0)) cut.classList.toggle("kr-hide", cutV <= 0);
      last.cutV = cutV; cutFill.style.transform = `scaleX(${cutV})`;
    }

    // ---- redeploy / spectate
    const rdOn = !s.me.alive && s.resurgence.countdown != null;
    if (rdOn !== last.rdOn) {
      last.rdOn = rdOn; redeploy.classList.toggle("kr-hide", !rdOn);
      if (rdOn) {
        const lives = s.resurgence.lives;
        rdS.textContent = s.range ? "BACK ON THE FIRING LINE" : s.phase === "warmup" ? "WARM-UP · BACK ON THE ISLET"
          : s.mode === "solo" ? `RESURGENCE · ${lives ?? 0} REDEPLOY${lives === 1 ? "" : "S"} LEFT — THEN IT'S FINAL`
          : "RESURGENCE · YOUR SQUAD KEEPS YOU IN THE FIGHT";
      }
    }
    if (rdOn) {
      const n = s.resurgence.countdown! > 0.05 ? String(Math.ceil(s.resurgence.countdown!)) : "GO!";
      if (n !== last.rdN) { last.rdN = n; rdN.textContent = n; if (!calm()) rdN.animate([{ transform: "scale(1.3)", opacity: 0.4 }, { transform: "scale(1)", opacity: 1 }], { duration: 260, easing: TOON.spring }); }
    }
    const specOn = !!s.spectating && !s.spectate;
    specUi.update(s.spectate);
    tog(vitals, "kr-hide", !!s.spectate);   // my own (empty) bars give way to the watched kong's, in the bar
    if (specOn !== last.specOn) { last.specOn = specOn; spectate.classList.toggle("kr-hide", !specOn); }
    if (s.spectating && s.spectating !== last.spec) { last.spec = s.spectating; specName.textContent = s.spectating; }

    // ---- net
    const ping = Math.round(s.net.ping), fps = Math.round(s.net.fps);
    if (ping !== last.ping || fps !== last.fps) { last.ping = ping; last.fps = fps; net.textContent = `${ping} MS · ${fps} FPS`; }

    // ---- scope
    if (s.scoped !== last.scoped) { last.scoped = s.scoped; scopeWrap.classList.toggle("kr-hide", !s.scoped); }
    if (s.scoped) {
      const W = Math.round(vw * dpr), H = Math.round(vh * dpr);
      if (W !== last.scopeW || H !== last.scopeH) { last.scopeW = W; last.scopeH = H; scopeCanvas.width = W; scopeCanvas.height = H; paintScope(scopeCanvas); }
      const z = `${s.scope?.zoom ?? 6}×${s.scope?.range ? ` · ${Math.round(s.scope.range)} M` : ""}`;
      if (z !== last.zoom) { last.zoom = z; zoomLbl.textContent = z; }
      const b = s.scope?.breath ?? -1;
      const bq = Math.round(b * 100) / 100;
      if (bq !== last.breath) {
        last.breath = bq;
        breath.style.display = b < 0 ? "none" : "";
        if (b >= 0) { breathFill.style.transform = `scaleX(${Math.max(0, Math.min(1, b))})`; breathLbl.textContent = s.scope?.holding ? "HOLDING BREATH" : `HOLD ${keyName("sprint")} · STEADY`; }
      }
    }

    // ---- damage numbers (stacked per target). A known `at` may change (predicted → confirmed, more pellets landed):
    // the group total follows it. (Toon) a health hit is a plain number; shield hits carry the shield icons (dmgKind).
    for (let i = 0; i < s.damageNumbers.length; i++) {
      const d = s.damageNumbers[i];
      let gp: DmgGroup | undefined;
      for (const q of groups) if (q.amts.has(d.at)) { gp = q; break; }
      const pred = !!d.predicted;
      if (gp) {
        gp.sx = d.sx; gp.sy = d.sy;
        const old = gp.amts.get(d.at)!;
        if (old !== d.amount || gp.pred !== pred || KIND_RANK[d.kind] > KIND_RANK[gp.kind]) {
          const confirm = gp.pred && !pred;
          gp.total += d.amount - old; gp.amts.set(d.at, d.amount); gp.pred = pred;
          // the server's confirmation sets the kind outright (a predicted head may confirm as a shield hit)
          if (confirm || KIND_RANK[d.kind] > KIND_RANK[gp.kind]) gp.kind = d.kind;
          dmgKind(gp.el, gp.kind, gp.pred);
          txt(dmgNum(gp.el), String(Math.max(0, Math.round(gp.total))));
          if (confirm || d.amount > old) { gp.lastAdd = now; if (confirm) gp.start = now; }
        }
        continue;
      }
      // new hit: join a live group on the same target (or very close on screen), else start one
      for (const q of groups) {
        if (now - q.lastAdd > 1) continue;
        if (d.target !== undefined ? q.target === d.target : q.target === undefined && Math.hypot(q.sx - d.sx, (q.sy - d.sy) * 0.56) < 0.035) { gp = q; break; }
      }
      if (gp) {
        gp.amts.set(d.at, d.amount); gp.total += d.amount; gp.lastAdd = now; gp.sx = d.sx; gp.sy = d.sy; gp.pred = pred && gp.pred;
        if (KIND_RANK[d.kind] > KIND_RANK[gp.kind]) gp.kind = d.kind;
        dmgKind(gp.el, gp.kind, gp.pred);
        txt(dmgNum(gp.el), String(Math.round(gp.total)));
        gp.start = now;
      } else {
        const e = freeDmg.pop() ?? groups.shift()?.el;
        if (!e) continue;
        gp = { key: String(d.at), target: d.target, total: d.amount, kind: d.kind, start: now, lastAdd: now, sx: d.sx, sy: d.sy, el: e, drift: (Math.sin(d.at * 12.9898) * 0.5) * 30, amts: new Map([[d.at, d.amount]]), pred };
        e.className = "kr-dmg"; dmgKind(e, d.kind, pred);
        txt(dmgNum(e), String(Math.round(d.amount)));
        groups.push(gp);
      }
    }
    // HUD panels the numbers must not cover (e.g. "27" over "NOTHING COUNTS YET"): their rects, read at
    // most once a second (layout reads are not free), padded
    if (groups.length && now - panelsAt > 1) {
      panelsAt = now; panels.length = 0;
      // (Toon) + the whole top-right column and the range's practice panel (game/range.ts, outside the HUD root)
      for (const e of [leftCol, substat, mmWrap, vitals, ammo, hotbar, trCol, announce, place, radioB, elim, medals.el, document.querySelector<HTMLElement>(".tn-hud-practice")]) {
        if (!e || e.classList.contains("kr-hide") || !e.getClientRects().length) continue;   // (no boxes: hidden; fixed-position too)
        const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
        // (Toon) padded by about half a hit number, so the whole number clears the panel, not just its centre
        panels.push([r.left - 34 * u, r.top - 30 * u, r.right + 34 * u, r.bottom + 30 * u]);
      }
    }
    for (let i = groups.length - 1; i >= 0; i--) {
      const q = groups[i];
      const age = now - q.start, idle = now - q.lastAdd;
      if (idle > 1.0 || q.total <= 0.5) { q.el.className = "kr-dmg kr-hide"; freeDmg.push(q.el); groups.splice(i, 1); continue; }
      const pop = calm() ? 1 : age < 0.07 ? 1.45 - (age / 0.07) * 0.45 : 1;
      const rise = ease(idle / 1.0) * 46 * u;
      let x = q.sx * vw + q.drift * u * ease(idle), y = q.sy * vh - 40 * u - rise;
      // inside a panel: out through its nearest edge
      for (const [l, t, r, b] of panels) {
        if (x < l || x > r || y < t || y > b) continue;
        const dl = x - l, dr = r - x, dt = y - t, db = b - y, m = Math.min(dl, dr, dt, db);
        if (m === dl) x = l; else if (m === dr) x = r; else if (m === dt) y = t; else y = b;
      }
      q.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${pop.toFixed(3)})`;
      q.el.style.opacity = idle > 0.72 ? String(Math.max(0, 1 - (idle - 0.72) / 0.28)) : "1";
    }

    // ---- canvases
    if (!mapOpen) {
      minimap.update(s, now);
      drawCompass(s);
      center.update(s, now, vh);
    } else big.update(s, now);
  }

  function setOp(e: HTMLElement, k: "vigLow" | "vigDmg" | "vigStorm" | "vigShield" | "vigHeal", v: number) {
    const q = Math.round(v * 100) / 100;
    if (q === last[k]) return;
    last[k] = q;
    e.style.opacity = String(q);
  }

  big.onClick = (x, z) => hud.onMapClick?.(x, z);
  specUi.onAction = (a) => hud.onSpectate?.(a);
  big.onClear = () => hud.onMapClear?.();

  const hud: Hud = {
    el: root,
    update,
    setVisible(v: boolean) { visible = v; root.classList.toggle("kr-hide", !v); },
    setMapOpen(open: boolean) {
      if (open === mapOpen) return;
      mapOpen = open;
      if (open) big.open(); else big.close();
    },
    get mapOpen() { return mapOpen; },
    mapPad(dt, c) { if (mapOpen) big.pad(dt, c); },
    onMapClick: null,
    onMapClear: null,
    onSpectate: null,
    spectateFlash(dir: -1 | 1) { specUi.flash(dir); },
    setIconRenderer(fn: IconRenderer | null) {
      hb.setIconRenderer(fn);
    },
  };

  resize();
  // view-camera hook: ?map=1 opens the full-screen map for the ui-02 view (kept intentionally)
  if (flag("map")) hud.setMapOpen(true);
  void drawGlyph;
  return hud;
}

/** compass bearing (degrees clockwise from north) from a to b; world −Z is north */
function bearing(ax: number, az: number, bx: number, bz: number) {
  return ((Math.atan2(bx - ax, -(bz - az)) * 180) / Math.PI + 360) % 360;
}
