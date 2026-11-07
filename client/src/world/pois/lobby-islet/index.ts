// POI lobby-islet — the KONG ROYALE pre-match lobby. Everything is driven by the ONE
// layout table in shared/pois/lobby-islet.ts (colliders come from the same table):
//   tiki bar + stools (tiki.ts), trampoline / punching bag / target dummies / volleyball net (toys.ts), dock (dock.ts),
//   crates / barrels / pallets / deck chair / windsock (props.ts), runway (runway.ts), rock outcrop (rock.ts),
//   palms + banana plants + beach dressing (through the veg area's VegApi), the parked BANANA CO. plane
//   (actors/plane.ts), and the screenshot crowd of kongs (crowd.ts, stage "lobby-crowd").
// Static meshes are merged per material by a Batch (≈8 draw calls) using two procedurally painted 2K atlases (atlas.ts).
import * as THREE from "three";
import type { WorldModule } from "../../module";
import type { WorldCtx } from "../../../engine/engine";
import type { CamSpec } from "../../../engine/views";
import type { VegApi, PlantKind } from "../../veg/api";
import type { WaterApi } from "../../water/api";
import { LOBBY, CAM, DIM, toWorld, toFrame as toFrameC, worldYaw, groundY, itemLocal, inTpClearing, clearings as LOBBY_CLEAR, type LobbyItem } from "../../../../../shared/pois/lobby-islet";
import { inClearing } from "../../../../../shared/world/veg-scatter";
import { loadAtlases } from "./atlas";
import { Batch, M } from "./kit";
import { type LK, makeMaterials, rng, bananaBunch } from "./lk";
import { buildDock } from "./dock";
import { buildTiki, buildStool } from "./tiki";
import { buildTramp, buildGallows, buildDummy, buildNet } from "./toys";
import { buildCrate, buildBarrel, buildPallet, buildChair, buildWindsock } from "./props";
import { buildRunway } from "./runway";
import { buildRock } from "./rock";
import { stageCrowd } from "./crowd";
import { createPlane } from "../../../actors/plane";

// ------------------------------------------------------------------------------------------------ views
const fp = (lx: number, d: number, y: number): [number, number, number] => { const [x, z] = toWorld(lx, d); return [+x.toFixed(2), y, +z.toFixed(2)]; };
const V = (p: [number, number, number], t: [number, number, number], fov: number, stage = "lobby-crowd", note?: string): CamSpec => ({ pos: p, target: t, fov, stage, t: 12, note });
const views: Record<string, CamSpec> = {
  // the view camera: hovering over the shallows off the north beach, looking SSW across the beach/plaza to the plane
  "char-02-lobby-island": V(fp(CAM.lx, CAM.d, CAM.y), fp(CAM.lx, CAM.d + 60, CAM.y - 60 * Math.tan(CAM.pitch)), CAM.fov, "lobby-crowd", "lobby islet: tiki left, toys centre, dock right, plane behind"),
  // detail cameras
  "wip-lobby-tiki": V(fp(-7.5, 10.5, 3.6), fp(-14.6, 19.6, 3.2), 50),
  "wip-lobby-toys": V(fp(1.5, 5.5, 3.4), fp(4, 15, 1.2), 52),
  "wip-lobby-dock": V(fp(12, 0.2, 3.9), fp(5, 7.5, 1.2), 55),
  "wip-lobby-plane": V(fp(0, 18, 4.6), fp(13.5, 38.5, 4.2), 58),
  "wip-lobby-chair": V(fp(-7.6, 8.6, 2.2), fp(-10.2, 11.6, 1.2), 40),
  "wip-lobby-top": V(fp(0, 6, 55), fp(0, 30, 0), 55),
  "wip-lobby-rock": V(fp(-20, 36, 8), fp(-50, 118, 14), 50),
};

