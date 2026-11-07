// POI mango-market — the island's dense town centre. Visuals derived from shared/pois/mango-market.ts LAYOUT (the
// same data the server collides against), merged per material into TownLod cells: fine (furniture, individual fruit,
// < 40 m) / near (props, interiors, lights, < 90 m) / main (shells, awnings, roofs) + one far proxy (> 250 m).
import * as THREE from "three";
import type { WorldModule } from "../../module";
import type { CamSpec } from "../../../engine/views";
import { LAYOUT, Y, FX, FZ, FOUNTAIN_R, STATUE_H, STATUE_YAW, PLAZA_POLY, A_FRONT, toW, toUV, yawUV, CAM_BUILDING, INTERIOR_ROOMS, townFlat, type RoofProp } from "../../../../../shared/pois/mango-market";
import { addStreet, addFence, addGardenWall, addLaundry, addCourt, addStreetPlanter, ribbonGeo } from "../_kit/town-streets";
import { HedgeSet } from "./hedges";
import { townInteriors } from "../_kit/town-interiors";
import { mulberry } from "../../../../../shared/pois/town-kit";
import { townMats, preloadTownTex, TownLod, type TownBins } from "../_kit/town-materials";
import { addBuilding, addBuildingLod1 } from "../_kit/town-building";
import * as K from "../_kit/town-market";
import { addFountain } from "../_kit/town-fountain";
import { M, col, latheGeo, polyGeo, boxGeo, cylGeo, lowDetail, mediumDetail } from "../_kit/town-geo";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { TownVeg } from "../_kit/town-veg";
import { FruitBatch, beginFruit, endFruit, withoutFruit } from "../_kit/town-fruit";
import { labViews, labRequested, buildLabs } from "../_kit/town-lab";
import { addRock } from "../_kit/town-lagoon";
import { SlicePace } from "../_kit/pace";

const A = CAM_BUILDING;
const AH = A.floors * (A.floorH ?? 3.2);
// view camera: A fronts the plaza directly; the camera stands on A's roof 2.4 m behind its
// front parapet at the left, 8.4 m above the plaza, and looks across the plaza ~14° right of the fountain: the fountain
// ~28 m away (≈ 14 % of the width, 44 % from the left), C's roof + teal tank bottom-left, B's red pent + olive stand
// tank right, the parapet crates across the bottom edge, stall rows both sides
const CAM_UV: [number, number] = [-3.4, A_FRONT - 2.4];
const CAM_H = AH + 2.7;
const cam = toW(CAM_UV[0], CAM_UV[1]), tgt = toW(3.7, 1.25);
const P3 = (u: number, v: number, y: number): [number, number, number] => { const p = toW(u, v); return [p[0], y, p[1]]; };
/** a gable roof prism (ridge along local x, span along z, eaves at y 0), both windings (the proxy material is one-sided) */
function gablePrism(L: number, W: number, h: number): THREE.BufferGeometry {
  const x0 = -L / 2, x1 = L / 2, z0 = -W / 2, z1 = W / 2;
  const A = [[x0, 0, z0], [x0, 0, z1], [x0, h, 0]], B = [[x1, 0, z0], [x1, 0, z1], [x1, h, 0]];
  const tris = [[A[0], A[2], A[1]], [B[0], B[1], B[2]], [A[1], B[1], B[2]], [A[1], B[2], A[2]], [A[0], A[2], B[2]], [A[0], B[2], B[0]]];
  const P: number[] = [];
  for (const t of tris) { P.push(...t[0], ...t[1], ...t[2]); P.push(...t[0], ...t[2], ...t[1]); }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(P, 3)); g.computeVertexNormals();
  return g;
}
const views: Record<string, CamSpec> = {
  // on building A's roof (near/south-west side of the plaza), looking NNE down the plaza axis over its dressed roof
  "poi-12-mango-market": { pos: [cam[0], Y + CAM_H, cam[1]], target: [tgt[0], Y + 3.4, tgt[1]], fov: 50, t: 12 },
  "mango-plaza-ground": { pos: P3(-9, -24, Y + 1.7), target: P3(3, 10, Y + 3), fov: 62, t: 12 },
  "mango-street": { pos: P3(-66, -4.2, Y + 1.7), target: P3(-20, -4.2, Y + 2.5), fov: 62, t: 12 },
  "mango-aerial": { pos: [FX - 60, Y + 70, FZ + 90], target: [FX, Y, FZ - 10], fov: 50, t: 12 },
  "mango-stall-close": { pos: P3(-7.2, 12, Y + 1.7), target: P3(-9.7, 15, Y + 1.1), fov: 60, t: 12 },
  "mango-fountain-close": { pos: P3(-2, -14, Y + 1.7), target: P3(0, 0, Y + 3.8), fov: 62, t: 12 },
  // inside shop D2 (ground floor), standing just inside the door looking diagonally across the room
  "mango-int": (() => {
    const b = LAYOUT.buildings[LAYOUT.ids.D2], c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    const L = (lx: number, ly: number, lz: number): [number, number, number] => [b.x + lx * c + lz * s, ly, b.z - lx * s + lz * c];
    return { pos: L(-b.w / 2 + 1.0, Y + 1.65, b.d / 2 - 0.9), target: L(b.w / 2 - 1.2, Y + 1.0, -b.d / 2 + 1.0), fov: 74, t: 12 };
  })(),
  // upstairs in D2 (first floor: a bedroom / living room)
  "mango-room-up": (() => {
    const b = LAYOUT.buildings[LAYOUT.ids.D2], c = Math.cos(b.yaw), s = Math.sin(b.yaw), fh = b.floorH ?? 3.2;
    const L = (lx: number, ly: number, lz: number): [number, number, number] => [b.x + lx * c + lz * s, ly, b.z - lx * s + lz * c];
    // (1.9 m in from the front corner, clear of where the open french leaves swing)
    return { pos: L(-b.w / 2 + 1.9, b.y + fh + 1.65, b.d / 2 - 1.9), target: L(b.w / 2 - 1.0, b.y + fh + 0.9, -b.d / 2 + 1.0), fov: 74, t: 12 };
  })(),
  ...labViews(),
};

