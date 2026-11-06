// poi-harbor kit — shared tileable materials for the harbor + wreck (cranes, ship, warehouses, tanks, props).
// All painted in code (harbor-paint.ts). Cached per page: `harborMats()` returns the same instances every call, so
// merged/instanced geometry can share them and the renderer keeps the program count low.
//
// Every material tiles in METRES (build geometry with harbor-geo.ts / uvMetres(): 1 uv = 1 m). On top of the painted
// tile, `weather()` injects a world-space shader layer: macro tone variation (kills visible tiling), grime that
// accumulates toward the ground plane, and roughness response — the atmos area's CSM/aerial patch chains after it.
import * as THREE from "three";
import { canvas, edgeShade, hazardStripes, noiseTile, normalFromHeight, paintNoise, rng, scratches, splotches, streaks, tex, type TexOpts, cappedBitmap } from "./harbor-paint";
import { workerPool } from "../../../engine/worker-pool";
import { capped } from "../../../engine/tex-cap";
import { presetImageMean, setPaletteMaterial } from "./harbor-geo";

export interface HarborMats {
  /** ripe-yellow industrial paint (cranes, forklifts, funnels, ladders) — tile = 2 m */
  yellowPaint: THREE.MeshStandardMaterial;
  /** dark red-brown chassis paint */
  redPaint: THREE.MeshStandardMaterial;
  /** white marine paint with grime (ship superstructure, tanks) — tile = 3 m */
  whitePaint: THREE.MeshStandardMaterial;
  /** black hull paint, slight sheen */
  blackHull: THREE.MeshStandardMaterial;
  /** red anti-fouling boot-top */
  bootRed: THREE.MeshStandardMaterial;
  /** galvanised steel (railings, cable trays, bolts) */
  galv: THREE.MeshStandardMaterial;
  /** dark machined steel (rails, wheels, rods) */
  steel: THREE.MeshStandardMaterial;
  /** rust-eaten iron (the wreck) — tile = 4 m */
  rust: THREE.MeshStandardMaterial;
  /** warm light-grey concrete (apron, walls) — tile = 4 m */
  concrete: THREE.MeshStandardMaterial;
  /** dark quay wall concrete / sheet-pile with tide line — tile = 4 m (v = height, tide mark near v≈0.55) */
  quayWall: THREE.MeshStandardMaterial;
  /** yellow/black hazard capping — tile = 2 m along u */
  hazard: THREE.MeshStandardMaterial;
  /** weathered timber planks (pier, pallets) — tile = 1 m, planks run along v */
  wood: THREE.MeshStandardMaterial;
  /** corrugated grey steel sheet (warehouse roofs) — tile = 1 m, ribs along v */
  corrugatedGrey: THREE.MeshStandardMaterial;
  /** corrugated sun-bleached yellow sheet */
  corrugatedYellow: THREE.MeshStandardMaterial;
  /** black rubber (tyres, fenders) */
  rubber: THREE.MeshStandardMaterial;
  /** tinted glass */
  glass: THREE.MeshPhysicalMaterial;
  /** small shared normal map: dents + rivets, tileable (NoColorSpace) */
  dentNormal: THREE.Texture;
  /** ripe banana skin */
  banana: THREE.MeshStandardMaterial;
  /** cream sand-coloured plywood (container floors, crate lids) */
  plywood: THREE.MeshStandardMaterial;
  /** charcoal machinery paint (motor housings, bogies, cabins' trim) */
  darkPaint: THREE.MeshStandardMaterial;
  /** white-painted smooth concrete / render (warehouse walls) — tile 4 m */
  wallWhite: THREE.MeshStandardMaterial;
  /** dark reflective window glass (bridge, cabin, warehouse strips) */
  windowDark: THREE.MeshStandardMaterial;
  /** ship deck: red-oxide deck paint with scuffs — tile 3 m */
  deck: THREE.MeshStandardMaterial;
  /** interior darkness (door recess, hold) — near-black, matte */
  interior: THREE.MeshStandardMaterial;
  /** blue trim paint (warehouse door frames, blue end walls) */
  bluePaint: THREE.MeshStandardMaterial;
  /** green crate / tarp canvas */
  greenPaint: THREE.MeshStandardMaterial;
  /** warm emissive lamp lens */
  lampLens: THREE.MeshStandardMaterial;
  /** red warning light */
  warnLight: THREE.MeshStandardMaterial;
  /** rope / hawser (tan fibre) */
  rope: THREE.MeshStandardMaterial;
  /** asphalt/dark concrete for rail beds + patches */
  asphalt: THREE.MeshStandardMaterial;
  /** steel wire rope (crane stays, hoist cables) */
  cable: THREE.MeshStandardMaterial;
  /** white-painted tank steel (fuel tanks) — tile 3 m */
  tankWhite: THREE.MeshStandardMaterial;
  /** barnacle/algae-crusted hull below the waterline (wreck + quay piles) */
  algae: THREE.MeshStandardMaterial;
  /** mossy boulder / rock (pier rocks, reef) */
  rock: THREE.MeshStandardMaterial;
  /** moss (rock caps) */
  moss: THREE.MeshStandardMaterial;
}

let cache: HarborMats | null = null;

// ------------------------------------------------------------------------------------------------ painted tiles
function baseTile(size: number, color: string, o: { seed?: number; grime?: number; grimeColor?: string; noise?: number; streaks?: number; scratches?: number; chips?: number; chipColor?: string }) {
  const [el, c] = canvas(size, size);
  c.fillStyle = color; c.fillRect(0, 0, size, size);
  paintNoise(c, 0, 0, size, size, { seed: o.seed ?? 1, scale: size * 0.9, alpha: o.noise ?? 0.16, blend: "overlay" });
  paintNoise(c, 0, 0, size, size, { seed: (o.seed ?? 1) + 3, scale: size * 0.23, alpha: (o.noise ?? 0.16) * 0.5, blend: "overlay" });
  if (o.grime) splotches(c, 0, 0, size, size, { n: 36, rMin: size * 0.03, rMax: size * 0.14, color: o.grimeColor ?? "rgba(60,45,30,1)", alpha: o.grime, seed: (o.seed ?? 1) + 5, blend: "multiply" });
  if (o.streaks) streaks(c, 0, 0, size, size, { n: 26, color: "rgba(110,70,35,1)", alpha: o.streaks, lenMin: size * 0.1, lenMax: size * 0.55, width: size * 0.008, seed: (o.seed ?? 1) + 9, blend: "multiply" });
  if (o.chips) { // paint chips: small bright-steel / dark-primer flecks
    const r = rng((o.seed ?? 1) + 17);
    for (let i = 0; i < 90 * o.chips; i++) {
      const x = r() * size, y = r() * size, rr = 0.6 + r() * size * 0.0025;
      c.fillStyle = r() < 0.5 ? (o.chipColor ?? "rgba(70,60,50,0.8)") : "rgba(160,150,140,0.7)";
      c.beginPath(); c.ellipse(x, y, rr * (1 + r()), rr, r() * 3, 0, Math.PI * 2); c.fill();
    }
  }
  if (o.scratches) scratches(c, 0, 0, size, size, { n: 70, color: "rgba(255,255,255,1)", alpha: o.scratches, seed: (o.seed ?? 1) + 13, lenMin: 4, lenMax: size * 0.1 });
  return el;
}

