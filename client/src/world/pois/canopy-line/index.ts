// POI canopy-line — CANOPY LINE: treetop zipline + rope-bridge network among gigantic jungle trees on the plateau lip
// above the NE valley. Every visual derives from shared/pois/canopy-line.ts LAYOUT —
// the same numbers the server collides against and the zipline sim rides (shared/sim/zipline.ts).
// Draw structure: one cluster per column (tree / tower) with its decks, stairs, huts and props, merged per material
// into MAIN (always) and DETAIL (rails, ropes, props, furniture; within DETAIL_FAR m) groups; the crowns are single
// foliage meshes; bridges / ziplines / the forest floor are clusters of their own.
import * as THREE from "three";
import type { WorldModule } from "../../module";
import type { CamSpec } from "../../../engine/views";
import type { WorldCtx } from "../../../engine/engine";
import type { VegApi, PlantKind } from "../../veg/api";
import { LAYOUT, VIEW, W, TOWER, CX, CZ, CAMP, INTERIOR_ROOMS, groundAt, rad, toW, inArc, mulberry, sagY, type V3 } from "../../../../../shared/pois/canopy-line";
import { buildInteriors } from "../_kit/interior";
import { canopyMats, makeBins, flushBins, ZIP_HIDE, type Bins } from "./kit";
import { addTrunk, addFlanges, addCrown } from "./trees";
import { addRing, addHelix, addBridge, addTower, addHut, addShelter, addZip, addProp } from "./structures";
import { distanceSwitch, type LodItem } from "../_kit/jungle-lod";
import { addFarProxy } from "./far";
import { flag } from "../../../flags";

/** the DETAIL set (rails, ropes, tread edges, prop hardware — 3–6 cm parts) is drawn within
 *  DETAIL_FAR m of the POI centre: beyond it every part is < 0.3 px, so it leaves unseen. (At 130 m the whole POI's
 *  rails / ropes / props visibly grew out of the POI centre in a 0.3 s scale fade whenever you crossed it.) */
/** A/B: ?elevlod=0 = the old switches (130 / 340 / 58 m, scale-faded) */
const OLD_LOD = !flag("elevlod");
const DETAIL_FAR = OLD_LOD ? 110 : 260;
/** beyond this distance from the POI centre MAIN + DETAIL give way to the far proxy (far.ts, ~15 k tris):
 *  900 m keeps the full POI through the whole drop from the plane (PLANE_ALT 720) and from anywhere on the island's
 *  heart — the swap (at 340 m the whole treetop village swapped in mid-glide) only happens where the POI is a few
 *  degrees wide. Hysteresis 40 m. */
const FAR_SWITCH = OLD_LOD ? 340 : 900;
/** furnished interiors: drawn within INT_FAR m of one of their rooms (at 58 m furniture blinked in behind windows) */
const INT_FAR = OLD_LOD ? 58 : 85;