const _sm = new THREE.Matrix4();
/** a prop's shadow-caster proxy (local frame `at`, base at y = 0): boxes / a canopy card per kind */
function propShadow(b: TownBins, kind: string, at: THREE.Matrix4, sc: number) {
  const B = (w: number, h: number, d: number, x: number, y: number, z: number, pitch = 0) => b.plastic.box(w, h, d, _sm.copy(at).multiply(M(x, y, z, 0, pitch)), 0xffffff);
  switch (kind) {
    case "stall": B(2.84, 0.05, 1.62, 0, 2.28, -0.1, Math.atan(0.3 / 1.3)); B(2.24, 0.8, 0.8, 0, 0.4, 0.26); for (const x of [-1.24, 1.24]) for (const z of [0.55, -0.75]) B(0.1, 2.3, 0.1, x, 1.15, z); break;
    case "scooter": B(1.7, 0.9, 0.5, 0, 0.55, 0); break;
    case "bench": B(1.8, 0.45, 0.45, 0, 0.25, 0); break;
    case "planter": B(sc * 2.2, 0.62, 0.5, 0, 0.31, 0); break;
    case "pot": B(0.62, 0.7, 0.62, 0, 0.35, 0); break;
    case "lamp": B(0.14, 3.4, 0.14, 0, 1.7, 0); B(0.4, 0.5, 0.4, 0, 3.4, 0); break;
    case "crate": case "pcrate": B(0.64, 0.36, 0.46, 0, 0.18, 0); break;
    case "cratestack": B(1.24, 1.0, 0.48, 0, 0.5, 0); break;
    case "barrel": B(0.58, 0.88, 0.58, 0, 0.44, 0); break;
    case "table": B(1.2, 0.9, 0.8, 0, 0.45, 0); break;
    case "cart": B(1.9, 0.95, 1.1, 0, 0.5, 0); break;
    case "sack": B(0.5, 0.42, 0.4, 0, 0.21, 0); break;
    case "bin": B(0.6, 1.0, 0.7, 0, 0.5, 0); break;
    case "basket": B(0.5, 0.3, 0.5, 0, 0.15, 0); break;
    default: break;
  }
}