function roughTile(size: number, base: number, variance: number, seed = 2) {
  const [el, c] = canvas(size, size);
  const v = Math.round(base * 255);
  c.fillStyle = `rgb(${v},${v},${v})`; c.fillRect(0, 0, size, size);
  paintNoise(c, 0, 0, size, size, { seed, scale: size * 0.7, alpha: variance, blend: "overlay" });
  paintNoise(c, 0, 0, size, size, { seed: seed + 1, scale: size * 0.15, alpha: variance * 0.6, blend: "overlay" });
  return el;
}

function dentNormal(size = 512): HTMLCanvasElement {
  const [el, c] = canvas(size, size);
  c.fillStyle = "#808080"; c.fillRect(0, 0, size, size);
  paintNoise(c, 0, 0, size, size, { seed: 31, scale: size * 0.5, alpha: 0.4, blend: "source-over", octaves: 3 });
  paintNoise(c, 0, 0, size, size, { seed: 32, scale: size * 0.12, alpha: 0.2, blend: "overlay", octaves: 4 });
  const r = rng(77);
  for (let i = 0; i < 70; i++) {
    const x = r() * size, y = r() * size, rad = size * 0.006 * (0.8 + 0.5 * r());
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, "rgba(255,255,255,0.9)"); g.addColorStop(0.7, "rgba(200,200,200,0.5)"); g.addColorStop(1, "rgba(128,128,128,0)");
    c.fillStyle = g; c.beginPath(); c.arc(x, y, rad, 0, Math.PI * 2); c.fill();
  }
  return normalFromHeight(el, 1.3);
}

function corrugatedTile(size: number, color: string, seed: number, bleach: number) {
  const [el, c] = canvas(size, size);
  c.fillStyle = color; c.fillRect(0, 0, size, size);
  const ribs = 8, rw = size / ribs;
  for (let i = 0; i < ribs; i++) {
    const x = i * rw;
    const g = c.createLinearGradient(x, 0, x + rw, 0);
    g.addColorStop(0, "rgba(255,255,255,0.20)"); g.addColorStop(0.25, "rgba(255,255,255,0.04)"); g.addColorStop(0.5, "rgba(0,0,0,0.0)"); g.addColorStop(0.75, "rgba(0,0,0,0.18)"); g.addColorStop(1, "rgba(0,0,0,0.0)");
    c.fillStyle = g; c.fillRect(x, 0, rw, size);
  }
  paintNoise(c, 0, 0, size, size, { seed, scale: size, alpha: 0.22, blend: "overlay" });
  streaks(c, 0, 0, size, size, { n: 30, color: "rgba(110,75,40,1)", alpha: 0.28, lenMin: size * 0.2, lenMax: size, width: rw * 0.35, seed: seed + 1, blend: "multiply" });
  splotches(c, 0, 0, size, size, { n: 14, rMin: size * 0.02, rMax: size * 0.08, color: "rgba(150,80,35,1)", alpha: 0.35, seed: seed + 2, blend: "multiply" });
  if (bleach) edgeShade(c, 0, 0, size, size, { size: size * 0.5, color: "rgba(255,250,230,1)", alpha: bleach, sides: ["top"], blend: "screen" });
  const [hel, hc] = canvas(size, size);
  for (let i = 0; i < ribs; i++) {
    const x = i * rw;
    const g = hc.createLinearGradient(x, 0, x + rw, 0);
    g.addColorStop(0, "#202020"); g.addColorStop(0.2, "#e0e0e0"); g.addColorStop(0.5, "#e0e0e0"); g.addColorStop(0.7, "#202020"); g.addColorStop(1, "#202020");
    hc.fillStyle = g; hc.fillRect(x, 0, rw, size);
  }
  return { color: el, normal: normalFromHeight(hel, 6) };
}

function woodTile(size: number) {
  const [el, c] = canvas(size, size);
  const r = rng(41);
  const planks = 6, pw = size / planks;
  for (let i = 0; i < planks; i++) {
    const x = i * pw, tone = 0.8 + r() * 0.32;
    c.fillStyle = `rgb(${Math.round(168 * tone)},${Math.round(118 * tone)},${Math.round(70 * tone)})`;
    c.fillRect(x, 0, pw, size);
    c.strokeStyle = "rgba(70,40,15,0.35)"; c.lineWidth = 1.2;
    for (let k = 0; k < 10; k++) {
      const gx = x + 3 + r() * (pw - 6);
      c.beginPath(); c.moveTo(gx, 0);
      for (let y = 0; y <= size; y += size / 8) c.lineTo(gx + Math.sin(y / 40 + k) * 3 + (r() - 0.5) * 2, y);
      c.stroke();
    }
    // knots
    for (let k = 0; k < 2; k++) { const ky = r() * size, kx = x + pw * (0.3 + 0.4 * r()); c.fillStyle = "rgba(60,35,15,0.45)"; c.beginPath(); c.ellipse(kx, ky, pw * 0.07, pw * 0.12, 0, 0, Math.PI * 2); c.fill(); }
    // end joint
    const jy = r() * size; c.fillStyle = "rgba(25,12,5,0.8)"; c.fillRect(x, jy, pw, 3);
    c.fillStyle = "rgba(20,10,5,0.8)"; c.fillRect(x + pw - 3, 0, 3, size);
    c.fillStyle = "rgba(40,40,45,0.9)";
    for (const ny of [size * 0.12, size * 0.5, size * 0.88]) { c.beginPath(); c.arc(x + pw * 0.3, ny, 2.2, 0, Math.PI * 2); c.arc(x + pw * 0.7, ny, 2.2, 0, Math.PI * 2); c.fill(); }
  }
  paintNoise(c, 0, 0, size, size, { seed: 42, scale: size * 0.8, alpha: 0.3, blend: "overlay" });
  splotches(c, 0, 0, size, size, { n: 22, rMin: size * 0.04, rMax: size * 0.18, color: "rgba(60,70,50,1)", alpha: 0.18, seed: 43, blend: "multiply" });
  const [hel, hc] = canvas(size, size);
  hc.fillStyle = "#b0b0b0"; hc.fillRect(0, 0, size, size);
  for (let i = 0; i < planks; i++) { hc.fillStyle = "#101010"; hc.fillRect(i * pw + pw - 3, 0, 3, size); }
  paintNoise(hc, 0, 0, size, size, { seed: 44, scale: size * 0.3, alpha: 0.5, blend: "overlay" });
  return { color: el, normal: normalFromHeight(hel, 3) };
}

/** a jointless warm-cream concrete tile for the apron slab (its 6 m joint grid is drawn analytically in the slab
 *  shader, crisp at any distance) — map + normal map, 4 m tile */
let slabTileCache: { map: THREE.Texture; normalMap: THREE.Texture } | null = null;
export function slabConcreteMaps(): { map: THREE.Texture; normalMap: THREE.Texture } {
  if (slabTileCache) return slabTileCache;
  slabTileCache = { map: T("slab.color"), normalMap: T("slab.normal", { srgb: false }) };
  return slabTileCache;
}