const deckView = (id: string, a: number, r: number, look: number, dist = 30, dy = 0, fov = 64): CamSpec => {
  const g = LAYOUT.rings[LAYOUT.deck[id]], c = LAYOUT.columns[g.col];
  const [x, z] = rad(c, a, r), [tx, tz] = [x + Math.cos(look) * dist, z + Math.sin(look) * dist];
  return { pos: [x, g.y + 1.75, z], target: [tx, g.y + 1.2 + dy, tz], fov, t: 12 };
};
const views: Record<string, CamSpec> = (() => {
  const v: Record<string, CamSpec> = {};
  // the view camera: on the Launch Tree's camera deck, NE across the valley to the lagoon
  v["poi-15-canopy-line"] = { pos: VIEW.pos, target: VIEW.target, fov: VIEW.fov, t: 12 };
  // plane / map read: the whole network from the NE, high
  v["canopy-aerial"] = { pos: [CX + 150, 160, CZ - 150], target: [CX + 10, 40, CZ + 5], fov: 50, t: 12 };
  // the plane's read from ~460 m: the far proxy (far.ts) + the crowns
  v["canopy-far"] = { pos: [CX + 330, 200, CZ - 330], target: [CX + 20, 45, CZ - 15], fov: 40, t: 12 };
  // eye level on the lodge deck looking back at the launch tree + tower across the bridge
  const b1 = LAYOUT.rings[LAYOUT.deck.B1], cb = LAYOUT.columns[b1.col], ca = LAYOUT.columns[LAYOUT.rings[LAYOUT.deck.A1].col];
  const aBA = Math.atan2(ca.z - cb.z, ca.x - cb.x);
  v["canopy-bridge"] = deckView("B1", aBA + 0.22, 9.5, aBA - 0.12, 40, 1.5, 66);
  // inside the lodge (ground storey, looking at the stair)
  {
    const h = LAYOUT.huts.find((q) => q.id === "lodge")!;
    const P = (lx: number, lz: number, ly: number): V3 => { const [ox, oz] = toW(h.yaw, lx, lz); return [h.x + ox, h.y + ly, h.z + oz]; };
    v["canopy-lodge-int"] = { pos: P(3.4, 2.0, 1.7), target: P(-1.5, -1.2, 1.4), fov: 72, t: 12 };
  }
  // valley floor at eye level under the giants, toward the depot and the valley trees
  { const x = 205, z = -268, tx = 232, tz = -250; v["canopy-valley"] = { pos: [x, groundAt(x, z) + 1.75, z], target: [tx, groundAt(tx, tz) + 6, tz], fov: 66, t: 12 }; }
  // on the tower top, the zip fan toward the sea
  // at the NE rail of the zip launch deck, clear of the nest stair, down the zip fan toward the sea
  { const c = TOWER.col, [x, z] = rad(c, -0.95, 3.2), h = -0.42; v["canopy-tower-top"] = { pos: [x, TOWER.top + 1.75, z], target: [x + Math.cos(h) * 60, TOWER.top - 20, z + Math.sin(h) * 60], fov: 66, t: 12 }; }
  // the plateau camp at eye level (tents, firepit, supply crates; the tower beyond)
  { const x = CAMP[0] - 8, z = CAMP[1] + 7, tx = CAMP[0] + 4, tz = CAMP[1] - 4; v["canopy-camp"] = { pos: [x, groundAt(x, z) + 1.8, z], target: [tx, groundAt(tx, tz) + 1.0, tz], fov: 66, t: 12 }; }
  // a furnished treehouse interior (Sea Hut on C1) and the crow's nest on the tower
  {
    const h = LAYOUT.huts.find((q) => q.id === "c-hut")!;
    const P = (lx: number, lz: number, ly: number): V3 => { const [ox, oz] = toW(h.yaw, lx, lz); return [h.x + ox, h.y + ly, h.z + oz]; };
    v["canopy-hut-int"] = { pos: P(-h.w / 2 + 0.6, h.d / 2 - 0.6, 1.75), target: P(h.w / 2 - 0.5, -h.d / 2 + 0.5, 0.9), fov: 74, t: 12 };
  }
  { const c = TOWER.col, [x, z] = rad(c, 0.7, 2.4); v["canopy-nest"] = { pos: [x, TOWER.nest + 1.75, z], target: [x + 50, TOWER.nest - 30, z - 25], fov: 70, t: 12 }; }
  // camera-deck eye level looking at the lodge tree
  v["canopy-deck"] = deckView("A1", 20 * Math.PI / 180, 7.0, -0.02, 40, 0, 66);
  return v;
})();

type Cluster = { main: Bins; det: Bins; key: string };