// ------------------------------------------------------------------------------------------------ build
const mod: WorldModule = {
  id: "poi:lobby-islet",
  views,
  async build(ctx) {
    const t0 = performance.now();
    const group = new THREE.Group();
    group.name = "poi:lobby-islet";
    ctx.scene.add(group);
    const aniso = Math.min(ctx.renderer.capabilities.getMaxAnisotropy(), ctx.quality === "low" ? 4 : 8);
    // the baked atlases stream + transcode off the main thread while the parked plane is built on it
    const atP = loadAtlases(ctx.assets, aniso);
    const pl = LOBBY.find((i) => i.kind === "plane");
    const tPlane = performance.now();
    const planeP = pl ? createPlane(ctx, { crew: false }).catch((e) => { console.warn("[lobby-islet] plane failed", e); return null; }) : Promise.resolve(null);
    const planeMs = Math.round(performance.now() - tPlane);
    const at = await atP;
    const mats = makeMaterials(at);
    const k: LK = { b: new Batch(), at, ground: (x, z) => ctx.terrain.height(x, z), r: rng(20260923) };
    const water = ctx.shared.get("water") as WaterApi | undefined;

    buildDock(k, water);
    await ctx.yield();
    let rockCrowns: THREE.Vector3[] = [];
    // yield between items so the build is time-sliced (no main-thread task > 50 ms)
    for (const it of LOBBY) {
      await ctx.yield();
      switch (it.kind) {
        case "tiki": buildTiki(k, it); break;
        case "stool": buildStool(k, it); break;
        case "tramp": buildTramp(k, it); break;
        case "gallows": buildGallows(k, it); break;
        case "dummy": buildDummy(k, it); break;
        case "net": buildNet(k, it); break;
        case "crate": buildCrate(k, it); break;
        case "barrel": buildBarrel(k, it); break;
        case "banana-barrel": buildBarrel(k, it, true); break;
        case "pallet": buildPallet(k, it); break;
        case "chair": buildChair(k, it); break;
        case "windsock": buildWindsock(k, it); break;
        case "runway": buildRunway(k, it); break;
        case "rock": rockCrowns = buildRock(k, it); break;
      }
    }
    // a banana bunch hanging from the gallows arm's back end + one in the palm by the chair
    const bag = LOBBY.find((i) => i.id === "bag")!;
    const [bx, bz] = toWorld(...itemLocal(bag, -0.34, 0));
    bananaBunch(k, M(bx, groundY(bag) + DIM.gallows.postH - 0.3, bz, 0, 1.2, 0), 4, 0.9);

    await ctx.yield();
    plantVeg(ctx, k, rockCrowns);
    await ctx.yield();

    const meshes = await k.b.meshesAsync(mats, "lobby", () => ctx.yield());
    for (const m of meshes) group.add(m);
    const tris = meshes.reduce((s, m) => s + (m.geometry.index ? m.geometry.index.count / 3 : 0), 0);

    // ---- the parked BANANA CO. plane (nose along the item's -X, gear down, rear ramp lowered, props stopped)
    // (build ≤ 1.0 s): the plane streams in AFTER build() returns — createPlane paints its textures in
    // yielded slices; readiness (shot mode / the title) waits for it through ctx.hold
    const release = ctx.hold("lobby-plane");
    void planeP.then((p) => {
      if (pl && p) {
        const [x, z] = toWorld(pl.lx, pl.d);
        p.object.position.set(x, groundY(pl), z);
        p.object.rotation.set(0, worldYaw(pl.a) + Math.PI / 2, 0);
        p.setGear(1); p.setRamp(1); p.setEngines(false);
        p.update(0, 12);
        group.add(p.object);
      }
    }).finally(release);
    console.info(`[lobby-islet] ${meshes.length} merged meshes, ${Math.round(tris / 1000)}k tris, atlases ${at.ms} ms (overlapped), plane ${planeMs} ms, build ${Math.round(performance.now() - t0)} ms`);
  },
  async stage(ctx, stage) {
    if (stage !== "lobby-crowd" || staged) return;
    staged = true;
    await stageCrowd(ctx);
  },
};
let staged = false;
export default mod;