function concreteTile(size: number, color: string, seed: number, joints: boolean) {
  const [el, c] = canvas(size, size);
  c.fillStyle = color; c.fillRect(0, 0, size, size);
  paintNoise(c, 0, 0, size, size, { seed, scale: size, alpha: 0.16, blend: "overlay" });
  paintNoise(c, 0, 0, size, size, { seed: seed + 1, scale: size * 0.2, alpha: 0.12, blend: "overlay" });
  paintNoise(c, 0, 0, size, size, { seed: seed + 2, scale: size * 0.05, alpha: 0.1, blend: "overlay", octaves: 2 });
  // aggregate speckle (fine, even — no blotches: large-scale tone comes from the world-space weather layer)
  const r = rng(seed + 21);
  for (let i = 0; i < size * 4; i++) { c.fillStyle = r() < 0.5 ? "rgba(95,90,82,0.28)" : "rgba(245,241,233,0.3)"; c.fillRect(r() * size, r() * size, 1 + r() * 1.5, 1 + r() * 1.5); }
  // a few pop-outs / small spalls
  for (let i = 0; i < 6; i++) { c.fillStyle = "rgba(110,104,96,0.35)"; c.beginPath(); c.ellipse(r() * size, r() * size, 2 + r() * 4, 1.5 + r() * 3, r() * 3, 0, Math.PI * 2); c.fill(); }
  if (joints) {
    // sawn expansion joints (dark, sealant) with slightly chipped arrises
    c.fillStyle = "rgba(50,46,42,0.7)"; c.fillRect(0, 0, size, 3); c.fillRect(0, 0, 3, size);
    c.fillStyle = "rgba(255,255,255,0.18)"; c.fillRect(0, 3, size, 2); c.fillRect(3, 0, 2, size);
    for (let i = 0; i < 18; i++) { const t = r() * size, horiz = r() < 0.5; c.fillStyle = "rgba(70,65,60,0.4)"; c.beginPath(); c.ellipse(horiz ? t : 2, horiz ? 2 : t, 3 + r() * 5, 2 + r() * 2, horiz ? 0 : Math.PI / 2, 0, Math.PI * 2); c.fill(); }
  }
  const [hel, hc] = canvas(size, size);
  hc.fillStyle = "#909090"; hc.fillRect(0, 0, size, size);
  paintNoise(hc, 0, 0, size, size, { seed: seed + 7, scale: size * 0.1, alpha: 0.4, blend: "overlay", octaves: 3 });
  if (joints) { hc.fillStyle = "#303030"; hc.fillRect(0, 0, size, 4); hc.fillRect(0, 0, 4, size); }
  return { color: el, normal: normalFromHeight(hel, 1.4) };
}

function rustTile(size: number) {
  const [el, c] = canvas(size, size);
  c.fillStyle = "#8a4420"; c.fillRect(0, 0, size, size);
  paintNoise(c, 0, 0, size, size, { seed: 51, scale: size, alpha: 0.45, blend: "overlay" });
  splotches(c, 0, 0, size, size, { n: 60, rMin: size * 0.02, rMax: size * 0.2, color: "#c06a30", alpha: 0.5, seed: 52 });
  splotches(c, 0, 0, size, size, { n: 50, rMin: size * 0.02, rMax: size * 0.14, color: "#4a2410", alpha: 0.45, seed: 53 });
  splotches(c, 0, 0, size, size, { n: 25, rMin: size * 0.02, rMax: size * 0.1, color: "#d8955a", alpha: 0.3, seed: 54 });
  streaks(c, 0, 0, size, size, { n: 50, color: "#4a2410", alpha: 0.45, lenMin: size * 0.15, lenMax: size * 0.8, width: size * 0.012, seed: 55 });
  c.strokeStyle = "rgba(35,16,8,0.7)"; c.lineWidth = 3;
  for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(0, i * size / 4); c.lineTo(size, i * size / 4); c.stroke(); }
  c.strokeStyle = "rgba(255,200,150,0.18)"; c.lineWidth = 2;
  for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(0, i * size / 4 + 4); c.lineTo(size, i * size / 4 + 4); c.stroke(); }
  paintNoise(c, 0, 0, size, size, { seed: 56, scale: size * 0.08, alpha: 0.22, blend: "overlay", octaves: 3 });
  const [hel, hc] = canvas(size, size);
  hc.fillStyle = "#808080"; hc.fillRect(0, 0, size, size);
  paintNoise(hc, 0, 0, size, size, { seed: 57, scale: size * 0.35, alpha: 0.6, blend: "overlay" });
  paintNoise(hc, 0, 0, size, size, { seed: 58, scale: size * 0.06, alpha: 0.4, blend: "overlay", octaves: 3 });
  hc.fillStyle = "#101010"; for (let i = 1; i < 4; i++) hc.fillRect(0, i * size / 4 - 2, size, 5);
  hc.fillStyle = "#f0f0f0";
  for (let i = 0; i < 4; i++) for (let x = size / 32; x < size; x += size / 16) { hc.beginPath(); hc.arc(x, i * size / 4 + size / 8, size * 0.006, 0, Math.PI * 2); hc.fill(); }
  const rough = roughTile(size, 0.85, 0.35, 59);
  return { color: el, normal: normalFromHeight(hel, 2.2), rough };
}

function quayWallTile(size: number) {
  const [el, c] = canvas(size, size);
  c.fillStyle = "#5a5b57"; c.fillRect(0, 0, size, size);
  paintNoise(c, 0, 0, size, size, { seed: 61, scale: size, alpha: 0.3, blend: "overlay" });
  // cast-in-place panel joints (vertical every 1/2 tile) + tie holes
  c.fillStyle = "rgba(30,30,28,0.5)"; for (let x = 0; x < size; x += size / 2) c.fillRect(x, 0, 3, size);
  c.fillStyle = "rgba(20,20,20,0.6)"; for (let x = size / 8; x < size; x += size / 4) for (const y of [size * 0.12, size * 0.28]) { c.beginPath(); c.arc(x, y, 3, 0, Math.PI * 2); c.fill(); }
  // tide band: algae + dark wet line in the lower part
  const g = c.createLinearGradient(0, size * 0.34, 0, size * 0.7);
  g.addColorStop(0, "rgba(0,0,0,0)"); g.addColorStop(0.3, "rgba(70,95,60,0.65)"); g.addColorStop(0.65, "rgba(28,44,32,0.9)"); g.addColorStop(1, "rgba(16,22,22,0.95)");
  c.fillStyle = g; c.fillRect(0, size * 0.34, size, size * 0.66);
  streaks(c, 0, size * 0.05, size, size * 0.45, { n: 30, color: "rgba(110,70,35,1)", alpha: 0.35, lenMin: size * 0.1, lenMax: size * 0.45, width: size * 0.012, seed: 62, blend: "multiply" });
  splotches(c, 0, size * 0.34, size, size * 0.2, { n: 40, rMin: size * 0.01, rMax: size * 0.04, color: "#e8e4d8", alpha: 0.5, seed: 63 }); // barnacles
  splotches(c, 0, size * 0.36, size, size * 0.3, { n: 30, rMin: size * 0.02, rMax: size * 0.08, color: "#6b9a4e", alpha: 0.35, seed: 64 });
  const [hel, hc] = canvas(size, size);
  hc.fillStyle = "#808080"; hc.fillRect(0, 0, size, size);
  for (let x = 0; x < size; x += size / 2) { hc.fillStyle = "#303030"; hc.fillRect(x, 0, 4, size); }
  paintNoise(hc, 0, 0, size, size, { seed: 65, scale: size * 0.15, alpha: 0.45, blend: "overlay" });
  return { color: el, normal: normalFromHeight(hel, 2.5) };
}

function hazardTile(size: number) {
  const [el, c] = canvas(size, size / 4);
  hazardStripes(c, 0, 0, size, size / 4, { period: size / 8, colors: ["#f6c318", "#1d1d1d"], angle: 0 });
  paintNoise(c, 0, 0, size, size / 4, { seed: 71, scale: size * 0.5, alpha: 0.25, blend: "overlay" });
  scratches(c, 0, 0, size, size / 4, { n: 60, color: "#000", alpha: 0.4, seed: 72, lenMin: 4, lenMax: 30 });
  splotches(c, 0, 0, size, size / 4, { n: 20, rMin: 4, rMax: 18, color: "rgba(120,80,40,1)", alpha: 0.35, seed: 73, blend: "multiply" });
  return el;
}

