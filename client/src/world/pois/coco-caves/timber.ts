// COCO CAVES timber + buildings + props, every piece derived from the shared layout (shared/pois/coco-caves.ts) that the
// server collides with: decks (planks, beams, piles, rope-and-post rails), solid step blocks, the smugglers' DEN and the
// MINE OFFICE (plank walls with real thickness + openings, frames, floors, ceilings, stairs, furniture), the hoist
// tower + headframe, crates ("BANANA CO."), barrels, the boat, the mine cart + rails, lanterns.
// Geometry is merged per material through GeoBins (poi-town kit) into a handful of draws; all materials take the cave
// light patch.
import * as THREE from "three";
import type { WorldCtx } from "../../../engine/engine";
import { shareTexture } from "../../../engine/texture-release";
import { GeoBin, M, col, cylGeo, tubeGeo, catenary, chamferBoxGeo } from "../_kit/town-geo";
import type { TownBins, BinName } from "../_kit/town-materials";
import { addBarrel } from "../_kit/town-props";
import { addLongboat } from "../_kit/town-boat";
import { ropeTex, crateTex, mulberry } from "../_kit/jungle-mat";
import { TIMBER, HUTS, deckCurbs, LEDGE, DEN, PROPS, PROP_HALF, TOWER, SKY, GABLE_RISE, WATER_Y, groundAt, hutPieces, hutToWorld, stairSteps, stairRails, deckPiles, postHalf, type CDeck, type CStair, type HutSpec, type CProp } from "../../../../../shared/pois/coco-caves";
import { cavePatch } from "./light";

const WOOD = "#e6c9a0", WOOD_D = "#9a8068", WOOD_L = "#f4e0c0", BEAM = "#b09070", PLANK_WALL = "#dcc4a0", IRON = "#3a3634";

