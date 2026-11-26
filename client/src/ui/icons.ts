// Icons. Two families:
//  • GLYPHS — flat vector shapes (person, clock, heart, shield, skull…) as SVG path data. The DOM uses inline <svg>
//    (crisp at any resolution, 4K included); canvases draw the same data through Path2D.
//  • ITEMS — glossy 3D-style item renders (public/assets/ui/icons/<id>.webp, in one shared hotbar style).
//    Kill-feed silhouettes are derived from their alpha.
import type { ConsumableId, WeaponId } from "../../../shared/world/map";
import { uiAsset } from "./styles";

export type ItemId = WeaponId | ConsumableId | "banana";

export const ITEM_IDS: ItemId[] = ["pistol", "smg", "ar", "shotgun", "sniper", "rocket", "bow", "minigun", "leaf-bundle", "smoothie", "golden-banana", "red-banana", "banana", "banana-bomb", "crate-wall", "smoke-bomb", "vine-grapple", "airstrike"];

// ------------------------------------------------------------------------------------------------ glyphs
interface Glyph { vb: [number, number]; paths: Array<{ d: string; fill?: string; stroke?: string; sw?: number; op?: number }> }
const C = "currentColor";
export const GLYPHS = {
  person: { vb: [80, 100], paths: [
    { d: "M40 3a22 22 0 1 1 0 44a22 22 0 1 1 0-44Z", fill: C },
    { d: "M3 94C3 70 17 55 40 55C63 55 77 70 77 94Q77 99 72 99H8Q3 99 3 94Z", fill: C },
  ] },
  clock: { vb: [100, 100], paths: [
    { d: "M50 6a44 44 0 1 1 0 88a44 44 0 1 1 0-88Z", stroke: C, sw: 9 },
    { d: "M50 24V52L69 64", stroke: C, sw: 9 },
  ] },
  heart: { vb: [100, 92], paths: [
    { d: "M50 90C44 85 4 58 4 29C4 14 16 3 30 3C39 3 46 8 50 15C54 8 61 3 70 3C84 3 96 14 96 29C96 58 56 85 50 90Z", fill: C },
    { d: "M28 14C19 14 13 21 13 29", stroke: "rgba(255,255,255,0.55)", sw: 6, op: 0.9 },
  ] },
  shield: { vb: [90, 104], paths: [
    { d: "M45 3L86 15V46C86 73 68 92 45 101C22 92 4 73 4 46V15Z", fill: C },
    { d: "M45 3L86 15V46C86 73 68 92 45 101Z", fill: "rgba(0,0,0,0.14)" },
  ] },
  storm: { vb: [100, 100], paths: [
    { d: "M27 58C13 58 5 49 5 38C5 27 14 18 26 19C30 9 40 3 51 3C66 3 77 13 79 27C89 28 96 36 96 45C96 53 90 58 82 58Z", fill: C },
    { d: "M55 44L36 72H50L42 97L69 62H54L63 44Z", fill: "#ffd400" },
  ] },
  bullet: { vb: [30, 100], paths: [
    { d: "M15 2C8 10 5 22 5 36V62H25V36C25 22 22 10 15 2Z", fill: C },
    { d: "M4 67H26V96Q26 99 23 99H7Q4 99 4 96Z", fill: C },
  ] },
  skull: { vb: [100, 100], paths: [
    { d: "M50 4C24 4 8 22 8 45C8 58 14 67 22 72V84C22 89 26 93 31 93H69C74 93 78 89 78 84V72C86 67 92 58 92 45C92 22 76 4 50 4Z", fill: C },
    { d: "M33 38a11 12 0 1 1 0 24a11 12 0 1 1 0-24ZM67 38a11 12 0 1 1 0 24a11 12 0 1 1 0-24Z", fill: "#15110a" },
    { d: "M50 60L56 72H44Z", fill: "#15110a" },
    { d: "M38 80V93M50 80V93M62 80V93", stroke: "#15110a", sw: 5 },
  ] },
  head: { vb: [100, 100], paths: [
    { d: "M50 10a40 40 0 1 1 0 80a40 40 0 1 1 0-80Z", stroke: C, sw: 10 },
    { d: "M50 0V28M50 72V100M0 50H28M72 50H100", stroke: C, sw: 10 },
    { d: "M50 40a10 10 0 1 1 0 20a10 10 0 1 1 0-20Z", fill: C },
  ] },
  eye: { vb: [100, 64], paths: [
    { d: "M2 32C16 11 33 2 50 2C67 2 84 11 98 32C84 53 67 62 50 62C33 62 16 53 2 32Z", fill: C },
    { d: "M50 14a18 18 0 1 1 0 36a18 18 0 1 1 0-36Z", fill: "#0e2a3e" },
    { d: "M50 24a8 8 0 1 1 0 16a8 8 0 1 1 0-16Z", fill: C },
  ] },
  plane: { vb: [100, 100], paths: [
    { d: "M50 2C55 2 57 8 57 14V38L96 58V68L57 58V80L70 90V97L50 92L30 97V90L43 80V58L4 68V58L43 38V14C43 8 45 2 50 2Z", fill: C },
  ] },
  banana: { vb: [100, 100], paths: [
    { d: "M17 20C10 50 24 82 58 88C73 91 88 86 95 78C80 82 62 79 49 70C35 60 27 43 27 22Z", fill: C },
    { d: "M15 22L14 11L24 8L27 21Z", fill: "#6b4a1c" },
  ] },
  crown: { vb: [100, 80], paths: [
    { d: "M6 70L2 18L28 42L50 6L72 42L98 18L94 70Z", fill: C },
  ] },
  bolt: { vb: [60, 100], paths: [{ d: "M38 2L4 58H26L18 98L56 38H34Z", fill: C }] },
  cross: { vb: [100, 100], paths: [{ d: "M36 6H64V36H94V64H64V94H36V64H6V36H36Z", fill: C }] },
  storm_s: { vb: [100, 100], paths: [{ d: "M20 70C8 70 2 62 2 52C2 42 10 35 20 36C24 22 36 14 50 14C66 14 78 25 80 40C90 41 98 48 98 57C98 65 92 70 84 70Z", fill: C }] },
  fall: { vb: [100, 100], paths: [{ d: "M50 96L20 58H38V6H62V58H80Z", fill: C }] },
  // a map pin: the named place you are in, by the minimap
  pin: { vb: [80, 100], paths: [{ d: "M40 2C19 2 4 17 4 37C4 62 40 98 40 98C40 98 76 62 76 37C76 17 61 2 40 2ZM40 22a15 15 0 1 1 0 30a15 15 0 1 1 0-30Z", fill: C }] },
  // Banana Stand: weapon upgrade (+1 tier upward chevron + star spark)
  upgrade: { vb: [100, 100], paths: [
    { d: "M50 8L84 44H64V88H36V44H16Z", fill: C },
    { d: "M22 68L50 40L78 68", stroke: "#ffd400", sw: 8 },
  ] },
  // Banana Stand: radar pulse (UAV concentric sonar rings + sweep needle)
  radar: { vb: [100, 100], paths: [
    { d: "M50 8a42 42 0 1 1 0 84a42 42 0 1 1 0-84Z", stroke: C, sw: 7 },
    { d: "M50 24a26 26 0 1 1 0 52a26 26 0 1 1 0-52Z", stroke: C, sw: 6, op: 0.7 },
    { d: "M50 50L80 24", stroke: "#5cf2ff", sw: 8 },
    { d: "M50 41a9 9 0 1 1 0 18a9 9 0 1 1 0-18Z", fill: C },
  ] },
} satisfies Record<string, Glyph>;
export type GlyphId = keyof typeof GLYPHS;