function bananaTile(size: number) {
  const [el, c] = canvas(size, size);
  c.fillStyle = "#f6cc34"; c.fillRect(0, 0, size, size);
  paintNoise(c, 0, 0, size, size, { seed: 81, scale: size * 0.6, alpha: 0.14, blend: "overlay" });
  const r = rng(82);
  c.fillStyle = "rgba(90,50,20,0.7)";
  for (let i = 0; i < 50; i++) { c.beginPath(); c.ellipse(r() * size, r() * size, 1.2 + r() * 2.5, 0.8 + r() * 1.6, r() * 3, 0, Math.PI * 2); c.fill(); }
  const g = c.createLinearGradient(0, 0, size * 0.25, 0);
  g.addColorStop(0, "rgba(120,150,40,0.7)"); g.addColorStop(1, "rgba(120,150,40,0)");
  c.fillStyle = g; c.fillRect(0, 0, size * 0.25, size);
  const g2 = c.createLinearGradient(size, 0, size * 0.85, 0);
  g2.addColorStop(0, "rgba(60,35,15,0.9)"); g2.addColorStop(1, "rgba(60,35,15,0)");
  c.fillStyle = g2; c.fillRect(size * 0.85, 0, size * 0.15, size);
  return el;
}

function rockTile(size: number) {
  const [el, c] = canvas(size, size);
  c.fillStyle = "#8d8a84"; c.fillRect(0, 0, size, size);
  paintNoise(c, 0, 0, size, size, { seed: 91, scale: size, alpha: 0.4, blend: "overlay" });
  paintNoise(c, 0, 0, size, size, { seed: 92, scale: size * 0.25, alpha: 0.3, blend: "overlay" });
  splotches(c, 0, 0, size, size, { n: 40, rMin: size * 0.02, rMax: size * 0.1, color: "#b5b0a6", alpha: 0.3, seed: 93 });
  splotches(c, 0, 0, size, size, { n: 30, rMin: size * 0.01, rMax: size * 0.05, color: "#5a5a54", alpha: 0.35, seed: 94, blend: "multiply" });
  splotches(c, 0, 0, size, size, { n: 20, rMin: size * 0.01, rMax: size * 0.04, color: "#c7c29a", alpha: 0.35, seed: 95 }); // lichen
  const [hel, hc] = canvas(size, size);
  hc.fillStyle = "#808080"; hc.fillRect(0, 0, size, size);
  paintNoise(hc, 0, 0, size, size, { seed: 96, scale: size * 0.4, alpha: 0.6, blend: "overlay" });
  paintNoise(hc, 0, 0, size, size, { seed: 97, scale: size * 0.08, alpha: 0.4, blend: "overlay" });
  return { color: el, normal: normalFromHeight(hel, 3) };
}

function mossTile(size: number) {
  const [el, c] = canvas(size, size);
  c.fillStyle = "#5f8a2e"; c.fillRect(0, 0, size, size);
  paintNoise(c, 0, 0, size, size, { seed: 101, scale: size * 0.6, alpha: 0.45, blend: "overlay" });
  splotches(c, 0, 0, size, size, { n: 60, rMin: size * 0.01, rMax: size * 0.06, color: "#a3c24a", alpha: 0.35, seed: 102 });
  splotches(c, 0, 0, size, size, { n: 40, rMin: size * 0.01, rMax: size * 0.05, color: "#35561c", alpha: 0.4, seed: 103, blend: "multiply" });
  const [hel, hc] = canvas(size, size);
  hc.fillStyle = "#808080"; hc.fillRect(0, 0, size, size);
  paintNoise(hc, 0, 0, size, size, { seed: 104, scale: size * 0.06, alpha: 0.7, blend: "overlay", octaves: 3 });
  return { color: el, normal: normalFromHeight(hel, 4) };
}

function deckTile(size: number) {
  const el = baseTile(size, "#8e3b26", { seed: 111, grime: 0.3, streaks: 0.2, scratches: 0.35, noise: 0.22, chips: 1.5, chipColor: "rgba(60,40,30,0.8)" });
  const c = el.getContext("2d")!;
  // welded plate seams
  c.strokeStyle = "rgba(40,20,12,0.55)"; c.lineWidth = 2;
  c.strokeRect(1, 1, size - 2, size / 2 - 2); c.strokeRect(size / 2, size / 2, size / 2 - 1, size / 2 - 1); c.strokeRect(1, size / 2, size / 2 - 1, size / 2 - 1);
  return el;
}

function algaeTile(size: number) {
  const el = baseTile(size, "#4e5a3a", { seed: 121, grime: 0.4, noise: 0.35 });
  const c = el.getContext("2d")!;
  splotches(c, 0, 0, size, size, { n: 80, rMin: size * 0.005, rMax: size * 0.02, color: "#dcd6c4", alpha: 0.6, seed: 122 });
  splotches(c, 0, 0, size, size, { n: 40, rMin: size * 0.02, rMax: size * 0.08, color: "#6f9a3a", alpha: 0.35, seed: 123 });
  return el;
}

