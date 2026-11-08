// POI the-murk — THE MURK mangrove swamp. Every visual is derived from shared/pois/the-murk.ts LAYOUT (the same data the
// server collides against): boardwalks + stairs (deck.ts), six playable huts (hut.ts), the hollow Great Mangrove with
// the Crow's Nest + smokehouse (tree.ts), the tea-coloured swamp water (water.ts), swamp FX (fx.ts). Merged through a
// TownLod (poi-town kit) whose materials are the murk's photo-textured sets (mats.ts).
import * as THREE from "three";
import type { WorldModule } from "../../module";
import type { WorldCtx } from "../../../engine/engine";
import type { CamSpec } from "../../../engine/views";
import { LAYOUT, GM, WALK_Y, WATER_Y, CX, CZ, INTERIOR_ROOMS, ROOM_DRESS, rootMasses, massOfPlant, type MProp } from "../../../../../shared/pois/the-murk";
import { buildInteriors } from "../_kit/interior";
import { toWorld, mulberry } from "../../../../../shared/pois/town-kit";
import { TownLod, type TownBins } from "../_kit/town-materials";
import { M, col, cylGeo, tubeGeo, catenary, chamferBoxGeo, noise3 } from "../_kit/town-geo";
import { addBarrel } from "../_kit/town-props";
import { addDrum } from "../_kit/town-lagoon";
import { addLongboat } from "../_kit/town-boat";
import { TownVeg } from "../_kit/town-veg";
import { murkMats, aliasTown } from "./mats";
import { addMDeck, addFlight, addBridge } from "./deck";
import { addHut, hutProxy } from "./hut";
import { addGreatMangrove, addRoots, addRootMasses, crownMesh, crownBuilder, heroLobes, HERO_LEAF, hollowGlow } from "./tree";
import { buildWater, buildLilies } from "./water";
import { buildFx } from "./fx";
import { addDress } from "./dress";
import { soft, addPost, murkLantern, murkCrate, ROPE } from "./geo";
import { flag } from "../../../flags";