const SVGNS = "http://www.w3.org/2000/svg";
/** inline <svg> glyph; colour via CSS `color` (or `color` arg) */
export function svgGlyph(id: GlyphId, cls = "", color?: string): SVGSVGElement {
  const g = GLYPHS[id] as Glyph;
  const s = document.createElementNS(SVGNS, "svg");
  s.setAttribute("viewBox", `0 0 ${g.vb[0]} ${g.vb[1]}`);
  if (cls) s.setAttribute("class", cls);
  if (color) s.style.color = color;
  for (const p of g.paths) {
    const e = document.createElementNS(SVGNS, "path");
    e.setAttribute("d", p.d);
    if (p.fill) e.setAttribute("fill", p.fill); else e.setAttribute("fill", "none");
    if (p.stroke) { e.setAttribute("stroke", p.stroke); e.setAttribute("stroke-width", String(p.sw ?? 4)); e.setAttribute("stroke-linecap", "round"); e.setAttribute("stroke-linejoin", "round"); }
    if (p.op !== undefined) e.setAttribute("opacity", String(p.op));
    s.appendChild(e);
  }
  return s;
}

const pathCache = new Map<string, Path2D>();
const p2d = (d: string) => { let p = pathCache.get(d); if (!p) { p = new Path2D(d); pathCache.set(d, p); } return p; };
/** draw a glyph into a 2D context, fitted into the box (x, y, w, h) */
export function drawGlyph(g: CanvasRenderingContext2D, id: GlyphId, x: number, y: number, w: number, h: number, color: string) {
  const gl = GLYPHS[id] as Glyph;
  const k = Math.min(w / gl.vb[0], h / gl.vb[1]);
  g.save();
  g.translate(x + (w - gl.vb[0] * k) / 2, y + (h - gl.vb[1] * k) / 2);
  g.scale(k, k);
  g.lineCap = "round"; g.lineJoin = "round";
  for (const p of gl.paths) {
    const path = p2d(p.d);
    const col = (c: string) => (c === C ? color : c);
    if (p.op !== undefined) g.globalAlpha = p.op;
    if (p.fill) { g.fillStyle = col(p.fill); g.fill(path); }
    if (p.stroke) { g.strokeStyle = col(p.stroke); g.lineWidth = p.sw ?? 4; g.stroke(path); }
    g.globalAlpha = 1;
  }
  g.restore();
}