// ------------------------------------------------------------------------------------------------ weathering patch
export interface WeatherOpts {
  /** macro tone variation amplitude (0..0.3) */
  vary?: number;
  /** world y where the ground grime starts (default 0) and its height (m) */
  grimeY?: number; grimeH?: number; grime?: number;
  /** grime colour (linear multiply target) */
  grimeColor?: string;
  /** extra roughness from grime */
  grimeRough?: number;
  /** macro noise scales (1/m) */
  scale?: [number, number];
  /** world-space vertical rust runs (gravity streaks, ~0.6–1.5 m wide, several m long): darkening amount 0..1 */
  streak?: number;
  /** colour the streaks bleed toward (default dark rust) */
  streakColor?: string;
}
const WEATHER_GLSL = /* glsl */ `
varying vec3 vHarborWP;
uniform vec4 uHW;   // vary, grimeY, grimeH, grime
uniform vec4 uHW2;  // grimeRough, scaleA, scaleB, -
uniform vec3 uHWC;  // grime colour
uniform vec4 uHW3;  // streak amount, -, -, -
uniform vec3 uHWS;  // streak colour
float hwHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float hwNoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hwHash(i), hwHash(i + vec3(1,0,0)), f.x), mix(hwHash(i + vec3(0,1,0)), hwHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hwHash(i + vec3(0,0,1)), hwHash(i + vec3(1,0,1)), f.x), mix(hwHash(i + vec3(0,1,1)), hwHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
`;
/** install the world-space weathering layer on a standard material (chains any existing onBeforeCompile) */
export function weather(m: THREE.MeshStandardMaterial, o: WeatherOpts = {}): THREE.MeshStandardMaterial {
  const uHW = { value: new THREE.Vector4(o.vary ?? 0.12, o.grimeY ?? 0, o.grimeH ?? 1.6, o.grime ?? 0.35) };
  const uHW2 = { value: new THREE.Vector4(o.grimeRough ?? 0.25, o.scale?.[0] ?? 0.13, o.scale?.[1] ?? 0.029, 0) };
  const uHWC = { value: new THREE.Color(o.grimeColor ?? "#6b5a45") };
  const uHW3 = { value: new THREE.Vector4(o.streak ?? 0, 0, 0, 0) };
  const uHWS = { value: new THREE.Color(o.streakColor ?? "#3a1a0c") };
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = function (shader, renderer) {
    prev.call(this, shader, renderer);
    shader.uniforms.uHW = uHW; shader.uniforms.uHW2 = uHW2; shader.uniforms.uHWC = uHWC; shader.uniforms.uHW3 = uHW3; shader.uniforms.uHWS = uHWS;
    shader.vertexShader = "varying vec3 vHarborWP;\n" + shader.vertexShader.replace("#include <project_vertex>", `#include <project_vertex>
      vec4 hwp = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        hwp = instanceMatrix * hwp;
      #endif
      #ifdef USE_BATCHING
        hwp = batchingMatrix * hwp;
      #endif
      vHarborWP = (modelMatrix * hwp).xyz;`);
    shader.fragmentShader = WEATHER_GLSL + shader.fragmentShader
      .replace("#include <map_fragment>", `#include <map_fragment>
        float hwA = hwNoise(vHarborWP * uHW2.y), hwB = hwNoise(vHarborWP * uHW2.z + 7.3);
        float hwN = hwA * 0.55 + hwB * 0.45;
        float hwG = (1.0 - smoothstep(uHW.y, uHW.y + uHW.z * (0.6 + 0.8 * hwA), vHarborWP.y)) * uHW.w;
        diffuseColor.rgb *= 1.0 + (hwN - 0.5) * 2.0 * uHW.x;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uHWC, hwG);
        if (uHW3.x > 0.0) {
          vec3 hwq = vHarborWP * vec3(1.15, 0.055, 1.15);
          float hwS = hwNoise(hwq) * 0.65 + hwNoise(hwq * 2.3 + 3.1) * 0.35;
          float hwRun = smoothstep(0.52, 0.8, hwS) * (0.55 + 0.45 * hwNoise(vHarborWP * vec3(0.4, 0.9, 0.4)));
          diffuseColor.rgb = mix(diffuseColor.rgb, uHWS, hwRun * uHW3.x);
          diffuseColor.rgb *= 1.0 + (1.0 - smoothstep(0.12, 0.35, hwS)) * 0.22 * uHW3.x;
        }`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + hwG * uHW2.x + (hwN - 0.5) * 0.12, 0.04, 1.0);`);
  };
  const prevKey = m.customProgramCacheKey.bind(m);
  m.customProgramCacheKey = () => prevKey() + "|hw2";
  (m.userData as { weather?: unknown }).weather = { uHW, uHW2, uHWC, uHW3, uHWS };
  return m;
}

// ------------------------------------------------------------------------------------------------ factory
const paintCache = new Map<string, THREE.MeshStandardMaterial>();
/** a painted-steel material in any colour (shares the harbor tiles; cached by key) */
export function paint(hex: string, o: { rough?: number; metal?: number; seed?: number; grime?: number; tile?: number; name?: string } = {}): THREE.MeshStandardMaterial {
  const key = `${hex}|${o.rough ?? 0.5}|${o.metal ?? 0.05}|${o.grime ?? 0.28}|${o.tile ?? 2}`;
  let m = paintCache.get(key);
  if (!m) {
    // (ONE neutral painted tile tinted by the colour — a paint() painting its own 512² tile on the
    // main thread costs 20–40 ms each, inside the parts' build tasks; the tile is painted by the texture worker)
    const mats = harborMats();
    const col = new THREE.Color(hex).multiplyScalar(1 / NEUTRAL_LIN);
    m = weather(new THREE.MeshStandardMaterial({ map: T("neutral"), color: col, roughnessMap: mats.yellowPaint.roughnessMap, roughness: o.rough ?? 0.5, metalness: o.metal ?? 0.05, normalMap: mats.dentNormal, normalScale: new THREE.Vector2(0.3, 0.3) }), { grime: o.grime ?? 0.28 });
    m.name = o.name ?? `paint-${hex}`;
    tileMetres(m, o.tile ?? 2);
    paintCache.set(key, m);
  }
  return m;
}

/** the warehouses' corrugated roof sheet (moved here from warehouse.ts so the texture worker paints it) */
function roofTile(kind: "yellow" | "grey"): { color: HTMLCanvasElement; normal: HTMLCanvasElement } {
  const S = 1024, ribs = 16;
  const [el, c] = canvas(S, S), [hel, hc] = canvas(S, S);
  const base = kind === "yellow" ? "#f0c648" : "#c7cccf";
  c.fillStyle = base; c.fillRect(0, 0, S, S);
  hc.fillStyle = "#808080"; hc.fillRect(0, 0, S, S);
  const rw = S / ribs;
  for (let i = 0; i < ribs; i++) {
    const x = i * rw;
    const g = c.createLinearGradient(x, 0, x + rw, 0);
    g.addColorStop(0, "rgba(255,255,255,0.22)"); g.addColorStop(0.2, "rgba(255,255,255,0.06)"); g.addColorStop(0.5, "rgba(0,0,0,0.04)"); g.addColorStop(0.72, "rgba(0,0,0,0.2)"); g.addColorStop(1, "rgba(0,0,0,0.02)");
    c.fillStyle = g; c.fillRect(x, 0, rw, S);
    const h = hc.createLinearGradient(x, 0, x + rw, 0);
    h.addColorStop(0, "#1a1a1a"); h.addColorStop(0.18, "#e8e8e8"); h.addColorStop(0.5, "#e8e8e8"); h.addColorStop(0.68, "#1a1a1a"); h.addColorStop(1, "#1a1a1a");
    hc.fillStyle = h; hc.fillRect(x, 0, rw, S);
  }
  // sheet laps across the ribs (v = arc length): dark step + fixing screws
  for (let y = 0; y < S; y += S / 3.33) {
    c.fillStyle = "rgba(0,0,0,0.28)"; c.fillRect(0, y, S, 3); c.fillStyle = "rgba(255,255,255,0.2)"; c.fillRect(0, y + 3, S, 2);
    hc.fillStyle = "#404040"; hc.fillRect(0, y, S, 3);
    for (let x = rw * 0.1; x < S; x += rw) { c.fillStyle = "rgba(40,40,40,0.6)"; c.beginPath(); c.arc(x, y + 9, 2.2, 0, Math.PI * 2); c.fill(); }
  }
  paintNoise(c, 0, 0, S, S, { seed: kind === "yellow" ? 511 : 512, scale: S * 1.4, alpha: 0.22, blend: "overlay" });
  if (kind === "yellow") edgeShade(c, 0, 0, S, S, { size: S * 0.6, color: "rgba(255,250,225,1)", alpha: 0.2, sides: ["top"], blend: "screen" });
  // rust weeping from the laps + a few patches, grime in the valleys
  streaks(c, 0, 4, S, S, { n: 34, color: "rgba(135,78,40,1)", alpha: kind === "yellow" ? 0.32 : 0.26, lenMin: S * 0.06, lenMax: S * 0.3, width: rw * 0.18, seed: 513, blend: "multiply" });
  splotches(c, 0, 0, S, S, { n: 10, rMin: S * 0.02, rMax: S * 0.07, color: "rgba(150,90,45,1)", alpha: 0.2, seed: 514, blend: "multiply" });
  return { color: el, normal: normalFromHeight(hel, 5) };
}
// ------------------------------------------------------------------------------------------------ painted off-thread
/** every texture the harbor paints, in named groups (a group paints its maps together: color + normal + rough from
 *  one height field). `harborMatsAsync()` paints them in worker threads (harbor-tex.worker.ts, OffscreenCanvas) and
 *  the main thread only uploads ImageBitmaps; `harborMats()` alone still paints any missing one live. */
const NEUTRAL_HEX = "#bdbdbd", NEUTRAL_LIN = new THREE.Color(NEUTRAL_HEX).r;
type Cv = HTMLCanvasElement;
const one = (k: string, f: () => Cv) => (): Record<string, Cv> => ({ [k]: f() });
const trio = (k: string, f: () => { color: Cv; normal: Cv; rough?: Cv }) => (): Record<string, Cv> => { const t = f(); const o: Record<string, Cv> = { [`${k}.color`]: t.color, [`${k}.normal`]: t.normal }; if (t.rough) o[`${k}.rough`] = t.rough; return o; };
/** the moored ship's hull plating: strakes + butts (14 × 9.6 m tile), weld seams, fender scuffs, a little rust (moved from
 *  peel-harbor/ship.ts so the texture worker paints it) */
function shipHullTile(): { color: Cv; normal: Cv } {
  const W = 1024, H = 704, MX = W / 14, MY = H / 9.6;   // px per metre (≈ 1.4 cm)
  const [el, c] = canvas(W, H), [hel, hc] = canvas(W, H);
  c.fillStyle = "#313a45"; c.fillRect(0, 0, W, H);
  paintNoise(c, 0, 0, W, H, { seed: 301, scale: 900, alpha: 0.22, blend: "overlay" });
  hc.fillStyle = "#808080"; hc.fillRect(0, 0, W, H);
  paintNoise(hc, 0, 0, W, H, { seed: 302, scale: 300, alpha: 0.25, blend: "overlay" });
  const R = rng(303);
  // strakes (tile-wrapping in y: they sum to 9.6 m)
  const strakes = [2.2, 2.6, 2.0, 2.8];
  const seams: Array<[number, number, number, number]> = [];
  let y0 = 0;
  for (const sh of strakes) {
    const yA = y0 * MY, yB = (y0 + sh) * MY;
    let x = R() * 3 * MX;
    const butts: number[] = [];
    while (x < W + 7 * MX) { butts.push(x); x += (3 + R() * 4) * MX; }
    for (let i = 0; i < butts.length - 1; i++) {
      const xa = butts[i], xb = butts[i + 1], tone = 0.93 + R() * 0.14;
      c.fillStyle = `rgba(${Math.round(49 * tone)},${Math.round(58 * tone)},${Math.round(69 * tone)},0.55)`;
      for (const ox of [-W, 0]) c.fillRect(xa + ox, yA, xb - xa, yB - yA);
      // pillowed plate (height rises toward the middle between frames)
      const g = hc.createLinearGradient(0, yA, 0, yB); g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, "rgba(255,255,255,0.1)"); g.addColorStop(1, "rgba(255,255,255,0)");
      hc.fillStyle = g; for (const ox of [-W, 0]) hc.fillRect(xa + ox, yA, xb - xa, yB - yA);
      seams.push([(xa % W + W) % W, yA, 0, yB - yA]);
    }
    seams.push([0, yA, W, 0]);
    y0 += sh;
  }
  // weld seams: a thin dark groove + a lighter bead (strakes crisp, butts fainter)
  for (const [x, y, w, h] of seams) {
    if (w) { c.fillStyle = "rgba(10,10,12,0.75)"; c.fillRect(0, y, W, 3); c.fillStyle = "rgba(160,170,182,0.18)"; c.fillRect(0, y + 3, W, 2); hc.fillStyle = "#303030"; hc.fillRect(0, y, W, 3); hc.fillStyle = "#d8d8d8"; hc.fillRect(0, y + 3, W, 3); }
    else { c.fillStyle = "rgba(10,10,12,0.55)"; c.fillRect(x, y, 2.5, h); c.fillStyle = "rgba(160,170,182,0.12)"; c.fillRect(x + 2.5, y, 1.5, h); hc.fillStyle = "#3a3a3a"; hc.fillRect(x, y, 2.5, h); hc.fillStyle = "#c8c8c8"; hc.fillRect(x + 2.5, y, 2, h); }
  }
  // fender / tug scuffs: thin grey rubs along ONE strake, clustered
  for (let i = 0; i < 12; i++) { const y = H * 0.47 + (R() - 0.5) * 40, x = W * 0.2 + R() * W * 0.45; c.fillStyle = `rgba(${130 + R() * 40},${128 + R() * 30},${120 + R() * 30},${0.1 + R() * 0.14})`; c.fillRect(x, y, 40 + R() * 180, 1.5 + R() * 2.5); }
  // sparse uneven rust: only a few seams weep (clusters), long thin runs + a couple of heavy blooms
  for (let k = 0; k < 5; k++) {
    const sx = R() * W, sy = seams[Math.floor(R() * seams.length)][1] + 2, n = 2 + Math.floor(R() * 5);
    streaks(c, sx - 30, sy, 60 + R() * 60, H * 0.5, { n, color: "rgba(118,60,28,1)", alpha: 0.5, lenMin: 30, lenMax: 220, width: 4, seed: 305 + k, blend: "source-over" });
  }
  splotches(c, 0, 0, W, H, { n: 8, rMin: 6, rMax: 20, color: "rgba(126,66,32,1)", alpha: 0.35, seed: 306 });
  splotches(c, 0, 0, W, H, { n: 16, rMin: 3, rMax: 10, color: "rgba(140,140,135,1)", alpha: 0.25, seed: 307 });
  return { color: el, normal: normalFromHeight(hel, 2.4) };
}
export const TEX_GROUPS: Record<string, () => Record<string, Cv>> = {
  dn: one("dn", () => dentNormal()),
  yellow: one("yellow", () => baseTile(1024, "#f2c010", { seed: 101, grime: 0.0, streaks: 0.09, scratches: 0.1, noise: 0.08, chips: 0.18 })),
  red: one("red", () => baseTile(512, "#9c3522", { seed: 111, grime: 0.1, streaks: 0.18, scratches: 0.12, chips: 0.4 })),
  white: one("white", () => baseTile(1024, "#f1eee6", { seed: 121, grime: 0.06, streaks: 0.24, noise: 0.08, chips: 0.3 })),
  galv: one("galv", () => baseTile(256, "#a9aeb1", { seed: 131, noise: 0.3, scratches: 0.25 })),
  steel: one("steel", () => baseTile(256, "#44484c", { seed: 141, noise: 0.25, scratches: 0.3 })),
  dark: one("dark", () => baseTile(512, "#3a3e42", { seed: 145, noise: 0.14, scratches: 0.2, grime: 0.08, chips: 0.3 })),
  rubber: one("rubber", () => baseTile(256, "#1d1d1e", { seed: 151, noise: 0.16 })),
  rust: trio("rust", () => rustTile(1024)),
  concrete: trio("concrete", () => concreteTile(1024, "#a8a092", 161, true)),
  slab: trio("slab", () => concreteTile(1024, "#cdc2ad", 163, false)),
  quay: trio("quay", () => quayWallTile(512)),
  wood: trio("wood", () => woodTile(512)),
  corrG: trio("corrG", () => corrugatedTile(512, "#b5b9bb", 171, 0.12)),
  corrY: trio("corrY", () => corrugatedTile(512, "#f0c341", 181, 0.4)),
  hazard: one("hazard", () => hazardTile(512)),
  ply: one("ply", () => baseTile(512, "#cfae7c", { seed: 191, grime: 0.24, noise: 0.24, scratches: 0.25 })),
  wallW: trio("wallW", () => concreteTile(512, "#ece8df", 201, false)),
  blue: one("blue", () => baseTile(512, "#2e67b8", { seed: 221, grime: 0.08, streaks: 0.16, scratches: 0.15, chips: 0.4 })),
  green: one("green", () => baseTile(512, "#3f8a3a", { seed: 231, grime: 0.08, streaks: 0.16, scratches: 0.15, chips: 0.4 })),
  tankW: one("tankW", () => baseTile(1024, "#f3f1ea", { seed: 241, grime: 0.1, streaks: 0.4, noise: 0.08 })),
  rope: one("rope", () => baseTile(128, "#c9a36a", { seed: 251, noise: 0.4 })),
  asph: trio("asph", () => concreteTile(512, "#5c5a57", 261, false)),
  rock: trio("rock", () => rockTile(512)),
  moss: trio("moss", () => mossTile(512)),
  rough: one("rough", () => roughTile(512, 0.5, 0.5)),
  roughMatte: one("roughMatte", () => roughTile(512, 0.85, 0.3, 5)),
  banana: one("banana", () => bananaTile(256)),
  deck: one("deck", () => deckTile(512)),
  algae: one("algae", () => algaeTile(512)),
  roofY: trio("roofY", () => roofTile("yellow")),
  roofG: trio("roofG", () => roofTile("grey")),
  shipHull: trio("shipHull", () => shipHullTile()),
  neutral: one("neutral", () => baseTile(512, NEUTRAL_HEX, { seed: 211, grime: 0.07, streaks: 0.16, scratches: 0.14, noise: 0.1, chips: 0.3 })),
};
/** the worker's entry: paint these groups → name → canvas */
export function paintTexGroups(groups: string[]): Record<string, Cv> { const out: Record<string, Cv> = {}; for (const g of groups) Object.assign(out, TEX_GROUPS[g]()); return out; }
const PRE = new Map<string, ImageBitmap>(), LIVE = new Map<string, Cv>();
const groupOf = (name: string) => name.split(".")[0];
/** a named harbor texture: the worker's ImageBitmap (pre-flipped) when it arrived, else painted live */
export function harborTex(name: string, o: TexOpts = {}): THREE.Texture { return T(name, o); }
function T(name: string, o: TexOpts = {}): THREE.Texture {
  const bm = PRE.get(name);
  if (bm) {
    const t = new THREE.Texture(bm as unknown as HTMLImageElement);
    t.colorSpace = (o.srgb ?? true) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.wrapS = t.wrapT = (o.repeat ?? true) ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    t.anisotropy = o.aniso ?? 8; t.flipY = false; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.needsUpdate = true;
    return t;
  }
  if (!LIVE.has(name)) for (const [k, c] of Object.entries(TEX_GROUPS[groupOf(name)]())) LIVE.set(k, capped(c));
  return tex(LIVE.get(name)!, o);
}
/** paint the harbor's textures in worker threads, then build the materials (≈ 1 s of main-thread painting
 *  becomes ImageBitmap uploads). Falls back to painting on the main thread if workers are unavailable. */
let pending: Promise<HarborMats> | null = null;
export function harborMatsAsync(): Promise<HarborMats> {
  if (cache) return Promise.resolve(cache);
  return (pending ??= (async () => {
    if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined") {
      try {
        const pool = workerPool(() => new Worker(new URL("./harbor-tex.worker.ts", import.meta.url), { type: "module" }), 4);
        // balanced by cost (1024² tiles + normal maps first, round-robin)
        const order = ["rust", "concrete", "slab", "roofY", "roofG", "shipHull", "yellow", "white", "tankW", "dn", "wood", "quay", "corrG", "corrY", "wallW", "asph", "rock", "moss", "red", "dark", "hazard", "ply", "blue", "green", "deck", "algae", "neutral", "rough", "roughMatte", "galv", "steel", "rubber", "rope", "banana"];
        const chunks: string[][] = [[], [], [], []];
        order.forEach((g, i) => chunks[i % 4].push(g));
        const res = await Promise.all(chunks.map((c) => pool.run<{ bm: Record<string, ImageBitmap>; means: Record<string, [number, number, number]> }>("paintMeans", c)));
        pool.close();
        const done = await Promise.all(res.flatMap((r) => Object.entries(r.bm).map(async ([k, raw]) => [k, await cappedBitmap(raw), r.means[k]] as const)));
        for (const [k, v, mn] of done) { PRE.set(k, v); if (mn) presetImageMean(v, mn); }
      } catch (e) { console.warn("[harbor] texture worker failed — painting on the main thread", e); }
    }
    return harborMats();
  })());
}

export function harborMats(): HarborMats {
  if (cache) return cache;
  const dn = T("dn", { srgb: false });
  const std = (o: THREE.MeshStandardMaterialParameters, name: string, w?: WeatherOpts | false) => {
    const m = new THREE.MeshStandardMaterial(o); m.name = name;
    return w === false ? m : weather(m, w);
  };
  const rough = T("rough", { srgb: false });
  const roughMatte = T("roughMatte", { srgb: false });

  cache = {
    dentNormal: dn,
    yellowPaint: std({ map: T("yellow"), roughnessMap: rough, roughness: 0.52, metalness: 0.04, normalMap: dn, normalScale: new THREE.Vector2(0.3, 0.3) }, "yellowPaint", { grime: 0.3, grimeY: 3.6, grimeH: 2.5 }),
    redPaint: std({ map: T("red"), roughnessMap: rough, roughness: 0.55, metalness: 0.04, normalMap: dn, normalScale: new THREE.Vector2(0.3, 0.3) }, "redPaint"),
    whitePaint: std({ map: T("white"), roughnessMap: rough, roughness: 0.48, metalness: 0.02, normalMap: dn, normalScale: new THREE.Vector2(0.25, 0.25) }, "whitePaint", { grime: 0.2, vary: 0.08 }),
    blackHull: std({ color: "#23282b", roughness: 0.42, metalness: 0.1, normalMap: dn, normalScale: new THREE.Vector2(0.45, 0.45), roughnessMap: rough }, "blackHull", { vary: 0.2, grime: 0 }),
    bootRed: std({ color: "#b8381f", roughness: 0.55, metalness: 0.04, normalMap: dn, normalScale: new THREE.Vector2(0.4, 0.4), roughnessMap: rough }, "bootRed", { vary: 0.15, grime: 0.5, grimeY: -3, grimeH: 2.5, grimeColor: "#4a5a3a" }),
    galv: std({ map: T("galv"), roughness: 0.42, metalness: 0.75, roughnessMap: rough }, "galv", { vary: 0.1, grime: 0.15 }),
    steel: std({ map: T("steel"), roughness: 0.4, metalness: 0.8, roughnessMap: rough }, "steel", { vary: 0.1, grime: 0.1 }),
    rust: std({ map: T("rust.color"), normalMap: T("rust.normal", { srgb: false }), normalScale: new THREE.Vector2(1, 1), roughnessMap: T("rust.rough", { srgb: false }), roughness: 1, metalness: 0.15 }, "rust", { vary: 0.22, grime: 0.4, grimeY: -1, grimeH: 3, grimeColor: "#3d4a2c" }),
    concrete: std({ map: T("concrete.color"), normalMap: T("concrete.normal", { srgb: false }), normalScale: new THREE.Vector2(0.6, 0.6), roughness: 0.9, metalness: 0, roughnessMap: roughMatte }, "concrete", { vary: 0.22, grime: 0.25, grimeY: 3.5, grimeH: 0.5, scale: [0.06, 0.013] }),
    quayWall: std({ map: T("quay.color"), normalMap: T("quay.normal", { srgb: false }), normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.85, metalness: 0.05 }, "quayWall", { vary: 0.14, grime: 0 }),
    hazard: std({ map: T("hazard"), roughness: 0.6, metalness: 0.04, normalMap: dn, normalScale: new THREE.Vector2(0.3, 0.3) }, "hazard", { vary: 0.1, grime: 0.1 }),
    wood: std({ map: T("wood.color"), normalMap: T("wood.normal", { srgb: false }), normalScale: new THREE.Vector2(0.8, 0.8), roughness: 0.85, metalness: 0 }, "wood", { vary: 0.15, grime: 0.3, grimeY: 0.5, grimeH: 2, grimeColor: "#4f5a44" }),
    corrugatedGrey: std({ map: T("corrG.color"), normalMap: T("corrG.normal", { srgb: false }), normalScale: new THREE.Vector2(1, 1), roughness: 0.5, metalness: 0.35, roughnessMap: rough }, "corrugatedGrey", { vary: 0.12, grime: 0 }),
    corrugatedYellow: std({ map: T("corrY.color"), normalMap: T("corrY.normal", { srgb: false }), normalScale: new THREE.Vector2(1, 1), roughness: 0.55, metalness: 0.15, roughnessMap: rough }, "corrugatedYellow", { vary: 0.14, grime: 0 }),
    rubber: std({ map: T("rubber"), roughness: 0.88, metalness: 0 }, "rubber", { vary: 0.1, grime: 0.2 }),
    glass: new THREE.MeshPhysicalMaterial({ color: "#6fb7c9", roughness: 0.05, metalness: 0.1, transmission: 0, opacity: 0.55, transparent: true, envMapIntensity: 1.2, name: "glass" }),
    banana: std({ map: T("banana"), roughness: 0.42, metalness: 0 }, "banana", false),
    plywood: std({ map: T("ply"), roughness: 0.82, metalness: 0, normalMap: dn, normalScale: new THREE.Vector2(0.3, 0.3) }, "plywood", { grime: 0.2 }),
    darkPaint: std({ map: T("dark"), roughnessMap: rough, roughness: 0.5, metalness: 0.2, normalMap: dn, normalScale: new THREE.Vector2(0.3, 0.3) }, "darkPaint", { grime: 0.15 }),
    wallWhite: std({ map: T("wallW.color"), normalMap: T("wallW.normal", { srgb: false }), normalScale: new THREE.Vector2(0.5, 0.5), roughness: 0.85, metalness: 0, roughnessMap: roughMatte }, "wallWhite", { grime: 0.35, grimeY: 3.6, grimeH: 1.4, vary: 0.08 }),
    windowDark: std({ color: "#1d3a4a", roughness: 0.08, metalness: 0.6, envMapIntensity: 1.4 }, "windowDark", false),
    deck: std({ map: T("deck"), roughness: 0.62, metalness: 0.05, normalMap: dn, normalScale: new THREE.Vector2(0.4, 0.4), roughnessMap: rough }, "deck", { vary: 0.14, grime: 0 }),
    interior: std({ color: "#1b1a18", roughness: 0.95, metalness: 0 }, "interior", false),
    bluePaint: std({ map: T("blue"), roughnessMap: rough, roughness: 0.5, metalness: 0.04, normalMap: dn, normalScale: new THREE.Vector2(0.3, 0.3) }, "bluePaint"),
    greenPaint: std({ map: T("green"), roughnessMap: rough, roughness: 0.55, metalness: 0.04, normalMap: dn, normalScale: new THREE.Vector2(0.3, 0.3) }, "greenPaint"),
    lampLens: std({ color: "#fff4dc", emissive: new THREE.Color("#ffe3a8"), emissiveIntensity: 0.6, roughness: 0.2, metalness: 0 }, "lampLens", false),
    warnLight: std({ color: "#ff3b22", emissive: new THREE.Color("#ff2a10"), emissiveIntensity: 1.6, roughness: 0.25, metalness: 0 }, "warnLight", false),
    rope: std({ map: T("rope"), roughness: 0.9, metalness: 0 }, "rope", false),
    asphalt: std({ map: T("asph.color"), normalMap: T("asph.normal", { srgb: false }), roughness: 0.92, metalness: 0 }, "asphalt", { vary: 0.1, grime: 0 }),
    cable: std({ color: "#2a2c2e", roughness: 0.4, metalness: 0.85 }, "cable", false),
    tankWhite: std({ map: T("tankW"), roughnessMap: rough, roughness: 0.42, metalness: 0.05, normalMap: dn, normalScale: new THREE.Vector2(0.2, 0.2) }, "tankWhite", { grime: 0.35, grimeY: 3.6, grimeH: 2.2, vary: 0.06, grimeColor: "#8a7a5e" }),
    algae: std({ map: T("algae"), roughness: 0.8, metalness: 0, normalMap: dn, normalScale: new THREE.Vector2(0.8, 0.8) }, "algae", { vary: 0.2, grime: 0 }),
    rock: std({ map: T("rock.color"), normalMap: T("rock.normal", { srgb: false }), normalScale: new THREE.Vector2(1.2, 1.2), roughness: 0.85, metalness: 0 }, "rock", { vary: 0.18, grime: 0.5, grimeY: -0.5, grimeH: 1.2, grimeColor: "#3f4a36" }),
    moss: std({ map: T("moss.color"), normalMap: T("moss.normal", { srgb: false }), normalScale: new THREE.Vector2(1, 1), roughness: 0.95, metalness: 0 }, "moss", { vary: 0.2, grime: 0 }),
  };
  const tiles: Array<[keyof HarborMats, number]> = [["yellowPaint", 3], ["redPaint", 2], ["whitePaint", 3], ["blackHull", 3], ["bootRed", 3], ["galv", 1], ["steel", 1], ["rust", 4], ["concrete", 5], ["quayWall", 4], ["wood", 1.2], ["corrugatedGrey", 1], ["corrugatedYellow", 1], ["rubber", 1], ["plywood", 1], ["darkPaint", 2], ["wallWhite", 3], ["deck", 4], ["bluePaint", 2], ["greenPaint", 2], ["rope", 0.3], ["asphalt", 4], ["tankWhite", 4], ["algae", 2], ["rock", 3], ["moss", 2]];
  for (const [k, t] of tiles) tileMetres(cache[k] as THREE.MeshStandardMaterial, t);
  tileMetres(cache.hazard, 2, 0.5);
  // palette merges (Builder.build({ palette })): vertex colour × dents, weathered like the rest
  const pal = weather(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.58, metalness: 0.05, normalMap: dn, normalScale: new THREE.Vector2(0.3, 0.3), roughnessMap: rough, name: "harbor-palette" }), { grime: 0.3, vary: 0.1 });
  tileMetres(pal, 2);
  setPaletteMaterial(pal);
  // quay wall: one tile spans the full wall height (−6 … +3.6 m) so the tide band sits at sea level
  tileMetres(cache.quayWall, 4, 9.6);
  for (const k of ["map", "normalMap"] as const) cache.quayWall[k]!.offset.set(0, 6 / 9.6);
  void noiseTile;
  return cache;
}

/** set a material's maps to repeat every `metres` (u) / `metresV` (v) on geometry whose UVs are in metres */
export function tileMetres(m: THREE.MeshStandardMaterial, metres: number, metresV = metres) {
  for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap"] as const) {
    const t = m[k]; if (t) t.repeat.set(1 / metres, 1 / metresV);
  }
}

/** rewrite a BoxGeometry-like geometry's UVs so that 1 uv unit = 1 metre on every face (triplanar-ish by face normal) */
export function uvMetres(g: THREE.BufferGeometry, scale = 1): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  if (!g.attributes.normal) g.computeVertexNormals();
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let u: number, v: number;
    if (ny >= nx && ny >= nz) { u = x; v = z; } else if (nx >= nz) { u = z; v = y; } else { u = x; v = y; }
    uv[i * 2] = u * scale; uv[i * 2 + 1] = v * scale;
  }
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return g;
}