type V3 = [number, number, number];
// ---- the view camera: ~1.5 m over the tea water SE of the shack, looking NNW up the channel — the shack on the
// left behind its porch, the boardwalk receding to the dock, the Great Mangrove's roots filling the right, the
// half-sunk rowboat in front
const CAM: [number, number] = [566.5, -205.5], HD: [number, number] = (() => { const x = -3.5, z = -39.5, l = Math.hypot(x, z); return [x / l, z / l]; })();
const at = (f: number, r: number, y: number): V3 => [CAM[0] + HD[0] * f - HD[1] * r, y, CAM[1] + HD[1] * f + HD[0] * r];
const eye = (x: number, z: number, y: number): V3 => [x, y + 1.8, z];
const views: Record<string, CamSpec> = {
  "poi-13-the-murk": { pos: at(0, 0, WATER_Y + 1.5), target: at(40, 0, 4.2), fov: 60, t: 14, stage: "murk" },
  "murk-aerial": { pos: [690, 120, -90], target: [572, 0, -222], fov: 55, t: 12 },
  "murk-top": { pos: [576, 330, -160], target: [576, 0, -218], fov: 50, t: 12 },
  "murk-plane": { pos: [380, 420, 60], target: [580, 0, -220], fov: 50, t: 12 },
  // eye level (kong eye ≈ 1.8 m over the floor)
  "murk-eye-landing": { pos: eye(562.5, -192.5, WALK_Y), target: [556, 3, -222], fov: 70, t: 12 },
  "murk-eye-gate": { pos: eye(565.0, -229.5, WALK_Y), target: [GM.x, 6, GM.z], fov: 70, t: 12 },
  // just inside the root gate, looking across the hollow at the spiral climbing around the heartwood column
  "murk-eye-hollow": { pos: [GM.x + Math.cos(GM.inA) * 2.0, GM.floorY + 1.75, GM.z + Math.sin(GM.inA) * 2.0], target: [GM.x - Math.cos(GM.inA) * 2.5, GM.floorY + 3.6, GM.z - Math.sin(GM.inA) * 2.5], fov: 80, t: 12 },
  "murk-eye-nest": { pos: eye(GM.x - 4.6, GM.z - 4.6, GM.platY), target: [GM.x + 8, GM.platY + 1, GM.z + 6], fov: 70, t: 12 },
  "murk-eye-bridge": { pos: eye(GM.x + GM.platH + 3, GM.z - 5.0, GM.platY - 0.6), target: [617, 8.5, -247.5], fov: 70, t: 12 },
  "murk-eye-dock": { pos: eye(566.5, -268, WALK_Y), target: [557, 3, -222], fov: 70, t: 12 },
  "murk-eye-shack": { pos: (() => { const h = LAYOUT.huts[0]; const [x, z] = toWorld(h, 2.4, 1.6); return [x, h.y + 1.7, z] as V3; })(), target: (() => { const h = LAYOUT.huts[0]; const [x, z] = toWorld(h, -2.8, -1.4); return [x, h.y + 1.2, z] as V3; })(), fov: 75, t: 12 },
  "murk-eye-bait": { pos: (() => { const h = LAYOUT.huts[1]; const [x, z] = toWorld(h, -2.5, 1.2); return [x, h.y + h.floorH * 2 + 1.8, z] as V3; })(), target: [GM.x, 12, GM.z], fov: 70, t: 12 },
  "murk-eye-water": { pos: eye(588.5, -203.0, 0.45), target: [604, 3, -193], fov: 70, t: 12 },
  "murk-eye-bait-ext": { pos: eye(586, -197.2, WALK_Y), target: [604.5, 4.5, -193.5], fov: 70, t: 12 },
  "murk-eye-stilt": { pos: eye(599.5, -233.6, WALK_Y), target: [617, 5, -247.5], fov: 70, t: 12 },
  "murk-eye-boathouse": { pos: eye(539.5, -217.6, WALK_Y), target: [527, 4, -226], fov: 70, t: 12 },
  "murk-eye-hermit": { pos: eye(629.5, -208.6, WALK_Y), target: [640.5, 3.5, -214], fov: 70, t: 12 },
};

// ---------------------------------------------------------------- props
/** a painted fishing float: squashed ball, cream band, algae ring at the water line, a top eye with its rope */
function addFloat(nb: TownBins, m: THREE.Matrix4, body: string, r = 0.24) {
  const ball = new THREE.SphereGeometry(r, 16, 12); ball.scale(1, 0.86, 1);
  nb.plastic.add(ball, m, col(body));
  const band = new THREE.TorusGeometry(r * 0.985, r * 0.13, 6, 24); band.rotateX(Math.PI / 2); band.scale(1, 0.86, 1);
  nb.plastic.add(band, m.clone().multiply(M(0, r * 0.18, 0)), col("#d6c8a4"));
  const algae = new THREE.TorusGeometry(r * 0.93, r * 0.12, 6, 24); algae.rotateX(Math.PI / 2);
  nb.plastic.add(algae, m.clone().multiply(M(0, -r * 0.42, 0)), col("#4c5a2a"));
  nb.metal.add(cylGeo(r * 0.16, r * 0.2, r * 0.22, 8), m.clone().multiply(M(0, r * 0.9, 0)), col("#3a3228"));
  const eye = new THREE.TorusGeometry(r * 0.2, r * 0.05, 5, 10);
  nb.metal.add(eye, m.clone().multiply(M(0, r * 1.12, 0)), col("#3a3228"));
}