export interface TimberMats { wood: THREE.MeshStandardMaterial; wall: THREE.MeshStandardMaterial; metal: THREE.MeshStandardMaterial; glass: THREE.MeshStandardMaterial; bulb: THREE.MeshStandardMaterial; rope: THREE.MeshStandardMaterial; cloth: THREE.MeshStandardMaterial; crate: THREE.MeshStandardMaterial; tin: THREE.MeshStandardMaterial; sign: THREE.MeshStandardMaterial; gold: THREE.MeshStandardMaterial; leaf: THREE.MeshStandardMaterial; net: THREE.MeshStandardMaterial }
export function timberMats(ctx: WorldCtx): TimberMats {
  // Poly Haven CC0 planks (public/assets/pois/caves/tex/SOURCES.json), warmed + lifted toward a toy timber look
  const plankMat = (name: string, set: "deck" | "wall", tile: number, color: [number, number, number]) => {
    const m = new THREE.MeshStandardMaterial({ name, vertexColors: true, roughness: 1, color: new THREE.Color(...color) });
    Promise.all([ctx.assets.texture(`assets/pois/caves/tex/${set}-d.webp`), ctx.assets.texture(`assets/pois/caves/tex/${set}-n.webp`, { srgb: false }), ctx.assets.texture(`assets/pois/caves/tex/${set}-arm.webp`, { srgb: false })]).then(([d, n, arm]) => {
      const rep = (t: THREE.Texture) => { const c = shareTexture(t); c.wrapS = c.wrapT = THREE.RepeatWrapping; c.repeat.set(1 / tile, 1 / tile); return c; };
      m.map = rep(d); m.normalMap = rep(n); m.roughnessMap = rep(arm); m.aoMap = null; m.needsUpdate = true;
    }).catch(() => {});
    return m;
  };
  const wood = plankMat("caves:wood", "deck", 1.8, [1.4, 1.2, 1.0]);
  const wall = plankMat("caves:wall", "wall", 1.4, [1.12, 1.04, 0.94]);
  const metal = new THREE.MeshStandardMaterial({ name: "caves:metal", vertexColors: true, roughness: 0.55, metalness: 0.6, color: "#ffffff" });
  const glass = new THREE.MeshStandardMaterial({ name: "caves:glass", vertexColors: true, roughness: 0.3, color: "#fff2c8", emissive: "#ffb347", emissiveIntensity: 2.2 });
  const bulb = new THREE.MeshStandardMaterial({ name: "caves:bulb", vertexColors: true, color: "#fff4d0", emissive: "#ffd27a", emissiveIntensity: 5 });
  const rope = new THREE.MeshStandardMaterial({ name: "caves:rope", map: ropeTex(), vertexColors: true, roughness: 0.95, color: "#f6ead4" });
  const cloth = new THREE.MeshStandardMaterial({ name: "caves:cloth", vertexColors: true, roughness: 0.95, color: "#ffffff" });
  const crate = new THREE.MeshStandardMaterial({ name: "caves:crate", map: crateTex("BANANA CO."), roughness: 0.85, color: "#ffffff" });
  const tin = new THREE.MeshStandardMaterial({ name: "caves:tin", vertexColors: true, roughness: 0.6, metalness: 0.35, color: "#ffffff", side: THREE.DoubleSide });
  const sign = new THREE.MeshStandardMaterial({ name: "caves:sign", map: signTex(), roughness: 0.75 });
  // raw gold: metallic, a warm self-glow so the piles sparkle in the cave light
  const gold = new THREE.MeshStandardMaterial({ name: "caves:gold", vertexColors: true, roughness: 0.28, metalness: 0.85, color: "#ffffff", emissive: "#b87a10", emissiveIntensity: 0.35, flatShading: true });
  cloth.map = burlapTex();
  for (const m of [wood, wall, metal, rope, cloth, crate, tin, sign]) cavePatch(m);
  cavePatch(gold, { spec: 1 });
  cavePatch(glass, { lamp: 0.2 }); cavePatch(bulb, { lamp: 0 });
  // the POI's own 3D plants (monstera / fern clumps — foreground greenery) + a knotted fishing net
  const leaf = new THREE.MeshStandardMaterial({ name: "caves:leaf", vertexColors: true, roughness: 0.55, color: "#ffffff", side: THREE.DoubleSide });
  const net = new THREE.MeshStandardMaterial({ name: "caves:net", map: netTex(), vertexColors: true, roughness: 0.9, color: "#ffffff", side: THREE.DoubleSide, alphaTest: 0.45 });
  cavePatch(leaf); cavePatch(net);
  return { wood, wall, metal, glass, bulb, rope, cloth, crate, tin, sign, gold, leaf, net };
}
/** a diamond-mesh fishing net with knots (alpha-tested), tiles at 0.5 m */
function netTex(): THREE.CanvasTexture {
  const N = 128, c = document.createElement("canvas"); c.width = c.height = N; const g = c.getContext("2d")!;
  g.clearRect(0, 0, N, N); g.strokeStyle = "#d8c9a0"; g.lineWidth = 5;
  for (const [a, b, cc, d] of [[0, 0, N, N], [N, 0, 0, N], [-N / 2, N / 2, N / 2, N * 1.5], [N / 2, -N / 2, N * 1.5, N / 2], [N / 2, -N / 2, -N / 2, N / 2], [N * 1.5, N / 2, N / 2, N * 1.5]]) { g.beginPath(); g.moveTo(a, b); g.lineTo(cc, d); g.stroke(); }
  g.fillStyle = "#c8b888"; for (const [x, y] of [[0, 0], [N / 2, N / 2], [N, 0], [0, N], [N, N]]) { g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(2, 2); t.anisotropy = 4; return t;
}
/** coarse burlap / canvas (sacks, bedding, the map on the table): woven threads + stains, tiles at 0.6 m */
function burlapTex(): THREE.CanvasTexture {
  const N = 256, c = document.createElement("canvas"); c.width = c.height = N; const g = c.getContext("2d")!, r = mulberry(31);
  g.fillStyle = "#cdb58c"; g.fillRect(0, 0, N, N);
  for (let i = 0; i < N; i += 4) { g.fillStyle = `rgba(90,70,40,${0.12 + r() * 0.1})`; g.fillRect(i, 0, 1.6, N); g.fillStyle = `rgba(255,240,210,${0.08 + r() * 0.08})`; g.fillRect(0, i + 2, N, 1.4); }
  for (let i = 0; i < 26; i++) { g.fillStyle = `rgba(110,80,50,${0.05 + r() * 0.08})`; g.beginPath(); g.arc(r() * N, r() * N, 8 + r() * 30, 0, 7); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(1 / 0.6, 1 / 0.6); t.anisotropy = 4; return t;
}

/** the BANANA CO. / smuggler signboard (painted, weathered) */
function signTex(): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = 1024; c.height = 320; const g = c.getContext("2d")!;
  g.fillStyle = "#2f4a3a"; g.fillRect(0, 0, 1024, 320);
  for (let i = 0; i < 5; i++) { g.fillStyle = `rgba(0,0,0,${0.08 + (i % 2) * 0.06})`; g.fillRect(0, i * 64, 1024, 3); }
  g.strokeStyle = "#f2c132"; g.lineWidth = 14; g.strokeRect(22, 22, 980, 276);
  g.fillStyle = "#f2c132"; g.font = "900 150px 'Arial Black', Impact, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
  g.fillText("BANANA CO.", 512, 168);
  // wear
  const r = mulberry(5); for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(${r() < 0.5 ? "20,30,24" : "240,220,170"},${0.05 + r() * 0.12})`; g.fillRect(r() * 1024, r() * 320, 2 + r() * 10, 1 + r() * 4); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}

export class Bins {
  wood: GeoBin; wall: GeoBin; metal: GeoBin; glass: GeoBin; bulb: GeoBin; rope: GeoBin; cloth: GeoBin; crate: GeoBin; tin: GeoBin; sign: GeoBin; gold: GeoBin; leaf: GeoBin; net: GeoBin;
  /** the poi-town prop kits' bin names, aliased onto ours */
  town: TownBins;
  constructor(m: TimberMats, prefix: string) {
    this.wood = new GeoBin(`${prefix}:wood`, m.wood); this.wall = new GeoBin(`${prefix}:wall`, m.wall); this.metal = new GeoBin(`${prefix}:metal`, m.metal); this.glass = new GeoBin(`${prefix}:glass`, m.glass);
    this.bulb = new GeoBin(`${prefix}:bulb`, m.bulb); this.rope = new GeoBin(`${prefix}:rope`, m.rope); this.cloth = new GeoBin(`${prefix}:cloth`, m.cloth);
    this.crate = new GeoBin(`${prefix}:crate`, m.crate); this.tin = new GeoBin(`${prefix}:tin`, m.tin); this.sign = new GeoBin(`${prefix}:sign`, m.sign); this.gold = new GeoBin(`${prefix}:gold`, m.gold);
    // ("~" = soft for the parity check — leaves and nets are walked through, like the veg)
    this.leaf = new GeoBin(`~${prefix}:leaf`, m.leaf); this.net = new GeoBin(`~${prefix}:net`, m.net); this.net.castShadow = false;
    this.glass.castShadow = false; this.bulb.castShadow = false; this.rope.castShadow = false; this.bulb.keepTiny = true;
    const map: Partial<Record<BinName, GeoBin>> = { wood: this.wood, woodDark: this.wood, clapboard: this.wood, thatch: this.wood, louvre: this.wood, trim: this.wood, metal: this.metal, plastic: this.metal, bronze: this.metal, glass: this.glass, bulb: this.bulb, rope: this.rope, net: this.rope, fabric: this.cloth, stripes: this.cloth, tin: this.tin };
    this.town = new Proxy(map, { get: (t, k: string) => (t as Record<string, GeoBin>)[k] ?? this.wood }) as TownBins;
  }
  build(group: THREE.Group): number {
    let n = 0;
    for (const b of [this.wood, this.wall, this.metal, this.glass, this.bulb, this.rope, this.cloth, this.crate, this.tin, this.sign, this.gold, this.leaf, this.net]) { const mesh = b.build(); if (mesh) { mesh.updateMatrix(); group.add(mesh); n++; } }
    return n;
  }
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** a round post between two points */
function post(b: GeoBin, a: THREE.Vector3, c: THREE.Vector3, r: number, color = BEAM) {
  const d = c.clone().sub(a), L = d.length(), m = new THREE.Matrix4().compose(a.clone().add(c).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()), new THREE.Vector3(1, 1, 1));
  b.add(cylGeo(r * 0.92, r, L, 8), m, col(color));
}

/** a sawn square post exactly on its collider (a vertical a → b, half side h): chamfered, a darker water-stained foot */
function squarePost(B: Bins, a: [number, number, number], b: [number, number, number], h: number, color: string, rnd: () => number) {
  const L = b[1] - a[1], m = M(a[0], (a[1] + b[1]) / 2, a[2], 0);
  B.wood.bbox(h * 2, L, h * 2, m, col(color, 0.9 + rnd() * 0.15), 0.025, undefined, [rnd() * 3, rnd() * 3]);
}
// ------------------------------------------------------------------------------------------------ decks
function addDeck(B: Bins, k: CDeck, rnd: () => number) {
  const t = k.t ?? 0.22, c = Math.cos(k.yaw), s = Math.sin(k.yaw);
  const W = (lx: number, lz: number, y: number) => V(k.x + lx * c + lz * s, y, k.z - lx * s + lz * c);
  const at = (lx: number, y: number, lz: number, yaw = 0) => M(k.x + lx * c + lz * s, y, k.z - lx * s + lz * c, k.yaw + yaw);
  // planks run across the long axis
  const alongZ = k.d >= k.w, span = alongZ ? k.d : k.w, across = alongZ ? k.w : k.d, n = Math.max(1, Math.round(span / 0.3)), pw = span / n;
  for (let i = 0; i < n; i++) {
    const u = -span / 2 + (i + 0.5) * pw, tone = rnd() < 0.3 ? WOOD_L : rnd() < 0.2 ? "#b88858" : WOOD, dy = (rnd() - 0.5) * 0.012;
    if (alongZ) B.wood.bbox(across + (rnd() - 0.5) * 0.06, 0.07, pw - 0.025, at(0, k.y - 0.035 + dy, u, (rnd() - 0.5) * 0.015), col(tone), 0.012, undefined, [rnd() * 3, rnd() * 3]);
    else B.wood.bbox(pw - 0.025, 0.07, across + (rnd() - 0.5) * 0.06, at(u, k.y - 0.035 + dy, 0, (rnd() - 0.5) * 0.015), col(tone), 0.012, undefined, [rnd() * 3, rnd() * 3]);
  }
  // a dark sub-floor board 9 cm under the deck top: the 2.5 cm plank gaps show shadow, not the water / sand below (and a
  // ray through a gap still meets the floor within 0.1 m — parity "floor-mismatch" on every 1.5 m lattice line)
  B.wood.box(alongZ ? across - 0.1 : span - 0.1, 0.03, alongZ ? span - 0.1 : across - 0.1, at(0, k.y - 0.085, 0), col("#3a2a1c"));
  // joists + edge beams (under the planks, inside the collider slab)
  const jn = Math.max(2, Math.round(across / 1.1));
  for (let j = 0; j <= jn; j++) {
    const v = -across / 2 + 0.08 + (across - 0.16) * j / jn;
    if (alongZ) B.wood.box(0.14, t - 0.07, k.d - 0.04, at(v, k.y - 0.07 - (t - 0.07) / 2, 0), col(BEAM));
    else B.wood.box(k.w - 0.04, t - 0.07, 0.14, at(0, k.y - 0.07 - (t - 0.07) / 2, v), col(BEAM));
  }
  // a tall deck body (the hoist tower's base crib) is solid timber cribbing down to the bank — drawn as the collider box
  // with log courses (joists only would leave parity invisible walls round the tower base)
  if (t > 0.8) {
    B.wall.box(k.w - 0.02, t - 0.08, k.d - 0.02, at(0, k.y - 0.08 - (t - 0.08) / 2, 0), col("#7a5a3c"));
    for (let y = k.y - 0.3; y > k.y - t; y -= 0.34) for (const [lx, lz, L, ax] of [[0, k.d / 2, k.w, 0], [0, -k.d / 2, k.w, 0], [k.w / 2, 0, k.d, 1], [-k.w / 2, 0, k.d, 1]] as Array<[number, number, number, number]>)
      B.wood.add(cylGeo(0.13, 0.13, L + 0.24, 7), at(lx, y, lz).multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(ax ? Math.PI / 2 : 0, 0, ax ? 0 : Math.PI / 2))), col(rnd() < 0.5 ? "#8a6a48" : "#7a5c3e"));
  }
  // low log kerbs (collider-exact)
  for (const cb of deckCurbs(k)) { const L = Math.max(cb.h[0], cb.h[2]) * 2, alongX = cb.h[0] > cb.h[2]; B.wood.add(cylGeo(0.09, 0.09, L, 7), M(cb.c[0], cb.c[1], cb.c[2], cb.yaw ?? 0).multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(alongX ? 0 : Math.PI / 2, 0, alongX ? Math.PI / 2 : 0))), col("#9a7650")); }
  // piles
  for (const p of deckPiles(k)) squarePost(B, p.a, p.b, postHalf(p), "#8a6a4a", rnd);
  // rails: posts every ~1.6 m, a top rail, a rope mid-rail
  for (const [sideStr, spec] of Object.entries(k.rails ?? {})) {
    const side = +sideStr, len = side % 2 === 0 ? k.w : k.d; if (!spec) continue;
    const spans: Array<[number, number]> = spec === true ? [[0, len]] : spec as Array<[number, number]>;
    for (const [u0r, u1r] of spans) {
      const u0 = Math.max(0, u0r), u1 = Math.min(len, u1r); if (u1 - u0 < 0.2) continue;
      const P = (u: number, y: number) => { const q = u - len / 2; return side === 0 ? W(q, k.d / 2 - 0.06, y) : side === 2 ? W(q, -k.d / 2 + 0.06, y) : side === 1 ? W(k.w / 2 - 0.06, q, y) : W(-k.w / 2 + 0.06, q, y); };
      const np = Math.max(1, Math.round((u1 - u0) / 1.6));
      for (let i = 0; i <= np; i++) { const u = u0 + (u1 - u0) * i / np; post(B.wood, P(u, k.y - 0.02), P(u, k.y + 1.04), 0.055, WOOD_D); }
      const a = P(u0, k.y + 1.0), b = P(u1, k.y + 1.0), mid = a.clone().add(b).multiplyScalar(0.5), L = a.distanceTo(b);
      B.wood.bbox(L + 0.1, 0.07, 0.1, new THREE.Matrix4().compose(mid, new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.atan2(-(b.z - a.z), b.x - a.x), 0)), new THREE.Vector3(1, 1, 1)), col(WOOD_D), 0.015);
      B.rope.add(tubeGeo(catenary(P(u0, k.y + 0.55), P(u1, k.y + 0.55), 0.08, 8), 0.022, 4, false, 8), null, col("#e8d8b0"));
    }
  }
}

// ------------------------------------------------------------------------------------------------ stairs
function addStair(B: Bins, s: CStair, rnd: () => number) {
  const steps = stairSteps(s);
  const c = Math.cos(s.yaw), sn = Math.sin(s.yaw), tread = s.tread ?? 0.28;
  for (const st of steps) {
    const b = st.box, m = M(b.c[0], b.c[1], b.c[2], b.yaw ?? 0);
    // carpentry: the collider block reads as a boxed timber stair — a dark boarded body (shadow gap), a
    // light riser board and a proud tread plank with a nosing on every step; stringers + posts on the sides (below)
    // (the body 1 cm proud of the collider's sides — 3 cm inside it, a grazing parity ray meets it 0.3 m+ past the box)
    B.wood.box(b.h[0] * 2 + 0.02, b.h[1] * 2 - 0.07, b.h[2] * 2 - 0.02, m.clone().multiply(M(0, -0.035, 0)), col(rnd() < 0.5 ? "#6e4e32" : "#654630"));
    B.wood.box(b.h[0] * 2 - 0.04, Math.min(0.26, b.h[1] * 2 - 0.06), 0.035, m.clone().multiply(M(0, b.h[1] - 0.06 - Math.min(0.26, b.h[1] * 2 - 0.06) / 2, -b.h[2] + 0.018)), col(rnd() < 0.5 ? "#b48656" : "#a67a4c"));
    B.wood.bbox(b.h[0] * 2 + 0.04, 0.06, b.h[2] * 2 + 0.05, M(b.c[0], st.top - 0.03, b.c[2], b.yaw ?? 0).multiply(M(0, 0, -0.01)), col(rnd() < 0.35 ? WOOD_L : WOOD), 0.014);
  }
  if (steps.length > 2) for (const sd of [-1, 1]) {
    // a log stringer along each side under the nosings + a post every third step down to the foot of the block
    const lx = sd * (s.width / 2 + 0.03), P = (i: number, y: number) => V(s.x + lx * c + (i + 0.5) * tread * sn, y, s.z - lx * sn + (i + 0.5) * tread * c);
    const n = steps.length;
    post(B.wood, P(-0.4, steps[0].top - 0.32), P(n - 0.6, steps[n - 1].top - 0.32), 0.075, BEAM);
    for (let i = 2; i < n; i += 3) { const y0 = steps[i].box.c[1] - steps[i].box.h[1]; post(B.wood, P(i, y0 + 0.02), P(i, steps[i].top - 0.3), 0.065, WOOD_D); }
  }
  // guards: a boarded balustrade per rail segment, exactly its collider (rope + three posts would leave the 1 m guard
  // box undrawn — parity invisible walls beside the tower flights), a cap rail on top
  for (const b of stairRails(s)) {
    const m = M(b.c[0], b.c[1], b.c[2], b.yaw ?? 0), H = b.h[1] * 2, L = b.h[2] * 2, nb = Math.max(2, Math.round(H / 0.24));
    for (let i = 0; i < nb; i++) B.wood.bbox(0.1, H / nb - 0.015, L, m.clone().multiply(M(0, -H / 2 + (i + 0.5) * H / nb, 0)), col(rnd() < 0.4 ? WOOD : "#b48a5c"), 0.01);
    B.wood.bbox(0.14, 0.07, L + 0.04, m.clone().multiply(M(0, H / 2 + 0.035, 0)), col(WOOD_D), 0.015);
  }
}

// ------------------------------------------------------------------------------------------------ buildings
function addHut(B: Bins, h: HutSpec, rnd: () => number) {
  const at = (lx: number, y: number, lz: number, yaw = 0, pitch = 0, roll = 0) => { const [x, z] = hutToWorld(h, lx, lz); return M(x, y, z, h.yaw + yaw, pitch, roll); };
  for (const p of hutPieces(h)) {
    const b = p.box, m = M(b.c[0], b.c[1], b.c[2], b.yaw ?? 0);
    if (p.kind === "wall") {
      // plank-clad wall with real thickness: the core + vertical boards proud on both faces
      B.wall.box(b.h[0] * 2, b.h[1] * 2, b.h[2] * 2, m, col(PLANK_WALL, 0.92 + rnd() * 0.12), [rnd() * 4, rnd() * 4]);
    } else if (p.kind === "slab") {
      B.wood.box(b.h[0] * 2, b.h[1] * 2, b.h[2] * 2, m, col(p.floor === 0 ? "#9a7048" : WOOD), [rnd() * 4, rnd() * 4]);
    } else if (p.kind === "step") {
      B.wood.box(b.h[0] * 2 - 0.02, b.h[1] * 2 - 0.05, b.h[2] * 2, m.clone().multiply(M(0, -0.025, 0)), col("#9a6e44"));
      B.wood.bbox(b.h[0] * 2 + 0.02, 0.05, b.h[2] * 2 + 0.03, M(b.c[0], b.c[1] + b.h[1] - 0.025, b.c[2], b.yaw ?? 0), col(WOOD_L), 0.01);
    } else if (p.kind === "rail") {
      // post-and-rail: top rail + posts + a low board
      B.wood.bbox(b.h[0] * 2, 0.07, b.h[2] * 2, M(b.c[0], b.c[1] + b.h[1] - 0.035, b.c[2], b.yaw ?? 0), col(WOOD_D), 0.015);
      B.wood.box(b.h[0] * 2, 0.16, b.h[2] * 2 * 0.7, M(b.c[0], b.c[1] - b.h[1] + 0.14, b.c[2], b.yaw ?? 0), col(WOOD));
      const L = Math.max(b.h[0], b.h[2]) * 2, n = Math.max(1, Math.round(L / 1.3)), along = b.h[0] > b.h[2] ? [1, 0] : [0, 1];
      for (let i = 0; i <= n; i++) { const u = -L / 2 + L * i / n; B.wood.box(0.09, b.h[1] * 2, 0.09, M(b.c[0], b.c[1], b.c[2], b.yaw ?? 0).multiply(M(along[0] * u, 0, along[1] * u)), col(WOOD_D)); }
    } else if (p.kind === "part") {
      B.wall.box(b.h[0] * 2, b.h[1] * 2, b.h[2] * 2, m, col("#e4cfb0"));
    }
  }
  const H = h.floors * h.fh, y0 = h.y;
  // timber frame: corner posts, floor-line beams (proud of the wall faces by 4 cm)
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) B.wood.bbox(0.3, H + 0.05, 0.3, at(sx * (h.w / 2 - 0.1), y0 + H / 2, sz * (h.d / 2 - 0.1)), col(BEAM), 0.03);
  for (let f = 0; f <= h.floors; f++) {
    const y = y0 + f * h.fh - 0.1;
    B.wood.bbox(h.w + 0.1, 0.22, 0.12, at(0, y, h.d / 2 + 0.02), col(BEAM), 0.02); B.wood.bbox(h.w + 0.1, 0.22, 0.12, at(0, y, -h.d / 2 - 0.02), col(BEAM), 0.02);
    B.wood.bbox(0.12, 0.22, h.d + 0.1, at(h.w / 2 + 0.02, y, 0), col(BEAM), 0.02); B.wood.bbox(0.12, 0.22, h.d + 0.1, at(-h.w / 2 - 0.02, y, 0), col(BEAM), 0.02);
  }
  // opening frames (doors, windows) + shutters + sills; window openings stay open (players shoot through them)
  const SIDE: Array<{ A: [number, number]; dir: [number, number]; n: [number, number] }> = [
    { A: [-h.w / 2, h.d / 2], dir: [1, 0], n: [0, 1] }, { A: [h.w / 2, h.d / 2], dir: [0, -1], n: [1, 0] }, { A: [h.w / 2, -h.d / 2], dir: [-1, 0], n: [0, -1] }, { A: [-h.w / 2, -h.d / 2], dir: [0, 1], n: [-1, 0] }];
  for (const o of h.openings) {
    const S = SIDE[o.side], yb = y0 + o.floor * h.fh + o.y, fyaw = Math.atan2(S.n[0], S.n[1]);
    for (const face of [1, -1]) {
      const off = face > 0 ? 0.03 : -h.t - 0.03;
      const F = (u: number, y: number, dz = 0) => at(S.A[0] + S.dir[0] * u + S.n[0] * (off + dz), y, S.A[1] + S.dir[1] * u + S.n[1] * (off + dz), fyaw);
      B.wood.bbox(0.12, o.h + 0.12, 0.08, F(o.u - 0.04, yb + o.h / 2), col(WOOD_D), 0.015);
      B.wood.bbox(0.12, o.h + 0.12, 0.08, F(o.u + o.w + 0.04, yb + o.h / 2), col(WOOD_D), 0.015);
      B.wood.bbox(o.w + 0.2, 0.12, 0.08, F(o.u + o.w / 2, yb + o.h + 0.04), col(WOOD_D), 0.015);
      if (o.kind === "window") B.wood.bbox(o.w + 0.26, 0.08, 0.16, F(o.u + o.w / 2, yb - 0.02, face * 0.04), col(WOOD_D), 0.015);
    }
    if (o.kind === "window") {
      // open shutters folded flat against the outside wall
      for (const sd of [-1, 1]) {
        const u = sd < 0 ? o.u - o.w / 4 - 0.12 : o.u + o.w + o.w / 4 + 0.12;
        B.wood.box(o.w / 2, o.h, 0.04, at(S.A[0] + S.dir[0] * u + S.n[0] * 0.06, yb + o.h / 2, S.A[1] + S.dir[1] * u + S.n[1] * 0.06, fyaw), col(rnd() < 0.5 ? "#3f7a6a" : "#4a8a78"));
      }
    }
  }
  // (the rooms inside — panelling, trims, ceiling beams, lamps, furniture — come from the interiors kit: index.ts)
  // roof
  if (h.roof === "gable") {
    const y = y0 + H, ov = 0.45, span = h.d / 2 + ov, pitch = Math.atan2(GABLE_RISE, span), L = Math.hypot(GABLE_RISE, span);
    for (const sg of [1, -1]) {
      const m = at(0, y + GABLE_RISE / 2 + 0.1, sg * span / 2, 0, sg * pitch);
      B.tin.box(h.w + ov * 2, 0.05, L, m, col("#b0452f"));
      for (let i = 0; i < 9; i++) B.tin.box(0.05, 0.035, L, m.clone().multiply(M(-h.w / 2 - ov + (i + 0.5) * (h.w + 2 * ov) / 9, 0.035, 0)), col("#9a3a28"));
    }
    B.metal.box(h.w + 2 * ov, 0.1, 0.3, at(0, y + GABLE_RISE + 0.12, 0), col("#6a5a50"));
    // gable end boards (closed triangles)
    const tri = new THREE.Shape([new THREE.Vector2(-span + ov, 0), new THREE.Vector2(span - ov, 0), new THREE.Vector2(0, GABLE_RISE)]);
    const tg = new THREE.ExtrudeGeometry(tri, { depth: 0.1, bevelEnabled: false });
    for (const sx of [-1, 1]) B.wood.add(tg, at(sx * (h.w / 2 - 0.05), y, 0, Math.PI / 2).multiply(M(0, 0, -0.05)), col(PLANK_WALL));
  } else {
    // deck roof: tar-paper edge + the BANANA CO. board on the front parapet
    const y = y0 + H;
    B.sign.add(signGeo(3.4, 1.05), at(-1.9, y + 0.5, h.d / 2 + 0.07), 0xffffff);
  }
  // a sign over the office door
  if (h.id === "office") B.sign.add(signGeo(2.4, 0.75), at(0.1, y0 + 2.75, h.d / 2 + 0.06), 0xffffff);
}
function signGeo(w: number, h: number): THREE.BufferGeometry { const g = new THREE.PlaneGeometry(w, h); return g; }

// ------------------------------------------------------------------------------------------------ props
function addProp(B: Bins, p: CProp, rnd: () => number) {
  const m = M(p.x, p.y, p.z, p.yaw), T = (x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0) => m.clone().multiply(M(x, y, z, yaw, pitch, roll));
  const hh = PROP_HALF[p.kind];
  switch (p.kind) {
    case "crate": crate(B, T(0, 0, 0), 1.0, 0.9, rnd); break;
    case "crate-stack": crate(B, T(0, 0, 0), 1.1, 0.9, rnd); crate(B, T(0, 0.9, 0), 0.92, 0.84, rnd); break;   // (squared up: = its two collider boxes)
    case "barrel": addBarrel(B.town, T(0, 0, 0).multiply(new THREE.Matrix4().makeScale(1.3, 1.13, 1.3)), rnd() < 0.5 ? "#7a5236" : "#8a6040", false); break;
    case "drum": addBarrel(B.town, T(0, 0, 0).multiply(new THREE.Matrix4().makeScale(1.2, 1.08, 1.2)), rnd() < 0.5 ? "#b0442a" : "#2f6a8a", true); break;
    case "boat": addLongboat(B.town, T(0, 0.25, 0).multiply(new THREE.Matrix4().makeScale(0.68, 0.72, 0.68)), { hull: "#c9452f", stripe: "#f2e6c2", lower: "#4a3a2a", inner: "#8a6a44", seat: "#2fb3a8", motor: false, oars: true, len: 5.6, fenders: 0, cargo: ["crate", "rope"] }, rnd); break;
    case "cart": {
      // an ore tub: a flared, riveted steel hopper on a timber-and-iron chassis, four spoked wheels on the rails,
      // heaped with gold ore (collider = PROP_HALF cart)
      const hop = new THREE.CylinderGeometry(0.62, 0.48, 0.62, 4, 1, true); hop.rotateY(Math.PI / 4); hop.scale(1.0, 1, 1.45);
      B.metal.add(hop, T(0, 0.86, 0), col("#7a5a44"));
      B.metal.add(new THREE.BoxGeometry(0.92, 0.05, 1.36), T(0, 0.56, 0), col("#4a3a30"));
      for (const sy of [0.58, 1.14]) for (const sz of [-1, 1]) B.metal.box(sy > 1 ? 1.26 : 0.98, 0.05, 0.05, T(0, sy, sz * (sy > 1 ? 0.9 : 0.7)), col(IRON));
      for (const sy of [0.58, 1.14]) for (const sx of [-1, 1]) B.metal.box(0.05, 0.05, sy > 1 ? 1.8 : 1.4, T(sx * (sy > 1 ? 0.62 : 0.48), sy, 0), col(IRON));
      for (let i = 0; i < 10; i++) B.metal.add(new THREE.SphereGeometry(0.022, 5, 3), T((i % 2 ? 1 : -1) * 0.6, 0.95, -0.7 + (i >> 1) * 0.35), col("#2a2420"));
      B.wood.box(0.7, 0.12, 1.7, T(0, 0.4, 0), col(BEAM));
      for (const sz of [-0.55, 0.55]) {
        B.metal.box(1.22, 0.06, 0.06, T(0, 0.24, sz), col(IRON));
        for (const sx of [-1, 1]) {
          const w = T(sx * 0.55, 0.24, sz, 0, 0, Math.PI / 2);
          B.metal.add(new THREE.TorusGeometry(0.2, 0.035, 5, 14), T(sx * 0.55, 0.24, sz, Math.PI / 2), col("#3a3634"));
          for (let k = 0; k < 3; k++) B.metal.box(0.02, 0.38, 0.03, w.clone().multiply(M(0, 0, 0, k * Math.PI / 3)), col("#4a4440"));
          B.metal.add(cylGeo(0.06, 0.06, 0.08, 8), w, col(IRON));
        }
      }
      // the load: gold ore + dark rock, heaped over the rim (on an ore bed flush with the collider top)
      B.metal.box(1.0, 0.05, 1.62, T(0, 1.17, 0), col("#4a3c30"));
      for (let i = 0; i < 16; i++) { const g = new THREE.IcosahedronGeometry(0.12 + rnd() * 0.1, 0); B.gold.add(g, T((rnd() - 0.5) * 0.85, 1.08 + rnd() * 0.18 - Math.abs(rnd() - 0.5) * 0.2, (rnd() - 0.5) * 1.3, rnd() * 6, rnd(), rnd()), col(rnd() < 0.55 ? "#f2b62a" : "#5a4c40")); }
      break;
    }
    case "rails": {
      // rails + sleepers laid ON the ground: every sleeper takes the sand height under it (one flat 18 m piece would float)
      const c = Math.cos(p.yaw), sn = Math.sin(p.yaw), gy = (lz: number) => groundAt(p.x + lz * sn, p.z + lz * c) - p.y;
      for (let i = -8; i <= 8; i++) { const lz = i * 1.05; B.wood.box(1.6, 0.1, 0.24, T(0, gy(lz) + 0.02, lz, (rnd() - 0.5) * 0.06), col(BEAM)); }
      for (const sx of [-0.55, 0.55]) for (let i = -8; i < 8; i++) {
        const z0 = i * 1.05, z1 = z0 + 1.05, y0 = gy(z0) + 0.12, y1 = gy(z1) + 0.12, L = Math.hypot(1.05, y1 - y0);
        B.metal.box(0.07, 0.09, L + 0.02, T(sx, (y0 + y1) / 2, (z0 + z1) / 2, 0, -Math.atan2(y1 - y0, 1.05)), col("#6a5a50"));
      }
      break;
    }
    case "table": {
      B.wood.bbox(1.8, 0.08, 1.1, T(0, 0.8, 0), col(WOOD_L), 0.02);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.wood.box(0.09, 0.78, 0.09, T(sx * 0.78, 0.39, sz * 0.45), col(WOOD_D));
      B.cloth.add(new THREE.PlaneGeometry(0.8, 0.55), T(-0.2, 0.845, 0.05, 0.3, -Math.PI / 2), col("#e8dcb8"));   // a map
      caveLantern(B, T(0.55, 0.84, -0.2, 0.4));
      break;
    }
    case "shelf": {
      for (const sx of [-1, 1]) B.wood.box(0.08, 2.0, 0.5, T(sx * 0.86, 1.0, 0), col(WOOD_D));
      for (let i = 0; i < 4; i++) { B.wood.box(1.8, 0.05, 0.5, T(0, 0.1 + i * 0.62, 0), col(WOOD)); if (i < 3) for (let k = 0; k < 3; k++) if (rnd() < 0.8) crate(B, T(-0.55 + k * 0.55, 0.13 + i * 0.62, 0, (rnd() - 0.5) * 0.3), 0.42, 0.36, rnd); }
      break;
    }
    case "bunk": {
      // a low plank cot with a straw mattress and a blanket (0.6 m: a kong can stand on it under the 3.1 m ceiling)
      B.wood.bbox(2.0, 0.1, 1.0, T(0, 0.33, 0), col(WOOD_D), 0.02);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.wood.box(0.09, 0.3, 0.09, T(sx * 0.94, 0.15, sz * 0.44), col(BEAM));
      B.cloth.bbox(1.9, 0.16, 0.9, T(0, 0.45, 0), col("#e2cc9a"), 0.06);
      B.cloth.bbox(1.2, 0.05, 0.94, T(0.35, 0.55, 0, 0.05), col(rnd() < 0.5 ? "#7a9ab8" : "#b8583a"), 0.02);
      break;
    }
    case "stool": {
      B.wood.add(cylGeo(0.2, 0.19, 0.06, 12), T(0, 0.43, 0), col(WOOD_L));
      for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI * 2; B.wood.add(cylGeo(0.025, 0.03, 0.44, 5), T(Math.cos(a) * 0.13, 0.21, Math.sin(a) * 0.13, 0, Math.cos(a) * 0.12, Math.sin(a) * 0.12), col(WOOD_D)); }
      break;
    }
    case "sacks": {
      // burlap sacks: soft pillows (a squashed, lumpy rounded box) with a gathered, tied neck; three below, one on top
      const sack = (x: number, y: number, z: number, ry: number, rz: number) => {
        const g = chamferBoxGeo(0.56, 0.36, 0.42, 0.13); const pa = g.attributes.position as THREE.BufferAttribute;
        for (let v = 0; v < pa.count; v++) { const px = pa.getX(v), py = pa.getY(v), pz = pa.getZ(v); const k = 1 + 0.12 * Math.sin(px * 9 + pz * 7) - 0.18 * Math.max(0, py) * 2; pa.setXYZ(v, px * k, py, pz * k); }
        g.computeVertexNormals();
        B.cloth.add(g, T(x, y + 0.18, z, ry, 0, rz), col(rnd() < 0.5 ? "#cdb993" : "#bfa77e"));
        B.cloth.add(cylGeo(0.06, 0.1, 0.14, 8), T(x + Math.sin(rz) * -0.2, y + 0.4, z, ry, 0, rz), col("#b89c70"));
        B.rope.add(new THREE.TorusGeometry(0.07, 0.018, 4, 10), T(x + Math.sin(rz) * -0.2, y + 0.4, z, ry, Math.PI / 2, rz), col("#8a6a44"));
      };
      sack(-0.3, 0, -0.12, 0.2, 0.05); sack(0.3, 0, 0.1, -0.3, -0.04); sack(0.02, 0, 0.3, 1.2, 0.02); sack(0.0, 0.32, -0.02, 0.6, 0.12);
      break;
    }
    case "nuggets": {
      // a heap of raw gold: faceted lumps on a little spill of ore dust (≤ 0.3 m: step-over, no collider)
      const n = 7 + Math.floor(rnd() * 5), k = p.s ?? 1;
      for (let i = 0; i < n; i++) {
        const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 0.42 * k, sz = (0.06 + rnd() * 0.08) * k;
        const g = new THREE.IcosahedronGeometry(sz, 0); g.scale(1, 0.7 + rnd() * 0.4, 1);
        B.gold.add(g, T(Math.cos(a) * r, sz * 0.5 + (r < 0.15 * k ? 0.08 * k : 0), Math.sin(a) * r, rnd() * 6, rnd(), rnd()), col(rnd() < 0.3 ? "#ffd766" : "#f2b62a"));
      }
      B.wood.add(new THREE.CylinderGeometry(0.46 * k, 0.55 * k, 0.05, 10), T(0, 0.02, 0), col("#6a5a44"));
      break;
    }
    case "coil": {
      // a rope coil: four stacked turns, a loose tail
      // (two turns, ≤ 0.13 m: a coil on a deck is part of its floor — parity ±0.15)
      for (let k = 0; k < 2; k++) B.rope.add(new THREE.TorusGeometry(0.22 - k * 0.03, 0.035, 5, 16), T(0, 0.035 + k * 0.06, 0, k * 0.7, Math.PI / 2), col("#d8c49a"));
      B.rope.add(tubeGeo([V(0.18, 0.04, 0), V(0.35, 0.03, 0.12), V(0.52, 0.03, 0.08)].map((v) => v.applyMatrix4(T(0, 0, 0))), 0.03, 4, false, 6), null, col("#d0bc90"));
      break;
    }
    case "net": {
      // a fishing net thrown over a crate: a sagging sheet hanging down its sides
      const g = new THREE.PlaneGeometry(1.5, 1.5, 10, 10).rotateX(-Math.PI / 2), pa = g.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pa.count; i++) { const x = pa.getX(i), z = pa.getZ(i), e = Math.max(Math.abs(x), Math.abs(z)); const drop = e > 0.5 ? (e - 0.5) * 1.6 : 0; pa.setXYZ(i, Math.min(0.54, Math.abs(x)) * Math.sign(x) + (Math.abs(x) > 0.54 ? Math.sign(x) * 0.02 : 0), 0.03 - drop + Math.sin(x * 7 + z * 5) * 0.03, Math.min(0.54, Math.abs(z)) * Math.sign(z) + (Math.abs(z) > 0.54 ? Math.sign(z) * 0.02 : 0)); }
      g.computeVertexNormals(); B.net.add(g, T(0, 0, 0), col("#e8dcc0"));
      break;
    }
    case "gold": {
      // a treasure heap: a coin mound, scattered coins, nuggets, a cup (≤ 0.4 m: step-over, visual only)
      const k = p.s ?? 1;
      B.gold.add(new THREE.SphereGeometry(0.5, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(k, 0.5 * k, 0.85 * k), T(0, 0, 0), col("#e8b83a"));
      for (let i = 0; i < 34; i++) { const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 0.8 * k, y = Math.max(0, 0.25 * k * (1 - (r / (0.55 * k)) ** 2)); B.gold.add(cylGeo(0.035, 0.035, 0.01, 7), T(Math.cos(a) * r, y + 0.006, Math.sin(a) * r * 0.85, rnd() * 6, (rnd() - 0.5) * 0.8, (rnd() - 0.5) * 0.8), col(rnd() < 0.5 ? "#f6d266" : "#e2a838")); }
      for (let i = 0; i < 7; i++) { const a = rnd() * Math.PI * 2, r = 0.2 + rnd() * 0.3 * k; B.gold.add(new THREE.IcosahedronGeometry(0.06 + rnd() * 0.06, 0), T(Math.cos(a) * r, 0.12 * k + rnd() * 0.08, Math.sin(a) * r * 0.85, rnd() * 6, rnd(), rnd()), col("#ffd766")); }
      B.gold.add(cylGeo(0.06, 0.035, 0.12, 8), T(0.25 * k, 0.2 * k, -0.1, 0, 0.5, 0.3), col("#f2c24a"));
      break;
    }
    case "monstera": monstera(B, T(0, 0, 0), p.s ?? 1, rnd); break;
    case "fern": fernClump(B, T(0, 0, 0), p.s ?? 1, rnd); break;
    case "lantern-post": {
      // a hewn post on a stone footing, a braced arm with an iron hook, a modelled lantern on a
      // chain (the collider stays the post's square core)
      B.wood.bbox(0.18, 2.5, 0.18, T(0, 1.25, 0), col(rnd() < 0.5 ? BEAM : "#a08060"), 0.025);
      B.metal.add(cylGeo(0.2, 0.24, 0.16, 7), T(0, 0.06, 0, rnd()), col("#6a6258"));
      B.wood.bbox(0.72, 0.09, 0.09, T(0.32, 2.38, 0), col(BEAM), 0.012);
      B.wood.box(0.06, 0.48, 0.06, T(0.2, 2.12, 0, 0, 0, -0.85), col(WOOD_D));
      B.metal.add(new THREE.TorusGeometry(0.035, 0.008, 4, 8), T(0.62, 2.3, 0), col(IRON));
      for (let k = 0; k < 3; k++) B.metal.add(new THREE.TorusGeometry(0.022, 0.006, 3, 6), T(0.62, 2.24 - k * 0.05, 0, k * 1.57), col(IRON));
      caveLantern(B, T(0.62, 1.8, 0, rnd() * 0.6));
      break;
    }
    default: break;
  }
  void hh;
}
/** a 3D monstera clump (not flat fern cards): 7–9 split leaves (a midrib + pinnate fingers, cupped and
 *  drooping) on arching stems from one base, dark glossy green → lighter edges */
function monstera(B: Bins, at: THREE.Matrix4, s: number, rnd: () => number) {
  const n = 7 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const yaw = i / n * Math.PI * 2 + rnd() * 0.5, L = (0.75 + rnd() * 0.35) * s, rise = (0.45 + rnd() * 0.45) * s, lean = (0.25 + rnd() * 0.35) * s;
    const base = V(0, 0, 0), tip = V(Math.sin(yaw) * lean, rise, Math.cos(yaw) * lean);
    B.leaf.add(tubeGeo([base, V(Math.sin(yaw) * lean * 0.3, rise * 0.75, Math.cos(yaw) * lean * 0.3), tip].map((v) => v.applyMatrix4(at)), 0.018 * s, 4, false, 6), null, col("#4f7a2a"));
    // the blade: midrib along its local +z from the stem tip, fingers to both sides
    const pos: number[] = [], cl: number[] = [], idx: number[] = [], F = 7;
    const P = (u: number, v: number) => { const w = Math.sin(Math.PI * Math.min(1, u * 1.08)) ** 0.8 * 0.36 * L; const x = v * w, z = u * L, y = -0.35 * L * u * u + 0.14 * Math.abs(v) * w; return [x, y, z]; };
    const vtx = (u: number, v: number, c: number) => { const [x, y, z] = P(u, v); pos.push(x, y, z); const g = 0.62 + 0.25 * Math.abs(v); cl.push(0.12 * c * g, 0.36 * c * g, 0.1 * c * g); return pos.length / 3 - 1; };
    for (let side of [-1, 1]) for (let f = 0; f < F; f++) {
      const u0 = (f + 0.08) / F, u1 = (f + 0.92) / F, sk = 0.05;
      const a = vtx(u0, 0, 1.15), b = vtx(u1, 0, 1.15), c = vtx(u1 + sk, side * 1.0, 1), d = vtx(u0 + sk * 1.5, side * 1.0, 1);
      if (side > 0) idx.push(a, b, c, a, c, d); else idx.push(a, c, b, a, d, c);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(cl, 3)); g.setIndex(idx); g.computeVertexNormals();
    const m = at.clone().multiply(new THREE.Matrix4().compose(tip, new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35 + rnd() * 0.3, yaw, (rnd() - 0.5) * 0.4, "YXZ")), new THREE.Vector3(1, 1, 1)));
    B.leaf.add(g, m, 0xffffff);
  }
}
/** a 3D fern clump: 9–12 arching fronds, each a curved rachis with alternating tapered pinnae */
function fernClump(B: Bins, at: THREE.Matrix4, s: number, rnd: () => number) {
  const n = 9 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const yaw = i / n * Math.PI * 2 + rnd() * 0.4, L = (0.8 + rnd() * 0.4) * s, up = 0.9 + rnd() * 0.5;
    const pos: number[] = [], cl: number[] = [], idx: number[] = [], K = 14;
    const R = (t: number) => [0, Math.sin(t * Math.PI * 0.75) * 0.55 * L * up - t * t * 0.25 * L, t * L];   // the rachis in frond space
    for (let k = 1; k < K; k++) {
      const t = k / K, [x, y, z] = R(t), [, y2, z2] = R(Math.min(1, t + 0.06)), pl = 0.2 * L * Math.sin(Math.PI * Math.min(1, t * 1.1 + 0.05)), c = 0.7 + 0.3 * t;
      for (const side of [-1, 1]) {
        const b = pos.length / 3; pos.push(x, y, z, x, y2, z2, side * pl, y - pl * 0.25, z + pl * 0.35);
        const g = 0.85 + rnd() * 0.3; for (let q = 0; q < 3; q++) cl.push(0.16 * c * g, 0.42 * c * g, 0.12 * c * g);
        idx.push(b, b + 1, b + 2);
      }
    }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(cl, 3)); g.setIndex(idx); g.computeVertexNormals();
    B.leaf.add(g, at.clone().multiply(new THREE.Matrix4().makeRotationY(yaw)), 0xffffff);
  }
}
/** a modelled storm lantern (not a glowing cube): an octagonal base, a glass chimney with a flame,
 *  four frame bars, a vented cone hood with a chimney and a wire bail — origin at its base, 0.42 m tall */
function caveLantern(B: Bins, at: THREE.Matrix4) {
  const A = (x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0) => at.clone().multiply(M(x, y, z, yaw, pitch, roll));
  B.metal.add(cylGeo(0.105, 0.115, 0.045, 8), A(0, 0.022, 0), col("#3a3430"));
  B.metal.add(cylGeo(0.085, 0.105, 0.025, 8), A(0, 0.055, 0), col("#4a4038"));
  B.glass.add(cylGeo(0.072, 0.078, 0.2, 8), A(0, 0.17, 0), col("#ffe2a0"));
  B.bulb.add(new THREE.SphereGeometry(0.03, 6, 5).scale(1, 1.6, 1), A(0, 0.15, 0), col("#fff2c0"));
  for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2 + Math.PI / 4; B.metal.box(0.014, 0.22, 0.014, A(Math.cos(a) * 0.088, 0.17, Math.sin(a) * 0.088), col("#2f2a26")); }
  B.metal.add(cylGeo(0.1, 0.1, 0.02, 8), A(0, 0.285, 0), col("#3a3430"));
  B.metal.add(new THREE.ConeGeometry(0.11, 0.09, 8, 1), A(0, 0.34, 0), col("#4a4038"));
  B.metal.add(cylGeo(0.022, 0.026, 0.05, 6), A(0, 0.4, 0), col("#2f2a26"));
  B.metal.add(new THREE.TorusGeometry(0.075, 0.006, 4, 10, Math.PI), A(0, 0.3, 0), col("#2f2a26"));
}
function crate(B: Bins, at: THREE.Matrix4, s: number, h: number, rnd: () => number) {
  // UVs = one texture per face (metres = the face size, centred): the BANANA CO. stencil sits inside every face
  B.crate.add(chamferBoxGeo(s, h, s, 0.03, [0, (s - h) / 2], s), at.clone().multiply(M(0, h / 2, 0)), 0xffffff);
  // bevelled edge battens in darker wood
  const c = col(rnd() < 0.5 ? "#6a4a30" : "#7a5638");
  for (const sy of [0.04, h - 0.04]) for (const sz of [-1, 1]) B.wood.box(s + 0.03, 0.07, 0.05, at.clone().multiply(M(0, sy, sz * (s / 2 + 0.005))), c);
  for (const sy of [0.04, h - 0.04]) for (const sx of [-1, 1]) B.wood.box(0.05, 0.07, s + 0.03, at.clone().multiply(M(sx * (s / 2 + 0.005), sy, 0)), c);
}

// ------------------------------------------------------------------------------------------------ tower, headframe
function addTower(B: Bins, rnd: () => number) {
  const T = TOWER, top = SKY.y1 + 4.2, xs = [T.x - T.w / 2 - 0.14, T.x + T.w / 2 + 0.14], zs = [T.z - T.len / 2 - 0.14, T.z + T.len / 2 + 0.14];
  // X-bracing on the two long faces and the ends, every flight
  for (let k = 0; k < T.flights; k++) {
    const ya = T.yb + k * T.rise, yb = ya + T.rise;
    for (const x of xs) { post(B.wood, V(x, ya, zs[0]), V(x, yb, zs[1]), 0.06, BEAM); post(B.wood, V(x, yb, zs[0]), V(x, ya, zs[1]), 0.06, BEAM); B.wood.box(0.12, 0.16, T.len + 0.3, M(x, yb - 0.1, T.z), col(BEAM)); }
    for (const z of zs) { post(B.wood, V(xs[0], ya, z), V(xs[1], yb, z), 0.05, BEAM); B.wood.box(T.w + 0.3, 0.16, 0.12, M(T.z === z ? T.x : T.x, yb - 0.1, z), col(BEAM)); }
  }
  // headframe over the top deck: struts from the corner post tops (all above head height) to an apex over the south
  // end, the sheave wheel, the hoist rope hanging clear of the tower into the open shaft with a crate on the hook
  const apex = V(T.x, top + 5.2, zs[1] - 0.2);   // (tall, with a 1.7 m wheel — the landmark's silhouette from the plane)
  for (const x of xs) for (const z of zs) post(B.wood, V(x, top, z), apex, 0.1, BEAM);
  post(B.wood, V(xs[0], top, zs[0]), V(xs[0], top + 0.1, zs[1]), 0.12, BEAM); post(B.wood, V(xs[1], top, zs[0]), V(xs[1], top + 0.1, zs[1]), 0.12, BEAM);
  const wheel = M(apex.x, apex.y - 0.5, apex.z + 0.1, Math.PI / 2);
  B.metal.add(new THREE.TorusGeometry(1.7, 0.12, 8, 36), wheel, col("#c0462c"));
  for (let i = 0; i < 6; i++) B.metal.box(0.08, 3.3, 0.08, wheel.clone().multiply(M(0, 0, 0, 0, 0, i * Math.PI / 6)), col("#4a3e34"));
  B.metal.add(cylGeo(0.12, 0.12, 0.4, 10), wheel.clone().multiply(M(0, 0, 0, 0, Math.PI / 2, 0)), col(IRON));
  const hookZ = apex.z + 1.8;
  B.rope.add(tubeGeo([V(T.x, apex.y - 0.5, hookZ), V(T.x, 58.4, hookZ)], 0.035, 5, false, 2), null, col("#d8c49a"));
  crate(B, M(T.x, 57.5, hookZ, 0.3), 0.9, 0.8, rnd);
  B.sign.add(signGeo(4.2, 1.3), M(T.x, top + 1.0, zs[1] + 0.08, 0), 0xffffff);
  B.sign.add(signGeo(4.2, 1.3), M(T.x, top + 1.0, zs[0] - 0.08, Math.PI), 0xffffff);
  // (no rope ladder from the rim to the bank — the sim has no climbing, so it would be a ladder you could
  //  not use; the tower stair beside it is the route up to the skylight rim)
  void groundAt; void WATER_Y;
}

export async function buildTimber(ctx: WorldCtx, group: THREE.Group, mats: TimberMats): Promise<{ draws: number }> {
  // (build time: ~150 ms of geometry, so yields between the sections; the rnd sequence is unaffected)
  const rnd = mulberry(4711), B = new Bins(mats, "caves");
  for (const k of TIMBER.decks) addDeck(B, k, rnd);
  await ctx.yield();
  // plank porch laid on the den's rock plinth (6 cm) and the scaffold ledge's landing: visual only, within the collider
  const porchPlanks = (x0: number, z0: number, x1: number, z1: number, y: number) => { const n = Math.round((x1 - x0) / 0.3); for (let i = 0; i < n; i++) B.wood.bbox((x1 - x0) / n - 0.02, 0.06, z1 - z0 - rnd() * 0.1, M(x0 + (i + 0.5) * (x1 - x0) / n, y + 0.03, (z0 + z1) / 2 + (rnd() - 0.5) * 0.06, (rnd() - 0.5) * 0.02), col(rnd() < 0.3 ? WOOD_L : WOOD), 0.01, undefined, [rnd() * 3, rnd() * 3]); };
  porchPlanks(DEN.x - DEN.w / 2 - 0.4, DEN.z - DEN.d / 2 - 2.1, DEN.x + DEN.w / 2 + 0.4, DEN.z - DEN.d / 2 - 0.02, LEDGE.y);
  porchPlanks(LEDGE.x0 + 0.3, LEDGE.z0 + 0.3, LEDGE.x1 - 0.3, LEDGE.z0 + 3.5, LEDGE.y);
  for (const s of TIMBER.stairs) addStair(B, s, rnd);
  await ctx.yield();
  for (const p of TIMBER.posts) squarePost(B, p.a, p.b, postHalf(p), BEAM, rnd);
  for (const b of TIMBER.panels) B.wall.box(b.h[0] * 2, b.h[1] * 2, b.h[2] * 2, M(b.c[0], b.c[1], b.c[2], b.yaw ?? 0), col(PLANK_WALL));
  for (const h of HUTS) addHut(B, h, rnd);
  await ctx.yield();
  // the crag's banner (on the flagpole post of the layout): a yellow BANANA CO. flag, slightly waved
  { const fp = TIMBER.posts[TIMBER.posts.length - 1], top = V(fp.b[0], fp.b[1] - 0.3, fp.b[2]);
    const g = new THREE.PlaneGeometry(3.2, 1.6, 8, 1), pa = g.attributes.position as THREE.BufferAttribute; for (let i = 0; i < pa.count; i++) pa.setZ(i, Math.sin((pa.getX(i) + 1.6) * 1.9) * 0.18 * (pa.getX(i) + 1.6) / 3.2);
    g.computeVertexNormals(); B.sign.add(g, M(top.x + 1.65, top.y - 0.8, top.z, 0.6), 0xffffff); B.sign.add(g, M(top.x + 1.65, top.y - 0.8, top.z, 0.6 + Math.PI), 0xffffff); }
  let np = 0; for (const p of PROPS) { addProp(B, p, rnd); if (++np % 24 === 0) await ctx.yield(); }
  addTower(B, rnd);
  await ctx.yield();
  return { draws: B.build(group) };
}