const mod: WorldModule = {
  id: "poi:mango-market",
  views,
  async build(ctx) {
    if (labRequested()) { await buildLabs(ctx); return; }
    const t0 = performance.now();
    const pace = new SlicePace(ctx);
    const group = new THREE.Group();
    group.name = "poi:mango-market";
    ctx.scene.add(group);
    const tm: Record<string, number> = {}; let tl = performance.now();
    // (__townPhase tags each long task with the phase it fell in — `after:<last lap>`)
    const lap = (k: string) => { const n = performance.now(); tm[k] = Math.round(n - tl); tl = n; (globalThis as { __townPhase?: string }).__townPhase = `after:${k}`; };
    (globalThis as { __townPhase?: string }).__townPhase = "mats";
    await pace.wait(preloadTownTex(ctx.renderer, () => ctx.yield()));
    const mats = townMats(ctx.renderer);
    await pace.pause();
    lap("mats");
    // (individual fruit to 8.5 m — the painted heap mound carries the pile beyond; 11 m drew ~35 k fruit tris at
    // mango-fountain-close)
    const fruit = new FruitBatch(mats.fruit, { name: "mango:fruit", hi: 3, lo: 6, far: 8.5 });
    beginFruit(fruit);
    // perf: casting limited to 55 m (buildings' LOD1 twins) / 30 m (props' low copies) — the far map carries the proxy
    // town beyond; props get a FAR tier (canopy / bunting / bulb cards) out to 260 m; furniture only within 11 m
    const lod = new TownLod(mats, "mango", { cell: 48, fine: 30, near: 70, mid: 70, far: 240, propCell: 7, propDistrict: 35, propHi: 3.5, propMid: 10, propLo: 45, propFar: 260, itemNear: 40, itemFine: 11, itemMed: 24, castItem: 55, castProp: 22, frame: (x, z) => { const [u, v] = toUV(x, z); return [u + 24, v + 24]; } });
    const Mn = (x: number, z: number) => lod.main(x, z), Nr = (x: number, z: number) => lod.near(x, z);
    const rng = mulberry(77);
    const hedges = new HedgeSet("mango");
    const extra: THREE.Object3D[] = [];

    // ---- ground: town-wide street paving + the raised plaza floor with a kerb and a ring pattern round the fountain
    for (const [bi, [u0, v0, u1, v1]] of [...LAYOUT.blocks, [-26, -46, 26, 37] as [number, number, number, number]].entries()) {
      const e = 3.2, poly = [toW(u0 - e, v0 - e), toW(u1 + e, v0 - e), toW(u1 + e, v1 + e), toW(u0 - e, v1 + e)];
      const [mx, mz] = toW((u0 + u1) / 2, (v0 + v1) / 2);
      // the block pads overlap their neighbours (and run 3 m under the streets): each pad its own height, all
      // clear below the carriageways (+35 mm) — a hash step could put two neighbours (or a pad and a street) in one plane
      Mn(mx, mz).paving.add(polyGeo(poly, Y + 0.018 + (bi % 5) * 0.0025, 1), null, col("#c9c0b3"));
      await pace.pause();
    }
    // the street plan: every street a paved ribbon with gutters + kerb lines (cut where the ground leaves the
    // pad), the second square paved, the school court painted, the orchard planted
    const onOtherStreet = (x: number, z: number, self: number) => LAYOUT.streets.some((o, oi) => {
      if (oi === self) return false;
      for (let k = 1; k < o.pts.length; k++) { const a = o.pts[k - 1], b = o.pts[k], dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz || 1e-9, t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)); if (Math.hypot(x - a[0] - t * dx, z - a[1] - t * dz) < o.w / 2 + 0.6) return true; }
      return false;
    }) || LAYOUT.squares.some((sq) => { let ins = false; for (let i = 0, j = sq.length - 1; i < sq.length; j = i++) { const [xi, zi] = sq[i], [xj, zj] = sq[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) ins = !ins; } return ins; });
    for (const [si, st] of LAYOUT.streets.entries()) {
      // per ~30 m chunk so each piece lives in its own LOD cell
      for (let i = 0; i < st.pts.length - 1; i += 10) {
        const seg = st.pts.slice(i, Math.min(st.pts.length, i + 11)), m = seg[Math.floor(seg.length / 2)];
        addStreet(Mn(m[0], m[1]), seg, st.w, Y, st.kind, (x, z) => townFlat(x, z, -2), (x, z) => !onOtherStreet(x, z, si), (si % 4) * 0.001);
        await pace.pause();
      }
    }
    for (const sq of LAYOUT.squares) {
      const c = sq.reduce((a, p) => [a[0] + p[0] / sq.length, a[1] + p[1] / sq.length], [0, 0]);
      // (flush with the streets — a raised slab read as a stage; a darker border band + two ring bands)
      Mn(c[0], c[1]).paving.add(polyGeo(sq, Y + 0.04, 1), null, col("#e3d5bf"));
      for (let i = 0; i < sq.length; i++) { const a = sq[i], b = sq[(i + 1) % sq.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]); Mn(c[0], c[1]).paving.box(len + 0.4, 0.012, 0.9, M((a[0] + b[0]) / 2 - (a[0] + b[0] - 2 * c[0]) * 0.02, Y + 0.046, (a[1] + b[1]) / 2 - (a[1] + b[1] - 2 * c[1]) * 0.02, Math.atan2(b[0] - a[0], b[1] - a[1]) + Math.PI / 2), col("#a89a86")); }
      for (const [r0, r1, cc] of [[4.5, 5.2, "#c2b39b"], [9.0, 9.5, "#c8b9a2"]] as Array<[number, number, string]>) Mn(c[0], c[1]).paving.add(latheGeo([[r0, 0], [r1, 0]], 48, 1), M(c[0], Y + 0.045, c[1]), col(cc));
      await pace.pause();
    }
    for (const pl of LAYOUT.places) {
      if (pl.kind === "court" && pl.poly) { const a = pl.poly[0], b = pl.poly[1], d = pl.poly[3], w = Math.hypot(b[0] - a[0], b[1] - a[1]), dd = Math.hypot(d[0] - a[0], d[1] - a[1]); addCourt(Mn(pl.x, pl.z), M(pl.x, Y, pl.z, Math.atan2(-(b[1] - a[1]), b[0] - a[0])), w, dd); }
    }
    await pace.pause();
    const pl = PLAZA_POLY.map(([u, v]) => toW(u, v));
    Mn(FX, FZ).paving.add(polyGeo(pl, Y + 0.12, 1), null, col("#e9dccb"));
    for (let i = 0; i < pl.length; i++) {
      const a = pl[i], b = pl[(i + 1) % pl.length], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      Mn(FX, FZ).stone.bbox(len + 0.3, 0.16, 0.34, M((a[0] + b[0]) / 2, Y + 0.06, (a[1] + b[1]) / 2, Math.atan2(b[0] - a[0], b[1] - a[1]) + Math.PI / 2), col("#c6bdb0"), 0.04);
    }
    await pace.pause();
    // concentric ring bands of darker slabs round the fountain
    for (const [r0, r1, c] of [[FOUNTAIN_R + 1.5, FOUNTAIN_R + 2.4, "#b3aa9d"], [FOUNTAIN_R + 5.2, FOUNTAIN_R + 5.8, "#a79e91"], [FOUNTAIN_R + 9.0, FOUNTAIN_R + 9.5, "#b0a699"]] as Array<[number, number, string]>)
      Mn(FX, FZ).paving.add(latheGeo([[r0, 0], [r1, 0]], 72, 1), M(FX, Y + 0.125, FZ), col(c));

    lap("ground");
    const veg = new TownVeg(ctx, Nr(FX, FZ), rng);
    // ---- buildings: hero ring (full detail), fabric by distance from the plaza.
    // perf: buildings are LOD'd in GROUPS (26 m squares of the plaza frame), not one by one — every (group, tier, bin)
    // is one sub-draw of its BatchedMesh, and per-building items make ~1.3 k sub-draws (+ as many shadow sub-draws) at
    // poi-12. A group switches to its LOD1 boxes beyond the largest `mid` of its members.
    const GC = 26;
    // (the plaza ring groups apart from the fabric — a fabric house sharing a square with a ring house would be held at the
    // ring's 110 m full-shell distance)
    // the PLAZA ring = the hand-authored ring minus its back-street houses behind the camera row (those are fabric —
    // otherwise they sit in the ring's 110 m full-shell groups behind the view camera)
    const isRing = (i: number) => i < LAYOUT.ring && toUV(LAYOUT.parts[i].b.x, LAYOUT.parts[i].b.z)[1] > A_FRONT - 11.5;
    const groupOf = (b: { x: number; z: number }, i = 1e9) => { const [u, v] = toUV(b.x, b.z); return `${isRing(i) ? "r" : "g"}${Math.floor((u + 13) / GC)},${Math.floor((v + 13) / GC)}`; };
    // 3×3 groups share a PARENT whose merged LOD1 replaces them all once every one of them is beyond its `mid`
    const parentOf = (b: { x: number; z: number }, i = 1e9) => { const [u, v] = toUV(b.x, b.z); return `${isRing(i) ? "r" : "g"}${Math.floor((u + 13) / (GC * 3))},${Math.floor((v + 13) / (GC * 3))}`; };
    const midOf = (i: number) => { const b = LAYOUT.parts[i].b, dist = Math.hypot(b.x - FX, b.z - FZ); return isRing(i) ? 110 : dist < 45 ? 55 : 40; };
    const groupMid = new Map<string, number>();
    for (let i = 0; i < LAYOUT.parts.length; i++) { const k = groupOf(LAYOUT.parts[i].b, i); groupMid.set(k, Math.max(groupMid.get(k) ?? 0, midOf(i))); }
    for (let i = 0; i < LAYOUT.parts.length; i++) {
      await pace.pause();
      const parts = LAYOUT.parts[i], b = parts.b;
      const dist = Math.hypot(b.x - FX, b.z - FZ);
      // bevelled trims (lod 2) only where the view camera / a kong sees them up close; the ring + plaza fabric at lod 1
      const dCam = Math.hypot(b.x - cam[0], b.z - cam[1]);
      // (A itself — the camera's own building, never in the view's frame — at lod 1)
      const lv = dCam < 15 && i !== LAYOUT.ids.A ? 2 : i < LAYOUT.ring || dist < 45 ? 1 : 0;
      // full shells within the group's `mid`, the textured LOD1 facade boxes beyond (≥ 60 m, ring 110 m — a 70 m
      // swap is visible from rooftops and the drop)
      const gk = groupOf(b, i);
      const it = lod.item(gk, b.x, b.z, { mid: groupMid.get(gk), parent: parentOf(b, i) });
      // sub-draws: trims share the plaster batch (same texture set) in the full shell
      (it.main as Record<string, unknown>).trim = it.main.plaster;
      addBuildingLod1(it.lod1, parts);
      if (it.plod1) addBuildingLod1(it.plod1, parts);
      await pace.pause();
      // rooftop props: `med` = the building's medium copy (no veg planting — that is its own LOD'd instance)
      const roofProp = (med: boolean) => (bins: TownBins, at: THREE.Matrix4, pr: RoofProp, r: () => number): boolean => {
        // rooftop planters grow real banana plants / small palms everywhere:
        // the ring's are the hero kit, the fabric's are the veg area's instanced plants (cheap, LOD'd, impostors)
        if (pr.kind === "planter") {
          const sc = pr.s ?? 1, e = at.elements;
          K.addPot(bins, at, r, { size: 0.5 * sc, plant: "none" });
          if (i < LAYOUT.ring) K.addBananaPlant(bins, at.clone().multiply(M(0, 0.46 * sc, 0)), r, { h: 1.1 * sc + (sc >= 1.3 ? 1.6 : 0.2), leaf: 1.2 * sc + (sc >= 1.3 ? 0.9 : 0), n: med ? 5 : 7, pitch: 0.45 });
          // (banana plants only — a rooftop palm's trunk is a drawn solid with no collider)
          else if (!med) { void r(); veg.plant("banana-plant", e[12], e[14], r() * 6.28, r() < 0.7 ? 0.45 + 0.2 * sc : 0.4 + 0.15 * sc, e[13] + 0.46 * sc); }
          return true;
        }
        if (i >= LAYOUT.ring) return false;
        // (full-kit tanks / AC only on the view camera's neighbours; the rest of the ring's roofs in medium detail —
        // ~1.5–3 k tris a tank at full detail, never seen closer than ~7 m below a kong on the street)
        const wrap = !med && dCam > 15 ? mediumDetail : <T>(f: () => T) => f();
        if (pr.kind === "plastic" || pr.kind === "steel" || pr.kind === "stand" || pr.kind === "tower") { wrap(() => K.addWaterTank(bins, at, r, { kind: pr.kind as "plastic", color: pr.color, scale: pr.s })); return true; }
        if (pr.kind === "ac") { wrap(() => K.addACUnit(bins, at, r)); return true; }
        return false;
      };
      addBuilding(it.main, mats, parts, {
        // furniture stays PER BUILDING (its own tiny item: only the rooms within ~11 m of a kong below the roof)
        // (the near tier — floors, flower boxes, lamps — lives in the shell bins: with the medium tier from 30 m it is
        // never drawn without the shell anyway, and would cost a second set of sub-draws)
        extra, lod: lv, near: it.main, fine: lod.item(`f${i}`, b.x, b.z, { top: b.y + parts.H }).fine, kitFurniture: true,
        // the ring's rooftop tanks/AC use the detailed market kit; the fabric keeps the cheap lathe tanks
        roofProp: roofProp(false),
      });
      await pace.pause();
      // perf: the MEDIUM copy (drawn from 30 m to the group's `mid`): the painted LOD1 facade + real lintels / sills /
      // jambs + the low-detail rooftop kit — ~2–3 k tris a ring house instead of ~12 k (the rooftop tanks alone were ~5 k)
      lowDetail(() => addBuildingLod1(it.med, { ...parts, rng: mulberry(b.seed ?? 1) }, { frames: true, roofProp: roofProp(true) }));
    }

    lap("buildings");
    // ---- FACADE DRESSING on the side / back walls that face a street: a
    // split-AC unit high on each upper storey between the windows, a wall lamp over the ground floor, a drainpipe at the
    // corner. Above head height (≥ 2.1 m over the floor), visual only.
    {
      const inB = (x: number, z: number, m: number) => LAYOUT.buildings.some((q) => { const c = Math.cos(q.yaw), sn = Math.sin(q.yaw), dx = x - q.x, dz = z - q.z; return Math.abs(dx * c - dz * sn) < q.w / 2 + m && Math.abs(dx * sn + dz * c) < q.d / 2 + m; });
      const fr = mulberry(4407);
      for (let i = 0; i < LAYOUT.parts.length; i++) {
        if (i === LAYOUT.ids.A) continue;
        await pace.pause();
        const p = LAYOUT.parts[i], b = p.b, c = Math.cos(b.yaw), sn = Math.sin(b.yaw), fh = b.floorH ?? 3.2;
        for (const w of p.walls) {
          await pace.pause();
          const out = (u: number, o: number): [number, number] => { const lx = w.A[0] + w.dir[0] * u + w.n[0] * o, lz = w.A[1] + w.dir[1] * u + w.n[1] * o; return [b.x + lx * c + lz * sn, b.z - lx * sn + lz * c]; };
          const mid = out(w.len / 2, 2.6);
          if (inB(mid[0], mid[1], 0.1)) continue;   // a party wall / a slot: never seen
          const yaw = Math.atan2(w.n[0] * c + w.n[1] * sn, -w.n[0] * sn + w.n[1] * c);
          for (let f = 1; f < b.floors; f++) {
            if (fr() < 0.35) continue;
            const ops = w.openings[f] ?? [];
            let u = -1;
            for (let k = 0; k < 6 && u < 0; k++) { const t = 0.9 + fr() * (w.len - 1.8); if (ops.every((o) => t < o.u - 0.6 || t > o.u + o.w + 0.6)) u = t; }
            if (u < 0) continue;
            const [x, z] = out(u, 0.22), at = M(x, b.y + f * fh + 2.05, z, yaw);
            const { hi, lo } = lod.prop(x, z);
            K.addACUnit(hi, at, fr); lowDetail(() => K.addACUnit(lo, at, mulberry(i * 31 + f)));
            // condensate drip stain + the pipe run down the wall
            Mn(x, z).metal.add(cylGeo(0.022, 0.022, 1.1, 6), M(x + Math.cos(yaw) * 0.0, b.y + f * fh + 1.5, z, yaw).multiply(M(0.3, 0, -0.08)), col("#d8d2c4"));
          }
          if (fr() < 0.5) { // a bracket wall lamp over the ground floor
            const t = 0.8 + fr() * (w.len - 1.6), ops0 = w.openings[0] ?? [];
            if (ops0.every((o) => t < o.u - 0.3 || t > o.u + o.w + 0.3)) {
              const [x, z] = out(t, 0.0), m = M(x, b.y + 2.75, z, yaw);
              const nb = Mn(x, z);
              nb.metal.add(cylGeo(0.018, 0.018, 0.4, 6).rotateX(Math.PI / 2), m.clone().multiply(M(0, 0, 0.2)), col("#2b2d30"));
              nb.metal.add(cylGeo(0.07, 0.12, 0.16, 10), m.clone().multiply(M(0, -0.05, 0.4)), col("#2b2d30"));
              nb.bulb.add(cylGeo(0.06, 0.06, 0.08, 8), m.clone().multiply(M(0, -0.15, 0.4)), 0xffffff);
            }
          }
        }
      }
    }
    // ---- view foreground: the camera stands on A's roof 2.4 m behind its front parapet. A's parapet carries
    // a crate of mangoes (bottom-right of centre) + pots; a big banana plant beside the camera sweeps its leaves up the
    // left edge; C's front corner (2.5 m proud of A, bottom-left) carries the teal tank (layout roof prop), a crate of
    // bananas, a planter box; B's front-left corner (bottom-right) the olive stand tank (layout), monstera, fern, crate
    {
      const hb = Nr(cam[0], cam[1]), F = A_FRONT;
      const at = (u: number, v: number, y: number, yaw = 0) => { const [x, z] = toW(u, v); return M(x, Y + y, z, yawUV(0, 1) + yaw); };
      const plant = (k: "monstera" | "fern" | "banana-plant" | "palm", u: number, v: number, y: number, s: number, yaw = 0) => { const [x, z] = toW(u, v); veg.plant(k, x, z, yaw, s, Y + y); };
      const ap = AH + 0.3 + 0.02, pF = F - 0.13;
      // A's front parapet: mango crate (the bottom-right hero crate), a flower pot, a small green crate
      K.addFruitCrate(hb, at(-1.35, pF, ap, -Math.PI / 2 - 0.08), rng, { heap: 1.0, color: "#8a5a34", w: 0.72, d: 0.46 });
      K.addPot(hb, at(-0.3, pF - 0.5, AH, 0.4), rng, { size: 0.55, plant: "none" }); plant("monstera", -0.3, pF - 0.5, AH + 0.55, 0.9, 3.4);
      K.addPot(hb, at(0.9, pF - 0.6, AH), rng, { size: 0.5, plant: "none" }); plant("fern", 0.9, pF - 0.6, AH + 0.46, 1.3, 0.4);
      K.addPot(hb, at(-2.6, pF - 0.45, AH, 0.5), rng, { size: 0.45, plant: "flowers" });
      K.addPlasticCrate(hb, at(1.9, pF - 0.5, AH, -0.3), "#4c9a3b", { fruit: "mango" });
      await pace.pause();
      // the big banana plant left of the camera (its leaves frame the left edge) + a second one behind
      K.addPot(hb, at(-6.4, -24.3, 6.0, 0.4), rng, { size: 0.72, plant: "none" });
      K.addBananaPlant(hb, at(-6.4, -24.3, 6.0 + 0.66, 0), rng, { h: 2.0, leaf: 3.4, pitch: 0.6, yaws: [0.9, 1.3, 1.75, 2.2, 0.45, 2.7, -0.3] });
      K.addWaterTank(hb, at(1.8, F - 6.0, AH, 0.3), rng, { kind: "plastic", color: "#2f4f8f", scale: 1.1 });
      await pace.pause();
      // C's front-right corner: crate of bananas on the parapet, a planter box, a pot with a banana plant
      const cy = 6.0 + 0.45 + 0.02;
      K.addFruitCrate(hb, at(-6.3, -23.25, cy, 0.08), rng, { fruit: "banana", heap: 1.0, color: "#b98b58", w: 0.66, d: 0.42 });
      K.addPlanterBox(hb, at(-8.2, -23.25, cy, 0), rng, { w: 1.1, color: "#3f8f78", flowers: ["#e0402f", "#f2b233"] });
      K.addPot(hb, at(-9.4, -26.4, 6.0, 0.4), rng, { size: 0.78, plant: "none" });
      K.addBananaPlant(hb, at(-9.4, -26.4, 6.0 + 0.72, 0), rng, { h: 2.8, leaf: 3.3, pitch: 0.6, yaws: [0.2, 0.55, 0.95, 1.3, 1.75, 2.2, -0.2, 2.75, -2.9, -0.6] });
      K.addPlasticCrate(hb, at(-5.4, -25.4, 6.0, 0.4), "#d9483b", { fruit: "banana" });
      await pace.pause();
      // big banana leaves up the left edge: a tall plant on C's roof just outside the frame, leaves fanned
      // toward the camera axis
      K.addPot(hb, at(-5.9, -25.0, 6.0, 0.4), rng, { size: 0.8, plant: "none" });
      K.addBananaPlant(hb, at(-5.9, -25.0, 6.0 + 0.74, 0), rng, { h: 1.3, leaf: 3.6, pitch: 0.16, yaws: [0.5, 0.9, 1.3, 1.7, 0.1, 2.2, 2.8] });
      await pace.pause();
      // B's grey pipes on its yellow wall facing the camera (downpipe + elbow + a run under the pent + a valve)
      {
        const [px, pz] = toW(3.12, -20.45), pc = col("#9aa0a6");
        hb.metal.add(new THREE.CylinderGeometry(0.075, 0.075, 6.3, 10), M(px, Y + 3.45, pz), pc);
        hb.metal.add(new THREE.TorusGeometry(0.22, 0.075, 8, 10, Math.PI / 2), M(px, Y + 6.6, pz, yawUV(0, 1) + Math.PI / 2, 0, 0), pc);
        const [qx, qz] = toW(3.1, -21.7);
        hb.metal.add(new THREE.CylinderGeometry(0.06, 0.06, 2.4, 10).rotateX(Math.PI / 2), M(qx, Y + 5.55, qz, yawUV(0, 1)), pc);
        const [vx, vz] = toW(3.0, -21.4);
        hb.metal.add(new THREE.CylinderGeometry(0.11, 0.11, 0.18, 10).rotateZ(Math.PI / 2), M(vx, Y + 5.55, vz, yawUV(0, 1)), col("#c23a2a"));
      }
      await pace.pause();
      // B's front-left corner (bottom-right): monstera + fern pots, a crate of mangoes on the parapet
      const by = 6.2 + 0.5 + 0.02;
      K.addFruitCrate(hb, at(3.9, -20.13, by, 0.06), rng, { heap: 1.0, color: "#2f8f86", w: 0.7, d: 0.45 });
      K.addPot(hb, at(4.2, -22.4, 6.2), rng, { size: 0.62, plant: "none" }); plant("monstera", 4.2, -22.4, 6.2 + 0.6, 1.0, 3.4);
      K.addPot(hb, at(4.4, -24.6, 6.2), rng, { size: 0.55, plant: "none" }); plant("fern", 4.4, -24.6, 6.2 + 0.5, 1.4, 0.4);
      K.addPot(hb, at(4.0, -25.8, 6.2, 0.4), rng, { size: 0.42, plant: "flowers" });
    }

    await pace.pause();
    lap("hero");
    // ---- fountain + statue + water (the fountain kit: shared dims = the colliders)
    await addFountain(ctx, Mn(FX, FZ), mats, M(FX, Y + 0.12, FZ), extra, rng, { R: FOUNTAIN_R, statueHeight: STATUE_H, statueYaw: STATUE_YAW }, pace);

    lap("fountain");
    // ---- props (market kit), perf: every prop is built TWICE into its 12 m prop cell — the full kit (`hi`, drawn
    // within ~22 m) and the same kit inside `lowDetail()` (`lo`, plain boxes / fewer segments / no tiny parts / no fruit,
    // drawn out to 75 m). Individual fruit lives in the FruitBatch (own LOD); the painted heap mound carries the pile.
    // Each prop draws its random choices from its own seeded rng so both copies agree.
    for (let pi = 0; pi < LAYOUT.props.length; pi++) {
      await pace.pause();
      const p = LAYOUT.props[pi];
      if (p.kind === "palm" || p.kind === "banana-plant" || p.kind === "bush" || p.kind === "monstera" || p.kind === "fern") { veg.plant(p.kind, p.x, p.z, p.yaw, p.s ?? 1, p.y ?? Y); continue; }
      // yards: shade trees (the veg area's broadleaf), walls / hedges / fences / washing lines (town-streets)
      if (p.kind === "tree") { veg.plant("jungle-tree", p.x, p.z, p.yaw, p.s ?? 0.6, p.y ?? Y); continue; }
      // hedges: their own sculpted, leaf-textured, instanced set with its own LOD (./hedges.ts)
      if (p.kind === "hedge") { hedges.add(p.x, (p.y ?? Y) + 0.02, p.z, p.yaw, p.s ?? 2, mulberry(9001 + pi * 7)); continue; }
      if (p.kind === "fence" || p.kind === "gwall" || p.kind === "laundry" || p.kind === "splanter") {
        const at = M(p.x, (p.y ?? Y) + 0.02, p.z, p.yaw), { hi, lo, plo, far } = lod.prop(p.x, p.z), len = p.s ?? 2;
        const draw = (nb: TownBins, low: boolean) => {
          const r = mulberry(9001 + pi * 7);
          if (p.kind === "fence") addFence(nb, at, len, p.color ?? "#f4efe1", low);
          else if (p.kind === "gwall") addGardenWall(nb, at, len, p.color ?? "#f6efe0");
          else if (p.kind === "splanter") addStreetPlanter(nb, at, len, p.color ?? "#f2e8d0", r, low);
          else addLaundry(nb, at, len, r);
        };
        draw(hi, false); lowDetail(() => draw(lo, true));
        // the yard runs are in the district's low copy too, not only their CELL's tiers — once
        // the district (its bounds = the other props) switches to its low copy, the cell is covered and the wall /
        // fence / planter would vanish 3 m from a kong. Also in its far tier (to propFar)
        if (plo) lowDetail(() => draw(plo, true));
        if (p.kind !== "laundry") lowDetail(() => draw(far, true));
        continue;
      }
      // the outskirts' cover boulders: sculpted, moss-capped, the 320-tri shape
      if (p.kind === "rock") { addRock(lod.main(p.x, p.z), M(p.x, (p.y ?? Y) + (p.s ?? 1) * 0.1, p.z, p.yaw), p.s ?? 1, mulberry(pi * 7 + 3), 0.75, "#a8a08a", true); continue; }
      const at = M(p.x, (p.y ?? Y) + 0.03, p.z, p.yaw);
      const { hi, lo, mid, plo, sh, psh } = lod.prop(p.x, p.z);
      // (contact blobs live in the cells' MAIN tier — two tris each, and the near tier doubled the cells' sub-draws)
      const blob = (w: number, d: number) => Mn(p.x, p.z).blob.add(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), at.clone().multiply(M(0, 0.02, 0)), 0xffffff);
      const build = (nb: TownBins, low: boolean) => {
        const r = mulberry(9001 + pi * 7);
        switch (p.kind) {
          case "stall": K.addStall(nb, at, r, { stripe: p.v ?? 0, fruit: p.fruit ?? "mixed", lod: low ? 2 : 1 }); break;
          case "scooter": K.addScooter(nb, at, p.color ?? "#f2c132"); break;
          case "bench": K.addBench(nb, at, { kind: r() < 0.5 ? "stone" : "wood" }); break;
          case "planter": K.addPlanterBox(nb, at, r, { w: (p.s ?? 0.5) * 2.2, color: ["#3f8f78", "#c85a3a", "#8a5a34", "#2f6fb0"][Math.floor(r() * 4)] }); break;
          case "pot": K.addPot(nb, at, r, { size: p.s ?? 0.45, plant: r() < 0.5 ? "leafy" : "flowers" }); break;
          case "lamp": K.addLampPost(nb, at); break;
          case "crate": K.addFruitCrate(nb, at, r, { color: ["#2f8f86", "#3a6fb0", "#c85a3a", "#8a5a34"][(p.v ?? 0) % 4], fruit: p.fruit === "banana" ? "banana" : "mango", heap: 0.8, lod: 2 }); break;
          case "pcrate": K.addPlasticCrate(nb, at, p.color ?? ["#3f8f3a", "#3a6fb0", "#d9483b", "#f1c232"][(p.v ?? 0) % 4], { fruit: r() < 0.6 ? (r() < 0.6 ? "mango" : "banana") : null, lod: 2 }); break;
          case "cratestack": K.addCrateStack(nb, at, r, 3 + Math.floor(r() * 3)); break;
          case "barrel": { const c = ["#2fb3a8", "#3a6fb0", "#c9553d", "#7a7f85"][(p.v ?? 0) % 4]; nb.metal.add(latheGeo([[0, 0], [0.28, 0], [0.29, 0.02], [0.29, 0.26], [0.31, 0.29], [0.29, 0.32], [0.29, 0.56], [0.31, 0.59], [0.29, 0.62], [0.29, 0.86], [0.27, 0.88], [0, 0.88]], 16), at, col(c)); break; }
          case "table": K.addBench(nb, at, { kind: "wood" }); K.addPlasticCrate(nb, at.clone().multiply(M(-0.35, 0.458, 0, 0.1)), "#f0b92e", { fruit: p.fruit === "banana" ? "banana" : "mango", lod: 2 }); K.addPlasticCrate(nb, at.clone().multiply(M(0.35, 0.458, 0, -0.1)), "#2a9d8f", { fruit: "mango", lod: 2 }); break;
          case "cart": K.addHandcart(nb, at, r); break;
          case "sack": K.addSack(nb, at, r); break;
          // a wheelie bin against a wall: body, lid with a lip, axle + wheels, handle bar
          case "bin": {
            const bc = col(["#2f6b3a", "#2f4f8f", "#5a5f66", "#8a6a2a"][(p.v ?? 0) % 4]);
            nb.plastic.bbox(0.6, 0.94, 0.68, at.clone().multiply(M(0, 0.49, 0)), bc, 0.05);
            nb.plastic.bbox(0.64, 0.07, 0.74, at.clone().multiply(M(0, 0.995, 0.02, 0, -0.04)), bc.clone().multiplyScalar(0.85), 0.03);
            nb.metal.add(new THREE.CylinderGeometry(0.02, 0.02, 0.62, 6).rotateZ(Math.PI / 2), at.clone().multiply(M(0, 0.9, -0.36)), col("#3a3d42"));
            for (const sx of [-0.25, 0.25]) nb.metal.add(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 10).rotateZ(Math.PI / 2), at.clone().multiply(M(sx, 0.09, -0.3)), col("#1f2124"));
            break;
          }
          case "basket": K.addBasket(nb, at, r, p.fruit === "banana" ? "banana" : "mango"); break;
          default: break;
        }
      };
      build(hi, false);
      await pace.pause();
      withoutFruit(() => mediumDetail(() => build(mid, false)));
      await pace.pause();
      lowDetail(() => build(lo, true));
      if (plo) lowDetail(() => build(plo, true));
      // explicit shadow casters (a few boxes / a canopy card a prop) — ~10× cheaper than casting the low copy
      for (const sb of psh ? [sh, psh] : [sh]) propShadow(sb, p.kind, at, p.s ?? 0.5);
      // far tier: stalls keep a canopy card + table block out to 260 m, and their canopy casts in the far map
      if (p.kind === "stall") {
        const { far } = lod.prop(p.x, p.z);
        K.addStallFar(far, at, p.v ?? 0);
        lod.proxyGeo(new THREE.BoxGeometry(2.8, 0.08, 1.6), at.clone().multiply(M(0, 2.3, -0.1)), "#d9c7a8");
      }
      const bl: Partial<Record<string, [number, number]>> = { stall: [3.2, 2.2], scooter: [2.0, 0.9], bench: [2.0, 0.8], planter: [1.4, 0.8], pot: [0.9, 0.9], crate: [0.9, 0.7], pcrate: [0.8, 0.6], cratestack: [1.6, 0.8], barrel: [0.9, 0.9], table: [2.0, 0.8], cart: [2.0, 1.1] };
      const bd = bl[p.kind]; if (bd) blob(bd[0], bd[1]);
    }
    await veg.flushAsync(pace);

    // ---- lines: string lights + bunting (market kit) — full + low copies like the props
    for (let li = 0; li < LAYOUT.lines.length; li++) {
      await pace.pause();
      const l = LAYOUT.lines[li];
      const a = new THREE.Vector3(...l.a), b = new THREE.Vector3(...l.b);
      const { hi, lo, far } = lod.prop((a.x + b.x) / 2, (a.z + b.z) / 2, `l${li}`);
      const draw = (nb: TownBins, r: () => number) => { if (l.kind === "lights") K.addStringLights(nb, a, b, l.sag); else K.addBunting(nb, a, b, l.sag, r); };
      const seed = Math.floor(rng() * 1e9);
      draw(hi, mulberry(seed));
      lowDetail(() => draw(lo, mulberry(seed)));
      if (l.kind === "lights") K.addLightsFar(far, a, b, l.sag); else K.addBuntingFar(far, a, b, l.sag, mulberry(seed));
    }

    // ---- stone foundations under the slope houses
    for (const pl of LAYOUT.plinths) {
      Mn(pl.x, pl.z).stone.bbox(pl.w, pl.y1 - pl.y0, pl.d, M(pl.x, (pl.y0 + pl.y1) / 2, pl.z, pl.yaw), col("#b3a68c"), 0.06, (x, y, z, b, o) => { const k = Math.min(1, Math.max(0, (y - pl.y0) / 1.2)); o.multiplyScalar(0.75 + 0.25 * k); if (y < pl.y0 + 0.7) o.lerp(new THREE.Color("#6f7d4a"), 0.35 * (1 - k)); });
      lod.proxyGeo(boxGeo(pl.w, pl.y1 - pl.y0, pl.d), M(pl.x, (pl.y0 + pl.y1) / 2, pl.z, pl.yaw), "#a89b82");
      await pace.pause();
    }

    // ---- the far proxy carries the town's GROUND PLAN: otherwise beyond 240 m the streets, squares, the plaza and the
    // paved blocks vanish with the detailed town (boxes on grass from the drop), and the whole street plan appears
    // at the switch. Same outlines as the detailed paving, its base colour, one polygon-offset material, no shadow.
    // (untextured, so ~15 % darker than the paving's tint: the textured paving reads darker than its vertex colour)
    const PGC = "#ada597";
    for (const [u0, v0, u1, v1] of [...LAYOUT.blocks, [-26, -46, 26, 37] as [number, number, number, number]]) {
      const e = 3.2, poly = [toW(u0 - e, v0 - e), toW(u1 + e, v0 - e), toW(u1 + e, v1 + e), toW(u0 - e, v1 + e)];
      lod.proxyGround(polyGeo(poly, Y + 0.03, 1), null, PGC);
      await pace.pause();
    }
    for (const st of LAYOUT.streets) { const g = ribbonGeo(st.pts, st.w, Y + 0.035, (x, z) => townFlat(x, z, -2)); if (g) lod.proxyGround(g, null, PGC); await pace.pause(); }
    // (one colour: the layers overlap a few mm apart — at 300 m+ they would fight in depth; same colour = invisible)
    for (const sq of LAYOUT.squares) lod.proxyGround(polyGeo(sq, Y + 0.04, 1), null, PGC);
    lod.proxyGround(polyGeo(PLAZA_POLY.map(([u, v]) => toW(u, v)), Y + 0.12, 1), null, PGC);
    // ---- far proxy: every building as a windowed box + roof (flat parapet slab / hip prism), tanks as boxes
    for (const pb of LAYOUT.parts) {
      await pace.pause();
      const b = pb.b;
      lod.proxyBox(M(b.x, b.y, b.z, b.yaw), b.w, pb.H + (pb.roof.kind === "flat" ? pb.roof.parapet : 0), b.d, b.wall, pb.roof.kind === "flat" ? "#bfae94" : b.roofColor, true);
      // (a GABLE prism along the roof's ridge axis — a 4-sided pyramid turns every pitched roof into a
      //  tent at the 240 m switch, a shape change visible from the plane)
      if (pb.roof.kind !== "flat") { const ov = pb.roof.overhang, ax = pb.roof.axis === "x"; lod.proxyGeo(gablePrism((ax ? b.w : b.d) + 2 * ov, (ax ? b.d : b.w) + 2 * ov, pb.roof.rise), M(b.x, b.y + pb.H, b.z, b.yaw + (ax ? 0 : Math.PI / 2)), b.roofColor); }
      else for (const pr of pb.roof.props) if (pr.kind === "plastic" || pr.kind === "steel" || pr.kind === "tower" || pr.kind === "stand") {
        const c = Math.cos(b.yaw), s = Math.sin(b.yaw), x = b.x + pr.x * c + pr.z * s, z = b.z - pr.x * s + pr.z * c;
        lod.proxyGeo(new THREE.CylinderGeometry(0.7, 0.7, 1.5, 8), M(x, b.y + pb.H + (pr.kind === "tower" ? 4 : pr.kind === "stand" ? 2 : 0.8), z), pr.color ?? "#2f4f8f");
      }
    }
    // the fountain in the proxy: the statue itself is always drawn, so the proxy carries its real pedestal
    // (2.5 m square to its 3.2 m top — a 5 m box would run 1.8 m up into the gorilla's legs) + the basin and its water
    lod.proxyGeo(boxGeo(2.5, 3.1, 2.5), M(FX, Y + 0.12 + 1.55, FZ, STATUE_YAW), "#b9ab92");
    lod.proxyGeo(new THREE.CylinderGeometry(FOUNTAIN_R, FOUNTAIN_R + 0.6, 0.84, 24), M(FX, Y + 0.12 + 0.42, FZ), "#cbbfa9");
    lod.proxyGeo(new THREE.CylinderGeometry(FOUNTAIN_R - 0.45, FOUNTAIN_R - 0.45, 0.04, 24), M(FX, Y + 0.12 + 0.85, FZ), "#3fb3ad");

    lap("props+lines+proxy");
    endFruit();
    await fruit.buildAsync(ctx, group, pace);
    lap("fruit");
    const n = await lod.buildAsync(ctx, group, pace);
    lap("merge");
    await hedges.build(ctx, group, pace);
    lap("hedges");
    // furniture by the shared interiors kit (the rooms the server collides with), streamed in near the camera
    // (perf: rooms shown within 11 m of their cell — seen through a door / window from the street, never across the plaza)
    await pace.pause();
    const ints = townInteriors(ctx, group, INTERIOR_ROOMS, { name: "mango", showDist: 11 });
    tm.intCells = ints.cells;
    // merge the painted signs by material (one draw per sign design instead of one per sign)
    // the statue, fountain water + jets and the signs live in one sub-group
    const nearGroup = new THREE.Group(); nearGroup.name = "mango:near-extras"; group.add(nearGroup);
    // (no distance switch — the 7.4 m statue is the town's landmark from the plane, and hiding it at
    //  200 m while the town itself is still drawn makes it "spawn in" during every fly-in. Far away the engine's
    //  screen-size cull takes its small parts; the statue + water cost ~38 k tris only while they are on screen)
    const byMat = new Map<THREE.Material, THREE.Mesh[]>();
    for (const e of extra) { const m = e as THREE.Mesh; if (m.isMesh && m.name === "sign") { const k = m.material as THREE.Material; (byMat.get(k) ?? byMat.set(k, []).get(k)!).push(m); } else { e.userData.farShadow = false; nearGroup.add(e); } }
    for (const [mat, list] of byMat) {
      await pace.pause();
      const geos = list.map((m) => { m.updateMatrix(); const g = m.geometry.clone(); g.applyMatrix4(m.matrix); return g; });
      const merged = mergeGeometries(geos, false);
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat); mesh.name = "mango:signs"; mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.farShadow = false; mesh.matrixAutoUpdate = false;
      nearGroup.add(mesh);
    }
    pace.finish();
    console.info(`[mango-market] ${LAYOUT.buildings.length} buildings, ${n} merged meshes, ${fruit.count} fruit, ${lod.stats()}, veg fallbacks: ${veg.fallbacks}, build ${Math.round(performance.now() - t0)} ms ${JSON.stringify(tm)}, main-thread busy ${Math.round(pace.busyMs)} ms, longest slice ${Math.round(pace.maxMs)} ms`);
  },
};
export default mod;