function addProp(nb: TownBins, mb: TownBins, p: MProp, rng: () => number, extra: THREE.Object3D[], signMat: THREE.Material) {
  const m = M(p.x, p.y, p.z, p.yaw);
  const T = (x: number, y: number, z: number, yaw = 0, pitch = 0, roll = 0) => m.clone().multiply(M(x, y, z, yaw, pitch, roll));
  const woods = ["#e8c49a", "#d8b088", "#f0d0a4", "#c8a47c"];
  switch (p.kind) {
    case "crates": {
      if (p.h) {
        // a stack reaching exactly h (the crate steps up to the smokehouse roof)
        const n = Math.max(1, Math.round(p.h / 0.52));
        for (let i = 0; i < n; i++) murkCrate(nb, T((rng() - 0.5) * 0.04, i * p.h / n, (rng() - 0.5) * 0.04, (rng() - 0.5) * 0.12), 0.98, p.h / n - 0.004, 0.98, woods[(i + (p.v ?? 0)) % 4], rng);
        break;
      }
      // individual closed crates (murkCrate), each its own size / tint / twist — never one block
      const v = (p.v ?? 0) % 4, hs = [[0.62, 0.62], [0.45, 0.45], [0.62, 0.52, 0.46], [0.66, 0.59]][v];
      let y = 0;
      hs.forEach((h, i) => { murkCrate(nb, T((rng() - 0.5) * 0.06, y, (rng() - 0.5) * 0.06, (rng() - 0.5) * 0.26), 1.18 - i * 0.09, h - 0.004, 0.94 - i * 0.06, woods[(i + v) % 4], rng); y += h; });
      break;
    }
    case "barrel": addBarrel(nb, m, (p.v ?? 0) % 2 ? "#6a4e34" : "#8a6a44", false); break;
    case "drum": addDrum(nb, m, (p.v ?? 0) % 2 ? "#5a7a6a" : "#8a4a32", rng); break;
    case "trap": {
      // a lobster / crab pot: slat cage + netting
      for (let i = 0; i < 5; i++) nb.wood.box(0.05, 0.05, 0.62, T(-0.4 + i * 0.2, 0.55, 0), col("#8a6a44"));
      for (const s of [-1, 1]) nb.wood.box(0.9, 0.58, 0.05, T(0, 0.29, s * 0.3), col("#7a5a3a"));
      nb.wood.box(0.9, 0.05, 0.62, T(0, 0.03, 0), col("#6a4e34"));
      nb.net.box(0.84, 0.5, 0.56, T(0, 0.3, 0), col("#cfc4a0"));
      break;
    }
    case "netrack": {
      for (const s of [-1, 1]) addPost(nb, ...(() => { const q = new THREE.Vector3(s * 1.1, 0, 0).applyMatrix4(m); return [q.x, q.z] as [number, number]; })(), p.y + 2.1, p.y - 0.05, 0.06, rng, true);
      nb.wood.add(cylGeo(0.04, 0.04, 2.3, 6), T(0, 2.05, 0, 0, 0, Math.PI / 2), col("#6a5238"));
      // (the net itself is the green alpha-cut drape in fx.ts — the kit's grey net read as chain-link)
      break;
    }
    case "lantern": {
      const h = p.h ?? 2.4;
      addPost(nb, p.x, p.z, p.y + h, p.y - 0.05, 0.06, rng, false);
      nb.wood.box(0.5, 0.05, 0.05, T(0.22, h - 0.05, 0), col("#5a4430"));
      murkLantern(nb, T(0.42, h - 0.5, 0));
      break;
    }
    case "sign": {
      addPost(nb, p.x, p.z, p.y + 2.4, p.y - 0.3, 0.08, rng, false);
      const g = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.5), signMat);
      g.applyMatrix4(T(0, 1.9, 0.1, 0, 0, (rng() - 0.5) * 0.1));
      g.castShadow = true; extra.push(g);
      nb.wood.box(1.6, 0.6, 0.05, T(0, 1.9, 0.07, 0, 0, 0), col("#5a4430"));
      break;
    }
    case "rowboat": {
      // the foreground boat: half sunk, bow up on the bank, stern under the tea
      addLongboat(mb, T(0, 0, 0, 0, 0.1, 0.09).multiply(M(0, 0, 0, 0, 0, 0, 0.78)), { hull: "#6e4634", stripe: "#8f8266", lower: "#2e271c", inner: "#5e4a34", seat: "#57432f", motor: false, oars: true, len: 4.6, fenders: 0, cargo: ["rope"] }, rng);
      addFloat(nb, T(1.9, 0.3, -0.55, 0.4, 0.2), "#8a4630", 0.22);
      // tea water pooled in the half-sunk hull (the bilge), algae-flecked
      nb.plastic.add(new THREE.BoxGeometry(3.4, 0.02, 0.95), T(-0.2, 0.3, 0), col("#3a2a12"));
      break;
    }
    case "canoe": addLongboat(mb, T(0, 0, 0, 0, 0.02, 0.03).multiply(M(0, 0, 0, 0, 0, 0, 0.62, 0.7, 0.62)), { hull: "#6a4a30", stripe: "#c8b890", lower: "#3a2a1e", inner: "#8a6a44", motor: false, oars: true, len: 5.2, fenders: 0, cargo: [] }, rng); break;
    case "logpile": for (let i = 0; i < 6; i++) nb.thatch.add(cylGeo(0.14, 0.15, 1.7, 9), T(-0.4 + (i % 3) * 0.3 + (i > 2 ? 0.15 : 0), 0.15 + (i > 2 ? 0.26 : 0), 0, 0, 0, Math.PI / 2).multiply(M(0, 0, 0, 0, 0, 0)), soft("#9a8468", 0.5)); break;
    case "buoy": addFloat(nb, T(0, 0.04, 0, 0, 0.12, 0.08), (p.v ?? 0) ? "#c8b890" : "#94442e", 0.26); nb.rope.add(tubeGeo([new THREE.Vector3(p.x, p.y + 0.1, p.z), new THREE.Vector3(p.x + 0.4, p.y - 0.5, p.z + 0.2)], 0.02, 4, false, 4), null, col(ROPE)); break;
    case "stack": {
      // a riveted tin vent stack: a square boot flashed into the roof, the round pipe, a conical rain cap on struts
      const h = p.h ?? 1.75;
      nb.metal.add(chamferBoxGeo(0.84, 0.5, 0.84, 0.02), T(0, 0.25, 0), col("#6a5a4a"));
      nb.metal.add(cylGeo(0.34, 0.36, h - 0.45, 14), T(0, 0.5 + (h - 0.45) / 2 - 0.1, 0), col("#7a6e62"), (x: number, y: number, z: number, _b: THREE.Color, o: THREE.Color) => { if (noise3(x * 3, y * 2, z * 3) > 0.55) o.lerp(new THREE.Color("#7a3a1e"), 0.6); });
      for (let k = 0; k < 3; k++) nb.metal.add(new THREE.TorusGeometry(0.355, 0.012, 4, 18).rotateX(Math.PI / 2), T(0, 0.6 + k * 0.4, 0), col("#4a4038"));
      const cap = new THREE.ConeGeometry(0.5, 0.3, 14); nb.metal.add(cap, T(0, h + 0.12, 0), col("#5a5048"));
      break;
    }
    case "cupola": {
      // a louvred ridge cupola: board base with slatted vents on all four sides, a pyramid cap, a fish weather-vane
      const h = p.h ?? 1.75, bh = h * 0.72;
      nb.clapboard.add(chamferBoxGeo(1.2, bh, 1.2, 0.02), T(0, bh / 2, 0), col("#8a6a4a"));
      for (let k = 0; k < 4; k++) for (let i = 0; i < 4; i++) nb.wood.box(0.86, 0.05, 0.05, T(0, bh * 0.55 + i * 0.11, 0, k * Math.PI / 2).multiply(M(0, 0, 0.61, 0, 0, 0)).multiply(M(0, 0, 0, 0, -0.6, 0)), col("#4a3624"));
      for (let k = 0; k < 4; k++) nb.wood.box(1.26, 0.07, 0.06, T(0, bh - 0.03, 0, k * Math.PI / 2).multiply(M(0, 0, 0.62)), col("#5a4430"));
      const cap = new THREE.ConeGeometry(0.95, h - bh + 0.1, 4, 1); cap.rotateY(Math.PI / 4);
      nb.tin.add(cap, T(0, bh + (h - bh) / 2, 0), col("#7a5f45"));
      nb.metal.add(cylGeo(0.012, 0.012, 0.7, 5), T(0, h + 0.3, 0), col("#3a3632"));
      const vane = new THREE.SphereGeometry(0.5, 10, 6); vane.scale(0.55, 0.14, 0.03);
      nb.metal.add(vane, T(0.08, h + 0.55, 0, 0.6), col("#4a4a42"));
      break;
    }
    case "chimney": {
      const h = p.h ?? 3;
      for (let y = 0; y < h - 0.2; y += 0.32) nb.rock.box(0.7 - (y / h) * 0.06, 0.3, 0.7 - (y / h) * 0.06, T((rng() - 0.5) * 0.03, y + 0.15, (rng() - 0.5) * 0.03, (rng() - 0.5) * 0.08), col(rng() < 0.5 ? "#8a7a68" : "#9a8674", 0.95 + rng() * 0.1));
      nb.rock.box(0.84, 0.14, 0.84, T(0, h - 0.07, 0), col("#6a5e52"));
      nb.metal.add(cylGeo(0.14, 0.16, 0.5, 8), T(0, h + 0.2, 0), col("#2a2622"));
      break;
    }
    default: break;
  }
}