async function build(ctx: WorldCtx) {
  const t0 = performance.now();
  const mats = await canopyMats(ctx.renderer, ctx);
  const root = new THREE.Group(); root.name = "poi:canopy-line"; ctx.scene.add(root);
  // (perf: the POI's cost was CPU submit of ~200 draws) — MAIN is ONE set of
  // per-material meshes for the whole POI (~16 draws; the POI is one compact silhouette, culled as a unit), DETAIL is two
  // regional sets (plateau / valley) switched off beyond DETAIL_FAR
  const MAIN = makeBins(mats, "canopy:main");
  const dets = new Map<string, Bins>();
  const clusters = new Map<string, Cluster>();
  // (draw calls) ONE detail set for the whole POI — from anywhere inside it both halves were within range anyway,
  // two sets only doubled the ~17 per-material draws
  const region = (_key: string) => "all";
  const cl = (key: string): Cluster => {
    let c = clusters.get(key);
    if (!c) { const r = region(key); let d = dets.get(r); if (!d) { d = makeBins(mats, `canopy:${r}:det`); dets.set(r, d); } c = { main: MAIN, det: d, key: r }; clusters.set(key, c); }
    return c;
  };
  const rng = mulberry(90210);
  const crowns: THREE.Mesh[] = [];
  let crownTris = 0;

  // ---- columns: trunk / tower, their decks + stairs, the huts + shelters + props that stand on those decks
  for (let ci = 0; ci < LAYOUT.columns.length; ci++) {
    const c = LAYOUT.columns[ci];
    await ctx.yield();
    const k = cl(c.id);
    const rings = LAYOUT.rings.filter((g) => g.col === ci);
    const helix = LAYOUT.helices.find((h) => h.col === ci);
    if (c.kind === "tree") {
      addTrunk(k.main, c, rings.map((g) => g.y));
      addFlanges(k.main, c);
      await ctx.yield();
      const cr = addCrown(k.main, c, mats, ci);
      if (cr) { crowns.push(cr.mesh); crownTris += cr.tris; }
    } else addTower(k.main, k.det, rng);
    for (const g of rings) { await ctx.yield(); addRing(k.main, k.det, g, helix, rng); }
    await ctx.yield();
    if (helix) addHelix(k.main, k.det, helix, rng);
  }
  // (the crowns stay one mesh per tree: the foliage wind is weighted by the object-space height over the trunk top)
  for (const m of crowns) root.add(m);
  const clusterAt = (x: number, y: number, z: number): Cluster => {
    for (const g of LAYOUT.rings) { const c = LAYOUT.columns[g.col]; if (Math.abs(g.y - y) < 3.5 && Math.hypot(x - c.x, z - c.z) < g.r1 + 0.5) return cl(c.id); }
    return cl(`ground:${Math.floor(x / 60)},${Math.floor(z / 60)}`);
  };
  for (const h of LAYOUT.huts) { await ctx.yield(); const k = clusterAt(h.x, h.y, h.z); addHut(k.main, k.det, h, rng); }
  for (const s of LAYOUT.shelters) { await ctx.yield(); const k = clusterAt(s.x, s.y, s.z); addShelter(k.main, k.det, s, rng); }
  for (const p of LAYOUT.props) { await ctx.yield(); const k = clusterAt(p.x, p.y, p.z); addProp(k.main, k.det, p, rng); }
  for (const b of LAYOUT.bridges) { await ctx.yield(); const k = cl(b.a[1] > 55 ? "links:high" : "links:low"); addBridge(k.main, k.det, b, rng); }
  for (const z of LAYOUT.zips) { await ctx.yield(); const k = cl("links:zip"); addZip(k.main, k.det, z, rng); }
  await ctx.yield();

  // ---- flush: MAIN groups always drawn; DETAIL groups within DETAIL_FAR of their bounds
  let tris = crownTris;
  const lod: LodItem[] = [];
  const farC = new THREE.Vector3(185, 40, -250);
  // every switch below is INSTANT (userData.noCull: the engine's 0.3 s visibility scale fade shrinks a merged
  // POI-wide mesh toward its centre — the whole treetop village would grow out of one point)
  // and happens where its parts are sub-pixel (detail, interiors) or the POI is a few degrees wide (far proxy)
  let isFar = false;
  const farTest = (cam: THREE.Vector3) => {
    const f = root.userData.forceFar as boolean | undefined;   // (perf A/B tools: force the far proxy on / off)
    if (f !== undefined) return (isFar = f);
    const d = cam.distanceTo(farC); isFar = isFar ? d > FAR_SWITCH - 40 : d > FAR_SWITCH; return isFar;
  };
  { const gm = new THREE.Group(); gm.name = "canopy:main"; gm.userData.noCull = !OLD_LOD; tris += flushBins(MAIN, gm); root.add(gm); lod.push({ o: gm, test: (cam) => !farTest(cam) }); }
  let farTris = 0;
  {
    const fb = makeBins(mats, "canopy:far"); addFarProxy(fb);
    const gf = new THREE.Group(); gf.name = "canopy:far"; gf.userData.noCull = !OLD_LOD; farTris = flushBins(fb, gf); root.add(gf);
    gf.visible = false; lod.push({ o: gf, test: () => isFar });
  }
  await ctx.yield();
  for (const [r, d] of dets) {
    await ctx.yield();
    // detail: thin ropes / labels / small metal never cast (sub-texel in the cascades, pure shadow-pass cost)
    // only the rails / frames (woodDark) still cast from the DETAIL sets
    for (const k of ["rope", "label", "metal", "plastic", "wood", "bark", "fringe", "fabric", "rock", "twig"] as const) d[k].castShadow = false;
    const gd = new THREE.Group(); gd.name = `canopy:${r}:det`; gd.userData.noCull = !OLD_LOD; tris += flushBins(d, gd); root.add(gd);
    let detOn = true;
    if (gd.children.length) lod.push({ o: gd, test: (cam) => { const dd = cam.distanceTo(farC); detOn = detOn ? dd < DETAIL_FAR + 20 : dd < DETAIL_FAR; return detOn && !isFar; } });
  }
  // ---- furnished interiors (shared kit): every treehouse storey + the depot, merged per material family
  await ctx.yield();
  // three regional interior sets, each drawn only while the camera is within
  // INT_FAR of one of its rooms (a room seen through a window from farther is a dark opening anyway)
  const groupsOf: Record<string, string[]> = { plateau: ["lodge", "b-hut", "e-hut"], north: ["d-hut", "g-pod", "depot", "c-hut"], south: ["h-hut", "h-pod", "k-pod", "f-hut"] };
  for (const [gname, ids] of Object.entries(groupsOf)) {
    const rooms = INTERIOR_ROOMS.filter((r) => ids.includes((r.id ?? "").split(":")[0]));
    if (!rooms.length) continue;
    try {
      await ctx.yield();
      const ib = await buildInteriors(ctx, rooms, { name: `canopy:interiors:${gname}`, parent: root });
      root.add(ib.group); ib.group.userData.noCull = !OLD_LOD; tris += ib.tris;
      ib.group.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = false; o.userData.castShadow = false; } });   // (inside walls: no sun reaches them)
      const pts = rooms.map((r) => new THREE.Vector3(r.x, r.y + 1.5, r.z));
      lod.push({ o: ib.group, test: (cam) => pts.some((q) => q.distanceToSquared(cam) < INT_FAR * INT_FAR) });
    } catch (e) { console.error("canopy-line: interiors failed", gname, e); }
  }
  await ctx.yield();
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.matrixAutoUpdate = false; o.updateMatrix(); } });
  root.updateMatrixWorld(true);
  distanceSwitch(ctx, lod);

  // ---- dressing with the island's own plants: fern / monstera / banana skirts at the trunk feet, potted greens on
  // the camera deck (foreground monstera + banana), understorey around the huts on the ground
  const veg = ctx.shared.get("veg") as VegApi | undefined;
  if (veg) {
    const q: Partial<Record<PlantKind, THREE.Matrix4[]>> = {};
    const put = (k: PlantKind, x: number, y: number, z: number, s: number, yaw = rng() * 6.28) => { (q[k] ??= []).push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(s, s, s))); };
    for (const c of LAYOUT.columns) {
      if (c.kind !== "tree") continue;
      // (8 a trunk: thin foliage, so the trunk feet read as clean root flares + a skirt)
      for (let i = 0; i < 8; i++) {
        const a = rng() * 6.28, r = c.r + 1.2 + rng() * 5.5, [x, z] = rad(c, a, r);
        // keep the stair foot and the flanges' tips free
        const s0 = LAYOUT.helices.find((h) => LAYOUT.columns[h.col] === c)!.steps[0];
        if (Math.abs(Math.atan2(Math.sin(a - s0.a), Math.cos(a - s0.a))) < 0.9 && r < c.r + 4) continue;
        const kind: PlantKind = i % 4 === 0 ? "monstera" : i % 4 === 1 ? "banana-plant" : i % 4 === 2 ? "fern" : "bush";
        put(kind, x, groundAt(x, z) - 0.05, z, kind === "banana-plant" ? 1.1 + rng() * 0.4 : 1.2 + rng() * 0.5);
      }
    }
    // understorey under the valley decks: the clearings keep veg's scatter out of the deck footprints, which
    // left bare ground seen from above — palms only where the lowest deck / bridge overhead is ≥ 17 m up, low greens
    // (bush, banana, fern, monstera) elsewhere; never on the stair feet, the depot, props or the camp
    {
      const over = (x: number, z: number) => {
        let lo = Infinity;
        for (const g of LAYOUT.rings) { const c = LAYOUT.columns[g.col]; if (Math.hypot(x - c.x, z - c.z) < g.r1 + 2) lo = Math.min(lo, g.y - 0.8); }
        for (const b of LAYOUT.bridges) { const dx = b.b[0] - b.a[0], dz = b.b[2] - b.a[2], L2 = dx * dx + dz * dz, t = Math.min(1, Math.max(0, ((x - b.a[0]) * dx + (z - b.a[2]) * dz) / L2)); if (Math.hypot(x - (b.a[0] + dx * t), z - (b.a[2] + dz * t)) < 4) lo = Math.min(lo, sagY(b.a[1], b.b[1], b.sag, t) - 0.5); }
        return lo;
      };
      for (const c of LAYOUT.columns) {
        if (c.kind !== "tree") continue;
        const r1 = Math.max(...LAYOUT.rings.filter((g) => LAYOUT.columns[g.col] === c).map((g) => g.r1));
        const s0 = LAYOUT.helices.find((h) => LAYOUT.columns[h.col] === c)!.steps[0];
        // (18 a tree and no palms — light tree coverage, clear sight lines from the decks to the valley floor)
        for (let i = 0; i < 18; i++) {
          const a = rng() * 6.283, r = c.r + 3 + Math.sqrt(rng()) * (r1 + 2 - c.r - 3), [x, z] = rad(c, a, r);
          if (Math.abs(Math.atan2(Math.sin(a - s0.a), Math.cos(a - s0.a))) < 1.1 && r < c.r + 5) continue;
          const gy = groundAt(x, z);
          if (gy < 0.9) continue;
          if (LAYOUT.huts.some((h) => Math.abs(h.y - gy) < 3 && Math.hypot(h.x - x, h.z - z) < Math.hypot(h.w, h.d) / 2 + 2)) continue;
          if (LAYOUT.props.some((p) => Math.abs(p.y - gy) < 2 && Math.hypot(p.x - x, p.z - z) < Math.max(p.hx, p.hz) + 1.2)) continue;
          if (Math.hypot(x - CAMP[0], z - CAMP[1]) < 10) continue;
          const clear = over(x, z) - gy, k = rng();
          const kind: PlantKind = k < 0.45 ? "bush" : k < 0.65 ? "banana-plant" : k < 0.84 ? "fern" : "monstera";
          if (clear < 4) continue;
          put(kind, x, gy - 0.05, z, kind === "bush" ? 0.9 + rng() * 0.5 : 1.1 + rng() * 0.5);
        }
      }
    }
    // deck greenery: ferns / monstera / banana tubs along the rails (never in a gate, a stair hole or a hut)
    for (const g of LAYOUT.rings) {
      if (g.kind !== "tree") continue;
      const c = LAYOUT.columns[g.col];
      let placed = 0;
      for (let k = 0; k < 24 && placed < 4; k++) {
        const a = rng() * Math.PI * 2, r = g.r1 - 0.75, [x, z] = rad(c, a, r);
        if (g.gaps.some((h) => inArc(a, h) || inArc(a + 0.12, h) || inArc(a - 0.12, h))) continue;
        if (LAYOUT.huts.some((h) => Math.abs(h.y - g.y) < 0.1 && Math.hypot(h.x - x, h.z - z) < Math.hypot(h.w, h.d) / 2 + 1.2)) continue;
        if (LAYOUT.props.some((p) => Math.abs(p.y - g.y) < 0.1 && Math.hypot(p.x - x, p.z - z) < 1.8)) continue;
        const kind: PlantKind = placed % 3 === 0 ? "monstera" : placed % 3 === 1 ? "fern" : "banana-plant";
        put(kind, x, g.y - 0.05, z, kind === "banana-plant" ? 0.55 : kind === "monstera" ? 0.8 : 0.9);
        placed++;
      }
    }
    // flowers along the rails. (No hanging lianas under the deck rims — the veg vine is a 13 m span
    // whose ends sit 2–4 m UNDER the deck at its 0.75–0.95 scale: vines hanging from nothing)
    for (const g of LAYOUT.rings) {
      if (g.kind !== "tree") continue;
      const c = LAYOUT.columns[g.col];
      for (let k = 0; k < 10; k++) {
        const a = rng() * Math.PI * 2, [x, z] = rad(c, a, g.r1 - 0.55);
        if (g.gaps.some((h) => inArc(a, h) || inArc(a + 0.1, h) || inArc(a - 0.1, h))) continue;
        if (LAYOUT.huts.some((h) => Math.abs(h.y - g.y) < 0.1 && Math.hypot(h.x - x, h.z - z) < Math.hypot(h.w, h.d) / 2 + 1.4)) continue;
        if (LAYOUT.props.some((p) => Math.abs(p.y - g.y) < 0.1 && Math.hypot(p.x - x, p.z - z) < 1.6)) continue;
        put("flowers", x, g.y - 0.02, z, 0.8 + rng() * 0.3);
      }
    }
    // camera-deck foreground greens (in planter tubs, props dressing — visual only)
    const g = LAYOUT.rings[LAYOUT.deck.A1];
    for (const [f, r, k, s] of [[1.3, -2.9, "monstera", 1.0], [2.2, -3.6, "fern", 1.1], [5.2, -3.9, "banana-plant", 0.6]] as Array<[number, number, PlantKind, number]>) { const [x, z] = W(f, r); put(k, x, g.y - 0.05, z, s); }
    // the big lit foreground: a banana clump + monstera in the view camera's lower half (VIEW frame),
    // pulled onto the deck (≤ 8.6 m from the trunk) and clear of the crates / winch
    {
      const ca = LAYOUT.columns[g.col], [px, , pz] = VIEW.pos, hb = Math.atan2(VIEW.target[2] - pz, VIEW.target[0] - px);
      const F = (f: number, r: number): [number, number] => { let x = px + Math.cos(hb) * f - Math.sin(hb) * r, z = pz + Math.sin(hb) * f + Math.cos(hb) * r; const d = Math.hypot(x - ca.x, z - ca.z); if (d > 8.6) { x = ca.x + (x - ca.x) * 8.6 / d; z = ca.z + (z - ca.z) * 8.6 / d; } return [x, z]; };
      for (const [f, r, k, sc] of [[3.4, 0.9, "banana-plant", 0.95], [2.6, -1.6, "monstera", 1.15], [4.4, 2.1, "fern", 1.2]] as Array<[number, number, PlantKind, number]>) {
        const [x, z] = F(f, r);
        if (LAYOUT.props.some((p) => Math.abs(p.y - g.y) < 0.2 && Math.hypot(p.x - x, p.z - z) < Math.max(p.hx, p.hz) + 0.7)) continue;
        put(k, x, g.y - 0.05, z, sc);
      }
    }
    for (const [k, ms] of Object.entries(q)) { try { veg.plant(k as PlantKind, ms!); } catch (e) { console.warn("canopy-line: veg.plant failed", k, e); } }
  }

  // ---- zipline cable in first person: while the camera hangs within 1.6 m under a cable (a rider's eye is ~0.7 m
  // below it) the cable's fragments within 4.5 m of the camera fade out — no black wedge through the crosshair
  {
    const zs = LAYOUT.zips.map((z) => ({ z, dx: z.b[0] - z.a[0], dz: z.b[2] - z.a[2], L2: (z.b[0] - z.a[0]) ** 2 + (z.b[2] - z.a[2]) ** 2 }));
    ctx.onUpdate(() => {
      const p = ctx.camera.position;
      let hide = 0;
      if (Math.hypot(p.x - CX, p.z - CZ) < 200) for (const q of zs) {
        const t = Math.min(1, Math.max(0, ((p.x - q.z.a[0]) * q.dx + (p.z - q.z.a[2]) * q.dz) / q.L2));
        const x = q.z.a[0] + q.dx * t, zz = q.z.a[2] + q.dz * t, y = sagY(q.z.a[1], q.z.b[1], q.z.sag, t);
        const dh = Math.hypot(p.x - x, p.z - zz), dv = y - p.y;
        if (dh < 1.6 && dv > -0.6 && dv < 1.8) { hide = 4.5; break; }
      }
      ZIP_HIDE.value = hide;
    });
  }

  // perf probe (tools): ?canopyOff=crowns,det,main,cast hides / un-casts parts of this POI for A/B timing
  const off = flag("canopyOff");
  if (off.length) root.traverse((o) => {
    const n = o.name;
    if (off.includes("crowns") && n.startsWith("canopy:crown")) o.visible = false;
    if (off.includes("det") && n.endsWith(":det") && !n.includes(":det:")) o.visible = false;
    if (off.includes("main") && o.parent === root && !n.endsWith(":det") && !n.startsWith("canopy:crown")) o.visible = false;
    if (off.includes("cast") && (o as THREE.Mesh).isMesh) o.castShadow = false;
  });
  const ms = Math.round(performance.now() - t0);
  (root.userData as Record<string, unknown>).stats = { ms, tris, crownTris, farTris, clusters: clusters.size, draws: root.children.length };
  ctx.shared.set?.("canopy", { stats: root.userData.stats });
  console.info(`[canopy-line] built in ${ms} ms · ${Math.round(tris / 1000)} k tris (${Math.round(crownTris / 1000)} k crown) · far proxy ${Math.round(farTris / 1000)} k · ${clusters.size} clusters`);
}

const mod: WorldModule = { id: "poi:canopy-line", views, build };
export default mod;