// ------------------------------------------------------------------------------------------------ vegetation
/** palms / banana plants from the layout + hand-placed beach dressing (grass tufts, bushes, ferns, flowers, jungle on the rock) */
function plantVeg(ctx: WorldCtx, k: LK, rockCrowns: THREE.Vector3[]) {
  const api = ctx.shared.get("veg") as VegApi | undefined;
  if (!api) { console.warn("[lobby-islet] no veg api — palms skipped"); return; }
  const q = new Map<PlantKind, THREE.Matrix4[]>();
  const put = (kind: PlantKind, x: number, y: number, z: number, yaw: number, s: number) => {
    if (inTpClearing(x, z)) return;                                   // the char-05 view set's clearings (actors/tp-set.ts)
    let l = q.get(kind); if (!l) q.set(kind, (l = []));
    l.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(s, s, s)));
  };
  const at = (it: LobbyItem) => { const [x, z] = toWorld(it.lx, it.d); return { x, z, y: ctx.terrain.height(x, z) }; };
  for (const it of LOBBY) {
    if (it.kind === "palm") { const p = at(it); put(it.id === "palm-0" || it.id === "palm-4" || it.id === "palm-7" ? "palm-leaning" : "palm", p.x, p.y - 0.1, p.z, worldYaw(it.a), (it.h ?? 11) / 11); }
    if (it.kind === "banana-plant") { const p = at(it); put("banana-plant", p.x, p.y - 0.05, p.z, worldYaw(it.a), it.s ?? 1); }
  }
  // keep-out discs around items + kong spots so tufts never poke through props
  const blockers: Array<[number, number, number]> = [];
  for (const it of LOBBY) {
    const r = it.kind === "tiki" ? 7.5 : it.kind === "runway" ? 0 : it.kind === "tramp" ? 2.3 : it.kind === "net" ? 1.2 : it.kind === "dock" ? 0 : it.kind === "plane" ? 0 : it.kind === "rock" ? 0 : 1.1;
    if (r > 0) blockers.push([it.lx, it.d, r]);
  }
  const free = (lx: number, d: number) => blockers.every(([bx, bd, r]) => Math.hypot(lx - bx, d - bd) > r);
  const rr = rng(4242);
  // sparse dry grass tufts on the sand (little green clumps around the toys and along the dune line)
  // (clustered 2–4 tuft patches, not an even sprinkle — the sand stays mostly clean)
  for (let i = 0; i < 26; i++) {
    const lx = -22 + rr() * 44, d = 10 + rr() * 22;
    if (d > 30 && lx > -20 && lx < 30) continue;                   // runway apron stays clean
    const n = 2 + Math.floor(rr() * 3);
    for (let j = 0; j < n; j++) {
      const px = lx + (rr() - 0.5) * 1.4, pd = d + (rr() - 0.5) * 1.4;
      if (!free(px, pd)) continue;
      const [x, z] = toWorld(px, pd), y = ctx.terrain.height(x, z);
      if (y < 0.35) continue;
      put(rr() < 0.9 ? "grass" : "flowers", x, y - 0.03, z, rr() * 6.28, 0.55 + rr() * 0.45);
    }
  }
  // clumps: bushes + ferns + monstera behind the tiki bar, at the dune edge left, along the back of the runway
  const clump = (lx: number, d: number, kinds: PlantKind[], n: number, spread: number, s0 = 0.9) => {
    for (let i = 0; i < n; i++) {
      const a = rr() * 6.28, rad = Math.sqrt(rr()) * spread, px = lx + Math.cos(a) * rad, pd = d + Math.sin(a) * rad;
      const [x, z] = toWorld(px, pd), y = ctx.terrain.height(x, z);
      if (y < 0.3) continue;
      put(kinds[Math.floor(rr() * kinds.length)], x, y - 0.05, z, rr() * 6.28, s0 + rr() * 0.4);
    }
  };
  clump(-22, 23, ["bush", "monstera", "fern"], 9, 3.2);
  clump(-17.5, 12.5, ["monstera", "fern", "bush"], 5, 1.4, 1.0);
  clump(-26, 33, ["bush", "fern"], 7, 3);
  clump(-12, 27.5, ["fern", "flowers"], 4, 1.3, 0.8);
  clump(24, 31, ["bush", "fern", "flowers"], 6, 2.5);
  clump(32, 50, ["bush", "monstera"], 6, 3);
  clump(-36, 62, ["bush", "banana-plant", "monstera"], 8, 4);
  clump(-4, 64, ["bush", "fern"], 6, 3);
  clump(18, 60, ["bush", "fern", "flowers"], 7, 3.5);
  clump(-30, 100, ["bush", "monstera", "banana-plant"], 10, 6);
  // dense jungle belt behind the runway so the horizon reads as a lush island, not open sea.
  // Keeps the pad centre (0, 1020) clear — other areas stage loot / gear there.
  const [pcx, pcd] = toFrameC(0, 1020);
  // a 7.5 m lattice (~45 % fewer plants than 5.5 m, on top of the island scatter) and no puffball jungle trees
  // in the belt: a clean palm horizon with low understorey, readable for the warm-up
  for (let d = 52; d <= 118; d += 7.5) for (let lx = -74; lx <= 44; lx += 7.5) {
    const px = lx + (rr() - 0.5) * 4, pd = d + (rr() - 0.5) * 4;
    if (Math.hypot(px - pcx, pd - pcd) < 19) continue;
    if (pd < 58 && px > -30 && px < 30) continue;                      // runway apron
    const tall = px / pd > -0.62 && px / pd < -0.3 && pd > 64;           // in front of the rock: keep it low

    const [x, z] = toWorld(px, pd), y = ctx.terrain.height(x, z);
    if (y < 0.6) continue;
    if (inClearing(x, z, [LOBBY_CLEAR[1]] as never)) continue; // never on / beside the runway (a palm grew out of its corner)
    const u = rr();
    const kind: PlantKind = tall ? (u < 0.12 ? "palm" : u < 0.7 ? "bush" : "monstera") : u < 0.36 ? "palm" : u < 0.7 ? "bush" : u < 0.86 ? "banana-plant" : "monstera";
    const sc = kind === "palm" ? 0.85 + rr() * 0.5 : 0.9 + rr() * 0.7;
    put(kind, x, y - 0.1, z, rr() * 6.28, sc);
  }
  // jungle on the rock crown
  for (const [i, c] of rockCrowns.entries()) {
    const kind: PlantKind = i % 5 === 0 ? "palm" : i % 3 === 0 ? "jungle-tree" : "bush";
    put(kind, c.x, c.y - 0.4, c.z, rr() * 6.28, kind === "bush" ? 1.3 + rr() * 0.6 : kind === "jungle-tree" ? 0.55 + rr() * 0.2 : 0.8 + rr() * 0.3);
  }
  for (const [kind, ms] of q) { try { api.plant(kind, ms); } catch (e) { console.warn("[lobby-islet] veg.plant failed", kind, e); } }
  void k;
}