// ------------------------------------------------------------------------------------------------ items
const imgCache = new Map<string, HTMLImageElement>();
export const itemIconUrl = (id: string) => uiAsset(`icons/${id}.webp`);
/** shared, preloaded <img> for an item (decode() it before drawing to a canvas) */
export function itemImage(id: string): HTMLImageElement {
  let im = imgCache.get(id);
  if (!im) {
    im = new Image();
    im.decoding = "async";
    im.src = itemIconUrl(ITEM_IDS.includes(id as ItemId) ? id : "banana");
    imgCache.set(id, im);
  }
  return im;
}
/** preload every item icon; resolves when all are decoded (or failed) */
export function preloadItems(): Promise<void> {
  return Promise.all(ITEM_IDS.map((id) => itemImage(id).decode().catch(() => undefined))).then(() => undefined);
}

/** icons painted facing left in the source art — mirrored in the kill feed so every weapon points at the victim */
const FACES_LEFT = new Set(["pistol", "smg", "shotgun", "sniper"]);
const silCache = new Map<string, HTMLCanvasElement>();
/** flat cream silhouette of a weapon (kill feed), w×h device px, drawn from the item art's alpha */
export function weaponSilhouette(id: string, w: number, h: number, color = "#fbf3c9"): HTMLCanvasElement | null {
  const key = `${id}/${w}/${h}/${color}`;
  const hit = silCache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  if (id === "storm" || id === "fall" || id === "unknown") {
    drawGlyph(g, id === "storm" ? "bolt" : id === "fall" ? "fall" : "skull", 0, 0, w, h, color);
    silCache.set(key, c);
    return c;
  }
  const im = itemImage(id);
  if (!im.complete || !im.naturalWidth) return null;
  // tight bbox of the art, fitted into the box with a 1 px dark rim for contrast
  const k = Math.min(w / im.naturalWidth, h / im.naturalHeight) * 1.25;
  const dw = im.naturalWidth * k, dh = im.naturalHeight * k;
  const tmp = document.createElement("canvas");
  tmp.width = w; tmp.height = h;
  const t = tmp.getContext("2d")!;
  t.save();
  if (FACES_LEFT.has(id)) { t.translate(w, 0); t.scale(-1, 1); }
  t.drawImage(im, (w - dw) / 2, (h - dh) / 2, dw, dh);
  t.restore();
  t.globalCompositeOperation = "source-in";
  t.fillStyle = color;
  t.fillRect(0, 0, w, h);
  // dark rim
  g.globalAlpha = 0.55;
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) g.drawImage(tmp, dx, dy);
  g.globalCompositeOperation = "source-in";
  g.fillStyle = "rgba(10,10,6,0.9)";
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = "source-over";
  g.globalAlpha = 1;
  g.drawImage(tmp, 0, 0);
  silCache.set(key, c);
  return c;
}