const mod: WorldModule = {
  id: "poi:the-murk",
  views,
  async build(ctx: WorldCtx) {
    const t0 = performance.now();
    // dev ablation: ?murkoff=crown,water,fx,roots,huts,decks,veg,gm
    const OFF = new Set(flag("murkoff"));
    const OLD_LOD = !flag("elevlod");   // A/B: ?elevlod=0 = the old LOD switches
    const group = new THREE.Group();
    group.name = "poi:the-murk";
    ctx.scene.add(group);
    const mm = await murkMats(ctx);
    const tMats = performance.now();
    const mats = aliasTown(mm);
    // TownLod's tiers switch BatchedMesh instances in one frame, so every switch sits
    // where it cannot be seen — the far proxy (deck slabs + boxes + a cone for the hero) only beyond 900 m (at 280 m
    // the whole swamp swapped in mid-glide; PLANE_ALT is 720), the near tier (rails, piles, ropes: < 1 px there) to
    // 170 m (300 m measured +0.4 ms from Mango Market for sub-pixel parts), the hut near tier to 140 and the
    // furniture to 90 / 80 m (at 40 / 34 tables blinked in behind the windows as you walked up)
    const lod = new TownLod(mats, "murk", OLD_LOD ? { cell: 48, near: 90, far: 280, fine: 40, itemNear: 70, itemFine: 34, castItem: 140 } : { cell: 48, near: 170, far: 900, fine: 90, itemNear: 140, itemFine: 80, castItem: 160 });
    const Mn = (x: number, z: number) => lod.main(x, z), Nr = (x: number, z: number) => lod.near(x, z);
    const rng = mulberry(0x4d55524b);
    const g = (x: number, z: number) => ctx.terrain.height(x, z);
    const extra: THREE.Object3D[] = [];

    // ---- boardwalks, stairs, the rope bridge
    // (dev) synchronous slice lengths between yields, reported with the build line (budget: no slice > 50 ms)
    const slices: Array<[number, string]> = []; let sliceT = performance.now(), sliceN = 0;
    const Y = async (label = "") => { const t = performance.now(); slices.push([t - sliceT, `${sliceN++}${label}`]); await ctx.yield(); sliceT = performance.now(); };
    await Y();
    if (!OFF.has("decks")) for (const k of LAYOUT.decks) { addMDeck(Mn(k.x, k.z), Nr(k.x, k.z), k, g, rng); await Y(); }
    if (!OFF.has("decks")) for (const f of LAYOUT.flights) { addFlight(Mn(f.x, f.z), Nr(f.x, f.z), f, g, rng); await Y(); }
    addBridge(Mn(LAYOUT.bridge.a[0], LAYOUT.bridge.a[2]), Nr(LAYOUT.bridge.a[0], LAYOUT.bridge.a[2]), rng);
    const dressSigns: Record<string, THREE.MeshStandardMaterial> = {};
    // ---- huts: each its own LOD unit (full shell within 90 m, LOD1 beyond + shadow proxy)
    if (!OFF.has("huts")) for (const [i, p] of LAYOUT.parts.entries()) {
      // the full shell to 420 m (at 95 m every shack swapped its LOD1 shell for the real one as you approached)
      const it = lod.item(`h${i}`, p.h.x, p.h.z, OLD_LOD ? { mid: 95, near: 70, fine: 34, top: p.ridgeY + 1 } : { mid: 420, near: 140, fine: 80, top: p.ridgeY + 1 });
      addHut({ main: it.main, near: it.near, fine: it.fine, lod1: it.lod1 }, p, g, rng);
      // the storytelling props of this hut's rooms (shared ROOM_DRESS: placed clear of the kit's furniture)
      for (const d of ROOM_DRESS) {
        if (!d.room.startsWith(`murk-${p.h.id}-`)) continue;
        const room = INTERIOR_ROOMS.find((r) => r.id === d.room)!;
        const at = new THREE.Matrix4().makeRotationY(room.yaw).setPosition(room.x, room.y, room.z).multiply(M(d.x, d.y, d.z, d.yaw));
        addDress(it.near, it.fine, at, d, rng, extra, d.kind === "sign" ? (dressSigns[p.h.id] ??= mats.sign(p.h.id === "boathouse" ? "BOAT REPAIR" : "LIVE BAIT", p.h.id === "boathouse" ? "#2e3e4e" : "#6a2a1e", "#f2e6c2")) : null);
      }
      hutProxy((m, w, h, d, wall, roof, win) => lod.proxyBox(m, w, h, d, wall, roof, win), (geo, m, c) => lod.proxyGeo(geo, m, c), p);
      await Y(":hut");
    }
    // ---- the furnished storeys (shared interiors kit: same layout → same colliders + loot slots as the server)
    // the furnished rooms switch at once (noCull: no 0.3 s scale fade about the centre of ALL the huts — the
    // furniture slid across the swamp behind the windows) and only ~170 m out, where a window is a few pixels
    if (!OFF.has("int")) { const ib = await buildInteriors(ctx, INTERIOR_ROOMS, { parent: group, name: "murk:interiors", maxDist: 110 }); if (!OLD_LOD) ib.group.userData.noCull = true; }
    await Y(":interiors");
    // ---- the Great Mangrove (its own LOD unit) + all roots / limbs / logs
    {
      // the hero landmark keeps its full model to the far switch (at 240 m it swapped mid-drop)
      const it = lod.item("gm", GM.x, GM.z, OLD_LOD ? { mid: 240, near: 90, fine: 40, top: 30 } : { mid: 900, near: 170, fine: 90, top: 30 });
      if (!OFF.has("gm")) { addGreatMangrove({ main: it.main, near: it.near, fine: it.fine, lod1: it.lod1 }, rng); extra.push(hollowGlow()); }
      await Y(":gm");
      if (!OFF.has("roots")) await addRoots((x, z) => Mn(x, z), it.lod1, rng, (x, z) => Nr(x, z), Y);
      // the sculpted root masses at every tree / tangle / mangrove foot (their colliders: shared massBoxes)
      if (!OFF.has("roots")) await addRootMasses((x, z) => Mn(x, z), [...rootMasses(), ...LAYOUT.plants.filter((p) => p.kind === "mangrove").map(massOfPlant)], () => ctx.yield());
    }
    // ---- props
    const signMat = mats.sign("BANANA CO.", "#2f4a3a", "#f2e6c2");
    await Y(":masses");
    // the props are the swamp's HARD COVER (crates, barrels, traps — with colliders): drawn with the main tier
    // (to the far switch), not the near tier — a crate you can be shot from behind never vanishes at 90–170 m
    for (const p of LAYOUT.props) addProp(OLD_LOD ? Nr(p.x, p.z) : Mn(p.x, p.z), Mn(p.x, p.z), p, rng, extra, signMat);
    await Y(":props");
    for (const r of LAYOUT.ropes) Nr(r.a[0], r.a[2]).rope.add(tubeGeo(catenary(new THREE.Vector3(...r.a), new THREE.Vector3(...r.b), r.sag, 8), 0.022, 4, false, 10), null, col(ROPE));
    // ---- vegetation through the veg area's API (mangroves carry the SAME colliders as veg-scatter gives them)
    const veg = new TownVeg(ctx, Nr(CX, CZ), rng);
    // (understory plants in the shallows grow out of the tea: their base sits just under the surface, not on the bed)
    if (!OFF.has("veg")) for (const p of LAYOUT.plants) veg.plant(p.kind, p.x, p.z, p.yaw, p.s, p.kind === "mangrove" ? p.y ?? g(p.x, p.z) : Math.max(p.y ?? g(p.x, p.z), WATER_Y - 0.12));
    await Y(":veg-plant");
    veg.flush();
    await Y(":veg-flush");
    // ---- far proxy: deck slabs, pile skirts, the hero as a cone + crown ball
    for (const k of LAYOUT.decks) lod.proxyGeo(new THREE.BoxGeometry(k.w, 0.3, k.d), M(k.x, k.y - 0.15, k.z, k.yaw), "#8a6a48");
    lod.proxyGeo(new THREE.CylinderGeometry(2.4, 4.4, 21, 10), M(GM.x, 10, GM.z), "#6a5a44");

    await Y(":proxy");
    const n = await lod.buildAsync(ctx, group);
    group.userData.lod = lod;   // (perf A/B tools: the TownLod, its distances in .o)
    await Y(":lod");
    for (const e of extra) { e.userData.farShadow = false; group.add(e); }

    // ---- the crown (hero) — leaf cards, one mesh
    const canLobes = LAYOUT.canopies.map((c) => ({ c: new THREE.Vector3(...c.c), r: c.r }));
    // built cell by cell with a yield between cells (in one go the crown is a ~0.8 s synchronous slice)
    const nearB = crownBuilder(ctx, canLobes, 7);
    const crown = nearB.group;
    for (const st of nearB.steps) { st(); await Y(":crown-cell"); }
    // the hero's crown: its own lime-gold mesh (the landmark from the plane)
    crown.add(crownMesh(ctx, heroLobes(), 11, HERO_LEAF));
    // distance LOD: beyond ~450 m from the POI centre the crowns swap to 30 % of the cards (hysteresis 20 m). The far set
    // builds here with the near one: built lazily in the frames the first time a camera was far (always, in a match's
    // warm-up on the lobby islet), it cost ~35 ms a frame, and its new materials missed the atmos sweep and the stream's
    // parallel compile — two synchronous program links (~0.2 s) in one warm-up frame
    const farB = crownBuilder(ctx, canLobes, 7, undefined, 0.3);
    const crownFar = farB.group;
    for (const st of farB.steps) { st(); await Y(":crown-far-cell"); }
    crownFar.add(crownMesh(ctx, heroLobes(), 11, HERO_LEAF, 0.3));
    crownFar.name = "murk:crown-far"; crownFar.visible = false;
    const crownRoot = new THREE.Group(); crownRoot.name = "murk:crown"; crownRoot.add(crown, crownFar);
    let farNow = false;
    ctx.onUpdate(() => {
      const c = ctx.camera.position, d = Math.hypot(c.x - CX, c.z - CZ, c.y);
      // the near / far crown crossfade at 420–450 m (at 210–230 m the canopy visibly thinned / thickened
      // during every approach on foot from Mango Market and every glide)
      if (OLD_LOD ? (farNow ? d < 210 : d > 230) : (farNow ? d < 420 : d > 450)) farNow = !farNow;
      crown.visible = !farNow; crownFar.visible = farNow;
    });

    if (!OFF.has("crown")) group.add(crownRoot);
    await Y(":crown-root");
    // ---- water + lilies
    // canopy cover for the water's reflections: under any crown lobe (xz), feathered
    const lobesAll = [...heroLobes(), ...LAYOUT.canopies.map((c) => ({ c: new THREE.Vector3(...c.c), r: c.r }))];
    // (a 10 m grid of the lobes that reach each cell — looping every lobe per sample for the water's reflection map +
    // per-vertex cover cost ~0.8 s of the build)
    const CG = 10, cgrid = new Map<number, typeof lobesAll>();
    for (const L of lobesAll) { const R = L.r * 1.6; for (let i = Math.floor((L.c.x - R) / CG); i <= Math.floor((L.c.x + R) / CG); i++) for (let j = Math.floor((L.c.z - R) / CG); j <= Math.floor((L.c.z + R) / CG); j++) { const k = i * 4096 + j; let a = cgrid.get(k); if (!a) cgrid.set(k, a = []); a.push(L); } }
    const cover = (x: number, z: number) => { let k = 0; for (const L of cgrid.get(Math.floor(x / CG) * 4096 + Math.floor(z / CG)) ?? []) { const d = Math.hypot(x - L.c.x, z - L.c.z); k = Math.max(k, 1 - Math.min(1, Math.max(0, (d - L.r * 0.7) / (L.r * 0.9)))); } return k; };
    const water = buildWater(ctx, cover);
    await Y(":water");
    if (!OFF.has("water")) { group.add(water.mesh, water.shelf); if (water.haze && !OFF.has("haze")) group.add(water.haze); }
    const lilySpots: Array<[number, number]> = [[569, -209], [579, -203], [552, -232], [587, -243], [606, -229], [628, -238], [598, -181], [536, -205], [520, -236], [644, -226], [571, -250], [612, -262], [560, -170], [636, -250]];
    group.add(buildLilies(ctx, lilySpots, water.levelAt, rng));
    await Y(":lilies");
    // ---- fx: fireflies, mist, sun shafts, hanging moss
    const fx = buildFx(ctx, water.levelAt, rng);
    await Y(":fx");
    if (!OFF.has("fx")) group.add(fx.group);
    ctx.onUpdate((dt, t) => { water.uniforms.uTime.value = t; fx.update(t); });
    // dev handle for in-page A/B GPU timing: toggle parts by name
    (globalThis as unknown as { __murk?: unknown }).__murk = {
      parts: () => ({ water: [water.mesh], haze: water.haze ? [water.haze] : [], crown: [crownRoot], fx: [fx.group], lilies: group.children.filter((c) => c.name === "murk:lilies"), batches: group.children.filter((c) => c.name.startsWith("murk:") && !["murk:crown", "murk:water", "murk:fx", "murk:lilies", "murk:haze"].includes(c.name)),
        // probes (not geometry): "hiding" them switches one cost off — the tea's SSR trace, the crown's shadow casting
        ssr: [{ set visible(v: boolean) { water.uniforms.uDbg.value = v ? 0 : 3; } }],
        crownShadow: [{ set visible(v: boolean) { crownRoot.traverse((o) => { if (o.name === "murk:crown-pre") o.castShadow = v; }); } }],
        crownLit: [{ set visible(v: boolean) { crownRoot.traverse((o) => { if (o !== crownRoot && o.name === "murk:crown") ((o as THREE.Mesh).material as THREE.Material).visible = v; }); } }],
        crownPre: [{ set visible(v: boolean) { crownRoot.traverse((o) => { if (o.name === "murk:crown-pre") ((o as THREE.Mesh).material as THREE.Material).visible = v; }); } }],
        crownCore: [{ set visible(v: boolean) { crownRoot.traverse((o) => { if (o.name === "murk:crown-core") o.visible = v; }); } }] }),
    };
    console.info(`[the-murk] ${LAYOUT.huts.length} huts, ${LAYOUT.decks.length} decks, ${LAYOUT.roots.length} roots, ${n} batches, ${lod.stats()}, veg fallbacks ${veg.fallbacks}, mats ${Math.round(tMats - t0)} ms, build ${Math.round(performance.now() - t0)} ms, longest slices ${slices.sort((a, b) => b[0] - a[0]).slice(0, 6).map(([ms, i]) => `#${i} ${Math.round(ms)} ms`).join(", ")}, sum ${Math.round(slices.reduce((a, b) => a + b[0], 0))} ms`);
  },
  async stage(ctx, stage) {
    if (stage === "murk") (await import("./stage")).stageMurk(ctx);
  },
};
export default mod;
